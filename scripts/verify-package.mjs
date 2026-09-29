#!/usr/bin/env node
// Verify a packaged .vsix actually contains what the extension loads at
// runtime (10x-plan P2.4).
//
// This replaces a CI step that asserted `node_modules/yjs`, `y-protocols`,
// `ws`, and `markdown-it` were inside the vsix. That was true when the host
// shipped unbundled; today esbuild inlines every runtime dependency into
// `out/extension.js` and `.vscodeignore` drops `node_modules/**`. The old
// check went red the moment the Yjs layer was deleted (v0.34.46) and stayed
// red — a guard that fails for a stale reason teaches everyone to ignore it.
//
// What actually needs verifying now:
//   1. Every asset the extension loads by path/URI is in the package.
//   2. The host bundle doesn't `require()` anything that isn't bundled —
//      the real form of "a runtime dep went missing".
//
// Usage: node scripts/verify-package.mjs <path-to-vsix>

import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import * as path from "node:path";

const vsix = process.argv[2];
if (!vsix) {
  console.error("usage: node scripts/verify-package.mjs <path-to-vsix>");
  process.exit(2);
}

/** Files the extension loads at runtime; a missing one is a broken install. */
const REQUIRED = [
  "extension/out/extension.js",
  "extension/out/webview/client.js",
  // The live editor's styles are bundled by esbuild into client.css (host.css
  // + the Milkdown theme are imports, not separate assets).
  "extension/out/webview/client.css",
  "extension/out/webview/comments-shared.css",
  "extension/out/inlineComments/client.js",
  "extension/out/inlineComments/client.css",
  "extension/out/inlineComments/comments-shared.css",
  "extension/out/pr/webview/client.js",
  "extension/out/pr/webview/client.css",
  "extension/out/pr/webview/comments-shared.css",
  // Mermaid is the one dependency loaded as a script asset by URI rather than
  // bundled, so it must ship from node_modules.
  "extension/node_modules/mermaid/dist/mermaid.min.js",
  "extension/node_modules/mermaid/package.json",
  // The Claude Code plugin, which Set Up Claude Code copies into a local
  // marketplace and installs from (10x-plan-4 P0.2). A package without it
  // silently falls back to the standalone skill on every machine.
  "extension/plugin/.claude-plugin/plugin.json",
  "extension/plugin/skills/review/SKILL.md",
  "extension/plugin/lib/mdc.mjs",
  "extension/plugin/hooks/hooks.json",
  "extension/plugin/bin/mdc",
];

/**
 * Files that must NOT ship. The GitHub marketplace manifest points at
 * `./plugin` in the repository; inside the extension it would be a second,
 * unused marketplace definition.
 */
const FORBIDDEN = ["extension/.claude-plugin/marketplace.json"];

// Whole directories that must not ship: build tooling, scratch output, the
// marketplace manifest's siblings. A prefix match, because these hold files
// whose names change.
const FORBIDDEN_PREFIXES = ["extension/scripts/", "extension/.playwright-mcp/", "extension/out/skill/", "extension/out/test/"];

// The only JavaScript under out/ that the extension loads: the host bundle
// and the three webview bundles. tsc's per-file output is inlined into the
// host bundle and must not ship alongside it — it once made up 108 of the
// package's 158 files.
const OUT_JS_ALLOWED = new Set([
  "extension/out/extension.js",
  "extension/out/webview/client.js",
  "extension/out/inlineComments/client.js",
  "extension/out/pr/webview/client.js",
]);

/**
 * Modules the host bundle is allowed to require at runtime: `vscode` is
 * provided by the editor, and the two `ws` optional native addons are marked
 * external by esbuild and guarded by try/catch inside their requiring code.
 */
const ALLOWED_EXTERNALS = new Set(["vscode", "bufferutil", "utf-8-validate"]);

