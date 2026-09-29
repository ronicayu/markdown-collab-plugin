// PR review webview: collapse/expand and Resolve/Unresolve.
//
// Every card the webview can show — a GitHub review thread, a resolvable or
// non-resolvable GitLab discussion, and the user's own unposted draft — gets
// a chevron and takes part in Collapse all / Expand all. A resolved thread
// starts collapsed, everything else (open threads, non-resolvable notes,
// drafts) starts expanded. Resolve/Unresolve only appears where the platform
// actually allows it, posts a `resolve-thread` message, and the card's
// resolved badge + collapse state only change once the host confirms with a
// fresh `existing-comments` push — never optimistically.
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

const VSCODE_API_STUB = `
window.__mcPosted = [];
window.__mcState = undefined;
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (msg) { window.__mcPosted.push(msg); },
    setState: function (s) { window.__mcState = s; },
    getState: function () { return window.__mcState; },
  };
};
`;

async function bootPrReviewShell(page: Page): Promise<void> {
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
  await page.addScriptTag({ content: VSCODE_API_STUB });
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
async function bootPrReview(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await bootPrReviewShell(page);
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

test("an unresolved resolvable thread starts expanded, with a Resolve button", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator(".existing-card").first();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator(".existing-head")).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByRole("button", { name: "Resolve" })).toBeVisible();
});

test("a resolved thread starts collapsed, with an Unresolve button and the Resolved badge", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ resolved: true })],
  });
  const card = page.locator(".existing-card").first();
  await expect(card).toHaveClass(/collapsed/);
  await expect(card.locator(".existing-head")).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByRole("button", { name: "Unresolve" })).toBeVisible();
  // The badge lives in the header, so it's visible even collapsed.
  await expect(card.locator(".badge.resolved")).toBeVisible();
  await expect(card.locator(".badge.resolved")).toHaveText("resolved");
});

test("clicking the header toggles collapse", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator(".existing-card").first();
  const header = card.locator(".existing-head");
  await expect(card).not.toHaveClass(/collapsed/);
  await header.click();
  await expect(card).toHaveClass(/collapsed/);
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(header).toHaveAttribute("aria-expanded", "true");
});

test("Enter and Space on the header toggle collapse", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator(".existing-card").first();
  const header = card.locator(".existing-head");
  await header.focus();
  await header.press("Enter");
  await expect(card).toHaveClass(/collapsed/);
  await header.press(" ");
  await expect(card).not.toHaveClass(/collapsed/);
});

test("the Resolve button posts resolve-thread and only collapses once the host confirms", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator(".existing-card").first();
  const resolveBtn = card.getByRole("button", { name: "Resolve" });
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
  const confirmedCard = page.locator(".existing-card").first();
  await expect(confirmedCard).toHaveClass(/collapsed/);
  await expect(confirmedCard.getByRole("button", { name: "Unresolve" })).toBeVisible();
});

test("the Unresolve button posts resolve-thread:false and expands once confirmed", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ resolved: true })],
  });
  const card = page.locator(".existing-card").first();
  await card.getByRole("button", { name: "Unresolve" }).click();
  const msg = await awaitPosted(page, "resolve-thread");
  expect(msg).toEqual({ type: "resolve-thread", resolveId: "PRRT_thread1", resolved: false });

  await clearPosted(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ resolved: false })],
  });
  const confirmedCard = page.locator(".existing-card").first();
  await expect(confirmedCard).not.toHaveClass(/collapsed/);
  await expect(confirmedCard.getByRole("button", { name: "Resolve" })).toBeVisible();
});

test("a resolve-thread-error re-enables the button with the platform's message", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, { type: "existing-comments", comments: [githubComment()] });
  const card = page.locator(".existing-card").first();
  await card.getByRole("button", { name: "Resolve" }).click();
  await awaitPosted(page, "resolve-thread");
  await pushToWebview(page, {
    type: "resolve-thread-error",
    resolveId: "PRRT_thread1",
    error: "gh api graphql resolveReviewThread failed: FORBIDDEN",
  });
  const resolveBtn = card.getByRole("button", { name: "Resolve" });
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
  const card = page.locator(".existing-card").first();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.getByRole("button", { name: /Resolve/ })).toHaveCount(0);
  await card.locator(".existing-head").click();
  await expect(card).toHaveClass(/collapsed/);
  // Collapsed summary still shows author + gist + reply count for a note
  // that was never resolvable to begin with.
  await expect(card.locator(".existing-gist")).toContainText("carol");
  await expect(card.locator(".existing-gist")).toContainText("just an FYI");
  await expect(card.locator(".existing-gist")).toContainText("0 replies");
});

test("a draft card is collapsible, starts expanded, and shows author + gist + reply count collapsed", async ({ page }) => {
  await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
  const card = page.locator("#drafts-list .existing-card").first();
  await expect(card).not.toHaveClass(/collapsed/);
  const header = card.locator(".existing-head");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.click();
  await expect(card).toHaveClass(/collapsed/);
  await expect(card.locator(".existing-gist")).toContainText("Your draft");
  await expect(card.locator(".existing-gist")).toContainText("nit: typo here");
  await expect(card.locator(".existing-gist")).toContainText("0 replies");
  // Still reachable: Edit/Delete live in the (now hidden) body, but the
  // card's own dataset id — used to flash it from a preview marker — is
  // unaffected by collapse.
  await expect(card).toHaveAttribute("data-draft-id", "d1");
});

test("Collapse all / Expand all operates on every card — drafts and existing threads together", async ({ page }) => {
  await bootPrReview(page, { drafts: [draft()], totalDraftCount: 1 });
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", resolved: true })],
  });
  const collapseAll = page.locator("#collapse-all-btn");
  await expect(collapseAll).toBeVisible();
  // One thread starts resolved (collapsed) and the rest expanded, so the
  // button's first label is "Collapse all" (something is still expanded).
  await expect(collapseAll).toHaveText("Collapse all");

  await collapseAll.click();
  const cards = page.locator("#drafts-list .existing-card, #existing-list .existing-card");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) await expect(card).toHaveClass(/collapsed/);
  await expect(collapseAll).toHaveText("Expand all");

  await collapseAll.click();
  for (const card of await cards.all()) await expect(card).not.toHaveClass(/collapsed/);
  await expect(collapseAll).toHaveText("Collapse all");
});

test("a manual toggle survives an unrelated existing-comments refresh", async ({ page }) => {
  await bootPrReview(page);
  await pushToWebview(page, {
    type: "existing-comments",
    comments: [githubComment({ id: "1", threadId: "1" }), githubComment({ id: "2", threadId: "2", body: "second thread" })],
  });
  const first = page.locator(".existing-card").first();
  await first.locator(".existing-head").click();
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
  await expect(page.locator(".existing-card").first()).toHaveClass(/collapsed/);
});
