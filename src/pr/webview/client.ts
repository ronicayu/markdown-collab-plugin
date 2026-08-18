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

import { createMarkdownRenderer, ensurePlantuml } from "../../webviewShared/markdownPipeline";
import { slugifyHeading } from "../../inlineComments/linkParse";
import { buildComposer, buildCommentBody, buildCommentCard, type ComposerHandle } from "../../webviewShared/commentUi";
import { resolveImageSrc, type ImageBaseUris } from "../../webviewShared/imageSrc";

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
  imageBaseUris: ImageBaseUris;
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

const md = createMarkdownRenderer();
function ensurePlantumlInstalled(opts: { serverUrl: string; format: "svg" | "png" } | undefined): void {
  ensurePlantuml(md, opts);
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
  existingFilter: document.getElementById("existing-filter") as HTMLElement,
  existingStatus: document.getElementById("existing-status") as HTMLElement,
  existingList: document.getElementById("existing-list") as HTMLElement,
};

let totalDraftCount = 0;
let existingComments: ExistingPrComment[] | null = null;

type ExistingFilter = "all" | "open" | "resolved";
/** Restored from webview state so the choice survives tab switches/reloads. */
let existingFilter: ExistingFilter = (() => {
  const saved = (vscode.getState() as { existingFilter?: unknown } | undefined)?.existingFilter;
  return saved === "open" || saved === "resolved" ? saved : "all";
})();

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
    renderCommentMarkers();
  } else if (msg.type === "drafts") {
    drafts = msg.drafts;
    totalDraftCount = msg.totalDraftCount;
    renderDrafts();
    refreshSubmitButton();
    renderCommentMarkers();
  } else if (msg.type === "existing-comments") {
    existingComments = msg.comments;
    renderExisting();
    renderCommentMarkers();
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
  annotateLineNumbers();
  void runMermaid();
}

/**
 * Tag each top-level rendered block with the 1-based source line it starts
 * on (`data-src-line`), shown as a gutter number by CSS. The line comes
 * from the first `[data-mc-src]` span inside the block, so blocks with no
 * annotated text (mermaid diagrams, bare images, hr) get no number.
 */
function annotateLineNumbers(): void {
  for (const block of Array.from(dom.preview.children)) {
    if (!(block instanceof HTMLElement)) continue;
    const src = block.dataset.mcSrc
      ? block
      : block.querySelector<HTMLElement>("[data-mc-src]");
    const m = /^(\d+)\.(\d+)$/.exec(src?.dataset.mcSrc ?? "");
    if (!m) continue;
    const line = String(lineFromOffset(Number(m[1])));
    if (block.tagName === "PRE") {
      // `pre` scrolls horizontally (overflow-x), which clips the gutter
      // pseudo-element — hang the number on a plain wrapper instead.
      const wrap = document.createElement("div");
      block.replaceWith(wrap);
      wrap.appendChild(block);
      wrap.dataset.srcLine = line;
    } else {
      block.dataset.srcLine = line;
    }
  }
}

