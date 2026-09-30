// The redesigned sidebar chrome (docs/sidebar-chrome-redesign.md): the
// document toolbar's comments toggle, the footer and its send-options menu,
// the filter tabs' own counts, and the header-height budget that keeps the
// clutter this redesign removed from creeping back.
//
// The toolbar's other new control, `#edit-mode-toggle` moved out of the
// sidebar, is covered by modeToggle.spec.ts and liveSidebarToolbar.spec.ts;
// this file is everything else the redesign touched.

import { expect, test } from "@playwright/test";
import { parse, replaceThread } from "../../inlineComments/format";
import { awaitPosted, bootLiveEditor, pushToWebview } from "./harness";
import { liveInit, liveSidecar, reviewFixture } from "./fixtures";

const RESOLVED_TS = "2026-07-02T09:00:00.000Z";

/** `source` with `threadId` marked resolved — the state a toggle-resolve round trip leaves. */
function resolveThread(source: string, threadId: string): string {
  const thread = parse(source).threads.find((t) => t.id === threadId)!;
  return replaceThread(source, threadId, {
    ...thread,
    status: "resolved",
    resolvedBy: "ronica",
    resolvedTs: RESOLVED_TS,
  });
}

test.describe("sidebar footer", () => {
  test("hidden with no threads at all", async ({ page }) => {
    const EMPTY_DOC = "# Notes\n\nNothing has been reviewed in this file yet.\n";
    await bootLiveEditor(page, { ...liveInit(EMPTY_DOC), readOnly: true });
    await expect(page.locator(".mc-sidebar-footer")).toBeHidden();
  });

  test("hidden once every thread is resolved", async ({ page }) => {
    const fixture = reviewFixture();
    const allResolved = resolveThread(resolveThread(fixture.source, fixture.answeredThreadId), fixture.openThreadId);
    await bootLiveEditor(page, { ...liveInit(allResolved), readOnly: true });
    await expect(page.locator(".mc-sidebar-footer")).toBeHidden();
  });

  test("visible with the open count in the Send label otherwise", async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    await expect(page.locator(".mc-sidebar-footer")).toBeVisible();
    await expect(page.locator("#send-to-claude")).toHaveText("Send 2 comments to Claude");

    // Resolving one of the two open threads drops the count to a singular label.
    const oneResolved = resolveThread(fixture.source, fixture.answeredThreadId);
    await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(oneResolved) });
    await expect(page.locator("#send-to-claude")).toHaveText("Send 1 comment to Claude");
  });
});

