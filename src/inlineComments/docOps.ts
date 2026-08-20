// The review operations, as pure source→source functions.
//
// WHY THIS EXISTS (10x-plan-2 P0.1): `mdc` (the CLI Claude runs) and the
// extension-hosted MCP server expose the same seven verbs. Implementing them
// twice would mean two definitions of "reply" that drift — one of them
// eventually accepting an edit the other refuses. So the verbs live here, once,
// as functions over a markdown string, and each front end supplies only its own
// I/O and error reporting:
//
//   mdc.ts        → readFileSync / writeFileSync, exit codes
//   mcpServer/    → WorkspaceEdit on the open TextDocument, JSON-RPC errors
//
// Every mutating op validates integrity BEFORE returning, and throws rather
// than handing back a document that is worse than the one it was given. That is
// the difference from the CLI's original design, which wrote first and checked
// after: a rejected operation now never reaches the file at all.

import {
  acceptSuggestion,
  addSuggestion,
  addThread,
  appendReply,
  parse,
  rejectSuggestion,
  replaceThread,
  withThreads,
  type InlineThread,
  type ReviewCheckpoint,
} from "./format";
import { checkpointFor } from "./deltaReview";
import { checkIntegrity, type IntegrityIssue } from "./integrity";
import { hashAnchorText, staleThreadIds, withRefreshedAnchorHash } from "./staleness";

/** Machine-readable reason an operation refused. */
export type DocOpCode =
  /** No thread with that id in the document. */
  | "thread_not_found"
  /** No pending suggestion with that anchor id. */
  | "suggestion_not_found"
  /** The quoted passage isn't in the prose. */
  | "passage_not_found"
  /** The passage appears more than once and no occurrence was given. */
  | "passage_ambiguous"
  /** The thread/suggestion has no anchor markers, so its span can't be placed. */
  | "unanchored"
  /** The span can't carry an anchor (frontmatter, threads region, code). */
  | "not_anchorable"
  /** An empty or inverted range was given where a passage was required. */
  | "empty_selection"
  /** The given range falls outside the document. */
  | "out_of_range"
  /** The operation had nothing to act on; the document is unchanged. */
  | "nothing_to_do"
  /** The result would introduce integrity problems; nothing was changed. */
  | "integrity";

/**
 * A refused operation. Carries a code so callers can map to their own error
 * channel (an exit status, a JSON-RPC error) without string-matching.
 */
export class DocOpError extends Error {
  constructor(
    readonly code: DocOpCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DocOpError";
  }
}

/** A mutating op's output: the new source plus what to report about it. */
export interface OpOutcome<T> {
  next: string;
  result: T;
}

/**
 * Refuse a mutation that would leave the document with more integrity problems
 * than it started with. Pre-write, unlike the check-after-write the CLI used to
 * do: the caller can surface a structured refusal while the file still holds
 * its last good state.
 */
export function assertNoNewIssues(before: string, after: string): IntegrityIssue[] {
  const wasBroken = checkIntegrity(before).issues.length;
  const report = checkIntegrity(after);
  if (report.issues.length > wasBroken) {
    const introduced = report.issues.length - wasBroken;
    throw new DocOpError(
      "integrity",
      `refusing to write — the change would introduce ${introduced} integrity problem(s): ${report.issues
        .map((i) => i.message)
        .join("; ")}`,
      { issues: report.issues },
    );
  }
  return report.issues;
}

function findThread(source: string, threadId: string): InlineThread {
  const t = parse(source).threads.find((x) => x.id === threadId);
  if (!t) {
    throw new DocOpError("thread_not_found", `no thread with id ${threadId} in this file`, { threadId });
  }
  return t;
}

/** Last non-deleted comment — used to decide whether a thread awaits Claude. */
function lastLiveComment(t: InlineThread) {
  const live = t.comments.filter((c) => !c.deleted);
  return live[live.length - 1];
}

/**
 * Locate the `occurrence`-th appearance of `quote` in the prose (before the
 * threads region), refusing ambiguity rather than guessing. `occurrence` is
 * 1-based; 0 means "there must be exactly one".
 */
