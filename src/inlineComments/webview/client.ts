// All state mutations round-trip through the extension host as `WorkspaceEdit`s on the
// underlying .md file — there is no in-webview cache of comments.

import { createMarkdownRenderer, ensurePlantuml, setHtmlImageResolver } from "../../webviewShared/markdownPipeline";
import { hydrateShadowHtml, shadowRootsIn } from "../../webviewShared/shadowHtml";
import { isAgentComment } from "../../agentIdentity";
import { isClaudeUnread } from "../claudeUnread";
import { slugifyHeading } from "../linkParse";
import { findCountLabel, findMatchesIn, stepIndex } from "../../webviewShared/findState";
import { createDiffNav, isNavKeyContext } from "../../webviewShared/diffNav";
import { planHighlightSlices } from "../../webviewShared/highlightSlices";
import {
  THREAD_RENDER_CHUNK,
  adjacentThreadId,
  chunkThreads,
  claudeSummary,
  emptyState,
  filterThreads,
  matchesFilter,
  nextCollapseAllAction,
  nextUnreadThreadId,
  threadCountLabel,
  type EmptyState,
  type ThreadFilter,
} from "../../webviewShared/threadListState";
import { buildComposer, buildCommentBody, buildCommentCard, buildSuggestionCard, type CardAction } from "../../webviewShared/commentUi";
import { smoothScrollIntoView } from "../../webviewShared/scrollIntoView";
import { resolveImageSrc, type ImageBaseUris } from "../../webviewShared/imageSrc";
import { LINE_ATTR, LINE_ENV_KEY, displayLine } from "../../webviewShared/lineNumbers";
import { buildOutline } from "../../webviewShared/outline";
import { buildOutlinePanel, type OutlinePanelHandle } from "../../webviewShared/outlinePanel";

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
  /** Set by the tools/CLI on every comment an agent writes. */
  agent?: boolean;
  /**
   * How this comment reached the file — "tools" (MCP) or "cli" (`mdc`).
   * Absent means it was typed straight into the file's text, by a human or by
   * an agent editing directly. Only meaningful on an agent comment;
   * `renderComment` gates the marker on `isAgentComment` first.
   */
  via?: "tools" | "cli";
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
  /** The anchored text changed after this thread's last comment. */
  stale?: boolean;
}

interface SuggestionState {
  anchorId: string;
  threadId?: string;
  author: string;
  ts: string;
  original: string;
  proposed: string;
  note?: string;
  anchor: { proseStart: number; proseEnd: number } | null;
}

interface SerializedState {
  prose: string;
  threads: ThreadState[];
  suggestions: SuggestionState[];
  /** Source line per prose line. Present only when line numbers are on. */
  lineMap?: number[];
}

interface DiffLineRange {
  /** 1-based, inclusive, in prose-line space. */
  start: number;
  end: number;
}

interface DiffRemovedRun {
  /** 1-based prose line the removed text sits after; 0 = top of document. */
  afterLine: number;
  /** The removed old-side prose, newline-joined. */
  text: string;
}

/** Uncommitted-vs-HEAD overlay; null / absent = plain inline-comments view. */
interface DiffState {
  addedRanges: DiffLineRange[];
  removed: DiffRemovedRun[];
  isNew: boolean;
}

interface InitMsg {
  type: "init";
  fileName: string;
  state: SerializedState;
  diff?: DiffState | null;
  user: { name: string };
  imageBaseUris: {
    docDir: string;
    workspaceFolder: string | null;
  };
  plantuml?: { serverUrl: string; format: "svg" | "png" };
  skillStatus?: SkillStatus;
  suggestMode?: boolean;
  pendingThreadIds?: string[];
  /** Host-decided wording for the waiting row. */
  pendingLabel?: string;
  /**
   * Display name of the agent that last wrote to this file — "Codex", "Cursor",
   * etc. Absent means Claude, so an old host omitting the field reads as it
   * always has. Used where the UI has no per-thread agent to name (the Send
   * button and its title, the suggest-mode switch title, the default
   * pending-row text).
   */
  agentName?: string;
}

type SkillStatus = "missing" | "outdated" | "current";

interface SkillStatusMsg {
  type: "skill-status";
  status: SkillStatus;
}

interface UpdateMsg {
  type: "update";
  state: SerializedState;
  diff?: DiffState | null;
  suggestMode?: boolean;
  pendingThreadIds?: string[];
  pendingLabel?: string;
  agentName?: string;
}

interface ReviewPendingMsg {
  type: "review-pending";
  existingIds: string[];
}

interface ScrollToMsg {
  type: "scroll-to";
  proseOffset: number;
}

const md = createMarkdownRenderer();
function ensurePlantumlInstalled(opts: { serverUrl: string; format: "svg" | "png" } | undefined): void {
  ensurePlantuml(md, opts);
}

let imageBaseUris: ImageBaseUris = {
  docDir: "",
  workspaceFolder: null,
};

// Override markdown-it's default image renderer so relative `src`
// attributes resolve against the .md file's directory (turned into a
// webview-loadable URI by the extension host). Without this every
// `![alt](foo.png)` 404s against the webview's own vscode-webview://
// origin.
// Same for an `<img>` written as raw HTML.
setHtmlImageResolver(md, (src) => resolveImageSrc(src, imageBaseUris));
const defaultImageRule = md.renderer.rules.image ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const tok = tokens[idx];
  const srcIdx = tok.attrIndex("src");
  if (srcIdx >= 0 && tok.attrs) {
    const original = tok.attrs[srcIdx][1];
    if (isDrawioSrc(original)) {
      // .drawio isn't a browser image format: emit a placeholder that
      // processDrawioPlaceholders() swaps for an inline SVG rendered from
      // host-read XML. Carry the original href + alt for the swap.
      const alt = tok.children ? self.renderInlineAsText(tok.children, options, env) : "";
      return `<span class="mc-drawio" data-drawio-href="${md.utils.escapeHtml(original)}" title="${md.utils.escapeHtml(alt)}">Loading diagram…</span>`;
    }
    const resolved = resolveImageSrc(original, imageBaseUris);
    if (resolved !== original) tok.attrs[srcIdx][1] = resolved;
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

function isDrawioSrc(src: string): boolean {
  const clean = (src || "").split(/[?#]/)[0].toLowerCase();
  return clean.endsWith(".drawio") || clean.endsWith(".drawio.xml") || clean.endsWith(".xml");
}

const dom = {
  preview: document.getElementById("preview") as HTMLElement,
  floating: document.getElementById("floating-add") as HTMLButtonElement,
  threadCount: document.getElementById("thread-count") as HTMLElement,
  threadsList: document.getElementById("threads-list") as HTMLElement,
  composer: document.getElementById("composer") as HTMLElement,
  filterRadios: document.querySelectorAll<HTMLInputElement>('input[name="filter"]'),
  sendToClaude: document.getElementById("send-to-claude") as HTMLButtonElement,
  copyPrompt: document.getElementById("copy-prompt") as HTMLButtonElement,
  suggestModeToggle: document.getElementById("suggest-mode-toggle") as HTMLButtonElement,
  removeResolved: document.getElementById("remove-resolved") as HTMLButtonElement,
  finalizeDoc: document.getElementById("finalize-doc") as HTMLButtonElement,
  diffNav: document.getElementById("diff-nav") as HTMLElement,
  diffPrev: document.getElementById("diff-prev") as HTMLButtonElement,
  diffNext: document.getElementById("diff-next") as HTMLButtonElement,
  diffNavCount: document.getElementById("diff-nav-count") as HTMLElement,
  skillWarning: document.getElementById("skill-warning") as HTMLElement,
  skillWarningText: document.getElementById("skill-warning-text") as HTMLElement,
  skillInstall: document.getElementById("skill-install") as HTMLButtonElement,
  app: document.getElementById("app") as HTMLElement,
  collapseThreads: document.getElementById("collapse-threads") as HTMLButtonElement,
  expandThreads: document.getElementById("expand-threads") as HTMLButtonElement,
  claudeSummary: document.getElementById("claude-summary") as HTMLElement,
  claudeSummaryText: document.getElementById("claude-summary-text") as HTMLElement,
  claudeNext: document.getElementById("claude-next") as HTMLButtonElement,
  collapseAll: document.getElementById("collapse-all") as HTMLButtonElement,
  claudeFilterLabel: document.getElementById("filter-claude-label") as HTMLLabelElement,
  claudeFilterLabelText: document.getElementById("filter-claude-label-text") as HTMLElement,
  overflowMenuBtn: document.getElementById("overflow-menu-btn") as HTMLButtonElement,
  overflowMenu: document.getElementById("overflow-menu") as HTMLElement,
  hintToggle: document.getElementById("hint-toggle") as HTMLButtonElement,
  keysHint: document.getElementById("keys-hint") as HTMLElement,
  findBar: document.getElementById("find-bar") as HTMLElement,
  findInput: document.getElementById("find-input") as HTMLInputElement,
  findCount: document.getElementById("find-count") as HTMLElement,
  findPrev: document.getElementById("find-prev") as HTMLButtonElement,
  findNext: document.getElementById("find-next") as HTMLButtonElement,
  findClose: document.getElementById("find-close") as HTMLButtonElement,
  outlinePane: document.getElementById("outline-pane") as HTMLElement,
  // The scroll container is the pane, not #preview inside it — a listener on
  // the wrong one silently never fires.
  previewPane: document.getElementById("preview-pane") as HTMLElement,
  outlineToggle: document.getElementById("outline-toggle") as HTMLButtonElement,
};

// One "…" menu is open at a time (the toolbar's or one thread card's), tracked
// here so a click anywhere else closes it. Escape closes and returns focus to
// the trigger; an outside click doesn't steal focus from where the user clicked.
let openMenu: { trigger: HTMLButtonElement; panel: HTMLElement } | null = null;

function closeOpenMenu(returnFocus: boolean): void {
  if (!openMenu) return;
  const { trigger, panel } = openMenu;
  panel.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  openMenu = null;
  if (returnFocus && trigger.isConnected) trigger.focus();
}

function openMenuAt(trigger: HTMLButtonElement, panel: HTMLElement): void {
  closeOpenMenu(false);
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  openMenu = { trigger, panel };
  panel.querySelector<HTMLElement>('[role="menuitem"]:not([hidden])')?.focus();
}

function toggleMenuAt(trigger: HTMLButtonElement, panel: HTMLElement): void {
  if (openMenu?.panel === panel) closeOpenMenu(false);
  else openMenuAt(trigger, panel);
}

document.addEventListener("click", (e) => {
  if (!openMenu) return;
  const target = e.target as Node;
  if (openMenu.panel.contains(target) || openMenu.trigger.contains(target)) return;
  closeOpenMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (!openMenu) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeOpenMenu(true);
  }
});

dom.overflowMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenuAt(dom.overflowMenuBtn, dom.overflowMenu);
});

