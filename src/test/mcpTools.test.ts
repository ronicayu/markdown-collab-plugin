import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  HELP_HINT,
  SUGGESTION_MAX_MULTIPLE_OF_QUOTE,
  SUGGESTION_MIN_CHARS,
  TOOLS,
  callTool,
  suggestionTooLarge,
  type ToolDeps,
} from "../mcpServer/tools";
import { ensureMarkdownCollabDir, resolveWorkspaceFile, writeDescriptorFile } from "../mcpServer/index";
import { renderSkill } from "../skillText";
import { addThread, parse } from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";
import { readHostFile } from "./hostSources";

const DOC = `# Guide

The parser handles nested lists correctly.

Suggest mode ships behind a setting.
`;

/** An in-memory workspace: one file, recorded writes. */
function harness(initial = DOC) {
  const files = new Map<string, string>([["/ws/guide.md", initial]]);
  const calls: Array<{ tool: string; file?: string; note?: string; agent: string }> = [];
  const deps: ToolDeps = {
    resolveFile: async (file) => {
      const key = file.startsWith("/") ? file : `/ws/${file}`;
      if (!files.has(key)) throw new Error(`no such file inside the workspace: ${file}`);
      return key;
    },
    readDoc: async (key) => files.get(key)!,
    writeDoc: async (key, next) => {
      files.set(key, next);
    },
    onCall: (e) => calls.push(e),
    now: () => "2026-07-30T00:00:00.000Z",
  };
  return {
    deps,
    calls,
    read: (key = "/ws/guide.md") => files.get(key)!,
    call: (name: string, args: Record<string, unknown> = {}, author?: string) =>
      callTool(name, args, deps, author),
  };
}

/** Tool results are JSON text blocks; parse the one block back out. */
function body(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

describe("mcp tool catalog", () => {
  it("advertises every verb the CLI has, plus the status beacon and mc_help", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "mc_accept",
      "mc_check",
      "mc_edit",
      "mc_help",
      "mc_list",
      "mc_open",
      "mc_reject",
      "mc_reply",
      "mc_resolve",
      "mc_rewrite",
      "mc_status",
      "mc_suggest",
    ]);
  });

  it("gives every tool a description and an object schema", () => {
    for (const t of TOOLS) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
    }
  });

  it("requires `file` on every tool that touches a document", () => {
    for (const t of TOOLS) {
      if (t.name === "mc_status" || t.name === "mc_help") continue;
      expect(t.inputSchema.required, `${t.name}`).toContain("file");
    }
  });

  // A client that doesn't surface `instructions` sees only the
  // tool descriptions, so every write points at the workflow.
  it("ends every mutating tool's description with the mc_help hint, and only those", () => {
    const mutating = ["mc_reply", "mc_open", "mc_rewrite", "mc_edit", "mc_resolve", "mc_suggest", "mc_accept", "mc_reject"];
    for (const t of TOOLS) {
      if (mutating.includes(t.name)) {
        expect(t.description.endsWith(" If unsure of the workflow, call mc_help first."), t.name).toBe(true);
      } else {
        expect(t.description, t.name).not.toContain(HELP_HINT.trim());
      }
    }
  });
});

describe("mc_help", () => {
  it("takes no arguments", () => {
    const help = TOOLS.find((t) => t.name === "mc_help")!;
    expect(help.inputSchema.properties).toEqual({});
    expect(help.inputSchema.required).toEqual([]);
  });

  it("returns the headless (tools-only) rendering of the skill, verbatim", async () => {
    const h = harness();
    const r = await h.call("mc_help");
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.text).toBe(renderSkill("headless"));
    // Needs no file, touches nothing, and reports no document to the pending
    // indicators.
    expect(h.calls).toEqual([{ tool: "mc_help", agent: "claude" }]);
    expect(h.read()).toBe(DOC);
  });
});

