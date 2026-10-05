// The uncommitted-diff overlay in the live editor's read-only mode —
// mirrors uncommittedDiff.spec.ts (the review view's gate) so the two surfaces are
// held to the same bar: stripes for the "after", removed-text widgets for
// the "before", change navigation, and a marker-only change staying
// unstriped because the diff is computed prose-against-prose.

import { expect, test } from "@playwright/test";
import { addThread } from "../../inlineComments/format";
import { proseOf } from "../../collab/inlineBridge";
import { diffProse } from "../../uncommitted/proseDiff";
import { bootLiveEditor } from "./harness";
import { liveInit } from "./fixtures";

const DOC = "# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n";

const boot = (page: Parameters<typeof bootLiveEditor>[0], diff: Record<string, unknown> | null) =>
  bootLiveEditor(page, { ...liveInit(DOC), readOnly: true, diff });

test("no diff: no badge, no stripes, no removed widgets", async ({ page }) => {
  await boot(page, null);
  await expect(page.locator("#mdc-diff-badge")).toBeHidden();
  await expect(page.locator(".mdc-diff-changed")).toHaveCount(0);
  await expect(page.locator(".mdc-diff-removed")).toHaveCount(0);
});

test("added range stripes the block on those prose lines", async ({ page }) => {
  // Prose line 3 is "Alpha paragraph.".
  await boot(page, { addedRanges: [{ start: 3, end: 3 }], removed: [], isNew: false });
  await expect(page.locator("#mdc-diff-badge")).toHaveText("uncommitted changes");
  const striped = page.locator(".mdc-diff-changed");
  await expect(striped).toHaveCount(1);
  await expect(striped).toContainText("Alpha paragraph.");
});

test("a removed run renders the old text after its anchor block, scrollable and struck through", async ({
  page,
}) => {
  // Removed text sat after prose line 3 ("Alpha paragraph.").
  await boot(page, {
    addedRanges: [],
    removed: [{ afterLine: 3, text: "Old paragraph that was deleted." }],
    isNew: false,
  });
  const widget = page.locator(".mdc-diff-removed");
  await expect(widget).toHaveCount(1);
  const text = widget.locator(".mdc-diff-removed-text");
  await expect(text).toHaveText("Old paragraph that was deleted.");
  await expect(widget.locator(".mdc-diff-removed-label")).toContainText("removed");
  // Tall removals scroll instead of swallowing the page.
  const overflowY = await text.evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY).toBe("auto");
  const textDecoration = await text.evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(textDecoration).toContain("line-through");
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
  const first = page.locator(".milkdown .ProseMirror > :first-child");
  await expect(first).toHaveClass(/mdc-diff-removed/);
  // Deletions count as changes in the badge, even with nothing added.
  await expect(page.locator("#mdc-diff-badge")).toHaveText("uncommitted changes");
});

test("a modification shows before and after adjacent to each other", async ({ page }) => {
  // "Alpha paragraph." (line 3) is the rewrite of old text anchored above it
  // (after line 2, the blank following the title) — exactly what diffProse
  // emits for a modified paragraph.
  await boot(page, {
    addedRanges: [{ start: 3, end: 3 }],
    removed: [{ afterLine: 2, text: "Alpha paragraf." }],
    isNew: false,
  });
  await expect(page.locator(".mdc-diff-changed")).toContainText("Alpha paragraph.");
  const widget = page.locator(".mdc-diff-removed");
  await expect(widget.locator(".mdc-diff-removed-text")).toHaveText("Alpha paragraf.");
  const nextText = await widget.evaluate((el) => el.nextElementSibling?.textContent ?? "");
  expect(nextText).toContain("Alpha paragraph.");
});

test("blank-line-only removals are not rendered", async ({ page }) => {
  await boot(page, { addedRanges: [], removed: [{ afterLine: 3, text: "" }], isNew: false });
  await expect(page.locator(".mdc-diff-removed")).toHaveCount(0);
  await expect(page.locator("#mdc-diff-badge")).toBeVisible();
});

test("a new file shows the badge and no removed widgets", async ({ page }) => {
  await boot(page, { addedRanges: [{ start: 1, end: 7 }], removed: [], isNew: true });
  await expect(page.locator("#mdc-diff-badge")).toHaveText("new file — uncommitted");
  await expect(page.locator(".mdc-diff-removed")).toHaveCount(0);
});

