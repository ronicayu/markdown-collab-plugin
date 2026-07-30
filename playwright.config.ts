// Webview e2e suite (10x-plan-2 P2.1): the shipped webview bundles driven by a
// real pointer in real Chromium, asserting the exact messages they post to the
// extension host.
//
// Deliberately small and fast — one browser, no dev server, no fixtures on
// disk. `npm run test:webview` compiles first, because these specs load
// `out/**/client.js`, not the TypeScript sources.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/test/webview-e2e",
  // The suite is a release gate, so a stray `test.only` must fail CI rather
  // than silently shrink it.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    ...devices["Desktop Chrome"],
    // about:blank pages built by the harness — nothing to serve.
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
