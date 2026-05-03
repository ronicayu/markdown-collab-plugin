// Webview client for the Markdown Collab editor.
//
// Major UX rework (v0.19.0). Architecture:
//   - Milkdown WYSIWYG editor on the left.
//   - Comments sidebar on the right with: connection-status banner,
//     "+ Add comment" as the prominent primary button, an overflow menu
//     for Claude integrations, a clickable filter chip ("3 open · 5 total"
//     toggles "hide resolved"), the comment list, and an inline
//     composer / reply / delete-confirm slot.
//   - Real social presence: avatar stack of named peers in the header,
//     remote cursors with name flags styled to match each peer's color.
//   - Bidirectional comment navigation: every comment's anchor is
//     highlighted in the editor; clicking the highlight scrolls the
//     sidebar to the matching card and flashes it; clicking a card
//     scrolls the editor to its anchor and flashes it.
//   - Responsive: below 720px, the sidebar collapses to a drawer with a
//     toggle in the editor area.
//   - Editor follows the user's VSCode theme (no more forced Nord).

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  prosePluginsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/core";
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
import { stripInlineMarkup } from "../collab/anchorExtractor";
import { renderedRangeToPmRange } from "../collab/pmPositionMapper";
import { formatRelativeTime } from "../collab/relativeTime";

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
let userName: string = "user";

const sidebarState: {
  comments: CommentSummary[];
  hideResolved: boolean;
  collapsed: boolean;
  connection: "connected" | "connecting" | "offline";
  peers: Array<{ name: string; color: string }>;
} = {
  comments: [],
  hideResolved: false,
  collapsed: false,
  connection: "connecting",
  peers: [],
};

let sidebarEl: HTMLElement | null = null;
let composerEl: HTMLElement | null = null;
let editorContainer: HTMLElement | null = null;
let layoutEl: HTMLElement | null = null;
let collapseToggleEl: HTMLButtonElement | null = null;

let cachedMarkdown = "";

// Selection-tracking for the Add-Comment buttons. The composer reads
// from `live → pendingSelection → lastNonEmptySelection` in that order.
//
// Why three layers:
//   - `live`: the editor's current selection at composer-open time. The
//     happy path.
//   - `pendingSelection`: snapshot taken on the button's `mousedown`
//     so `preventDefault` failure (some Milkdown plugin paths) doesn't
//     lose the user's intent.
//   - `lastNonEmptySelection`: continuously kept in sync with the PM
//     state via `updateLastNonEmptySelection` below. Required because
//     the FLOATING button (position: fixed, outside the editor's DOM
//     subtree) can blur the editor *before* its own mousedown fires —
//     so even `pendingSelection` ends up empty. The lastNonEmpty
//     cache holds whatever the user last meaningfully selected and is
//     the final fallback that fixes the "double-click required" bug.
let pendingSelection: { from: number; to: number } | null = null;
let lastNonEmptySelection: { from: number; to: number } | null = null;

function captureCurrentSelection(): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const sel = view.state.selection;
    if (!sel.empty) pendingSelection = { from: sel.from, to: sel.to };
  });
}

function updateLastNonEmptySelection(): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const sel = view.state.selection;
    if (!sel.empty) lastNonEmptySelection = { from: sel.from, to: sel.to };
  });
}

const HIGHLIGHT_PLUGIN_KEY = new PluginKey("mdc-anchor-highlight");

async function init(msg: InitMessage): Promise<void> {
  userName = msg.user.name || "user";
  ydoc = new Y.Doc();
  provider = new WebsocketProvider(msg.serverUrl, msg.room, ydoc, { connect: true });
  provider.awareness.setLocalStateField("user", msg.user);

  buildLayout();
  sidebarState.comments = msg.comments ?? [];
  cachedMarkdown = msg.text;
  renderSidebar();

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorContainer!);
      ctx.set(defaultValueCtx, msg.text);
      ctx.update(prosePluginsCtx, (prev) =>
        prev.concat([makeMermaidPlugin(), makeAnchorHighlightPlugin()]),
      );
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (suppressNextPost) {
          suppressNextPost = false;
          return;
        }
        if (markdown === prevMarkdown) return;
        cachedMarkdown = markdown;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          vscode.postMessage({ type: "edit", text: markdown });
        }, 250);
        // Doc structure changed → recompute anchor highlights so they
        // track the new positions.
        forceHighlightRefresh();
      });
    })
    .config(nord)
    .use(commonmark)
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
    forceHighlightRefresh();
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

  // Connection state — drives the prominent header banner now, not the
  // tiny corner badge.
  const refreshConnection = (): void => {
    const next: typeof sidebarState.connection = provider?.wsconnected
      ? "connected"
      : provider?.wsconnecting
        ? "connecting"
        : "offline";
    if (sidebarState.connection !== next) {
      sidebarState.connection = next;
      renderSidebar();
    }
  };
  refreshConnection();
  provider.on("status", refreshConnection);

  // Peer awareness → social presence in the header.
  const refreshPeers = (): void => {
    const states = provider?.awareness.getStates() ?? new Map();
    const myId = ydoc?.clientID;
    const peers: typeof sidebarState.peers = [];
    states.forEach((state, clientId) => {
      if (clientId === myId) return;
      const u = (state as { user?: { name?: string; color?: string } }).user;
      if (u && u.name) peers.push({ name: u.name, color: u.color ?? "#888" });
    });
    sidebarState.peers = peers;
    renderSidebar();
  };
  refreshPeers();
  provider.awareness.on("change", refreshPeers);

  installAddCommentAffordance();
}