function buildMenuItem(label: string, onClick: () => void, opts: { danger?: boolean } = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "menuitem");
  if (opts.danger) btn.classList.add("danger");
  btn.textContent = label;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// Built from the prose the preview renders, so its line numbers index the same
// text the headings are found in.
const collapsedOutline: Set<string> = ((): Set<string> => {
  const saved = vscode.getState() as { collapsedOutline?: string[] } | undefined;
  return new Set(saved?.collapsedOutline ?? []);
})();

let outlineVisible: boolean = ((): boolean => {
  const saved = vscode.getState() as { outlineVisible?: boolean } | undefined;
  return saved?.outlineVisible ?? false;
})();

const outlinePanel: OutlinePanelHandle = buildOutlinePanel({
  collapsed: collapsedOutline,
  onCollapseChanged: () => {
    vscode.setState({
      ...(vscode.getState() as Record<string, unknown> | undefined),
      collapsedOutline: Array.from(collapsedOutline),
    });
  },
  onNavigate: (node) => scrollPreviewToHeadingIndex(node.index),
});
dom.outlinePane.appendChild(outlinePanel.el);

function applyOutlineVisibility(): void {
  dom.outlinePane.hidden = !outlineVisible;
  // The grid template needs the extra column, or every pane shifts one slot.
  dom.app.classList.toggle("with-outline", outlineVisible);
  dom.outlineToggle.setAttribute("aria-pressed", String(outlineVisible));
  dom.outlineToggle.classList.toggle("active", outlineVisible);
}
applyOutlineVisibility();

dom.outlineToggle.addEventListener("click", () => {
  outlineVisible = !outlineVisible;
  vscode.setState({
    ...(vscode.getState() as Record<string, unknown> | undefined),
    outlineVisible,
  });
  applyOutlineVisibility();
});

/**
 * Positional rather than by name: the outline and the renderer agree on how
 * many headings there are and in what order, but not always on how to spell
 * one, so duplicate heading names must not make an entry inert.
 */
function scrollPreviewToHeadingIndex(index: number): void {
  const all = dom.preview.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6");
  const target = all[index];
  if (target) smoothScrollIntoView(target, "start");
}

function syncOutlineActive(): void {
  if (!outlineVisible || !currentState) return;
  const previewTop = dom.previewPane.getBoundingClientRect().top;
  let activeIndex: number | null = null;
  const all = dom.preview.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6");
  for (let i = 0; i < all.length; i++) {
    // The last heading whose top has passed the fold is the section being read.
    if (all[i].getBoundingClientRect().top - previewTop <= 8) activeIndex = i;
    else break;
  }
  outlinePanel.setActive(activeIndex);
}

const collapsedThreads: Set<string> = ((): Set<string> => {
  const saved = vscode.getState() as { collapsedThreadIds?: string[] } | undefined;
  return new Set(saved?.collapsedThreadIds ?? []);
})();
function saveCollapsedThreads(): void {
  vscode.setState({
    ...(vscode.getState() as Record<string, unknown> | undefined),
    collapsedThreadIds: Array.from(collapsedThreads),
  });
}

/**
 * Thread IDs that existed when "Ask Agent to Review This Doc" fired. On the next
 * render where new claude-unread threads appear (the reply landed and the file
 * reloaded), scroll to the first new one and clear this. Persisted so it
 * survives a webview reload.
 */
let pendingReviewSnapshot: Set<string> | null = ((): Set<string> | null => {
  const saved = vscode.getState() as { pendingReviewIds?: string[] } | undefined;
  return saved?.pendingReviewIds ? new Set(saved.pendingReviewIds) : null;
})();

function savePendingReviewSnapshot(): void {
  const ids = pendingReviewSnapshot ? Array.from(pendingReviewSnapshot) : null;
  vscode.setState({
    ...(vscode.getState() as Record<string, unknown> | undefined),
    pendingReviewIds: ids,
  });
}

function setCollapsed(collapsed: boolean): void {
  dom.app.classList.toggle("threads-collapsed", collapsed);
  dom.expandThreads.hidden = !collapsed;
  vscode.setState({ ...(vscode.getState() as Record<string, unknown> | undefined), collapsed });
}
{
  const saved = vscode.getState() as { collapsed?: boolean } | undefined;
  if (saved?.collapsed) setCollapsed(true);
}
dom.collapseThreads.addEventListener("click", () => setCollapsed(true));
dom.expandThreads.addEventListener("click", () => setCollapsed(false));

// State is cleared whenever the preview re-renders so stale <mark> nodes
// don't survive a state change.

let findMatches: HTMLElement[] = [];
let findIndex = -1;

function findOpen(): void {
  dom.findBar.hidden = false;
  dom.findInput.focus();
  dom.findInput.select();
}

function findClose(): void {
  dom.findBar.hidden = true;
  // Clear the query first: findClear() recomputes the counter from the input,
  // so clearing afterwards left a stale "No results" behind the hidden bar.
  dom.findInput.value = "";
  findClear();
}

function findClear(): void {
  for (const m of findMatches) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    parent.normalize();
  }
  findMatches = [];
  findIndex = -1;
  updateFindCount();
}

function updateFindCount(): void {
  const label = findCountLabel(dom.findInput.value, findIndex, findMatches.length);
  dom.findCount.textContent = label.text;
  dom.findCount.classList.toggle("empty", label.empty);
}

function findRun(): void {
  findClear();
  const query = dom.findInput.value;
  if (!query) return;
  const needle = query.toLowerCase();
  const targets: Text[] = [];
  // Shadow-rendered HTML blocks are searched where they sit, so matches stay
  // in reading order: a tree walk doesn't enter a shadow root on its own.
  const shadowHosts = new Set(shadowRootsIn(dom.preview).map((sr) => sr.host));
  const collect = (root: Node): void => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Skip text inside SVG (mermaid diagrams) — wrapping their text
          // nodes in <mark> breaks the rendered diagram.
          const name = node.nodeName;
          if (name === "SVG" || name === "STYLE" || name === "SCRIPT") return NodeFilter.FILTER_REJECT;
          return shadowHosts.has(node as Element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return (node.textContent ?? "").toLowerCase().includes(needle)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) targets.push(n as Text);
      else if ((n as Element).shadowRoot) collect((n as Element).shadowRoot!);
    }
  };
  collect(dom.preview);

  for (const textNode of targets) {
    const text = textNode.textContent ?? "";
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const match of findMatchesIn(text, query)) {
      if (match.start > pos) {
        frag.appendChild(document.createTextNode(text.slice(pos, match.start)));
      }
      const mark = document.createElement("mark");
      mark.className = "mc-search";
      mark.textContent = text.slice(match.start, match.end);
      frag.appendChild(mark);
      findMatches.push(mark);
      pos = match.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  if (findMatches.length > 0) {
    findIndex = 0;
    highlightCurrent(true);
  }
  updateFindCount();
}

