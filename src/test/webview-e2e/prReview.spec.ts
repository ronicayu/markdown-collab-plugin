// PR review webview — same chrome language as the live editor's comment
// sidebar (docs/pr-review-redesign.md): `#drafts-pane` reuses
// threadSidebar.css / controls.css / comments.css's ids and class names, so
// most of what this file drives (the header, the filter tabs, the "…" menu,
// the card shell) is the shared sidebar under test elsewhere
// (liveSidebar*.spec.ts) — this file covers what's specific to the PR view:
// drafts pinned above threads, the existing-comment filter's own defaults and
// counts, the quote/jump button, Reply/Resolve/pr-open on a thread, and the
// verdict/summary/submit footer.
//
// Boots the shipped bundle (`out/pr/webview/client.js`) against the exact DOM
// skeleton the panel serves (`prReviewShell.ts`, imported directly rather than
// copy-pasted, so a rename there can't silently drift out of sync with this
// spec) — same approach as harness.ts's bootInlineView/bootLiveEditor, kept
// local to this file since prReviewPanel.ts isn't something a webview test
// can import (it pulls in `vscode`).

import * as path from "path";
import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, clearPosted, pushToWebview, REPO_ROOT } from "./harness";
import { prReviewAppBody } from "../../pr/prReviewShell";

const outFile = (...parts: string[]): string => path.join(REPO_ROOT, "out", ...parts);

/**
 * `acquireVsCodeApi` stand-in, plus a `window.open` stub so a click on
 * `.pr-open` (or an in-body link) can be asserted without actually opening a
 * tab. `state` seeds `getState()` — what a reload / a corrupted profile could
 * plausibly hand back — so a spec can boot straight into a saved filter or a
 * malformed blob without a second round trip through `setState`.
 */
function vscodeApiStub(state: unknown): string {
  return `
window.__mcPosted = [];
window.__mcOpened = [];
window.__mcState = ${JSON.stringify(state)};
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (msg) { window.__mcPosted.push(msg); },
    setState: function (s) { window.__mcState = s; },
    getState: function () { return window.__mcState; },
  };
};
window.open = function (url) { window.__mcOpened.push(url); return null; };
`;
}

async function bootPrReviewShell(page: Page, opts: { state?: unknown } = {}): Promise<void> {
  page.on("pageerror", (err) => {
    throw new Error(`uncaught error in webview: ${err.message}`);
  });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${prReviewAppBody()}</body></html>`,
  );
  await page.addStyleTag({ path: outFile("pr", "webview", "comments-shared.css") });
  await page.addStyleTag({ path: outFile("pr", "webview", "client.css") });
  // Order matters: the stub must exist before the bundle's top-level
  // `acquireVsCodeApi()` call runs.
  await page.addScriptTag({ content: vscodeApiStub(opts.state) });
  await page.addScriptTag({ path: outFile("pr", "webview", "client.js") });
  await awaitPosted(page, "ready");
  await clearPosted(page);
}

function baseInit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "init",
    fileName: "docs/a.md",
    source: "# Title\n\nSome body text about the change.\n\nMore text here.\n",
    addedRanges: [{ start: 1, end: 4 }],
    drafts: [],
    totalDraftCount: 0,
    imageBaseUris: { docDir: "https://example.invalid/doc/", workspaceFolder: null },
    ...overrides,
  };
}

/** Boot the shell and push an `init`. Resolves once the preview has rendered. */
async function bootPrReview(
  page: Page,
  overrides: Record<string, unknown> = {},
  opts: { state?: unknown } = {},
): Promise<void> {
  await bootPrReviewShell(page, opts);
  await pushToWebview(page, baseInit(overrides));
  await expect(page.locator("#preview")).not.toBeEmpty();
}

function githubComment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    threadId: "1",
    author: "alice",
    body: "Please rewrite this paragraph for clarity.",
    path: "docs/a.md",
    line: 3,
    side: "RIGHT",
    createdAt: "2026-07-01T00:00:00Z",
    url: "https://github.com/o/r/pull/7#discussion_r1",
    resolved: false,
    resolvable: true,
    resolveId: "PRRT_thread1",
    ...over,
  };
}

const draft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "d1",
  path: "docs/a.md",
  body: "nit: typo here",
  line: 3,
  side: "RIGHT",
  createdAt: "2026-07-01T00:00:00Z",
  ...over,
});

async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __mcOpened: string[] }).__mcOpened);
}

/** Select some preview text so `#floating-add` / `#add-comment-btn` have a target. */
async function selectPreviewText(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const preview = document.getElementById("preview")!;
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const idx = t.data.indexOf(text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(t, idx);
      range.setEnd(t, idx + text.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    throw new Error(`text not found in preview: ${text}`);
  }, needle);
}

// --- collapse / expand, Resolve / Unresolve (migrated) ----------------------

test("an unresolved resolvable thread starts expanded, with a Resolve button", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator("#existing-list .thread-card").first();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator(".thread-collapse")).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
});

