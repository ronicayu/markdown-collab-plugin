// Gate 1: 0 misplaced highlights.
//
// The one-view spike threaded 164 probe words through 8 documents (repeated
// words first, the hard case) and compared the two views. The markdown-it
// review view put every highlight on the right word; the live editor put 12 on
// the wrong occurrence of it, because it counted occurrences in the Markdown
// source — where image alt text and link targets also contain words — and then
// searched the rendered text. The read-only live editor now places a highlight
// by the source bytes under each character, so it must agree with that view on
// all 164: same text, same place in its block, none missing. Pending
// suggestions were highlighted by the same search, so 19 suggestion probes
// ride along and are held to the same bar.
//
// The probe set is frozen in fixtures/alignment/probes.json (offsets into the
// documents as stored). The oracle is frozen beside it, in
// fixtures/alignment/placements.json: for each probe, the text the markdown-it
// view showed before it in its block (an independent parser, mapping rendered
// text to prose offsets through its own spans), recorded before that view was
// removed.

import * as fs from "fs";
import * as path from "path";
import { expect, test, type Page } from "@playwright/test";
import { bootLiveEditor, REPO_ROOT } from "./harness";
import { liveInit } from "./fixtures";
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

/** Per document: the text before each probe in its block, in probe order. */
const placements = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "src/test/fixtures/alignment/placements.json"), "utf8"),
) as Record<string, { probes: string[]; suggestions: string[] }>;

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
      // The markdown-it view printed a task item's `[ ]`/`[x]` as text; the
      // editor draws a checkbox. That's rendering, not placement.
      const before = r.toString().replace(/^\s*\[[ xX]\]\s/, "").replace(/\s+/g, " ").slice(-24).trimStart();
      const text = Array.from(document.querySelectorAll<HTMLElement>(`${mark}[${attr}="${id}"]`))
        .map((x) => x.textContent)
        .join("");
      out[id] = { text: text.replace(/\s+/g, " ").trim(), before };
    }
    return out;
  }, sel);
}

/** Compare one kind of highlight against the oracle; returns the misplaced and missing probes. */
function compare(
  anchors: Array<{ id: string; word: string; before: string }>,
  actual: Placed,
): { misplaced: string[]; missing: string[] } {
  const misplaced: string[] = [];
  const missing: string[] = [];
  for (const { id, word, before } of anchors) {
    const got = actual[id];
    if (!got) missing.push(`"${word}" after …${before}`);
    else if (got.text !== word || got.before !== before) {
      misplaced.push(`"${word}": expected …${before}⟦${word}⟧  live …${got.before}⟦${got.text}⟧`);
    }
  }
  return { misplaced, missing };
}

test("the probe set is the spike's 164, plus 19 suggestions", () => {
  expect(probeSet.docs.reduce((n, d) => n + d.probes.length, 0)).toBe(164);
  expect(probeSet.total).toBe(164);
  expect(probeSet.docs.reduce((n, d) => n + d.suggestions.length, 0)).toBe(19);
  expect(probeSet.totalSuggestions).toBe(19);
  for (const doc of probeSet.docs) {
    expect(placements[doc.name]?.probes, doc.name).toHaveLength(doc.probes.length);
    expect(placements[doc.name]?.suggestions, doc.name).toHaveLength(doc.suggestions.length);
  }
});

for (const doc of probeSet.docs) {
  test(`read-only highlights sit where the markdown-it view put them: ${doc.name}`, async ({ page }) => {
    const base = fs.readFileSync(path.join(REPO_ROOT, doc.file), "utf8");
    const expected = placements[doc.name]!;
    // Anchor every probe, last first so earlier offsets stay valid.
    const all = [
      ...doc.probes.map((p, i) => ({ kind: "thread" as const, p, before: expected.probes[i]! })),
      ...doc.suggestions.map((p, i) => ({ kind: "suggestion" as const, p, before: expected.suggestions[i]! })),
    ].sort((a, b) => b.p[0] - a.p[0]);
    let source = base;
    const threads: Array<{ id: string; word: string; before: string }> = [];
    const suggestions: Array<{ id: string; word: string; before: string }> = [];
    for (const { kind, p, before } of all) {
      const [start, end, word] = p;
      expect(base.slice(start, end), `${doc.file} changed under the frozen probes`).toBe(word);
      const ts = "2026-09-29T00:00:00.000Z";
      if (kind === "thread") {
        const r = addThread(source, start, end, { author: "ronica", body: "probe", ts });
        source = r.source;
        threads.push({ id: r.thread.id, word, before });
      } else {
        const r = addSuggestion(source, start, end, { author: "claude", proposed: word.toUpperCase(), ts });
        source = r.source;
        suggestions.push({ id: r.suggestion.anchorId, word, before });
      }
    }

    await bootLiveEditor(page, { ...liveInit(source), readOnly: true });
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    const actualThreads = await highlightsIn(page, { mark: ".mdc-anchor-highlight", attr: "data-comment-id" });
    const actualSuggestions = await highlightsIn(page, {
      mark: ".mdc-anchor-highlight--suggestion",
      attr: "data-suggestion-id",
    });

    const t = compare(threads, actualThreads);
    const s = compare(suggestions, actualSuggestions);
    expect(t.misplaced, "thread highlights on the wrong occurrence").toEqual([]);
    expect(t.missing, "thread probes with no highlight").toEqual([]);
    expect(s.misplaced, "suggestion highlights on the wrong occurrence").toEqual([]);
    expect(s.missing, "suggestion probes with no highlight").toEqual([]);
  });
}
