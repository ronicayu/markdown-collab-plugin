// WYSIWYG markdown editor inside a VSCode webview, with a sidebar for
// review comments backed by the same .md.json sidecar the standard editor
// uses.
//
// Architecture:
//   - Milkdown (ProseMirror under the hood) provides the WYSIWYG surface —
//     headers render as headers, tables render as tables, etc.
//   - Yjs collab is wired through @milkdown/plugin-collab → y-prosemirror,
//     which uses Y.XmlFragment("prosemirror") as the CRDT.
//   - The comments sidebar reads the sidecar via the extension (postMessage
//     init / sidecar-changed). Selecting text in the editor exposes an
//     "Add comment" affordance; submitting it builds an Anchor (text +
//     contextBefore + contextAfter) from the current markdown serialization
//     and posts add-comment back to the extension, which writes the sidecar.

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
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

interface CommentSummary {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  anchor: { text: string; contextBefore: string; contextAfter: string };
  replies: Array<{ author: string; body: string; createdAt: string }>;
}

interface InitMessage {
  type: "init";
  text: string;
  room: string;
  serverUrl: string;
  user: { name: string; color: string };
  comments: CommentSummary[];
}

interface ExternalChangeMessage {
  type: "externalChange";
  text: string;
}

interface SidecarChangedMessage {
  type: "sidecar-changed";
  comments: CommentSummary[];
}

interface AddCommentResultMessage {
  type: "add-comment-result";
  ok: boolean;
  error?: string;
}

type IncomingMessage =
  | InitMessage
  | ExternalChangeMessage
  | SidecarChangedMessage
  | AddCommentResultMessage;

const vscode = acquireVsCodeApi();

let editor: Editor | null = null;
let ydoc: Y.Doc | null = null;
let provider: WebsocketProvider | null = null;
let suppressNextPost = false;

const sidebarState: { comments: CommentSummary[] } = { comments: [] };
let sidebarEl: HTMLElement | null = null;
let composerEl: HTMLElement | null = null;
let editorContainer: HTMLElement | null = null;

const ANCHOR_CONTEXT_LEN = 24;
const MIN_ANCHOR_NON_WS_CHARS = 8;

async function init(msg: InitMessage): Promise<void> {
  ydoc = new Y.Doc();
  provider = new WebsocketProvider(msg.serverUrl, msg.room, ydoc, {
    connect: true,
  });
  provider.awareness.setLocalStateField("user", msg.user);

  buildLayout();
  sidebarState.comments = msg.comments ?? [];
  renderSidebar();

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorContainer!);
      ctx.set(defaultValueCtx, msg.text);
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (suppressNextPost) {
          suppressNextPost = false;
          return;
        }
        if (markdown === prevMarkdown) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          vscode.postMessage({ type: "edit", text: markdown });
        }, 250);
      });
    })
    .config(nord)
    .use(commonmark)
    // GFM extends commonmark with tables, task lists, strikethrough,
    // autolinks, and footnotes. Must come AFTER commonmark so its
    // schema overrides take effect.
    .use(gfm)
    .use(history)
    .use(listener)
    .use(collab)
    .create();

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

  // Add-comment affordance: a floating button that appears when the user
  // has a non-empty editor selection. Clicking it opens the composer in
  // the sidebar with the selection's plain text pre-filled as the anchor.
  installAddCommentAffordance();
}

function buildLayout(): void {
  document.body.innerHTML = "";
  const layout = document.createElement("div");
  layout.className = "mdc-layout";
  document.body.appendChild(layout);

  editorContainer = document.createElement("div");
  editorContainer.className = "mdc-editor-pane";
  layout.appendChild(editorContainer);

  sidebarEl = document.createElement("aside");
  sidebarEl.className = "mdc-sidebar";
  sidebarEl.setAttribute("aria-label", "Review comments");
  layout.appendChild(sidebarEl);
}

