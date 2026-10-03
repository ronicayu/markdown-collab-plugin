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
// Second, unrelated job (10x-plan-6 P2.1): a direct Edit/Write to a file
// while suggest mode is on for the workspace. `mc_edit`/`mc_rewrite` refuse
// this at the tool layer (`mcpServer/tools.ts`), but Claude Code's own Edit
// tool bypasses that entirely — it writes the file directly, no MCP call in
// the middle. This hook is the only place left to catch it. The setting
// (`markdownCollab.proposeEditsAsSuggestions`) is workspace configuration,
// always written with `ConfigurationTarget.Workspace` (see `commands/send.ts`),
// so for the common single-folder case it's sitting on disk at
// `<hook cwd>/.vscode/settings.json` — cheap to read without a running
// extension. A multi-root workspace keeps it in the `.code-workspace` file
// instead, which this does not read; same rule as everywhere else in this
// file — if it can't tell, it says nothing rather than guessing.
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

/** The setting's key, exactly as declared in `package.json` and read in `commands/send.ts`. */
const SUGGEST_MODE_SETTING = "markdownCollab.proposeEditsAsSuggestions";

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
  // every ordinary markdown file in the project. Suggest mode is scoped the
  // same way: it's a rule about *this collaborative review workflow*, not a
  // blanket "never Edit a .md file in this repo" — a file with no threads
  // region yet is out of scope for both checks below.
  if (!content.includes(THREADS_BEGIN_MARKER)) return SILENT_OK;

  const reports: string[] = [];

  if (suggestModeOnDisk(hookCwd, io)) {
    reports.push(suggestModeReport(filePath));
  }

  const errors = opCheck(content).issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) reports.push(formatReport(filePath, errors));

  if (reports.length === 0) return SILENT_OK;
  return { exitCode: 2, stderr: reports.join("") };
}

function suggestModeReport(filePath: string): string {
  return (
    `Markdown Collab: ${filePath} was edited directly, but suggest mode is on for this workspace — ` +
    "propose edits with mc_suggest / mdc suggest instead of editing directly.\n"
  );
}

/**
 * Whether `markdownCollab.proposeEditsAsSuggestions` reads `true` in the
 * `.vscode/settings.json` sitting at the hook's own working directory — the
 * workspace root, for the common case of a single-folder VS Code window
 * (Claude Code's terminal cwd is that folder). Returns `false` — never
 * guessed `true` — when there's no such file, its JSON doesn't parse even
 * loosely, or the key is absent/false there: any of those might still mean
 * the setting is on somewhere this cheap, single-file check can't see (a
 * multi-root `.code-workspace`, a workspace root above this one), and this
 * only ever reports what it can actually read.
 */
function suggestModeOnDisk(hookCwd: string, io: HookIo): boolean {
  const raw = io.readFile(path.join(hookCwd, ".vscode", "settings.json"));
  if (raw === null) return false;
  const parsed = parseJsonc(raw);
  if (!isPlainObject(parsed)) return false;
  return parsed[SUGGEST_MODE_SETTING] === true;
}

/**
 * Just enough of JSONC to read a hand-edited `.vscode/settings.json`: line
 * comments and block comments dropped outside string literals, then a
 * trailing comma before a closing `}` or `]` dropped. Not a general parser — anything this
 * doesn't handle falls through to `JSON.parse` failing, which returns
 * `undefined` here exactly like a missing file: the hook stays silent rather
 * than guessing at a file it can't actually read.
 */
function parseJsonc(raw: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < raw.length) {
        out += raw[++i];
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++; // land on the closing "/"; the `for`'s own i++ steps past it
      continue;
    }
    out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
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
