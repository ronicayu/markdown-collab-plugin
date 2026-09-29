// Word-level diff in the suggestion card (round-6 P2.2).
//
// A small edit renders as one sentence with the changed words marked in
// place; a rewrite big enough to be mostly different falls back to the old
// two-paragraph old/new block. Either view carries a toggle to the other.

import { expect, test, type Page } from "@playwright/test";
import { addSuggestion, parse } from "../../inlineComments/format";
import { serialize } from "../../inlineComments/serializeState";
import { bootInlineView } from "./harness";

const TS = "2026-07-01T11:30:00.000Z";

/** A one-paragraph document carrying a single pending suggestion on it. */
function docWithSuggestion(original: string, proposed: string): string {
  const doc = `# Doc\n\n${original}\n`;
  const at = doc.indexOf(original);
  return addSuggestion(doc, at, at + original.length, { author: "claude", proposed, ts: TS }).source;
}

async function bootWithSuggestion(page: Page, original: string, proposed: string): Promise<void> {
  const source = docWithSuggestion(original, proposed);
  await bootInlineView(page, {
    fileName: "doc.md",
    state: serialize(parse(source)),
    user: { name: "ronica" },
    imageBaseUris: { docDir: "", workspaceFolder: null },
  });
}

const ORIGINAL = "The parser handles nested lists correctly.";

test("a one-word change renders inline with a single <ins> and a single <del>", async ({ page }) => {
  await bootWithSuggestion(page, ORIGINAL, "The parser handles nested lists precisely.");
  const card = page.locator(".mc-suggestion");
  const sentence = card.locator(".mc-suggestion__sentence");
  await expect(sentence).toBeVisible();
  await expect(sentence.locator("ins")).toHaveCount(1);
  await expect(sentence.locator("del")).toHaveCount(1);
  await expect(sentence.locator("ins")).toHaveText("precisely");
  await expect(sentence.locator("del")).toHaveText("correctly");
  // The old two-paragraph block still exists (the toggle needs it) but isn't shown.
  await expect(card.locator(".mc-suggestion__diff")).toBeHidden();
});

test("a full rewrite falls back to the old two-paragraph old/new view", async ({ page }) => {
  await bootWithSuggestion(
    page,
    ORIGINAL,
    "A sleepy turtle crawls beneath a warm blanket, ignoring the weather outside completely.",
  );
  const card = page.locator(".mc-suggestion");
  await expect(card.locator(".mc-suggestion__diff")).toBeVisible();
  await expect(card.locator(".mc-suggestion__del")).toContainText(ORIGINAL);
  await expect(card.locator(".mc-suggestion__sentence")).toBeHidden();
  await expect(card.locator(".mc-suggestion__toggle")).toHaveText("Show inline");
});

test("the toggle switches a small change between the inline and old/new views", async ({ page }) => {
  await bootWithSuggestion(page, ORIGINAL, "The parser handles nested lists precisely.");
  const card = page.locator(".mc-suggestion");
  const toggle = card.locator(".mc-suggestion__toggle");
  await expect(toggle).toHaveText("Show old / new");

  await toggle.click();
  await expect(card.locator(".mc-suggestion__diff")).toBeVisible();
  await expect(card.locator(".mc-suggestion__sentence")).toBeHidden();
  await expect(toggle).toHaveText("Show inline");

  await toggle.click();
  await expect(card.locator(".mc-suggestion__sentence")).toBeVisible();
  await expect(card.locator(".mc-suggestion__diff")).toBeHidden();
  await expect(toggle).toHaveText("Show old / new");
});

// Security review: `buildSuggestionDiff` used to build the inline word diff
// unconditionally, even when the block view was the one actually shown —
// `diffWords`' O(n·m) LCS table on a 100KB-per-side suggestion is seconds
// and gigabytes, freezing the webview on every render. Past
// `exceedsTokenCap` the inline view is never built at all, not even lazily
// on a click, so the toggle itself is disabled.
test("a 100KB-per-side suggestion renders fast, with the inline toggle disabled instead of ever diffing word by word", async ({
  page,
}) => {
  const original = "lorem ipsum dolor sit amet ".repeat(3800); // ~100KB
  const proposed = "consectetur adipiscing elit sed do ".repeat(2900); // ~100KB
  expect(original.length).toBeGreaterThan(100_000);
  expect(proposed.length).toBeGreaterThan(100_000);

  const start = Date.now();
  await bootWithSuggestion(page, original, proposed);
  const card = page.locator(".mc-suggestion");
  const toggle = card.locator(".mc-suggestion__toggle");
  // A generous bound, not the unit test's tight one (webview boot + IPC
  // overhead dominates here) — the unfixed bug froze the page for seconds at
  // far smaller inputs than this, so this still fails hard on a regression.
  await expect(toggle).toBeVisible({ timeout: 2000 });
  expect(Date.now() - start).toBeLessThan(2000);

  await expect(card.locator(".mc-suggestion__diff")).toBeVisible();
  await expect(card.locator(".mc-suggestion__sentence")).toHaveCount(0);
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveText("Show inline");
  await expect(toggle).toHaveAttribute("title", /too large to diff word by word/);

  // Clicking a disabled button fires no handler either way, but make the
  // intent explicit: there is truly no way to reach the inline view here.
  await toggle.click({ force: true });
  await expect(card.locator(".mc-suggestion__sentence")).toHaveCount(0);
});
