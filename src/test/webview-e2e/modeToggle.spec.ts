// Edit mode through real keystrokes, and the in-view Reading/Editing mode
// control.
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
import { awaitPosted, bootLiveEditor, bootLiveEditorShell, clearPosted, posted, pushToWebview } from "./harness";
import { liveInit, liveProse } from "./fixtures";
import { addThreadAtEditorRange, addThreadAtProseRange, applyBlockEdits } from "../../collab/inlineBridge";
import type { EditorPoint } from "../../collab/sourcePositions";
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
  // One input, so a slow machine can't split the word across two debounces.
  await page.keyboard.insertText("New para");
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
  await caretIn(page, "lists correctly."); // focuses the editor — posts its own editor-focus, filtered below
  await page.keyboard.type("?");
  await page.locator('input[name="edit-mode"][value="read"]').click();
  await expect
    .poll(async () => (await posted(page)).filter((m) => m.type !== "editor-focus").map((m) => m.type))
    .toEqual(["edit-blocks", "set-read-only"]);
});

// #edit-mode-toggle moved into the document toolbar,
// specifically so the mode switch stays reachable with the sidebar collapsed
// (the old floating .mdc-sidebar-toggle left no way to switch mode once
// collapsed).
test("the mode control is still visible and clickable with the sidebar collapsed", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await page.locator("#mdc-comments-toggle").click();
  await expect(page.locator(".mdc-layout")).toHaveClass(/mdc-layout--collapsed/);

  const group = page.locator("#edit-mode-toggle");
  await expect(group).toBeVisible();
  // The fixture boots in edit mode (no `readOnly` in the init payload); switch to Reading.
  await page.locator('input[name="edit-mode"][value="read"]').click();
  expect(await awaitPosted(page, "set-read-only")).toEqual({ type: "set-read-only", readOnly: true });
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

// More of what people do with a keyboard: each posts what the editor holds,
// the host splices it, and the file may change only where the edit was.

/** Whether `after` is `before` with `[from, to)` of it replaced — returns the replacement, or null. */
function onlyReplaced(before: string, after: string, from: number, to: number): string | null {
  const tail = before.length - to;
  if (after.slice(0, from) !== before.slice(0, from) || after.slice(after.length - tail) !== before.slice(to)) return null;
  return after.slice(from, after.length - tail);
}

/** Select from `startText`'s first character to `endText`'s last, across blocks. */
async function selectText(page: Page, startText: string, endText: string): Promise<void> {
  await editable(page).focus();
  await page.evaluate(
    ({ startText, endText }) => {
      const root = document.querySelector(".milkdown .ProseMirror")!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
      const a = texts.find((t) => t.data.includes(startText))!;
      const b = texts.find((t) => t.data.includes(endText))!;
      const r = document.createRange();
      r.setStart(a, a.data.indexOf(startText));
      r.setEnd(b, b.data.indexOf(endText) + endText.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
    },
    { startText, endText },
  );
}

test("selecting a whole paragraph and deleting it removes that paragraph's bytes and nothing else", async ({ page }) => {
  const { source, ids } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await selectText(page, "The parser", "correctly.");
  await page.keyboard.press("Backspace");
  const emptied = await spliced(page, source);
  // The paragraph is still there, empty: milkdown writes one as `<br />`.
  const para = parse(source).anchors.get(ids[0]!)!;
  const start = source.lastIndexOf("\n", para.openStart) + 1;
  const end = source.indexOf("\n", para.closeEnd);
  expect(onlyReplaced(source, emptied.source, start, end)).toBe("<br />");
  expect(regionOf(emptied.source)).toBe(regionOf(source));

  // Backspace again takes the empty paragraph out, with one separator.
  await page.keyboard.press("Backspace");
  const removed = await spliced(page, emptied.source);
  expect(removed.source).toBe(source.slice(0, start - 2) + source.slice(end));
});

test("typing in the middle of a list item that isn't the last changes only that item", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await caretIn(page, "first item", "first".length);
  // One key, so a slow machine can't split it across two debounces.
  await page.keyboard.type("s");
  const typed = await spliced(page, source);
  expect(typed.message.edits).toHaveLength(1);
  // Still tight: no blank line appears between the items.
  expect(typed.source).toBe(source.replace("- first item", "- firsts item"));
});

test("pasting two paragraphs adds exactly them, with a blank line between", async ({ page }) => {
  const { source, ids } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await caretIn(page, "lists correctly.");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "Pasted one.\n\nPasted two.");
    const target = document.querySelector(".milkdown .ProseMirror")!;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const pasted = await spliced(page, source);
  const close = `<!--mc:/a:${ids[0]}-->`;
  const at = source.indexOf(" correctly.", source.indexOf(close)) + " correctly.".length;
  expect(onlyReplaced(source, pasted.source, at, at)).toBe("Pasted one.\n\nPasted two.");
  expect(pasted.message.edits.map((e) => e.types)).toEqual([["paragraph", "paragraph"]]);
});

