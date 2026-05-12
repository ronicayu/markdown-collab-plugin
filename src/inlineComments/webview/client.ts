// Webview client for the experimental inline-comments view.
//
// Renders the .md prose (with mc:* markup stripped) via markdown-it,
// overlays a highlight on each anchored span, and runs a sidebar of
// threads with add/reply/edit/resolve/delete UI. All state mutations
// round-trip through the extension host as `WorkspaceEdit`s on the
// underlying .md file — there is no in-webview cache of comments.

import MarkdownIt from "markdown-it";
import { installSourceOffsetPlugin } from "./renderWithOffsets";

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  setState: (s: unknown) => void;
  getState: () => unknown;
};

declare global {
  interface Window {
    mermaid?: {
      initialize: (cfg: Record<string, unknown>) => void;
      run: (cfg?: { querySelector?: string }) => Promise<void>;
    };
  }
}

const vscode = acquireVsCodeApi();

interface InlineComment {
  id: string;
  parent?: string;
  author: string;
  ts: string;
  body: string;
  editedTs?: string;
  deleted?: boolean;
}

interface ThreadState {
  id: string;
  quote: string;
  status: "open" | "resolved";
  resolvedBy?: string;
  resolvedTs?: string;
  comments: InlineComment[];
  anchor: { proseStart: number; proseEnd: number } | null;
}

interface SerializedState {
  prose: string;
  threads: ThreadState[];
}

interface InitMsg {
  type: "init";
  fileName: string;
  state: SerializedState;
  user: { name: string };
}

interface UpdateMsg {
  type: "update";
  state: SerializedState;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
installSourceOffsetPlugin(md);

const dom = {
  fileName: document.getElementById("file-name") as HTMLElement,
  preview: document.getElementById("preview") as HTMLElement,
  floating: document.getElementById("floating-add") as HTMLButtonElement,
  threadCount: document.getElementById("thread-count") as HTMLElement,
  threadsList: document.getElementById("threads-list") as HTMLElement,
  composer: document.getElementById("composer") as HTMLElement,
  filterRadios: document.querySelectorAll<HTMLInputElement>('input[name="filter"]'),
  sendToClaude: document.getElementById("send-to-claude") as HTMLButtonElement,
  copyPrompt: document.getElementById("copy-prompt") as HTMLButtonElement,
};

dom.sendToClaude.addEventListener("click", () => {
  vscode.postMessage({ type: "send-to-claude" });
});
dom.copyPrompt.addEventListener("click", () => {
  vscode.postMessage({ type: "copy-prompt" });
});

let currentState: SerializedState | null = null;
let user: { name: string } = { name: "anonymous" };
let filter: "open" | "all" | "resolved" = "open";
let pendingSelection: { proseStart: number; proseEnd: number } | null = null;
let editingCommentId: string | null = null; // composite "threadId:commentId" when editing
let highlightedThreadId: string | null = null;
// Track two-click delete confirmation per thread / per comment. Using
// inline confirm rather than window.confirm() because VSCode webviews
// silently block sync modal dialogs — the user would click Delete and
// see nothing happen.
const pendingDeleteThread = new Set<string>();
const pendingDeleteComment = new Set<string>(); // composite "threadId:commentId"

function render(state: SerializedState): void {
  currentState = state;
  renderPreview(state);
  renderThreads(state);
  positionFloatingButton();
}

let mermaidInitialized = false;

function renderPreview(state: SerializedState): void {
  // markdown-it renders the prose to HTML. Our source-offset plugin
  // wraps every text/code token in `<span data-mc-src="START.END">…`,
  // where START/END are prose-offset byte ranges. We then walk those
  // spans to overlay anchor highlights — no fuzzy text matching.
  dom.preview.innerHTML = md.render(state.prose);
  applyAnchorHighlights(state);
  void runMermaid();
}

async function runMermaid(): Promise<void> {
  const mermaid = window.mermaid;
  if (!mermaid) return;
  if (!mermaidInitialized) {
    const isDark =
      document.body.classList.contains("vscode-dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "strict",
      });
      mermaidInitialized = true;
    } catch (e) {
      console.error("mermaid init failed", e);
      return;
    }
  }
  // mermaid.run mutates `<pre class="mermaid">` in place by replacing its
  // content with an SVG. Anchored highlight spans inside the block (if
  // any) survive only as data attributes on the source-offset span we
  // wrap around the code; the SVG itself isn't selectable, so anchored
  // text inside a mermaid block won't visually highlight (but the
  // sidebar card still works).
  try {
    await mermaid.run({ querySelector: "pre.mermaid" });
  } catch (e) {
    console.error("mermaid render failed", e);
  }
}

