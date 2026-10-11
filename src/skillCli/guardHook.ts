// `mdc guard --hook` — the logic behind the Claude Code PreToolUse hook.
//
// The PostToolUse hook (`checkHook.ts`) reports a broken marker after the edit
// has landed, by which point the comment is already damaged and the usual next
// move is another hand edit to "fix" it. This one runs before Edit, Write and
// MultiEdit and refuses the call outright when it would change the review data
// — any `<!--mc:…-->` anchor marker, thread line or region fence — and says
// which `mdc` command does that job instead. Exit 2 blocks the tool call and
// hands our stderr to the model.
//
// It stays narrow, for the same reason the check hook does (a guard that fires
// on the wrong thing teaches Claude to ignore its tooling):
//
// - Only a .md file that already carries review data. Ordinary Markdown, and a
//   file being created, are none of its business.
// - A prose edit that leaves every `<!--mc:…-->` exactly as it was passes,
//   inside an anchored span or not.
// - A file that is already broken passes, so a repair the check hook asked
//   for can be made.
// - An edit it can't simulate (its old_string isn't in the file) passes: the
//   Edit tool refuses that itself.
//
// While suggest mode is on for the workspace, every direct edit of such a file
// is refused: the change belongs in `mdc suggest`.
//
// Never throws; every unexpected path is a silent pass.

import * as path from "node:path";
import { opCheck } from "../inlineComments/docOps";
import { isPlainObject, suggestModeOnDisk, type HookIo, type HookOutcome } from "./checkHook";

const PASS: HookOutcome = { exitCode: 0, stderr: "" };

const REVIEW_DATA = /<!--mc:[\s\S]*?-->/g;

export function runGuardHook(stdinText: string, io: HookIo): HookOutcome {
  try {
    return decide(stdinText, io);
  } catch {
    return PASS;
  }
}

function decide(stdinText: string, io: HookIo): HookOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return PASS;
  }
  if (!isPlainObject(payload)) return PASS;
  const input = payload.tool_input;
  if (!isPlainObject(input)) return PASS;
  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath === "") return PASS;
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") return PASS;

  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : io.cwd();
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(hookCwd, filePath);
  const current = io.readFile(absPath);
  if (current === null || !current.includes("<!--mc:")) return PASS;

  const next = afterTool(payload.tool_name, input, current);
  if (next === null || next === current) return PASS;

  if (suggestModeOnDisk(hookCwd, io)) return { exitCode: 2, stderr: suggestModeRefusal(filePath) };

  if (sameReviewData(current, next)) return PASS;
  if (opCheck(current).issues.some((issue) => issue.severity === "error")) return PASS;
  return { exitCode: 2, stderr: refusal(filePath) };
}

/** The file as the tool would leave it, or null when that can't be worked out. */
function afterTool(tool: unknown, input: Record<string, unknown>, current: string): string | null {
  if (tool === "Write") return typeof input.content === "string" ? input.content : null;
  if (tool === "Edit") return applyEdit(current, input);
  if (tool === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    let text: string | null = current;
    for (const edit of input.edits) {
      if (!isPlainObject(edit) || text === null) return null;
      text = applyEdit(text, edit);
    }
    return text;
  }
  return null;
}

function applyEdit(text: string, edit: Record<string, unknown>): string | null {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = edit;
  if (typeof oldString !== "string" || typeof newString !== "string" || oldString === "") return null;
  const at = text.indexOf(oldString);
  if (at < 0) return null;
  if (replaceAll === true) return text.split(oldString).join(newString);
  return text.slice(0, at) + newString + text.slice(at + oldString.length);
}

function sameReviewData(a: string, b: string): boolean {
  const before = a.match(REVIEW_DATA) ?? [];
  const after = b.match(REVIEW_DATA) ?? [];
  return before.length === after.length && before.every((token, i) => token === after[i]);
}

function refusal(filePath: string): string {
  return [
    `Markdown Collab: not applied — this edit to ${filePath} would change its review comments (a <!--mc:…--> marker or thread line), and a hand edit is how they break.`,
    "Make the change with mdc (or the markdown-collab MCP tool of the same name):",
    `- reply to a thread: mdc reply ${filePath} <threadId> --body "…"`,
    `- rewrite a commented passage, markers kept: mdc rewrite ${filePath} <threadId> --with "…"`,
    `- change or delete prose around markers: mdc edit ${filePath} --old "…" --new "…"`,
    `- open, resolve, suggest: mdc open / mdc resolve / mdc suggest ${filePath} …`,
    "An Edit that leaves every <!--mc:…--> exactly as it is still goes through.",
    "",
  ].join("\n");
}

function suggestModeRefusal(filePath: string): string {
  return (
    `Markdown Collab: not applied — suggest mode is on for this workspace, so ${filePath} isn't edited directly. ` +
    `Propose the change with mdc suggest ${filePath} --quote "…" --with "…" --note "…" (or mc_suggest).\n`
  );
}