// Cmd+Z no longer runs a local ProseMirror undo
// — the file's undo history is the only one. It flushes the keystroke, asks
// the host to undo the file, and the file's answer puts the document back.
test("undo after typing puts the file back byte for byte, markers included", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await caretIn(page, "behind a setting.");
  await page.keyboard.type("!");
  const typed = await spliced(page, source);
  expect(typed.source).toBe(source.replace("-->.\n", "-->.!\n"));

  await page.keyboard.press("ControlOrMeta+z");
  expect(await awaitPosted(page, "undo")).toEqual({ type: "undo" });
  await clearPosted(page);
  // The host undid the write to the file and pushes the result back.
  await pushToWebview(page, { type: "externalChange", text: liveProse(source), epoch: 2, quiet: true, reveal: true });
  await expect(editable(page)).not.toContainText("setting.!");

  // The file is back exactly where it started: the next edit diffs cleanly against it.
  await caretIn(page, "lists correctly.");
  await page.keyboard.type("?");
  const edited = await spliced(page, source);
  expect(edited.source).toBe(source.replace("correctly.", "correctly.?"));
});

// Pushes and rebuilds crossing each other: nothing typed or sent may be lost
// without a word, and the epoch an edit carries is the one the host last sent.

test("an external change that arrives while the editor is being built is applied once it's built", async ({ page }) => {
  const { source } = fixture();
  // The build takes a turn of the event loop, as it can in VS Code — here on purpose.
  await page.evaluate(() => {
    (window as unknown as { __mcTestHooks: Record<string, unknown> }).__mcTestHooks = {
      beforeEditorBuild: () => new Promise((r) => setTimeout(r, 150)),
    };
  });
  await bootLiveEditorShell(page);
  const changed = source.replace("Suggest mode ships", "Suggest mode now ships");
  // Back to back: the editor is still being built when the change arrives.
  await page.evaluate(
    (msgs) => {
      for (const m of msgs) window.postMessage(m, "*");
    },
    [
      { type: "init", ...liveInit(source), epoch: 1 },
      { type: "externalChange", text: liveProse(changed), epoch: 2 },
    ],
  );
  await awaitPosted(page, "ready-with-content");
  await expect(editable(page)).toContainText("Suggest mode now ships");
  await clearPosted(page);
  await caretIn(page, "lists correctly.");
  await page.keyboard.type("!");
  const typed = await spliced(page, changed);
  expect(typed.message.epoch).toBe(2);
});

test("a keystroke still in the debounce when the host rebuilds the editor is posted first", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await caretIn(page, "lists correctly.");
  await page.keyboard.type("!");
  // The switch to Reading arrives before the debounce fires.
  await pushToWebview(page, { type: "init", ...liveInit(source), readOnly: true, epoch: 2 });
  const edit = (await awaitPosted(page, "edit-blocks")) as unknown as EditBlocks;
  expect(edit.epoch).toBe(1);
  expect(edit.edits).toEqual([{ from: 1, to: 2, markdown: "The parser handles nested lists correctly.!", types: ["paragraph"] }]);
  await expect(editable(page)).toHaveAttribute("contenteditable", "false");
  // Outlive the destroyed editor's own 200 ms listener debounce: it used to
  // fire on the dead editor and throw from a timer ("editorView not found"),
  // which the harness turns into a failure — but only when the test was still
  // running, so it passed on a quiet machine and failed on a busy one.
  await page.waitForTimeout(350);
  expect((await posted(page)).filter((m) => m.type === "webview-error")).toEqual([]);
});

test("a quiet push replaces the text without announcing an outside edit", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), readOnly: true, epoch: 1 });
  const changed = source.replace("correctly.", "correctly.!");
  await pushToWebview(page, { type: "externalChange", text: liveProse(changed), epoch: 2, quiet: true });
  await expect(editable(page)).toContainText("correctly.!");
  await page.waitForTimeout(100);
  // Counted now, not polled: a notice would still be showing.
  expect(await page.locator(".mdc-banner").count()).toBe(0);
  expect(await page.locator(".mdc-toast--visible").count()).toBe(0);
});

