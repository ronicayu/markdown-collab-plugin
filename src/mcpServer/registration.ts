// Making the server discoverable to Claude Code, without committing a secret.
//
// `.mcp.json` is a project file people check in, so it must never contain the
// token — and it can't contain a literal port either, because the port moves
// when it's taken. Claude Code expands `${VAR}` and `${VAR:-default}` in an
// http server's `url` and `headers` (verified against the MCP docs, 2026-07),
// so the entry references two environment variables and the extension supplies
// them through VS Code's `EnvironmentVariableCollection` — which every terminal
// VS Code spawns inherits, including the one the default send mode starts
// Claude in.
//
// What each side degrades to:
//   - Claude launched outside this window: the vars are unset, the URL falls
//     back to the last known port and the Authorization header stays literal,
//     so the server answers 401 and Claude Code reports the server as needing
//     auth. The CLI and terminal paths keep working — that is the whole reason
//     they stay (10x-plan-2: MCP is never the default).
//   - Someone clones the repo without the extension: same, plus nothing secret
//     leaked, because nothing secret was ever written here.

/** Server name in `.mcp.json`, and the prefix Claude sees on tool names. */
export const MCP_SERVER_NAME = "markdown-collab";

/** Environment variables the extension injects into VS Code terminals. */
export const ENV_URL = "MARKDOWN_COLLAB_MCP_URL";
export const ENV_TOKEN = "MARKDOWN_COLLAB_MCP_TOKEN";

/** Gitignored, 0600 — the descriptor a non-terminal client can read. */
export const DESCRIPTOR_REL = ".markdown-collab/.mcp-server.json";

export interface McpJsonEntry {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

/**
 * The `.mcp.json` entry for a server currently listening on `port`. The literal
 * port is only the fallback for a session that didn't inherit the env var.
 */
export function mcpJsonEntry(port: number): McpJsonEntry {
  return {
    type: "http",
    url: `\${${ENV_URL}:-http://127.0.0.1:${port}/mcp}`,
    headers: { Authorization: `Bearer \${${ENV_TOKEN}}` },
  };
}

export interface MergeResult {
  /** The file text to write, or null when nothing needed to change. */
  text: string | null;
  /** True when an entry under our name already existed and was replaced. */
  replaced: boolean;
}

/**
 * Merge our entry into an existing `.mcp.json`, preserving every other server
 * and the file's own formatting decisions as far as JSON allows. Returns
 * `text: null` when the file already says exactly this, so a workspace whose
 * port hasn't moved isn't rewritten on every activation.
 */
export function mergeMcpJson(existing: string | null, port: number): MergeResult {
  const entry = mcpJsonEntry(port);
  let root: Record<string, unknown> = {};
  if (existing && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (e) {
      // Refuse rather than clobber: a malformed .mcp.json is the user's file
      // with the user's other servers in it.
      throw new Error(`.mcp.json is not valid JSON (${(e as Error).message}); leaving it alone`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".mcp.json does not contain a JSON object; leaving it alone");
    }
    root = parsed as Record<string, unknown>;
  }
  const servers =
    typeof root.mcpServers === "object" && root.mcpServers !== null && !Array.isArray(root.mcpServers)
      ? { ...(root.mcpServers as Record<string, unknown>) }
      : {};
  const previous = servers[MCP_SERVER_NAME];
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) {
    return { text: null, replaced: true };
  }
  servers[MCP_SERVER_NAME] = entry;
  const next = { ...root, mcpServers: servers };
  return { text: `${JSON.stringify(next, null, 2)}\n`, replaced: previous !== undefined };
}

export interface ServerDescriptor {
  url: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  /** So a stale descriptor from an older build is recognisable. */
  version: string;
}

export function descriptorJson(d: ServerDescriptor): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

/**
 * A deterministic starting port per workspace, in the ephemeral range.
 * Not a guarantee — `serveMcp` falls back when it's taken — but it means the
 * URL in `.mcp.json` usually stays correct across restarts, which is the
 * difference between "reconnects silently" and "the human re-runs setup".
 */
export function preferredPort(workspacePath: string): number {
  let h = 2166136261;
  for (let i = 0; i < workspacePath.length; i++) {
    h ^= workspacePath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 49152–65535 is the IANA dynamic range; keep clear of the last 256 so a
  // fallback scan has somewhere to go.
  return 49152 + (Math.abs(h) % (65535 - 49152 - 256));
}
