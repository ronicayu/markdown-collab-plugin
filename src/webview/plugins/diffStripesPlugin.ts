// Milkdown glue for the uncommitted-diff overlay. The range→node mapping itself
// is pure and lives in `src/collab/diffStripes.ts` (same split as
// `src/webview/sourcePositionPlugin.ts` / `src/collab/sourcePositions.ts`);
// this file turns that into ProseMirror decorations: a `.mdc-diff-changed`
// node decoration per changed block, and a `.mdc-diff-removed` DOM widget
// per deleted run, struck through and scrollable so a tall removal doesn't
// swallow the page.

import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PmDocNode } from "prosemirror-model";
import {
  removedWidgetPosition,
  stripedBlockRanges,
  type DiffPmNode,
  type DiffRemovedRun,
  type DiffState,
} from "../../collab/diffStripes";

export type { DiffLineRange, DiffPmNode, DiffRemovedRun, DiffState } from "../../collab/diffStripes";

export const DIFF_STRIPES_KEY = new PluginKey("mdc-diff-stripes");

function buildRemovedWidgetDom(run: DiffRemovedRun): HTMLElement {
  const div = document.createElement("div");
  div.className = "mdc-diff-removed";
  div.setAttribute("contenteditable", "false");
  const label = document.createElement("div");
  label.className = "mdc-diff-removed-label";
  const n = run.text.split("\n").length;
  label.textContent = `removed — this was in HEAD (${n} line${n === 1 ? "" : "s"})`;
  const pre = document.createElement("pre");
  pre.className = "mdc-diff-removed-text";
  pre.textContent = run.text;
  div.append(label, pre);
  return div;
}

function buildDiffDecorations(doc: PmDocNode, prose: string, diff: DiffState | null): DecorationSet {
  if (!diff) return DecorationSet.empty;
  const asDiffNode = doc as unknown as DiffPmNode;
  const decos: Decoration[] = [];
  for (const range of stripedBlockRanges(asDiffNode, prose, diff.addedRanges)) {
    decos.push(Decoration.node(range.from, range.to, { class: "mdc-diff-changed" }));
  }
  // A removed run that was only blank lines has nothing visible to show —
  // same filter the review view applies before painting.
  for (const run of diff.removed ?? []) {
    if (run.text.trim() === "") continue;
    const pos = removedWidgetPosition(asDiffNode, prose, run.afterLine);
    decos.push(
      Decoration.widget(pos, () => buildRemovedWidgetDom(run), {
        side: 1,
        ignoreSelection: true,
        key: `mdc-diff-removed-${run.afterLine}-${run.text.length}`,
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

export type GetDiff = () => DiffState | null;
export type GetProse = () => string;

/**
 * Decorates changed top-level blocks with `.mdc-diff-changed` and inserts a
 * `.mdc-diff-removed` widget for each deleted run — the live editor's
 * read-only counterpart of the review view's stripes. `getDiff`/`getProse` are
 * read fresh on every (re)build: this plugin never caches the diff itself, so
 * client.ts owns when a stale one would show wrong stripes, by dispatching a
 * `{ refresh: true }` meta on this key.
 */
export function makeDiffStripesPlugin(getDiff: GetDiff, getProse: GetProse): Plugin {
  return new Plugin({
    key: DIFF_STRIPES_KEY,
    state: {
      init: (_cfg, state) => buildDiffDecorations(state.doc, getProse(), getDiff()),
      apply: (tr, old, _oldState, newState) => {
        const meta = tr.getMeta(DIFF_STRIPES_KEY) as { refresh?: boolean } | undefined;
        if (meta?.refresh) return buildDiffDecorations(newState.doc, getProse(), getDiff());
        return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
      },
    },
    props: {
      decorations(state) {
        return DIFF_STRIPES_KEY.getState(state) as DecorationSet | undefined;
      },
    },
  });
}
