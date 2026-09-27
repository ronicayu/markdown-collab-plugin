// Several guard tests read the extension host's source as text and assert on
// it (no addThread call outside opOpenAt, no workspace-folder gate, the
// dispatcher marks pending, etc). Before 10x-plan-4 P3.2 that source was one
// file, `src/extension.ts`. The split moved the logic these guards watch into
// `src/commands/*.ts`; this file is the one place that knows the new map, so a
// future re-split only has to update `HOST_FILES` once.

import { readFileSync } from "fs";
import { resolve } from "path";

/** `extension.ts` plus every command family it wires up. */
export const HOST_FILES = [
  "extension.ts",
  "commands/deps.ts",
  "commands/send.ts",
  "commands/review.ts",
  "commands/comments.ts",
  "commands/setup.ts",
  "commands/diagnostics.ts",
];

/** Read one host-side source file, given a path relative to `src/`. */
export function readHostFile(rel: string): string {
  return readFileSync(resolve(__dirname, "..", rel), "utf8");
}

/**
 * The combined text of every host-side source file. Guards that used to grep
 * one big `extension.ts` now grep this instead, so a violation is caught no
 * matter which family it lands in.
 */
export function readHostSources(): string {
  return HOST_FILES.map(readHostFile).join("\n");
}
