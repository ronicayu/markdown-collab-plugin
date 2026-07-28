// Contract tests for the inline-comments host↔webview protocol (10x-plan P2.4).
//
// Each test is a recorded message applied to a document, asserting the
// document that comes back. This is the layer the CHANGELOG's regression
// history maps onto — commenting on a table cell, editing inside an anchored
// span, deleting a comment with replies — and until now it could only be
// exercised through a running Extension Host.

import { describe, expect, it } from "vitest";
import { addThread, addSuggestion, parse } from "../inlineComments/format";
import { applyClientMutation, type MutationMessage } from "../inlineComments/mutations";
import { mapProseToSource } from "../inlineComments/proseMapping";

const CTX = { author: "ronica", now: () => "2026-07-28T12:00:00.000Z" };

/** Apply a message to a document, the way the panel does. */
function apply(source: string, msg: MutationMessage, ctx = CTX) {
  return applyClientMutation(parse(source), msg, ctx);
}

/**
 * What the preview renders: the source with markers, the threads region, and
 * frontmatter stripped. Trailing whitespace varies with whether a threads
 * region is present (stripping it leaves the newline that preceded it), so
 * comparisons here are trailing-whitespace-insensitive.
 */
function proseOf(source: string): string {
  return mapProseToSource(parse(source)).prose.trimEnd();
}

/** The prose offsets of `needle` — what the webview would report for a selection. */
function proseSelection(source: string, needle: string) {
  const { prose } = mapProseToSource(parse(source));
  const selStart = prose.indexOf(needle);
  if (selStart === -1) throw new Error(`"${needle}" not found in prose`);
  return { selStart, selEnd: selStart + needle.length };
}

/** Comment on `needle`, addressing it the way the webview does (prose offsets). */
function commentOn(source: string, needle: string, body: string) {
  return apply(source, { type: "add-comment", ...proseSelection(source, needle), body });
}

const DOC = ["# Guide", "", "The retry uses exponential backoff with a cap.", ""].join("\n");

describe("add-comment", () => {
  it("anchors the selected passage and opens a thread", () => {
    const { source, warning } = commentOn(DOC, "exponential backoff", "which cap?");
    expect(warning).toBeUndefined();
    const parsed = parse(source);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].quote).toBe("exponential backoff");
    expect(parsed.threads[0].comments[0]).toMatchObject({
      author: "ronica",
      body: "which cap?",
    });
    expect(parsed.unanchoredThreadIds).toEqual([]);
  });

  it("leaves the prose intact once markers are stripped", () => {
    const { source } = commentOn(DOC, "exponential backoff", "?");
    expect(proseOf(source)).toBe(DOC.trimEnd());
  });

  it("maps prose offsets through an existing anchor (the regression class)", () => {
    // Comment on a later passage in a doc that already has markers earlier —
    // if the offsets weren't mapped back to source space, the second anchor
    // would land short by the length of the first pair of markers.
    const first = commentOn(DOC, "The retry", "scope?").source;
    const second = commentOn(first, "with a cap", "what cap?").source;
    const parsed = parse(second);
    expect(parsed.threads.map((t) => t.quote)).toEqual(["The retry", "with a cap"]);
    expect(parsed.unanchoredThreadIds).toEqual([]);
    expect(proseOf(parsed.source)).toBe(DOC.trimEnd());
  });

  it("maps prose offsets past frontmatter", () => {
    // The preview hides frontmatter, so prose offsets start below it — an
    // anchor computed without that shift lands inside the YAML.
    const doc = "---\ntitle: Guide\n---\n\nThe retry uses backoff.\n";
    const { source } = commentOn(doc, "backoff", "which one?");
    const parsed = parse(source);
    expect(parsed.threads[0].quote).toBe("backoff");
    expect(source).toContain("---\ntitle: Guide\n---");
    expect(source).toMatch(/uses <!--mc:a:[a-z0-9]+-->backoff<!--mc:\/a:[a-z0-9]+-->\./);
    // Frontmatter is stripped from the preview; its trailing blank line isn't.
    expect(proseOf(source).trim()).toBe("The retry uses backoff.");
  });

  it("anchors a table cell whose text repeats elsewhere", () => {
    const doc = [
      "| Flag | Default |",
      "|---|---|",
      "| `--retry` | 3 |",
      "| `--timeout` | 3 |",
      "",
    ].join("\n");
    // The second "3" — a duplicate-value cell, historically mis-anchored.
    const { prose } = mapProseToSource(parse(doc));
    const selStart = prose.lastIndexOf("3");
    const { source, warning } = apply(doc, {
      type: "add-comment",
      selStart,
      selEnd: selStart + 1,
      body: "seconds or attempts?",
    });
    expect(warning).toBeUndefined();
    const parsed = parse(source);
    expect(parsed.threads[0].quote).toBe("3");
    // The marker landed on the timeout row, not the retry row.
    const line = source.split("\n").find((l) => l.includes("mc:a:"))!;
    expect(line).toContain("--timeout");
  });

  it("refuses to anchor inside a code fence instead of writing a broken thread", () => {
    const doc = ["Intro.", "", "```js", "const backoff = 1;", "```", ""].join("\n");
    const { prose } = mapProseToSource(parse(doc));
    const selStart = prose.indexOf("const backoff");
    const { source, warning } = apply(doc, {
      type: "add-comment",
      selStart,
      selEnd: selStart + "const backoff".length,
      body: "rename?",
    });
    expect(warning).toMatch(/code/i);
    expect(source).toBe(doc);
  });

  it("warns rather than anchoring an empty selection", () => {
    const { source, warning } = apply(DOC, {
      type: "add-comment",
      selStart: 3,
      selEnd: 3,
      body: "?",
    });
    expect(warning).toMatch(/select some text/i);
    expect(source).toBe(DOC);
  });

  it("warns when the selection can't be mapped back to the source", () => {
    const { source, warning } = apply(DOC, {
      type: "add-comment",
      selStart: 0,
      selEnd: 99_999,
      body: "?",
    });
    expect(warning).toMatch(/map selection/i);
    expect(source).toBe(DOC);
  });
});