function buildLayout(): void {
  document.body.innerHTML = "";
  layoutEl = document.createElement("div");
  layoutEl.className = "mdc-layout";
  document.body.appendChild(layoutEl);

  editorContainer = document.createElement("div");
  editorContainer.className = "mdc-editor-pane";
  layoutEl.appendChild(editorContainer);

  // Sidebar toggle (visible on narrow widths via CSS).
  collapseToggleEl = document.createElement("button");
  collapseToggleEl.type = "button";
  collapseToggleEl.className = "mdc-sidebar-toggle";
  collapseToggleEl.title = "Toggle comments sidebar";
  collapseToggleEl.setAttribute("aria-label", "Toggle comments sidebar");
  collapseToggleEl.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3 3h10v1H3V3zm0 4h7v1H3V7zm0 4h10v1H3v-1z"/></svg>';
  collapseToggleEl.addEventListener("click", () => {
    sidebarState.collapsed = !sidebarState.collapsed;
    syncCollapsedClass();
  });
  layoutEl.appendChild(collapseToggleEl);

  sidebarEl = document.createElement("aside");
  sidebarEl.className = "mdc-sidebar";
  sidebarEl.setAttribute("aria-label", "Review comments");
  layoutEl.appendChild(sidebarEl);
}

function syncCollapsedClass(): void {
  if (!layoutEl) return;
  layoutEl.classList.toggle("mdc-layout--collapsed", sidebarState.collapsed);
}