describe("mc_list", () => {
  it("returns threads and suggestions", async () => {
    const h = harness();
    const opened = body(await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "Ordered too?" }));
    const listed = body(await h.call("mc_list", { file: "guide.md" }));
    expect(listed.threadCount).toBe(1);
    expect(listed.threads[0].id).toBe(opened.threadId);
    expect(listed.threads[0].anchoredText).toBe("nested lists");
  });

  it("actionable=true hides threads whose last word is Claude's", async () => {
    const h = harness();
    await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "Ordered too?" });
    const listed = body(await h.call("mc_list", { file: "guide.md", actionable: true }));
    // mc_open authors as claude, so the thread exists but owes nothing:
    // `threadCount` stays the document total, `threads` is the filtered view.
    expect(listed.threadCount).toBe(1);
    expect(listed.threads).toEqual([]);
  });
});

describe("writes", () => {
  it("mc_reply appends a claude comment and leaves the file valid", async () => {
    const seeded = addThread(DOC, DOC.indexOf("nested lists"), DOC.indexOf("nested lists") + 12, {
      author: "ronica",
      body: "Ordered too?",
      ts: "2026-07-01T00:00:00.000Z",
    });
    const h = harness(seeded.source);
    const r = body(await h.call("mc_reply", { file: "guide.md", threadId: seeded.thread.id, body: "Yes." }));
    expect(r.action).toBe("reply");
    const thread = parse(h.read()).threads.find((t) => t.id === seeded.thread.id)!;
    expect(thread.comments.at(-1)).toMatchObject({ author: "claude", body: "Yes." });
    expect(checkIntegrity(h.read()).ok).toBe(true);
  });

  it("mc_reply on a resolved thread reopens it and says so in the result (ux-review-2026-09 0.6)", async () => {
    const h = harness();
    const { threadId } = body(await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "q" }));
    body(await h.call("mc_resolve", { file: "guide.md", threadId }));
    const r = body(await h.call("mc_reply", { file: "guide.md", threadId, body: "one more thing" }));
    expect(r).toMatchObject({ action: "reply", threadId, commentId: "c2", reopened: true });
    expect(parse(h.read()).threads[0]!.status).toBe("open");

    const again = body(await h.call("mc_reply", { file: "guide.md", threadId, body: "and another" }));
    expect(again.reopened).toBe(false);
  });

  it("mc_suggest records a proposal without changing the prose", async () => {
    const h = harness();
    const r = body(
      await h.call("mc_suggest", {
        file: "guide.md",
        quote: "Suggest mode ships behind a setting.",
        with: "Suggest mode is off by default.",
        note: "Match the README.",
      }),
    );
    expect(r.action).toBe("suggest");
    const parsed = parse(h.read());
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0]!.proposed).toBe("Suggest mode is off by default.");
    // The document still reads as the original until the human accepts.
    expect(h.read()).toContain("Suggest mode ships behind a setting.");
  });

  it("mc_rewrite replaces the anchored span, markers intact", async () => {
    const h = harness();
    const { threadId } = body(
      await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "Say which kinds." }),
    );
    body(await h.call("mc_rewrite", { file: "guide.md", threadId, with: "nested and ordered lists" }));
    expect(h.read()).toContain("nested and ordered lists");
    expect(checkIntegrity(h.read()).ok).toBe(true);
    expect(parse(h.read()).anchors.has(threadId)).toBe(true);
  });
});

