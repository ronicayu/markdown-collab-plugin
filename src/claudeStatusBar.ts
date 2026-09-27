// "Claude is working…" in the status bar (10x-plan-2 P0.2), and — since
// 10x-plan-4 P2.2 — "sent for review" for the one wait that used to have no
// pulse at all.
//
// The per-thread row is the primary affordance — the wait belongs to a thread,
// and that is where the human is looking. But during a review pass the human is
// often *not* looking at the panel: they went back to the editor while Claude
// reads three files. This is the one place that's visible from anywhere, so it
// carries the phase Claude reports over `mc_status` and disappears the moment
// the pass ends.
//
// Deliberately silent for inferred waits — mostly. Standing text that says
// "Claude is working" when the extension is only assuming so would be the same
// lie the timeout exists to avoid — just in a more prominent place. That is
// why a terminal send never lights this up on its own for a per-thread wait:
// the extension pasted a prompt, and nothing it can observe says Claude picked
// it up. The one deliberate exception is the review-pass item below: it says
// "Sent for review" for an inferred pass, which is not a claim about Claude at
// all — it's a fact about what the extension did, and reads like one
// (`$(clock)`, not `$(loading~spin)`, and no verb attached to Claude).
//
// Headless runs (10x-plan-4 P0.1) are the other exception that proves the
// rule: the extension started that process and reads its event stream, so
// "Claude is reviewing" with a running clock is an observation, not an
// assumption. While one is active it owns the item; nothing else is shown
// until it's gone. The text itself is built in `headlessStatusText.ts`.
//
// Priority when more than one thing wants this one item (`chooseStatusBarView`,
// below): an active headless run outright (10x-plan-4 P0.1 already owns the
// item while it runs, and nothing here duplicates that) > a live review pass
// (10x-plan-4 P2.2 — the pulse this file's second half exists for) > a
// per-thread protocol wait > a finished/failed headless notice, which sits
// last because it is a look-back at something already over, and anything
// still live is more worth a glance than a look-back.

import * as vscode from "vscode";
import { claudePending, onPendingChanged } from "./claudePendingService";
import type { PendingStatus } from "./inlineComments/claudePending";
import { agentDisplayName } from "./agentIdentity";
import { headlessStatusBar } from "./headlessStatusText";
import { reviewPassPending, onReviewPassChanged } from "./reviewPassPendingService";
import { firstArrivedFile, reviewPassStatusText, type ReviewPassRecord } from "./reviewPassPending";
import {
  activeHeadlessRuns,
  lastHeadlessRun,
  onHeadlessRunsChanged,
  type HeadlessRunRecord,
} from "./transports/headless";

/** How long "Claude finished …" stays up. Long enough to notice, short enough to not linger. */
const DONE_FLASH_MS = 8000;

/** How long "Review arrived" stays up before it goes back to silent — same duration and the same reasoning as `DONE_FLASH_MS`. */
const REVIEW_ARRIVED_FLASH_MS = 8000;

/**
 * What the status bar should read, or null to hide it. Names whichever agent
 * the protocol evidence actually came from (10x-plan-4 P1.2) — defaulting to
 * Claude, both because that's the overwhelming common case and because an
 * "inferred" wait (filtered out above) never earns a slug at all.
 */
export function statusBarText(status: PendingStatus, fileLabel: string): string | null {
  if (status.threadIds.length === 0) return null;
  if (status.evidence !== "protocol") return null;
  const agent = agentDisplayName(status.agent ?? "claude");
  if (status.phase) return `$(loading~spin) ${agent.noun}: ${status.phase}`;
  if (status.active) return `$(loading~spin) ${agent.sentence} is working on ${fileLabel}`;
  return `$(loading~spin) Sent ${fileLabel} to ${agent.sentence}`;
}

/** One thing that can occupy the status bar item, and the command a click on it runs. */
export type StatusBarSource = "headless" | "review-pass" | "pending" | "notice";

export interface StatusBarChoice {
  source: StatusBarSource;
  text: string;
  tooltip: string;
  /** `undefined` for the per-thread wait: it names no phase Claude ever calls a menu on — there's nothing to click through to that the panel doesn't already show. */
  command?: string;
}

const PROTOCOL_TOOLTIP = "Markdown Collab: Claude is working through the review tools";

