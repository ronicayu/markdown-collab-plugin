// Locate a comment's anchor inside the live editor's rendered text
// (Milkdown's `view.state.doc.textContent`). Mirrors src/anchor.ts:resolve
// semantically: prefer unique exact match; when duplicates exist,
// disambiguate by requiring ALL stored (non-empty) context sides to
// match; orphan (null) if 0 or >1 candidates pass.
//
// Context comparison uses whitespace-normalised neighborhoods because
// stripInlineMarkup and live textContent collapse whitespace
// differently from the stored markdown source — a strict byte-level
// endsWith would spuriously reject correct hits (e.g. when stored
// contextBefore was "Section B\n" but the stripped form drops the
// newline).

import { stripInlineMarkup } from "./anchorExtractor";

export interface LiveAnchor {
  text: string;
  contextBefore: string;
  contextAfter: string;
}

export interface LiveRange {
  start: number;
  end: number;
}

export function locateAnchorInLiveText(
  haystack: string,
  anchor: LiveAnchor,
): LiveRange | null {
  const needle = stripInlineMarkup(anchor.text).stripped.trim();
  if (needle.length === 0) return null;
  const before = stripInlineMarkup(anchor.contextBefore).stripped;
  const after = stripInlineMarkup(anchor.contextAfter).stripped;
  const nBefore = normalizeWs(before);
  const nAfter = normalizeWs(after);
  const anyContext = nBefore.length > 0 || nAfter.length > 0;

  const hits = allHits(haystack, needle);

  if (hits.length === 1) {
    const h = hits[0]!;
    if (!anyContext) return { start: h, end: h + needle.length };
    if (contextMatchesAt(haystack, h, h + needle.length, nBefore, nAfter)) {
      return { start: h, end: h + needle.length };
    }
    // Single hit but context disagrees — fall through to normalised
    // needle search; if that also fails to find a confident match,
    // orphan.
  } else if (hits.length > 1) {
    if (!anyContext) return null; // can't disambiguate without context
    const passing = hits.filter((h) =>
      contextMatchesAt(haystack, h, h + needle.length, nBefore, nAfter),
    );
    if (passing.length === 1) {
      const h = passing[0]!;
      return { start: h, end: h + needle.length };
    }
    // 0 or >1 candidates passed — orphan rather than guess.
    return null;
  }

  // No (or ambiguous-on-context) exact hits → try whitespace-normalised
  // needle search.
  const nNeedle = normalizeWs(needle);
  if (nNeedle.length === 0) return null;
  const { normalized, map } = collapseWs(haystack);
  const normHits = allHits(normalized, nNeedle);
  if (normHits.length === 0) return null;
  if (normHits.length === 1) {
    const nh = normHits[0]!;
    const start = map[nh];
    const end = map[nh + nNeedle.length];
    if (start === undefined || end === undefined) return null;
    if (!anyContext) return { start, end };
    if (contextMatchesAt(haystack, start, end, nBefore, nAfter)) {
      return { start, end };
    }
    return null;
  }
  if (!anyContext) return null;
  const passing = normHits.filter((nh) => {
    const start = map[nh];
    const end = map[nh + nNeedle.length];
    if (start === undefined || end === undefined) return false;
    return contextMatchesAt(haystack, start, end, nBefore, nAfter);
  });
  if (passing.length !== 1) return null;
  const nh = passing[0]!;
  const start = map[nh];
  const end = map[nh + nNeedle.length];
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

function allHits(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (needle.length === 0) return hits;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    hits.push(idx);
    from = idx + 1;
  }
  return hits;
}

// Pulls a neighborhood larger than the raw byte count, then compares in
// whitespace-normalised space so that one-side runs of whitespace don't
// produce false negatives.
function contextMatchesAt(
  haystack: string,
  start: number,
  end: number,
  nBefore: string,
  nAfter: string,
): boolean {
  const beforeBudget = Math.max(nBefore.length * 2, 8);
  const afterBudget = Math.max(nAfter.length * 2, 8);
  const beforeSlice = haystack.slice(Math.max(0, start - beforeBudget), start);
  const afterSlice = haystack.slice(end, end + afterBudget);
  const beforeOk = nBefore.length === 0 || normalizeWs(beforeSlice).endsWith(nBefore);
  const afterOk = nAfter.length === 0 || normalizeWs(afterSlice).startsWith(nAfter);
  return beforeOk && afterOk;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function collapseWs(text: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      const runStart = i;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      map.push(runStart);
      normalized += " ";
    } else {
      map.push(i);
      normalized += ch;
      i++;
    }
  }
  map.push(text.length);
  return { normalized, map };
}
