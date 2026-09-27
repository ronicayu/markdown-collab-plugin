// "Sent for review" — a pulse for the one wait `claudePending.ts` structurally
// can't cover (10x-plan-4 P2.2, née 10x-plan-3 P2.1).
//
// `claudePending.ts` tracks threads Claude owes a reply on. A review REQUEST
// ("Ask Claude to Review", single file / folder / "changes since last pass")
// carries no comments at all — it asks Claude to open threads from scratch —
// so there is nothing for that tracker to snapshot and nothing ever resolves.
// The result, before this module: one toast on send, then silence until
// threads happen to land, indistinguishable from a paste that never arrived.
//
// This module is that pass's own record, parallel in shape and in spirit to
// `ClaudePendingTracker`: one entry per dispatched review request, an
// "inferred" vs "protocol" evidence grade with the same meaning (see
// `claudePending.ts`'s module header — the short version: inferred is a
// guess, protocol is a tool call), and the same injected clock/scheduler so
// the timeouts are testable without waiting for real.
//
// What's different from the per-thread tracker: a review pass has no prior
// threads to answer, so "done" means something else, and it isn't one-shot —
// the skill opens threads ONE AT A TIME as it reads, so a pass over a big
// file can write thirty of them over a couple of minutes. Resolving the whole
// pass on the FIRST one would show "1 new comment" while twenty-nine more are
// still coming, which is its own kind of lie. So there's a state in between:
//
//   waiting    — dispatched; nothing has landed yet.
//   receiving  — at least one new agent-authored thread has landed, and the
//                pass isn't complete yet. Every further thread refreshes the
//                silence clock; a `waiting` pass can only reach this by way
//                of a thread actually landing.
//   arrived    — every file the pass covers is COMPLETE: either its closing
//                `mc_check` fired, or its review checkpoint moved to at or
//                after the pass's dispatch time (a terminal Claude using the
//                `mdc` CLI stamps one on a healthy `mdc check`, same as
//                `mc_check` does) — or, for a session that never checks in at
//                all, a quiet period elapsed with no new thread. A pass that
//                completes having found nothing is still `arrived`, honestly,
//                with a zero count — not a pass stuck in `waiting` forever.
//   stale      — `waiting` for the full ten-minute timeout with NOTHING
//                received at all. A `receiving` pass never goes stale; once
//                something has landed, the only way out is completion (by
//                signal or by quiet period), never "nothing arrived".
//
// Pure and vscode-free, like `claudePending.ts`: the host (`reviewPassWatch.ts`,
// `claudeStatusBar.ts`, `commands/send.ts`) wires this to `onDidChangeTextDocument`,
// a `FileSystemWatcher`, and the same MCP tool-call signals the per-thread
// tracker reads. `ReviewPassPayload`/`ReviewPassIntent` below are duplicated
// (not imported) from `sendToClaude.ts` / `commands/send.ts`'s shapes for
// exactly that reason — TypeScript's structural typing means the real
// `ReviewPayload` and `DispatchIntent` satisfy them without a cast, so nothing
// is lost by not reaching across the vscode boundary to import them.

import { agentDisplayName, isAgentComment } from "./agentIdentity";
import { formatElapsed } from "./headlessStatusText";

/** How long a `waiting` pass may go with NOTHING received before it's declared stale. Same duration as the per-thread wait — it's the same "how long is too long to say nothing" question. */
export const REVIEW_PASS_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a `receiving` pass may go with no NEW thread before it's called done anyway — the fallback for a session that opens threads but never checks in. Short, relative to the stale timeout: silence here already has other evidence (threads did land), so there's much less to lose by calling it early. */
export const REVIEW_PASS_QUIET_MS = 90 * 1000;

/** How the tracker knows about this pass. See the module comment and `claudePending.ts`. */
export type ReviewPassEvidence = "inferred" | "protocol";

/** Where a live pass currently stands. See the module header for what separates each from the next. */
export type ReviewPassPhase = "waiting" | "receiving" | "arrived" | "stale";

/** The shape this module needs from a parsed thread. */
export interface ReviewPassInputThread {
  id: string;
  comments: Array<{ author: string; deleted?: boolean; agent?: boolean }>;
}

