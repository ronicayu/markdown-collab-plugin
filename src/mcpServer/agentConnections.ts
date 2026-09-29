// Wiring for "Connect an Agent" (10x-plan-4 P1.1): which clients are hooked
// up, and keeping them hooked up across restarts.
//
// Since 10x-plan-6 P1.1 everything here is the optional second step for the
// agents that aren't Claude Code: Connect writes AGENTS.md first (see
// `connectFormatFirst` in commands/setup.ts), because the file format is what
// those agents are held to, and only then offers a registration from here.
//
// Two different kinds of "stay connected":
//   - Cursor CLI's `.cursor/mcp.json` and Codex's `.codex/config.toml` are
//     files. `.cursor/mcp.json` references the env vars the way Cursor CLI
//     can, so it never goes stale once written; `.codex/config.toml` carries
//     a literal port, so it can go stale, but the file *having our table at
//     all* is the remembered "yes" — same idea as `.mcp.json`'s consent, just
//     stored in the file instead of `workspaceState`. Either way, no
//     `workspaceState` bookkeeping is needed for these two.
//   - Cursor's in-app agent and Copilot's agent mode are told the URL and
//     token directly, in-process, every session — there is no file to leave
//     behind, which also means there is nothing to reconnect to after a
//     restart unless we do it ourselves. That's what the `workspaceState`
//     tracking below is for, and `reconnectAgents` is the "ourselves": run
//     once per activation, after the server has a port and a token, it
//     re-registers whichever of these the workspace previously connected.
//
// Nothing here writes a file the human didn't ask for (Codex's self-heal only
// ever *rewrites* a table that's already there, never creates one), and
// nothing here ever writes a token to disk — only Codex's config carries a
// port, and only because `bearer_token_env_var` is the one part of its config
// Codex is willing to read from the environment instead.

import { lstat } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import type { McpServerHandle } from "./index";
import { MCP_SERVER_NAME, removeMcpJsonEntry } from "./registration";
import { mergeCursorMcpJson, removeCursorMcpEntry } from "./clients/cursor";
import { codexTablePresent, mergeCodexToml, removeCodexTable } from "./clients/codex";
import { genericSnippet } from "./clients/generic";
import { CopilotMcpProvider, COPILOT_PROVIDER_ID, hasCopilotProviderApi } from "./clients/copilot";

export type SessionAgentId = "cursor-inapp" | "copilot";

const CONNECTED_KEY_PREFIX = "markdownCollab.connectedAgents";

function workspaceKey(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? `${CONNECTED_KEY_PREFIX}:${folder.uri.toString()}` : null;
}

function connectedSet(context: vscode.ExtensionContext): Set<SessionAgentId> {
  const key = workspaceKey();
  if (!key) return new Set();
  return new Set(context.workspaceState.get<SessionAgentId[]>(key, []));
}

/** Whether Connect an Agent → `id` was run in this workspace (remembered only
 *  for the two session-scoped clients — see the file header). */
export function isAgentConnected(context: vscode.ExtensionContext, id: SessionAgentId): boolean {
  return connectedSet(context).has(id);
}

/** Remember that `id` was connected, so activation re-registers it next time. */
export async function markAgentConnected(context: vscode.ExtensionContext, id: SessionAgentId): Promise<void> {
  const key = workspaceKey();
  if (!key) return;
  const set = connectedSet(context);
  set.add(id);
  await context.workspaceState.update(key, Array.from(set));
}

/** Forget that `id` was connected (4.4: Disconnect Agent) — the inverse of `markAgentConnected`, so `reconnectAgents` doesn't resurrect it on the next restart. */
export async function markAgentDisconnected(context: vscode.ExtensionContext, id: SessionAgentId): Promise<void> {
  const key = workspaceKey();
  if (!key) return;
  const set = connectedSet(context);
  set.delete(id);
  await context.workspaceState.update(key, Array.from(set));
}

// ---------------------------------------------------------------------------
// Cursor (in-app agent)
// ---------------------------------------------------------------------------

/** Cursor exposes this beyond the standard vscode API — verified 2026-09
 *  against `vscode.cursor.mcp.{register,unregister}Server`. Absent
 *  everywhere else, including plain VS Code, so this is the feature-detect
 *  every call site guards on rather than assuming from any version field. */
export function hasCursorInAppApi(): boolean {
  return typeof (vscode as unknown as { cursor?: { mcp?: { registerServer?: unknown } } }).cursor?.mcp
    ?.registerServer === "function";
}

/** Register directly with Cursor's in-app agent: live URL + token, no file —
 *  its agent doesn't run in a terminal, so the env-var trick `.cursor/mcp.json`
 *  and `.mcp.json` rely on doesn't reach it. */
