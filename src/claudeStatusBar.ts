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
// timeout exists to avoid — just in a more prominent place.

import * as vscode from "vscode";
import { claudePending, onPendingChanged } from "./claudePendingService";
import type { PendingStatus } from "./inlineComments/claudePending";

/** What the status bar should read, or null to hide it. */
export function statusBarText(status: PendingStatus, fileLabel: string): string | null {
  if (status.threadIds.length === 0) return null;
  if (status.evidence !== "protocol") return null;
  if (status.phase) return `$(loading~spin) Claude: ${status.phase}`;
  if (status.active) return `$(loading~spin) Claude is working on ${fileLabel}`;
  return `$(loading~spin) Sent ${fileLabel} to Claude`;
}

/**
 * Show the phase of any protocol-backed pass in the status bar. Returns a
 * disposable that also removes the item.
 */
export function activateClaudeStatusBar(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.tooltip = "Markdown Collab: Claude is working through the review tools";

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
    const text = statusBarText(status, vscode.workspace.asRelativePath(uri));
    if (text) {
      item.text = text;
      item.show();
    } else {
      item.hide();
    }
  };

  const sub = onPendingChanged(refresh);
  return {
    dispose(): void {
      sub.dispose();
      item.dispose();
    },
  };
}
