// Suggestion storage + transforms (10x-plan P1.1).
//
// A suggestion keeps the ORIGINAL text in the prose (wrapped in the same
// paired anchor markers a comment uses) and stores the PROPOSED replacement
// in a `<!--mc:s ...-->` line inside the threads region. The file therefore
// renders as the original in any Markdown viewer; the proposal is invisible.
// Accept swaps original→proposed (marker-safe); reject keeps the original.

import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  addSuggestion,
  addThread,
  parse,
  rejectSuggestion,
  stripAllInlineMarkup,
  withThreads,
} from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";

const TS = "2026-07-27T12:00:00.000Z";
const DOC = "# Guide\n\nThe retry policy uses exponential backoff.\n";

function suggestOn(source: string, quote: string, proposed: string, note?: string) {
  const at = source.indexOf(quote);
  if (at === -1) throw new Error(`quote not found: ${quote}`);
  return addSuggestion(source, at, at + quote.length, { author: "claude", proposed, note, ts: TS });
}

describe("addSuggestion", () => {
  it("wraps the original in markers and stores the proposal in a mc:s line", () => {
    const { source, suggestion } = suggestOn(DOC, "exponential backoff", "exponential backoff with jitter", "add jitter");
    const parsed = parse(source);

    expect(parsed.suggestions).toHaveLength(1);
    const s = parsed.suggestions[0];
    expect(s.anchorId).toBe(suggestion.anchorId);
    expect(s.original).toBe("exponential backoff");
    expect(s.proposed).toBe("exponential backoff with jitter");
    expect(s.note).toBe("add jitter");
    expect(s.author).toBe("claude");

    // The anchor wraps the ORIGINAL text.
    const a = parsed.anchors.get(s.anchorId)!;
    expect(source.slice(a.openEnd, a.closeStart)).toBe("exponential backoff");
  });

  it("renders as the original — the proposal is invisible to other viewers", () => {
    const { source } = suggestOn(DOC, "exponential backoff", "exponential backoff with jitter");
    expect(stripAllInlineMarkup(source)).toContain("uses exponential backoff.");
    expect(stripAllInlineMarkup(source)).not.toContain("with jitter");
  });

  it("leaves the document integrity-clean (suggestion anchors are not orphans)", () => {
    const { source } = suggestOn(DOC, "exponential backoff", "exponential backoff with jitter");
    const report = checkIntegrity(source);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("refuses to anchor inside code", () => {
    const doc = "# C\n\nUse the `retry` helper.\n";
    const at = doc.indexOf("retry");
    expect(() => addSuggestion(doc, at, at + 5, { author: "claude", proposed: "x" })).toThrow(/code/);
  });

  it("mints an anchorId unique across threads and other suggestions", () => {
    let doc = DOC;
    doc = addThread(doc, doc.indexOf("Guide"), doc.indexOf("Guide") + 5, { author: "r", body: "hi", ts: TS }).source;
    const first = suggestOn(doc, "exponential backoff", "A");
    const second = addSuggestion(first.source, first.source.indexOf("retry policy"), first.source.indexOf("retry policy") + 12, { author: "claude", proposed: "B", ts: TS });
    const ids = new Set([...parse(second.source).threads.map((t) => t.id), ...parse(second.source).suggestions.map((s) => s.anchorId)]);
    expect(ids.size).toBe(3); // 1 thread + 2 suggestions, all distinct
  });
});

describe("acceptSuggestion", () => {
  it("replaces the original with the proposed text, removes markers + line", () => {
    const { source, suggestion } = suggestOn(DOC, "exponential backoff", "exponential backoff with jitter");
    const after = acceptSuggestion(source, suggestion.anchorId);

    expect(stripAllInlineMarkup(after)).toContain("uses exponential backoff with jitter.");
    expect(parse(after).suggestions).toHaveLength(0);
    expect(parse(after).anchors.has(suggestion.anchorId)).toBe(false);
    expect(after).not.toContain("mc:a:");
    expect(after).not.toContain("mc:s ");
    expect(checkIntegrity(after).ok).toBe(true);
  });

  it("is a no-op for an unknown id", () => {
    const { source } = suggestOn(DOC, "exponential backoff", "x");
    expect(acceptSuggestion(source, "nope1")).toBe(source);
  });
});

describe("rejectSuggestion", () => {
  it("keeps the original, removes markers + line", () => {
    const { source, suggestion } = suggestOn(DOC, "exponential backoff", "exponential backoff with jitter");
    const after = rejectSuggestion(source, suggestion.anchorId);

    expect(stripAllInlineMarkup(after)).toContain("uses exponential backoff.");
    expect(stripAllInlineMarkup(after)).not.toContain("with jitter");
    expect(parse(after).suggestions).toHaveLength(0);
    expect(after).not.toContain("mc:a:");
    expect(checkIntegrity(after).ok).toBe(true);
  });

  it("reject then re-parse restores the original document exactly", () => {
    const { source, suggestion } = suggestOn(DOC, "exponential backoff", "x");
    const after = rejectSuggestion(source, suggestion.anchorId);
    expect(after).toBe(DOC);
  });
});

describe("suggestions coexist with threads", () => {
  it("adding a comment does not disturb a pending suggestion", () => {
    const { source, suggestion } = suggestOn(DOC, "exponential backoff", "exponential backoff with jitter");
    const at = source.indexOf("Guide");
    const withComment = addThread(source, at, at + 5, { author: "ronica", body: "title?", ts: TS }).source;

    const parsed = parse(withComment);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0].anchorId).toBe(suggestion.anchorId);
    expect(parsed.suggestions[0].proposed).toBe("exponential backoff with jitter");
    expect(checkIntegrity(withComment).ok).toBe(true);
  });

  it("withThreads preserves suggestions when suggestions arg is omitted", () => {
    const { source } = suggestOn(DOC, "exponential backoff", "x");
    const parsed = parse(source);
    // Rewrite the region with the same threads, no suggestions arg.
    const rewritten = withThreads(source, parsed.threads);
    expect(parse(rewritten).suggestions).toHaveLength(1);
  });

  it("a suggestion linked to a thread carries its threadId", () => {
    const at = DOC.indexOf("exponential backoff");
    const { source } = addSuggestion(DOC, at, at + "exponential backoff".length, {
      author: "claude",
      proposed: "exponential backoff with jitter",
      threadId: "abc12",
      ts: TS,
    });
    expect(parse(source).suggestions[0].threadId).toBe("abc12");
  });
});