describe("refusals", () => {
  it("names an unknown thread without touching the document", async () => {
    const h = harness();
    const before = h.read();
    const r = await h.call("mc_reply", { file: "guide.md", threadId: "nope1", body: "hi" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("thread_not_found");
    expect(h.read()).toBe(before);
  });

  it("refuses an ambiguous passage rather than guessing which one", async () => {
    const h = harness("# T\n\nsame words here\n\nsame words here\n");
    const r = await h.call("mc_open", { file: "guide.md", quote: "same words here", body: "which?" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("passage_ambiguous");
    expect(body(r).error.details.occurrences).toBe(2);
  });

  it("takes the occurrence when told which one", async () => {
    const h = harness("# T\n\nsame words here\n\nsame words here\n");
    const r = await h.call("mc_open", {
      file: "guide.md",
      quote: "same words here",
      body: "the second one",
      occurrence: 2,
    });
    expect(r.isError).toBeUndefined();
    const anchored = parse(h.read()).anchors;
    expect(anchored.size).toBe(1);
  });

  // The same validator the CLI and the ops use.
  it.each(["banana", -1, 1.5, "1e0"])("refuses occurrence %j as invalid_arguments, writing nothing", async (occurrence) => {
    const h = harness();
    const before = h.read();
    for (const [tool, args] of [
      ["mc_open", { quote: "nested lists", body: "q" }],
      ["mc_suggest", { quote: "nested lists", with: "lists" }],
      ["mc_edit", { old: "nested lists", new: "lists" }],
    ] as const) {
      const r = await h.call(tool, { file: "guide.md", ...args, occurrence });
      expect(r.isError, tool).toBe(true);
      expect(body(r).error.code, tool).toBe("invalid_arguments");
    }
    expect(h.read()).toBe(before);
  });

  it("refuses a passage inside a code block", async () => {
    const h = harness("# T\n\n```\nliteral text\n```\n");
    const r = await h.call("mc_open", { file: "guide.md", quote: "literal text", body: "nope" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("not_anchorable");
  });

  it("refuses a file outside the workspace, and says so in the result", async () => {
    const h = harness();
    const r = await h.call("mc_list", { file: "/etc/passwd" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("host_error");
    expect(body(r).error.message).toContain("no such file inside the workspace");
  });

  it("refuses a missing argument before reading anything", async () => {
    const h = harness();
    const r = await h.call("mc_reply", { file: "guide.md", threadId: "abc" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("invalid_arguments");
  });

  it("rejects a change that would break integrity, leaving the file alone", async () => {
    // A rewrite whose replacement carries a half-marker would orphan an anchor.
    const h = harness();
    const { threadId } = body(
      await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "note" }),
    );
    const before = h.read();
    const r = await h.call("mc_rewrite", {
      file: "guide.md",
      threadId,
      with: "text <!--mc:a:zzzzz--> more",
    });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("integrity");
    expect(h.read()).toBe(before);
  });
});

describe("mc_status", () => {
  it("reports progress without reading or writing a document", async () => {
    const h = harness();
    const before = h.read();
    const r = await h.call("mc_status", { note: "reading 2 of 3 files" });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toEqual({ ok: true, note: "reading 2 of 3 files" });
    expect(h.read()).toBe(before);
    expect(h.calls.at(-1)).toEqual({
      tool: "mc_status",
      file: undefined,
      note: "reading 2 of 3 files",
      agent: "claude",
    });
  });
});

describe("call notification", () => {
  it("fires for every document tool with the resolved file", async () => {
    const h = harness();
    await h.call("mc_list", { file: "guide.md" });
    await h.call("mc_check", { file: "guide.md" });
    expect(h.calls).toEqual([
      { tool: "mc_list", file: "/ws/guide.md", agent: "claude" },
      { tool: "mc_check", file: "/ws/guide.md", agent: "claude" },
    ]);
  });

  it("carries the calling agent's slug, not just claude's", async () => {
    const h = harness();
    await h.call("mc_list", { file: "guide.md" }, "codex");
    expect(h.calls).toEqual([{ tool: "mc_list", file: "/ws/guide.md", agent: "codex" }]);
  });
});

describe("author threading (10x-plan-4 P1.2)", () => {
  it("mc_open with a non-default author lands that author, agent: true, on the comment", async () => {
    const h = harness();
    body(await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "?" }, "codex"));
    const thread = parse(h.read()).threads[0]!;
    expect(thread.comments[0]).toMatchObject({ author: "codex", agent: true });
  });

  it("mc_reply with a non-default author lands that author, agent: true", async () => {
    const seeded = addThread(DOC, DOC.indexOf("nested lists"), DOC.indexOf("nested lists") + 12, {
      author: "ronica",
      body: "Ordered too?",
      ts: "2026-07-01T00:00:00.000Z",
    });
    const h = harness(seeded.source);
    body(await h.call("mc_reply", { file: "guide.md", threadId: seeded.thread.id, body: "yes" }, "cursor"));
    const thread = parse(h.read()).threads.find((t) => t.id === seeded.thread.id)!;
    expect(thread.comments.at(-1)).toMatchObject({ author: "cursor", agent: true });
  });

  it("mc_suggest with a non-default author lands that author, agent: true", async () => {
    const h = harness();
    body(
      await h.call(
        "mc_suggest",
        { file: "guide.md", quote: "Suggest mode ships behind a setting.", with: "off by default." },
        "gemini",
      ),
    );
    const suggestion = parse(h.read()).suggestions[0]!;
    expect(suggestion).toMatchObject({ author: "gemini", agent: true });
  });

  it("opList(actionable) treats a Codex-answered thread as no longer waiting on Claude", async () => {
    const h = harness();
    const opened = body(
      await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "human note" }, "claude"),
    );
    // A human opened nothing here; simulate the human still owing nothing and
    // Codex having already answered — actionable should exclude it.
    body(await h.call("mc_reply", { file: "guide.md", threadId: opened.threadId, body: "codex replied" }, "codex"));
    const listed = body(await h.call("mc_list", { file: "guide.md", actionable: true }));
    expect(listed.threads.find((t: { id: string }) => t.id === opened.threadId)).toBeUndefined();
  });
});

// A write through the tools says so in the file, and mc_list
// hands the same field back so an agent can see it too.
describe("via: tools", () => {
  it("mc_open, mc_reply and mc_suggest stamp via: tools, and mc_list reports it", async () => {
    const h = harness();
    const { threadId } = body(await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "q" }, "codex"));
    body(await h.call("mc_reply", { file: "guide.md", threadId, body: "a" }, "cursor"));
    body(
      await h.call("mc_suggest", {
        file: "guide.md",
        quote: "Suggest mode ships behind a setting.",
        with: "Suggest mode is off by default.",
      }),
    );

    const parsed = parse(h.read());
    expect(parsed.threads[0]!.comments.map((c) => c.via)).toEqual(["tools", "tools"]);
    expect(parsed.suggestions[0]!.via).toBe("tools");

    const listed = body(await h.call("mc_list", { file: "guide.md" }));
    expect(listed.threads[0].comments).toEqual([
      expect.objectContaining({ author: "codex", via: "tools" }),
      expect.objectContaining({ author: "cursor", via: "tools" }),
    ]);
    expect(listed.suggestions[0].via).toBe("tools");
  });

  it("a comment that came some other way lists without the field", async () => {
    const seeded = addThread(DOC, DOC.indexOf("nested lists"), DOC.indexOf("nested lists") + 12, {
      author: "ronica",
      body: "Ordered too?",
      ts: "2026-07-01T00:00:00.000Z",
    });
    const h = harness(seeded.source);
    const listed = body(await h.call("mc_list", { file: "guide.md" }));
    expect(listed.threads[0].comments[0]).not.toHaveProperty("via");
  });
});

// Suggest mode used to be a request the model could ignore.
// `suggestModeFor` on `ToolDeps` is how a host tells `callTool` it's on for a
// given document key; `mc_edit`/`mc_rewrite` must refuse outright rather than
// silently applying the change, and every other tool (mc_suggest above all)
// must be unaffected.
describe("suggest mode refusal (10x-plan-6 P2.1)", () => {
  function harnessWithSuggestMode(suggestModeFor?: ToolDeps["suggestModeFor"]) {
    const files = new Map<string, string>([["/ws/guide.md", DOC]]);
    const deps: ToolDeps = {
      resolveFile: async (file) => (file.startsWith("/") ? file : `/ws/${file}`),
      readDoc: async (key) => files.get(key)!,
      writeDoc: async (key, next) => {
        files.set(key, next);
      },
      suggestModeFor,
    };
    return { deps, read: () => files.get("/ws/guide.md")!, call: (name: string, args: Record<string, unknown>) => callTool(name, args, deps) };
  }

  it("mc_edit refuses with suggest_mode_on and writes nothing", async () => {
    const h = harnessWithSuggestMode(() => true);
    const before = h.read();
    const r = await h.call("mc_edit", { file: "guide.md", old: "nested lists", new: "ordered lists" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("suggest_mode_on");
    expect(body(r).error.message).toBe(
      "Suggest mode is on for this file — propose the change with mc_suggest instead",
    );
    expect(h.read()).toBe(before);
  });

  it("mc_rewrite refuses with suggest_mode_on and writes nothing", async () => {
    const h = harnessWithSuggestMode(() => true);
    const opened = body(await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "q" }));
    const before = h.read();
    const r = await h.call("mc_rewrite", { file: "guide.md", threadId: opened.threadId, with: "x" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("suggest_mode_on");
    expect(h.read()).toBe(before);
  });

  it("mc_edit and mc_rewrite proceed as usual when suggest mode is off", async () => {
    const h = harnessWithSuggestMode(() => false);
    const r = await h.call("mc_edit", { file: "guide.md", old: "nested lists", new: "ordered lists" });
    expect(r.isError).toBeUndefined();
    expect(h.read()).toContain("ordered lists");
  });

  it("a caller that never wires suggestModeFor keeps direct edits working", async () => {
    const h = harnessWithSuggestMode(undefined);
    const r = await h.call("mc_edit", { file: "guide.md", old: "nested lists", new: "ordered lists" });
    expect(r.isError).toBeUndefined();
  });

  it("mc_suggest is unaffected — it IS the suggest-mode path", async () => {
    const h = harnessWithSuggestMode(() => true);
    const r = await h.call("mc_suggest", { file: "guide.md", quote: "nested lists", with: "ordered lists" });
    expect(r.isError).toBeUndefined();
  });

  it("other mutating tools (mc_reply, mc_open, mc_resolve) are unaffected", async () => {
    const h = harnessWithSuggestMode(() => true);
    const openResult = await h.call("mc_open", { file: "guide.md", quote: "nested lists", body: "q" });
    expect(openResult.isError).toBeUndefined();
    const { threadId } = body(openResult);
    expect((await h.call("mc_reply", { file: "guide.md", threadId, body: "a" })).isError).toBeUndefined();
    expect((await h.call("mc_resolve", { file: "guide.md", threadId })).isError).toBeUndefined();
  });

  it("is keyed by the resolved document, not called once globally", async () => {
    const seen: string[] = [];
    const h = harnessWithSuggestMode((key) => {
      seen.push(key);
      return true;
    });
    await h.call("mc_edit", { file: "guide.md", old: "nested lists", new: "x" });
    expect(seen).toEqual(["/ws/guide.md"]);
  });
});

// One suggestion, one change — a `with` that reads like a
// whole-paragraph rewrite is refused rather than accepted as a "suggestion".
describe("mc_suggest size guard (10x-plan-6 P2.3)", () => {
  it("suggestionTooLarge is the max of the multiple-of-quote and the flat floor", () => {
    expect(suggestionTooLarge("x".repeat(10), "y".repeat(SUGGESTION_MIN_CHARS))).toBe(false);
    expect(suggestionTooLarge("x".repeat(10), "y".repeat(SUGGESTION_MIN_CHARS + 1))).toBe(true);
    const longQuote = "x".repeat(200);
    const atMultiple = "y".repeat(longQuote.length * SUGGESTION_MAX_MULTIPLE_OF_QUOTE);
    expect(suggestionTooLarge(longQuote, atMultiple)).toBe(false);
    expect(suggestionTooLarge(longQuote, atMultiple + "z")).toBe(true);
  });

  it("mc_suggest refuses a with far longer than the quote, writing nothing", async () => {
    const h = harness();
    const before = h.read();
    const r = await h.call("mc_suggest", {
      file: "guide.md",
      quote: "nested lists",
      with: "x".repeat(SUGGESTION_MIN_CHARS + 1),
    });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("suggestion_too_large");
    expect(body(r).error.message).toMatch(/split/);
    expect(h.read()).toBe(before);
  });

  it("mc_suggest allows a with right at the boundary", async () => {
    const h = harness();
    const r = await h.call("mc_suggest", {
      file: "guide.md",
      quote: "nested lists",
      with: "x".repeat(SUGGESTION_MIN_CHARS),
    });
    expect(r.isError).toBeUndefined();
  });
});

// L1: resolveWorkspaceFile is the boundary a tool call reachable from a model
// actually crosses — the fake resolveFile above (used everywhere else in this
// file) is a stand-in for it, not the real thing, so these tests exercise it
// directly against real files on disk.
describe("resolveWorkspaceFile (L1: workspace-file boundary)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "mc-resolve-"));
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(root), name: "ws", index: 0 },
    ];
    // The stub has no workspace.fs / FileType at all — wire a minimal, real
    // one backed by Node's fs so resolveWorkspaceFile's stat call has
    // something to answer it.
    (vscode as unknown as { FileType: { File: number; Directory: number } }).FileType = { File: 1, Directory: 2 };
    (vscode.workspace as unknown as { fs: unknown }).fs = {
      stat: async (uri: { fsPath: string }) => {
        const s = await fsp.stat(uri.fsPath);
        return { type: s.isDirectory() ? 2 : 1 };
      },
    };
  });

  afterEach(async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("resolves a plain markdown file inside the workspace", async () => {
    await fsp.writeFile(path.join(root, "notes.md"), "# hi\n", "utf8");
    const uri = await resolveWorkspaceFile("notes.md");
    expect(uri.fsPath).toBe(path.join(root, "notes.md"));
  });

  it("resolves a .markdown file too", async () => {
    await fsp.writeFile(path.join(root, "notes.markdown"), "# hi\n", "utf8");
    const uri = await resolveWorkspaceFile("notes.markdown");
    expect(uri.fsPath).toBe(path.join(root, "notes.markdown"));
  });

  it("refuses .git/config even though it's lexically inside the workspace", async () => {
    await fsp.mkdir(path.join(root, ".git"), { recursive: true });
    await fsp.writeFile(path.join(root, ".git", "config"), "[core]\n", "utf8");
    await expect(resolveWorkspaceFile(".git/config")).rejects.toMatchObject({ code: "not_markdown" });
  });

  it("refuses .vscode/tasks.json", async () => {
    await fsp.mkdir(path.join(root, ".vscode"), { recursive: true });
    await fsp.writeFile(path.join(root, ".vscode", "tasks.json"), "{}", "utf8");
    await expect(resolveWorkspaceFile(".vscode/tasks.json")).rejects.toMatchObject({ code: "not_markdown" });
  });

  it("refuses a non-markdown file with no suspicious directory involved", async () => {
    await fsp.writeFile(path.join(root, "notes.txt"), "hi", "utf8");
    await expect(resolveWorkspaceFile("notes.txt")).rejects.toMatchObject({ code: "not_markdown" });
  });

  it("refuses a symlink whose real target resolves outside the workspace", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "mc-outside-"));
    try {
      const target = path.join(outside, "secret.md");
      await fsp.writeFile(target, "# secret\n", "utf8");
      await fsp.symlink(target, path.join(root, "linked.md"));
      await expect(resolveWorkspaceFile("linked.md")).rejects.toMatchObject({ code: "outside_workspace" });
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symlink whose real target is inside the workspace but not markdown", async () => {
    await fsp.writeFile(path.join(root, "real.txt"), "hi", "utf8");
    await fsp.symlink(path.join(root, "real.txt"), path.join(root, "alias.md"));
    await expect(resolveWorkspaceFile("alias.md")).rejects.toMatchObject({ code: "not_markdown" });
  });

  it("accepts a symlink whose real path still lands inside the workspace as an editable file", async () => {
    await fsp.writeFile(path.join(root, "real.md"), "# real\n", "utf8");
    await fsp.symlink(path.join(root, "real.md"), path.join(root, "alias.md"));
    const uri = await resolveWorkspaceFile("alias.md");
    expect(uri.fsPath).toBe(path.join(root, "alias.md"));
  });

  it("still reports file_not_found for a path lexically outside every workspace folder", async () => {
    // Unchanged from before L1 (mdc.ts's forwarder falls back to a direct
    // write on exactly this code) — a non-existent absolute path outside the
    // workspace is "not ours", not "wrong kind".
    await expect(resolveWorkspaceFile("/definitely/not/in/the/workspace.md")).rejects.toMatchObject({
      code: "file_not_found",
    });
  });
});

