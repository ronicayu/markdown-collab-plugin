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
import { isAgentComment } from "../agentIdentity";
import { isClaudeUnread } from "../inlineComments/claudeUnread";
import { isNavKeyContext } from "./diffNav";
import {
  THREAD_RENDER_CHUNK,
  adjacentThreadId,
  chunkThreads,
  claudeSummary,
  emptyState,
  filterThreads,
  nextCollapseAllAction,
  nextUnreadThreadId,
  threadCountLabel,
  type EmptyState,
  type ThreadFilter,
} from "./threadListState";
import { buildComposer, buildCommentBody, buildCommentCard, buildSuggestionCard, type CardAction } from "./commentUi";
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
  /** A slot in the title row for the host's own buttons (outline, add comment). */
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
    <span id="thread-count"></span>
    <span class="mc-title-actions"></span>
  </div>
  <div id="claude-summary" hidden>
    <span id="claude-summary-text" role="status" aria-live="polite"></span>
    <button id="claude-next" class="btn-link" title="Jump to the next unread thread from Claude.">Next</button>
  </div>
  <div class="filter-row" role="radiogroup" aria-label="Filter comment threads">
    <label class="segment"><input type="radio" name="filter" value="open" checked><span>Open</span></label>
    <label class="segment"><input type="radio" name="filter" value="all"><span>All</span></label>
    <label class="segment"><input type="radio" name="filter" value="resolved"><span>Resolved</span></label>
    <label id="filter-claude-label" class="segment" hidden><input type="radio" name="filter" value="claude-unread"><span id="filter-claude-label-text">New from Claude</span></label>
  </div>
  <div class="actions-row">
    <button id="send-to-claude" class="mc-btn mc-btn--primary" title="Send the prompt to a running Claude terminal (or your configured send mode).">Send to Claude</button>
    <span class="switch-row">
      <label id="suggest-mode-label" for="suggest-mode-toggle">Suggest mode</label>
      <button id="suggest-mode-toggle" type="button" class="switch" role="switch" aria-checked="false" aria-labelledby="suggest-mode-label" title="When on, Send to Claude asks Claude to propose edits as suggestions you accept or reject."></button>
    </span>
    <span class="switch-row">
      <label id="edit-mode-label" for="edit-mode-toggle">Edit</label>
      <button id="edit-mode-toggle" type="button" class="switch" role="switch" aria-checked="false" aria-labelledby="edit-mode-label" title="When on, you can edit the text in place. Off, the document is read-only and only comments change the file."></button>
    </span>
    <span class="actions-end">
      <span class="mc-menu-wrap">
        <button id="overflow-menu-btn" type="button" class="btn-ghost" aria-haspopup="menu" aria-expanded="false" aria-controls="overflow-menu" aria-label="More actions" title="More actions">…</button>
        <div id="overflow-menu" class="mc-menu" role="menu" aria-label="More actions" hidden>
          <button id="copy-prompt" type="button" role="menuitem" title="Copy the prompt to your clipboard.">Copy prompt</button>
          <button id="collapse-all" type="button" role="menuitem" title="Collapse / expand all comment threads">Collapse all</button>
          <button id="remove-resolved" type="button" role="menuitem" class="danger" hidden title="Delete every resolved comment from this file. Open comments and pending suggestions are kept.">Remove resolved</button>
          <button id="finalize-doc" type="button" role="menuitem" class="danger" hidden title="Remove ALL review data — every comment, marker, and pending suggestion — leaving clean markdown ready to commit.">Remove all review data</button>
        </div>
      </span>
      <button id="hint-toggle" class="btn-link" title="Show keyboard shortcuts" aria-pressed="false">?</button>
    </span>
  </div>
  <div id="keys-hint">n / p to move between threads · r reply · e resolve · o open in editor</div>
  <div id="skill-warning" class="skill-warning" hidden>
    <span id="skill-warning-text"></span>
    <button id="skill-install" class="btn-link"></button>
  </div>
