// Helpers for classifying threads as "new from Claude" vs "reviewed".
// Shared by the inline-comments webview and unit tests. Pure functions —
// no DOM, no vscode API dependency — so they work in both contexts.
//
// Despite the name (kept — renaming every file that imports this one is
// churn for nothing, 10x-plan-4 P1.2), these read through `isAgentComment`
// rather than a literal `"claude"` check, so a thread Cursor or Codex opened
// is "unread" and "reviewed" on exactly the same terms Claude's always were:
// what matters is whether a HUMAN has engaged with it yet, not which agent
// wrote it.

import { isAgentComment } from "../agentIdentity";

export interface ClaudeUnreadComment {
  author: string;
  deleted?: boolean;
  agent?: boolean;
}

export interface ClaudeUnreadThread {
  status: "open" | "resolved";
  comments: ClaudeUnreadComment[];
}

/**
 * A thread is "unread from Claude" when:
 *   - it's open,
 *   - the earliest non-deleted comment is an agent's, and
 *   - no non-agent (human) comment exists in the thread yet.
 * Once a human replies (or the thread resolves) it no longer counts as
 * unread — see `isClaudeReviewed`.
 */
export function isClaudeUnread(t: ClaudeUnreadThread): boolean {
  if (t.status !== "open") return false;
  const live = t.comments.filter((c) => !c.deleted);
  if (live.length === 0) return false;
  if (!isAgentComment(live[0])) return false;
  return !live.some((c) => !isAgentComment(c));
}

/**
 * An agent-initiated thread that the human has engaged with: either
 * replied to (at least one non-deleted, non-agent comment) or resolved.
 * Used to surface a *"M reviewed"* counter alongside *"N new from
 * Claude"* in the sidebar.
 */
export function isClaudeReviewed(t: ClaudeUnreadThread): boolean {
  const live = t.comments.filter((c) => !c.deleted);
  if (live.length === 0 || !isAgentComment(live[0])) return false;
  if (t.status === "resolved") return true;
  return live.some((c) => !isAgentComment(c));
}

/**
 * The slug of the agent that opened `t`, when it's unread — the "from
 * Claude"/"from Codex"/"from agents" wording (`agentGroupLabel`) reads this
 * off every unread thread in a list to decide which name(s) to use. `undefined`
 * when the thread isn't unread at all (nothing to attribute a label to).
 */
export function unreadAgentSlug(t: ClaudeUnreadThread): string | undefined {
  if (!isClaudeUnread(t)) return undefined;
  const live = t.comments.filter((c) => !c.deleted);
  return live[0]?.author.toLowerCase();
}
