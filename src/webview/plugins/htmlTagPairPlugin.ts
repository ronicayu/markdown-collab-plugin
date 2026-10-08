// Inline HTML formatting in the live editor: `x<sup>2</sup>`, `<kbd>Ctrl</kbd>`.
//
// Milkdown parses each tag as its own opaque `html` node, so `<sup>2</sup>` is
// three siblings — `<sup>`, the text "2", `</sup>` — and no single node knows
// what to render. This plugin pairs them per textblock and styles the text in
// between with an inline decoration whose `nodeName` is the tag, so the
// document keeps its nodes (and its markdown round-trips byte for byte) while
// the reader sees a superscript. The two tag nodes get a class the html node
// view uses to hide them in Reading mode; Editing keeps them visible, so a tag
// is never deleted without being seen.
//
// Only tags `classifyHtml` accepts as a single clean allowlisted tag pair, and
// only their sanitized attributes reach the decoration.

import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import { classifyHtml, INLINE_PAIR_TAGS } from "../../webviewShared/htmlSanitize";

export const HTML_TAG_PAIR_KEY = new PluginKey<DecorationSet>("mdc-html-tag-pairs");

/** Added to both tag nodes of a matched pair. */
export const PAIRED_TAG_CLASS = "mdc-html-tag--paired";

interface OpenTag {
  name: string;
  attrs: Record<string, string>;
  from: number;
  to: number;
}

export function htmlTagPairDecorations(doc: PmNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    const open: OpenTag[] = [];
    block.forEach((child, offset) => {
      if (child.type.name !== "html") return;
      const snippet = classifyHtml(String(child.attrs.value ?? ""));
      if (snippet.kind !== "tag" || !INLINE_PAIR_TAGS.has(snippet.tag.name)) return;
      const from = blockPos + 1 + offset;
      const to = from + child.nodeSize;
      if (!snippet.tag.closing) {
        open.push({ name: snippet.tag.name, attrs: snippet.tag.attrs, from, to });
        return;
      }
      // Nearest unclosed tag of the same name; anything opened after it and
      // never closed stays unpaired (and therefore visible).
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].name !== snippet.tag.name) continue;
        const start = open[i];
        open.length = i;
        if (from > start.to) decos.push(Decoration.inline(start.to, from, { nodeName: start.name, ...start.attrs }));
        decos.push(Decoration.node(start.from, start.to, { class: PAIRED_TAG_CLASS }));
        decos.push(Decoration.node(from, to, { class: PAIRED_TAG_CLASS }));
        break;
      }
    });
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function makeHtmlTagPairPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: HTML_TAG_PAIR_KEY,
    state: {
      init: (_config, state) => htmlTagPairDecorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? htmlTagPairDecorations(tr.doc) : old),
    },
    props: {
      decorations: (state) => HTML_TAG_PAIR_KEY.getState(state),
    },
  });
}
