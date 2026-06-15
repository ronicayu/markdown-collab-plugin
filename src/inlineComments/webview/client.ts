// Webview client for the inline-comments view (default storage in v0.27+).
//
// Renders the .md prose (with mc:* markup stripped) via markdown-it,
// overlays a highlight on each anchored span, and runs a sidebar of
// threads with add/reply/edit/resolve/delete UI. All state mutations
// round-trip through the extension host as `WorkspaceEdit`s on the
// underlying .md file — there is no in-webview cache of comments.

import MarkdownIt from "markdown-it";
import { isClaudeReviewed, isClaudeUnread } from "../claudeUnread";
import { slugifyHeading } from "../linkParse";
import { buildComposer, buildCommentCard, type CardAction } from "../../webviewShared/commentUi";
import { installSourceOffsetPlugin } from "./renderWithOffsets";
import { installPlantumlPlugin } from "../../plantumlPlugin";

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
  imageBaseUris: {
    docDir: string;
    workspaceFolder: string | null;
  };
  plantuml?: { serverUrl: string; format: "svg" | "png" };
  skillStatus?: SkillStatus;
}

type SkillStatus = "missing" | "outdated" | "current";

interface SkillStatusMsg {
  type: "skill-status";
  status: SkillStatus;
}

interface UpdateMsg {
  type: "update";
  state: SerializedState;
}

interface ReviewPendingMsg {
  type: "review-pending";
  existingIds: string[];
}