/** The one field this module needs from `ReviewCheckpoint` (`src/inlineComments/format.ts`) — duplicated for the same vscode-free reason as `ReviewPassPayload` below. */
export interface ReviewPassInputCheckpoint {
  /** ISO-8601 UTC. */
  ts: string;
}

/** Structurally identical to `ReviewPayload` (`src/sendToClaude.ts`) — see the
 * module header for why this is a duplicate shape rather than an import. */
export interface ReviewPassPayload {
  prompt: string;
  inlineSkillPrompt?: string;
  file: string;
  files?: string[];
  unresolvedCount: number;
  comments: unknown[];
}

/** Structurally identical to `commands/send.ts`'s `DispatchIntent`, narrowed
 * to the one variant that ever starts a pass. */
export interface ReviewPassIntent {
  kind: "review-request";
  hasFocus: boolean;
}

/** One dispatched review request. */
export interface ReviewPassRecord {
  id: string;
  /** `vscode.WorkspaceFolder.uri.toString()` — the "one live pass per folder" key. */
  folderKey: string;
  /** `uri.toString()` for every file the pass covers. */
  files: string[];
  dispatchedAt: number;
  /** Epoch ms of the most recent evidence this pass is still alive — see `claudePending.ts`'s field of the same name. Drives the `waiting` stale timeout AND the `receiving` quiet period, whichever the current state uses. */
  lastSignal: number;
  evidence: ReviewPassEvidence;
  /** Latest phase Claude reported via `mc_status`, if any. */
  phase?: string;
  /** Agent slug protocol evidence was last recorded under (10x-plan-4 P1.2). */
  agent?: string;
  /** Snapshot of each file's thread ids at dispatch — what "new" is measured against. */
  knownThreadIds: Map<string, Set<string>>;
  state: ReviewPassPhase;
  /** Files not yet COMPLETE — no `mc_check`/CLI checkpoint seen for them since dispatch. Empties (by either signal) to trigger the "every file done" resolution. */
  outstanding: Set<string>;
  /** New agent-authored thread count discovered so far, per file. */
  newThreadCounts: Map<string, number>;
  /** Kept verbatim so "Resend" can re-dispatch through the exact same path. */
  payload: ReviewPassPayload;
  intent: ReviewPassIntent;
}

/** Is `t` a thread the snapshot didn't know about, opened by an agent? A
 * human opening a new thread of their own while Claude is out doesn't mean
 * the pass landed — only an agent's does (10x-plan-4 P1.2: any agent, not
 * just Claude, same rule `isAgentComment` applies everywhere else). */
function isNewAgentThread(known: Set<string>, t: ReviewPassInputThread): boolean {
  if (known.has(t.id)) return false;
  const live = t.comments.filter((c) => !c.deleted);
  if (live.length === 0) return false;
  return isAgentComment(live[0]!);
}

/** Total new-thread count across every file in the pass — what "N new comments" counts. */
export function totalNewThreads(record: ReviewPassRecord): number {
  let total = 0;
  for (const n of record.newThreadCounts.values()) total += n;
  return total;
}

/** The file to open on a click: the first one with a new thread, or — for the
 * zero-count "no concerns found" case, or before anything has arrived — the
 * first file in the pass, since there's still something to open. */
export function firstArrivedFile(record: ReviewPassRecord): string | undefined {
  for (const file of record.files) {
    if ((record.newThreadCounts.get(file) ?? 0) > 0) return file;
  }
  return record.files[0];
}

/** States in which a pass is still live enough to accept a signal. Both `noteDocument` and the tool-call signals are inert once a pass reaches `arrived`/`stale`. */
function isLive(state: ReviewPassPhase): boolean {
  return state === "waiting" || state === "receiving";
}

/**
 * Per-folder record of a review request Claude hasn't finished yet.
 *
 * Lives in the extension host (via `reviewPassPendingService.ts`) rather than
 * a webview so the status bar item works with no panel open at all — exactly
 * the case this exists for, since a review REQUEST is dispatched precisely
 * when there's nothing open in the sidebar to show progress in yet.
 */
export class ReviewPassTracker {
  private readonly byFolder = new Map<string, ReviewPassRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(
    /** Called whenever a folder's live pass changes state. */
    private readonly onChange: (folderKey: string) => void = () => {},
    private readonly now: () => number = () => Date.now(),
    private readonly timeoutMs: number = REVIEW_PASS_TIMEOUT_MS,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
    private readonly cancel: (t: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t),
    private readonly quietMs: number = REVIEW_PASS_QUIET_MS,
  ) {}