function rewriteImageSrcs(): void {
  if (!state) return;
  const base = state.imageBaseUris;
  for (const img of dom.preview.querySelectorAll<HTMLImageElement>("img")) {
    const src = img.getAttribute("src") || "";
    if (src.startsWith("#")) continue;
    // Same resolver as the inline view and the live editor. This used to be a
    // hand-rolled string join here, which is the code the `..`-climbing fix in
    // 0.34.31 replaced everywhere else — so `../diagrams/x.png` resolved to
    // `<docDir>/diagrams/x.png` and 404'd in the PR view only.
    const resolved = resolveImageSrc(src, base);
    if (resolved !== src) img.src = resolved;
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
 * Rendered block covering a 1-based source line. Prefers the most specific
 * block that contains the line; falls back to the nearest block starting at
 * or before it.
 */
function blockForLine(line: number): HTMLElement | null {
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
  return containing ?? before;
}

/**
 * Scroll the preview pane to the rendered block covering a 1-based source
 * line and flash it. Used by the draft / existing-comment line buttons so a
 * click lands inside the review preview rather than popping the raw text
 * editor.
 */
function scrollPreviewToLine(line: number): void {
  const target = blockForLine(line);
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

// --- comment line markers -------------------------------------------------

/** One thing a preview marker points at: a draft card or an existing thread. */
interface MarkerTarget { kind: "draft" | "existing"; key: string; resolved: boolean; }

/**
 * Hang a clickable 💬 chip on every rendered block whose source lines carry
 * a draft or an existing PR thread. Clicking scrolls the right pane to the
 * matching card(s) — the reverse of the cards' "Line N" jump buttons.
 * Idempotent: clears previous markers, so it re-runs on every drafts /
 * existing-comments update.
 */
function renderCommentMarkers(): void {
  for (const m of dom.preview.querySelectorAll(".pr-comment-marker")) m.remove();
  for (const el of dom.preview.querySelectorAll(".has-comment-marker")) el.classList.remove("has-comment-marker");

  const byBlock = new Map<HTMLElement, MarkerTarget[]>();
  const add = (line: number, t: MarkerTarget): void => {
    let block = blockForLine(line);
    if (!block) return;
    if (block.tagName === "PRE" && block.parentElement && block.parentElement !== dom.preview) {
      // `pre` scrolls horizontally (overflow-x), which would clip the
      // absolutely-positioned chip — hang it on the wrapper instead.
      block = block.parentElement;
    }
    const list = byBlock.get(block) ?? [];
    list.push(t);
    byBlock.set(block, list);
  };

  for (const d of drafts) add(d.startLine ?? d.line, { kind: "draft", key: d.id, resolved: false });
  if (existingComments) {
    // First comment per thread carries the anchor line and resolved state.
    const heads = new Map<string, ExistingPrComment>();
    for (const c of existingComments) {
      const key = c.threadId ?? c.id;
      const prev = heads.get(key);
      if (!prev || Date.parse(c.createdAt) < Date.parse(prev.createdAt)) heads.set(key, c);
    }
    for (const [key, head] of heads) {
      add(head.line, { kind: "existing", key, resolved: head.resolved === true });
    }
  }

  for (const [block, targets] of byBlock) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pr-comment-marker";
    if (targets.every((t) => t.resolved)) btn.classList.add("resolved");
    btn.textContent = targets.length === 1 ? "💬" : `💬 ${targets.length}`;
    btn.title = markerTitle(targets);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      revealComments(targets);
    });
    block.classList.add("has-comment-marker");
    block.appendChild(btn);
  }
}

function markerTitle(targets: MarkerTarget[]): string {
  const threads = targets.filter((t) => t.kind === "existing").length;
  const draftCount = targets.length - threads;
  const parts: string[] = [];
  if (threads) parts.push(`${threads} comment thread${threads === 1 ? "" : "s"}`);
  if (draftCount) parts.push(`${draftCount} draft${draftCount === 1 ? "" : "s"}`);
  return `${parts.join(" · ")} — click to show`;
}

/** Scroll the right pane to a marker's card(s) and flash them. */
function revealComments(targets: MarkerTarget[]): void {
  // A targeted thread may be hidden by the open/resolved filter — widen to
  // "all" so every target has a card on screen.
  const hidden = targets.some((t) =>
    t.kind === "existing" &&
    (existingFilter === "open" ? t.resolved : existingFilter === "resolved" && !t.resolved),
  );
  if (hidden) {
    existingFilter = "all";
    const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
    vscode.setState({ ...prev, existingFilter });
    renderExisting();
  }
  const cards: HTMLElement[] = [];
  for (const t of targets) {
    const sel = t.kind === "draft"
      ? `[data-draft-id="${CSS.escape(t.key)}"]`
      : `[data-thread-id="${CSS.escape(t.key)}"]`;
    const card = (t.kind === "draft" ? dom.draftsList : dom.existingList).querySelector<HTMLElement>(sel);
    if (card) cards.push(card);
  }
  if (cards.length === 0) return;
  cards[0].scrollIntoView({ behavior: "smooth", block: "center" });
  for (const card of cards) flashCard(card);
}

