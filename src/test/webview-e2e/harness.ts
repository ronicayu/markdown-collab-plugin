// Boot helpers for the webview e2e suite (10x-plan-2 P2.1).
//
// These specs run the *shipped* webview bundles (`out/**/client.js`) in real
// Chromium with `acquireVsCodeApi` stubbed, then assert the exact message the
// client posts back to the extension host. The host half of each message is
// already contract-tested (`mutations.test.ts`, `inlineBridge.test.ts`), so
// message-equality here closes the loop end to end: a click that stops
// producing the right message fails the build, which is what the recurring
// "needs a dev-host pass" list was standing in for.
//
// Deliberately NOT a full VS Code instance: no Electron, no extension host, no
// Selenium. The pieces a webview can't see (workspace edits, disk) are covered
// by the integration suite.

import * as path from "path";
import { expect, type Page } from "@playwright/test";
// Statically imported, deliberately. This was `await import(...)` inside
// bootInlineView, and on the v0.34.72 tag every inline-view spec died there
// with `SyntaxError: Unexpected token 'export'` on GitHub's runner while all
// 24 passed locally — a runtime module resolution that only agreed with one of
// the two environments. A static import is resolved by Playwright's own
// transform, the same way every spec imports this file, so there is no
// resolution left to disagree about. `webviewShell` imports nothing, so there
// was never a host build to be lazy about.
import { inlineCommentsAppBody } from "../../inlineComments/webviewShell";

export const REPO_ROOT = path.resolve(__dirname, "../../..");
const outFile = (...parts: string[]): string => path.join(REPO_ROOT, "out", ...parts);

/**
 * The `acquireVsCodeApi` stand-in. Records every posted message on
 * `window.__mcPosted` and keeps `setState`/`getState` honest (the inline client
 * persists collapsed threads through them, so a no-op stub would change
 * behavior).
 */
const VSCODE_API_STUB = `
window.__mcPosted = [];
let __mcState = undefined;
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (msg) { window.__mcPosted.push(msg); },
    setState: function (s) { __mcState = s; },
    getState: function () { return __mcState; },
  };
};
`;

/** Every message the client has posted to the host, oldest first. */
export async function posted(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __mcPosted: Array<Record<string, unknown>> }).__mcPosted);
}

/** Drop the recorded messages — call after boot so a spec asserts only its own click. */
export async function clearPosted(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mcPosted: unknown[] }).__mcPosted.length = 0;
  });
}

/**
 * Wait until exactly one message of `type` has been posted and return it.
 * Asserting on a single message (rather than "contains") is the point: a click
 * that fires its handler twice, or fires a second unrelated message, fails.
 */
export async function awaitPosted(page: Page, type: string): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => (await posted(page)).filter((m) => m.type === type).length, {
      message: `waiting for a "${type}" message`,
      timeout: 5000,
    })
    .toBe(1);
  return (await posted(page)).find((m) => m.type === type)!;
}

/** Push a host→webview message into the page, exactly as `postMessage` would. */
export async function pushToWebview(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, "*"), msg);
}

async function bootPage(page: Page, body: string, styles: string[], script: string): Promise<void> {
  page.on("pageerror", (err) => {
    throw new Error(`uncaught error in webview: ${err.message}`);
  });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
  for (const style of styles) await page.addStyleTag({ path: style });
  // Order matters: the stub must exist before the bundle's top-level
  // `acquireVsCodeApi()` call runs.
  await page.addScriptTag({ content: VSCODE_API_STUB });
  await page.addScriptTag({ path: script });
}

/**
 * Boot the inline-comments webview with the panel's own DOM skeleton and push
 * an `init`. Resolves once the thread list has rendered.
 */
export async function bootInlineView(page: Page, init: Record<string, unknown>): Promise<void> {
  await bootPage(
    page,
    inlineCommentsAppBody(),
    [outFile("inlineComments", "comments-shared.css"), outFile("inlineComments", "client.css")],
    outFile("inlineComments", "client.js"),
  );
  await awaitPosted(page, "ready");
  await clearPosted(page);
  await pushToWebview(page, { type: "init", ...init });
  await expect(page.locator("#preview")).not.toBeEmpty();
}

/**
 * Boot the live (Milkdown) editor and push an `init`. Resolves once Milkdown
 * has mounted and reported its post-init content back to the host — the same
 * signal the integration suite waits on.
 */
export async function bootLiveEditor(page: Page, init: Record<string, unknown>): Promise<void> {
  await bootPage(
    page,
    "",
    [outFile("webview", "comments-shared.css"), outFile("webview", "client.css")],
    outFile("webview", "client.js"),
  );
  await awaitPosted(page, "ready");
  await clearPosted(page);
  await pushToWebview(page, { type: "init", ...init });
  await awaitPosted(page, "ready-with-content");
  await expect(page.locator(".mdc-editor-root .milkdown")).toBeVisible();
  await clearPosted(page);
}
