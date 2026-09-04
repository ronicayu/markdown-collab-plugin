// "Finalize" in the comment panels (issue #1).
//
// The review is over and the file is headed for a commit — the reviewer is
// looking at the panel where the last threads sit, which is where the way out
// should be. The button only asks; the host owns the modal and the write.

import { expect, test } from "@playwright/test";
import { addSuggestion, addThread, parse, replaceThread, type InlineThread } from "../../inlineComments/format";
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
  test("hidden on a clean document — nothing to finalize", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: serialize(parse(DOC)),
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("#finalize-doc")).toBeHidden();
  });

  test("offered for open threads, not just resolved ones, and posts the request", async ({ page }) => {
    // Unlike remove-resolved, finalize applies to ANY review data — the point
    // is to end the review, however it stands.
    await bootInlineView(page, {
      fileName: "doc.md",
      state: serialize(parse(fixture(0, 2))),
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    const btn = page.locator("#finalize-doc");
    await expect(btn).toBeVisible();

    await btn.click();
    expect(await awaitPosted(page, "finalize")).toEqual({ type: "finalize" });
  });

  test("offered when only a pending suggestion remains", async ({ page }) => {
    const at = DOC.indexOf("Beta");
    const src = addSuggestion(DOC, at, at + 4, { author: "claude", proposed: "Gamma", ts: TS }).source;
    await bootInlineView(page, {
      fileName: "doc.md",
      state: serialize(parse(src)),
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("#finalize-doc")).toBeVisible();
  });

  test("disappears once the document is finalized", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: serialize(parse(fixture(1, 1))),
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("#finalize-doc")).toBeVisible();

    // The host pushes the post-finalize state: no threads, no suggestions.
    await page.evaluate((state) => window.postMessage({ type: "update", state }, "*"),
      serialize(parse(DOC)) as unknown as Record<string, unknown>);
    await expect(page.locator("#finalize-doc")).toBeHidden();
  });
});

test.describe("live editor", () => {
  test("asks the host to run the command", async ({ page }) => {
    const src = fixture(1, 1);
    await bootLiveEditor(page, {
      text: src,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(src),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    const btn = page.locator("[data-action='finalize']");
    await expect(btn).toBeVisible();
    await btn.click();

    const invoked = (await posted(page)).filter((m) => m.type === "invoke-command");
    expect(invoked.pop()).toEqual({ type: "invoke-command", command: "finalize" });
  });

  test("the button follows an incremental update", async ({ page }) => {
    const src = fixture(1, 1);
    await bootLiveEditor(page, {
      text: src,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(src),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("[data-action='finalize']")).toBeVisible();

    await page.evaluate(
      (payload) => window.postMessage({ type: "sidecar-changed", ...payload }, "*"),
      liveSidecar(DOC) as unknown as Record<string, unknown>,
    );
    await expect(page.locator("[data-action='finalize']")).toBeHidden();
  });
});
