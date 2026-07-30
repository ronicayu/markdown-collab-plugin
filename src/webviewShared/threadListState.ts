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

import { isClaudeReviewed, isClaudeUnread } from "../inlineComments/claudeUnread";

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
}

/**
 * Counts for the "N new from Claude · M reviewed" row. A thread is counted
 * once: unread until the human replies or resolves it, reviewed after.
 */
export function claudeSummary(threads: ListThread[]): ClaudeSummary {
  let unread = 0;
  let reviewed = 0;
  for (const t of threads) {
    if (isClaudeUnread(t)) unread++;
    else if (isClaudeReviewed(t)) reviewed++;
  }
  const hasAny = unread + reviewed > 0;
  const unreadLabel = unread === 1 ? "1 new from Claude" : `${unread} new from Claude`;
  const reviewedLabel = reviewed === 1 ? "1 reviewed" : `${reviewed} reviewed`;
  return {
    unread,
    reviewed,
    hasAny,
    text: hasAny ? `${unreadLabel} · ${reviewedLabel}` : "",
  };
}

/** What an empty thread list should say, given why it's empty. */
export function emptyListMessage(filter: ThreadFilter): string {
  if (filter === "open") {
    return "No open comments. Select text in the preview to start a thread.";
  }
  if (filter === "claude-unread") {
    return "No unread threads from Claude. Run 'Ask Claude to Review This Doc' to start one.";
  }
  return "No comments match this filter.";
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