  /**
   * Start tracking a freshly dispatched review request. Only one live pass
   * per folder: a new dispatch replaces whatever was there, discarding its
   * progress along with it — the same rule `claudePending.mark` follows for a
   * re-sent thread.
   */
  public dispatch(opts: {
    folderKey: string;
    files: string[];
    knownThreadIds: Map<string, Set<string>>;
    payload: ReviewPassPayload;
    intent: ReviewPassIntent;
    /** Always "inferred" in production — see the module header. Overridable for tests. */
    evidence?: ReviewPassEvidence;
  }): ReviewPassRecord {
    this.clearTimer(opts.folderKey);
    const now = this.now();
    const record: ReviewPassRecord = {
      id: `review-pass-${++this.seq}-${now}`,
      folderKey: opts.folderKey,
      files: [...opts.files],
      dispatchedAt: now,
      lastSignal: now,
      evidence: opts.evidence ?? "inferred",
      knownThreadIds: opts.knownThreadIds,
      state: "waiting",
      outstanding: new Set(opts.files),
      newThreadCounts: new Map(),
      payload: opts.payload,
      intent: opts.intent,
    };
    this.byFolder.set(opts.folderKey, record);
    this.armTimer(opts.folderKey);
    this.onChange(opts.folderKey);
    return record;
  }

  /** The record whose file list contains `docKey`, if it's still live. */
  private forDoc(docKey: string): ReviewPassRecord | undefined {
    for (const record of this.byFolder.values()) {
      if (record.files.includes(docKey)) return record;
    }
    return undefined;
  }

  /**
   * A file in a live pass changed. Two independent things can be true of the
   * SAME change, and both are checked every time:
   *
   *   - a thread not in the dispatch-time snapshot, agent-authored → counts
   *     as newly arrived, and moves a `waiting` pass into `receiving` (a
   *     `receiving` pass just keeps accumulating).
   *   - the file's own review checkpoint moved to at or after the pass's
   *     dispatch time → this ONE file is complete (same "the pass finished"
   *     signal `noteComplete`/`mc_check` gives, just noticed a different way:
   *     a terminal Claude using the `mdc` CLI stamps this on a healthy
   *     `mdc check`, and never calls `mc_check` at all).
   *
   * The whole pass resolves to `arrived` once every file is complete —
   * whichever of the two ways got each one there.
   */
  public noteDocument(
    docKey: string,
    threads: ReviewPassInputThread[],
    checkpoint?: ReviewPassInputCheckpoint | null,
  ): void {
    const record = this.forDoc(docKey);
    if (!record || !isLive(record.state)) return;
    let changed = false;

    // The stored Set, not a fallback copy — threads land one at a time while
    // `receiving`, so THIS call's fresh ids must be folded back in before the
    // NEXT call, or a thread already counted would be counted again every
    // time it reappears in a later snapshot of the same file.
    let known = record.knownThreadIds.get(docKey);
    if (!known) {
      known = new Set<string>();
      record.knownThreadIds.set(docKey, known);
    }
    const fresh = threads.filter((t) => isNewAgentThread(known!, t));
    if (fresh.length > 0) {
      for (const t of fresh) known.add(t.id);
      record.newThreadCounts.set(docKey, (record.newThreadCounts.get(docKey) ?? 0) + fresh.length);
      if (record.state === "waiting") record.state = "receiving";
      changed = true;
    }

    if (checkpoint && Date.parse(checkpoint.ts) >= record.dispatchedAt && record.outstanding.delete(docKey)) {
      changed = true;
    }

    if (!changed) return;
    record.lastSignal = this.now();

    if (record.outstanding.size === 0) {
      this.finish(record, "arrived");
      return;
    }
    this.armTimer(record.folderKey);
    this.onChange(record.folderKey);
  }

  /** Applies an activity signal to one live record. Shared by `noteActivity` and `noteActivityEverywhere`. */
  private applyActivity(record: ReviewPassRecord, opts: { phase?: string; agent?: string }): void {
    record.evidence = "protocol";
    if (opts.phase !== undefined) record.phase = opts.phase;
    if (opts.agent !== undefined) record.agent = opts.agent;
    record.lastSignal = this.now();
    this.armTimer(record.folderKey);
    this.onChange(record.folderKey);
  }

