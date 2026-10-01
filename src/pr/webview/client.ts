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
 *
 * The sidebar (`#drafts-pane`) uses the same ids, class names, and
 * stylesheets (threadSidebar.css, controls.css, comments.css) as the live
 * editor's comment sidebar (docs/pr-review-redesign.md) — the two can't
 * drift apart again.
 */

import "../../webviewShared/threadSidebar.css";
import "../../webviewShared/controls.css";
import "./client.css";
import { createMarkdownRenderer, ensurePlantuml } from "../../webviewShared/markdownPipeline";
import { slugifyHeading } from "../../inlineComments/linkParse";
import {
  buildComposer,
  buildCommentBody,
  buildCommentCard,
  buildCollapseToggle,
  type ComposerHandle,
} from "../../webviewShared/commentUi";
import { resolveImageSrc, type ImageBaseUris } from "../../webviewShared/imageSrc";
import { createDiffNav, isNavKeyContext } from "../../webviewShared/diffNav";
import { smoothScrollIntoView } from "../../webviewShared/scrollIntoView";
import { nextCollapseAllAction } from "../../webviewShared/threadListState";
import { createMenuController } from "../../webviewShared/menu";

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
  /** Whether this thread can be resolved at all — gates the Resolve/Unresolve button. */
  resolvable?: boolean;
  /** Id to send back in a `resolve-thread` message. Present only when `resolvable`. */
  resolveId?: string;
}
interface ExistingMessage { type: "existing-comments"; comments: ExistingPrComment[]; }
interface ReplyErrorMessage { type: "reply-error"; threadId: string; error: string; }
interface ResolveThreadErrorMessage { type: "resolve-thread-error"; resolveId: string; error: string; }
type HostMessage = InitMessage | DraftsMessage | ExistingMessage | ReplyErrorMessage | ResolveThreadErrorMessage;

interface ReadyMessage { type: "ready"; }
interface AddDraftRequest { type: "add-draft"; startLine: number; endLine: number; body: string; }
interface EditDraftRequest { type: "edit-draft"; id: string; body: string; }
interface DeleteDraftRequest { type: "delete-draft"; id: string; }
type ReviewVerdict = "comment" | "approve" | "request-changes";
interface SubmitRequest { type: "submit"; verdict: ReviewVerdict; body?: string; }
interface ReplyRequest { type: "reply"; threadId: string; body: string; }
interface ResolveThreadRequest { type: "resolve-thread"; resolveId: string; resolved: boolean; }
type ClientToHost =
  | ReadyMessage
  | AddDraftRequest
  | EditDraftRequest
  | DeleteDraftRequest
  | SubmitRequest
  | ReplyRequest
  | ResolveThreadRequest;

const vscode = window.acquireVsCodeApi();

const md = createMarkdownRenderer();
function ensurePlantumlInstalled(opts: { serverUrl: string; format: "svg" | "png" } | undefined): void {
  ensurePlantuml(md, opts);
}

const dom = {
  app: document.getElementById("app") as HTMLElement,
  preview: document.getElementById("preview") as HTMLElement,
  diffNav: document.getElementById("diff-nav") as HTMLElement,
  diffPrev: document.getElementById("diff-prev") as HTMLButtonElement,
  diffNext: document.getElementById("diff-next") as HTMLButtonElement,
  diffNavCount: document.getElementById("diff-nav-count") as HTMLElement,
  commentsToggle: document.getElementById("comments-toggle") as HTMLButtonElement,
  floating: document.getElementById("floating-add") as HTMLButtonElement,
  addCommentBtn: document.getElementById("add-comment-btn") as HTMLButtonElement,
  overflowMenuBtn: document.getElementById("overflow-menu-btn") as HTMLButtonElement,
  overflowMenu: document.getElementById("overflow-menu") as HTMLElement,
  collapseAllBtn: document.getElementById("collapse-all-btn") as HTMLButtonElement,
  existingFilterRow: document.getElementById("existing-filter") as HTMLElement,
  existingFilterRadios: document.querySelectorAll<HTMLInputElement>('input[name="existing-filter"]'),
  filterCountOpen: document.getElementById("existing-filter-count-open") as HTMLElement,
  filterCountAll: document.getElementById("existing-filter-count-all") as HTMLElement,
  filterCountResolved: document.getElementById("existing-filter-count-resolved") as HTMLElement,
  composer: document.getElementById("composer") as HTMLElement,
  draftsList: document.getElementById("drafts-list") as HTMLElement,
  existingStatus: document.getElementById("existing-status") as HTMLElement,
  existingList: document.getElementById("existing-list") as HTMLElement,
  submitBar: document.getElementById("submit-bar") as HTMLElement,
  submitButton: document.getElementById("submit-review") as HTMLButtonElement,
  submitHint: document.getElementById("submit-hint") as HTMLElement,
  verdictRadios: document.querySelectorAll<HTMLInputElement>('input[name="verdict"]'),
  summaryToggle: document.getElementById("summary-toggle") as HTMLButtonElement,
  reviewBody: document.getElementById("review-body") as HTMLTextAreaElement,
};

