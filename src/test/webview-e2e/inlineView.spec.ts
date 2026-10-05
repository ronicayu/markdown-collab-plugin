// Click-level coverage for the inline-comments webview.
//
// Every spec drives the shipped bundle with a real pointer and asserts the
// exact message posted to the extension host — the flows that used to be
// signed off with a manual dev-host pass before each release.

import { expect, test } from "@playwright/test";
import { awaitPosted, bootInlineView, clearPosted, posted, pushToWebview } from "./harness";
import { editAnchoredText, inlineInit, replyTo, reviewFixture, twoSuggestions } from "./fixtures";

const fixture = reviewFixture();

test.beforeEach(async ({ page }) => {
  await bootInlineView(page, inlineInit(fixture.source));
});

test("renders the prose, both threads, and the pending suggestion", async ({ page }) => {
  await expect(page.locator("#preview h1")).toHaveText("Release notes");
  // The "open" filter is on by default; the answered thread is still open.
  await expect(page.locator(".thread-card")).toHaveCount(2);
  await expect(page.locator(".mc-suggestion")).toHaveCount(1);
  // "Release notes" → "Release highlights" is a one-word change, small enough
  // that the card defaults to the inline word diff (round-6 P2.2), not the
  // old two-paragraph old/new block.
  const sentence = page.locator(".mc-suggestion .mc-suggestion__sentence");
  await expect(sentence).toBeVisible();
  await expect(sentence.locator("del")).toHaveText("notes");
  await expect(sentence.locator("ins")).toHaveText("highlights");
  await expect(page.locator(".mc-suggestion .mc-suggestion__diff")).toBeHidden();
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

test("the suggest-mode switch posts toggle-suggest-mode and follows the host's answer", async ({ page }) => {
  // round-4 P3.1: a labelled `role="switch"`, not a chip whose own label read
  // as status text ("Suggest: off"). The state lives beside it in a fixed
  // "Suggest mode" label; the switch itself only ever carries aria-checked.
  const toggle = page.locator("#suggest-mode-toggle");
  await expect(page.locator("#suggest-mode-label")).toHaveText("Suggest mode");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  expect(await awaitPosted(page, "toggle-suggest-mode")).toEqual({ type: "toggle-suggest-mode" });
  // The webview does NOT flip its own state: the setting is the host's, and
  // the switch only reflects what comes back. Anything else would show "on"
  // after a write that failed.
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    suggestMode: true,
    pendingThreadIds: [],
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

test("replying in a thread posts the reply with its thread id and body", async ({ page }) => {
  // round-4 P3.2: the reply box is collapsed until Reply is clicked.
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  const replyBox = card.locator(".reply-box");
  await expect(replyBox).toBeHidden();
  await card.locator(".thread-reply-toggle").click();
  await expect(replyBox).toBeVisible();

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
  // Collapses back once sent.
  await expect(replyBox).toBeHidden();
});

test("clicking Reply toggles the composer open and closed", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  const toggle = card.locator(".thread-reply-toggle");
  const replyBox = card.locator(".reply-box");
  await expect(replyBox).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(replyBox).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const focused = await replyBox.locator("textarea").evaluate((el) => el === document.activeElement);
  expect(focused).toBe(true);

  await toggle.click();
  await expect(replyBox).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("a card with an unsent draft keeps its reply box open across a re-render", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-reply-toggle").click();
  await card.locator(".reply-box textarea").fill("half a thought");

  // Any external update re-renders the whole list.
  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    suggestMode: false,
    pendingThreadIds: [],
  });
  await expect(card.locator(".reply-box")).toBeVisible();
  await expect(card.locator(".reply-box textarea")).toHaveValue("half a thought");
});

test("Resolve posts toggle-resolve for the clicked thread only", async ({ page }) => {
  const actions = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .thread-actions`);
  await actions.getByRole("button", { name: "Resolve", exact: true }).click();
  expect(await awaitPosted(page, "toggle-resolve")).toEqual({
    type: "toggle-resolve",
    threadId: fixture.answeredThreadId,
  });
});

test("the per-card \"…\" menu holds Open in editor, Copy prompt, and Delete", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  const menuBtn = card.locator(".thread-menu-btn");
  await expect(menuBtn).toHaveAttribute("aria-haspopup", "menu");
  await expect(menuBtn).toHaveAttribute("aria-expanded", "false");

  const menu = card.locator(".mc-menu");
  await expect(menu).toBeHidden();
  await menuBtn.click();
  await expect(menu).toBeVisible();
  await expect(menuBtn).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText(["Open in editor", "Copy prompt", "Delete"]);
});

test("Escape closes a card's menu and returns focus to its \"…\" button", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  const menuBtn = card.locator(".thread-menu-btn");
  await menuBtn.click();
  await expect(card.locator(".mc-menu")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(card.locator(".mc-menu")).toBeHidden();
  const focused = await menuBtn.evaluate((el) => el === document.activeElement);
  expect(focused).toBe(true);
});

test("a click outside a card's open menu closes it", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-menu-btn").click();
  await expect(card.locator(".mc-menu")).toBeVisible();

  await page.locator("#preview").click();
  await expect(card.locator(".mc-menu")).toBeHidden();
});

test("a card's Send button posts send-to-claude-comment for that thread alone, no menu involved", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  const send = card.locator(".thread-actions .thread-send");
  await expect(send).toHaveText("Send");
  await expect(send).toHaveAttribute("title", "Send this thread to Claude");
  await send.click();
  expect(await posted(page)).toEqual([{ type: "send-to-claude-comment", threadId: fixture.openThreadId }]);
  await expect(card.locator(".mc-menu")).toBeHidden();
});

test("\"Copy prompt\" in the card menu posts the thread-scoped message", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-menu-btn").click();
  await card.getByRole("menuitem", { name: "Copy prompt" }).click();
  expect(await awaitPosted(page, "copy-claude-comment")).toEqual({
    type: "copy-claude-comment",
    threadId: fixture.openThreadId,
  });
  await expect(card.locator(".mc-menu")).toBeHidden();
});

test("deleting a thread needs a second click to confirm, inside the card menu", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-menu-btn").click();
  const deleteItem = card.getByRole("menuitem", { name: "Delete", exact: true });
  await deleteItem.click();
  // Armed, not fired: one stray click must never destroy a thread.
  expect(await posted(page)).toEqual([]);
  const confirm = card.getByRole("menuitem", { name: "Confirm delete" });
  await expect(confirm).toBeVisible();

  await confirm.click();
  expect(await awaitPosted(page, "delete-thread")).toEqual({
    type: "delete-thread",
    threadId: fixture.openThreadId,
  });
});

test("the waiting row shows the phase Claude reported over MCP", async ({ page }) => {
  // With protocol evidence the host sends specific wording
  // instead of the inferred default, and the card renders whatever it is given.
  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    suggestMode: false,
    pendingThreadIds: [fixture.openThreadId],
    pendingLabel: "Claude: reading 2 of 3 files",
  });
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card.locator(".mc-card__pending")).toContainText("Claude: reading 2 of 3 files");
  await expect(card.locator(".mc-card__pending")).not.toContainText("Claude is working");
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

test("a thread whose passage was rewritten shows a 'text changed' badge", async ({ page }) => {
  // The comment may be answering text that is no longer there,
  // and nothing in the card said so before.
  const stale = editAnchoredText(fixture.source, fixture.openThreadId, "behind a different setting");
  await pushToWebview(page, {
    type: "update",
    state: inlineInit(stale).state,
    suggestMode: false,
    pendingThreadIds: [],
  });

  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card.locator(".badge.stale")).toHaveText("text changed");
  // The other thread is untouched and must stay unbadged — a badge on
  // everything is the same as a badge on nothing.
  await expect(
    page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .badge.stale`),
  ).toHaveCount(0);
});

