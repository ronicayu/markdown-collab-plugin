// Tests for `runCheckHook` (the pure logic behind `mdc check --hook`).
//
// This is the Claude Code PostToolUse hook: it gets the hook's JSON on
// stdin, decides whether the just-edited file has *error*-severity marker
// damage, and reports it on stderr with exit 2 — or stays silent (exit 0)
// for everything else, including its own bugs. Every branch is exercised
// here with an in-memory `HookIo` so nothing spawns node or touches a real
// filesystem; the end-to-end spawn of the bundled script lives in
// `skillCli.test.ts` ("mdc CLI: check --hook").

import { describe, expect, it } from "vitest";
import { runCheckHook, type HookIo } from "../skillCli/checkHook";
import { addThread } from "../inlineComments/format";

const T = "2026-07-01T00:00:00.000Z";

/** An `HookIo` backed by an in-memory file map, for tests that don't care about resolution. */
function memIo(files: Record<string, string>, cwd = "/proj"): HookIo {
  return {
    readFile: (absPath) => (Object.prototype.hasOwnProperty.call(files, absPath) ? files[absPath] : null),
    cwd: () => cwd,
  };
}

function hookStdin(filePath: string, opts: { cwd?: string } = {}): string {
  const payload: Record<string, unknown> = {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    tool_response: { ok: true },
  };
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  return JSON.stringify(payload);
}

/** A healthy doc with one anchored, well-formed thread (threads region included). */
function healthyDoc(): { source: string; id: string } {
  const base = "# Guide\n\nThe retry policy uses exponential backoff with a cap.\n";
  const quote = "exponential backoff";
  const start = base.indexOf(quote);
  const { source, thread } = addThread(base, start, start + quote.length, {
    author: "claude",
    body: "why 30s?",
    ts: T,
  });
  return { source, id: thread.id };
}

/** `n` anchored threads over distinct sentences, all healthy. */
function docWithNThreads(n: number): { source: string; ids: string[] } {
  const sentences = Array.from({ length: n }, (_, i) => `Sentence number ${i} appears here.`);
  let source = `# Doc\n\n${sentences.join(" ")}\n`;
  const ids: string[] = [];
  for (const sentence of sentences) {
    const start = source.indexOf(sentence);
    const { source: next, thread } = addThread(source, start, start + sentence.length, {
      author: "claude",
      body: "x",
      ts: T,
    });
    source = next;
    ids.push(thread.id);
  }
  return { source, ids };
}

