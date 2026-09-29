// The live editor's thread sidebar, card by card (10x-plan-6 P4, sidebar
// parity): the review view's inlineView.spec.ts, run against the live editor,
// which now renders the same sidebar (webviewShared/threadSidebar.ts). Same
// selectors, same messages — where the review view posts something, the live
// editor must post exactly that, since the review view is about to go.
//
// Booted read-only, the mode the live editor opens in once it's the only view;
// the few specs that depend on the mode say which one they use.

import { expect, test, type Page } from "@playwright/test";
import { addThread, appendReply, parse, replaceThread } from "../../inlineComments/format";
import { awaitPosted, bootLiveEditor, bootLiveEditorShell, clearPosted, posted, pushToWebview } from "./harness";
import { editAnchoredText, liveInit, liveSidecar, replyTo, reviewFixture, twoSuggestions } from "./fixtures";

const fixture = reviewFixture();

/** Push a `sidecar-changed` for `source`, as the provider does after any change. */
async function pushSidecar(page: Page, source: string, opts: Parameters<typeof liveSidecar>[1] = {}): Promise<void> {
  await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(source, opts) });
}

test.describe("with the review fixture", () => {
  test.beforeEach(async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
  });

  test("renders both threads and the pending suggestion with its word diff", async ({ page }) => {
    await expect(page.locator(".thread-card")).toHaveCount(2);
    await expect(page.locator("#threads-list .mc-suggestion")).toHaveCount(1);
    const sentence = page.locator(".mc-suggestion .mc-suggestion__sentence");
    await expect(sentence).toBeVisible();
    await expect(sentence.locator("del")).toHaveText("notes");
    await expect(sentence.locator("ins")).toHaveText("highlights");
    await expect(page.locator("#thread-count")).toHaveText("2 open · 2 total");
  });

  test("Send to Claude posts send-to-claude", async ({ page }) => {
    await page.locator("#send-to-claude").click();
    expect(await awaitPosted(page, "send-to-claude")).toEqual({ type: "send-to-claude" });
  });

  test("the suggest-mode switch posts toggle-suggest-mode and follows the host's answer", async ({ page }) => {
    const toggle = page.locator("#suggest-mode-toggle");
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(page.locator("#suggest-mode-label")).toHaveText("Suggest mode");
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    expect(await awaitPosted(page, "toggle-suggest-mode")).toEqual({ type: "toggle-suggest-mode" });
    // The setting is the host's: the switch only shows what comes back.
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await pushSidecar(page, fixture.source, { suggestMode: true });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("replying in a thread posts the reply with its thread id and body", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    const replyBox = card.locator(".reply-box");
    await expect(replyBox).toBeHidden();
    await card.locator(".thread-reply-toggle").click();
    await expect(replyBox).toBeVisible();

    const submit = replyBox.getByRole("button", { name: "Reply", exact: true });
    await expect(submit).toBeDisabled();
    await replyBox.locator("textarea").fill("The setting is markdownCollab.proposeEditsAsSuggestions.");
    await submit.click();

    expect(await awaitPosted(page, "reply")).toEqual({
      type: "reply",
      threadId: fixture.openThreadId,
      body: "The setting is markdownCollab.proposeEditsAsSuggestions.",
    });
    await expect(replyBox).toBeHidden();
  });

  test("clicking Reply toggles the composer open and closed, focusing it", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    const toggle = card.locator(".thread-reply-toggle");
    const replyBox = card.locator(".reply-box");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    await expect(replyBox).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await replyBox.locator("textarea").evaluate((el) => el === document.activeElement)).toBe(true);

    await toggle.click();
    await expect(replyBox).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("a card with an unsent draft keeps its reply box open across an update", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-reply-toggle").click();
    await card.locator(".reply-box textarea").fill("half a thought");

    await pushSidecar(page, fixture.source);
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

  test("a resolved thread's card offers Reopen", async ({ page }) => {
    const answered = parse(fixture.source).threads.find((t) => t.id === fixture.answeredThreadId)!;
    const resolvedSrc = replaceThread(fixture.source, answered.id, {
      ...answered,
      status: "resolved",
      resolvedBy: "ronica",
      resolvedTs: "2026-07-02T09:00:00.000Z",
    });
    await pushSidecar(page, resolvedSrc);
    await page.locator('input[name="filter"][value="all"]').click();
    const resolvedCard = page.locator(".thread-card.resolved");
    await expect(resolvedCard).toHaveCount(1);
    await expect(resolvedCard.locator(".thread-actions")).toContainText("Reopen");
  });

  test("the per-card \"…\" menu holds Open in editor, Send this thread, Copy prompt, and Delete", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    const menuBtn = card.locator(".thread-menu-btn");
    await expect(menuBtn).toHaveAttribute("aria-haspopup", "menu");
    await expect(menuBtn).toHaveAttribute("aria-expanded", "false");
    const menu = card.locator(".mc-menu");
    await expect(menu).toBeHidden();

    await menuBtn.click();
    await expect(menu).toBeVisible();
    await expect(menuBtn).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("menuitem")).toHaveText(["Open in editor", "Send this thread", "Copy prompt", "Delete"]);
  });

  test("Escape closes a card's menu and returns focus to its \"…\" button", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    const menuBtn = card.locator(".thread-menu-btn");
    await menuBtn.click();
    await expect(card.locator(".mc-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.locator(".mc-menu")).toBeHidden();
    expect(await menuBtn.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test("a click outside a card's open menu closes it", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-menu-btn").click();
    await expect(card.locator(".mc-menu")).toBeVisible();
    await page.locator(".milkdown p").first().click();
    await expect(card.locator(".mc-menu")).toBeHidden();
  });

  test("\"Send this thread\" and \"Copy prompt\" in the card menu post the thread-scoped messages", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-menu-btn").click();
    await card.getByRole("menuitem", { name: "Send this thread" }).click();
    expect(await awaitPosted(page, "send-to-claude-comment")).toEqual({
      type: "send-to-claude-comment",
      threadId: fixture.openThreadId,
    });
    await expect(card.locator(".mc-menu")).toBeHidden();

    await card.locator(".thread-menu-btn").click();
    await card.getByRole("menuitem", { name: "Copy prompt" }).click();
    expect(await awaitPosted(page, "copy-claude-comment")).toEqual({
      type: "copy-claude-comment",
      threadId: fixture.openThreadId,
    });
  });

  test("\"Open in editor\" in the card menu posts open-in-editor for that thread", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-menu-btn").click();
    await card.getByRole("menuitem", { name: "Open in editor" }).click();
    expect(await awaitPosted(page, "open-in-editor")).toEqual({
      type: "open-in-editor",
      threadId: fixture.openThreadId,
    });
  });

  test("deleting a thread needs a second click to confirm, inside the card menu", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-menu-btn").click();
    await card.getByRole("menuitem", { name: "Delete", exact: true }).click();
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

  test("Edit on a comment opens it in place and posts edit-comment", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".mc-card").first().getByRole("button", { name: "Edit" }).click();
    const textarea = card.locator(".mc-card").first().locator("textarea");
    await expect(textarea).toHaveValue("Which setting, exactly?");
    await textarea.fill("Which setting, and where is it documented?");
    await card.getByRole("button", { name: "Save" }).click();

    const msg = await awaitPosted(page, "edit-comment");
    expect(msg).toMatchObject({
      type: "edit-comment",
      threadId: fixture.openThreadId,
      body: "Which setting, and where is it documented?",
    });
    expect(typeof msg.commentId).toBe("string");
  });

  test("deleting one comment takes a second click and posts delete-comment with its thread", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    const reply = card.locator(".mc-card").nth(1);
    await reply.getByRole("button", { name: "Delete" }).click();
    expect(await posted(page)).toEqual([]);
    await reply.getByRole("button", { name: "Confirm" }).click();

    const msg = await awaitPosted(page, "delete-comment");
    expect(msg).toMatchObject({ type: "delete-comment", threadId: fixture.answeredThreadId });
    expect(typeof msg.commentId).toBe("string");
  });

  test("the waiting row shows the phase the host reports", async ({ page }) => {
    await pushSidecar(page, fixture.source, {
      pendingThreadIds: [fixture.openThreadId],
      pendingLabel: "Claude: reading 2 of 3 files",
    });
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await expect(card.locator(".mc-card__pending")).toContainText("Claude: reading 2 of 3 files");
    await expect(card.locator(".mc-card__pending")).not.toContainText("Claude is working");
  });

  test("a pending thread shows '<agent> is working…' and drops it when the reply lands", async ({ page }) => {
    await pushSidecar(page, fixture.source, { pendingThreadIds: [fixture.openThreadId] });
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await expect(card).toHaveClass(/awaiting-claude/);
    await expect(card.locator(".mc-card__pending")).toContainText("Claude is working");
    await expect(card.locator(".mc-card__pending")).toHaveAttribute("aria-live", "polite");

    await clearPosted(page);
    await pushSidecar(page, fixture.source);
    await expect(card.locator(".mc-card__pending")).toHaveCount(0);
  });

  test("a thread whose passage was rewritten shows 'text changed', and a reply clears it", async ({ page }) => {
    const stale = editAnchoredText(fixture.source, fixture.openThreadId, "behind a different setting");
    await pushSidecar(page, stale);
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await expect(card.locator(".badge.stale")).toHaveText("text changed");
    await expect(page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .badge.stale`)).toHaveCount(0);

    await pushSidecar(page, replyTo(stale, fixture.openThreadId, "Noted — the new wording is fine."));
    await expect(card.locator(".badge.stale")).toHaveCount(0);
  });

  test("Accept all needs a second click, and only appears for more than one suggestion", async ({ page }) => {
    await expect(page.locator(".accept-all-row")).toHaveCount(0);
    await pushSidecar(page, twoSuggestions(fixture.source));
    const button = page.locator(".accept-all-row button");
    await expect(button).toHaveText("Accept all 2");

    await button.click();
    expect(await posted(page)).toEqual([]);
    await expect(button).toHaveText(/Click again/);
    await button.click();
    expect(await awaitPosted(page, "accept-all-suggestions")).toEqual({ type: "accept-all-suggestions" });
  });

  test("collapsing a card folds it to its quote, and the chevron unfolds it", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    await card.locator(".thread-collapse").click();
    await expect(card).toHaveClass(/collapsed/);
    await expect(card.locator(".thread-actions")).toBeHidden();
    await card.locator(".thread-collapse").click();
    await expect(card).not.toHaveClass(/collapsed/);
  });

  test("clicking a card makes it current and pulses its highlight in the document", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-quote").click();
    await expect(card).toHaveClass(/highlighted/);
    await expect(
      page.locator(`.mdc-anchor-highlight[data-comment-id="${fixture.openThreadId}"]`).first(),
    ).toHaveClass(/mdc-anchor-highlight--pulse/);
  });

  test("clicking a highlight in the document makes its card the current one", async ({ page }) => {
    await page.locator(`.mdc-anchor-highlight[data-comment-id="${fixture.openThreadId}"]`).first().click();
    await expect(page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`)).toHaveClass(/highlighted/);
    await expect(page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`)).not.toHaveClass(/highlighted/);
  });

  // The host opens the review view on a thread (a hover link, a tree row, the
  // unread walk) and posts `reveal-thread` (10x-plan-6 P4, the switch).
  test("reveal-thread from the host makes the card current and pulses its highlight", async ({ page }) => {
    await pushToWebview(page, { type: "reveal-thread", threadId: fixture.openThreadId });
    await expect(page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`)).toHaveClass(/highlighted/);
    await expect(
      page.locator(`.mdc-anchor-highlight[data-comment-id="${fixture.openThreadId}"]`).first(),
    ).toHaveClass(/mdc-anchor-highlight--pulse/);
  });

  test("reveal-thread widens the filter when it hides the thread", async ({ page }) => {
    const answered = parse(fixture.source).threads.find((t) => t.id === fixture.answeredThreadId)!;
    const resolvedSrc = replaceThread(fixture.source, answered.id, {
      ...answered,
      status: "resolved",
      resolvedBy: "ronica",
      resolvedTs: "2026-07-02T09:00:00.000Z",
    });
    await pushSidecar(page, resolvedSrc);
    await expect(page.locator(`.thread-card[data-thread="${answered.id}"]`)).toHaveCount(0);
    await pushToWebview(page, { type: "reveal-thread", threadId: answered.id });
    await expect(page.locator('input[name="filter"][value="all"]')).toBeChecked();
    await expect(page.locator(`.thread-card[data-thread="${answered.id}"]`)).toHaveClass(/highlighted/);
  });

  // --- n/p/r/e/o ---------------------------------------------------------------

  test("n moves the highlight to the next thread card, p to the previous, wrapping at both ends", async ({ page }) => {
    const answered = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    const open = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await expect(page.locator(".thread-card.highlighted")).toHaveCount(0);

    await page.keyboard.press("n");
    await expect(answered).toHaveClass(/highlighted/);
    await page.keyboard.press("n");
    await expect(open).toHaveClass(/highlighted/);
    await expect(answered).not.toHaveClass(/highlighted/);
    await page.keyboard.press("n");
    await expect(answered).toHaveClass(/highlighted/);
    await page.keyboard.press("p");
    await expect(open).toHaveClass(/highlighted/);
  });

  test("r focuses the highlighted thread's reply textarea, expanding a collapsed card first", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    await card.locator(".thread-collapse").click();
    await expect(card).toHaveClass(/collapsed/);
    await page.keyboard.press("n");
    await expect(card).toHaveClass(/highlighted/);

    await page.keyboard.press("r");
    await expect(card).not.toHaveClass(/collapsed/);
    expect(await card.locator(".reply-box textarea").evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test("r and o are no-ops when nothing is highlighted", async ({ page }) => {
    await page.keyboard.press("r");
    expect(await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement)).toBe(false);
    await page.keyboard.press("o");
    expect(await posted(page)).toEqual([]);
  });

  test("e posts toggle-resolve for the highlighted thread — the same message Resolve posts", async ({ page }) => {
    await page.keyboard.press("n");
    await page.keyboard.press("e");
    expect(await awaitPosted(page, "toggle-resolve")).toEqual({
      type: "toggle-resolve",
      threadId: fixture.answeredThreadId,
    });
  });

  test("o opens the highlighted thread in the editor", async ({ page }) => {
    await page.keyboard.press("n");
    await page.keyboard.press("o");
    expect(await awaitPosted(page, "open-in-editor")).toEqual({
      type: "open-in-editor",
      threadId: fixture.answeredThreadId,
    });
  });

  test("n/p/r/e/o are inert while a reply textarea has focus", async ({ page }) => {
    const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await card.locator(".thread-reply-toggle").click();
    await card.locator(".reply-box textarea").click();
    for (const key of ["n", "p", "e", "o", "r"]) await page.keyboard.press(key);
    await expect(page.locator(".thread-card.highlighted")).toHaveCount(0);
    expect(await posted(page)).toEqual([]);
  });

  test("the keys hint lists every key", async ({ page }) => {
    await expect(page.locator("#keys-hint")).toHaveText(
      "n / p to move between threads · r reply · e resolve · o open in editor",
    );
  });

  // --- a11y ------------------------------------------------------------------------

  test("thread list and cards carry feed / article / posinset semantics", async ({ page }) => {
    await expect(page.locator("#threads-list")).toHaveAttribute("role", "feed");
    const cards = page.locator(".thread-card");
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) {
      await expect(card).toHaveAttribute("role", "article");
      expect(await card.getAttribute("aria-label")).toBeTruthy();
    }
    await expect(cards.nth(0)).toHaveAttribute("aria-posinset", "1");
    await expect(cards.nth(1)).toHaveAttribute("aria-setsize", "2");
  });

  test("roving tabindex: only the highlighted card is in the tab order, and it follows n/p", async ({ page }) => {
    const answered = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    const open = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await expect(answered).toHaveAttribute("tabindex", "0");
    await expect(open).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("n");
    await page.keyboard.press("n");
    await expect(answered).toHaveAttribute("tabindex", "-1");
    await expect(open).toHaveAttribute("tabindex", "0");
  });

  test("the unread banner stays hidden when no thread came from an agent", async ({ page }) => {
    await expect(page.locator("#claude-summary")).toBeHidden();
    await expect(page.locator("#filter-claude-label")).toBeHidden();
  });
});

