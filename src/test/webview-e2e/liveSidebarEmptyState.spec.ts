// The live editor's sidebar before and outside of a review (10x-plan-6 P4,
// sidebar parity): the pre-init "Loading…" placeholder, the first-run empty
// state, the skill banner, and the scroll to an agent's first new thread —
// the review view's loadingState / inlineViewEmptyState coverage and its
// review-pending path, run against the live editor.
//
// Every test boots its own document; the page takes one `init`.

import { expect, test } from "@playwright/test";
import { addThread } from "../../inlineComments/format";
import { awaitPosted, bootLiveEditor, bootLiveEditorShell, pushToWebview } from "./harness";
import { liveInit, liveSidecar, reviewFixture } from "./fixtures";

const EMPTY_DOC = "# Notes\n\nNothing has been reviewed in this file yet.\n";

test("shows a muted 'Loading…' placeholder before init, and clears it on the first init", async ({ page }) => {
  await bootLiveEditorShell(page);
  await expect(page.locator(".mdc-editor-pane .mc-loading")).toHaveText("Loading…");
  await expect(page.locator("#threads-list .mc-loading")).toHaveText("Loading…");

  await pushToWebview(page, { type: "init", ...liveInit(EMPTY_DOC), readOnly: true });
  await expect(page.locator(".mdc-editor-root .milkdown h1")).toHaveText("Notes");
  await expect(page.locator(".mc-loading")).toHaveCount(0);
});

test("shows 'Ask agent to review' — naming no agent — and posts empty-state-review", async ({ page }) => {
  await bootLiveEditor(page, { ...liveInit(EMPTY_DOC), readOnly: true });
  const card = page.locator(".mc-empty-state");
  await expect(card).toBeVisible();
  await expect(card).toContainText("No comments yet.");
  await expect(card).not.toContainText("Claude");
  await card.getByRole("button", { name: "Ask agent to review" }).click();
  expect(await awaitPosted(page, "empty-state-review")).toEqual({ type: "empty-state-review" });
});

test("the empty state teaches both keybinding forms", async ({ page }) => {
  await bootLiveEditor(page, { ...liveInit(EMPTY_DOC), readOnly: true });
  await expect(page.locator(".mc-empty-state__hint")).toContainText("Cmd+K Cmd+Alt+M");
  await expect(page.locator(".mc-empty-state__hint")).toContainText("Ctrl+K Ctrl+Alt+M");
});

test("a filter hiding real threads shows the plain message, not the first-run card", async ({ page }) => {
  const body = "# Notes\n\nSome text worth commenting on.\n";
  const at = body.indexOf("Some text");
  const { source } = addThread(body, at, at + "Some text".length, {
    author: "user",
    body: "a comment",
    ts: "2026-01-01T00:00:00.000Z",
  });
  await bootLiveEditor(page, { ...liveInit(source), readOnly: true });
  await page.locator('input[name="filter"][value="resolved"]').click();
  await expect(page.locator("#threads-list .empty")).toContainText("No comments match this filter.");
  await expect(page.locator(".mc-empty-state")).toHaveCount(0);
});

test("the skill banner shows when the skill is missing, and Install posts install-skill", async ({ page }) => {
  await bootLiveEditor(page, { ...liveInit(EMPTY_DOC), readOnly: true });
  await expect(page.locator("#skill-warning")).toBeHidden();

  await pushToWebview(page, { type: "skill-status", status: "missing" });
  await expect(page.locator("#skill-warning")).toBeVisible();
  await expect(page.locator("#skill-warning-text")).toContainText("isn't installed");
  const install = page.locator("#skill-install");
  await expect(install).toHaveText("Install skill");
  await install.click();
  expect(await awaitPosted(page, "install-skill")).toEqual({ type: "install-skill" });

  await pushToWebview(page, { type: "skill-status", status: "current" });
  await expect(page.locator("#skill-warning")).toBeHidden();
});

test("after an agent is asked to review, its first new thread becomes the current card when it lands", async ({ page }) => {
  const fixture = reviewFixture();
  await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
  await pushToWebview(page, {
    type: "review-pending",
    existingIds: [fixture.answeredThreadId, fixture.openThreadId],
  });

  const at = fixture.source.indexOf("Suggest mode");
  const landed = addThread(fixture.source, at, at + "Suggest mode".length, {
    author: "claude",
    body: "Name the setting.",
    ts: "2026-07-02T10:00:00.000Z",
    agent: true,
  });
  await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(landed.source) });
  await expect(page.locator(`.thread-card[data-thread="${landed.thread.id}"]`)).toHaveClass(/highlighted/);
  // The document goes to the new thread too: its highlight pulses, and the
  // jump never reports the anchor missing.
  await expect(
    page.locator(`.mdc-anchor-highlight[data-comment-id="${landed.thread.id}"]`).first(),
  ).toHaveClass(/mdc-anchor-highlight--pulse/);
  await expect(page.locator(".mdc-toast", { hasText: "Couldn't locate" })).toHaveCount(0);
});

test("a first review of an empty file lands on its first thread without an anchor error", async ({ page }) => {
  const doc = "# Notes\n\nThe setup section references the old config path.\n\nRetries are not described.\n";
  await bootLiveEditor(page, { ...liveInit(doc), readOnly: true });
  await pushToWebview(page, { type: "review-pending", existingIds: [] });

  let source = doc;
  const ids: string[] = [];
  for (const [quote, body] of [
    ["old config path", "This path moved in the last release."],
    ["Retries are not described", "What happens after the third retry?"],
  ] as const) {
    const at = source.indexOf(quote);
    const added = addThread(source, at, at + quote.length, {
      author: "claude",
      body,
      ts: "2026-07-02T10:00:00.000Z",
      agent: true,
    });
    source = added.source;
    ids.push(added.thread.id);
  }
  await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(source) });

  await expect(page.locator(`.thread-card[data-thread="${ids[0]}"]`)).toHaveClass(/highlighted/);
  await expect(page.locator(`.mdc-anchor-highlight[data-comment-id="${ids[0]}"]`).first()).toHaveClass(
    /mdc-anchor-highlight--pulse/,
  );
  await expect(page.locator(".mdc-toast", { hasText: "Couldn't locate" })).toHaveCount(0);
});
