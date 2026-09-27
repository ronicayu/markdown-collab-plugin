// Codex CLI — 10x-plan-4 P1.1.
//
// Codex reads `~/.codex/config.toml` and, for projects it has been told to
// trust, a project-scoped `.codex/config.toml`. A server goes in as
// `[mcp_servers.<name>]` with `url` and `bearer_token_env_var` — the name of
// an env var Codex reads the token from at call time, never the token
// itself. Unlike Cursor CLI, Codex does not expand `${VAR}` inside `url`, so
// the URL here is the literal loopback address; that's also why, unlike
// `.cursor/mcp.json`, this file needs rewriting when the port moves (the same
// "rewrite only when changed" rule `.mcp.json` already follows).
//
// No TOML library: this is a tiny, pure, line-based upsert of exactly one
// table, so it never has to parse — or risk mangling — the rest of a file
// that is otherwise the user's own. It finds the table's header line (either
// spelling), replaces everything between it and the next `[` header (or
// EOF) with our two lines, and leaves every other table, comment, and blank
// line untouched. Appends a fresh table, canonically spelled, when ours
// isn't there yet.

import type { MergeResult } from "../registration";
import { ENV_TOKEN } from "../registration";

const HEADER_UNQUOTED = "[mcp_servers.markdown-collab]";
const HEADER_QUOTED = '[mcp_servers."markdown-collab"]';

export interface CodexEntry {
  url: string;
  bearer_token_env_var: string;
}

/** The `[mcp_servers.markdown-collab]` table for a server on `port`. */
export function codexEntry(port: number): CodexEntry {
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    bearer_token_env_var: ENV_TOKEN,
  };
}

function bodyLines(entry: CodexEntry): string[] {
  return [`url = "${entry.url}"`, `bearer_token_env_var = "${entry.bearer_token_env_var}"`];
}

function isOurHeader(line: string): boolean {
  const t = line.trim();
  return t === HEADER_UNQUOTED || t === HEADER_QUOTED;
}

function isTableHeader(line: string): boolean {
  return line.trim().startsWith("[");
}

/** True when the file already declares our table, under either spelling. */
export function codexTablePresent(text: string): boolean {
  return text.split("\n").some(isOurHeader);
}

/**
 * Upsert `[mcp_servers.markdown-collab]` into an existing `config.toml`.
 * Returns `text: null` when the file already says exactly this (so a
 * workspace whose port hasn't moved isn't rewritten on every activation).
 */
export function mergeCodexToml(existing: string | null, port: number): MergeResult {
  const entry = codexEntry(port);
  const body = bodyLines(entry);

  if (existing === null || existing.trim() === "") {
    return { text: [HEADER_UNQUOTED, ...body, ""].join("\n"), replaced: false };
  }

  const hadTrailingNewline = existing.endsWith("\n");
  const lines = existing.split("\n");
  if (hadTrailingNewline) lines.pop(); // split() leaves a trailing "" when the text ends in \n

  const headerIdx = lines.findIndex(isOurHeader);
  let newLines: string[];
  let replaced: boolean;

  if (headerIdx === -1) {
    replaced = false;
    newLines = [...lines];
    // Exactly one blank line separates the appended table from whatever came
    // before, without piling up blank lines across repeated runs.
    while (newLines.length > 0 && newLines[newLines.length - 1] === "") newLines.pop();
    if (newLines.length > 0) newLines.push("");
    newLines.push(HEADER_UNQUOTED, ...body);
  } else {
    replaced = true;
    let end = headerIdx + 1;
    while (end < lines.length && !isTableHeader(lines[end]!)) end++;
    const tail = lines.slice(end);
    // `tail` is either empty (we were the last table) or starts with the next
    // header (every line up to it, blank or not, was consumed above as part
    // of "this table's body") — so re-insert one separating blank line
    // whenever another table follows.
    const needsSeparator = tail.length > 0;
    newLines = [...lines.slice(0, headerIdx + 1), ...body, ...(needsSeparator ? [""] : []), ...tail];
  }

  const text = `${newLines.join("\n")}\n`;
  if (existing === text) return { text: null, replaced };
  return { text, replaced };
}
