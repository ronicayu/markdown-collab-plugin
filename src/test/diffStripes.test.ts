// The live editor's diff-overlay range→node mapping (10x-plan-6 P4 phase B).
// The full pipeline (a real Milkdown doc, real decorations) is exercised by
// the webview-e2e gate (liveEditorDiff.spec.ts); these pin the pure mapping
// on hand-built ProseMirror-shaped trees, the same style
// sourcePositions.test.ts uses for `PmNodeLike`.

import { describe, expect, it } from "vitest";
import {
  removedWidgetPosition,
  stripedBlockRanges,
  type DiffPmNode,
} from "../collab/diffStripes";
import type { BlockSource } from "../collab/sourcePositions";

// --- a ProseMirror-shaped document, just enough for the mapping -----------

/** A terminal text-container node (paragraph/heading/table_cell/table_header): never recursed into. */
function leaf(typeName: string, mcSrc: BlockSource | null, contentLength: number): DiffPmNode {
  return {
    type: { name: typeName },
    attrs: mcSrc ? { mcSrc } : {},
    nodeSize: 2 + contentLength,
    forEach: () => {
      /* leaves have nothing the mapper needs to walk */
    },
  };
}

/** Any container (doc, table, table_row, blockquote, list, list item, …). */
function container(typeName: string, children: DiffPmNode[]): DiffPmNode {
  return {
    type: { name: typeName },
    attrs: {},
    nodeSize: 2 + children.reduce((n, c) => n + c.nodeSize, 0),
    forEach(cb) {
      let pos = 0;
      children.forEach((child, i) => {
        cb(child, pos, i);
        pos += child.nodeSize;
      });
    },
  };
}

// "# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n" — the
// same fixture the review view's uncommittedDiff.spec.ts uses, so the line
// numbers in these tests read the same way ("prose line 3 is Alpha").
const DOC = "# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n";

function span(needle: string, fromIndex = 0): BlockSource {
  const start = DOC.indexOf(needle, fromIndex);
  if (start < 0) throw new Error(`fixture text not found: ${needle} (from ${fromIndex})`);
  return { start, end: start + needle.length, runs: null };
}

function paragraphsDoc(): { doc: DiffPmNode; alpha: { from: number; to: number }; beta: { from: number; to: number }; gamma: { from: number; to: number } } {
  const heading = leaf("heading", { start: 0, end: 7, runs: null }, 5); // "Title"
  const alphaText = "Alpha paragraph.";
  const betaText = "Beta paragraph.";
  const gammaText = "Gamma paragraph.";
  const alpha = leaf("paragraph", span(alphaText), alphaText.length);
  const beta = leaf("paragraph", span(betaText), betaText.length);
  const gamma = leaf("paragraph", span(gammaText), gammaText.length);
  const doc = container("doc", [heading, alpha, beta, gamma]);
  const headingEnd = heading.nodeSize;
  const alphaEnd = headingEnd + alpha.nodeSize;
  const betaEnd = alphaEnd + beta.nodeSize;
  const gammaEnd = betaEnd + gamma.nodeSize;
  return {
    doc,
    alpha: { from: headingEnd, to: alphaEnd },
    beta: { from: alphaEnd, to: betaEnd },
    gamma: { from: betaEnd, to: gammaEnd },
  };
}