function highlightCurrent(scroll: boolean): void {
  for (const m of findMatches) m.classList.remove("mc-search--current");
  const cur = findMatches[findIndex];
  if (!cur) return;
  cur.classList.add("mc-search--current");
  if (scroll) smoothScrollIntoView(cur, "center");
}

function findStep(delta: number): void {
  if (findMatches.length === 0) return;
  findIndex = stepIndex(findIndex, delta, findMatches.length);
  highlightCurrent(true);
  updateFindCount();
}

dom.findInput.addEventListener("input", () => {
  findRun();
});
dom.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    findClose();
  }
});
dom.findPrev.addEventListener("click", () => findStep(-1));
dom.findNext.addEventListener("click", () => findStep(1));
dom.findClose.addEventListener("click", () => findClose());

document.addEventListener("keydown", (e) => {
  // The webview doesn't expose VS Code's editor find widget, so we own Cmd/Ctrl+F.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    findOpen();
  } else if (e.key === "Escape" && !dom.findBar.hidden) {
    e.preventDefault();
    findClose();
  }
});

dom.sendToClaude.addEventListener("click", () => {
  vscode.postMessage({ type: "send-to-claude" });
});
dom.copyPrompt.addEventListener("click", () => {
  vscode.postMessage({ type: "copy-prompt" });
  closeOpenMenu(false);
});
dom.suggestModeToggle.addEventListener("click", () => {
  vscode.postMessage({ type: "toggle-suggest-mode" });
});

// The host owns the confirm and the write: a webview cannot show a modal of its
// own (VS Code blocks synchronous dialogs), and a two-click arm is too quiet for
// a bulk delete.
dom.removeResolved.addEventListener("click", () => {
  vscode.postMessage({ type: "remove-resolved" });
  closeOpenMenu(false);
});

// Same host-owned confirm as remove-resolved; this one also deletes open threads.
dom.finalizeDoc.addEventListener("click", () => {
  vscode.postMessage({ type: "finalize" });
  closeOpenMenu(false);
});

/**
 * Sets the state a screen reader and CSS read from. The webview doesn't flip it
 * on click: the setting is the host's, and the switch only reflects what comes back.
 */
function updateSuggestModeToggle(on: boolean): void {
  dom.suggestModeToggle.setAttribute("aria-checked", String(on));
  dom.suggestModeToggle.classList.toggle("on", on);
}

/**
 * Put `agentName` into the toolbar wherever there's no per-thread agent to name:
 * the Send button and its title, and the suggest-mode switch title. `agentName`
 * already fell back to "Claude" in init/update, so this never needs to.
 */
function updateAgentUi(): void {
  dom.sendToClaude.textContent = `Send to ${agentName}`;
  dom.sendToClaude.title = `Send the prompt to a running ${agentName} terminal (or your configured send mode).`;
  dom.suggestModeToggle.title = `When on, Send to ${agentName} asks ${agentName} to propose edits as suggestions you accept or reject.`;
}

dom.skillInstall.addEventListener("click", () => {
  dom.skillInstall.disabled = true;
  dom.skillInstall.textContent = "Installing…";
  vscode.postMessage({ type: "install-skill" });
});

function renderSkillWarning(status: SkillStatus | undefined): void {
  if (!status || status === "current") {
    dom.skillWarning.hidden = true;
    return;
  }
  dom.skillWarning.hidden = false;
  dom.skillWarningText.textContent =
    status === "missing"
      ? "The Markdown Collab Claude skill isn't installed — Claude won't know how to act on these comments."
      : "The Markdown Collab Claude skill is out of date.";
  dom.skillInstall.disabled = false;
  dom.skillInstall.textContent = status === "missing" ? "Install skill" : "Update skill";
}

// Intercept anchor clicks inside the rendered preview: the webview sandbox
// swallows navigation, so markdown links are otherwise inert. Same-doc
// `#fragment` links scroll within the preview; everything else goes to the host.
// Document-level so links inside comment bodies route the same way — otherwise
// they fall through to the webview default and are treated as external web links.
document.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!target) return;
  const href = target.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  // The markdown-it default renderer doesn't emit anchor ids on headings, so
  // fall back to text-matching when no element matches by id.
  if (href.startsWith("#")) {
    scrollPreviewToFragment(href.slice(1));
    return;
  }
  vscode.postMessage({ type: "open-link", href });
});

function scrollPreviewToFragment(fragment: string): void {
  if (!fragment) return;
  const decoded = (() => {
    try {
      return decodeURIComponent(fragment);
    } catch {
      return fragment;
    }
  })();
  const byId = dom.preview.querySelector<HTMLElement>(`[id="${cssEscape(decoded)}"]`);
  if (byId) {
    smoothScrollIntoView(byId, "start");
    return;
  }
  const headings = dom.preview.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6");
  for (const h of Array.from(headings)) {
    if (slugifyHeading(h.textContent || "") === decoded) {
      smoothScrollIntoView(h, "start");
      return;
    }
  }
}

function updateCollapseAllLabel(): void {
  const threads = currentState?.threads ?? [];
  const allCollapsed = threads.length > 0 && threads.every((t) => collapsedThreads.has(t.id));
  dom.collapseAll.textContent = allCollapsed ? "Expand all" : "Collapse all";
  dom.collapseAll.disabled = threads.length === 0;
}
// Folds in place with no re-render, so an in-progress reply textarea on
// another card isn't wiped.
function setThreadCollapsed(id: string, collapsed: boolean): void {
  if (collapsed) collapsedThreads.add(id);
  else collapsedThreads.delete(id);
  saveCollapsedThreads();
  const card = dom.threadsList.querySelector<HTMLElement>(
    `.thread-card[data-thread="${cssEscape(id)}"]`,
  );
  card?.classList.toggle("collapsed", collapsed);
  const chevron = card?.querySelector<HTMLButtonElement>(".thread-collapse");
  if (chevron) chevron.textContent = collapsed ? "▸" : "▾";
  updateCollapseAllLabel();
}
dom.collapseAll.addEventListener("click", () => {
  const threads = currentState?.threads ?? [];
  const collapse =
    nextCollapseAllAction(
      threads.map((t) => t.id),
      collapsedThreads,
    ) === "collapse";
  for (const t of threads) setThreadCollapsed(t.id, collapse);
  closeOpenMenu(false);
});

dom.claudeNext.addEventListener("click", () => {
  if (!currentState) return;
  const nextId = nextUnreadThreadId(currentState.threads, highlightedThreadId);
  if (nextId) focusThread(nextId);
});