// L2a: the descriptor's directory and file, tested directly against real
// temp files rather than through startMcpServer (which needs a full
// vscode.ExtensionContext this suite has no stand-in for).
describe("ensureMarkdownCollabDir (L2a)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "mc-dir-"));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("creates the directory and a .gitignore that keeps out everything but conventions.md", async () => {
    const dir = path.join(root, ".markdown-collab");
    await ensureMarkdownCollabDir(dir);
    expect((await fsp.stat(dir)).isDirectory()).toBe(true);
    const gitignore = await fsp.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain("*");
    expect(gitignore).toContain("!conventions.md");
    expect(gitignore).toContain("!.gitignore");
  });

  it("refuses when .markdown-collab is itself a symlink", async () => {
    const real = path.join(root, "elsewhere");
    await fsp.mkdir(real);
    const dir = path.join(root, ".markdown-collab");
    await fsp.symlink(real, dir);
    await expect(ensureMarkdownCollabDir(dir)).rejects.toThrow(/symlink/);
  });

  it("doesn't overwrite an existing .gitignore", async () => {
    const dir = path.join(root, ".markdown-collab");
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, ".gitignore"), "custom\n", "utf8");
    await ensureMarkdownCollabDir(dir);
    expect(await fsp.readFile(path.join(dir, ".gitignore"), "utf8")).toBe("custom\n");
  });

  it.skipIf(process.platform === "win32")("doesn't create a file at the target of a dangling .gitignore symlink", async () => {
    const outside = path.join(root, "outside.txt");
    const dir = path.join(root, ".markdown-collab");
    await fsp.mkdir(dir);
    await fsp.symlink(outside, path.join(dir, ".gitignore"));
    await ensureMarkdownCollabDir(dir);
    await expect(fsp.lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is a no-op on a second call against an already-set-up directory", async () => {
    const dir = path.join(root, ".markdown-collab");
    await ensureMarkdownCollabDir(dir);
    await expect(ensureMarkdownCollabDir(dir)).resolves.toBeUndefined();
  });
});

