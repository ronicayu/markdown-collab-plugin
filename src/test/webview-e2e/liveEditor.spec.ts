// Click-level coverage for the live (Milkdown) editor webview — 10x-plan-2 P2.1.
//
// Milkdown wouldn't boot under the earlier JSDOM-ish harness, so this surface
// was only ever "verified by construction": its logic had unit tests, its
// clicks had none. Real Chromium runs it, so these specs observe the actual
// ProseMirror editor and the actual messages its buttons post.

import { expect, test } from "@playwright/test";
import { awaitPosted, bootLiveEditor, posted, pushToWebview } from "./harness";
import { editAnchoredText, liveInit, liveProse, liveSidecar, replyTo, reviewFixture } from "./fixtures";

const fixture = reviewFixture();

test.beforeEach(async ({ page }) => {
  await bootLiveEditor(page, liveInit(fixture.source));
});

test("Milkdown renders the prose with the markers stripped", async ({ page }) => {
  const editor = page.locator(".mdc-editor-root .milkdown");
  await expect(editor.locator("h1")).toHaveText("Release notes");
  await expect(editor).toContainText("The parser handles nested lists correctly.");
  // Anchor markers are invisible in the source, and must not leak into the doc.
  await expect(editor).not.toContainText("mc:a:");
});

test("both threads render in the sidebar with their quotes", async ({ page }) => {
  await expect(page.locator(".thread-card")).toHaveCount(2);
  await expect(
    page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .thread-quote`),
  ).toHaveText("nested lists");
  await expect(
    page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`),
  ).toContainText("ordered and bullet lists share the tokenizer");
});

test("Accept on a suggestion posts accept-suggestion for that anchor", async ({ page }) => {
  const card = page.locator("#threads-list .mc-suggestion");
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "Accept" }).click();
  expect(await awaitPosted(page, "accept-suggestion")).toEqual({
    type: "accept-suggestion",
    anchorId: fixture.suggestionId,
  });
});

test("Reject on a suggestion posts reject-suggestion for that anchor", async ({ page }) => {
  await page.locator("#threads-list .mc-suggestion").getByRole("button", { name: "Reject" }).click();
  expect(await awaitPosted(page, "reject-suggestion")).toEqual({
    type: "reject-suggestion",
    anchorId: fixture.suggestionId,
  });
});

test("the suggestion's anchored text is highlighted in the document, like a thread's is", async ({ page }) => {
  // reviewFixture() anchors its one suggestion at the "Release notes" heading.
  const mark = page.locator(".mdc-anchor-highlight--suggestion");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveText("Release notes");
  // A distinct class from a comment thread's highlight, not a variant of it —
  // the two decoration sets are independent plugins (suggestionHighlightPlugin.ts),
  // and both thread highlights are still there, unaffected.
  await expect(page.locator(".mdc-anchor-highlight")).toHaveCount(2);
});

test("selecting text and adding a comment posts add-comment with the selected anchor", async ({ page }) => {
  // Select "Suggest" from the third paragraph by keyboard — deterministic where
  // a double-click depends on where the word happens to sit. The floating
  // affordance only appears for a non-empty ProseMirror selection, so its
  // visibility is itself the assertion that the selection registered.
  const para = page.locator(".milkdown p", { hasText: "Suggest mode ships" });
  await para.click({ position: { x: 4, y: 8 } });
  // ProseMirror takes focus asynchronously; typing before it lands sends the
  // keys to the document and selects nothing.
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest(".milkdown")))
    .toBe(true);
  await page.keyboard.press("Home");
  for (let i = 0; i < "Suggest".length; i++) await page.keyboard.press("Shift+ArrowRight");

  const addBtn = page.locator(".mdc-add-comment-btn");
  await expect(addBtn).toBeVisible();
  await addBtn.click();

  const composer = page.locator(".mdc-composer-slot .mc-composer");
  await expect(composer).toBeVisible();
  await expect(composer.locator(".mc-composer__meta")).toContainText("Commenting on: Suggest");
  await composer.locator("textarea").fill("Name the setting here.");
  await composer.getByRole("button", { name: "Save" }).click();

  const msg = await awaitPosted(page, "add-comment");
  expect(msg.body).toBe("Name the setting here.");
  expect(msg.author).toBe("ronica");
  const anchor = msg.anchor as { text: string; contextBefore: string; contextAfter: string };
  expect(anchor.text).toBe("Suggest");
  expect(anchor.contextAfter).toContain(" mode ships");
  // The host places the marker at these offsets in `fullMd` instead of
  // re-finding the text, so an off-by-one here anchors the wrong span.
  const fullMd = msg.fullMd as string;
  expect(fullMd.slice(msg.selStart as number, msg.selEnd as number)).toBe("Suggest");
});