describe("runCheckHook: malformed or out-of-scope stdin (exit 0, silent)", () => {
  it("empty stdin", () => {
    const r = runCheckHook("", memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("non-JSON stdin", () => {
    const r = runCheckHook("not json at all {{{", memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("JSON array at the top level", () => {
    const r = runCheckHook("[1, 2, 3]", memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("JSON number at the top level", () => {
    const r = runCheckHook("42", memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("JSON null at the top level", () => {
    const r = runCheckHook("null", memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("missing tool_input", () => {
    const r = runCheckHook(JSON.stringify({ session_id: "s1" }), memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("tool_input is not an object", () => {
    const r = runCheckHook(JSON.stringify({ tool_input: "/abs/doc.md" }), memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("tool_input.file_path missing", () => {
    const r = runCheckHook(JSON.stringify({ tool_input: {} }), memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("tool_input.file_path is not a string", () => {
    const r = runCheckHook(JSON.stringify({ tool_input: { file_path: 7 } }), memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("tool_input.file_path is an empty string", () => {
    const r = runCheckHook(JSON.stringify({ tool_input: { file_path: "" } }), memIo({}));
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("a .txt file is out of scope", () => {
    const io = memIo({ "/proj/notes.txt": "whatever" });
    const r = runCheckHook(hookStdin("/proj/notes.txt"), io);
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("a missing file (readFile returns null)", () => {
    const io = memIo({});
    const r = runCheckHook(hookStdin("/proj/gone.md"), io);
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("a .md file without the threads marker, even with stray marker-shaped text", () => {
    const io = memIo({
      "/proj/plain.md": "# Doc\n\nSome text <!--mc:a:abcde-->weird<!--mc:/a:abcde--> stray, no threads region.\n",
    });
    const r = runCheckHook(hookStdin("/proj/plain.md"), io);
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("an exception thrown by io.readFile is swallowed", () => {
    const io: HookIo = {
      readFile: () => {
        throw new Error("boom");
      },
      cwd: () => "/proj",
    };
    const r = runCheckHook(hookStdin("/proj/doc.md"), io);
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });
});

describe("runCheckHook: extension acceptance is case-insensitive", () => {
  it("accepts uppercase .MD", () => {
    const { source, id } = healthyDoc();
    const corrupted = source.replace(`<!--mc:/a:${id}-->`, "");
    const io = memIo({ "/proj/DOC.MD": corrupted });
    const r = runCheckHook(hookStdin("/proj/DOC.MD"), io);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("comment-marker problem");
  });

  it("accepts .markdown", () => {
    const { source, id } = healthyDoc();
    const corrupted = source.replace(`<!--mc:/a:${id}-->`, "");
    const io = memIo({ "/proj/doc.markdown": corrupted });
    const r = runCheckHook(hookStdin("/proj/doc.markdown"), io);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("comment-marker problem");
  });
});

describe("runCheckHook: healthy and warning-only documents stay silent", () => {
  it("a healthy doc with threads exits 0", () => {
    const { source } = healthyDoc();
    const io = memIo({ "/proj/doc.md": source });
    const r = runCheckHook(hookStdin("/proj/doc.md"), io);
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("a doc with only warning issues (an unanchored thread) exits 0", () => {
    const { source, id } = healthyDoc();
    const quote = "exponential backoff";
    // Remove the anchor markers AND the passage they wrapped — the thread
    // becomes unanchored (a warning), not repairable by quote-matching, and
    // still only a warning: exactly the "deliberately deleted a commented
    // passage" case the hook must not nag about.
    const corrupted = source.replace(`<!--mc:a:${id}-->${quote}<!--mc:/a:${id}-->`, "");
    const io = memIo({ "/proj/doc.md": corrupted });
    const r = runCheckHook(hookStdin("/proj/doc.md"), io);
    expect(r).toEqual({ exitCode: 0, stderr: "" });
  });

  it("an empty-quote thread is a warning too — `mdc check` reports it, the hook doesn't", () => {
    // What `mdc open --occurrence banana` used to write. The markers are paired
    // and the JSON is valid — no structural
    // damage, so it stays below the hook's error-only bar.
    const { source, id } = healthyDoc();
    const damaged = source
      .replace(`<!--mc:a:${id}-->exponential backoff<!--mc:/a:${id}-->`, "exponential backoff")
      .replace("# Guide", `<!--mc:a:${id}--><!--mc:/a:${id}--># Guide`)
      .replace('"quote":"exponential backoff"', '"quote":""');
    const io = memIo({ "/proj/doc.md": damaged });
    expect(runCheckHook(hookStdin("/proj/doc.md"), io)).toEqual({ exitCode: 0, stderr: "" });
  });
});

describe("runCheckHook: error-severity damage reports and exits 2", () => {
  it("a dropped close marker: exact message shape, singular", () => {
    const { source, id } = healthyDoc();
    const corrupted = source.replace(`<!--mc:/a:${id}-->`, "");
    const io = memIo({ "/proj/doc.md": corrupted });

    const r = runCheckHook(hookStdin("/proj/doc.md"), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe(
      `Markdown Collab: /proj/doc.md has 1 comment-marker problem after this edit:\n` +
        `- Anchor ${id} has an opening marker with no matching close.\n` +
        "Run `mdc check /proj/doc.md --repair` (or mc_check) and fix what remains — don't hand-edit markers.\n",
    );
  });

  it("more than 10 issues: capped at 10 lines plus a summary, plural", () => {
    const { source, ids } = docWithNThreads(12);
    let corrupted = source;
    for (const id of ids) corrupted = corrupted.replace(`<!--mc:/a:${id}-->`, "");
    const io = memIo({ "/proj/doc.md": corrupted });

    const r = runCheckHook(hookStdin("/proj/doc.md"), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr.startsWith("Markdown Collab: /proj/doc.md has 12 comment-marker problems after this edit:\n")).toBe(
      true,
    );
    const lines = r.stderr.split("\n");
    const issueLines = lines.filter((l) => l.startsWith("- ") && !l.includes("more"));
    expect(issueLines.length).toBe(10);
    expect(r.stderr).toContain("- …and 2 more\n");
    expect(r.stderr.trim().endsWith("don't hand-edit markers.")).toBe(true);
  });
});

describe("runCheckHook: relative path resolution", () => {
  it("resolves a relative file_path against the hook's cwd when present", () => {
    const { source, id } = healthyDoc();
    const corrupted = source.replace(`<!--mc:/a:${id}-->`, "");
    const io = memIo({ "/from/hook/doc.md": corrupted }, "/ignored/io/cwd");

    const r = runCheckHook(hookStdin("doc.md", { cwd: "/from/hook" }), io);

    expect(r.exitCode).toBe(2);
    // The message keeps the path as given, not the resolved absolute one.
    expect(r.stderr).toContain("Markdown Collab: doc.md has 1 comment-marker problem after this edit:");
  });

  it("resolves a relative file_path against io.cwd() when the hook gives no cwd", () => {
    const { source, id } = healthyDoc();
    const corrupted = source.replace(`<!--mc:/a:${id}-->`, "");
    const io = memIo({ "/io/default/cwd/doc.md": corrupted }, "/io/default/cwd");

    const r = runCheckHook(hookStdin("doc.md"), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Markdown Collab: doc.md has 1 comment-marker problem after this edit:");
  });
});

// `mc_edit`/`mc_rewrite` refuse suggest-mode direct edits at
// the tool layer (mcpTools.test.ts), but Claude Code's own Edit tool bypasses
// the tools entirely — this hook is the only backstop for that path. The
// setting is workspace configuration, always written with
// `ConfigurationTarget.Workspace` (`commands/send.ts`), so for a single-folder
// workspace it's on disk at `<hook cwd>/.vscode/settings.json`.
describe("runCheckHook: suggest mode on disk (10x-plan-6 P2.1)", () => {
  const SETTINGS_ON = JSON.stringify({ "markdownCollab.proposeEditsAsSuggestions": true });
  const SETTINGS_OFF = JSON.stringify({ "markdownCollab.proposeEditsAsSuggestions": false });

  it("reports a direct edit when suggest mode is on in .vscode/settings.json at the hook's cwd", () => {
    const { source } = healthyDoc();
    const io = memIo({
      "/proj/doc.md": source,
      "/proj/.vscode/settings.json": SETTINGS_ON,
    });

    const r = runCheckHook(hookStdin("/proj/doc.md"), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(
      "suggest mode is on for this workspace — propose edits with mc_suggest / mdc suggest instead of editing directly",
    );
  });

  it("stays silent when the setting is present but false", () => {
    const { source } = healthyDoc();
    const io = memIo({
      "/proj/doc.md": source,
      "/proj/.vscode/settings.json": SETTINGS_OFF,
    });
    expect(runCheckHook(hookStdin("/proj/doc.md"), io)).toEqual({ exitCode: 0, stderr: "" });
  });

  it("stays silent — never guesses — when there is no .vscode/settings.json at all", () => {
    const { source } = healthyDoc();
    const io = memIo({ "/proj/doc.md": source });
    expect(runCheckHook(hookStdin("/proj/doc.md"), io)).toEqual({ exitCode: 0, stderr: "" });
  });

  it("stays silent on a .md file with no threads region yet, even with suggest mode on", () => {
    const io = memIo({
      "/proj/plain.md": "# Doc\n\nNo comments here yet.\n",
      "/proj/.vscode/settings.json": SETTINGS_ON,
    });
    expect(runCheckHook(hookStdin("/proj/plain.md"), io)).toEqual({ exitCode: 0, stderr: "" });
  });

  it("reads settings.json with line comments and a trailing comma (JSONC)", () => {
    const { source } = healthyDoc();
    const jsonc = [
      "{",
      "  // suggest mode on for this workspace",
      '  "markdownCollab.proposeEditsAsSuggestions": true,',
      "}",
    ].join("\n");
    const io = memIo({ "/proj/doc.md": source, "/proj/.vscode/settings.json": jsonc });

    const r = runCheckHook(hookStdin("/proj/doc.md"), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("suggest mode is on for this workspace");
  });

  it("reads settings.json with a block comment around unrelated settings", () => {
    const { source } = healthyDoc();
    const jsonc = [
      "{",
      "  /* editor tweaks",
      '     "editor.fontSize": 14, */',
      '  "markdownCollab.proposeEditsAsSuggestions": true',
      "}",
    ].join("\n");
    const io = memIo({ "/proj/doc.md": source, "/proj/.vscode/settings.json": jsonc });

    const r = runCheckHook(hookStdin("/proj/doc.md"), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("suggest mode is on for this workspace");
  });

  it("stays silent on unparseable settings.json rather than guessing", () => {
    const { source } = healthyDoc();
    const io = memIo({ "/proj/doc.md": source, "/proj/.vscode/settings.json": "not { json at all" });
    expect(runCheckHook(hookStdin("/proj/doc.md"), io)).toEqual({ exitCode: 0, stderr: "" });
  });

  it("resolves settings.json against the hook's own cwd, not the edited file's directory", () => {
    const { source } = healthyDoc();
    const io = memIo({
      "/from/hook/nested/doc.md": source,
      "/from/hook/.vscode/settings.json": SETTINGS_ON,
    });

    const r = runCheckHook(hookStdin("nested/doc.md", { cwd: "/from/hook" }), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("suggest mode is on for this workspace");
  });

  it("reports both suggest mode and marker damage together when an edit causes both", () => {
    const { source, id } = healthyDoc();
    const corrupted = source.replace(`<!--mc:/a:${id}-->`, "");
    const io = memIo({
      "/proj/doc.md": corrupted,
      "/proj/.vscode/settings.json": SETTINGS_ON,
    });

    const r = runCheckHook(hookStdin("/proj/doc.md"), io);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("suggest mode is on for this workspace");
    expect(r.stderr).toContain("comment-marker problem");
  });
});
