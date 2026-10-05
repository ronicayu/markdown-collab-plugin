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
import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { isInsideRoot } from "../pathUtils";
import { claudePending } from "../claudePendingService";
import { reviewPassPending } from "../reviewPassPendingService";
import { minimalEdit } from "../inlineComments/minimalEdit";
import { serveMcp, type McpHttpServer } from "./httpServer";
import { SessionRegistry } from "./sessions";
import { callTool, TOOLS, ToolRefusal, type ToolDeps } from "./tools";
import { renderMcpInstructions } from "../skillText";
import {
  DESCRIPTOR_REL,
  ENV_TOKEN,
  ENV_URL,
  MCP_SERVER_NAME,
  descriptorJson,
  mergeMcpJson,
  preferredPort,
} from "./registration";

export interface McpServerHandle {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  dispose(): void;
}

/** Callbacks the rest of the extension wires in (lifecycle signals land here). */
export interface McpHostDeps {
  log: Logger;
  /** Fired for every tool call, before it runs. `agent` is the calling
   * session's slug (10x-plan-4 P1.2) — Claude when the client is Claude Code,
   * whatever `agentSlugFromClientName` resolved otherwise. */
  onToolCall?(event: { tool: string; file?: string; note?: string; agent: string }): void;
}

let running: (McpServerHandle & { server: McpHttpServer }) | null = null;

/** The live server, or null when it isn't running. */
export function currentMcpServer(): McpServerHandle | null {
  return running;
}

/** Extensions a tool call is ever allowed to touch (L1). */
const EDITABLE_EXTENSIONS = new Set([".md", ".markdown"]);
/** Path segments that must never appear in a tool-editable file, even one
 *  lexically inside the workspace: repo config and editor settings are not
 *  the document review surface this server exists for. */
const FORBIDDEN_SEGMENTS = new Set([".git", ".vscode"]);

/**
 * Syntactic check only, no filesystem access: `.md`/`.markdown` extension,
 * and no path segment named `.git` or `.vscode`. Applied twice — to the
 * lexical candidate and again to its resolved real path (L1) — so a symlink
 * can't launder either rule.
 */
