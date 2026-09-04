/**
 * Line-diff coverage for the uncommitted-changes view. The Myers diff here
 * decides which rendered blocks get change stripes, so it gets fixtures for
 * every shape: pure adds, pure deletes, edits, and the fuzzy boundaries
 * (trailing newlines, empty sides, identical inputs).
 */

import { describe, expect, it } from "vitest";
import { addedLineRangesBetween } from "../uncommitted/proseDiff";

/** Also sanity-check against a brute-force check: every reported line differs somewhere. */
const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

describe("addedLineRangesBetween", () => {
  it("returns [] for identical texts", () => {
    const t = "# Title\n\nA paragraph.\n";
    expect(addedLineRangesBetween(t, t)).toEqual([]);
  });

  it("marks every line when there is no old version (untracked file)", () => {
    expect(addedLineRangesBetween(null, "a\nb\nc\n")).toEqual([{ start: 1, end: 3 }]);
  });

  it("returns [] for an empty new text", () => {
    expect(addedLineRangesBetween(null, "")).toEqual([]);
    expect(addedLineRangesBetween("old\n", "")).toEqual([]);
  });

  it("marks an appended line", () => {
    expect(addedLineRangesBetween("a\nb\n", "a\nb\nc\n")).toEqual([{ start: 3, end: 3 }]);
  });

  it("marks a line inserted in the middle", () => {
    expect(addedLineRangesBetween("a\nc\n", "a\nb\nc\n")).toEqual([{ start: 2, end: 2 }]);
  });

  it("marks a modified line (delete+insert at the same spot)", () => {
    expect(addedLineRangesBetween("a\nOLD\nc\n", "a\nNEW\nc\n")).toEqual([
      { start: 2, end: 2 },
    ]);
  });

  it("reports nothing for a pure deletion", () => {
    expect(addedLineRangesBetween("a\nb\nc\n", "a\nc\n")).toEqual([]);
  });

  it("coalesces consecutive added lines into one range", () => {
    expect(addedLineRangesBetween("a\nz\n", "a\nb\nc\nd\nz\n")).toEqual([
      { start: 2, end: 4 },
    ]);
  });

  it("reports multiple separate ranges", () => {
    const got = addedLineRangesBetween("a\nb\nc\nd\n", "a\nX\nb\nc\nY\nd\n");
    expect(got).toEqual([
      { start: 2, end: 2 },
      { start: 5, end: 5 },
    ]);
  });

  it("marks everything when nothing is common", () => {
    expect(addedLineRangesBetween("a\nb\n", "x\ny\nz\n")).toEqual([{ start: 1, end: 3 }]);
  });

  it("treats a missing trailing newline the same as a present one", () => {
    expect(addedLineRangesBetween("a\nb", "a\nb\n")).toEqual([]);
    expect(addedLineRangesBetween("a\nb\n", "a\nb\nc")).toEqual([{ start: 3, end: 3 }]);
  });

  it("does not mark unchanged duplicate lines around an insertion", () => {
    // Repeated blank lines are everywhere in markdown; the diff must not
    // smear the stripe across them.
    const oldT = "para one\n\npara two\n\npara three\n";
    const newT = "para one\n\npara two\n\ninserted\n\npara three\n";
    const got = addedLineRangesBetween(oldT, newT);
    // Exactly the inserted line (plus at most one neighbouring blank —
    // ambiguous alignment between identical blank lines is acceptable).
    const marked = new Set<number>();
    for (const r of got) for (let l = r.start; l <= r.end; l++) marked.add(l);
    expect(marked.has(5)).toBe(true); // "inserted"
    expect(marked.has(1)).toBe(false);
    expect(marked.has(3)).toBe(false);
    expect(marked.has(7)).toBe(false);
    expect(marked.size).toBeLessThanOrEqual(2);
  });

  it("total marked lines never exceeds the new text's line count", () => {
    const oldT = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const newT =
      Array.from({ length: 40 }, (_, i) => (i % 7 === 0 ? `edited ${i}` : `line ${i}`)).join(
        "\n",
      ) + "\n";
    const got = addedLineRangesBetween(oldT, newT);
    const n = lines(newT).length;
    for (const r of got) {
      expect(r.start).toBeGreaterThanOrEqual(1);
      expect(r.end).toBeGreaterThanOrEqual(r.start);
      expect(r.end).toBeLessThanOrEqual(n);
    }
    // Every marked line really is one of the edited ones.
    const newLines = lines(newT);
    for (const r of got) {
      for (let l = r.start; l <= r.end; l++) {
        expect(newLines[l - 1]).toMatch(/^edited /);
      }
    }
    // And every edited line is marked.
    const marked = new Set<number>();
    for (const r of got) for (let l = r.start; l <= r.end; l++) marked.add(l);
    newLines.forEach((text, i) => {
      if (text.startsWith("edited ")) expect(marked.has(i + 1)).toBe(true);
    });
  });
});