test("replying to a stale thread clears the badge", async ({ page }) => {
  const stale = editAnchoredText(fixture.source, fixture.openThreadId, "behind a different setting");
  await pushToWebview(page, {
    type: "update",
    state: inlineInit(stale).state,
    suggestMode: false,
    pendingThreadIds: [],
  });
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card.locator(".badge.stale")).toBeVisible();

  // The host applies the reply and pushes fresh state; the reply resets the
  // baseline because the replier just read the new text.
  await pushToWebview(page, {
    type: "update",
    state: inlineInit(replyTo(stale, fixture.openThreadId, "Noted — the new wording is fine.")).state,
    suggestMode: false,
    pendingThreadIds: [],
  });
  await expect(card.locator(".badge.stale")).toHaveCount(0);
});

// n/p/r/e unified keyboard map for the thread list (outside
// the diff overlay, which uncommittedDiff.spec.ts already covers for n/p).

test("n moves the highlight to the next thread card, p to the previous, wrapping at both ends", async ({ page }) => {
  const answered = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
  const open = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(page.locator(".thread-card.highlighted")).toHaveCount(0);

  // Nothing highlighted yet: n starts at the first card in document order.
  await page.keyboard.press("n");
  await expect(answered).toHaveClass(/highlighted/);
  await expect(open).not.toHaveClass(/highlighted/);

  await page.keyboard.press("n");
  await expect(open).toHaveClass(/highlighted/);
  await expect(answered).not.toHaveClass(/highlighted/);

  // Past the last card, n wraps to the first.
  await page.keyboard.press("n");
  await expect(answered).toHaveClass(/highlighted/);

  // p from the first card wraps back to the last.
  await page.keyboard.press("p");
  await expect(open).toHaveClass(/highlighted/);
  await expect(answered).not.toHaveClass(/highlighted/);
});

