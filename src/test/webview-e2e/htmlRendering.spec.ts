// Raw HTML in the document renders, sanitized, on the review surfaces.
//
// Documents reach for HTML where Markdown has no syntax — `<details>`,
// `<sup>`, `<kbd>`, a centred `<div>`, an HTML table — and every surface used
// to show it as escaped source. Now the allowlisted part renders and the rest
// (a `<script>`, an `on*` handler, a `style`) stays inert, while the markdown
// itself is untouched: these are rendering changes only.

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
  await expect(root.locator("script")).toHaveCount(0);
  await expect(root.locator("[onclick], [onerror], [style*='position']")).toHaveCount(0);
  await expect(root.locator("#threads-list")).toHaveCount(0);
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
