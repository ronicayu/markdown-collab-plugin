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
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { CellSelection } from "@milkdown/prose/tables";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { locateAnchorInLiveText } from "../collab/liveAnchorLocator";
import { renderedRangeToPmRange } from "../collab/pmPositionMapper";
import { formatRelativeTime } from "../collab/relativeTime";
import { slugifyHeading } from "../inlineComments/linkParse";

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
};

interface CommentSummary {
  id: string;
  rootCommentId: string;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  anchor: { text: string; contextBefore: string; contextAfter: string };
  replies: Array<{ id: string; author: string; body: string; createdAt: string }>;
}

interface InitMessage {
  type: "init";
  text: string;
  room: string;
  serverUrl: string;
  user: { name: string; color: string };
  comments: CommentSummary[];
  frontmatter?: string;
}

interface ExternalChangeMessage {
  type: "externalChange";
  text: string;
}

interface FrontmatterMessage {
  type: "frontmatter";
  frontmatter: string;
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

interface DrawioReadResultMessage {
  type: "drawio-read-result";
  requestId: string;
  href: string;
  ok: boolean;
  content?: string;
  error?: string;
}

type IncomingMessage =
  | InitMessage
  | ExternalChangeMessage
  | FrontmatterMessage
  | SidecarChangedMessage
  | AddCommentResultMessage
  | ReplyCommentResultMessage
  | ToggleResolveResultMessage
  | DeleteCommentResultMessage
  | OpenLinkResultMessage
  | DrawioReadResultMessage;

const vscode = acquireVsCodeApi();

let editor: Editor | null = null;
let ydoc: Y.Doc | null = null;
let awareness: Awareness | null = null;
let suppressNextPost = false;
let userName: string = "user";
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
// Debounces the human's edits before posting them to the host. Module-scoped so
// an incoming external (Claude) change can cancel a still-pending stale post —
// otherwise that post would fire after the external change and overwrite it.
let editDebounce: ReturnType<typeof setTimeout> | null = null;
// In-progress reply text per thread, so an always-on reply box keeps what the
// user typed across sidebar re-renders.
const pendingReplies = new Map<string, string>();

const sidebarState: {
  comments: CommentSummary[];
  hideResolved: boolean;
  collapsed: boolean;
  // Transient one-line status (e.g. "Updated from disk" when Claude edits the
  // file). null when nothing to show.
  notice: string | null;
} = {
  comments: [],
  hideResolved: false,
  collapsed: false,
  notice: null,
};

let sidebarEl: HTMLElement | null = null;
let composerEl: HTMLElement | null = null;
let editorContainer: HTMLElement | null = null;
let frontmatterEl: HTMLElement | null = null;
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
  // Local-only awareness: there is no network relay and no second human. The
  // collab plugin still wants an Awareness, so we give it a doc-local one that
  // never syncs to anyone. Claude collaborates via the file, not via Yjs.
  awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", msg.user);

  buildLayout();
  sidebarState.comments = msg.comments ?? [];
  cachedMarkdown = msg.text;
  renderFrontmatter(msg.frontmatter ?? "");
  renderSidebar();

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorContainer!);
      ctx.set(defaultValueCtx, msg.text);
      ctx.update(prosePluginsCtx, (prev) =>
        prev.concat([
          makeFlattenCellSelectionPlugin(),
          makeMermaidPlugin(),
          makeDrawioPlugin(),
          makeAnchorHighlightPlugin(),
        ]),
      );
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (suppressNextPost) {
          suppressNextPost = false;
          return;
        }
        if (markdown === prevMarkdown) return;
        cachedMarkdown = markdown;
        if (editDebounce) clearTimeout(editDebounce);
        editDebounce = setTimeout(() => {
          editDebounce = null;
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

  const startCollab = (): void => {
    if (!editor) return;
    editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx);
      collabService
        .bindDoc(ydoc!)
        .setAwareness(awareness!)
        .applyTemplate(msg.text)
        .connect();
    });
    forceHighlightRefresh();
    reportReady(true);
  };

  // No relay to wait on — start the editor immediately as a solo editor.
  startCollab();

  installAddCommentAffordance();
}

function buildLayout(): void {
  document.body.innerHTML = "";
  layoutEl = document.createElement("div");
  layoutEl.className = "mdc-layout";
  document.body.appendChild(layoutEl);

  const editorPane = document.createElement("div");
  editorPane.className = "mdc-editor-pane";
  layoutEl.appendChild(editorPane);

  // Frontmatter panel sits above the Milkdown body. The body editor mounts
  // into its own element so ProseMirror never touches the frontmatter DOM.
  frontmatterEl = document.createElement("div");
  frontmatterEl.className = "mdc-frontmatter";
  frontmatterEl.hidden = true;
  editorPane.appendChild(frontmatterEl);

  editorContainer = document.createElement("div");
  editorContainer.className = "mdc-editor-root";
  editorPane.appendChild(editorContainer);

  collapseToggleEl = document.createElement("button");
  collapseToggleEl.type = "button";
  collapseToggleEl.className = "mdc-sidebar-toggle";
  collapseToggleEl.addEventListener("click", () => {
    sidebarState.collapsed = !sidebarState.collapsed;
    syncCollapsedClass();
  });
  layoutEl.appendChild(collapseToggleEl);

  sidebarEl = document.createElement("aside");
  sidebarEl.className = "mdc-sidebar";
  sidebarEl.setAttribute("aria-label", "Review comments");
  layoutEl.appendChild(sidebarEl);

  syncCollapsedClass();
}