interface ProseSpan {
  el: HTMLElement;
  proseStart: number;
  proseEnd: number;
}

/** All `[data-mc-src]` spans in the preview, in document order, with parsed offsets. */
function collectProseSpans(): ProseSpan[] {
  const out: ProseSpan[] = [];
  const nodes = dom.preview.querySelectorAll<HTMLElement>("[data-mc-src]");
  for (const el of Array.from(nodes)) {
    const raw = el.dataset.mcSrc;
    if (!raw) continue;
    const dot = raw.indexOf(".");
    if (dot === -1) continue;
    const s = Number(raw.slice(0, dot));
    const e = Number(raw.slice(dot + 1));
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    out.push({ el, proseStart: s, proseEnd: e });
  }
  return out;
}

/**
 * For each thread with an anchor range, find every prose span that
 * overlaps the anchor and wrap the overlapping slice of the span's text
 * in a `<mark class="mc-hl">`. Because span boundaries align with
 * source-offset boundaries exactly, a single mark per span suffices.
 */
function applyAnchorHighlights(state: SerializedState): void {
  const spans = collectProseSpans();
  for (const t of state.threads) {
    if (!t.anchor) continue;
    if (filter === "open" && t.status === "resolved") continue;
    if (filter === "resolved" && t.status === "open") continue;
    for (const span of spans) {
      const start = Math.max(span.proseStart, t.anchor.proseStart);
      const end = Math.min(span.proseEnd, t.anchor.proseEnd);
      if (start >= end) continue;
      wrapSpanRange(span, start - span.proseStart, end - span.proseStart, t.id, t.status);
    }
  }
}

/**
 * Wrap chars [textStart, textEnd) of `span.el`'s first text node in a
 * `<mark>`. The renderer guarantees each `[data-mc-src]` wraps either a
 * single text node or `<code>`-text-`</code>`; we handle both.
 */
function wrapSpanRange(
  span: ProseSpan,
  textStart: number,
  textEnd: number,
  threadId: string,
  status: "open" | "resolved",
): void {
  const el = span.el;
  // The span renderer produces either:
  //   <span data-mc-src="..">TEXT</span>
  //   <span data-mc-src=".."><code>TEXT</code></span>
  // Pick the text-holding node.
  let textHost: HTMLElement = el;
  if (el.firstElementChild && el.children.length === 1 && el.firstElementChild.tagName === "CODE") {
    textHost = el.firstElementChild as HTMLElement;
  }
  const textNode = textHost.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
  const data = (textNode as Text).data;
  const tStart = Math.max(0, Math.min(textStart, data.length));
  const tEnd = Math.max(tStart, Math.min(textEnd, data.length));
  if (tEnd <= tStart) return;
  const before = data.slice(0, tStart);
  const middle = data.slice(tStart, tEnd);
  const after = data.slice(tEnd);
  textHost.removeChild(textNode);
  if (before) textHost.appendChild(document.createTextNode(before));
  const mark = document.createElement("mark");
  mark.className = `mc-hl ${status === "resolved" ? "mc-hl-resolved" : ""}`;
  mark.dataset.thread = threadId;
  mark.textContent = middle;
  mark.addEventListener("click", (e) => {
    e.stopPropagation();
    highlightedThreadId = threadId;
    scrollSidebarTo(threadId);
    for (const c of dom.threadsList.querySelectorAll<HTMLElement>(".thread-card")) {
      c.classList.toggle("highlighted", c.dataset.thread === threadId);
    }
  });
  textHost.appendChild(mark);
  if (after) textHost.appendChild(document.createTextNode(after));
}

/**
 * In-progress reply textarea content keyed by thread id. Preserved across
 * re-renders (which fire on every external update — e.g., when the AI's
 * reply lands and the file changes) so the user doesn't lose their typing
 * mid-sentence. Also tracks which thread had the focused textarea so we
 * can restore it.
 */
const pendingReplyText = new Map<string, string>();
let focusedReplyThreadId: string | null = null;

function captureReplyState(): void {
  for (const card of dom.threadsList.querySelectorAll<HTMLElement>(".thread-card")) {
    const id = card.dataset.thread;
    if (!id) continue;
    const ta = card.querySelector<HTMLTextAreaElement>(".reply-box textarea");
    if (!ta) continue;
    if (ta.value.length > 0) pendingReplyText.set(id, ta.value);
    if (document.activeElement === ta) focusedReplyThreadId = id;
  }
}

