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
  it("invokes the vs-markdown-collab skill and lists each open thread", () => {
    const src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    const prompt = _internal.buildPrompt("docs/foo.md", [parseFirst(src)]);
    expect(prompt).toContain("vs-markdown-collab skill");
    expect(prompt).toContain("1 unresolved review comment on");
    expect(prompt).toContain("docs/foo.md");
    expect(prompt).toContain("world"); // the anchored quote
    expect(prompt).toContain("fix?"); // the latest comment body
  });

  it("delegates the format / reply rules to the skill rather than re-documenting them", () => {
    const src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    const prompt = _internal.buildPrompt("docs/foo.md", [parseFirst(src)]);
    expect(prompt).not.toContain("<!--mc:threads:begin-->");
    expect(prompt).not.toContain('"status":"resolved"');
  });

  it("shows the latest comment body for a thread with replies", () => {
    let src = addThread("Hello world.", 6, 11, { author: "r", body: "fix?", ts: TS }).source;
    src = replaceThread(src, parseFirst(src).id, {
      ...parseFirst(src),
      comments: [
        ...parseFirst(src).comments,
        { id: "c2", parent: "c1", author: "a", ts: TS, body: "still broken" },
      ],
    });
    const prompt = _internal.buildPrompt("docs/foo.md", [parseFirst(src)]);
    expect(prompt).toContain("latest: still broken");
  });
});

function parseFirst(src: string): InlineThread {
  return parse(src).threads[0];
}
