import { describe, expect, it } from "vitest";
import {
  REVIEW_PASS_QUIET_MS,
  REVIEW_PASS_TIMEOUT_MS,
  ReviewPassTracker,
  firstArrivedFile,
  reviewPassStatusText,
  snapshotReviewPass,
  totalNewThreads,
  type ReviewPassInputThread,
  type ReviewPassPayload,
  type ReviewPassRecord,
} from "../reviewPassPending";

const T0 = 1_000_000;
const FOLDER = "file:///ws/";
const FILE_A = "file:///ws/a.md";
const FILE_B = "file:///ws/b.md";

function payload(file = "a.md", files?: string[]): ReviewPassPayload {
  return { prompt: "review please", file, files, unresolvedCount: 0, comments: [] };
}

const INTENT = { kind: "review-request" as const, hasFocus: false };

/** Same one-shot thread shape `addThread`/agent tools write: a single agent-authored comment. */
function agentThread(id: string): ReviewPassInputThread {
  return { id, comments: [{ author: "claude", agent: true }] };
}

function humanThread(id: string): ReviewPassInputThread {
  return { id, comments: [{ author: "ronica" }] };
}

/** An ISO timestamp `ms` after T0 — for building `ReviewPassInputCheckpoint`s in tests. */
function isoAt(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

/** Tracker with a controllable clock and no real timers — same pattern as `claudePending.test.ts`. */
function makeTracker(timeoutMs = 1000, quietMs = 500) {
  let now = T0;
  const fired: Array<{ fn: () => void; ms: number }> = [];
  const changes: string[] = [];
  const tracker = new ReviewPassTracker(
    (folderKey) => changes.push(folderKey),
    () => now,
    timeoutMs,
    (fn, ms) => {
      fired.push({ fn, ms });
      return fired.length as unknown as ReturnType<typeof setTimeout>;
    },
    () => undefined,
    quietMs,
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

function dispatchSingle(tracker: ReviewPassTracker, opts: { evidence?: "inferred" | "protocol" } = {}) {
  return tracker.dispatch({
    folderKey: FOLDER,
    files: [FILE_A],
    knownThreadIds: new Map([[FILE_A, new Set<string>()]]),
    payload: payload(),
    intent: INTENT,
    evidence: opts.evidence,
  });
}

function dispatchMulti(tracker: ReviewPassTracker) {
  return tracker.dispatch({
    folderKey: FOLDER,
    files: [FILE_A, FILE_B],
    knownThreadIds: new Map([
      [FILE_A, new Set<string>()],
      [FILE_B, new Set<string>()],
    ]),
    payload: payload("2 files", ["a.md", "b.md"]),
    intent: INTENT,
  });
}

describe("ReviewPassTracker — dispatch", () => {
  it("starts a fresh pass as waiting, inferred, with every file outstanding", () => {
    const { tracker } = makeTracker();
    const record = dispatchSingle(tracker);
    expect(record.state).toBe("waiting");
    expect(record.evidence).toBe("inferred");
    expect(record.files).toEqual([FILE_A]);
    expect(record.outstanding).toEqual(new Set([FILE_A]));
    expect(tracker.get(FOLDER)).toBe(record);
  });

  it("notifies on dispatch", () => {
    const { tracker, changes } = makeTracker();
    dispatchSingle(tracker);
    expect(changes).toEqual([FOLDER]);
  });

  it("a new dispatch replaces the old record and forgets its progress", () => {
    const { tracker } = makeTracker();
    const first = dispatchSingle(tracker, { evidence: "protocol" });
    tracker.noteActivity(FILE_A, { phase: "reading", agent: "codex" });
    const second = dispatchSingle(tracker);
    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe("waiting");
    expect(second.evidence).toBe("inferred");
    expect(second.phase).toBeUndefined();
    expect(second.agent).toBeUndefined();
  });
});

describe("ReviewPassTracker — noteDocument: threads land one at a time", () => {
  it("a new agent-authored thread moves waiting → receiving, not straight to arrived", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    const record = tracker.get(FOLDER)!;
    // The file is still outstanding — nothing has said this pass is COMPLETE,
    // just that something landed. A single-file pass with the file still
    // outstanding must not read as "arrived: 1 new comment" while Claude is
    // still writing thread #2.
    expect(record.state).toBe("receiving");
    expect(totalNewThreads(record)).toBe(1);
  });

  it("does NOT move to receiving when the new thread is human-authored", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [humanThread("t1")]);
    expect(tracker.get(FOLDER)!.state).toBe("waiting");
  });

  it("ignores a thread that was already there at dispatch", () => {
    const { tracker } = makeTracker();
    const record = tracker.dispatch({
      folderKey: FOLDER,
      files: [FILE_A],
      knownThreadIds: new Map([[FILE_A, new Set(["t1"])]]),
      payload: payload(),
      intent: INTENT,
    });
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    expect(tracker.get(FOLDER)!.state).toBe("waiting");
    expect(record.id).toBe(tracker.get(FOLDER)!.id);
  });

  it("a single-file pass stays receiving as threads keep landing, one call at a time", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    expect(tracker.get(FOLDER)!.state).toBe("receiving");
    tracker.noteDocument(FILE_A, [agentThread("t1"), agentThread("t2")]);
    expect(tracker.get(FOLDER)!.state).toBe("receiving");
    expect(totalNewThreads(tracker.get(FOLDER)!)).toBe(2);
    tracker.noteDocument(FILE_A, [agentThread("t1"), agentThread("t2"), agentThread("t3")]);
    expect(tracker.get(FOLDER)!.state).toBe("receiving");
    expect(totalNewThreads(tracker.get(FOLDER)!)).toBe(3);
    // Only mc_check (or a checkpoint, or the quiet period) ends it.
    tracker.noteComplete(FILE_A);
    expect(tracker.get(FOLDER)!.state).toBe("arrived");
    expect(totalNewThreads(tracker.get(FOLDER)!)).toBe(3);
  });

  it("counts every new agent thread found in one call", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1"), agentThread("t2"), humanThread("t3")]);
    expect(totalNewThreads(tracker.get(FOLDER)!)).toBe(2);
    expect(tracker.get(FOLDER)!.state).toBe("receiving");
  });

  it("is a no-op for a document outside the pass", () => {
    const { tracker, changes } = makeTracker();
    dispatchSingle(tracker);
    changes.length = 0;
    tracker.noteDocument("file:///ws/unrelated.md", [agentThread("t1")]);
    expect(changes).toEqual([]);
  });

  it("does nothing once the pass has already resolved", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    tracker.noteComplete(FILE_A); // single file → arrived
    expect(tracker.get(FOLDER)!.state).toBe("arrived");
    // t2 is still new against the dispatch-time snapshot, so if the tracker
    // didn't guard on state it would count again — it must not.
    tracker.noteDocument(FILE_A, [agentThread("t1"), agentThread("t2")]);
    expect(totalNewThreads(tracker.get(FOLDER)!)).toBe(1);
  });
});

