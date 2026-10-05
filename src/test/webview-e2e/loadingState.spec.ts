// The inline-comments panel's pre-init loading placeholder (round-4 P3.3).
//
// `init` arrives asynchronously — the host resolves the document and parses
// its threads before it can send it (inlineCommentsPanel.ts) — so the panel
// used to flash empty `#preview` / `#threads-list` on every open. The shell
// now ships a muted "Loading…" placeholder in both; this pins that it's there
// before `init` and gone the moment the first render lands.

import { expect, test } from "@playwright/test";
import { bootInlineViewShell, pushToWebview } from "./harness";
import { inlineInit } from "./fixtures";

test("shows a muted 'Loading…' placeholder before init, and clears it on the first init", async ({ page }) => {
  await bootInlineViewShell(page);

  await expect(page.locator("#preview .mc-loading")).toHaveText("Loading…");
  await expect(page.locator("#threads-list .mc-loading")).toHaveText("Loading…");

  await pushToWebview(page, { type: "init", ...inlineInit("# Doc\n\nSome prose.\n") });

  await expect(page.locator("#preview .mc-loading")).toHaveCount(0);
  await expect(page.locator("#threads-list .mc-loading")).toHaveCount(0);
  await expect(page.locator("#preview h1")).toHaveText("Doc");
});
