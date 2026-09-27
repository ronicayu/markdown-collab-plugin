// 10x-plan-4 P3.1: the live editor is frozen — no new features land there,
// and its bundle is guarded against growth (scripts/verify-package.mjs, which
// runs on the built .vsix in CI). The other half of "frozen" is that the two
// heaviest dependencies stay lazy: `mermaid` and `mxgraph` must remain
// dynamic imports, loaded only when a webview actually renders a mermaid or
// drawio block, not pulled into the client bundle unconditionally. A regular
// `import` accidentally reintroduced by a future edit would silently blow the
// size budget the packaging guard enforces — this is the source-text guard
// that catches it before that, the way the repo's other stale-reference and
// line-count guards do (see staleTransportReferences.test.ts,
// extensionHostSize.test.ts).

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");

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

describe("the live editor's heavy dependencies stay lazy (10x-plan-4 P3.1)", () => {
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