function renderThreads(state: SerializedState): void {
  captureReplyState();
  const list = dom.threadsList;
  list.innerHTML = "";
  const filtered = state.threads.filter((t) => {
    if (filter === "open") return t.status === "open";
    if (filter === "resolved") return t.status === "resolved";
    return true;
  });
  const totalOpen = state.threads.filter((t) => t.status === "open").length;
  dom.threadCount.textContent = `${totalOpen} open · ${state.threads.length} total`;
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      filter === "open"
        ? "No open comments. Select text in the preview to start a thread."
        : "No comments match this filter.";
    list.appendChild(empty);
    return;
  }
  for (const t of filtered) {
    list.appendChild(renderThreadCard(t));
  }
}

function renderThreadCard(t: ThreadState): HTMLElement {
  const card = document.createElement("section");
  card.className = "thread-card";
  if (t.status === "resolved") card.classList.add("resolved");
  if (t.id === highlightedThreadId) card.classList.add("highlighted");
  card.dataset.thread = t.id;
  card.addEventListener("click", () => {
    highlightedThreadId = t.id;
    scrollPreviewTo(t);
    // Update only the .highlighted class on cards; do NOT re-render the
    // list, because that would blow away any in-progress reply textarea
    // content the user has typed on a different card.
    for (const c of dom.threadsList.querySelectorAll<HTMLElement>(".thread-card")) {
      c.classList.toggle("highlighted", c.dataset.thread === t.id);
    }
  });

  const head = document.createElement("header");
  head.className = "thread-head";
  const quote = document.createElement("blockquote");
  quote.className = "thread-quote";
  quote.textContent = t.quote || "(no quote)";
  if (!t.anchor) {
    const badge = document.createElement("span");
    badge.className = "badge broken";
    badge.textContent = "broken anchor";
    badge.title = "Anchor marker missing from prose. Fix by re-anchoring.";
    quote.appendChild(badge);
  }
  head.appendChild(quote);

  const actions = document.createElement("div");
  actions.className = "thread-actions";
  const resolveBtn = document.createElement("button");
  resolveBtn.className = "btn-ghost";
  resolveBtn.textContent = t.status === "resolved" ? "Reopen" : "Resolve";
  resolveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "toggle-resolve", threadId: t.id });
  });
  const armed = pendingDeleteThread.has(t.id);
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-ghost danger";
  deleteBtn.textContent = armed ? "Confirm delete" : "Delete";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pendingDeleteThread.has(t.id)) {
      pendingDeleteThread.delete(t.id);
      vscode.postMessage({ type: "delete-thread", threadId: t.id });
    } else {
      pendingDeleteThread.add(t.id);
      // Auto-disarm after a few seconds so a stale "Confirm delete"
      // button doesn't sit there waiting to bite.
      setTimeout(() => {
        if (pendingDeleteThread.delete(t.id) && currentState) renderThreads(currentState);
      }, 4000);
      renderThreads(currentState!);
    }
  });
  actions.append(resolveBtn, deleteBtn);
  if (armed) {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingDeleteThread.delete(t.id);
      renderThreads(currentState!);
    });
    actions.append(cancelBtn);
  }
  head.appendChild(actions);
  card.appendChild(head);

  for (const c of t.comments) {
    card.appendChild(renderComment(t, c));
  }

  // Reply composer. We stop click propagation on the box and its children
  // so clicking inside doesn't bubble to the card's click handler (which
  // would re-highlight the thread and trigger a re-render that wipes the
  // textarea content the user just typed).
  const replyBox = document.createElement("div");
  replyBox.className = "reply-box";
  replyBox.addEventListener("click", (e) => e.stopPropagation());
  replyBox.addEventListener("mousedown", (e) => e.stopPropagation());
  const replyTa = document.createElement("textarea");
  replyTa.placeholder = "Reply…";
  replyTa.rows = 1;
  // Restore in-progress text captured before the most recent re-render.
  const restoredText = pendingReplyText.get(t.id) ?? "";
  if (restoredText) {
    replyTa.value = restoredText;
    requestAnimationFrame(() => autoresize(replyTa));
  }
  replyTa.addEventListener("input", () => {
    autoresize(replyTa);
    replyBtn.disabled = replyTa.value.trim().length === 0;
    if (replyTa.value.length === 0) pendingReplyText.delete(t.id);
    else pendingReplyText.set(t.id, replyTa.value);
  });
  replyBox.appendChild(replyTa);
  const replyBtn = document.createElement("button");
  replyBtn.textContent = "Reply";
  replyBtn.disabled = restoredText.trim().length === 0;
  replyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const body = replyTa.value.trim();
    if (!body) return;
    vscode.postMessage({ type: "reply", threadId: t.id, body });
    replyTa.value = "";
    replyBtn.disabled = true;
    pendingReplyText.delete(t.id);
  });
  replyBox.appendChild(replyBtn);
  card.appendChild(replyBox);
  if (focusedReplyThreadId === t.id) {
    requestAnimationFrame(() => {
      replyTa.focus();
      replyTa.selectionStart = replyTa.selectionEnd = replyTa.value.length;
    });
    focusedReplyThreadId = null;
  }

  return card;
}

