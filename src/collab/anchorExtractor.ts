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

export interface StripResult {
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
export function stripInlineMarkup(md: string): StripResult {
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
        emitLabelStripped(md, i + 2, close.labelEnd, push);
        i = close.parenEnd + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = matchLinkBrackets(md, i);
      if (close) {
        emitLabelStripped(md, i + 1, close.labelEnd, push);
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

// Emit the chars of a link label (the part between `[` and `]`) into the
// stripped output, also stripping inline-code wrappers and emphasis
// markers WITHIN the label. Without this, link labels styled as inline
// code — e.g. `` [`X.md`](url) `` — would push the literal backticks
// into the stripped string, which the rendered editor text does not
// contain. The mismatch makes the user's selection un-locatable.
function emitLabelStripped(
  md: string,
  labelStart: number,
  labelEnd: number,
  push: (ch: string, originIdx: number) => void,
): void {
  for (let j = labelStart; j < labelEnd; j++) {
    const c = md[j]!;
    // Skip inline-code/emphasis wrapper chars within the label. We use
    // a coarse skip rather than full pair-matching because labels are
    // short and the rendered text won't contain these markers either.
    if (c === "`" || c === "*" || c === "_" || c === "~") continue;
    push(c, j);
  }
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

export interface BuildResult {
  anchor: Anchor | null;
  // Diagnostic info surfaced to the webview so we can see WHY a
  // selection failed to anchor in production. Set on null returns.
  debug: {
    selectedTrimmed: string;
    selectedNonWs: number;
    strippedHits: number;
    chosenStrategy:
      | "strip-and-map"
      | "rendered-fallback"
      | "plain-fallback"
      | "rejected-too-short"
      | "rejected-not-found";
  };
}

export function buildAnchorFromSelection(
  renderedText: string,
  selStart: number,
  selEnd: number,
  markdownSource: string,
): Anchor | null {
  return buildAnchorWithDebug(renderedText, selStart, selEnd, markdownSource).anchor;
}

export function buildAnchorWithDebug(
  renderedText: string,
  selStart: number,
  selEnd: number,
  markdownSource: string,
): BuildResult {
  const debug: BuildResult["debug"] = {
    selectedTrimmed: "",
    selectedNonWs: 0,
    strippedHits: 0,
    chosenStrategy: "rejected-too-short",
  };
  if (selStart < 0 || selEnd <= selStart) {
    return { anchor: null, debug };
  }
  const selected = renderedText.slice(selStart, selEnd).trim();
  debug.selectedTrimmed = selected;
  debug.selectedNonWs = nonWsLength(selected);
  if (debug.selectedNonWs < MIN_ANCHOR_NON_WS_CHARS) {
    debug.chosenStrategy = "rejected-too-short";
    return { anchor: null, debug };
  }

  // Strategy 1 — strip markdown markup with a position map and locate
  // the rendered selection in the stripped string.
  {
    const { stripped, map } = stripInlineMarkup(markdownSource);
    const occurrencesInStripped = findAll(stripped, selected);
    debug.strippedHits = occurrencesInStripped.length;
    if (occurrencesInStripped.length > 0) {
      const renderedBefore = renderedText.slice(0, selStart);
      const occurrenceIndex = countOccurrences(renderedBefore, selected);
      const pickedStripped =
        occurrencesInStripped[Math.min(occurrenceIndex, occurrencesInStripped.length - 1)]!;
      const mdStart = map[pickedStripped]!;
      const lastIdx = pickedStripped + selected.length - 1;
      const mdEnd = map[lastIdx]! + 1;
      const text = markdownSource.slice(mdStart, mdEnd);
      const contextBefore = markdownSource.slice(
        Math.max(0, mdStart - ANCHOR_CONTEXT_LEN),
        mdStart,
      );
      const contextAfter = markdownSource.slice(mdEnd, mdEnd + ANCHOR_CONTEXT_LEN);
      debug.chosenStrategy = "strip-and-map";
      return { anchor: { text, contextBefore, contextAfter }, debug };
    }
  }

  // Strategy 2 — fallback: store the rendered selection AS-IS with
  // rendered surrounding text as context. The existing `anchor.resolve`
  // helper has whitespace-normalisation and tolerant-separator
  // fallbacks that can sometimes still locate this in the markdown
  // source even though our strip approach didn't.
  {
    const renderedBefore = renderedText.slice(
      Math.max(0, selStart - ANCHOR_CONTEXT_LEN),
      selStart,
    );
    const renderedAfter = renderedText.slice(
      selEnd,
      Math.min(renderedText.length, selEnd + ANCHOR_CONTEXT_LEN),
    );
    debug.chosenStrategy = "rendered-fallback";
    return {
      anchor: {
        text: selected,
        contextBefore: renderedBefore,
        contextAfter: renderedAfter,
      },
      debug,
    };
  }
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