describe("stripedBlockRanges", () => {
  it("stripes exactly the paragraph whose prose line was added", () => {
    const { doc, alpha } = paragraphsDoc();
    // Prose line 3 is "Alpha paragraph.".
    expect(stripedBlockRanges(doc, DOC, [{ start: 3, end: 3 }])).toEqual([alpha]);
  });

  it("stripes every block an added range spans", () => {
    const { doc, alpha, beta } = paragraphsDoc();
    // Lines 3-5 cover Alpha (3), the blank line (4) and Beta (5).
    expect(stripedBlockRanges(doc, DOC, [{ start: 3, end: 5 }])).toEqual([alpha, beta]);
  });

  it("returns nothing for a paragraph that only gained a marker — no line range touches it", () => {
    const { doc } = paragraphsDoc();
    expect(stripedBlockRanges(doc, DOC, [{ start: 999, end: 999 }])).toEqual([]);
  });

  it("returns nothing when addedRanges is empty", () => {
    const { doc } = paragraphsDoc();
    expect(stripedBlockRanges(doc, DOC, [])).toEqual([]);
  });

  it("skips a block with no mcSrc (unmapped) rather than guessing", () => {
    const heading = leaf("heading", { start: 0, end: 7, runs: null }, 5);
    const unmapped = leaf("paragraph", null, "Alpha paragraph.".length);
    const doc = container("doc", [heading, unmapped]);
    // Line 3 is the unmapped paragraph's own line; line 1 (the heading,
    // which IS mapped) is deliberately left out of the range so this only
    // exercises the unmapped block.
    expect(stripedBlockRanges(doc, DOC, [{ start: 3, end: 999 }])).toEqual([]);
  });

  it("stripes a paragraph nested in a blockquote by itself, not the blockquote", () => {
    const alphaText = "Alpha paragraph.";
    const alpha = leaf("paragraph", span(alphaText), alphaText.length);
    const quote = container("blockquote", [alpha]);
    const doc = container("doc", [quote]);
    const alphaFrom = 1; // one past the blockquote's own opening position (0)
    expect(stripedBlockRanges(doc, DOC, [{ start: 3, end: 3 }])).toEqual([
      { from: alphaFrom, to: alphaFrom + alpha.nodeSize },
    ]);
  });

  describe("tables — row granularity", () => {
    // Cell sources point at real words on prose lines 3 and 5 (`span`'s
    // `fromIndex` keeps "paragraph" — which appears on every line — pinned
    // to the right occurrence), so the row's aggregate [min start, max end]
    // actually exercises two distinct cell spans, not one duplicated twice.
    function tableDoc(): { doc: DiffPmNode; row0: { from: number; to: number }; row1: { from: number; to: number } } {
      const aStart = DOC.indexOf("Alpha paragraph.");
      const cellA = leaf("table_header", span("Alpha", aStart), 5);
      const cellB = leaf("table_header", span("paragraph", aStart), 9);
      const headerRow = container("table_row", [cellA, cellB]);
      const bStart = DOC.indexOf("Beta paragraph.");
      const cellX = leaf("table_cell", span("Beta", bStart), 4);
      const cellY = leaf("table_cell", span("paragraph", bStart), 9);
      const bodyRow = container("table_row", [cellX, cellY]);
      const table = container("table", [headerRow, bodyRow]);
      const doc = container("doc", [table]);
      const tableContentStart = 1; // one past the table's own opening position (0)
      const row0From = tableContentStart;
      const row0To = row0From + headerRow.nodeSize;
      const row1From = row0To;
      const row1To = row1From + bodyRow.nodeSize;
      return { doc, row0: { from: row0From, to: row0To }, row1: { from: row1From, to: row1To } };
    }

    it("stripes the whole row when one of its cells changed", () => {
      const { doc, row0 } = tableDoc();
      // "Alpha" is on prose line 3.
      expect(stripedBlockRanges(doc, DOC, [{ start: 3, end: 3 }])).toEqual([row0]);
    });

    it("stripes only the touched row, not the other one", () => {
      const { doc, row1 } = tableDoc();
      // "Beta" is on prose line 5.
      expect(stripedBlockRanges(doc, DOC, [{ start: 5, end: 5 }])).toEqual([row1]);
    });

    it("a row where every cell is unmapped gets no stripe even on a touched line", () => {
      const cellA = leaf("table_header", null, 5);
      const cellB = leaf("table_header", null, 5);
      const row = container("table_row", [cellA, cellB]);
      const table = container("table", [row]);
      const doc = container("doc", [table]);
      expect(stripedBlockRanges(doc, DOC, [{ start: 1, end: 999 }])).toEqual([]);
    });
  });
});

describe("removedWidgetPosition", () => {
  it("anchors after the top-level block the prose line sits in", () => {
    const { doc, alpha } = paragraphsDoc();
    // Removed text sat after prose line 3 ("Alpha paragraph.").
    expect(removedWidgetPosition(doc, DOC, 3)).toBe(alpha.to);
  });

  it("a removal at the very top (afterLine 0) goes to position 0", () => {
    const { doc } = paragraphsDoc();
    expect(removedWidgetPosition(doc, DOC, 0)).toBe(0);
  });

  it("a modification's removed run anchors just above its replacement", () => {
    const { doc } = paragraphsDoc();
    // "Alpha paragraph." (line 3) replaces old text anchored after line 2
    // (the blank line following the title) — nothing with mcSrc precedes it
    // but the heading, so the widget lands right after the heading.
    const headingEnd = 7; // heading.nodeSize from paragraphsDoc()
    expect(removedWidgetPosition(doc, DOC, 2)).toBe(headingEnd);
  });

  it("falls back to the very start when nothing precedes the anchor line", () => {
    const heading = leaf("heading", null, 5); // unmapped — contributes no span
    const alphaText = "Alpha paragraph.";
    const alpha = leaf("paragraph", null, alphaText.length); // also unmapped
    const doc = container("doc", [heading, alpha]);
    expect(removedWidgetPosition(doc, DOC, 3)).toBe(0);
  });

  it("a table's removed run anchors after the whole table, not a row", () => {
    const cellA = leaf("table_header", span("Alpha"), 5);
    const row = container("table_row", [cellA]);
    const table = container("table", [row]);
    const doc = container("doc", [table]);
    // Line 3 ("Alpha") is inside the table's only row/cell — the widget
    // still anchors to the table's own end (the top-level block), which for
    // a single-row table is the same position as the row's end.
    expect(removedWidgetPosition(doc, DOC, 3)).toBe(table.nodeSize);
  });
});
