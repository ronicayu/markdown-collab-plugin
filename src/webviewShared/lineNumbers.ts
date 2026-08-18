// Source line numbers for the rendered surfaces.
//
// Both surfaces render *prose* — the document with markers, the threads region,
// and frontmatter stripped — so a line number computed from what they render is
// not the line number in the file. The host supplies a prose-line → source-line
// table (`sourceLineForProseLine`); this module supplies the other half: which
// prose line each rendered block came from.
//
// A wrong line number is worse than no line number, because it sends someone to
// the wrong place in their own document and looks authoritative doing it. Both
// helpers here are therefore conservative: they label only blocks whose line is
// known, and `topLevelBlockLines` reports what it found so a caller can decline
// to show anything if the shape it expected didn't hold.

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/** Attribute carrying the 0-based prose line a rendered block starts on. */
export const LINE_ATTR = "data-mc-line";

/** Render env flag that switches the attribute on for a single render. */
export const LINE_ENV_KEY = "mcLineNumbers";

/**
 * Stamp every top-level block element with the prose line it starts on, but
 * only when this render asked for it (`md.render(src, { mcLineNumbers: true })`).
 *
 * Per-render rather than per-renderer: the surfaces build their renderer once
 * at load, the setting can change at any time, and markup nobody is going to
 * display should not appear in everyone's DOM in the meantime.
 *
 * Only top level: a list item inside a list would otherwise get its own number
 * in the gutter, turning a tidy column into a cluster next to every list.
 */
export function installLineNumberPlugin(md: MarkdownIt): void {
  md.core.ruler.push("mc-line-numbers", (state) => {
    if (!(state.env as Record<string, unknown> | undefined)?.[LINE_ENV_KEY]) return true;
    let depth = 0;
    for (const token of state.tokens as Token[]) {
      if (token.nesting === -1) depth--;
      if (depth === 0 && token.map) token.attrSet(LINE_ATTR, String(token.map[0]));
      if (token.nesting === 1) depth++;
    }
    return true;
  });
}

/**
 * The prose line each top-level block starts on, in document order.
 *
 * For the live editor, whose ProseMirror document has no source positions at
 * all. Its top-level nodes are the same sequence of blocks CommonMark parses,
 * so the Nth entry here belongs to the Nth top-level node — and when the two
 * counts disagree, the caller shows nothing rather than a column of numbers
 * that are quietly off by one from some point onward.
 */
export function topLevelBlockLines(markdown: string): number[] {
  // A bare instance: this parses for positions only and must not inherit the
  // rendering surfaces' plugins, which exist to produce HTML.
  const md = new MarkdownIt();
  const lines: number[] = [];
  let depth = 0;
  for (const token of md.parse(markdown, {}) as Token[]) {
    if (token.nesting === -1) depth--;
    if (depth === 0 && token.map) lines.push(token.map[0]);
    if (token.nesting === 1) depth++;
  }
  return lines;
}

/**
 * Resolve a 0-based prose line to the 1-based source line to display, or null
 * when the table doesn't cover it — a table built for an older revision of the
 * document is exactly when a confidently wrong number would appear.
 */
export function displayLine(lineMap: readonly number[] | undefined, proseLine: number): number | null {
  if (!lineMap || proseLine < 0 || proseLine >= lineMap.length) return null;
  return lineMap[proseLine];
}