interface ScrollToMsg {
  type: "scroll-to";
  proseOffset: number;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
installSourceOffsetPlugin(md);
let plantumlInstalled = false;
function ensurePlantumlInstalled(opts: { serverUrl: string; format: "svg" | "png" } | undefined): void {
  if (plantumlInstalled || !opts) return;
  installPlantumlPlugin(md, opts);
  plantumlInstalled = true;
}

let imageBaseUris: { docDir: string; workspaceFolder: string | null } = {
  docDir: "",
  workspaceFolder: null,
};

// Override markdown-it's default image renderer so relative `src`
// attributes resolve against the .md file's directory (turned into a
// webview-loadable URI by the extension host). Without this every
// `![alt](foo.png)` 404s against the webview's own vscode-webview://
// origin.
const defaultImageRule = md.renderer.rules.image ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const tok = tokens[idx];
  const srcIdx = tok.attrIndex("src");
  if (srcIdx >= 0 && tok.attrs) {
    const original = tok.attrs[srcIdx][1];
    if (isDrawioSrc(original)) {
      // .drawio files aren't a browser image format. Emit a placeholder;
      // processDrawioPlaceholders() asks the host for the XML and renders
      // it to an inline SVG. Carry the original href + alt for the swap.
      const alt = tok.children ? self.renderInlineAsText(tok.children, options, env) : "";
      return `<span class="mc-drawio" data-drawio-href="${md.utils.escapeHtml(original)}" title="${md.utils.escapeHtml(alt)}">Loading diagram…</span>`;
    }
    const resolved = resolveImageSrc(original);
    if (resolved !== original) tok.attrs[srcIdx][1] = resolved;
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

/** True for hrefs a browser can't render as an image but the host can read + render. */
function isDrawioSrc(src: string): boolean {
  const clean = (src || "").split(/[?#]/)[0].toLowerCase();
  return clean.endsWith(".drawio") || clean.endsWith(".drawio.xml") || clean.endsWith(".xml");
}

/**
 * Map a markdown image src to something the webview can load:
 *   - `http://`, `https://`, `data:` → unchanged (CSP allows them)
 *   - leading `/` → resolved against the workspace folder
 *   - everything else → resolved against the .md's directory
 *   - empty / undefined → unchanged
 */
function resolveImageSrc(src: string): string {
  if (!src) return src;
  if (/^(https?:|data:|vscode-webview-resource:|vscode-webview:|file:)/i.test(src)) return src;
  if (src.startsWith("//")) return "https:" + src;
  const cleaned = src.replace(/^\.\//, "");
  if (cleaned.startsWith("/")) {
    if (!imageBaseUris.workspaceFolder) return src;
    return joinUri(imageBaseUris.workspaceFolder, cleaned.slice(1));
  }
  if (!imageBaseUris.docDir) return src;
  return joinUri(imageBaseUris.docDir, cleaned);
}

function joinUri(base: string, rel: string): string {
  // Best-effort URI join: strip any trailing slash on base, then split
  // off `?query`/`#hash` so we don't merge them with the path.
  const m = /^([^?#]*)([?#].*)?$/.exec(rel);
  const path = m ? m[1] : rel;
  const tail = m && m[2] ? m[2] : "";
  const segments = path.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(encodeURIComponent(seg));
  }
  return base.replace(/\/+$/, "") + "/" + out.join("/") + tail;
}

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
  findBar: document.getElementById("find-bar") as HTMLElement,
  findInput: document.getElementById("find-input") as HTMLInputElement,
  findCount: document.getElementById("find-count") as HTMLElement,
  findPrev: document.getElementById("find-prev") as HTMLButtonElement,
  findNext: document.getElementById("find-next") as HTMLButtonElement,
  findClose: document.getElementById("find-close") as HTMLButtonElement,
};

// Thread IDs the user has collapsed (folded to just the quote). Persisted so
// the choice survives a webview reload.
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
 * Set when the user fires "Ask Claude to Review This Doc". Holds the
 * thread IDs that existed at the time of the dispatch. On the next
 * render where new claude-unread threads appear (i.e. Claude's reply
 * has landed and the file was reloaded), we auto-scroll to the first
 * new one and clear the snapshot. Survives webview reloads via state.
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

// Sidebar collapse state. Persisted across messages via vscode.setState so
// the user's preference survives a webview reload.
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

// ---------------------------------------------------------------------------
// Find-in-preview
// ---------------------------------------------------------------------------
// Scoped find for the rendered prose. Walks text nodes inside #preview,
// wraps matches in <mark class="mc-search">, tracks them as `findMatches`,
// and lets the user step through with Enter / Shift+Enter / buttons.
//
// State is cleared whenever the preview re-renders (handled in the message
// update path) so stale <mark> nodes don't survive a state change.

let findMatches: HTMLElement[] = [];
let findIndex = -1;

function findOpen(): void {
  dom.findBar.hidden = false;
  dom.findInput.focus();
  dom.findInput.select();
}

function findClose(): void {
  dom.findBar.hidden = true;
  findClear();
  dom.findInput.value = "";
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
  const total = findMatches.length;
  const query = dom.findInput.value;
  if (!query) {
    dom.findCount.textContent = "";
    dom.findCount.classList.remove("empty");
    return;
  }
  if (total === 0) {
    dom.findCount.textContent = "No results";
    dom.findCount.classList.add("empty");
    return;
  }
  dom.findCount.textContent = `${findIndex + 1} / ${total}`;
  dom.findCount.classList.remove("empty");
}

function findRun(): void {
  findClear();
  const query = dom.findInput.value;
  if (!query) return;
  const needle = query.toLowerCase();
  const root = dom.preview;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text inside SVG (mermaid diagrams) — wrapping their text
      // nodes in <mark> breaks the rendered diagram.
      let p: Node | null = node.parentNode;
      while (p && p !== root) {
        const name = (p as Element).nodeName;
        if (name === "SVG" || name === "STYLE" || name === "SCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentNode;
      }
      return (node.textContent ?? "").toLowerCase().includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let n: Node | null = walker.nextNode();
  while (n) {
    targets.push(n as Text);
    n = walker.nextNode();
  }

  for (const textNode of targets) {
    const text = textNode.textContent ?? "";
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let pos = 0;
    while (pos < text.length) {
      const hit = lower.indexOf(needle, pos);
      if (hit === -1) {
        frag.appendChild(document.createTextNode(text.slice(pos)));
        break;
      }
      if (hit > pos) frag.appendChild(document.createTextNode(text.slice(pos, hit)));
      const mark = document.createElement("mark");
      mark.className = "mc-search";
      mark.textContent = text.slice(hit, hit + needle.length);
      frag.appendChild(mark);
      findMatches.push(mark);
      pos = hit + needle.length;
    }
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
  if (scroll) cur.scrollIntoView({ block: "center", behavior: "smooth" });
}

function findStep(delta: number): void {
  if (findMatches.length === 0) return;
  findIndex = (findIndex + delta + findMatches.length) % findMatches.length;
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
  // Cmd+F (macOS) / Ctrl+F (others) opens the find bar. The webview
  // doesn't expose VS Code's editor find widget, so we own this shortcut.
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
});

dom.skillInstall.addEventListener("click", () => {
  dom.skillInstall.disabled = true;
  dom.skillInstall.textContent = "Installing…";
  vscode.postMessage({ type: "install-skill" });
});

/**
 * Show / hide the "skill out of date" banner. `current` hides it; `outdated`
 * and `missing` show a one-line warning with an install button.
 */
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

// Intercept anchor clicks inside the rendered preview. Without this
// markdown links are inert (the webview sandbox swallows navigation).
// Same-doc `#fragment` links scroll within the preview; everything else
// is handed to the extension host for resolution + opening. Document-level so
// links inside comment bodies are routed the same way — otherwise a comment
// link (a `#section` or a relative `other.md`) falls through to the webview's
// default and gets treated as an external web link.
document.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!target) return;
  const href = target.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  // Fragment-only links jump within the rendered preview by id. The
  // markdown-it default renderer doesn't emit anchor ids on headings,
  // so we fall back to text-matching when no element matches by id.
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
  // 1. Try exact id match (in case anything in the preview has ids).
  const byId = dom.preview.querySelector<HTMLElement>(`[id="${cssEscape(decoded)}"]`);
  if (byId) {
    byId.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // 2. Match by slug against every heading in the preview.
  const headings = dom.preview.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6");
  for (const h of Array.from(headings)) {
    if (slugifyHeading(h.textContent || "") === decoded) {
      h.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}


// "Collapse all" / "Expand all" — operates on every thread, and its label
// reflects whether they're all currently collapsed.
function updateCollapseAllLabel(): void {
  const threads = currentState?.threads ?? [];
  const allCollapsed = threads.length > 0 && threads.every((t) => collapsedThreads.has(t.id));
  dom.collapseAll.textContent = allCollapsed ? "Expand all" : "Collapse all";
  dom.collapseAll.disabled = threads.length === 0;
}
// Fold/unfold a single thread in place (no re-render, so an in-progress reply
// textarea on another card isn't wiped).
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
  const collapse = !(threads.length > 0 && threads.every((t) => collapsedThreads.has(t.id)));
  for (const t of threads) setThreadCollapsed(t.id, collapse);
});

dom.claudeNext.addEventListener("click", () => {
  if (!currentState) return;
  const unread = currentState.threads.filter(isClaudeUnread);
  if (unread.length === 0) return;
  const currentIdx = highlightedThreadId
    ? unread.findIndex((t) => t.id === highlightedThreadId)
    : -1;
  const nextIdx = (currentIdx + 1) % unread.length;
  const target = unread[nextIdx];
  highlightedThreadId = target.id;
  // Scroll the card into view, then scroll the preview to the anchor.
  const card = dom.threadsList.querySelector<HTMLElement>(
    `.thread-card[data-thread="${cssEscape(target.id)}"]`,
  );
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    for (const c of dom.threadsList.querySelectorAll<HTMLElement>(".thread-card")) {
      c.classList.toggle("highlighted", c.dataset.thread === target.id);
    }
  }
  scrollPreviewTo(target);
});

function cssEscape(s: string): string {
  // Thread ids are 5-char base36, no need for full CSS.escape support.
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

let currentState: SerializedState | null = null;
let user: { name: string } = { name: "anonymous" };
let filter: "open" | "all" | "resolved" | "claude-unread" = "open";
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
  highlightedThreadId = target.id;
  // Clear the snapshot first so re-entry doesn't loop on subsequent updates.
  pendingReviewSnapshot = null;
  savePendingReviewSnapshot();
  // Defer one frame so the freshly-rendered card is in the DOM.
  requestAnimationFrame(() => {
    const card = dom.threadsList.querySelector<HTMLElement>(
      `.thread-card[data-thread="${cssEscape(target.id)}"]`,
    );
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      for (const c of dom.threadsList.querySelectorAll<HTMLElement>(".thread-card")) {
        c.classList.toggle("highlighted", c.dataset.thread === target.id);
      }
    }
    scrollPreviewTo(target);
  });
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

// --- drawio diagrams ------------------------------------------------------
// `.drawio` files aren't a browser image format. The host reads the XML and
// we render it to an inline SVG here. Cache by href so frequent preview
// re-renders reuse a rendered diagram instead of re-fetching, and so a result
// arriving after a re-render still paints the current placeholders.

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
    if (filter === "claude-unread" && !isClaudeUnread(t)) continue;
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
    if (filter === "claude-unread") return isClaudeUnread(t);
    return true;
  });
  const totalOpen = state.threads.filter((t) => t.status === "open").length;
  dom.threadCount.textContent = `${totalOpen} open · ${state.threads.length} total`;
  renderClaudeSummary(state);
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      filter === "open"
        ? "No open comments. Select text in the preview to start a thread."
        : filter === "claude-unread"
          ? "No unread threads from Claude. Run 'Ask Claude to Review This Doc' to start one."
          : "No comments match this filter.";
    list.appendChild(empty);
    return;
  }
  for (const t of filtered) {
    list.appendChild(renderThreadCard(t));
  }
}