test("r focuses the highlighted thread's reply textarea, expanding a collapsed card first", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
  await card.locator(".thread-collapse").click();
  await expect(card).toHaveClass(/collapsed/);

  await page.keyboard.press("n"); // highlights the first card (answered)
  await expect(card).toHaveClass(/highlighted/);

  await page.keyboard.press("r");
  await expect(card).not.toHaveClass(/collapsed/);
  const focused = await card
    .locator(".reply-box textarea")
    .evaluate((el) => el === document.activeElement);
  expect(focused).toBe(true);
});

test("r is a no-op when nothing is highlighted", async ({ page }) => {
  await page.keyboard.press("r");
  const anyFocused = await page.evaluate(
    () => document.activeElement instanceof HTMLTextAreaElement,
  );
  expect(anyFocused).toBe(false);
});

test("e posts toggle-resolve for the highlighted thread — the same message Resolve posts", async ({ page }) => {
  await page.keyboard.press("n"); // highlights the first card (answered)
  await page.keyboard.press("e");
  expect(await awaitPosted(page, "toggle-resolve")).toEqual({
    type: "toggle-resolve",
    threadId: fixture.answeredThreadId,
  });
});

test("n/p/r/e are inert while a reply textarea has focus", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-reply-toggle").click(); // opens the composer
  const replyTextarea = card.locator(".reply-box textarea");
  await replyTextarea.click();

  await page.keyboard.press("n");
  await page.keyboard.press("p");
  await page.keyboard.press("e");
  // "r" also just types a letter into the focused textarea — assert it did
  // NOT steal focus toward some other thread's reply box.
  await page.keyboard.press("r");

  await expect(page.locator(".thread-card.highlighted")).toHaveCount(0);
  expect(await posted(page)).toEqual([]);
});

test("Accept all needs a second click, and only appears for more than one suggestion", async ({ page }) => {
  // One suggestion is the fixture's default: the bulk action
  // would be a second button doing what Accept already does.
  await expect(page.locator(".accept-all-row")).toHaveCount(0);

  await pushToWebview(page, {
    type: "update",
    state: inlineInit(twoSuggestions(fixture.source)).state,
    suggestMode: false,
    pendingThreadIds: [],
  });
  const button = page.locator(".accept-all-row button");
  await expect(button).toHaveText("Accept all 2");

  await button.click();
  // Armed, not fired: this rewrites the whole document.
  expect(await posted(page)).toEqual([]);
  await expect(button).toHaveText(/Click again/);

  await button.click();
  expect(await awaitPosted(page, "accept-all-suggestions")).toEqual({
    type: "accept-all-suggestions",
  });
});

