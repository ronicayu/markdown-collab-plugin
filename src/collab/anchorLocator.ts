// Locate a comment's anchor inside the rendered editor (rendered text +
// position maps).
//
// The webview wants to draw a coloured highlight for every comment in
// the file so that:
//   - Reviewers can SEE which passages have comments without scanning
//     the sidebar.
//   - Clicking a highlighted span scrolls/flashes the matching card in
//     the sidebar (bidirectional navigation).
//
// We resolve each anchor against the markdown source (using the
// existing tolerant resolver), then map the resulting markdown range
// back into rendered-text coordinates. The webview then walks the
// ProseMirror doc to convert rendered offsets to PM positions and
// produce a Decoration.
//
// This module is pure — no `vscode`, no `prosemirror`. The webview
// supplies the markdown source and rendered text; we return the
// rendered range.

import { resolve as resolveAnchor } from "../anchor";
import type { Anchor } from "../types";

export interface RenderedRange {
  // Inclusive start / exclusive end in the *rendered* text (what
  // `view.state.doc.textContent` returns).
  start: number;
  end: number;
}

export interface PositionMap {
  /** stripped[i] originated from markdownSource[map[i]]. Length n+1. */
  map: number[];
  /** The stripped string itself; length n. */
  stripped: string;
}

/**
 * Given an anchor and the markdown source plus its strip-with-position-
 * map (built once by the caller), return the rendered-text range the
 * anchor points at, or null if the anchor cannot be resolved.
 */
export function locateAnchorInRendered(
  anchor: Anchor,
  markdownSource: string,
  positionMap: PositionMap,
): RenderedRange | null {
  const resolved = resolveAnchor(markdownSource, anchor);
  if (!resolved) return null;
  return mdRangeToRenderedRange(resolved.start, resolved.end, positionMap);
}

/**
 * Map a markdown-source range onto the corresponding rendered-text
 * range, by walking the strip→md position map. Markdown positions that
 * fell on stripped chars (data) translate 1:1; positions that fell on
 * markup chars (which the rendered text omits) are skipped — the
 * resulting rendered range covers only the data chars between the two
 * markdown bounds.
 */
export function mdRangeToRenderedRange(
  mdStart: number,
  mdEnd: number,
  positionMap: PositionMap,
): RenderedRange | null {
  const { map } = positionMap;
  // map.length === stripped.length + 1
  const strippedLen = map.length - 1;
  let renderedStart = -1;
  let renderedEnd = -1;
  for (let s = 0; s < strippedLen; s++) {
    const mdPos = map[s]!;
    if (mdPos >= mdStart && renderedStart < 0) renderedStart = s;
    if (mdPos < mdEnd) renderedEnd = s + 1;
    else if (renderedEnd >= 0) break;
  }
  if (renderedStart < 0 || renderedEnd <= renderedStart) return null;
  return { start: renderedStart, end: renderedEnd };
}
