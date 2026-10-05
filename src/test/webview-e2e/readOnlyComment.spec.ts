// Gate 2, end to end: in the read-only live editor,
// select text, add a comment, and the file changes by exactly two markers (and
// the thread's record) — on every document the one-view spike used.
//
// The edit-mode path posts the editor's whole serialization and the host
// adopts it as the new body, which rewrote 9–62 prose lines per comment in the
// spike. Read-only posts a prose span instead; the host inserts the markers
// into the file's own bytes. This spec drives the shipped bundle's selection
// and composer, then runs the host op on what it posted.
//
// Also here: the read-only drag-selection bug the spike found ("Su" for
// "Suggest"), and the refusals.

import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, bootLiveEditor, clearPosted, posted, pushToWebview } from "./harness";
import { liveInit, liveSidecar, reviewFixture } from "./fixtures";
import { addThreadAtProseRange } from "../../collab/inlineBridge";
import { parse, stripAllInlineMarkup } from "../../inlineComments/format";
import { oneViewCorpus, onlyMarkersAdded } from "../support/oneViewCorpus";

const COMMENT = { author: "ronica", body: "gate 2", ts: "2026-09-29T00:00:00.000Z" };

/**
 * Pick up to one selection of each shape the editor renders — a plain word, a
 * word inside emphasis/strong/a link, a table cell, a list item, a heading,
 * and a drag from plain text into markup. Returns each target's kind and
 * text; with `select`, also makes that target the document's DOM selection,
 * the way a mouse selection lands.
 *
 * Re-run for every selection rather than keeping Range objects: a highlight
 * decoration re-renders its paragraph, and a Range into the old text nodes
 * would select whatever they've become.
 */
async function targets(page: Page, select = -1): Promise<Array<{ kind: string; text: string }>> {
  return page.evaluate((index) => {
    const root = document.querySelector<HTMLElement>(".ProseMirror")!;
    const inWidget = (el: Element): boolean =>
      !!el.closest("pre, code, .mdc-line-number") ||
      (el.closest('[contenteditable="false"]') ?? root) !== root;
    const word = /[A-Za-z]{3,}/;
    const kinds: Array<[string, (el: Element) => boolean]> = [
      ["plain", (el) => el.matches(".ProseMirror p")],
      ["markup", (el) => el.matches("strong, em, a, del")],
      ["table", (el) => !!el.closest("td, th")],
      ["list", (el) => !!el.closest("li")],
      ["heading", (el) => !!el.closest("h1, h2, h3, h4, h5, h6")],
    ];
    const targets: Array<{ kind: string; range: Range }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    for (const [kind, matches] of kinds) {
      for (const t of texts) {
        const el = t.parentElement!;
        if (inWidget(el) || !matches(el)) continue;
        const m = word.exec(t.data);
        if (!m) continue;
        const range = document.createRange();
        range.setStart(t, m.index);
        range.setEnd(t, m.index + m[0].length);
        targets.push({ kind, range });
        break;
      }
    }
    // A drag that starts in plain text and ends inside the markup after it.
    for (const t of texts) {
      const next = t.nextSibling;
      if (inWidget(t.parentElement!) || !t.parentElement!.matches(".ProseMirror p")) continue;
      if (!(next instanceof HTMLElement) || !next.matches("strong, em, a")) continue;
      const inner = next.firstChild;
      const tail = /([A-Za-z]{3,})\s*$/.exec(t.data);
      if (!(inner instanceof Text) || !tail || !word.test(inner.data)) continue;
      const range = document.createRange();
      range.setStart(t, tail.index);
      range.setEnd(inner, Math.min(inner.data.length, word.exec(inner.data)!.index + 3));
      targets.push({ kind: "across-markup", range });
      break;
    }
    const chosen = targets[index];
    if (chosen) {
      (chosen.range.startContainer.parentElement as HTMLElement).scrollIntoView({ block: "center" });
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(chosen.range);
    }
    return targets.map((t) => ({ kind: t.kind, text: t.range.toString() }));
  }, select);
}

/** Open the composer from the floating button, save a comment, return what was posted. */
async function commentOnSelection(page: Page): Promise<Record<string, unknown>> {
  const addBtn = page.locator(".mdc-add-comment-btn");
  await expect(addBtn).toBeVisible();
  await addBtn.click();
  const composer = page.locator(".mdc-composer-slot .mc-composer");
  await composer.locator("textarea").fill(COMMENT.body);
  await composer.getByRole("button", { name: "Save" }).click();
  const msg = await awaitPosted(page, "add-comment");
  await clearPosted(page);
  await pushToWebview(page, { type: "add-comment-result", ok: true });
  return msg;
}

