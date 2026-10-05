// Build an Anchor (text + contextBefore + contextAfter) for a selection made in
// the WYSIWYG editor.
//
// ProseMirror's selection is in rendered coordinates (no markup chars) but
// anchors must resolve against the markdown source, and
// `markdownSource.indexOf(selectedText)` would pick the first occurrence (and
// find nothing when the selection crosses a link). So inline markup is stripped
// from the source with a position map back into the original; the rendered
// selection is found in the stripped string and its [start, end) translated
// back. Anchor.text is the literal markdown slice between those positions, so
// `anchor.resolve` round-trips.

import type { Anchor } from "../types";

const ANCHOR_CONTEXT_LEN = 24;

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
 * stripped-position → original-position map.
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
  // Tracks whether the *next* non-skipped char will be at the start of
  // a logical line. ProseMirror's `doc.textContent` doesn't include
  // newlines OR line-start block markup (heading hashes, list bullets,
  // blockquote `>`s, indentation), so we strip them here too — without
  // this the stripped string is longer than what the editor renders
  // and every position past the first list/heading drifts forward.
  let lineStart = true;

  const push = (ch: string, originIdx: number): void => {
    map.push(originIdx);
    stripped.push(ch);
  };

  while (i < len) {
    let ch = md[i]!;

    // Newlines: skipped entirely. PM's textContent has none — sibling
    // blocks are concatenated without separators.
    if (ch === "\n" || ch === "\r") {
      i++;
      lineStart = true;
      continue;
    }

    // Escape sequences: `\X` for any non-newline X. PM strips the
    // backslash and renders X. Apply this before any other char
    // handler so escaped markup chars (`\*`, `\[`, `\|`) don't
    // accidentally trigger their respective strippers.
    if (ch === "\\" && i + 1 < len && md[i + 1] !== "\n" && md[i + 1] !== "\r") {
      push(md[i + 1]!, i + 1);
      i += 2;
      continue;
    }

    // Reference link definition line: `[label]: <url> ["title"]` at
    // line start contributes nothing to textContent. Skip the whole
    // line (including the trailing newline).
    if (lineStart && isReferenceDefAt(md, i)) {
      while (i < len && md[i] !== "\n" && md[i] !== "\r") i++;
      continue;
    }

    // GFM table cell separator: a `|` between cells contributes
    // nothing to textContent (cells are concatenated as siblings),
    // AND PM's table parser trims each cell's leading/trailing
    // whitespace. We mirror both: drop the `|` itself, drop any
    // following horizontal whitespace, and pop any trailing
    // horizontal whitespace we already pushed (the previous cell's
    // padding). Without the trim every table row contributes 2N+
    // extra chars to the stripped string and the downstream PM-
    // position mapper lands the highlight further down the doc by
    // the accumulated drift.
    if (ch === "|" && md[i - 1] !== "\\") {
      while (
        stripped.length > 0 &&
        (stripped[stripped.length - 1] === " " || stripped[stripped.length - 1] === "\t")
      ) {
        stripped.pop();
        map.pop();
      }
      i++;
      while (i < len && (md[i] === " " || md[i] === "\t")) i++;
      continue;
    }

    // Fenced code block opener (``` or ~~~ at line start). PM stores
    // the body as a code_block node whose textContent is the raw body
    // (no fences, no language tag). We skip the opening fence line
    // (including the language tag), keep the body lines exactly,
    // and skip the closing fence line.
    if (lineStart) {
      const fence = readFenceAt(md, i);
      if (fence) {
        let j = i;
        while (j < len && md[j] !== "\n" && md[j] !== "\r") j++;
        i = j;
        if (md[i] === "\n" || md[i] === "\r") i++;
        while (i < len) {
          let k = i;
          while (k < len && (md[k] === " " || md[k] === "\t")) k++;
          let runChar: string | null = null;
          let runLen = 0;
          while (k < len && (md[k] === fence.char)) {
            runChar = md[k]!;
            runLen++;
            k++;
          }
          let onlyWsAfter = true;
          let lineEnd = k;
          while (lineEnd < len && md[lineEnd] !== "\n" && md[lineEnd] !== "\r") {
            if (md[lineEnd] !== " " && md[lineEnd] !== "\t") {
              onlyWsAfter = false;
              break;
            }
            lineEnd++;
          }
          if (runChar === fence.char && runLen >= fence.len && onlyWsAfter) {
            i = lineEnd;
            if (md[i] === "\n" || md[i] === "\r") i++;
            lineStart = true;
            break;
          }
          while (i < len && md[i] !== "\n" && md[i] !== "\r") {
            push(md[i]!, i);
            i++;
          }
          if (md[i] === "\n" || md[i] === "\r") i++;
        }
        continue;
      }
    }

    // Setext heading underline (line of only `=` or `-`, length >= 3,
    // following a non-blank line). We're already at line start; the
    // underline is consumed wholesale because PM consumes it as part
    // of the heading node.
    if (lineStart && isSetextUnderlineAt(md, i)) {
      while (i < len && md[i] !== "\n" && md[i] !== "\r") i++;
      continue;
    }

    // Horizontal rule (line of only `-`, `*`, or `_` with optional
    // spaces between them, 3+ markers). PM emits an `<hr>` node which
    // contributes nothing to textContent.
    if (lineStart && isHorizontalRuleAt(md, i)) {
      while (i < len && md[i] !== "\n" && md[i] !== "\r") i++;
      continue;
    }

    // At line start, eat block-level markdown markers. We loop because
    // a single line can carry several (e.g. `> > - text` for nested
    // blockquote + list).
    if (lineStart) {
      let advanced = true;
      while (advanced) {
        advanced = false;
        while (i < len && (md[i] === " " || md[i] === "\t")) {
          i++;
          advanced = true;
        }
        if (i >= len) break;
        const c = md[i]!;
        if (c === "#") {
          let j = i;
          let hashes = 0;
          while (j < len && md[j] === "#" && hashes < 6) {
            j++;
            hashes++;
          }
          if (md[j] === " " || md[j] === "\t") {
            i = j + 1;
            advanced = true;
            continue;
          }
        }
        if (c === ">") {
          i++;
          if (md[i] === " ") i++;
          advanced = true;
          continue;
        }
        if ((c === "-" || c === "*" || c === "+") && md[i + 1] === " ") {
          i += 2;
          advanced = true;
          // Task-list checkbox `[ ]` or `[x]` (case-insensitive) +
          // space immediately after a list bullet. PM stores this as
          // an attribute on the list_item, not as text content.
          if (
            md[i] === "[" &&
            (md[i + 1] === " " || md[i + 1] === "x" || md[i + 1] === "X") &&
            md[i + 2] === "]" &&
            md[i + 3] === " "
          ) {
            i += 4;
          }
          continue;
        }
        if (c >= "0" && c <= "9") {
          let j = i;
          while (j < len && md[j]! >= "0" && md[j]! <= "9") j++;
          if ((md[j] === "." || md[j] === ")") && md[j + 1] === " ") {
            i = j + 2;
            advanced = true;
            continue;
          }
        }
      }
      lineStart = false;
      if (i >= len) continue;
      // If the line-start handlers landed us on a newline (e.g.
      // `> \n` — blockquote prefix on an otherwise-empty line) we
      // MUST restart the outer-loop iteration so the newline check at
      // the top fires again. Otherwise we'd fall through to inline
      // handling and end up pushing the newline as a literal char.
      if (md[i] === "\n" || md[i] === "\r") continue;
      // After consuming line-start block markers, check whether the
      // *remaining* line is a GFM table separator row (e.g. inside a
      // blockquote: `> |---|---|---|` — the `> ` was just stripped,
      // so we're now sitting at `|---|---|---|`). PM's table parser
      // ignores separator rows entirely; the stripper must too,
      // otherwise we'd push every `-` of the dashes literally.
      if (isTableSeparatorRowAt(md, i)) {
        while (i < len && md[i] !== "\n" && md[i] !== "\r") i++;
        continue;
      }
      // The line-start handlers may have left us on a `|` that opens a
      // table data row inside a blockquote (e.g. `> | Term | Meaning |`).
      // The top-of-iteration `|` strip already fired for *this*
      // iteration before line-start ran, so we need to re-check it
      // here too — restart the loop so the strip + everything else
      // runs cleanly against the post-line-start position.
      if (md[i] === "|" && md[i - 1] !== "\\") continue;
      ch = md[i]!;
    }

    // Link: `[label](url)` or `[label][ref]` — emit `label` and skip
    // the wrapper. Image variant `![alt](url)` is treated similarly:
    // we drop the `!`, emit the alt text.
    if (ch === "!" && md[i + 1] === "[") {
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
      const refClose = matchReferenceLinkBrackets(md, i);
      if (refClose) {
        emitLabelStripped(md, i + 1, refClose.labelEnd, push);
        i = refClose.refCloseEnd + 1;
        continue;
      }
    }

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
      if (md[i + 1] === ch) {
        const close = md.indexOf(ch + ch, i + 2);
        if (close > 0 && close - (i + 2) < 200) {
          for (let j = i + 2; j < close; j++) push(md[j]!, j);
          i = close + 2;
          continue;
        }
        // Doubled marker with no matching close — push both literal.
        // CRITICAL: do NOT fall through to the single-marker branch,
        // which would happily match the second `*` of the unclosed
        // pair as the close and strip them both.
        push(ch, i);
        push(ch, i + 1);
        i += 2;
        continue;
      }
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
  map.push(len);
  return { stripped: stripped.join(""), map };
}