describe("reply", () => {
  const withThread = commentOn(DOC, "exponential backoff", "which cap?").source;
  const threadId = parse(withThread).threads[0].id;

  it("appends a comment authored by the current user", () => {
    const { source } = apply(withThread, { type: "reply", threadId, body: "60s." });
    const t = parse(source).threads[0];
    expect(t.comments).toHaveLength(2);
    expect(t.comments[1]).toMatchObject({ author: "ronica", body: "60s." });
  });

  it("records the parent for a threaded reply", () => {
    const { source } = apply(withThread, {
      type: "reply",
      threadId,
      body: "60s.",
      parentCommentId: "c1",
    });
    expect(parse(source).threads[0].comments[1].parent).toBe("c1");
  });

  it("is a no-op for a thread that no longer exists", () => {
    const { source } = apply(withThread, { type: "reply", threadId: "gone1", body: "hi" });
    expect(source).toBe(withThread);
  });

  it("leaves the anchor and the prose untouched", () => {
    const { source } = apply(withThread, { type: "reply", threadId, body: "60s." });
    expect(proseOf(source)).toBe(DOC.trimEnd());
    expect(parse(source).unanchoredThreadIds).toEqual([]);
  });
});

describe("edit-comment", () => {
  const withThread = commentOn(DOC, "exponential backoff", "which cap?").source;
  const threadId = parse(withThread).threads[0].id;

  it("replaces the body and stamps editedTs", () => {
    const { source } = apply(withThread, {
      type: "edit-comment",
      threadId,
      commentId: "c1",
      body: "what is the cap?",
    });
    const c = parse(source).threads[0].comments[0];
    expect(c.body).toBe("what is the cap?");
    expect(c.editedTs).toBe("2026-07-28T12:00:00.000Z");
  });

  it("ignores an unknown comment id without disturbing the thread", () => {
    const { source } = apply(withThread, {
      type: "edit-comment",
      threadId,
      commentId: "c9",
      body: "nope",
    });
    expect(parse(source).threads[0].comments[0].body).toBe("which cap?");
  });

  it("is a no-op for an unknown thread", () => {
    const { source } = apply(withThread, {
      type: "edit-comment",
      threadId: "gone1",
      commentId: "c1",
      body: "x",
    });
    expect(source).toBe(withThread);
  });
});

