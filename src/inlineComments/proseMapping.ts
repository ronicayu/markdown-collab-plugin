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

/**
 * The prose index for a source offset: the first entry that is >= `srcOffset`,
 * so an offset inside a skipped region (a marker, the threads block) collapses
 * to the next surviving character. Null when the offset is past the end.
 *
 * `proseToSrc` is strictly increasing by construction, so this is a binary
 * search. It used to be a linear scan, which made every call O(document) —
 * and `mapProseToSource` calls it twice per thread, so a doc with 200 threads
 * scanned the file 400 times to build one preview.
 */
export function findProseIndex(proseToSrc: number[], srcOffset: number): number | null {
  let lo = 0;
  let hi = proseToSrc.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (proseToSrc[mid] >= srcOffset) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/**
 * Source line number (1-based) for each line of the prose, so a surface that
 * renders the prose can label a block with the line it occupies in the actual
 * file (10x-plan-3 follow-on: "show line numbers").
 *
 * The two line spaces genuinely differ. Frontmatter and the threads region are
 * whole blocks the prose never sees, so a naive count is wrong by however many
 * lines those take — which for a document with frontmatter is every number on
 * screen. Anchor markers are inline and don't add lines, but they do shift
 * offsets, so the mapping has to go through the offset table rather than
 * counting newlines in the prose.
 *
 * Index is the 0-based prose line; the value is the 1-based source line, which
 * is what an editor shows and what a person would type into a "go to line" box.
 */
export function sourceLineForProseLine(parsed: ParsedDocument): number[] {
  const { prose, proseStartToSource } = mapProseToSource(parsed);
  const srcLineStarts = computeLineStarts(parsed.source);

  const out: number[] = [];
  let proseOffset = 0;
  // `split` rather than an index walk: an empty prose still has one line, and
  // that line still has a source line worth reporting.
  for (const line of prose.split("\n")) {
    const srcOffset = proseStartToSource(proseOffset);
    out.push(srcOffset === null ? 1 : lineOf(srcLineStarts, srcOffset));
    proseOffset += line.length + 1;
  }
  return out;
}

/** Offsets at which each line of `text` begins. */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line containing `offset`. Binary search over line starts. */
function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found + 1;
}
