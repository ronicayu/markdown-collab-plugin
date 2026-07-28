// "Claude is working…" — which threads are awaiting a reply (10x-plan P1.2).
//
// Sending comments to Claude is the one moment in the workflow with no
// feedback: you click, the payload goes out, and nothing changes until the
// file is rewritten underneath you. The extension already knows more than it
// shows — it dispatched a payload for specific threads and hasn't seen a reply
// land in the threads block yet — so this turns that knowledge into a per-card
// indicator.
//
// Resolution is comment-shaped, not time-shaped: a thread stops waiting when a
// comment authored by Claude appears on it that wasn't there at dispatch. A
// timeout only exists because a dispatch can go unanswered forever (the user
// closes Claude, the terminal paste never runs) and a permanent "working…" is
// a lie, not because elapsed time means anything.
//
// Pure and vscode-free: the tracker takes an injected clock and scheduler so
// the expiry path is testable without waiting ten minutes.

/** How long a thread may wait before we stop claiming Claude is working on it. */
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

export interface PendingThread {
  threadId: string;
  /** Live (non-deleted) comment count at dispatch. */
  commentCount: number;
  /** Epoch ms when the payload was dispatched. */
  since: number;
}

/** The shape this module needs from a parsed thread. */
export interface PendingInputThread {
  id: string;
  status: "open" | "resolved";
  comments: Array<{ author: string; deleted?: boolean }>;
}

function liveComments(t: PendingInputThread): Array<{ author: string; deleted?: boolean }> {
  return t.comments.filter((c) => !c.deleted);
}

/** Snapshot the threads a dispatch covers, so their replies can be detected. */
export function snapshotPending(
  threads: PendingInputThread[],
  threadIds: string[],
  now: number,
): PendingThread[] {
  const wanted = new Set(threadIds);
  return threads
    .filter((t) => wanted.has(t.id))
    .map((t) => ({ threadId: t.id, commentCount: liveComments(t).length, since: now }));
}

/**
 * Has this thread been answered since its snapshot?
 *
 * Answered means: a new comment arrived AND the last one is Claude's. Counting
 * alone would clear the indicator when the *human* adds a note while waiting;
 * checking only the author would clear it on a thread Claude had already
 * replied to before the dispatch.
 */
export function isAnswered(snapshot: PendingThread, thread: PendingInputThread | undefined): boolean {
  if (!thread) return true; // deleted while waiting — nothing left to wait for
  if (thread.status === "resolved") return true;
  const live = liveComments(thread);
  if (live.length <= snapshot.commentCount) return false;
  return live[live.length - 1]!.author === "claude";
}

/**
 * The snapshots still waiting: not yet answered, not yet timed out. Threads
 * that have been answered or that have aged out drop off the list.
 */
export function stillPending(
  snapshots: PendingThread[],
  threads: PendingInputThread[],
  now: number,
  timeoutMs: number = PENDING_TIMEOUT_MS,
): PendingThread[] {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return snapshots.filter(
    (s) => now - s.since < timeoutMs && !isAnswered(s, byId.get(s.threadId)),
  );
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
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    /**
     * Called whenever a document's pending set changes — a dispatch marking
     * threads, or a timeout expiring them. Views re-render off this; the
     * expiry case has no file write to hang off, and the mark case must show
     * the indicator immediately rather than on the next unrelated change.
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

  /** Record that a payload covering `threadIds` just went out for `docKey`. */
  public mark(docKey: string, threads: PendingInputThread[], threadIds: string[]): void {
    if (threadIds.length === 0) return;
    const fresh = snapshotPending(threads, threadIds, this.now());
    if (fresh.length === 0) return;
    // Re-sending a thread restarts its wait rather than stacking a second one.
    const others = (this.byDoc.get(docKey) ?? []).filter(
      (s) => !fresh.some((f) => f.threadId === s.threadId),
    );
    this.byDoc.set(docKey, [...others, ...fresh]);
    this.armTimer(docKey);
    this.onChange(docKey);
  }

  /**
   * Thread ids still waiting, pruning anything answered or expired. Call this
   * on every state push — the document changing is what tells us Claude
   * replied.
   */
  public pending(docKey: string, threads: PendingInputThread[]): string[] {
    const snapshots = this.byDoc.get(docKey);
    if (!snapshots || snapshots.length === 0) return [];
    const remaining = stillPending(snapshots, threads, this.now(), this.timeoutMs);
    if (remaining.length === 0) {
      this.byDoc.delete(docKey);
      this.clearTimer(docKey);
    } else if (remaining.length !== snapshots.length) {
      this.byDoc.set(docKey, remaining);
    }
    return remaining.map((s) => s.threadId);
  }

  public clear(docKey: string): void {
    this.byDoc.delete(docKey);
    this.clearTimer(docKey);
  }

  public dispose(): void {
    for (const key of [...this.timers.keys()]) this.clearTimer(key);
    this.byDoc.clear();
  }

  /**
   * Wake up when the oldest entry for this doc expires, so a dispatch nobody
   * ever answers stops claiming to be in flight without needing a file change
   * to notice.
   */
  private armTimer(docKey: string): void {
    this.clearTimer(docKey);
    const snapshots = this.byDoc.get(docKey);
    if (!snapshots || snapshots.length === 0) return;
    const oldest = Math.min(...snapshots.map((s) => s.since));
    const delay = Math.max(0, oldest + this.timeoutMs - this.now());
    const timer = this.schedule(() => {
      this.timers.delete(docKey);
      const left = this.byDoc.get(docKey);
      if (!left) return;
      const survivors = left.filter((s) => this.now() - s.since < this.timeoutMs);
      if (survivors.length === 0) this.byDoc.delete(docKey);
      else this.byDoc.set(docKey, survivors);
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
