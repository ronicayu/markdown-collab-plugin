// The regressions that actually happened, replayed in a real Extension Host
// (10x-plan P2.4, move 3).
//
// Each scenario below maps to a CHANGELOG entry from the anchoring and
// live-editor failure classes. Unit tests cover the same transforms on
// strings; these exist because the failures involved the *host* — a real
// TextDocument, a WorkspaceEdit, the undo stack, and a file changing on disk
// underneath an open editor — which is precisely the layer strings can't
// reach.

import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { addThread, parse } from "../../../inlineComments/format";
import { applyClientMutation } from "../../../inlineComments/mutations";
import { mapProseToSource } from "../../../inlineComments/proseMapping";

const CTX = { author: "tester", now: () => "2026-07-28T12:00:00.000Z" };

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

async function openFixture(name: string, body: string): Promise<vscode.TextDocument> {
  const p = fixturePath(name);
  await fs.writeFile(p, body, "utf-8");
  return vscode.workspace.openTextDocument(vscode.Uri.file(p));
}

/** Replace the whole document, the way the panel's applyMutation does. */
async function writeWholeDocument(doc: vscode.TextDocument, next: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    next,
  );
  assert.ok(await vscode.workspace.applyEdit(edit), "WorkspaceEdit did not apply");
  assert.ok(await doc.save(), "document did not save");
}

