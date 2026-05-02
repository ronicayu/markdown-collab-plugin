// WYSIWYG markdown editor inside a VSCode webview.
//
// Architecture:
//   Milkdown (ProseMirror under the hood) provides the WYSIWYG surface —
//   headers render as headers, **bold** renders as bold text, lists as
//   lists, etc. The user never types or sees raw markdown.
//
//   Yjs collab is wired through @milkdown/plugin-collab → y-prosemirror,
//   which uses Y.XmlFragment("prosemirror") (not Y.Text) as the CRDT.
//
// Lifecycle:
//   1. Extension sends { type: 'init', text, room, serverUrl, user }.
//   2. Webview spins up Y.Doc + WebsocketProvider + Milkdown editor.
//   3. After provider syncs (or 1.5s grace), bind the doc to Milkdown's
//      collabService and applyTemplate(text). applyTemplate only seeds
//      when the remote doc is still empty — second peers see the existing
//      content untouched.
//   4. Listener plugin posts a debounced { type: 'edit', markdown } back
//      to the extension on every mutation so the on-disk file stays in
//      step. Markdown is what we save — Milkdown's serializer round-trips
//      the ProseMirror state to commonmark.

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { history } from "@milkdown/plugin-history";
import { nord } from "@milkdown/theme-nord";
import "@milkdown/theme-nord/style.css";
import "./host.css";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

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

let editor: Editor | null = null;
let ydoc: Y.Doc | null = null;
let provider: WebsocketProvider | null = null;
// True while we are applying an external file change so the listener skips
// re-posting back to the extension (avoids a feedback loop with
// vscode.workspace.onDidChangeTextDocument).
let suppressNextPost = false;

async function init(msg: InitMessage): Promise<void> {
  ydoc = new Y.Doc();
  provider = new WebsocketProvider(msg.serverUrl, msg.room, ydoc, {
    connect: true,
  });
  provider.awareness.setLocalStateField("user", msg.user);

  const root = document.body;
  // Wrap the Milkdown surface in a fixed container so the nord theme's
  // padding doesn't fight the iframe's edges.
  const container = document.createElement("div");
  container.className = "milkdown-host";
  root.appendChild(container);

  let lastSeenMarkdown = msg.text;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, container);
      ctx.set(defaultValueCtx, msg.text);
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (suppressNextPost) {
          suppressNextPost = false;
          return;
        }
        if (markdown === prevMarkdown) return;
        lastSeenMarkdown = markdown;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          vscode.postMessage({ type: "edit", text: markdown });
        }, 250);
      });
    })
    .config(nord)
    .use(commonmark)
    .use(history)
    .use(listener)
    .use(collab)
    .create();

  // Wire collab. The pattern is: bind the Y.Doc + awareness, then either
  // apply the template (we are the first peer — populate from msg.text) or
  // connect immediately (we joined an existing session — accept what the
  // relay hands us). applyTemplate's default condition is "remote doc is
  // an empty document", so it's a no-op for late joiners.
  const startCollab = (synced: boolean): void => {
    if (!editor) return;
    editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx);
      collabService
        .bindDoc(ydoc!)
        .setAwareness(provider!.awareness)
        .applyTemplate(msg.text)
        .connect();
    });
    reportReady(synced);
  };

  let started = false;
  const startOnce = (synced: boolean): void => {
    if (started) return;
    started = true;
    startCollab(synced);
  };
  provider.once("sync", (synced: boolean) => startOnce(synced));
  setTimeout(() => startOnce(false), 1500);

  // Connection-state badge.
  const badge = document.createElement("div");
  badge.className = "collab-badge";
  document.body.appendChild(badge);
  const refreshBadge = (): void => {
    const peers = provider ? provider.awareness.getStates().size : 0;
    const status = provider?.wsconnected ? "connected" : "offline";
    badge.textContent = `${status} · ${peers} peer${peers === 1 ? "" : "s"}`;
  };
  refreshBadge();
  provider.on("status", refreshBadge);
  provider.awareness.on("change", refreshBadge);

  // Touch lastSeenMarkdown so noUnusedLocals doesn't fire — we keep the
  // ref so applyExternalChange can compare and skip no-op writes.
  void lastSeenMarkdown;
}

function reportReady(synced: boolean): void {
  if (!editor) return;
  let length = 0;
  let error: string | undefined;
  try {
    editor.action((ctx) => {
      const serializer = ctx.get(serializerCtx);
      const view = ctx.get(editorViewCtx);
      length = serializer(view.state.doc).length;
    });
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
  }
  vscode.postMessage({ type: "ready-with-content", length, synced, error });
}

function applyExternalChange(text: string): void {
  if (!editor) return;
  suppressNextPost = true;
  // Re-seed the editor's content. The collab plugin sees this as a local
  // change and broadcasts it through the relay to other peers, which is
  // the right behaviour: external file edits should propagate.
  editor.action((ctx) => {
    ctx.set(defaultValueCtx, text);
  });
  // applyTemplate with `true` condition forces the replacement to take
  // effect even when the doc is non-empty.
  editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx);
    collabService.applyTemplate(text, () => true);
  });
}

function postError(stage: string, err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  vscode.postMessage({ type: "webview-error", stage, message });
}

window.addEventListener("error", (e) => postError("uncaught", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => postError("unhandled-rejection", e.reason));

window.addEventListener("message", (e: MessageEvent<IncomingMessage>) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    if (editor) return;
    init(msg).catch((err) => postError("init", err));
  } else if (msg.type === "externalChange") {
    try {
      applyExternalChange(msg.text);
    } catch (err) {
      postError("externalChange", err);
    }
  }
});

vscode.postMessage({ type: "ready" });
