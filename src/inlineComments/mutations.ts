// Document mutations requested by the inline-comments webview (10x-plan P2.4).
//
// Every comment operation the human performs arrives as a postMessage and ends
// as a full-document rewrite. That transform — message + current document in,
// new document out — is the highest-risk code in the extension and used to be
// buried in the panel class next to `WorkspaceEdit` plumbing and `vscode.window`
// calls, where it could only be tested through an Extension Host.
//
// It lives here as a pure function so the host↔webview protocol can be tested
// as a contract: feed a recorded message and a document, assert the resulting
// document. The panel keeps the side effects (applying the edit, showing the
// warning this returns, and the non-document messages like open-link).

import {
  acceptSuggestion,
  addThread,
  appendReply,
  parse,
  rejectSuggestion,
  replaceThread,
  type InlineComment,
  type InlineThread,
  type ParsedDocument,
} from "./format";
import { mapProseToSource } from "./proseMapping";
import { withRefreshedAnchorHash } from "./staleness";

/** The webview messages that rewrite the document. */
export type MutationMessage =
  | { type: "add-comment"; selStart: number; selEnd: number; body: string }
  | { type: "reply"; threadId: string; body: string; parentCommentId?: string }
  | { type: "edit-comment"; threadId: string; commentId: string; body: string }
  | { type: "toggle-resolve"; threadId: string }
  | { type: "delete-thread"; threadId: string }
  | { type: "delete-comment"; threadId: string; commentId: string }
  | { type: "accept-suggestion"; anchorId: string }
  | { type: "reject-suggestion"; anchorId: string }
  /** Accept every anchored suggestion in the file, in one undoable step (P3.3). */
  | { type: "accept-all-suggestions" };

export interface MutationContext {
  /** Author attributed to new comments and to resolving. */
  author: string;
  /** Current time as an ISO-8601 string. Injected so tests are deterministic. */
  now: () => string;
}

export interface MutationResult {
  /** The new document. Identical to the input when the mutation was a no-op. */
  source: string;
  /**
   * A message for the human explaining why nothing happened. Present only
   * when the request could not be carried out for a reason they can act on —
   * a stale thread id is a silent no-op, a selection that won't map is not.
   */
  warning?: string;
}

/**
 * Apply one webview mutation to the parsed document.
 *
 * Unknown or stale ids return the source unchanged rather than throwing: the
 * webview's state can lag the file by one edit (Claude may have just resolved
 * the thread on disk), and a no-op is the right answer to "reply to a thread
 * that no longer exists".
 */
export function applyClientMutation(
  parsed: ParsedDocument,
  msg: MutationMessage,
  ctx: MutationContext,
): MutationResult {
  switch (msg.type) {
    case "add-comment":
      return addComment(parsed, msg, ctx);
    case "reply": {
      const t = findThread(parsed, msg.threadId);
      if (!t) return { source: parsed.source };
      const next = appendReply(t, {
        author: ctx.author,
        body: msg.body,
        parent: msg.parentCommentId,
      });
      // The replier just read the passage as it stands, so this reply is the
      // new baseline for "text changed since this comment" (P1.3).
      return {
        source: replaceThread(parsed.source, t.id, withRefreshedAnchorHash(parsed, next)),
      };
    }
    case "edit-comment": {
      const t = findThread(parsed, msg.threadId);
      if (!t) return { source: parsed.source };
      const editedTs = ctx.now();
      const next: InlineThread = {
        ...t,
        comments: t.comments.map((c) =>
          c.id === msg.commentId ? { ...c, body: msg.body, editedTs } : c,
        ),
      };
      return { source: replaceThread(parsed.source, t.id, next) };
    }
    case "toggle-resolve": {
      const t = findThread(parsed, msg.threadId);
      if (!t) return { source: parsed.source };
      const next: InlineThread =
        t.status === "open"
          ? { ...t, status: "resolved", resolvedBy: ctx.author, resolvedTs: ctx.now() }
          : { ...t, status: "open", resolvedBy: undefined, resolvedTs: undefined };
      return { source: replaceThread(parsed.source, t.id, next) };
    }
    case "delete-thread":
      return { source: replaceThread(parsed.source, msg.threadId, null) };
    case "delete-comment":
      return deleteComment(parsed, msg);
    case "accept-suggestion":
      // An unanchored suggestion can't place its change — leave it for the
      // human to reject rather than guessing where it belongs.
      if (!parsed.anchors.has(msg.anchorId)) return { source: parsed.source };
      return { source: acceptSuggestion(parsed.source, msg.anchorId) };
    case "reject-suggestion":
      return { source: rejectSuggestion(parsed.source, msg.anchorId) };
    case "accept-all-suggestions": {
      // Applied one at a time against the running source, because each accept
      // moves the offsets the next one depends on. Unanchored suggestions are
      // skipped and reported rather than guessed at, exactly as a single accept
      // treats them.
      let source = parsed.source;
      let applied = 0;
      let skipped = 0;
      for (const s of parsed.suggestions) {
        if (!parse(source).anchors.has(s.anchorId)) {
          skipped++;
          continue;
        }
        source = acceptSuggestion(source, s.anchorId);
        applied++;
      }
      if (applied === 0 && skipped === 0) return { source: parsed.source };
      return {
        source,
        warning:
          skipped > 0
            ? `Accepted ${applied} suggestion${applied === 1 ? "" : "s"}; skipped ${skipped} that lost their anchors — reject those.`
            : undefined,
      };
    }
  }
}

