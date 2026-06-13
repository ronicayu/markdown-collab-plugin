/**
 * PR review preview webview client.
 *
 * Renders the source markdown to HTML using the same source-offset
 * plugin the inline-comments view uses, then walks every element
 * carrying a `data-mc-src="START.END"` attribute and adds a left side
 * stripe to those whose source byte range overlaps any added-line
 * range from the PR diff.
 *
 * Selection inside the preview pops a "+ Comment on selection" button.
 * Clicking it opens a composer in the right pane; submit dispatches an
 * `add-draft` message with the selection's source line range. Drafts
 * are rendered as cards in the right pane; each card jumps to its line
 * in the editor when clicked.
 */

import MarkdownIt from "markdown-it";
import { installSourceOffsetPlugin } from "../../inlineComments/webview/renderWithOffsets";
import { slugifyHeading } from "../../inlineComments/linkParse";
import { buildComposer, buildCommentCard, type ComposerHandle } from "../../webviewShared/commentUi";
import { installPlantumlPlugin } from "../../plantumlPlugin";

interface VsCodeApi {
  postMessage(msg: ClientToHost): void;
  getState(): unknown;
  setState(s: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi(): VsCodeApi;
    mermaid?: {
      initialize(opts: Record<string, unknown>): void;
      run(opts?: { querySelector?: string }): Promise<void>;
    };
  }
}

interface LineRange { start: number; end: number; }
interface PrDraft {
  id: string;
  path: string;
  body: string;
  line: number;
  startLine?: number;
  side: "RIGHT";
  createdAt: string;
}

interface InitMessage {
  type: "init";
  fileName: string;
  source: string;
  addedRanges: LineRange[];
  drafts: PrDraft[];
  totalDraftCount: number;
  imageBaseUris: { docDir: string; workspaceFolder: string | null };
  plantuml?: { serverUrl: string; format: "svg" | "png" };
}
interface DraftsMessage { type: "drafts"; drafts: PrDraft[]; totalDraftCount: number; }
interface ExistingPrComment {
  id: string;
  threadId?: string;
  author: string;
  body: string;
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  createdAt: string;
  url: string;
  resolved?: boolean;
}
interface ExistingMessage { type: "existing-comments"; comments: ExistingPrComment[]; }
interface ReplyErrorMessage { type: "reply-error"; threadId: string; error: string; }
type HostMessage = InitMessage | DraftsMessage | ExistingMessage | ReplyErrorMessage;

interface ReadyMessage { type: "ready"; }
interface AddDraftRequest { type: "add-draft"; startLine: number; endLine: number; body: string; }
interface EditDraftRequest { type: "edit-draft"; id: string; body: string; }
interface DeleteDraftRequest { type: "delete-draft"; id: string; }
type ReviewVerdict = "comment" | "approve" | "request-changes";
interface SubmitRequest { type: "submit"; verdict: ReviewVerdict; body?: string; }
interface ReplyRequest { type: "reply"; threadId: string; body: string; }
type ClientToHost = ReadyMessage | AddDraftRequest | EditDraftRequest | DeleteDraftRequest | SubmitRequest | ReplyRequest;

const vscode = window.acquireVsCodeApi();

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
installSourceOffsetPlugin(md);
let plantumlInstalled = false;
function ensurePlantumlInstalled(opts: { serverUrl: string; format: "svg" | "png" } | undefined): void {
  if (plantumlInstalled || !opts) return;
  installPlantumlPlugin(md, opts);
  plantumlInstalled = true;
}

const dom = {
  fileName: document.getElementById("file-name") as HTMLElement,
  preview: document.getElementById("preview") as HTMLElement,
  floating: document.getElementById("floating-add") as HTMLButtonElement,
  draftCount: document.getElementById("draft-count") as HTMLElement,
  draftsList: document.getElementById("drafts-list") as HTMLElement,
  composer: document.getElementById("composer") as HTMLElement,
  submitButton: document.getElementById("submit-review") as HTMLButtonElement,
  submitHint: document.getElementById("submit-hint") as HTMLElement,
  verdictRadios: document.querySelectorAll<HTMLInputElement>('input[name="verdict"]'),
  reviewBody: document.getElementById("review-body") as HTMLTextAreaElement,
  existingSection: document.getElementById("existing-section") as HTMLElement,
  existingStatus: document.getElementById("existing-status") as HTMLElement,
  existingList: document.getElementById("existing-list") as HTMLElement,
};

let totalDraftCount = 0;
let existingComments: ExistingPrComment[] | null = null;

