// Build an Anchor (text + contextBefore + contextAfter) for a selection
// made in the WYSIWYG editor.
//
// The challenge: ProseMirror's selection is in *rendered* coordinates
// (no markup chars), but anchors must resolve against the *markdown
// source*. The bug we're guarding against: an earlier extractor used
// `markdownSource.indexOf(selectedText)` which always picks the first
// occurrence — selecting the link label inside `[here](url)` in a doc
// that ALSO has a bare "here" earlier silently mis-anchored on the bare
// one. Worse, when the selection itself crossed a link, the literal
// rendered text doesn't appear at all in the markdown source.
//
// Strategy: strip inline markdown markup from the source while
// recording a position map back into the original. The stripped string
// equals (or is a close approximation of) what ProseMirror renders; we
// can find the rendered selection in the stripped string and translate
// the resulting [start, end) pair back into markdown positions.
// Anchor.text is then the literal markdown slice between those
// positions — including any markup chars the selection crossed — and
// `anchor.resolve` will round-trip cleanly because that exact text now
// lives in the source.

import type { Anchor } from "../types";

const ANCHOR_CONTEXT_LEN = 24;
const MIN_ANCHOR_NON_WS_CHARS = 8;

function nonWsLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (!/\s/.test(s.charAt(i))) n++;
  }
  return n;
}

interface StripResult {
  stripped: string;
  // map[i] = position in the *original* markdown that produced
  // stripped[i]. map.length === stripped.length + 1 (sentinel end).
  map: number[];
}

/**
 * Strip inline markdown markup from `md` while recording a
 * stripped-position → original-position map. Inline markup understood:
 *   - link text:   `[label](url)` → `label`
 *   - autolink:    `<https://x>` → `https://x`
 *   - bold/em/strike/code wrappers: `**X**`, `__X__`, `*X*`, `_X_`,
 *     `~~X~~`, `` `X` ``  → `X`
 *
 * Block-level markup (headers, blockquotes, lists) is left in place
 * because it sits at line start and the selection rarely starts on
 * those characters.
 */
