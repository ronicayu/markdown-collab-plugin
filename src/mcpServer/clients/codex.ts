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
//
// L4 hardening: the header scan tolerates a trailing `# comment` on the
// header line, never mistakes a `[`-shaped line inside a `"""`/`'''`
// multi-line string for a table header, and a merge preserves any key the
// user added to our table beyond the two (`url`, `bearer_token_env_var`)
// this file owns.

import type { MergeResult, RemovalResult } from "../registration";
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

/**
 * Strip a TOML trailing comment — an unquoted `#` and everything after it —
 * so a header written as `[mcp_servers.markdown-collab] # managed by …`
 * still reads as our header (L4). TOML comments run from an unquoted `#` to
 * end of line; a value like `bearer_token_env_var = "FOO#BAR"` must keep its
 * `#`, so quote state is tracked rather than just searching for the character.
 */
function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function isOurHeader(line: string): boolean {
  const t = stripTrailingComment(line).trim();
  return t === HEADER_UNQUOTED || t === HEADER_QUOTED;
}

function isTableHeader(line: string): boolean {
  return stripTrailingComment(line).trim().startsWith("[");
}

/**
 * For each line, whether it STARTS inside a `"""`/`'''` multi-line string
 * left open by an earlier line (L4) — the state the header scan needs so it
 * never mistakes a `[`-shaped line of a string's own content for a table
 * header (a description field quoting an example config, say). Approximate
 * but safe: this only has to agree with a real TOML parser on well-formed
 * files, which is all this module ever runs against — a malformed file isn't
 * something a line-based upsert can make worse than it already is.
 */
function computeInMultilineString(lines: string[]): boolean[] {
  const inside: boolean[] = [];
  let open: '"""' | "'''" | null = null;
  for (const line of lines) {
    inside.push(open !== null);
    let rest = line;
    for (;;) {
      if (open === null) {
        const iDouble = rest.indexOf('"""');
        const iSingle = rest.indexOf("'''");
        if (iDouble === -1 && iSingle === -1) break;
        if (iSingle === -1 || (iDouble !== -1 && iDouble < iSingle)) {
          open = '"""';
          rest = rest.slice(iDouble + 3);
        } else {
          open = "'''";
          rest = rest.slice(iSingle + 3);
        }
      } else {
        const closeIdx = rest.indexOf(open);
        if (closeIdx === -1) break;
        rest = rest.slice(closeIdx + open.length);
        open = null;
      }
    }
  }
  return inside;
}

/** Find our header's line index, ignoring any line that starts inside an open multi-line string. */
function findOurHeaderIndex(lines: string[], inString: boolean[]): number {
  return lines.findIndex((line, i) => !inString[i] && isOurHeader(line));
}

/** Find the end of our table's body — the next real table header, or EOF — starting from `from`. */
function findTableEnd(lines: string[], inString: boolean[], from: number): number {
  let end = from;
  while (end < lines.length && !(!inString[end] && isTableHeader(lines[end]!))) end++;
  return end;
}

/** The two keys `mergeCodexToml` ever rewrites; anything else in our table is the user's own. */
const OWNED_KEYS = new Set(["url", "bearer_token_env_var"]);

/**
 * True when `line` assigns one of the keys this table's merge owns. Used to
 * separate "our stale value, safe to replace" from "a key the user added to
 * this table, which a merge must not silently drop" (L4) — the old comments
 * and blank lines in between are still discarded, matching how this module
 * has always treated its own table's leftover formatting.
 */
function isExtraUserKeyLine(line: string): boolean {
  const m = /^([A-Za-z0-9_-]+)\s*=/.exec(stripTrailingComment(line).trim());
  return !!m && !OWNED_KEYS.has(m[1]!);
}

/** True when the file already declares our table, under either spelling. */
export function codexTablePresent(text: string): boolean {
  const lines = text.split("\n");
  const inString = computeInMultilineString(lines);
  return findOurHeaderIndex(lines, inString) !== -1;
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

  const inString = computeInMultilineString(lines);
  const headerIdx = findOurHeaderIndex(lines, inString);
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
    const end = findTableEnd(lines, inString, headerIdx + 1);
    // Preserve a key the user added to our table (L4): only `url` and
    // `bearer_token_env_var` are ours to rewrite; any other `key = value`
    // line in the old body survives, appended right after our fresh two.
    const oldBody = lines.slice(headerIdx + 1, end);
    const extraLines = oldBody.filter(isExtraUserKeyLine);
    const tail = lines.slice(end);
    // `tail` is either empty (we were the last table) or starts with the next
    // header (every line up to it, blank or not, was consumed above as part
    // of "this table's body") — so re-insert one separating blank line
    // whenever another table follows.
    const needsSeparator = tail.length > 0;
    newLines = [
      ...lines.slice(0, headerIdx + 1),
      ...body,
      ...extraLines,
      ...(needsSeparator ? [""] : []),
      ...tail,
    ];
  }

  const text = `${newLines.join("\n")}\n`;
  if (existing === text) return { text: null, replaced };
  return { text, replaced };
}

/**
 * The inverse of `mergeCodexToml` (4.4: Disconnect Agent → Codex) — drop our
 * table (either header spelling) up to the next table header or EOF, leaving
 * every other table, comment, and blank line untouched. `text: null` when the
 * table isn't there at all, so Disconnect on a workspace that never ran
 * Connect is a no-op.
 */
export function removeCodexTable(existing: string | null): RemovalResult {
  if (existing === null || !codexTablePresent(existing)) return { text: null, removed: false };

  const hadTrailingNewline = existing.endsWith("\n");
  const lines = existing.split("\n");
  if (hadTrailingNewline) lines.pop(); // split() leaves a trailing "" when the text ends in \n

  const inString = computeInMultilineString(lines);
  const headerIdx = findOurHeaderIndex(lines, inString);
  const end = findTableEnd(lines, inString, headerIdx + 1);

  const before = lines.slice(0, headerIdx);
  // Drop the blank separator line directly above our table — the one
  // `mergeCodexToml` inserts when appending after another table — so removing
  // us doesn't leave it stranded where our table used to be.
  while (before.length > 0 && before[before.length - 1] === "") before.pop();
  const after = lines.slice(end);

  const newLines = after.length === 0 ? before : before.length === 0 ? after : [...before, "", ...after];
  return { text: newLines.length > 0 ? `${newLines.join("\n")}\n` : "", removed: true };
}
