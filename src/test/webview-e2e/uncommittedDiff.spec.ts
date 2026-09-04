// The uncommitted-diff overlay: green stripes for the "after", removed-text
// widgets for the "before". The widgets exist because a deletion (or the old
// half of a modification) used to be invisible — the reviewer saw only what
// the file says now, never what it stopped saying.

import { expect, test } from "@playwright/test";
import { parse } from "../../inlineComments/format";
import { serialize } from "../../inlineComments/serializeState";
import { bootInlineView } from "./harness";

const DOC = "# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n";

const boot = (page: Parameters<typeof bootInlineView>[0], diff: Record<string, unknown> | null) =>
  bootInlineView(page, {
    fileName: "doc.md",
    state: serialize(parse(DOC)),
    diff,
    user: { name: "r" },
    imageBaseUris: { docDir: "", workspaceFolder: null },
  });

test("no diff: no badge, no stripes, no removed widgets", async ({ page }) => {
  await boot(page, null);
  await expect(page.locator("#diff-mode-badge")).toBeHidden();
  await expect(page.locator(".mc-diff-changed")).toHaveCount(0);
  await expect(page.locator(".mc-diff-removed")).toHaveCount(0);
});

test("added range stripes the block on those prose lines", async ({ page }) => {
  // Prose line 3 is "Alpha paragraph.".
  await boot(page, { addedRanges: [{ start: 3, end: 3 }], removed: [], isNew: false });
  await expect(page.locator("#diff-mode-badge")).toHaveText("uncommitted changes");
  const striped = page.locator(".mc-diff-changed");
  await expect(striped).toHaveCount(1);
  await expect(striped).toContainText("Alpha paragraph.");
});

test("a removed run renders the old text after its anchor block", async ({ page }) => {
  // Removed text sat after prose line 3 ("Alpha paragraph.").
  await boot(page, {
    addedRanges: [],
    removed: [{ afterLine: 3, text: "Old paragraph that was deleted." }],
    isNew: false,
  });
  const widget = page.locator(".mc-diff-removed");
  await expect(widget).toHaveCount(1);
  await expect(widget.locator(".mc-diff-removed-text")).toHaveText(
    "Old paragraph that was deleted.",
  );
  await expect(widget.locator(".mc-diff-removed-label")).toContainText("removed");
  // Anchored after the Alpha block: the element right before the widget
  // contains Alpha, and Beta comes after.
  const prevText = await widget.evaluate((el) => el.previousElementSibling?.textContent ?? "");
  expect(prevText).toContain("Alpha paragraph.");
});

test("a removal at the very top goes above everything", async ({ page }) => {
  await boot(page, {
    addedRanges: [],
    removed: [{ afterLine: 0, text: "A deleted intro line." }],
    isNew: false,
  });
  const first = page.locator("#preview > :first-child");
  await expect(first).toHaveClass(/mc-diff-removed/);
  // Deletions count as changes in the badge, even with nothing added.
  await expect(page.locator("#diff-mode-badge")).toHaveText("uncommitted changes");
});

test("a modification shows before and after adjacent to each other", async ({ page }) => {
  // "Alpha paragraph." (line 3) is the rewrite of old text anchored above it
  // (after line 2, the blank following the title — exactly what diffProse
  // emits for a modified paragraph).
  await boot(page, {
    addedRanges: [{ start: 3, end: 3 }],
    removed: [{ afterLine: 2, text: "Alpha paragraf." }],
    isNew: false,
  });
  await expect(page.locator(".mc-diff-changed")).toContainText("Alpha paragraph.");
  const widget = page.locator(".mc-diff-removed");
  await expect(widget.locator(".mc-diff-removed-text")).toHaveText("Alpha paragraf.");
  // The before sits above its replacement.
  const nextText = await widget.evaluate((el) => el.nextElementSibling?.textContent ?? "");
  expect(nextText).toContain("Alpha paragraph.");
});

test("blank-line-only removals are not rendered", async ({ page }) => {
  await boot(page, {
    addedRanges: [],
    removed: [{ afterLine: 3, text: "" }],
    isNew: false,
  });
  await expect(page.locator(".mc-diff-removed")).toHaveCount(0);
  await expect(page.locator("#diff-mode-badge")).toBeVisible();
});

test("several removals anchored through the document land in order", async ({ page }) => {
  await boot(page, {
    addedRanges: [],
    removed: [
      { afterLine: 3, text: "First deletion." },
      { afterLine: 5, text: "Second deletion." },
    ],
    isNew: false,
  });
  const widgets = page.locator(".mc-diff-removed .mc-diff-removed-text");
  await expect(widgets).toHaveCount(2);
  await expect(widgets.nth(0)).toHaveText("First deletion.");
  await expect(widgets.nth(1)).toHaveText("Second deletion.");
});

test("a new file shows the badge and no removed widgets", async ({ page }) => {
  await boot(page, { addedRanges: [{ start: 1, end: 7 }], removed: [], isNew: true });
  await expect(page.locator("#diff-mode-badge")).toHaveText("new file — uncommitted");
  await expect(page.locator(".mc-diff-removed")).toHaveCount(0);
});