function renderSidebar(): void {
  if (!sidebarEl) return;
  syncCollapsedClass();

  const total = sidebarState.comments.length;
  const open = sidebarState.comments.filter((c) => !c.resolved).length;
  const resolvedCount = total - open;
  const visibleComments = sidebarState.comments.filter((c) =>
    sidebarState.hideResolved ? !c.resolved : true,
  );

  // Connection banner — only shown when not connected.
  let banner = "";
  if (sidebarState.connection !== "connected") {
    const label = sidebarState.connection === "connecting" ? "Reconnecting…" : "Offline — your edits aren't syncing";
    const cls = sidebarState.connection === "connecting" ? "mdc-banner--warn" : "mdc-banner--err";
    banner = `<div class="mdc-banner ${cls}" role="status">${escapeHtml(label)}</div>`;
  }

  // Peer presence — colored initials in a stack.
  const peerStack = renderPeerStack(sidebarState.peers);

  const filterClass = sidebarState.hideResolved ? "mdc-filter-chip mdc-filter-chip--active" : "mdc-filter-chip";
  const filterLabel = sidebarState.hideResolved
    ? `Showing open · ${open}`
    : `${open} open · ${total} total`;

  const header = `
    ${banner}
    <div class="mdc-sidebar-header">
      <div class="mdc-sidebar-header-row">
        <div class="mdc-sidebar-titles">
          <div class="mdc-sidebar-title">Comments</div>
          <button type="button" class="${filterClass}" data-action="toggle-filter" title="${
            sidebarState.hideResolved ? "Show all" : "Hide resolved"
          }">
            ${escapeHtml(filterLabel)}
          </button>
        </div>
        ${peerStack}
        <div class="mdc-sidebar-toolbar">
          <button type="button" class="mdc-icon-btn mdc-icon-btn--primary" data-action="add-comment" title="Add a comment on the current selection (Cmd/Ctrl+Shift+M)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5v5h5v1H8v5H7v-5H2v-1h5v-5h1z"/></svg>
            <span>Add comment</span>
          </button>
          <div class="mdc-overflow-menu">
            <button type="button" class="mdc-icon-btn" data-action="overflow" title="More actions" aria-haspopup="true" aria-expanded="false">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>
            </button>
            <div class="mdc-overflow-popup" hidden>
              <button type="button" data-action="copy-prompt">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M4 1.5h7a1 1 0 0 1 1 1V12h-1V2.5H4v-1zM2 4.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5zm1 0V14h7V4.5H3z"/></svg>
                <span>Copy prompt</span>
              </button>
              <button type="button" data-action="send-to-claude" ${open === 0 ? "disabled" : ""} title="${
                open === 0 ? "No unresolved comments to send" : "Send unresolved comments to Claude Code"
              }">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M1.7 14.3 14.4 8 1.7 1.7v4.7L10 8l-8.3 1.6v4.7z"/></svg>
                <span>Send to Claude</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const composerSlot = '<div class="mdc-composer-slot"></div>';

  let body: string;
  if (total === 0) {
    body = `
      <div class="mdc-sidebar-empty">
        <div class="mdc-sidebar-empty-title">No comments yet</div>
        <div class="mdc-sidebar-empty-body">
          Select text in the editor, then:
          <ul>
            <li>Press <span class="mdc-kbd">${isMac() ? "⌘" : "Ctrl"}+Shift+M</span></li>
            <li>Or click <strong>+ Add comment</strong> at the top of this panel</li>
            <li>Or use the floating button that appears next to your selection</li>
          </ul>
          Threads written here also appear in VS Code's gutter UI on the same file.
        </div>
      </div>
    `;
  } else if (visibleComments.length === 0) {
    body = `<div class="mdc-sidebar-empty"><div class="mdc-sidebar-empty-title">All comments resolved</div><div class="mdc-sidebar-empty-body">${resolvedCount} resolved · 0 open. Click "Showing open" above to see resolved threads.</div></div>`;
  } else {
    body = visibleComments
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

function renderPeerStack(peers: Array<{ name: string; color: string }>): string {
  if (peers.length === 0) return "";
  const dots = peers
    .slice(0, 4)
    .map((p) => {
      const initial = (p.name?.[0] ?? "?").toUpperCase();
      const safeName = escapeHtml(p.name);
      return `<span class="mdc-peer-dot" style="background:${escapeAttr(p.color)}" title="${safeName}" aria-label="${safeName}">${escapeHtml(initial)}</span>`;
    })
    .join("");
  const overflow = peers.length > 4 ? `<span class="mdc-peer-dot mdc-peer-dot--more" title="${peers.length - 4} more">+${peers.length - 4}</span>` : "";
  return `<div class="mdc-peer-stack" aria-label="${peers.length} other peer${peers.length === 1 ? "" : "s"} present">${dots}${overflow}</div>`;
}

function renderCommentCard(c: CommentSummary): string {
  const anchorText = escapeHtml(c.anchor.text.length > 80 ? c.anchor.text.slice(0, 77) + "…" : c.anchor.text);
  const bodyHtml = renderBodyWithLinks(c.body);
  const replies = c.replies
    .map(
      (r) =>
        `<div class="mdc-reply"><div class="mdc-reply-meta"><span class="mdc-reply-author">${escapeHtml(r.author)}</span><span class="mdc-reply-time">${escapeHtml(formatRelativeTime(r.createdAt))}</span></div><div class="mdc-reply-body">${renderBodyWithLinks(r.body)}</div></div>`,
    )
    .join("");
  const resolveTitle = c.resolved ? "Mark as unresolved" : "Mark as resolved";
  const resolveIcon = c.resolved
    ? `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8zm6-5a5 5 0 1 0 0 10A5 5 0 0 0 8 3z"/></svg>`
    : `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13.5 4 6 11.5 2.5 8l1-1L6 9.5 12.5 3z"/></svg>`;
  return `
    <article class="mdc-comment ${c.resolved ? "mdc-comment--resolved" : ""}" data-id="${escapeAttr(c.id)}">
      <header class="mdc-comment-header">
        <div class="mdc-comment-meta-left">
          <span class="mdc-comment-author">${escapeHtml(c.author)}</span>
          <span class="mdc-comment-time">${escapeHtml(formatRelativeTime(c.createdAt))}</span>
        </div>
        <div class="mdc-comment-actions">
          <button type="button" class="mdc-icon-btn mdc-icon-btn--small" data-comment-action="reply" title="Reply">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 2.5 5 5.5l3 3v-2c2 0 3.5 1 4 3 .2-3.4-2-5-4-5v-2z"/></svg>
          </button>
          <button type="button" class="mdc-icon-btn mdc-icon-btn--small" data-comment-action="resolve" title="${resolveTitle}">
            ${resolveIcon}
          </button>
          <button type="button" class="mdc-icon-btn mdc-icon-btn--small mdc-icon-btn--danger" data-comment-action="delete" title="Delete this thread">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M5.5 2v1H2v1h1l1 9.5a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9L13 4h1V3h-3.5V2h-5zM6 5h1v7H6V5zm3 0h1v7H9V5z"/></svg>
          </button>
        </div>
      </header>
      <button type="button" class="mdc-comment-anchor" data-comment-action="jump" title="Click to scroll to the highlighted passage">${anchorText}</button>
      <div class="mdc-comment-body">${bodyHtml}</div>
      ${replies ? `<div class="mdc-replies">${replies}</div>` : ""}
      <div class="mdc-reply-slot"></div>
    </article>
  `;
}

