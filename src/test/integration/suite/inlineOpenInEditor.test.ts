// Reverse navigation, host side (10x-plan-4 P2.4): "Open in editor" from an
// inline-comments thread card opens a real text editor with the anchored
// text selected, and an unanchored thread (its marker text has been edited
// away) shows an information toast instead of opening anything.
//
// Drives `openThreadInEditor` directly against a real `vscode.TextDocument`
// rather than through a live webview panel — the panel has no public seam for
// injecting a webview→host message from test code (that side of the click is
// covered by the webview e2e suite instead, which drives the real bundle in
// real Chromium and asserts the posted message).

import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { addThread, parse } from "../../../inlineComments/format";
import { openThreadInEditor } from "../../../inlineComments/inlineCommentsPanel";

function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "fixtures", name);
}

async function rmIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch {
    /* already gone */
  }
}

async function writeFixtureWithThread(
  name: string,
  body: string,
  anchorText: string,
): Promise<{ uri: vscode.Uri; threadId: string }> {
  const start = body.indexOf(anchorText);
  assert.ok(start >= 0, `anchor text ${JSON.stringify(anchorText)} not in fixture body`);
  const { source, thread } = addThread(body, start, start + anchorText.length, {
    author: "user",
    body: "test comment",
    ts: "2026-05-02T00:00:00.000Z",
  });
  const p = fixturePath(name);
  await fs.writeFile(p, source, "utf-8");
  return { uri: vscode.Uri.file(p), threadId: thread.id };
}

/**
 * Swap `vscode.window.showInformationMessage` for a stub that records calls,
 * restoring the original afterward. The Extension Test Host runs a real
 * Electron window, so a modal-free `showInformationMessage` wouldn't block —
 * but we still don't want an unasserted toast popping up mid-suite, and we
 * need to observe whether it fired.
 */
async function withInformationMessageStub<T>(
  run: (calls: string[]) => Promise<T>,
): Promise<T> {
  const calls: string[] = [];
  const original = vscode.window.showInformationMessage;
  const stubbed = (vscode.window as unknown) as { showInformationMessage: unknown };
  stubbed.showInformationMessage = (message: string): Promise<undefined> => {
    calls.push(message);
    return Promise.resolve(undefined);
  };
  try {
    return await run(calls);
  } finally {
    stubbed.showInformationMessage = original;
  }
}

suite("openThreadInEditor (10x-plan-4 P2.4 reverse navigation)", () => {
  test("opens the anchored text with it selected", async () => {
    const body = "# Notes\n\nThe quick brown fox jumps over the lazy dog.\n";
    const { uri, threadId } = await writeFixtureWithThread(
      "open-in-editor-anchored.md",
      body,
      "quick brown fox",
    );
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const anchor = parse(doc.getText()).anchors.get(threadId);
      assert.ok(anchor, "fixture thread should have an anchor");

      await withInformationMessageStub(async (calls) => {
        await openThreadInEditor(doc, threadId);
        assert.deepStrictEqual(calls, [], "anchored thread must not show the removed-text toast");
      });

      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, "expected an active text editor after opening");
      assert.strictEqual(editor!.document.uri.toString(), doc.uri.toString());

      const expectedRange = new vscode.Range(
        doc.positionAt(anchor!.openEnd),
        doc.positionAt(anchor!.closeStart),
      );
      assert.ok(
        editor!.selection.isEqual(expectedRange),
        `selection ${JSON.stringify(editor!.selection)} did not match the anchored range ${JSON.stringify(expectedRange)}`,
      );
      assert.strictEqual(doc.getText(editor!.selection), "quick brown fox");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rmIfExists(uri.fsPath);
    }
  });

  test("an unanchored thread shows an information toast instead of opening anything", async () => {
    const body = "# Notes\n\nThe quick brown fox jumps over the lazy dog.\n";
    const { uri, threadId } = await writeFixtureWithThread(
      "open-in-editor-unanchored.md",
      body,
      "quick brown fox",
    );
    try {
      // Rewrite the file so the thread's markers are gone — same shape as a
      // human deleting the sentence the comment was anchored to.
      const stripped = "# Notes\n\nNothing left to anchor to.\n";
      await fs.writeFile(uri.fsPath, stripped, "utf-8");
      const doc = await vscode.workspace.openTextDocument(uri);
      assert.strictEqual(parse(doc.getText()).anchors.get(threadId), undefined);

      await withInformationMessageStub(async (calls) => {
        await openThreadInEditor(doc, threadId);
        assert.deepStrictEqual(calls, [
          "This comment's text was removed, so there's nothing to jump to.",
        ]);
      });
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rmIfExists(uri.fsPath);
    }
  });
});
