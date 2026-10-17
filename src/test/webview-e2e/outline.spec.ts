// The table-of-contents panel in the review view (the live editor).

import { expect, test } from "@playwright/test";
import { bootLiveEditor } from "./harness";
import { liveSidecar } from "./fixtures";

const DOC = `# Guide

Intro prose.

## Setup

Steps here.

### Prerequisites

Details.

## Usage

More prose.
`;

async function boot(page: import("@playwright/test").Page, text: string): Promise<void> {
  await bootLiveEditor(page, {
    text,
    user: { name: "r", color: "#fff" },
    ...liveSidecar(text),
    frontmatter: "",
    imageBaseUris: { docDir: "", workspaceFolder: null },
  });
}

test.describe("live editor", () => {
  test("toggles an outline listing the document's headings", async ({ page }) => {
    await boot(page, DOC);
    await expect(page.locator(".mdc-outline-pane")).toBeHidden();
    await page.locator("[data-action='toggle-outline']").click();
    await expect(page.locator(".mdc-outline-pane")).toBeVisible();

    const rows = page.locator(".mc-outline__row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator(".mc-outline__label")).toHaveText("Guide");
    await expect(rows.nth(3).locator(".mc-outline__label")).toHaveText("Usage");
    // Depth is what conveys nesting.
    await expect(rows.nth(1)).toHaveAttribute("style", /--mc-outline-depth: 1/);
    await expect(rows.nth(2)).toHaveAttribute("style", /--mc-outline-depth: 2/);
  });

  test("collapsing a section hides its children but keeps the section", async ({ page }) => {
    await boot(page, DOC);
    await page.locator("[data-action='toggle-outline']").click();
    const setupRow = page.locator(".mc-outline__row", { hasText: "Setup" }).first();
    await setupRow.locator(".mc-outline__twisty").click();

    await expect(page.locator(".mc-outline__row", { hasText: "Prerequisites" })).toHaveCount(0);
    await expect(setupRow).toBeVisible();
    await expect(page.locator(".mc-outline__row")).toHaveCount(3);
  });

  test("a leaf heading has no expander to click", async ({ page }) => {
    await boot(page, DOC);
    await page.locator("[data-action='toggle-outline']").click();
    const leaf = page.locator(".mc-outline__row", { hasText: "Prerequisites" }).first();
    await expect(leaf.locator(".mc-outline__twisty--leaf")).toHaveCount(1);
  });

  test("says what to do when the document has no headings", async ({ page }) => {
    await boot(page, "Just prose, no headings.\n");
    await page.locator("[data-action='toggle-outline']").click();
    await expect(page.locator(".mc-outline__empty")).toContainText("Add one with #");
  });

  test("ignores a heading inside a code fence", async ({ page }) => {
    await boot(page, "# Real\n\n```sh\n# not a heading\n```\n");
    await page.locator("[data-action='toggle-outline']").click();
    await expect(page.locator(".mc-outline__row")).toHaveCount(1);
  });

  test("the editor keeps its width and every pane stays on one row", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await boot(page, DOC);
    await page.locator("[data-action='toggle-outline']").click();
    const box = await page.evaluate(() => {
      const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      return {
        outline: Math.round(rect(".mdc-outline-pane").width),
        editor: Math.round(rect(".mdc-editor-pane").width),
        tops: [".mdc-outline-pane", ".mdc-editor-pane", ".mdc-sidebar"].map((s) =>
          Math.round(rect(s).top),
        ),
      };
    });
    expect(box.outline).toBeGreaterThan(100);
    expect(box.editor).toBeGreaterThan(box.outline);
    expect(new Set(box.tops).size).toBe(1);
  });
});