function renderBodyWithLinks(body: string): string {
  const escaped = escapeHtml(body);
  return escaped.replace(
    /(https?:\/\/[^\s<>"]+)|(mailto:[^\s<>"]+@[^\s<>"]+)/g,
    (match) => `<a href="${match}" data-mdc-link="1">${match}</a>`,
  );
}

function attachToolbarHandlers(): void {
  if (!sidebarEl) return;
  // Filter chip
  const filterChip = sidebarEl.querySelector<HTMLButtonElement>("[data-action='toggle-filter']");
  filterChip?.addEventListener("click", () => {
    sidebarState.hideResolved = !sidebarState.hideResolved;
    renderSidebar();
  });
  // Toolbar buttons
  for (const btn of Array.from(sidebarEl.querySelectorAll<HTMLButtonElement>(".mdc-sidebar-toolbar [data-action]"))) {
    const action = btn.dataset.action;
    btn.addEventListener("mousedown", (e) => {
      // preventDefault on mousedown stops the click from blurring the
      // editor (which would clear the PM selection before our click
      // handler runs). We ALSO snapshot the selection here as a
      // belt-and-suspenders measure — some Milkdown plugin paths slip
      // past the preventDefault and cause the SECOND click symptom
      // (first click sees an empty selection and toasts; user clicks
      // again with the still-collapsed selection and… still nothing).
      e.preventDefault();
      if (action === "add-comment") captureCurrentSelection();
    });
    btn.addEventListener("click", (e) => {
      if (btn.disabled) return;
      if (action === "send-to-claude") {
        vscode.postMessage({ type: "invoke-command", command: "send-to-claude" });
        closeOverflow();
      } else if (action === "copy-prompt") {
        vscode.postMessage({ type: "invoke-command", command: "copy-prompt" });
        closeOverflow();
      } else if (action === "add-comment") {
        openComposerForCurrentSelection();
      } else if (action === "overflow") {
        e.stopPropagation();
        toggleOverflow(btn);
      }
    });
  }
}

function toggleOverflow(trigger: HTMLButtonElement): void {
  const popup = trigger.parentElement?.querySelector<HTMLElement>(".mdc-overflow-popup");
  if (!popup) return;
  const open = popup.hasAttribute("hidden");
  if (open) {
    popup.removeAttribute("hidden");
    trigger.setAttribute("aria-expanded", "true");
  } else {
    popup.setAttribute("hidden", "");
    trigger.setAttribute("aria-expanded", "false");
  }
}

function closeOverflow(): void {
  if (!sidebarEl) return;
  const popup = sidebarEl.querySelector<HTMLElement>(".mdc-overflow-popup");
  popup?.setAttribute("hidden", "");
  const trigger = sidebarEl.querySelector<HTMLElement>("[data-action='overflow']");
  trigger?.setAttribute("aria-expanded", "false");
}

function attachCommentHandlers(): void {
  if (!sidebarEl) return;
  for (const card of Array.from(sidebarEl.querySelectorAll<HTMLElement>(".mdc-comment"))) {
    const id = card.dataset.id;
    if (!id) continue;
    for (const btn of Array.from(card.querySelectorAll<HTMLButtonElement>("[data-comment-action]"))) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.commentAction;
        if (action === "reply") openReplyComposer(card, id);
        else if (action === "resolve")
          vscode.postMessage({ type: "toggle-resolve-comment", commentId: id });
        else if (action === "delete") openDeleteConfirm(card, id);
        else if (action === "jump") {
          const comment = sidebarState.comments.find((c) => c.id === id);
          if (comment) jumpToAnchor(comment);
        }
      });
    }
  }
}

function openDeleteConfirm(card: HTMLElement, commentId: string): void {
  const slot = card.querySelector<HTMLElement>(".mdc-reply-slot");
  if (!slot) return;
  if (slot.querySelector(".mdc-delete-confirm")) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = `
    <div class="mdc-delete-confirm" role="alertdialog" aria-label="Confirm delete">
      <div class="mdc-delete-confirm-text">Delete this thread? Replies are deleted with it.</div>
      <div class="mdc-delete-confirm-actions">
        <button type="button" class="mdc-delete-confirm-cancel">Cancel</button>
        <button type="button" class="mdc-delete-confirm-confirm">Delete</button>
      </div>
    </div>
  `;
  const cancel = slot.querySelector<HTMLButtonElement>(".mdc-delete-confirm-cancel")!;
  const confirm = slot.querySelector<HTMLButtonElement>(".mdc-delete-confirm-confirm")!;
  cancel.addEventListener("click", () => (slot.innerHTML = ""));
  confirm.addEventListener("click", () => {
    confirm.disabled = true;
    confirm.textContent = "Deleting…";
    vscode.postMessage({ type: "delete-comment", commentId });
  });
}

