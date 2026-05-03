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

import { Editor, defaultValueCtx, editorViewCtx, prosePluginsCtx, rootCtx, serializerCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { history } from "@milkdown/plugin-history";
import { nord } from "@milkdown/theme-nord";
import "@milkdown/theme-nord/style.css";
import "./host.css";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
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

interface ReplyCommentResultMessage {
  type: "reply-comment-result";
  ok: boolean;
  commentId: string;
  error?: string;
}

interface ToggleResolveResultMessage {
  type: "toggle-resolve-result";
  ok: boolean;
  commentId: string;
  resolved?: boolean;
  error?: string;
}

interface DeleteCommentResultMessage {
  type: "delete-comment-result";
  ok: boolean;
  commentId: string;
  error?: string;
}

interface OpenLinkResultMessage {
  type: "open-link-result";
  ok: boolean;
  href: string;
  reason?: string;
}

type IncomingMessage =
  | InitMessage
  | ExternalChangeMessage
  | SidecarChangedMessage
  | AddCommentResultMessage
  | ReplyCommentResultMessage
  | ToggleResolveResultMessage
  | DeleteCommentResultMessage
  | OpenLinkResultMessage;

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
    .config((ctx) => {
      ctx.update(prosePluginsCtx, (prev) => prev.concat(makeMermaidPlugin()));
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
  const sendDisabled = unresolved === 0 ? "disabled" : "";

  const header = `
    <div class="mdc-sidebar-header">
      <div class="mdc-sidebar-header-row">
        <div class="mdc-sidebar-titles">
          <div class="mdc-sidebar-title">Comments</div>
          <div class="mdc-sidebar-subtitle">${unresolved} open · ${total} total</div>
        </div>
        <div class="mdc-sidebar-toolbar">
          <button type="button" class="mdc-icon-btn" data-action="copy-prompt" title="Copy 'address unresolved comments' prompt to clipboard" aria-label="Copy Claude prompt">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 1.5h7a1 1 0 0 1 1 1V12h-1V2.5H4v-1zM2 4.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5zm1 0V14h7V4.5H3z"/></svg>
          </button>
          <button type="button" class="mdc-icon-btn mdc-icon-btn--accent" data-action="send-to-claude" title="Send unresolved comments to Claude Code" aria-label="Send to Claude" ${sendDisabled}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M1.7 14.3 14.4 8 1.7 1.7v4.7L10 8l-8.3 1.6v4.7z"/></svg>
            <span class="mdc-icon-btn-label">Send to Claude</span>
          </button>
        </div>
      </div>
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
  attachToolbarHandlers();
  attachCommentHandlers();
}

function renderCommentCard(c: CommentSummary): string {
  const anchorText = escapeHtml(c.anchor.text.length > 80 ? c.anchor.text.slice(0, 77) + "…" : c.anchor.text);
  const bodyHtml = renderBodyWithLinks(c.body);
  const replies = c.replies
    .map(
      (r) =>
        `<div class="mdc-reply"><span class="mdc-reply-author">${escapeHtml(r.author)}</span><span class="mdc-reply-body">${renderBodyWithLinks(r.body)}</span></div>`,
    )
    .join("");
  const resolveTitle = c.resolved ? "Mark as unresolved" : "Mark as resolved";
  const resolveIcon = c.resolved
    ? `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8zm6-5a5 5 0 1 0 0 10A5 5 0 0 0 8 3z"/></svg>`
    : `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13.5 4 6 11.5 2.5 8l1-1L6 9.5 12.5 3z"/></svg>`;
  return `
    <article class="mdc-comment ${c.resolved ? "mdc-comment--resolved" : ""}" data-id="${escapeHtml(c.id)}">
      <header class="mdc-comment-header">
        <div class="mdc-comment-meta-left">
          <span class="mdc-comment-author">${escapeHtml(c.author)}</span>
          <span class="mdc-comment-meta">${c.resolved ? "resolved" : "open"}</span>
        </div>
        <div class="mdc-comment-actions">
          <button type="button" class="mdc-icon-btn mdc-icon-btn--small" data-comment-action="reply" title="Reply" aria-label="Reply">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 2.5 5 5.5l3 3v-2c2 0 3.5 1 4 3 .2-3.4-2-5-4-5v-2z"/></svg>
          </button>
          <button type="button" class="mdc-icon-btn mdc-icon-btn--small" data-comment-action="resolve" title="${resolveTitle}" aria-label="${resolveTitle}">
            ${resolveIcon}
          </button>
          <button type="button" class="mdc-icon-btn mdc-icon-btn--small mdc-icon-btn--danger" data-comment-action="delete" title="Delete this thread" aria-label="Delete">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M5.5 2v1H2v1h1l1 9.5a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9L13 4h1V3h-3.5V2h-5zM6 5h1v7H6V5zm3 0h1v7H9V5z"/></svg>
          </button>
        </div>
      </header>
      <div class="mdc-comment-anchor" title="Click to scroll to the anchor in the editor">${anchorText}</div>
      <div class="mdc-comment-body">${bodyHtml}</div>
      ${replies ? `<div class="mdc-replies">${replies}</div>` : ""}
      <div class="mdc-reply-slot"></div>
    </article>
  `;
}

function renderBodyWithLinks(body: string): string {
  // Linkify bare http(s) URLs and mailto: addresses inside the comment
  // body. We escape first so the text is safe, then post-process the
  // escaped result to wrap matched URLs in anchor tags. Matching against
  // the escaped text is fine because URLs only contain ASCII chars.
  const escaped = escapeHtml(body);
  return escaped.replace(
    /(https?:\/\/[^\s<>"]+)|(mailto:[^\s<>"]+@[^\s<>"]+)/g,
    (match) => `<a href="${match}" data-mdc-link="1">${match}</a>`,
  );
}

function attachToolbarHandlers(): void {
  if (!sidebarEl) return;
  for (const btn of Array.from(sidebarEl.querySelectorAll<HTMLButtonElement>(".mdc-sidebar-toolbar [data-action]"))) {
    const action = btn.dataset.action;
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      if (action === "send-to-claude") {
        vscode.postMessage({ type: "invoke-command", command: "send-to-claude" });
      } else if (action === "copy-prompt") {
        vscode.postMessage({ type: "invoke-command", command: "copy-prompt" });
      }
    });
  }
}

function attachCommentHandlers(): void {
  if (!sidebarEl) return;
  for (const card of Array.from(sidebarEl.querySelectorAll<HTMLElement>(".mdc-comment"))) {
    const id = card.dataset.id;
    if (!id) continue;
    // Click on the card body (not the action buttons) → scroll to anchor.
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".mdc-comment-actions")) return;
      if (target.closest(".mdc-reply-slot")) return;
      if (target.tagName === "A") return;
      const comment = sidebarState.comments.find((c) => c.id === id);
      if (comment) scrollToAnchor(comment.anchor.text);
    });
    for (const btn of Array.from(card.querySelectorAll<HTMLButtonElement>("[data-comment-action]"))) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.commentAction;
        if (action === "reply") openReplyComposer(card, id);
        else if (action === "resolve")
          vscode.postMessage({ type: "toggle-resolve-comment", commentId: id });
        else if (action === "delete") {
          if (confirmDeletion()) {
            vscode.postMessage({ type: "delete-comment", commentId: id });
          }
        }
      });
    }
  }
}

