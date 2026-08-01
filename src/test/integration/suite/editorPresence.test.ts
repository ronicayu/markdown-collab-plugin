// The raw-editor providers, driven through VS Code's own provider commands
// (10x-plan-3 P0.1 / P0.3).
//
// `setDecorations` is write-only, so decorations themselves can't be read back
// — the pure range model is unit-tested instead, and what is asserted here is
// everything a user can actually invoke: the fold, the hover, and the lens.
// These only exist inside a real extension host, which is why they're here.

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import * as fsp from "fs/promises";
import * as os from "os";

const REVIEWED = `# Guide

The retry policy uses <!--mc:a:aaa11-->exponential backoff<!--mc:/a:aaa11--> with jitter.

Tokenizers live in the appendix.

<!--mc:threads:begin-->
<!--mc:t {"id":"aaa11","quote":"exponential backoff","status":"open","comments":[{"id":"c1","author":"claude","ts":"2026-01-15T10:00:00.000Z","body":"Full or equal jitter?"}]} -->
<!--mc:threads:end-->
`;

const CLEAN = `# Guide

Nothing to review here.
`;

/** Write a scratch .md and open it. Unique per call — see collab.test.ts. */
let counter = 0;
async function openDoc(content: string): Promise<vscode.TextDocument> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mc-presence-"));
  const file = path.join(dir, `doc-${counter++}.md`);
  await fsp.writeFile(file, content, "utf8");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

suite("Editor presence providers", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("markdown-collab.markdown-collab-plugin");
    await ext?.activate();
  });

  test("folds the threads region, and nothing in a clean file", async () => {
    const doc = await openDoc(REVIEWED);
    const folds = (await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      "vscode.executeFoldingRangeProvider",
      doc.uri,
    )) ?? [];
    const ours = folds.filter((f) => doc.lineAt(f.start).text.includes("mc:threads:begin"));
    assert.strictEqual(ours.length, 1, "expected exactly one fold over the threads region");
    assert.ok(
      doc.lineAt(ours[0].end).text.includes("mc:threads:end"),
      "the fold should end on the closing fence",
    );

    const clean = await openDoc(CLEAN);
    const cleanFolds = (await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      "vscode.executeFoldingRangeProvider",
      clean.uri,
    )) ?? [];
    assert.ok(
      !cleanFolds.some((f) => clean.lineAt(f.start).text.includes("mc:")),
      "a file with no review state should get no threads fold",
    );
  });

  test("hovering an anchored span shows the thread", async () => {
    const doc = await openDoc(REVIEWED);
    const at = doc.positionAt(REVIEWED.indexOf("exponential backoff") + 3);
    const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      doc.uri,
      at,
    )) ?? [];
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value))
      .join("\n");
    assert.ok(text.includes("Full or equal jitter?"), `hover missing the comment body: ${text}`);
    assert.ok(text.includes("claude"), "hover should name the author");
  });

  test("hovering ordinary prose shows nothing of ours", async () => {
    const doc = await openDoc(REVIEWED);
    const at = doc.positionAt(REVIEWED.indexOf("Tokenizers") + 2);
    const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      doc.uri,
      at,
    )) ?? [];
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value))
      .join("\n");
    assert.ok(!text.includes("Markdown Collab"), `unexpected hover on plain prose: ${text}`);
  });

  test("a reviewed file gets one lens into the review view", async () => {
    const doc = await openDoc(REVIEWED);
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      doc.uri,
    )) ?? [];
    const ours = lenses.filter((l) => l.command?.command === "markdownCollab.openInlineCommentsView");
    assert.strictEqual(ours.length, 1, "expected exactly one Markdown Collab lens");
    assert.ok(ours[0].command?.title.includes("comment"), ours[0].command?.title);
    assert.strictEqual(ours[0].range.start.line, 0, "the lens belongs at the top of the file");
  });

  test("a clean file gets no lens — unreviewed docs stay uncluttered", async () => {
    const doc = await openDoc(CLEAN);
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      doc.uri,
    )) ?? [];
    assert.ok(
      !lenses.some((l) => l.command?.command?.startsWith("markdownCollab.")),
      "no review state means no chrome",
    );
  });

  test("the presence pass never modifies the document", async () => {
    // Decorations, folds, and hovers are all reads. If any of them ever wrote,
    // the extension would be editing files as a side effect of scrolling.
    const doc = await openDoc(REVIEWED);
    await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", doc.uri);
    await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      doc.uri,
      doc.positionAt(REVIEWED.indexOf("exponential") + 2),
    );
    await vscode.commands.executeCommand("vscode.executeCodeLensProvider", doc.uri);
    assert.strictEqual(doc.getText(), REVIEWED, "document text changed");
    assert.strictEqual(doc.isDirty, false, "document became dirty");
  });
});