function openReplyComposer(card: HTMLElement, commentId: string): void {
  const slot = card.querySelector<HTMLElement>(".mdc-reply-slot");
  if (!slot) return;
  if (slot.querySelector(".mdc-reply-composer")) {
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
  cancel.addEventListener("click", () => (slot.innerHTML = ""));
  submit.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (!body) {
      textarea.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Sending…";
    vscode.postMessage({ type: "reply-comment", commentId, body, author: userName });
  });
}

// ---------------------------------------------------------------------------
// Bidirectional navigation: anchor highlights in editor + jump from sidebar
// ---------------------------------------------------------------------------

function makeAnchorHighlightPlugin(): Plugin {
  return new Plugin({
    key: HIGHLIGHT_PLUGIN_KEY,
    state: {
      init: (_cfg, state) => buildAnchorDecorations(state.doc, sidebarState.comments, cachedMarkdown),
      apply: (tr, oldDecos) => {
        const meta = tr.getMeta(HIGHLIGHT_PLUGIN_KEY);
        if (meta?.refresh) {
          return buildAnchorDecorations(tr.doc, sidebarState.comments, cachedMarkdown);
        }
        if (!tr.docChanged) return oldDecos.map(tr.mapping, tr.doc);
        return buildAnchorDecorations(tr.doc, sidebarState.comments, cachedMarkdown);
      },
    },
    props: {
      decorations(state) {
        return HIGHLIGHT_PLUGIN_KEY.getState(state) as DecorationSet | undefined;
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
          ".mdc-anchor-highlight",
        );
        if (!target) return false;
        const commentId = target.getAttribute("data-comment-id");
        if (!commentId) return false;
        revealCommentInSidebar(commentId);
        // Also flash the highlight to confirm the click landed.
        target.classList.remove("mdc-anchor-highlight--pulse");
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        void target.offsetWidth; // restart CSS animation
        target.classList.add("mdc-anchor-highlight--pulse");
        return true;
      },
    },
  });
}

interface DocLike {
  textContent: string;
  descendants: (
    cb: (node: { isText: boolean; nodeSize: number; type: { name: string } }, pos: number) => boolean | void,
  ) => void;
}

function buildAnchorDecorations(
  doc: DocLike,
  comments: CommentSummary[],
  _markdownSource: string,
): DecorationSet {
  if (comments.length === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  // Resolve every anchor against the LIVE PM doc's textContent (the
  // text the user actually sees). No more mapping through a
  // hand-rolled markdown stripper — that whole layer is the source of
  // the persistent alignment-bug class. anchor.text may contain
  // markup chars (it was authored against the markdown source); we
  // strip those off the small anchor strings, not off the full
  // document, before searching.
  const haystack = doc.textContent;
  for (const c of comments) {
    if (c.resolved) continue; // Don't highlight resolved threads — too noisy.
    const rendered = locateAnchorInLiveText(haystack, c.anchor);
    if (!rendered) continue;
    const pmRange = renderedRangeToPmRange(doc, rendered.start, rendered.end);
    if (!pmRange) continue;
    decos.push(
      Decoration.inline(
        pmRange.from,
        pmRange.to,
        {
          class: "mdc-anchor-highlight",
          "data-comment-id": c.id,
          title: `Comment by ${c.author}: ${truncate(c.body, 100)}`,
        },
      ),
    );
  }
  return DecorationSet.create(doc as never, decos);
}

interface LiveAnchor {
  text: string;
  contextBefore: string;
  contextAfter: string;
}

// Locate an anchor in the live rendered text. The anchor's text /
// contextBefore / contextAfter were stored relative to the markdown
// source, so they may contain inline-markup chars (e.g. `here](url)`)
// that the live textContent does not have. We strip just those small
// strings (not the full doc) and search.
//
// Disambiguation strategy (in order):
//   1. Strip the anchor strings, look for unique exact match.
//   2. If multiple matches, pick the one whose stripped contexts agree.
//   3. If none match exact, fall back to whitespace-normalised search.
//   4. Give up (return null — the comment doesn't get highlighted).
function locateAnchorInLiveText(
  haystack: string,
  anchor: LiveAnchor,
): { start: number; end: number } | null {
  const needle = stripInlineMarkup(anchor.text).stripped.trim();
  if (needle.length === 0) return null;
  const before = stripInlineMarkup(anchor.contextBefore).stripped;
  const after = stripInlineMarkup(anchor.contextAfter).stripped;

  const hits: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    hits.push(idx);
    from = idx + 1;
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    return { start: hits[0]!, end: hits[0]! + needle.length };
  }
  // Multiple hits — disambiguate by context.
  for (const h of hits) {
    const haystackBefore = haystack.slice(Math.max(0, h - before.length - 4), h);
    const haystackAfter = haystack.slice(h + needle.length, h + needle.length + after.length + 4);
    const beforeOk = before.length === 0 || haystackBefore.endsWith(before);
    const afterOk = after.length === 0 || haystackAfter.startsWith(after);
    if (beforeOk && afterOk) return { start: h, end: h + needle.length };
  }
  // Loosen: any hit where at least one side matches.
  for (const h of hits) {
    const haystackBefore = haystack.slice(Math.max(0, h - before.length - 4), h);
    const haystackAfter = haystack.slice(h + needle.length, h + needle.length + after.length + 4);
    const beforeOk = before.length > 0 && haystackBefore.endsWith(before);
    const afterOk = after.length > 0 && haystackAfter.startsWith(after);
    if (beforeOk || afterOk) return { start: h, end: h + needle.length };
  }
  // No context disambiguation possible — pick the first hit.
  return { start: hits[0]!, end: hits[0]! + needle.length };
}

