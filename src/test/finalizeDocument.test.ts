// Finalizing a document: one verb to end the review (issue #1).
//
// When the review is over and the file is about to be committed, every trace
// of review data has to go — markers, threads, suggestions, checkpoint, the
// region itself. Asking Claude to do marker surgery by hand worked, but a
// finished review deserves one button, not a prompt.

import { describe, expect, it } from "vitest";
import {
  addSuggestion,
  addThread,
  parse,
  replaceThread,
  withThreads,
  type InlineThread,
} from "../inlineComments/format";
import { DocOpError, opCheckpoint, opFinalize } from "../inlineComments/docOps";

const TS = "2026-01-01T00:00:00.000Z";
const DOC = "# Guide\n\nAlpha sentence here.\n\nBeta sentence here.\n\nGamma sentence here.\n";
const FRONTMATTER = "---\ntitle: Guide\n---\n\n";

const resolve = (t: InlineThread): InlineThread => ({
  ...t,
  status: "resolved",
  resolvedBy: "you",
  resolvedTs: TS,
});

/** Open a thread on `needle`, optionally resolving it. */
function withThread(src: string, needle: string, resolved: boolean): { source: string; id: string } {
  const at = src.indexOf(needle);
  const r = addThread(src, at, at + needle.length, { author: "you", body: `re ${needle}`, ts: TS });
  if (!resolved) return { source: r.source, id: r.thread.id };
  return { source: replaceThread(r.source, r.thread.id, resolve(r.thread)), id: r.thread.id };
}

describe("opFinalize", () => {
  it("removes open and resolved threads alike, restoring the original document", () => {
    const a = withThread(DOC, "Alpha", true);
    const b = withThread(a.source, "Beta", false);
    const { next, result } = opFinalize(b.source);

    expect(next).toBe(DOC);
    expect(result.removedOpen).toBe(1);
    expect(result.removedResolved).toBe(1);
    expect(result.discardedSuggestions).toBe(0);
  });

  it("discards a pending suggestion but keeps its original text", () => {
    const at = DOC.indexOf("Beta");
    const withSug = addSuggestion(DOC, at, at + 4, {
      author: "claude",
      proposed: "Delta",
      ts: TS,
    }).source;
    const { next, result } = opFinalize(withSug);

    expect(next).toBe(DOC);
    expect(next).toContain("Beta sentence here.");
    expect(next).not.toContain("Delta");
    expect(result.discardedSuggestions).toBe(1);
  });

  it("drops the review checkpoint along with the region", () => {
    const a = withThread(DOC, "Alpha", false);
    const { next: checkpointed } = opCheckpoint(a.source, () => TS);
    expect(checkpointed).toContain("mc:rev");
    const { next } = opFinalize(checkpointed);
    expect(next).toBe(DOC);
  });

  it("leaves frontmatter alone — it belongs to the document, not the review", () => {
    const doc = FRONTMATTER + DOC;
    const a = withThread(doc, "Alpha", false);
    const { next } = opFinalize(a.source);
    expect(next).toBe(doc);
  });

  it("cleans up stray anchor markers even when the threads region is gone", () => {
    // A file mangled by a hand edit: markers in the prose, no records. Finalize
    // is exactly the moment to sweep those out too.
    const stray = DOC.replace("Alpha", "<!--mc:a:zzzzz-->Alpha<!--mc:/a:zzzzz-->");
    const { next } = opFinalize(stray);
    expect(next).toBe(DOC);
  });

  it("refuses on a clean file, rather than silently doing nothing", () => {
    try {
      opFinalize(DOC);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as DocOpError).code).toBe("nothing_to_do");
    }
  });

  it("finalizing an already-finalized document refuses too (idempotence check)", () => {
    const a = withThread(DOC, "Alpha", true);
    const { next } = opFinalize(a.source);
    expect(() => opFinalize(next)).toThrow(DocOpError);
  });

  it("removes an empty threads region left behind by earlier deletions", () => {
    // withThreads([]) with a checkpoint renders a region with no threads.
    const { next: checkpointed } = opCheckpoint(DOC, () => TS);
    const region = withThreads(checkpointed, []);
    expect(region).toContain("mc:threads:begin");
    const { next, result } = opFinalize(region);
    expect(next).not.toContain("mc:");
    expect(result.removedOpen + result.removedResolved).toBe(0);
    expect(parse(next).threadsRegion).toBeNull();
  });
});
