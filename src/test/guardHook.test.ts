// `runGuardHook` — the Claude Code PreToolUse hook behind `mdc guard --hook`.
// It refuses (exit 2) an Edit, Write or MultiEdit that would change a review
// marker or thread line by hand, and every direct edit while suggest mode is
// on; everything else passes silently.

import { describe, expect, it } from "vitest";
import { runGuardHook } from "../skillCli/guardHook";
import type { HookIo } from "../skillCli/checkHook";
import { addThread } from "../inlineComments/format";

const FILE = "/proj/docs/guide.md";
const BASE = "# Guide\n\nThe retry policy uses exponential backoff with a cap.\n\nA second paragraph.\n";

function reviewed(): { source: string; id: string } {
  const at = BASE.indexOf("exponential backoff");
  const r = addThread(BASE, at, at + "exponential backoff".length, {
    author: "ronica",
    body: "Which cap?",
    ts: "2026-07-01T00:00:00.000Z",
  });
  return { source: r.source, id: r.thread.id };
}

function io(files: Record<string, string>): HookIo {
  return { readFile: (p) => files[p] ?? null, cwd: () => "/proj" };
}

function stdin(tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/proj", tool_name: tool, tool_input: { file_path: FILE, ...input } });
}

const edit = (old_string: string, new_string: string, extra: Record<string, unknown> = {}) =>
  stdin("Edit", { old_string, new_string, ...extra });

describe("refused: a hand edit of the review data", () => {
  it("an Edit that drops a closing marker", () => {
    const { source, id } = reviewed();
    const r = runGuardHook(edit(`backoff<!--mc:/a:${id}-->`, "backoff"), io({ [FILE]: source }));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not applied");
    expect(r.stderr).toContain(`mdc rewrite ${FILE} <threadId>`);
    expect(r.stderr).toContain(`mdc reply ${FILE} <threadId>`);
  });

  it("an Edit that writes a reply into the thread line", () => {
    const { source } = reviewed();
    const r = runGuardHook(edit('"body":"Which cap?"}', '"body":"Which cap?"},{"id":"c2","author":"claude","body":"30s"}'), io({ [FILE]: source }));
    expect(r.exitCode).toBe(2);
  });

  it("a Write that leaves out the threads region", () => {
    const { source } = reviewed();
    const r = runGuardHook(stdin("Write", { content: BASE }), io({ [FILE]: source }));
    expect(r.exitCode).toBe(2);
  });

  it("a MultiEdit whose second edit touches a marker", () => {
    const { source, id } = reviewed();
    const r = runGuardHook(
      stdin("MultiEdit", {
        edits: [
          { old_string: "A second paragraph.", new_string: "A second paragraph, edited." },
          { old_string: `<!--mc:a:${id}-->`, new_string: "" },
        ],
      }),
      io({ [FILE]: source }),
    );
    expect(r.exitCode).toBe(2);
  });
});

describe("let through", () => {
  it("a prose edit that leaves every marker and thread line as it was — inside an anchored span too", () => {
    const { source } = reviewed();
    expect(runGuardHook(edit("A second paragraph.", "A second, longer paragraph."), io({ [FILE]: source }))).toEqual({ exitCode: 0, stderr: "" });
    expect(runGuardHook(edit("exponential", "geometric"), io({ [FILE]: source })).exitCode).toBe(0);
    expect(runGuardHook(edit("paragraph", "section", { replace_all: true }), io({ [FILE]: source })).exitCode).toBe(0);
    // replace_all over text the thread line holds too changes the review data.
    expect(runGuardHook(edit("cap", "limit", { replace_all: true }), io({ [FILE]: source })).exitCode).toBe(2);
  });

  it("a file with no review data, a new file, and a file that isn't Markdown", () => {
    expect(runGuardHook(stdin("Write", { content: "x" }), io({ [FILE]: BASE })).exitCode).toBe(0);
    expect(runGuardHook(stdin("Write", { content: "x" }), io({})).exitCode).toBe(0);
    const ts = JSON.stringify({ cwd: "/proj", tool_name: "Write", tool_input: { file_path: "/proj/a.ts", content: "" } });
    expect(runGuardHook(ts, io({ "/proj/a.ts": reviewed().source })).exitCode).toBe(0);
  });

  it("an Edit whose old_string isn't in the file (the Edit tool refuses it itself)", () => {
    const { source } = reviewed();
    expect(runGuardHook(edit("<!--mc:not there-->", ""), io({ [FILE]: source })).exitCode).toBe(0);
  });

  it("a repair of a file that is already broken", () => {
    const { source, id } = reviewed();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");
    const r = runGuardHook(edit("backoff with", `backoff<!--mc:/a:${id}--> with`), io({ [FILE]: broken }));
    expect(r.exitCode).toBe(0);
  });

  it("anything it can't read: bad JSON, no tool input, an unknown tool", () => {
    const files = io({ [FILE]: reviewed().source });
    expect(runGuardHook("not json", files).exitCode).toBe(0);
    expect(runGuardHook(JSON.stringify({ tool_name: "Edit" }), files).exitCode).toBe(0);
    expect(runGuardHook(stdin("Read", {}), files).exitCode).toBe(0);
  });
});

describe("suggest mode on for the workspace", () => {
  const settings = { "/proj/.vscode/settings.json": '{ "markdownCollab.proposeEditsAsSuggestions": true }' };

  it("refuses even a prose-only edit of a reviewed file, pointing at mdc suggest", () => {
    const r = runGuardHook(edit("A second paragraph.", "Edited."), io({ [FILE]: reviewed().source, ...settings }));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(`mdc suggest ${FILE}`);
  });

  it("leaves a file with no review data alone", () => {
    expect(runGuardHook(edit("A second paragraph.", "Edited."), io({ [FILE]: BASE, ...settings })).exitCode).toBe(0);
  });
});
