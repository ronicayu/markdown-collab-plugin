// Tests for renderedRangeToPmRange — the function that translates
// rendered-text offsets into ProseMirror positions for the comment-
// anchor highlighter. Boundary bugs here are what the user saw as
// "highlighted text are wrong".
//
// We model the PM doc as a flat sequence of nodes with `isText`,
// `nodeSize`, and a `pos` (start position in the doc). The mapper only
// reads `isText` and `nodeSize`; descendants order matches PM's
// document order.

import { describe, expect, it } from "vitest";
import {
  renderedRangeToPmRange,
  type DocLike,
  type DocNodeLike,
} from "../collab/pmPositionMapper";

interface FakeNode extends DocNodeLike {
  pos: number;
}

function fakeDoc(nodes: FakeNode[]): DocLike {
  return {
    descendants(cb) {
      for (const n of nodes) {
        const r = cb(n, n.pos);
        if (r === false) return;
      }
    },
  };
}

// Helpers to construct PM-position-correct node sequences.
//
// For doc = `<p>Hello world</p>`:
//   pos 0 : <p> open
//   pos 1 : "Hello world" text node, nodeSize 11
//   pos 12: <p> close
const onePara = fakeDoc([{ isText: true, nodeSize: 11, pos: 1 }]);

// For `<p>Hello </p><p>world</p>`:
//   pos 0 : <p> open
//   pos 1 : "Hello " text, nodeSize 6
//   pos 7 : <p> close
//   pos 8 : <p> open
//   pos 9 : "world" text, nodeSize 5
//   pos 14: <p> close
// textContent = "Hello world" (11 chars — PM doesn't put a separator
// between paragraphs in textContent; this matters for our test).
const twoParas = fakeDoc([
  { isText: true, nodeSize: 6, pos: 1 },
  { isText: true, nodeSize: 5, pos: 9 },
]);

// For `<p>Hello <strong>world</strong></p>`:
//   pos 0 : <p> open
//   pos 1 : "Hello " text, nodeSize 6
//   pos 7 : <strong> open
//   pos 8 : "world" text, nodeSize 5
//   pos 13: <strong> close
//   pos 14: <p> close
const paraWithStrong = fakeDoc([
  { isText: true, nodeSize: 6, pos: 1 },
  { isText: true, nodeSize: 5, pos: 8 },
]);

