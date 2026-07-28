// Find-in-view state for the inline comments webview (10x-plan P2.4).
//
// The webview owns Cmd+F because a webview can't reach VS Code's editor find
// widget. The DOM half (walking text nodes, wrapping matches in <mark>) has to
// stay in the client; the parts that used to be wrong — where the matches are,
// which one is current after stepping, and what the counter reads — are pure
// and live here.

export interface FindMatch {
  /** Offset of the match in the searched string. */
  start: number;
  /** Offset just past the match. */
  end: number;
}

/**
 * Every case-insensitive, non-overlapping occurrence of `query` in `text`, in
 * order. An empty query matches nothing (rather than everything), so clearing
 * the find box clears the highlights.
 */
export function findMatchesIn(text: string, query: string): FindMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  const out: FindMatch[] = [];
  let pos = 0;
  while (pos <= hay.length - needle.length) {
    const hit = hay.indexOf(needle, pos);
    if (hit === -1) break;
    out.push({ start: hit, end: hit + needle.length });
    pos = hit + needle.length; // non-overlapping: "aaa" in "aaaa" matches once
  }
  return out;
}

/**
 * The index `delta` steps from `current`, wrapping in both directions.
 * Returns -1 when there is nothing to step through.
 */
export function stepIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  return (((current + delta) % total) + total) % total;
}

export interface FindCount {
  /** `""` before a query is typed, `"No results"`, or `"3 / 12"`. */
  text: string;
  /** True when the query found nothing — the caller styles this state. */
  empty: boolean;
}

/** The find bar's counter. `index` is 0-based; the label is 1-based. */
export function findCountLabel(query: string, index: number, total: number): FindCount {
  if (!query) return { text: "", empty: false };
  if (total === 0) return { text: "No results", empty: true };
  return { text: `${index + 1} / ${total}`, empty: false };
}