test("a resolved thread starts collapsed, with an Unresolve button and the resolved badge", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ resolved: true })],
  });
  // A resolved thread is behind its own tab now (decision 2) — Open is the default.
  await page.locator('input[name="existing-filter"][value="all"]').click();
  const card = page.locator("#existing-list .thread-card").first();
  await expect(card).toHaveClass(/collapsed/);
  await expect(card.locator(".thread-collapse")).toHaveAttribute("aria-expanded", "false");
  // The badge lives in the header, so it's visible even collapsed; the
  // action row (Unresolve) is not — collapsed hides everything but the head,
  // the same as the live sidebar.
  await expect(card.locator(".mc-badge--resolved")).toBeVisible();
  await expect(card.locator(".mc-badge--resolved")).toHaveText("resolved");
  await card.locator(".thread-collapse").click();
  await expect(card.getByRole("button", { name: "Unresolve" })).toBeVisible();
});

test("the chevron collapses and expands; clicking elsewhere on a collapsed head also expands it", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator("#existing-list .thread-card").first();
  const chevron = card.locator(".thread-collapse");
  await expect(card).not.toHaveClass(/collapsed/);
  await chevron.click();
  await expect(card).toHaveClass(/collapsed/);
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  // Collapsed, a click anywhere on the head expands it — not just the
  // chevron (live sidebar behaviour, threadSidebar.ts).
  await card.locator(".pr-line").click();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
});

test("Enter and Space on the chevron toggle collapse", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator("#existing-list .thread-card").first();
  const chevron = card.locator(".thread-collapse");
  await chevron.focus();
  await chevron.press("Enter");
  await expect(card).toHaveClass(/collapsed/);
  await chevron.press(" ");
  await expect(card).not.toHaveClass(/collapsed/);
});

test("the Resolve button posts resolve-thread and only collapses once the host confirms", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator("#existing-list .thread-card").first();
  const resolveBtn = card.getByRole("button", { name: "Resolve", exact: true });
  await resolveBtn.click();

  const msg = await awaitPosted(page, "resolve-thread");
  expect(msg).toEqual({ type: "resolve-thread", resolveId: "PRRT_thread1", resolved: true });
  // Busy immediately (the "optimistic" part is the button, not the data) —
  // but not yet collapsed, because the host hasn't confirmed anything yet.
  await expect(page.getByRole("button", { name: "Resolving…" })).toBeVisible();
  await expect(card).not.toHaveClass(/collapsed/);

  await clearPosted(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ resolved: true })],
  });
  // Now resolved, it's behind the "all" / "resolved" tab (decision 2) — the
  // default "open" filter would hide it.
  await page.locator('input[name="existing-filter"][value="all"]').click();
  const confirmedCard = page.locator("#existing-list .thread-card").first();
  await expect(confirmedCard).toHaveClass(/collapsed/);
  await confirmedCard.locator(".thread-collapse").click();
  await expect(confirmedCard.getByRole("button", { name: "Unresolve" })).toBeVisible();
});