function matchReferenceLinkBrackets(
  md: string,
  openIdx: number,
): { labelEnd: number; refCloseEnd: number } | null {
  let depth = 1;
  let j = openIdx + 1;
  while (j < md.length && depth > 0) {
    const c = md[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    } else if (c === "\\") {
      j++;
    }
    j++;
  }
  if (depth !== 0) return null;
  const labelEnd = j;
  if (md[labelEnd + 1] !== "[") return null;
  // Find matching `]` of the ref bracket.
  let k = labelEnd + 2;
  while (k < md.length && md[k] !== "]" && md[k] !== "\n") k++;
  if (md[k] !== "]") return null;
  return { labelEnd, refCloseEnd: k };
}

function isReferenceDefAt(md: string, i: number): boolean {
  if (md[i] !== "[") return false;
  let j = i + 1;
  while (j < md.length && md[j] !== "]" && md[j] !== "\n") j++;
  if (md[j] !== "]" || md[j + 1] !== ":") return false;
  let k = j + 2;
  while (k < md.length && (md[k] === " " || md[k] === "\t")) k++;
  if (k >= md.length || md[k] === "\n") return false;
  return true;
}

function readFenceAt(md: string, i: number): { char: string; len: number } | null {
  // Allow up to 3 leading spaces.
  let j = i;
  let indent = 0;
  while (j < md.length && md[j] === " " && indent < 3) {
    j++;
    indent++;
  }
  const ch = md[j];
  if (ch !== "`" && ch !== "~") return null;
  let n = 0;
  while (j < md.length && md[j] === ch) {
    n++;
    j++;
  }
  if (n < 3) return null;
  return { char: ch, len: n };
}