const listing = execFileSync("unzip", ["-l", vsix], { encoding: "utf8" });
// Exact entry names, not substrings: "extension/plugin/bin/mdc" is a prefix
// of "extension/plugin/bin/mdc.cmd", and a substring match would pass a
// package that shipped only the Windows shim.
const entries = new Set(
  listing
    .split("\n")
    .map((line) => /^\s*\d+\s+\S+\s+\S+\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter(Boolean),
);
const missing = REQUIRED.filter((rel) => !entries.has(rel));
const strayDirs = [...entries].filter((e) => FORBIDDEN_PREFIXES.some((p) => e.startsWith(p)));
const strayJs = [...entries].filter((e) => e.startsWith("extension/out/") && e.endsWith(".js") && !OUT_JS_ALLOWED.has(e));
if (strayDirs.length > 0 || strayJs.length > 0) {
  for (const e of [...strayDirs, ...strayJs].slice(0, 20)) console.error(`::error::${path.basename(vsix)} ships ${e}, which nothing loads at runtime — fix .vscodeignore`);
  if (strayDirs.length + strayJs.length > 20) console.error(`::error::…and ${strayDirs.length + strayJs.length - 20} more`);
  process.exit(1);
}
if (missing.length > 0) {
  for (const rel of missing) {
    console.error(`::error::missing ${rel} in the vsix — .vscodeignore or the bundle steps are out of sync`);
  }
  process.exit(1);
}
const shipped = FORBIDDEN.filter((rel) => entries.has(rel));
if (shipped.length > 0) {
  for (const rel of shipped) console.error(`::error::${rel} is in the vsix — .vscodeignore should exclude it`);
  process.exit(1);
}

// The review view's webview bundle has an upper bound (10x-plan-6 P4), the
// same one src/test/liveEditorBundle.test.ts checks on out/: this checks what
// actually shipped. `mermaid` and `mxgraph` stay dynamic imports, guarded by
// that test's source checks.
//
// Measured 2026-09-29 on branch round-4: `npm run compile` then
// `wc -c out/webview/client.js` read 4,631,142 bytes. The number below is
// that × 1.25, floored — room for the review view to grow, not for a
// dependency to land in the bundle whole. Raising it is a deliberate act —
// remeasure, and update the comment and the test alongside it.
const WEBVIEW_CLIENT_BUDGET_BYTES = 5_788_927;

const clientJsBuffer = execFileSync("unzip", ["-p", vsix, "extension/out/webview/client.js"], {
  maxBuffer: 64 * 1024 * 1024,
});
if (clientJsBuffer.length > WEBVIEW_CLIENT_BUDGET_BYTES) {
  console.error(
    `::error::extension/out/webview/client.js is ${clientJsBuffer.length} bytes, over the review view's bound of ${WEBVIEW_CLIENT_BUDGET_BYTES} bytes (10x-plan-6 P4) — check for a dependency bundled whole or a lazy import made static; if this growth is deliberate, remeasure and update scripts/verify-package.mjs and src/test/liveEditorBundle.test.ts`,
  );
  process.exit(1);
}

// Read the packaged host bundle straight out of the archive so we check what
// actually shipped, not what happens to be in ./out.
const bundle = execFileSync("unzip", ["-p", vsix, "extension/out/extension.js"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const required = new Set();
for (const m of bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
  const id = m[1];
  if (id.startsWith(".") || id.startsWith("/")) continue;
  if (id.startsWith("node:")) continue;
  required.add(id);
}

const builtins = new Set(builtinModules);
const unbundled = [...required].filter((id) => {
  const root = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
  return !builtins.has(root) && !ALLOWED_EXTERNALS.has(root);
});

if (unbundled.length > 0) {
  for (const id of unbundled) {
    console.error(
      `::error::out/extension.js requires "${id}" at runtime, but it is not bundled and not shipped in the vsix`,
    );
  }
  process.exit(1);
}

console.log(
  `verify-package: ${path.basename(vsix)} has all ${REQUIRED.length} required assets, none of the ${FORBIDDEN.length} excluded ones, and no unbundled requires`,
);
