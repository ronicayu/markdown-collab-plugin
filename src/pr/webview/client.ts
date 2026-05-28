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
  imageBaseUris: { docDir: string; workspaceFolder: string | null };
}
interface DraftsMessage { type: "drafts"; drafts: PrDraft[]; }
type HostMessage = InitMessage | DraftsMessage;

interface ReadyMessage { type: "ready"; }
interface AddDraftRequest { type: "add-draft"; startLine: number; endLine: number; body: string; }
interface EditDraftRequest { type: "edit-draft"; id: string; body: string; }
interface DeleteDraftRequest { type: "delete-draft"; id: string; }
interface JumpRequest { type: "jump"; line: number; }
type ClientToHost = ReadyMessage | AddDraftRequest | EditDraftRequest | DeleteDraftRequest | JumpRequest;

const vscode = window.acquireVsCodeApi();

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
installSourceOffsetPlugin(md);

const dom = {
  fileName: document.getElementById("file-name") as HTMLElement,
  preview: document.getElementById("preview") as HTMLElement,
  floating: document.getElementById("floating-add") as HTMLButtonElement,
  draftCount: document.getElementById("draft-count") as HTMLElement,
  draftsList: document.getElementById("drafts-list") as HTMLElement,
  composer: document.getElementById("composer") as HTMLElement,
};

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
    lineStarts = computeLineStarts(msg.source);
    dom.fileName.textContent = msg.fileName;
    renderPreview(msg.source, msg.addedRanges);
    renderDrafts();
  } else if (msg.type === "drafts") {
    drafts = msg.drafts;
    renderDrafts();
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
  dom.floating.style.top = `${rect.bottom + window.scrollY + 4}px`;
  dom.floating.style.left = `${rect.left + window.scrollX}px`;
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
  const meta = document.createElement("div");
  meta.className = "composer-meta";
  meta.textContent = sel.startLine === sel.endLine
    ? `Comment on line ${sel.startLine}`
    : `Comment on lines ${sel.startLine}–${sel.endLine}`;
  const ta = document.createElement("textarea");
  ta.placeholder = "Your review comment (markdown supported by GitHub / GitLab)";
  ta.rows = 4;
  const row = document.createElement("div");
  row.className = "composer-actions";
  const save = document.createElement("button");
  save.textContent = "Add draft";
  save.disabled = true;
  ta.addEventListener("input", () => { save.disabled = ta.value.trim().length === 0; });
  save.addEventListener("click", () => {
    const body = ta.value.trim();
    if (!body) return;
    vscode.postMessage({ type: "add-draft", startLine: sel.startLine, endLine: sel.endLine, body });
    dom.composer.hidden = true;
    dom.floating.hidden = true;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    pendingSelection = null;
  });
  const cancel = document.createElement("button");
  cancel.className = "btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    dom.composer.hidden = true;
  });
  row.append(save, cancel);
  dom.composer.append(meta, ta, row);
  requestAnimationFrame(() => ta.focus());
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
  const card = document.createElement("section");
  card.className = "draft-card";

  const head = document.createElement("header");
  head.className = "draft-head";
  const lineLabel = document.createElement("button");
  lineLabel.className = "draft-line btn-link";
  lineLabel.textContent = d.startLine && d.startLine !== d.line
    ? `Lines ${d.startLine}–${d.line}`
    : `Line ${d.line}`;
  lineLabel.title = "Jump to this line in the source editor";
  lineLabel.addEventListener("click", () => vscode.postMessage({ type: "jump", line: d.startLine ?? d.line }));
  head.appendChild(lineLabel);
  card.appendChild(head);

  if (editingDraftId === d.id) {
    const ta = document.createElement("textarea");
    ta.value = d.body;
    ta.rows = Math.max(2, Math.min(8, d.body.split("\n").length));
    card.appendChild(ta);
    const row = document.createElement("div");
    row.className = "composer-actions";
    const save = document.createElement("button");
    save.textContent = "Save";
    save.addEventListener("click", () => {
      const body = ta.value.trim();
      if (!body) return;
      vscode.postMessage({ type: "edit-draft", id: d.id, body });
      editingDraftId = null;
    });
    const cancel = document.createElement("button");
    cancel.className = "btn-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      editingDraftId = null;
      renderDrafts();
    });
    row.append(save, cancel);
    card.appendChild(row);
    requestAnimationFrame(() => ta.focus());
    return card;
  }

  const body = document.createElement("div");
  body.className = "draft-body";
  body.textContent = d.body;
  card.appendChild(body);

  const tools = document.createElement("div");
  tools.className = "draft-tools";
  const editBtn = document.createElement("button");
  editBtn.className = "btn-link";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => {
    editingDraftId = d.id;
    renderDrafts();
  });
  const delBtn = document.createElement("button");
  delBtn.className = "btn-link danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "delete-draft", id: d.id });
  });
  tools.append(editBtn, delBtn);
  card.appendChild(tools);
  return card;
}
