/**
 * Prose-space line diff for the uncommitted-changes review view.
 *
 * The view stripes rendered blocks whose content changed since HEAD. Both
 * sides are compared as *prose* (source with mc markers, the threads region,
 * and frontmatter stripped) so that adding a review comment — which writes
 * `<!--mc:…-->` markers into the file — never lights up a paragraph whose
 * actual words are untouched. A raw `git diff` can't do that, hence this
 * in-process diff.
 *
 * Pure and vscode-free so it unit-tests directly.
 */

import type { LineRange } from "../pr/diff";

/**
 * A run of old-side lines that no longer exist in the new text — the "before"
 * the reviewer can't otherwise see. Anchored to the new-side line it would sit
 * after, so the view can show the removed text where it used to be.
 */
export interface RemovedRun {
  /** New-side line (1-based) the removed text sits after; 0 = top of document. */
  afterLine: number;
  /** The removed old-side lines, newline-joined. */
  text: string;
}

export interface ProseDiff {
  /** New-side lines that are added or modified (1-based, inclusive). */
  addedRanges: LineRange[];
  /** Old-side content that was deleted or replaced, in document order. */
  removed: RemovedRun[];
}

/**
 * Full prose diff between the HEAD version and the working copy.
 * `oldText === null` means "no previous version" (untracked file): every line
 * is added, nothing was removed. A modified paragraph shows up as both — its
 * new lines in `addedRanges` and its old lines as a `RemovedRun` anchored just
 * above them.
 *
 * Implemented as a Myers O(ND) diff over lines with a linear-space-unfriendly
 * but simple full trace — documents here are markdown prose, not megabyte
 * logs, and the panel recomputes at most once per document change.
 */
export function diffProse(oldText: string | null, newText: string): ProseDiff {
  const newLines = splitLines(newText);
  if (oldText === null) {
    return {
      addedRanges: newLines.length > 0 ? [{ start: 1, end: newLines.length }] : [],
      removed: [],
    };
  }
  if (oldText === newText) return { addedRanges: [], removed: [] };
  const oldLines = splitLines(oldText);
  const { oldKeep, newKeep } = commonLines(oldLines, newLines);
  return {
    addedRanges: coalesce(newLines.length, newKeep),
    removed: removedRuns(oldLines, oldKeep, newKeep),
  };
}

/**
 * Line ranges (1-based, inclusive, new-side) that are added or modified in
 * `newText` relative to `oldText`. Pure deletions produce no range — there is
 * no new-side line to stripe. Kept as the narrow interface for callers that
 * only paint stripes; `diffProse` carries the removed side too.
 */
export function addedLineRangesBetween(oldText: string | null, newText: string): LineRange[] {
  return diffProse(oldText, newText).addedRanges;
}

/** Split into lines without a phantom trailing entry for a final newline. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Group the old-side lines that fell out of the LCS into runs, each anchored
 * to the new-side line it sits after. The two keep arrays mark the same
 * common subsequence in the same order, so a forward two-pointer walk pairs
 * them up: at each sync point the removed old lines are consumed before the
 * added new lines, which is what anchors a modification's "before" text just
 * above its replacement.
 */
function removedRuns(oldLines: string[], oldKeep: boolean[], newKeep: boolean[]): RemovedRun[] {
  const runs: RemovedRun[] = [];
  let i = 0; // old side
  let j = 0; // new side
  while (i < oldLines.length) {
    if (!oldKeep[i]) {
      const start = i;
      while (i < oldLines.length && !oldKeep[i]) i++;
      runs.push({ afterLine: j, text: oldLines.slice(start, i).join("\n") });
      continue;
    }
    // Common line: skip the new side's added lines to reach its partner.
    while (j < newKeep.length && !newKeep[j]) j++;
    i++;
    j++;
  }
  return runs;
}

/**
 * Myers diff: marks, per side, which lines are part of the longest common
 * subsequence (i.e. unchanged).
 */
function commonLines(a: string[], b: string[]): { oldKeep: boolean[]; newKeep: boolean[] } {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const oldKeep = new Array<boolean>(n).fill(false);
  const newKeep = new Array<boolean>(m).fill(false);
  if (m === 0 || n === 0) return { oldKeep, newKeep }; // nothing common

  // V arrays per depth for trace-back. Offset k by `max` to index arrays.
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 1);
  let found = false;
  let dFound = 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max]; // down: insertion from b
      } else {
        x = v[k - 1 + max] + 1; // right: deletion from a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        found = true;
        dFound = d;
        break;
      }
    }
  }
  trace.push(Int32Array.from(v));

  // Trace back from (n, m), marking the diagonal (common) steps.
  let x = n;
  let y = m;
  for (let d = dFound; d > 0 && (x > 0 || y > 0); d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + max] < vPrev[k + 1 + max])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[prevK + max];
    const prevY = prevX - prevK;
    // Diagonal run at the end of this d-step is common lines.
    while (x > prevX && y > prevY) {
      x--;
      y--;
      oldKeep[x] = true;
      newKeep[y] = true;
    }
    if (d > 0) {
      // The single non-diagonal step (insert or delete) is not common.
      x = prevX;
      y = prevY;
    }
  }
  // d === 0 remnant: leading diagonal from (0,0).
  while (x > 0 && y > 0) {
    x--;
    y--;
    oldKeep[x] = true;
    newKeep[y] = true;
  }
  return { oldKeep, newKeep };
}

/** Collapse the non-kept new-side lines into 1-based inclusive ranges. */
function coalesce(lineCount: number, keep: boolean[]): LineRange[] {
  const out: LineRange[] = [];
  let start = -1;
  for (let i = 0; i < lineCount; i++) {
    if (!keep[i]) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      out.push({ start: start + 1, end: i });
      start = -1;
    }
  }
  if (start !== -1) out.push({ start: start + 1, end: lineCount });
  return out;
}
