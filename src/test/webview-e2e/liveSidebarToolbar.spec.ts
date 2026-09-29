// The live editor's sidebar toolbar (10x-plan-6 P4, sidebar parity): the
// review view's toolbar.spec.ts — filter segments, Send named after the agent,
// the suggest-mode switch, the "…" menu, the keyboard hint — plus the one
// control only the live editor has, the Edit switch between read-only and
// editing.

import { expect, test } from "@playwright/test";
import { addThread, replaceThread, type InlineThread } from "../../inlineComments/format";
import { awaitPosted, bootLiveEditor, getState, posted, pushToWebview } from "./harness";
import { liveInit, liveSidecar, reviewFixture } from "./fixtures";

const fixture = reviewFixture();

test.describe("with the review fixture, read-only", () => {
  test.beforeEach(async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
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
    await expect(page.locator(".filter-row .segment", { has: all })).toHaveClass(/active/);

    await page.keyboard.press("ArrowRight");
    await expect(resolved).toBeChecked();
    await expect(page.locator(".thread-card")).toHaveCount(0);
    // The pending suggestion stays above the list whatever the filter says.
    await expect(page.locator("#threads-list .mc-suggestion")).toHaveCount(1);
  });

  test("the filter survives a reload of the page's state", async ({ page }) => {
    // Switching Read/Edit reloads the webview; the list shouldn't reset with it.
    await page.locator('input[name="filter"][value="all"]').click();
    const state = (await getState(page)) as { threadFilter?: string } | undefined;
    expect(state?.threadFilter).toBe("all");
  });

  test("agentName from the host renames the Send button and its titles", async ({ page }) => {
    await expect(page.locator("#send-to-claude")).toHaveText("Send to Claude");
    await expect(page.locator("#suggest-mode-toggle")).toHaveAttribute("title", /Claude/);

    await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(fixture.source, { agentName: "Codex" }) });
    await expect(page.locator("#send-to-claude")).toHaveText("Send to Codex");
    await expect(page.locator("#send-to-claude")).toHaveAttribute("title", /Codex/);
    await expect(page.locator("#suggest-mode-toggle")).toHaveAttribute("title", /Codex/);
  });

  test("without a host-computed pendingLabel, the waiting row says '<agentName> is working…'", async ({ page }) => {
    await pushToWebview(page, {
      type: "sidecar-changed",
      ...liveSidecar(fixture.source, { pendingThreadIds: [fixture.openThreadId], agentName: "Codex" }),
    });
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await expect(card.locator(".mc-card__pending")).toContainText("Codex is working");
  });

  test("the overflow menu is closed by default and opens on click", async ({ page }) => {
    const btn = page.locator("#overflow-menu-btn");
    await expect(btn).toHaveAttribute("aria-haspopup", "menu");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#overflow-menu")).toBeHidden();
    await btn.click();
    await expect(page.locator("#overflow-menu")).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  test("the overflow menu holds Copy prompt, Collapse all, and — only once resolved — Remove resolved", async ({ page }) => {
    await page.locator("#overflow-menu-btn").click();
    const menu = page.locator("#overflow-menu");
    await expect(menu.getByRole("menuitem", { name: "Copy prompt" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Collapse all" })).toBeVisible();
    await expect(menu.locator("#remove-resolved")).toBeHidden();
    await expect(menu.locator("#finalize-doc")).toHaveText("Remove all review data");
    await expect(menu.locator("#finalize-doc")).toBeVisible();
  });

  test("Copy prompt posts copy-prompt and closes the menu", async ({ page }) => {
    await page.locator("#overflow-menu-btn").click();
    await page.locator("#overflow-menu").getByRole("menuitem", { name: "Copy prompt" }).click();
    expect(await awaitPosted(page, "copy-prompt")).toEqual({ type: "copy-prompt" });
    await expect(page.locator("#overflow-menu")).toBeHidden();
  });

  test("Collapse all folds every card, then reads Expand all", async ({ page }) => {
    await page.locator("#overflow-menu-btn").click();
    await page.locator("#collapse-all").click();
    await expect(page.locator(".thread-card.collapsed")).toHaveCount(2);
    await expect(page.locator("#collapse-all")).toHaveText("Expand all");
  });

  test("Escape closes the overflow menu and returns focus to its trigger", async ({ page }) => {
    const btn = page.locator("#overflow-menu-btn");
    await btn.click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#overflow-menu")).toBeHidden();
    expect(await btn.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test("a click outside the open overflow menu closes it", async ({ page }) => {
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#overflow-menu")).toBeVisible();
    await page.locator(".milkdown p").first().click();
    await expect(page.locator("#overflow-menu")).toBeHidden();
  });

  test("the menu opens inside the sidebar, not off its left edge", async ({ page }) => {
    await page.locator("#overflow-menu-btn").click();
    const menu = await page.locator("#overflow-menu").boundingBox();
    const sidebar = await page.locator(".mc-thread-sidebar").boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(sidebar!.x);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width + 1);
  });

  test("opening the toolbar menu closes an open card menu, and vice versa", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-menu-btn").click();
    await expect(card.locator(".mc-menu")).toBeVisible();
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#overflow-menu")).toBeVisible();
    await expect(card.locator(".mc-menu")).toBeHidden();
  });

  test("Remove all review data posts finalize", async ({ page }) => {
    await page.locator("#overflow-menu-btn").click();
    await page.locator("#finalize-doc").click();
    expect(await awaitPosted(page, "finalize")).toEqual({ type: "finalize" });
  });

  test.describe("keyboard hint", () => {
    test("is visible before any of n/p/r/e/o is used, hides after the first use, and persists the dismissal", async ({ page }) => {
      await expect(page.locator("#keys-hint")).toBeVisible();
      await page.keyboard.press("n");
      await expect(page.locator("#keys-hint")).toBeHidden();
      const state = (await getState(page)) as { hintDismissed?: boolean } | undefined;
      expect(state?.hintDismissed).toBe(true);
    });

    test("the \"?\" button brings the hint back, and toggles it off again", async ({ page }) => {
      await page.keyboard.press("e");
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

  test.describe("the Edit switch", () => {
    test("is off in read-only mode, and asks the host to start editing", async ({ page }) => {
      const toggle = page.locator("#edit-mode-toggle");
      await expect(toggle).toHaveAttribute("role", "switch");
      await expect(page.locator("#edit-mode-label")).toHaveText("Edit");
      await expect(toggle).toHaveAttribute("aria-checked", "false");

      await toggle.click();
      expect(await awaitPosted(page, "set-read-only")).toEqual({ type: "set-read-only", readOnly: false });
      // The mode is the host's to change (it rebuilds the editor); the switch
      // only shows the mode the editor is actually in.
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    });
  });
});

test("in edit mode the Edit switch is on, and asks the host to go read-only", async ({ page }) => {
  await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: false });
  const toggle = page.locator("#edit-mode-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  expect(await awaitPosted(page, "set-read-only")).toEqual({ type: "set-read-only", readOnly: true });
  expect((await posted(page)).filter((m) => m.type === "edit" || m.type === "edit-blocks")).toEqual([]);
});

test("Remove resolved appears in the menu once there's something to act on, and posts remove-resolved", async ({ page }) => {
  const TS = "2026-01-01T00:00:00.000Z";
  const resolve = (t: InlineThread): InlineThread => ({ ...t, status: "resolved", resolvedBy: "you", resolvedTs: TS });
  const at = fixture.source.indexOf("nested lists");
  const added = addThread(fixture.source, at, at + "nested lists".length, { author: "you", body: "x", ts: TS });
  const withResolved = replaceThread(added.source, added.thread.id, resolve(added.thread));

  await bootLiveEditor(page, { ...liveInit(withResolved), readOnly: true });
  await page.locator("#overflow-menu-btn").click();
  const btn = page.locator("#remove-resolved");
  await expect(btn).toHaveText("Remove 1 resolved");
  await btn.click();
  expect(await awaitPosted(page, "remove-resolved")).toEqual({ type: "remove-resolved" });
});