/**
 * The priority rule from the module header, as a pure function of the four
 * things that can want this one status bar item — unit-tested without
 * spinning up a real status bar item or any of the trackers behind it.
 */
export function chooseStatusBarView(inputs: {
  headless: { text: string; tooltip: string } | null;
  reviewPass: { text: string; tooltip: string } | null;
  pending: string | null;
  notice: { text: string; tooltip: string } | null;
}): StatusBarChoice | null {
  if (inputs.headless) {
    return { source: "headless", ...inputs.headless, command: "markdownCollab.headlessRunMenu" };
  }
  if (inputs.reviewPass) {
    return { source: "review-pass", ...inputs.reviewPass, command: "markdownCollab.reviewPassMenu" };
  }
  if (inputs.pending) {
    return { source: "pending", text: inputs.pending, tooltip: PROTOCOL_TOOLTIP };
  }
  if (inputs.notice) {
    return { source: "notice", ...inputs.notice, command: "markdownCollab.headlessRunMenu" };
  }
  return null;
}

/** The review-pass view for whichever pass `reviewPassPending.current()` returns, or null once its "arrived" flash has run out (still tracked, just not shown) or there's nothing live at all. */
function currentReviewPassView(now: number): { record: ReviewPassRecord; view: { text: string; tooltip: string } } | null {
  const record = reviewPassPending.current();
  if (!record) return null;
  if (record.state === "arrived" && now - record.lastSignal >= REVIEW_ARRIVED_FLASH_MS) return null;
  return { record, view: reviewPassStatusText(record, now) };
}

/**
 * Show the phase of any protocol-backed pass — a live review pass, or an
 * active headless run — in the status bar. Returns a disposable that also
 * removes the item.
 */