function isSetextUnderlineAt(md: string, i: number): boolean {
  let end = i;
  while (end < md.length && md[end] !== "\n" && md[end] !== "\r") end++;
  if (end - i < 3) return false;
  let j = i;
  while (j < end && md[j] === " ") j++;
  const c = md[j];
  if (c !== "=" && c !== "-") return false;
  let n = 0;
  while (j < end && md[j] === c) {
    j++;
    n++;
  }
  if (n < 3) return false;
  while (j < end) {
    if (md[j] !== " " && md[j] !== "\t") return false;
    j++;
  }
  return true;
}

function isHorizontalRuleAt(md: string, i: number): boolean {
  let end = i;
  while (end < md.length && md[end] !== "\n" && md[end] !== "\r") end++;
  if (end - i < 3) return false;
  let j = i;
  while (j < end && md[j] === " ") j++;
  const marker = md[j];
  if (marker !== "-" && marker !== "*" && marker !== "_") return false;
  let count = 0;
  for (let k = i; k < end; k++) {
    const c = md[k];
    if (c === marker) count++;
    else if (c !== " " && c !== "\t") return false;
  }
  return count >= 3;
}

function isTableSeparatorRowAt(md: string, i: number): boolean {
  let end = i;
  while (end < md.length && md[end] !== "\n" && md[end] !== "\r") end++;
  if (end - i < 3) return false;
  let dashRun = 0;
  let maxDashRun = 0;
  let sawAnyContent = false;
  for (let j = i; j < end; j++) {
    const c = md[j]!;
    if (c === "-") {
      dashRun++;
      if (dashRun > maxDashRun) maxDashRun = dashRun;
      sawAnyContent = true;
    } else {
      dashRun = 0;
      if (c === "|" || c === ":" || c === " " || c === "\t") {
        sawAnyContent = sawAnyContent || c === "|" || c === ":";
      } else {
        return false;
      }
    }
  }
  return sawAnyContent && maxDashRun >= 3;
}

// Link labels styled as inline code — e.g. `` [`X.md`](url) `` — would push the
// literal backticks into the stripped string, which the rendered editor text
// does not contain, making the user's selection un-locatable. So wrapper chars
// within the label are dropped.
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
  let depth = 1;
  let j = openIdx + 1;
  while (j < md.length && depth > 0) {
    const c = md[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    } else if (c === "\\") {
      j++;
    }
    j++;
  }
  if (depth !== 0) return null;
  const labelEnd = j;
  if (md[labelEnd + 1] !== "(") return null;
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
      | "rejected-empty"
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
    chosenStrategy: "rejected-empty",
  };
  if (selStart < 0 || selEnd <= selStart) {
    return { anchor: null, debug };
  }
  const selected = renderedText.slice(selStart, selEnd).trim();
  debug.selectedTrimmed = selected;
  debug.selectedNonWs = nonWsLength(selected);
  // Reject only an empty / whitespace-only selection. Any real selection —
  // even a single character — can be anchored; inline markers store the exact
  // offsets, so there's no fuzzy-locate reason to demand a minimum length.
  if (debug.selectedNonWs === 0) {
    debug.chosenStrategy = "rejected-empty";
    return { anchor: null, debug };
  }

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