describe("ReviewPassTracker — noteDocument: checkpoint completion (the mdc CLI path)", () => {
  it("a checkpoint at or after dispatch completes the file, even with zero threads (mdc CLI, no mc_check call)", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [], { ts: isoAt(0) });
    const record = tracker.get(FOLDER)!;
    expect(record.state).toBe("arrived");
    expect(totalNewThreads(record)).toBe(0);
  });

  it("an OLD checkpoint (before dispatch) does not complete the file", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [], { ts: isoAt(-1000) });
    expect(tracker.get(FOLDER)!.state).toBe("waiting");
  });

  it("a thread landing AND a fresh checkpoint in the same call resolves directly", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")], { ts: isoAt(0) });
    const record = tracker.get(FOLDER)!;
    expect(record.state).toBe("arrived");
    expect(totalNewThreads(record)).toBe(1);
  });

  it("in a multi-file pass, a checkpoint completes only ITS file", () => {
    const { tracker } = makeTracker();
    dispatchMulti(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")], { ts: isoAt(0) });
    const record = tracker.get(FOLDER)!;
    expect(record.state).toBe("receiving"); // B is still outstanding
    expect(record.outstanding).toEqual(new Set([FILE_B]));
    tracker.noteDocument(FILE_B, [], { ts: isoAt(0) });
    expect(tracker.get(FOLDER)!.state).toBe("arrived");
  });
});