describe("serialization safety", () => {
  const NASTY = [
    "proposed with --> inside",
    "proposed with <!-- inside",
    'proposed with {"json":"ish"}',
    "unicode 🚀 and\nnewline",
  ];
  for (const proposed of NASTY) {
    it(`round-trips a gnarly proposal: ${JSON.stringify(proposed.slice(0, 24))}`, () => {
      const { source, suggestion } = suggestOn(DOC, "exponential backoff", proposed, "note with --> too");
      const parsed = parse(source);
      expect(parsed.suggestions[0].proposed).toBe(proposed);
      expect(parsed.suggestions[0].note).toBe("note with --> too");
      expect(checkIntegrity(source).ok).toBe(true);
      // And accept applies it verbatim.
      const after = acceptSuggestion(source, suggestion.anchorId);
      expect(stripAllInlineMarkup(after)).toContain(proposed);
    });
  }
});

describe("suggestion integrity", () => {
  it("flags a suggestion whose anchor markers were removed", () => {
    const { source, suggestion } = suggestOn(DOC, "exponential backoff", "x");
    const broken = source
      .split(`<!--mc:a:${suggestion.anchorId}-->`)
      .join("")
      .split(`<!--mc:/a:${suggestion.anchorId}-->`)
      .join("");
    const report = checkIntegrity(broken);
    expect(report.issues.some((i) => i.kind === "unanchored-suggestion")).toBe(true);
    expect(report.issues.find((i) => i.kind === "unanchored-suggestion")!.repairable).toBe(false);
  });
});
