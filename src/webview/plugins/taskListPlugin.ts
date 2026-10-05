// Task-list checkbox interaction.
//
// `@milkdown/preset-gfm` already parses `- [ ]`/`- [x]` into a `list_item`
// with a `checked` attr and renders `<li data-item-type="task"
// data-checked="…">` — there just isn't a visible checkbox (that's
// `plugins.css`) or a way to toggle one by clicking it (this plugin). Milkdown
// ships no command for this, so a click inside the glyph's hit area flips the
// node's `checked` attr directly via `setNodeMarkup`.
//
// `view.editable` gates the toggle off in a read-only view.

import { Plugin } from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/** Roughly the rendered checkbox glyph's width (see plugins.css) — a click
 *  this close to the list item's left edge toggles it; further right is
 *  ordinary text editing (cursor placement, selection). */
const CHECKBOX_HIT_WIDTH = 22;

export function makeTaskListPlugin(): Plugin {
  return new Plugin({
    props: {
      handleClickOn(view: EditorView, _pos: number, node: PmNode, nodePos: number, event: Event): boolean {
        if (node.type.name !== "list_item" || node.attrs.checked == null) return false;
        if (!view.editable) return false;
        const mouse = event as MouseEvent;
        const li = (mouse.target as HTMLElement | null)?.closest('li[data-item-type="task"]');
        if (!li) return false;
        const rect = li.getBoundingClientRect();
        if (mouse.clientX - rect.left > CHECKBOX_HIT_WIDTH) return false;
        view.dispatch(
          view.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, checked: !node.attrs.checked }),
        );
        return true;
      },
    },
  });
}