describe("ReviewPassTracker — noteActivity", () => {
  it("upgrades an inferred pass to protocol and records phase/agent", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteActivity(FILE_A, { phase: "reading 1 of 2", agent: "codex" });
    const record = tracker.get(FOLDER)!;
    expect(record.evidence).toBe("protocol");
    expect(record.phase).toBe("reading 1 of 2");
    expect(record.agent).toBe("codex");
    expect(record.state).toBe("waiting");
  });

  it("keeps the last-known phase when a later call carries none", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteActivity(FILE_A, { phase: "step 1" });
    tracker.noteActivity(FILE_A, {});
    expect(tracker.get(FOLDER)!.phase).toBe("step 1");
  });

  it("still applies while a pass is receiving, not just waiting", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]); // → receiving
    tracker.noteActivity(FILE_A, { phase: "opening more threads" });
    expect(tracker.get(FOLDER)!).toMatchObject({ state: "receiving", phase: "opening more threads" });
  });

  it("a phase with no file reaches every live pass, and only live ones", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    const other = tracker.dispatch({
      folderKey: "file:///ws2/",
      files: ["file:///ws2/c.md"],
      knownThreadIds: new Map([["file:///ws2/c.md", new Set<string>()]]),
      payload: payload("c.md"),
      intent: INTENT,
    });
    tracker.noteComplete("file:///ws2/c.md"); // resolves `other` to arrived
    tracker.noteActivityEverywhere({ phase: "reading 2 of 3" });
    expect(tracker.get(FOLDER)!.phase).toBe("reading 2 of 3");
    expect(tracker.get(other.folderKey)!.phase).toBeUndefined(); // already arrived, untouched
  });

  it("pushes the silence deadline out instead of leaving the original dispatch time", () => {
    const { tracker, advance, timers } = makeTracker(1000);
    dispatchSingle(tracker);
    advance(900);
    tracker.noteActivity(FILE_A, { phase: "still going" });
    // The next-armed timer is relative to the refreshed lastSignal, not the
    // original dispatch — 1000ms out again, not 100ms.
    expect(timers.at(-1)!.ms).toBe(1000);
  });
});

describe("ReviewPassTracker — noteComplete", () => {
  it("does not resolve a multi-file pass until the LAST outstanding file completes", () => {
    const { tracker } = makeTracker();
    dispatchMulti(tracker);
    tracker.noteComplete(FILE_A);
    expect(tracker.get(FOLDER)!.state).toBe("waiting");
    tracker.noteComplete(FILE_B);
    expect(tracker.get(FOLDER)!.state).toBe("arrived");
  });

  it("a multi-file pass with threads already landing stays receiving until every file completes", () => {
    const { tracker } = makeTracker();
    dispatchMulti(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    expect(tracker.get(FOLDER)!.state).toBe("receiving");
    tracker.noteComplete(FILE_A);
    expect(tracker.get(FOLDER)!.state).toBe("receiving"); // B still outstanding
    tracker.noteComplete(FILE_B);
    const record = tracker.get(FOLDER)!;
    expect(record.state).toBe("arrived");
    expect(totalNewThreads(record)).toBe(1);
  });

  it("a pass that finds nothing still finishes — arrived with a zero count", () => {
    const { tracker } = makeTracker();
    dispatchMulti(tracker);
    tracker.noteComplete(FILE_A);
    tracker.noteComplete(FILE_B);
    const record = tracker.get(FOLDER)!;
    expect(record.state).toBe("arrived");
    expect(totalNewThreads(record)).toBe(0);
  });

  it("mc_check is itself protocol evidence even with no prior tool call", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    expect(tracker.get(FOLDER)!.evidence).toBe("inferred");
    tracker.noteComplete(FILE_A);
    expect(tracker.get(FOLDER)!.state).toBe("arrived");
  });

  it("is a no-op once the pass already resolved", () => {
    const { tracker, changes } = makeTracker();
    dispatchSingle(tracker);
    tracker.noteComplete(FILE_A);
    changes.length = 0;
    tracker.noteComplete(FILE_A);
    expect(changes).toEqual([]);
  });
});

