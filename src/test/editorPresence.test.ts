// The raw-text-editor presence model (10x-plan-3 P0.1 / P0.3).
//
// Everything here is computed from a document the real format engine built, so
// the offsets are the ones the editor will actually decorate — a hand-written
// fixture would drift from the format and these assertions would keep passing
// while the decorations landed in the wrong place.

import { describe, expect, it } from "vitest";
import {
  addSuggestion,
  addThread,
  appendReply,
  parse,
  replaceThread,
} from "../inlineComments/format";
import type { InlineThread } from "../inlineComments/format";
import {
  hasPresence,
  hoverFor,
  lineAt,
  presenceLensLabel,
  presenceRanges,
  threadAt,
  threadsFold,
} from "../editorPresence/presence";

const T1 = "2026-01-15T10:00:00.000Z";

/** The engine has no `setResolved` helper — resolving is a field update. */
function resolve(t: InlineThread): InlineThread {
  return { ...t, status: "resolved", resolvedBy: "you", resolvedTs: T1 };
}
const NOW = Date.parse("2026-01-15T10:30:00.000Z");

const DOC = `# Guide

The retry policy uses exponential backoff with jitter.

Tokenizers are described in the appendix.
`;

/** A document with one open thread on the backoff sentence. */
function withThread(): { source: string; id: string } {
  const at = DOC.indexOf("exponential backoff");
  const r = addThread(DOC, at, at + "exponential backoff".length, {
    author: "you",
    body: "Is the jitter full or equal?",
    ts: T1,
  });
  return { source: r.source, id: r.thread.id };
}

describe("presenceRanges", () => {
  it("marks both anchor markers and the text between them", () => {
    const { source, id } = withThread();
    const parsed = parse(source);
    const ranges = presenceRanges(parsed);
    const anchor = parsed.anchors.get(id)!;

    expect(ranges.markers).toContainEqual({ start: anchor.openStart, end: anchor.openEnd });
    expect(ranges.markers).toContainEqual({ start: anchor.closeStart, end: anchor.closeEnd });
    expect(ranges.openSpans).toEqual([{ start: anchor.openEnd, end: anchor.closeStart }]);
    // The decorated span is exactly the anchored prose, markers excluded.
    expect(source.slice(anchor.openEnd, anchor.closeStart)).toBe("exponential backoff");
  });

  it("separates resolved threads from open ones", () => {
    const { source, id } = withThread();
    const parsed0 = parse(source);
    const resolved = replaceThread(
      source,
      id,
      resolve(parsed0.threads[0]),
    );
    const ranges = presenceRanges(parse(resolved));
    expect(ranges.openSpans).toHaveLength(0);
    expect(ranges.resolvedSpans).toHaveLength(1);
  });

  it("treats a suggestion's original as its own category", () => {
    const at = DOC.indexOf("jitter");
    const { source } = addSuggestion(DOC, at, at + "jitter".length, {
      author: "claude",
      proposed: "full jitter",
      ts: T1,
    });
    const ranges = presenceRanges(parse(source));
    expect(ranges.suggestionSpans).toHaveLength(1);
    expect(ranges.openSpans).toHaveLength(0);
    // Its markers are still dimmed like any other.
    expect(ranges.markers).toHaveLength(2);
  });

  it("reports the threads region so it can be folded", () => {
    const { source } = withThread();
    const ranges = presenceRanges(parse(source));
    expect(ranges.threadsRegion).not.toBeNull();
    expect(source.slice(ranges.threadsRegion!.start)).toContain("<!--mc:threads:begin-->");
  });

  it("returns nothing for a clean document", () => {
    const ranges = presenceRanges(parse(DOC));
    expect(ranges.markers).toEqual([]);
    expect(ranges.openSpans).toEqual([]);
    expect(ranges.threadsRegion).toBeNull();
    expect(hasPresence(parse(DOC))).toBe(false);
  });

  it("recognizes a reviewed document as carrying presence", () => {
    expect(hasPresence(parse(withThread().source))).toBe(true);
  });
});

describe("lineAt / threadsFold", () => {
  it("counts lines from zero", () => {
    expect(lineAt("a\nb\nc", 0)).toBe(0);
    expect(lineAt("a\nb\nc", 2)).toBe(1);
    expect(lineAt("a\nb\nc", 4)).toBe(2);
  });

  it("folds from the begin fence to the end fence", () => {
    const { source } = withThread();
    const fold = threadsFold(source, parse(source))!;
    const lines = source.split("\n");
    expect(lines[fold.startLine]).toContain("<!--mc:threads:begin-->");
    expect(lines[fold.endLine]).toContain("<!--mc:threads:end-->");
    // The begin fence stays visible when collapsed, so the region is discoverable.
    expect(fold.endLine).toBeGreaterThan(fold.startLine);
  });

  it("has nothing to fold in a clean document", () => {
    expect(threadsFold(DOC, parse(DOC))).toBeNull();
  });
});

describe("threadAt", () => {
  it("finds the thread whose anchor covers the offset", () => {
    const { source, id } = withThread();
    const parsed = parse(source);
    const anchor = parsed.anchors.get(id)!;
    expect(threadAt(parsed, anchor.openEnd + 1)?.id).toBe(id);
  });

  it("returns null outside any anchor", () => {
    const { source } = withThread();
    expect(threadAt(parse(source), 0)).toBeNull();
  });

  it("picks the innermost thread when anchors nest", () => {
    // Comment the sentence, then a word inside it.
    const outerAt = DOC.indexOf("The retry policy uses exponential backoff with jitter.");
    const outer = addThread(DOC, outerAt, outerAt + 53, { author: "you", body: "whole line", ts: T1 });
    const innerAt = outer.source.indexOf("jitter");
    const inner = addThread(outer.source, innerAt, innerAt + "jitter".length, {
      author: "you",
      body: "which jitter",
      ts: T1,
    });
    const parsed = parse(inner.source);
    const innerAnchor = parsed.anchors.get(inner.thread.id)!;
    expect(threadAt(parsed, innerAnchor.openEnd)?.id).toBe(inner.thread.id);
  });
});