/** One trigger/panel pair at a time — here, just the header's "…" menu. */
const menu = createMenuController();

let totalDraftCount = 0;
let existingComments: ExistingPrComment[] | null = null;

/**
 * `vscode.getState()`'s blob round-trips through `history.state` across
 * reloads — a stale extension version, a corrupted profile, or a future
 * field this build doesn't know about can hand back something that isn't an
 * object at all (or throw outright). Every reader goes through here so a bad
 * blob degrades to "nothing was saved" instead of throwing at module load
 * and blanking the whole webview before a single message is handled.
 */
function safeGetState(): Record<string, unknown> {
  try {
    const s = vscode.getState();
    return s !== null && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type ExistingFilter = "open" | "all" | "resolved";
/** Restored from webview state so the choice survives tab switches/reloads. Default "open" (round-4). */
let existingFilter: ExistingFilter = (() => {
  const saved = safeGetState().existingFilter;
  return saved === "open" || saved === "all" || saved === "resolved" ? saved : "open";
})();

// --- collapse / expand state -----------------------------------------------
//
// One Set covers every collapsible card — a user's own draft and an existing
// platform thread alike (resolvable or not, GitHub or GitLab) — keyed by a
// prefixed id so the two card kinds can never collide. Absence from the set
// means expanded, which is already the right default for a draft and for an
// open thread; a resolved thread needs to start collapsed instead, which
// `applyThreadCollapseDefault` below handles by adding it to the set the
// first time it's seen. Persisted via vscode state so a toggle survives a
// re-render within the session (tab switch, a draft added elsewhere, a
// refreshed fetch) — but not across a full reload, same lifetime as
// `existingFilter` above.

const collapsedCards: Set<string> = (() => {
  const saved = safeGetState().collapsedCardIds;
  return new Set(Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : []);
})();

function persistCollapsedCards(): void {
  vscode.setState({ ...safeGetState(), collapsedCardIds: Array.from(collapsedCards) });
}

function draftKey(id: string): string {
  return `d:${id}`;
}
function threadKey(c: ExistingPrComment): string {
  return `t:${c.threadId ?? c.id}`;
}
/** The raw id a `reply` / `resolve-thread` message carries — not `threadKey`'s prefixed form. */
function rawThreadId(c: ExistingPrComment): string {
  return c.threadId ?? c.id;
}

/**
 * The resolved value each thread had the last time it was rendered, so a
 * fresh render can tell three cases apart: a thread never seen before
 * (apply the resolved → collapsed / open → expanded default), a resolved
 * ↔ open transition (re-apply that same default — collapsing on resolve,
 * expanding on unresolve — regardless of any earlier manual toggle, because
 * the (un)resolve action itself is the more recent explicit choice), and no
 * change at all (leave the set exactly as the user last left it, which is
 * what makes a manual toggle survive an unrelated re-render).
 */
const lastResolvedByThread = new Map<string, boolean>();
function applyThreadCollapseDefault(key: string, resolved: boolean): void {
  const prev = lastResolvedByThread.get(key);
  if (prev === undefined || prev !== resolved) {
    if (resolved) collapsedCards.add(key);
    else collapsedCards.delete(key);
  }
  lastResolvedByThread.set(key, resolved);
}

/**
 * A short one-line summary of a comment body, markdown stripped down to a
 * rough plain-text read and whitespace collapsed — used for a draft/thread
 * card's `aria-label` gist and the empty-state hint. No gist helper is
 * shared in webviewShared yet, so this is local to the PR view.
 */
function gistOf(body: string, max = 60): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trimEnd()}…`;
}

/** Existing comments grouped into threads, sorted the way the list displays them. */
function threadsFrom(comments: ExistingPrComment[]): ExistingPrComment[][] {
  const byThread = new Map<string, ExistingPrComment[]>();
  for (const c of comments) {
    const list = byThread.get(threadKey(c)) ?? [];
    list.push(c);
    byThread.set(threadKey(c), list);
  }
  return Array.from(byThread.values())
    .map((list) => list.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)))
    .sort((a, b) => a[0].line - b[0].line);
}

/** Every collapsible card's key currently on screen: drafts and existing threads alike. */
function allCardKeys(): string[] {
  const keys = drafts.map((d) => draftKey(d.id));
  if (existingComments) keys.push(...threadsFrom(existingComments).map((t) => threadKey(t[0])));
  return keys;
}

/** Sync the "…" menu's Collapse all / Expand all item to the current state. */
function updateCollapseAllButton(): void {
  const keys = allCardKeys();
  dom.collapseAllBtn.disabled = keys.length === 0;
  dom.collapseAllBtn.textContent =
    keys.length === 0 || nextCollapseAllAction(keys, collapsedCards) === "collapse" ? "Collapse all" : "Expand all";
}

dom.overflowMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menu.toggleMenuAt(dom.overflowMenuBtn, dom.overflowMenu);
});
dom.collapseAllBtn.addEventListener("click", () => {
  const keys = allCardKeys();
  if (keys.length > 0) {
    const action = nextCollapseAllAction(keys, collapsedCards);
    for (const key of keys) {
      if (action === "collapse") collapsedCards.add(key);
      else collapsedCards.delete(key);
    }
    persistCollapsedCards();
    renderDrafts();
    renderExisting();
  }
  menu.closeOpenMenu(false);
});

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
    // A draft appearing/disappearing can flip the big empty-state card and
    // the collapse-all availability, both of which the existing-comments
    // render also owns — cheap to recompute from the cached comments.
    renderExisting();
    refreshSubmitButton();
    renderCommentMarkers();
  } else if (msg.type === "existing-comments") {
    existingComments = msg.comments;
    renderExisting();
    renderCommentMarkers();
  } else if (msg.type === "reply-error") {
    failPendingReply(msg.threadId, msg.error);
  } else if (msg.type === "resolve-thread-error") {
    failPendingResolve(msg.resolveId, msg.error);
  }
});

// --- submit footer ----------------------------------------------------------

function currentVerdict(): ReviewVerdict {
  for (const r of dom.verdictRadios) if (r.checked) return r.value as ReviewVerdict;
  return "comment";
}

function updateVerdictSegments(): void {
  for (const r of dom.verdictRadios) r.closest("label")?.classList.toggle("active", r.checked);
}

function verdictLabel(verdict: ReviewVerdict, n: number): string {
  const what = n === 1 ? "1 comment" : `${n} comments`;
  if (verdict === "approve") return `Approve with ${what}`;
  if (verdict === "request-changes") return `Request changes with ${what}`;
  return `Submit ${what}`;
}

function refreshSubmitButton(): void {
  dom.submitBar.hidden = totalDraftCount === 0;
  if (totalDraftCount === 0) return;
  dom.submitButton.textContent = verdictLabel(currentVerdict(), totalDraftCount);
  const elsewhere = totalDraftCount - drafts.length;
  dom.submitHint.hidden = elsewhere <= 0;
  dom.submitHint.textContent = elsewhere > 0 ? `${drafts.length} on this file · ${elsewhere} on other files` : "";
}

for (const r of dom.verdictRadios) {
  r.addEventListener("change", () => {
    updateVerdictSegments();
    refreshSubmitButton();
  });
}
updateVerdictSegments();

dom.submitButton.addEventListener("click", () => {
  if (totalDraftCount === 0) return;
  vscode.postMessage({ type: "submit", verdict: currentVerdict(), body: dom.reviewBody.value.trim() || undefined });
});

// "Add summary" reveals and focuses the textarea and hides itself; emptying
// and blurring the textarea collapses it back — so a non-empty summary is
// never hidden out from under the reviewer.
dom.summaryToggle.addEventListener("click", () => {
  dom.summaryToggle.hidden = true;
  dom.reviewBody.hidden = false;
  dom.reviewBody.focus();
});
dom.reviewBody.addEventListener("blur", () => {
  if (dom.reviewBody.value.trim().length === 0) {
    dom.reviewBody.hidden = true;
    dom.summaryToggle.hidden = false;
  }
});

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
  if (addedRanges.length === 0) {
    diffNav.setStops([]);
    return;
  }
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
  diffNav.setStops(Array.from(dom.preview.querySelectorAll<HTMLElement>(".pr-changed")));
}

const diffNav = createDiffNav({
  container: dom.diffNav,
  prev: dom.diffPrev,
  next: dom.diffNext,
  count: dom.diffNavCount,
  currentClass: "pr-diff-current",
});

// n/p step through the PR's changed blocks, GitHub-style — never while the
// user is typing in the composer or review-summary box.
document.addEventListener("keydown", (e) => {
  if (dom.diffNav.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!isNavKeyContext(e.target)) return;
  if (e.key === "n") diffNav.step(1);
  else if (e.key === "p") diffNav.step(-1);
});

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
 * line and flash it. Used by the draft / existing-comment quote buttons so a
 * click lands inside the review preview rather than popping the raw text
 * editor.
 */
function scrollPreviewToLine(line: number): void {
  const target = blockForLine(line);
  if (!target) return;
  smoothScrollIntoView(target, "center");
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

/**
 * The text a card's `.thread-quote` button shows: the rendered preview
 * block's own text (what the reader actually sees, marker chip stripped),
 * falling back to the raw source line when the block can't be found (e.g. a
 * line inside a table row markdown-it didn't tag), falling back to a bare
 * "Line N" when even the source line is gone (a draft/thread anchored to a
 * line number the file no longer has).
 */
function quoteTextFor(line: number): string {
  const block = blockForLine(line);
  if (block) {
    const clone = block.cloneNode(true) as HTMLElement;
    for (const marker of clone.querySelectorAll(".pr-comment-marker")) marker.remove();
    const text = (clone.textContent ?? "").trim().replace(/\s+/g, " ");
    if (text) return text;
  }
  const raw = state?.source.split("\n")[line - 1]?.trim();
  if (raw) return raw;
  return `Line ${line}`;
}

/** `L3`, or `L3–5` for a range. */
function lineRangeLabel(startLine: number | undefined, endLine: number): string {
  return startLine !== undefined && startLine !== endLine ? `L${startLine}–${endLine}` : `L${endLine}`;
}

// --- comment line markers -------------------------------------------------

/** One thing a preview marker points at: a draft card or an existing thread. */
interface MarkerTarget { kind: "draft" | "existing"; key: string; resolved: boolean; }

/**
 * Hang a clickable 💬 chip on every rendered block whose source lines carry
 * a draft or an existing PR thread. Clicking scrolls the right pane to the
 * matching card(s) — the reverse of a card's own quote/jump button.
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
  // A marker clicked while the sidebar is hidden would scroll and flash a
  // card nobody can see — bring the sidebar back first.
  if (sidebarCollapsed) {
    sidebarCollapsed = false;
    syncSidebarCollapsedUi();
  }
  // A targeted thread may be hidden by the open/resolved filter — widen to
  // "all" so every target has a card on screen.
  const hidden = targets.some((t) =>
    t.kind === "existing" &&
    (existingFilter === "open" ? t.resolved : existingFilter === "resolved" && !t.resolved),
  );
  if (hidden) {
    existingFilter = "all";
    vscode.setState({ ...safeGetState(), existingFilter });
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
  smoothScrollIntoView(cards[0], "center");
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

// --- comments toggle / collapsed sidebar ------------------------------------
//
// Collapsing hides `#drafts-pane` (grid column 0) and puts the open-thread
// count on the toggle's badge, so the number is never lost just because the
// sidebar (and its own counts) hid — same contract as the live editor's
// comments toggle (src/webview/client.ts, syncCollapsedClass). Not persisted:
// the live editor doesn't persist its own collapsed flag either, so this
// mirrors that (both reset to expanded on reload).

let sidebarCollapsed = false;

function openExistingThreadCount(): number {
  if (!existingComments) return 0;
  return threadsFrom(existingComments).filter((t) => t[0].resolved !== true).length;
}

function syncSidebarCollapsedUi(): void {
  dom.app.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  const label = sidebarCollapsed ? "Show comments" : "Hide comments";
  dom.commentsToggle.title = label;
  dom.commentsToggle.setAttribute("aria-label", label);
  dom.commentsToggle.setAttribute("aria-pressed", String(!sidebarCollapsed));
  const badge = dom.commentsToggle.querySelector<HTMLElement>(".mc-badge");
  if (badge) {
    const openCount = openExistingThreadCount();
    const show = sidebarCollapsed && openCount > 0;
    badge.hidden = !show;
    badge.textContent = show ? String(openCount) : "";
  }
}

dom.commentsToggle.addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  syncSidebarCollapsedUi();
});

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
    smoothScrollIntoView(byId, "start");
    return;
  }
  for (const h of dom.preview.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6")) {
    if (slugifyHeading(h.textContent || "") === decoded) {
      smoothScrollIntoView(h, "start");
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

// The sidebar's own "+" — same action as the floating button. `mousedown`
// must preventDefault so the click doesn't collapse the preview's native
// text selection before the click handler runs (Chromium clears a selection
// on mousedown into any other element unless the default is prevented — the
// same reason the live editor's own "+" does this, src/webview/client.ts).
dom.addCommentBtn.addEventListener("mousedown", (e) => e.preventDefault());
dom.addCommentBtn.addEventListener("click", () => {
  if (pendingSelection) {
    openComposer(pendingSelection);
  } else {
    showToast("No text is selected. Select some text in the preview first.");
  }
});

let toastTimer: number | undefined;
/** Minimal toast for the "+" with no usable selection — this view's own take
 * on what the live editor's `showToast` does (src/webview/client.ts). */
function showToast(text: string): void {
  let toast = document.querySelector<HTMLElement>(".pr-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "pr-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("pr-toast--visible");
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove("pr-toast--visible"), 4000);
}

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

// --- shared card head (draft + existing thread) ----------------------------

/**
 * The `.thread-head-row` every card kind shares: collapse chevron, the
 * quote/jump button, an optional badge, the comment count (shown only
 * collapsed — threadSidebar.css), and the `L3` / `L3–5` line label.
 * Collapsed, a click anywhere in the row expands it (live sidebar
 * behaviour); the chevron and the quote button stop that bubbling so their
 * own click does only their own thing.
 */
function buildCardHead(opts: {
  quoteLine: number;
  lineLabel: string;
  collapsed: boolean;
  toggleAriaLabel: string;
  toggleTitle: string;
  badge?: { cls: string; text: string };
  commentCount: number;
  onToggleCollapse(): void;
}): HTMLElement {
  const headRow = document.createElement("div");
  headRow.className = "thread-head-row";

  const chevron = buildCollapseToggle({
    extraClass: "thread-collapse",
    ariaLabel: opts.toggleAriaLabel,
    title: opts.toggleTitle,
    expanded: !opts.collapsed,
    onToggle: (e) => {
      e.stopPropagation();
      opts.onToggleCollapse();
    },
  });
  headRow.appendChild(chevron);

  const quote = document.createElement("button");
  quote.type = "button";
  quote.className = "thread-quote pr-jump";
  quote.title = "Jump to this line in the preview";
  quote.textContent = quoteTextFor(opts.quoteLine);
  quote.addEventListener("click", (e) => {
    e.stopPropagation();
    scrollPreviewToLine(opts.quoteLine);
  });
  headRow.appendChild(quote);

  if (opts.badge) {
    const badge = document.createElement("span");
    badge.className = opts.badge.cls;
    badge.textContent = opts.badge.text;
    headRow.appendChild(badge);
  }

  const count = document.createElement("span");
  count.className = "thread-comment-count";
  count.textContent = opts.commentCount === 1 ? "1 comment" : `${opts.commentCount} comments`;
  headRow.appendChild(count);

  const lineEl = document.createElement("span");
  lineEl.className = "pr-line";
  lineEl.textContent = opts.lineLabel;
  headRow.appendChild(lineEl);

  headRow.addEventListener("click", (e) => {
    if (!opts.collapsed) return;
    e.stopPropagation();
    opts.onToggleCollapse();
  });

  const head = document.createElement("header");
  head.className = "thread-head";
  head.appendChild(headRow);
  return head;
}

// --- drafts sidebar -------------------------------------------------------

function renderDrafts(): void {
  dom.draftsList.innerHTML = "";
  // Sort by line ascending.
  const sorted = [...drafts].sort((a, b) => (a.startLine ?? a.line) - (b.startLine ?? b.line));
  for (const d of sorted) {
    dom.draftsList.appendChild(renderDraftCard(d));
  }
  updateCollapseAllButton();
}

/**
 * A draft has no resolved state, so it needs none of `applyThreadCollapseDefault`'s
 * transition tracking — absence from `collapsedCards` already means expanded,
 * which is the only default a draft ever wants. A draft being edited keeps
 * its frame and head (the quote says which line the text is about) and is
 * always shown in full, so an in-progress edit is never hidden.
 */
function renderDraftCard(d: PrDraft): HTMLElement {
  const lineLabel = lineRangeLabel(d.startLine, d.line);
  const editing = editingDraftId === d.id;
  const key = draftKey(d.id);
  const collapsed = !editing && collapsedCards.has(key);
  const card = document.createElement("section");
  card.className = collapsed ? "thread-card pr-draft collapsed" : "thread-card pr-draft";
  card.dataset.draftId = d.id;
  card.setAttribute("aria-label", `You: ${gistOf(d.body)}`);

  card.appendChild(buildCardHead({
    quoteLine: d.startLine ?? d.line,
    lineLabel,
    collapsed,
    toggleAriaLabel: "Collapse or expand this draft comment",
    toggleTitle: "Collapse / expand this draft comment",
    badge: { cls: "mc-badge mc-badge--draft", text: "draft" },
    commentCount: 1,
    onToggleCollapse: () => {
      if (collapsedCards.has(key)) collapsedCards.delete(key);
      else collapsedCards.add(key);
      persistCollapsedCards();
      renderDrafts();
    },
  }));

  if (editing) {
    const composer = buildComposer({
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
    card.appendChild(composer.el);
    return card;
  }

  card.appendChild(buildCommentCard({
    author: "You",
    timestamp: d.createdAt,
    bodyEl: buildCommentBody(d.body),
    actions: [
      { label: "Edit", onClick: () => { editingDraftId = d.id; renderDrafts(); } },
      { label: "Delete", variant: "danger", onClick: () => vscode.postMessage({ type: "delete-draft", id: d.id }) },
    ],
  }));

  return card;
}

// --- existing comments (read-only, plus Reply / Resolve) -------------------

/** Open reply composers, keyed by threadId, so a reply-error can re-enable them. */
const pendingReplies = new Map<string, ComposerHandle>();
/** In-flight resolve/unresolve buttons, keyed by resolveId, so a
 * resolve-thread-error can re-enable the one that failed. */
const pendingResolves = new Map<string, { btn: HTMLButtonElement; label: string }>();

function setExistingStatus(text: string | null): void {
  dom.existingStatus.hidden = text === null;
  dom.existingStatus.textContent = text ?? "";
}

function renderExisting(): void {
  // A fresh render replaces every thread card, so any in-flight composer or
  // resolve-button DOM is gone — drop the stale references.
  pendingReplies.clear();
  pendingResolves.clear();
  dom.existingList.innerHTML = "";

  if (existingComments === null) {
    dom.existingFilterRow.hidden = true;
    setExistingStatus("Loading comments…");
    updateCollapseAllButton();
    syncSidebarCollapsedUi();
    return;
  }

  const threads = threadsFrom(existingComments);
  // Resolved threads start collapsed, open ones expanded; a resolve ↔
  // unresolve transition re-applies that same rule. Runs over every thread
  // (not just what the filter shows), so a thread hidden by the filter today
  // still has the right collapse state if the filter changes later.
  for (const t of threads) applyThreadCollapseDefault(threadKey(t[0]), t[0].resolved === true);
  persistCollapsedCards();

  renderExistingFilterChips(threads);

  if (threads.length === 0) {
    // Nothing at all yet — the big first-run card, but only once drafts are
    // also empty; a reviewer already mid-draft doesn't need it repeated.
    if (drafts.length === 0) dom.existingList.appendChild(buildEmptyState());
    setExistingStatus(null);
    updateCollapseAllButton();
    syncSidebarCollapsedUi();
    return;
  }

  const filtered = threads.filter((t) => {
    if (existingFilter === "open") return t[0].resolved !== true;
    if (existingFilter === "resolved") return t[0].resolved === true;
    return true;
  });
  if (filtered.length === 0) {
    setExistingStatus(
      existingFilter === "open" ? "No open comments on this file." : "No resolved comments on this file.",
    );
  } else {
    setExistingStatus(null);
    for (const thread of filtered) dom.existingList.appendChild(renderExistingThread(thread));
  }
  updateCollapseAllButton();
  syncSidebarCollapsedUi();
}

/** First-run empty state — no drafts, no existing comments at all. No button: the sidebar's own "+" already covers the call to action. */
function buildEmptyState(): HTMLElement {
  const card = document.createElement("div");
  card.className = "mc-empty-state";
  const headline = document.createElement("div");
  headline.className = "mc-empty-state__headline";
  headline.textContent = "No comments on this file yet.";
  const hint = document.createElement("div");
  hint.className = "mc-empty-state__hint";
  hint.textContent = "Select text in the preview, then click + to draft a comment.";
  card.append(headline, hint);
  return card;
}

function updateExistingFilterSegments(): void {
  for (const r of dom.existingFilterRadios) {
    r.checked = r.value === existingFilter;
    r.closest("label")?.classList.toggle("active", r.checked);
  }
}

for (const r of dom.existingFilterRadios) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    existingFilter = r.value as ExistingFilter;
    vscode.setState({ ...safeGetState(), existingFilter });
    renderExisting();
  });
}

/** Tab counts — existing threads only, never drafts. Hidden with no existing threads at all. */
function renderExistingFilterChips(threads: ExistingPrComment[][]): void {
  dom.existingFilterRow.hidden = threads.length === 0;
  if (threads.length === 0) return;
  const resolvedCount = threads.filter((t) => t[0].resolved === true).length;
  dom.filterCountOpen.textContent = String(threads.length - resolvedCount);
  dom.filterCountAll.textContent = String(threads.length);
  dom.filterCountResolved.textContent = String(resolvedCount);
  updateExistingFilterSegments();
}

/** Show/hide a thread card's reply box without a re-render, so in-progress replies on other cards survive. */
function setReplyOpen(card: HTMLElement, open: boolean): void {
  const box = card.querySelector<HTMLElement>(".reply-box");
  const toggle = card.querySelector<HTMLButtonElement>(".thread-reply-toggle");
  box?.classList.toggle("open", open);
  toggle?.setAttribute("aria-expanded", String(open));
  if (open) box?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

function renderExistingThread(thread: ExistingPrComment[]): HTMLElement {
  const head = thread[0];
  const key = threadKey(head);
  const threadId = rawThreadId(head);
  const collapsed = collapsedCards.has(key);
  const card = document.createElement("section");
  card.className = head.resolved ? "thread-card resolved" : "thread-card";
  if (collapsed) card.classList.add("collapsed");
  card.dataset.threadId = threadId;
  card.setAttribute("aria-label", `${head.author}: ${head.body.slice(0, 60)}`);

  card.appendChild(buildCardHead({
    quoteLine: head.line,
    lineLabel: lineRangeLabel(undefined, head.line),
    collapsed,
    toggleAriaLabel: "Collapse or expand this comment thread",
    toggleTitle: "Collapse / expand this thread",
    badge: head.resolved ? { cls: "mc-badge mc-badge--resolved", text: "resolved" } : undefined,
    commentCount: thread.length,
    onToggleCollapse: () => {
      if (collapsedCards.has(key)) collapsedCards.delete(key);
      else collapsedCards.add(key);
      persistCollapsedCards();
      renderExisting();
    },
  }));

  // Visible per-card actions are Reply and Resolve/Reopen; the "↗ open" that
  // used to sit on every comment is now one button per thread, at the row's end.
  const actions = document.createElement("div");
  actions.className = "thread-actions";

  const replyToggleBtn = document.createElement("button");
  replyToggleBtn.type = "button";
  replyToggleBtn.className = "mc-btn mc-btn--quiet thread-reply-toggle";
  replyToggleBtn.textContent = "Reply";
  replyToggleBtn.setAttribute("aria-expanded", "false");
  replyToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const box = card.querySelector<HTMLElement>(".reply-box");
    setReplyOpen(card, !box?.classList.contains("open"));
  });
  actions.appendChild(replyToggleBtn);

  // Only when the platform actually lets this thread be resolved — every
  // GitHub review thread, a GitLab discussion whose `resolvable` came back
  // true. Never for a plain, non-resolvable note.
  if (head.resolvable && head.resolveId) {
    actions.appendChild(buildResolveButton(head));
  }

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "mc-icon-btn pr-open";
  openBtn.title = "Open this thread in the browser";
  openBtn.setAttribute("aria-label", "Open this thread in the browser");
  openBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/>' +
    '<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5l-6 6"/></svg>';
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.open(head.url, "_blank");
  });
  actions.appendChild(openBtn);

  card.appendChild(actions);

  // Comments render flat — no reply indent, no per-comment actions (the
  // per-comment "↗ Open" is gone; the thread has one now, above).
  for (const c of thread) card.appendChild(renderExistingComment(c));

  const replyBox = document.createElement("div");
  replyBox.className = "reply-box";
  replyBox.addEventListener("click", (e) => e.stopPropagation());
  replyBox.addEventListener("mousedown", (e) => e.stopPropagation());
  const composer = buildComposer({
    placeholder: "Reply… (markdown supported by GitHub / GitLab)",
    submitLabel: "Reply",
    rows: 3,
    autofocus: false,
    onSubmit: (body) => {
      composer.setBusy("Posting…");
      pendingReplies.set(threadId, composer);
      vscode.postMessage({ type: "reply", threadId, body });
    },
    onCancel: () => setReplyOpen(card, false),
  });
  replyBox.appendChild(composer.el);
  card.appendChild(replyBox);

  return card;
}

