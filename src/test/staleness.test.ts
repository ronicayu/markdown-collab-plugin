import { describe, expect, it } from "vitest";
import {
  anchoredTextOf,
  currentAnchorHash,
  hashAnchorText,
  isThreadStale,
  staleThreadIds,
  withRefreshedAnchorHash,
} from "../inlineComments/staleness";
import { addThread, appendReply, parse, replaceThread, stripAnchorMarkers } from "../inlineComments/format";
import { opList, opReply, opRewrite } from "../inlineComments/docOps";

const DOC = `# Guide

The parser handles nested lists correctly.
`;

/** A document with one thread anchored on "nested lists". */
function seeded(body = "Does this cover ordered lists?") {
  const at = DOC.indexOf("nested lists");
  return addThread(DOC, at, at + "nested lists".length, {
    author: "ronica",
    body,
    ts: "2026-07-01T00:00:00.000Z",
  });
}

/** Rewrite the anchored span in place, the way an editor would. */
function editAnchoredText(source: string, threadId: string, next: string): string {
  const a = parse(source).anchors.get(threadId)!;
  return source.slice(0, a.openEnd) + next + source.slice(a.closeStart);
}

describe("hashAnchorText", () => {
  it("is stable and distinguishes different text", () => {
    expect(hashAnchorText("nested lists")).toBe(hashAnchorText("nested lists"));
    expect(hashAnchorText("nested lists")).not.toBe(hashAnchorText("nested list"));
    expect(hashAnchorText("")).toBe(hashAnchorText(""));
  });

  it("is a fixed-width hex string", () => {
    for (const text of ["", "a", "nested lists", "x".repeat(5000), "emoji 🎉 and ünïcödé"]) {
      expect(hashAnchorText(text)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("notices whitespace-only differences", () => {
    // "the same words" and "the  same words" mean the same thing to a reader
    // but the second is an edit, and the human should be told.
    expect(hashAnchorText("the same words")).not.toBe(hashAnchorText("the  same words"));
  });
});

describe("a new thread records what its author saw", () => {
  it("stamps the anchored text's hash at creation", () => {
    const { source, thread } = seeded();
    expect(thread.anchorHash).toBe(hashAnchorText("nested lists"));
    expect(parse(source).threads[0]!.anchorHash).toBe(thread.anchorHash);
  });

  it("is not stale until the text moves", () => {
    const { source, thread } = seeded();
    expect(isThreadStale(parse(source), thread.id)).toBe(false);
  });
});

describe("isThreadStale", () => {
  it("is true once the anchored text is rewritten", () => {
    const { source, thread } = seeded();
    const edited = editAnchoredText(source, thread.id, "nested and ordered lists");
    expect(isThreadStale(parse(edited), thread.id)).toBe(true);
    expect(staleThreadIds(parse(edited))).toEqual([thread.id]);
  });

  it("ignores edits elsewhere in the document", () => {
    const { source, thread } = seeded();
    const edited = source.replace("# Guide", "# Guide to the parser");
    expect(isThreadStale(parse(edited), thread.id)).toBe(false);
  });

  // Backwards compatibility: files written before this existed carry no hash,
  // and "unknown" must never render as a clean bill of health.
  it("is false for a thread with no stored hash, however much the text moved", () => {
    const { source, thread } = seeded();
    const legacy = replaceThread(source, thread.id, { ...thread, anchorHash: undefined });
    expect(legacy).not.toContain("anchorHash");
    const edited = editAnchoredText(legacy, thread.id, "something else entirely");
    expect(isThreadStale(parse(edited), thread.id)).toBe(false);
  });

  it("is false for an unanchored thread — the broken anchor is the louder problem", () => {
    const { source, thread } = seeded();
    const orphaned = stripAnchorMarkers(source, thread.id);
    expect(parse(orphaned).anchors.has(thread.id)).toBe(false);
    expect(isThreadStale(parse(orphaned), thread.id)).toBe(false);
  });

  it("is false for a thread id that isn't in the document", () => {
    expect(isThreadStale(parse(DOC), "nope1")).toBe(false);
  });
});

describe("the hash refreshes when someone comments", () => {
  it("a reply resets the baseline to the text the replier saw", () => {
    const { source, thread } = seeded();
    const edited = editAnchoredText(source, thread.id, "nested and ordered lists");
    expect(isThreadStale(parse(edited), thread.id)).toBe(true);

    const parsed = parse(edited);
    const replied = replaceThread(
      edited,
      thread.id,
      withRefreshedAnchorHash(parsed, appendReply(parsed.threads[0]!, {
        author: "ronica",
        body: "still fine",
        ts: "2026-07-02T00:00:00.000Z",
      })),
    );
    expect(isThreadStale(parse(replied), thread.id)).toBe(false);
  });

  it("Claude's reply through the shared op refreshes it too", () => {
    const { source, thread } = seeded();
    const edited = editAnchoredText(source, thread.id, "nested and ordered lists");
    const { next } = opReply(edited, thread.id, "Yes — both are covered.");
    expect(isThreadStale(parse(next), thread.id)).toBe(false);
  });

  it("a rewrite through the shared op is not stale — the rewriter wrote it", () => {
    const { source, thread } = seeded();
    const { next } = opRewrite(source, thread.id, "ordered and bullet lists");
    expect(isThreadStale(parse(next), thread.id)).toBe(false);
    expect(anchoredTextOf(parse(next), thread.id)).toBe("ordered and bullet lists");
  });

  it("leaves an unanchored thread's hash alone rather than hashing nothing", () => {
    const { source, thread } = seeded();
    const orphaned = parse(stripAnchorMarkers(source, thread.id));
    const t = orphaned.threads[0]!;
    expect(withRefreshedAnchorHash(orphaned, t)).toBe(t);
    expect(currentAnchorHash(orphaned, thread.id)).toBeUndefined();
  });
});

describe("mc_list reports staleness", () => {
  it("marks the stale thread so Claude re-evaluates it first", () => {
    const { source, thread } = seeded();
    const edited = editAnchoredText(source, thread.id, "nested and ordered lists");
    const listed = opList(edited);
    expect(listed.threads[0]).toMatchObject({ id: thread.id, stale: true });
    expect(opList(source).threads[0]!.stale).toBe(false);
  });
});
