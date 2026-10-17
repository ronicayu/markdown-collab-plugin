// "Finalize" in the review view's comment sidebar (issue #1).
//
// The review is over and the file is headed for a commit — the reviewer is
// looking at the sidebar where the last threads sit, which is where the way out
// should be. The button only asks; the host owns the modal and the write.

import { expect, test, type Page } from "@playwright/test";
import { addSuggestion, addThread, replaceThread, type InlineThread } from "../../inlineComments/format";
import { awaitPosted, bootLiveEditor } from "./harness";
import { liveSidecar } from "./fixtures";

const TS = "2026-01-01T00:00:00.000Z";
const DOC = "# Doc\n\nAlpha sentence.\n\nBeta sentence.\n";

const resolve = (t: InlineThread): InlineThread => ({
  ...t,
  status: "resolved",
  resolvedBy: "you",
  resolvedTs: TS,
});

/** A document with `resolved` resolved threads and `open` open ones. */
function fixture(resolvedCount: number, openCount: number): string {
  let src = DOC;
  for (let i = 0; i < resolvedCount + openCount; i++) {
    const needle = i % 2 === 0 ? "Alpha" : "Beta";
    const at = src.indexOf(needle);
    const r = addThread(src, at, at + needle.length, { author: "you", body: `t${i}`, ts: TS });
    src = i < resolvedCount ? replaceThread(r.source, r.thread.id, resolve(r.thread)) : r.source;
  }
  return src;
}

async function boot(page: Page, src: string): Promise<void> {
  await bootLiveEditor(page, {
    text: src,
    user: { name: "r", color: "#fff" },
    ...liveSidecar(src),
    frontmatter: "",
    imageBaseUris: { docDir: "", workspaceFolder: null },
  });
}

test.describe("live editor", () => {
  test("hidden on a clean document — nothing to finalize", async ({ page }) => {
    await boot(page, DOC);
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#finalize-doc")).toBeHidden();
  });

  // The "…" menu item, in the comment sidebar.
  test("asks the host to run the command", async ({ page }) => {
    await boot(page, fixture(1, 1));
    await page.locator("#overflow-menu-btn").click();
    const btn = page.locator("#finalize-doc");
    await expect(btn).toBeVisible();
    await btn.click();
    expect(await awaitPosted(page, "finalize")).toEqual({ type: "finalize" });
  });

  test("offered for open threads, not just resolved ones", async ({ page }) => {
    // Unlike remove-resolved, finalize applies to ANY review data — the point
    // is to end the review, however it stands.
    await boot(page, fixture(0, 2));
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#finalize-doc")).toBeVisible();
  });

  test("offered when only a pending suggestion remains", async ({ page }) => {
    const at = DOC.indexOf("Beta");
    await boot(page, addSuggestion(DOC, at, at + 4, { author: "claude", proposed: "Gamma", ts: TS }).source);
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#finalize-doc")).toBeVisible();
  });

  test("the button follows an incremental update", async ({ page }) => {
    await boot(page, fixture(1, 1));
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#finalize-doc")).toBeVisible();

    await page.evaluate(
      (payload) => window.postMessage({ type: "sidecar-changed", ...payload }, "*"),
      liveSidecar(DOC) as unknown as Record<string, unknown>,
    );
    await expect(page.locator("#finalize-doc")).toBeHidden();
  });
});
