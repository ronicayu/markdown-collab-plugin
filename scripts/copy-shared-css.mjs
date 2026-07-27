#!/usr/bin/env node
// One shared bundle step for the shared comment-panel stylesheet.
//
// All three webviews (live editor, inline comments, PR/MR review) load the
// same `src/webviewShared/comments.css` as `comments-shared.css` from their
// own out directory (a webview can only load resources under its panel's
// localResourceRoots, which are per-view). This replaces the three separate
// copyFileSync calls that used to live inside each `bundle:*` script — one
// source of truth for the copy, so the shared CSS can never be updated in one
// view's build and forgotten in another's.

import { copyFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src/webviewShared/comments.css");
const targets = [
  "out/webview/comments-shared.css",
  "out/inlineComments/comments-shared.css",
  "out/pr/webview/comments-shared.css",
];

for (const rel of targets) {
  const dest = path.join(root, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

process.stdout.write(`copy:shared-css → comments-shared.css × ${targets.length}\n`);