describe("ReviewPassTracker — waiting → stale (nothing received at all)", () => {
  it("goes stale after the timeout with no signal at all", () => {
    const { tracker, advance, runTimers } = makeTracker(1000);
    dispatchSingle(tracker);
    advance(1001);
    runTimers();
    expect(tracker.get(FOLDER)!.state).toBe("stale");
  });

  it("does not go stale before the deadline", () => {
    const { tracker, advance, runTimers } = makeTracker(1000);
    dispatchSingle(tracker);
    advance(999);
    runTimers();
    expect(tracker.get(FOLDER)?.state).toBe("waiting");
  });

  it("activity keeps a long pass alive past what the original deadline would have been", () => {
    const { tracker, advance, runTimers } = makeTracker(1000);
    dispatchSingle(tracker);
    for (let i = 0; i < 5; i++) {
      advance(900);
      tracker.noteActivity(FILE_A, { phase: `step ${i}` });
      runTimers();
    }
    // 4.5s elapsed against a 1s timeout — still alive because activity kept
    // resetting the deadline.
    expect(tracker.get(FOLDER)!.state).toBe("waiting");
  });

  it("still goes stale once the protocol goes silent", () => {
    const { tracker, advance, runTimers } = makeTracker(1000);
    dispatchSingle(tracker);
    tracker.noteActivity(FILE_A);
    advance(1001);
    runTimers();
    expect(tracker.get(FOLDER)!.state).toBe("stale");
  });
});

describe("ReviewPassTracker — receiving → arrived (quiet period)", () => {
  it("a receiving pass with no further signal becomes arrived, not stale, after the quiet period", () => {
    const { tracker, advance, runTimers } = makeTracker(1_000_000, 500);
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]); // → receiving
    advance(501);
    runTimers();
    const record = tracker.get(FOLDER)!;
    expect(record.state).toBe("arrived");
    expect(totalNewThreads(record)).toBe(1);
  });

  it("does not resolve before the quiet period elapses", () => {
    const { tracker, advance, runTimers } = makeTracker(1_000_000, 500);
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    advance(499);
    runTimers();
    expect(tracker.get(FOLDER)!.state).toBe("receiving");
  });

  it("the quiet period is measured from the LAST thread, not the first", () => {
    const { tracker, advance, runTimers } = makeTracker(1_000_000, 500);
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]); // t=0: → receiving
    advance(400);
    tracker.noteDocument(FILE_A, [agentThread("t1"), agentThread("t2")]); // t=400: refreshes lastSignal
    advance(400); // t=800 total — 500ms past thread #1, but only 400ms past thread #2
    runTimers();
    expect(tracker.get(FOLDER)!.state).toBe("receiving");
    advance(101); // now 501ms since thread #2
    runTimers();
    const record = tracker.get(FOLDER)!;
    expect(record.state).toBe("arrived");
    expect(totalNewThreads(record)).toBe(2);
  });

  it("a receiving pass never goes stale, however long it stays quiet", () => {
    // Same silence duration that would stale a `waiting` pass (the outer
    // timeoutMs), but this one already has evidence something landed.
    const { tracker, advance, runTimers } = makeTracker(1000, 1000);
    dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    advance(1001);
    runTimers();
    expect(tracker.get(FOLDER)!.state).toBe("arrived");
  });
});

