// Cursor CLI (`cursor-agent`) — 10x-plan-4 P1.1.
//
// `cursor-agent` reads a project's `.cursor/mcp.json` and interpolates
// `${env:NAME}` inside `url` and `headers` (verified against Cursor's docs,
// 2026-09). Launched from a VS Code terminal it inherits the same
// `MARKDOWN_COLLAB_MCP_URL` / `MARKDOWN_COLLAB_MCP_TOKEN` env vars Claude
// Code's `.mcp.json` entry already relies on — so this file carries neither a
// literal port nor a token, only the two references. That also means, unlike
// `.mcp.json` and Codex's `.codex/config.toml`, it never needs rewriting when
// the port moves: once written it stays correct for the life of the
// workspace.
//
// (This is the Cursor *CLI*. Cursor's in-app agent is a different client —
// it doesn't run in a terminal, so env vars don't reach it, and it's
// registered programmatically instead. See `mcpServer/agentConnections.ts`.)

import {
  ENV_TOKEN,
  ENV_URL,
  MCP_SERVER_NAME,
  mergeMcpServersJson,
  removeMcpServersJsonEntry,
  type MergeResult,
  type RemovalResult,
} from "../registration";

export interface CursorMcpEntry {
  url: string;
  headers: Record<string, string>;
}

/** The `.cursor/mcp.json` entry. No port, no token — env references only. */
export function cursorMcpEntry(): CursorMcpEntry {
  return {
    url: `\${env:${ENV_URL}}`,
    headers: { Authorization: `Bearer \${env:${ENV_TOKEN}}` },
  };
}

/**
 * Merge our entry into an existing `.cursor/mcp.json`, reusing the same
 * "mcpServers" JSON merge `.mcp.json` uses (`registration.ts`) — the shape of
 * the file is identical, only the entry's contents differ.
 */
export function mergeCursorMcpJson(existing: string | null): MergeResult {
  return mergeMcpServersJson(existing, MCP_SERVER_NAME, cursorMcpEntry());
}

/** The inverse of `mergeCursorMcpJson` (4.4: Disconnect Agent → Cursor CLI). */
export function removeCursorMcpEntry(existing: string | null): RemovalResult {
  return removeMcpServersJsonEntry(existing, MCP_SERVER_NAME);
}
