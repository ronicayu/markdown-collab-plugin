// The table-of-contents panel in both rendered surfaces.

import { expect, test } from "@playwright/test";
import { bootInlineView, bootLiveEditor } from "./harness";
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

test.describe("inline comments view", () => {
  test.beforeEach(async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: { prose: DOC, threads: [], suggestions: [] },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
  });

  test("is hidden until asked for, then lists the headings nested", async ({ page }) => {
    await expect(page.locator("#outline-pane")).toBeHidden();
    await page.locator("#outline-toggle").click();
    await expect(page.locator("#outline-pane")).toBeVisible();

    const rows = page.locator(".mc-outline__row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator(".mc-outline__label")).toHaveText("Guide");
    await expect(rows.nth(1).locator(".mc-outline__label")).toHaveText("Setup");
    // Depth is what conveys nesting.
    await expect(rows.nth(1)).toHaveAttribute("style", /--mc-outline-depth: 1/);
    await expect(rows.nth(2)).toHaveAttribute("style", /--mc-outline-depth: 2/);
  });

  test("collapsing a section hides its children but keeps the section", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    const setupRow = page.locator(".mc-outline__row", { hasText: "Setup" }).first();
    await setupRow.locator(".mc-outline__twisty").click();

    await expect(page.locator(".mc-outline__row", { hasText: "Prerequisites" })).toHaveCount(0);
    await expect(setupRow).toBeVisible();
    await expect(page.locator(".mc-outline__row")).toHaveCount(3);
  });


  test("a leaf heading has no expander to click", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    const leaf = page.locator(".mc-outline__row", { hasText: "Prerequisites" }).first();
    await expect(leaf.locator(".mc-outline__twisty--leaf")).toHaveCount(1);
  });

});

// Separate describe: these boot their own document, and booting twice in one
// page re-injects the client bundle (`__mcState already declared`).
test.describe("inline comments view — other documents", () => {
  test("clicking a heading scrolls the preview to it", async ({ page }) => {
    // A document short enough to fit the viewport cannot scroll, and the
    // assertion would be measuring a no-op.
    const filler = Array.from({ length: 60 }, (_, i) => `Filler line ${i}.`).join("\n\n");
    await bootInlineView(page, {
      fileName: "long.md",
      state: {
        prose: `# Guide\n\n${filler}\n\n## Usage\n\nAt the bottom.\n`,
        threads: [],
        suggestions: [],
      },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await page.locator("#outline-toggle").click();
    await page.locator(".mc-outline__row", { hasText: "Usage" }).first().click();
    // The pane scrolls, and the heading ends up on screen. Not "at the top":
    // the last heading in a document cannot reach the top, because the pane
    // runs out of content to scroll past and stops at its limit.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const pane = document.getElementById("preview-pane")!;
          const usage = Array.from(pane.querySelectorAll("h2")).find(
            (h) => h.textContent === "Usage",
          )!;
          const paneBox = pane.getBoundingClientRect();
          const top = usage.getBoundingClientRect().top - paneBox.top;
          return { scrolled: pane.scrollTop > 100, visible: top >= 0 && top < paneBox.height };
        }),
      )
      .toEqual({ scrolled: true, visible: true });
  });

  test("says what to do when the document has no headings", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: { prose: "Just prose, no headings.\n", threads: [], suggestions: [] },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await page.locator("#outline-toggle").click();
    await expect(page.locator(".mc-outline__empty")).toContainText("Add one with #");
  });

  test("ignores a heading inside a code fence", async ({ page }) => {
    await bootInlineView(page, {
      fileName: "doc.md",
      state: {
        prose: "# Real\n\n```sh\n# not a heading\n```\n",
        threads: [],
        suggestions: [],
      },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await page.locator("#outline-toggle").click();
    await expect(page.locator(".mc-outline__row")).toHaveCount(1);
  });
});

// The bug this file did not catch the first time: `#app` is a grid with a
// fixed column list, and adding the outline as a third child auto-placed every
// pane one slot across — outline in the 1fr column, preview squeezed into the
// 360px comments column, comments wrapped onto a second row. Every structural
// assertion above still passed, because the rows and clicks were all present
// and correct. Only the geometry was wrong, so the geometry is asserted here.
test.describe("layout", () => {
  const boot = async (page: import("@playwright/test").Page): Promise<void> => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await bootInlineView(page, {
      fileName: "doc.md",
      state: { prose: DOC, threads: [], suggestions: [] },
      user: { name: "r" },
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
  };

  const widths = (page: import("@playwright/test").Page) =>
    page.evaluate(() => ({
      outline: Math.round(document.getElementById("outline-pane")!.getBoundingClientRect().width),
      preview: Math.round(document.getElementById("preview-pane")!.getBoundingClientRect().width),
      threads: Math.round(document.getElementById("threads-pane")!.getBoundingClientRect().width),
    }));

  test("the preview keeps most of the width when the outline opens", async ({ page }) => {
    await boot(page);
    const before = await widths(page);
    expect(before.threads).toBe(360);

    await page.locator("#outline-toggle").click();
    const after = await widths(page);

    // The outline takes its own column; the preview gives up that much and
    // stays the widest pane. The comments pane is untouched.
    expect(after.threads).toBe(360);
    expect(after.outline).toBeGreaterThan(100);
    expect(after.preview).toBeGreaterThan(after.outline);
    expect(after.preview).toBeGreaterThan(before.preview - after.outline - 40);
  });

  test("every pane stays on one row", async ({ page }) => {
    await boot(page);
    await page.locator("#outline-toggle").click();
    // Grid auto-placement pushed the comments pane onto a second row, which is
    // invisible to a width check but obvious as a vertical offset.
    const tops = await page.evaluate(() =>
      ["outline-pane", "preview-pane", "threads-pane"].map((id) =>
        Math.round(document.getElementById(id)!.getBoundingClientRect().top),
      ),
    );
    expect(new Set(tops).size).toBe(1);
  });

  test("closing the outline gives the width back", async ({ page }) => {
    await boot(page);
    const before = await widths(page);
    await page.locator("#outline-toggle").click();
    await page.locator("#outline-toggle").click();
    expect(await widths(page)).toEqual(before);
  });
});

test.describe("live editor", () => {
  test("toggles an outline listing the document's headings", async ({ page }) => {
    await bootLiveEditor(page, {
      text: DOC,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(DOC),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
    await expect(page.locator(".mdc-outline-pane")).toBeHidden();
    await page.locator("[data-action='toggle-outline']").click();
    await expect(page.locator(".mdc-outline-pane")).toBeVisible();

    const rows = page.locator(".mc-outline__row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator(".mc-outline__label")).toHaveText("Guide");
    await expect(rows.nth(3).locator(".mc-outline__label")).toHaveText("Usage");
  });

  test("the editor keeps its width and every pane stays on one row", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await bootLiveEditor(page, {
      text: DOC,
      user: { name: "r", color: "#fff" },
      ...liveSidecar(DOC),
      frontmatter: "",
      imageBaseUris: { docDir: "", workspaceFolder: null },
    });
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