function confirmDeletion(): boolean {
  // window.confirm is available in webviews. We fall back to a single
  // toast acknowledgement if for some reason it returns falsy without
  // user interaction (some embeddings mock confirm() to false).
  // eslint-disable-next-line no-alert
  return window.confirm(
    "Delete this comment thread? Replies are deleted with it. This cannot be undone.",
  );
}

function openReplyComposer(card: HTMLElement, commentId: string): void {
  const slot = card.querySelector<HTMLElement>(".mdc-reply-slot");
  if (!slot) return;
  if (slot.querySelector(".mdc-reply-composer")) {
    // Toggle off — second click closes the composer.
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = `
    <div class="mdc-reply-composer">
      <textarea class="mdc-reply-input" rows="2" placeholder="Reply…"></textarea>
      <div class="mdc-reply-actions">
        <button type="button" class="mdc-reply-cancel">Cancel</button>
        <button type="button" class="mdc-reply-submit">Send reply</button>
      </div>
    </div>
  `;
  const textarea = slot.querySelector<HTMLTextAreaElement>(".mdc-reply-input")!;
  const cancel = slot.querySelector<HTMLButtonElement>(".mdc-reply-cancel")!;
  const submit = slot.querySelector<HTMLButtonElement>(".mdc-reply-submit")!;
  textarea.focus();
  cancel.addEventListener("click", () => {
    slot.innerHTML = "";
  });
  submit.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (!body) {
      textarea.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Sending…";
    vscode.postMessage({ type: "reply-comment", commentId, body });
  });
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

interface MermaidApi {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
}

// Lazy mermaid loader. Mermaid (with d3, dagre, etc.) weighs several MB,
// so we only load it the first time a fenced ```mermaid block actually
// renders — most documents never need it.
let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const candidate = (mod as { default?: unknown }).default ?? mod;
      const api = candidate as MermaidApi;
      try {
        api.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
      } catch {
        /* initialize is idempotent in newer versions; defensive try */
      }
      return api;
    });
  }
  return mermaidPromise;
}

