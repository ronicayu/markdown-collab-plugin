// "Claude is working…" — which threads are awaiting a reply, and how sure we are.
//
// The extension dispatched a payload for specific threads and hasn't seen a
// reply land in the threads block yet; this turns that knowledge into a
// per-card indicator.
//
// There are two grades of knowledge here, and the difference matters:
//
//   "inferred"  — every dispatch starts here. Resolution is
//                 comment-shaped: a thread stops waiting when a comment
//                 authored by Claude appears that wasn't there at dispatch. A
//                 timeout exists only because a dispatch can go unanswered
//                 forever (the user closed Claude, the paste never ran) and a
//                 permanent "working…" is a lie — not because elapsed time
//                 means anything.
//
//   "protocol"  — Claude actually called one of the extension's MCP tools, so
//                 the tool calls themselves are evidence — a call upgrades any
//                 "inferred" wait on that document (`noteActivity`), says
//                 "active", `mc_status` says what phase, and the pass's final
//                 `mc_check` (`noteComplete`) says finished. The timeout stops
//                 being a guess about Claude's lifetime and becomes a silence
//                 detector: it runs from the last signal, not from dispatch, so
//                 a long pass that keeps reporting never expires mid-work.
//
// Pure and vscode-free: the tracker takes an injected clock and scheduler so
// the expiry path is testable without waiting ten minutes.
//
// Naming the agent (the wording rule: name the agent when the code knows it,
// say "the agent" when it doesn't): an "inferred" wait names no one — the
// extension only knows it sent something, not who read it. A "protocol" wait's
// evidence IS a tool call, and a tool call carries the calling agent's slug,
// so `noteActivity`/`noteComplete` learn it there and `pendingLabel` names
// whichever agent is actually doing the work.

import { agentDisplayName, isAgentComment, sentenceLead, WAITING_FOR_AGENT } from "../agentIdentity";

/** How long a thread may wait, with no signal at all, before we stop claiming Claude is working on it. */
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

/** How the tracker knows about this wait. See the module comment. */
export type PendingEvidence = "inferred" | "protocol";

export interface PendingThread {
  threadId: string;
  /** Live (non-deleted) comment count at dispatch. */
  commentCount: number;
  /** Epoch ms when the payload was dispatched. */
  since: number;
  evidence: PendingEvidence;
  /**
   * Epoch ms of the most recent evidence this wait is still alive — dispatch
   * time until a tool call moves it. The timeout measures from here, so an
   * hour-long review pass that keeps calling tools is never declared dead.
   */
  lastSignal: number;
}

export interface PendingInputThread {
  id: string;
  status: "open" | "resolved";
  comments: Array<{ author: string; deleted?: boolean; agent?: boolean }>;
}

export interface PendingStatus {
  threadIds: string[];
  /** The strongest evidence among the waiting threads. */
  evidence: PendingEvidence;
  /** Latest phase Claude reported via `mc_status`, if any. */
  phase?: string;
  /** True once Claude has actually called a tool for this document. */
  active: boolean;
  /**
   * The agent slug protocol evidence was last recorded under, when there is
   * any (`noteActivity`/`noteComplete` learn it from the tool call). Absent
   * for a purely "inferred" wait — that path never learns who picked up the
   * terminal send, and it is always Claude anyway.
   */
  agent?: string;
}

function liveComments(t: PendingInputThread): Array<{ author: string; deleted?: boolean; agent?: boolean }> {
  return t.comments.filter((c) => !c.deleted);
}

export function snapshotPending(
  threads: PendingInputThread[],
  threadIds: string[],
  now: number,
  evidence: PendingEvidence = "inferred",
): PendingThread[] {
  const wanted = new Set(threadIds);
  return threads
    .filter((t) => wanted.has(t.id))
    .map((t) => ({
      threadId: t.id,
      commentCount: liveComments(t).length,
      since: now,
      evidence,
      lastSignal: now,
    }));
}

/**
 * Has this thread been answered since its snapshot?
 *
 * Answered means: a new comment arrived AND the last one is an agent's (any
 * agent — whichever one picked up the reply, the human isn't the one still owed
 * an answer). Counting alone would clear the indicator when the *human* adds a
 * note while waiting; checking only the author would clear it on a thread an
 * agent had already replied to before the dispatch.
 */
export function isAnswered(snapshot: PendingThread, thread: PendingInputThread | undefined): boolean {
  if (!thread) return true; // deleted while waiting — nothing left to wait for
  if (thread.status === "resolved") return true;
  const live = liveComments(thread);
  if (live.length <= snapshot.commentCount) return false;
  return isAgentComment(live[live.length - 1]!);
}