let state: InitMessage | null = null;
let editingDraftId: string | null = null;
/** Source line-start offsets for the loaded file. lineStarts[i] = byte offset of line i+1 start. */
let lineStarts: number[] = [];
/** Cached drafts (rendered from `state` or from `drafts` updates). */
let drafts: PrDraft[] = [];

interface PendingSelection { startLine: number; endLine: number; quote: string; }
let pendingSelection: PendingSelection | null = null;

window.addEventListener("message", (ev) => {
  const msg = ev.data as HostMessage;
  if (msg.type === "init") {
    state = msg;
    drafts = msg.drafts;
    totalDraftCount = msg.totalDraftCount;
    existingComments = null;
    lineStarts = computeLineStarts(msg.source);
    dom.fileName.textContent = msg.fileName;
    ensurePlantumlInstalled(msg.plantuml);
    renderPreview(msg.source, msg.addedRanges);
    renderDrafts();
    renderExisting();
    refreshSubmitButton();
  } else if (msg.type === "drafts") {
    drafts = msg.drafts;
    totalDraftCount = msg.totalDraftCount;
    renderDrafts();
    refreshSubmitButton();
  } else if (msg.type === "existing-comments") {
    existingComments = msg.comments;
    renderExisting();
  } else if (msg.type === "reply-error") {
    failPendingReply(msg.threadId, msg.error);
  }
});

dom.submitButton.addEventListener("click", () => {
  if (totalDraftCount === 0) return;
  vscode.postMessage({ type: "submit", verdict: currentVerdict(), body: dom.reviewBody.value.trim() || undefined });
});

function currentVerdict(): ReviewVerdict {
  for (const r of dom.verdictRadios) if (r.checked) return r.value as ReviewVerdict;
  return "comment";
}

function refreshSubmitButton(): void {
  if (totalDraftCount === 0) {
    dom.submitButton.disabled = true;
    dom.submitButton.textContent = "Submit review";
    dom.submitHint.textContent = "No drafts yet.";
  } else {
    dom.submitButton.disabled = false;
    dom.submitButton.textContent = `Submit review (${totalDraftCount})`;
    const localCount = drafts.length;
    const elsewhere = totalDraftCount - localCount;
    dom.submitHint.textContent = elsewhere > 0
      ? `${localCount} on this file · ${elsewhere} on other files`
      : `${localCount} draft${localCount === 1 ? "" : "s"} ready to submit`;
  }
}

vscode.postMessage({ type: "ready" });

function computeLineStarts(src: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") out.push(i + 1);
  }
  out.push(src.length);
  return out;
}

