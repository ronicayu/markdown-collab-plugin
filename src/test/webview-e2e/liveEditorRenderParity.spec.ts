// Rendering-parity gaps between the live (Milkdown) editor and the review
// view, closed per docs/spike-one-view.md section A: PlantUML fences, hiding
// a mermaid fence's source once it renders (reappearing on error), task-list
// checkboxes, and inline `<br>`. The suggestion-highlight gap and the drawio
// `![alt](x.drawio)` image-syntax gap have their own homes — the fixture they
// need already exists in liveEditor.spec.ts and drawioRender.spec.ts.

import { expect, test } from "@playwright/test";
import { bootLiveEditor } from "./harness";
import { liveInit } from "./fixtures";
import { encodeAsHex } from "../../plantumlPlugin";

test("a PlantUML fence renders as an image via the configured server, source hidden", async ({ page }) => {
  const source = "# Doc\n\n```plantuml\nAlice -> Bob: hi\n```\n";
  await bootLiveEditor(page, liveInit(source));

  const widget = page.locator(".mdc-plantuml");
  await expect(widget).toHaveCount(1);
  const img = widget.locator("img");
  await expect(img).toHaveCount(1);
  const expectedUrl = `https://www.plantuml.com/plantuml/svg/~h${encodeAsHex("Alice -> Bob: hi")}`;
  await expect(img).toHaveAttribute("src", expectedUrl);

  // The fence's raw source is still in the doc (still a normal, editable
  // code_block — this is a decoration, not a rewrite) but not shown, matching
  // the review view's plain <figure><img> with no visible fence.
  const sourcePre = page.locator('pre[data-language="plantuml"]');
  await expect(sourcePre).toHaveCount(1);
  await expect(sourcePre).toBeHidden();
});

test("an empty PlantUML fence doesn't request a diagram", async ({ page }) => {
  await bootLiveEditor(page, liveInit("# Doc\n\n```plantuml\n```\n"));
  await expect(page.locator(".mdc-plantuml")).toContainText("empty plantuml block");
  await expect(page.locator(".mdc-plantuml img")).toHaveCount(0);
});

test("a mermaid diagram renders and its fence source is hidden once it does", async ({ page }) => {
  await bootLiveEditor(page, liveInit("# Doc\n\n```mermaid\ngraph TD\nA-->B\n```\n"));

  const widget = page.locator(".mdc-mermaid");
  await expect(widget.locator("svg")).toBeVisible({ timeout: 15_000 });

  const source = page.locator('pre[data-language="mermaid"]');
  await expect(source).toHaveCount(1);
  await expect(source).toBeHidden();
});

test("an invalid mermaid diagram shows the error AND keeps its source visible", async ({ page }) => {
  await bootLiveEditor(page, liveInit("# Doc\n\n```mermaid\nthis is not a diagram at all {{{\n```\n"));

  await expect(page.locator(".mdc-mermaid__error")).toBeVisible({ timeout: 15_000 });
  // Unlike the success case, the source must stay reachable so the author can
  // fix it — this is the one place the fence and its (failed) render both show.
  await expect(page.locator('pre[data-language="mermaid"]')).toBeVisible();
});

test("a task-list item shows a checkbox reflecting [ ] / [x], and clicking it toggles", async ({ page }) => {
  await bootLiveEditor(page, liveInit("# Doc\n\n- [ ] todo one\n- [x] todo two\n"));

  const items = page.locator('li[data-item-type="task"]');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-checked", "false");
  await expect(items.nth(1)).toHaveAttribute("data-checked", "true");

  // Click near the left edge — the rendered checkbox glyph — not the text.
  await items.nth(0).click({ position: { x: 5, y: 8 } });
  await expect(items.nth(0)).toHaveAttribute("data-checked", "true");
});

test("clicking a task item's text (not the checkbox) does not toggle it", async ({ page }) => {
  await bootLiveEditor(page, liveInit("# Doc\n\n- [ ] todo one\n"));
  const item = page.locator('li[data-item-type="task"]');
  await item.click({ position: { x: 60, y: 8 } });
  await expect(item).toHaveAttribute("data-checked", "false");
});

test("an inline <br> renders as a line break instead of disappearing", async ({ page }) => {
  await bootLiveEditor(page, liveInit("# Doc\n\nLine one<br>Line two\n"));

  const editor = page.locator(".mdc-editor-root .milkdown");
  await expect(editor.locator("p br")).toHaveCount(1);
  await expect(editor).toContainText("Line one");
  await expect(editor).toContainText("Line two");
});

test("a <br> alone in its own paragraph is still dropped (empty-line placeholder, unchanged)", async ({ page }) => {
  // Not a real-world input (nothing writes this except Milkdown's own
  // serializer, as a placeholder for a blank line) but pins that the fix is
  // scoped to inline <br> and doesn't regress the placeholder round-trip: the
  // paragraph parses empty, same as before this change.
  await bootLiveEditor(page, liveInit("# Doc\n\n<br>\n\nAfter.\n"));
  const editor = page.locator(".mdc-editor-root .milkdown");
  // ProseMirror renders every empty block with its own cursor-placement
  // `<br class="ProseMirror-trailingBreak">` — that's unrelated UI, not a
  // hardbreak node, so it's excluded here rather than asserting zero <br>s.
  await expect(editor.locator("br:not(.ProseMirror-trailingBreak)")).toHaveCount(0);
  await expect(editor).toContainText("After.");
});
