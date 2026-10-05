// Boot helpers for the webview e2e suite.
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
import { liveEditorShellBody } from "../../collab/liveEditorShell";

export const REPO_ROOT = path.resolve(__dirname, "../../..");
const outFile = (...parts: string[]): string => path.join(REPO_ROOT, "out", ...parts);

/**
 * The `acquireVsCodeApi` stand-in. Records every posted message on
 * `window.__mcPosted` and keeps `setState`/`getState` honest (the inline
 * client persists collapsed threads, the outline, and — round-4 P3.5 — the
 * keyboard hint's dismissal through them, so a no-op stub would change
 * behavior). The state itself is on `window.__mcState` too, so a spec can
 * read back what the client persisted without a real webview reload.
 */
const VSCODE_API_STUB = `
window.__mcPosted = [];
window.__mcState = undefined;
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (msg) { window.__mcPosted.push(msg); },
    setState: function (s) { window.__mcState = s; },
    getState: function () { return window.__mcState; },
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

/** Whatever the client last passed to `vscode.setState()`. */
export async function getState(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __mcState: unknown }).__mcState);
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

/** What a boot can set up before the bundle runs. */
export interface BootOptions {
  /**
   * What `getState()` returns from the start — the state a reloaded webview
   * finds, including state an older build (or a corrupted store) left behind.
   */
  state?: unknown;
}

async function bootPage(page: Page, body: string, styles: string[], script: string, opts: BootOptions = {}): Promise<void> {
  page.on("pageerror", (err) => {
    throw new Error(`uncaught error in webview: ${err.message}`);
  });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
  for (const style of styles) await page.addStyleTag({ path: style });
  // Order matters: the stub must exist before the bundle's top-level
  // `acquireVsCodeApi()` call runs.
  await page.addScriptTag({ content: VSCODE_API_STUB });
  if ("state" in opts) await page.addScriptTag({ content: `window.__mcState = ${JSON.stringify(opts.state)};` });
  await page.addScriptTag({ path: script });
}

/**
 * Boot the inline-comments webview shell (panel DOM + client bundle) without
 * pushing an `init` yet. Split out of `bootInlineView` so a spec can assert
 * the pre-init state — the "Loading…" placeholder (round-4 P3.3) — before
 * sending the message that replaces it.
 */
export async function bootInlineViewShell(page: Page): Promise<void> {
  await bootPage(
    page,
    inlineCommentsAppBody(),
    [outFile("inlineComments", "comments-shared.css"), outFile("inlineComments", "client.css")],
    outFile("inlineComments", "client.js"),
  );
  await awaitPosted(page, "ready");
  await clearPosted(page);
}

/**
 * Boot the inline-comments webview with the panel's own DOM skeleton and push
 * an `init`. Resolves once the thread list has rendered.
 */
export async function bootInlineView(page: Page, init: Record<string, unknown>): Promise<void> {
  await bootInlineViewShell(page);
  await pushToWebview(page, { type: "init", ...init });
  await expect(page.locator("#preview")).not.toBeEmpty();
}

/**
 * Boot the live editor's page (the provider's pre-init shell + client bundle)
 * without pushing an `init` yet, so a spec can assert the "Loading…" state.
 */
export async function bootLiveEditorShell(page: Page, opts: BootOptions = {}): Promise<void> {
  await bootPage(
    page,
    liveEditorShellBody(),
    [outFile("webview", "comments-shared.css"), outFile("webview", "client.css")],
    outFile("webview", "client.js"),
    opts,
  );
  await awaitPosted(page, "ready");
  await clearPosted(page);
}

/**
 * Boot the live (Milkdown) editor and push an `init`. Resolves once Milkdown
 * has mounted and reported its post-init content back to the host — the same
 * signal the integration suite waits on.
 */
export async function bootLiveEditor(page: Page, init: Record<string, unknown>, opts: BootOptions = {}): Promise<void> {
  await bootLiveEditorShell(page, opts);
  await pushToWebview(page, { type: "init", ...init });
  await awaitPosted(page, "ready-with-content");
  await expect(page.locator(".mdc-editor-root .milkdown")).toBeVisible();
  await clearPosted(page);
}
