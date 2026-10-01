// The comment sidebar (10x-plan-6 P4, sidebar parity).
//
// Everything the review view's threads pane does — the filter segments, the
// Send / suggest-mode / "…" toolbar, the unread banner, thread cards with
// Reply / Resolve / a "…" menu, n/p/r/e/o, the empty state — written against
// `SidebarState` instead of the review view's own DOM and message plumbing, so
// the live editor shows the same sidebar when it becomes the only view.
//
// Copied from src/inlineComments/webview/client.ts, which keeps its own copy
// until the review view is removed. The ids and class names are the same on
// purpose: the two surfaces look alike and their e2e specs read alike.
//
// The module owns its DOM, its keyboard map, and the preferences it persists
// through the host's getState/setState. The document side — scrolling to a
// highlight, stepping change stripes — belongs to the host, via callbacks.

import "./threadSidebar.css";
import "./controls.css";
import { isAgentComment } from "../agentIdentity";
import { isClaudeUnread } from "../inlineComments/claudeUnread";
import { isNavKeyContext } from "./diffNav";
import { createMenuController } from "./menu";
import {
  THREAD_RENDER_CHUNK,
  adjacentThreadId,
  chunkThreads,
  claudeSummary,
  collapseKey,
  emptyState,
  filterCounts,
  filterThreads,
  initialCollapsed,
  nextCollapseAllAction,
  nextUnreadThreadId,
  type CollapsibleCard,
  type EmptyState,
  type ThreadFilter,
} from "./threadListState";
import {
  buildComposer,
  buildCommentBody,
  buildCommentCard,
  buildCollapseToggle,
  buildSuggestionCard,
  type CardAction,
} from "./commentUi";
import { smoothScrollIntoView } from "./scrollIntoView";
import type {
  SidebarComment,
  SidebarMessage,
  SidebarState,
  SidebarSuggestion,
  SidebarThread,
  SkillStatus,
} from "./sidebarProtocol";