export function locatePassage(source: string, quote: string, occurrence = 0): number {
  const parsed = parse(source);
  const limit = parsed.threadsRegion ? parsed.threadsRegion.start : source.length;
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(quote, from);
    if (at === -1 || at >= limit) break;
    hits.push(at);
    from = at + quote.length;
  }
  if (hits.length === 0) {
    throw new DocOpError("passage_not_found", `passage not found: ${JSON.stringify(quote.slice(0, 60))}`, {
      quote,
    });
  }
  if (hits.length > 1 && occurrence === 0) {
    throw new DocOpError(
      "passage_ambiguous",
      `passage appears ${hits.length} times; pass occurrence 1..${hits.length} to say which one you mean`,
      { quote, occurrences: hits.length },
    );
  }
  const index = occurrence === 0 ? 0 : occurrence - 1;
  if (index < 0 || index >= hits.length) {
    throw new DocOpError(
      "passage_not_found",
      `occurrence ${occurrence} is out of range (passage appears ${hits.length} time(s))`,
      { quote, occurrences: hits.length },
    );
  }
  return hits[index]!;
}

export interface ListedThread {
  id: string;
  status: "open" | "resolved";
  quote: string;
  anchored: boolean;
  /** The live text between the markers — what the reviewer is pointing at. */
  anchoredText: string | null;
  /** The anchored text changed after the thread's last comment (P1.3). */
  stale: boolean;
  comments: Array<{ id: string; author: string; ts: string; body: string }>;
}

export interface ListedSuggestion {
  anchorId: string;
  threadId?: string;
  author: string;
  anchored: boolean;
  original: string;
  proposed: string;
  note?: string;
}

export interface ListResult {
  threadCount: number;
  threads: ListedThread[];
  suggestionCount: number;
  suggestions: ListedSuggestion[];
}

/**
 * The document's review state. `actionable` narrows to threads that are open
 * and whose last word is not Claude's — the ones still owed a reply.
 */
export function opList(source: string, actionable = false): ListResult {
  const parsed = parse(source);
  const stale = new Set(staleThreadIds(parsed));
  const threads = parsed.threads
    .filter((t) => {
      if (!actionable) return true;
      if (t.status !== "open") return false;
      const last = lastLiveComment(t);
      return last !== undefined && last.author !== "claude";
    })
    .map((t) => {
      const a = parsed.anchors.get(t.id);
      return {
        id: t.id,
        status: t.status,
        quote: t.quote,
        anchored: a !== undefined,
        anchoredText: a ? source.slice(a.openEnd, a.closeStart) : null,
        // True when the passage moved after the last comment — read this one
        // first, the comment may be answering text that no longer exists.
        stale: stale.has(t.id),
        comments: t.comments
          .filter((c) => !c.deleted)
          .map((c) => ({ id: c.id, author: c.author, ts: c.ts, body: c.body })),
      };
    });
  const suggestions = parsed.suggestions.map((s) => {
    const a = parsed.anchors.get(s.anchorId);
    return {
      anchorId: s.anchorId,
      threadId: s.threadId,
      author: s.author,
      anchored: a !== undefined,
      original: s.original,
      proposed: s.proposed,
      note: s.note,
    };
  });
  return {
    threadCount: parsed.threads.length,
    threads,
    suggestionCount: parsed.suggestions.length,
    suggestions,
  };
}

export function opReply(
  source: string,
  threadId: string,
  body: string,
  now = () => new Date().toISOString(),
): OpOutcome<{ threadId: string; commentId: string }> {
  const thread = findThread(source, threadId);
  // Claude just read this passage to answer about it, so its reply is the new
  // baseline for "text changed since this comment" (P1.3).
  const replied = withRefreshedAnchorHash(
    parse(source),
    appendReply(thread, { author: "claude", body, ts: now() }),
  );
  const next = replaceThread(source, threadId, replied);
  assertNoNewIssues(source, next);
  const updated = findThread(next, threadId);
  return {
    next,
    result: { threadId, commentId: updated.comments[updated.comments.length - 1]!.id },
  };
}

/**
 * Replace the text between a thread's markers.
 *
 * This is the operation the skill's marker-surgery instructions were for, and
 * the one most likely to drop a marker by hand: the markers sit flush against
 * the text, so a bare-text edit either fails to match or eats one. Here the
 * markers are never part of the edit — we splice between them and update the
 * thread's `quote`, which is the fallback locator.
 */
