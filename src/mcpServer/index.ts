// The extension-hosted MCP server: lifecycle, document I/O, registration.
//
// WHY THIS EXISTS (10x-plan-2 P0.1). Until now every Claude edit reached the
// document the same way: a separate process wrote the file and the extension
// found out by watching it change. That loses three things at once — the edit
// races whatever is unsaved in the editor, it can't be undone with Cmd+Z, and
// integrity is checked after the damage rather than before it. Hosting the
// server here inverts all three: Claude calls a tool, the tool runs the same
// shared op the CLI runs, and the write goes out as a `WorkspaceEdit` against
// the live TextDocument.
//
// What this file owns: starting/stopping the listener, resolving a
// caller-supplied path to a document inside the workspace, applying edits, and
// telling Claude Code where to find us. The verbs are in `tools.ts`, the wire
// protocol in `protocol.ts`, the socket in `httpServer.ts`.
//
// MCP is never the default (see docs/10x-plan-2.md): the server runs, but the
// send-mode picker only *offers* it, and terminal/clipboard/CLI keep working
// unchanged for any Claude session that can't reach it.

import { randomBytes } from "node:crypto";
import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { isInsideRoot } from "../pathUtils";
import { claudePending } from "../claudePendingService";
import { minimalEdit } from "../inlineComments/minimalEdit";
import { serveMcp, type McpHttpServer } from "./httpServer";
import { callTool, TOOLS, ToolRefusal, type ToolDeps } from "./tools";
import {
  DESCRIPTOR_REL,
  ENV_TOKEN,
  ENV_URL,
  MCP_SERVER_NAME,
  descriptorJson,
  mergeMcpJson,
  preferredPort,
} from "./registration";

const SERVER_INSTRUCTIONS =
  "Markdown Collab review tools. Threads and suggestions live inline in the .md file; these tools are the " +
  "only safe way to change them — never hand-edit `<!--mc:...-->` markers. Start with mc_list, act with " +
  "mc_reply / mc_open / mc_rewrite / mc_suggest, and finish every file with mc_check (which also tells the " +
  "human you are done). Writes go through the editor, so the human can undo them.";

export interface McpServerHandle {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  dispose(): void;
}

/** Callbacks the rest of the extension wires in (lifecycle signals land here). */
export interface McpHostDeps {
  log: Logger;
  /** Fired for every tool call, before it runs. */
  onToolCall?(event: { tool: string; file?: string; note?: string }): void;
}

let running: (McpServerHandle & { server: McpHttpServer }) | null = null;

/** The live server, or null when it isn't running. */
export function currentMcpServer(): McpServerHandle | null {
  return running;
}

/**
 * Resolve a caller-supplied path to a `.md` file inside one of the workspace
 * folders. Everything else is refused: a tool server reachable from a model is
 * not a general filesystem.
 */
export async function resolveWorkspaceFile(file: string): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates: string[] = path.isAbsolute(file)
    ? [file]
    : folders.map((f) => path.join(f.uri.fsPath, file));
  if (candidates.length === 0) {
    throw new ToolRefusal("no_workspace", "no workspace folder is open; open the folder holding the document");
  }
  for (const candidate of candidates) {
    const inside = folders.some((f) => isInsideRoot(candidate, f.uri.fsPath));
    if (!inside) continue;
    const uri = vscode.Uri.file(candidate);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) continue;
      return uri;
    } catch {
      continue;
    }
  }
  throw new ToolRefusal(
    "file_not_found",
    `no such file inside the workspace: ${file}. Paths must be inside an open workspace folder.`,
    { file },
  );
}

/**
 * Apply `next` to the document as a `WorkspaceEdit`, then save.
 *
 * Three properties this buys over a raw disk write, all of them the point of
 * P0.1: the edit is ordered against the buffer's unsaved state instead of
 * racing it, it joins the editor's undo stack (Cmd+Z undoes Claude), and every
 * open view re-renders from the document-change event it already listens to.
 */
async function applyDocumentEdit(uri: vscode.Uri, next: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const change = minimalEdit(doc.getText(), next);
  if (!change) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)),
    change.replacement,
  );
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("the editor rejected the edit (the document may have changed underneath it)");
  }
  // Review state is meant to be on disk the moment it is written — the same
  // rule the panels follow after every mutation. `save()` also answers false
  // when there was nothing to save (a reload landed the same bytes first), so
  // the dirty flag, not the return value, is what says the write is lost.
  const saved = await doc.save();
  if (!saved && doc.isDirty) {
    throw new Error("the edit applied but the file could not be saved");
  }
}

export function buildToolDeps(deps: McpHostDeps): ToolDeps {
  return {
    resolveFile: async (file) => (await resolveWorkspaceFile(file)).toString(),
    readDoc: async (key) => (await vscode.workspace.openTextDocument(vscode.Uri.parse(key))).getText(),
    writeDoc: async (key, next) => applyDocumentEdit(vscode.Uri.parse(key), next),
    onCall: (event) => {
      // One line per tool call is the transcript of what Claude actually did.
      // Without it a refused or misrouted call is invisible: the model sees the
      // error, the human sees a document that didn't change.
      deps.log.info("tool call", {
        tool: event.tool,
        file: event.file
          ? vscode.workspace.asRelativePath(vscode.Uri.parse(event.file))
          : undefined,
        note: event.note,
      });
      deps.onToolCall?.(event);
    },
    onRefusal: (event) => {
      deps.log.warn("tool call refused", event);
    },
  };
}

