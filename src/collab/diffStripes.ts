// Range→node mapping for the live editor's uncommitted-diff overlay
// (10x-plan-6 P4 phase B, docs/one-view-design.md). Pure and DOM-free —
// like `sourcePositions.ts` next to it — so it unit-tests directly and so
// `src/webview/plugins/diffStripesPlugin.ts` (the Milkdown/DOM glue) can stay
// thin. Reuses the exact `mcSrc` source positions phase A already stamps onto
// paragraph, heading, table_cell and table_header nodes
// (`sourcePositions.ts`, `src/webview/sourcePositionPlugin.ts`) instead of a
// second locate-by-text pass.
//
// Two mapping problems, both mirroring the review view's DOM-side algorithm
// (src/inlineComments/webview/client.ts, paintDiffStripes/paintDiffDeletions)
// but over ProseMirror nodes instead of rendered `[data-mc-src]` spans, and
// at different granularities because the review view's is too:
//
//   - STRIPES (`stripedBlockRanges`): mark every block whose own prose lines
//     the diff touched. A paragraph or heading node IS the block — its own
//     `mcSrc` is both the range to test and the position to decorate. A
//     table_cell/table_header is finer than the review view's stripe unit:
//     a changed cell stripes its whole ROW, matching the review view's
//     `nearestDiffBlock` walk, which stops at the `<tr>` because `<td>`/`<th>`
//     aren't in its block-tag set. A paragraph nested in a blockquote or list
//     item stripes itself, not its container — same reason: `<p>` is always
//     the nearer ancestor.
//   - REMOVED WIDGETS (`removedWidgetPosition`): one per `RemovedRun`,
//     inserted after the TOP-LEVEL block that contains (or last precedes)
//     the prose line it's anchored to — coarser than stripes, matching the
//     review view's `topLevelBlock` (a table's removed-text widget goes
//     after the whole table, not a row).
//
// A block whose `mcSrc` is null (source position missing — the
// one-view-design.md "block failing verification" case, or a leaf mdast node
// whose position was never set) contributes nothing to either pass: it can't
// be tested for overlap and can't anchor a widget, so it's silently skipped
// rather than guessed at — same rule the source-position highlight plugin
// already follows. A table row where every cell is like this gets no stripe
// even if the diff touched its prose lines, and a document with no mapped
// block at all pushes every removed-run widget to the top.

import { SOURCE_ATTR, type BlockSource } from "./sourcePositions";

/** 1-based, inclusive prose-line range — the wire shape `DiffState.addedRanges` carries. */
export interface DiffLineRange {
  start: number;
  end: number;
}

/** One run of deleted HEAD prose, anchored to the prose line it used to follow (0 = top). */
export interface DiffRemovedRun {
  afterLine: number;
  text: string;
}

/**
 * Uncommitted-vs-HEAD overlay. Mirrors the host's `DiffState`
 * (src/inlineComments/inlineCommentsPanel.ts) field-for-field — the webview
 * bundle can't import that vscode-touching module, so this is the webview's
 * own copy of the same wire shape, the way the review view's client.ts keeps
 * its own `DiffState`/`DiffLineRange`/`DiffRemovedRun` too. Not a second
 * shape: the host sends exactly this.
 */
export interface DiffState {
  addedRanges: DiffLineRange[];
  removed: DiffRemovedRun[];
  isNew: boolean;
}

/**
 * The slice of a ProseMirror node this module reads. A real `Node` is cast
 * to it at the call site (`doc as unknown as DiffPmNode`) — same idiom as
 * `sourcePositions.ts`'s `PmNodeLike` — narrow enough that a unit test can
 * build plain objects instead of a real Milkdown schema.
 */
export interface DiffPmNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  nodeSize: number;
  forEach: (cb: (node: DiffPmNode, offset: number, index: number) => void) => void;
}

const STRIPEABLE_TEXT_BLOCKS = new Set(["paragraph", "heading"]);
const TABLE_CELL_TYPES = new Set(["table_cell", "table_header"]);

function mcSrcOf(node: DiffPmNode): BlockSource | null {
  return (node.attrs[SOURCE_ATTR] as BlockSource | null | undefined) ?? null;
}