function flashCard(el: HTMLElement): void {
  el.classList.remove("card-jump-flash");
  // Force reflow so re-adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add("card-jump-flash");
  window.setTimeout(() => el.classList.remove("card-jump-flash"), 1500);
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

// Links inside comment cards. Nothing routed these before, because comment
// bodies were plain text and had no links to route; now that they render as
// markdown, a bare `<a>` in a webview would simply do nothing when clicked.
document.addEventListener("click", (e) => {
  const anchor = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!anchor || dom.preview.contains(anchor)) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!href || href.startsWith("#")) return;
  e.preventDefault();
  window.open(href, "_blank");
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
    const editCard = buildCommentCard({ author: "Your draft", bodyEl: composer.el });
    editCard.dataset.draftId = d.id;
    return editCard;
  }

  const card = buildCommentCard({
    author: "Your draft",
    bodyEl: buildCommentBody(d.body),
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
  card.dataset.draftId = d.id;
  return card;
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
    dom.existingFilter.hidden = true;
    dom.existingStatus.textContent = "Loading existing comments…";
    dom.existingStatus.hidden = false;
    dom.existingList.innerHTML = "";
    return;
  }
  if (existingComments.length === 0) {
    dom.existingFilter.hidden = true;
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

  // A thread is resolved when its head comment is — GitLab sets it per note,
  // GitHub per review thread; both surface on the head. Only offer the filter
  // when it can change anything (some resolved data exists).
  const resolvedCount = threads.filter((t) => t[0].resolved === true).length;
  renderExistingFilterChips(threads.length, resolvedCount);
  const filtered = threads.filter((t) => {
    if (existingFilter === "open") return t[0].resolved !== true;
    if (existingFilter === "resolved") return t[0].resolved === true;
    return true;
  });
  if (filtered.length === 0) {
    dom.existingStatus.textContent = existingFilter === "open"
      ? "No open comments on this file."
      : "No resolved comments on this file.";
    dom.existingStatus.hidden = false;
    return;
  }
  for (const thread of filtered) {
    dom.existingList.appendChild(renderExistingThread(thread));
  }
}

function renderExistingFilterChips(total: number, resolved: number): void {
  if (resolved === 0) {
    // Nothing to filter — every thread is open (or the platform gave no
    // resolved data). Fall back to showing everything.
    dom.existingFilter.hidden = true;
    existingFilter = "all";
    return;
  }
  dom.existingFilter.hidden = false;
  dom.existingFilter.innerHTML = "";
  const chips: { key: ExistingFilter; label: string }[] = [
    { key: "all", label: `All ${total}` },
    { key: "open", label: `Open ${total - resolved}` },
    { key: "resolved", label: `Resolved ${resolved}` },
  ];
  for (const chip of chips) {
    const btn = document.createElement("button");
    btn.className = "filter-chip";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(existingFilter === chip.key));
    if (existingFilter === chip.key) btn.classList.add("active");
    btn.textContent = chip.label;
    btn.addEventListener("click", () => {
      if (existingFilter === chip.key) return;
      existingFilter = chip.key;
      const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
      vscode.setState({ ...prev, existingFilter });
      renderExisting();
    });
    dom.existingFilter.appendChild(btn);
  }
}

function renderExistingThread(thread: ExistingPrComment[]): HTMLElement {
  const head = thread[0];
  const card = document.createElement("section");
  card.className = "existing-card";
  card.dataset.threadId = head.threadId ?? head.id;
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
    bodyEl: buildCommentBody(c.body),
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

