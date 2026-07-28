// Prose ↔ source offset mapping for the inline-comments view (10x-plan P2.4).
//
// The webview renders the document with all `mc:` markup, the threads region,
// and frontmatter stripped, so every offset it reports is in "prose space" and
// every offset the format engine wants is in "source space". Getting that
// translation wrong is how a comment ends up anchored to the wrong words, or
// swallowing a marker — the failure class the CHANGELOG has the most entries
// for.
//
// Pure and vscode-free (it moved out of `inlineCommentsPanel.ts`, which is not)
// so both the panel and the mutation handlers can use it and it can be tested
// directly.

import type { ParsedDocument } from "./format";

export interface ProseMapping {
  /** The source with markers, the threads region, and frontmatter removed. */
  prose: string;
  /** Map a *start* prose offset (inclusive boundary) to a source offset. */
  proseStartToSource: (proseOffset: number) => number | null;
  /** Map an *end* prose offset (exclusive boundary) to a source offset. */
  proseEndToSource: (proseOffset: number) => number | null;
  /**
   * Map a source offset to a prose offset. If the source offset falls inside a
   * skipped region (anchor marker or threads block), returns the prose offset
   * of the next surviving character. Returns `null` only when the source
   * offset is past the end of the source.
   */
  sourceToProse: (srcOffset: number) => number | null;
  /** Each thread's anchored span, in prose offsets. */
  anchorsInProse: Map<string, { proseStart: number; proseEnd: number }>;
}

/**
 * Build a map from prose offsets (the source with all `mc:` markup stripped)
 * back to source offsets, plus each thread's anchor position in prose space.
 */
export function mapProseToSource(parsed: ParsedDocument): ProseMapping {
  const src = parsed.source;
  // Build a list of "skip" intervals (every mc marker + the entire threads
  // region + frontmatter block). We then walk src and emit a position map.
  const skips: Array<[number, number]> = [];
  for (const a of parsed.anchors.values()) {
    skips.push([a.openStart, a.openEnd]);
    skips.push([a.closeStart, a.closeEnd]);
  }
  if (parsed.threadsRegion) {
    // Also eat one trailing newline before the region so we don't leave a
    // stray blank line floating in the preview.
    const start =
      parsed.threadsRegion.start > 0 && src[parsed.threadsRegion.start - 1] === "\n"
        ? parsed.threadsRegion.start - 1
        : parsed.threadsRegion.start;
    skips.push([start, parsed.threadsRegion.end]);
  }
  if (parsed.frontmatter) {
    skips.push([parsed.frontmatter.start, parsed.frontmatter.end]);
  }
  skips.sort((a, b) => a[0] - b[0]);

  // proseToSrc[i] = source offset corresponding to prose offset i.
  // Length = prose.length + 1 so end-of-string maps too.
  const proseChars: string[] = [];
  const proseToSrc: number[] = [];
  let skipIdx = 0;
  for (let i = 0; i < src.length; i++) {
    while (skipIdx < skips.length && i >= skips[skipIdx][1]) skipIdx++;
    if (skipIdx < skips.length && i >= skips[skipIdx][0] && i < skips[skipIdx][1]) {
      continue;
    }
    proseToSrc.push(i);
    proseChars.push(src[i]);
  }
  proseToSrc.push(src.length);
  const prose = proseChars.join("");

  // Per-thread anchor in prose space: openEnd maps to the prose offset of the
  // first character after the open marker.
  const anchorsInProse = new Map<string, { proseStart: number; proseEnd: number }>();
  for (const [id, range] of parsed.anchors) {
    const ps = findProseIndex(proseToSrc, range.openEnd);
    const pe = findProseIndex(proseToSrc, range.closeStart);
    if (ps !== null && pe !== null) {
      anchorsInProse.set(id, { proseStart: ps, proseEnd: pe });
    }
  }

  return {
    prose,
    anchorsInProse,
    proseStartToSource: (proseOffset: number) => {
      if (proseOffset < 0 || proseOffset > proseToSrc.length - 1) return null;
      return proseToSrc[proseOffset];
    },
    proseEndToSource: (proseOffset: number) => {
      if (proseOffset < 0 || proseOffset > proseToSrc.length - 1) return null;
      // End boundary: anchor "just past the last selected char". If the next
      // prose char lives across a skipped region we still want to anchor
      // immediately after the last *selected* source char rather than
      // swallowing the markers.
      if (proseOffset === 0) return proseToSrc[0];
      return proseToSrc[proseOffset - 1] + 1;
    },
    sourceToProse: (srcOffset: number) => findProseIndex(proseToSrc, srcOffset),
  };
}

export function findProseIndex(proseToSrc: number[], srcOffset: number): number | null {
  // Linear scan is fine for review-sized docs. Switch to binary search if
  // anyone complains.
  for (let i = 0; i < proseToSrc.length; i++) {
    if (proseToSrc[i] === srcOffset) return i;
    if (proseToSrc[i] > srcOffset) return i; // Marker boundary collapse — closest prose index.
  }
  return null;
}
