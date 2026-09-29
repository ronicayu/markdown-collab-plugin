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
import { createDiffNav, isNavKeyContext } from "../../webviewShared/diffNav";
import { smoothScrollIntoView } from "../../webviewShared/scrollIntoView";
import { nextCollapseAllAction } from "../../webviewShared/threadListState";

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
  preview: document.getElementById("preview") as HTMLElement,
  diffNav: document.getElementById("diff-nav") as HTMLElement,
  diffPrev: document.getElementById("diff-prev") as HTMLButtonElement,
  diffNext: document.getElementById("diff-next") as HTMLButtonElement,
  diffNavCount: document.getElementById("diff-nav-count") as HTMLElement,
  floating: document.getElementById("floating-add") as HTMLButtonElement,
  draftCount: document.getElementById("draft-count") as HTMLElement,
  collapseAllBtn: document.getElementById("collapse-all-btn") as HTMLButtonElement,
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

type ExistingFilter = "all" | "open" | "resolved";
/** Restored from webview state so the choice survives tab switches/reloads. */
let existingFilter: ExistingFilter = (() => {
  const saved = safeGetState().existingFilter;
  return saved === "open" || saved === "resolved" ? saved : "all";
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
 * A short one-line summary of a comment body for a collapsed card's header:
 * markdown stripped down to a rough plain-text read, whitespace collapsed,
 * and capped so a long comment doesn't blow out the collapsed row. No gist
 * helper is shared in webviewShared yet, so this is local to the PR view.
 */
function gistOf(body: string, max = 100): string {
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

/**
 * The collapsible header shared by a draft card and an existing-thread card:
 * a chevron plus whatever the caller appends to it. `aria-expanded` and the
 * click/keyboard toggle live on the header element itself — the whole row is
 * the toggle target, not just the chevron — so a caller's own buttons inside
 * it (Line N, Resolve) must stop propagation or they'd also toggle collapse.
 */
function buildCardHeader(opts: { collapsed: boolean; ariaLabel: string; onToggle: () => void }): HTMLElement {
  const header = document.createElement("header");
  header.className = "existing-head";
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", String(!opts.collapsed));
  header.setAttribute("aria-label", opts.ariaLabel);
  const chevron = document.createElement("span");
  chevron.className = "existing-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = opts.collapsed ? "▸" : "▾";
  header.appendChild(chevron);
  header.addEventListener("click", () => opts.onToggle());
  header.addEventListener("keydown", (e) => {
    if (e.target !== header) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      opts.onToggle();
    }
  });
  return header;
}

/** The collapsed-only summary line: author, a one-line gist, and the reply count. */
function buildGistLine(author: string, body: string, replyCount: number): HTMLElement {
  const gist = document.createElement("span");
  gist.className = "existing-gist";
  const authorEl = document.createElement("strong");
  authorEl.textContent = author;
  gist.appendChild(authorEl);
  gist.appendChild(document.createTextNode(
    ` ${gistOf(body)} · ${replyCount} repl${replyCount === 1 ? "y" : "ies"}`,
  ));
  return gist;
}

/** Existing comments grouped into threads, sorted the way `renderExisting` displays them. */
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

/** Sync the toolbar's Collapse all / Expand all button to the current state. */
function updateCollapseAllButton(): void {
  const keys = allCardKeys();
  dom.collapseAllBtn.hidden = keys.length === 0;
  if (keys.length === 0) return;
  dom.collapseAllBtn.textContent =
    nextCollapseAllAction(keys, collapsedCards) === "collapse" ? "Collapse all" : "Expand all";
}

dom.collapseAllBtn.addEventListener("click", () => {
  const keys = allCardKeys();
  if (keys.length === 0) return;
  const action = nextCollapseAllAction(keys, collapsedCards);
  for (const key of keys) {
    if (action === "collapse") collapsedCards.add(key);
    else collapsedCards.delete(key);
  }
  persistCollapsedCards();
  renderDrafts();
  renderExisting();
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
 * line and flash it. Used by the draft / existing-comment line buttons so a
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
    updateCollapseAllButton();
    return;
  }
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
 * which is the only default a draft ever wants. Collapse chrome only applies
 * to the non-editing view; a draft being edited always shows its composer in
 * full so an in-progress edit is never hidden.
 */
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

  const key = draftKey(d.id);
  const collapsed = collapsedCards.has(key);
  const card = document.createElement("section");
  card.className = "existing-card";
  card.dataset.draftId = d.id;
  if (collapsed) card.classList.add("collapsed");

  const header = buildCardHeader({
    collapsed,
    ariaLabel: "Collapse or expand this draft comment",
    onToggle: () => {
      if (collapsedCards.has(key)) collapsedCards.delete(key);
      else collapsedCards.add(key);
      persistCollapsedCards();
      renderDrafts();
    },
  });
  const lineBtn = document.createElement("button");
  lineBtn.className = "draft-line btn-link";
  lineBtn.textContent = lineLabel;
  lineBtn.title = "Jump to this line in the preview";
  lineBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    scrollPreviewToLine(d.startLine ?? d.line);
  });
  header.appendChild(lineBtn);
  header.appendChild(buildGistLine("Your draft", d.body, 0));
  card.appendChild(header);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "existing-body-wrap";
  bodyWrap.appendChild(buildCommentCard({
    author: "Your draft",
    bodyEl: buildCommentBody(d.body),
    actions: [
      { label: "Edit", onClick: () => { editingDraftId = d.id; renderDrafts(); } },
      { label: "Delete", variant: "danger", onClick: () => vscode.postMessage({ type: "delete-draft", id: d.id }) },
    ],
  }));
  card.appendChild(bodyWrap);

  return card;
}