// An edit-mode comment: the selection is named by structure, and the host
// finds it in the file's own bytes — the add changes nothing but its markers,
// in a block the serializer rewrote as much as in one it never touched.
test("in edit mode, a comment adds its two markers to the file's own bytes and nothing else", async ({ page }) => {
  const COMMENT = { author: "ronica", body: "Why?", ts: TS };
  // A block typed into (its bytes now the serializer's), a list, a padded table.
  const base = "# Notes\n\nSome __strong__ text and _more_.\n\n- one\n- two\n\n| a   | b   |\n|-----|-----|\n| 1   | 2   |\n";
  await bootLiveEditor(page, { ...liveInit(base), epoch: 1 });
  await caretIn(page, "text and");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  let source = (await spliced(page, base)).source;

  for (const [first, last] of [
    ["strong", "text"],
    ["two", "two"],
    ["2", "2"],
  ] as const) {
    await selectText(page, first, last);
    await page.locator(".mdc-add-comment-btn").click();
    const composer = page.locator(".mdc-composer-slot .mc-composer");
    await composer.locator("textarea").fill("Why?");
    await composer.getByRole("button", { name: "Save" }).click();
    const msg = await awaitPosted(page, "add-comment");
    // Nothing the editor serialized goes with it for the host to adopt.
    expect(msg.fullMd).toBeUndefined();
    expect(msg.editRange).toBeDefined();
    const r = addThreadAtEditorRange(source, msg.editRange as { first: EditorPoint; last: EditorPoint }, COMMENT);
    if (!r.ok) throw new Error(r.error);
    const id = parse(r.source).threads.find((t) => !parse(source).threads.some((b) => b.id === t.id))!.id;
    expect(onlyMarkersAdded(source, r.source, id), `${first}…${last}`).toEqual([]);
    const a = parse(r.source).anchors.get(id)!;
    expect(stripAllInlineMarkup(r.source.slice(a.openEnd, a.closeStart))).toContain(last);
    source = r.source;
    await pushToWebview(page, { type: "add-comment-result", ok: true });
    await clearPosted(page);
  }
});

test("a keystroke and Enter twice in one debounce, then typing: neither edit is refused", async ({ page }) => {
  const { source } = fixture();
  await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
  await caretIn(page, "behind a setting.");
  // Within one debounce: the two empty paragraphs at the end come with a real change.
  await page.keyboard.type("!");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const first = await spliced(page, source);
  expect(first.message.edits).toEqual([{ from: 4, to: 5, markdown: "Suggest mode ships behind a setting.!", types: ["paragraph"] }]);
  await page.keyboard.type("x");
  const typed = await spliced(page, first.source);
  expect(typed.source).toBe(first.source.replace(/\.!\n/, ".!\n\n<br />\n\nx\n"));
});

