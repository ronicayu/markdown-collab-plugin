// Guard for the reduced-motion pass: every `scrollIntoView`
// call across the three review surfaces must respect
// `prefers-reduced-motion`, which only happens if it goes through the shared
// `smoothScrollIntoView` helper. A literal `behavior: "smooth"` anywhere else
// in these directories is a call site that slipped past that helper — this
// guard catches the next one before it ships, the same way the a11y pass
// caught the ones that existed when it landed.

import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(__dirname, "..");

const SCAN_DIRS = ["inlineComments/webview", "webview", "pr/webview", "webviewShared"];

const HELPER_FILE = "webviewShared/scrollIntoView.ts";

const SMOOTH_LITERAL = /behavior:\s*["']smooth["']/;

/** `.ts` files directly inside `relDir` (none of these dirs nest further). */
function tsFilesIn(relDir: string): string[] {
  const abs = resolve(SRC_ROOT, relDir);
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(relDir, e.name));
}

describe("scrollIntoView({ behavior: \"smooth\" }) only inside the shared helper", () => {
  const files = SCAN_DIRS.flatMap(tsFilesIn).filter((rel) => rel !== HELPER_FILE);

  it("found more than a couple of files to check (the scan didn't come up empty)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const rel of files) {
    it(`${rel} does not hardcode a smooth scroll`, () => {
      const text = readFileSync(resolve(SRC_ROOT, rel), "utf8");
      expect(text).not.toMatch(SMOOTH_LITERAL);
    });
  }

  it("the helper itself still does the reduced-motion check", () => {
    const text = readFileSync(resolve(SRC_ROOT, HELPER_FILE), "utf8");
    expect(text).toMatch(/prefers-reduced-motion/);
    expect(text).toMatch(/"smooth"/);
    expect(text).toMatch(/"auto"/);
  });
});