test("the Unresolve button posts resolve-thread:false and expands once confirmed", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ resolved: true })],
  });
  await page.locator('input[name="existing-filter"][value="all"]').click();
  const card = page.locator("#existing-list .thread-card").first();
  // Resolved threads start collapsed, which hides the action row — expand first.
  await card.locator(".thread-collapse").click();
  await card.getByRole("button", { name: "Unresolve" }).click();
  const msg = await awaitPosted(page, "resolve-thread");
  expect(msg).toEqual({ type: "resolve-thread", resolveId: "PRRT_thread1", resolved: false });

  await clearPosted(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ resolved: false })],
  });
  const confirmedCard = page.locator("#existing-list .thread-card").first();
  await expect(confirmedCard).not.toHaveClass(/collapsed/);
  await expect(confirmedCard.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
});

test("a resolve-thread-error re-enables the button with the platform's message", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator("#existing-list .thread-card").first();
  await card.getByRole("button", { name: "Resolve", exact: true }).click();
  await awaitPosted(page, "resolve-thread");
  await pushToWebview(page, {
    type: "resolve-thread-error",
    resolveId: "PRRT_thread1",
    error: "gh api graphql resolveReviewThread failed: FORBIDDEN",
  });
  const resolveBtn = card.getByRole("button", { name: "Resolve", exact: true });
  await expect(resolveBtn).toBeEnabled();
  await expect(resolveBtn).toHaveAttribute("title", /FORBIDDEN/);
  // Never collapsed — the failure path never touched the data.
  await expect(card).not.toHaveClass(/collapsed/);
});

test("a non-resolvable note is collapsible but offers no Resolve button", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({
      id: "9", threadId: "9", resolvable: false, resolveId: undefined, author: "carol", body: "just an FYI",
    })],
  });
  const card = page.locator("#existing-list .thread-card").first();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.getByRole("button", { name: /Resolve/ })).toHaveCount(0);
  // "author: gist" aria-label, as the live sidebar does.
  await expect(card).toHaveAttribute("aria-label", "carol: just an FYI");
  await card.locator(".thread-collapse").click();
  await expect(card).toHaveClass(/collapsed/);
  // "N comments" is visible collapsed, as in the live sidebar.
  await expect(card.locator(".thread-comment-count")).toHaveText("1 comment");
});

test("a draft card is collapsible, starts expanded, carries the draft badge, and its data-draft-id survives collapse", async ({ page }) => {
  await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
  const card = page.locator("#drafts-list .thread-card").first();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card).toHaveClass(/pr-draft/);
  const chevron = card.locator(".thread-collapse");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".mc-badge--draft")).toHaveText("draft");
  await expect(card.getByText("You", { exact: true })).toBeVisible();

  await chevron.click();
  await expect(card).toHaveClass(/collapsed/);
  await expect(card.locator(".thread-comment-count")).toHaveText("1 comment");
  // Still reachable: Edit/Delete live in the (now hidden) body, but the
  // card's own dataset id — used to flash it from a preview marker — is
  // unaffected by collapse.
  await expect(card).toHaveAttribute("data-draft-id", "d1");
});

test("Collapse all / Expand all, in the \"…\" menu, operates on every card — drafts and existing threads together", async ({ page }) => {
  await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", resolved: true })],
  });
  // "All" so the resolved thread (behind its own tab by default) is on screen too.
  await page.locator('input[name="existing-filter"][value="all"]').click();
  await page.locator("#overflow-menu-btn").click();
  const collapseAll = page.locator("#collapse-all-btn");
  await expect(collapseAll).toBeVisible();
  await expect(collapseAll).toBeEnabled();
  // One thread starts resolved (collapsed) and the rest expanded, so the
  // item's first label is "Collapse all" (something is still expanded).
  await expect(collapseAll).toHaveText("Collapse all");

  await collapseAll.click();
  const cards = page.locator("#drafts-list .thread-card, #existing-list .thread-card");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) await expect(card).toHaveClass(/collapsed/);

  await page.locator("#overflow-menu-btn").click();
  await expect(page.locator("#collapse-all-btn")).toHaveText("Expand all");
  await page.locator("#collapse-all-btn").click();
  for (const card of await cards.all()) await expect(card).not.toHaveClass(/collapsed/);
});

