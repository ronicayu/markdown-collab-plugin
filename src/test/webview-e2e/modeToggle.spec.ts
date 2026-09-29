// Edit mode through real keystrokes, and the in-view Reading/Editing mode
// control (docs/one-view-design.md, "Phase B").
//
// blockSplice.spec.ts gates every block of 17 documents through the bundle's
// test seam; this drives the path a person takes — the keyboard, the edit
// debounce, the posted `edit-blocks` — for typing, Enter in the middle of a
// paragraph (a split), Enter at its end then typing (an insertion) and
// Backspace at a block's start (a merge). Each message is spliced by the host
// function, and the file may change only on the lines of the blocks involved.
//
// Then the mode control: the sidebar posts `set-read-only`; the host (played here)
// re-sends `init` in the new mode and the editor is rebuilt in place — read-only
// with the source-position schema, so a comment goes through
// `addThreadAtProseRange` and changes no prose line.

import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, bootLiveEditor, clearPosted, posted, pushToWebview } from "./harness";
import { liveInit } from "./fixtures";
import { addThreadAtProseRange, applyBlockEdits } from "../../collab/inlineBridge";
import { addThread, parse, stripAllInlineMarkup } from "../../inlineComments/format";
import { onlyMarkersAdded } from "../support/oneViewCorpus";

const TS = "2026-09-29T00:00:00.000Z";

const BASE = [
  "# Release notes",
  "",
  "The parser handles nested lists correctly.",
  "",
  "- first item",
  "- second item",
  "",
  "| Key | Value |",
  "|-----|-------|",
  "| a   | b     |",
  "",
  "Suggest mode ships behind a setting.",
  "",
].join("\n");

/** BASE with a thread on "nested lists" and one on "behind a setting". */
function fixture(): { source: string; ids: string[] } {
  let source = BASE;
  const ids: string[] = [];
  for (const text of ["nested lists", "behind a setting"]) {
    const at = source.indexOf(text);
    const r = addThread(source, at, at + text.length, { author: "ronica", body: `on ${text}`, ts: TS });
    source = r.source;
    ids.push(r.thread.id);
  }
  return { source, ids };
}

const editable = (page: Page) => page.locator(".milkdown .ProseMirror");

/**
 * Put the caret `offset` characters into `text`, or — with `offset` "end" — at
 * the end of the block whose text contains it. (Highlights split a block into
 * several text nodes, so a block is found by its whole text.)
 */
async function caretIn(page: Page, text: string, offset: number | "end" = "end"): Promise<void> {
  await editable(page).focus();
  await page.evaluate(
    ({ text, offset }) => {
      const root = document.querySelector(".milkdown .ProseMirror")!;
      const texts = (el: Node): Text[] => {
        const out: Text[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
        return out;
      };
      const r = document.createRange();
      if (offset === "end") {
        const block = Array.from(root.querySelectorAll("p, h1, h2, h3")).find((b) => b.textContent!.includes(text));
        const last = block ? texts(block).pop() : undefined;
        if (!last) throw new Error(`no block holds ${text}`);
        r.setStart(last, last.data.length);
      } else {
        const node = texts(root).find((t) => t.data.includes(text));
        if (!node) throw new Error(`no text node holds ${text}`);
        r.setStart(node, node.data.indexOf(text) + offset);
      }
      r.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
    },
    { text, offset },
  );
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".milkdown"))).toBe(true);
}

type EditBlocks = { epoch: number; baseTypes: string[]; edits: Array<{ from: number; to: number; markdown: string; types: string[] }> };

/** Wait for the one `edit-blocks` a keystroke posts, splice it, and clear the log. */
async function spliced(page: Page, source: string): Promise<{ message: EditBlocks; source: string }> {
  const message = (await awaitPosted(page, "edit-blocks")) as unknown as EditBlocks;
  await clearPosted(page);
  const r = applyBlockEdits(source, message);
  if (!r.ok) throw new Error(r.error);
  expect(r.restructured).toBe(false);
  return { message, source: r.source };
}

const regionOf = (source: string): string => {
  const r = parse(source).threadsRegion;
  return r ? source.slice(r.start, r.end) : "";
};

