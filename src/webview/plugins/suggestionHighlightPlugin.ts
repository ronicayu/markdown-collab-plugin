// Highlights a pending suggestion's anchored text in the document, the way
// `makeAnchorHighlightPlugin` (client.ts) highlights a comment thread's — same
// locate-by-text-and-ordinal approach, same rendered-text↔PM-position mapper,
// a sibling PluginKey so its decoration set is independent, and a distinct
// class so the two never look alike (`mc-hl--suggestion` is the review view's
// name for this; `mdc-` is this view's prefix throughout).
//
// Deliberately NOT folded into makeAnchorHighlightPlugin: a second,
// independent plugin keeps the two decoration sets (and their refreshes)
// apart.
//
// In read-only mode client.ts passes a `place` function, and suggestions are
// placed by source position exactly as threads are: the text-and-ordinal search
// below can land on the wrong occurrence. Edit mode keeps the search.
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { locateAnchorInLiveText, locateNthOccurrence } from "../../collab/liveAnchorLocator";
import { renderedRangeToPmRange, renderedTextOf, type DocLike } from "../../collab/pmPositionMapper";

/** The subset of `SuggestionSummary` (client.ts) this plugin needs. */
export interface SuggestionAnchorLike {
  anchorId: string;
  anchor: { text: string; contextBefore: string; contextAfter: string };
  anchorOrdinal: number;
  /** The anchored span in prose offsets; -1 (or absent) when unanchored. */
  proseStart?: number;
  proseEnd?: number;
}

/** Editor ranges for one suggestion's anchored text — empty when it can't be placed. */
export type PlaceSuggestion = (doc: DocLike, suggestion: SuggestionAnchorLike) => Array<{ from: number; to: number }>;

export const SUGGESTION_HIGHLIGHT_KEY = new PluginKey("mdc-suggestion-highlight");

/** Edit mode's placement: find the anchored occurrence of the text. */
function locateByText(doc: DocLike, haystack: string, s: SuggestionAnchorLike): Array<{ from: number; to: number }> {
  const rendered =
    s.anchorOrdinal >= 0
      ? locateNthOccurrence(haystack, s.anchor.text, s.anchorOrdinal)
      : locateAnchorInLiveText(haystack, s.anchor);
  if (!rendered) return [];
  const pmRange = renderedRangeToPmRange(doc, rendered.start, rendered.end);
  return pmRange ? [pmRange] : [];
}

function buildSuggestionDecorations(
  doc: DocLike,
  suggestions: readonly SuggestionAnchorLike[],
  place: PlaceSuggestion | undefined,
): DecorationSet {
  if (suggestions.length === 0) return DecorationSet.empty;
  const haystack = place ? "" : renderedTextOf(doc);
  const decos: Decoration[] = [];
  for (const s of suggestions) {
    const ranges = place ? place(doc, s) : locateByText(doc, haystack, s);
    for (const r of ranges) {
      decos.push(
        Decoration.inline(
          r.from,
          r.to,
          { class: "mdc-anchor-highlight--suggestion", "data-suggestion-id": s.anchorId, title: "Suggested edit" },
          { id: s.anchorId },
        ),
      );
    }
  }
  return DecorationSet.create(doc as never, decos);
}

/**
 * `getSuggestions` is read fresh on every (re)build — the plugin never caches
 * the list itself, so client.ts owns when a stale list would show wrong
 * highlights (same contract as `makeAnchorHighlightPlugin`/`sidebarState.comments`).
 * `place`, when given, replaces the text search (read-only mode).
 */
export function makeSuggestionHighlightPlugin(
  getSuggestions: () => readonly SuggestionAnchorLike[],
  place?: PlaceSuggestion,
): Plugin {
  return new Plugin({
    key: SUGGESTION_HIGHLIGHT_KEY,
    state: {
      init: (_cfg, state) => buildSuggestionDecorations(state.doc, getSuggestions(), place),
      apply: (tr, old) => {
        const meta = tr.getMeta(SUGGESTION_HIGHLIGHT_KEY);
        if (meta?.refresh) return buildSuggestionDecorations(tr.doc, getSuggestions(), place);
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return SUGGESTION_HIGHLIGHT_KEY.getState(state) as DecorationSet | undefined;
      },
    },
  });
}