test("a manual toggle survives an unrelated existing-comments refresh", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", body: "second thread" })],
  });
  const first = page.locator("#existing-list .thread-card").first();
  await first.locator(".thread-collapse").click();
  await expect(first).toHaveClass(/collapsed/);

  // A refresh that doesn't touch either thread's resolved state (e.g. a
  // reply landed on the other thread) must leave the manual toggle alone.
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [
      githubComment({ id: "1", threadId: "1" }),
      githubComment({ id: "2", threadId: "2", body: "second thread" }),
      githubComment({ id: "3", threadId: "2", body: "a reply", author: "dave" }),
    ],
  });
  await expect(page.locator("#existing-list .thread-card").first()).toHaveClass(/collapsed/);
});

test("malformed persisted state doesn't break rendering, and collapse still works", async ({ page }) => {
  await bootPrReviewShell(page, {
    state: { collapsedCardIds: "not-an-array", existingFilter: 42, someFutureField: { nested: true } },
  });
  await pushToWebview(page, baseInit());
  await expect(page.locator("#preview")).not.toBeEmpty();

  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator("#existing-list .thread-card").first();
  // Falls back to the default (expanded, unresolved thread) rather than
  // reflecting the malformed `collapsedCardIds` / `existingFilter` values.
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator(".thread-collapse")).toHaveAttribute("aria-expanded", "true");

  // And collapse still works from here — the malformed seed didn't leave
  // the toggle machinery in a broken state.
  await card.locator(".thread-collapse").click();
  await expect(card).toHaveClass(/collapsed/);
  await card.locator(".thread-collapse").click();
  await expect(card).not.toHaveClass(/collapsed/);
});

// --- pr-open (new) -----------------------------------------------------------

test("a thread with three comments renders exactly one .pr-open, no button inside any comment card, and clicking it opens the head comment's URL", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [
      githubComment({ id: "1", threadId: "1", author: "alice", createdAt: "2026-07-01T00:00:00Z" }),
      githubComment({ id: "2", threadId: "1", author: "bob", createdAt: "2026-07-01T00:05:00Z", body: "reply one" }),
      githubComment({ id: "3", threadId: "1", author: "carol", createdAt: "2026-07-01T00:10:00Z", body: "reply two" }),
    ],
  });
  const card = page.locator("#existing-list .thread-card").first();
  await expect(card.locator(".pr-open")).toHaveCount(1);
  await expect(card.locator(".mc-card button")).toHaveCount(0);

  await card.locator(".pr-open").click();
  expect(await openedUrls(page)).toEqual(["https://github.com/o/r/pull/7#discussion_r1"]);
});

// --- tabs (new) ---------------------------------------------------------------

test.describe("existing-comment tabs", () => {
  test("default to Open with no saved state", async ({ page }) => {
    await bootPrReview(page);
    await pushToWebview(page, {
      type: "existing-comments",
      comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", resolved: true })],
    });
    await expect(page.locator('input[name="existing-filter"][value="open"]')).toBeChecked();
    await expect(page.locator("#existing-list .thread-card")).toHaveCount(1);
  });

  test("counts reflect existing threads only, not drafts", async ({ page }) => {
    await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
    await pushToWebview(page, {
      type: "existing-comments",
      comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", resolved: true })],
    });
    await expect(page.locator("#existing-filter-count-open")).toHaveText("1");
    await expect(page.locator("#existing-filter-count-all")).toHaveText("2");
    await expect(page.locator("#existing-filter-count-resolved")).toHaveText("1");
  });

  test("a saved existingFilter is honoured", async ({ page }) => {
    await bootPrReview(page, {}, { state: { existingFilter: "resolved" } });
    await pushToWebview(page, {
      type: "existing-comments",
      comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", resolved: true })],
    });
    await expect(page.locator('input[name="existing-filter"][value="resolved"]')).toBeChecked();
    const cards = page.locator("#existing-list .thread-card");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveClass(/resolved/);
  });

  test("the row is hidden with no existing threads", async ({ page }) => {
    await bootPrReview(page);
    await pushToWebview(page, { type: "existing-comments", comments: [] });
    await expect(page.locator("#existing-filter")).toBeHidden();
  });

  test("radios move with arrow keys", async ({ page }) => {
    await bootPrReview(page);
    await pushToWebview(page, {
      type: "existing-comments",
      comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", resolved: true })],
    });
    await page.locator('input[name="existing-filter"][value="open"]').focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('input[name="existing-filter"][value="all"]')).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('input[name="existing-filter"][value="resolved"]')).toBeChecked();
  });

  test("a draft stays above the threads on every tab", async ({ page }) => {
    await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
    await pushToWebview(page, {
      type: "existing-comments",
      comments: [githubComment({ id: "1", threadId: "1", resolved: true })],
    });
    await page.locator('input[name="existing-filter"][value="resolved"]').click();
    await expect(page.locator("#drafts-list .thread-card")).toHaveCount(1);
    await expect(page.locator("#existing-list .thread-card")).toHaveCount(1);
  });
});