test.describe("send options", () => {
  test.beforeEach(async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
  });

  test("opening the menu shows suggest mode and copy prompt", async ({ page }) => {
    const btn = page.locator("#send-options-btn");
    await expect(btn).toHaveAttribute("aria-haspopup", "menu");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#send-options-menu")).toBeHidden();

    await btn.click();
    await expect(page.locator("#send-options-menu")).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#suggest-mode-toggle")).toBeVisible();
    await expect(page.locator("#copy-prompt")).toHaveText("Copy prompt instead");
  });

  test("toggling suggest mode posts toggle-suggest-mode", async ({ page }) => {
    await page.locator("#send-options-btn").click();
    await page.locator("#suggest-mode-toggle").click();
    expect(await awaitPosted(page, "toggle-suggest-mode")).toEqual({ type: "toggle-suggest-mode" });
  });

  test("copy prompt instead posts copy-prompt", async ({ page }) => {
    await page.locator("#send-options-btn").click();
    await page.locator("#copy-prompt").click();
    expect(await awaitPosted(page, "copy-prompt")).toEqual({ type: "copy-prompt" });
  });

  test("Escape closes it and returns focus to its trigger", async ({ page }) => {
    const btn = page.locator("#send-options-btn");
    await btn.click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#send-options-menu")).toBeHidden();
    expect(await btn.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test("one menu open at a time with the \"…\" menu", async ({ page }) => {
    await page.locator("#send-options-btn").click();
    await expect(page.locator("#send-options-menu")).toBeVisible();

    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#overflow-menu")).toBeVisible();
    await expect(page.locator("#send-options-menu")).toBeHidden();

    await page.locator("#send-options-btn").click();
    await expect(page.locator("#send-options-menu")).toBeVisible();
    await expect(page.locator("#overflow-menu")).toBeHidden();
  });

  test("opens upward — its bottom sits at or above the trigger's top", async ({ page }) => {
    const btn = page.locator("#send-options-btn");
    await btn.click();
    const btnBox = (await btn.boundingBox())!;
    const menuBox = (await page.locator("#send-options-menu").boundingBox())!;
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(btnBox.y + 1);
  });
});

test.describe("filter tabs", () => {
  test("hidden at 0 total threads", async ({ page }) => {
    const EMPTY_DOC = "# Notes\n\nNothing has been reviewed in this file yet.\n";
    await bootLiveEditor(page, { ...liveInit(EMPTY_DOC), readOnly: true });
    await expect(page.locator(".filter-row")).toBeHidden();
  });

  test("each tab's count matches the threads", async ({ page }) => {
    const fixture = reviewFixture();
    const oneResolved = resolveThread(fixture.source, fixture.answeredThreadId);
    await bootLiveEditor(page, { ...liveInit(oneResolved), readOnly: true });
    await expect(page.locator('.filter-row .segment:has(input[value="open"]) .count')).toHaveText("1");
    await expect(page.locator('.filter-row .segment:has(input[value="all"]) .count')).toHaveText("2");
    await expect(page.locator('.filter-row .segment:has(input[value="resolved"]) .count')).toHaveText("1");
  });
});

test.describe("comments toggle", () => {
  test("collapses the sidebar, shows the open-count badge, and the mode switch stays clickable", async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    const toggle = page.locator("#mdc-comments-toggle");
    const badge = toggle.locator(".mc-badge");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(badge).toBeHidden();

    await toggle.click();
    await expect(page.locator(".mdc-layout")).toHaveClass(/mdc-layout--collapsed/);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveAttribute("aria-label", "Show comments");
    // The open count is never lost just because the sidebar (and its own counts) hid.
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("2");

    // Still reachable with the sidebar collapsed — the whole point of moving it here.
    await page.locator('input[name="edit-mode"][value="edit"]').click();
    expect(await awaitPosted(page, "set-read-only")).toEqual({ type: "set-read-only", readOnly: false });
  });

  test("badge stays hidden collapsed with no open threads", async ({ page }) => {
    const fixture = reviewFixture();
    const allResolved = resolveThread(resolveThread(fixture.source, fixture.answeredThreadId), fixture.openThreadId);
    await bootLiveEditor(page, { ...liveInit(allResolved), readOnly: true });
    await page.locator("#mdc-comments-toggle").click();
    await expect(page.locator("#mdc-comments-toggle .mc-badge")).toBeHidden();
  });
});

test.describe("keyboard shortcuts in the \"…\" menu", () => {
  test("holds Keyboard shortcuts; toggling it shows/hides #keys-hint; the × hides it and unchecks the item", async ({
    page,
  }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });

    // First-run: visible without anyone having touched the menu yet.
    await expect(page.locator("#keys-hint")).toBeVisible();

    await page.locator("#keys-hint-dismiss").click();
    await expect(page.locator("#keys-hint")).toBeHidden();

    await page.locator("#overflow-menu-btn").click();
    const item = page.locator("#hint-toggle");
    await expect(item).toHaveAttribute("role", "menuitemcheckbox");
    await expect(item).toHaveText("Keyboard shortcuts");
    await expect(item).toHaveAttribute("aria-checked", "false");

    await item.click();
    await expect(page.locator("#keys-hint")).toBeVisible();
    await page.locator("#overflow-menu-btn").click();
    await expect(item).toHaveAttribute("aria-checked", "true");
    // Close the menu before the next click — it's still open (absolutely
    // positioned, so it overlaps #keys-hint below the filter row) from the
    // check above.
    await page.keyboard.press("Escape");
    await expect(page.locator("#overflow-menu")).toBeHidden();

    // The inline × on the hint itself dismisses it and unchecks the menu item too.
    await page.locator("#keys-hint-dismiss").click();
    await expect(page.locator("#keys-hint")).toBeHidden();
    await page.locator("#overflow-menu-btn").click();
    await expect(item).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("header height budget", () => {
  test("with threads and no contextual rows, #threads-header is at most 80px tall", async ({ page }) => {
    const fixture = reviewFixture();
    // reviewFixture()'s threads are human-opened (Claude only replies), so
    // #claude-summary has nothing to show on its own; hintDismissed suppresses
    // the shortcut hint the way a returning user's session would.
    await bootLiveEditor(
      page,
      { ...liveInit(fixture.source), readOnly: true },
      { state: { hintDismissed: true } },
    );
    await expect(page.locator("#claude-summary")).toBeHidden();
    await expect(page.locator("#skill-warning")).toBeHidden();
    await expect(page.locator("#keys-hint")).toBeHidden();

    const box = await page.locator("#threads-header").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(80);
  });
});

test.describe("suggest mode shows in the Send label", () => {
  test("with the menu closed, the label says the send asks for suggestions", async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    await expect(page.locator("#send-to-claude")).toHaveText("Send 2 comments to Claude");

    await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(fixture.source, { suggestMode: true }) });
    await expect(page.locator("#send-to-claude")).toHaveText("Send 2 comments to Claude as suggestions");
    await expect(page.locator("#send-options-btn")).toHaveAttribute("title", "Suggest mode is on");
  });
});

test.describe("shortcut hint waits for the first thread", () => {
  test("hidden with no threads, and the menu item is disabled; both come back with the first thread", async ({
    page,
  }) => {
    const EMPTY_DOC = "# Notes\n\nNothing has been reviewed in this file yet.\n";
    await bootLiveEditor(page, { ...liveInit(EMPTY_DOC), readOnly: true });
    await expect(page.locator("#keys-hint")).toBeHidden();
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#hint-toggle")).toBeDisabled();
    await page.keyboard.press("Escape");

    const fixture = reviewFixture();
    await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(fixture.source) });
    await expect(page.locator("#keys-hint")).toBeVisible();
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#hint-toggle")).toBeEnabled();
  });
});