function syncCollapsedClass(): void {
  if (!layoutEl) return;
  layoutEl.classList.toggle("mdc-layout--collapsed", sidebarState.collapsed);
  if (collapseToggleEl) {
    const collapsed = sidebarState.collapsed;
    const label = collapsed ? "Show comments" : "Hide comments";
    collapseToggleEl.title = label;
    collapseToggleEl.setAttribute("aria-label", label);
    collapseToggleEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const arrow = collapsed
      ? '<path d="M10.5 3L5 8l5.5 5 .9-.95L6.85 8l4.55-4.05z"/>'
      : '<path d="M5.5 3L11 8l-5.5 5-.9-.95L9.15 8 4.6 3.95z"/>';
    collapseToggleEl.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">${arrow}</svg>`;
  }
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

  // Transient notice — e.g. "Updated from disk" when Claude (or another tool)
  // edits the .md while the editor is open and the change lands here.
  const banner = sidebarState.notice
    ? `<div class="mdc-banner mdc-banner--info" role="status">${escapeHtml(sidebarState.notice)}</div>`
    : "";

  const filterClass = sidebarState.hideResolved ? "mdc-filter-chip mdc-filter-chip--active" : "mdc-filter-chip";
  const filterLabel = sidebarState.hideResolved
    ? `Showing open · ${open}`
    : `${open} open · ${total} total`;

  const header = `
    <div class="mdc-banner-slot">${banner}</div>
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
        <div class="mdc-sidebar-toolbar">
          <button type="button" class="mdc-icon-btn mdc-icon-btn--primary" data-action="add-comment" title="Add a comment on the current selection (Cmd/Ctrl+Shift+M)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5v5h5v1H8v5H7v-5H2v-1h5v-5h1z"/></svg>
            <span>Add comment</span>
          </button>
        </div>
      </div>
      <div class="mdc-sidebar-actions">
        <button type="button" class="mdc-icon-btn mdc-sidebar-action mdc-sidebar-action--primary" data-action="send-to-claude" ${open === 0 ? "disabled" : ""} title="${
          open === 0 ? "No unresolved comments to send" : "Send unresolved comments to Claude Code"
        }">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M1.7 14.3 14.4 8 1.7 1.7v4.7L10 8l-8.3 1.6v4.7z"/></svg>
          <span>Send to Claude</span>
        </button>
        <button type="button" class="mdc-icon-btn mdc-sidebar-action" data-action="copy-prompt" title="Copy the prompt to your clipboard.">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M4 1.5h7a1 1 0 0 1 1 1V12h-1V2.5H4v-1zM2 4.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5zm1 0V14h7V4.5H3z"/></svg>
          <span>Copy</span>
        </button>
      </div>
    </div>
  `;

  const composerSlot = '<div class="mdc-composer-slot"></div>';

  let body: string;
  if (total === 0) {
    body = emptyNoCommentsHtml();
  } else if (visibleComments.length === 0) {
    body = emptyAllResolvedHtml(resolvedCount);
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

function emptyNoCommentsHtml(): string {
  return `
    <div class="mdc-sidebar-empty">
      <div class="mdc-sidebar-empty-title">No comments yet</div>
      <div class="mdc-sidebar-empty-body">
        Select text in the editor, then:
        <ul>
          <li>Press <span class="mdc-kbd">${isMac() ? "⌘" : "Ctrl"}+Shift+M</span></li>
          <li>Or click <strong>+ Add comment</strong> at the top of this panel</li>
          <li>Or use the floating button that appears next to your selection</li>
        </ul>
        Comments are saved inside the Markdown file itself, so they travel with it and show up in the Inline Comments view.
      </div>
    </div>
  `;
}

function emptyAllResolvedHtml(resolvedCount: number): string {
  return `<div class="mdc-sidebar-empty"><div class="mdc-sidebar-empty-title">All comments resolved</div><div class="mdc-sidebar-empty-body">${resolvedCount} resolved · 0 open. Click "Showing open" above to see resolved threads.</div></div>`;
}

// Update only the transient notice banner — used by showNotice so a "Updated
// from disk" flash doesn't rebuild the whole comment list (which would drop
// focus from an in-progress reply).
function renderNotice(): void {
  if (!sidebarEl) return;
  const slot = sidebarEl.querySelector<HTMLElement>(".mdc-banner-slot");
  if (!slot) {
    renderSidebar();
    return;
  }
  slot.innerHTML = sidebarState.notice
    ? `<div class="mdc-banner mdc-banner--info" role="status">${escapeHtml(sidebarState.notice)}</div>`
    : "";
}

// Refresh the header's count + Send-to-Claude enabled state in place.
function updateSidebarCounts(): void {
  if (!sidebarEl) return;
  const total = sidebarState.comments.length;
  const open = sidebarState.comments.filter((c) => !c.resolved).length;
  const filterBtn = sidebarEl.querySelector<HTMLButtonElement>("[data-action='toggle-filter']");
  if (filterBtn) {
    filterBtn.textContent = sidebarState.hideResolved
      ? `Showing open · ${open}`
      : `${open} open · ${total} total`;
  }
  const sendBtn = sidebarEl.querySelector<HTMLButtonElement>("[data-action='send-to-claude']");
  if (sendBtn) sendBtn.disabled = open === 0;
}

// A stable identity for a thread's rendered content. Two renders with the same
// signature are byte-identical, so reconciliation can leave that card's DOM
// untouched — preserving its always-on reply box's focus and caret.
function threadSignature(c: CommentSummary): string {
  return JSON.stringify({
    a: c.author,
    t: c.createdAt,
    b: c.body,
    r: c.resolved,
    an: c.anchor.text,
    rep: c.replies.map((x) => [x.author, x.createdAt, x.body]),
  });
}

function buildCardElement(c: CommentSummary): HTMLElement {
  const tmp = document.createElement("div");
  tmp.innerHTML = renderCommentCard(c);
  const card = tmp.firstElementChild as HTMLElement;
  attachCardHandlers(card, c.id);
  return card;
}

// Patch the comment list in place: keep unchanged thread cards (so a reply
// you're typing isn't interrupted), rebuild only the threads whose content
// changed, insert new ones, and drop removed ones.
function reconcileComments(): void {
  if (!sidebarEl) return;
  const list = sidebarEl.querySelector<HTMLElement>(".mdc-comment-list");
  if (!list) {
    renderSidebar();
    return;
  }
  updateSidebarCounts();
  const total = sidebarState.comments.length;
  const visible = sidebarState.comments
    .filter((c) => (sidebarState.hideResolved ? !c.resolved : true))
    .slice()
    .sort((a, b) => Number(a.resolved) - Number(b.resolved));
  if (visible.length === 0) {
    list.innerHTML = total === 0 ? emptyNoCommentsHtml() : emptyAllResolvedHtml(total);
    return;
  }
  if (list.querySelector(".mdc-sidebar-empty")) list.innerHTML = "";

  const seen = new Set<string>();
  let prev: HTMLElement | null = null;
  for (const c of visible) {
    seen.add(c.id);
    const existing = list.querySelector<HTMLElement>(
      `.mdc-comment[data-id="${cssEscape(c.id)}"]`,
    );
    let card: HTMLElement;
    if (existing && existing.dataset.sig === threadSignature(c)) {
      card = existing; // unchanged — leave the DOM (and any focused reply) alone
    } else {
      card = buildCardElement(c);
      if (existing) existing.replaceWith(card);
    }
    const desired: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
    if (desired !== card) {
      if (prev) prev.after(card);
      else list.prepend(card);
    }
    prev = card;
  }
  for (const card of Array.from(list.querySelectorAll<HTMLElement>(".mdc-comment"))) {
    if (!seen.has(card.dataset.id ?? "")) card.remove();
  }
}

function renderCommentCard(c: CommentSummary): string {
  const anchorText = escapeHtml(c.anchor.text.length > 80 ? c.anchor.text.slice(0, 77) + "…" : c.anchor.text);
  // Each comment/reply is the same shared `.mc-card` the inline + PR panels
  // use, so all three views render identical comment chrome. Each carries its
  // own Delete (a single comment), separate from the thread-level "Delete
  // thread" action in the header.
  const commentCard = (commentId: string, author: string, ts: string, body: string, reply: boolean): string =>
    `<div class="mc-card${reply ? " mc-card--reply" : ""}">
      <div class="mc-card__meta"><span class="mc-card__author">${escapeHtml(author)}</span><span class="mc-card__time">${escapeHtml(formatRelativeTime(ts))}</span></div>
      <div class="mc-card__body">${renderBodyWithLinks(body)}</div>
      <div class="mc-card__actions"><button type="button" class="mc-btn mc-btn--link mc-btn--danger" data-del-comment="${escapeAttr(commentId)}" title="Delete this comment">Delete</button></div>
    </div>`;
  const replies = c.replies.map((r) => commentCard(r.id, r.author, r.createdAt, r.body, true)).join("");
  return `
    <article class="mdc-comment ${c.resolved ? "mdc-comment--resolved" : ""}" data-id="${escapeAttr(c.id)}" data-sig="${escapeAttr(threadSignature(c))}">
      <div class="mdc-thread-head">
        <button type="button" class="mdc-thread-quote" data-comment-action="jump" title="Click to scroll to the highlighted passage">${anchorText}</button>
        <div class="mdc-thread-actions">
          <button type="button" class="mc-btn mc-btn--link" data-comment-action="send-thread-claude" title="Send this thread to Claude">→ Claude</button>
          <button type="button" class="mc-btn mc-btn--link" data-comment-action="copy-thread-claude" title="Copy this thread's prompt to the clipboard">Copy</button>
          <button type="button" class="mc-btn mc-btn--link" data-comment-action="resolve">${c.resolved ? "Unresolve" : "Resolve"}</button>
          <button type="button" class="mc-btn mc-btn--link mc-btn--danger" data-comment-action="delete" title="Delete the whole thread">Delete thread</button>
        </div>
      </div>
      ${commentCard(c.rootCommentId, c.author, c.createdAt, c.body, false)}
      ${replies}
      <div class="mdc-reply-box">
        <textarea class="mdc-reply-input" rows="2" placeholder="Reply…" aria-label="Reply to this thread"></textarea>
        <div class="mdc-reply-box-actions">
          <button type="button" class="mc-btn mc-btn--primary mdc-reply-submit" disabled>Reply</button>
        </div>
      </div>
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
  // Toolbar + action-row buttons (Add comment, Send to Claude, Copy).
  for (const btn of Array.from(
    sidebarEl.querySelectorAll<HTMLButtonElement>(
      ".mdc-sidebar-toolbar [data-action], .mdc-sidebar-actions [data-action]",
    ),
  )) {
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
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      if (action === "send-to-claude") {
        vscode.postMessage({ type: "invoke-command", command: "send-to-claude" });
        showNotice("Sent to Claude — your edits are saved to disk");
      } else if (action === "copy-prompt") {
        vscode.postMessage({ type: "invoke-command", command: "copy-prompt" });
      } else if (action === "add-comment") {
        openComposerForCurrentSelection();
      }
    });
  }
}

function attachCommentHandlers(): void {
  if (!sidebarEl) return;
  for (const card of Array.from(sidebarEl.querySelectorAll<HTMLElement>(".mdc-comment"))) {
    const id = card.dataset.id;
    if (id) attachCardHandlers(card, id);
  }
}

function attachCardHandlers(card: HTMLElement, id: string): void {
  for (const btn of Array.from(card.querySelectorAll<HTMLButtonElement>("[data-comment-action]"))) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.commentAction;
      if (action === "resolve")
        vscode.postMessage({ type: "toggle-resolve-comment", commentId: id });
      else if (action === "delete")
        armDelete(btn, () => vscode.postMessage({ type: "delete-comment", commentId: id }));
      else if (action === "send-thread-claude") {
        vscode.postMessage({ type: "invoke-command", command: "send-thread-claude", commentId: id });
        showNotice("Sent this thread to Claude — your edits are saved");
      } else if (action === "copy-thread-claude")
        vscode.postMessage({ type: "invoke-command", command: "copy-thread-claude", commentId: id });
      else if (action === "jump") {
        const comment = sidebarState.comments.find((c) => c.id === id);
        if (comment) jumpToAnchor(comment);
      }
    });
  }
  // Per-comment delete (each `.mc-card`), separate from the thread-level delete.
  for (const del of Array.from(card.querySelectorAll<HTMLButtonElement>("[data-del-comment]"))) {
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const commentId = del.dataset.delComment;
      if (!commentId) return;
      armDelete(del, () =>
        vscode.postMessage({ type: "delete-single-comment", threadId: id, commentId }),
      );
    });
  }
  attachReplyBox(card, id);
}

// Wire the always-on reply box at the bottom of a thread. Typing here is
// posted directly (no "Reply" button to open a composer first); in-progress
// text is kept in `pendingReplies` so a sidebar re-render doesn't lose it.
function attachReplyBox(card: HTMLElement, id: string): void {
  const input = card.querySelector<HTMLTextAreaElement>(".mdc-reply-input");
  const submit = card.querySelector<HTMLButtonElement>(".mdc-reply-submit");
  if (!input || !submit) return;
  input.value = pendingReplies.get(id) ?? "";
  submit.disabled = input.value.trim().length === 0;
  const send = (): void => {
    const body = input.value.trim();
    if (!body) return;
    submit.disabled = true;
    submit.textContent = "Sending…";
    vscode.postMessage({ type: "reply-comment", commentId: id, body, author: userName });
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("input", () => {
    pendingReplies.set(id, input.value);
    submit.disabled = input.value.trim().length === 0;
  });
  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  });
  submit.addEventListener("click", send);
}

// Inline two-step delete: the first click arms the button ("Confirm?"), a
// second click within 3s confirms. Keeps the confirmation on the button itself
// (next to where you clicked) instead of a dialog at the bottom of the thread.
function armDelete(btn: HTMLButtonElement, confirm: () => void): void {
  if (btn.dataset.armed === "1") {
    confirm();
    btn.textContent = "Deleting…";
    btn.disabled = true;
    return;
  }
  const original = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = "Confirm?";
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.armed === "1") {
      btn.dataset.armed = "";
      btn.textContent = original;
    }
  }, 3000);
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

// TEMP diagnostic: logs each anchor's locate/map outcome to the "Markdown
// Collab" output channel so we can see why heading highlights don't appear.
const HIGHLIGHT_DEBUG = true;

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
  const report: string[] = [];
  for (const c of comments) {
    if (c.resolved) continue; // Don't highlight resolved threads — too noisy.
    const rendered = locateAnchorInLiveText(haystack, c.anchor);
    if (!rendered) {
      report.push(
        `NOT-LOCATED id=${c.id} text=${JSON.stringify(c.anchor.text.slice(0, 40))} ctxBefore=${JSON.stringify(c.anchor.contextBefore.slice(-24))} ctxAfter=${JSON.stringify(c.anchor.contextAfter.slice(0, 24))}`,
      );
      continue;
    }
    const pmRange = renderedRangeToPmRange(doc, rendered.start, rendered.end);
    if (!pmRange) {
      report.push(
        `NO-PMRANGE id=${c.id} rendered=${rendered.start}-${rendered.end} text=${JSON.stringify(haystack.slice(rendered.start, rendered.end))}`,
      );
      continue;
    }
    report.push(`OK id=${c.id} pm=${pmRange.from}-${pmRange.to} text=${JSON.stringify(haystack.slice(rendered.start, rendered.end))}`);
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
  if (HIGHLIGHT_DEBUG && report.length > 0) {
    vscode.postMessage({
      type: "webview-error",
      stage: "highlight-debug",
      message: `decos=${decos.length} haystackLen=${haystack.length} :: ${report.join("  ||  ")}`,
    });
  }
  return DecorationSet.create(doc as never, decos);
}

// locateAnchorInLiveText now lives in ../collab/liveAnchorLocator for
// testability — re-exported via the top-of-file import.

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

// ---------------------------------------------------------------------------
// Drawio inline viewer
// ---------------------------------------------------------------------------
//
// Detection: a paragraph whose only inline content is a single link
// whose href ends in `.drawio` / `.drawio.xml` / `.xml`. That mirrors
// the "image-only paragraph promotes to block" convention markdown
// renderers already follow. Links mixed with other text keep their
// regular click behavior; only the dedicated diagram link gets the
// inline-render treatment.
//
// Loading: file content is owned by the extension. The widget posts
// `drawio-read` with a request id, then completes when the matching
// `drawio-read-result` arrives. A per-href cache avoids re-requesting
// on every PM transaction (every keystroke triggers a re-render of
// decorations).

const drawioPluginKey = new PluginKey("mdc-drawio");

interface DrawioCacheEntry {
  href: string;
  status: "pending" | "ready" | "error";
  svg?: SVGSVGElement;
  error?: string;
  // Re-render hooks: each rendered widget registers itself so the
  // entry can paint once content/error arrives. The set is cleared
  // when the entry resolves but lazy widget creation can still find
  // the cached value via status.
  listeners: Set<() => void>;
}

const drawioCache = new Map<string, DrawioCacheEntry>();
let drawioRequestCounter = 0;
const drawioPendingRequests = new Map<string, string>();

function isDrawioHrefForWidget(href: string): boolean {
  const cleaned = (href || "").trim().toLowerCase().split("#")[0]!.split("?")[0]!;
  if (!cleaned) return false;
  // Reject schemes — only workspace-relative paths are eligible. The
  // extension-side resolver enforces the same rule, but rejecting here
  // avoids the round-trip for obviously-out-of-scope hrefs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return false;
  return cleaned.endsWith(".drawio") || cleaned.endsWith(".drawio.xml") || cleaned.endsWith(".xml");
}

interface PmNode {
  type: { name: string };
  isText?: boolean;
  childCount?: number;
  child?: (i: number) => PmNode;
  marks?: Array<{ type: { name: string }; attrs: Record<string, unknown> }>;
  text?: string;
  textContent?: string;
}

// Returns the drawio href if the paragraph node is "diagram-only" — a
// single link mark on a single text node, whitespace-padding allowed.
function paragraphDrawioHref(paragraph: PmNode): string | null {
  if (paragraph.type.name !== "paragraph") return null;
  const childCount = paragraph.childCount ?? 0;
  // A diagram-only paragraph is a single text node carrying a link
  // mark. PM may split text into multiple nodes if marks change, but a
  // single-link paragraph has exactly one child.
  if (childCount !== 1) return null;
  const child = paragraph.child?.(0);
  if (!child || !child.isText) return null;
  const linkMark = (child.marks ?? []).find((m) => m.type.name === "link");
  if (!linkMark) return null;
  const href = String(linkMark.attrs.href ?? "");
  if (!isDrawioHrefForWidget(href)) return null;
  // The visible text can be any caption — we don't constrain it. But
  // if the user wrote `[label] (file.drawio)` (extra space after `]`),
  // PM still parses it as a link; we accept that too.
  return href;
}

function buildDrawioDecorations(doc: DocLike): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    const href = paragraphDrawioHref(node as unknown as PmNode);
    if (!href) return true;
    decos.push(
      Decoration.widget(pos, () => makeDrawioWidget(href), {
        side: 1,
        ignoreSelection: true,
        key: `drawio-${pos}-${href}`,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc as never, decos);
}

function makeDrawioWidget(href: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mdc-drawio";
  wrap.setAttribute("data-href", href);
  const target = document.createElement("div");
  target.className = "mdc-drawio__render";
  wrap.appendChild(target);

  const paint = (): void => {
    const entry = drawioCache.get(href);
    if (!entry) {
      target.textContent = "Loading diagram…";
      return;
    }
    if (entry.status === "pending") {
      target.textContent = "Loading diagram…";
      return;
    }
    if (entry.status === "error") {
      target.innerHTML = `<div class="mdc-drawio__error">${escapeHtml(entry.error ?? "Could not render diagram.")}</div>`;
      return;
    }
    if (entry.status === "ready" && entry.svg) {
      target.innerHTML = "";
      target.appendChild(entry.svg.cloneNode(true) as SVGSVGElement);
    }
  };

  const existing = drawioCache.get(href);
  if (existing) {
    existing.listeners.add(paint);
    paint();
  } else {
    requestDrawio(href, paint);
    paint();
  }

  return wrap;
}

function requestDrawio(href: string, repaint: () => void): void {
  const entry: DrawioCacheEntry = {
    href,
    status: "pending",
    listeners: new Set([repaint]),
  };
  drawioCache.set(href, entry);
  const requestId = `drawio-${++drawioRequestCounter}`;
  drawioPendingRequests.set(requestId, href);
  vscode.postMessage({ type: "drawio-read", requestId, href });
}

function handleDrawioReadResult(msg: DrawioReadResultMessage): void {
  drawioPendingRequests.delete(msg.requestId);
  const entry = drawioCache.get(msg.href);
  if (!entry) return;

  if (!msg.ok || typeof msg.content !== "string") {
    entry.status = "error";
    entry.error = msg.error ?? "Could not load diagram.";
    flushDrawioListeners(entry);
    return;
  }

  void (async () => {
    try {
      const { renderDrawioToSvg } = await import("./drawioRenderer");
      const result = await renderDrawioToSvg(msg.content!);
      if (result.ok) {
        entry.status = "ready";
        entry.svg = result.svg;
      } else {
        entry.status = "error";
        entry.error = result.message;
      }
    } catch (e) {
      entry.status = "error";
      entry.error = (e as Error).message;
    }
    flushDrawioListeners(entry);
  })();
}

function flushDrawioListeners(entry: DrawioCacheEntry): void {
  for (const fn of entry.listeners) {
    try {
      fn();
    } catch (e) {
      postError("drawio-paint", e);
    }
  }
  entry.listeners.clear();
}

function makeDrawioPlugin(): Plugin {
  return new Plugin({
    key: drawioPluginKey,
    state: {
      init: (_cfg, state) => buildDrawioDecorations(state.doc),
      apply: (tr, oldDecos) =>
        tr.docChanged ? buildDrawioDecorations(tr.doc) : oldDecos.map(tr.mapping, tr.doc),
    },
    props: {
      decorations(state) {
        return drawioPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

// Milkdown's GFM preset wires `prosemirror-tables`' `tableEditing`
// plugin, which promotes any drag that touches a cell boundary into a
// `CellSelection` covering the whole cell(s). For commenting, that
// snap-to-cell behaviour is wrong: the user wants to highlight a
// substring of a cell, not the cell itself. We can't disable the
// promotion (it's hardcoded inside the table-editing plugin's mousedown
// handler), so instead we run `appendTransaction` after every state
// update and, whenever the resulting selection is a `CellSelection`,
// rewrite it to a plain `TextSelection` covering only the visible text
// of the selected cell range. The user sees a normal text-range
// highlight; the comment anchor records the actual text they meant.
function makeFlattenCellSelectionPlugin(): Plugin {
  return new Plugin({
    appendTransaction(_trs, _oldState, newState) {
      const sel = newState.selection;
      if (!(sel instanceof CellSelection)) return null;
      const $a = sel.$anchorCell;
      const $h = sel.$headCell;
      const lo = $a.pos <= $h.pos ? $a : $h;
      const hi = $a.pos <= $h.pos ? $h : $a;
      const loCell = lo.nodeAfter;
      const hiCell = hi.nodeAfter;
      if (!loCell || !hiCell) return null;
      // Inner text positions: skip past the cell open token (+1) and stop
      // before the cell close token (nodeSize - 1, since outer +1 was
      // already paid).
      const from = lo.pos + 1;
      const to = hi.pos + hiCell.nodeSize - 1;
      if (from >= to) return null;
      return newState.tr.setSelection(TextSelection.create(newState.doc, from, to));
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
  // Belt-and-suspenders for the floating button: capture-phase pointerdown
  // anywhere snapshots PM's selection BEFORE any focus shift or
  // setTimeout-0 refresh can run. Closes the race where a fast click on
  // the button beats the prior selectionchange's deferred refresh.
  window.addEventListener("pointerdown", () => {
    updateLastNonEmptySelection();
  }, true);

  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    captureCurrentSelection();
    updateLastNonEmptySelection();
  });
  button.addEventListener("click", () => {
    button.style.display = "none";
    openComposerForCurrentSelection();
  });
}

function openComposerForCurrentSelection(): void {
  if (!editor || !composerEl) return;
  let anchor: import("../types").Anchor | null = null;
  // Exact selection offsets into `anchorFullMd` (the editor's current body
  // markdown). The host places the invisible marker at these offsets instead
  // of fuzzy-searching, so commenting never fails to "locate the text".
  // -1 means "unknown" (the rare slice-not-in-fullMd case) → host falls back.
  let anchorSelStart = -1;
  let anchorSelEnd = -1;
  let anchorFullMd = "";
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
    anchorFullMd = fullMd;
    // The selection's *visible text* (textContent) is reliable for ANY
    // content — table cells, bold, links — and is the anchor backbone: the
    // live highlight matches it against the editor text and the host stores
    // it as the quote. The markdown slice + offsets are computed too, but
    // only as a precise-placement bonus when the slice maps cleanly into
    // fullMd (plain paragraph spans). A table cell serializes to a mini-table
    // that isn't in fullMd verbatim — we just skip the offsets there and let
    // the host place by text or save loosely-anchored, instead of refusing.
    const renderedText = view.state.doc.textContent;
    const renderedSelStart = renderedOffsetForPm(view.state.doc, selFrom);
    const renderedSelEnd = renderedOffsetForPm(view.state.doc, selTo);
    let sliceMd = "";
    try {
      sliceMd = serializer(view.state.doc.cut(selFrom, selTo)).trim();
    } catch {
      sliceMd = "";
    }
    displayText =
      renderedSelStart >= 0 && renderedSelEnd >= 0
        ? renderedText.slice(renderedSelStart, renderedSelEnd).trim()
        : sliceMd;

    const anchorText = displayText || sliceMd;
    if (anchorText.replace(/\s/g, "").length < 3) {
      failureReason = "Selection is too short. Highlight a few more characters.";
      return;
    }
    anchor = {
      text: anchorText,
      contextBefore:
        renderedSelStart >= 0 ? renderedText.slice(Math.max(0, renderedSelStart - 24), renderedSelStart) : "",
      contextAfter: renderedSelEnd >= 0 ? renderedText.slice(renderedSelEnd, renderedSelEnd + 24) : "",
    };

    // Precise-placement bonus: if the markdown slice appears in fullMd, record
    // exact offsets so the host wraps that exact span. Otherwise leave the
    // offsets at -1 and let the host fall back to text / loose anchoring.
    if (sliceMd.length > 0) {
      const occurrences: number[] = [];
      let from = 0;
      while (true) {
        const idx = fullMd.indexOf(sliceMd, from);
        if (idx < 0) break;
        occurrences.push(idx);
        from = idx + 1;
      }
      if (occurrences.length > 0) {
        let approxMdStart = -1;
        try {
          approxMdStart = serializer(view.state.doc.cut(0, selFrom)).length;
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
        anchorSelStart = chosen;
        anchorSelEnd = chosen + sliceMd.length;
      }
    }
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
      // Exact placement: the host wraps [selStart, selEnd) in fullMd with the
      // marker, no fuzzy locate. Falls back to anchor text when offsets are -1.
      fullMd: anchorFullMd,
      selStart: anchorSelStart,
      selEnd: anchorSelEnd,
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
  // Cancel a still-pending local edit post. The keystroke that scheduled it
  // predates this external (Claude) change, so letting it fire would overwrite
  // Claude's edit with our stale text.
  if (editDebounce) {
    clearTimeout(editDebounce);
    editDebounce = null;
  }
  // `applyTemplate` replaces the whole document, which otherwise snaps the
  // view back to the top and drops the cursor. Capture the scroll position
  // and selection first, then restore them — so an external edit, or a
  // format-on-save echo right after you typed, doesn't jump to the file head.
  const scroller = editorContainer?.parentElement ?? null; // .mdc-editor-pane (overflow:auto)
  const prevScrollTop = scroller?.scrollTop ?? 0;
  let prevFrom = -1;
  editor.action((ctx) => {
    prevFrom = ctx.get(editorViewCtx).state.selection.from;
  });

  suppressNextPost = true;
  cachedMarkdown = text;
  editor.action((ctx) => ctx.set(defaultValueCtx, text));
  editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx);
    collabService.applyTemplate(text, () => true);
  });

  // Restore the cursor near its old position (clamped to the new doc),
  // without auto-scrolling — we restore the scroll offset ourselves.
  if (prevFrom >= 0) {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      try {
        const pos = Math.max(0, Math.min(prevFrom, view.state.doc.content.size));
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
      } catch {
        /* positions shifted past EOF after the change — leave the default */
      }
    });
  }
  if (scroller) {
    requestAnimationFrame(() => {
      scroller.scrollTop = prevScrollTop;
    });
  }
  forceHighlightRefresh();
  showNotice("Updated from disk");
}

// Flash a transient one-line notice in the sidebar header, then clear it. Used
// when an edit arrives from outside the editor (Claude editing the .md, a save
// from another window, git) so the change isn't silent.
function showNotice(text: string): void {
  sidebarState.notice = text;
  renderNotice();
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    sidebarState.notice = null;
    noticeTimer = null;
    renderNotice();
  }, 2500);
}

// Render the read-only frontmatter panel above the editor. Milkdown would
// turn the `---` fences into thematic breaks and corrupt the YAML on save, so
// the frontmatter is kept out of the body and surfaced here instead.
function renderFrontmatter(raw: string): void {
  if (!frontmatterEl) return;
  const text = (raw ?? "").replace(/\n+$/, "");
  if (!text.trim()) {
    frontmatterEl.hidden = true;
    frontmatterEl.textContent = "";
    return;
  }
  frontmatterEl.hidden = false;
  frontmatterEl.innerHTML =
    `<div class="mdc-frontmatter-head">` +
    `<span class="mdc-frontmatter-label">Frontmatter</span>` +
    `<span class="mdc-frontmatter-hint">read-only — edit in the plain text editor</span>` +
    `</div>` +
    `<pre class="mdc-frontmatter-body">${escapeHtml(text)}</pre>`;
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
  // In-doc fragment links scroll the editor to the heading; everything else
  // is routed to the host for opening.
  if (href.startsWith("#")) {
    scrollEditorToFragment(href.slice(1));
    return;
  }
  vscode.postMessage({ type: "open-link", href });
});

/** Scroll the editor to a heading matching `fragment` (by id, else by slug). */
function scrollEditorToFragment(fragment: string): void {
  if (!fragment || !editor) return;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* malformed escape — match the raw form */
  }
  editor.action((ctx) => {
    const root = ctx.get(editorViewCtx).dom as HTMLElement;
    const byId = root.querySelector<HTMLElement>(`[id="${cssEscape(decoded)}"]`);
    if (byId) {
      byId.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    for (const h of Array.from(root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"))) {
      if (slugifyHeading(h.textContent || "") === decoded) {
        h.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  });
}

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
  } else if (msg.type === "frontmatter") {
    renderFrontmatter(msg.frontmatter);
  } else if (msg.type === "sidecar-changed") {
    sidebarState.comments = msg.comments ?? [];
    reconcileComments();
    forceHighlightRefresh();
  } else if (msg.type === "add-comment-result") {
    if (msg.ok) {
      if (composerEl) composerEl.innerHTML = "";
      showToast("Comment added.");
      // Belt-and-suspenders: re-run the anchor highlight once the doc has
      // settled (the sidecar-changed refresh can fire before a save-participant
      // re-seed lands), so a fresh comment's highlight shows immediately.
      requestAnimationFrame(() => forceHighlightRefresh());
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
      // The reply landed; drop the in-progress text so the upcoming re-render
      // shows an empty reply box for this thread.
      pendingReplies.delete(msg.commentId);
      showToast("Reply sent.");
    } else {
      const submit = document.querySelector<HTMLButtonElement>(
        `.mdc-comment[data-id="${cssEscape(msg.commentId)}"] .mdc-reply-submit`,
      );
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Reply";
      }
      showToast(`Reply failed: ${msg.error ?? "unknown error"}`);
    }
  } else if (msg.type === "toggle-resolve-result") {
    if (!msg.ok) showToast(`Resolve failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "delete-comment-result") {
    if (!msg.ok) showToast(`Delete failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "open-link-result") {
    if (!msg.ok) showToast(`Could not open link: ${msg.reason ?? msg.href}`);
  } else if (msg.type === "drawio-read-result") {
    handleDrawioReadResult(msg);
  }
});

// VS Code webviews lose document focus the moment the user clicks any
// outer chrome (file tree, terminal, another editor). The next click
// back into the webview is then consumed as a focus-capture gesture
// before its own handler runs — every button feels like it needs two
// clicks. Pre-empt that by stealing focus back the instant the pointer
// re-enters or presses anywhere inside the iframe. Capture phase + no
// preventDefault keeps it transparent to the actual click flow.
window.addEventListener(
  "pointerdown",
  () => {
    if (!document.hasFocus()) window.focus();
  },
  true,
);
window.addEventListener(
  "mouseenter",
  () => {
    if (!document.hasFocus()) window.focus();
  },
  true,
);

vscode.postMessage({ type: "ready" });
