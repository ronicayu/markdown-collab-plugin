// Which slices of a prose span's text nodes a highlight covers (10x-plan P2.4).
//
// A rendered prose span starts as one text node, but every highlight applied
// to it splits that node into before/mark/after. So the second comment in a
// paragraph has to be placed against a span whose text now lives across
// several nodes — and getting that wrong is invisible: the highlight simply
// doesn't appear (which it didn't, until this was fixed).
//
// The DOM half (splitText + replaceChild) stays in the webview client. The
// offset arithmetic — the part that was wrong — is here, where it can be
// tested without a DOM.

export interface TextPiece {
  /** Length of this text node's data. */
  length: number;
  /** Whether the node already sits inside a highlight mark. */
  inMark: boolean;
}

export interface HighlightSlice {
  /** Index into the input pieces. */
  index: number;
  /** Start offset within that piece. */
  from: number;
  /** End offset within that piece (exclusive). */
  to: number;
}

/**
 * Map a range over a span's *concatenated* text onto per-text-node slices.
 *
 * Pieces already inside a mark still advance the offset (their text is part of
 * the span) but are never returned: nesting one highlight inside another
 * renders as a single darker blob that tells the reader nothing. A range
 * covering several pieces yields one slice per piece.
 */
export function planHighlightSlices(
  pieces: TextPiece[],
  start: number,
  end: number,
): HighlightSlice[] {
  const out: HighlightSlice[] = [];
  if (end <= start) return out;
  let offset = 0;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    const pieceStart = offset;
    offset += piece.length;
    if (piece.inMark) continue;
    const from = Math.max(start, pieceStart) - pieceStart;
    const to = Math.min(end, offset) - pieceStart;
    if (to > from) out.push({ index, from, to });
  }
  return out;
}