describe("toggle-resolve", () => {
  const withThread = commentOn(DOC, "exponential backoff", "which cap?").source;
  const threadId = parse(withThread).threads[0].id;

  it("resolves an open thread, recording who and when", () => {
    const { source } = apply(withThread, { type: "toggle-resolve", threadId });
    const t = parse(source).threads[0];
    expect(t.status).toBe("resolved");
    expect(t.resolvedBy).toBe("ronica");
    expect(t.resolvedTs).toBe("2026-07-28T12:00:00.000Z");
  });

  it("reopens a resolved thread and clears the resolution stamp", () => {
    const resolved = apply(withThread, { type: "toggle-resolve", threadId }).source;
    const { source } = apply(resolved, { type: "toggle-resolve", threadId });
    const t = parse(source).threads[0];
    expect(t.status).toBe("open");
    expect(t.resolvedBy).toBeUndefined();
    expect(t.resolvedTs).toBeUndefined();
  });

  it("keeps the thread anchored across the round trip", () => {
    const resolved = apply(withThread, { type: "toggle-resolve", threadId }).source;
    const reopened = apply(resolved, { type: "toggle-resolve", threadId }).source;
    expect(parse(reopened).unanchoredThreadIds).toEqual([]);
    expect(proseOf(reopened)).toBe(DOC.trimEnd());
  });
});

describe("delete-thread", () => {
  it("removes the thread and its markers, restoring the prose", () => {
    const withThread = commentOn(DOC, "exponential backoff", "which cap?").source;
    const threadId = parse(withThread).threads[0].id;
    const { source } = apply(withThread, { type: "delete-thread", threadId });
    expect(parse(source).threads).toEqual([]);
    expect(source).not.toContain("mc:a:");
    // Deleting the only thread must not leave the document one blank line
    // longer than it started (a real regression, fixed in 0.34.41).
    expect(source).toBe(DOC);
  });

  it("is a no-op for an unknown id", () => {
    const withThread = commentOn(DOC, "exponential backoff", "?").source;
    const { source } = apply(withThread, { type: "delete-thread", threadId: "gone1" });
    expect(source).toBe(withThread);
  });
});

describe("delete-comment", () => {
  const withThread = commentOn(DOC, "exponential backoff", "which cap?").source;
  const threadId = parse(withThread).threads[0].id;
  const withReply = apply(withThread, { type: "reply", threadId, body: "60s." }).source;

  it("drops a leaf comment entirely", () => {
    const { source } = apply(withReply, { type: "delete-comment", threadId, commentId: "c2" });
    const t = parse(source).threads[0];
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0].id).toBe("c1");
  });

  it("tombstones a comment that has replies, keeping the tree shape", () => {
    const threaded = apply(withThread, {
      type: "reply",
      threadId,
      body: "60s.",
      parentCommentId: "c1",
    }).source;
    const { source } = apply(threaded, { type: "delete-comment", threadId, commentId: "c1" });
    const t = parse(source).threads[0];
    expect(t.comments).toHaveLength(2);
    expect(t.comments[0]).toMatchObject({ id: "c1", deleted: true, body: "" });
    expect(t.comments[1].parent).toBe("c1");
  });

  it("deletes the whole thread when the last live comment goes", () => {
    const { source } = apply(withThread, { type: "delete-comment", threadId, commentId: "c1" });
    expect(parse(source).threads).toEqual([]);
    expect(source).toBe(DOC);
  });

  it("is a no-op for an unknown thread", () => {
    const { source } = apply(withReply, {
      type: "delete-comment",
      threadId: "gone1",
      commentId: "c1",
    });
    expect(source).toBe(withReply);
  });
});

