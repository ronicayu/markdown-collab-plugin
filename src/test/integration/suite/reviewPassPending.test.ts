// The review-pass pulse against a real Extension Host (10x-plan-4 P2.2).
//
// The unit suite (`reviewPassPending.test.ts`) exercises the pure tracker in
// isolation. What only the host can show is the whole path a dispatch takes:
// "Ask Claude to Review" in clipboard mode (no terminal needed) creating a
// tracked pass; a thread landing moving it to `receiving` (not straight to
// `arrived` — the skill opens threads one at a time, and this is exactly the
// case the intermediate state exists for); and the pass then completing two
// different ways — an editor edit and a plain disk write with no document
// open at all (the terminal `mdc` CLI's path) — each stamping the same
// review checkpoint `mdc check` now writes (the integrating session's second
// change), which is what the tracker reads to call the file done.
//
// `markdownCollab.reviewPassStatus` is how the suite reads the tracker's
// state: it's compiled and loaded as part of the extension's own bundle, and
// this suite is a separate module graph (`out/test/integration`), so there is
// no direct import that would see the same singleton — the same reason
// `markdownCollab.headlessStatus` exists for the headless suite.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { addThread } from "../../../inlineComments/format";
import { opCheckpoint } from "../../../inlineComments/docOps";

interface ReviewPassSnapshot {
  id: string;
  folderKey: string;
  files: string[];
  dispatchedAt: number;
  lastSignal: number;
  evidence: "inferred" | "protocol";
  phase?: string;
  agent?: string;
  state: "waiting" | "receiving" | "arrived" | "stale";
  newThreadCounts: Record<string, number>;
  outstanding: string[];
}

function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "fixtures", name);
}

