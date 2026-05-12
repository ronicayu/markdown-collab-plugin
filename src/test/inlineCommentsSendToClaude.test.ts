import { describe, expect, it } from "vitest";
import { addThread, parse, replaceThread, type InlineThread } from "../inlineComments/format";
import { _internal } from "../inlineComments/sendToClaude";

const TS = "2026-05-12T00:00:00.000Z";

describe("inlineComments/sendToClaude - threadToComment", () => {
  it("maps a single-comment thread to a Comment with no replies", () => {
    const src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    const t = parseFirst(src);
    const c = _internal.threadToComment(t);
    expect(c).toMatchObject({
      id: t.id,
      anchor: { text: "world", contextBefore: "", contextAfter: "" },
      body: "fix?",
      author: "r",
      createdAt: TS,
      resolved: false,
      replies: [],
    });
  });

  it("threads with replies surface as replies[]", () => {
    let src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    src = replaceThread(src, parseFirst(src).id, {
      ...parseFirst(src),
      comments: [
        ...parseFirst(src).comments,
        { id: "c2", parent: "c1", author: "a", ts: TS, body: "yes" },
      ],
    });
    const c = _internal.threadToComment(parseFirst(src));
    expect(c.replies).toEqual([{ author: "a", body: "yes", createdAt: TS }]);
  });

  it("tombstoned comments are excluded from replies + body", () => {
    let src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    src = replaceThread(src, parseFirst(src).id, {
      ...parseFirst(src),
      comments: [
        { ...parseFirst(src).comments[0], deleted: true, body: "" },
        { id: "c2", author: "a", ts: TS, body: "real reply" },
      ],
    });
    const c = _internal.threadToComment(parseFirst(src));
    expect(c.body).toBe("real reply");
    expect(c.replies).toEqual([]);
  });
});

describe("inlineComments/sendToClaude - buildPrompt", () => {
  it("includes file path, format reminder, and each open thread", () => {
    const src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    const prompt = _internal.buildPrompt("docs/foo.md", [parseFirst(src)]);
    expect(prompt).toContain("docs/foo.md");
    expect(prompt).toContain("<!--mc:a:ID-->");
    expect(prompt).toContain("<!--mc:threads:begin-->");
    expect(prompt).toContain("fix?");
    expect(prompt).toContain("world");
  });

  it("instructs the AI to reply, not resolve", () => {
    const src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    const prompt = _internal.buildPrompt("docs/foo.md", [parseFirst(src)]);
    expect(prompt.toLowerCase()).toContain("reply");
    expect(prompt).toContain('Do NOT mark threads resolved');
    // Must not tell the AI to change status to resolved.
    expect(prompt).not.toContain('"status":"resolved"');
  });

  it("tells the AI which parent id to reply to (last live comment in each thread)", () => {
    let src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    src = replaceThread(src, parseFirst(src).id, {
      ...parseFirst(src),
      comments: [
        ...parseFirst(src).comments,
        { id: "c2", parent: "c1", author: "a", ts: TS, body: "I disagree" },
      ],
    });
    const prompt = _internal.buildPrompt("docs/foo.md", [parseFirst(src)]);
    expect(prompt).toContain('parent="c2"');
  });
});

function parseFirst(src: string): InlineThread {
  return parse(src).threads[0];
}