export function registerCursorInApp(handle: Pick<McpServerHandle, "url" | "token">): void {
  const cursor = (
    vscode as unknown as {
      cursor: { mcp: { registerServer: (opts: unknown) => void } };
    }
  ).cursor;
  cursor.mcp.registerServer({
    name: MCP_SERVER_NAME,
    server: { url: handle.url, headers: { Authorization: `Bearer ${handle.token}` } },
  });
}

/**
 * Unregister from Cursor's in-app agent (4.4: Disconnect Agent) — the
 * inverse of `registerCursorInApp`. Nothing was ever written to disk for
 * this client, so this is the entire undo: the live registration goes away
 * for the rest of the session.
 */
export function unregisterCursorInApp(): void {
  const cursor = (
    vscode as unknown as {
      cursor: { mcp: { unregisterServer: (name: string) => void } };
    }
  ).cursor;
  cursor.mcp.unregisterServer(MCP_SERVER_NAME);
}

// ---------------------------------------------------------------------------
// GitHub Copilot (agent mode)
// ---------------------------------------------------------------------------

let copilotProvider: CopilotMcpProvider | null = null;

/**
 * Register the Copilot provider at activation whenever the host supports it
 * (see `hasCopilotProviderApi`) — older forks (Cursor, Windsurf, VSCodium)
 * simply don't have the API, and we never raise `engines.vscode` to force the
 * question. Safe to call once per activation; the returned provider is also
 * reachable later via `currentCopilotProvider()` (the command handler and the
 * post-restart self-heal both need the same instance, not a fresh one).
 */
export function activateCopilotProvider(context: vscode.ExtensionContext): CopilotMcpProvider | null {
  if (!hasCopilotProviderApi()) return null;
  const provider = new CopilotMcpProvider();
  const sub = vscode.lm.registerMcpServerDefinitionProvider(COPILOT_PROVIDER_ID, provider);
  context.subscriptions.push(sub, provider);
  copilotProvider = provider;
  return provider;
}

/** The provider registered by `activateCopilotProvider`, or null when this
 *  host doesn't support the API (or activation hasn't run yet). */
export function currentCopilotProvider(): CopilotMcpProvider | null {
  return copilotProvider;
}

// ---------------------------------------------------------------------------
// File writers (Cursor CLI, Codex) and the generic fallback
// ---------------------------------------------------------------------------

export type FileWriteOutcome = "written" | "unchanged";

/**
 * Refuse to write through a symlink (L5): `lstat` the target itself (if it
 * exists) and its parent directory, following neither. A symlinked
 * `.cursor/`, `.codex/`, or `.mcp.json` could otherwise land one of the
 * writers/removers below somewhere outside the workspace the human never
 * agreed to touch. Duplicated (rather than shared) in `agents.ts` and
 * `mcpServer/index.ts`, which guard the same class of write for AGENTS.md and
 * `.mcp.json`'s own create path — each is small and self-contained, and none
 * of the three otherwise depends on the others.
 */
export async function refuseSymlink(targetUri: vscode.Uri): Promise<string | null> {
  for (const p of [path.dirname(targetUri.fsPath), targetUri.fsPath]) {
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink()) return `${p} is a symlink`;
    } catch {
      /* doesn't exist yet — nothing to refuse there */
    }
  }
  return null;
}

/** Throw when `refuseSymlink` finds one — the shared refusal every writer/remover below opens with. */
async function guardAgainstSymlink(targetUri: vscode.Uri): Promise<void> {
  const reason = await refuseSymlink(targetUri);
  if (reason) throw new Error(`refusing to write through a symlink: ${reason}`);
}

async function readWorkspaceFile(uri: vscode.Uri): Promise<string | null> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return null;
  }
}

/** Write/merge `.cursor/mcp.json` for Cursor CLI. Always safe to call: the
 *  entry never carries a port or a token, so there is nothing to rewrite on a
 *  later restart (see the file header) — this is only ever invoked from the
 *  Connect an Agent command, never from activation. */
export async function writeCursorCliConfig(folder: vscode.Uri): Promise<FileWriteOutcome> {
  const dir = vscode.Uri.joinPath(folder, ".cursor");
  const uri = vscode.Uri.joinPath(dir, "mcp.json");
  await guardAgainstSymlink(uri);
  const existing = await readWorkspaceFile(uri);
  const merged = mergeCursorMcpJson(existing);
  if (merged.text === null) return "unchanged";
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(merged.text, "utf8"));
  return "written";
}

/** Write/merge `[mcp_servers.markdown-collab]` into `.codex/config.toml`.
 *  Called from the Connect an Agent command — unlike `reconcileCodexConfig`
 *  below, this one is allowed to create the table (and the file) fresh. */