function renderSidebar(): void {
  if (!sidebarEl) return;
  const total = sidebarState.comments.length;
  const unresolved = sidebarState.comments.filter((c) => !c.resolved).length;

  const header = `
    <div class="mdc-sidebar-header">
      <div class="mdc-sidebar-title">Comments</div>
      <div class="mdc-sidebar-subtitle">${unresolved} open · ${total} total</div>
    </div>
  `;

  const composerSlot = '<div class="mdc-composer-slot"></div>';

  let body: string;
  if (total === 0) {
    body = `<div class="mdc-sidebar-empty">No comments yet.<br><br>Select text in the editor and press <kbd>+ Add comment</kbd> to start a thread.</div>`;
  } else {
    body = sidebarState.comments
      .slice()
      .sort((a, b) => Number(a.resolved) - Number(b.resolved))
      .map((c) => renderCommentCard(c))
      .join("");
  }

  sidebarEl.innerHTML = header + composerSlot + `<div class="mdc-comment-list">${body}</div>`;
  composerEl = sidebarEl.querySelector(".mdc-composer-slot");
  attachCommentClickHandlers();
}

function renderCommentCard(c: CommentSummary): string {
  const anchorText = escapeHtml(c.anchor.text.length > 80 ? c.anchor.text.slice(0, 77) + "…" : c.anchor.text);
  const replies = c.replies
    .map(
      (r) =>
        `<div class="mdc-reply"><span class="mdc-reply-author">${escapeHtml(r.author)}</span><span class="mdc-reply-body">${escapeHtml(r.body)}</span></div>`,
    )
    .join("");
  return `
    <article class="mdc-comment ${c.resolved ? "mdc-comment--resolved" : ""}" data-id="${escapeHtml(c.id)}">
      <header class="mdc-comment-header">
        <span class="mdc-comment-author">${escapeHtml(c.author)}</span>
        <span class="mdc-comment-meta">${c.resolved ? "resolved" : "open"}</span>
      </header>
      <div class="mdc-comment-anchor" title="Click to scroll to the anchor in the editor">${anchorText}</div>
      <div class="mdc-comment-body">${escapeHtml(c.body)}</div>
      ${replies ? `<div class="mdc-replies">${replies}</div>` : ""}
    </article>
  `;
}

function attachCommentClickHandlers(): void {
  if (!sidebarEl) return;
  for (const card of Array.from(sidebarEl.querySelectorAll<HTMLElement>(".mdc-comment"))) {
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      const comment = sidebarState.comments.find((c) => c.id === id);
      if (comment) scrollToAnchor(comment.anchor.text);
    });
  }
}

function scrollToAnchor(text: string): void {
  if (!editor || !text) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const haystack = view.state.doc.textContent;
    const idx = haystack.indexOf(text);
    if (idx < 0) return;
    // ProseMirror positions count gaps between nodes; mapping plain text
    // offsets to PM positions exactly is non-trivial. As a pragmatic
    // approximation we walk the doc and accumulate textual content.
    let pmPos = 0;
    let textCounted = 0;
    view.state.doc.descendants((node, pos) => {
      if (textCounted >= idx) return false;
      if (node.isText) {
        const remaining = idx - textCounted;
        if (remaining < node.nodeSize) {
          pmPos = pos + remaining;
          textCounted = idx;
          return false;
        }
        textCounted += node.nodeSize;
      }
      return true;
    });
    if (pmPos > 0) {
      view.focus();
      const dom = view.domAtPos(pmPos).node as Element | null;
      if (dom && (dom as HTMLElement).scrollIntoView) {
        (dom as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
        flashElement(dom as HTMLElement);
      }
    }
  });
}

function flashElement(el: HTMLElement): void {
  el.classList.add("mdc-flash");
  setTimeout(() => el.classList.remove("mdc-flash"), 900);
}

function installAddCommentAffordance(): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mdc-add-comment-btn";
  button.textContent = "+ Add comment";
  button.style.display = "none";
  document.body.appendChild(button);

  const updateButton = (): void => {
    if (!editor || !editorContainer) return;
    interface ButtonCoords {
      top: number;
      left: number;
    }
    let coords: ButtonCoords | null = null;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const sel = view.state.selection;
      if (sel.empty) return;
      const text = view.state.doc.textBetween(sel.from, sel.to, "\n").trim();
      if (text.replace(/\s/g, "").length < MIN_ANCHOR_NON_WS_CHARS) return;
      const c = view.coordsAtPos(sel.to);
      coords = { top: c.top, left: c.right };
    });
    const c = coords as ButtonCoords | null;
    if (c) {
      button.style.display = "block";
      button.style.top = `${c.top}px`;
      button.style.left = `${c.left + 6}px`;
    } else {
      button.style.display = "none";
    }
  };

  // Watch selection changes via ProseMirror's view dispatch — but that hook
  // requires plugin wiring. The selectionchange event on the document fires
  // for both editor and DOM selections, so it covers caret moves caused by
  // mouse clicks and keyboard navigation alike.
  document.addEventListener("selectionchange", () => {
    setTimeout(updateButton, 0);
  });

  button.addEventListener("mousedown", (e) => {
    // mousedown on the button would otherwise blur the editor and clear
    // the selection before our click handler runs.
    e.preventDefault();
  });
  button.addEventListener("click", () => {
    button.style.display = "none";
    openComposerForCurrentSelection();
  });
}

