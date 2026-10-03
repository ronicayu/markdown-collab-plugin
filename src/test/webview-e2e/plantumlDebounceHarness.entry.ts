// Standalone browser entry for plantumlDebounceParity.spec.ts, bundled
// on the fly (see that spec's `buildHarnessBundle`) instead of going through
// the shipped webview bundle.
//
// Why a separate harness instead of driving the real live editor through
// `harness.ts`'s `bootLiveEditor`: `plantumlWidgetPlugin.ts` hides a
// plantuml/puml fence's raw source (`PLANTUML_SOURCE_HIDDEN_CLASS`, styled
// `display: none !important` by `src/webview/plugins/plugins.css`) the
// moment it's recognized, with no gap where it's visible and editable — so
// there's no real caret a Playwright `page.keyboard.type()` could land in to
// simulate a person editing an already-rendered fence; browsers refuse to
// place a selection inside `display: none` content at all. This harness
// mounts the exact same, unmodified `makePlantumlPlugin()` against a bare
// ProseMirror `EditorView` (no Milkdown, no `plugins.css`, so the hidden
// class has no visual effect and nothing blocks focus/selection) and drives
// edits straight through ProseMirror's model API — the same thing a real
// keystroke ultimately dispatches — instead of fighting the DOM for a caret
// position the product intentionally makes unreachable.

import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { makePlantumlPlugin, setPlantumlConfig } from "../../webview/plugins/plantumlWidgetPlugin";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      toDOM: () => ["p", 0] as const,
      parseDOM: [{ tag: "p" }],
    },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      defining: true,
      marks: "",
      attrs: { language: { default: null } },
      toDOM: (node) => ["pre", { "data-language": (node.attrs as { language: string }).language ?? "" }, ["code", 0]] as const,
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" as const }],
    },
    text: { group: "inline" },
  },
});

let currentView: EditorView | null = null;

function findCodeBlockEnd(view: EditorView): number {
  let end = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "code_block") end = pos + node.nodeSize - 1;
    return true;
  });
  if (end < 0) throw new Error("plantumlDebounceHarness: no code_block in the document");
  return end;
}

const api = {
  /** Mount a fresh editor with a single plantuml fence holding `initialSrc`. */
  mount(initialSrc: string, serverUrl: string): void {
    setPlantumlConfig({ serverUrl, format: "svg" });
    const container = document.getElementById("editor");
    if (!container) throw new Error("plantumlDebounceHarness: #editor not found");
    const content = initialSrc ? [schema.text(initialSrc)] : [];
    const doc = schema.node("doc", null, [schema.node("code_block", { language: "plantuml" }, content)]);
    const state = EditorState.create({ schema, doc, plugins: [makePlantumlPlugin()] });
    currentView = new EditorView(container, { state });
  },
  /** Insert `ch` at the end of the (sole) plantuml fence's source, the way a
   * real keystroke's transaction would — same `view.dispatch` call path
   * `client.ts`'s own ProseMirror input handling ends up going through. */
  appendChar(ch: string): void {
    if (!currentView) throw new Error("plantumlDebounceHarness: not mounted");
    const end = findCodeBlockEnd(currentView);
    currentView.dispatch(currentView.state.tr.insertText(ch, end));
  },
};

(window as unknown as { __plantumlHarness: typeof api }).__plantumlHarness = api;