function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async (): Promise<void> => {
      try {
        if (await condition()) return resolve();
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`));
      }
      setTimeout(() => void tick(), 50);
    };
    void tick();
  });
}

suite("Historical regressions (real host)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("markdown-collab.markdown-collab-plugin");
    assert.ok(ext, "extension not loaded");
    if (!ext.isActive) await ext.activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  // -------------------------------------------------------------------
  // 1. Comment on a table cell whose value repeats (0.34.23–0.34.31 class).
  //    The anchor used to land on the first matching cell.
  // -------------------------------------------------------------------
  test("commenting on a duplicate table-cell value anchors the selected row", async () => {
    const name = "reg-table.md";
    const body = [
      "# Flags",
      "",
      "| Flag | Default |",
      "|---|---|",
      "| `--retry` | 3 |",
      "| `--timeout` | 3 |",
      "",
    ].join("\n");
    const doc = await openFixture(name, body);
    try {
      const { prose } = mapProseToSource(parse(doc.getText()));
      const selStart = prose.lastIndexOf("3"); // the timeout row
      const { source, warning } = applyClientMutation(
        parse(doc.getText()),
        { type: "add-comment", selStart, selEnd: selStart + 1, body: "seconds or attempts?" },
        CTX,
      );
      assert.strictEqual(warning, undefined, `unexpected warning: ${warning}`);
      await writeWholeDocument(doc, source);

      const onDisk = await fs.readFile(doc.uri.fsPath, "utf-8");
      const parsed = parse(onDisk);
      assert.strictEqual(parsed.threads.length, 1);
      assert.strictEqual(parsed.threads[0]!.quote, "3");
      assert.deepStrictEqual(parsed.unanchoredThreadIds, []);
      const markerLine = onDisk.split("\n").find((l) => l.includes("mc:a:"))!;
      assert.ok(markerLine.includes("--timeout"), `marker landed on the wrong row: ${markerLine}`);
      // The table still renders as a table: the row keeps its pipes.
      assert.strictEqual((markerLine.match(/\|/g) ?? []).length, 3);
    } finally {
      await rmIfExists(doc.uri.fsPath);
    }
  });

  // -------------------------------------------------------------------
  // 2. Editing inside an anchored span must keep the thread anchored —
  //    the markers surround the text, so typing between them is safe, but
  //    only if nothing re-serializes the document behind the edit.
  // -------------------------------------------------------------------
  test("editing inside an anchored span keeps the thread anchored", async () => {
    const name = "reg-inner-edit.md";
    const body = "# Guide\n\nThe retry uses exponential backoff.\n";
    const { source } = addThread(body, body.indexOf("exponential"), body.indexOf("backoff") + 7, {
      author: "tester",
      body: "which cap?",
      ts: CTX.now(),
    });
    const doc = await openFixture(name, source);
    try {
      const before = parse(doc.getText());
      const threadId = before.threads[0]!.id;
      const anchor = before.anchors.get(threadId)!;

      // Type inside the anchored span, between the markers.
      const edit = new vscode.WorkspaceEdit();
      const insertAt = doc.positionAt(anchor.closeStart);
      edit.insert(doc.uri, insertAt, " with jitter");
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(await doc.save());

      const after = parse(await fs.readFile(doc.uri.fsPath, "utf-8"));
      assert.strictEqual(after.threads.length, 1, "thread survived the inner edit");
      assert.deepStrictEqual(after.unanchoredThreadIds, [], "thread is still anchored");
      const range = after.anchors.get(threadId)!;
      assert.strictEqual(
        after.source.slice(range.openEnd, range.closeStart),
        "exponential backoff with jitter",
        "the anchored span grew with the edit",
      );
    } finally {
      await rmIfExists(doc.uri.fsPath);
    }
  });

  // -------------------------------------------------------------------
  // 3a. An edit that removes the anchored passage orphans the thread rather
  //     than losing it — the thread and its quote survive for the human to
  //     re-anchor.
  // -------------------------------------------------------------------
  test("deleting the anchored passage orphans the thread instead of losing it", async () => {
    const name = "reg-orphan.md";
    const body = "# Guide\n\nThe retry uses exponential backoff.\n";
    const { source } = addThread(body, body.indexOf("exponential"), body.indexOf("backoff") + 7, {
      author: "tester",
      body: "which cap?",
      ts: CTX.now(),
    });
    const doc = await openFixture(name, source);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    try {
      const before = parse(doc.getText());
      const threadId = before.threads[0]!.id;
      const anchor = before.anchors.get(threadId)!;

      // Delete the whole anchored span, markers and all — what a careless
      // rewrite of the sentence does.
      await editor.edit((b) =>
        b.delete(new vscode.Range(doc.positionAt(anchor.openStart), doc.positionAt(anchor.closeEnd))),
      );
      const orphaned = parse(doc.getText());
      assert.strictEqual(orphaned.threads.length, 1, "the thread itself survives");
      assert.strictEqual(orphaned.threads[0]!.quote, "exponential backoff", "the quote survives");
      assert.deepStrictEqual(
        orphaned.unanchoredThreadIds,
        [threadId],
        "deleting the passage orphans the thread",
      );
      assert.ok(!orphaned.source.includes("mc:a:"), "no half-marker left behind");
    } finally {
      await rmIfExists(doc.uri.fsPath);
    }
  });

  // -------------------------------------------------------------------
  // 3b. Marker damage with the prose intact — a raw edit that dropped a
  //     marker, the failure the skill warns about three times — is
  //     recoverable in one click, and the repair never touches prose.
  // -------------------------------------------------------------------
  test("repairInlineComments re-anchors a thread whose markers were stripped", async () => {
    const name = "reg-repair.md";
    const body = "# Guide\n\nThe retry uses exponential backoff.\n";
    const { source } = addThread(body, body.indexOf("exponential"), body.indexOf("backoff") + 7, {
      author: "tester",
      body: "which cap?",
      ts: CTX.now(),
    });
    // Strip the markers the way a hand-edit does, leaving the prose alone.
    const damaged = source.replace(/<!--mc:\/?a:[a-z0-9]+-->/g, "");
    const doc = await openFixture(name, damaged);
    try {
      const threadId = parse(damaged).threads[0]!.id;
      assert.deepStrictEqual(
        parse(damaged).unanchoredThreadIds,
        [threadId],
        "fixture should start damaged",
      );

      await vscode.commands.executeCommand("markdownCollab.repairInlineComments", doc.uri.fsPath);
      await waitFor(
        () => parse(doc.getText()).unanchoredThreadIds.length === 0,
        5000,
        "repair never re-anchored the thread",
      );

      const repaired = parse(doc.getText());
      assert.ok(repaired.anchors.has(threadId), "markers restored around the quote");
      const range = repaired.anchors.get(threadId)!;
      assert.strictEqual(
        repaired.source.slice(range.openEnd, range.closeStart),
        "exponential backoff",
      );
      // Prose-preserving by construction — the rendered text is unchanged.
      assert.strictEqual(
        mapProseToSource(repaired).prose.trimEnd(),
        mapProseToSource(parse(damaged)).prose.trimEnd(),
      );
    } finally {
      await rmIfExists(doc.uri.fsPath);
    }
  });

  // -------------------------------------------------------------------
  // 4. A file changed on disk while open — Claude replying to a thread —
  //    must reach the open document, not sit behind a stale buffer.
  // -------------------------------------------------------------------
  test("an external change to an open document is observable", async () => {
    const name = "reg-external-change.md";
    const body = "# Guide\n\nThe retry uses exponential backoff.\n";
    const { source } = addThread(body, body.indexOf("exponential"), body.indexOf("backoff") + 7, {
      author: "tester",
      body: "which cap?",
      ts: CTX.now(),
    });
    const doc = await openFixture(name, source);
    await vscode.window.showTextDocument(doc);
    try {
      const threadId = parse(doc.getText()).threads[0]!.id;
      // Claude replies via the mdc helper — a plain write to the file.
      const replied = applyClientMutation(
        parse(doc.getText()),
        { type: "reply", threadId, body: "60 seconds." },
        { author: "claude", now: CTX.now },
      ).source;
      await fs.writeFile(doc.uri.fsPath, replied, "utf-8");

      await waitFor(
        () => parse(doc.getText()).threads[0]!.comments.length === 2,
        10000,
        "the open document never picked up the on-disk reply",
      );
      const t = parse(doc.getText()).threads[0]!;
      assert.strictEqual(t.comments[1]!.author, "claude");
      assert.strictEqual(t.comments[1]!.body, "60 seconds.");
      assert.deepStrictEqual(parse(doc.getText()).unanchoredThreadIds, []);
    } finally {
      await rmIfExists(doc.uri.fsPath);
    }
  });

  // -------------------------------------------------------------------
  // 5. Send-mode dispatch: the suggest-mode toggle has to reach the prompt
  //    the transport actually sends, across the setting → command → payload
  //    chain that unit tests only cover one link of at a time.
  // -------------------------------------------------------------------
  test("suggest mode reaches the dispatched prompt", async () => {
    const name = "reg-suggest-dispatch.md";
    const body = "# Guide\n\nThe retry uses exponential backoff.\n";
    const { source } = addThread(body, body.indexOf("exponential"), body.indexOf("backoff") + 7, {
      author: "tester",
      body: "which cap?",
      ts: CTX.now(),
    });
    const doc = await openFixture(name, source);
    const config = vscode.workspace.getConfiguration("markdownCollab");
    const prevMode = config.get<string>("sendMode", "ask");
    const prevSuggest = config.get<boolean>("proposeEditsAsSuggestions", false);
    try {
      await config.update("sendMode", "clipboard", vscode.ConfigurationTarget.Workspace);
      await config.update("proposeEditsAsSuggestions", false, vscode.ConfigurationTarget.Workspace);
      await vscode.window.showTextDocument(doc);

      await vscode.env.clipboard.writeText("cleared-by-test");
      await vscode.commands.executeCommand("markdownCollab.sendAllToClaude", doc.uri);
      await waitFor(
        async () => (await vscode.env.clipboard.readText()) !== "cleared-by-test",
        5000,
        "clipboard never updated with the plain prompt",
      );
      const plain = await vscode.env.clipboard.readText();
      assert.ok(plain.includes(name), `prompt missing the file: ${plain}`);
      assert.ok(!/suggest mode/i.test(plain), `plain prompt should not request suggest mode: ${plain}`);

      // Flip the toggle through the command the UI uses.
      await vscode.commands.executeCommand("markdownCollab.toggleSuggestMode");
      await waitFor(
        () =>
          vscode.workspace
            .getConfiguration("markdownCollab")
            .get<boolean>("proposeEditsAsSuggestions", false) === true,
        5000,
        "toggleSuggestMode did not flip the setting",
      );

      await vscode.env.clipboard.writeText("cleared-by-test");
      await vscode.commands.executeCommand("markdownCollab.sendAllToClaude", doc.uri);
      await waitFor(
        async () => (await vscode.env.clipboard.readText()) !== "cleared-by-test",
        5000,
        "clipboard never updated with the suggest-mode prompt",
      );
      const suggesting = await vscode.env.clipboard.readText();
      assert.ok(/suggest mode/i.test(suggesting), `prompt missing the suggest directive: ${suggesting}`);
      assert.ok(suggesting.includes("mdc suggest"), `prompt should name the helper: ${suggesting}`);
    } finally {
      await config.update("sendMode", prevMode, vscode.ConfigurationTarget.Workspace);
      await config.update(
        "proposeEditsAsSuggestions",
        prevSuggest,
        vscode.ConfigurationTarget.Workspace,
      );
      await rmIfExists(doc.uri.fsPath);
    }
  });
});