  /**
   * Claude called a tool against this file. Upgrades the pass to "protocol"
   * evidence and pushes the silence deadline out (`waiting`'s stale timeout,
   * or `receiving`'s quiet period — whichever the current state uses), same
   * as `claudePending.noteActivity`.
   */
  public noteActivity(docKey: string, opts: { phase?: string; agent?: string } = {}): void {
    const record = this.forDoc(docKey);
    if (!record || !isLive(record.state)) return;
    this.applyActivity(record, opts);
  }

  /** An `mc_status` note with no file — applies to every pass currently live. */
  public noteActivityEverywhere(opts: { phase?: string; agent?: string } = {}): void {
    for (const record of [...this.byFolder.values()]) {
      if (isLive(record.state)) this.applyActivity(record, opts);
    }
  }

  /**
   * Claude finished its pass on this file (`mc_check`). Only resolves the
   * WHOLE pass once every file it covers has checked in — a multi-file pass
   * is not done because the first of three files is. A pass that never finds
   * anything to comment on still finishes this way: "arrived" with a zero
   * count is a legitimate, honest outcome (the skill's own rule), not a
   * silent one.
   */
  public noteComplete(docKey: string): void {
    const record = this.forDoc(docKey);
    if (!record || !isLive(record.state)) return;
    record.outstanding.delete(docKey);
    record.lastSignal = this.now();
    if (record.outstanding.size === 0) {
      this.finish(record, "arrived");
    } else {
      this.armTimer(record.folderKey);
      this.onChange(record.folderKey);
    }
  }

  /** The live (or just-resolved) pass for one folder, or undefined if none. */
  public get(folderKey: string): ReviewPassRecord | undefined {
    return this.byFolder.get(folderKey);
  }

  /**
   * The pass the status bar should show when more than one folder has one —
   * the most recently dispatched, on the theory that whatever the human just
   * asked for is the one they're waiting on.
   */
  public current(): ReviewPassRecord | undefined {
    let best: ReviewPassRecord | undefined;
    for (const record of this.byFolder.values()) {
      if (!best || record.dispatchedAt > best.dispatchedAt) best = record;
    }
    return best;
  }

  /** Forget a folder's pass outright — the status bar's "Dismiss" action, for a live or a stale pass alike. */
  public dismiss(folderKey: string): void {
    const had = this.byFolder.delete(folderKey);
    this.clearTimer(folderKey);
    if (had) this.onChange(folderKey);
  }

  public dispose(): void {
    for (const key of [...this.timers.keys()]) this.clearTimer(key);
    this.byFolder.clear();
  }

  private finish(record: ReviewPassRecord, state: "arrived" | "stale"): void {
    record.state = state;
    this.clearTimer(record.folderKey);
    this.onChange(record.folderKey);
  }