function cssEscape(s: string): string {
  // Thread ids are 5-char base36, no need for full CSS.escape support.
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

let currentState: SerializedState | null = null;
let currentDiff: DiffState | null = null;
let user: { name: string } = { name: "anonymous" };
let filter: ThreadFilter = "open";
// Threads dispatched to Claude and not yet answered — the host owns this, so
// it survives a webview reload and matches whatever the live editor shows.
let pendingThreadIds: ReadonlySet<string> = new Set();
// What the waiting row says. The host owns the wording because only it knows
// whether the wait is inferred or protocol-backed.
let pendingLabelText = "Claude is working\u2026";
let agentName = "Claude";
/** First click on "Accept all" arms it; the second applies. */
let acceptAllArmed = false;
// How many thread cards the list is currently allowed to build. Grows by a
// chunk each time the user clicks "Show more"; resets when the filter changes,
// since that is a new list.
let renderedThreadLimit = THREAD_RENDER_CHUNK;
let pendingSelection: { proseStart: number; proseEnd: number } | null = null;
let editingCommentId: string | null = null; // composite "threadId:commentId" when editing
let highlightedThreadId: string | null = null;
// Track two-click delete confirmation per thread / per comment. Using
// inline confirm rather than window.confirm() because VSCode webviews
// silently block sync modal dialogs — the user would click Delete and
// see nothing happen.
const pendingDeleteThread = new Set<string>();
const pendingDeleteComment = new Set<string>(); // composite "threadId:commentId"

/**
 * Move the "current card" state (`.highlighted` class + roving `tabindex`) to
 * `id` without a re-render, so an in-progress reply textarea elsewhere in the
 * list survives.
 */
function updateHighlightedCardDom(id: string): void {
  for (const c of dom.threadsList.querySelectorAll<HTMLElement>(".thread-card")) {
    const match = c.dataset.thread === id;
    c.classList.toggle("highlighted", match);
    c.tabIndex = match ? 0 : -1;
  }
}

/**
 * Highlight `id`'s card, scroll it into view, and scroll the preview to its
 * anchor. Raises the render cap first when the card hasn't been built yet: a
 * thread past the chunk limit would otherwise scroll toward a card that isn't
 * in the DOM.
 */
function focusThread(id: string): void {
  if (!currentState) return;
  const target = currentState.threads.find((t) => t.id === id);
  if (!target) return;
  highlightedThreadId = target.id;

  const revealAndScroll = (): void => {
    const card = dom.threadsList.querySelector<HTMLElement>(
      `.thread-card[data-thread="${cssEscape(target.id)}"]`,
    );
    updateHighlightedCardDom(target.id);
    if (card) {
      smoothScrollIntoView(card, "center");
      // Move DOM focus with the highlight (roving tabindex) so a keyboard user
      // lands where the screen reader is looking. `preventScroll` because the
      // line above already positioned the scroll.
      card.focus({ preventScroll: true });
    }
    scrollPreviewTo(target);
  };

  const targetIndex = filterThreads(currentState.threads, filter).findIndex((t) => t.id === target.id);
  if (targetIndex >= renderedThreadLimit) {
    renderedThreadLimit = Math.ceil((targetIndex + 1) / THREAD_RENDER_CHUNK) * THREAD_RENDER_CHUNK;
    renderThreads(currentState);
    // Defer one frame so the freshly-rendered card is in the DOM.
    requestAnimationFrame(revealAndScroll);
  } else {
    revealAndScroll();
  }
}

function moveThreadHighlight(delta: 1 | -1): void {
  if (!currentState) return;
  const nextId = adjacentThreadId(currentState.threads, filter, highlightedThreadId, delta);
  if (nextId) focusThread(nextId);
}

/**
 * Expands a collapsed card first: the textarea is `display: none` inside it, so
 * a `.focus()` would silently do nothing.
 */
function focusReplyOnHighlighted(): void {
  if (!highlightedThreadId) return;
  if (collapsedThreads.has(highlightedThreadId)) setThreadCollapsed(highlightedThreadId, false);
  setReplyOpen(highlightedThreadId, true, true);
}

function resolveOrReopenHighlighted(): void {
  if (!highlightedThreadId) return;
  vscode.postMessage({ type: "toggle-resolve", threadId: highlightedThreadId });
}

function openHighlightedInEditor(): void {
  if (!highlightedThreadId) return;
  vscode.postMessage({ type: "open-in-editor", threadId: highlightedThreadId });
}

/**
 * The segmented-control look is CSS driven off which radio is `:checked`, but
 * some call sites flip `.checked` directly (no `change` fires) — a background
 * thread landing while "New from Claude" is selected, for instance. Those call
 * this so the active segment repaints too.
 */
function updateFilterSegments(): void {
  for (const r of dom.filterRadios) r.closest("label")?.classList.toggle("active", r.checked);
}

function render(state: SerializedState): void {
  currentState = state;
  renderPreview(state);
  renderThreads(state);
  updateCollapseAllLabel();
  positionFloatingButton();
  maybeScrollToNewReview(state);
}

function maybeScrollToNewReview(state: SerializedState): void {
  if (!pendingReviewSnapshot) return;
  const newClaudeUnread = state.threads
    .filter((t) => isClaudeUnread(t) && !pendingReviewSnapshot!.has(t.id))
    .sort((a, b) => {
      const aPos = a.anchor?.proseStart ?? Number.MAX_SAFE_INTEGER;
      const bPos = b.anchor?.proseStart ?? Number.MAX_SAFE_INTEGER;
      return aPos - bPos;
    });
  if (newClaudeUnread.length === 0) return;
  const target = newClaudeUnread[0];
  // Clear the snapshot first so re-entry doesn't loop on subsequent updates.
  pendingReviewSnapshot = null;
  savePendingReviewSnapshot();
  focusThread(target.id);
}

let mermaidInitialized = false;

function renderPreview(state: SerializedState): void {
  // The source-offset plugin wraps every text/code token in
  // `<span data-mc-src="START.END">` (prose offsets); anchor highlights are
  // painted from those spans, with no fuzzy text matching. The env flag is what
  // switches the per-block line attribute on, so the markup carries no line
  // data unless the numbers are being shown.
  const showLines = Array.isArray(state.lineMap);
  dom.preview.innerHTML = md.render(state.prose, showLines ? { [LINE_ENV_KEY]: true } : {});
  hydrateShadowHtml(dom.preview);
  dom.preview.classList.toggle("with-line-numbers", showLines);
  if (showLines) paintLineNumbers(state.lineMap!);
  paintDiffStripes(state.prose, currentDiff);
  applyAnchorHighlights(state);
  outlinePanel.update(buildOutline(state.prose));
  syncOutlineActive();
  void runMermaid();
  processDrawioPlaceholders();
  // The rerender just blew away any <mark> nodes we'd inserted. Reset
  // find state, and if the bar is still open re-run against the new DOM
  // so the user doesn't lose their query.
  findMatches = [];
  findIndex = -1;
  if (!dom.findBar.hidden && dom.findInput.value) {
    findRun();
  } else {
    updateFindCount();
  }
}

const DIFF_BLOCK_TAGS = new Set(["P", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "TABLE", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DIV", "FIGURE", "IMG"]);

function nearestDiffBlock(start: Element): HTMLElement | null {
  let cur: Element | null = start;
  while (cur && cur !== dom.preview) {
    if (DIFF_BLOCK_TAGS.has(cur.tagName)) return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return null;
}

function paintDiffStripes(prose: string, diff: DiffState | null): void {
  document.body.classList.toggle("diff-mode", diff !== null);
  renderDiffBadge(diff);
  if (!diff) {
    diffNav.setStops([]);
    updateKeysHint();
    return;
  }
  const lineStarts: number[] = [0];
  for (let i = 0; i < prose.length; i++) {
    if (prose[i] === "\n") lineStarts.push(i + 1);
  }
  const lineFor = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const overlaps = (a: number, b: number): boolean =>
    diff.addedRanges.some((r) => a <= r.end && b >= r.start);
  const seen = new WeakSet<Element>();
  for (const el of Array.from(dom.preview.querySelectorAll<HTMLElement>("[data-mc-src]"))) {
    const raw = el.dataset.mcSrc || "";
    const dot = raw.indexOf(".");
    if (dot === -1) continue;
    const start = Number(raw.slice(0, dot));
    const end = Number(raw.slice(dot + 1));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const startLine = lineFor(start);
    const endLine = lineFor(Math.max(start, end - 1));
    if (!overlaps(startLine, endLine)) continue;
    const block = nearestDiffBlock(el);
    if (!block || seen.has(block)) continue;
    seen.add(block);
    block.classList.add("mc-diff-changed");
  }
  paintDiffDeletions(prose, diff, lineStarts);
  // Stops: every stripe and removed-text widget, in document order, collected
  // after both painters ran.
  diffNav.setStops(
    Array.from(dom.preview.querySelectorAll<HTMLElement>(".mc-diff-changed, .mc-diff-removed")),
  );
  updateKeysHint();
}

/**
 * The hint names what n/p will actually do. They step changes whenever the
 * change arrows are showing and walk threads otherwise, so the line follows
 * the arrows' visibility rather than the diff badge: a diff with no changes
 * has no arrows, and there n/p walk threads.
 */
function updateKeysHint(): void {
  const target = dom.diffNav.hidden ? "threads" : "changes";
  dom.keysHint.textContent = `n / p to move between ${target} · r reply · e resolve · o open in editor`;
}

// Hides itself the first time n/p/r/e/o is used; the "?" button brings it back
// (or hides it again) as a manual override. Persisted so it doesn't reappear on
// every webview reload once dismissed.
let hintDismissed: boolean = ((): boolean => {
  const saved = vscode.getState() as { hintDismissed?: boolean } | undefined;
  return saved?.hintDismissed ?? false;
})();

function saveHintDismissed(): void {
  vscode.setState({ ...(vscode.getState() as Record<string, unknown> | undefined), hintDismissed });
}

function applyHintVisibility(): void {
  dom.keysHint.hidden = hintDismissed;
  dom.hintToggle.setAttribute("aria-pressed", String(!hintDismissed));
}
applyHintVisibility();

function dismissHintOnFirstUse(): void {
  if (hintDismissed) return;
  hintDismissed = true;
  saveHintDismissed();
  applyHintVisibility();
}

dom.hintToggle.addEventListener("click", () => {
  hintDismissed = !hintDismissed;
  saveHintDismissed();
  applyHintVisibility();
});

const diffNav = createDiffNav({
  container: dom.diffNav,
  prev: dom.diffPrev,
  next: dom.diffNext,
  count: dom.diffNavCount,
  currentClass: "mc-diff-current",
});

// While the diff overlay is showing, n/p step through changed blocks;
// otherwise they walk the highlight through the filtered thread list.
// Deliberately no `a` for "accept" — a single-key accept with no visible target
// is a footgun. Never fires with a modifier held or while typing in the find
// bar, a composer, or a reply box.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (!isNavKeyContext(e.target)) return;
  if (e.key === "n" || e.key === "p") {
    const delta = e.key === "n" ? 1 : -1;
    if (!dom.diffNav.hidden) diffNav.step(delta);
    else moveThreadHighlight(delta);
  } else if (e.key === "r") {
    focusReplyOnHighlighted();
  } else if (e.key === "e") {
    resolveOrReopenHighlighted();
  } else if (e.key === "o") {
    openHighlightedInEditor();
  } else {
    return;
  }
  dismissHintOnFirstUse();
});

function topLevelBlock(el: Element): HTMLElement | null {
  let cur: Element | null = el;
  while (cur && cur.parentElement !== dom.preview) cur = cur.parentElement;
  return cur as HTMLElement | null;
}

/**
 * Insert a widget showing the deleted HEAD text where each removed run sat;
 * without it a deletion (or the old half of a modification) is invisible. The
 * widget goes after the top-level block containing (or last preceding) the
 * anchor line; a run anchored to line 0 goes above everything.
 */
function paintDiffDeletions(prose: string, diff: DiffState, lineStarts: number[]): void {
  // A removed run that was only blank lines has nothing visible to show.
  const runs = (diff.removed ?? []).filter((r) => r.text.trim() !== "");
  if (runs.length === 0) return;
  const spans = Array.from(dom.preview.querySelectorAll<HTMLElement>("[data-mc-src]"))
    .map((el) => {
      const raw = el.dataset.mcSrc || "";
      const dot = raw.indexOf(".");
      const start = dot === -1 ? NaN : Number(raw.slice(0, dot));
      return Number.isFinite(start) ? { start, el } : null;
    })
    .filter((s): s is { start: number; el: HTMLElement } => s !== null)
    .sort((a, b) => a.start - b.start);
  // Several runs can anchor to the same block; remember the last widget so
  // they stack in document order instead of reversing.
  const lastAt = new Map<Element, Element>();
  const insertAtTop = (widget: HTMLElement): void => {
    const prev = lastAt.get(dom.preview);
    if (prev) prev.insertAdjacentElement("afterend", widget);
    else dom.preview.insertBefore(widget, dom.preview.firstChild);
    lastAt.set(dom.preview, widget);
  };
  for (const run of runs) {
    const widget = buildRemovedWidget(run);
    if (run.afterLine === 0 || spans.length === 0) {
      insertAtTop(widget);
      continue;
    }
    // End offset of the anchor line: the widget belongs after the block
    // holding that offset, or after the last block before it.
    const anchorOffset =
      run.afterLine < lineStarts.length ? lineStarts[run.afterLine] - 1 : prose.length;
    let lo = 0;
    let hi = spans.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid].start <= anchorOffset) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx === -1) {
      insertAtTop(widget);
      continue;
    }
    const block = topLevelBlock(spans[idx].el);
    if (!block) {
      insertAtTop(widget);
      continue;
    }
    (lastAt.get(block) ?? block).insertAdjacentElement("afterend", widget);
    lastAt.set(block, widget);
  }
}