describe("ReviewPassTracker — dismiss, current, get", () => {
  it("dismiss forgets the pass entirely", () => {
    const { tracker, changes } = makeTracker();
    dispatchSingle(tracker);
    changes.length = 0;
    tracker.dismiss(FOLDER);
    expect(tracker.get(FOLDER)).toBeUndefined();
    expect(changes).toEqual([FOLDER]);
  });

  it("dismissing a folder with no pass notifies nothing", () => {
    const { tracker, changes } = makeTracker();
    tracker.dismiss(FOLDER);
    expect(changes).toEqual([]);
  });

  it("current() is the most recently dispatched pass across every folder", () => {
    const { tracker, advance } = makeTracker();
    dispatchSingle(tracker);
    advance(10);
    const later = tracker.dispatch({
      folderKey: "file:///ws2/",
      files: ["file:///ws2/c.md"],
      knownThreadIds: new Map([["file:///ws2/c.md", new Set<string>()]]),
      payload: payload("c.md"),
      intent: INTENT,
    });
    expect(tracker.current()).toBe(later);
  });

  it("dispose cancels every outstanding timer and forgets every pass", () => {
    const { tracker } = makeTracker();
    dispatchSingle(tracker);
    tracker.dispose();
    expect(tracker.get(FOLDER)).toBeUndefined();
  });
});

// Every status-text state, verbatim (10x-plan-4 P2.2's design spells these out
// literally — pinned here so a rewording is a deliberate edit, not a drift).
describe("reviewPassStatusText", () => {
  function record(overrides: Partial<ReviewPassRecord> = {}): ReviewPassRecord {
    return {
      id: "review-pass-1",
      folderKey: FOLDER,
      files: [FILE_A],
      dispatchedAt: T0,
      lastSignal: T0,
      evidence: "inferred",
      knownThreadIds: new Map(),
      state: "waiting",
      outstanding: new Set([FILE_A]),
      newThreadCounts: new Map(),
      payload: payload("docs/guide.md"),
      intent: INTENT,
      ...overrides,
    };
  }

  it("inferred + waiting: a fact, not a claim about Claude", () => {
    const view = reviewPassStatusText(record(), T0 + 80_000);
    expect(view.text).toBe("$(clock) Sent for review · 1m 20s");
    expect(view.tooltip).toBe(
      "Sent docs/guide.md to Claude for review. Waiting for comments to appear — click for options.",
    );
  });

  it("protocol + waiting + phase", () => {
    const view = reviewPassStatusText(record({ evidence: "protocol", phase: "reading 2 of 3" }), T0);
    expect(view.text).toBe("$(loading~spin) Claude: reading 2 of 3");
  });

  it("protocol + waiting, no phase yet", () => {
    const view = reviewPassStatusText(record({ evidence: "protocol" }), T0);
    expect(view.text).toBe("$(loading~spin) Claude is reviewing docs/guide.md");
  });

  it("protocol names whichever agent actually earned it", () => {
    const view = reviewPassStatusText(record({ evidence: "protocol", agent: "codex", phase: "opening threads" }), T0);
    expect(view.text).toBe("$(loading~spin) Codex: opening threads");
  });

  it("receiving, one new thread: singular, a fact that threads are appearing", () => {
    const view = reviewPassStatusText(
      record({ state: "receiving", outstanding: new Set([FILE_A]), newThreadCounts: new Map([[FILE_A, 1]]) }),
      T0,
    );
    expect(view.text).toBe("$(sync~spin) Review in progress · 1 new comment");
    expect(view.tooltip).toBe(
      "Claude's review of docs/guide.md is under way — 1 new comment so far. Click for options.",
    );
  });

  it("receiving, several new threads: plural, summed across files", () => {
    const view = reviewPassStatusText(
      record({
        state: "receiving",
        files: [FILE_A, FILE_B],
        outstanding: new Set([FILE_A, FILE_B]),
        newThreadCounts: new Map([
          [FILE_A, 2],
          [FILE_B, 1],
        ]),
      }),
      T0,
    );
    expect(view.text).toBe("$(sync~spin) Review in progress · 3 new comments");
  });

  it("arrived, zero new threads: 'no concerns found', not silence", () => {
    const view = reviewPassStatusText(record({ state: "arrived" }), T0);
    expect(view.text).toBe("$(check) Review arrived: no concerns found");
  });

  it("arrived, one new thread: singular", () => {
    const view = reviewPassStatusText(
      record({ state: "arrived", newThreadCounts: new Map([[FILE_A, 1]]) }),
      T0,
    );
    expect(view.text).toBe("$(check) Review arrived: 1 new comment");
  });

  it("arrived, several new threads: plural, summed across files", () => {
    const view = reviewPassStatusText(
      record({
        state: "arrived",
        files: [FILE_A, FILE_B],
        newThreadCounts: new Map([
          [FILE_A, 2],
          [FILE_B, 1],
        ]),
      }),
      T0,
    );
    expect(view.text).toBe("$(check) Review arrived: 3 new comments");
  });

  it("stale: the fixed 10-minute wording, not a drifting elapsed count", () => {
    const view = reviewPassStatusText(record({ state: "stale" }), T0 + 25 * 60_000);
    expect(view.text).toBe("$(warning) Review sent 10m ago — nothing arrived");
  });
});