function renderClaudeSummary(state: SerializedState): void {
  let unread = 0;
  let reviewed = 0;
  for (const t of state.threads) {
    if (isClaudeUnread(t)) unread++;
    else if (isClaudeReviewed(t)) reviewed++;
  }
  const hasAny = unread + reviewed > 0;
  dom.claudeSummary.hidden = !hasAny;
  // The "New from Claude" filter chip is only relevant when there are
  // Claude threads to look at. Hide it (and snap filter back to "open")
  // when none exist so the chip doesn't sit there in dead state.
  dom.claudeFilterLabel.hidden = !hasAny;
  if (!hasAny && filter === "claude-unread") {
    filter = "open";
    for (const r of dom.filterRadios) r.checked = r.value === "open";
  }
  if (!hasAny) return;
  const unreadLabel = unread === 1 ? "1 new from Claude" : `${unread} new from Claude`;
  const reviewedLabel = reviewed === 1 ? "1 reviewed" : `${reviewed} reviewed`;
  dom.claudeSummaryText.textContent = `${unreadLabel} · ${reviewedLabel}`;
  dom.claudeNext.disabled = unread === 0;
}

function renderThreadCard(t: ThreadState): HTMLElement {
  const card = document.createElement("section");
  card.className = "thread-card";
  if (t.status === "resolved") card.classList.add("resolved");
  if (t.id === highlightedThreadId) card.classList.add("highlighted");
  if (isClaudeUnread(t)) card.classList.add("claude-unread");
  if (collapsedThreads.has(t.id)) card.classList.add("collapsed");
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
  }
  headRow.appendChild(quote);
  head.appendChild(headRow);

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
  const sendClaudeBtn = document.createElement("button");
  sendClaudeBtn.className = "btn-ghost";
  sendClaudeBtn.textContent = "→ Claude";
  sendClaudeBtn.title = "Send the whole thread (all comments + replies) to Claude";
  sendClaudeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "send-to-claude-comment", threadId: t.id });
  });
  const copyClaudeBtn = document.createElement("button");
  copyClaudeBtn.className = "btn-ghost";
  copyClaudeBtn.textContent = "Copy";
  copyClaudeBtn.title = "Copy this thread's prompt to clipboard";
  copyClaudeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "copy-claude-comment", threadId: t.id });
  });
  actions.append(sendClaudeBtn, copyClaudeBtn, resolveBtn, deleteBtn);
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
  const composer = buildComposer({
    placeholder: "Reply…",
    submitLabel: "Reply",
    rows: 2,
    // Restore in-progress text captured before the most recent re-render.
    initialValue: pendingReplyText.get(t.id) ?? "",
    // Always-on reply box — don't grab focus on every thread re-render.
    autofocus: false,
    onSubmit: (body) => {
      vscode.postMessage({ type: "reply", threadId: t.id, body });
      composer.textarea.value = "";
      pendingReplyText.delete(t.id);
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

function renderComment(thread: ThreadState, c: InlineComment): HTMLElement {
  if (c.deleted) {
    const card = buildCommentCard({
      author: c.author,
      timestamp: c.ts,
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
      bodyEl: composer.el,
      reply: !!c.parent,
    });
  }

  const bodyEl = document.createElement("div");
  bodyEl.innerHTML = md.renderInline(c.body);

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
    bodyEl,
    reply: !!c.parent,
    actions,
  });
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

document.addEventListener("selectionchange", () => positionFloatingButton());
window.addEventListener("scroll", () => positionFloatingButton(), true);

dom.filterRadios.forEach((r) =>
  r.addEventListener("change", () => {
    filter = (r.value as typeof filter);
    if (currentState) render(currentState);
  }),
);

window.addEventListener("message", (ev) => {
  const msg = ev.data as InitMsg | UpdateMsg | ReviewPendingMsg | ScrollToMsg | DrawioReadResult | SkillStatusMsg;
  if (!msg) return;
  if (msg.type === "drawio-read-result") {
    handleDrawioResult(msg);
    return;
  }
  if (msg.type === "init") {
    dom.fileName.textContent = msg.fileName;
    user = msg.user;
    imageBaseUris = msg.imageBaseUris;
    ensurePlantumlInstalled(msg.plantuml);
    renderSkillWarning(msg.skillStatus);
    render(msg.state);
  } else if (msg.type === "update") {
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

/**
 * Scroll the rendered preview so the source-offset span enclosing
 * `proseOffset` is visible. Used by the host to support "open inline
 * view at line N" (and the heading-jump variant of cross-file links).
 *
 * Defers one frame so the call works even when fired immediately after
 * init, before the preview HTML has been painted.
 */
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
    best.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

void user; // silence unused for now; will use when threading authorship UI hints

vscode.postMessage({ type: "ready" });