export async function writeCodexConfig(folder: vscode.Uri, port: number): Promise<FileWriteOutcome> {
  const dir = vscode.Uri.joinPath(folder, ".codex");
  const uri = vscode.Uri.joinPath(dir, "config.toml");
  await guardAgainstSymlink(uri);
  const existing = await readWorkspaceFile(uri);
  const merged = mergeCodexToml(existing, port);
  if (merged.text === null) return "unchanged";
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(merged.text, "utf8"));
  return "written";
}

// ---------------------------------------------------------------------------
// File removers (4.4: Disconnect Agent) — the inverse of the writers above.
// Each is idempotent: called on a workspace that never connected, it reads
// the file, finds nothing of ours, and writes nothing back.
// ---------------------------------------------------------------------------

/** Remove the `markdown-collab` entry from the workspace's `.mcp.json`, leaving every other server untouched. */
export async function removeClaudeMcpJson(folder: vscode.Uri): Promise<FileWriteOutcome> {
  const uri = vscode.Uri.joinPath(folder, ".mcp.json");
  await guardAgainstSymlink(uri);
  const existing = await readWorkspaceFile(uri);
  const outcome = removeMcpJsonEntry(existing);
  if (outcome.text === null) return "unchanged";
  await vscode.workspace.fs.writeFile(uri, Buffer.from(outcome.text, "utf8"));
  return "written";
}

/** Remove the `markdown-collab` entry from `.cursor/mcp.json`, leaving every other server untouched. */
export async function removeCursorCliConfig(folder: vscode.Uri): Promise<FileWriteOutcome> {
  const uri = vscode.Uri.joinPath(folder, ".cursor", "mcp.json");
  await guardAgainstSymlink(uri);
  const existing = await readWorkspaceFile(uri);
  const outcome = removeCursorMcpEntry(existing);
  if (outcome.text === null) return "unchanged";
  await vscode.workspace.fs.writeFile(uri, Buffer.from(outcome.text, "utf8"));
  return "written";
}

/** Remove the `[mcp_servers.markdown-collab]` table from `.codex/config.toml`, leaving every other table untouched. */
export async function removeCodexConfig(folder: vscode.Uri): Promise<FileWriteOutcome> {
  const uri = vscode.Uri.joinPath(folder, ".codex", "config.toml");
  await guardAgainstSymlink(uri);
  const existing = await readWorkspaceFile(uri);
  const outcome = removeCodexTable(existing);
  if (outcome.text === null) return "unchanged";
  await vscode.workspace.fs.writeFile(uri, Buffer.from(outcome.text, "utf8"));
  return "written";
}

/**
 * Self-heal for Codex: only rewrites a table that's already there. The table
 * existing at all is the remembered "yes" (no `workspaceState` needed, unlike
 * the two session-scoped clients above) — but its `url` carries a literal
 * port, so a workspace whose port moved since the table was written needs the
 * rewrite, on every activation, the same way `.mcp.json` gets one. Never
 * creates the table: that would be writing a file the human never asked for.
 */
export async function reconcileCodexConfig(folder: vscode.Uri, port: number): Promise<void> {
  const uri = vscode.Uri.joinPath(folder, ".codex", "config.toml");
  const existing = await readWorkspaceFile(uri);
  if (existing === null || !codexTablePresent(existing)) return;
  const merged = mergeCodexToml(existing, port);
  if (merged.text === null) return;
  await guardAgainstSymlink(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(merged.text, "utf8"));
}

/** Open the "Other agent" scratch document. Nothing is written to disk. */
export async function openGenericSnippetDocument(handle: Pick<McpServerHandle, "url" | "token">): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: genericSnippet(handle.url, handle.token),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc);
}

// ---------------------------------------------------------------------------
// Activation-time self-heal
// ---------------------------------------------------------------------------

/**
 * Re-establish every client whose connection can go stale across a restart —
 * the session-scoped ones from `workspaceState`, and Codex's config if its
 * table's port is out of date. Called once per activation, right after the
 * server has a handle (see `extension.ts`); a fresh window mints a fresh
 * token and, occasionally, a fresh port, and this is what makes a workspace
 * that connected an agent last session not have to run the command again.
 */
export async function reconnectAgents(
  context: vscode.ExtensionContext,
  handle: McpServerHandle,
  log: Logger,
): Promise<void> {
  if (isAgentConnected(context, "cursor-inapp") && hasCursorInAppApi()) {
    try {
      registerCursorInApp(handle);
      log.info("re-registered with Cursor's in-app agent");
    } catch (e) {
      log.warn("could not re-register with Cursor's in-app agent", e);
    }
  }

  const provider = currentCopilotProvider();
  if (provider && isAgentConnected(context, "copilot")) {
    provider.setConnected(true);
    provider.setLiveServer({ url: handle.url, token: handle.token });
    log.info("re-provided the Copilot MCP server definition");
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    try {
      await reconcileCodexConfig(folder.uri, handle.port);
    } catch (e) {
      log.warn("could not refresh .codex/config.toml", e);
    }
  }
}