function forceHighlightRefresh(): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(HIGHLIGHT_PLUGIN_KEY, { refresh: true }));
  });
}

function revealCommentInSidebar(commentId: string): void {
  if (!sidebarEl) return;
  if (sidebarState.collapsed) {
    sidebarState.collapsed = false;
    syncCollapsedClass();
  }
  // If filtered out (e.g. resolved + hideResolved), temporarily show all.
  const target = sidebarState.comments.find((c) => c.id === commentId);
  if (target?.resolved && sidebarState.hideResolved) {
    sidebarState.hideResolved = false;
    renderSidebar();
  }
  const card = sidebarEl.querySelector<HTMLElement>(`.mdc-comment[data-id="${cssEscape(commentId)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("mdc-comment--flash");
  void card.offsetWidth;
  card.classList.add("mdc-comment--flash");
}

// Compute the rendered-text offset (offset into doc.textContent) that
// corresponds to a ProseMirror position. Used to display the
// "Commenting on:" preview in the composer. Returns -1 if the position
// can't be located (e.g. it falls inside a non-text node).
function renderedOffsetForPm(doc: { descendants: (cb: (n: { isText: boolean; nodeSize: number }, p: number) => boolean | void) => void }, pmPos: number): number {
  let textCounted = 0;
  let result = -1;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.isText) {
      const nodeStart = pos;
      const nodeEnd = pos + node.nodeSize;
      if (pmPos >= nodeStart && pmPos <= nodeEnd) {
        result = textCounted + (pmPos - nodeStart);
        return false;
      }
      textCounted += node.nodeSize;
    }
    return true;
  });
  return result;
}

function jumpToAnchor(comment: CommentSummary): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const rendered = locateAnchorInLiveText(view.state.doc.textContent, comment.anchor);
    if (!rendered) {
      showToast("Couldn't locate this comment's anchor in the document. The text may have changed.");
      return;
    }
    const pmRange = renderedRangeToPmRange(
      view.state.doc as unknown as Parameters<typeof renderedRangeToPmRange>[0],
      rendered.start,
      rendered.end,
    );
    if (!pmRange) return;
    try {
      const dom = view.domAtPos(pmRange.from).node as Element | null;
      if (dom && (dom as HTMLElement).scrollIntoView) {
        (dom as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch {
      /* ignore */
    }
    // Briefly flash the highlight at this comment.
    setTimeout(() => {
      const highlight = document.querySelector<HTMLElement>(
        `.mdc-anchor-highlight[data-comment-id="${cssEscape(comment.id)}"]`,
      );
      if (highlight) {
        highlight.classList.remove("mdc-anchor-highlight--pulse");
        void highlight.offsetWidth;
        highlight.classList.add("mdc-anchor-highlight--pulse");
      }
    }, 150);
  });
}

// ---------------------------------------------------------------------------
// Mermaid (unchanged from prior version, slightly tightened)
// ---------------------------------------------------------------------------

interface MermaidApi {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const candidate = (mod as { default?: unknown }).default ?? mod;
      const api = candidate as MermaidApi;
      try {
        api.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      } catch {
        /* idempotent */
      }
      return api;
    });
  }
  return mermaidPromise;
}

let mermaidIdCounter = 0;
const mermaidPluginKey = new PluginKey("mdc-mermaid");
interface MermaidEntry { src: string; status: "pending" | "ready" | "error"; svg?: string; error?: string }
const mermaidCache = new Map<string, MermaidEntry>();

function makeMermaidPlugin(): Plugin {
  return new Plugin({
    key: mermaidPluginKey,
    state: {
      init: (_cfg, state) => buildMermaidDecorations(state.doc),
      apply: (tr, oldDecos) => (tr.docChanged ? buildMermaidDecorations(tr.doc) : oldDecos.map(tr.mapping, tr.doc)),
    },
    props: {
      decorations(state) {
        return mermaidPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

function buildMermaidDecorations(doc: DocLike): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if ((node.type as { name?: string }).name !== "code_block") return true;
    const lang = ((node as unknown as { attrs?: { language?: string } }).attrs ?? {}).language;
    if (lang !== "mermaid") return true;
    const src = (node as unknown as { textContent: string }).textContent;
    decos.push(
      Decoration.widget(pos, () => makeMermaidWidget(src), {
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
    else if (cached.status === "error") target.innerHTML = `<div class="mdc-mermaid__error">${escapeHtml(cached.error ?? "render failed")}</div>`;
    else target.textContent = "Rendering mermaid…";
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

// ---------------------------------------------------------------------------
// Composer + selection-driven add comment
// ---------------------------------------------------------------------------

function installAddCommentAffordance(): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mdc-add-comment-btn";
  button.textContent = "+ Add comment";
  button.style.display = "none";
  document.body.appendChild(button);

  const updateButton = (): void => {
    if (!editor || !editorContainer) return;
    interface ButtonCoords { top: number; left: number }
    let coords: ButtonCoords | null = null;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const sel = view.state.selection;
      if (sel.empty) return;
      try {
        const c = view.coordsAtPos(sel.to);
        coords = { top: c.top, left: c.right };
      } catch {
        /* ignore */
      }
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

  // Refresh the floating button's position AND keep
  // lastNonEmptySelection in lock-step with PM's state. Both run on
  // every selection-affecting event so the composer can always reach
  // for "the last non-empty selection the user made", regardless of
  // any focus/blur weirdness between PM and the floating button.
  const refresh = (): void => {
    updateLastNonEmptySelection();
    updateButton();
  };
  document.addEventListener("selectionchange", () => setTimeout(refresh, 0));
  document.addEventListener("mouseup", () => setTimeout(refresh, 0));
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      setTimeout(refresh, 0);
    }
  });

  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    captureCurrentSelection();
  });
  button.addEventListener("click", () => {
    button.style.display = "none";
    openComposerForCurrentSelection();
  });
}

function openComposerForCurrentSelection(): void {
  if (!editor || !composerEl) return;
  let anchor: import("../types").Anchor | null = null;
  let displayText = "";
  let failureReason = "";
  // Three-layer selection lookup — see the comment block on
  // pendingSelection / lastNonEmptySelection for why. Order:
  //   1. live (PM's current selection at composer-open time)
  //   2. pendingSelection (mousedown snapshot — close to live)
  //   3. lastNonEmptySelection (the most recent non-empty user
  //      selection, kept in sync via updateLastNonEmptySelection)
  // The third layer is what fixes the "had to double-click the
  // floating button" bug.
  const captured = pendingSelection;
  pendingSelection = null;
  const recent = lastNonEmptySelection;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const serializer = ctx.get(serializerCtx);
    const live = view.state.selection;
    let selFrom: number;
    let selTo: number;
    if (!live.empty) {
      selFrom = live.from;
      selTo = live.to;
    } else if (captured) {
      selFrom = captured.from;
      selTo = captured.to;
    } else if (recent) {
      selFrom = recent.from;
      selTo = recent.to;
    } else {
      failureReason = "No text is selected. Highlight some text in the editor first.";
      return;
    }
    if (selFrom === selTo) {
      failureReason = "No text is selected. Highlight some text in the editor first.";
      return;
    }
    // Phase-3 write side: use Milkdown's own serializer to compute
    // the markdown for the user's selection, instead of mapping
    // through a hand-rolled stripper. `doc.cut(from, to)` slices the
    // PM tree; serializing the slice gives us markdown identical to
    // what Milkdown would write for that span on save.
    const fullMd = serializer(view.state.doc);
    cachedMarkdown = fullMd;
    let sliceMd = "";
    try {
      const sliced = view.state.doc.cut(selFrom, selTo);
      sliceMd = serializer(sliced).trim();
    } catch (e) {
      failureReason = `Couldn't extract the selection's markdown: ${(e as Error).message}`;
      return;
    }
    const renderedText = view.state.doc.textContent;
    const renderedSelStart = renderedOffsetForPm(view.state.doc, selFrom);
    const renderedSelEnd = renderedOffsetForPm(view.state.doc, selTo);
    if (renderedSelStart >= 0 && renderedSelEnd >= 0) {
      displayText = renderedText.slice(renderedSelStart, renderedSelEnd).trim();
    } else {
      displayText = sliceMd;
    }

    // Anchor.text = the precise markdown slice. anchor.contextBefore/
    // After = the surrounding markdown chars from the full doc — find
    // the slice's position via Nth-occurrence (count occurrences of
    // sliceMd in fullMd before the user's selection point).
    if (sliceMd.length === 0) {
      failureReason = "Selection produced no text.";
      return;
    }
    const nonWs = sliceMd.replace(/\s/g, "").length;
    if (nonWs < 8) {
      failureReason = "Selection is too short. Pick at least 8 characters of contiguous text.";
      return;
    }
    // Choose the occurrence whose position best matches where in
    // fullMd we'd expect — for write side, prefer the FIRST occurrence
    // unless we have prior info. Better: count occurrences of sliceMd
    // in fullMd up to (but not past) the selection's "begin position
    // when serialized standalone" — too complex, just use first hit
    // disambiguated by surrounding text.
    const occurrences: number[] = [];
    let from = 0;
    while (true) {
      const idx = fullMd.indexOf(sliceMd, from);
      if (idx < 0) break;
      occurrences.push(idx);
      from = idx + 1;
    }
    if (occurrences.length === 0) {
      // Slice doesn't appear in fullMd verbatim — slice serialization
      // produced something the full serialization doesn't have (rare
      // edge: marked-up node boundaries). Fall back to the slice
      // text alone with empty context; the tolerant resolver will
      // try its best.
      anchor = { text: sliceMd, contextBefore: "", contextAfter: "" };
      return;
    }
    // Pick the occurrence whose surrounding chars appear "around" the
    // user's selection point. We approximate the selection's md
    // position via len(serialize(doc.cut(0, selFrom))).
    let approxMdStart = -1;
    try {
      const beforeDoc = view.state.doc.cut(0, selFrom);
      approxMdStart = serializer(beforeDoc).length;
    } catch {
      approxMdStart = -1;
    }
    let chosen = occurrences[0]!;
    if (approxMdStart >= 0 && occurrences.length > 1) {
      let bestDiff = Infinity;
      for (const o of occurrences) {
        const diff = Math.abs(o - approxMdStart);
        if (diff < bestDiff) {
          bestDiff = diff;
          chosen = o;
        }
      }
    }
    const mdStart = chosen;
    const mdEnd = mdStart + sliceMd.length;
    anchor = {
      text: sliceMd,
      contextBefore: fullMd.slice(Math.max(0, mdStart - 24), mdStart),
      contextAfter: fullMd.slice(mdEnd, mdEnd + 24),
    };
  });

  if (!anchor) {
    showToast(failureReason || "Couldn't anchor this selection.");
    return;
  }
  const finalAnchor: import("../types").Anchor = anchor;

  composerEl.innerHTML = `
    <div class="mdc-composer">
      <div class="mdc-composer-anchor"><span class="mdc-composer-label">Commenting on:</span> ${escapeHtml(displayText.slice(0, 120))}${displayText.length > 120 ? "…" : ""}</div>
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
      anchor: finalAnchor,
      body,
      author: userName,
    });
  });
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(text: string, durationMs = 4500): void {
  let toast = document.querySelector<HTMLElement>(".mdc-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "mdc-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("mdc-toast--visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.classList.remove("mdc-toast--visible"), durationMs);
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
  cachedMarkdown = text;
  editor.action((ctx) => ctx.set(defaultValueCtx, text));
  editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx);
    collabService.applyTemplate(text, () => true);
  });
  forceHighlightRefresh();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^\w-]/g, (c) => `\\${c}`);
}

