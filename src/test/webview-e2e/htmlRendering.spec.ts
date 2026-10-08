// Raw HTML in the document renders, sanitized, on the review surfaces.
//
// Documents reach for HTML where Markdown has no syntax — `<details>`,
// `<sup>`, `<kbd>`, a centred `<div>`, an HTML table — and every surface used
// to show it as escaped source. Now the allowlisted part renders and the rest
// (a `<script>`, an `on*` handler) stays inert, while the markdown itself is
// untouched: these are rendering changes only. A complete HTML block renders
// in a contained shadow root with its own CSS as written; the containment
// tests at the end are what make that safe.

import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, bootInlineView, bootLiveEditor } from "./harness";
import { inlineInit, liveInit } from "./fixtures";

const DOC = `# Probe

Inline: x<sup>2</sup> and <kbd>Ctrl</kbd>+<kbd>C</kbd>, <!-- a note --> end.

<details>
<summary>More details</summary>

Hidden **markdown** body.

</details>

<div align="center">
  <b>Centered</b> text
</div>

<table><tr><td>Cell A</td><td>Cell B</td></tr></table>

<table style="border-collapse:collapse"><tr><td style="background:#d1f2d9;padding:8px 12px">Green</td><td>Plain</td></tr></table>

<div style="position:fixed; color:rgb(200, 0, 0)" onclick="alert(1)" class="mdc-sidebar" id="threads-list">styled</div>

<script>alert(1)</script>

<a href="https://example.com/docs">a link</a>
`;

const editor = (page: Page) => page.locator(".mdc-editor-root .milkdown");

async function noUnsafeDom(root: import("@playwright/test").Locator): Promise<void> {
  // Locators pierce open shadow roots, so this covers shadow-rendered blocks too.
  await expect(root.locator("script")).toHaveCount(0);
  await expect(root.locator("[onclick], [onerror]")).toHaveCount(0);
  // The document's `id="threads-list"` is kept, but inside a shadow root: the
  // page's own lookups can't see it, so it can't shadow the app's element.
  const leaked = await root.page().evaluate(() => !!document.getElementById("threads-list")?.closest(".mdc-html, #preview"));
  expect(leaked).toBe(false);
}

test.describe("live editor, Reading", () => {
  test.beforeEach(async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(DOC), readOnly: true });
  });

  test("inline tag pairs render as formatting, and their tags disappear", async ({ page }) => {
    await expect(editor(page).locator("sup")).toHaveText("2");
    await expect(editor(page).locator("kbd")).toHaveText(["Ctrl", "C"]);
    // innerText, not textContent: the tag nodes are still in the DOM, hidden.
    const shown = await editor(page).locator("p").filter({ hasText: "Inline:" }).evaluate((el) => (el as HTMLElement).innerText);
    expect(shown).toContain("x2 and Ctrl+C");
    expect(shown).not.toContain("<");
  });

  test("an HTML comment shows nothing", async ({ page }) => {
    const shown = await editor(page).evaluate((el) => (el as HTMLElement).innerText);
    expect(shown).not.toContain("a note");
  });

  test("details, a centred div and an HTML table render", async ({ page }) => {
    await expect(editor(page).locator("details summary")).toHaveText("More details");
    await expect(editor(page)).toContainText("Hidden markdown body.");
    await expect(editor(page)).not.toContainText("</details>");
    await expect(editor(page).locator('div[align="center"] b')).toHaveText("Centered");
    await expect(editor(page).locator(".mdc-html table td")).toHaveText(["Cell A", "Cell B", "Green", "Plain"]);
    const green = editor(page).locator(".mdc-html td", { hasText: "Green" });
    await expect(green).toHaveCSS("background-color", "rgb(209, 242, 217)");
    await expect(green).toHaveCSS("color", "rgb(31, 35, 40)");
    await expect(editor(page).locator(".mdc-html td", { hasText: "Plain" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("unsafe HTML stays inert", async ({ page }) => {
    await noUnsafeDom(editor(page));
    // Stripped attributes, kept content.
    await expect(editor(page).locator(".mdc-html div").filter({ hasText: "styled" })).toHaveCount(1);
    await expect(editor(page).locator(".mdc-html div").filter({ hasText: "styled" })).toHaveCSS("color", "rgb(200, 0, 0)");
    // A script stays visible as its source, so the reviewer still sees it.
    await expect(editor(page)).toContainText("<script>alert(1)</script>");
  });

  test("a link in raw HTML is a real link, opened through the host", async ({ page }) => {
    await editor(page).locator('a[href="https://example.com/docs"]').click();
    expect(await awaitPosted(page, "open-link")).toMatchObject({ type: "open-link", href: "https://example.com/docs" });
  });
});

test.describe("live editor, Editing", () => {
  test("inline tags stay visible, so they can't be deleted unseen", async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(DOC), readOnly: false });
    await expect(editor(page).locator("sup")).toHaveText("2");
    await expect(editor(page).locator(".mdc-html-tag").first()).toBeVisible();
    await expect(editor(page)).toContainText("<!-- a note -->");
    await noUnsafeDom(editor(page));
  });

  test("editing the paragraph around inline HTML keeps every tag", async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(DOC), readOnly: false });
    // Click the paragraph's first word, not its middle: a click on a tag chip
    // selects that whole node, and typing would replace it (as with any atom).
    await editor(page).locator("p").filter({ hasText: "Inline:" }).click({ position: { x: 4, y: 8 } });
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest(".milkdown")))
      .toBe(true);
    await page.keyboard.type("!");
    const edit = await awaitPosted(page, "edit-blocks");
    const serialized = (edit.edits as Array<{ markdown: string }>).map((e) => e.markdown).join("\n\n");
    // Wherever in the first word the "!" landed, every tag around it survived.
    expect(serialized).toContain("!");
    expect(serialized.replace("!", "")).toContain("Inline: x<sup>2</sup> and <kbd>Ctrl</kbd>+<kbd>C</kbd>, <!-- a note --> end.");
  });
});

