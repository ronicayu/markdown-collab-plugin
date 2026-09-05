// Regression: comment highlights drifted one character per hard break.
//
// Milkdown's hardbreak node declares `leafText: () => "\n"`, so PM's
// `doc.textContent` carries a character for every hard break while the
// text-node walk that maps rendered offsets to PM positions does not. The
// live editor located anchors in the first string and mapped them through the
// second, so a comment below six hard breaks highlighted a span starting six
// characters late — mid-word, running off the end of the anchored sentence.

import { expect, test } from "@playwright/test";
import { bootLiveEditor } from "./harness";
import { liveInit } from "./fixtures";
import { addThread } from "../../inlineComments/format";

const ANCHOR = "A single horizontal storyline of the four lifecycles";

/** A doc whose anchored paragraph sits below `n` hard-broken lines. */
function docWithHardBreaks(n: number): string {
  const broken = Array.from({ length: n }, (_, i) => `Line ${i + 1}.  `).join("\n");
  const base = `# Journey view\n\n${broken}\n\n${ANCHOR} as a chain of business moments.\n`;
  const at = base.indexOf(ANCHOR);
  return addThread(base, at, at + ANCHOR.length, {
    author: "ronica",
    body: "what if there are multiple storylines?",
    ts: "2026-09-05T10:00:00.000Z",
  }).source;
}

for (const breaks of [0, 6]) {
  test(`the highlight covers exactly the anchored text with ${breaks} hard breaks above it`, async ({
    page,
  }) => {
    await bootLiveEditor(page, liveInit(docWithHardBreaks(breaks)));
    const mark = page.locator(".mdc-anchor-highlight").first();
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(ANCHOR);
  });
}