// --- submit footer (new) ------------------------------------------------------

test.describe("submit footer", () => {
  test("hidden at zero drafts", async ({ page }) => {
    await bootPrReview(page);
    await expect(page.locator("#submit-bar")).toBeHidden();
  });

  test("the three verdict labels, singular and plural", async ({ page }) => {
    await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
    await expect(page.locator("#submit-bar")).toBeVisible();
    await expect(page.locator("#submit-review")).toHaveText("Submit 1 comment");

    await page.locator('input[name="verdict"][value="approve"]').click();
    await expect(page.locator("#submit-review")).toHaveText("Approve with 1 comment");

    await page.locator('input[name="verdict"][value="request-changes"]').click();
    await expect(page.locator("#submit-review")).toHaveText("Request changes with 1 comment");

    await pushToWebview(page, {
      type: "drafts",
      drafts: [draft(), draft({ id: "d2", line: 4 })],
      totalDraftCount: 2,
    });
    await expect(page.locator("#submit-review")).toHaveText("Request changes with 2 comments");

    await page.locator('input[name="verdict"][value="comment"]').click();
    await expect(page.locator("#submit-review")).toHaveText("Submit 2 comments");
  });

  test("the summary toggle shows and focuses the textarea, collapses when emptied and blurred, and never hides non-empty text", async ({ page }) => {
    await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
    const toggle = page.locator("#summary-toggle");
    const body = page.locator("#review-body");
    await expect(body).toBeHidden();

    await toggle.click();
    await expect(body).toBeVisible();
    await expect(toggle).toBeHidden();
    await expect(body).toBeFocused();

    await body.fill("Looks good overall");
    await body.blur();
    await expect(body).toBeVisible();
    await expect(toggle).toBeHidden();

    await body.fill("");
    await body.blur();
    await expect(body).toBeHidden();
    await expect(toggle).toBeVisible();
  });

  test("the hint shows only when drafts exist on other files", async ({ page }) => {
    await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
    await expect(page.locator("#submit-hint")).toBeHidden();

    await pushToWebview(page, { type: "drafts", drafts: [draft()], totalDraftCount: 3 });
    await expect(page.locator("#submit-hint")).toBeVisible();
    await expect(page.locator("#submit-hint")).toHaveText("1 on this file · 2 on other files");
  });
});

// --- comments toggle (new) -----------------------------------------------------

