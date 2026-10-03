// Thread-list state for the comment panels (10x-plan P2.4).
//
// The webview clients are the churned layer of this codebase, and most of what
// they got wrong over 126 versions was not DOM manipulation but the arithmetic
// around it: which threads a filter admits, what the counters say, which
// thread the "Next" button should land on, and whether a card's content
// actually changed. That logic is pure. It lives here so it can be tested
// without a DOM, and so the inline view and the live editor agree on it.
//
// Structural input types: the two clients carry different thread shapes
// (SerializedState.threads vs CommentSummary), so these take the narrowest
// structure each function needs rather than a shared nominal type.

import { isClaudeReviewed, isClaudeUnread, unreadAgentSlug } from "../inlineComments/claudeUnread";
import { agentGroupLabel } from "../agentIdentity";

export type ThreadFilter = "open" | "all" | "resolved" | "claude-unread";

export interface ListThread {
  id: string;
  status: "open" | "resolved";
  comments: Array<{ author: string; deleted?: boolean }>;
}

/** Does `filter` admit this thread? */
export function matchesFilter(thread: ListThread, filter: ThreadFilter): boolean {
  if (filter === "open") return thread.status === "open";
  if (filter === "resolved") return thread.status === "resolved";
  if (filter === "claude-unread") return isClaudeUnread(thread);
  return true;
}

/** The threads a filter shows, in input order. */
export function filterThreads<T extends ListThread>(threads: T[], filter: ThreadFilter): T[] {
  return threads.filter((t) => matchesFilter(t, filter));
}

/** The inline view's header counter: `"3 open · 7 total"`. */
export function threadCountLabel(threads: ListThread[]): string {
  const open = threads.filter((t) => t.status === "open").length;
  return `${open} open · ${threads.length} total`;
}

/**
 * Per-tab counts for the live editor's filter row (sidebar-chrome-redesign):
 * each tab reads its own count instead of one combined header line.
 */
export interface FilterCounts {
  open: number;
  all: number;
  resolved: number;
}

export function filterCounts(threads: ListThread[]): FilterCounts {
  let open = 0;
  let resolved = 0;
  for (const t of threads) {
    if (t.status === "open") open++;
    else resolved++;
  }
  return { open, all: threads.length, resolved };
}

/**
 * The live editor's filter-button label, which doubles as its counter: it
 * names the filter's effect when filtering, and the counts when not.
 */
export function sidebarCountLabel(opts: {
  open: number;
  total: number;
  hideResolved: boolean;
}): string {
  return opts.hideResolved
    ? `Showing open · ${opts.open}`
    : `${opts.open} open · ${opts.total} total`;
}

export interface ClaudeSummary {
  unread: number;
  reviewed: number;
  /** Whether any Claude-initiated thread exists — the summary row's visibility. */
  hasAny: boolean;
  /** `"2 new from Claude · 1 reviewed"`. Empty when `hasAny` is false. */
  text: string;
  /**
   * The same agent noun baked into `text` ("Claude", another agent's name, or
   * "agents"), exposed separately so callers with their own copy to fill in —
   * the filter chip, a button's title — can name the actual agent instead of
   * hardcoding "Claude" (round-4 P3, agent-neutral copy). Falls back to the
   * generic "Agent" when there are no unread threads to derive it from.
   */
  agentNoun: string;
}

/**
 * Counts for the "N new from Claude · M reviewed" row. A thread is counted
 * once: unread until the human replies or resolves it, reviewed after.
 *
 * The label names whichever agent(s) the unread threads actually came from
 * (the wording rule: name the agent when the code knows it): the one agent's
 * name ("Claude", "Codex", …) when every unread thread came from the same
 * agent, and the generic "agents" when more than one distinct agent
 * contributed.
 */
export function claudeSummary(threads: ListThread[]): ClaudeSummary {
  let unread = 0;
  let reviewed = 0;
  const unreadSlugs: string[] = [];
  for (const t of threads) {
    if (isClaudeUnread(t)) {
      unread++;
      const slug = unreadAgentSlug(t);
      if (slug) unreadSlugs.push(slug);
    } else if (isClaudeReviewed(t)) reviewed++;
  }
  const hasAny = unread + reviewed > 0;
  const agentNoun = agentGroupLabel(unreadSlugs).noun;
  const unreadLabel = unread === 1 ? `1 new from ${agentNoun}` : `${unread} new from ${agentNoun}`;
  const reviewedLabel = reviewed === 1 ? "1 reviewed" : `${reviewed} reviewed`;
  return {
    unread,
    reviewed,
    hasAny,
    text: hasAny ? `${unreadLabel} · ${reviewedLabel}` : "",
    agentNoun,
  };
}

