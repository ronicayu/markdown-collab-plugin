import { describe, expect, it } from "vitest";
import {
  HELP_HINT,
  SUGGESTION_MAX_MULTIPLE_OF_QUOTE,
  SUGGESTION_MIN_CHARS,
  TOOLS,
  callTool,
  suggestionTooLarge,
  type ToolDeps,
} from "../mcpServer/tools";
import { renderSkill } from "../skillText";
import { addThread, parse } from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";

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

  // 10x-plan-4 P1.3: a client that doesn't surface `instructions` sees only the
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

  // ux-review-2026-09 0.1: the same validator the CLI and the ops use.
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

// 10x-plan-6 P1.4: a write through the tools says so in the file, and mc_list
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

// 10x-plan-6 P2.1: suggest mode used to be a request the model could ignore.
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

// 10x-plan-6 P2.3: one suggestion, one change — a `with` that reads like a
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