function looksEditable(candidate: string): boolean {
  const ext = path.extname(candidate).toLowerCase();
  if (!EDITABLE_EXTENSIONS.has(ext)) return false;
  return !candidate.split(/[\\/]+/).some((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

/**
 * Resolve a caller-supplied path to a `.md`/`.markdown` file inside one of the
 * workspace folders. Everything else is refused: a tool server reachable from
 * a model is not a general filesystem (L1) — `mc_edit` must not be able to
 * reach `.git/config` or `.vscode/tasks.json` just because they sit lexically
 * inside the workspace, and a symlink must not be able to smuggle a call
 * anywhere `fs.realpath` says is actually outside it.
 */
export async function resolveWorkspaceFile(file: string): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates: string[] = path.isAbsolute(file)
    ? [file]
    : folders.map((f) => path.join(f.uri.fsPath, file));
  if (candidates.length === 0) {
    throw new ToolRefusal("no_workspace", "no workspace folder is open; open the folder holding the document");
  }
  // Real paths of the workspace roots themselves, computed once: comparing a
  // symlink-resolved candidate against a lexical root would misfire on any
  // machine where part of the root's own path is a symlink (macOS's /tmp ->
  // /private/tmp, for one) — the same reasoning that resolves the candidate.
  const realFolderRoots = await Promise.all(
    folders.map((f) => fsp.realpath(f.uri.fsPath).catch(() => f.uri.fsPath)),
  );
  let sawWrongKind = false;
  for (const candidate of candidates) {
    const inside = folders.some((f) => isInsideRoot(candidate, f.uri.fsPath));
    if (!inside) continue; // unchanged: falls through to file_not_found below, same as before L1
    if (!looksEditable(candidate)) {
      sawWrongKind = true;
      continue;
    }
    const uri = vscode.Uri.file(candidate);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      continue;
    }
    if (stat.type === vscode.FileType.Directory) continue;
    // A symlink can point anywhere; require its real target to still be an
    // editable path inside the workspace, not just the link itself.
    let real: string;
    try {
      real = await fsp.realpath(candidate);
    } catch {
      continue;
    }
    if (!realFolderRoots.some((root) => isInsideRoot(real, root))) {
      throw new ToolRefusal("outside_workspace", `${file} resolves, through a symlink, outside the open workspace`, {
        file,
      });
    }
    if (!looksEditable(real)) {
      throw new ToolRefusal(
        "not_markdown",
        `only .md/.markdown files can be edited, and never inside .git/ or .vscode/: ${file}`,
        { file },
      );
    }
    return uri;
  }
  if (sawWrongKind) {
    throw new ToolRefusal(
      "not_markdown",
      `only .md/.markdown files can be edited, and never inside .git/ or .vscode/: ${file}`,
      { file },
    );
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
    // 10x-plan-6 P2.1: read fresh on every call, never cached — the human can
    // flip `markdownCollab.proposeEditsAsSuggestions` mid-session (the
    // status-bar toggle, "Send to Claude"'s own checkbox) and the very next
    // tool call must see it. Scoped to the document's own URI: the setting is
    // declared "window"-scoped in package.json today, so every folder in a
    // multi-root workspace answers alike, but resolving against the resource
    // means a future per-folder scope needs no change here.
    suggestModeFor: (key) =>
      vscode.workspace.getConfiguration("markdownCollab", vscode.Uri.parse(key)).get<boolean>(
        "proposeEditsAsSuggestions",
        false,
      ),
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
        agent: event.agent,
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
 *
 * Feeds the review-pass tracker (`reviewPassPending`, 10x-plan-4 P2.2)
 * alongside the per-thread one, unconditionally: a tool call against a
 * document that isn't part of any live review pass is simply ignored there
 * (there's nothing to look up), so this never needs to know which of the two
 * — or both, or neither — actually apply.
 */
export function pendingSignalsFromToolCalls(event: {
  tool: string;
  file?: string;
  note?: string;
  agent: string;
}): void {
  if (event.tool === "mc_status") {
    if (event.file) {
      claudePending.noteActivity(event.file, { phase: event.note, agent: event.agent });
      reviewPassPending.noteActivity(event.file, { phase: event.note, agent: event.agent });
    } else {
      claudePending.noteActivityEverywhere({ phase: event.note, agent: event.agent });
      reviewPassPending.noteActivityEverywhere({ phase: event.note, agent: event.agent });
    }
    return;
  }
  if (!event.file) return;
  // The skill ends each file with mc_check, so that call is the completion
  // signal. Anything else is progress.
  if (event.tool === "mc_check") {
    claudePending.noteComplete(event.file);
    reviewPassPending.noteComplete(event.file);
  } else {
    claudePending.noteActivity(event.file, { agent: event.agent });
    reviewPassPending.noteActivity(event.file, { agent: event.agent });
  }
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
  if (!vscode.workspace.isTrusted) return null;
  if (running) return running;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;

  // Fresh per session. A token that outlived a window would be a credential
  // sitting in a file with no process behind it.
  const token = randomBytes(32).toString("hex");
  const toolDeps = buildToolDeps(deps);
  // One registry per running server: which agent a session belongs to is
  // only meaningful for as long as the connection issuing it is alive
  // (10x-plan-4 P1.2).
  const sessions = new SessionRegistry();

  let server: McpHttpServer;
  try {
    server = await serveMcp({
      token,
      port: preferredPort(folder.uri.fsPath),
      onError: (m) => deps.log.warn("transport error", m),
      handlers: {
        serverInfo: { name: MCP_SERVER_NAME, version: extensionVersion(context) },
        // The workflow in brief, from the same sections as the skill (10x-plan-4
        // P1.3): a client with no skill installed still learns list → act → check.
        instructions: renderMcpInstructions(),
        tools: TOOLS,
        callTool: (name, args, author) => callTool(name, args, toolDeps, author),
        recordSession: (sessionId, clientName) => sessions.record(sessionId, clientName),
        resolveAuthor: (sessionId) => sessions.slugFor(sessionId),
      },
    });
  } catch (e) {
    deps.log.error("could not start the tool server", e);
    return null;
  }

  // Terminals VS Code spawns inherit these, which is how `.mcp.json`'s
  // `${VAR}` references resolve without a secret in the repo.
  //
  // `persistent = false` (L2b): VS Code otherwise remembers this collection
  // across restarts in its own storage so a terminal that reopens before the
  // extension re-activates still sees it — exactly the credential-with-no-
  // server-behind-it this file already refuses to leave in `process.env` on
  // dispose (below), just in a different store. The token is fresh every
  // session; nothing about it is meant to survive one.
  context.environmentVariableCollection.persistent = false;
  context.environmentVariableCollection.replace(ENV_URL, server.url);
  context.environmentVariableCollection.replace(ENV_TOKEN, token);
  context.environmentVariableCollection.description =
    "Markdown Collab: MCP tool server address and per-session token";

  // Also set these directly on the extension host's own process (10x-plan-4
  // P1.1) — every extension shares this one process, so a CLI agent that
  // ANOTHER extension spawns after us (Claude Code's own VS Code extension
  // starting `claude`, the Codex IDE extension starting its app-server)
  // inherits them exactly like a VS Code terminal does, and `.mcp.json` /
  // `bearer_token_env_var` references resolve for those sessions too. This is
  // the same exposure `environmentVariableCollection` already gives every
  // terminal — same user, same machine, child processes either way — just
  // extended to a second kind of child process VS Code itself doesn't spawn.
  process.env[ENV_URL] = server.url;
  process.env[ENV_TOKEN] = token;

  await writeDescriptor(
    folder.uri,
    { url: server.url, port: server.port, token, version: extensionVersion(context) },
    deps.log,
  );

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
      // Mirror image of setting them above: leaving a stale URL/token in the
      // host process after the server that issued them is gone would let a
      // later-spawned agent believe a dead server is reachable.
      delete process.env[ENV_URL];
      delete process.env[ENV_TOKEN];
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

/** L2a: the README recommends ignoring everything under `.markdown-collab/`
 *  except `conventions.md` — this is what makes that true by construction
 *  rather than by the user remembering to write it themselves. */
const MC_GITIGNORE_BODY = "*\n!conventions.md\n!.gitignore\n";

/**
 * `.markdown-collab/`, created fresh if it doesn't exist, refused if it's a
 * symlink (L2a: the descriptor and its token must land inside a real,
 * predictable directory, not wherever a symlink happens to point — the same
 * reasoning L5 applies to the agent-connection config files), and carrying a
 * `.gitignore` that keeps everything but `conventions.md` (and itself) out of
 * version control.
 */
export async function ensureMarkdownCollabDir(dir: string): Promise<void> {
  let lst: import("node:fs").Stats | undefined;
  try {
    lst = await fsp.lstat(dir);
  } catch {
    lst = undefined;
  }
  if (lst?.isSymbolicLink()) {
    throw new Error(`${dir} is a symlink; refusing to write inside it`);
  }
  if (!lst) {
    await fsp.mkdir(dir, { recursive: true });
  }
  const gitignore = path.join(dir, ".gitignore");
  if (await refuseSymlink(gitignore)) return;
  try {
    await fsp.access(gitignore);
  } catch {
    await fsp.writeFile(gitignore, MC_GITIGNORE_BODY, "utf8");
  }
}

/**
 * Write the descriptor at mode 0600 (L2a) — `vscode.workspace.fs.writeFile`
 * lands at the process umask's default (0644 on a typical machine), which is
 * world-readable; Node's `fs` is what actually exposes file permissions, so
 * the descriptor switches to it here. `writeFile`'s own `mode` option only
 * takes effect when the file doesn't already exist, so an explicit `chmod`
 * follows to tighten a descriptor left over from a build before this fix, or
 * from a filesystem/umask that ignored the create-time mode.
 */
export async function writeDescriptorFile(filePath: string, body: string): Promise<void> {
  const symlink = await refuseSymlink(filePath);
  if (symlink) throw new Error(`refusing to write through a symlink: ${symlink}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(filePath, flags, 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function writeDescriptor(
  folder: vscode.Uri,
  d: { url: string; port: number; token: string; version: string },
  log: Logger,
): Promise<void> {
  const descriptorPath = path.join(folder.fsPath, ...DESCRIPTOR_REL.split("/"));
  const body = descriptorJson({ ...d, pid: process.pid, startedAt: new Date().toISOString() });
  try {
    await ensureMarkdownCollabDir(path.dirname(descriptorPath));
    await writeDescriptorFile(descriptorPath, body);
  } catch (e) {
    // Best effort: the env-var path is the one that matters, and a workspace
    // that can't be written to (or whose .markdown-collab is a symlink) is
    // not a reason to refuse to serve — but a symlink is worth a log line,
    // unlike a routine permission failure.
    log.warn("could not write the tool-server descriptor", e);
  }
}

async function removeDescriptor(folder: vscode.Uri): Promise<void> {
  try {
    await fsp.unlink(path.join(folder.fsPath, ...DESCRIPTOR_REL.split("/")));
  } catch {
    /* already gone */
  }
}

/**
 * Refuse to write through a symlink (L5): `lstat` the target itself (if it
 * exists) and its parent directory, following neither. A symlinked
 * `.mcp.json` or workspace root could otherwise land a write somewhere
 * outside the workspace the human never agreed to touch. Duplicated (rather
 * than shared) in `mcpServer/agentConnections.ts` and `agents.ts`, which
 * guard the same class of write for the other agent-connection files — each
 * is small and self-contained, and none of the three otherwise depends on
 * the others.
 */
async function refuseSymlink(targetFsPath: string): Promise<string | null> {
  for (const p of [path.dirname(targetFsPath), targetFsPath]) {
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) return `${p} is a symlink`;
    } catch {
      /* doesn't exist yet — nothing to refuse there */
    }
  }
  return null;
}

const CONSENT_KEY = "markdownCollab.mcpJsonConsent";

/** What `ensureMcpJsonRegistration` actually did, for a caller (the Connect
 *  an Agent command) that wants to show its own toast only when something
 *  really happened rather than after a declined consent prompt. */
export type McpJsonRegistrationOutcome = "declined" | "written" | "unchanged";

/**
 * Offer to register the server in the workspace's `.mcp.json`, once per
 * workspace. `.mcp.json` is a file people commit and review, so it is never
 * written without a yes — and the answer (either way) is remembered.
 */
export async function ensureMcpJsonRegistration(
  context: vscode.ExtensionContext,
  handle: McpServerHandle,
  log: Logger,
): Promise<McpJsonRegistrationOutcome> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "declined";
  const key = `${CONSENT_KEY}:${folder.uri.toString()}`;
  const answer = context.workspaceState.get<"yes" | "no">(key);
  if (answer === "no") return "declined";

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
      return "declined";
    }
    await context.workspaceState.update(key, "yes");
  }

  try {
    const merged = mergeMcpJson(existing, handle.port);
    if (merged.text === null) return "unchanged";
    // L5: refuse a symlinked .mcp.json (or workspace root) rather than follow
    // it — the same guard agentConnections.ts's writers apply to the other
    // agent-connection config files.
    const symlink = await refuseSymlink(uri.fsPath);
    if (symlink) throw new Error(`refusing to write through a symlink: ${symlink}`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(merged.text, "utf8"));
    log.info("registered in .mcp.json", { action: merged.replaced ? "updated" : "added", server: MCP_SERVER_NAME });
    return "written";
  } catch (e) {
    void vscode.window.showWarningMessage(`Markdown Collab: could not update .mcp.json — ${(e as Error).message}`);
    return "declined";
  }
}

/** Forget the remembered `.mcp.json` answer so the offer comes back. */
export async function resetMcpJsonConsent(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  await context.workspaceState.update(`${CONSENT_KEY}:${folder.uri.toString()}`, undefined);
}