describe("writeDescriptorFile (L2a: 0600)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "mc-descriptor-"));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("writes at mode 0600, not the process umask's default", async () => {
    const file = path.join(root, ".mcp-server.json");
    await writeDescriptorFile(file, '{"token":"x"}');
    const stat = await fsp.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fsp.readFile(file, "utf8")).toBe('{"token":"x"}');
  });

  it("tightens an existing file's mode to 0600, even if it was left looser", async () => {
    const file = path.join(root, ".mcp-server.json");
    await fsp.writeFile(file, "stale", { mode: 0o644 });
    await writeDescriptorFile(file, '{"token":"y"}');
    const stat = await fsp.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fsp.readFile(file, "utf8")).toBe('{"token":"y"}');
  });

  it.skipIf(process.platform === "win32")("doesn't write through a symlink to a file outside the directory", async () => {
    const outside = path.join(root, "outside.txt");
    await fsp.writeFile(outside, "keep", "utf8");
    const file = path.join(root, ".mcp-server.json");
    await fsp.symlink(outside, file);
    await expect(writeDescriptorFile(file, '{"token":"z"}')).rejects.toThrow(/symlink/);
    expect(await fsp.readFile(outside, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("doesn't create a file at the target of a dangling symlink", async () => {
    const outside = path.join(root, "outside.txt");
    const file = path.join(root, ".mcp-server.json");
    await fsp.symlink(outside, file);
    await expect(writeDescriptorFile(file, '{"token":"z"}')).rejects.toThrow(/symlink/);
    await expect(fsp.lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives a set-up directory a 0600 descriptor", async () => {
    const dir = path.join(root, ".markdown-collab");
    await ensureMarkdownCollabDir(dir);
    const file = path.join(dir, ".mcp-server.json");
    await writeDescriptorFile(file, '{"token":"w"}');
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fsp.readFile(file, "utf8")).toBe('{"token":"w"}');
  });
});

// L2b: no dedicated test harness exists for startMcpServer itself (it needs a
// full vscode.ExtensionContext), so this is the same source-text guard the
// codebase already uses for host-side wiring that isn't otherwise unit
// testable (see commentOnSelection.test.ts / hostSources.ts).
describe("environmentVariableCollection (L2b)", () => {
  it("is set non-persistent, so the token doesn't survive in VS Code's own terminal-env cache", () => {
    const src = readHostFile("mcpServer/index.ts");
    expect(src).toMatch(/environmentVariableCollection\.persistent\s*=\s*false/);
  });
});