test("keystrokes post only the blocks they changed, and the host splices those into the file", async ({ page }) => {
  const { source: original, ids } = fixture();
  await bootLiveEditor(page, { ...liveInit(original), epoch: 1 });
  await expect(editable(page)).toHaveAttribute("contenteditable", "true");

  // Typing at the end of a paragraph.
  await caretIn(page, "lists correctly.");
  await page.keyboard.type("!");
  const typed = await spliced(page, original);
  expect(typed.message.epoch).toBe(1);
  expect(typed.message.baseTypes).toEqual(["heading", "paragraph", "bullet_list", "table", "paragraph"]);
  expect(typed.message.edits).toEqual([
    { from: 1, to: 2, markdown: "The parser handles nested lists correctly.!", types: ["paragraph"] },
  ]);
  // Byte for byte: the list keeps its `-`, the table its padding, both threads their markers.
  expect(typed.source).toBe(original.replace("correctly.", "correctly.!"));

  // Enter in the middle of that paragraph: one change over the block it split.
  await caretIn(page, "nested lists", 0);
  await page.keyboard.press("Enter");
  const split = await spliced(page, typed.source);
  expect(split.message.edits).toEqual([
    // The space before the caret stays at the end of the first half.
    { from: 1, to: 2, markdown: "The parser handles \n\nnested lists correctly.!", types: ["paragraph", "paragraph"] },
  ]);
  expect(split.source).toBe(typed.source.replace("handles <!--mc", "handles \n\n<!--mc"));

  // Enter at the end of the last paragraph, then typing: an insertion after it.
  await caretIn(page, "behind a setting.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("New para");
  const inserted = await spliced(page, split.source);
  expect(inserted.message.edits).toEqual([{ from: 6, to: 6, markdown: "New para", types: ["paragraph"] }]);
  expect(inserted.source).toBe(split.source.replace("setting<!--mc:/a:" + ids[1] + "-->.", "setting<!--mc:/a:" + ids[1] + "-->.\n\nNew para"));

  // Backspace at its start: a merge, spliced over the union of the two blocks.
  await caretIn(page, "New para", 0);
  await page.keyboard.press("Backspace");
  const merged = await spliced(page, inserted.source);
  expect(merged.message.edits).toEqual([
    { from: 5, to: 7, markdown: "Suggest mode ships behind a setting.New para", types: ["paragraph"] },
  ]);
  expect(merged.source).toBe(inserted.source.replace(".\n\nNew para", ".New para"));

  // Through all four, both threads kept their text and the threads block its bytes.
  for (const [id, text] of [
    [ids[0]!, "nested lists"],
    [ids[1]!, "behind a setting"],
  ] as const) {
    const a = parse(merged.source).anchors.get(id)!;
    expect(merged.source.slice(a.openEnd, a.closeStart)).toBe(text);
  }
  expect(regionOf(merged.source)).toBe(regionOf(original));
});

test("an edit still in the debounce is posted before the mode switch", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await caretIn(page, "lists correctly.");
  await page.keyboard.type("?");
  await page.locator('input[name="edit-mode"][value="read"]').click();
  await expect.poll(async () => (await posted(page)).map((m) => m.type)).toEqual(["edit-blocks", "set-read-only"]);
});

test("the mode control rebuilds the editor read-only and back; a read-only comment adds only its markers", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await expect(editable(page)).toHaveAttribute("contenteditable", "true");

  // Editing → Reading. The control only asks; the host re-sends `init` in the new mode.
  await page.locator('input[name="edit-mode"][value="read"]').click();
  expect(await awaitPosted(page, "set-read-only")).toEqual({ type: "set-read-only", readOnly: true });
  await clearPosted(page);
  await pushToWebview(page, { type: "init", ...liveInit(source), readOnly: true, epoch: 2 });
  await expect(editable(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.locator("#edit-mode-toggle")).toHaveAttribute("data-mode", "read");
  // Highlights are placed by source position now.
  await expect(page.locator(".mdc-anchor-highlight")).toHaveCount(2);

  // A comment in read-only mode: a prose span, placed in the file's own bytes.
  await page.evaluate(() => {
    const root = document.querySelector(".milkdown .ProseMirror")!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf("Suggest");
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + "Suggest".length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
      return;
    }
  });
  await page.locator(".mdc-add-comment-btn").click();
  const composer = page.locator(".mdc-composer-slot .mc-composer");
  await composer.locator("textarea").fill("Which mode?");
  await composer.getByRole("button", { name: "Save" }).click();
  const msg = await awaitPosted(page, "add-comment");
  expect(msg.fullMd).toBeUndefined();
  expect(msg.proseText).toBe("Suggest");
  const r = addThreadAtProseRange(
    source,
    { start: msg.proseStart as number, end: msg.proseEnd as number, text: msg.proseText as string },
    { author: "ronica", body: "Which mode?", ts: TS },
  );
  if (!r.ok) throw new Error(r.error);
  const added = parse(r.source).threads.find((t) => !parse(source).threads.some((b) => b.id === t.id))!;
  expect(onlyMarkersAdded(source, r.source, added.id)).toEqual([]);
  expect(stripAllInlineMarkup(r.source)).toBe(stripAllInlineMarkup(source));
  await pushToWebview(page, { type: "add-comment-result", ok: true });
  await clearPosted(page);

  // Reading → Editing, on the file with the new comment.
  await page.locator('input[name="edit-mode"][value="edit"]').click();
  expect(await awaitPosted(page, "set-read-only")).toEqual({ type: "set-read-only", readOnly: false });
  await clearPosted(page);
  await pushToWebview(page, { type: "init", ...liveInit(r.source), readOnly: false, epoch: 3 });
  await expect(editable(page)).toHaveAttribute("contenteditable", "true");
  await caretIn(page, "lists correctly.");
  await page.keyboard.type("!");
  const edited = await spliced(page, r.source);
  expect(edited.message.epoch).toBe(3);
  expect(edited.source).toBe(r.source.replace("correctly.", "correctly.!"));
});

test("a re-render the host sends after refusing an edit says why and becomes the new base", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await pushToWebview(page, {
    type: "externalChange",
    text: liveInit(source).text,
    epoch: 4,
    toast: "Your last edit wasn't saved: the edit doesn't describe blocks of this document.",
  });
  await expect(page.locator(".mdc-toast")).toContainText("Your last edit wasn't saved");
  await expect(page.locator(".mdc-banner")).toHaveCount(0);
  // The re-render itself posts nothing; the next keystroke is diffed against it.
  await page.waitForTimeout(600);
  expect((await posted(page)).filter((m) => m.type === "edit-blocks")).toEqual([]);
  await caretIn(page, "lists correctly.");
  await page.keyboard.type("!");
  const edited = await spliced(page, source);
  expect(edited.message.epoch).toBe(4);
  expect(edited.message.edits).toHaveLength(1);
});