async function reviewPassStatus(uri: vscode.Uri): Promise<ReviewPassSnapshot | null> {
  return (await vscode.commands.executeCommand(
    "markdownCollab.reviewPassStatus",
    uri,
  )) as ReviewPassSnapshot | null;
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  message: string,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Dispatch "Ask Claude to Review" in clipboard mode and wait for the send to actually go out, so a subsequent `reviewPassStatus` poll isn't racing the dispatch itself. */
async function dispatchReviewAndWaitForClipboard(uri: vscode.Uri, marker: string): Promise<void> {
  await vscode.env.clipboard.writeText(marker);
  await vscode.commands.executeCommand("markdownCollab.askClaudeToReview", uri, undefined, { focus: "" });
  await waitFor(
    async () => (await vscode.env.clipboard.readText()) !== marker,
    "clipboard was never updated by askClaudeToReview",
  );
}

(process.platform === "win32" ? suite.skip : suite)("review pass pending: a pulse for a review request", () => {
  let previousMode: unknown;
  const created: string[] = [];

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("markdown-collab.markdown-collab-plugin");
    assert.ok(ext, "extension not loaded");
    if (!ext.isActive) await ext.activate();
    const config = vscode.workspace.getConfiguration("markdownCollab");
    previousMode = config.get<string>("sendMode", "ask");
    // Clipboard avoids needing a real terminal in the test host — the pulse
    // is the same for both non-headless modes (10x-plan-4 P2.2's design).
    await config.update("sendMode", "clipboard", vscode.ConfigurationTarget.Workspace);
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration("markdownCollab");
    await config.update("sendMode", previousMode, vscode.ConfigurationTarget.Workspace);
    for (const p of created) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* already gone */
      }
    }
  });

  test("dispatch tracks a waiting, inferred pass", async () => {
    const p = fixturePath("review-pass-waiting.md");
    created.push(p);
    fs.writeFileSync(p, "# Waiting doc\n\nProse to review.\n", "utf-8");
    const uri = vscode.Uri.file(p);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    await dispatchReviewAndWaitForClipboard(uri, "cleared-waiting");

    const waiting = await waitFor(() => reviewPassStatus(uri), "no review pass was tracked after dispatch");
    assert.strictEqual(waiting.state, "waiting");
    assert.strictEqual(waiting.evidence, "inferred");
    assert.deepStrictEqual(waiting.files, [uri.toString()]);
  });

  test("an agent-authored thread written through the editor moves the pass to receiving, and a checkpoint completes it", async () => {
    const p = fixturePath("review-pass-open.md");
    created.push(p);
    fs.writeFileSync(p, "# Open doc\n\nSome prose to review here.\n", "utf-8");
    const uri = vscode.Uri.file(p);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    await dispatchReviewAndWaitForClipboard(uri, "cleared-open");
    await waitFor(() => reviewPassStatus(uri), "no review pass was tracked after dispatch");

    const source = doc.getText();
    const anchor = "Some prose to review here.";
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, "anchor text not found in fixture");
    const { source: withThread } = addThread(source, start, start + anchor.length, {
      author: "claude",
      body: "Consider rewording this.",
      ts: "2026-05-02T00:00:00.000Z",
      agent: true,
    });
    const threadEdit = new vscode.WorkspaceEdit();
    threadEdit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(source.length)), withThread);
    assert.ok(await vscode.workspace.applyEdit(threadEdit), "the editor rejected the thread edit");

    // One thread landed, but nothing has said the FILE is done — the skill
    // opens threads one at a time, so this must not read as "arrived" yet.
    const receiving = await waitFor(async () => {
      const status = await reviewPassStatus(uri);
      return status?.state === "receiving" ? status : null;
    }, "the pass never moved to receiving after a thread landed");
    assert.strictEqual(receiving.newThreadCounts[uri.toString()], 1);

    // The checkpoint a healthy `mdc check` (or `mc_check`) stamps — same
    // mechanism, applied here as an editor edit — is what says this file in
    // particular is done.
    const { next: checkpointed } = opCheckpoint(doc.getText());
    const checkpointEdit = new vscode.WorkspaceEdit();
    checkpointEdit.replace(
      uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      checkpointed,
    );
    assert.ok(await vscode.workspace.applyEdit(checkpointEdit), "the editor rejected the checkpoint edit");

    const arrived = await waitFor(async () => {
      const status = await reviewPassStatus(uri);
      return status?.state === "arrived" ? status : null;
    }, "review pass never resolved after its checkpoint landed through the editor");
    assert.strictEqual(arrived.newThreadCounts[uri.toString()], 1);
  });

  test("the same thing straight to disk (no document open): receiving, then arrived via a checkpoint", async () => {
    const p = fixturePath("review-pass-disk.md");
    created.push(p);
    const initial = "# Disk-write doc\n\nOther prose to review here.\n";
    fs.writeFileSync(p, initial, "utf-8");
    const uri = vscode.Uri.file(p);

    // Nothing from an earlier test should leave this file's neighbor open —
    // this is the "no panel, no open document" case the FileSystemWatcher
    // path exists for.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    await dispatchReviewAndWaitForClipboard(uri, "cleared-disk");
    await waitFor(() => reviewPassStatus(uri), "no review pass was tracked after dispatch");

    const anchor = "Other prose to review here.";
    const start = initial.indexOf(anchor);
    assert.ok(start >= 0, "anchor text not found in fixture");
    const { source: withThread } = addThread(initial, start, start + anchor.length, {
      author: "claude",
      body: "A thread from a disk write.",
      ts: "2026-05-02T00:00:00.000Z",
      agent: true,
    });
    // A plain fs write — no vscode API, no open document.
    fs.writeFileSync(p, withThread, "utf-8");

    const receiving = await waitFor(async () => {
      const status = await reviewPassStatus(uri);
      return status?.state === "receiving" ? status : null;
    }, "the pass never moved to receiving after a disk-only thread write");
    assert.strictEqual(receiving.newThreadCounts[uri.toString()], 1);

    // The `mdc` CLI's path: a healthy `mdc check` stamps this same checkpoint
    // straight to disk, no editor involved at all.
    const { next: checkpointed } = opCheckpoint(withThread);
    fs.writeFileSync(p, checkpointed, "utf-8");

    const arrived = await waitFor(async () => {
      const status = await reviewPassStatus(uri);
      return status?.state === "arrived" ? status : null;
    }, "review pass never resolved after its checkpoint landed via a disk write", 20000);
    assert.strictEqual(arrived.newThreadCounts[uri.toString()], 1);
  });
});
