// Feeds `reviewPassPending.noteDocument` from the extension host (10x-plan-4
// P2.2). The pure tracker only knows how to compare a thread list against a
// snapshot; this is what hands it one, from two independent sources, because
// either can be the only one that fires:
//
//   - `vscode.workspace.onDidChangeTextDocument` — the common case, a Claude
//     terminal session (or the live editor) editing the open document.
//   - a `FileSystemWatcher` scoped to the pass's own files — a terminal
//     Claude using the `mdc` CLI writes straight to disk, and the document
//     this window has open (if any) doesn't fire a change event for that; the
//     panel already re-reads on an FS event elsewhere, this is the same idea
//     applied to a pass that may have no panel open at all.
//
// Started once per successful terminal/clipboard dispatch of a review-request
// payload (`commands/send.ts`); never for headless, which owns the status bar
// outright while it runs (see `claudeStatusBar.ts`'s module header). Watchers
// are torn down the moment the pass they were started for stops being the
// live one for its folder — resolved, gone stale, dismissed, or replaced by a
// fresh dispatch — so nothing accumulates across a long session.

import * as vscode from "vscode";
import type { Logger } from "./logging";
import { parse as parseInline } from "./inlineComments/format";
import { reviewPassPending, onReviewPassChanged } from "./reviewPassPendingService";
import type { ReviewPassIntent, ReviewPassPayload } from "./reviewPassPending";

/** The thread ids a file has right now, or an empty set if it can't be read (new file, race with creation). */
async function snapshotThreadIds(uri: vscode.Uri): Promise<Set<string>> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return new Set(parseInline(doc.getText()).threads.map((t) => t.id));
  } catch {
    return new Set();
  }
}

/**
 * Start tracking a freshly dispatched review request. `payload` should be the
 * pre-conventions, pre-mcp-directive payload the caller originally built — the
 * one "Resend" re-dispatches through `dispatchReviewPayload` from scratch,
 * which re-applies both, so storing the already-decorated prompt would double
 * them up on a resend.
 */
export async function startReviewPassWatch(
  folder: vscode.WorkspaceFolder,
  payload: ReviewPassPayload,
  intent: ReviewPassIntent,
  log: Logger,
): Promise<void> {
  const rels = payload.files ?? [payload.file];
  const uris = rels.map((rel) => vscode.Uri.joinPath(folder.uri, rel));
  const knownThreadIds = new Map<string, Set<string>>();
  for (const uri of uris) {
    knownThreadIds.set(uri.toString(), await snapshotThreadIds(uri));
  }

  const folderKey = folder.uri.toString();
  const record = reviewPassPending.dispatch({
    folderKey,
    files: uris.map((u) => u.toString()),
    knownThreadIds,
    payload,
    intent,
  });
  log.trace("review pass tracking started", { folder: folder.name, files: rels });

  const fileSet = new Set(record.files);
  const disposables: vscode.Disposable[] = [];

  const check = async (uri: vscode.Uri, text?: string): Promise<void> => {
    const docKey = uri.toString();
    if (!fileSet.has(docKey)) return;
    try {
      const source = text ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const parsed = parseInline(source);
      // The checkpoint is how a terminal Claude using the `mdc` CLI (which
      // never calls `mc_check`) still completes a file: `mdc check` stamps
      // one on a healthy document, same as `mc_check` does.
      reviewPassPending.noteDocument(docKey, parsed.threads, parsed.checkpoint);
    } catch (e) {
      // A transient read failure (mid-write) isn't worth surfacing — the next
      // change event or watcher tick sees the settled file.
      log.trace("review pass watch: read failed", { file: uri.fsPath, error: (e as Error).message });
    }
  };

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      void check(e.document.uri, e.document.getText());
    }),
  );
  for (const rel of rels) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, rel));
    watcher.onDidChange((uri) => void check(uri));
    watcher.onDidCreate((uri) => void check(uri));
    disposables.push(watcher);
  }

  // Tear down the moment this pass stops being LIVE for its folder — resolved
  // (arrived/stale), dismissed, or superseded by a new dispatch. "waiting" AND
  // "receiving" both still need these watchers: a pass that moved to
  // "receiving" on its first thread is exactly as unfinished as one that
  // hasn't received anything yet, and its remaining files' `mc_check`s or
  // checkpoints still have to be seen.
  const sub = onReviewPassChanged((changedFolderKey) => {
    if (changedFolderKey !== folderKey) return;
    const current = reviewPassPending.get(folderKey);
    if (current?.id === record.id && (current.state === "waiting" || current.state === "receiving")) return;
    for (const d of disposables) d.dispose();
    sub.dispose();
  });
}
