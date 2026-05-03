// Direct tests for the message-handler statics on CollabEditorProvider.
// These exercise the full webview-side message handling path *without*
// driving the webview iframe — they call CollabEditorProvider.runReplyComment
// / runToggleResolve / runDeleteComment with the same sidecarPath the
// provider would. This is the regression guard for "delete a comment
// does not work": the previous failure was that the webview never POSTed
// the message (window.confirm was blocked), but if the handler itself
// regresses we want to catch that here too.

import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { CollabEditorProvider } from "../../../collab/collabEditorProvider";
import {
  addComment as addCommentToSidecar,
  loadSidecar,
  sidecarPathFor,
} from "../../../sidecar";

void vscode; // imported for its side effect (extension auto-activates)

function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "fixtures", name);
}
function workspaceRoot(): string {
  return path.resolve(__dirname, "..", "fixtures");
}

suite("CollabEditorProvider message handlers (direct)", () => {
  const fileRel = "handlers-target.md";
  let mdPath: string;
  let sidecarPath: string;

  suiteSetup(async () => {
    mdPath = fixturePath(fileRel);
    await fs.writeFile(
      mdPath,
      "# Handlers fixture\n\nThis paragraph contains the anchor target string for the handler tests.\n",
      "utf-8",
    );
    sidecarPath = sidecarPathFor(mdPath, workspaceRoot())!;
  });

  suiteTeardown(async () => {
    await fs.rm(mdPath, { force: true });
    await fs.rm(sidecarPath, { force: true });
  });

  // -------------------------------------------------------------------
  // delete (the regression guard for the user-reported bug)
  // -------------------------------------------------------------------
  test("delete: removes the comment and returns ok=true", async () => {
    const created = await addCommentToSidecar(sidecarPath, fileRel, {
      anchor: { text: "the anchor target string for the handler tests", contextBefore: "", contextAfter: "" },
      body: "to delete",
      author: "user",
      createdAt: "2026-05-03T00:00:00.000Z",
    });
    const result = await CollabEditorProvider.runDeleteComment(sidecarPath, created.id);
    assert.deepStrictEqual(
      { type: result.type, ok: result.ok, commentId: result.commentId },
      { type: "delete-comment-result", ok: true, commentId: created.id },
    );
    const loaded = await loadSidecar(sidecarPath);
    const stillThere = loaded?.sidecar.comments.find((c) => c.id === created.id);
    assert.strictEqual(stillThere, undefined);
  });

  test("delete: ok=false with explicit reason when commentId is unknown", async () => {
    // Make sure a sidecar exists (with at least one comment) so the
    // helper takes the "load + filter" path rather than the
    // "no sidecar" path.
    await addCommentToSidecar(sidecarPath, fileRel, {
      anchor: { text: "the anchor target string for the handler tests", contextBefore: "", contextAfter: "" },
      body: "still here",
      author: "user",
      createdAt: "2026-05-03T00:00:01.000Z",
    });
    const result = await CollabEditorProvider.runDeleteComment(sidecarPath, "c_doesnotex");
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? "", /not found/);
  });

  test("delete: ok=false when sidecarPath is null (file outside workspace)", async () => {
    const result = await CollabEditorProvider.runDeleteComment(null, "c_anything");
    assert.strictEqual(result.ok, false);
  });

  // -------------------------------------------------------------------
  // author propagation
  // -------------------------------------------------------------------
  test("reply: stores the author argument the webview sends, not a hardcoded 'user'", async () => {
    const created = await addCommentToSidecar(sidecarPath, fileRel, {
      anchor: { text: "the anchor target string for the handler tests", contextBefore: "", contextAfter: "" },
      body: "host for author test",
      author: "user",
      createdAt: "2026-05-03T00:00:30.000Z",
    });
    const result = await CollabEditorProvider.runReplyComment(
      sidecarPath,
      created.id,
      "from Alice",
      "Alice",
    );
    assert.strictEqual(result.ok, true);
    const loaded = (await loadSidecar(sidecarPath))!.sidecar;
    const c = loaded.comments.find((x) => x.id === created.id)!;
    const lastReply = c.replies[c.replies.length - 1]!;
    assert.strictEqual(lastReply.author, "Alice");
    assert.strictEqual(lastReply.body, "from Alice");
  });

  test("reply: falls back to a non-empty author when none is provided", async () => {
    const created = await addCommentToSidecar(sidecarPath, fileRel, {
      anchor: { text: "the anchor target string for the handler tests", contextBefore: "", contextAfter: "" },
      body: "host for author fallback",
      author: "user",
      createdAt: "2026-05-03T00:00:31.000Z",
    });
    const result = await CollabEditorProvider.runReplyComment(sidecarPath, created.id, "no-author");
    assert.strictEqual(result.ok, true);
    const loaded = (await loadSidecar(sidecarPath))!.sidecar;
    const c = loaded.comments.find((x) => x.id === created.id)!;
    const lastReply = c.replies[c.replies.length - 1]!;
    // Fallback resolves to OS username or "user" — never empty, never the
    // literal string "undefined".
    assert.ok(lastReply.author && lastReply.author.length > 0);
    assert.notStrictEqual(lastReply.author, "undefined");
  });

  // -------------------------------------------------------------------
  // reply (general)
  // -------------------------------------------------------------------
  test("reply: appends to the comment's replies", async () => {
    const created = await addCommentToSidecar(sidecarPath, fileRel, {
      anchor: { text: "the anchor target string for the handler tests", contextBefore: "", contextAfter: "" },
      body: "host",
      author: "user",
      createdAt: "2026-05-03T00:00:02.000Z",
    });
    const result = await CollabEditorProvider.runReplyComment(sidecarPath, created.id, "first reply body");
    assert.strictEqual(result.ok, true);
    const loaded = (await loadSidecar(sidecarPath))!.sidecar;
    const c = loaded.comments.find((x) => x.id === created.id)!;
    assert.strictEqual(c.replies.length, 1);
    assert.strictEqual(c.replies[0]!.body, "first reply body");
  });

  test("reply: rejects empty body without touching the sidecar", async () => {
    const created = await addCommentToSidecar(sidecarPath, fileRel, {
      anchor: { text: "the anchor target string for the handler tests", contextBefore: "", contextAfter: "" },
      body: "no-empty-reply",
      author: "user",
      createdAt: "2026-05-03T00:00:03.000Z",
    });
    const result = await CollabEditorProvider.runReplyComment(sidecarPath, created.id, "   ");
    assert.strictEqual(result.ok, false);
    const loaded = (await loadSidecar(sidecarPath))!.sidecar;
    const c = loaded.comments.find((x) => x.id === created.id)!;
    assert.strictEqual(c.replies.length, 0);
  });

  test("reply: ok=false on unknown commentId", async () => {
    const result = await CollabEditorProvider.runReplyComment(sidecarPath, "c_doesnotex", "body");
    assert.strictEqual(result.ok, false);
  });

  // -------------------------------------------------------------------
  // toggle resolve
  // -------------------------------------------------------------------
  test("toggle resolve: flips resolved twice, returning the new value each time", async () => {
    const created = await addCommentToSidecar(sidecarPath, fileRel, {
      anchor: { text: "the anchor target string for the handler tests", contextBefore: "", contextAfter: "" },
      body: "to-toggle",
      author: "user",
      createdAt: "2026-05-03T00:00:04.000Z",
    });
    const r1 = await CollabEditorProvider.runToggleResolve(sidecarPath, created.id);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.resolved, true);
    const r2 = await CollabEditorProvider.runToggleResolve(sidecarPath, created.id);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.resolved, false);
  });

  test("toggle resolve: ok=false when sidecar is missing", async () => {
    const tmp = fixturePath("nonexistent.md");
    const tmpSidecar = sidecarPathFor(tmp, workspaceRoot())!;
    await fs.rm(tmpSidecar, { force: true });
    const result = await CollabEditorProvider.runToggleResolve(tmpSidecar, "c_anything");
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? "", /not found/);
  });
});