/** `starts[i]` = 0-based char offset where prose line `i + 1` begins. */
function lineStartsOf(prose: string): number[] {
  const starts = [0];
  for (let i = 0; i < prose.length; i++) {
    if (prose[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-based prose line containing `offset`, via a sorted line-start table — same approach the review view's `paintDiffStripes` uses. */
function lineFor(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function overlapsAdded(lineStarts: number[], added: readonly DiffLineRange[], srcStart: number, srcEnd: number): boolean {
  const startLine = lineFor(lineStarts, srcStart);
  const endLine = lineFor(lineStarts, Math.max(srcStart, srcEnd - 1));
  return added.some((r) => startLine <= r.end && endLine >= r.start);
}

export interface BlockRange {
  from: number;
  to: number;
}

/**
 * The blocks (document order) whose prose the diff's `addedRanges` touch —
 * one range per changed paragraph/heading, one per changed table row. `doc`
 * is the editor's top-level node (`state.doc`).
 */
export function stripedBlockRanges(
  doc: DiffPmNode,
  prose: string,
  addedRanges: readonly DiffLineRange[],
): BlockRange[] {
  if (addedRanges.length === 0) return [];
  const lineStarts = lineStartsOf(prose);
  const out: BlockRange[] = [];

  const visit = (node: DiffPmNode, pos: number): void => {
    if (STRIPEABLE_TEXT_BLOCKS.has(node.type.name)) {
      const src = mcSrcOf(node);
      if (src && overlapsAdded(lineStarts, addedRanges, src.start, src.end)) {
        out.push({ from: pos, to: pos + node.nodeSize });
      }
      return; // paragraphs/headings never nest another mcSrc container
    }
    if (node.type.name === "table") {
      let rowPos = pos + 1; // a node's content starts one past its own position
      node.forEach((row) => {
        let rowStart = -1;
        let rowEnd = -1;
        row.forEach((cell) => {
          if (!TABLE_CELL_TYPES.has(cell.type.name)) return;
          const src = mcSrcOf(cell);
          if (!src) return; // this cell can't be tested — the row's range just skips it
          if (rowStart === -1 || src.start < rowStart) rowStart = src.start;
          if (src.end > rowEnd) rowEnd = src.end;
        });
        // Every cell was unmappable: the row has no range to test, so it
        // gets no stripe even if the diff touched its prose lines.
        if (rowStart !== -1 && overlapsAdded(lineStarts, addedRanges, rowStart, rowEnd)) {
          out.push({ from: rowPos, to: rowPos + row.nodeSize });
        }
        rowPos += row.nodeSize;
      });
      return;
    }
    // Any other container (the doc itself, blockquote, list, list item, …):
    // recurse to find nested paragraphs/headings/tables. Their own position
    // is what gets striped, not this container's — see the file header.
    let childPos = pos + 1;
    node.forEach((child) => {
      visit(child, childPos);
      childPos += child.nodeSize;
    });
  };
  // `doc` occupies no position slot of its own (ProseMirror convention: its
  // content starts at 0), so treat its "position" as -1 — the same formula
  // then gives childPos = 0 for its direct children.
  visit(doc, -1);
  return out;
}

interface SourceSpan {
  srcStart: number;
  topFrom: number;
  topTo: number;
}

/**
 * Every mcSrc-bearing node in the document, tagged with the top-level block
 * it lives under (itself, if it is one) and sorted by source position. Used
 * only to anchor removed-text widgets, which — like the review view's
 * `topLevelBlock` — only care about the top-level block, never a row or a
 * list item.
 */
function collectSourceSpans(doc: DiffPmNode): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const visit = (node: DiffPmNode, topFrom: number, topTo: number): void => {
    if (STRIPEABLE_TEXT_BLOCKS.has(node.type.name) || TABLE_CELL_TYPES.has(node.type.name)) {
      const src = mcSrcOf(node);
      if (src) spans.push({ srcStart: src.start, topFrom, topTo });
      return;
    }
    node.forEach((child) => visit(child, topFrom, topTo));
  };
  let pos = 0;
  doc.forEach((node) => {
    visit(node, pos, pos + node.nodeSize);
    pos += node.nodeSize;
  });
  spans.sort((a, b) => a.srcStart - b.srcStart);
  return spans;
}

/**
 * Where to insert the widget for a `RemovedRun` anchored after prose line
 * `afterLine`: right after the top-level block containing (or last
 * preceding) that line, or the very start of the document when nothing
 * precedes it — mirroring the review view's `paintDiffDeletions` anchoring.
 */
export function removedWidgetPosition(doc: DiffPmNode, prose: string, afterLine: number): number {
  if (afterLine === 0) return 0;
  const lineStarts = lineStartsOf(prose);
  const anchorOffset = afterLine < lineStarts.length ? lineStarts[afterLine]! - 1 : prose.length;
  const spans = collectSourceSpans(doc);
  let lo = 0;
  let hi = spans.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.srcStart <= anchorOffset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx === -1 ? 0 : spans[idx]!.topTo;
}