function buildRemovedWidget(run: DiffRemovedRun): HTMLElement {
  const div = document.createElement("div");
  div.className = "mc-diff-removed";
  const label = document.createElement("div");
  label.className = "mc-diff-removed-label";
  const n = run.text.split("\n").length;
  label.textContent = `removed — this was in HEAD (${n} line${n === 1 ? "" : "s"})`;
  const pre = document.createElement("pre");
  pre.className = "mc-diff-removed-text";
  pre.textContent = run.text;
  div.append(label, pre);
  return div;
}

function renderDiffBadge(diff: DiffState | null): void {
  const badge = document.getElementById("diff-mode-badge");
  if (!badge) return;
  badge.hidden = diff === null;
  if (!diff) return;
  badge.textContent = diff.isNew
    ? "new file — uncommitted"
    : diff.addedRanges.length === 0 && (diff.removed ?? []).length === 0
      ? "no uncommitted prose changes"
      : "uncommitted changes";
}

/**
 * A block whose line the map doesn't cover gets no number rather than a guess:
 * a push can race a keystroke, and a confidently wrong line number is worse
 * than a missing one.
 */
function paintLineNumbers(lineMap: number[]): void {
  for (const el of Array.from(dom.preview.querySelectorAll<HTMLElement>(`[${LINE_ATTR}]`))) {
    const proseLine = Number(el.getAttribute(LINE_ATTR));
    const src = Number.isFinite(proseLine) ? displayLine(lineMap, proseLine) : null;
    if (src === null) el.removeAttribute("data-mc-srcline");
    else el.setAttribute("data-mc-srcline", String(src));
  }
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
  // mermaid.run replaces `<pre class="mermaid">` content with an SVG, which isn't
  // selectable, so anchored text inside a mermaid block won't visually highlight
  // (the sidebar card still works).
  try {
    await mermaid.run({ querySelector: "pre.mermaid" });
  } catch (e) {
    console.error("mermaid render failed", e);
  }
}

// Cached by href so frequent preview re-renders reuse a rendered diagram
// instead of re-fetching, and a result arriving after a re-render still paints
// the current placeholders.

interface DrawioReadResult {
  type: "drawio-read-result";
  requestId: string;
  href: string;
  ok: boolean;
  content?: string;
  error?: string;
}
interface DrawioEntry { status: "pending" | "ready" | "error"; svg?: SVGSVGElement; error?: string; }
const drawioCache = new Map<string, DrawioEntry>();
const drawioPending = new Map<string, string>(); // requestId -> href
let drawioReqCounter = 0;

function processDrawioPlaceholders(): void {
  for (const el of Array.from(dom.preview.querySelectorAll<HTMLElement>(".mc-drawio[data-drawio-href]"))) {
    const href = el.dataset.drawioHref ?? "";
    const cached = drawioCache.get(href);
    if (cached?.status === "ready" && cached.svg) { paintDrawio(el, cached.svg); continue; }
    if (cached?.status === "error") { paintDrawioError(el, cached.error); continue; }
    if (cached?.status === "pending") continue; // request in flight — repaints on result
    drawioCache.set(href, { status: "pending" });
    const requestId = `drawio-${++drawioReqCounter}`;
    drawioPending.set(requestId, href);
    vscode.postMessage({ type: "drawio-read", requestId, href });
  }
}

function handleDrawioResult(msg: DrawioReadResult): void {
  const href = drawioPending.get(msg.requestId) ?? msg.href;
  drawioPending.delete(msg.requestId);
  if (!msg.ok || typeof msg.content !== "string") {
    drawioCache.set(href, { status: "error", error: msg.error ?? "Could not load diagram." });
    repaintDrawio(href);
    return;
  }
  void (async () => {
    try {
      const { renderDrawioToSvg } = await import("../../webview/drawioRenderer");
      const result = await renderDrawioToSvg(msg.content!);
      drawioCache.set(
        href,
        result.ok ? { status: "ready", svg: result.svg } : { status: "error", error: result.message },
      );
    } catch (e) {
      drawioCache.set(href, { status: "error", error: (e as Error).message });
    }
    repaintDrawio(href);
  })();
}

function repaintDrawio(href: string): void {
  const entry = drawioCache.get(href);
  if (!entry) return;
  for (const el of Array.from(dom.preview.querySelectorAll<HTMLElement>(".mc-drawio[data-drawio-href]"))) {
    if ((el.dataset.drawioHref ?? "") !== href) continue;
    if (entry.status === "ready" && entry.svg) paintDrawio(el, entry.svg);
    else if (entry.status === "error") paintDrawioError(el, entry.error);
  }
}

function paintDrawio(el: HTMLElement, svg: SVGSVGElement): void {
  el.classList.add("ready");
  el.classList.remove("error");
  // Clone — one cached SVG element may paint several placeholders (and fresh
  // ones after each preview re-render); a node can only live in one parent.
  el.replaceChildren(svg.cloneNode(true));
}

function paintDrawioError(el: HTMLElement, error?: string): void {
  el.classList.add("error");
  el.classList.remove("ready");
  el.textContent = `⚠ Diagram failed to load${error ? `: ${error}` : ""}`;
}

interface ProseSpan {
  el: HTMLElement;
  proseStart: number;
  proseEnd: number;
}

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
 * Because span boundaries align with source-offset boundaries exactly, a
 * single mark per span suffices.
 */