/** The snapshots still waiting: not yet answered, not yet silent for too long. */
export function stillPending(
  snapshots: PendingThread[],
  threads: PendingInputThread[],
  now: number,
  timeoutMs: number = PENDING_TIMEOUT_MS,
): PendingThread[] {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return snapshots.filter(
    (s) => now - (s.lastSignal ?? s.since) < timeoutMs && !isAnswered(s, byId.get(s.threadId)),
  );
}

interface DocSignals {
  /** Claude has called at least one tool since the dispatch. */
  active: boolean;
  /** Latest `mc_status` note. */
  phase?: string;
  /** Slug of the agent the last tool call for this document came from. */
  agent?: string;
}

/**
 * Per-document record of what Claude owes us a reply on.
 *
 * Lives in the extension host rather than a webview so the indicator survives
 * a panel reload, and so the inline view and the live editor agree about the
 * same document.
 */
export class ClaudePendingTracker {
  private readonly byDoc = new Map<string, PendingThread[]>();
  private readonly signals = new Map<string, DocSignals>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    /**
     * Called whenever a document's pending set changes — a dispatch marking
     * threads, a tool call reporting progress, or a timeout expiring them.
     * Views re-render off this; the expiry and progress cases have no file
     * write to hang off, and the mark case must show the indicator immediately
     * rather than on the next unrelated change.
     */
    private readonly onChange: (docKey: string) => void = () => {},
    private readonly now: () => number = () => Date.now(),
    private readonly timeoutMs: number = PENDING_TIMEOUT_MS,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
    private readonly cancel: (t: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t),
  ) {}

  public mark(
    docKey: string,
    threads: PendingInputThread[],
    threadIds: string[],
    evidence: PendingEvidence = "inferred",
  ): void {
    if (threadIds.length === 0) return;
    const fresh = snapshotPending(threads, threadIds, this.now(), evidence);
    if (fresh.length === 0) return;
    // Re-sending a thread restarts its wait rather than stacking a second one.
    const others = (this.byDoc.get(docKey) ?? []).filter(
      (s) => !fresh.some((f) => f.threadId === s.threadId),
    );
    this.byDoc.set(docKey, [...others, ...fresh]);
    // A new dispatch starts a new pass: whatever Claude was doing before this
    // is not evidence about this one.
    this.signals.set(docKey, { active: false });
    this.armTimer(docKey);
    this.onChange(docKey);
  }

  /**
   * Claude called a tool against this document. Upgrades the wait from "sent"
   * to "active", records the phase when one came with it, and pushes the
   * silence deadline out.
   *
   * A tool call is itself protocol evidence, whatever the wait started as: every
   * dispatch is marked "inferred" up front, so this is the only place a wait
   * ever becomes "protocol" — and it upgrades every snapshot for the document,
   * not just ones that already had it.
   */
  public noteActivity(docKey: string, opts: { phase?: string; agent?: string } = {}): void {
    const snapshots = this.byDoc.get(docKey);
    const previous = this.signals.get(docKey);
    const next: DocSignals = {
      active: true,
      phase: opts.phase ?? previous?.phase,
      agent: opts.agent ?? previous?.agent,
    };
    this.signals.set(docKey, next);
    if (!snapshots || snapshots.length === 0) {
      // Claude is working on a document nobody is waiting on (an unprompted
      // pass, or one whose threads were already answered). Nothing to re-render.
      return;
    }
    const now = this.now();
    this.byDoc.set(
      docKey,
      snapshots.map((s) => ({ ...s, evidence: "protocol", lastSignal: now })),
    );
    this.armTimer(docKey);
    this.onChange(docKey);
  }

  /**
   * A phase report that named no file. Applies to every document currently
   * waiting: a multi-file pass reports "reading 2 of 3", which is true of all
   * of them, and dropping it would leave the row silent for exactly the long
   * passes the beacon exists for.
   */
  public noteActivityEverywhere(opts: { phase?: string; agent?: string } = {}): void {
    for (const docKey of [...this.byDoc.keys()]) this.noteActivity(docKey, opts);
  }

  /**
   * Claude finished its pass on this document — the skill's closing `mc_check`.
   * Clears the wait outright, regardless of whether it was still "inferred" or
   * had already been upgraded to "protocol": `mc_check` is itself a tool call,
   * so it can be the very first signal a file gets. Waiting for a reply-shaped
   * file change instead would keep the indicator up after a pass that
   * (legitimately) left no reply.
   */
  public noteComplete(docKey: string): void {
    const had = (this.byDoc.get(docKey)?.length ?? 0) > 0;
    this.byDoc.delete(docKey);
    this.signals.delete(docKey);
    this.clearTimer(docKey);
    if (had) this.onChange(docKey);
  }

  /**
   * Thread ids still waiting, pruning anything answered or expired. Call this
   * on every state push — the document changing is what tells us Claude
   * replied.
   */
  public pending(docKey: string, threads: PendingInputThread[]): string[] {
    return this.status(docKey, threads).threadIds;
  }

  public status(docKey: string, threads: PendingInputThread[]): PendingStatus {
    const snapshots = this.byDoc.get(docKey);
    if (!snapshots || snapshots.length === 0) {
      return { threadIds: [], evidence: "inferred", active: false };
    }
    const remaining = stillPending(snapshots, threads, this.now(), this.timeoutMs);
    if (remaining.length === 0) {
      this.byDoc.delete(docKey);
      this.signals.delete(docKey);
      this.clearTimer(docKey);
      return { threadIds: [], evidence: "inferred", active: false };
    }
    if (remaining.length !== snapshots.length) this.byDoc.set(docKey, remaining);
    const signals = this.signals.get(docKey);
    return {
      threadIds: remaining.map((s) => s.threadId),
      evidence: remaining.some((s) => s.evidence === "protocol") ? "protocol" : "inferred",
      phase: signals?.phase,
      active: signals?.active ?? false,
      agent: signals?.agent,
    };
  }

  /**
   * The wait state without pruning it.
   *
   * `status()` needs the document's threads to decide what has been answered,
   * and prunes as a side effect — so a caller that doesn't have the parsed
   * threads (a status bar, a log line) must not call it: passing an empty list
   * reads as "every thread was deleted" and clears real state. This is the
   * read-only view for those callers.
   */
  public peek(docKey: string): PendingStatus {
    const snapshots = this.byDoc.get(docKey) ?? [];
    const signals = this.signals.get(docKey);
    return {
      threadIds: snapshots.map((s) => s.threadId),
      evidence: snapshots.some((s) => s.evidence === "protocol") ? "protocol" : "inferred",
      phase: signals?.phase,
      active: signals?.active ?? false,
      agent: signals?.agent,
    };
  }

  public unmark(docKey: string, threadIds: string[]): void {
    const snapshots = this.byDoc.get(docKey);
    if (!snapshots) return;
    const left = snapshots.filter((s) => !threadIds.includes(s.threadId));
    if (left.length === snapshots.length) return;
    if (left.length === 0) {
      this.clear(docKey);
    } else {
      this.byDoc.set(docKey, left);
      this.armTimer(docKey);
    }
    this.onChange(docKey);
  }

  public clear(docKey: string): void {
    this.byDoc.delete(docKey);
    this.signals.delete(docKey);
    this.clearTimer(docKey);
  }

  public dispose(): void {
    for (const key of [...this.timers.keys()]) this.clearTimer(key);
    this.byDoc.clear();
    this.signals.clear();
  }

  /**
   * Wake up when the oldest entry for this doc falls silent, so a dispatch
   * nobody ever answers stops claiming to be in flight without needing a file
   * change to notice.
   */
  private armTimer(docKey: string): void {
    this.clearTimer(docKey);
    const snapshots = this.byDoc.get(docKey);
    if (!snapshots || snapshots.length === 0) return;
    const oldest = Math.min(...snapshots.map((s) => s.lastSignal ?? s.since));
    const delay = Math.max(0, oldest + this.timeoutMs - this.now());
    const timer = this.schedule(() => {
      this.timers.delete(docKey);
      const left = this.byDoc.get(docKey);
      if (!left) return;
      const survivors = left.filter((s) => this.now() - (s.lastSignal ?? s.since) < this.timeoutMs);
      if (survivors.length === 0) {
        this.byDoc.delete(docKey);
        this.signals.delete(docKey);
      } else {
        this.byDoc.set(docKey, survivors);
      }
      this.onChange(docKey);
      this.armTimer(docKey);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(docKey, timer);
  }

  private clearTimer(docKey: string): void {
    const timer = this.timers.get(docKey);
    if (timer !== undefined) {
      this.cancel(timer);
      this.timers.delete(docKey);
    }
  }
}

/**
 * The line the views show under a waiting thread. Protocol-grade evidence earns
 * a specific claim; inferred evidence keeps the vaguer one, because it is a
 * guess and should read like one.
 *
 * The wording rule: name the agent when the code knows which one, otherwise
 * say "the agent". An inferred wait is only a guess that something read the
 * prompt, and the extension doesn't know who — "Waiting for the agent…". A
 * protocol wait names whichever agent's tool call actually earned it, and reads
 * generic ("Agent: …", "The agent is working…") when a caller has evidence but
 * hasn't learned who from (`status`/`peek` built before any tool call carried
 * a slug).
 */
export function pendingLabel(status: Pick<PendingStatus, "evidence" | "phase" | "active" | "agent">): string {
  if (status.evidence !== "protocol") return WAITING_FOR_AGENT;
  const agent = agentDisplayName(status.agent ?? "agent");
  if (status.phase) return `${agent.noun}: ${status.phase}`;
  if (status.active) return `${sentenceLead(agent)} is working on this file…`;
  return `Sent to ${agent.sentence}…`;
}