describe("firstArrivedFile / totalNewThreads / snapshotReviewPass", () => {
  it("firstArrivedFile picks the first file that actually has a new thread", () => {
    const record: ReviewPassRecord = {
      id: "x",
      folderKey: FOLDER,
      files: [FILE_A, FILE_B],
      dispatchedAt: T0,
      lastSignal: T0,
      evidence: "inferred",
      knownThreadIds: new Map(),
      state: "arrived",
      outstanding: new Set(),
      newThreadCounts: new Map([[FILE_B, 1]]),
      payload: payload("x", ["a.md", "b.md"]),
      intent: INTENT,
    };
    expect(firstArrivedFile(record)).toBe(FILE_B);
  });

  it("firstArrivedFile falls back to the first file when nothing arrived", () => {
    const record: ReviewPassRecord = {
      id: "x",
      folderKey: FOLDER,
      files: [FILE_A, FILE_B],
      dispatchedAt: T0,
      lastSignal: T0,
      evidence: "inferred",
      knownThreadIds: new Map(),
      state: "arrived",
      outstanding: new Set(),
      newThreadCounts: new Map(),
      payload: payload("x", ["a.md", "b.md"]),
      intent: INTENT,
    };
    expect(firstArrivedFile(record)).toBe(FILE_A);
  });

  it("snapshotReviewPass turns Maps/Sets into plain data, and null is null", () => {
    expect(snapshotReviewPass(undefined)).toBeNull();
    const { tracker } = makeTracker();
    const record = dispatchSingle(tracker);
    tracker.noteDocument(FILE_A, [agentThread("t1")]);
    const snap = snapshotReviewPass(tracker.get(FOLDER)) as Record<string, unknown>;
    expect(snap.state).toBe("receiving");
    expect(snap.newThreadCounts).toEqual({ [FILE_A]: 1 });
    expect(snap.id).toBe(record.id);
  });

  it("REVIEW_PASS_TIMEOUT_MS is ten minutes", () => {
    expect(REVIEW_PASS_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("REVIEW_PASS_QUIET_MS is ninety seconds", () => {
    expect(REVIEW_PASS_QUIET_MS).toBe(90 * 1000);
  });
});