function applyAnchorHighlights(state: SerializedState): void {
  const spans = collectProseSpans();
  for (const t of state.threads) {
    if (!t.anchor) continue;
    // Highlights follow the sidebar filter — a thread the list doesn't show
    // shouldn't paint a span in the preview either.
    if (!matchesFilter(t, filter)) continue;
    for (const span of spans) {
      const start = Math.max(span.proseStart, t.anchor.proseStart);
      const end = Math.min(span.proseEnd, t.anchor.proseEnd);
      if (start >= end) continue;
      wrapSpanRange(span, start - span.proseStart, end - span.proseStart, t.id, t.status);
    }
  }
  // Mark each anchored suggestion's original text so the change location is
  // visible in the preview. Uses fresh spans because the thread pass above
  // mutates text nodes (a mark splits a span into before/mark/after).
  for (const s of state.suggestions) {
    if (!s.anchor) continue;
    for (const span of collectProseSpans()) {
      const start = Math.max(span.proseStart, s.anchor.proseStart);
      const end = Math.min(span.proseEnd, s.anchor.proseEnd);
      if (start >= end) continue;
      wrapSpanRange(span, start - span.proseStart, end - span.proseStart, "", "open", s.anchorId);
    }
  }
}

/**
 * Offsets are over the span's *concatenated* text, so the walk covers every
 * text node under the span: a paragraph with two comments gets marked twice,
 * and the second mark lands in whatever node the first one split off. Text
 * already inside a `<mark>` still counts toward the offsets but is never
 * wrapped again — nested highlights would render as a single darker blob.
 */
function wrapSpanRange(
  span: ProseSpan,
  textStart: number,
  textEnd: number,
  threadId: string,
  status: "open" | "resolved",
  suggestionId?: string,
): void {
  const el = span.el;
  // Collect the nodes BEFORE mutating: splitting a text node while a
  // TreeWalker is live would revisit the pieces we just created.
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);

  const slices = planHighlightSlices(
    nodes.map((node) => ({ length: node.data.length, inMark: isInsideMark(node, el) })),
    textStart,
    textEnd,
  );

  for (const slice of slices) {
    const mark = buildHighlightMark(threadId, status, suggestionId);
    // splitText leaves the pieces in place, so surrounding text keeps its order.
    const rest = nodes[slice.index].splitText(slice.from);
    rest.splitText(slice.to - slice.from);
    mark.textContent = rest.data;
    rest.parentNode?.replaceChild(mark, rest);
  }
}

function isInsideMark(node: Node, root: HTMLElement): boolean {
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
    if ((p as HTMLElement).tagName === "MARK") return true;
  }
  return false;
}

function buildHighlightMark(
  threadId: string,
  status: "open" | "resolved",
  suggestionId?: string,
): HTMLElement {
  const mark = document.createElement("mark");
  if (suggestionId) {
    mark.className = "mc-hl mc-hl--suggestion";
    mark.dataset.suggestionId = suggestionId;
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = dom.threadsList.querySelector<HTMLElement>(
        `[data-suggestion-id="${cssEscape(suggestionId)}"]`,
      );
      if (card) smoothScrollIntoView(card, "center");
    });
  } else {
    mark.className = `mc-hl ${status === "resolved" ? "mc-hl-resolved" : ""}`;
    mark.dataset.thread = threadId;
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      highlightedThreadId = threadId;
      scrollSidebarTo(threadId);
      updateHighlightedCardDom(threadId);
    });
  }
  return mark;
}

/**
 * In-progress reply textarea content keyed by thread id. Preserved across
 * re-renders (which fire on every external update, e.g. when the agent's reply
 * lands) so the user doesn't lose their typing mid-sentence; also tracks which
 * thread had the focused textarea so it can be restored.
 */
const pendingReplyText = new Map<string, string>();
let focusedReplyThreadId: string | null = null;

/**
 * Threads whose reply composer is expanded, via the card's Reply button or the
 * `r` key. Collapsed by default so a review with many threads isn't many
 * always-open textareas.
 */
const openReplyThreadIds = new Set<string>();

/** A thread with an unsent draft stays open across a re-render even if the
 * user never explicitly opened it this pass — losing sight of typed text
 * behind a collapsed composer would be worse than the composer being open. */
function replyShouldBeOpen(id: string): boolean {
  return openReplyThreadIds.has(id) || (pendingReplyText.get(id)?.length ?? 0) > 0;
}

function setReplyOpen(id: string, open: boolean, focus: boolean): void {
  if (open) openReplyThreadIds.add(id);
  else openReplyThreadIds.delete(id);
  const card = dom.threadsList.querySelector<HTMLElement>(`.thread-card[data-thread="${cssEscape(id)}"]`);
  const box = card?.querySelector<HTMLElement>(".reply-box");
  const shown = replyShouldBeOpen(id);
  box?.classList.toggle("open", shown);
  card?.querySelector(".thread-reply-toggle")?.setAttribute("aria-expanded", String(shown));
  // Synchronous, not deferred to a frame: the `display` flip above already took
  // effect, and the `r` key handler expects the textarea focused by the time it
  // returns.
  if (shown && focus) box?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

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
  // A per-card "…" menu is about to be torn down with the rest of the list;
  // otherwise `openMenu` would point at a detached panel. The toolbar's menu
  // lives outside `list` and is untouched.
  if (openMenu && list.contains(openMenu.panel)) closeOpenMenu(false);
  list.innerHTML = "";

  // Pending suggestions render above the comment threads, regardless of the
  // comment filter — an unreviewed edit is the most actionable thing here.
  if (state.suggestions.length > 1) list.appendChild(renderAcceptAll(state.suggestions.length));
  for (const s of state.suggestions) {
    list.appendChild(renderSuggestion(s));
  }

  const filtered = filterThreads(state.threads, filter);
  dom.threadCount.textContent = threadCountLabel(state.threads);
  // Offered only when it would do something; its absence says "nothing to clean
  // up" more clearly than a disabled control would.
  const resolvedCount = state.threads.filter((t) => t.status === "resolved").length;
  dom.removeResolved.hidden = resolvedCount === 0;
  dom.removeResolved.textContent = `Remove ${resolvedCount} resolved`;
  dom.finalizeDoc.hidden = state.threads.length === 0 && state.suggestions.length === 0;
  renderClaudeSummary(state);
  if (filtered.length === 0) {
    if (state.suggestions.length === 0) {
      list.appendChild(
        buildEmptyStateEl(
          emptyState({
            filter,
            totalThreads: state.threads.length,
          }),
        ),
      );
    }
    return;
  }
  // Build at most a chunk of cards per pass; the rest arrive on click.
  const chunk = chunkThreads(filtered, renderedThreadLimit);
  for (let i = 0; i < chunk.visible.length; i++) {
    // posinset/setsize are against the full filtered list, not just what's
    // built so far — a screen reader announcing "3 of 300" should say the
    // list's real shape, even though only the first chunk has DOM behind it.
    list.appendChild(renderThreadCard(chunk.visible[i], i + 1, filtered.length));
  }
  if (chunk.moreLabel) {
    const more = document.createElement("button");
    more.className = "btn-ghost mc-show-more";
    more.textContent = chunk.moreLabel;
    more.addEventListener("click", () => {
      renderedThreadLimit += THREAD_RENDER_CHUNK;
      if (currentState) renderThreads(currentState);
    });
    list.appendChild(more);
  }
}

function buildEmptyStateEl(state: EmptyState): HTMLElement {
  if (state.kind === "filtered") {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = state.message;
    return p;
  }
  const card = document.createElement("div");
  card.className = "mc-empty-state";
  const headline = document.createElement("div");
  headline.className = "mc-empty-state__headline";
  headline.textContent = state.headline;
  const hint = document.createElement("div");
  hint.className = "mc-empty-state__hint";
  hint.textContent = state.hint;
  const action = document.createElement("button");
  action.textContent = state.action.label;
  action.addEventListener("click", () => vscode.postMessage(state.action.message));
  card.append(headline, hint, action);
  return card;
}

/** Armed with a two-step confirm because it rewrites the document in one go. */
function renderAcceptAll(count: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "accept-all-row";
  const btn = document.createElement("button");
  btn.className = "btn-ghost";
  btn.textContent = acceptAllArmed ? `Accept all ${count}? Click again` : `Accept all ${count}`;
  if (acceptAllArmed) btn.classList.add("armed");
  btn.title = "Apply every pending suggestion in this file. One undo step.";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (acceptAllArmed) {
      acceptAllArmed = false;
      vscode.postMessage({ type: "accept-all-suggestions" });
      return;
    }
    acceptAllArmed = true;
    // Auto-disarm, so a half-pressed button doesn't sit there waiting to
    // rewrite the file on an unrelated click later.
    setTimeout(() => {
      if (acceptAllArmed) {
        acceptAllArmed = false;
        if (currentState) renderThreads(currentState);
      }
    }, 4000);
    if (currentState) renderThreads(currentState);
  });
  row.appendChild(btn);
  return row;
}

function renderSuggestion(s: SuggestionState): HTMLElement {
  const card = buildSuggestionCard({
    author: s.author,
    timestamp: s.ts,
    note: s.note,
    original: s.original,
    proposed: s.proposed,
    anchored: s.anchor !== null,
    onAccept: () => vscode.postMessage({ type: "accept-suggestion", anchorId: s.anchorId }),
    onReject: () => vscode.postMessage({ type: "reject-suggestion", anchorId: s.anchorId }),
    onClick: s.anchor
      ? () => {
          const mark = dom.preview.querySelector<HTMLElement>(`[data-suggestion-id="${cssEscape(s.anchorId)}"]`);
          if (mark) smoothScrollIntoView(mark, "center");
        }
      : undefined,
  });
  card.dataset.suggestionId = s.anchorId;
  return card;
}

