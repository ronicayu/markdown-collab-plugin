import { describe, expect, it, vi } from "vitest";
import {
  ClaudePendingTracker,
  PENDING_TIMEOUT_MS,
  isAnswered,
  snapshotPending,
  stillPending,
  type PendingInputThread,
} from "../inlineComments/claudePending";

const T0 = 1_000_000;

function thread(
  id: string,
  authors: string[],
  opts: { status?: "open" | "resolved"; deleted?: number[] } = {},
): PendingInputThread {
  return {
    id,
    status: opts.status ?? "open",
    comments: authors.map((author, i) => ({
      author,
      deleted: opts.deleted?.includes(i) || undefined,
    })),
  };
}

describe("snapshotPending", () => {
  it("records the live comment count at dispatch", () => {
    const threads = [thread("a1", ["ronica", "claude"]), thread("b2", ["ronica"])];
    expect(snapshotPending(threads, ["a1", "b2"], T0)).toEqual([
      { threadId: "a1", commentCount: 2, since: T0 },
      { threadId: "b2", commentCount: 1, since: T0 },
    ]);
  });

  it("ignores tombstoned comments in the count", () => {
    const threads = [thread("a1", ["ronica", "ronica"], { deleted: [1] })];
    expect(snapshotPending(threads, ["a1"], T0)[0]!.commentCount).toBe(1);
  });

  it("skips ids that aren't in the document", () => {
    expect(snapshotPending([thread("a1", ["r"])], ["a1", "gone"], T0)).toHaveLength(1);
  });
});

describe("isAnswered", () => {
  const snap = { threadId: "a1", commentCount: 1, since: T0 };

  it("is false while nothing new has arrived", () => {
    expect(isAnswered(snap, thread("a1", ["ronica"]))).toBe(false);
  });

  it("is true once Claude adds a comment", () => {
    expect(isAnswered(snap, thread("a1", ["ronica", "claude"]))).toBe(true);
  });

  it("stays false when the HUMAN adds a comment while waiting", () => {
    // Counting alone would clear the indicator here, which is wrong: Claude
    // still owes a reply.
    expect(isAnswered(snap, thread("a1", ["ronica", "ronica"]))).toBe(false);
  });

  it("stays false for a thread Claude had already answered before dispatch", () => {
    // Snapshot taken when the thread already ended with a claude comment;
    // checking only the author would clear it immediately.
    const prior = { threadId: "a1", commentCount: 2, since: T0 };
    expect(isAnswered(prior, thread("a1", ["ronica", "claude"]))).toBe(false);
    expect(isAnswered(prior, thread("a1", ["ronica", "claude", "claude"]))).toBe(true);
  });

  it("is true when the thread was resolved while waiting", () => {
    expect(isAnswered(snap, thread("a1", ["ronica"], { status: "resolved" }))).toBe(true);
  });

  it("is true when the thread was deleted while waiting", () => {
    expect(isAnswered(snap, undefined)).toBe(true);
  });
});

describe("stillPending", () => {
  const snaps = [
    { threadId: "a1", commentCount: 1, since: T0 },
    { threadId: "b2", commentCount: 1, since: T0 },
  ];

  it("keeps threads with no reply yet", () => {
    const threads = [thread("a1", ["ronica"]), thread("b2", ["ronica"])];
    expect(stillPending(snaps, threads, T0 + 1000).map((s) => s.threadId)).toEqual(["a1", "b2"]);
  });

  it("drops a thread once Claude answers it", () => {
    const threads = [thread("a1", ["ronica", "claude"]), thread("b2", ["ronica"])];
    expect(stillPending(snaps, threads, T0 + 1000).map((s) => s.threadId)).toEqual(["b2"]);
  });

  it("drops everything once the timeout passes", () => {
    const threads = [thread("a1", ["ronica"]), thread("b2", ["ronica"])];
    expect(stillPending(snaps, threads, T0 + PENDING_TIMEOUT_MS)).toEqual([]);
  });

  it("keeps a thread right up to the timeout boundary", () => {
    const threads = [thread("a1", ["ronica"])];
    expect(stillPending([snaps[0]!], threads, T0 + PENDING_TIMEOUT_MS - 1)).toHaveLength(1);
  });
});

