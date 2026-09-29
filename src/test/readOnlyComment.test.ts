// Gate 2 of docs/one-view-design.md, host half: a comment added through the
// read-only path writes into the file's own bytes and nothing else. The edit
// path this replaces (`addThreadAtOffsets`) rebuilt the file from the editor's
// serialization and rewrote 9–62 prose lines per comment in the one-view
// spike; here every add, on every document the spike used, must change none.
//
// The selections here are prose ranges picked by regex — the host doesn't
// care how a range was found. How the webview turns a mouse selection into
// one is gated in webview-e2e/readOnlyComment.spec.ts, through the real bundle.

import { describe, expect, it } from "vitest";
import { addThreadAtProseRange, proseOf } from "../collab/inlineBridge";
import { parse, stripAllInlineMarkup, withThreads } from "../inlineComments/format";
import { oneViewCorpus, onlyMarkersAdded } from "./support/oneViewCorpus";

const COMMENT = { author: "ronica", body: "gate 2", ts: "2026-09-29T00:00:00.000Z" };

/** Word-sized ranges spread through the prose, plus a few spanning four words (and whatever markup lies between). */
function selections(prose: string): Array<{ start: number; end: number }> {
  const words = [...prose.matchAll(/[A-Za-z][A-Za-z'-]{3,}/g)];
  const out: Array<{ start: number; end: number }> = [];
  const picks = Math.min(25, words.length);
  for (let i = 0; i < picks; i++) {
    const w = words[Math.floor((i * words.length) / picks)]!;
    out.push({ start: w.index!, end: w.index! + w[0].length });
  }
  for (let i = 0; i + 3 < words.length && out.length < picks + 6; i += Math.max(1, Math.floor(words.length / 6))) {
    const last = words[i + 3]!;
    out.push({ start: words[i]!.index!, end: last.index! + last[0].length });
  }
  return out;
}

const trimEof = (s: string): string => s.replace(/\n+$/, "");

describe("read-only add-comment writes only its markers", () => {
  for (const doc of oneViewCorpus()) {
    it(`${doc.name}`, () => {
      const before = doc.source;
      const prose = proseOf(before);
      const parsedBefore = parse(before);
      let added = 0;
      for (const sel of selections(prose)) {
        const r = addThreadAtProseRange(before, { ...sel, text: prose.slice(sel.start, sel.end) }, COMMENT);
        if (!r.ok) {
          // The format can't anchor inside code; that refusal is the feature.
          expect(r.error, JSON.stringify(prose.slice(sel.start, sel.end))).toMatch(/code/);
          continue;
        }
        added++;
        const after = r.source;
        const parsedAfter = parse(after);
        const thread = parsedAfter.threads.find((t) => !parsedBefore.threads.some((b) => b.id === t.id))!;
        expect(onlyMarkersAdded(before, after, thread.id)).toEqual([]);
        // Zero prose lines changed. Exact when the file already had a threads
        // block; otherwise up to the blank line the format puts before a new
        // one (see `onlyMarkersAdded`), which only ever sits at the end.
        if (parsedBefore.threadsRegion) {
          expect(stripAllInlineMarkup(after)).toBe(stripAllInlineMarkup(before));
        } else {
          expect(trimEof(stripAllInlineMarkup(after))).toBe(trimEof(stripAllInlineMarkup(before)));
        }
        expect(trimEof(proseOf(after))).toBe(trimEof(prose));
        // It landed on the selected text.
        expect(thread.quote).toBe(prose.slice(sel.start, sel.end));
        expect(parsedAfter.anchors.has(thread.id)).toBe(true);
        // Pending suggestions and the review checkpoint are untouched.
        expect(parsedAfter.suggestions).toEqual(parsedBefore.suggestions);
        expect(parsedAfter.checkpoint).toEqual(parsedBefore.checkpoint);
      }
      expect(added).toBeGreaterThan(0);
    });
  }
});

describe("addThreadAtProseRange", () => {
  const base = "---\ntitle: T\n---\n# Notes\n\nThe parser handles nested lists.\n";

  it("maps through the frontmatter and existing markers to the file's own offsets", () => {
    const prose = proseOf(base);
    const at = prose.indexOf("nested");
    const first = addThreadAtProseRange(base, { start: at, end: at + 6, text: "nested" }, COMMENT);
    expect(first.ok).toBe(true);
    const src1 = (first as { source: string }).source;
    // A second comment right after the first one's close marker stays outside it.
    const prose1 = proseOf(src1);
    const at2 = prose1.indexOf("lists");
    const second = addThreadAtProseRange(src1, { start: at2, end: at2 + 5, text: "lists" }, COMMENT);
    expect(second.ok).toBe(true);
    const src2 = (second as { source: string }).source;
    const quotes = parse(src2).threads.map((t) => t.quote);
    expect(quotes).toEqual(["nested", "lists"]);
    expect(src2.startsWith("---\ntitle: T\n---\n")).toBe(true);
  });

  it("refuses when the file changed under the selection", () => {
    const prose = proseOf(base);
    const at = prose.indexOf("parser");
    const r = addThreadAtProseRange(base, { start: at, end: at + 6, text: "PARSER" }, COMMENT);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/changed/) });
  });

  it("refuses an empty or out-of-range span", () => {
    expect(addThreadAtProseRange(base, { start: 5, end: 5, text: "" }, COMMENT).ok).toBe(false);
    expect(addThreadAtProseRange(base, { start: 0, end: 10_000, text: "x" }, COMMENT).ok).toBe(false);
    expect(addThreadAtProseRange(base, { start: -1, end: 3, text: "x" }, COMMENT).ok).toBe(false);
  });

  it("refuses inside code, as the review view does", () => {
    const src = "Run `npm test` first.\n";
    const at = proseOf(src).indexOf("npm");
    const r = addThreadAtProseRange(src, { start: at, end: at + 3, text: "npm" }, COMMENT);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/code/) });
  });

  it("keeps pending suggestions and the review checkpoint", () => {
    const checkpoint = { ts: "2026-09-01T00:00:00.000Z", contentHash: "abc" };
    const src = withThreads(base, [], [], checkpoint);
    const prose = proseOf(src);
    const at = prose.indexOf("handles");
    const r = addThreadAtProseRange(src, { start: at, end: at + 7, text: "handles" }, COMMENT);
    expect(r.ok).toBe(true);
    expect(parse((r as { source: string }).source).checkpoint).toEqual(checkpoint);
  });
});