// --- existing comments (read-only) ----------------------------------------

/** Open reply composers, keyed by threadId, so a reply-error can re-enable them. */
const pendingReplies = new Map<string, ComposerHandle>();
/** In-flight resolve/unresolve buttons, keyed by resolveId, so a
 * resolve-thread-error can re-enable the one that failed. */
const pendingResolves = new Map<string, { btn: HTMLButtonElement; label: string }>();

function renderExisting(): void {
  // A fresh render replaces every thread card, so any in-flight composer or
  // resolve-button DOM is gone — drop the stale references.
  pendingReplies.clear();
  pendingResolves.clear();
  dom.existingSection.hidden = false;
  if (existingComments === null) {
    dom.existingFilter.hidden = true;
    dom.existingStatus.textContent = "Loading existing comments…";
    dom.existingStatus.hidden = false;
    dom.existingList.innerHTML = "";
    updateCollapseAllButton();
    return;
  }
  if (existingComments.length === 0) {
    dom.existingFilter.hidden = true;
    dom.existingStatus.textContent = "No existing PR comments on this file.";
    dom.existingStatus.hidden = false;
    dom.existingList.innerHTML = "";
    updateCollapseAllButton();
    return;
  }
  dom.existingStatus.hidden = true;
  dom.existingList.innerHTML = "";
  const threads = threadsFrom(existingComments);

  // Resolved threads start collapsed, open ones expanded; a resolve ↔
  // unresolve transition re-applies that same rule. Runs over every thread
  // (not just what the filter shows), so a thread hidden by the filter today
  // still has the right collapse state if the filter changes later.
  for (const t of threads) applyThreadCollapseDefault(threadKey(t[0]), t[0].resolved === true);
  persistCollapsedCards();

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
    updateCollapseAllButton();
    return;
  }
  for (const thread of filtered) {
    dom.existingList.appendChild(renderExistingThread(thread));
  }
  updateCollapseAllButton();
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
      vscode.setState({ ...safeGetState(), existingFilter });
      renderExisting();
    });
    dom.existingFilter.appendChild(btn);
  }
}

function renderExistingThread(thread: ExistingPrComment[]): HTMLElement {
  const head = thread[0];
  const key = threadKey(head);
  const collapsed = collapsedCards.has(key);
  const card = document.createElement("section");
  card.className = "existing-card";
  card.dataset.threadId = head.threadId ?? head.id;
  if (head.resolved) card.classList.add("resolved");
  if (collapsed) card.classList.add("collapsed");

  const meta = buildCardHeader({
    collapsed,
    ariaLabel: "Collapse or expand this comment thread",
    onToggle: () => {
      if (collapsedCards.has(key)) collapsedCards.delete(key);
      else collapsedCards.add(key);
      persistCollapsedCards();
      renderExisting();
    },
  });
  const lineBtn = document.createElement("button");
  lineBtn.className = "draft-line btn-link";
  lineBtn.textContent = `Line ${head.line}`;
  lineBtn.title = "Jump to this line in the preview";
  lineBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    scrollPreviewToLine(head.line);
  });
  meta.appendChild(lineBtn);
  // The badge lives in the header, not the (collapsible) body, so a
  // collapsed resolved thread is still recognisable at a glance.
  if (head.resolved) {
    const tag = document.createElement("span");
    tag.className = "badge resolved";
    tag.textContent = "resolved";
    meta.appendChild(tag);
  }
  // Only when the platform actually lets this thread be resolved — every
  // GitHub review thread, a GitLab discussion whose `resolvable` came back
  // true. Never for a plain, non-resolvable note.
  if (head.resolvable && head.resolveId) {
    meta.appendChild(buildResolveButton(head));
  }
  meta.appendChild(buildGistLine(head.author, head.body, thread.length - 1));
  card.appendChild(meta);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "existing-body-wrap";
  for (const c of thread) {
    bodyWrap.appendChild(renderExistingComment(c, c === head));
  }
  bodyWrap.appendChild(renderReplyArea(head.threadId ?? head.id));
  card.appendChild(bodyWrap);
  return card;
}

/**
 * The Resolve/Unresolve button for a thread's header. Click posts a
 * `resolve-thread` message and goes busy immediately (the "optimistic" part
 * of the flow — the button itself, not the thread's resolved state); the
 * actual resolved flag, badge, and collapse only change once the host
 * confirms with a fresh `existing-comments` push, which is also what a
 * concurrent resolve from someone else on the platform would produce. A
 * `resolve-thread-error` re-enables the button in place via `pendingResolves`.
 */
function buildResolveButton(head: ExistingPrComment): HTMLButtonElement {
  const resolveId = head.resolveId!;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-link existing-resolve";
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

/** A resolve/unresolve POST failed — revert the button to its clickable label. */
function failPendingResolve(resolveId: string, error: string): void {
  const pending = pendingResolves.get(resolveId);
  if (!pending) return;
  pending.btn.disabled = false;
  pending.btn.textContent = pending.label;
  pending.btn.title = error;
  pendingResolves.delete(resolveId);
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