const trimEof = (s: string): string => s.replace(/\n+$/, "");

for (const doc of oneViewCorpus()) {
  test(`a read-only comment adds only its markers: ${doc.name}`, async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(doc.source), readOnly: true });
    const before = doc.source;
    const parsedBefore = parse(before);
    const count = (await targets(page)).length;
    expect(count, "no selectable text found").toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const { kind, text } = (await targets(page, i))[i]!;
      const msg = await commentOnSelection(page);
      // The read-only message: a prose span and its text, no serialized body.
      expect(msg.fullMd, kind).toBeUndefined();
      expect((msg.anchor as { text: string }).text, kind).toBe(text.trim());

      const r = addThreadAtProseRange(
        before,
        { start: msg.proseStart as number, end: msg.proseEnd as number, text: msg.proseText as string },
        COMMENT,
      );
      expect(r, `${kind} "${text}"`).toMatchObject({ ok: true });
      const after = (r as { source: string }).source;
      const thread = parse(after).threads.find((t) => !parsedBefore.threads.some((b) => b.id === t.id))!;
      expect(onlyMarkersAdded(before, after, thread.id), `${kind} "${text}"`).toEqual([]);
      if (parsedBefore.threadsRegion) {
        expect(stripAllInlineMarkup(after)).toBe(stripAllInlineMarkup(before));
      } else {
        // Up to the blank line the format puts before a new threads block.
        expect(trimEof(stripAllInlineMarkup(after))).toBe(trimEof(stripAllInlineMarkup(before)));
      }

      // Round trip: the new thread's highlight covers exactly what was selected.
      await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(after) });
      const marks = page.locator(`.mdc-anchor-highlight[data-comment-id="${thread.id}"]`);
      await expect(marks.first()).toBeVisible();
      expect((await marks.allTextContents()).join(""), `${kind} highlight`).toBe(text.trim());
      await pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(before) });
    }
  });
}

test("a mouse drag in the read-only editor selects the whole word", async ({ page }) => {
  // The spike's bug: the floating button appeared mid-drag under the pointer,
  // the native selection followed it out of the editor, and the comment was
  // anchored to "Su". A drag in small steps is what triggered it.
  await bootLiveEditor(page, { ...liveInit(reviewFixture().source), readOnly: true });
  const box = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll(".milkdown p")).find((x) => x.textContent!.startsWith("Suggest"))!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 0);
    r.setEnd(p.firstChild!, "Suggest".length);
    const b = r.getBoundingClientRect();
    return { x: b.left, y: b.top + b.height / 2, w: b.width };
  });
  await page.mouse.move(box.x + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 1, box.y, { steps: 8 });
  // Not while the button is held: it would sit under the pointer.
  await expect(page.locator(".mdc-add-comment-btn")).toBeHidden();
  await page.mouse.up();

  await expect(page.locator(".mdc-add-comment-btn")).toBeVisible();
  await page.locator(".mdc-add-comment-btn").click();
  await expect(page.locator(".mdc-composer-slot .mc-composer__meta")).toHaveText("Commenting on: Suggest");
  const composer = page.locator(".mdc-composer-slot .mc-composer");
  await composer.locator("textarea").fill("Which setting?");
  await composer.getByRole("button", { name: "Save" }).click();
  const msg = await awaitPosted(page, "add-comment");
  expect(msg.proseText).toBe("Suggest");
});

test("the read-only editor refuses a selection inside code, before the composer opens", async ({ page }) => {
  const source = "# Setup\n\nRun the tests first.\n\n```sh\nnpm test\n```\n";
  await bootLiveEditor(page, { ...liveInit(source), readOnly: true });
  await page.evaluate(() => {
    const code = document.querySelector(".milkdown pre code")!;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode() as Text;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
  });
  await page.locator(".mdc-add-comment-btn").click();
  await expect(page.locator(".mdc-toast")).toContainText("can't be anchored inside code");
  await expect(page.locator(".mdc-composer-slot .mc-composer")).toHaveCount(0);
});

test("typing in the read-only editor changes nothing and posts no edit", async ({ page }) => {
  const fixture = reviewFixture();
  await bootLiveEditor(page, { ...liveInit(fixture.source), readOnly: true });
  await page.locator(".milkdown p").first().click();
  await page.keyboard.type("XYZ");
  await page.keyboard.press("Enter");
  await expect(page.locator(".milkdown")).not.toContainText("XYZ");
  // The edit debounce is 250 ms; give it time to (not) fire.
  await page.waitForTimeout(400);
  expect((await posted(page)).filter((m) => m.type === "edit" || m.type === "edit-blocks")).toEqual([]);
});
