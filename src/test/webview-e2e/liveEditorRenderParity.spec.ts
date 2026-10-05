// Rendering-parity gaps between the live (Milkdown) editor and the review
// view, closed: PlantUML fences, hiding
// a mermaid fence's source once it renders (reappearing on error), task-list
// checkboxes, and inline `<br>`. The suggestion-highlight gap and the drawio
// `![alt](x.drawio)` image-syntax gap have their own homes — the fixture they
// need already exists in liveEditor.spec.ts and drawioRender.spec.ts.

import { expect, test, type Page } from "@playwright/test";
import * as path from "path";
import * as esbuild from "esbuild";
import { awaitPosted, bootLiveEditor, bootLiveEditorShell, clearPosted, pushToWebview, REPO_ROOT } from "./harness";
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

// ---------------------------------------------------------------------------
// Mermaid follows the editor theme (client.ts initializes mermaid with
// `theme: isDark ? "dark" : "default"`, dark for a `vscode-dark` /
// `vscode-high-contrast` body class). Pinned by comparing the node fill color
// mermaid 11's default and dark themes actually emit into the rendered SVG's
// inline <style> — `#ECECFF` vs `#1f2020`, mermaid's own default theme
// constants (verified by rendering both themes directly against this
// project's installed mermaid version) — rather than spying on
// `mermaid.initialize`: esbuild inlines the dynamic `import("mermaid")` into
// the single-file IIFE bundle (no code splitting in that output format), so
// there's no separate module load for a `page.addInitScript` to intercept.
// ---------------------------------------------------------------------------

const MERMAID_SOURCE = "# Doc\n\n```mermaid\ngraph TD\nA-->B\n```\n";
const MERMAID_DEFAULT_NODE_FILL = "fill:#ECECFF";
const MERMAID_DARK_NODE_FILL = "fill:#1f2020";

test("mermaid renders the dark theme when the body carries vscode-dark", async ({ page }) => {
  await bootLiveEditorShell(page);
  // Mermaid's theme is read once, at first render, off `document.body`'s
  // classes (client.ts's `loadMermaid`) — set it before `init` triggers that
  // first render.
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await pushToWebview(page, { type: "init", ...liveInit(MERMAID_SOURCE) });
  await awaitPosted(page, "ready-with-content");
  await clearPosted(page);

  const svg = page.locator(".mdc-mermaid svg");
  await expect(svg).toBeVisible({ timeout: 15_000 });
  const style = await svg.locator("style").first().innerHTML();
  expect(style).toContain(MERMAID_DARK_NODE_FILL);
  expect(style).not.toContain(MERMAID_DEFAULT_NODE_FILL);
});

test("mermaid renders the default theme without vscode-dark on the body", async ({ page }) => {
  await bootLiveEditor(page, liveInit(MERMAID_SOURCE));
  const svg = page.locator(".mdc-mermaid svg");
  await expect(svg).toBeVisible({ timeout: 15_000 });
  const style = await svg.locator("style").first().innerHTML();
  expect(style).toContain(MERMAID_DEFAULT_NODE_FILL);
  expect(style).not.toContain(MERMAID_DARK_NODE_FILL);
});

// ---------------------------------------------------------------------------
// PlantUML debounce (security review — every keystroke inside a fence sent
// that draft to the configured PlantUML server, plantuml.com by default).
// Driven through a standalone harness rather than the real live editor —
// see plantumlDebounceHarness.entry.ts's doc comment for why (the fence's
// source is hidden the moment it's recognized, `display: none`, with no gap
// where a real caret could land in it).
// ---------------------------------------------------------------------------

let harnessBundlePath: Promise<string> | null = null;

/** Bundles `plantumlDebounceHarness.entry.ts` (real `makePlantumlPlugin`,
 * no mocking) on first use and caches the output path for the rest of the
 * run — esbuild is already a project devDependency, same one `npm run
 * bundle:*` uses, just invoked programmatically instead of via the CLI so
 * this harness doesn't need its own package.json script. */
function buildHarnessBundle(): Promise<string> {
  if (!harnessBundlePath) {
    const outfile = path.join(REPO_ROOT, "out", "test-fixtures", "plantumlDebounceHarness.js");
    harnessBundlePath = esbuild
      .build({
        entryPoints: [path.join(__dirname, "plantumlDebounceHarness.entry.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2020",
        outfile,
      })
      .then(() => outfile);
  }
  return harnessBundlePath;
}

async function bootPlantumlHarness(page: Page, initialSrc: string, serverUrl: string): Promise<void> {
  const bundle = await buildHarnessBundle();
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="editor"></div></body></html>');
  await page.addScriptTag({ path: bundle });
  await page.evaluate(
    ([src, url]) => (window as unknown as { __plantumlHarness: { mount(s: string, u: string): void } }).__plantumlHarness.mount(src, url),
    [initialSrc, serverUrl] as const,
  );
}

async function appendChar(page: Page, ch: string): Promise<void> {
  await page.evaluate(
    (c) => (window as unknown as { __plantumlHarness: { appendChar(ch: string): void } }).__plantumlHarness.appendChar(c),
    ch,
  );
}

test("typing several characters into a plantuml fence issues one request after the pause, not one per keystroke", async ({
  page,
}) => {
  const serverUrl = "https://plantuml.invalid/plantuml";
  await page.route(`${serverUrl}/**`, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: "<svg></svg>" }),
  );
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith(serverUrl)) requests.push(req.url());
  });

  await bootPlantumlHarness(page, "Alice -> Bob: hi", serverUrl);
  // The initial mount is its own (first-ever, nothing to debounce) render.
  await expect.poll(() => requests.length).toBe(1);
  requests.length = 0;

  // Five keystrokes, close enough together that they land inside one
  // debounce window (the plugin's DEBOUNCE_MS is 1000ms).
  for (const ch of [" ", "n", "o", "w", "!"]) {
    await appendChar(page, ch);
    await page.waitForTimeout(100);
  }
  // No request yet — still well inside the debounce window.
  expect(requests).toHaveLength(0);

  // Past the debounce window: exactly one request, for the fully-settled
  // source (not an intermediate keystroke's).
  await expect.poll(() => requests.length, { timeout: 3000 }).toBe(1);
  expect(requests[0]).toBe(`${serverUrl}/svg/~h${encodeAsHex("Alice -> Bob: hi now!")}`);
});