function renderComment(thread: ThreadState, c: InlineComment): HTMLElement {
  const el = document.createElement("article");
  el.className = "comment";
  if (c.deleted) el.classList.add("tombstone");
  if (c.parent) el.classList.add("reply");

  const meta = document.createElement("header");
  meta.className = "comment-meta";
  const author = document.createElement("strong");
  author.textContent = c.author;
  const ts = document.createElement("time");
  ts.textContent = " · " + formatTs(c.ts) + (c.editedTs ? " · edited" : "");
  meta.append(author, ts);
  el.appendChild(meta);

  if (c.deleted) {
    const body = document.createElement("p");
    body.className = "comment-body deleted";
    body.textContent = "(comment deleted)";
    el.appendChild(body);
    return el;
  }

  const editingKey = `${thread.id}:${c.id}`;
  if (editingCommentId === editingKey) {
    const ta = document.createElement("textarea");
    ta.value = c.body;
    ta.rows = Math.max(2, Math.min(8, c.body.split("\n").length));
    el.appendChild(ta);
    const row = document.createElement("div");
    row.className = "edit-actions";
    const save = document.createElement("button");
    save.textContent = "Save";
    save.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "edit-comment", threadId: thread.id, commentId: c.id, body: ta.value });
      editingCommentId = null;
    });
    const cancel = document.createElement("button");
    cancel.className = "btn-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      editingCommentId = null;
      renderThreads(currentState!);
    });
    row.append(save, cancel);
    el.appendChild(row);
    return el;
  }

  const body = document.createElement("div");
  body.className = "comment-body";
  body.innerHTML = md.renderInline(c.body);
  el.appendChild(body);

  const tools = document.createElement("div");
  tools.className = "comment-tools";
  const editBtn = document.createElement("button");
  editBtn.className = "btn-link";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    editingCommentId = editingKey;
    renderThreads(currentState!);
  });
  const cmtKey = `${thread.id}:${c.id}`;
  const cmtArmed = pendingDeleteComment.has(cmtKey);
  const delBtn = document.createElement("button");
  delBtn.className = "btn-link danger";
  delBtn.textContent = cmtArmed ? "Confirm" : "Delete";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pendingDeleteComment.has(cmtKey)) {
      pendingDeleteComment.delete(cmtKey);
      vscode.postMessage({ type: "delete-comment", threadId: thread.id, commentId: c.id });
    } else {
      pendingDeleteComment.add(cmtKey);
      setTimeout(() => {
        if (pendingDeleteComment.delete(cmtKey) && currentState) renderThreads(currentState);
      }, 4000);
      renderThreads(currentState!);
    }
  });
  tools.append(editBtn, delBtn);
  if (cmtArmed) {
    const cancel = document.createElement("button");
    cancel.className = "btn-link";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingDeleteComment.delete(cmtKey);
      renderThreads(currentState!);
    });
    tools.append(cancel);
  }
  el.appendChild(tools);
  return el;
}

function formatTs(ts: string): string {
  const t = new Date(ts);
  if (isNaN(t.getTime())) return ts;
  const diff = Date.now() - t.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return t.toLocaleDateString();
}

function autoresize(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
}

