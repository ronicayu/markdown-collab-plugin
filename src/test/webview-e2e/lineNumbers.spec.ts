// Source line numbers in both rendered surfaces.
//
// The numbers must be lines in the .md file, not lines of the rendered prose:
// frontmatter and the stored threads block are stripped before either surface
// sees the text, so a number counted from what is on screen points at the wrong
// place in the user's file. The host supplies the mapping; these specs check
// that what reaches the screen uses it, and that nothing appears when the
// option is off.

import { expect, test } from "@playwright/test";
import { awaitPosted, bootInlineView, bootLiveEditor } from "./harness";
import { liveSidecar } from "./fixtures";

// Two lines of frontmatter plus its fences: "# Title" is line 5 of the file
// but the first line of the prose.
const SOURCE_PROSE = "\n# Title\n\nFirst paragraph.\n\n- a list item\n";
/** What `sourceLineForProseLine` produces for that document. */
const LINE_MAP = [4, 5, 6, 7, 8, 9, 10];

test.describe("inline comments view", () => {
  test("labels blocks with their source line", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: { prose: SOURCE_PROSE, threads: [], suggestions: [], lineMap: LINE_MAP },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    const heading = page.locator("#preview h1");
    await expect(heading).toHaveAttribute("data-mc-srcline", "5");
    await expect(page.locator("#preview p").first()).toHaveAttribute("data-mc-srcline", "7");
    await expect(page.locator("#preview")).toHaveClass(/with-line-numbers/);
  });

  test("shows nothing when the option is off", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: { prose: SOURCE_PROSE, threads: [], suggestions: [] },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("#preview")).not.toHaveClass(/with-line-numbers/);
    await expect(page.locator("#preview [data-mc-srcline]")).toHaveCount(0);
    // The attribute is gated at render, so the markup carries no line data.
    await expect(page.locator("#preview [data-mc-line]")).toHaveCount(0);
  });

  test("numbers only top-level blocks, not every list item", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: {
        prose: "- one\n- two\n- three\n",
        threads: [],
        suggestions: [],
        lineMap: [1, 2, 3, 4],
      },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator("#preview ul[data-mc-srcline]")).toHaveCount(1);
    await expect(page.locator("#preview li[data-mc-srcline]")).toHaveCount(0);
  });
});

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
    const edit = await awaitPosted(page, "edit");
    const serialized = String(edit.text ?? "");
    expect(serialized).toContain("# Title");
    // A stray "5" or "7" on its own line would mean a decoration leaked in.
    expect(serialized).not.toMatch(/^\s*\d+\s*$/m);
  });
});