test("a paragraph that only gained a comment marker is not striped — the diff is prose-against-prose", async ({
  page,
}) => {
  const at = DOC.indexOf("Beta paragraph.");
  const withThread = addThread(DOC, at, at + "Beta paragraph.".length, {
    author: "ronica",
    body: "what does this mean?",
    ts: "2026-07-01T10:00:00.000Z",
  }).source;
  // Sanity: the marker changed the SOURCE but not the prose the diff is
  // computed against, so a real prose-against-prose diff finds nothing added.
  const diff = diffProse(proseOf(DOC), proseOf(withThread));
  expect(diff.addedRanges).toEqual([]);
  await bootLiveEditor(page, {
    ...liveInit(withThread),
    readOnly: true,
    diff: { addedRanges: diff.addedRanges, removed: diff.removed, isNew: false },
  });
  await expect(page.locator(".mdc-diff-changed")).toHaveCount(0);
  // The comment itself still anchored normally, unaffected by diff mode.
  await expect(page.locator(".mdc-anchor-highlight")).toHaveCount(1);
});

test.describe("change navigation", () => {
  test("hidden without a diff, counts stripes and removals with one", async ({ page }) => {
    await boot(page, {
      addedRanges: [{ start: 3, end: 3 }],
      removed: [{ afterLine: 5, text: "Gone." }],
      isNew: false,
    });
    await expect(page.locator("#mdc-diff-nav")).toBeVisible();
    await expect(page.locator("#mdc-diff-nav-count")).toHaveText("2 changes");
  });

  test("next steps through every change in order and wraps", async ({ page }) => {
    await boot(page, {
      addedRanges: [
        { start: 3, end: 3 },
        { start: 7, end: 7 },
      ],
      removed: [],
      isNew: false,
    });
    const next = page.locator("#mdc-diff-next");
    await next.click();
    await expect(page.locator("#mdc-diff-nav-count")).toHaveText("1 / 2");
    await expect(page.locator(".mdc-diff-current")).toContainText("Alpha paragraph.");
    await next.click();
    await expect(page.locator("#mdc-diff-nav-count")).toHaveText("2 / 2");
    await expect(page.locator(".mdc-diff-current")).toContainText("Gamma paragraph.");
    await expect(page.locator(".mdc-diff-current")).toHaveCount(1);
    await next.click();
    await expect(page.locator(".mdc-diff-current")).toContainText("Alpha paragraph.");
  });

  test("prev from idle lands on the last change", async ({ page }) => {
    await boot(page, {
      addedRanges: [
        { start: 3, end: 3 },
        { start: 7, end: 7 },
      ],
      removed: [],
      isNew: false,
    });
    await page.locator("#mdc-diff-prev").click();
    await expect(page.locator("#mdc-diff-nav-count")).toHaveText("2 / 2");
    await expect(page.locator(".mdc-diff-current")).toContainText("Gamma paragraph.");
  });

  test("n and p keys step changes via the sidebar's dispatch", async ({ page }) => {
    await boot(page, {
      addedRanges: [
        { start: 3, end: 3 },
        { start: 7, end: 7 },
      ],
      removed: [],
      isNew: false,
    });
    await page.keyboard.press("n");
    await expect(page.locator("#mdc-diff-nav-count")).toHaveText("1 / 2");
    await page.keyboard.press("n");
    await expect(page.locator("#mdc-diff-nav-count")).toHaveText("2 / 2");
    await page.keyboard.press("p");
    await expect(page.locator("#mdc-diff-nav-count")).toHaveText("1 / 2");
  });

  test("nav stays visible after scrolling", async ({ page }) => {
    // A document tall enough to actually scroll .mdc-editor-scroll — the fixed
    // three-paragraph DOC above doesn't overflow the viewport. (The scrolling
    // element used to be `.mdc-editor-pane` itself; the redesign split the
    // pane's padding and scrolling into this inner wrapper so the document
    // toolbar above it can span the pane's full width and stay put.)
    const longDoc =
      "# Title\n\n" + Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.`).join("\n\n") + "\n";
    await bootLiveEditor(page, {
      ...liveInit(longDoc),
      readOnly: true,
      diff: { addedRanges: [{ start: 3, end: 3 }], removed: [], isNew: false },
    });
    await page.evaluate(() => {
      const pane = document.querySelector(".mdc-editor-scroll")!;
      pane.scrollTop = pane.scrollHeight;
    });
    const toolbar = page.locator("#mdc-diff-toolbar");
    await expect(toolbar).toBeVisible();
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThan(100);
  });
});
