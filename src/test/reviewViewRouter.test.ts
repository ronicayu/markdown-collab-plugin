// The review view's router: where the live editor lands.

import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { addThread, appendReply, parse, replaceThread, stripAnchorMarkers } from "../inlineComments/format";
import {
  createReviewViewRouter,
  reviewViewOptsFrom,
  routeReviewView,
  type ReviewViewTargets,
} from "../commands/reviewViewRouter";

const BODY = "# Title\n\nFirst paragraph with a claim.\n\nSecond paragraph, where\nthe agent has a question.\n";

function withThread(source: string, text: string, author: string): { source: string; id: string } {
  const start = source.indexOf(text);
  if (start < 0) throw new Error(`${text} not in the source`);
  const { source: next, thread } = addThread(source, start, start + text.length, {
    author,
    body: `${author} says`,
    ts: "2026-09-29T00:00:00.000Z",
  });
  return { source: next, id: thread.id };
}

describe("routeReviewView", () => {
  it("opens the live editor", () => {
    expect(routeReviewView("", {})).toEqual({});
  });

  it("passes the diff overlay through", () => {
    expect(routeReviewView("", { diff: true })).toEqual({ diff: true });
  });

  it("lands on a thread by id", () => {
    const { source, id } = withThread(BODY, "the agent has a question", "ronica");
    expect(routeReviewView(source, { revealThreadId: id })).toEqual({ revealThreadId: id });
  });

  it("still names a thread with no anchor to the live editor", () => {
    const anchored = withThread(BODY, "a claim", "ronica");
    const source = stripAnchorMarkers(anchored.source, anchored.id);
    expect(parse(source).unanchoredThreadIds).toContain(anchored.id);
    expect(routeReviewView(source, { revealThreadId: anchored.id })).toEqual({ revealThreadId: anchored.id });
  });

  it("focusNewFromAgent lands on the first thread, in document order, an agent opened and no human answered", () => {
    // In document order: a human's thread, an agent thread a human answered,
    // then the first unread agent thread, then a second one.
    let doc = withThread(BODY, "Title", "ronica").source;
    const answered = withThread(doc, "First paragraph", "claude");
    const thread = parse(answered.source).threads.find((t) => t.id === answered.id)!;
    doc = replaceThread(
      answered.source,
      answered.id,
      appendReply(thread, { author: "ronica", body: "done", ts: "2026-09-29T00:01:00.000Z" }),
    );
    const firstUnread = withThread(doc, "Second paragraph", "claude");
    const secondUnread = withThread(firstUnread.source, "a question", "codex");
    const source = secondUnread.source;

    expect(routeReviewView(source, { focusNewFromAgent: true })).toEqual({ revealThreadId: firstUnread.id });
    // An explicit thread wins.
    expect(routeReviewView(source, { focusNewFromAgent: true, revealThreadId: secondUnread.id })).toEqual({
      revealThreadId: secondUnread.id,
    });
  });

  it("focusNewFromAgent with nothing unread just opens the view", () => {
    const { source } = withThread(BODY, "a claim", "ronica");
    expect(routeReviewView(source, { focusNewFromAgent: true })).toEqual({});
  });
});

describe("reviewViewOptsFrom", () => {
  it("reads the known fields with the right types", () => {
    expect(reviewViewOptsFrom({ revealThreadId: "k7q3p", diff: true, focusNewFromAgent: true })).toEqual({
      revealThreadId: "k7q3p",
      diff: true,
      focusNewFromAgent: true,
    });
  });

  it("ignores what menus pass as a command's second argument", () => {
    // editor/title passes the editor group; explorer/context passes the selection.
    expect(reviewViewOptsFrom({ groupId: 0 })).toEqual({});
    expect(reviewViewOptsFrom([{ fsPath: "/a.md" }])).toEqual({});
    expect(reviewViewOptsFrom(undefined)).toEqual({});
    expect(reviewViewOptsFrom("k7q3p")).toEqual({});
    expect(reviewViewOptsFrom({ revealThreadId: 3, diff: "yes", focusNewFromAgent: 1 })).toEqual({});
    expect(reviewViewOptsFrom({ revealThreadId: "" })).toEqual({});
  });
});

describe("createReviewViewRouter", () => {
  const uri = { fsPath: "/ws/doc.md", toString: () => "file:///ws/doc.md" } as unknown as vscode.Uri;

  function fakeTargets(source: string) {
    const calls: Array<{ opts: unknown }> = [];
    let reads = 0;
    const targets: ReviewViewTargets = {
      live: async (_uri, opts) => void calls.push({ opts }),
      readSource: async () => {
        reads++;
        return source;
      },
    };
    return { targets, calls, reads: () => reads };
  }

  it("opens the live editor with the diff overlay when asked", async () => {
    const { targets, calls } = fakeTargets(BODY);
    const open = createReviewViewRouter(targets);
    await open(uri);
    await open(uri, { diff: true });
    expect(calls).toEqual([
      { opts: { revealThreadId: undefined, diff: undefined } },
      { opts: { revealThreadId: undefined, diff: true } },
    ]);
  });

  it("reads the file only to find the first unread agent thread", async () => {
    const { source, id } = withThread(BODY, "a claim", "ronica");
    const { targets, calls, reads } = fakeTargets(source);
    const open = createReviewViewRouter(targets);
    await open(uri, { diff: true });
    await open(uri, { revealThreadId: id });
    expect(reads()).toBe(0);
    await open(uri, { focusNewFromAgent: true });
    expect(reads()).toBe(1);
    expect(calls[1]).toEqual({ opts: { revealThreadId: id, diff: undefined } });
  });
});