test.describe("comments toggle", () => {
  test("collapses the pane, shows the open-thread badge, and restores", async ({ page }) => {
    await bootPrReview(page);
    await pushToWebview(page, {
      type: "existing-comments",
      comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", resolved: true })],
    });
    const toggle = page.locator("#comments-toggle");
    const badge = toggle.locator(".mc-badge");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(badge).toBeHidden();

    await toggle.click();
    await expect(page.locator("#app")).toHaveClass(/sidebar-collapsed/);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveAttribute("aria-label", "Show comments");
    // The open-thread count is never lost just because the pane hid.
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("1");

    await toggle.click();
    await expect(page.locator("#app")).not.toHaveClass(/sidebar-collapsed/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(badge).toBeHidden();
  });
});

// --- overflow menu (new) --------------------------------------------------------

test.describe("overflow menu", () => {
  test("holds Collapse all / Expand all; Escape closes it and returns focus to its trigger", async ({ page }) => {
    await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
    const btn = page.locator("#overflow-menu-btn");
    await expect(page.locator("#overflow-menu")).toBeHidden();

    await btn.click();
    await expect(page.locator("#overflow-menu")).toBeVisible();
    await expect(page.locator("#collapse-all-btn")).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(page.locator("#overflow-menu")).toBeHidden();
    expect(await btn.evaluate((el) => el === document.activeElement)).toBe(true);
  });
});

// --- the quote / jump button (new) ----------------------------------------------

test.describe("the quote", () => {
  test("jumps to the line in the preview when clicked", async ({ page }) => {
    await bootPrReview(page);
    await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
    await page.locator("#existing-list .thread-card .thread-quote").click();
    await expect(page.locator("#preview .pr-jump-flash")).toBeVisible();
  });

  test("the range label reads L3–4 for a multi-line draft, L3 for a single line", async ({ page }) => {
    await bootPrReview(page, {
      drafts: [draft({ id: "d1", line: 4, startLine: 3 }), draft({ id: "d2", line: 3 })],
      totalDraftCount: 2,
    });
    const cards = page.locator("#drafts-list .thread-card");
    await expect(cards.nth(0).locator(".pr-line")).toHaveText("L3–4");
    await expect(cards.nth(1).locator(".pr-line")).toHaveText("L3");
  });
});

// --- add-comment-btn (new) ------------------------------------------------------

test("#add-comment-btn opens the composer for the current selection", async ({ page }) => {
  await bootPrReview(page);
  await selectPreviewText(page, "Some body text");
  await expect(page.locator("#floating-add")).toBeVisible();
  await page.locator("#add-comment-btn").click();
  await expect(page.locator("#composer .mc-composer")).toBeVisible();
});

// --- no class-less buttons (new) -------------------------------------------------

test("no class-less <button> inside #drafts-pane with a draft in edit mode, a thread with an open reply composer, and a resolved thread on screen", async ({ page }) => {
  await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [
      githubComment({ id: "1", threadId: "1" }),
      githubComment({ id: "2", threadId: "2", resolved: true }),
    ],
  });

  await page.locator("#drafts-list").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#drafts-list .mc-composer")).toBeVisible();

  await page.locator("#existing-list .thread-card").first().locator(".thread-reply-toggle").click();
  await expect(page.locator("#existing-list .reply-box").first()).toHaveClass(/open/);

  const classless = await page
    .locator("#drafts-pane button")
    .evaluateAll((els) => els.filter((el) => el.className.trim() === "").map((el) => el.outerHTML));
  expect(classless).toEqual([]);
});

test("a draft being edited keeps its card frame, its quote and its draft badge", async ({ page }) => {
  await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
  await page.locator("#drafts-list").getByRole("button", { name: "Edit", exact: true }).click();
  const card = page.locator("#drafts-list .thread-card.pr-draft");
  await expect(card).toHaveCount(1);
  // The quote is what says which line the text being edited is about.
  await expect(card.locator(".thread-quote")).toBeVisible();
  await expect(card.locator(".mc-badge--draft")).toHaveText("draft");
  await expect(card.locator(".mc-composer textarea")).toBeVisible();
  await expect(card).not.toHaveClass(/collapsed/);
});

test("clicking a line marker while the sidebar is hidden brings the sidebar back", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment({ id: "1", threadId: "1" })] });
  await page.locator("#comments-toggle").click();
  await expect(page.locator("#app")).toHaveClass(/sidebar-collapsed/);

  await page.locator(".pr-comment-marker").first().click();
  await expect(page.locator("#app")).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator("#comments-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#existing-list .thread-card[data-thread-id="1"]')).toBeVisible();
});
