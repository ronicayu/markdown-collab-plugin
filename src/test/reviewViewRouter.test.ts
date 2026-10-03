// The review view's router (10x-plan-6 P4, the switch): which view opens —
// the live editor, or the previous panel while
// `markdownCollab.classicReviewView` is on — and where it lands.

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

/** Line (1-based) the thread's anchored text starts on, as `TextDocument.positionAt` counts. */
function anchorLine(source: string, id: string): number {
  const anchor = parse(source).anchors.get(id)!;
  return source.slice(0, anchor.openEnd).split("\n").length;
}

describe("routeReviewView", () => {
  it("opens the live editor unless the classic view is on", () => {
    expect(routeReviewView("", {}, false)).toEqual({ view: "live" });
    expect(routeReviewView("", {}, true)).toEqual({ view: "classic" });
  });

  it("passes the diff overlay to either view", () => {
    expect(routeReviewView("", { diff: true }, false)).toEqual({ view: "live", diff: true });
    expect(routeReviewView("", { diff: true }, true)).toEqual({ view: "classic", showDiff: true });
  });

  it("lands the live editor on a thread by id, and the classic view on its anchor's line", () => {
    const { source, id } = withThread(BODY, "the agent has a question", "ronica");
    expect(routeReviewView(source, { revealThreadId: id }, false)).toEqual({ view: "live", revealThreadId: id });
    const classic = routeReviewView(source, { revealThreadId: id }, true);
    expect(classic).toEqual({ view: "classic", line: anchorLine(source, id) });
    // The anchor is on the sixth line of the body.
    expect(classic).toMatchObject({ line: 6 });
  });

  it("opens the classic view at the top for a thread with no anchor, and still names it to the live editor", () => {
    const anchored = withThread(BODY, "a claim", "ronica");
    const source = stripAnchorMarkers(anchored.source, anchored.id);
    expect(parse(source).unanchoredThreadIds).toContain(anchored.id);
    expect(routeReviewView(source, { revealThreadId: anchored.id }, true)).toEqual({ view: "classic" });
    expect(routeReviewView(source, { revealThreadId: anchored.id }, false)).toEqual({
      view: "live",
      revealThreadId: anchored.id,
    });
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

    expect(routeReviewView(source, { focusNewFromAgent: true }, false)).toEqual({
      view: "live",
      revealThreadId: firstUnread.id,
    });
    expect(routeReviewView(source, { focusNewFromAgent: true }, true)).toEqual({
      view: "classic",
      line: anchorLine(source, firstUnread.id),
    });
    // An explicit thread wins.
    expect(routeReviewView(source, { focusNewFromAgent: true, revealThreadId: secondUnread.id }, false)).toEqual({
      view: "live",
      revealThreadId: secondUnread.id,
    });
  });

  it("focusNewFromAgent with nothing unread just opens the view", () => {
    const { source } = withThread(BODY, "a claim", "ronica");
    expect(routeReviewView(source, { focusNewFromAgent: true }, false)).toEqual({ view: "live" });
    expect(routeReviewView(source, { focusNewFromAgent: true }, true)).toEqual({ view: "classic" });
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

  function fakeTargets(source: string, classic: { on: boolean }) {
    const calls: Array<{ view: string; opts: unknown }> = [];
    let reads = 0;
    const targets: ReviewViewTargets = {
      classic: async (_uri, opts) => void calls.push({ view: "classic", opts }),
      live: async (_uri, opts) => void calls.push({ view: "live", opts }),
      readSource: async () => {
        reads++;
        return source;
      },
      classicEnabled: () => classic.on,
    };
    return { targets, calls, reads: () => reads };
  }

  it("reads the setting on every open, so a change applies to the next one", async () => {
    const setting = { on: false };
    const { targets, calls } = fakeTargets(BODY, setting);
    const open = createReviewViewRouter(targets);
    await open(uri);
    setting.on = true;
    await open(uri, { diff: true });
    setting.on = false;
    await open(uri, { diff: true });
    expect(calls).toEqual([
      { view: "live", opts: { revealThreadId: undefined, diff: undefined } },
      { view: "classic", opts: { line: undefined, showDiff: true } },
      { view: "live", opts: { revealThreadId: undefined, diff: true } },
    ]);
  });

  it("reads the file only when asked to land on a thread", async () => {
    const { source, id } = withThread(BODY, "a claim", "ronica");
    const { targets, calls, reads } = fakeTargets(source, { on: false });
    const open = createReviewViewRouter(targets);
    await open(uri, { diff: true });
    expect(reads()).toBe(0);
    await open(uri, { revealThreadId: id });
    await open(uri, { focusNewFromAgent: true });
    expect(reads()).toBe(2);
    expect(calls[1]).toEqual({ view: "live", opts: { revealThreadId: id, diff: undefined } });
  });

  it("hands the classic view its anchor line for a reveal", async () => {
    const { source, id } = withThread(BODY, "a claim", "ronica");
    const { targets, calls } = fakeTargets(source, { on: true });
    await createReviewViewRouter(targets)(uri, { revealThreadId: id });
    expect(calls).toEqual([{ view: "classic", opts: { line: anchorLine(source, id), showDiff: undefined } }]);
  });
});