export function opRewrite(
  source: string,
  threadId: string,
  replacement: string,
): OpOutcome<{ threadId: string; previous: string; replacement: string }> {
  const parsed = parse(source);
  const thread = findThread(source, threadId);
  const a = parsed.anchors.get(threadId);
  if (!a) {
    throw new DocOpError(
      "unanchored",
      `thread ${threadId} has no anchor markers in the prose; rewrite needs an anchored span`,
      { threadId },
    );
  }
  const previous = source.slice(a.openEnd, a.closeStart);
  const spliced = source.slice(0, a.openEnd) + replacement + source.slice(a.closeStart);
  // The rewriter wrote this text, so it is not "changed since the last
  // comment" — it IS what the next reader will see.
  const next = replaceThread(spliced, threadId, {
    ...thread,
    quote: replacement,
    anchorHash: hashAnchorText(replacement),
  });
  assertNoNewIssues(source, next);
  return { next, result: { threadId, previous, replacement } };
}

export function opOpen(
  source: string,
  quote: string,
  body: string,
  occurrence = 0,
  now = () => new Date().toISOString(),
): OpOutcome<{ threadId: string; quote: string }> {
  const at = locatePassage(source, quote, occurrence);
  let result;
  try {
    result = addThread(source, at, at + quote.length, { author: "claude", body, ts: now() });
  } catch (e) {
    // addThread refuses frontmatter, the threads region, and code.
    throw new DocOpError("not_anchorable", (e as Error).message, { quote });
  }
  assertNoNewIssues(source, result.source);
  return { next: result.source, result: { threadId: result.thread.id, quote } };
}

/**
 * Open a thread on an exact source range, for a caller that already knows
 * where the passage is (10x-plan-3 P0.2 — a selection in the text editor).
 *
 * Distinct from `opOpen`, which finds the passage by its text: Claude describes
 * a quote and must be refused when it is ambiguous, whereas a human has pointed
 * at one specific range and "that quote appears three times" would be a
 * nonsense answer to a selection. Same integrity gate, same refusals from
 * `addThread` (frontmatter, the threads region, code spans).
 */
export function opOpenAt(
  source: string,
  start: number,
  end: number,
  body: string,
  author: string,
  now = () => new Date().toISOString(),
): OpOutcome<{ threadId: string; quote: string }> {
  if (end <= start) {
    throw new DocOpError("empty_selection", "select some text to comment on", { start, end });
  }
  if (start < 0 || end > source.length) {
    throw new DocOpError("out_of_range", "the selection is outside the document", { start, end });
  }
  let result;
  try {
    result = addThread(source, start, end, { author, body, ts: now() });
  } catch (e) {
    throw new DocOpError("not_anchorable", (e as Error).message, { start, end });
  }
  assertNoNewIssues(source, result.source);
  return { next: result.source, result: { threadId: result.thread.id, quote: result.thread.quote } };
}

export function opResolve(
  source: string,
  threadId: string,
  now = () => new Date().toISOString(),
): OpOutcome<{ threadId: string }> {
  const thread = findThread(source, threadId);
  const next = replaceThread(source, threadId, {
    ...thread,
    status: "resolved",
    resolvedBy: "claude",
    resolvedTs: now(),
  });
  assertNoNewIssues(source, next);
  return { next, result: { threadId } };
}

/**
 * Remove every resolved thread from the document, markers and all.
 *
 * Resolved threads are the sediment of a long review: settled, unread, and in
 * the way of the ones that still need an answer. Deleting them one at a time
 * through the two-click confirm is the tedium this replaces.
 *
 * Deliberately all-or-nothing about *what* it removes: only threads whose
 * status is `resolved`. An open thread is never touched, and neither is a
 * pending suggestion — a suggestion nobody has accepted or rejected is
 * unfinished business, not sediment, even when the thread beside it is closed.
 *
 * Returns the ids it removed so a caller can say how many, and refuses with
 * `nothing_to_do` when there are none — a command that silently does nothing
 * is indistinguishable from one that is broken.
 */
export function opPurgeResolved(source: string): OpOutcome<{ removed: string[] }> {
  const parsed = parse(source);
  const resolved = parsed.threads.filter((t) => t.status === "resolved");
  if (resolved.length === 0) {
    throw new DocOpError("nothing_to_do", "this file has no resolved comments");
  }
  let next = source;
  for (const t of resolved) {
    // `replaceThread(…, null)` drops the record and strips its markers. One at
    // a time rather than a bulk rewrite so each removal goes through the same
    // path a single delete does.
    next = replaceThread(next, t.id, null);
  }
  assertNoNewIssues(source, next);
  return { next, result: { removed: resolved.map((t) => t.id) } };
}

