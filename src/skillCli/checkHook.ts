// `mdc check --hook` — the pure logic behind the Claude Code PostToolUse hook.
//
// WHY THIS EXISTS: the plugin's `hooks/hooks.json` runs `mdc check --hook`
// after every Edit/Write/MultiEdit, piping Claude Code's hook JSON in on
// stdin. Exit 2 feeds our stderr straight back to the model — the mechanical
// version of the skill telling Claude three times not to hand-edit markers.
// A guard that fires on the wrong thing is worse than no guard: it teaches
// Claude to ignore its own tooling. So this stays deliberately narrow —
// error-severity issues only (unpaired markers, malformed thread JSON,
// duplicate ids: structural damage an edit can actually cause) — and
// deliberately silent everywhere else, including its own bugs.
//
// `warning`-severity issues (unanchored-thread, orphan-anchor,
// unanchored-suggestion, empty-quote) are NOT reported here. An unanchored
// thread is the correct, by-design result of deliberately deleting an
// anchored passage — nagging about it on every subsequent edit of the file
// would just push Claude to re-anchor it to unrelated text to make the noise
// stop.
//
// I/O is injected (see `HookIo`) so every branch — including "the file can't
// be read" and "the caller's own readFile blew up" — is unit-testable
// without spawning node or touching a real filesystem.

import * as path from "node:path";
import { opCheck } from "../inlineComments/docOps";

/** Filesystem access the hook needs, small enough to fake in a test. */
export interface HookIo {
  /** Returns file contents, or null for missing/unreadable/directory. */
  readFile(absPath: string): string | null;
  cwd(): string;
}

export interface HookOutcome {
  exitCode: 0 | 2;
  stderr: string;
}

const SILENT_OK: HookOutcome = { exitCode: 0, stderr: "" };

/** Literal marker `parse()` uses to find the threads region — see format.ts. */
const THREADS_BEGIN_MARKER = "<!--mc:threads:begin-->";

/** Per-issue lines beyond this are collapsed into a single "…and K more". */
const MAX_ISSUE_LINES = 10;

/**
 * Decide what (if anything) to tell Claude about the file it just edited.
 *
 * Never throws: this is a guard, and a guard that can crash the hook and
 * take Claude's turn down with it is worse than the bug it was meant to
 * catch. Every path below — bad JSON, a missing field, an exception thrown
 * by the caller's own `readFile` — resolves to a `HookOutcome`, never an
 * exception.
 */
export function runCheckHook(stdinText: string, io: HookIo): HookOutcome {
  try {
    return decide(stdinText, io);
  } catch {
    return SILENT_OK;
  }
}

function decide(stdinText: string, io: HookIo): HookOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return SILENT_OK;
  }
  if (!isPlainObject(payload)) return SILENT_OK;

  const toolInput = payload.tool_input;
  if (!isPlainObject(toolInput)) return SILENT_OK;

  const filePath = toolInput.file_path;
  if (typeof filePath !== "string" || filePath === "") return SILENT_OK;

  // Only markdown files carry our markers; anything else is out of scope
  // for this guard by definition.
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") return SILENT_OK;

  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : io.cwd();
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(hookCwd, filePath);

  const content = io.readFile(absPath);
  if (content === null) return SILENT_OK;

  // A .md file that never opted into inline comments has nothing for us to
  // check — and checking it anyway would be pure overhead on every edit of
  // every ordinary markdown file in the project.
  if (!content.includes(THREADS_BEGIN_MARKER)) return SILENT_OK;

  const errors = opCheck(content).issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return SILENT_OK;

  return { exitCode: 2, stderr: formatReport(filePath, errors) };
}

function formatReport(filePath: string, errors: Array<{ message: string }>): string {
  const noun = errors.length === 1 ? "problem" : "problems";
  const lines = [`Markdown Collab: ${filePath} has ${errors.length} comment-marker ${noun} after this edit:`];

  const shown = errors.slice(0, MAX_ISSUE_LINES);
  for (const issue of shown) lines.push(`- ${issue.message}`);
  if (errors.length > MAX_ISSUE_LINES) {
    lines.push(`- …and ${errors.length - MAX_ISSUE_LINES} more`);
  }

  lines.push(`Run \`mdc check ${filePath} --repair\` (or mc_check) and fix what remains — don't hand-edit markers.`);
  return `${lines.join("\n")}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
