// "Remove resolved" in the review view's comment sidebar.
//
// The action existed as a command only, which meant finding it required
// knowing its name — while the resolved comments it acts on are sitting in
// front of you in the panel. It is offered there now, and only when it would
// actually do something.

import { expect, test } from "@playwright/test";
import { addThread, replaceThread, type InlineThread } from "../../inlineComments/format";
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

test.describe("live editor", () => {
  // The button lives in the "…" menu and posts `remove-resolved`. Updates
  // re-render the list, and the button has to follow them — the old live sidebar once kept a
  // stale "Remove N resolved" after the removal had already happened.
  test("the button follows an incremental update, not just the first render", async ({ page }) => {
    const src = fixture(2, 1);
    await bootLiveEditor(page, {
      text: src,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(src),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    const btn = page.locator("#remove-resolved");
    await expect(btn).toHaveText("Remove 2 resolved");

    // Exactly what the host pushes after the removal lands: the same message
    // shape, with the resolved threads gone.
    const after = fixture(0, 1);
    await page.evaluate(
      (payload) => window.postMessage({ type: "sidecar-changed", ...payload }, "*"),
      liveSidecar(after) as unknown as Record<string, unknown>,
    );
    await page.locator("#overflow-menu-btn").click();
    await expect(btn).toBeHidden();
  });

  test("the label tracks a partial removal", async ({ page }) => {
    const src = fixture(3, 1);
    await bootLiveEditor(page, {
      text: src,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(src),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("#remove-resolved")).toHaveText("Remove 3 resolved");
    const after = fixture(1, 1);
    await page.evaluate(
      (payload) => window.postMessage({ type: "sidecar-changed", ...payload }, "*"),
      liveSidecar(after) as unknown as Record<string, unknown>,
    );
    await expect(page.locator("#remove-resolved")).toHaveText("Remove 1 resolved");
  });

  test("offers the button only when something is resolved", async ({ page }) => {
    const clean = fixture(0, 2);
    await bootLiveEditor(page, {
      text: clean,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(clean),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await page.locator("#overflow-menu-btn").click();
    await expect(page.locator("#remove-resolved")).toBeHidden();
  });

  test("asks the host to run the command", async ({ page }) => {
    const src = fixture(2, 1);
    await bootLiveEditor(page, {
      text: src,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(src),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await page.locator("#overflow-menu-btn").click();
    const btn = page.locator("#remove-resolved");
    await expect(btn).toHaveText("Remove 2 resolved");
    await btn.click();
    // The host owns the confirm and the write; the webview only asks.
    expect(await awaitPosted(page, "remove-resolved")).toEqual({ type: "remove-resolved" });
  });
});
