// Webview client: CodeMirror 6 + Yjs + y-codemirror.next.
//
// Runs inside a VSCode webview iframe. Talks to the extension host via
// postMessage for file persistence, and to a y-websocket server for
// peer sync (multi-cursor, real-time edits).
//
// Lifecycle:
//   1. Extension sends { type: 'init', text, room, serverUrl, user }.
//   2. Webview spins up Yjs doc + WebsocketProvider + CodeMirror editor.
//   3. If we are the first peer in the room, seed the Y.Text with `text`.
//      Otherwise, the provider hands us the existing Y.Doc state.
//   4. On every Yjs update we post a debounced { type: 'edit', text }
//      back to the extension so the underlying TextDocument is kept fresh.
//   5. Extension may push { type: 'externalChange', text } when the file
//      changed on disk while no local edits were in flight; we replace the
//      Y.Text contents in a transaction.

import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { encodeSeedText } from "../collab/seedEncoding";

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
};

interface InitMessage {
  type: "init";
  text: string;
  room: string;
  serverUrl: string;
  user: { name: string; color: string };
}

interface ExternalChangeMessage {
  type: "externalChange";
  text: string;
}

type IncomingMessage = InitMessage | ExternalChangeMessage;

const vscode = acquireVsCodeApi();

let view: EditorView | null = null;
let ydoc: Y.Doc | null = null;
let provider: WebsocketProvider | null = null;
// True while we are applying an external file change so the resulting Yjs
// observe callback skips re-posting back to the extension (avoids a feedback
// loop with vscode.workspace.onDidChangeTextDocument).
let suppressNextPost = false;

function init(msg: InitMessage): void {
  ydoc = new Y.Doc();
  const ytext = ydoc.getText("doc");

  // The server is the single source of truth for "first peer wins": it
  // accepts an `init` query param the first time a room is created and
  // ignores it for every later connection. Doing the seed client-side is
  // racy when two peers connect simultaneously (both observe an empty doc,
  // both insert, you get duplicated text).
  const params: { [k: string]: string } = {};
  if (msg.text.length > 0) params.init = encodeSeedText(msg.text);
  provider = new WebsocketProvider(msg.serverUrl, msg.room, ydoc, {
    connect: true,
    params,
  });

  provider.awareness.setLocalStateField("user", msg.user);

  const undoManager = new Y.UndoManager(ytext);

  const state = EditorState.create({
    doc: ytext.toString(),
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.theme(
        {
          "&": { height: "100vh", fontSize: "14px" },
          ".cm-scroller": { fontFamily: "var(--vscode-editor-font-family, monospace)" },
        },
        { dark: true },
      ),
      yCollab(ytext, provider.awareness, { undoManager }),
    ],
  });

  view = new EditorView({ state, parent: document.body });

  // Debounced extension-side persistence. CRDT sync is handled by the
  // provider; this only keeps the on-disk TextDocument in step.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  ytext.observe(() => {
    if (suppressNextPost) {
      suppressNextPost = false;
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      vscode.postMessage({ type: "edit", text: ytext.toString() });
    }, 250);
  });

  // Expose connection state in a corner badge for debugging.
  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;bottom:6px;right:8px;font:11px var(--vscode-font-family);" +
    "padding:2px 6px;border-radius:3px;background:var(--vscode-badge-background);" +
    "color:var(--vscode-badge-foreground);opacity:0.7;pointer-events:none;z-index:1000";
  document.body.appendChild(badge);
  const refreshBadge = (): void => {
    const peers = provider ? provider.awareness.getStates().size : 0;
    const status = provider?.wsconnected ? "connected" : "offline";
    badge.textContent = `${status} · ${peers} peer${peers === 1 ? "" : "s"}`;
  };
  refreshBadge();
  provider.on("status", refreshBadge);
  provider.awareness.on("change", refreshBadge);
}

function applyExternalChange(text: string): void {
  if (!ydoc || !view) return;
  const ytext = ydoc.getText("doc");
  if (ytext.toString() === text) return;
  suppressNextPost = true;
  ydoc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  }, "external");
}

window.addEventListener("message", (e: MessageEvent<IncomingMessage>) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    if (view) return;
    init(msg);
  } else if (msg.type === "externalChange") {
    applyExternalChange(msg.text);
  }
});

vscode.postMessage({ type: "ready" });
