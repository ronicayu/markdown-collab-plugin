// Source line numbers in the review view (the live editor).
//
// The numbers must be lines in the .md file, not lines of the rendered prose:
// frontmatter and the stored threads block are stripped before the view
// sees the text, so a number counted from what is on screen points at the wrong
// place in the user's file. The host supplies the mapping; these specs check
// that what reaches the screen uses it, and that nothing appears when the
// option is off.

import { expect, test } from "@playwright/test";
import { awaitPosted, bootLiveEditor } from "./harness";
import { liveSidecar } from "./fixtures";

test.describe("live editor", () => {
  test("puts a source line number beside each top-level block", async ({ page }) => {
    const text = "# Title\n\nFirst paragraph.\n";
    await bootLiveEditor(page, {
      text,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(text),
      frontmatter: "---\ntitle: T\n---",
      imageBaseUris: { docDir: "", workspaceFolder: null },
      // Frontmatter occupies lines 1-3, so the prose starts at line 5.
      lineMap: [5, 6, 7, 8],
    });
    const numbers = page.locator(".mdc-line-number");
    await expect(numbers).toHaveCount(2);
    await expect(numbers.nth(0)).toHaveText("5");
    await expect(numbers.nth(1)).toHaveText("7");
    await expect(page.locator(".mdc-editor-root")).toHaveClass(/with-line-numbers/);
  });

  test("shows no numbers when the option is off", async ({ page }) => {
    const text = "# Title\n\nBody.\n";
    await bootLiveEditor(page, {
      text,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(text),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator(".mdc-line-number")).toHaveCount(0);
    await expect(page.locator(".mdc-editor-root")).not.toHaveClass(/with-line-numbers/);
  });

  test("numbers only top-level blocks, not every list item", async ({ page }) => {
    const text = "- one\n- two\n- three\n";
    await bootLiveEditor(page, {
      text,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(text),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
      lineMap: [1, 2, 3, 4],
    });
    const numbers = page.locator(".mdc-line-number");
    await expect(numbers).toHaveCount(1);
    await expect(numbers.nth(0)).toHaveText("1");
  });

  test("turns the gutter on and off without a reload", async ({ page }) => {
    const text = "# Title\n\nBody.\n";
    await bootLiveEditor(page, {
      text,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(text),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator(".mdc-line-number")).toHaveCount(0);
    await page.evaluate(() =>
      window.postMessage({ type: "line-map", lineMap: [1, 2, 3, 4] }, "*"),
    );
    await expect(page.locator(".mdc-line-number")).toHaveCount(2);
    await page.evaluate(() => window.postMessage({ type: "line-map" }, "*"));
    await expect(page.locator(".mdc-line-number")).toHaveCount(0);
  });

  test("numbers never reach the markdown the host is sent", async ({ page }) => {
    const text = "# Title\n\nBody.\n";
    await bootLiveEditor(page, {
      text,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(text),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
      lineMap: [1, 2, 3, 4],
    });
    await expect(page.locator(".mdc-line-number")).toHaveCount(2);
    // Decorations are not document content; typing must not serialize them.
    await page.locator(".milkdown .ProseMirror").click();
    // ProseMirror takes focus asynchronously — typing before it lands goes
    // nowhere and no edit is ever posted.
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest(".milkdown")))
      .toBe(true);
    await page.keyboard.type("x");
    // Edit mode posts the blocks the keystroke changed, each serialized,
    // not the whole document.
    const edit = await awaitPosted(page, "edit-blocks");
    // The gutter's widgets are decorations, not nodes: the host is told about
    // exactly the document's two blocks.
    expect(edit.baseTypes).toEqual(["heading", "paragraph"]);
    const serialized = (edit.edits as Array<{ markdown: string }>).map((e) => e.markdown).join("\n\n");
    expect(serialized).toContain("x");
    // A stray "5" or "7" on its own line would mean a decoration leaked in.
    expect(serialized).not.toMatch(/^\s*\d+\s*$/m);
  });
});
