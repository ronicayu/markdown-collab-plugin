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

function buildPlantumlDecorations(doc: DocLike): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    const lang = (node.attrs ?? {}).language as string | undefined;
    if (!isPlantumlLang(lang)) return true;
    const src = (node as unknown as { textContent: string }).textContent;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: PLANTUML_SOURCE_HIDDEN_CLASS }));
    decos.push(
      Decoration.widget(pos, () => makePlantumlWidget(src), {
        side: -1,
        ignoreSelection: true,
        key: `plantuml-${pos}-${src.length}`,
      }),
    );
    return true;
  });
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
      wrap.innerHTML = `<div class="mdc-plantuml__error">Could not load the PlantUML diagram from ${escapeHtml(config.serverUrl)}.</div>`;
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
        tr.docChanged ? buildPlantumlDecorations(tr.doc as unknown as DocLike) : old.map(tr.mapping, tr.doc),
    },
    props: {
      decorations(state) {
        return plantumlPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}