const LONG = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a long document that scrolls.`).join("\n\n") + "\n";

// An outside change (an agent's edit, a format-on-save) used to arrive as a
// whole-document replacement. ProseMirror then mapped every earlier undo step
// through that replacement — all onto the end of the new document — so Cmd+Z
// undid nothing and parked the cursor (and the scroll) at the end of the file.
// Now Cmd+Z has nothing of its own to map: the file's undo history is the
// only one, so it undoes whatever changed the
// file last — the agent's edit, here, not the keystroke typed before it.
test.describe("undo after an outside change", () => {
  test("undoes the agent's edit — the file's last change — and reveals it, not the end of the doc", async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(LONG), epoch: 1 });
    await caretIn(page, "Paragraph 1 of");
    await page.keyboard.type("!");
    // The host wrote the keystroke; the agent then edits the last paragraph of
    // that file while the cursor is still at the top. The agent's write is
    // now the file's last change.
    const { source: withBang } = await spliced(page, LONG);
    const scroller = page.locator(".mdc-editor-scroll");
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    const edited = withBang.replace("Paragraph 60 of", "Paragraph 60 (edited by the agent) of");
    await pushToWebview(page, { type: "externalChange", text: liveProse(edited), epoch: 2, quiet: true });
    await expect(editable(page)).toContainText("edited by the agent");

    await page.keyboard.press("ControlOrMeta+z");
    expect(await awaitPosted(page, "undo")).toEqual({ type: "undo" });
    await clearPosted(page);

    // The host's answer: the agent's edit undone — the file's last change,
    // not the user's earlier keystroke — revealed where it happened, neither
    // left at the top (where the caret was typing) nor jumped to the end.
    const undone = edited.replace("Paragraph 60 (edited by the agent) of", "Paragraph 60 of");
    await pushToWebview(page, { type: "externalChange", text: liveProse(undone), epoch: 3, quiet: true, reveal: true });
    await expect(editable(page)).not.toContainText("edited by the agent");
    // The keystroke at the top survives: it was never the agent's to undo.
    await expect(editable(page).locator("p").first()).toHaveText("Paragraph 1 of a long document that scrolls.!");
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("the cursor stays on its text when the change is above it", async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(LONG), epoch: 1 });
    await caretIn(page, "Paragraph 60 of", "Paragraph 60 of".length);
    const above = LONG.replace("Paragraph 1 of", "Paragraph 1 (now much longer after the agent rewrote it) of");
    await pushToWebview(page, { type: "externalChange", text: liveProse(above), epoch: 2, quiet: true });
    await expect(editable(page)).toContainText("now much longer");
    await page.keyboard.type("!");
    // Before: the old absolute offset was restored, which now fell at the start of the paragraph.
    await expect(editable(page).locator("p").last()).toHaveText("Paragraph 60 of! a long document that scrolls.");
  });
});

// Mod-z/Mod-Shift-z/Mod-y in Editing mode: never a local undo (there is none
// any more) — they flush the pending edit, ask the host, and wait for its
// answer.
test.describe("undo and redo keys", () => {
  test("Cmd+Z posts the pending edit still in the debounce, then undo; the document doesn't change until the host answers", async ({
    page,
  }) => {
    const { source } = fixture();
    await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
    await caretIn(page, "lists correctly."); // focuses the editor — posts its own editor-focus, filtered below
    await page.keyboard.type("!");
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.type !== "editor-focus").map((m) => m.type))
      .toEqual(["edit-blocks", "undo"]);
    // Nothing reverted locally — the file's answer hasn't come back yet.
    await expect(editable(page)).toContainText("lists correctly.!");
  });

  test("Cmd+Shift+Z and Ctrl+Y post redo", async ({ page }) => {
    const { source } = fixture();
    await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
    await caretIn(page, "lists correctly.");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect(await awaitPosted(page, "redo")).toEqual({ type: "redo" });
    await clearPosted(page);
    await page.keyboard.press("Control+y");
    expect(await awaitPosted(page, "redo")).toEqual({ type: "redo" });
  });

  test("the host's undo answer removes the keystroke, leaves the caret where it was typed, and shows no notice", async ({
    page,
  }) => {
    const { source } = fixture();
    await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
    await caretIn(page, "lists correctly.");
    await page.keyboard.type("!");
    await page.keyboard.press("ControlOrMeta+z");
    await awaitPosted(page, "undo");
    await clearPosted(page);
    await pushToWebview(page, { type: "externalChange", text: liveProse(source), epoch: 2, quiet: true, reveal: true });
    await expect(editable(page)).not.toContainText("correctly.!");
    // The caret lands right where the undone "!" was — typing continues from there.
    await page.keyboard.type("?");
    await expect(editable(page)).toContainText("correctly.?");
    await expect(page.locator(".mdc-banner")).toHaveCount(0);
    await expect(page.locator(".mdc-toast--visible")).toHaveCount(0);
  });

  test("a reveal change scrolls it into view; without reveal, the same change leaves scrollTop alone", async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(LONG), epoch: 1 });
    // ProseMirror's own scrollIntoView only moves the viewport when the view
    // has a real DOM selection to scroll to — exactly the state Cmd+Z is
    // always pressed from, so this focuses the editor first, as a keystroke
    // would, rather than asserting on an editor nothing ever put the caret in.
    await caretIn(page, "Paragraph 60 of");
    const scroller = page.locator(".mdc-editor-scroll");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const atBottom = await scroller.evaluate((el) => el.scrollTop);
    expect(atBottom).toBeGreaterThan(0);

    const changedTop = LONG.replace("Paragraph 1 of", "Paragraph 1 (edited) of");
    await pushToWebview(page, { type: "externalChange", text: liveProse(changedTop), epoch: 2, quiet: true });
    await expect(editable(page)).toContainText("Paragraph 1 (edited)");
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(atBottom);

    const changedTopAgain = changedTop.replace("Paragraph 1 (edited) of", "Paragraph 1 (edited again) of");
    await pushToWebview(page, {
      type: "externalChange",
      text: liveProse(changedTopAgain),
      epoch: 3,
      quiet: true,
      reveal: true,
    });
    await expect(editable(page)).toContainText("Paragraph 1 (edited again)");
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(atBottom);
  });

  test("an externalChange with the text the editor already shows dispatches nothing", async ({ page }) => {
    const { source } = fixture();
    await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
    await caretIn(page, "lists correctly.");
    await pushToWebview(page, { type: "externalChange", text: liveInit(source).text, epoch: 2, quiet: true });
    // Had anything been dispatched, the caret would no longer be exactly
    // where it was typed.
    await page.keyboard.type("!");
    const typed = await spliced(page, source);
    expect(typed.source).toBe(source.replace("correctly.", "correctly.!"));
  });
});

// For a handful of before/after shapes, the editor's document after
// `externalChange` serializes to exactly the pushed text — the character-
// precise replace (or a fallback behind it) always lands on `next`.
const ROUND_TRIP_CASES: Array<{
  label: string;
  before: string;
  after: string;
  ready: (page: Page) => Promise<unknown>;
}> = [
  {
    label: "edit inside a paragraph",
    before: "# T\n\nHello world.\n",
    after: "# T\n\nHello cruel world.\n",
    ready: (page) => expect(editable(page)).toContainText("cruel"),
  },
  {
    label: "insert a paragraph",
    before: "# T\n\nOne.\n",
    after: "# T\n\nOne.\n\nTwo.\n",
    ready: (page) => expect(editable(page)).toContainText("Two."),
  },
  {
    label: "delete a list item",
    before: "# T\n\n- apple\n- banana\n- cherry\n",
    after: "# T\n\n- apple\n- cherry\n",
    ready: (page) => expect(editable(page).locator("li")).toHaveCount(2),
  },
  {
    label: "change a table cell",
    before: "# T\n\n| a   | b   |\n|-----|-----|\n| 1   | 2   |\n",
    after: "# T\n\n| a   | b   |\n|-----|-----|\n| 1   | 99  |\n",
    ready: (page) => expect(editable(page)).toContainText("99"),
  },
  {
    label: "change a heading level",
    before: "# T\n\nBody.\n",
    after: "## T\n\nBody.\n",
    ready: (page) => expect(editable(page).locator("h2")).toHaveCount(1),
  },
];

for (const { label, before, after, ready } of ROUND_TRIP_CASES) {
  test(`round trip: ${label}`, async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(before), epoch: 1 });
    await pushToWebview(page, { type: "externalChange", text: liveProse(after), epoch: 2, quiet: true });
    await ready(page);
    await caretIn(page, "T");
    await page.keyboard.type("!");
    const result = await spliced(page, after);
    expect(result.source).toBe(after.replace("T", "T!"));
  });
}

test.describe("editor-focus", () => {
  test("true on focus, false on blur, false on a switch to Reading", async ({ page }) => {
    const { source } = fixture();
    await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });

    await editable(page).focus();
    expect(await awaitPosted(page, "editor-focus")).toEqual({ type: "editor-focus", focused: true });
    await clearPosted(page);

    await page.locator("#mdc-comments-toggle").click();
    expect(await awaitPosted(page, "editor-focus")).toEqual({ type: "editor-focus", focused: false });
    await clearPosted(page);

    await editable(page).focus();
    expect(await awaitPosted(page, "editor-focus")).toEqual({ type: "editor-focus", focused: true });
    await clearPosted(page);

    // The host switching to Reading rebuilds the editor read-only — focused
    // goes false even though nothing in the page clicked away first.
    await pushToWebview(page, { type: "init", ...liveInit(source), readOnly: true, epoch: 2 });
    expect(await awaitPosted(page, "editor-focus")).toEqual({ type: "editor-focus", focused: false });
  });

  test("nothing in Reading mode", async ({ page }) => {
    const { source } = fixture();
    await bootLiveEditor(page, { ...liveInit(source), readOnly: true, epoch: 1 });
    await editable(page).focus();
    await page.waitForTimeout(100);
    expect((await posted(page)).filter((m) => m.type === "editor-focus")).toEqual([]);
  });
});