/** Convert a 0-based byte offset into a 1-based line number. */
function lineFromOffset(off: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function rangeOverlapsAdded(startLine: number, endLine: number, added: LineRange[]): boolean {
  for (const r of added) {
    if (endLine >= r.start && startLine <= r.end) return true;
  }
  return false;
}

function renderPreview(source: string, addedRanges: LineRange[]): void {
  dom.preview.innerHTML = md.render(source);
  rewriteImageSrcs();
  paintDiffStripes(addedRanges);
  void runMermaid();
}

function rewriteImageSrcs(): void {
  if (!state) return;
  const base = state.imageBaseUris;
  for (const img of dom.preview.querySelectorAll<HTMLImageElement>("img")) {
    const src = img.getAttribute("src") || "";
    if (/^(https?:|data:|vscode-webview)/.test(src)) continue;
    if (src.startsWith("/") && base.workspaceFolder) {
      img.src = `${base.workspaceFolder}${src}`;
    } else if (!src.startsWith("#")) {
      img.src = `${base.docDir}/${src.replace(/^\.\//, "")}`;
    }
  }
}

/**
 * Walk every `[data-mc-src]` span in the preview. For each, decode its
 * source-byte range, map to source lines, and add the diff stripe class
 * to the nearest "block-ish" ancestor if any of those lines is part of
 * an added-line range. We also stripe block-level images, links whose
 * URL changed even when text didn't, etc — anything markdown-it tagged.
 */
function paintDiffStripes(addedRanges: LineRange[]): void {
  if (addedRanges.length === 0) return;
  const seenBlocks = new WeakSet<Element>();
  for (const el of dom.preview.querySelectorAll<HTMLElement>("[data-mc-src]")) {
    const m = /^(\d+)\.(\d+)$/.exec(el.dataset.mcSrc || "");
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const startLine = lineFromOffset(start);
    const endLine = lineFromOffset(Math.max(start, end - 1));
    if (!rangeOverlapsAdded(startLine, endLine, addedRanges)) continue;
    const block = nearestBlock(el);
    if (!block || seenBlocks.has(block)) continue;
    seenBlocks.add(block);
    block.classList.add("pr-changed");
    block.dataset.prLine = String(startLine);
  }
}

const BLOCK_TAGS = new Set(["P", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "TABLE", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DIV", "FIGURE", "IMG"]);

function nearestBlock(start: Element): HTMLElement | null {
  let cur: Element | null = start;
  while (cur && cur !== dom.preview) {
    if (BLOCK_TAGS.has(cur.tagName)) return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Scroll the preview pane to the rendered block covering a 1-based source
 * line and flash it. Used by the draft / existing-comment line buttons so a
 * click lands inside the review preview rather than popping the raw text
 * editor. Prefers the most specific block that contains the line; falls back
 * to the nearest block starting at or before it.
 */
function scrollPreviewToLine(line: number): void {
  let containing: HTMLElement | null = null;
  let containingStart = -1;
  let before: HTMLElement | null = null;
  let beforeStart = -1;
  for (const el of dom.preview.querySelectorAll<HTMLElement>("[data-mc-src]")) {
    const m = /^(\d+)\.(\d+)$/.exec(el.dataset.mcSrc || "");
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const startLine = lineFromOffset(start);
    const endLine = lineFromOffset(Math.max(start, end - 1));
    const block = nearestBlock(el);
    if (!block) continue;
    if (startLine <= line && line <= endLine && startLine > containingStart) {
      containing = block;
      containingStart = startLine;
    }
    if (startLine <= line && startLine > beforeStart) {
      before = block;
      beforeStart = startLine;
    }
  }
  const target = containing ?? before;
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  flashBlock(target);
}

let flashTimer: number | undefined;
function flashBlock(el: HTMLElement): void {
  for (const prev of dom.preview.querySelectorAll(".pr-jump-flash")) {
    prev.classList.remove("pr-jump-flash");
  }
  // Force reflow so re-adding the class restarts the animation when the same
  // line button is clicked twice in a row.
  void el.offsetWidth;
  el.classList.add("pr-jump-flash");
  if (flashTimer !== undefined) clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => el.classList.remove("pr-jump-flash"), 1500);
}

let mermaidInitialized = false;
async function runMermaid(): Promise<void> {
  const m = window.mermaid;
  if (!m) return;
  if (!mermaidInitialized) {
    const isDark = document.body.classList.contains("vscode-dark") || window.matchMedia("(prefers-color-scheme: dark)").matches;
    try {
      m.initialize({ startOnLoad: false, theme: isDark ? "dark" : "default", securityLevel: "strict" });
      mermaidInitialized = true;
    } catch { /* ignore */ }
  }
  try { await m.run({ querySelector: "pre.mermaid" }); } catch { /* ignore */ }
}

// --- selection / composer -------------------------------------------------

document.addEventListener("selectionchange", () => positionFloatingButton());
dom.preview.addEventListener("scroll", () => positionFloatingButton());
window.addEventListener("resize", () => positionFloatingButton());

// In-doc fragment links (e.g. `[Setup](#setup)`) scroll the preview to the
// matching heading. Non-fragment links keep their default behavior.
dom.preview.addEventListener("click", (e) => {
  const anchor = e.target instanceof Element ? e.target.closest("a") : null;
  const href = anchor?.getAttribute("href");
  if (!href || !href.startsWith("#")) return;
  e.preventDefault();
  scrollPreviewToFragment(href.slice(1));
});

/** Scroll the preview to a heading matching `fragment` (by id, else by slug). */
function scrollPreviewToFragment(fragment: string): void {
  if (!fragment) return;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* malformed escape — match the raw form */
  }
  const byId = dom.preview.querySelector<HTMLElement>(`[id="${CSS.escape(decoded)}"]`);
  if (byId) {
    byId.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  for (const h of dom.preview.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6")) {
    if (slugifyHeading(h.textContent || "") === decoded) {
      h.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}

function positionFloatingButton(): void {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    dom.floating.hidden = true;
    pendingSelection = null;
    return;
  }
  const range = sel.getRangeAt(0);
  if (!dom.preview.contains(range.commonAncestorContainer)) {
    dom.floating.hidden = true;
    return;
  }
  const startOffset = endpointToSourceOffset(range.startContainer, range.startOffset);
  const endOffset = endpointToSourceOffset(range.endContainer, range.endOffset);
  if (startOffset == null || endOffset == null) {
    dom.floating.hidden = true;
    pendingSelection = null;
    return;
  }
  const lo = Math.min(startOffset, endOffset);
  const hi = Math.max(startOffset, endOffset);
  pendingSelection = {
    startLine: lineFromOffset(lo),
    endLine: lineFromOffset(Math.max(lo, hi - 1)),
    quote: sel.toString().trim(),
  };
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    dom.floating.hidden = true;
    return;
  }
  // `position: fixed` (set in CSS) — viewport coords from
  // getBoundingClientRect are exactly what we want, no scroll math.
  dom.floating.style.top = `${rect.bottom + 4}px`;
  dom.floating.style.left = `${rect.left}px`;
  dom.floating.hidden = false;
}

function endpointToSourceOffset(node: Node, offset: number): number | null {
  // Walk up until we find a [data-mc-src] ancestor. Use its start offset
  // plus a rough count of preceding text chars within that ancestor.
  let cur: Node | null = node;
  while (cur && cur !== dom.preview) {
    if (cur.nodeType === 1) {
      const el = cur as HTMLElement;
      if (el.dataset.mcSrc) {
        const m = /^(\d+)\.(\d+)$/.exec(el.dataset.mcSrc);
        if (!m) return null;
        const start = Number(m[1]);
        const end = Number(m[2]);
        // Approximate: text nodes inside this span occupy a contiguous
        // range of source bytes between start and end. Pin to start +
        // chars consumed before the (node, offset) point, clamped to end.
        const prefix = textOffsetWithin(el, node, offset);
        return Math.min(end, start + prefix);
      }
    }
    cur = cur.parentNode;
  }
  return null;
}

function textOffsetWithin(root: Element, target: Node, targetOffset: number): number {
  let consumed = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n: Node | null = walker.currentNode;
  while (n) {
    if (n === target) {
      if (target.nodeType === 3) consumed += targetOffset;
      return consumed;
    }
    if (n.nodeType === 3) consumed += (n as Text).textContent?.length ?? 0;
    n = walker.nextNode();
  }
  return consumed;
}

dom.floating.addEventListener("click", () => {
  if (!pendingSelection) return;
  openComposer(pendingSelection);
});

function openComposer(sel: PendingSelection): void {
  editingDraftId = null;
  dom.composer.hidden = false;
  dom.composer.innerHTML = "";
  const composer = buildComposer({
    meta: sel.startLine === sel.endLine
      ? `Comment on line ${sel.startLine}`
      : `Comment on lines ${sel.startLine}–${sel.endLine}`,
    placeholder: "Your review comment (markdown supported by GitHub / GitLab)",
    submitLabel: "Add draft",
    rows: 4,
    onSubmit: (body) => {
      vscode.postMessage({ type: "add-draft", startLine: sel.startLine, endLine: sel.endLine, body });
      dom.composer.hidden = true;
      dom.floating.hidden = true;
      window.getSelection()?.removeAllRanges();
      pendingSelection = null;
    },
    onCancel: () => {
      dom.composer.hidden = true;
    },
  });
  dom.composer.appendChild(composer.el);
}

// --- drafts sidebar -------------------------------------------------------

function renderDrafts(): void {
  dom.draftsList.innerHTML = "";
  dom.draftCount.textContent = drafts.length === 0 ? "" : ` · ${drafts.length}`;
  if (drafts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No drafts yet for this file. Select prose in the preview to add one.";
    dom.draftsList.appendChild(empty);
    return;
  }
  // Sort by line ascending.
  const sorted = [...drafts].sort((a, b) => (a.startLine ?? a.line) - (b.startLine ?? b.line));
  for (const d of sorted) {
    dom.draftsList.appendChild(renderDraftCard(d));
  }
}

function renderDraftCard(d: PrDraft): HTMLElement {
  const lineLabel = d.startLine && d.startLine !== d.line
    ? `Lines ${d.startLine}–${d.line}`
    : `Line ${d.line}`;

  if (editingDraftId === d.id) {
    const composer = buildComposer({
      meta: lineLabel,
      initialValue: d.body,
      submitLabel: "Save",
      rows: Math.max(2, Math.min(8, d.body.split("\n").length)),
      onSubmit: (body) => {
        vscode.postMessage({ type: "edit-draft", id: d.id, body });
        editingDraftId = null;
      },
      onCancel: () => {
        editingDraftId = null;
        renderDrafts();
      },
    });
    return buildCommentCard({ author: "Your draft", bodyEl: composer.el });
  }

  const bodyEl = document.createElement("div");
  bodyEl.textContent = d.body;
  return buildCommentCard({
    author: "Your draft",
    bodyEl,
    actions: [
      {
        label: lineLabel,
        title: "Jump to this line in the preview",
        onClick: () => scrollPreviewToLine(d.startLine ?? d.line),
      },
      { label: "Edit", onClick: () => { editingDraftId = d.id; renderDrafts(); } },
      { label: "Delete", variant: "danger", onClick: () => vscode.postMessage({ type: "delete-draft", id: d.id }) },
    ],
  });
}

// --- existing comments (read-only) ----------------------------------------

/** Open reply composers, keyed by threadId, so a reply-error can re-enable them. */
const pendingReplies = new Map<string, ComposerHandle>();

function renderExisting(): void {
  // A fresh render replaces every thread card, so any in-flight composer DOM
  // is gone — drop the stale references.
  pendingReplies.clear();
  dom.existingSection.hidden = false;
  if (existingComments === null) {
    dom.existingStatus.textContent = "Loading existing comments…";
    dom.existingStatus.hidden = false;
    dom.existingList.innerHTML = "";
    return;
  }
  if (existingComments.length === 0) {
    dom.existingStatus.textContent = "No existing PR comments on this file.";
    dom.existingStatus.hidden = false;
    dom.existingList.innerHTML = "";
    return;
  }
  dom.existingStatus.hidden = true;
  dom.existingList.innerHTML = "";
  // Group by threadId so replies nest under their parent.
  const byThread = new Map<string, ExistingPrComment[]>();
  for (const c of existingComments) {
    const key = c.threadId ?? c.id;
    const list = byThread.get(key) ?? [];
    list.push(c);
    byThread.set(key, list);
  }
  const threads = Array.from(byThread.values())
    .map((list) => list.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)))
    .sort((a, b) => a[0].line - b[0].line);
  for (const thread of threads) {
    dom.existingList.appendChild(renderExistingThread(thread));
  }
}

function renderExistingThread(thread: ExistingPrComment[]): HTMLElement {
  const head = thread[0];
  const card = document.createElement("section");
  card.className = "existing-card";
  if (head.resolved) card.classList.add("resolved");

  const meta = document.createElement("header");
  meta.className = "existing-head";
  const lineBtn = document.createElement("button");
  lineBtn.className = "draft-line btn-link";
  lineBtn.textContent = `Line ${head.line}`;
  lineBtn.title = "Jump to this line in the preview";
  lineBtn.addEventListener("click", () => scrollPreviewToLine(head.line));
  meta.appendChild(lineBtn);
  if (head.resolved) {
    const tag = document.createElement("span");
    tag.className = "badge resolved";
    tag.textContent = "resolved";
    meta.appendChild(tag);
  }
  card.appendChild(meta);

  for (const c of thread) {
    card.appendChild(renderExistingComment(c, c === head));
  }
  card.appendChild(renderReplyArea(head.threadId ?? head.id));
  return card;
}

/**
 * Reply affordance for an existing thread. Shows a "Reply" link that swaps to
 * a composer; submitting posts a `reply` to the host, which posts it to the
 * platform and pushes refreshed comments (re-rendering this thread with the
 * new reply nested). A `reply-error` re-enables the composer in place.
 */
function renderReplyArea(threadId: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "existing-reply";

  const showButton = (): void => {
    wrap.innerHTML = "";
    const openBtn = document.createElement("button");
    openBtn.className = "mc-btn mc-btn--link";
    openBtn.textContent = "Reply";
    openBtn.addEventListener("click", showComposer);
    wrap.appendChild(openBtn);
  };

  const showComposer = (): void => {
    wrap.innerHTML = "";
    const composer = buildComposer({
      placeholder: "Reply… (markdown supported by GitHub / GitLab)",
      submitLabel: "Reply",
      rows: 3,
      onSubmit: (body) => {
        composer.setBusy("Posting…");
        pendingReplies.set(threadId, composer);
        vscode.postMessage({ type: "reply", threadId, body });
      },
      onCancel: () => {
        pendingReplies.delete(threadId);
        showButton();
      },
    });
    wrap.appendChild(composer.el);
  };

  showButton();
  return wrap;
}

/** A reply POST failed — re-enable the composer and show the error inline. */
function failPendingReply(threadId: string, error: string): void {
  pendingReplies.get(threadId)?.setError(error);
}

function renderExistingComment(c: ExistingPrComment, isHead: boolean): HTMLElement {
  return buildCommentCard({
    author: c.author,
    timestamp: c.createdAt,
    body: c.body,
    reply: !isHead,
    actions: [
      {
        label: "↗ Open",
        title: "Open this comment on the platform",
        onClick: () => window.open(c.url, "_blank"),
      },
    ],
  });
}