function openComposerForCurrentSelection(): void {
  if (!editor || !composerEl) return;
  let anchorText = "";
  let contextBefore = "";
  let contextAfter = "";
  let markdownAtCapture = "";
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const serializer = ctx.get(serializerCtx);
    const sel = view.state.selection;
    if (sel.empty) return;
    anchorText = view.state.doc.textBetween(sel.from, sel.to, "\n").trim();
    markdownAtCapture = serializer(view.state.doc);
    const idx = markdownAtCapture.indexOf(anchorText);
    if (idx < 0) {
      // The selected plain text doesn't appear verbatim in the markdown
      // (e.g. selection straddled markup chars). Fall back to using the
      // selection text alone as the anchor with no context.
      contextBefore = "";
      contextAfter = "";
      return;
    }
    contextBefore = markdownAtCapture.slice(Math.max(0, idx - ANCHOR_CONTEXT_LEN), idx);
    contextAfter = markdownAtCapture.slice(
      idx + anchorText.length,
      idx + anchorText.length + ANCHOR_CONTEXT_LEN,
    );
  });

  if (anchorText.replace(/\s/g, "").length < MIN_ANCHOR_NON_WS_CHARS) {
    showToast("Selection is too short to anchor a comment (need at least 8 non-whitespace characters).");
    return;
  }

  composerEl.innerHTML = `
    <div class="mdc-composer">
      <div class="mdc-composer-anchor"><span class="mdc-composer-label">Commenting on:</span> ${escapeHtml(anchorText.slice(0, 120))}${anchorText.length > 120 ? "…" : ""}</div>
      <textarea class="mdc-composer-input" placeholder="Write a comment…" rows="3"></textarea>
      <div class="mdc-composer-actions">
        <button type="button" class="mdc-composer-cancel">Cancel</button>
        <button type="button" class="mdc-composer-submit">Save</button>
      </div>
    </div>
  `;
  const textarea = composerEl.querySelector<HTMLTextAreaElement>(".mdc-composer-input")!;
  const cancelBtn = composerEl.querySelector<HTMLButtonElement>(".mdc-composer-cancel")!;
  const submitBtn = composerEl.querySelector<HTMLButtonElement>(".mdc-composer-submit")!;
  textarea.focus();
  cancelBtn.addEventListener("click", () => {
    if (composerEl) composerEl.innerHTML = "";
  });
  submitBtn.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (!body) {
      textarea.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    vscode.postMessage({
      type: "add-comment",
      anchor: { text: anchorText, contextBefore, contextAfter },
      body,
    });
  });
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(text: string): void {
  let toast = document.querySelector<HTMLElement>(".mdc-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "mdc-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("mdc-toast--visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.classList.remove("mdc-toast--visible"), 3500);
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
  editor.action((ctx) => {
    ctx.set(defaultValueCtx, text);
  });
  editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx);
    collabService.applyTemplate(text, () => true);
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  } else if (msg.type === "sidecar-changed") {
    sidebarState.comments = msg.comments ?? [];
    renderSidebar();
  } else if (msg.type === "add-comment-result") {
    if (msg.ok) {
      if (composerEl) composerEl.innerHTML = "";
      showToast("Comment added.");
    } else {
      const submitBtn = composerEl?.querySelector<HTMLButtonElement>(".mdc-composer-submit");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save";
      }
      showToast(`Could not save comment: ${msg.error ?? "unknown error"}`);
    }
  }
});

vscode.postMessage({ type: "ready" });
