// While a new comment is being written, the text it's about stays marked.
//
// The composer's textarea takes focus, and the editor's own selection stops
// being drawn — so the person typed a comment without seeing what it was on,
// and in Editing mode the floating "+ Add comment" button came back on top of
// that very text. The span is now marked from the moment the composer opens
// until the comment is saved (its real highlight takes over) or cancelled.

import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, bootLiveEditor, pushToWebview } from "./harness";
import { liveInit, liveSidecar } from "./fixtures";
import { addThreadAtEditorRange, addThreadAtProseRange } from "../../collab/inlineBridge";

const DOC = "# Notes\n\nThe parser handles nested lists correctly.\n\nSuggest mode ships behind a setting.\n";
const TS = "2026-07-01T10:00:00.000Z";

/** Select `target` in the editor, as a drag would. */
async function select(page: Page, target: string): Promise<void> {
  await page.evaluate((t) => {
    const root = document.querySelector<HTMLElement>(".milkdown .ProseMirror")!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? "").indexOf(t);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + t.length);
      root.focus();
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    throw new Error(`not in the editor: ${t}`);
  }, target);
}

/** Select, open the composer, and type a body without saving. */
async function startComment(page: Page, target: string): Promise<import("@playwright/test").Locator> {
  await select(page, target);
  const add = page.locator(".mdc-add-comment-btn");
  await expect(add).toBeVisible();
  await add.click();
  const composer = page.locator(".mdc-composer-slot .mc-composer");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill("Ordered lists too?");
  return composer;
}

for (const readOnly of [false, true]) {
  const mode = readOnly ? "Reading" : "Editing";

  test.describe(`${mode} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await bootLiveEditor(page, { ...liveInit(DOC), readOnly });
    });

    test("the selected text stays marked while the comment is written, and the button stays off it", async ({ page }) => {
      await startComment(page, "nested lists");
      // Focus is in the textarea: the editor's own selection isn't drawn…
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
      // …so the span is marked instead.
      await expect(page.locator(".milkdown .mdc-anchor-pending")).toHaveText("nested lists");
      await page.keyboard.press("End");
      await page.waitForTimeout(100);
      await expect(page.locator(".mdc-add-comment-btn")).toBeHidden();
    });

    test("Cancel takes the mark away", async ({ page }) => {
      const composer = await startComment(page, "nested lists");
      await composer.getByRole("button", { name: "Cancel" }).click();
      await expect(page.locator(".milkdown .mdc-anchor-pending")).toHaveCount(0);
    });

    test("once saved, the comment's own highlight takes over from the mark", async ({ page }) => {
      const composer = await startComment(page, "nested lists");
      await composer.getByRole("button", { name: "Save" }).click();
      const msg = await awaitPosted(page, "add-comment");
      // What the host would write, by the same functions it uses.
      const comment = { author: "ronica", body: "Ordered lists too?", ts: TS };
      const r = readOnly
        ? addThreadAtProseRange(
            DOC,
            {
              start: msg.proseStart as number,
              end: msg.proseEnd as number,
              text: msg.proseText as string,
              before: (msg.anchor as { contextBefore: string }).contextBefore,
              after: (msg.anchor as { contextAfter: string }).contextAfter,
            },
            comment,
          )
        : addThreadAtEditorRange(DOC, msg.editRange as never, comment);
      if (!r.ok) throw new Error(r.error);
      await pushToWebview(page, { type: "add-comment-result", ok: true });
      await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(r.source) });
      await expect(page.locator(".milkdown .mdc-anchor-pending")).toHaveCount(0);
      await expect(page.locator(".milkdown .mdc-anchor-highlight")).toHaveText("nested lists");
    });

    test("a save that fails keeps the mark, with the composer, for the retry", async ({ page }) => {
      const composer = await startComment(page, "nested lists");
      await composer.getByRole("button", { name: "Save" }).click();
      await awaitPosted(page, "add-comment");
      await pushToWebview(page, { type: "add-comment-result", ok: false, error: "the file changed" });
      await expect(page.locator(".milkdown .mdc-anchor-pending")).toHaveText("nested lists");
    });

    test("selecting other text brings the button back, to comment there instead", async ({ page }) => {
      await startComment(page, "nested lists");
      await select(page, "behind a setting");
      await expect(page.locator(".mdc-add-comment-btn")).toBeVisible();
    });
  });
}