describe("ClaudePendingTracker", () => {
  /** Tracker with a controllable clock and no real timers. */
  function makeTracker(timeoutMs = 1000) {
    let now = T0;
    const fired: Array<{ fn: () => void; ms: number }> = [];
    const changes: string[] = [];
    const tracker = new ClaudePendingTracker(
      (docKey) => changes.push(docKey),
      () => now,
      timeoutMs,
      (fn, ms) => {
        fired.push({ fn, ms });
        return fired.length as unknown as ReturnType<typeof setTimeout>;
      },
      () => undefined,
    );
    return {
      tracker,
      changes,
      advance: (ms: number) => {
        now += ms;
      },
      runTimers: () => {
        const pending = fired.splice(0, fired.length);
        for (const t of pending) t.fn();
      },
      timers: fired,
    };
  }

  const DOC = "/ws/docs/guide.md";

  it("reports nothing before anything is sent", () => {
    const { tracker } = makeTracker();
    expect(tracker.pending(DOC, [thread("a1", ["ronica"])])).toEqual([]);
  });

  it("reports a thread as pending after a dispatch", () => {
    const { tracker } = makeTracker();
    const threads = [thread("a1", ["ronica"]), thread("b2", ["ronica"])];
    tracker.mark(DOC, threads, ["a1"]);
    expect(tracker.pending(DOC, threads)).toEqual(["a1"]);
  });

  it("clears the thread when Claude's reply lands", () => {
    const { tracker } = makeTracker();
    const before = [thread("a1", ["ronica"])];
    tracker.mark(DOC, before, ["a1"]);
    const after = [thread("a1", ["ronica", "claude"])];
    expect(tracker.pending(DOC, after)).toEqual([]);
    // And stays cleared on subsequent pushes.
    expect(tracker.pending(DOC, after)).toEqual([]);
  });

  it("keeps waiting when the human replies to their own thread", () => {
    const { tracker } = makeTracker();
    tracker.mark(DOC, [thread("a1", ["ronica"])], ["a1"]);
    expect(tracker.pending(DOC, [thread("a1", ["ronica", "ronica"])])).toEqual(["a1"]);
  });

  it("tracks documents independently", () => {
    const { tracker } = makeTracker();
    const threads = [thread("a1", ["ronica"])];
    tracker.mark(DOC, threads, ["a1"]);
    expect(tracker.pending("/ws/other.md", threads)).toEqual([]);
    expect(tracker.pending(DOC, threads)).toEqual(["a1"]);
  });

  it("restarts the wait when the same thread is re-sent", () => {
    const { tracker, advance } = makeTracker(1000);
    const threads = [thread("a1", ["ronica"])];
    tracker.mark(DOC, threads, ["a1"]);
    advance(900);
    tracker.mark(DOC, threads, ["a1"]);
    advance(200); // 1100ms since the first send, 200ms since the second
    expect(tracker.pending(DOC, threads)).toEqual(["a1"]);
  });

  it("gives up after the timeout instead of claiming Claude is still working", () => {
    const { tracker, advance } = makeTracker(1000);
    const threads = [thread("a1", ["ronica"])];
    tracker.mark(DOC, threads, ["a1"]);
    advance(1001);
    expect(tracker.pending(DOC, threads)).toEqual([]);
  });

  it("notifies on mark so the indicator appears before any file change", () => {
    // Nothing writes to the file when a payload goes out, so a view that only
    // re-renders on document change would show the indicator late — or never,
    // if Claude answers in one write.
    const { tracker, changes } = makeTracker();
    tracker.mark(DOC, [thread("a1", ["ronica"])], ["a1"]);
    expect(changes).toEqual([DOC]);
  });

  it("notifies on expiry so the views re-render without a file change", () => {
    const { tracker, advance, runTimers, changes } = makeTracker(1000);
    const threads = [thread("a1", ["ronica"])];
    tracker.mark(DOC, threads, ["a1"]);
    changes.length = 0; // ignore the mark notification
    advance(1001);
    runTimers();
    expect(changes).toEqual([DOC]);
    expect(tracker.pending(DOC, threads)).toEqual([]);
  });

  it("schedules the wake-up for when the oldest entry expires", () => {
    const { tracker, timers } = makeTracker(1000);
    tracker.mark(DOC, [thread("a1", ["ronica"])], ["a1"]);
    expect(timers.at(-1)!.ms).toBe(1000);
  });

  it("marking nothing is a no-op", () => {
    const { tracker, timers, changes } = makeTracker();
    tracker.mark(DOC, [thread("a1", ["ronica"])], []);
    expect(tracker.pending(DOC, [thread("a1", ["ronica"])])).toEqual([]);
    expect(timers).toHaveLength(0);
    expect(changes).toEqual([]);
  });

  it("clear() forgets a document", () => {
    const { tracker } = makeTracker();
    const threads = [thread("a1", ["ronica"])];
    tracker.mark(DOC, threads, ["a1"]);
    tracker.clear(DOC);
    expect(tracker.pending(DOC, threads)).toEqual([]);
  });

  it("dispose() cancels outstanding timers", () => {
    const cancel = vi.fn();
    const tracker = new ClaudePendingTracker(
      () => undefined,
      () => T0,
      1000,
      () => 1 as unknown as ReturnType<typeof setTimeout>,
      cancel,
    );
    tracker.mark(DOC, [thread("a1", ["ronica"])], ["a1"]);
    tracker.dispose();
    expect(cancel).toHaveBeenCalled();
  });
});
