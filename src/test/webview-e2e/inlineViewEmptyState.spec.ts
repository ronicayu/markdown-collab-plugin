// The inline-comments thread list's empty state (10x-plan-4 P2.4): a
// first-run card that teaches how to start a thread when the doc has never
// had one, vs. the plain one-line message when a filter is hiding threads
// that do exist.
//
// A separate file from inlineView.spec.ts on purpose: every test here boots
// its own `init` payload (a doc with no threads, or a headlessAvailable
// override), and `bootInlineView` injects the client's stub/bundle scripts
// into the page — doing that twice against one already-booted page throws
// ("Identifier '__mcState' has already been declared"), which is exactly why
// inlineView.spec.ts's shared `beforeEach` boot can't be reused here.

import { expect, test } from "@playwright/test";
import { awaitPosted, bootInlineView } from "./harness";
import { addThread } from "../../inlineComments/format";
import { inlineInit } from "./fixtures";

const EMPTY_DOC = "# Notes\n\nNothing has been reviewed in this file yet.\n";

test("shows 'Review with Claude' when headless is available, and posts empty-state-review", async ({ page }) => {
  await bootInlineView(page, { ...inlineInit(EMPTY_DOC), headlessAvailable: true });
  const card = page.locator(".mc-empty-state");
  await expect(card).toBeVisible();
  await expect(card).toContainText("No comments yet.");
  const button = card.getByRole("button", { name: "Review with Claude" });
  await button.click();
  expect(await awaitPosted(page, "empty-state-review")).toEqual({ type: "empty-state-review" });
});

test("shows 'Ask Claude to review this doc' when headless is unavailable", async ({ page }) => {
  await bootInlineView(page, { ...inlineInit(EMPTY_DOC), headlessAvailable: false });
  const card = page.locator(".mc-empty-state");
  await expect(card.getByRole("button", { name: "Ask Claude to review this doc" })).toBeVisible();
  // Same message either way — only the button label depends on headlessAvailable.
  await expect(card).toContainText("No comments yet.");
});

test("shows both keybinding forms — the client doesn't try to detect the OS", async ({ page }) => {
  await bootInlineView(page, inlineInit(EMPTY_DOC));
  await expect(page.locator(".mc-empty-state__hint")).toContainText("Cmd+K Cmd+Alt+M");
  await expect(page.locator(".mc-empty-state__hint")).toContainText("Ctrl+K Ctrl+Alt+M");
});

test("a filter hiding real threads still shows the plain message, not the first-run card", async ({ page }) => {
  // One open thread, no suggestions: filtering to "resolved" hides it (0
  // shown), but this is not a doc nobody has ever commented on, so it must
  // get the plain filtered message rather than the first-run card.
  const body = "# Notes\n\nSome text worth commenting on.\n";
  const at = body.indexOf("Some text worth commenting on");
  const { source } = addThread(body, at, at + "Some text worth commenting on".length, {
    author: "user",
    body: "a comment",
    ts: "2026-01-01T00:00:00.000Z",
  });
  await bootInlineView(page, inlineInit(source));

  await page.locator('input[name="filter"][value="resolved"]').click();
  await expect(page.locator("#threads-list .empty")).toContainText("No comments match this filter.");
  await expect(page.locator(".mc-empty-state")).toHaveCount(0);
});