function findThread(parsed: ParsedDocument, id: string): InlineThread | undefined {
  return parsed.threads.find((t) => t.id === id);
}

function addComment(
  parsed: ParsedDocument,
  msg: Extract<MutationMessage, { type: "add-comment" }>,
  ctx: MutationContext,
): MutationResult {
  // The selection arrives in *prose* (stripped) offset space — what the
  // preview rendered. Map it back to source-offset space before inserting
  // markers, or the anchor lands in the wrong place in any document that
  // already has markers or frontmatter above the selection.
  const { proseStartToSource, proseEndToSource } = mapProseToSource(parsed);
  const sStart = proseStartToSource(msg.selStart);
  const sEnd = proseEndToSource(msg.selEnd);
  if (sStart === null || sEnd === null) {
    return {
      source: parsed.source,
      warning: "Could not map selection back to source — try selecting again.",
    };
  }
  if (sStart === sEnd) {
    return {
      source: parsed.source,
      warning: "Select some text to anchor the comment to.",
    };
  }
  try {
    const { source } = addThread(parsed.source, sStart, sEnd, {
      author: ctx.author,
      body: msg.body,
      ts: ctx.now(),
    });
    return { source };
  } catch (e) {
    // addThread refuses anchors inside code fences/spans, frontmatter, and the
    // threads region. That refusal is the feature — surface it instead of
    // writing a thread whose markers would render as literal text.
    return { source: parsed.source, warning: (e as Error).message };
  }
}

function deleteComment(
  parsed: ParsedDocument,
  msg: Extract<MutationMessage, { type: "delete-comment" }>,
): MutationResult {
  const t = findThread(parsed, msg.threadId);
  if (!t) return { source: parsed.source };
  // If the comment has descendants (replies), tombstone to keep the tree
  // shape. If it's a leaf, drop it entirely. If removing it leaves the thread
  // empty, delete the whole thread.
  const hasChildren = t.comments.some((c) => c.parent === msg.commentId && !c.deleted);
  let nextComments: InlineComment[];
  if (hasChildren) {
    nextComments = t.comments.map((c) =>
      c.id === msg.commentId ? { ...c, deleted: true, body: "" } : c,
    );
  } else {
    nextComments = t.comments.filter((c) => c.id !== msg.commentId);
  }
  const liveCount = nextComments.filter((c) => !c.deleted).length;
  if (liveCount === 0) return { source: replaceThread(parsed.source, t.id, null) };
  return { source: replaceThread(parsed.source, t.id, { ...t, comments: nextComments }) };
}