function stripInlineMarkup(md: string): StripResult {
  const stripped: string[] = [];
  const map: number[] = [];
  let i = 0;
  const len = md.length;

  const push = (ch: string, originIdx: number): void => {
    map.push(originIdx);
    stripped.push(ch);
  };

  while (i < len) {
    const ch = md[i]!;

    // Link: `[label](url)` or `[label][ref]` — emit `label` and skip
    // the wrapper. Image variant `![alt](url)` is treated similarly:
    // we drop the `!`, emit the alt text.
    if (ch === "!" && md[i + 1] === "[") {
      // image — try to find matching closing `)` of the URL
      const close = matchLinkBrackets(md, i + 1);
      if (close) {
        // emit alt text characters
        const labelStart = i + 2; // after `![`
        const labelEnd = close.labelEnd; // index of `]`
        for (let j = labelStart; j < labelEnd; j++) {
          push(md[j]!, j);
        }
        i = close.parenEnd + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = matchLinkBrackets(md, i);
      if (close) {
        const labelStart = i + 1;
        const labelEnd = close.labelEnd;
        for (let j = labelStart; j < labelEnd; j++) {
          push(md[j]!, j);
        }
        i = close.parenEnd + 1;
        continue;
      }
    }

    // Autolink: `<http://x>` or `<a@b.com>`.
    if (ch === "<") {
      const close = md.indexOf(">", i + 1);
      if (close > 0) {
        const inner = md.slice(i + 1, close);
        if (/^(https?:\/\/|mailto:|[\w.+-]+@)/.test(inner)) {
          for (let j = i + 1; j < close; j++) push(md[j]!, j);
          i = close + 1;
          continue;
        }
      }
    }

    // Inline emphasis / code wrappers — best-effort: pairs of identical
    // marker chars that wrap text. Skip the markers, keep the inside.
    if (ch === "*" || ch === "_" || ch === "~" || ch === "`") {
      // Detect doubled marker (**, __, ~~) first.
      if (md[i + 1] === ch) {
        // Look for matching `chch` later in the same paragraph.
        const close = md.indexOf(ch + ch, i + 2);
        if (close > 0 && close - (i + 2) < 200) {
          for (let j = i + 2; j < close; j++) push(md[j]!, j);
          i = close + 2;
          continue;
        }
      }
      // Single marker.
      const close = md.indexOf(ch, i + 1);
      if (close > 0 && close - (i + 1) < 200) {
        for (let j = i + 1; j < close; j++) push(md[j]!, j);
        i = close + 1;
        continue;
      }
    }

    push(ch, i);
    i++;
  }
  // sentinel
  map.push(len);
  return { stripped: stripped.join(""), map };
}

function matchLinkBrackets(
  md: string,
  openIdx: number,
): { labelEnd: number; parenEnd: number } | null {
  // openIdx points at `[`. Find the matching `]` then `(...)`.
  let depth = 1;
  let j = openIdx + 1;
  while (j < md.length && depth > 0) {
    const c = md[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    } else if (c === "\\") {
      j++; // skip escaped char
    }
    j++;
  }
  if (depth !== 0) return null;
  const labelEnd = j; // points at `]`
  if (md[labelEnd + 1] !== "(") return null;
  // Find matching `)` allowing one nesting level (rare).
  let pdepth = 1;
  let k = labelEnd + 2;
  while (k < md.length && pdepth > 0) {
    const c = md[k];
    if (c === "(") pdepth++;
    else if (c === ")") {
      pdepth--;
      if (pdepth === 0) break;
    } else if (c === "\\") {
      k++;
    }
    k++;
  }
  if (pdepth !== 0) return null;
  return { labelEnd, parenEnd: k };
}

export function buildAnchorFromSelection(
  renderedText: string,
  selStart: number,
  selEnd: number,
  markdownSource: string,
): Anchor | null {
  if (selStart < 0 || selEnd <= selStart) return null;
  const selected = renderedText.slice(selStart, selEnd).trim();
  if (nonWsLength(selected) < MIN_ANCHOR_NON_WS_CHARS) return null;

  const { stripped, map } = stripInlineMarkup(markdownSource);

  // Find every occurrence of `selected` in the stripped source, then
  // pick the one that best aligns with the user's selection position
  // in the rendered editor. We use the same Nth-occurrence heuristic
  // as before — the order of occurrences in stripped(markdown) almost
  // always matches the order in the editor's rendered text.
  const occurrencesInStripped = findAll(stripped, selected);
  if (occurrencesInStripped.length === 0) {
    return null;
  }
  const renderedBefore = renderedText.slice(0, selStart);
  const occurrenceIndex = countOccurrences(renderedBefore, selected);
  const pickedStripped =
    occurrencesInStripped[Math.min(occurrenceIndex, occurrencesInStripped.length - 1)]!;

  // Map stripped → markdown positions.
  // mdEnd = (md pos of the last selected stripped char) + 1, NOT
  // map[lastIdx + 1]. The latter equals "where the *next* char lives in
  // markdown" — and when the next char sits past a stripped run, that
  // pointer leaps over the run, sweeping closing markup chars (`]`,
  // `(url)`, etc.) into the anchor text. Using map[last]+1 keeps the
  // anchor exactly at the end of the user's selection in markdown.
  const mdStart = map[pickedStripped]!;
  const lastIdx = pickedStripped + selected.length - 1;
  const mdEnd = map[lastIdx]! + 1;
  const text = markdownSource.slice(mdStart, mdEnd);
  const contextBefore = markdownSource.slice(
    Math.max(0, mdStart - ANCHOR_CONTEXT_LEN),
    mdStart,
  );
  const contextAfter = markdownSource.slice(mdEnd, mdEnd + ANCHOR_CONTEXT_LEN);
  return { text, contextBefore, contextAfter };
}

function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (needle.length === 0) return hits;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return hits;
    hits.push(idx);
    from = idx + needle.length;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count++;
    from = idx + needle.length;
  }
}
