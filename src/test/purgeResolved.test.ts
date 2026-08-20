// Removing every resolved thread at once.
//
// Resolved threads accumulate over a long review: settled, never read again,
// and in the way of the ones still waiting on someone. Deleting them one at a
// time through the two-click confirm is the tedium this verb replaces.

import { describe, expect, it } from "vitest";
import { addSuggestion, addThread, parse, replaceThread, type InlineThread } from "../inlineComments/format";
import { DocOpError, opPurgeResolved } from "../inlineComments/docOps";

const TS = "2026-01-01T00:00:00.000Z";
const DOC = "# Guide\n\nAlpha sentence here.\n\nBeta sentence here.\n\nGamma sentence here.\n";

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

describe("opPurgeResolved", () => {
  it("removes resolved threads and leaves open ones alone", () => {
    const a = withThread(DOC, "Alpha", true);
    const b = withThread(a.source, "Beta", false);
    const { next, result } = opPurgeResolved(b.source);

    const parsed = parse(next);
    expect(result.removed).toEqual([a.id]);
    expect(parsed.threads.map((t) => t.id)).toEqual([b.id]);
    expect(parsed.threads[0].status).toBe("open");
  });

  it("strips the removed thread's anchor markers from the prose", () => {
    const a = withThread(DOC, "Alpha", true);
    expect(a.source).toContain(`<!--mc:a:${a.id}-->`);
    const { next } = opPurgeResolved(a.source);
    expect(next).not.toContain(`mc:a:${a.id}`);
    // The prose it was anchored to survives untouched.
    expect(next).toContain("Alpha sentence here.");
  });

  it("removes several at once", () => {
    const a = withThread(DOC, "Alpha", true);
    const b = withThread(a.source, "Beta", true);
    const c = withThread(b.source, "Gamma", false);
    const { result, next } = opPurgeResolved(c.source);
    expect(result.removed.sort()).toEqual([a.id, b.id].sort());
    expect(parse(next).threads).toHaveLength(1);
  });

  it("leaves a pending suggestion alone even when a thread beside it is resolved", () => {
    // A suggestion nobody has accepted or rejected is unfinished business, not
    // sediment — removing it would silently discard a proposed edit.
    const a = withThread(DOC, "Alpha", true);
    const at = a.source.indexOf("Beta");
    const withSug = addSuggestion(a.source, at, at + 4, {
      author: "claude",
      proposed: "Delta",
      ts: TS,
    }).source;
    const { next } = opPurgeResolved(withSug);
    expect(parse(next).suggestions).toHaveLength(1);
    expect(parse(next).threads).toHaveLength(0);
  });

  it("refuses when there is nothing to remove, rather than silently doing nothing", () => {
    const open = withThread(DOC, "Alpha", false);
    try {
      opPurgeResolved(open.source);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as DocOpError).code).toBe("nothing_to_do");
    }
  });

  it("refuses on a document with no threads at all", () => {
    expect(() => opPurgeResolved(DOC)).toThrow(DocOpError);
  });

  it("leaves the prose byte-identical apart from the markers it removed", () => {
    const a = withThread(DOC, "Alpha", true);
    const { next } = opPurgeResolved(a.source);
    const stripped = next.replace(/\n*<!--mc:threads:begin-->[\s\S]*<!--mc:threads:end-->\n*/, "\n");
    expect(stripped).toBe(DOC);
  });
});
