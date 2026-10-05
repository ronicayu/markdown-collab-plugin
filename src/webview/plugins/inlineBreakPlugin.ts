// Recovers an inline `<br>` from Milkdown's commonmark preset, which drops it
// silently.
//
// remark-parse turns any raw `<br>`/`<br/>`/`<br />`/`<br >` into an mdast
// "html" node. `@milkdown/preset-commonmark`'s `remarkPreserveEmptyLinePlugin`
// writes a lone `<br />` as an empty paragraph's placeholder on serialize, and
// on the next parse deletes any "html" node matching one of those four
// spellings so the placeholder doesn't show up as text. But its match is
// unconditional — it deletes EVERY such node, including one the user typed in
// the middle of a line, which is why it vanishes instead of rendering as a
// break.
//
// This plugin runs first (registered before `commonmark` in client.ts, so it
// sees the tree before that strip, and before `remarkHtmlTransformer`) and
// reclassifies a `<br>`-like node from "html" to mdast's own "break" — the node
// type a real two-space hard break produces, which
// `hardbreakSchema.parseMarkdown` (preset-commonmark) already turns into a
// rendered `<br>`.
//
// It only reclassifies a node whose PARENT is already an inline container (a
// paragraph, heading, table cell, ...) with more than one child — i.e. a `<br>`
// genuinely embedded in a line of text, e.g. "Line one<br>Line two". That shape
// only exists straight out of remark-parse: CommonMark's HTML block rule
// (type 7) can't start mid-paragraph.
//
// A `<br>` that IS its own block — alone on a line surrounded by blank lines,
// whether the user wrote it that way or it's the empty-paragraph placeholder —
// parses as an "html" node whose parent is "root"/"blockquote"/"listItem" (a
// block container), not yet wrapped in a paragraph; `remarkHtmlTransformer` (a
// later commonmark plugin) does that wrapping. By the time *this* plugin runs
// that hasn't happened, so the reliable signal is the parent's type, not a
// sibling count — those are left alone for the existing pipeline so a
// standalone `<br>` and the placeholder both keep behaving as before.
//
// Registration order matters and is enforced in client.ts, not here: Milkdown
// resolves every `$remark` plugin's `ctx.wait(InitReady)` in the order
// `#prepare` called each plugin (i.e. `.use()` call order), so
// `.use(inlineBreakPlugin)` before `.use(commonmark)` runs this transform
// before both of those.

import { $remark } from "@milkdown/utils";

const BR_VALUES = new Set(["<br />", "<br>", "<br/>", "<br >"]);

// Mirrors remarkHtmlTransformer's own `BLOCK_CONTAINER_TYPES` exactly — a
// block-level `<br>`'s parent is one of these until that later plugin wraps
// it into a paragraph.
const BLOCK_CONTAINER_TYPES = new Set(["root", "blockquote", "listItem"]);

export interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

function isBrHtmlNode(node: MdastNode): boolean {
  return node.type === "html" && typeof node.value === "string" && BR_VALUES.has(node.value.trim());
}

/** Mutates `tree` in place. */
export function convertInlineBreaks(tree: MdastNode): void {
  const children = tree.children;
  if (!children || children.length === 0) return;
  for (const child of children) convertInlineBreaks(child);
  if (BLOCK_CONTAINER_TYPES.has(tree.type)) return; // block-level <br> — leave for the existing pipeline
  if (children.length < 2) return; // sole inline child — same placeholder shape
  for (const child of children) {
    if (isBrHtmlNode(child)) {
      child.type = "break";
      delete child.value;
    }
  }
}

export const inlineBreakPlugin = $remark("mdcInlineBreak", () => () => (tree: unknown) => {
  convertInlineBreaks(tree as MdastNode);
});
