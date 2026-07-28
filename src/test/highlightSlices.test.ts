import { describe, expect, it } from "vitest";
import { planHighlightSlices, type TextPiece } from "../webviewShared/highlightSlices";

const piece = (length: number, inMark = false): TextPiece => ({ length, inMark });

describe("planHighlightSlices", () => {
  it("maps a range inside a single text node", () => {
    expect(planHighlightSlices([piece(20)], 5, 9)).toEqual([{ index: 0, from: 5, to: 9 }]);
  });

  it("places a range in a later node — the second comment in a paragraph", () => {
    // "The retry uses " | [marked] | " with a cap. The retry is capped."
    // The second highlight starts past the first two pieces; before the fix
    // only piece 0 was considered and the highlight silently vanished.
    const pieces = [piece(15), piece(19, true), piece(33)];
    expect(planHighlightSlices(pieces, 49, 55)).toEqual([{ index: 2, from: 15, to: 21 }]);
  });

  it("splits a range that spans several nodes", () => {
    expect(planHighlightSlices([piece(10), piece(10)], 5, 15)).toEqual([
      { index: 0, from: 5, to: 10 },
      { index: 1, from: 0, to: 5 },
    ]);
  });

  it("skips text already inside a mark but still counts its offsets", () => {
    const pieces = [piece(5), piece(5, true), piece(5)];
    // Range 0..15 covers everything; the marked middle is not re-wrapped.
    expect(planHighlightSlices(pieces, 0, 15)).toEqual([
      { index: 0, from: 0, to: 5 },
      { index: 2, from: 0, to: 5 },
    ]);
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(planHighlightSlices([piece(10)], 4, 4)).toEqual([]);
    expect(planHighlightSlices([piece(10)], 8, 3)).toEqual([]);
  });

  it("clamps a range that runs past the end of the text", () => {
    expect(planHighlightSlices([piece(10)], 6, 999)).toEqual([{ index: 0, from: 6, to: 10 }]);
  });

  it("returns nothing when the range starts past the end", () => {
    expect(planHighlightSlices([piece(10)], 20, 30)).toEqual([]);
  });

  it("handles a range that exactly covers one node", () => {
    expect(planHighlightSlices([piece(4), piece(6)], 4, 10)).toEqual([
      { index: 1, from: 0, to: 6 },
    ]);
  });

  it("ignores zero-length nodes without consuming offsets", () => {
    expect(planHighlightSlices([piece(0), piece(8)], 2, 5)).toEqual([{ index: 1, from: 2, to: 5 }]);
  });

  it("returns nothing when every piece is already marked", () => {
    expect(planHighlightSlices([piece(5, true), piece(5, true)], 0, 10)).toEqual([]);
  });

  it("keeps slices in document order", () => {
    const slices = planHighlightSlices([piece(3), piece(3), piece(3)], 1, 8);
    expect(slices.map((s) => s.index)).toEqual([0, 1, 2]);
  });
});