/** What an empty thread list should say, given why it's empty. */
export function emptyListMessage(filter: ThreadFilter): string {
  if (filter === "open") {
    return "No open comments. Select text in the preview to start a thread.";
  }
  if (filter === "claude-unread") {
    // Command renamed to "Ask Agent to Review This Doc" (package.json). This
    // function only gets `filter`, not the thread list, so there's no agent to
    // name — there are no unread threads to draw one from, which is exactly
    // why this message is showing — and the wording rule says "an agent".
    return "No unread threads from an agent. Run 'Ask Agent to Review This Doc' to start one.";
  }
  return "No comments match this filter.";
}

/** A filter is hiding threads that exist — the plain one-line message. */
export interface FilteredEmptyState {
  kind: "filtered";
  message: string;
}

/**
 * The doc has never had a comment on it — the first-minute path, not a filter
 * artifact. Rendered as a small card instead of a line of grey text (10x-plan-4
 * P2.4 / round-3 P3.1): a brand-new user staring at a blank sidebar has no way
 * to know a comment is even possible, let alone that an agent can start one.
 */
export interface FirstRunEmptyState {
  kind: "first-run";
  headline: string;
  hint: string;
  action: {
    label: string;
    /** Posted verbatim by the card's button. */
    message: { type: "empty-state-review" };
  };
}

export type EmptyState = FilteredEmptyState | FirstRunEmptyState;

const HINT_BOTH_FORMS =
  "Select text in the document and click + Add comment — or, in the text editor, select it and press Cmd+K Cmd+Alt+M (Ctrl+K Ctrl+Alt+M).";
const HINT_MAC =
  "Select text in the document and click + Add comment — or, in the text editor, select it and press Cmd+K Cmd+Alt+M.";
const HINT_OTHER =
  "Select text in the document and click + Add comment — or, in the text editor, select it and press Ctrl+K Ctrl+Alt+M.";

/**
 * What the empty state should show. Two branches, not one message with a
 * condition folded in — a filter hiding real threads and a document nobody has
 * ever commented on call for different UI (a line of text vs. a card with a
 * button), and `emptyListMessage` already owns the wording for the first.
 *
 * `platform` lets a caller that knows the webview's OS collapse the hint to
 * one keybinding form; omitted (e.g. this function tested in isolation, or a
 * host that never bothered to detect it), both forms are spelled out so the
 * hint is still correct everywhere.
 */
export function emptyState(opts: {
  filter: ThreadFilter;
  /** Every thread in the document, before filtering — 0 means "never reviewed". */
  totalThreads: number;
  platform?: "mac" | "other";
}): EmptyState {
  if (opts.totalThreads > 0) {
    return { kind: "filtered", message: emptyListMessage(opts.filter) };
  }
  const hint =
    opts.platform === "mac" ? HINT_MAC : opts.platform === "other" ? HINT_OTHER : HINT_BOTH_FORMS;
  return {
    kind: "first-run",
    headline: "No comments yet.",
    hint,
    action: {
      // The same words as the "Ask Agent to Review This Doc" command; the
      // empty state can't know which agent (or send mode) the click will use.
      label: "Ask agent to review",
      message: { type: "empty-state-review" },
    },
  };
}

/**
 * The next unread-from-Claude thread after `currentId`, wrapping at the end.
 * `null` when there are none. Passing an id that isn't in the unread list
 * (e.g. the human just replied to the highlighted thread) starts from the top,
 * so the walk never dead-ends on a stale cursor.
 */
export function nextUnreadThreadId(threads: ListThread[], currentId: string | null): string | null {
  const unread = threads.filter((t) => isClaudeUnread(t));
  if (unread.length === 0) return null;
  const currentIdx = currentId ? unread.findIndex((t) => t.id === currentId) : -1;
  return unread[(currentIdx + 1) % unread.length].id;
}

/**
 * The next/previous card in `filter`'s current list, wrapping at both ends.
 * `delta` is +1 for "next" (`n`), -1 for "previous" (`p`) — the in-webview
 * thread navigation (10x-plan-4 P2.1), which walks whatever the filter is
 * currently showing rather than a fixed "unread" subset like
 * `nextUnreadThreadId` does.
 *
 * `currentId` not being in the filtered list (nothing highlighted yet, the
 * highlighted thread just left the filter, or the filter itself just
 * changed) is treated as "start fresh": `n` lands on the first card, `p` on
 * the last, so the walk never dead-ends on a stale or absent cursor.
 */
export function adjacentThreadId(
  threads: ListThread[],
  filter: ThreadFilter,
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  const filtered = filterThreads(threads, filter);
  if (filtered.length === 0) return null;
  const currentIdx = currentId ? filtered.findIndex((t) => t.id === currentId) : -1;
  if (currentIdx === -1) {
    return delta === 1 ? filtered[0].id : filtered[filtered.length - 1].id;
  }
  return filtered[(currentIdx + delta + filtered.length) % filtered.length].id;
}