export interface ThreadSidebarHost {
  post(msg: SidebarMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
  /** Scroll the document to an anchored thread's highlight and flash it. */
  revealInDocument(threadId: string): void;
  /** Scroll the document to a suggestion's highlight. */
  revealSuggestionInDocument(anchorId: string): void;
}

export interface ThreadSidebarHandle {
  /** The sidebar root: header, then the thread list. */
  el: HTMLElement;
  headerEl: HTMLElement;
  /** A slot in the title row for the host's own "+ Add comment" button. */
  titleActionsEl: HTMLElement;
  listEl: HTMLElement;
  render(state: SidebarState): void;
  setSkillStatus(status: SkillStatus | undefined): void;
  /** A highlight in the document was clicked: make its card the current one. */
  revealThread(threadId: string): void;
  /** A suggestion highlight was clicked: scroll to its card. */
  revealSuggestion(anchorId: string): void;
  /**
   * An agent was just asked to review: remember which threads exist, so the
   * first new unread one gets scrolled to when it lands.
   */
  notifyReviewPending(existingIds: string[]): void;
  /**
   * While the document shows change stripes, n/p step changes instead of
   * threads, and the hint says so. `null` gives the keys back to the threads.
   */
  setChangeNavigation(step: ((delta: 1 | -1) => void) | null): void;
}

const THREAD_FILTERS: readonly ThreadFilter[] = ["open", "all", "resolved", "claude-unread"];

const SHELL = `<header id="threads-header">
  <div class="title-row">
    <h2>Comments</h2>
    <span class="mc-title-actions">
      <span class="mc-menu-wrap">
        <button id="overflow-menu-btn" type="button" class="mc-icon-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="overflow-menu" aria-label="More actions" title="More actions">⋯</button>
        <div id="overflow-menu" class="mc-menu" role="menu" aria-label="More actions" hidden>
          <button id="collapse-all" type="button" role="menuitem" class="mc-menuitem" title="Collapse / expand every comment thread and suggestion">Collapse all</button>
          <button id="hint-toggle" type="button" role="menuitemcheckbox" class="mc-menuitem" aria-checked="false" title="Show keyboard shortcuts">Keyboard shortcuts</button>
          <hr role="separator">
          <button id="remove-resolved" type="button" role="menuitem" class="mc-menuitem danger" hidden title="Delete every resolved comment from this file. Open comments and pending suggestions are kept.">Remove resolved</button>
          <button id="finalize-doc" type="button" role="menuitem" class="mc-menuitem danger" hidden title="Remove ALL review data — every comment, marker, and pending suggestion — leaving clean markdown ready to commit.">Remove all review data</button>
        </div>
      </span>
    </span>
  </div>
  <div class="filter-row" role="radiogroup" aria-label="Filter comment threads">
    <label class="segment"><input type="radio" name="filter" value="open" checked><span>Open <span id="filter-count-open" class="count"></span></span></label>
    <label class="segment"><input type="radio" name="filter" value="all"><span>All <span id="filter-count-all" class="count"></span></span></label>
    <label class="segment"><input type="radio" name="filter" value="resolved"><span>Resolved <span id="filter-count-resolved" class="count"></span></span></label>
    <label id="filter-claude-label" class="segment" hidden><input type="radio" name="filter" value="claude-unread"><span id="filter-claude-label-text">New from Claude</span></label>
  </div>
  <div id="claude-summary" hidden>
    <span id="claude-summary-text" role="status" aria-live="polite"></span>
    <button id="claude-next" class="mc-btn mc-btn--link" title="Jump to the next unread thread from Claude.">Next</button>
  </div>
  <div id="keys-hint"><span id="keys-hint-text">n / p to move between threads · r reply · e resolve · o open in editor</span><button id="keys-hint-dismiss" type="button" class="mc-icon-btn" aria-label="Hide shortcuts">×</button></div>
  <div id="skill-warning" class="skill-warning" hidden>
    <span id="skill-warning-text"></span>
    <button id="skill-install" class="mc-btn mc-btn--link"></button>
  </div>
</header>
<div id="threads-list" role="feed"><p class="mc-loading">Loading…</p></div>
<footer class="mc-sidebar-footer" hidden>
  <button id="send-to-claude" class="mc-btn mc-btn--primary" title="Send the prompt to a running Claude terminal (or your configured send mode).">Send</button>
  <span class="mc-menu-wrap">
    <button id="send-options-btn" type="button" class="mc-btn mc-btn--primary" aria-haspopup="menu" aria-expanded="false" aria-controls="send-options-menu" aria-label="Send options" title="Send options"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5l4 4 4-4"/></svg></button>
    <div id="send-options-menu" class="mc-menu mc-menu--up" role="menu" aria-label="Send options" hidden>
      <button id="suggest-mode-toggle" type="button" role="menuitemcheckbox" class="mc-menuitem" aria-checked="false" title="When on, Send asks Claude to propose edits as suggestions you accept or reject.">Ask for suggestions instead of edits</button>
    </div>
  </span>
  <button id="copy-prompt" type="button" class="mc-icon-btn" aria-label="Copy prompt" title="Copy the prompt to your clipboard."><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg></button>
</footer>`;

/**
 * Build the sidebar. Call once: it installs document-level listeners (the
 * keyboard map, menu dismissal) that live as long as the page.
 */
export function createThreadSidebar(host: ThreadSidebarHost): ThreadSidebarHandle {
  const root = document.createElement("div");
  root.className = "mc-thread-sidebar";
  root.innerHTML = SHELL;
  const byId = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;

  const dom = {
    header: byId<HTMLElement>("threads-header"),
    titleActions: root.querySelector<HTMLElement>(".mc-title-actions")!,
    footer: root.querySelector<HTMLElement>(".mc-sidebar-footer")!,
    filterRow: root.querySelector<HTMLElement>(".filter-row")!,
    filterCountOpen: byId<HTMLElement>("filter-count-open"),
    filterCountAll: byId<HTMLElement>("filter-count-all"),
    filterCountResolved: byId<HTMLElement>("filter-count-resolved"),
    threadsList: byId<HTMLElement>("threads-list"),
    filterRadios: root.querySelectorAll<HTMLInputElement>('input[name="filter"]'),
    sendToClaude: byId<HTMLButtonElement>("send-to-claude"),
    sendOptionsBtn: byId<HTMLButtonElement>("send-options-btn"),
    sendOptionsMenu: byId<HTMLElement>("send-options-menu"),
    copyPrompt: byId<HTMLButtonElement>("copy-prompt"),
    suggestModeToggle: byId<HTMLButtonElement>("suggest-mode-toggle"),
    removeResolved: byId<HTMLButtonElement>("remove-resolved"),
    finalizeDoc: byId<HTMLButtonElement>("finalize-doc"),
    skillWarning: byId<HTMLElement>("skill-warning"),
    skillWarningText: byId<HTMLElement>("skill-warning-text"),
    skillInstall: byId<HTMLButtonElement>("skill-install"),
    claudeSummary: byId<HTMLElement>("claude-summary"),
    claudeSummaryText: byId<HTMLElement>("claude-summary-text"),
    claudeNext: byId<HTMLButtonElement>("claude-next"),
    collapseAll: byId<HTMLButtonElement>("collapse-all"),
    claudeFilterLabel: byId<HTMLLabelElement>("filter-claude-label"),
    claudeFilterLabelText: byId<HTMLElement>("filter-claude-label-text"),
    overflowMenuBtn: byId<HTMLButtonElement>("overflow-menu-btn"),
    overflowMenu: byId<HTMLElement>("overflow-menu"),
    hintToggle: byId<HTMLButtonElement>("hint-toggle"),
    keysHint: byId<HTMLElement>("keys-hint"),
    keysHintText: byId<HTMLElement>("keys-hint-text"),
    keysHintDismiss: byId<HTMLButtonElement>("keys-hint-dismiss"),
  };

  // Every preference goes through one merge, so a key another part of the
  // page persists is never dropped by this module's write, or vice versa.
  // The state outlives the build that wrote it, so nothing read from it is
  // trusted: a value of the wrong shape reads as unset.
  const saved = (): Record<string, unknown> => {
    const state = host.getState();
    return state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  };
  const persist = (patch: Record<string, unknown>): void => host.setState({ ...saved(), ...patch });

  // --- "…" overflow menus ----------------------------------------------------
  // One trigger/panel pair at a time is open — the toolbar's or a single
  // thread card's — via the shared controller (webviewShared/menu.ts), which
  // also the PR review sidebar uses, so the two can never drift apart.
  const menu = createMenuController();

  dom.overflowMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.toggleMenuAt(dom.overflowMenuBtn, dom.overflowMenu);
  });
  // Bottom-anchored (opens upward) but the same trigger/panel pair and the
  // same one-open-at-a-time tracking as the "…" menu above.
  dom.sendOptionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.toggleMenuAt(dom.sendOptionsBtn, dom.sendOptionsMenu);
  });

  // --- State -------------------------------------------------------------------

  let currentState: SidebarState | null = null;
  let filter: ThreadFilter = ((): ThreadFilter => {
    // Persisted, unlike the review view: switching Reading/Editing reloads the
    // page, and the list the reviewer was working through shouldn't reset with it.
    const f = saved().threadFilter;
    return THREAD_FILTERS.includes(f as ThreadFilter) ? (f as ThreadFilter) : "open";
  })();
  let pendingThreadIds: ReadonlySet<string> = new Set();
  let pendingLabelText = "Claude is working…";
  let agentName = "Claude";
  let headlessAvailable = false;
  /** First click on "Accept all" arms it; the second applies. */
  let acceptAllArmed = false;
  // How many thread cards the list is currently allowed to build. Grows by a
  // chunk each time the user clicks "Show more"; resets when the filter changes,
  // since that is a new list.
  let renderedThreadLimit = THREAD_RENDER_CHUNK;
  let editingCommentId: string | null = null; // composite "threadId:commentId" when editing
  let highlightedThreadId: string | null = null;
  // Two-click delete confirmation per thread / per comment — inline, because
  // VS Code webviews silently block window.confirm().
  const pendingDeleteThread = new Set<string>();
  const pendingDeleteComment = new Set<string>(); // composite "threadId:commentId"
  let stepChanges: ((delta: 1 | -1) => void) | null = null;

  // Manual collapse/expand overrides, keyed by `collapseKey` (thread or
  // suggestion id, namespaced by kind) — round-8 P1. A card with no entry
  // here falls back to its default (`initialCollapsed`): resolved threads
  // start collapsed, everything else starts expanded. Persisted so a manual
  // toggle wins for the rest of the session, across both a host `update` and
  // a Reading/Editing re-init.
  const manualCollapse = new Map<string, boolean>(collapseOverridesOf(saved().collapseOverrides));
  const saveManualCollapse = (): void => persist({ collapseOverrides: Array.from(manualCollapse.entries()) });
  const isCollapsedCard = (card: CollapsibleCard): boolean => initialCollapsed(card, manualCollapse);
  /** Every card the "Collapse all" toggle and its label cover. */
  const collapsibleCards = (state: SidebarState): CollapsibleCard[] => [
    ...state.threads.map((t): CollapsibleCard => ({ kind: "thread", id: t.id, status: t.status })),
    ...state.suggestions.map((s): CollapsibleCard => ({ kind: "suggestion", id: s.anchorId })),
  ];

  /**
   * Fold or unfold one card in place — no re-render, so an in-progress reply
   * on another thread card isn't wiped. Updates the same DOM the initial
   * render read `isCollapsedCard` into, so a second click always sees the
   * truth this function itself just wrote, not a stale snapshot.
   */
  function setCardCollapsed(card: CollapsibleCard, collapsed: boolean): void {
    manualCollapse.set(collapseKey(card), collapsed);
    saveManualCollapse();
    const el =
      card.kind === "thread"
        ? cardFor(card.id)
        : dom.threadsList.querySelector<HTMLElement>(`[data-suggestion-id="${cssEscape(card.id)}"]`);
    el?.classList.toggle("collapsed", collapsed);
    // The glyph itself never changes — it's one chevron SVG that CSS rotates
    // off `aria-expanded` — so a repaint only has that attribute to touch.
    const chevron = el?.querySelector<HTMLButtonElement>(".thread-collapse");
    chevron?.setAttribute("aria-expanded", String(!collapsed));
    updateCollapseAllLabel();
  }

  // Set when an agent is asked to review this doc: the thread IDs that existed
  // then. On the next render where a new unread thread appears, scroll to the
  // first one and clear the snapshot. Survives a webview reload via state.
  let pendingReviewSnapshot: Set<string> | null = ((): Set<string> | null => {
    const ids = saved().pendingReviewIds;
    return Array.isArray(ids) ? new Set(ids.filter((id): id is string => typeof id === "string")) : null;
  })();
  const savePendingReviewSnapshot = (): void =>
    persist({ pendingReviewIds: pendingReviewSnapshot ? Array.from(pendingReviewSnapshot) : null });

  // --- Toolbar -------------------------------------------------------------------

  dom.sendToClaude.addEventListener("click", () => host.post({ type: "send-to-claude" }));
  // An open menu closes on this click like on any other outside click (the
  // menu controller's document listener).
  dom.copyPrompt.addEventListener("click", () => host.post({ type: "copy-prompt" }));
  // Every item in the send-options and "…" menus closes it after each click:
  // even the two menuitemcheckbox toggles (suggest mode, the keys hint) are
  // one action per click here, not a multi-select list to leave open.
  // The suggest-mode toggle doesn't flip itself: the setting is the host's,
  // and it only reflects what comes back — anything else would show "on"
  // after a write that failed.
  dom.suggestModeToggle.addEventListener("click", () => {
    host.post({ type: "toggle-suggest-mode" });
    menu.closeOpenMenu(false);
  });
  // The host owns the confirm and the write for both bulk deletes: a webview
  // can't show a modal, and a two-click arm is too quiet for something that
  // removes many threads at once.
  dom.removeResolved.addEventListener("click", () => {
    host.post({ type: "remove-resolved" });
    menu.closeOpenMenu(false);
  });
  dom.finalizeDoc.addEventListener("click", () => {
    host.post({ type: "finalize" });
    menu.closeOpenMenu(false);
  });
  dom.skillInstall.addEventListener("click", () => {
    dom.skillInstall.disabled = true;
    dom.skillInstall.textContent = "Installing…";
    host.post({ type: "install-skill" });
  });
  dom.collapseAll.addEventListener("click", () => {
    const cards = currentState ? collapsibleCards(currentState) : [];
    const collapsedIds = new Set(cards.filter(isCollapsedCard).map(collapseKey));
    const collapse = nextCollapseAllAction(cards.map(collapseKey), collapsedIds) === "collapse";
    for (const c of cards) setCardCollapsed(c, collapse);
    menu.closeOpenMenu(false);
  });
  dom.claudeNext.addEventListener("click", () => {
    if (!currentState) return;
    const nextId = nextUnreadThreadId(currentState.threads, highlightedThreadId);
    if (nextId) focusThread(nextId);
  });

  // `#edit-mode-toggle` itself lives in the document toolbar now (client.ts) —
  // the sidebar no longer builds or repaints it. `state.readOnly` still
  // arrives on every `render()` (SidebarState is unchanged), simply unused
  // here.
  function updateSwitches(state: SidebarState): void {
    dom.suggestModeToggle.setAttribute("aria-checked", String(state.suggestMode));
    // With the menu closed the only trace of suggest mode is the Send label
    // ("…as suggestions", see updateFooter) and this title.
    dom.sendOptionsBtn.title = state.suggestMode ? "Suggest mode is on" : "Send options";
  }

  /**
   * Put `agentName` wherever there's no per-thread agent to name instead: the
   * Send button's title and the suggest-mode item's title. The Send label
   * itself names no agent: `agentName` is whoever wrote here last ("Claude"
   * before anyone has), which is not necessarily who this send goes to.
   */
  function updateAgentUi(): void {
    dom.sendToClaude.title = `Send the prompt to a running ${agentName} terminal (or your configured send mode).`;
    dom.suggestModeToggle.title = `When on, Send asks ${agentName} to propose edits as suggestions you accept or reject.`;
  }

  /**
   * The footer: hidden with nothing open to send (the empty-state card covers
   * the no-threads-at-all case), otherwise the Send label named after the
   * open count — what a send actually acts on.
   */
  function updateFooter(state: SidebarState): void {
    const openCount = state.threads.filter((t) => t.status === "open").length;
    dom.footer.hidden = openCount === 0;
    const what = openCount === 1 ? "1 comment" : `${openCount} comments`;
    // The label says what the click does, so suggest mode can't be on silently.
    dom.sendToClaude.textContent = `Send ${what}${state.suggestMode ? " as suggestions" : ""}`;
  }

  function setSkillStatus(status: SkillStatus | undefined): void {
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

  // --- Filters -------------------------------------------------------------------

  /**
   * The segmented look is driven off which radio is `:checked`, but a couple of
   * call sites set `.checked` directly (not through a click, which fires
   * `change` on its own) — those call this so the active segment repaints.
   */
  function updateFilterSegments(): void {
    for (const r of dom.filterRadios) {
      r.checked = r.value === filter;
      r.closest("label")?.classList.toggle("active", r.checked);
    }
  }

  function setFilter(next: ThreadFilter): void {
    filter = next;
    persist({ threadFilter: filter });
    updateFilterSegments();
    // A different filter is a different list — start its render budget over.
    renderedThreadLimit = THREAD_RENDER_CHUNK;
    if (currentState) renderThreads(currentState);
  }

  dom.filterRadios.forEach((r) => r.addEventListener("change", () => setFilter(r.value as ThreadFilter)));
  updateFilterSegments();

  // --- Keyboard hint -------------------------------------------------------------
  // Shown until n/p/r/e/o is first used, then hidden; "?" brings it back (and
  // hides it again) — a manual override on top of the first-use dismissal.
  let hintDismissed = saved().hintDismissed === true;
  // n/p/r/e/o act on threads; with none there is nothing for the hint to
  // explain, so it (and its menu item) wait for the first thread.
  let hasThreads = false;

  function applyHintVisibility(): void {
    dom.keysHint.hidden = hintDismissed || !hasThreads;
    dom.hintToggle.disabled = !hasThreads;
    dom.hintToggle.setAttribute("aria-checked", String(!hintDismissed));
  }
  applyHintVisibility();

  function dismissHintOnFirstUse(): void {
    if (hintDismissed) return;
    hintDismissed = true;
    persist({ hintDismissed });
    applyHintVisibility();
  }

  dom.hintToggle.addEventListener("click", () => {
    hintDismissed = !hintDismissed;
    persist({ hintDismissed });
    applyHintVisibility();
    menu.closeOpenMenu(false);
  });
  // The inline "×" on the hint itself: same dismissal, no menu to close.
  dom.keysHintDismiss.addEventListener("click", () => {
    hintDismissed = true;
    persist({ hintDismissed });
    applyHintVisibility();
  });

  /** The hint names what n/p will actually do: step changes while stripes show, walk threads otherwise. */
  function updateKeysHint(): void {
    const target = stepChanges ? "changes" : "threads";
    dom.keysHintText.textContent = `n / p to move between ${target} · r reply · e resolve · o open in editor`;
  }

  // n/p walk the highlight through the filtered list (or step changes while the
  // host has change stripes up), r opens the highlighted thread's reply box, e
  // resolves/reopens it, o opens it in a text editor. Deliberately no `a` for
  // "accept" — a single-key accept with no visible target is a footgun. Never
  // fires with a modifier held or while typing (a composer, a reply box, or the
  // editor in edit mode, which is contenteditable).
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (!isNavKeyContext(e.target)) return;
    if (e.key === "n" || e.key === "p") {
      const delta = e.key === "n" ? 1 : -1;
      if (stepChanges) stepChanges(delta);
      else moveThreadHighlight(delta);
    } else if (e.key === "r") {
      focusReplyOnHighlighted();
    } else if (e.key === "e") {
      if (highlightedThreadId) host.post({ type: "toggle-resolve", threadId: highlightedThreadId });
    } else if (e.key === "o") {
      if (highlightedThreadId) host.post({ type: "open-in-editor", threadId: highlightedThreadId });
    } else {
      return;
    }
    dismissHintOnFirstUse();
  });

  // --- Thread navigation ---------------------------------------------------------

  /**
   * Move the "current card" state (`.highlighted` + roving `tabindex`) to `id`
   * without re-rendering, so an in-progress reply elsewhere survives.
   */
  function updateHighlightedCardDom(id: string): void {
    for (const c of dom.threadsList.querySelectorAll<HTMLElement>(".thread-card")) {
      const match = c.dataset.thread === id;
      c.classList.toggle("highlighted", match);
      c.tabIndex = match ? 0 : -1;
    }
  }

  const cardFor = (id: string): HTMLElement | null =>
    dom.threadsList.querySelector<HTMLElement>(`.thread-card[data-thread="${cssEscape(id)}"]`);

  /** Show the document position of a thread — only anchored threads have one. */
  function revealThreadInDocument(t: SidebarThread): void {
    if (t.anchor) host.revealInDocument(t.id);
  }

  /**
   * Highlight `id`'s card, scroll it into view, and scroll the document to its
   * anchor. Shared by "Next", n/p, and the scroll-to-new-review path. Raises
   * the render cap first when the card hasn't been built yet.
   */
  function focusThread(id: string): void {
    if (!currentState) return;
    const target = currentState.threads.find((t) => t.id === id);
    if (!target) return;
    highlightedThreadId = target.id;

    const revealAndScroll = (): void => {
      const card = cardFor(target.id);
      updateHighlightedCardDom(target.id);
      if (card) {
        smoothScrollIntoView(card, "center");
        // Move DOM focus with the highlight so a keyboard user lands where the
        // screen reader is now looking; the scroll above already positioned it.
        card.focus({ preventScroll: true });
      }
      revealThreadInDocument(target);
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

  /** Focus the highlighted thread's reply box, expanding a collapsed card first. */
  function focusReplyOnHighlighted(): void {
    if (!highlightedThreadId) return;
    const thread = currentState?.threads.find((t) => t.id === highlightedThreadId);
    if (thread) {
      const card: CollapsibleCard = { kind: "thread", id: thread.id, status: thread.status };
      if (isCollapsedCard(card)) setCardCollapsed(card, false);
    }
    setReplyOpen(highlightedThreadId, true, true);
  }

  function maybeScrollToNewReview(state: SidebarState): void {
    if (!pendingReviewSnapshot) return;
    const snapshot = pendingReviewSnapshot;
    const fresh = state.threads
      .filter((t) => isClaudeUnread(t) && !snapshot.has(t.id))
      .sort(
        (a, b) =>
          (a.anchor?.proseStart ?? Number.MAX_SAFE_INTEGER) - (b.anchor?.proseStart ?? Number.MAX_SAFE_INTEGER),
      );
    if (fresh.length === 0) return;
    // Clear the snapshot first so re-entry doesn't loop on later updates.
    pendingReviewSnapshot = null;
    savePendingReviewSnapshot();
    focusThread(fresh[0].id);
  }

  // --- Collapse --------------------------------------------------------------------
  // `setCardCollapsed`, `isCollapsedCard`, and `collapsibleCards` are defined
  // with the other persisted state above, next to `manualCollapse` itself.

  function updateCollapseAllLabel(): void {
    const cards = currentState ? collapsibleCards(currentState) : [];
    const allCollapsed = cards.length > 0 && cards.every(isCollapsedCard);
    dom.collapseAll.textContent = allCollapsed ? "Expand all" : "Collapse all";
    dom.collapseAll.disabled = cards.length === 0;
  }

  // --- Reply composers ---------------------------------------------------------------
  // In-progress reply text by thread id, kept across re-renders (every external
  // update rebuilds the list), plus which reply box had focus so it gets it back.
  const pendingReplyText = new Map<string, string>();
  let focusedReplyThreadId: string | null = null;
  // Reply boxes are collapsed until Reply is clicked or `r` pressed: thirty
  // always-open textareas are thirty fields of chrome for the one being used.
  const openReplyThreadIds = new Set<string>();

  /** An unsent draft keeps its box open across a re-render, opened explicitly or not. */
  function replyShouldBeOpen(id: string): boolean {
    return openReplyThreadIds.has(id) || (pendingReplyText.get(id)?.length ?? 0) > 0;
  }

  function setReplyOpen(id: string, open: boolean, focus: boolean): void {
    if (open) openReplyThreadIds.add(id);
    else openReplyThreadIds.delete(id);
    const card = cardFor(id);
    const box = card?.querySelector<HTMLElement>(".reply-box");
    const shown = replyShouldBeOpen(id);
    box?.classList.toggle("open", shown);
    card?.querySelector(".thread-reply-toggle")?.setAttribute("aria-expanded", String(shown));
    // Synchronous: the `r` handler expects the textarea focused when it returns.
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

  // --- Rendering -----------------------------------------------------------------------

  function render(state: SidebarState): void {
    currentState = state;
    pendingThreadIds = new Set(state.pendingThreadIds);
    agentName = state.agentName || "Claude";
    pendingLabelText = state.pendingLabel ?? `${agentName} is working…`;
    headlessAvailable = state.headlessAvailable;
    updateSwitches(state);
    updateAgentUi();
    updateFooter(state);
    renderThreads(state);
    updateCollapseAllLabel();
    maybeScrollToNewReview(state);
  }

  /** Each tab's own count, and the whole row hidden when there's nothing to filter. */
  function updateFilterCounts(threads: SidebarThread[]): void {
    const counts = filterCounts(threads);
    dom.filterCountOpen.textContent = String(counts.open);
    dom.filterCountAll.textContent = String(counts.all);
    dom.filterCountResolved.textContent = String(counts.resolved);
    dom.filterRow.hidden = counts.all === 0;
    hasThreads = counts.all > 0;
    applyHintVisibility();
  }

  function renderThreads(state: SidebarState): void {
    captureReplyState();
    const list = dom.threadsList;
    // A card's "…" menu is about to be torn down with the list; don't leave
    // the controller pointing at a detached panel. The toolbar's menu is untouched.
    menu.closeMenuWithin(list);
    list.innerHTML = "";

    // Pending suggestions render above the threads regardless of the filter —
    // an unreviewed edit is the most actionable thing here.
    if (state.suggestions.length > 1) list.appendChild(renderAcceptAll(state.suggestions.length));
    for (const s of state.suggestions) list.appendChild(renderSuggestion(s));

    renderClaudeSummary(state);
    const filtered = filterThreads(state.threads, filter);
    updateFilterCounts(state.threads);
    // Offered only when it would do something; its absence says "nothing to
    // clean up" more clearly than a disabled control would.
    const resolvedCount = state.threads.filter((t) => t.status === "resolved").length;
    dom.removeResolved.hidden = resolvedCount === 0;
    dom.removeResolved.textContent = `Remove ${resolvedCount} resolved`;
    dom.finalizeDoc.hidden = state.threads.length === 0 && state.suggestions.length === 0;
    if (filtered.length === 0) {
      if (state.suggestions.length === 0) {
        list.appendChild(
          buildEmptyStateEl(emptyState({ filter, totalThreads: state.threads.length, headlessAvailable })),
        );
      }
      return;
    }
    // Build at most a chunk of cards per pass; the rest arrive on click.
    const chunk = chunkThreads(filtered, renderedThreadLimit);
    for (let i = 0; i < chunk.visible.length; i++) {
      // posinset/setsize describe the whole filtered list, not the built chunk.
      list.appendChild(renderThreadCard(chunk.visible[i], i + 1, filtered.length));
    }
    if (chunk.moreLabel) {
      const more = document.createElement("button");
      more.className = "mc-btn mc-btn--quiet mc-show-more";
      more.textContent = chunk.moreLabel;
      more.addEventListener("click", () => {
        renderedThreadLimit += THREAD_RENDER_CHUNK;
        if (currentState) renderThreads(currentState);
      });
      list.appendChild(more);
    }
  }

  /** A plain line when a filter is hiding real threads; a first-run card when there are none. */
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
    action.className = "mc-btn mc-btn--primary";
    action.textContent = state.action.label;
    action.addEventListener("click", () => host.post(state.action.message));
    card.append(headline, hint, action);
    return card;
  }

  /** "Accept all N" — armed with a two-step confirm, since it rewrites the document in one go. */
  function renderAcceptAll(count: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "accept-all-row";
    const btn = document.createElement("button");
    btn.className = "mc-btn mc-btn--quiet";
    btn.textContent = acceptAllArmed ? `Accept all ${count}? Click again` : `Accept all ${count}`;
    if (acceptAllArmed) btn.classList.add("armed");
    btn.title = "Apply every pending suggestion in this file. One undo step.";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (acceptAllArmed) {
        acceptAllArmed = false;
        host.post({ type: "accept-all-suggestions" });
        return;
      }
      acceptAllArmed = true;
      // Auto-disarm, so a half-pressed button doesn't wait to rewrite the file.
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

  function renderSuggestion(s: SidebarSuggestion): HTMLElement {
    const suggestionCard: CollapsibleCard = { kind: "suggestion", id: s.anchorId };
    const card = buildSuggestionCard({
      author: s.author,
      timestamp: s.ts,
      note: s.note,
      original: s.original,
      proposed: s.proposed,
      anchored: s.anchored,
      onAccept: () => host.post({ type: "accept-suggestion", anchorId: s.anchorId }),
      onReject: () => host.post({ type: "reject-suggestion", anchorId: s.anchorId }),
      onClick: s.anchored ? () => host.revealSuggestionInDocument(s.anchorId) : undefined,
      collapsed: isCollapsedCard(suggestionCard),
      onToggleCollapse: () => setCardCollapsed(suggestionCard, !isCollapsedCard(suggestionCard)),
    });
    card.dataset.suggestionId = s.anchorId;
    return card;
  }

  function renderClaudeSummary(state: SidebarState): void {
    const summary = claudeSummary(state.threads);
    dom.claudeSummary.hidden = !summary.hasAny;
    // The "New from <agent>" chip only matters when agent threads exist; hide
    // it (and fall back to "open") otherwise, named by the same rule as the
    // summary text.
    dom.claudeFilterLabel.hidden = !summary.hasAny;
    dom.claudeFilterLabelText.textContent = `New from ${summary.agentNoun}`;
    dom.claudeNext.title = `Jump to the next unread thread from ${summary.agentNoun}.`;
    if (!summary.hasAny && filter === "claude-unread") {
      filter = "open";
      persist({ threadFilter: filter });
      updateFilterSegments();
    }
    if (!summary.hasAny) return;
    dom.claudeSummaryText.textContent = summary.text;
    dom.claudeNext.disabled = summary.unread === 0;
  }

  function renderThreadCard(t: SidebarThread, posinset: number, setsize: number): HTMLElement {
    const cardKey: CollapsibleCard = { kind: "thread", id: t.id, status: t.status };
    const card = document.createElement("section");
    card.className = "thread-card";
    if (t.status === "resolved") card.classList.add("resolved");
    if (t.id === highlightedThreadId) card.classList.add("highlighted");
    if (isClaudeUnread(t)) card.classList.add("claude-unread");
    if (isCollapsedCard(cardKey)) card.classList.add("collapsed");
    if (!t.anchor) card.classList.add("unanchored");
    card.dataset.thread = t.id;
    // The list is a `role="feed"`: each card is an article with its position
    // and a label a screen reader can announce without expanding it.
    card.setAttribute("role", "article");
    card.setAttribute("aria-posinset", String(posinset));
    card.setAttribute("aria-setsize", String(setsize));
    const root = t.comments[0];
    if (root) card.setAttribute("aria-label", `${root.author}: ${root.body.slice(0, 60)}`);
    // Roving tabindex: only the highlighted card is in the Tab order; before
    // anything is highlighted the first card takes the role.
    card.tabIndex = (highlightedThreadId ? t.id === highlightedThreadId : posinset === 1) ? 0 : -1;
    card.addEventListener("click", () => {
      highlightedThreadId = t.id;
      revealThreadInDocument(t);
      // Class + tabindex only — a re-render would wipe a reply being typed on
      // another card.
      updateHighlightedCardDom(t.id);
    });

    const head = document.createElement("header");
    head.className = "thread-head";
    const headRow = document.createElement("div");
    headRow.className = "thread-head-row";
    const chevron = buildCollapseToggle({
      extraClass: "thread-collapse",
      ariaLabel: "Collapse or expand this comment thread",
      title: "Collapse / expand this thread",
      expanded: !isCollapsedCard(cardKey),
      onToggle: (e) => {
        e.stopPropagation();
        setCardCollapsed(cardKey, !isCollapsedCard(cardKey));
      },
    });
    headRow.appendChild(chevron);
    const quote = document.createElement("blockquote");
    quote.className = "thread-quote";
    quote.textContent = t.quote || "(no quote)";
    if (!t.anchor) {
      // The markers are gone, so nothing in the document is highlighted for
      // this thread — read-only placement never guesses from the quote.
      const badge = document.createElement("span");
      badge.className = "badge broken";
      badge.textContent = "broken anchor";
      badge.title =
        "Anchor marker missing from the file, so this thread has no highlight in the document. Fix by re-anchoring.";
      quote.appendChild(badge);
    } else if (t.stale) {
      // Only when the anchor is intact: two badges about one failure is noise.
      const badge = document.createElement("span");
      badge.className = "badge stale";
      badge.textContent = "text changed";
      badge.title =
        "The anchored passage was edited after the last comment on this thread — the comment may be answering text that is no longer there.";
      quote.appendChild(badge);
    }
    if (t.status === "resolved") {
      // Shown regardless of collapse state, the same as broken/stale above —
      // it's the one status badge that matters once "All" mixes open and
      // resolved threads and a resolved one is folded to just this line.
      const badge = document.createElement("span");
      badge.className = "badge resolved";
      badge.textContent = "resolved";
      badge.title = "This thread is resolved.";
      quote.appendChild(badge);
    }
    headRow.appendChild(quote);
    // Collapsed, the header's row is the whole visible card — "N comments" is
    // the one thing the folded quote can't already say for itself.
    const commentCount = document.createElement("span");
    commentCount.className = "thread-comment-count";
    const liveCommentTotal = t.comments.filter((c) => !c.deleted).length;
    commentCount.textContent = liveCommentTotal === 1 ? "1 comment" : `${liveCommentTotal} comments`;
    headRow.appendChild(commentCount);
    // While collapsed, clicking anywhere in the header expands it — a bigger
    // target than the chevron alone, since the header is effectively the
    // whole card at that point. Expanded, a click here is left to bubble to
    // the card's own click handler above (highlight + reveal in the
    // document) instead: collapsing a card the human is reading out from
    // under a stray click on its quote would be a bad surprise.
    headRow.addEventListener("click", (e) => {
      if (!card.classList.contains("collapsed")) return;
      e.stopPropagation();
      setCardCollapsed(cardKey, false);
    });
    head.appendChild(headRow);

    // Visible per-card actions are Reply, Resolve/Reopen and Send; every other
    // per-thread action lives in the "…" menu.
    const actions = document.createElement("div");
    actions.className = "thread-actions";

    const replyOpenNow = replyShouldBeOpen(t.id);
    const replyToggleBtn = document.createElement("button");
    replyToggleBtn.type = "button";
    replyToggleBtn.className = "mc-btn mc-btn--quiet thread-reply-toggle";
    replyToggleBtn.textContent = "Reply";
    replyToggleBtn.setAttribute("aria-expanded", String(replyOpenNow));
    replyToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setReplyOpen(t.id, !replyShouldBeOpen(t.id), true);
    });

    const resolveBtn = document.createElement("button");
    resolveBtn.className = "mc-btn mc-btn--quiet";
    resolveBtn.textContent = t.status === "resolved" ? "Reopen" : "Resolve";
    resolveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      host.post({ type: "toggle-resolve", threadId: t.id });
    });

    // Named after the current agent: render() sets `agentName` before it
    // builds the cards.
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "mc-btn mc-btn--quiet thread-send";
    sendBtn.textContent = "Send";
    sendBtn.title = `Send this thread to ${agentName}`;
    sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      host.post({ type: "send-to-claude-comment", threadId: t.id });
    });

    const menuWrap = document.createElement("span");
    menuWrap.className = "mc-menu-wrap";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "mc-icon-btn thread-menu-btn";
    menuBtn.textContent = "⋯";
    menuBtn.title = "More thread actions";
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.setAttribute("aria-label", "More actions for this thread");
    // Named `menuPanel`, not `menu` — this function's card-local dropdown
    // would otherwise shadow the outer `menu` controller (createMenuController())
    // that `toggleMenuAt`/`closeOpenMenu` below actually belong to.
    const menuPanel = document.createElement("div");
    menuPanel.className = "mc-menu";
    menuPanel.setAttribute("role", "menu");
    menuPanel.hidden = true;
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.toggleMenuAt(menuBtn, menuPanel);
    });

    const openInEditorItem = menu.buildMenuItem("Open in editor", () => {
      host.post({ type: "open-in-editor", threadId: t.id });
      menu.closeOpenMenu(false);
    });
    const copyThreadItem = menu.buildMenuItem("Copy prompt", () => {
      host.post({ type: "copy-claude-comment", threadId: t.id });
      menu.closeOpenMenu(false);
    });
    // Two-click confirm, armed in place (no re-render) so the menu stays open
    // across the arm step.
    const deleteItem = menu.buildMenuItem(
      pendingDeleteThread.has(t.id) ? "Confirm delete" : "Delete",
      () => {
        if (pendingDeleteThread.has(t.id)) {
          pendingDeleteThread.delete(t.id);
          host.post({ type: "delete-thread", threadId: t.id });
          menu.closeOpenMenu(false);
          return;
        }
        pendingDeleteThread.add(t.id);
        deleteItem.textContent = "Confirm delete";
        // Auto-disarm so a stale "Confirm delete" doesn't sit there waiting.
        setTimeout(() => {
          if (pendingDeleteThread.delete(t.id) && deleteItem.isConnected) deleteItem.textContent = "Delete";
        }, 4000);
      },
      { danger: true },
    );
    menuPanel.append(openInEditorItem, copyThreadItem, deleteItem);
    menuWrap.append(menuBtn, menuPanel);

    actions.append(replyToggleBtn, resolveBtn, sendBtn, menuWrap);
    head.appendChild(actions);
    card.appendChild(head);

    // The waiting row hangs off the last comment, where the reply will land.
    const awaiting = pendingThreadIds.has(t.id);
    const lastLive = [...t.comments].reverse().find((c) => !c.deleted);
    for (const c of t.comments) card.appendChild(renderComment(t, c, awaiting && c === lastLive));
    if (awaiting) card.classList.add("awaiting-claude");

    // Clicks inside the reply box stay there: bubbling to the card would
    // scroll the document to the thread's highlight while the user types.
    const replyBox = document.createElement("div");
    replyBox.className = replyOpenNow ? "reply-box open" : "reply-box";
    replyBox.addEventListener("click", (e) => e.stopPropagation());
    replyBox.addEventListener("mousedown", (e) => e.stopPropagation());
    const composer = buildComposer({
      placeholder: "Reply…",
      submitLabel: "Reply",
      rows: 2,
      initialValue: pendingReplyText.get(t.id) ?? "",
      // Opens (and focuses) through `setReplyOpen`, not on mount.
      autofocus: false,
      onSubmit: (body) => {
        host.post({ type: "reply", threadId: t.id, body });
        composer.textarea.value = "";
        pendingReplyText.delete(t.id);
        setReplyOpen(t.id, false, false);
      },
    });
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

  function renderComment(thread: SidebarThread, c: SidebarComment, pending = false): HTMLElement {
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
          host.post({ type: "edit-comment", threadId: thread.id, commentId: c.id, body });
          editingCommentId = null;
        },
        onCancel: () => {
          editingCommentId = null;
          if (currentState) renderThreads(currentState);
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

    const armed = pendingDeleteComment.has(editingKey);
    const actions: CardAction[] = [
      {
        label: "Edit",
        onClick: () => {
          editingCommentId = editingKey;
          if (currentState) renderThreads(currentState);
        },
      },
      {
        label: armed ? "Confirm" : "Delete",
        variant: "danger",
        onClick: () => {
          if (pendingDeleteComment.has(editingKey)) {
            pendingDeleteComment.delete(editingKey);
            host.post({ type: "delete-comment", threadId: thread.id, commentId: c.id });
            return;
          }
          pendingDeleteComment.add(editingKey);
          setTimeout(() => {
            if (pendingDeleteComment.delete(editingKey) && currentState) renderThreads(currentState);
          }, 4000);
          if (currentState) renderThreads(currentState);
        },
      },
    ];
    if (armed) {
      actions.push({
        label: "Cancel",
        onClick: () => {
          pendingDeleteComment.delete(editingKey);
          if (currentState) renderThreads(currentState);
        },
      });
    }

    return buildCommentCard({
      author: c.author,
      timestamp: c.ts,
      note: c.editedTs ? "edited" : undefined,
      via: viaMarker(c),
      // Full markdown: a reply with a list or a fenced block is the normal case.
      bodyEl: buildCommentBody(c.body),
      reply: !!c.parent,
      actions,
      pending,
      pendingLabel: pendingLabelText,
      pendingAriaLive: true,
    });
  }

  function revealThread(threadId: string): void {
    if (!currentState) return;
    const target = currentState.threads.find((t) => t.id === threadId);
    if (!target) return;
    // A highlight whose thread the filter hides still has to land somewhere.
    if (!filterThreads([target], filter).length) setFilter("all");
    highlightedThreadId = threadId;
    const scrollToCard = (): void => {
      const card = cardFor(threadId);
      if (card) smoothScrollIntoView(card, "center");
      updateHighlightedCardDom(threadId);
    };
    const index = filterThreads(currentState.threads, filter).findIndex((t) => t.id === threadId);
    if (index >= renderedThreadLimit) {
      renderedThreadLimit = Math.ceil((index + 1) / THREAD_RENDER_CHUNK) * THREAD_RENDER_CHUNK;
      renderThreads(currentState);
    }
    // Landing on a card folded to its quote (a resolved thread starts so)
    // opens it — as a click on its chevron would, for the rest of the session.
    const card: CollapsibleCard = { kind: "thread", id: threadId, status: target.status };
    if (isCollapsedCard(card)) setCardCollapsed(card, false);
    scrollToCard();
  }

  function revealSuggestion(anchorId: string): void {
    const card = dom.threadsList.querySelector<HTMLElement>(`[data-suggestion-id="${cssEscape(anchorId)}"]`);
    if (card) smoothScrollIntoView(card, "center");
  }

  return {
    el: root,
    headerEl: dom.header,
    titleActionsEl: dom.titleActions,
    listEl: dom.threadsList,
    render,
    setSkillStatus,
    revealThread,
    revealSuggestion,
    notifyReviewPending(existingIds: string[]): void {
      pendingReviewSnapshot = new Set(existingIds);
      savePendingReviewSnapshot();
    },
    setChangeNavigation(step: ((delta: 1 | -1) => void) | null): void {
      stepChanges = step;
      updateKeysHint();
    },
  };
}

/** The stored `[cardKey, collapsed]` pairs that are pairs of those types; anything else is dropped. */
function collapseOverridesOf(value: unknown): Array<[string, boolean]> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is [string, boolean] =>
      Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "boolean",
  );
}

/**
 * "via tools" / "via cli" / "via file" — how an agent's comment reached the
 * file. Human comments get no marker. An unrecognized `via` reads as absent —
 * "via file" — which is always a safe guess: not through the tools or `mdc`.
 */
function viaMarker(c: SidebarComment): { label: string; title: string } | undefined {
  if (!isAgentComment(c)) return undefined;
  const kind: "tools" | "cli" | "file" = c.via === "tools" || c.via === "cli" ? c.via : "file";
  const title = {
    tools: "The agent wrote this through the review tools (MCP), not by hand-editing the file.",
    cli: "The agent wrote this through the `mdc` command-line tool.",
    file: "The agent edited the file's text directly — not through the review tools or `mdc`.",
  }[kind];
  return { label: `via ${kind}`, title };
}

function cssEscape(s: string): string {
  // Thread and anchor ids are short base36, no need for full CSS.escape.
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