describe("accept-suggestion / reject-suggestion", () => {
  function docWithSuggestion() {
    const start = DOC.indexOf("exponential backoff");
    return addSuggestion(DOC, start, start + "exponential backoff".length, {
      author: "claude",
      proposed: "capped exponential backoff",
      note: "name the cap",
      ts: "2026-07-28T11:00:00.000Z",
    });
  }

  it("accept swaps the original for the proposed text", () => {
    const { source: withSuggestion, suggestion } = docWithSuggestion();
    const { source } = apply(withSuggestion, {
      type: "accept-suggestion",
      anchorId: suggestion.anchorId,
    });
    expect(source).toContain("capped exponential backoff");
    expect(parse(source).suggestions).toEqual([]);
    expect(source).not.toContain("mc:s ");
  });

  it("reject keeps the original text and drops the suggestion", () => {
    const { source: withSuggestion, suggestion } = docWithSuggestion();
    const { source } = apply(withSuggestion, {
      type: "reject-suggestion",
      anchorId: suggestion.anchorId,
    });
    expect(parse(source).suggestions).toEqual([]);
    expect(source).toContain("exponential backoff");
    expect(source).not.toContain("capped exponential");
    expect(source).toBe(DOC);
  });

  it("refuses to accept an unanchored suggestion — there is nowhere to put it", () => {
    const { source: withSuggestion, suggestion } = docWithSuggestion();
    // Strip the anchor markers, the way a careless raw edit would.
    const damaged = withSuggestion.replace(/<!--mc:\/?a:[a-z0-9]+-->/g, "");
    const { source } = apply(damaged, {
      type: "accept-suggestion",
      anchorId: suggestion.anchorId,
    });
    expect(source).toBe(damaged);
    expect(parse(source).suggestions).toHaveLength(1);
  });

  it("is a no-op for an unknown suggestion id", () => {
    const { source: withSuggestion } = docWithSuggestion();
    expect(apply(withSuggestion, { type: "accept-suggestion", anchorId: "nope1" }).source).toBe(
      withSuggestion,
    );
    expect(apply(withSuggestion, { type: "reject-suggestion", anchorId: "nope1" }).source).toBe(
      withSuggestion,
    );
  });
});

describe("sequences", () => {
  it("survives comment → reply → resolve → reopen → delete with no residue", () => {
    let source = commentOn(DOC, "exponential backoff", "which cap?").source;
    const threadId = parse(source).threads[0].id;
    source = apply(source, { type: "reply", threadId, body: "60s." }).source;
    source = apply(source, { type: "toggle-resolve", threadId }).source;
    source = apply(source, { type: "toggle-resolve", threadId }).source;
    source = apply(source, { type: "delete-thread", threadId }).source;
    expect(source).toBe(DOC);
  });

  it("keeps every thread anchored when several are added and one is removed", () => {
    let source = commentOn(DOC, "The retry", "scope?").source;
    source = commentOn(source, "exponential backoff", "cap?").source;
    source = commentOn(source, "Guide", "title?").source;
    const parsed = parse(source);
    expect(parsed.threads).toHaveLength(3);
    expect(parsed.unanchoredThreadIds).toEqual([]);

    const middle = parsed.threads.find((t) => t.quote === "exponential backoff")!;
    source = apply(source, { type: "delete-thread", threadId: middle.id }).source;
    const after = parse(source);
    expect(after.threads.map((t) => t.quote)).toEqual(["Guide", "The retry"]);
    expect(after.unanchoredThreadIds).toEqual([]);
    expect(proseOf(after.source)).toBe(DOC.trimEnd());
  });
});

describe("addThread offset contract", () => {
  it("prose offsets and source offsets agree on a clean document", () => {
    // Sanity check that the fixture helper matches what the format engine
    // does directly — if these diverge, every test above is testing itself.
    const start = DOC.indexOf("exponential backoff");
    const direct = addThread(DOC, start, start + "exponential backoff".length, {
      author: "ronica",
      body: "which cap?",
      ts: "2026-07-28T12:00:00.000Z",
    }).source;
    const viaMessage = commentOn(DOC, "exponential backoff", "which cap?").source;
    // Ids differ (randomly allocated); compare the prose and the anchored quote.
    expect(mapProseToSource(parse(viaMessage)).prose).toBe(
      mapProseToSource(parse(direct)).prose,
    );
    expect(parse(viaMessage).threads[0].quote).toBe(parse(direct).threads[0].quote);
  });
});
