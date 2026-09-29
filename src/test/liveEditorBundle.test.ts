// The review view's webview bundle, out/webview/client.js, has an upper
// bound (10x-plan-6 P4). It replaced the "no growth" budget from when the
// live editor was a side editor with no new features coming (10x-plan-4
// P3.1); it's now the review view and grows with it, so the bound leaves
// room for that and still catches a jump — a dependency pulled in whole, or
// one of the lazy imports below turned into a static one.
// scripts/verify-package.mjs checks the same number on the packaged .vsix.
//
// The two heaviest dependencies stay lazy: `mermaid` and `mxgraph` are
// dynamic imports, loaded only when a document has a mermaid or draw.io
// block. A regular `import` would put them in the bundle for every document;
// the source-text checks catch that before the size does.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const BUNDLE = path.join(ROOT, "out", "webview", "client.js");

// Measured 2026-09-29 on branch round-4, after the review-view switch:
// `npm run compile` then `wc -c out/webview/client.js` read 4,631,142 bytes.
// The bound is that × 1.25, floored. Raising it is a deliberate act — remeasure,
// update this comment and scripts/verify-package.mjs with it.
const WEBVIEW_CLIENT_MAX_BYTES = 5_788_927;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Matches a static import/require of `name`, but not `import("name")`. */
function staticImportOf(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const staticForms = new RegExp(
    `\\bfrom\\s+["']${escaped}["']|\\brequire\\(\\s*["']${escaped}["']\\s*\\)`,
  );
  return staticForms.test(source);
}

describe("the review view's webview bundle", () => {
  // Needs `npm run compile`. CI always compiles first; a fresh clone that
  // hasn't yet skips rather than fails.
  it.skipIf(!fs.existsSync(BUNDLE))(`stays under ${WEBVIEW_CLIENT_MAX_BYTES} bytes`, () => {
    expect(fs.statSync(BUNDLE).size).toBeLessThanOrEqual(WEBVIEW_CLIENT_MAX_BYTES);
  });

  it("src/webview/client.ts loads mermaid only via a dynamic import", () => {
    const source = read("src/webview/client.ts");
    expect(source).toMatch(/import\(\s*["']mermaid["']\s*\)/);
    expect(staticImportOf(source, "mermaid")).toBe(false);
  });

  it("src/webview/drawioRenderer.ts loads mxgraph only via a dynamic import", () => {
    const source = read("src/webview/drawioRenderer.ts");
    expect(source).toMatch(/import\(\s*["']mxgraph["']\s*\)/);
    expect(staticImportOf(source, "mxgraph")).toBe(false);
  });

  it("src/webview/client.ts loads the drawio renderer itself lazily too", () => {
    // The renderer module is where mxgraph lives; if client.ts pulled it in
    // statically, mxgraph would ride along even for a doc with no diagrams.
    const source = read("src/webview/client.ts");
    expect(source).toMatch(/import\(\s*["']\.\/drawioRenderer["']\s*\)/);
    expect(staticImportOf(source, "./drawioRenderer")).toBe(false);
  });
});