// --- Specs that need their own document ------------------------------------------

test("a thread an agent opened shows the unread banner, the 'New from' filter, and Next lands on it", async ({ page }) => {
  const at = fixture.source.indexOf("Suggest mode");
  const opened = addThread(fixture.source, at, at + "Suggest mode".length, {
    author: "claude",
    body: "Say what the setting is called.",
    ts: "2026-07-02T10:00:00.000Z",
  });
  await bootLiveEditor(page, { ...liveInit(opened.source), readOnly: true });

  await expect(page.locator("#claude-summary")).toBeVisible();
  await expect(page.locator("#claude-summary-text")).toHaveText("1 new from Claude · 0 reviewed");
  await expect(page.locator("#claude-summary-text")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#filter-claude-label-text")).toHaveText("New from Claude");
  const card = page.locator(`.thread-card[data-thread="${opened.thread.id}"]`);
  await expect(card).toHaveClass(/claude-unread/);

  await page.locator("#claude-next").click();
  await expect(card).toHaveClass(/highlighted/);

  await page.locator('input[name="filter"][value="claude-unread"]').click();
  await expect(page.locator(".thread-card")).toHaveCount(1);
});

test("an agent's comments carry the via marker; a human's don't", async ({ page }) => {
  const at = fixture.source.indexOf("Suggest mode");
  const first = addThread(fixture.source, at, at + "Suggest mode".length, {
    author: "ronica",
    body: "Name it.",
    ts: "2026-07-02T10:00:00.000Z",
  });
  const withReply = replaceThread(
    first.source,
    first.thread.id,
    appendReply(first.thread, { author: "claude", body: "Done.", ts: "2026-07-02T10:05:00.000Z", agent: true, via: "tools" }),
  );
  await bootLiveEditor(page, { ...liveInit(withReply), readOnly: true });
  const cards = page.locator(`.thread-card[data-thread="${first.thread.id}"] .mc-card`);
  await expect(cards.nth(0).locator(".mc-card__via")).toHaveCount(0);
  await expect(cards.nth(1).locator(".mc-card__via")).toHaveText("via tools");
});

test("a thread without markers is marked 'broken anchor' and has no highlight in the document", async ({ page }) => {
  // Deleting the anchored passage with its markers orphans the thread — the
  // outcome the skill asks agents to leave alone. Read-only placement never
  // guesses from the quote, so the card has to say there's nothing to show.
  const at = fixture.source.indexOf("<!--mc:a:" + fixture.openThreadId);
  const close = `<!--mc:/a:${fixture.openThreadId}-->`;
  const end = fixture.source.indexOf(close) + close.length;
  const orphaned = fixture.source.slice(0, at) + fixture.source.slice(end);
  await bootLiveEditor(page, { ...liveInit(orphaned), readOnly: true });

  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card).toHaveClass(/unanchored/);
  await expect(card.locator(".badge.broken")).toHaveText("broken anchor");
  await expect(card.locator(".badge.broken")).toHaveAttribute("title", /no highlight in the document/);
  await expect(page.locator(`.mdc-anchor-highlight[data-comment-id="${fixture.openThreadId}"]`)).toHaveCount(0);
  // The anchored thread is unaffected.
  await expect(page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .badge.broken`)).toHaveCount(0);
});

test("in edit mode, n typed into the document is text, not navigation", async ({ page }) => {
  await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: false });
  await page.locator(".milkdown p").first().click();
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest(".milkdown")))
    .toBe(true);
  await page.keyboard.press("n");
  await expect(page.locator(".thread-card.highlighted")).toHaveCount(0);
});

test("a reveal-thread right behind init waits for the editor, then lands on the thread", async ({ page }) => {
  // The host posts both back to back when it opens a panel on a thread; the
  // editor is still building when the reveal arrives.
  await bootLiveEditorShell(page);
  await pushToWebview(page, { type: "init", ...liveInit(fixture.source), readOnly: true });
  await pushToWebview(page, { type: "reveal-thread", threadId: fixture.openThreadId });
  await expect(page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`)).toHaveClass(/highlighted/);
  await expect(
    page.locator(`.mdc-anchor-highlight[data-comment-id="${fixture.openThreadId}"]`).first(),
  ).toHaveClass(/mdc-anchor-highlight--pulse/);
});
