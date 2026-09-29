// The inline-comments toolbar redesign (round-4 P3.1, P3.5): the filter
// segmented control, the "…" overflow menu, and the keyboard hint's
// show-until-used-once behavior. Card-level actions (Reply, the per-card
// "…" menu) live in inlineView.spec.ts, next to the rest of the card tests.

import { expect, test } from "@playwright/test";
import { addThread, parse, replaceThread, type InlineThread } from "../../inlineComments/format";
import { serialize } from "../../inlineComments/serializeState";
import { awaitPosted, bootInlineView, getState, pushToWebview } from "./harness";
import { reviewFixture } from "./fixtures";

const fixture = reviewFixture();

test.beforeEach(async ({ page }) => {
  await bootInlineView(page, {
    fileName: "docs/release-notes.md",
    state: serialize(parse(fixture.source)),
    user: { name: "ronica" },
    imageBaseUris: { docDir: "", workspaceFolder: null },
  });
});

test("the filter row is a radiogroup, and arrow keys move the selection", async ({ page }) => {
  await expect(page.locator(".filter-row")).toHaveAttribute("role", "radiogroup");
  const open = page.locator('input[name="filter"][value="open"]');
  const all = page.locator('input[name="filter"][value="all"]');
  const resolved = page.locator('input[name="filter"][value="resolved"]');
  await expect(open).toBeChecked();

  await open.focus();
  await page.keyboard.press("ArrowRight");
  await expect(all).toBeChecked();
  const allSegment = page.locator(".filter-row .segment", { has: all });
  await expect(allSegment).toHaveClass(/active/);

  // The native radio group's own `change` event is what the client listens
  // to (not a click handler on the segment), so this also proves the visual
  // segment doesn't intercept the key the way it would a mouse click. Landing
  // on "resolved" — where the fixture has nothing — is the one step in this
  // walk with an observably different result from "open".
  await page.keyboard.press("ArrowRight");
  await expect(resolved).toBeChecked();
  await expect(page.locator(".thread-card")).toHaveCount(0);
});

test("agentName from the host renames the Send button and updates its title and the suggest-mode switch title (round-6 P5.2)", async ({ page }) => {
  // Absent agentName reads as Claude — the existing fixture boot (no
  // agentName field) must keep showing exactly what it always has.
  await expect(page.locator("#send-to-claude")).toHaveText("Send to Claude");
  await expect(page.locator("#send-to-claude")).toHaveAttribute("title", /Claude/);
  await expect(page.locator("#suggest-mode-toggle")).toHaveAttribute("title", /Claude/);

  await pushToWebview(page, {
    type: "update",
    state: serialize(parse(fixture.source)),
    suggestMode: false,
    pendingThreadIds: [],
    agentName: "Codex",
  });

  await expect(page.locator("#send-to-claude")).toHaveText("Send to Codex");
  await expect(page.locator("#send-to-claude")).toHaveAttribute("title", /Codex/);
  await expect(page.locator("#suggest-mode-toggle")).toHaveAttribute("title", /Codex/);
});

test("without a host-computed pendingLabel, the waiting row falls back to '<agentName> is working…'", async ({ page }) => {
  await pushToWebview(page, {
    type: "update",
    state: serialize(parse(fixture.source)),
    suggestMode: false,
    pendingThreadIds: [fixture.openThreadId],
    agentName: "Codex",
  });
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card.locator(".mc-card__pending")).toContainText("Codex is working");
});

test("the overflow menu is closed by default and opens on click", async ({ page }) => {
  const btn = page.locator("#overflow-menu-btn");
  const menu = page.locator("#overflow-menu");
  await expect(btn).toHaveAttribute("aria-haspopup", "menu");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeHidden();

  await btn.click();
  await expect(menu).toBeVisible();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
});

test("the overflow menu holds Copy prompt, Collapse all, and — only once resolved — Remove resolved / Remove all review data", async ({ page }) => {
  await page.locator("#overflow-menu-btn").click();
  const menu = page.locator("#overflow-menu");
  await expect(menu.getByRole("menuitem", { name: "Copy prompt" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Collapse all" })).toBeVisible();
  // Nothing's resolved in the fixture yet.
  await expect(menu.locator("#remove-resolved")).toBeHidden();
  await expect(menu.locator("#finalize-doc")).toHaveText("Remove all review data");
});

test("Copy prompt posts copy-prompt and closes the menu", async ({ page }) => {
  await page.locator("#overflow-menu-btn").click();
  await page.locator("#overflow-menu").getByRole("menuitem", { name: "Copy prompt" }).click();
  expect(await awaitPosted(page, "copy-prompt")).toEqual({ type: "copy-prompt" });
  await expect(page.locator("#overflow-menu")).toBeHidden();
});

test("Escape closes the overflow menu and returns focus to its trigger", async ({ page }) => {
  const btn = page.locator("#overflow-menu-btn");
  await btn.click();
  await expect(page.locator("#overflow-menu")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#overflow-menu")).toBeHidden();
  expect(await btn.evaluate((el) => el === document.activeElement)).toBe(true);
});

test("a click outside the open overflow menu closes it", async ({ page }) => {
  await page.locator("#overflow-menu-btn").click();
  await expect(page.locator("#overflow-menu")).toBeVisible();
  await page.locator("#preview").click();
  await expect(page.locator("#overflow-menu")).toBeHidden();
});

test("opening the toolbar menu closes an open card menu, and vice versa", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-menu-btn").click();
  await expect(card.locator(".mc-menu")).toBeVisible();

  await page.locator("#overflow-menu-btn").click();
  await expect(page.locator("#overflow-menu")).toBeVisible();
  await expect(card.locator(".mc-menu")).toBeHidden();
});

test("Remove resolved and Remove all review data appear in the menu once there's something to act on", async ({ page }) => {
  const TS = "2026-01-01T00:00:00.000Z";
  const resolve = (t: InlineThread): InlineThread => ({ ...t, status: "resolved", resolvedBy: "you", resolvedTs: TS });
  const at = fixture.source.indexOf("nested lists");
  const added = addThread(fixture.source, at, at + "nested lists".length, { author: "you", body: "x", ts: TS });
  const withResolved = replaceThread(added.source, added.thread.id, resolve(added.thread));

  await bootInlineView(page, {
    fileName: "doc.md",
    state: serialize(parse(withResolved)),
    user: { name: "r" },
    imageBaseUris: { docDir: "", workspaceFolder: null },
  });
  await page.locator("#overflow-menu-btn").click();
  const menu = page.locator("#overflow-menu");
  await expect(menu.locator("#remove-resolved")).toHaveText("Remove 1 resolved");
  await expect(menu.locator("#finalize-doc")).toBeVisible();
});

test.describe("keyboard hint (P3.5)", () => {
  test("is visible before any of n/p/r/e/o is used, hides after the first use, and persists the dismissal", async ({ page }) => {
    await expect(page.locator("#keys-hint")).toBeVisible();

    await page.keyboard.press("n");
    await expect(page.locator("#keys-hint")).toBeHidden();

    const state = (await getState(page)) as { hintDismissed?: boolean } | undefined;
    expect(state?.hintDismissed).toBe(true);
  });

  test("the \"?\" button brings the hint back, and toggles it off again", async ({ page }) => {
    await page.keyboard.press("e"); // dismiss it, same as any of n/p/r/e/o
    await expect(page.locator("#keys-hint")).toBeHidden();

    const toggle = page.locator("#hint-toggle");
    await toggle.click();
    await expect(page.locator("#keys-hint")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await toggle.click();
    await expect(page.locator("#keys-hint")).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});
