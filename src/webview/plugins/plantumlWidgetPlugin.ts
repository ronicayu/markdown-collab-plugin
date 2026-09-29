// PlantUML fences (```plantuml / ```puml) as a rendered-image widget —
// the live editor's counterpart to the review view's `src/plantumlPlugin.ts`.
//
// Reuses that same module's `renderPlantumlFence` so both surfaces hit the
// same server URL, hex encoding and format setting
// (`markdownCollab.plantuml.serverUrl` / `.format`, passed down from the host
// on `init` — see `setPlantumlConfig`). The fence's raw source is hidden once
// the widget is showing, matching the review view (a plain `<figure><img>`,
// no visible fence) rather than the "both show" bug this closes.

import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import { renderPlantumlFence } from "../../plantumlPlugin";

export interface PlantumlConfig {
  serverUrl: string;
  format: "svg" | "png";
}

const DEFAULT_CONFIG: PlantumlConfig = {
  serverUrl: "https://www.plantuml.com/plantuml",
  format: "svg",
};

let config: PlantumlConfig = DEFAULT_CONFIG;

/** Set from the host's `init` payload — falls back to the review view's own default. */
export function setPlantumlConfig(next: PlantumlConfig | undefined): void {
  config = next ?? DEFAULT_CONFIG;
}

export const PLANTUML_SOURCE_HIDDEN_CLASS = "mdc-plantuml-source-hidden";

const plantumlPluginKey = new PluginKey("mdc-plantuml");

/** How long a fence's source must sit unchanged before its image re-fetches
 * (security review — every keystroke was sending that draft to the
 * configured PlantUML server, plantuml.com by default). */
const DEBOUNCE_MS = 1000;

function isPlantumlLang(lang: string | undefined): boolean {
  return lang === "plantuml" || lang === "puml";
}

interface DocLike {
  descendants: (
    cb: (
      node: { isText: boolean; nodeSize: number; text?: string; type: { name: string }; attrs?: Record<string, unknown> },
      pos: number,
    ) => boolean | void,
  ) => void;
}

/**
 * One fence's debounce bookkeeping, keyed by document position — stable
 * while the user types inside that fence, since typing doesn't move the
 * code_block's own start position. `committedSrc` is the source the widget
 * currently reflects (and what its `<img>` was actually fetched for);
 * the document's current text for that fence (read fresh on every rebuild,
 * not stored here) is whatever it holds right now. They diverge for up to
 * `DEBOUNCE_MS` while a timer is pending — the
 * decoration key stays pinned to `committedSrc` the whole time, so ProseMirror
 * keeps the existing widget (and its already-loaded image) on screen instead
 * of tearing it down for a fresh, uncommitted fetch on every keystroke.
 */
interface FenceState {
  committedSrc: string;
  timer: ReturnType<typeof setTimeout> | null;
}
const fenceState = new Map<number, FenceState>();

/** The view currently hosting this plugin, so a debounce timer that fires
 * later can ask it to repaint — set by the plugin's `view()` constructor,
 * mirroring client.ts's `refreshMermaidDecorations` for the same reason
 * (mermaid's render is async; here it's the debounce timer that resolves
 * after the fact instead of synchronously inside a transaction). */
let activeView: EditorView | null = null;

/** Cheap content identity for the decoration key. Keying on `src.length`
 * (the pre-fix behavior) missed same-length edits and fetched on every
 * length-changing keystroke; a hash of the actual (debounced) content is
 * both more correct and, since it only ever changes when `committedSrc`
 * does, exactly as stable as that source is. */
function hashSrc(src: string): string {
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (Math.imul(h, 31) + src.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function scheduleCommit(state: FenceState, liveSrc: string): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    state.committedSrc = liveSrc;
    // Nothing else changed the doc, so nothing else would otherwise ask the
    // view to recompute decorations with the now-updated key.
    activeView?.dispatch(activeView.state.tr.setMeta(plantumlPluginKey, "refresh"));
  }, DEBOUNCE_MS);
}

function buildPlantumlDecorations(doc: DocLike): DecorationSet {
  const decos: Decoration[] = [];
  const seen = new Set<number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    const lang = (node.attrs ?? {}).language as string | undefined;
    if (!isPlantumlLang(lang)) return true;
    const liveSrc = (node as unknown as { textContent: string }).textContent;
    seen.add(pos);

    let state = fenceState.get(pos);
    if (!state) {
      // First time this position is seen (fresh mount, or a position that
      // moved because something *else* in the doc changed) — nothing to
      // debounce yet, so show it immediately.
      state = { committedSrc: liveSrc, timer: null };
      fenceState.set(pos, state);
    } else if (state.committedSrc !== liveSrc) {
      scheduleCommit(state, liveSrc);
    }

    const committedSrc = state.committedSrc;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: PLANTUML_SOURCE_HIDDEN_CLASS }));
    decos.push(
      Decoration.widget(pos, () => makePlantumlWidget(committedSrc), {
        side: -1,
        ignoreSelection: true,
        key: `plantuml-${pos}-${hashSrc(committedSrc)}`,
      }),
    );
    return true;
  });
  // Drop bookkeeping for fences that no longer exist (deleted, or the block
  // stopped being a plantuml/puml fence) so a stale timer can't fire later.
  for (const [pos, state] of fenceState) {
    if (seen.has(pos)) continue;
    if (state.timer !== null) clearTimeout(state.timer);
    fenceState.delete(pos);
  }
  return DecorationSet.create(doc as never, decos);
}

function makePlantumlWidget(src: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mdc-plantuml";
  if (!src.trim()) {
    wrap.innerHTML = "<em>(empty plantuml block)</em>";
    return wrap;
  }
  wrap.innerHTML = renderPlantumlFence(src, config.serverUrl, config.format);
  // The URL is built synchronously (no client-side rendering step, unlike
  // mermaid), so the only failure mode is the browser failing to load the
  // image — a dead server, an unreachable network. Caption it in place
  // rather than silently showing a broken-image icon.
  const img = wrap.querySelector("img");
  img?.addEventListener(
    "error",
    () => {
      wrap.innerHTML = `<div class="mdc-plantuml__error">PlantUML server didn't return an image — check markdownCollab.plantuml.serverUrl (currently ${escapeHtml(config.serverUrl)}).</div>`;
    },
    { once: true },
  );
  return wrap;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function makePlantumlPlugin(): Plugin {
  return new Plugin({
    key: plantumlPluginKey,
    state: {
      init: (_cfg, state) => buildPlantumlDecorations(state.doc as unknown as DocLike),
      apply: (tr, old) =>
        tr.docChanged || tr.getMeta(plantumlPluginKey) === "refresh"
          ? buildPlantumlDecorations(tr.doc as unknown as DocLike)
          : old.map(tr.mapping, tr.doc),
    },
    view(editorView) {
      activeView = editorView;
      return {
        destroy() {
          if (activeView === editorView) activeView = null;
          for (const state of fenceState.values()) {
            if (state.timer !== null) clearTimeout(state.timer);
          }
          fenceState.clear();
        },
      };
    },
    props: {
      decorations(state) {
        return plantumlPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}
