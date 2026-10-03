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
import { awaitPosted, bootLiveEditor, posted, pushToWebview } from "./harness";
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
    await expect(page.locator("#copy-prompt")).toBeHidden();
  });

  test("hidden once every thread is resolved", async ({ page }) => {
    const fixture = reviewFixture();
    const allResolved = resolveThread(resolveThread(fixture.source, fixture.answeredThreadId), fixture.openThreadId);
    await bootLiveEditor(page, { ...liveInit(allResolved), readOnly: true });
    await expect(page.locator(".mc-sidebar-footer")).toBeHidden();
    await expect(page.locator("#copy-prompt")).toBeHidden();
  });

  test("visible with the open count in the Send label otherwise", async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    await expect(page.locator(".mc-sidebar-footer")).toBeVisible();
    await expect(page.locator("#send-to-claude")).toHaveText("Send 2 comments");
    await expect(page.locator("#copy-prompt")).toBeVisible();

    // Resolving one of the two open threads drops the count to a singular label.
    const oneResolved = resolveThread(fixture.source, fixture.answeredThreadId);
    await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(oneResolved) });
    await expect(page.locator("#send-to-claude")).toHaveText("Send 1 comment");
  });
});

test.describe("send options", () => {
  test.beforeEach(async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
  });

  test("opening the menu shows suggest mode and nothing else", async ({ page }) => {
    const btn = page.locator("#send-options-btn");
    await expect(btn).toHaveAttribute("aria-haspopup", "menu");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#send-options-menu")).toBeHidden();

    await btn.click();
    await expect(page.locator("#send-options-menu")).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#send-options-menu").getByRole("menuitem")).toHaveCount(0);
    await expect(page.locator("#send-options-menu").getByRole("menuitemcheckbox")).toHaveText([
      "Ask for suggestions instead of edits",
    ]);
    await expect(page.locator("#send-options-menu #copy-prompt")).toHaveCount(0);
  });

  test("toggling suggest mode posts toggle-suggest-mode", async ({ page }) => {
    await page.locator("#send-options-btn").click();
    await page.locator("#suggest-mode-toggle").click();
    expect(await awaitPosted(page, "toggle-suggest-mode")).toEqual({ type: "toggle-suggest-mode" });
  });

  test("the footer's copy button needs no menu: labelled, visible, one click posts copy-prompt", async ({ page }) => {
    const copy = page.locator("#copy-prompt");
    await expect(copy).toBeVisible();
    await expect(copy).toHaveAttribute("aria-label", "Copy prompt");
    await expect(copy).toHaveAttribute("title", "Copy the prompt to your clipboard.");
    await expect(copy).not.toHaveAttribute("role", "menuitem");
    await expect(page.locator("#send-options-menu")).toBeHidden();
    await copy.click();
    expect(await posted(page)).toEqual([{ type: "copy-prompt" }]);
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
    await expect(page.locator("#send-to-claude")).toHaveText("Send 2 comments");

    await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(fixture.source, { suggestMode: true }) });
    await expect(page.locator("#send-to-claude")).toHaveText("Send 2 comments as suggestions");
    await expect(page.locator("#send-options-btn")).toHaveAttribute("title", "Suggest mode is on");
  });

  test("Send, the chevron and the copy button share one row and height, Send truncating rather than wrapping", async ({
    page,
  }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(fixture.source, { suggestMode: true }) });
    await expect(page.locator("#send-to-claude")).toHaveText("Send 2 comments as suggestions");

    const [send, chevron, copy, footer] = await Promise.all([
      page.locator("#send-to-claude").boundingBox(),
      page.locator("#send-options-btn").boundingBox(),
      page.locator("#copy-prompt").boundingBox(),
      page.locator(".mc-sidebar-footer").boundingBox(),
    ]);
    for (const box of [chevron!, copy!]) {
      expect(box.y).toBeCloseTo(send!.y, 0);
      expect(box.height).toBeCloseTo(send!.height, 0);
    }
    // Left to right, inside the footer, and the copy button is not squeezed out.
    expect(chevron!.x).toBeGreaterThanOrEqual(send!.x + send!.width - 1);
    expect(copy!.x).toBeGreaterThan(chevron!.x + chevron!.width);
    expect(copy!.x + copy!.width).toBeLessThanOrEqual(footer!.x + footer!.width + 1);
    expect(copy!.width).toBeGreaterThanOrEqual(24);
    // Send fills what's left: nothing but the 12px footer padding beside the copy button.
    expect(copy!.x + copy!.width).toBeGreaterThan(footer!.x + footer!.width - 16);
  });
});

