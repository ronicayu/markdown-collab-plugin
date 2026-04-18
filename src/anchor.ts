import { Anchor, MIN_ANCHOR_CHARS } from "./types";

export function isAnchorTextValid(anchorText: string): boolean {
  return anchorText.replace(/\s/g, "").length >= MIN_ANCHOR_CHARS;
}

function findAllOccurrences(text: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const hits: number[] = [];
  let from = 0;
  while (true) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1;
  }
  return hits;
}

function contextMatches(
  text: string,
  start: number,
  end: number,
  anchor: Anchor,
): boolean {
  const beforeActual = text.slice(0, start);
  const afterActual = text.slice(end);
  let matchedAny = false;
  if (anchor.contextBefore.length > 0) {
    if (!beforeActual.endsWith(anchor.contextBefore)) return false;
    matchedAny = true;
  }
  if (anchor.contextAfter.length > 0) {
    if (!afterActual.startsWith(anchor.contextAfter)) return false;
    matchedAny = true;
  }
  return matchedAny;
}

const WHITESPACE_RE = /\s/;

/**
 * Collapse runs of whitespace (space/tab/newline/etc.) into a single space.
 * Returns the normalized string together with an index map: for each position
 * `i` in the normalized string (0..normalized.length inclusive), `map[i]` is
 * the corresponding offset in the original string. This lets us translate a
 * match found in the normalized text back to a range in the original.
 *
 * Convention: the character at `normalized[i]` corresponds to the original
 * character at `map[i]`; a match [nStart, nEnd) in normalized space maps back
 * to [map[nStart], map[nEnd]) in original space.
 */
function normalizeWhitespace(text: string): {
  normalized: string;
  map: number[];
} {
  let normalized = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (WHITESPACE_RE.test(ch)) {
      // Collapse a run of whitespace into one space anchored at the first
      // original index of the run.
      const runStart = i;
      while (i < text.length && WHITESPACE_RE.test(text[i])) i++;
      map.push(runStart);
      normalized += " ";
    } else {
      map.push(i);
      normalized += ch;
      i++;
    }
  }
  // Sentinel end entry so map[normalized.length] points just past the last
  // consumed original char.
  map.push(text.length);
  return { normalized, map };
}

export function resolve(
  text: string,
  anchor: Anchor,
): { start: number; end: number } | null {
  if (anchor.text.length === 0) return null;

  const hits = findAllOccurrences(text, anchor.text);
  if (hits.length === 1) {
    const start = hits[0];
    const end = start + anchor.text.length;
    // If neither side stores context, there's nothing to validate — accept.
    if (anchor.contextBefore.length === 0 && anchor.contextAfter.length === 0) {
      return { start, end };
    }
    // Otherwise, only accept when the actual surrounding text matches the
    // stored context on every side that is non-empty. If stored context is
    // present but disagrees with the document, fall through to normalization
    // rather than eagerly accepting an unrelated single hit.
    const beforeActual = text.slice(0, start);
    const afterActual = text.slice(end);
    const beforeOk =
      anchor.contextBefore.length === 0 ||
      beforeActual.endsWith(anchor.contextBefore);
    const afterOk =
      anchor.contextAfter.length === 0 ||
      afterActual.startsWith(anchor.contextAfter);
    if (beforeOk && afterOk) {
      return { start, end };
    }
    // Fall through to whitespace-normalized matching below.
  } else if (hits.length > 1) {
    const contextHits = hits.filter((h) =>
      contextMatches(text, h, h + anchor.text.length, anchor),
    );
    if (contextHits.length === 1) {
      return {
        start: contextHits[0],
        end: contextHits[0] + anchor.text.length,
      };
    }
    if (contextHits.length === 0) {
      // No context match in any candidate — orphan rather than guess.
      return null;
    }
    // Still ambiguous — fall through to null (do not try normalization,
    // it can't disambiguate further than exact match already did).
    return null;
  }

  // Try whitespace-normalized match (reached either when there were no exact
  // hits, or when a single exact hit had stored context that disagreed with
  // the surrounding document and we fell through).
  const needle = anchor.text.replace(/\s+/g, " ").trim();
  if (needle.length === 0) return null;
  const { normalized, map } = normalizeWhitespace(text);
  const normHits = findAllOccurrences(normalized, needle);
  if (normHits.length === 1) {
    const nStart = normHits[0];
    const nEnd = nStart + needle.length;
    const origStart = map[nStart];
    const origEnd = map[nEnd];
    // If context is stored, only accept the normalized hit when it matches.
    // This prevents accepting a single incidental occurrence when the caller
    // stored non-empty context that disagrees with the document.
    if (anchor.contextBefore.length > 0 || anchor.contextAfter.length > 0) {
      if (!contextMatches(text, origStart, origEnd, anchor)) {
        return null;
      }
    }
    return { start: origStart, end: origEnd };
  }
  return null;
}
