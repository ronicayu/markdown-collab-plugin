// Multi-file Review Mode payloads (10x-plan P1.3).
//
// "Ask Claude to Review" started per-file, but real doc work is a `docs/`
// folder or a PR's worth of files. This module builds ONE Review Mode payload
// for a set of files: the same review contract as the single-file prompt, plus
// the one dimension that only exists across files — consistency between them
// (drifting terminology, contradictory claims, guidance duplicated then
// diverged). The cross-file TreeView already aggregates the resulting threads.
//
// Pure and vscode-free so it can be unit-tested; the caller resolves the
// selection to workspace-relative paths and byte sizes.

import { reviewModeClosing, type ReviewPayload } from "./sendToClaude";

export interface ReviewFile {
  /** Workspace-relative path, POSIX separators (it goes into a prompt). */
  rel: string;
  /** File size in bytes, used for the summed soft-confirm. */
  bytes: number;
}

/**
 * The cross-document review dimension. Stated as part of the job rather than
 * an optional extra: reviewing files one at a time is what the single-file
 * command already does, so a multi-file pass that never compares them adds
 * nothing but batching.
 */
export const CROSS_DOCUMENT_DIMENSION = [
  "Review the files in the order listed, reading each one end to end before opening threads on it.",
  "",
  "Then review them against each other — cross-document consistency is part of this pass, not an extra:",
  "- terminology that drifts between files (the same concept under two names, or one name for two concepts),",
  "- a claim in one file contradicted by another,",
  "- guidance duplicated in two files that has since diverged,",
  "- cross-references between the files that no longer resolve (renamed heading, moved section, stale path).",
  "",
  "Anchor a cross-document thread in the file that is wrong — or, when neither is clearly wrong, the more prominent one — and name the other file and its conflicting text in the body.",
].join("\n");

/**
 * Build the payload for a Review Mode pass over several files. `files` is used
 * in the order given (the caller sorts); the order is also the order Claude is
 * told to work in, so threads land in a predictable sequence.
 *
 * Mirrors `buildReviewRequestPayload` for the single-file case: no upper bound
 * on threads, no prose edits, optional free-form focus directive.
 */
export function buildMultiFileReviewPayload(
  files: ReviewFile[],
  focus?: string,
): ReviewPayload {
  const rels = files.map((f) => f.rel);
  const trimmedFocus = focus?.trim();
  const lines: string[] = [
    `Use the vs-markdown-collab skill in Review Mode on these ${rels.length} files:`,
    "",
    ...rels.map((rel) => `- \`${rel}\``),
  ];
  if (trimmedFocus) lines.push("", `Focus: ${trimmedFocus}`);
  lines.push("", CROSS_DOCUMENT_DIMENSION, "", reviewModeClosing(rels.length));
  return {
    prompt: lines.join("\n"),
    file: selectionLabel(rels),
    files: rels,
    unresolvedCount: 0,
    comments: [],
  };
}

/** Total bytes across the selection — the input to the summed soft confirm. */
export function totalBytes(files: ReviewFile[]): number {
  return files.reduce((sum, f) => sum + f.bytes, 0);
}

/**
 * A short human label for a multi-file selection, used where the single-file
 * payload carries a path (toasts, the event-log envelope). Names the shared
 * directory when there is one, since that is how the user picked the files.
 */
export function selectionLabel(rels: string[]): string {
  const n = rels.length;
  if (n === 0) return "no files";
  if (n === 1) return rels[0];
  const dir = commonDirectory(rels);
  return dir ? `${n} files under ${dir}/` : `${n} files`;
}

/**
 * Longest directory prefix shared by every path, or "" when the files sit at
 * the workspace root or in unrelated trees. Segment-wise, so `docs/api.md` and
 * `docs-old/api.md` share nothing rather than the string prefix `docs`.
 */
function commonDirectory(rels: string[]): string {
  const segmentLists = rels.map((rel) => rel.split("/").slice(0, -1));
  const first = segmentLists[0] ?? [];
  const shared: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (!segmentLists.every((segs) => segs[i] === seg)) break;
    shared.push(seg);
  }
  return shared.join("/");
}