</header>
<div id="threads-list" role="feed"><p class="mc-loading">Loading…</p></div>`;

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
    threadCount: byId<HTMLElement>("thread-count"),
    threadsList: byId<HTMLElement>("threads-list"),
    filterRadios: root.querySelectorAll<HTMLInputElement>('input[name="filter"]'),
    sendToClaude: byId<HTMLButtonElement>("send-to-claude"),
    copyPrompt: byId<HTMLButtonElement>("copy-prompt"),
    suggestModeToggle: byId<HTMLButtonElement>("suggest-mode-toggle"),
    editModeToggle: byId<HTMLButtonElement>("edit-mode-toggle"),
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
  };

  // Every preference goes through one merge, so a key another part of the
  // page persists is never dropped by this module's write, or vice versa.
  const saved = (): Record<string, unknown> => (host.getState() as Record<string, unknown> | undefined) ?? {};
  const persist = (patch: Record<string, unknown>): void => host.setState({ ...saved(), ...patch });

  // --- "…" overflow menus ----------------------------------------------------
  // One trigger/panel pair at a time is open — the toolbar's or a single
  // thread card's — tracked here rather than per-menu, so a click anywhere
  // else (another trigger, the document) closes whatever was open first. Escape
  // closes and returns focus to the trigger; an outside click closes without
  // stealing focus back from wherever the user clicked next.
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

  /** One `role="menuitem"` button for a "…" menu — the toolbar's or a card's. */
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

  // --- State -------------------------------------------------------------------

  let currentState: SidebarState | null = null;
  let filter: ThreadFilter = ((): ThreadFilter => {
    // Persisted, unlike the review view: switching Read/Edit reloads the page,
    // and the list the reviewer was working through shouldn't reset with it.
    const f = saved().threadFilter;
    return THREAD_FILTERS.includes(f as ThreadFilter) ? (f as ThreadFilter) : "open";
  })();
  let pendingThreadIds: ReadonlySet<string> = new Set();
  let pendingLabelText = "Claude is working…";
  let agentName = "Claude";
  let headlessAvailable = false;
  let readOnly = false;
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

  // Thread IDs the user has collapsed (folded to just the quote). Persisted so
  // the choice survives a webview reload.
  const collapsedThreads = new Set<string>((saved().collapsedThreadIds as string[] | undefined) ?? []);
  const saveCollapsedThreads = (): void => persist({ collapsedThreadIds: Array.from(collapsedThreads) });

  // Set when an agent is asked to review this doc: the thread IDs that existed
  // then. On the next render where a new unread thread appears, scroll to the
  // first one and clear the snapshot. Survives a webview reload via state.
  let pendingReviewSnapshot: Set<string> | null = ((): Set<string> | null => {
    const ids = saved().pendingReviewIds as string[] | null | undefined;
    return ids ? new Set(ids) : null;
  })();
  const savePendingReviewSnapshot = (): void =>
    persist({ pendingReviewIds: pendingReviewSnapshot ? Array.from(pendingReviewSnapshot) : null });

  // --- Toolbar -------------------------------------------------------------------

  dom.sendToClaude.addEventListener("click", () => host.post({ type: "send-to-claude" }));
  // The rest of the overflow menu's items close it after each click: every one
  // of them is a one-shot action, not a toggle.
  dom.copyPrompt.addEventListener("click", () => {
    host.post({ type: "copy-prompt" });
    closeOpenMenu(false);
  });
  // Neither switch flips itself: the setting is the host's, and the switch
  // only reflects what comes back — anything else would show "on" after a
  // write that failed.
  dom.suggestModeToggle.addEventListener("click", () => host.post({ type: "toggle-suggest-mode" }));
  dom.editModeToggle.addEventListener("click", () => host.post({ type: "set-read-only", readOnly: !readOnly }));
  // The host owns the confirm and the write for both bulk deletes: a webview
  // can't show a modal, and a two-click arm is too quiet for something that
  // removes many threads at once.
  dom.removeResolved.addEventListener("click", () => {
    host.post({ type: "remove-resolved" });
    closeOpenMenu(false);
  });
  dom.finalizeDoc.addEventListener("click", () => {
    host.post({ type: "finalize" });
    closeOpenMenu(false);
  });
  dom.skillInstall.addEventListener("click", () => {
    dom.skillInstall.disabled = true;
    dom.skillInstall.textContent = "Installing…";
    host.post({ type: "install-skill" });
  });
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

  function updateSwitches(state: SidebarState): void {
    dom.suggestModeToggle.setAttribute("aria-checked", String(state.suggestMode));
    dom.suggestModeToggle.classList.toggle("on", state.suggestMode);
    dom.editModeToggle.setAttribute("aria-checked", String(!state.readOnly));
    dom.editModeToggle.classList.toggle("on", !state.readOnly);
  }

  /**
   * Put `agentName` wherever there's no per-thread agent to name instead: the
   * Send button, its title, and the suggest-mode switch title.
   */
  function updateAgentUi(): void {
    dom.sendToClaude.textContent = `Send to ${agentName}`;
    dom.sendToClaude.title = `Send the prompt to a running ${agentName} terminal (or your configured send mode).`;
    dom.suggestModeToggle.title = `When on, Send to ${agentName} asks ${agentName} to propose edits as suggestions you accept or reject.`;
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

  function applyHintVisibility(): void {
    dom.keysHint.hidden = hintDismissed;
    dom.hintToggle.setAttribute("aria-pressed", String(!hintDismissed));
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
  });

  /** The hint names what n/p will actually do: step changes while stripes show, walk threads otherwise. */
  function updateKeysHint(): void {
    const target = stepChanges ? "changes" : "threads";
    dom.keysHint.textContent = `n / p to move between ${target} · r reply · e resolve · o open in editor`;
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
    if (collapsedThreads.has(highlightedThreadId)) setThreadCollapsed(highlightedThreadId, false);
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

  function updateCollapseAllLabel(): void {
    const threads = currentState?.threads ?? [];
    const allCollapsed = threads.length > 0 && threads.every((t) => collapsedThreads.has(t.id));
    dom.collapseAll.textContent = allCollapsed ? "Expand all" : "Collapse all";
    dom.collapseAll.disabled = threads.length === 0;
  }

  // Fold/unfold one thread in place (no re-render, so an in-progress reply on
  // another card isn't wiped).
  function setThreadCollapsed(id: string, collapsed: boolean): void {
    if (collapsed) collapsedThreads.add(id);
    else collapsedThreads.delete(id);
    saveCollapsedThreads();
    const card = cardFor(id);
    card?.classList.toggle("collapsed", collapsed);
    const chevron = card?.querySelector<HTMLButtonElement>(".thread-collapse");
    if (chevron) chevron.textContent = collapsed ? "▸" : "▾";
    updateCollapseAllLabel();
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
    readOnly = state.readOnly;
    updateSwitches(state);
    updateAgentUi();
    renderThreads(state);
    updateCollapseAllLabel();
    maybeScrollToNewReview(state);
  }

  function renderThreads(state: SidebarState): void {
    captureReplyState();
    const list = dom.threadsList;
    // A card's "…" menu is about to be torn down with the list; don't leave
    // `openMenu` pointing at a detached panel. The toolbar's menu is untouched.
    if (openMenu && list.contains(openMenu.panel)) closeOpenMenu(false);
    list.innerHTML = "";

    // Pending suggestions render above the threads regardless of the filter —
    // an unreviewed edit is the most actionable thing here.
    if (state.suggestions.length > 1) list.appendChild(renderAcceptAll(state.suggestions.length));
    for (const s of state.suggestions) list.appendChild(renderSuggestion(s));

    renderClaudeSummary(state);
    const filtered = filterThreads(state.threads, filter);
    dom.threadCount.textContent = threadCountLabel(state.threads);
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
      more.className = "btn-ghost mc-show-more";
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
    btn.className = "btn-ghost";
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
    const card = document.createElement("section");
    card.className = "thread-card";
    if (t.status === "resolved") card.classList.add("resolved");
    if (t.id === highlightedThreadId) card.classList.add("highlighted");
    if (isClaudeUnread(t)) card.classList.add("claude-unread");
    if (collapsedThreads.has(t.id)) card.classList.add("collapsed");
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
    headRow.appendChild(quote);
    head.appendChild(headRow);

    // Visible per-card actions are Reply and Resolve/Reopen; every other
    // per-thread action lives in the "…" menu.
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
      host.post({ type: "toggle-resolve", threadId: t.id });
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
      host.post({ type: "open-in-editor", threadId: t.id });
      closeOpenMenu(false);
    });
    const sendThreadItem = buildMenuItem("Send this thread", () => {
      host.post({ type: "send-to-claude-comment", threadId: t.id });
      closeOpenMenu(false);
    });
    const copyThreadItem = buildMenuItem("Copy prompt", () => {
      host.post({ type: "copy-claude-comment", threadId: t.id });
      closeOpenMenu(false);
    });
    // Two-click confirm, armed in place (no re-render) so the menu stays open
    // across the arm step.
    const deleteItem = buildMenuItem(
      pendingDeleteThread.has(t.id) ? "Confirm delete" : "Delete",
      () => {
        if (pendingDeleteThread.has(t.id)) {
          pendingDeleteThread.delete(t.id);
          host.post({ type: "delete-thread", threadId: t.id });
          closeOpenMenu(false);
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
    menu.append(openInEditorItem, sendThreadItem, copyThreadItem, deleteItem);
    menuWrap.append(menuBtn, menu);

    actions.append(replyToggleBtn, resolveBtn, menuWrap);
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