/**
 * Whether the collapse-all control should collapse or expand next: expand only
 * when everything is already collapsed, so a partially-collapsed list
 * collapses the rest rather than flipping to expanded.
 */
export function nextCollapseAllAction(
  threadIds: string[],
  collapsed: ReadonlySet<string>,
): "collapse" | "expand" {
  const allCollapsed = threadIds.length > 0 && threadIds.every((id) => collapsed.has(id));
  return allCollapsed ? "expand" : "collapse";
}

/**
 * A card the thread list can fold — a thread or a pending suggestion,
 * described just enough to pick its default collapse state (round-8 P1,
 * "every kind of comment collapses").
 */
export type CollapsibleCard =
  | { kind: "thread"; id: string; status: "open" | "resolved" }
  | { kind: "suggestion"; id: string };

/**
 * A stable key for a card's persisted collapse override — namespaced by kind
 * so a thread id and a suggestion anchor id, drawn from different id spaces,
 * can never collide in the one map the sidebar persists.
 */
export function collapseKey(card: CollapsibleCard): string {
  return `${card.kind}:${card.id}`;
}

/**
 * Whether a card should render collapsed. A manual toggle — recorded in
 * `overrides`, keyed by `collapseKey` — always wins, so it survives whatever
 * the card's own status does next. Short of one: a resolved thread starts
 * collapsed (it's settled; the review pass doesn't need it in the way), and
 * everything else — an open thread, a pending suggestion — starts expanded,
 * since those are exactly the things a review pass still has to look at.
 */
export function initialCollapsed(card: CollapsibleCard, overrides: ReadonlyMap<string, boolean>): boolean {
  const override = overrides.get(collapseKey(card));
  if (override !== undefined) return override;
  return card.kind === "thread" && card.status === "resolved";
}

/**
 * How many thread cards to build in one pass. Each card is a non-trivial DOM
 * subtree (header, body, replies, an always-on reply box), so a review pass
 * that opened 300 threads used to build 300 of them synchronously before the
 * panel painted anything.
 */
export const THREAD_RENDER_CHUNK = 100;

export interface ThreadChunk<T> {
  /** The threads to build cards for now. */
  visible: T[];
  /** How many are held back behind the "show more" control. */
  remaining: number;
  /** Label for that control, or null when everything is rendered. */
  moreLabel: string | null;
}

/**
 * Split a filtered thread list into what to render now and what to hold back.
 *
 * Deliberately progressive rendering, NOT virtualization: cards already built
 * stay in the DOM, so find-in-page, Cmd+F, and scroll position keep working —
 * a windowed list would silently hide threads from all three. The cap only
 * defers the initial build.
 */
export function chunkThreads<T>(threads: T[], shown: number): ThreadChunk<T> {
  const limit = Math.max(0, shown);
  if (threads.length <= limit) {
    return { visible: threads, remaining: 0, moreLabel: null };
  }
  const remaining = threads.length - limit;
  const next = Math.min(remaining, THREAD_RENDER_CHUNK);
  return {
    visible: threads.slice(0, limit),
    remaining,
    moreLabel:
      remaining === next
        ? `Show ${remaining} more`
        : `Show ${next} more (${remaining} hidden)`,
  };
}

/** A thread's rendered content, for the live editor's reconciler. */
export interface SignatureThread {
  author: string;
  createdAt: string;
  body: string;
  resolved: boolean;
  anchor: { text: string };
  replies: Array<{ author: string; createdAt: string; body: string }>;
}

/**
 * A stable identity for a thread's rendered content. Two renders with the same
 * signature are byte-identical, so the reconciler can leave that card's DOM
 * untouched — preserving the always-on reply box's focus and caret. Anything
 * the card displays must be in here, or an edit won't repaint; anything it
 * doesn't display must stay out, or every unrelated update destroys the card
 * the human is typing in.
 *
 * `pending` is part of the signature because the card renders a waiting row
 * from it, and that row is the one thing that changes with no accompanying
 * content change — a dispatch flips it on while author, body, and replies all
 * stay identical. Leaving it out kept the indicator off the live editor
 * entirely (caught by the webview e2e suite, 10x-plan-2 P2.1). Pass the row's
 * *text* rather than a flag when there is one, so a phase update from
 * `mc_status` repaints too (10x-plan-2 P0.2).
 */
export function threadSignature(c: SignatureThread, pending: boolean | string = false): string {
  return JSON.stringify({
    a: c.author,
    t: c.createdAt,
    b: c.body,
    r: c.resolved,
    an: c.anchor.text,
    rep: c.replies.map((x) => [x.author, x.createdAt, x.body]),
    p: pending,
  });
}
