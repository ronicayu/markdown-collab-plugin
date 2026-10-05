// Gate 1: 0 misplaced highlights.
//
// The one-view spike threaded 164 probe words through 8 documents (repeated
// words first, the hard case) and compared the two views. The review view put
// every highlight on the right word; the live editor put 12 on the wrong
// occurrence of it, because it counted occurrences in the Markdown source —
// where image alt text and link targets also contain words — and then searched
// the rendered text. The read-only live editor now places a highlight by the
// source bytes under each character, so it must agree with the review view on
// all 164: same text, same place in its block, none missing. Pending
// suggestions were highlighted by the same search, so 19 suggestion probes
// ride along and are held to the same bar.
//
// The probe set is frozen in fixtures/alignment/probes.json (offsets into the
// documents as stored). The review view is the oracle: it maps rendered text to
// prose offsets through its own markdown-it spans (proseMapping), an
// independent parser.

import * as fs from "fs";
import * as path from "path";
import { expect, test, type Page } from "@playwright/test";
import { bootInlineView, bootLiveEditor, REPO_ROOT } from "./harness";
import { inlineInit, liveInit } from "./fixtures";
import { addSuggestion, addThread } from "../../inlineComments/format";

type Probe = [start: number, end: number, word: string];

interface ProbeDoc {
  name: string;
  file: string;
  /** Anchored as comment threads. */
  probes: Probe[];
  /** Anchored as pending suggestions. */
  suggestions: Probe[];
}

const probeSet = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "src/test/fixtures/alignment/probes.json"), "utf8"),
) as { total: number; totalSuggestions: number; docs: ProbeDoc[] };

type Placed = Record<string, { text: string; before: string }>;

/** Each highlight's text and the text before it in its block, keyed by its id attribute. */
async function highlightsIn(page: Page, sel: { mark: string; attr: string }): Promise<Placed> {
  return page.evaluate(({ mark, attr }) => {
    const out: Record<string, { text: string; before: string }> = {};
    const blockOf = (el: Element): Element =>
      el.closest("p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,dd,dt") ?? el.parentElement!;
    for (const m of Array.from(document.querySelectorAll<HTMLElement>(mark))) {
      const id = m.getAttribute(attr);
      if (!id || out[id]) continue;
      const r = document.createRange();
      r.setStart(blockOf(m), 0);
      r.setEndBefore(m);
      // The review view prints a task item's `[ ]`/`[x]` as text; the editor
      // draws a checkbox. That's rendering, not placement.
      const before = r.toString().replace(/^\s*\[[ xX]\]\s/, "").replace(/\s+/g, " ").slice(-24).trimStart();
      const text = Array.from(document.querySelectorAll<HTMLElement>(`${mark}[${attr}="${id}"]`))
        .map((x) => x.textContent)
        .join("");
      out[id] = { text: text.replace(/\s+/g, " ").trim(), before };
    }
    return out;
  }, sel);
}

/** Compare one kind of highlight between the views; returns the misplaced and missing probes. */
function compare(
  anchors: Array<{ id: string; word: string }>,
  expected: Placed,
  actual: Placed,
): { misplaced: string[]; missing: string[] } {
  const misplaced: string[] = [];
  const missing: string[] = [];
  for (const { id, word } of anchors) {
    const want = expected[id];
    const got = actual[id];
    // The oracle itself must have placed the probe, on the probed word.
    expect(want, `review view lost the probe "${word}"`).toBeDefined();
    expect(want!.text).toBe(word);
    if (!got) missing.push(`"${word}" after …${want!.before}`);
    else if (got.text !== want!.text || got.before !== want!.before) {
      misplaced.push(`"${word}": review …${want!.before}⟦${want!.text}⟧  live …${got.before}⟦${got.text}⟧`);
    }
  }
  return { misplaced, missing };
}

test("the probe set is the spike's 164, plus 19 suggestions", () => {
  expect(probeSet.docs.reduce((n, d) => n + d.probes.length, 0)).toBe(164);
  expect(probeSet.total).toBe(164);
  expect(probeSet.docs.reduce((n, d) => n + d.suggestions.length, 0)).toBe(19);
  expect(probeSet.totalSuggestions).toBe(19);
});

for (const doc of probeSet.docs) {
  test(`read-only highlights sit where the review view puts them: ${doc.name}`, async ({ browser }) => {
    const base = fs.readFileSync(path.join(REPO_ROOT, doc.file), "utf8");
    // Anchor every probe, last first so earlier offsets stay valid.
    const all = [
      ...doc.probes.map((p) => ({ kind: "thread" as const, p })),
      ...doc.suggestions.map((p) => ({ kind: "suggestion" as const, p })),
    ].sort((a, b) => b.p[0] - a.p[0]);
    let source = base;
    const threads: Array<{ id: string; word: string }> = [];
    const suggestions: Array<{ id: string; word: string }> = [];
    for (const { kind, p } of all) {
      const [start, end, word] = p;
      expect(base.slice(start, end), `${doc.file} changed under the frozen probes`).toBe(word);
      const ts = "2026-09-29T00:00:00.000Z";
      if (kind === "thread") {
        const r = addThread(source, start, end, { author: "ronica", body: "probe", ts });
        source = r.source;
        threads.push({ id: r.thread.id, word });
      } else {
        const r = addSuggestion(source, start, end, { author: "claude", proposed: word.toUpperCase(), ts });
        source = r.source;
        suggestions.push({ id: r.suggestion.anchorId, word });
      }
    }

    const threadMarks = { review: { mark: "mark.mc-hl", attr: "data-thread" }, live: { mark: ".mdc-anchor-highlight", attr: "data-comment-id" } };
    const suggestionMarks = {
      review: { mark: "mark.mc-hl--suggestion", attr: "data-suggestion-id" },
      live: { mark: ".mdc-anchor-highlight--suggestion", attr: "data-suggestion-id" },
    };

    const review = await browser.newPage();
    await bootInlineView(review, inlineInit(source));
    await expect(review.locator("mark.mc-hl[data-thread]")).not.toHaveCount(0);
    const expectedThreads = await highlightsIn(review, threadMarks.review);
    const expectedSuggestions = await highlightsIn(review, suggestionMarks.review);
    await review.close();

    const live = await browser.newPage();
    await bootLiveEditor(live, { ...liveInit(source), readOnly: true });
    await expect(live.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    const actualThreads = await highlightsIn(live, threadMarks.live);
    const actualSuggestions = await highlightsIn(live, suggestionMarks.live);
    await live.close();

    const t = compare(threads, expectedThreads, actualThreads);
    const s = compare(suggestions, expectedSuggestions, actualSuggestions);
    expect(t.misplaced, "thread highlights on the wrong occurrence").toEqual([]);
    expect(t.missing, "thread probes with no highlight").toEqual([]);
    expect(s.misplaced, "suggestion highlights on the wrong occurrence").toEqual([]);
    expect(s.missing, "suggestion probes with no highlight").toEqual([]);
  });
}