/**
 * Turn tool calls into lifecycle signals (10x-plan-2 P0.2).
 *
 * This is what replaces the guessing. A call against a document is hard
 * evidence Claude is working on it; `mc_status` says what it's doing; and the
 * closing `mc_check` — which the skill runs on every file it touched — is the
 * end of the pass. The timer stays only as a silence detector.
 *
 * `mc_status` without a file applies to every document currently waiting: the
 * beacon is about the pass, and a multi-file pass reports phases like "reading
 * 2 of 3" that belong to all of them.
 */
export function pendingSignalsFromToolCalls(event: {
  tool: string;
  file?: string;
  note?: string;
}): void {
  if (event.tool === "mc_status") {
    if (event.file) claudePending.noteActivity(event.file, { phase: event.note });
    else claudePending.noteActivityEverywhere({ phase: event.note });
    return;
  }
  if (!event.file) return;
  // The skill ends each file with mc_check, so that call is the completion
  // signal. Anything else is progress.
  if (event.tool === "mc_check") claudePending.noteComplete(event.file);
  else claudePending.noteActivity(event.file);
}

/**
 * Start the server for this window. Returns null (and logs) when it can't bind,
 * because a missing MCP server must never break the extension: every other send
 * mode still works without it.
 */
export async function startMcpServer(
  context: vscode.ExtensionContext,
  deps: McpHostDeps,
): Promise<McpServerHandle | null> {
  if (running) return running;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;

  // Fresh per session. A token that outlived a window would be a credential
  // sitting in a file with no process behind it.
  const token = randomBytes(32).toString("hex");
  const toolDeps = buildToolDeps(deps);

  let server: McpHttpServer;
  try {
    server = await serveMcp({
      token,
      port: preferredPort(folder.uri.fsPath),
      onError: (m) => deps.log.warn("transport error", m),
      handlers: {
        serverInfo: { name: MCP_SERVER_NAME, version: extensionVersion(context) },
        instructions: SERVER_INSTRUCTIONS,
        tools: TOOLS,
        callTool: (name, args) => callTool(name, args, toolDeps),
      },
    });
  } catch (e) {
    deps.log.error("could not start the tool server", e);
    return null;
  }

  // Terminals VS Code spawns inherit these, which is how `.mcp.json`'s
  // `${VAR}` references resolve without a secret in the repo.
  context.environmentVariableCollection.replace(ENV_URL, server.url);
  context.environmentVariableCollection.replace(ENV_TOKEN, token);
  context.environmentVariableCollection.description =
    "Markdown Collab: MCP tool server address and per-session token";

  await writeDescriptor(folder.uri, { url: server.url, port: server.port, token, version: extensionVersion(context) });

  // The port, not the URL: the URL carries the session token.
  deps.log.info("tool server listening", { port: server.port });

  const handle = {
    url: server.url,
    port: server.port,
    token,
    server,
    dispose: (): void => {
      running = null;
      context.environmentVariableCollection.clear();
      void removeDescriptor(folder.uri);
      void server.close();
      deps.log.info("tool server stopped");
    },
  };
  running = handle;
  return handle;
}

function extensionVersion(context: vscode.ExtensionContext): string {
  return (context.extension?.packageJSON?.version as string | undefined) ?? "0.0.0";
}

async function writeDescriptor(
  folder: vscode.Uri,
  d: { url: string; port: number; token: string; version: string },
): Promise<void> {
  const uri = vscode.Uri.joinPath(folder, ...DESCRIPTOR_REL.split("/"));
  const body = descriptorJson({ ...d, pid: process.pid, startedAt: new Date().toISOString() });
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, ".markdown-collab"));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(body, "utf8"));
  } catch {
    // Best effort: the env-var path is the one that matters, and a workspace
    // that can't be written to is not a reason to refuse to serve.
  }
}

async function removeDescriptor(folder: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, ...DESCRIPTOR_REL.split("/")));
  } catch {
    /* already gone */
  }
}

const CONSENT_KEY = "markdownCollab.mcpJsonConsent";

/**
 * Offer to register the server in the workspace's `.mcp.json`, once per
 * workspace. `.mcp.json` is a file people commit and review, so it is never
 * written without a yes — and the answer (either way) is remembered.
 */
export async function ensureMcpJsonRegistration(
  context: vscode.ExtensionContext,
  handle: McpServerHandle,
  log: Logger,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const key = `${CONSENT_KEY}:${folder.uri.toString()}`;
  const answer = context.workspaceState.get<"yes" | "no">(key);
  if (answer === "no") return;

  const uri = vscode.Uri.joinPath(folder.uri, ".mcp.json");
  let existing: string | null = null;
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    existing = null;
  }

  if (answer !== "yes") {
    const choice = await vscode.window.showInformationMessage(
      "Let Claude Code call Markdown Collab's review tools directly? This adds a `markdown-collab` entry to " +
        "`.mcp.json` in this workspace. No token is written to the file — it travels through the terminal " +
        "environment. Sending stays on your current mode unless you pick MCP.",
      "Add to .mcp.json",
      "Not now",
    );
    if (choice !== "Add to .mcp.json") {
      // "Not now" is remembered so this isn't asked on every activation; the
      // command re-offers it when the human wants it.
      await context.workspaceState.update(key, "no");
      return;
    }
    await context.workspaceState.update(key, "yes");
  }

  try {
    const merged = mergeMcpJson(existing, handle.port);
    if (merged.text === null) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(merged.text, "utf8"));
    log.info("registered in .mcp.json", { action: merged.replaced ? "updated" : "added", server: MCP_SERVER_NAME });
  } catch (e) {
    void vscode.window.showWarningMessage(`Markdown Collab: could not update .mcp.json — ${(e as Error).message}`);
  }
}

/** Forget the remembered `.mcp.json` answer so the offer comes back. */
export async function resetMcpJsonConsent(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  await context.workspaceState.update(`${CONSENT_KEY}:${folder.uri.toString()}`, undefined);
}