function renderClaudeSummary(state: SerializedState): void {
  const summary = claudeSummary(state.threads);
  dom.claudeSummary.hidden = !summary.hasAny;
  // The "New from <agent>" chip is only relevant when there are agent threads;
  // hide it (and snap filter back to "open") when none exist. Its wording follows
  // `claudeSummary`'s `agentNoun` rule.
  dom.claudeFilterLabel.hidden = !summary.hasAny;
  dom.claudeFilterLabelText.textContent = `New from ${summary.agentNoun}`;
  dom.claudeNext.title = `Jump to the next unread thread from ${summary.agentNoun}. (Cmd/Ctrl+K, Cmd/Ctrl+Alt+N)`;
  if (!summary.hasAny && filter === "claude-unread") {
    filter = "open";
    for (const r of dom.filterRadios) r.checked = r.value === "open";
    updateFilterSegments();
  }
  if (!summary.hasAny) return;
  dom.claudeSummaryText.textContent = summary.text;
  dom.claudeNext.disabled = summary.unread === 0;
}

function renderThreadCard(t: ThreadState, posinset: number, setsize: number): HTMLElement {
  const card = document.createElement("section");
  card.className = "thread-card";
  if (t.status === "resolved") card.classList.add("resolved");
  if (t.id === highlightedThreadId) card.classList.add("highlighted");
  if (isClaudeUnread(t)) card.classList.add("claude-unread");
  if (collapsedThreads.has(t.id)) card.classList.add("collapsed");
  card.dataset.thread = t.id;
  // The list is a `role="feed"`, so each card reads as an article with its
  // position in that feed and a label a screen reader can announce unexpanded.
  card.setAttribute("role", "article");
  card.setAttribute("aria-posinset", String(posinset));
  card.setAttribute("aria-setsize", String(setsize));
  const root = t.comments[0];
  if (root) {
    card.setAttribute("aria-label", `${root.author}: ${root.body.slice(0, 60)}`);
  }
  // Roving tabindex: only the highlighted card is in the Tab order. Before
  // anything is explicitly highlighted, the first card in the feed takes the
  // role instead of leaving the whole feed unreachable by keyboard.
  card.tabIndex = (highlightedThreadId ? t.id === highlightedThreadId : posinset === 1) ? 0 : -1;
  card.addEventListener("click", () => {
    highlightedThreadId = t.id;
    scrollPreviewTo(t);
    // Update only the .highlighted class (and roving tabindex) on cards; do
    // NOT re-render the list, because that would blow away any in-progress
    // reply textarea content the user has typed on a different card.
    updateHighlightedCardDom(t.id);
  });

  const head = document.createElement("header");
  head.className = "thread-head";
  const headRow = document.createElement("div");
  headRow.className = "thread-head-row";
  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "thread-collapse";
  chevron.textContent = collapsedThreads.has(t.id) ? "▸" : "▾";
  chevron.title = "Collapse / expand this thread";
  chevron.setAttribute("aria-label", "Collapse or expand this comment thread");
  chevron.addEventListener("click", (e) => {
    e.stopPropagation();
    setThreadCollapsed(t.id, !collapsedThreads.has(t.id));
  });
  headRow.appendChild(chevron);
  const quote = document.createElement("blockquote");
  quote.className = "thread-quote";
  quote.textContent = t.quote || "(no quote)";
  if (!t.anchor) {
    const badge = document.createElement("span");
    badge.className = "badge broken";
    badge.textContent = "broken anchor";
    badge.title = "Anchor marker missing from prose. Fix by re-anchoring.";
    quote.appendChild(badge);
  } else if (t.stale) {
    // Only when the anchor is intact: a broken anchor is already the louder
    // problem, and two badges about one failure is noise.
    const badge = document.createElement("span");
    badge.className = "badge stale";
    badge.textContent = "text changed";
    badge.title =
      "The anchored passage was edited after the last comment on this thread — the comment may be answering text that is no longer there.";
    quote.appendChild(badge);
  }
  headRow.appendChild(quote);
  head.appendChild(headRow);

  // Visible per-card actions: Reply, Resolve/Reopen and Send. Every other
  // per-thread action lives in the "…" menu below — a thirty-thread review
  // would otherwise put six equal-weight buttons on every one of them.
  const actions = document.createElement("div");
  actions.className = "thread-actions";

  const replyOpenNow = replyShouldBeOpen(t.id);
  const replyToggleBtn = document.createElement("button");
  replyToggleBtn.type = "button";
  replyToggleBtn.className = "btn-ghost thread-reply-toggle";
  replyToggleBtn.textContent = "Reply";
  replyToggleBtn.setAttribute("aria-expanded", String(replyOpenNow));
  replyToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setReplyOpen(t.id, !replyShouldBeOpen(t.id), true);
  });

  const resolveBtn = document.createElement("button");
  resolveBtn.className = "btn-ghost";
  resolveBtn.textContent = t.status === "resolved" ? "Reopen" : "Resolve";
  resolveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "toggle-resolve", threadId: t.id });
  });

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "btn-ghost thread-send";
  sendBtn.textContent = "Send";
  sendBtn.title = `Send this thread to ${agentName}`;
  sendBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "send-to-claude-comment", threadId: t.id });
  });

  const menuWrap = document.createElement("span");
  menuWrap.className = "mc-menu-wrap";
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "btn-ghost thread-menu-btn";
  menuBtn.textContent = "…";
  menuBtn.title = "More thread actions";
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.setAttribute("aria-label", "More actions for this thread");
  const menu = document.createElement("div");
  menu.className = "mc-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenuAt(menuBtn, menu);
  });

  const openInEditorItem = buildMenuItem("Open in editor", () => {
    vscode.postMessage({ type: "open-in-editor", threadId: t.id });
    closeOpenMenu(false);
  });
  const copyThreadItem = buildMenuItem("Copy prompt", () => {
    vscode.postMessage({ type: "copy-claude-comment", threadId: t.id });
    closeOpenMenu(false);
  });
  // Two-click confirm, armed in place (no re-render) so the open menu stays
  // open across the arm step — the existing auto-disarm still applies.
  const deleteItem = buildMenuItem(
    pendingDeleteThread.has(t.id) ? "Confirm delete" : "Delete",
    () => {
      if (pendingDeleteThread.has(t.id)) {
        pendingDeleteThread.delete(t.id);
        vscode.postMessage({ type: "delete-thread", threadId: t.id });
        closeOpenMenu(false);
        return;
      }
      pendingDeleteThread.add(t.id);
      deleteItem.textContent = "Confirm delete";
      // Auto-disarm after a few seconds so a stale "Confirm delete"
      // item doesn't sit there waiting to bite.
      setTimeout(() => {
        if (pendingDeleteThread.delete(t.id) && deleteItem.isConnected) {
          deleteItem.textContent = "Delete";
        }
      }, 4000);
    },
    { danger: true },
  );
  menu.append(openInEditorItem, copyThreadItem, deleteItem);
  menuWrap.append(menuBtn, menu);

  actions.append(replyToggleBtn, resolveBtn, sendBtn, menuWrap);
  head.appendChild(actions);
  card.appendChild(head);

  // "Claude is working…" hangs off the last comment, where the reply will
  // land — the wait belongs to this thread, not to the panel as a whole.
  const awaitingClaude = pendingThreadIds.has(t.id);
  const lastLive = [...t.comments].reverse().find((c) => !c.deleted);
  for (const c of t.comments) {
    card.appendChild(renderComment(t, c, awaitingClaude && c === lastLive));
  }
  if (awaitingClaude) card.classList.add("awaiting-claude");

  // Reply composer. Stop click propagation on the box and its children so
  // clicking inside doesn't bubble to the card's click handler (which would
  // re-highlight the thread and re-render, wiping the text just typed).
  // Collapsed until Reply is clicked or `r` is pressed on the highlighted card;
  // a non-empty draft stays open across a re-render (`replyShouldBeOpen`).
  const replyBox = document.createElement("div");
  replyBox.className = replyOpenNow ? "reply-box open" : "reply-box";
  replyBox.addEventListener("click", (e) => e.stopPropagation());
  replyBox.addEventListener("mousedown", (e) => e.stopPropagation());
  const composer = buildComposer({
    placeholder: "Reply…",
    submitLabel: "Reply",
    rows: 2,
    // Restore in-progress text captured before the most recent re-render.
    initialValue: pendingReplyText.get(t.id) ?? "",
    // The composer opens (and focuses) through `setReplyOpen`, not on mount.
    autofocus: false,
    onSubmit: (body) => {
      vscode.postMessage({ type: "reply", threadId: t.id, body });
      composer.textarea.value = "";
      pendingReplyText.delete(t.id);
      setReplyOpen(t.id, false, false);
    },
  });
  // Persist what's typed so a re-render (e.g. highlight refresh) doesn't lose it.
  composer.textarea.addEventListener("input", () => {
    const v = composer.textarea.value;
    if (v.length === 0) pendingReplyText.delete(t.id);
    else pendingReplyText.set(t.id, v);
  });
  replyBox.appendChild(composer.el);
  card.appendChild(replyBox);
  if (focusedReplyThreadId === t.id) {
    requestAnimationFrame(() => {
      composer.textarea.focus();
      composer.textarea.selectionStart = composer.textarea.selectionEnd = composer.textarea.value.length;
    });
    focusedReplyThreadId = null;
  }

  return card;
}