test.describe("card actions (phase 2)", () => {
  test("the thread action row reads Reply, Resolve, Send, then \"…\" as the rightmost control", async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    const actions = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"] .thread-actions`);
    const [replyBox, resolveBox, sendBox, menuBox] = await Promise.all([
      actions.locator(".thread-reply-toggle").boundingBox(),
      actions.getByRole("button", { name: "Resolve", exact: true }).boundingBox(),
      actions.locator(".thread-send").boundingBox(),
      actions.locator(".thread-menu-btn").boundingBox(),
    ]);
    expect(resolveBox!.x).toBeGreaterThan(replyBox!.x);
    expect(sendBox!.x).toBeGreaterThan(resolveBox!.x);
    expect(menuBox!.x).toBeGreaterThan(sendBox!.x);
  });

  test("no class-less button anywhere in .mc-thread-sidebar with threads, a suggestion, an open composer, and an editing comment", async ({
    page,
  }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });

    // A suggestion is already in the fixture. Open a reply composer on one
    // thread and start editing a comment on the other, so every button kind
    // the card module builds is on screen at once.
    const answeredCard = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    await answeredCard.locator(".thread-reply-toggle").click();
    await expect(answeredCard.locator(".reply-box")).toHaveClass(/open/);

    const openCard = page.locator(`.thread-card[data-thread="${fixture.openThreadId}"]`);
    await openCard.getByRole("button", { name: "Edit", exact: true }).click();
    // Every thread card carries its own (normally hidden) reply composer, so
    // `.mc-composer` alone is ambiguous here — the edit-in-place composer is
    // the one that also carries `.mc-card__body` (it replaces the comment's
    // body element in place).
    await expect(openCard.locator(".mc-composer.mc-card__body")).toBeVisible();

    const classless = await page
      .locator(".mc-thread-sidebar button")
      .evaluateAll((els) => els.filter((el) => el.className.trim() === "").map((el) => el.outerHTML));
    expect(classless).toEqual([]);
  });

  test("the collapse chevron keeps aria-expanded and rotates", async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    const chevron = card.locator(".thread-collapse");
    const svgRotation = () => chevron.locator("svg").evaluate((el) => getComputedStyle(el).transform);

    await expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(await svgRotation()).toBe("none");

    await chevron.click();
    await expect(card).toHaveClass(/collapsed/);
    await expect(chevron).toHaveAttribute("aria-expanded", "false");
    // "rotates" is a CSS transform keyed off `aria-expanded`, not a swapped
    // glyph — the computed transform actually changing is what to prove.
    expect(await svgRotation()).not.toBe("none");
  });

  test("a thread card's chevron ends the head row at the card's right edge, level with the first quote line", async ({
    page,
  }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    const chevron = card.locator(".thread-collapse");
    const quote = card.locator(".thread-quote");
    const [chevronBox, quoteBox, cardBox, menuBox] = await Promise.all([
      chevron.boundingBox(),
      quote.boundingBox(),
      card.boundingBox(),
      card.locator(".thread-menu-btn").boundingBox(),
    ]);
    expect(chevronBox!.x).toBeGreaterThanOrEqual(quoteBox!.x + quoteBox!.width - 1);
    // The card has a 1px border and 12px padding: inner right edge = border box right - 13.
    expect(Math.abs(chevronBox!.x + chevronBox!.width - (cardBox!.x + cardBox!.width - 13))).toBeLessThanOrEqual(3);
    expect(Math.abs(chevronBox!.y - quoteBox!.y)).toBeLessThanOrEqual(3);
    // Same column as the "…" below it, and clear of it vertically.
    expect(chevronBox!.y + chevronBox!.height).toBeLessThanOrEqual(menuBox!.y);
    expect(
      Math.abs(chevronBox!.x + chevronBox!.width / 2 - (menuBox!.x + menuBox!.width / 2)),
    ).toBeLessThanOrEqual(1);
    // The chevron is the head row's last child, so Tab order follows the visual one.
    expect(
      await card.locator(".thread-head-row").evaluate((row) => row.lastElementChild?.classList.contains("thread-collapse")),
    ).toBe(true);
  });

  test("a collapsed thread card reads quote, comment count, chevron, with the chevron pointing left", async ({
    page,
  }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    const chevron = card.locator(".thread-collapse");
    const turn = () => chevron.locator("svg").evaluate((el) => getComputedStyle(el).transform);
    expect(await turn()).toBe("none");
    await chevron.click();
    await expect(card).toHaveClass(/collapsed/);

    const [quoteBox, countBox, chevronBox] = await Promise.all([
      card.locator(".thread-quote").boundingBox(),
      card.locator(".thread-comment-count").boundingBox(),
      chevron.boundingBox(),
    ]);
    expect(countBox!.x).toBeGreaterThanOrEqual(quoteBox!.x + quoteBox!.width - 1);
    expect(chevronBox!.x).toBeGreaterThanOrEqual(countBox!.x + countBox!.width - 1);
    // A 90° turn is matrix(0, 1, -1, 0, 0, 0); a -90° one would be matrix(0, -1, 1, 0, 0, 0).
    // The transition runs for 120ms, so wait for it to settle first.
    await expect.poll(turn).toBe("matrix(0, 1, -1, 0, 0, 0)");
  });

  test("the Reply label's left edge sits on the quote bar's left edge", async ({ page }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    const card = page.locator(`.thread-card[data-thread="${fixture.answeredThreadId}"]`);
    const quoteBox = await card.locator(".thread-quote").boundingBox();
    // The label's own ink, not the button's box: a range over its text node.
    const labelLeft = await card
      .locator(".thread-reply-toggle")
      .evaluate((btn) => {
        const range = document.createRange();
        range.selectNodeContents(btn);
        return range.getBoundingClientRect().left;
      });
    expect(Math.abs(labelLeft - quoteBox!.x)).toBeLessThanOrEqual(2);
  });

  test("a suggestion card's chevron ends its head row at the right edge, and collapsed the row reads summary, chevron", async ({
    page,
  }) => {
    const fixture = reviewFixture();
    await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
    const card = page.locator("#threads-list .mc-suggestion");
    const chevron = card.locator(".mc-suggestion__collapse");
    const [metaBox, chevronBox, cardBox] = await Promise.all([
      card.locator(".mc-card__meta").boundingBox(),
      chevron.boundingBox(),
      card.boundingBox(),
    ]);
    expect(chevronBox!.x).toBeGreaterThanOrEqual(metaBox!.x + metaBox!.width - 1);
    // 1px border + 10px padding.
    expect(Math.abs(chevronBox!.x + chevronBox!.width - (cardBox!.x + cardBox!.width - 11))).toBeLessThanOrEqual(3);
    // The meta row starts at the card's content edge, as Accept does.
    const acceptBox = await card.getByRole("button", { name: "Accept", exact: true }).boundingBox();
    expect(Math.abs(metaBox!.x - acceptBox!.x)).toBeLessThanOrEqual(2);

    await chevron.click();
    await expect(card).toHaveClass(/collapsed/);
    const summaryBox = await card.locator(".mc-suggestion__summary").boundingBox();
    const collapsedChevron = await chevron.boundingBox();
    expect(collapsedChevron!.x).toBeGreaterThanOrEqual(summaryBox!.x + summaryBox!.width - 1);
    await expect.poll(() => chevron.locator("svg").evaluate((el) => getComputedStyle(el).transform)).toBe(
      "matrix(0, 1, -1, 0, 0, 0)",
    );
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
