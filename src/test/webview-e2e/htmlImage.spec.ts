// Raw-HTML images in the live editor.
//
// Markdown can't centre an image or set its width, so documents write
// `<img src="x.png" width="400">` and `<p align="center"><img …></p>`. Milkdown
// keeps raw HTML as an opaque node and renders its source as escaped text, so
// those pictures appeared as literal angle brackets. Only the single-image case
// is recognized; anything else must keep rendering as text.

import { expect, test } from "@playwright/test";
import { bootLiveEditor } from "./harness";
import { liveSidecar } from "./fixtures";

const BASES = {
  docDir: "https://base.test/dir",
  workspaceFolder: "https://base.test/ws",
};

async function boot(page: import("@playwright/test").Page, text: string): Promise<void> {
  await bootLiveEditor(page, {
    text,
    user: { name: "r", color: "#fff" },
    ...liveSidecar(text),
    frontmatter: "",
    imageBaseUris: BASES,
  });
}

test("a bare <img> renders as a picture with a resolved src", async ({ page }) => {
  await boot(page, `# Doc\n\n<img src="shot.png" alt="a shot" width="400">\n`);
  const img = page.locator(".milkdown .mdc-html-image img");
  await expect(img).toHaveAttribute("src", "https://base.test/dir/shot.png");
  await expect(img).toHaveAttribute("alt", "a shot");
  await expect(img).toHaveAttribute("width", "400");
});

test("a centered wrapper is honoured, and ../ paths resolve", async ({ page }) => {
  await boot(page, `# Doc\n\n<p align="center"><img src="../diagrams/arch.png"></p>\n`);
  const wrapper = page.locator(".milkdown .mdc-html-image--center");
  await expect(wrapper).toHaveCount(1);
  await expect(wrapper.locator("img")).toHaveAttribute(
    "src",
    "https://base.test/diagrams/arch.png",
  );
});

test("a script tag still renders as escaped text, not as HTML", async ({ page }) => {
  await boot(page, `# Doc\n\n<script>alert(1)</script>\n`);
  await expect(page.locator(".milkdown script")).toHaveCount(0);
  await expect(page.locator(".milkdown")).toContainText("alert(1)");
});

test("an img carrying an event handler renders without the handler", async ({ page }) => {
  await boot(page, `# Doc\n\n<img src="x.png" onerror="alert(1)">\n`);
  // Not the single-image fast path (it refuses `on*`), but the general
  // sanitizer rebuilds the tag from allowlisted attributes only.
  await expect(page.locator(".milkdown .mdc-html-image")).toHaveCount(0);
  const img = page.locator(".milkdown .mdc-html img");
  await expect(img).toHaveAttribute("src", "https://base.test/dir/x.png");
  await expect(page.locator(".milkdown [onerror]")).toHaveCount(0);
});

test("a javascript: src is refused", async ({ page }) => {
  await boot(page, `# Doc\n\n<img src="javascript:alert(1)">\n`);
  await expect(page.locator(".milkdown .mdc-html-image")).toHaveCount(0);
});

test("markdown images keep working alongside", async ({ page }) => {
  await boot(page, `# Doc\n\n![md](../diagrams/tn5.png)\n`);
  await expect(page.locator(".milkdown img.mdc-image")).toHaveAttribute(
    "src",
    "https://base.test/diagrams/tn5.png",
  );
});