export function activateClaudeStatusBar(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  /** The last text the protocol-evidence path asked for (null = hidden). */
  let pendingText: string | null = null;
  /**
   * The finished run still being shown: "finished" for a few seconds, a
   * failure until the human clicks it. Cleared by a click or a newer run.
   */
  let notice: { record: HeadlessRunRecord; until: number | null } | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let reviewNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  const render = (): void => {
    const now = Date.now();
    const running = activeHeadlessRuns()[0];
    const headlessNotice =
      !running && notice && (notice.until === null || notice.until > now) ? notice.record : null;
    const reviewPassView = running ? null : currentReviewPassView(now);

    const choice = chooseStatusBarView({
      headless: running ? headlessStatusBar(running.run.state, running.fileLabel, now) : null,
      reviewPass: reviewPassView?.view ?? null,
      pending: pendingText,
      notice: headlessNotice ? headlessStatusBar(headlessNotice.run.state, headlessNotice.fileLabel, now) : null,
    });

    if (choice) {
      item.text = choice.text;
      item.tooltip = choice.tooltip;
      item.command = choice.command;
      item.show();
    } else {
      item.hide();
    }

    // The clock ticks once per second only while something live is actually
    // showing elapsed time: a running headless run, or an inferred (not yet
    // protocol-upgraded) review pass — the only two states whose text
    // includes a clock at all.
    const reviewTicking = reviewPassView?.record.state === "waiting" && reviewPassView.record.evidence === "inferred";
    const ticking = Boolean(running) || reviewTicking;
    if (ticking && !ticker) ticker = setInterval(render, 1000);
    if (!ticking && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const onRunsChanged = (): void => {
    const last = lastHeadlessRun();
    if (last && last !== notice?.record && activeHeadlessRuns().length === 0) {
      const kind = last.run.state.kind;
      if (kind === "done") {
        notice = { record: last, until: Date.now() + DONE_FLASH_MS };
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(render, DONE_FLASH_MS + 50);
      } else if (kind === "failed" || kind === "cancelled") {
        // A user cancel renders as nothing (see headlessStatusBar); a failure
        // or a timeout stays until clicked.
        notice = { record: last, until: null };
      }
    }
    if (activeHeadlessRuns().length > 0) notice = null;
    render();
  };

  const refresh = (docKey: string): void => {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(docKey);
    } catch {
      return;
    }
    // `peek`, not `status`: status prunes against the threads it is given, and
    // this callback has no business deciding what has been answered — the
    // panels do that on every push.
    const status = claudePending.peek(docKey);
    pendingText = statusBarText(status, vscode.workspace.asRelativePath(uri));
    render();
  };

  /**
   * A review pass changed. Besides re-rendering, this is what schedules the
   * wake-up that hides an "arrived" pass after its flash window — with no
   * open panel and no further tool calls, nothing else would ever call
   * `render()` again once the flash runs out.
   */
  const onReviewChanged = (): void => {
    if (reviewNoticeTimer) {
      clearTimeout(reviewNoticeTimer);
      reviewNoticeTimer = null;
    }
    const record = reviewPassPending.current();
    if (record?.state === "arrived") {
      const remaining = REVIEW_ARRIVED_FLASH_MS - (Date.now() - record.lastSignal);
      if (remaining > 0) reviewNoticeTimer = setTimeout(render, remaining + 50);
    }
    render();
  };

  /** Open the review view on one of a pass's files, by doc key (`uri.toString()`). */
  const openReviewPassFile = async (docKey: string | undefined): Promise<void> => {
    if (!docKey) return;
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(docKey);
    } catch {
      return;
    }
    await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", uri);
  };

  /**
   * The status bar click. A running headless pass offers the three things a
   * human watching it might want; a finished one goes where its text points.
   */
  const headlessMenu = vscode.commands.registerCommand("markdownCollab.headlessRunMenu", async () => {
    const running = activeHeadlessRuns()[0];
    if (running) {
      const pick = await vscode.window.showQuickPick(["Cancel run", "Show logs", "Open review view"], {
        placeHolder: `Claude is reviewing ${running.fileLabel}`,
      });
      if (pick === "Cancel run") running.run.cancel("user");
      else if (pick === "Show logs") await vscode.commands.executeCommand("markdownCollab.showOutput");
      else if (pick === "Open review view") await openFirstFile(running);
      return;
    }
    const shown = notice;
    notice = null;
    render();
    if (!shown) return;
    if (shown.record.run.state.kind === "done") await openFirstFile(shown.record);
    else await vscode.commands.executeCommand("markdownCollab.showOutput");
  });

  /**
   * The review-pass item's click (10x-plan-4 P2.2). Branches on the pass's
   * own state rather than baking a fixed menu into the item: "waiting" and
   * "receiving" are both still in flight and offer the same two options,
   * "stale" offers the recovery options, and "arrived" offers none at all —
   * a click on an arrived pass just opens it.
   */
  const reviewMenu = vscode.commands.registerCommand("markdownCollab.reviewPassMenu", async () => {
    const record = reviewPassPending.current();
    if (!record) return;
    if (record.state === "arrived") {
      await openReviewPassFile(firstArrivedFile(record));
      return;
    }
    if (record.state === "waiting" || record.state === "receiving") {
      const pick = await vscode.window.showQuickPick(["Open review view", "Dismiss"], {
        placeHolder: `Sent ${record.payload.file} for review`,
      });
      // `firstArrivedFile` falls back to the first file when nothing has
      // landed yet — exactly right for "waiting" too.
      if (pick === "Open review view") await openReviewPassFile(firstArrivedFile(record));
      else if (pick === "Dismiss") reviewPassPending.dismiss(record.folderKey);
      return;
    }
    // "stale"
    const pick = await vscode.window.showQuickPick(["Resend", "Dismiss", "Show logs"], {
      placeHolder: `Review sent to Claude — nothing has arrived yet`,
    });
    if (pick === "Resend") await vscode.commands.executeCommand("markdownCollab.resendReviewPass");
    else if (pick === "Dismiss") reviewPassPending.dismiss(record.folderKey);
    else if (pick === "Show logs") await vscode.commands.executeCommand("markdownCollab.showOutput");
  });

  const pendingSub = onPendingChanged(refresh);
  const reviewSub = onReviewPassChanged(onReviewChanged);
  const runsSub = onHeadlessRunsChanged(onRunsChanged);
  return {
    dispose(): void {
      pendingSub.dispose();
      reviewSub.dispose();
      runsSub.dispose();
      headlessMenu.dispose();
      reviewMenu.dispose();
      if (ticker) clearInterval(ticker);
      if (noticeTimer) clearTimeout(noticeTimer);
      if (reviewNoticeTimer) clearTimeout(reviewNoticeTimer);
      item.dispose();
    },
  };
}

async function openFirstFile(record: HeadlessRunRecord): Promise<void> {
  const first = record.files[0];
  if (!first) return;
  await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", vscode.Uri.file(first));
}
