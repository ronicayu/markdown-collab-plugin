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
 * Line ranges (1-based, inclusive, new-side) that are added or modified in
 * `newText` relative to `oldText`. Pure deletions produce no range — there is
 * no new-side line to stripe. `oldText === null` means "no previous version"
 * (untracked file): every line is added.
 *
 * Implemented as a Myers O(ND) diff over lines with a linear-space-unfriendly
 * but simple full trace — documents here are markdown prose, not megabyte
 * logs, and the panel recomputes at most once per document change.
 */
export function addedLineRangesBetween(
  oldText: string | null,
  newText: string,
): LineRange[] {
  const newLines = splitLines(newText);
  if (oldText === null) {
    return newLines.length > 0 ? [{ start: 1, end: newLines.length }] : [];
  }
  if (oldText === newText) return [];
  const oldLines = splitLines(oldText);
  const keep = newSideCommonLines(oldLines, newLines);
  return coalesce(newLines.length, keep);
}

/** Split into lines without a phantom trailing entry for a final newline. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Myers diff: returns a boolean per new-side line — true when the line is
 * part of the longest common subsequence (i.e. unchanged).
 */
function newSideCommonLines(a: string[], b: string[]): boolean[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const keep = new Array<boolean>(m).fill(false);
  if (m === 0) return keep;
  if (n === 0) return keep; // nothing common; every b line is added

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
      keep[y] = true;
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
    keep[y] = true;
  }
  return keep;
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
