// "Claude is working…" in the status bar (10x-plan-2 P0.2).
//
// The per-thread row is the primary affordance — the wait belongs to a thread,
// and that is where the human is looking. But during a review pass the human is
// often *not* looking at the panel: they went back to the editor while Claude
// reads three files. This is the one place that's visible from anywhere, so it
// carries the phase Claude reports over `mc_status` and disappears the moment
// the pass ends.
//
// Deliberately silent for inferred waits. Standing text that says "Claude is
// working" when the extension is only assuming so would be the same lie the
// timeout exists to avoid — just in a more prominent place. That is why a
// terminal send never lights this up on its own: the extension pasted a
// prompt, and nothing it can observe says Claude picked it up.
//
// Headless runs (10x-plan-4 P0.1) are the exception that proves the rule: the
// extension started that process and reads its event stream, so "Claude is
// reviewing" with a running clock is an observation, not an assumption. While
// one is active it owns the item; the protocol-evidence text returns when it's
// gone. The text itself is built in `headlessStatusText.ts`.

import * as vscode from "vscode";
import { claudePending, onPendingChanged } from "./claudePendingService";
import type { PendingStatus } from "./inlineComments/claudePending";
import { agentDisplayName } from "./agentIdentity";
import { headlessStatusBar } from "./headlessStatusText";
import {
  activeHeadlessRuns,
  lastHeadlessRun,
  onHeadlessRunsChanged,
  type HeadlessRunRecord,
} from "./transports/headless";

/** How long "Claude finished …" stays up. Long enough to notice, short enough to not linger. */
const DONE_FLASH_MS = 8000;

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

/**
 * Show the phase of any protocol-backed pass — or an active headless run — in
 * the status bar. Returns a disposable that also removes the item.
 */
export function activateClaudeStatusBar(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const PROTOCOL_TOOLTIP = "Markdown Collab: Claude is working through the review tools";

  /** The last text the protocol-evidence path asked for (null = hidden). */
  let pendingText: string | null = null;
  /**
   * The finished run still being shown: "finished" for a few seconds, a
   * failure until the human clicks it. Cleared by a click or a newer run.
   */
  let notice: { record: HeadlessRunRecord; until: number | null } | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const render = (): void => {
    const now = Date.now();
    const running = activeHeadlessRuns()[0];
    const shown = running ?? (notice && (notice.until === null || notice.until > now) ? notice.record : null);
    const view = shown ? headlessStatusBar(shown.run.state, shown.fileLabel, now) : null;
    if (view) {
      item.text = view.text;
      item.tooltip = view.tooltip;
      item.command = "markdownCollab.headlessRunMenu";
      item.show();
    } else if (pendingText) {
      item.text = pendingText;
      item.tooltip = PROTOCOL_TOOLTIP;
      item.command = undefined;
      item.show();
    } else {
      item.hide();
    }
    // The clock only ticks while something is running.
    if (running && !ticker) ticker = setInterval(render, 1000);
    if (!running && ticker) {
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
   * The status bar click. A running pass offers the three things a human
   * watching it might want; a finished one goes where its text points.
   */
  const menu = vscode.commands.registerCommand("markdownCollab.headlessRunMenu", async () => {
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

  const pendingSub = onPendingChanged(refresh);
  const runsSub = onHeadlessRunsChanged(onRunsChanged);
  return {
    dispose(): void {
      pendingSub.dispose();
      runsSub.dispose();
      menu.dispose();
      if (ticker) clearInterval(ticker);
      if (noticeTimer) clearTimeout(noticeTimer);
      item.dispose();
    },
  };
}

async function openFirstFile(record: HeadlessRunRecord): Promise<void> {
  const first = record.files[0];
  if (!first) return;
  await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", vscode.Uri.file(first));
}