function postError(stage: string, err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  vscode.postMessage({ type: "webview-error", stage, message });
}

window.addEventListener("error", (e) => postError("uncaught", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => postError("unhandled-rejection", e.reason));

// Cmd/Ctrl+Shift+M = open the composer for the current selection.
document.addEventListener("keydown", (e) => {
  const isCmdOrCtrl = e.metaKey || e.ctrlKey;
  if (isCmdOrCtrl && e.shiftKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault();
    e.stopPropagation();
    openComposerForCurrentSelection();
  }
});

// Click outside overflow menu closes it.
document.addEventListener("click", (e) => {
  if (!sidebarEl) return;
  const target = e.target as HTMLElement | null;
  if (!target?.closest(".mdc-overflow-menu")) closeOverflow();
});

// Link click interceptor — route to extension's openExternal/vscode.open.
document.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement | null)?.closest("a[href]");
  if (!target) return;
  if (target.closest(".mdc-composer")) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return;
  const href = (target as HTMLAnchorElement).getAttribute("href") || "";
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  vscode.postMessage({ type: "open-link", href });
});

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
    forceHighlightRefresh();
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
      const submit = document.querySelector<HTMLButtonElement>(
        `.mdc-comment[data-id="${cssEscape(msg.commentId)}"] .mdc-reply-submit`,
      );
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Send reply";
      }
      showToast(`Reply failed: ${msg.error ?? "unknown error"}`);
    }
  } else if (msg.type === "toggle-resolve-result") {
    if (!msg.ok) showToast(`Resolve failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "delete-comment-result") {
    if (!msg.ok) showToast(`Delete failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "open-link-result") {
    if (!msg.ok) showToast(`Could not open link: ${msg.reason ?? msg.href}`);
  }
});

vscode.postMessage({ type: "ready" });