  /**
   * Wake up when the pass falls silent for as long as its CURRENT state
   * tolerates, so it stops looking live without needing an external event to
   * notice — same pattern as `ClaudePendingTracker.armTimer`. Which deadline
   * applies depends on the state at arm time: `waiting` measures against the
   * ten-minute stale timeout and lands on `stale`; `receiving` measures
   * against the ninety-second quiet period and lands on `arrived` (something
   * already landed — quiet just means it's over, not that it failed).
   * `arrived`/`stale` need no timer at all.
   */
  private armTimer(folderKey: string): void {
    this.clearTimer(folderKey);
    const record = this.byFolder.get(folderKey);
    if (!record || !isLive(record.state)) return;
    const deadlineMs = record.state === "waiting" ? this.timeoutMs : this.quietMs;
    const delay = Math.max(0, record.lastSignal + deadlineMs - this.now());
    // Only `recordId` is captured — everything else the callback reads is
    // read LIVE off `this.byFolder` when it actually fires, not frozen here.
    // `record` and whatever `this.byFolder.get(folderKey)` returns later are
    // the SAME object as long as no new dispatch replaced it (mutations
    // happen in place), so comparing `record.state` to itself would never
    // catch anything — the callback has to be correct standing alone, the
    // same way `ClaudePendingTracker`'s timer recomputes from scratch rather
    // than trusting who scheduled it.
    const recordId = record.id;
    const timer = this.schedule(() => {
      this.timers.delete(folderKey);
      const current = this.byFolder.get(folderKey);
      if (!current || current.id !== recordId || !isLive(current.state)) return;
      const liveDeadlineMs = current.state === "waiting" ? this.timeoutMs : this.quietMs;
      if (this.now() - current.lastSignal >= liveDeadlineMs) {
        this.finish(current, current.state === "waiting" ? "stale" : "arrived");
      } else {
        this.armTimer(folderKey);
      }
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(folderKey, timer);
  }

  private clearTimer(folderKey: string): void {
    const timer = this.timers.get(folderKey);
    if (timer !== undefined) {
      this.cancel(timer);
      this.timers.delete(folderKey);
    }
  }
}

/**
 * The status bar line for a live (or just-resolved) pass. Every branch is a
 * fact: "sent" for an inferred wait (nothing claims Claude picked it up),
 * whatever Claude last reported for a protocol one (a tool call IS evidence),
 * "in progress" once threads are actually landing, and a plain count once
 * every file is done — never "Claude is working/reviewing" without protocol
 * evidence behind it (the same honesty rule `claudeStatusBar.ts`'s header
 * states for the per-thread wait).
 */
export function reviewPassStatusText(record: ReviewPassRecord, now: number): { text: string; tooltip: string } {
  const fileLabel = record.payload.file;
  if (record.state === "waiting") {
    if (record.evidence === "protocol") {
      const agent = agentDisplayName(record.agent ?? "claude");
      const text = record.phase
        ? `$(loading~spin) ${agent.noun}: ${record.phase}`
        : `$(loading~spin) ${agent.sentence} is reviewing ${fileLabel}`;
      return {
        text,
        tooltip: `${agent.sentence} is working through the review tools on ${fileLabel}. Click for options.`,
      };
    }
    const elapsed = formatElapsed(now - record.dispatchedAt);
    return {
      text: `$(clock) Sent for review · ${elapsed}`,
      tooltip: `Sent ${fileLabel} to Claude for review. Waiting for comments to appear — click for options.`,
    };
  }
  if (record.state === "receiving") {
    const total = totalNewThreads(record);
    return {
      text: `$(sync~spin) Review in progress · ${total} new comment${total === 1 ? "" : "s"}`,
      tooltip: `Claude's review of ${fileLabel} is under way — ${total} new comment${total === 1 ? "" : "s"} so far. Click for options.`,
    };
  }
  if (record.state === "arrived") {
    const total = totalNewThreads(record);
    if (total === 0) {
      return {
        text: "$(check) Review arrived: no concerns found",
        tooltip: `Claude reviewed ${fileLabel} and found nothing worth a thread. Click to open it.`,
      };
    }
    return {
      text: `$(check) Review arrived: ${total} new comment${total === 1 ? "" : "s"}`,
      tooltip: `Claude's review of ${fileLabel} landed — ${total} new comment${total === 1 ? "" : "s"}. Click to open.`,
    };
  }
  // "stale" — the constant is fixed, so the wording can be too, rather than
  // recomputing a drifting "N minutes ago" for a pass that's stopped ticking.
  const minutes = Math.round(REVIEW_PASS_TIMEOUT_MS / 60000);
  return {
    text: `$(warning) Review sent ${minutes}m ago — nothing arrived`,
    tooltip: `Sent ${fileLabel} to Claude for review ${minutes} minutes ago — nothing has arrived yet. Click to resend, dismiss, or show logs.`,
  };
}

/** A plain-data view of a pass for a caller with no business holding onto
 * `Map`/`Set` internals — the internal `markdownCollab.reviewPassStatus`
 * command diagnostics and the integration suite read through this. */
export function snapshotReviewPass(record: ReviewPassRecord | undefined): unknown {
  if (!record) return null;
  return {
    id: record.id,
    folderKey: record.folderKey,
    files: record.files,
    dispatchedAt: record.dispatchedAt,
    lastSignal: record.lastSignal,
    evidence: record.evidence,
    phase: record.phase,
    agent: record.agent,
    state: record.state,
    newThreadCounts: Object.fromEntries(record.newThreadCounts),
    outstanding: [...record.outstanding],
  };
}
