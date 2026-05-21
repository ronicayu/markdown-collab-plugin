// Helpers for classifying threads as "new from Claude" vs "reviewed".
// Shared by the inline-comments webview and unit tests. Pure functions —
// no DOM, no vscode API dependency — so they work in both contexts.

export interface ClaudeUnreadComment {
  author: string;
  deleted?: boolean;
}

export interface ClaudeUnreadThread {
  status: "open" | "resolved";
  comments: ClaudeUnreadComment[];
}

/**
 * A thread is "unread from Claude" when:
 *   - it's open,
 *   - the earliest non-deleted comment is authored by `claude`, and
 *   - no non-claude comment exists in the thread yet.
 * Once a human replies (or the thread resolves) it no longer counts as
 * unread — see `isClaudeReviewed`.
 */
export function isClaudeUnread(t: ClaudeUnreadThread): boolean {
  if (t.status !== "open") return false;
  const live = t.comments.filter((c) => !c.deleted);
  if (live.length === 0) return false;
  if (live[0].author !== "claude") return false;
  return !live.some((c) => c.author !== "claude");
}

/**
 * A claude-initiated thread that the human has engaged with: either
 * replied to (at least one non-deleted, non-claude comment) or resolved.
 * Used to surface a *"M reviewed"* counter alongside *"N new from
 * Claude"* in the sidebar.
 */
export function isClaudeReviewed(t: ClaudeUnreadThread): boolean {
  const live = t.comments.filter((c) => !c.deleted);
  if (live.length === 0 || live[0].author !== "claude") return false;
  if (t.status === "resolved") return true;
  return live.some((c) => c.author !== "claude");
}
