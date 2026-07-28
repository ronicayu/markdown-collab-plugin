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
];

/**
 * Modules the host bundle is allowed to require at runtime: `vscode` is
 * provided by the editor, and the two `ws` optional native addons are marked
 * external by esbuild and guarded by try/catch inside their requiring code.
 */
const ALLOWED_EXTERNALS = new Set(["vscode", "bufferutil", "utf-8-validate"]);

const listing = execFileSync("unzip", ["-l", vsix], { encoding: "utf8" });
const missing = REQUIRED.filter((rel) => !listing.includes(rel));
if (missing.length > 0) {
  for (const rel of missing) {
    console.error(`::error::missing ${rel} in the vsix — .vscodeignore or the bundle steps are out of sync`);
  }
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
  `verify-package: ${path.basename(vsix)} has all ${REQUIRED.length} required assets and no unbundled requires`,
);