/**
 * The Resolve/Unresolve button for a thread's action row. Click posts a
 * `resolve-thread` message and goes busy immediately (the "optimistic" part
 * of the flow — the button itself, not the thread's resolved state); the
 * actual resolved flag, badge, and collapse only change once the host
 * confirms with a fresh `existing-comments` push, which is also what a
 * concurrent resolve from someone else on the platform would produce. A
 * `resolve-thread-error` re-enables the button in place via `pendingResolves`.
 * "Unresolve" — the platform's own word — is kept on purpose.
 */
function buildResolveButton(head: ExistingPrComment): HTMLButtonElement {
  const resolveId = head.resolveId!;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mc-btn mc-btn--quiet pr-resolve";
  btn.textContent = head.resolved ? "Unresolve" : "Resolve";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = !head.resolved;
    const label = btn.textContent!;
    btn.disabled = true;
    btn.textContent = target ? "Resolving…" : "Unresolving…";
    pendingResolves.set(resolveId, { btn, label });
    vscode.postMessage({ type: "resolve-thread", resolveId, resolved: target });
  });
  return btn;
}

/** A reply POST failed — re-enable the composer and show the error inline. */
function failPendingReply(threadId: string, error: string): void {
  pendingReplies.get(threadId)?.setError(error);
}

/** A resolve/unresolve POST failed — revert the button to its clickable label. */
function failPendingResolve(resolveId: string, error: string): void {
  const pending = pendingResolves.get(resolveId);
  if (!pending) return;
  pending.btn.disabled = false;
  pending.btn.textContent = pending.label;
  pending.btn.title = error;
  pendingResolves.delete(resolveId);
}

function renderExistingComment(c: ExistingPrComment): HTMLElement {
  return buildCommentCard({
    author: c.author,
    timestamp: c.createdAt,
    bodyEl: buildCommentBody(c.body),
  });
}
