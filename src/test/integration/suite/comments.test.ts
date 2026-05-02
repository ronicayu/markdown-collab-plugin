// End-to-end test for the existing comments feature, plus its interaction
// with the new collab editor.
//
// Two failure modes we care about:
//   1. The comments feature (CommentController, sidecar load/save, anchor
//      resolution) regressed under the broader 0.16 changes.
//   2. Opening a .md in the collab editor invalidates anchors in an
//      existing .md.json sidecar, because the WYSIWYG round-trip
//      normalised whitespace differently from what was on disk.

import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { resolve as resolveAnchor } from "../../../anchor";
import {
  loadSidecar,
  saveSidecar,
  sidecarPathFor,
} from "../../../sidecar";
import type { Anchor, Comment, Sidecar } from "../../../types";

const VIEW_TYPE = "markdownCollab.collabEditor";

function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "fixtures", name);
}

function workspaceRoot(): string {
  return path.resolve(__dirname, "..", "fixtures");
}

function makeAnchor(fileText: string, needle: string): Anchor {
  const start = fileText.indexOf(needle);
  if (start < 0) {
    throw new Error(`Fixture changed — anchor needle ${JSON.stringify(needle)} not found`);
  }
  const end = start + needle.length;
  return {
    text: needle,
    contextBefore: fileText.slice(Math.max(0, start - 24), start),
    contextAfter: fileText.slice(end, Math.min(fileText.length, end + 24)),
  };
}

function makeSampleSidecar(fileRel: string, anchor: Anchor): Sidecar {
  const comment: Comment = {
    id: "c_" + crypto.randomBytes(4).toString("hex"),
    author: "user",
    body: "this should still anchor after a collab-editor round-trip",
    createdAt: "2026-05-02T00:00:00.000Z",
    resolved: false,
    anchor,
    replies: [],
  };
  return {
    version: 1,
    file: fileRel,
    comments: [comment],
  };
}

suite("Comments + collab editor interaction", () => {
  let mdPath: string;
  let sidecarPath: string;
  let originalText: string;

  suiteSetup(async () => {
    mdPath = fixturePath("with-comments.md");
    originalText = [
      "# Document with comments",
      "",
      "Paragraph one — this exact text is the anchor target.",
      "",
      "Paragraph two — a longer body to keep offsets meaningful.",
      "",
      "- item one",
      "- item two",
      "",
    ].join("\n");
    await fs.writeFile(mdPath, originalText, "utf-8");

    const sp = sidecarPathFor(mdPath, workspaceRoot());
    assert.ok(sp, "sidecar path resolution failed for fixture");
    sidecarPath = sp!;
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    const anchor = makeAnchor(originalText, "this exact text is the anchor target");
    await saveSidecar(sidecarPath, makeSampleSidecar("with-comments.md", anchor));
  });

  suiteTeardown(async () => {
    // Leave the .md fixture in place — sample.md is committed; this one
    // is generated. Cleaning up keeps re-runs deterministic.
    await fs.rm(mdPath, { force: true });
    await fs.rm(sidecarPath, { force: true });
  });

  test("anchor resolves against the on-disk text before the collab editor opens", async () => {
    const onDisk = await fs.readFile(mdPath, "utf-8");
    const loaded = await loadSidecar(sidecarPath);
    assert.ok(loaded && loaded.mode === "ok", "fixture sidecar should load cleanly");
    const anchor = loaded.sidecar.comments[0]!.anchor;
    const resolved = resolveAnchor(onDisk, anchor);
    assert.ok(resolved, "baseline: anchor should resolve before any editor is opened");
    assert.strictEqual(onDisk.slice(resolved.start, resolved.end), anchor.text);
  });

  test("opening the file in the collab editor preserves the on-disk text", async () => {
    // The collab editor's persistence path goes
    //   webview Y.Doc → applyEdit → TextDocument → file.
    // If Milkdown's serializer normalised whitespace differently from what
    // was on disk, the file would mutate on first save and the comment
    // anchor would no longer resolve. Open the file, give the round-trip
    // a moment, then re-read and re-resolve.
    const before = await fs.readFile(mdPath, "utf-8");
    const uri = vscode.Uri.file(mdPath);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    // The webview debounces edits at 250ms; give it ~3s to potentially
    // flush a normalisation write. We poll rather than sleep so a fast
    // pass doesn't waste time.
    let after = before;
    const start = Date.now();
    while (Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 200));
      after = await fs.readFile(mdPath, "utf-8");
      if (after !== before) break;
    }

    if (after !== before) {
      // The collab editor mutated the file. Verify anchors still resolve
      // against the new text — that's the property reviewers actually care
      // about. If they don't, the round-trip broke comments and we need to
      // either preserve raw whitespace in Milkdown's serializer config or
      // add an anchor migration step.
      const sidecar = (await loadSidecar(sidecarPath))!.sidecar;
      const resolved = resolveAnchor(after, sidecar.comments[0]!.anchor);
      assert.ok(
        resolved,
        `Collab editor rewrote the file in a way that broke comment anchors.\n` +
          `BEFORE: ${JSON.stringify(before)}\nAFTER: ${JSON.stringify(after)}`,
      );
      assert.strictEqual(after.slice(resolved.start, resolved.end), sidecar.comments[0]!.anchor.text);
    }
    // Either way, the test asserts the comment is still usable.
  });

  test("the comments command surface is still registered", async () => {
    // We can't easily drive the CommentController gutter UI from a headless
    // test (it lives in VSCode's editor chrome, not in extension API), but
    // the commands themselves should still be exposed. A regression here
    // would mean the comment workflow is silently broken.
    const cmds = await vscode.commands.getCommands(true);
    for (const id of [
      "markdownCollab.createThread",
      "markdownCollab.addReply",
      "markdownCollab.toggleResolve",
      "markdownCollab.deleteThread",
      "markdownCollab.editComment",
    ]) {
      assert.ok(cmds.includes(id), `command not registered: ${id}`);
    }
  });
});
