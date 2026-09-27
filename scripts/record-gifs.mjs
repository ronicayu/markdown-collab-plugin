#!/usr/bin/env node
// Records the two README GIFs (10x-plan-4 P3.3) from the SHIPPED inline-view
// bundle, driven through the same stubbed host the webview e2e harness uses
// (src/test/webview-e2e/harness.ts) — real Chromium, `acquireVsCodeApi`
// stubbed, host pushes simulated with `postMessage`. The scene scripts live in
// src/test/webview-e2e/gifRecording.record.ts, named so playwright.config.ts's
// default testMatch never picks it up as a spec (`npm run test:webview` must
// not run it); this script bundles that TS entry point with esbuild — the
// same way scripts/build-skill-cli.mjs turns a TS file into a runnable one
// outside tsc's normal compile — and calls its two exports directly.
//
// Pipeline per scene: record a .webm via Playwright's `recordVideo`, then a
// two-pass ffmpeg palettegen/paletteuse (this is what makes a screen-capture
// GIF not look like a wall of dithering), starting at ~12fps/900px and
// backing off both until the file is under the 1.5 MB budget.
//
// Run after `npm run compile` (the driver boots out/inlineComments/client.js,
// not the TypeScript source) via `npm run record:gifs`. GIFs land in
// media/gifs/ and are committed — see .vscodeignore for why they don't ship
// in the .vsix, and README.md for how they're referenced.

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIFS_DIR = path.join(root, "media", "gifs");
const SIZE_BUDGET_BYTES = 1.5 * 1024 * 1024;
const DURATION_BUDGET_S = 12;

/** Shrinking fps/width pairs, tried in order until a GIF fits the size budget. */
const QUALITY_LADDER = [
  { fps: 12, width: 900 },
  { fps: 10, width: 800 },
  { fps: 10, width: 700 },
  { fps: 8, width: 600 },
  { fps: 8, width: 480 },
];

function ffmpegBin() {
  return existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
}
function ffprobeBin() {
  return existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";
}

function ensureCompiled() {
  const required = [
    "out/inlineComments/client.js",
    "out/inlineComments/client.css",
    "out/inlineComments/comments-shared.css",
  ].map((rel) => path.join(root, rel));
  const missing = required.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    console.error("record-gifs: missing built assets — run `npm run compile` first:");
    for (const f of missing) console.error(`  ${path.relative(root, f)}`);
    process.exit(1);
  }
}

/**
 * Bundle the recording driver (TS, imports the harness + format engine) into
 * a runnable CommonJS module — not ESM: harness.ts uses `__dirname` at module
 * scope (real CJS semantics under esbuild's node platform), and true ESM has
 * no `__dirname` for esbuild to shim. `.cjs` written to disk so Node treats it
 * as CommonJS regardless of this package's own module type; `import()`-ing it
 * still exposes the named exports below via Node's cjs-module-lexer interop.
 */
async function bundleDriver() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, "src/test/webview-e2e/gifRecording.record.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    write: false,
    legalComments: "none",
    // Playwright ships native browser binaries and its own resolution logic;
    // it must be required at runtime from node_modules, not inlined.
    external: ["@playwright/test", "playwright", "playwright-core"],
  });
  return result.outputFiles[0].text;
}

/** Convert `webmPath` to a GIF at `gifPath`, backing off quality until it fits the budget. */
function convertToGif(webmPath, gifPath) {
  let lastSize = Infinity;
  for (const { fps, width } of QUALITY_LADDER) {
    const paletteFile = path.join(os.tmpdir(), `mc-gif-palette-${Date.now()}-${fps}-${width}.png`);
    const scaleFilter = `fps=${fps},scale=${width}:-1:flags=lanczos`;
    execFileSync(
      ffmpegBin(),
      ["-y", "-i", webmPath, "-vf", `${scaleFilter},palettegen`, "-update", "1", paletteFile],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    execFileSync(
      ffmpegBin(),
      [
        "-y",
        "-i", webmPath,
        "-i", paletteFile,
        "-filter_complex", `${scaleFilter}[x];[x][1:v]paletteuse`,
        gifPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    rmSync(paletteFile, { force: true });
    lastSize = statSync(gifPath).size;
    if (lastSize <= SIZE_BUDGET_BYTES) {
      return { fps, width, bytes: lastSize };
    }
  }
  throw new Error(
    `record-gifs: ${path.basename(gifPath)} is still ${lastSize} bytes at the lowest quality tried (${JSON.stringify(QUALITY_LADDER.at(-1))}) — over the ${SIZE_BUDGET_BYTES}-byte budget`,
  );
}

function gifDurationSeconds(gifPath) {
  const out = execFileSync(ffprobeBin(), [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    gifPath,
  ]).toString("utf8");
  return Number.parseFloat(out.trim());
}

async function recordScene(driver, name, recorder, scratchDir) {
  console.log(`record-gifs: recording ${name}…`);
  const sceneDir = path.join(scratchDir, name);
  mkdirSync(sceneDir, { recursive: true });
  const webmPath = await driver[recorder](sceneDir);
  const gifPath = path.join(GIFS_DIR, `${name}.gif`);
  mkdirSync(GIFS_DIR, { recursive: true });
  const { fps, width, bytes } = convertToGif(webmPath, gifPath);
  const duration = gifDurationSeconds(gifPath);
  const warn = duration > DURATION_BUDGET_S ? "  ⚠️ OVER the 12s budget" : "";
  console.log(
    `record-gifs: ${name}.gif — ${(bytes / 1024).toFixed(0)} KB, ${duration.toFixed(1)}s, ${fps}fps @ ${width}px${warn}`,
  );
  if (duration > DURATION_BUDGET_S) {
    throw new Error(`${name}.gif is ${duration.toFixed(1)}s, over the ${DURATION_BUDGET_S}s budget`);
  }
  return { name, fps, width, bytes, duration };
}

async function main() {
  ensureCompiled();
  // Under out/, not os.tmpdir(): the bundled driver imports `@playwright/test`
  // as a bare specifier, and Node resolves that by walking up from the
  // importing file looking for node_modules — which only finds this repo's
  // if the file lives somewhere under it.
  const scratchRoot = path.join(root, "out", ".gif-record-scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const scratchDir = mkdtempSync(path.join(scratchRoot, "run-"));
  const driverFile = path.join(scratchDir, "driver.cjs");
  writeFileSync(driverFile, await bundleDriver(), "utf8");
  try {
    const driver = await import(pathToFileURL(driverFile).href);
    const results = [];
    results.push(await recordScene(driver, "review-loop", "recordReviewLoop", scratchDir));
    results.push(await recordScene(driver, "review-with-claude", "recordReviewWithClaude", scratchDir));
    console.log("\nrecord-gifs: done.");
    for (const r of results) {
      console.log(`  media/gifs/${r.name}.gif — ${(r.bytes / 1024).toFixed(0)} KB, ${r.duration.toFixed(1)}s`);
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