/**
 * Propose an edit: wrap the passage's original text and record the proposal.
 * The file still renders as the original — the human accepts or rejects.
 */
export function opSuggest(
  source: string,
  quote: string,
  proposed: string,
  opts: { note?: string; occurrence?: number; threadId?: string } = {},
  now = () => new Date().toISOString(),
): OpOutcome<{ anchorId: string; original: string; proposed: string }> {
  const at = locatePassage(source, quote, opts.occurrence ?? 0);
  let result;
  try {
    result = addSuggestion(source, at, at + quote.length, {
      author: "claude",
      proposed,
      note: opts.note,
      threadId: opts.threadId,
      ts: now(),
    });
  } catch (e) {
    throw new DocOpError("not_anchorable", (e as Error).message, { quote });
  }
  assertNoNewIssues(source, result.source);
  return {
    next: result.source,
    result: {
      anchorId: result.suggestion.anchorId,
      original: result.suggestion.original,
      proposed,
    },
  };
}

export function opAccept(
  source: string,
  anchorId: string,
): OpOutcome<{ anchorId: string; applied: string }> {
  const parsed = parse(source);
  const suggestion = parsed.suggestions.find((s) => s.anchorId === anchorId);
  if (!suggestion) {
    throw new DocOpError("suggestion_not_found", `no suggestion with anchor id ${anchorId} in this file`, {
      anchorId,
    });
  }
  if (!parsed.anchors.has(anchorId)) {
    throw new DocOpError(
      "unanchored",
      `suggestion ${anchorId} lost its anchor markers; cannot place the change`,
      { anchorId },
    );
  }
  const next = acceptSuggestion(source, anchorId);
  assertNoNewIssues(source, next);
  return { next, result: { anchorId, applied: suggestion.proposed } };
}

export function opReject(source: string, anchorId: string): OpOutcome<{ anchorId: string }> {
  const parsed = parse(source);
  if (!parsed.suggestions.some((s) => s.anchorId === anchorId)) {
    throw new DocOpError("suggestion_not_found", `no suggestion with anchor id ${anchorId} in this file`, {
      anchorId,
    });
  }
  const next = rejectSuggestion(source, anchorId);
  assertNoNewIssues(source, next);
  return { next, result: { anchorId } };
}

export interface CheckResult {
  ok: boolean;
  counts: ReturnType<typeof checkIntegrity>["counts"];
  issues: Array<{
    kind: string;
    severity: string;
    threadId?: string;
    repairable: boolean;
    message: string;
  }>;
}

/** Integrity report. Never repairs — that stays a CLI/command affordance. */
export function opCheck(source: string): CheckResult {
  const report = checkIntegrity(source);
  return {
    ok: report.ok,
    counts: report.counts,
    issues: report.issues.map((i) => ({
      kind: i.kind,
      severity: i.severity,
      threadId: i.threadId,
      repairable: i.repairable,
      message: i.message,
    })),
  };
}

/**
 * Record "this document was reviewed in this state" (10x-plan-2 P1.1).
 *
 * Called by `mc_check`, which the skill runs at the end of every file — the one
 * moment we actually know a pass finished. The record is what makes the *next*
 * pass incremental, so writing it anywhere earlier would claim a review that
 * hadn't happened yet.
 *
 * Refuses on a broken document: checkpointing damage would tell the next pass
 * that the damage was reviewed and approved.
 */
export function opCheckpoint(
  source: string,
  now: () => string = () => new Date().toISOString(),
  gitRef?: string,
): OpOutcome<{ checkpoint: ReviewCheckpoint }> {
  const report = checkIntegrity(source);
  if (!report.ok) {
    throw new DocOpError("integrity", "refusing to checkpoint a document with integrity problems", {
      issues: report.issues,
    });
  }
  const checkpoint = checkpointFor(source, now, gitRef);
  const next = withThreads(source, parse(source).threads, undefined, checkpoint);
  assertNoNewIssues(source, next);
  return { next, result: { checkpoint } };
}