/**
 * Human comments never get a marker. An unrecognized `via` reads the same as
 * absent — "via file" — a safe guess: it just means "not through the tools or
 * `mdc`", true of anything hand-edited.
 */
function viaMarker(c: InlineComment): { label: string; title: string } | undefined {
  if (!isAgentComment(c)) return undefined;
  const kind: "tools" | "cli" | "file" = c.via === "tools" || c.via === "cli" ? c.via : "file";
  const title = {
    tools: "The agent wrote this through the review tools (MCP), not by hand-editing the file.",
    cli: "The agent wrote this through the `mdc` command-line tool.",
    file: "The agent edited the file's text directly — not through the review tools or `mdc`.",
  }[kind];
  return { label: `via ${kind}`, title };
}

function renderComment(thread: ThreadState, c: InlineComment, pending = false): HTMLElement {
  if (c.deleted) {
    const card = buildCommentCard({
      author: c.author,
      timestamp: c.ts,
      via: viaMarker(c),
      body: "(comment deleted)",
      reply: !!c.parent,
    });
    card.classList.add("tombstone");
    return card;
  }

  const editingKey = `${thread.id}:${c.id}`;
  if (editingCommentId === editingKey) {
    const composer = buildComposer({
      initialValue: c.body,
      submitLabel: "Save",
      rows: Math.max(2, Math.min(8, c.body.split("\n").length)),
      autofocus: false,
      onSubmit: (body) => {
        vscode.postMessage({ type: "edit-comment", threadId: thread.id, commentId: c.id, body });
        editingCommentId = null;
      },
      onCancel: () => {
        editingCommentId = null;
        renderThreads(currentState!);
      },
    });
    return buildCommentCard({
      author: c.author,
      timestamp: c.ts,
      note: c.editedTs ? "edited" : undefined,
      via: viaMarker(c),
      bodyEl: composer.el,
      reply: !!c.parent,
    });
  }

  // Full markdown, not `renderInline`: a reply with a bulleted list or a
  // fenced code block is the normal case, and inline rendering showed both as
  // a run-on line.
  const bodyEl = buildCommentBody(c.body);

  const cmtKey = editingKey;
  const cmtArmed = pendingDeleteComment.has(cmtKey);
  const actions: CardAction[] = [
    {
      label: "Edit",
      onClick: () => {
        editingCommentId = editingKey;
        renderThreads(currentState!);
      },
    },
    {
      label: cmtArmed ? "Confirm" : "Delete",
      variant: "danger",
      onClick: () => {
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
      },
    },
  ];
  if (cmtArmed) {
    actions.push({
      label: "Cancel",
      onClick: () => {
        pendingDeleteComment.delete(cmtKey);
        renderThreads(currentState!);
      },
    });
  }

  return buildCommentCard({
    author: c.author,
    timestamp: c.ts,
    note: c.editedTs ? "edited" : undefined,
    via: viaMarker(c),
    bodyEl,
    reply: !!c.parent,
    actions,
    pending,
    pendingLabel: pendingLabelText,
    pendingAriaLive: true,
  });
}

function scrollSidebarTo(id: string): void {
  const el = dom.threadsList.querySelector<HTMLElement>(`[data-thread="${id}"]`);
  if (el) smoothScrollIntoView(el, "center");
}

function scrollPreviewTo(t: ThreadState): void {
  if (!t.anchor) return;
  const el = dom.preview.querySelector<HTMLElement>(`mark[data-thread="${t.id}"]`);
  if (el) {
    smoothScrollIntoView(el, "center");
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
  // Refuse selections inside a code block: the parser strips anchor markers in
  // code regions, so the thread would be orphaned.
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
 * Returns null when the endpoint isn't inside a tagged span — by design in code
 * blocks (anchors there are stripped by the parser, so they aren't annotated at
 * char granularity) or in markup markdown-it adds without a token (e.g. table
 * structural cells with no inline children).
 */
function endpointToProse(node: Node, offset: number, which: "start" | "end"): number | null {
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
 * For an element-node endpoint whose nearest `[data-mc-src]` ancestor is the
 * preview itself (between block elements): the adjacent tagged span — previous
 * one for END, next for START — so selecting whole blocks still yields a usable
 * range. Null when no such neighbor exists.
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
  const composer = buildComposer({
    meta: "New comment",
    placeholder: "Leave a comment… (Cmd/Ctrl+Enter to submit)",
    submitLabel: "Comment",
    rows: 4,
    onSubmit: (body) => {
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
    },
    onCancel: () => {
      dom.composer.hidden = true;
    },
  });
  dom.composer.appendChild(composer.el);
}

dom.previewPane.addEventListener("scroll", () => syncOutlineActive(), { passive: true });
document.addEventListener("selectionchange", () => positionFloatingButton());
window.addEventListener("scroll", () => positionFloatingButton(), true);

dom.filterRadios.forEach((r) =>
  r.addEventListener("change", () => {
    filter = (r.value as typeof filter);
    updateFilterSegments();
    // A different filter is a different list — start its render budget over
    // rather than carrying a limit the user raised for the previous one.
    renderedThreadLimit = THREAD_RENDER_CHUNK;
    if (currentState) render(currentState);
  }),
);
updateFilterSegments();

window.addEventListener("message", (ev) => {
  const msg = ev.data as InitMsg | UpdateMsg | ReviewPendingMsg | ScrollToMsg | DrawioReadResult | SkillStatusMsg;
  if (!msg) return;
  if (msg.type === "drawio-read-result") {
    handleDrawioResult(msg);
    return;
  }
  if (msg.type === "init") {
    user = msg.user;
    imageBaseUris = msg.imageBaseUris;
    ensurePlantumlInstalled(msg.plantuml);
    renderSkillWarning(msg.skillStatus);
    updateSuggestModeToggle(msg.suggestMode ?? false);
    pendingThreadIds = new Set(msg.pendingThreadIds ?? []);
    agentName = msg.agentName || "Claude";
    updateAgentUi();
    pendingLabelText = msg.pendingLabel ?? `${agentName} is working…`;
    currentDiff = msg.diff ?? null;
    render(msg.state);
  } else if (msg.type === "update") {
    updateSuggestModeToggle(msg.suggestMode ?? false);
    pendingThreadIds = new Set(msg.pendingThreadIds ?? []);
    agentName = msg.agentName || "Claude";
    updateAgentUi();
    pendingLabelText = msg.pendingLabel ?? `${agentName} is working…`;
    currentDiff = msg.diff ?? null;
    render(msg.state);
  } else if (msg.type === "review-pending") {
    pendingReviewSnapshot = new Set(msg.existingIds);
    savePendingReviewSnapshot();
  } else if (msg.type === "scroll-to") {
    scrollPreviewToProseOffset(msg.proseOffset);
  } else if (msg.type === "skill-status") {
    renderSkillWarning(msg.status);
  }
});

/** Defers one frame so it works when fired right after init, before the preview is painted. */
function scrollPreviewToProseOffset(proseOffset: number): void {
  requestAnimationFrame(() => {
    const spans = dom.preview.querySelectorAll<HTMLElement>("[data-mc-src]");
    let best: HTMLElement | null = null;
    let bestStart = -1;
    for (const el of Array.from(spans)) {
      const raw = el.dataset.mcSrc;
      if (!raw) continue;
      const dot = raw.indexOf(".");
      if (dot === -1) continue;
      const start = Number(raw.slice(0, dot));
      const end = Number(raw.slice(dot + 1));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      // Prefer the first span that *contains* the offset. Fall back to
      // the closest one that starts at or after the offset.
      if (start <= proseOffset && proseOffset < end) {
        best = el;
        break;
      }
      if (start >= proseOffset && (bestStart === -1 || start < bestStart)) {
        best = el;
        bestStart = start;
      }
    }
    if (!best) return;
    smoothScrollIntoView(best, "start");
  });
}

void user; // silence unused

vscode.postMessage({ type: "ready" });