test("Resolve and \"Send this thread\" post the thread-scoped messages", async ({ page }) => {
  // The review view's messages (10x-plan-6 P4): the sidebar is shared now.
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-actions").getByRole("button", { name: "Resolve", exact: true }).click();
  expect(await awaitPosted(page, "toggle-resolve")).toEqual({
    type: "toggle-resolve",
    threadId: fixture.openThreadId,
  });

  await card.locator(".thread-menu-btn").click();
  await card.getByRole("menuitem", { name: "Send this thread" }).click();
  expect(await awaitPosted(page, "send-to-claude-comment")).toEqual({
    type: "send-to-claude-comment",
    threadId: fixture.openThreadId,
  });
});

test("deleting a thread needs a second click to confirm", async ({ page }) => {
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await card.locator(".thread-menu-btn").click();
  await card.getByRole("menuitem", { name: "Delete", exact: true }).click();
  expect(await posted(page)).toEqual([]);

  await card.getByRole("menuitem", { name: "Confirm delete" }).click();
  expect(await awaitPosted(page, "delete-thread")).toEqual({
    type: "delete-thread",
    threadId: fixture.openThreadId,
  });
});

test("a pending thread shows 'Claude is working…' until the sidecar update clears it", async ({ page }) => {
  await pushToWebview(page, {
    type: "sidecar-changed",
    ...liveSidecar(fixture.source, { pendingThreadIds: [fixture.openThreadId] }),
  });
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card).toHaveClass(/awaiting-claude/);
  await expect(card.locator(".mc-card__pending")).toContainText("Claude is working");

  await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(fixture.source) });
  await expect(card.locator(".mc-card__pending")).toHaveCount(0);
});

test("the waiting row follows the phase Claude reports", async ({ page }) => {
  // 10x-plan-2 P0.2. A phase update changes nothing else about the thread — so
  // this is also the regression test for the repaint.
  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await pushToWebview(page, {
    type: "sidecar-changed",
    ...liveSidecar(fixture.source, { pendingThreadIds: [fixture.openThreadId] }),
    pendingLabel: "Claude: reading 2 of 3 files",
  });
  await expect(card.locator(".mc-card__pending")).toContainText("Claude: reading 2 of 3 files");

  await pushToWebview(page, {
    type: "sidecar-changed",
    ...liveSidecar(fixture.source, { pendingThreadIds: [fixture.openThreadId] }),
    pendingLabel: "Claude: opening threads",
  });
  await expect(card.locator(".mc-card__pending")).toContainText("Claude: opening threads");
});

test("an external (Claude) change lands in the editor without echoing back an edit", async ({ page }) => {
  const nextProse = liveProse(fixture.source).replace(
    "Suggest mode ships behind a setting.",
    "Suggest mode ships behind a setting, off by default.",
  );

  await pushToWebview(page, {
    type: "externalChange",
    text: nextProse,
    changed: { start: 0, end: 0, text: "off by default", heading: "Release notes" },
  });

  await expect(page.locator(".milkdown")).toContainText("off by default");
  await expect(page.locator(".mdc-banner")).toContainText("Claude edited §Release notes");
  // Applying a disk-side change must not echo back as a human edit — that round
  // trip is how an external write gets overwritten by the editor's own state.
  // Waited out past the 250ms edit debounce, so a late post would be caught.
  await page.waitForTimeout(500);
  expect((await posted(page)).filter((m) => m.type === "edit" || m.type === "edit-blocks")).toEqual([]);
});

test("a thread whose passage was rewritten shows a 'text changed' badge", async ({ page }) => {
  const stale = editAnchoredText(fixture.source, fixture.openThreadId, "behind a different setting");
  await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(stale) });

  const card = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
  await expect(card.locator(".badge.stale")).toHaveText("text changed");
  await expect(
    page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .badge.stale`),
  ).toHaveCount(0);

  // Replying resets the baseline: the replier read the passage as it now reads.
  await pushToWebview(page, {
    type: "sidecar-changed",
    ...liveSidecar(replyTo(stale, fixture.openThreadId, "Fine as rewritten.")),
  });
  await expect(card.locator(".badge.stale")).toHaveCount(0);
});