function scrollSidebarTo(id: string): void {
  const el = dom.threadsList.querySelector<HTMLElement>(`[data-thread="${id}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function scrollPreviewTo(t: ThreadState): void {
  if (!t.anchor) return;
  const el = dom.preview.querySelector<HTMLElement>(`mark[data-thread="${t.id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1200);
  }
}

function positionFloatingButton(): void {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) {
    dom.floating.hidden = true;
    pendingSelection = null;
    return;
  }
  // Ensure selection is inside the preview.
  if (!dom.preview.contains(sel.anchorNode) || !dom.preview.contains(sel.focusNode)) {
    dom.floating.hidden = true;
    pendingSelection = null;
    return;
  }
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    dom.floating.hidden = true;
    return;
  }
  const ps = endpointToProse(range.startContainer, range.startOffset, "start");
  const pe = endpointToProse(range.endContainer, range.endOffset, "end");
  if (ps === null || pe === null || pe <= ps) {
    dom.floating.hidden = true;
    pendingSelection = null;
    return;
  }
  // Guard: refuse selections that fall inside a fenced/indented code
  // block. The parser strips anchor markers in code regions, so the
  // resulting thread would be orphaned. Tell the user up-front.
  if (selectionTouchesCode(range)) {
    dom.floating.hidden = true;
    dom.floating.title = "Comments inside code blocks are not supported.";
    pendingSelection = null;
    return;
  }
  dom.floating.title = "";
  pendingSelection = { proseStart: ps, proseEnd: pe };
  dom.floating.hidden = false;
  const previewRect = dom.preview.getBoundingClientRect();
  dom.floating.style.top = rect.bottom - previewRect.top + dom.preview.scrollTop + 4 + "px";
  dom.floating.style.left = rect.left - previewRect.left + 4 + "px";
}

/**
 * Map a (node, offset) pair from a DOM Range endpoint into a prose-byte
 * offset. Walks up to the nearest `[data-mc-src]` ancestor and adds the
 * char position within that ancestor's text.
 *
 * Returns null when the endpoint isn't inside a tagged span — which
 * happens, by design, in code blocks (we don't annotate fenced blocks at
 * char granularity because anchors there get stripped by the parser) or
 * in stretches of pure markup markdown-it adds without a token (e.g.,
 * around table structural cells with no inline children).
 */
function endpointToProse(node: Node, offset: number, which: "start" | "end"): number | null {
  // Resolve the span that owns this endpoint.
  let host: HTMLElement | null = null;
  let charOffset = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    const span = findSpanAncestor(node);
    if (!span) return null;
    host = span;
    charOffset = textOffsetWithinSpan(span, node, offset);
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (el.hasAttribute("data-mc-src")) {
      host = el;
      // offset is child-index. Translate to char position by walking children.
      charOffset = childIndexToCharOffset(el, offset);
    } else {
      // Look for a [data-mc-src] inside the children up to `offset`, or
      // walk up to find an ancestor span.
      const ancestor = findSpanAncestor(el);
      if (ancestor) {
        host = ancestor;
        // For an element-node endpoint inside a tagged ancestor, find a
        // text node at/just-before the child boundary.
        const childAtOffset = el.childNodes[offset] ?? null;
        if (childAtOffset) {
          const probe = firstTextNodeIn(childAtOffset);
          if (probe) charOffset = textOffsetWithinSpan(ancestor, probe, 0);
        } else {
          // Past last child of el — use end-of-host.
          charOffset = textLengthOfSpan(ancestor);
        }
      } else {
        // Fall back: try the nearest sibling span.
        host = nearestSiblingSpan(el, offset, which);
        if (host) {
          charOffset = which === "start" ? 0 : textLengthOfSpan(host);
        }
      }
    }
  }
  if (!host) return null;
  const raw = host.dataset.mcSrc;
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const proseStart = Number(raw.slice(0, dot));
  const proseEnd = Number(raw.slice(dot + 1));
  if (!Number.isFinite(proseStart) || !Number.isFinite(proseEnd)) return null;
  const clamped = Math.max(0, Math.min(charOffset, proseEnd - proseStart));
  return proseStart + clamped;
}

function selectionTouchesCode(range: Range): boolean {
  const within = (n: Node): boolean => {
    let cur: Node | null = n;
    while (cur && cur !== dom.preview) {
      if (cur.nodeType === Node.ELEMENT_NODE) {
        const tag = (cur as HTMLElement).tagName;
        if (tag === "CODE" || tag === "PRE") return true;
      }
      cur = cur.parentNode;
    }
    return false;
  };
  return within(range.startContainer) || within(range.endContainer);
}

