// Map a range in the rendered text (offsets into doc.textContent) onto
// ProseMirror positions, by walking the doc's text nodes and
// accumulating their nodeSize. Pure module so we can unit-test the
// boundary cases the webview's anchor highlighter depends on.
//
// Convention:
//   - For the START of the rendered range we use a STRICT upper bound:
//     a renderedStart equal to a text-node's right edge belongs to the
//     NEXT text node, not this one. Otherwise we'd point `from` at the
//     position after this text node, which sits inside an inter-node
//     token (e.g. a `<strong>` open) and produces visually-shifted
//     highlights.
//   - For the END we use an INCLUSIVE upper bound: a renderedEnd equal
//     to the right edge of the last text node IS the end of the doc and
//     must match. Otherwise end-of-doc anchors would fail to highlight.

export interface DocNodeLike {
  isText: boolean;
  nodeSize: number;
}

export interface DocLike {
  descendants: (
    cb: (node: DocNodeLike, pos: number) => boolean | void,
  ) => void;
}

export function renderedRangeToPmRange(
  doc: DocLike,
  renderedStart: number,
  renderedEnd: number,
): { from: number; to: number } | null {
  if (renderedStart < 0 || renderedEnd <= renderedStart) return null;
  let textCounted = 0;
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (from >= 0 && to >= 0) return false;
    if (node.isText) {
      const nodeRenderedStart = textCounted;
      const nodeRenderedEnd = textCounted + node.nodeSize;
      // STRICT upper for start — see file header.
      if (
        from < 0 &&
        renderedStart >= nodeRenderedStart &&
        renderedStart < nodeRenderedEnd
      ) {
        from = pos + (renderedStart - nodeRenderedStart);
      }
      // INCLUSIVE upper for end — see file header.
      if (
        to < 0 &&
        renderedEnd > nodeRenderedStart &&
        renderedEnd <= nodeRenderedEnd
      ) {
        to = pos + (renderedEnd - nodeRenderedStart);
      }
      textCounted += node.nodeSize;
    }
    return true;
  });
  if (from < 0 || to < 0 || to <= from) return null;
  return { from, to };
}