describe("hoverFor", () => {
  it("shows the author, age, and body of the latest comment", () => {
    const { source, id } = withThread();
    const parsed = parse(source);
    const anchor = parsed.anchors.get(id)!;
    const hover = hoverFor(parsed, anchor.openEnd, { now: NOW })!;
    expect(hover.markdown).toContain("1 comment");
    expect(hover.markdown).toContain("**you**");
    expect(hover.markdown).toContain("30m");
    expect(hover.markdown).toContain("Is the jitter full or equal?");
  });

  it("shows the newest reply, not the opening comment", () => {
    const { source, id } = withThread();
    const parsed0 = parse(source);
    const next = replaceThread(
      source,
      id,
      appendReply(parsed0.threads[0], {
        author: "claude",
        body: "Full jitter, per the AWS article.",
        ts: T1,
      }),
    );
    const parsed = parse(next);
    const hover = hoverFor(parsed, parsed.anchors.get(id)!.openEnd, { now: NOW })!;
    expect(hover.markdown).toContain("**claude**");
    expect(hover.markdown).toContain("Full jitter");
    expect(hover.markdown).toContain("2 comments");
    expect(hover.markdown).toContain("+1 earlier");
  });

  it("badges a thread Claude opened and nobody has answered", () => {
    const at = DOC.indexOf("Tokenizers");
    const r = addThread(DOC, at, at + 10, {
      author: "claude",
      body: "This section contradicts the appendix.",
      ts: T1,
    });
    const parsed = parse(r.source);
    const hover = hoverFor(parsed, parsed.anchors.get(r.thread.id)!.openEnd, { now: NOW })!;
    expect(hover.markdown).toContain("new from Claude");
  });

  it("badges a resolved thread", () => {
    const { source, id } = withThread();
    const resolved = replaceThread(source, id, resolve(parse(source).threads[0]));
    const parsed = parse(resolved);
    const hover = hoverFor(parsed, parsed.anchors.get(id)!.openEnd, { now: NOW })!;
    expect(hover.markdown).toContain("resolved");
  });

  it("truncates a long body rather than filling the screen", () => {
    const at = DOC.indexOf("Tokenizers");
    const r = addThread(DOC, at, at + 10, { author: "you", body: "x".repeat(900), ts: T1 });
    const parsed = parse(r.source);
    const hover = hoverFor(parsed, parsed.anchors.get(r.thread.id)!.openEnd, { now: NOW })!;
    expect(hover.markdown).toContain("…");
    expect(hover.markdown.length).toBeLessThan(500);
  });

  it("adds a command link only when the caller asks for one", () => {
    const { source, id } = withThread();
    const parsed = parse(source);
    const offset = parsed.anchors.get(id)!.openEnd;
    expect(hoverFor(parsed, offset, { now: NOW })!.markdown).not.toContain("command:");
    const linked = hoverFor(parsed, offset, {
      now: NOW,
      commandLinks: true,
      file: "file:///w/a.md",
    })!;
    expect(linked.markdown).toContain("command:markdownCollab.revealThread?");
    // Arguments are a URI-encoded JSON array — what VS Code expects.
    const args = decodeURIComponent(linked.markdown.split("revealThread?")[1].split(")")[0]);
    expect(JSON.parse(args)).toEqual(["file:///w/a.md", id]);
  });

  it("returns null where there is no thread", () => {
    const { source } = withThread();
    expect(hoverFor(parse(source), 0, { now: NOW })).toBeNull();
  });
});

describe("presenceLensLabel", () => {
  it("counts threads and flags what is unresolved", () => {
    const { source, id } = withThread();
    const second = addThread(source, source.indexOf("Tokenizers"), source.indexOf("Tokenizers") + 10, {
      author: "you",
      body: "second",
      ts: T1,
    });
    const resolved = replaceThread(
      second.source,
      id,
      resolve(parse(second.source).threads.find((t) => t.id === id)!),
    );
    expect(presenceLensLabel(parse(resolved))).toBe("2 comments · 1 unresolved — open review view");
  });

  it("says so when everything is resolved", () => {
    const { source, id } = withThread();
    const resolved = replaceThread(source, id, resolve(parse(source).threads[0]));
    expect(presenceLensLabel(parse(resolved))).toContain("all resolved");
  });

  it("surfaces unread Claude threads and pending suggestions", () => {
    const at = DOC.indexOf("Tokenizers");
    const r = addThread(DOC, at, at + 10, { author: "claude", body: "look at this", ts: T1 });
    const sugAt = r.source.indexOf("jitter");
    const withSug = addSuggestion(r.source, sugAt, sugAt + "jitter".length, {
      author: "claude",
      proposed: "full jitter",
      ts: T1,
    }).source;
    const label = presenceLensLabel(parse(withSug))!;
    expect(label).toContain("1 new from Claude");
    expect(label).toContain("1 suggestion");
  });

  it("is absent for a clean document, so unreviewed files get no chrome", () => {
    expect(presenceLensLabel(parse(DOC))).toBeNull();
  });
});