function findSpanAncestor(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== dom.preview) {
    if (cur.nodeType === Node.ELEMENT_NODE && (cur as HTMLElement).hasAttribute("data-mc-src")) {
      return cur as HTMLElement;
    }
    cur = cur.parentNode;
  }
  return null;
}

function firstTextNodeIn(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function textOffsetWithinSpan(span: HTMLElement, textNode: Node, charsIntoText: number): number {
  let acc = 0;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    if (n === textNode) return acc + charsIntoText;
    acc += (n as Text).data.length;
    n = walker.nextNode();
  }
  return acc;
}

function textLengthOfSpan(span: HTMLElement): number {
  let acc = 0;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    acc += (n as Text).data.length;
    n = walker.nextNode();
  }
  return acc;
}

function childIndexToCharOffset(el: HTMLElement, childIndex: number): number {
  let acc = 0;
  for (let i = 0; i < childIndex && i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === Node.TEXT_NODE) acc += (c as Text).data.length;
    else acc += (c as HTMLElement).textContent?.length ?? 0;
  }
  return acc;
}

/**
 * When the selection endpoint lands on an element node whose closest
 * `[data-mc-src]` ancestor is the preview itself (i.e., between block
 * elements), pick the adjacent tagged span — previous one for the END,
 * next one for the START — so that selecting whole blocks still yields
 * a usable range. Returns null when no such neighbor exists.
 */
function nearestSiblingSpan(el: HTMLElement, offset: number, which: "start" | "end"): HTMLElement | null {
  const child = el.childNodes[which === "start" ? offset : offset - 1];
  if (!child) return null;
  if (child.nodeType !== Node.ELEMENT_NODE) return null;
  const probe = which === "start"
    ? (child as HTMLElement).querySelector<HTMLElement>("[data-mc-src]")
    : Array.from((child as HTMLElement).querySelectorAll<HTMLElement>("[data-mc-src]")).pop() ?? null;
  return probe;
}

dom.floating.addEventListener("mousedown", (e) => {
  // Capture selection BEFORE click would clear it.
  e.preventDefault();
});
dom.floating.addEventListener("click", () => {
  if (!pendingSelection) return;
  openComposer(pendingSelection);
});

function openComposer(sel: { proseStart: number; proseEnd: number }): void {
  dom.composer.hidden = false;
  dom.composer.innerHTML = "";
  const header = document.createElement("div");
  header.className = "composer-header";
  header.textContent = "New comment";
  const ta = document.createElement("textarea");
  ta.placeholder = "Leave a comment… (Cmd/Ctrl+Enter to submit)";
  ta.rows = 4;
  setTimeout(() => ta.focus(), 0);
  const actions = document.createElement("div");
  actions.className = "composer-actions";
  const submit = document.createElement("button");
  submit.textContent = "Comment";
  submit.disabled = true;
  ta.addEventListener("input", () => {
    submit.disabled = ta.value.trim().length === 0;
    autoresize(ta);
  });
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !submit.disabled) {
      submit.click();
    } else if (e.key === "Escape") {
      cancel.click();
    }
  });
  submit.addEventListener("click", () => {
    const body = ta.value.trim();
    if (!body) return;
    vscode.postMessage({
      type: "add-comment",
      selStart: sel.proseStart,
      selEnd: sel.proseEnd,
      body,
    });
    dom.composer.hidden = true;
    pendingSelection = null;
    dom.floating.hidden = true;
    window.getSelection()?.removeAllRanges();
  });
  const cancel = document.createElement("button");
  cancel.className = "btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    dom.composer.hidden = true;
  });
  actions.append(submit, cancel);
  dom.composer.append(header, ta, actions);
}

document.addEventListener("selectionchange", () => positionFloatingButton());
window.addEventListener("scroll", () => positionFloatingButton(), true);

document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "c" && pendingSelection && document.activeElement?.tagName !== "TEXTAREA") {
    e.preventDefault();
    openComposer(pendingSelection);
  }
});

dom.filterRadios.forEach((r) =>
  r.addEventListener("change", () => {
    filter = (r.value as typeof filter);
    if (currentState) render(currentState);
  }),
);

window.addEventListener("message", (ev) => {
  const msg = ev.data as InitMsg | UpdateMsg;
  if (!msg) return;
  if (msg.type === "init") {
    dom.fileName.textContent = msg.fileName;
    user = msg.user;
    render(msg.state);
  } else if (msg.type === "update") {
    render(msg.state);
  }
});

void user; // silence unused for now; will use when threading authorship UI hints

vscode.postMessage({ type: "ready" });