let mermaidIdCounter = 0;

const mermaidPluginKey = new PluginKey("mdc-mermaid");

interface MermaidEntry {
  src: string;
  status: "pending" | "ready" | "error";
  svg?: string;
  error?: string;
}
const mermaidCache = new Map<string, MermaidEntry>();

function makeMermaidPlugin(): Plugin {
  return new Plugin({
    key: mermaidPluginKey,
    state: {
      init: (_cfg, state) => buildMermaidDecorations(state.doc),
      apply: (tr, oldDecos) => {
        if (!tr.docChanged) return oldDecos.map(tr.mapping, tr.doc);
        return buildMermaidDecorations(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return mermaidPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

function buildMermaidDecorations(doc: { descendants: (cb: (node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }, pos: number) => boolean | void) => void }): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    const lang = (node.attrs as { language?: string }).language;
    if (lang !== "mermaid") return true;
    const src = node.textContent;
    decos.push(
      Decoration.widget(pos, () => makeMermaidWidget(src), {
        // Place the SVG widget *before* the code block so the original
        // editable code-block renders untouched below it.
        side: -1,
        ignoreSelection: true,
        key: `mermaid-${pos}-${src.length}`,
      }),
    );
    return true;
  });
  return DecorationSet.create(doc as never, decos);
}

function makeMermaidWidget(src: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mdc-mermaid";
  const target = document.createElement("div");
  target.className = "mdc-mermaid__render";
  wrap.appendChild(target);

  if (!src.trim()) {
    target.innerHTML = "<em>(empty mermaid block)</em>";
    return wrap;
  }

  const cached = mermaidCache.get(src);
  if (cached) {
    if (cached.status === "ready") target.innerHTML = cached.svg ?? "";
    else if (cached.status === "error") {
      target.innerHTML = `<div class="mdc-mermaid__error">${escapeHtml(cached.error ?? "render failed")}</div>`;
    } else {
      target.textContent = "Rendering mermaid…";
    }
  } else {
    mermaidCache.set(src, { src, status: "pending" });
    target.textContent = "Rendering mermaid…";
    void loadMermaid()
      .then(async (mermaid) => {
        const id = `mdc-mermaid-${++mermaidIdCounter}`;
        try {
          const { svg } = await mermaid.render(id, src);
          mermaidCache.set(src, { src, status: "ready", svg });
          target.innerHTML = svg;
        } catch (e) {
          const message = (e as Error).message;
          mermaidCache.set(src, { src, status: "error", error: message });
          target.innerHTML = `<div class="mdc-mermaid__error">Mermaid render failed: ${escapeHtml(message)}</div>`;
        }
      })
      .catch((e) => {
        const message = (e as Error).message;
        mermaidCache.set(src, { src, status: "error", error: message });
        target.innerHTML = `<div class="mdc-mermaid__error">Failed to load mermaid: ${escapeHtml(message)}</div>`;
      });
  }
  return wrap;
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
  } else if (msg.type === "reply-comment-result") {
    if (msg.ok) {
      showToast("Reply sent.");
    } else {
      // Re-enable the submit button if the composer is still open.
      const submit = document.querySelector<HTMLButtonElement>(`.mdc-comment[data-id="${cssEscape(msg.commentId)}"] .mdc-reply-submit`);
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Send reply";
      }
      showToast(`Reply failed: ${msg.error ?? "unknown error"}`);
    }
  } else if (msg.type === "toggle-resolve-result") {
    if (!msg.ok) showToast(`Resolve failed: ${msg.error ?? "unknown error"}`);
    // The sidecar-changed broadcast that follows on success refreshes
    // the card's visual state, so no further UI work needed here.
  } else if (msg.type === "delete-comment-result") {
    if (!msg.ok) showToast(`Delete failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "open-link-result") {
    if (!msg.ok) showToast(`Could not open link: ${msg.reason ?? msg.href}`);
  }
});

// Best-effort CSS.escape polyfill — needed for the comment-id selector
// above. Modern webview Chromiums ship CSS.escape natively, but guard
// for older hosts so we never throw on a synthetic comment id.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^\w-]/g, (c) => `\\${c}`);
}

// Intercept any click on a link inside the editor pane or the sidebar
// and route it through the extension so vscode.env.openExternal handles
// the open with the proper trust prompt + scheme allowlist.
document.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement | null)?.closest("a[href]");
  if (!target) return;
  // Skip links that sit inside the composer's anchor preview etc.
  if (target.closest(".mdc-composer")) return;
  const href = (target as HTMLAnchorElement).getAttribute("href") || "";
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  vscode.postMessage({ type: "open-link", href });
});

vscode.postMessage({ type: "ready" });
