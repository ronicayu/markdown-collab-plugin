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

// The live editor is frozen (10x-plan-4 P3.1): no new features land there, so
// its bundle shouldn't grow either. `mermaid` and `mxgraph` are already
// dynamic imports, guarded separately by src/test/liveEditorFreeze.test.ts;
// this checks growth, not splitting — a guard the freeze doesn't have to be
// remembered to enforce.
//
// Budget measured 2026-09-27 on branch round-4-p3x: `npm run compile` then
// `wc -c out/webview/client.js` read 4,595,596 bytes. The number below is
// that measurement + 3% slack for minifier/dependency jitter across
// machines, floored to an integer. Raising it is a deliberate act — bump the
// comment's measurement alongside it, don't just widen the number.
const WEBVIEW_CLIENT_BUDGET_BYTES = 4_733_463;

const clientJsBuffer = execFileSync("unzip", ["-p", vsix, "extension/out/webview/client.js"], {
  maxBuffer: 64 * 1024 * 1024,
});
if (clientJsBuffer.length > WEBVIEW_CLIENT_BUDGET_BYTES) {
  console.error(
    `::error::extension/out/webview/client.js is ${clientJsBuffer.length} bytes, over the frozen-live-editor budget of ${WEBVIEW_CLIENT_BUDGET_BYTES} bytes (10x-plan-4 P3.1) — the live editor doesn't get new features, so it shouldn't get a bigger bundle either; if this growth is deliberate, remeasure and update the comment in scripts/verify-package.mjs`,
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
