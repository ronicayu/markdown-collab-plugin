// Regression guard for the in-collab-editor comment actions. The collab
// editor stores comments as inline `<!--mc:...-->` markers in the .md
// itself (not a sidecar), so these drive the inline bridge — the exact
// functions CollabEditorProvider's reply / resolve / delete / add message
// handlers call into — and assert they round-trip through the markdown.
//
// The bridge is pure (no vscode), so these run as plain assertions.

import * as assert from "assert";
import {
  addThreadFromAnchor,
  commentsOf,
  deleteThread,
  replyToThread,
  setThreadResolved,
} from "../../../collab/inlineBridge";
import { parse } from "../../../inlineComments/format";

const BODY = "# Handlers fixture\n\nThis paragraph contains the anchor target string for the handler tests.\n";
const ANCHOR = {
  text: "the anchor target string for the handler tests",
  contextBefore: "",
  contextAfter: "",
};

/** Seed a document with one thread and return [source, threadId]. */
function seed(): [string, string] {
  const res = addThreadFromAnchor(BODY, ANCHOR, {
    author: "user",
    body: "initial comment",
    ts: "2026-05-03T00:00:00.000Z",
  });
  assert.ok(res.ok, "seed addThreadFromAnchor should succeed");
  const id = parse(res.source).threads[0]!.id;
  return [res.source, id];
}

suite("Collab editor inline comment bridge", () => {
  // -------------------------------------------------------------------
  // add
  // -------------------------------------------------------------------
  test("add: wraps the anchor in markers and records the thread", () => {
    const [source, id] = seed();
    assert.ok(source.includes(`<!--mc:a:${id}-->`), "opening marker present");
    assert.ok(source.includes(`<!--mc:/a:${id}-->`), "closing marker present");
    const comments = commentsOf(source);
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0]!.body, "initial comment");
    assert.strictEqual(comments[0]!.author, "user");
    assert.strictEqual(comments[0]!.resolved, false);
  });

  test("add: ok=false when the anchor text isn't in the document", () => {
    const res = addThreadFromAnchor(BODY, { text: "text that is absent entirely", contextBefore: "", contextAfter: "" }, {
      author: "user",
      body: "x",
    });
    assert.strictEqual(res.ok, false);
  });

  // -------------------------------------------------------------------
  // delete (the regression guard for the user-reported bug)
  // -------------------------------------------------------------------
  test("delete: removes the thread and its markers", () => {
    const [source, id] = seed();
    const next = deleteThread(source, id);
    assert.ok(next !== null, "delete returns rewritten source");
    assert.strictEqual(commentsOf(next!).length, 0);
    assert.ok(!next!.includes(`<!--mc:a:${id}-->`), "opening marker removed");
    assert.ok(!next!.includes(`<!--mc:/a:${id}-->`), "closing marker removed");
  });

  test("delete: null on unknown id", () => {
    const [source] = seed();
    assert.strictEqual(deleteThread(source, "zzzzz"), null);
  });

  // -------------------------------------------------------------------
  // reply
  // -------------------------------------------------------------------
  test("reply: appends a reply preserving the author", () => {
    const [source, id] = seed();
    const next = replyToThread(source, id, { body: "from Alice", author: "Alice", ts: "2026-05-03T00:01:00.000Z" });
    assert.ok(next !== null);
    const comment = commentsOf(next!)[0]!;
    assert.strictEqual(comment.replies.length, 1);
    assert.strictEqual(comment.replies[0]!.author, "Alice");
    assert.strictEqual(comment.replies[0]!.body, "from Alice");
  });

  test("reply: null on unknown id", () => {
    const [source] = seed();
    assert.strictEqual(replyToThread(source, "zzzzz", { body: "x", author: "a" }), null);
  });

  // -------------------------------------------------------------------
  // toggle resolve
  // -------------------------------------------------------------------
  test("resolve: flips status both ways", () => {
    const [source, id] = seed();
    const resolved = setThreadResolved(source, id, true, "user", "2026-05-03T00:02:00.000Z");
    assert.ok(resolved !== null);
    assert.strictEqual(commentsOf(resolved!)[0]!.resolved, true);
    const reopened = setThreadResolved(resolved!, id, false, "user");
    assert.ok(reopened !== null);
    assert.strictEqual(commentsOf(reopened!)[0]!.resolved, false);
  });

  test("resolve: null on unknown id", () => {
    const [source] = seed();
    assert.strictEqual(setThreadResolved(source, "zzzzz", true, "user"), null);
  });
});
