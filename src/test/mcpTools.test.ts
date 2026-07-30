import { describe, expect, it } from "vitest";
import { TOOLS, callTool, type ToolDeps } from "../mcpServer/tools";
import { addThread, parse } from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";

const DOC = `# Guide

The parser handles nested lists correctly.

Suggest mode ships behind a setting.
`;

/** An in-memory workspace: one file, recorded writes. */
function harness(initial = DOC) {
  const files = new Map<string, string>([["/ws/guide.md", initial]]);
  const calls: Array<{ tool: string; file?: string; note?: string }> = [];
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
    call: (name: string, args: Record<string, unknown> = {}) => callTool(name, args, deps),
  };
}

/** Tool results are JSON text blocks; parse the one block back out. */
function body(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

describe("mcp tool catalog", () => {
  it("advertises every verb the CLI has, plus the status beacon", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "mc_accept",
      "mc_check",
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
      if (t.name === "mc_status") continue;
      expect(t.inputSchema.required, `${t.name}`).toContain("file");
    }
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
    expect(h.calls.at(-1)).toEqual({ tool: "mc_status", file: undefined, note: "reading 2 of 3 files" });
  });
});

describe("call notification", () => {
  it("fires for every document tool with the resolved file", async () => {
    const h = harness();
    await h.call("mc_list", { file: "guide.md" });
    await h.call("mc_check", { file: "guide.md" });
    expect(h.calls).toEqual([
      { tool: "mc_list", file: "/ws/guide.md" },
      { tool: "mc_check", file: "/ws/guide.md" },
    ]);
  });
});