// Reverse navigation, a11y. (The empty-state variants live in
// inlineViewEmptyState.spec.ts — each of those needs its own `init` payload,
// and this file's `beforeEach` already booted the page once with the shared
// fixture; a second `init`-time script injection into the same page throws.)

test("\"Open in editor\" in the card menu posts open-in-editor for that thread", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-menu-btn").click();
  await card.getByRole("menuitem", { name: "Open in editor" }).click();
  expect(await awaitPosted(page, "open-in-editor")).toEqual({
    type: "open-in-editor",
    threadId: fixture.openThreadId,
  });
});

test("o opens the highlighted thread in the editor", async ({ page }) => {
  await page.keyboard.press("n"); // highlights the first card (answered)
  await page.keyboard.press("o");
  expect(await awaitPosted(page, "open-in-editor")).toEqual({
    type: "open-in-editor",
    threadId: fixture.answeredThreadId,
  });
});

test("o is a no-op when nothing is highlighted", async ({ page }) => {
  await page.keyboard.press("o");
  expect(await posted(page)).toEqual([]);
});

test("o is inert while a reply textarea has focus", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-reply-toggle").click();
  await card.locator(".reply-box textarea").click();
  await page.keyboard.press("o");
  expect(await posted(page)).toEqual([]);
});

test("the keys hint lists o", async ({ page }) => {
  await expect(page.locator("#keys-hint")).toContainText("o open in editor");
});

test("thread list and cards carry feed / article / posinset semantics", async ({ page }) => {
  await expect(page.locator("#threads-list")).toHaveAttribute("role", "feed");
  const cards = page.locator(".thread-card");
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card).toHaveAttribute("role", "article");
    const label = await card.getAttribute("aria-label");
    expect(label).toBeTruthy();
  }
  await expect(cards.nth(0)).toHaveAttribute("aria-posinset", "1");
  await expect(cards.nth(0)).toHaveAttribute("aria-setsize", "2");
  await expect(cards.nth(1)).toHaveAttribute("aria-posinset", "2");
  await expect(cards.nth(1)).toHaveAttribute("aria-setsize", "2");
});

// It was `display: flex`, which outranks the UA `[hidden]` rule, so the empty
// bar sat at the top of every sidebar since 0.29. The fixture's threads were
// started by a person, so there is nothing for it to summarize.
test("the Claude summary bar stays hidden when no thread came from Claude", async ({ page }) => {
  await expect(page.locator("#claude-summary")).toBeHidden();
});

test("the claude-summary line and the pending row are aria-live", async ({ page }) => {
  await expect(page.locator("#claude-summary-text")).toHaveAttribute("aria-live", "polite");

  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    suggestMode: false,
    pendingThreadIds: [fixture.openThreadId],
  });
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card.locator(".mc-card__pending")).toHaveAttribute("aria-live", "polite");
});

test("roving tabindex: only the highlighted card is in the tab order, and it follows n/p", async ({ page }) => {
  const answered = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
  const open = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);

  // Nothing explicitly highlighted yet — the first card in the feed still
  // takes the roving role so Tab can reach the list at all.
  await expect(answered).toHaveAttribute("tabindex", "0");
  await expect(open).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("n");
  await expect(answered).toHaveAttribute("tabindex", "0");
  await expect(open).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("n");
  await expect(answered).toHaveAttribute("tabindex", "-1");
  await expect(open).toHaveAttribute("tabindex", "0");

  await page.keyboard.press("p");
  await expect(answered).toHaveAttribute("tabindex", "0");
  await expect(open).toHaveAttribute("tabindex", "-1");
});