describe("renderedRangeToPmRange", () => {
  // ---- single text node ----
  it("maps a range inside a single text node", () => {
    expect(renderedRangeToPmRange(onePara, 0, 5)).toEqual({ from: 1, to: 6 });
    expect(renderedRangeToPmRange(onePara, 6, 11)).toEqual({ from: 7, to: 12 });
  });

  it("maps the entire text content", () => {
    expect(renderedRangeToPmRange(onePara, 0, 11)).toEqual({ from: 1, to: 12 });
  });

  // ---- straddling two text nodes (across a markup boundary) ----
  it("maps a range that starts in one text node and ends in the next (the bug repro)", () => {
    // "ello world" — starts at offset 1 (inside "Hello "), ends at end
    // of "world" (offset 11). Spans the strong-mark boundary.
    const r = renderedRangeToPmRange(paraWithStrong, 1, 11);
    expect(r).not.toBeNull();
    expect(r!.from).toBe(2); // pos 1 + (1 - 0)
    expect(r!.to).toBe(13); // pos 8 + (11 - 6)
  });

  it("maps a range that starts EXACTLY at the second text node's left edge", () => {
    // renderedStart=6 — equal to the right edge of "Hello " AND the
    // left edge of "world". The mapper must point `from` at the SECOND
    // text node so the highlight covers "world", not the inter-node
    // strong-open token. Earlier code had this off-by-one and produced
    // visually-shifted highlights.
    const r = renderedRangeToPmRange(paraWithStrong, 6, 11);
    expect(r).not.toBeNull();
    expect(r!.from).toBe(8); // start of "world", not pos 7 (strong open)
    expect(r!.to).toBe(13); // end of "world"
  });

  it("maps a range that ends EXACTLY at the first text node's right edge", () => {
    // renderedEnd=6 — equal to the right edge of "Hello ". Should match
    // INSIDE "Hello " (we want the trailing space included), so `to`
    // is pos 7.
    const r = renderedRangeToPmRange(paraWithStrong, 0, 6);
    expect(r).not.toBeNull();
    expect(r!.from).toBe(1);
    expect(r!.to).toBe(7);
  });

  // ---- across paragraphs ----
  it("maps a range that spans two paragraphs", () => {
    // textContent = "Hello world" — first 6 chars in the first
    // paragraph's text node, next 5 in the second's.
    const r = renderedRangeToPmRange(twoParas, 3, 9);
    expect(r).not.toBeNull();
    // start: inside "Hello " at offset 3 → pos 1 + 3 = 4
    expect(r!.from).toBe(4);
    // end: inside "world" at offset 9-6=3 → pos 9 + 3 = 12
    expect(r!.to).toBe(12);
  });

  // ---- error / edge ----
  it("returns null for inverted or empty ranges", () => {
    expect(renderedRangeToPmRange(onePara, 5, 5)).toBeNull();
    expect(renderedRangeToPmRange(onePara, 8, 3)).toBeNull();
    expect(renderedRangeToPmRange(onePara, -1, 4)).toBeNull();
  });

  it("returns null when the range falls past the end of the doc", () => {
    expect(renderedRangeToPmRange(onePara, 12, 20)).toBeNull();
  });

  it("returns null when the range falls before any text node", () => {
    // No text node has nodeRenderedStart <= 0 < nodeRenderedEnd if all
    // text nodes are at positive rendered offsets — but onePara starts
    // at 0 so this case can't occur for it. Synthesise: a doc where
    // all text starts at offset 5.
    const offset = fakeDoc([{ isText: true, nodeSize: 4, pos: 5 }]);
    expect(renderedRangeToPmRange(offset, 100, 200)).toBeNull();
  });

  // ---- early-exit branches ----

  it("stops walking once both from and to are resolved (early exit branch)", () => {
    let visits = 0;
    const doc: DocLike = {
      descendants(cb) {
        // Three text nodes; the range fits entirely in the first.
        // The mapper should NOT visit nodes 2 and 3.
        const nodes: FakeNode[] = [
          { isText: true, nodeSize: 10, pos: 1 },
          { isText: true, nodeSize: 5, pos: 13 },
          { isText: true, nodeSize: 4, pos: 20 },
        ];
        for (const n of nodes) {
          visits++;
          const r = cb(n, n.pos);
          if (r === false) return;
        }
      },
    };
    const r = renderedRangeToPmRange(doc, 1, 6);
    expect(r).toEqual({ from: 2, to: 7 });
    // After the first node both `from` and `to` are set; the early-exit
    // guard fires on the SECOND callback (return false), so we visited
    // 2 nodes total, not 1 — the guard runs at the *start* of the
    // callback, not after each node's update.
    expect(visits).toBe(2);
  });

  it("ignores non-text nodes between text nodes (the inter-node-token case)", () => {
    // Mark-wrappers in PM appear as non-text nodes in descendants
    // *between* two text nodes. The mapper should skip them when
    // counting rendered offsets but still recurse to find their text
    // children. We model that by having a non-text node between the
    // text ones; descendants is responsible for emitting them in doc
    // order — the mapper doesn't recurse, it relies on the supplied
    // walk order.
    const nodes: FakeNode[] = [
      { isText: true, nodeSize: 6, pos: 1 },
      { isText: false, nodeSize: 1, pos: 7 } as FakeNode, // e.g. a hardbreak
      { isText: true, nodeSize: 5, pos: 8 },
    ];
    const doc = fakeDoc(nodes);
    // textContent over text nodes only = "Hello world" (6 + 5 = 11 chars).
    const r = renderedRangeToPmRange(doc, 6, 11);
    // renderedStart=6 is the LEFT EDGE of the second text node — strict
    // upper for `from` says first node's right edge does NOT match;
    // second node matches at offset 0 → pos 8 + 0 = 8.
    expect(r).toEqual({ from: 8, to: 13 });
  });

  // ---- inverted / degenerate ----

  it("returns null when from > to and we never find both", () => {
    // Force descendants to emit a single text node whose range can
    // satisfy `from` but never `to` (because to < from).
    const r = renderedRangeToPmRange(onePara, 8, 3);
    expect(r).toBeNull();
  });

  it("returns null on a doc with no text nodes at all", () => {
    const empty: DocLike = {
      descendants() {
        // emit nothing
      },
    };
    expect(renderedRangeToPmRange(empty, 0, 5)).toBeNull();
  });

  it("returns null when renderedStart equals renderedEnd (zero-width range is rejected)", () => {
    expect(renderedRangeToPmRange(onePara, 5, 5)).toBeNull();
  });

  it("handles a range that exactly equals the textContent length (full-doc highlight)", () => {
    // For onePara: textContent length = 11. Full range [0, 11].
    expect(renderedRangeToPmRange(onePara, 0, 11)).toEqual({ from: 1, to: 12 });
  });

  it("handles a range that crosses non-text nodes between two text nodes", () => {
    // Same as the inter-node-token test above but verifying that the
    // renderedStart sitting INSIDE the second text node still maps
    // correctly past the non-text intermediate node.
    const doc = fakeDoc([
      { isText: true, nodeSize: 4, pos: 1 } as FakeNode,
      { isText: false, nodeSize: 1, pos: 5 } as FakeNode,
      { isText: true, nodeSize: 4, pos: 6 } as FakeNode,
    ]);
    // textContent = "abcdefgh" (4 + 4). Range "cdef" → [2, 6).
    const r = renderedRangeToPmRange(doc, 2, 6);
    expect(r).not.toBeNull();
    // from inside first text: pos 1 + 2 = 3
    // to: renderedEnd=6 sits at right edge of first text? nodeRenderedEnd=4
    // for first node — 6 > 4 so doesn't match first. Second node nodeRenderedStart=4,
    // nodeRenderedEnd=8. renderedEnd=6 in (4, 8] → to = 6 + (6-4) = 8.
    expect(r!.from).toBe(3);
    expect(r!.to).toBe(8);
  });
});
