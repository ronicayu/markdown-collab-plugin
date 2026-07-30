// Click-level coverage for the inline-comments webview (10x-plan-2 P2.1).
//
// Every spec drives the shipped bundle with a real pointer and asserts the
// exact message posted to the extension host — the flows that used to be
// signed off with a manual dev-host pass before each release.

import { expect, test } from "@playwright/test";
import { awaitPosted, bootInlineView, clearPosted, posted, pushToWebview } from "./harness";
import { inlineInit, reviewFixture } from "./fixtures";

const fixture = reviewFixture();

test.beforeEach(async ({ page }) => {
  await bootInlineView(page, inlineInit(fixture.source));
});

test("renders the prose, both threads, and the pending suggestion", async ({ page }) => {
  await expect(page.locator("#preview h1")).toHaveText("Release notes");
  // The "open" filter is on by default; the answered thread is still open.
  await expect(page.locator(".thread-card")).toHaveCount(2);
  await expect(page.locator(".mc-suggestion")).toHaveCount(1);
  await expect(page.locator(".mc-suggestion__del")).toContainText("Release notes");
  await expect(page.locator(".mc-suggestion__ins")).toContainText("Release highlights");
});

test("Accept on a suggestion posts accept-suggestion for that anchor", async ({ page }) => {
  await page.locator(".mc-suggestion").getByRole("button", { name: "Accept" }).click();
  expect(await awaitPosted(page, "accept-suggestion")).toEqual({
    type: "accept-suggestion",
    anchorId: fixture.suggestionId,
  });
});

test("Reject on a suggestion posts reject-suggestion for that anchor", async ({ page }) => {
  await page.locator(".mc-suggestion").getByRole("button", { name: "Reject" }).click();
  expect(await awaitPosted(page, "reject-suggestion")).toEqual({
    type: "reject-suggestion",
    anchorId: fixture.suggestionId,
  });
});

test("Send to Claude posts send-to-claude", async ({ page }) => {
  await page.locator("#send-to-claude").click();
  expect(await awaitPosted(page, "send-to-claude")).toEqual({ type: "send-to-claude" });
});

test("the suggest-mode toggle posts toggle-suggest-mode and follows the host's answer", async ({ page }) => {
  const toggle = page.locator("#suggest-mode-toggle");
  await expect(toggle).toHaveText("Suggest: off");

  await toggle.click();
  expect(await awaitPosted(page, "toggle-suggest-mode")).toEqual({ type: "toggle-suggest-mode" });
  // The webview does NOT flip its own label: the setting is the host's, and the
  // toggle only reflects what comes back. Anything else would show "on" after a
  // write that failed.
  await expect(toggle).toHaveText("Suggest: off");

  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    suggestMode: true,
    pendingThreadIds: [],
  });
  await expect(toggle).toHaveText("Suggest: on");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

test("replying in a thread posts the reply with its thread id and body", async ({ page }) => {
  const replyBox = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"] .reply-box`);
  const submit = replyBox.getByRole("button", { name: "Reply", exact: true });
  // The composer stays disabled until there's something to send.
  await expect(submit).toBeDisabled();

  await replyBox.locator("textarea").fill("The setting is markdownCollab.proposeEditsAsSuggestions.");
  await submit.click();

  expect(await awaitPosted(page, "reply")).toEqual({
    type: "reply",
    threadId: fixture.openThreadId,
    body: "The setting is markdownCollab.proposeEditsAsSuggestions.",
  });
});

test("Resolve posts toggle-resolve for the clicked thread only", async ({ page }) => {
  const actions = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .thread-actions`);
  await actions.getByRole("button", { name: "Resolve", exact: true }).click();
  expect(await awaitPosted(page, "toggle-resolve")).toEqual({
    type: "toggle-resolve",
    threadId: fixture.answeredThreadId,
  });
});

test("deleting a thread needs a second click to confirm", async ({ page }) => {
  const actions = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"] .thread-actions`);
  await actions.getByRole("button", { name: "Delete", exact: true }).click();
  // Armed, not fired: one stray click must never destroy a thread.
  expect(await posted(page)).toEqual([]);
  const confirm = actions.getByRole("button", { name: "Confirm delete" });
  await expect(confirm).toBeVisible();

  await confirm.click();
  expect(await awaitPosted(page, "delete-thread")).toEqual({
    type: "delete-thread",
    threadId: fixture.openThreadId,
  });
});

test("a pending thread shows 'Claude is working…' and drops it when the reply lands", async ({ page }) => {
  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    suggestMode: false,
    pendingThreadIds: [fixture.openThreadId],
  });
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card.locator(".mc-card__pending")).toContainText("Claude is working");

  await clearPosted(page);
  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    suggestMode: false,
    pendingThreadIds: [],
  });
  await expect(card.locator(".mc-card__pending")).toHaveCount(0);
});