test.describe("inline comments view", () => {
  test("renders the same HTML, sanitized", async ({ page }) => {
    await bootInlineView(page, inlineInit(DOC));
    const preview = page.locator("#preview");
    await expect(preview.locator("sup")).toHaveText("2");
    await expect(preview.locator("kbd")).toHaveText(["Ctrl", "C"]);
    // markdown-it keeps the blocks between <details> and </details> inside it.
    await expect(preview.locator("details summary")).toHaveText("More details");
    await expect(preview.locator("details")).toContainText("Hidden markdown body.");
    await expect(preview.locator("table td")).toHaveText(["Cell A", "Cell B", "Green", "Plain"]);
    await expect(preview).not.toContainText("a note");
    await noUnsafeDom(preview);
    await expect(preview).toContainText("<script>alert(1)</script>");
  });
});

// A document's own CSS, at its most hostile: a full-window overlay on the
// fragment and on its shadow host (`:host … !important` outranks any outside
// rule on the host itself), and rules aimed at the app's own classes.
const HOSTILE = `# Hostile

<style>
:host { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; background: red !important; }
.mdc-sidebar, #mdc-sidebar, #find-bar, button { display: none !important; }
.card { background: rgb(1, 2, 3); color: rgb(250, 250, 250); padding: 6px; }
</style>
<div class="card">styled card</div>
<div style="position:fixed; inset:0; z-index:2147483647; background:rgba(255,0,0,.5)">overlay</div>

After the block.
`;

/** Whether the element under the centre of `selector` is that element (or inside it). */
async function receivesPointer(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  }, selector);
}

/** The hostile `:host` rule really applies: the block's shadow host is fixed, full-window. */
async function hostileHostApplies(page: Page): Promise<void> {
  const position = await page.evaluate(() => {
    const host = document.querySelector(".mdc-html-shadow")?.firstElementChild;
    return host ? getComputedStyle(host).position : null;
  });
  expect(position).toBe("fixed");
}

test.describe("shadow-rendered blocks are contained", () => {
  test("live editor: the block's CSS styles the block and nothing else", async ({ page }) => {
    await bootLiveEditor(page, { ...liveInit(HOSTILE), readOnly: true });
    await expect(editor(page).locator(".card")).toHaveCSS("background-color", "rgb(1, 2, 3)");
    // The <style> sits in a block of its own and still styles the card's block.
    await hostileHostApplies(page);
    // The app's controls are still shown, and still the thing under the pointer.
    await expect(page.locator("#edit-mode-toggle")).toBeVisible();
    await expect(page.locator("#mdc-comments-toggle")).toBeVisible();
    expect(await receivesPointer(page, "#edit-mode-toggle")).toBe(true);
    expect(await receivesPointer(page, "#mdc-comments-toggle")).toBe(true);
    // Text after the block is still reachable too.
    expect(await receivesPointer(page, ".mdc-editor-root .milkdown h1")).toBe(true);
  });

  test("inline comments view: same containment, and find searches inside the block", async ({ page }) => {
    await bootInlineView(page, inlineInit(HOSTILE));
    await expect(page.locator("#preview .card")).toHaveCSS("background-color", "rgb(1, 2, 3)");
    await hostileHostApplies(page);
    expect(await receivesPointer(page, "#outline-toggle")).toBe(true);
    expect(await receivesPointer(page, "#preview h1")).toBe(true);
    await page.locator("#preview").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator("#find-bar")).toBeVisible();
    await page.locator("#find-input").fill("styled card");
    await expect(page.locator("#find-count")).toHaveText("1 / 1");
    await expect(page.locator("#preview mark.mc-search--current")).toHaveText("styled card");
  });
});
