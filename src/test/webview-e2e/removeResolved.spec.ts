// "Remove resolved" in the comment panels.
//
// The action existed as a command only, which meant finding it required
// knowing its name — while the resolved comments it acts on are sitting in
// front of you in the panel. It is offered there now, and only when it would
// actually do something.

import { expect, test } from "@playwright/test";
import { addThread, parse, replaceThread, type InlineThread } from "../../inlineComments/format";
import { serialize } from "../../inlineComments/serializeState";
import { awaitPosted, bootInlineView, bootLiveEditor, posted } from "./harness";
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

test.describe("inline comments view", () => {
  test("offers the button only when there is something to remove", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: serialize(parse(fixture(0, 2))),
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    // Nothing resolved: no button, rather than a disabled one nobody can use.
    await expect(page.locator("#remove-resolved")).toBeHidden();
  });

  test("names the count and posts the request", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: serialize(parse(fixture(2, 1))),
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    const btn = page.locator("#remove-resolved");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText("Remove 2 resolved");

    await btn.click();
    // The host owns the confirm and the write; the webview only asks.
    expect(await awaitPosted(page, "remove-resolved")).toEqual({ type: "remove-resolved" });
  });

  test("the count follows the document", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: serialize(parse(fixture(1, 1))),
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("#remove-resolved")).toHaveText("Remove 1 resolved");

    // A second thread gets resolved elsewhere — the panel is told, and updates.
    await page.evaluate((state) => window.postMessage({ type: "update", state }, "*"),
      serialize(parse(fixture(3, 0))) as unknown as Record<string, unknown>);
    await expect(page.locator("#remove-resolved")).toHaveText("Remove 3 resolved");

    // And disappears when the last one goes.
    await page.evaluate((state) => window.postMessage({ type: "update", state }, "*"),
      serialize(parse(fixture(0, 2))) as unknown as Record<string, unknown>);
    await expect(page.locator("#remove-resolved")).toBeHidden();
  });
});

test.describe("live editor", () => {
  test("offers the button only when something is resolved", async ({ page }) => {
    const clean = fixture(0, 2);
    await bootLiveEditor(page, {
      text: clean,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(clean),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("[data-action='remove-resolved']")).toHaveCount(0);
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
    const btn = page.locator("[data-action='remove-resolved']");
    await expect(btn).toContainText("Remove 2 resolved");
    await btn.click();

    const invoked = (await posted(page)).filter((m) => m.type === "invoke-command");
    expect(invoked.pop()).toEqual({ type: "invoke-command", command: "remove-resolved" });
  });
});
