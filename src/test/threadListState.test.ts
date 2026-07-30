import { describe, expect, it } from "vitest";
import {
  chunkThreads,
  claudeSummary,
  emptyListMessage,
  filterThreads,
  matchesFilter,
  nextCollapseAllAction,
  nextUnreadThreadId,
  sidebarCountLabel,
  threadCountLabel,
  threadSignature,
  type ListThread,
} from "../webviewShared/threadListState";

/** A thread with one root comment, plus optional replies. */
function thread(
  id: string,
  opts: {
    status?: "open" | "resolved";
    author?: string;
    replies?: string[];
    deletedRoot?: boolean;
  } = {},
): ListThread {
  const comments: ListThread["comments"] = [
    { author: opts.author ?? "user", deleted: opts.deletedRoot },
  ];
  for (const author of opts.replies ?? []) comments.push({ author });
  return { id, status: opts.status ?? "open", comments };
}

describe("matchesFilter", () => {
  const open = thread("a");
  const resolved = thread("b", { status: "resolved" });
  const claudeNew = thread("c", { author: "claude" });

  it("'open' admits only open threads", () => {
    expect(matchesFilter(open, "open")).toBe(true);
    expect(matchesFilter(resolved, "open")).toBe(false);
  });

  it("'resolved' admits only resolved threads", () => {
    expect(matchesFilter(resolved, "resolved")).toBe(true);
    expect(matchesFilter(open, "resolved")).toBe(false);
  });

  it("'all' admits everything", () => {
    expect(matchesFilter(open, "all")).toBe(true);
    expect(matchesFilter(resolved, "all")).toBe(true);
  });

  it("'claude-unread' admits only unanswered claude threads", () => {
    expect(matchesFilter(claudeNew, "claude-unread")).toBe(true);
    expect(matchesFilter(open, "claude-unread")).toBe(false);
    expect(
      matchesFilter(thread("d", { author: "claude", replies: ["user"] }), "claude-unread"),
    ).toBe(false);
  });
});

describe("filterThreads", () => {
  it("preserves input order", () => {
    const threads = [thread("c"), thread("a"), thread("b", { status: "resolved" })];
    expect(filterThreads(threads, "open").map((t) => t.id)).toEqual(["c", "a"]);
  });

  it("returns everything for 'all'", () => {
    const threads = [thread("a"), thread("b", { status: "resolved" })];
    expect(filterThreads(threads, "all")).toHaveLength(2);
  });
});

describe("threadCountLabel", () => {
  it("counts open against total", () => {
    expect(
      threadCountLabel([thread("a"), thread("b"), thread("c", { status: "resolved" })]),
    ).toBe("2 open · 3 total");
  });

  it("reads sensibly with nothing to count", () => {
    expect(threadCountLabel([])).toBe("0 open · 0 total");
  });
});

describe("sidebarCountLabel", () => {
  it("shows both counts when not filtering", () => {
    expect(sidebarCountLabel({ open: 2, total: 5, hideResolved: false })).toBe("2 open · 5 total");
  });

  it("names the filter's effect when filtering", () => {
    expect(sidebarCountLabel({ open: 2, total: 5, hideResolved: true })).toBe("Showing open · 2");
  });
});

describe("claudeSummary", () => {
  it("counts unanswered claude threads as unread", () => {
    const s = claudeSummary([thread("a", { author: "claude" }), thread("b", { author: "claude" })]);
    expect(s.unread).toBe(2);
    expect(s.reviewed).toBe(0);
    expect(s.text).toBe("2 new from Claude · 0 reviewed");
  });

  it("moves a thread to reviewed once the human replies", () => {
    const s = claudeSummary([thread("a", { author: "claude", replies: ["user"] })]);
    expect(s.unread).toBe(0);
    expect(s.reviewed).toBe(1);
  });

  it("counts a resolved claude thread as reviewed, not unread", () => {
    const s = claudeSummary([thread("a", { author: "claude", status: "resolved" })]);
    expect(s.reviewed).toBe(1);
    expect(s.unread).toBe(0);
  });

  it("ignores human-authored threads entirely", () => {
    const s = claudeSummary([thread("a"), thread("b", { replies: ["claude"] })]);
    expect(s.hasAny).toBe(false);
    expect(s.text).toBe("");
  });

  it("uses singular wording for one", () => {
    const s = claudeSummary([
      thread("a", { author: "claude" }),
      thread("b", { author: "claude", replies: ["user"] }),
    ]);
    expect(s.text).toBe("1 new from Claude · 1 reviewed");
  });

  it("counts each thread once", () => {
    const s = claudeSummary([thread("a", { author: "claude", replies: ["user"] })]);
    expect(s.unread + s.reviewed).toBe(1);
  });
});

describe("emptyListMessage", () => {
  it("tells the human how to start a thread when the doc has none", () => {
    expect(emptyListMessage("open")).toMatch(/select text/i);
  });

  it("points at the review command when no claude threads exist", () => {
    expect(emptyListMessage("claude-unread")).toMatch(/Ask Claude to Review/);
  });

  it("blames the filter otherwise", () => {
    expect(emptyListMessage("resolved")).toMatch(/filter/i);
    expect(emptyListMessage("all")).toMatch(/filter/i);
  });
});

describe("nextUnreadThreadId", () => {
  const threads = [
    thread("a", { author: "claude" }),
    thread("b"), // human thread — skipped
    thread("c", { author: "claude" }),
    thread("d", { author: "claude", replies: ["user"] }), // answered — skipped
  ];

  it("starts at the first unread when nothing is highlighted", () => {
    expect(nextUnreadThreadId(threads, null)).toBe("a");
  });

  it("advances to the next unread, skipping non-claude and answered threads", () => {
    expect(nextUnreadThreadId(threads, "a")).toBe("c");
  });

  it("wraps at the end", () => {
    expect(nextUnreadThreadId(threads, "c")).toBe("a");
  });

  it("restarts from the top when the cursor is no longer unread", () => {
    // The human just replied to "d", so it left the unread list.
    expect(nextUnreadThreadId(threads, "d")).toBe("a");
  });

  it("returns null when nothing is unread", () => {
    expect(nextUnreadThreadId([thread("a"), thread("b")], null)).toBeNull();
    expect(nextUnreadThreadId([], null)).toBeNull();
  });
});

describe("nextCollapseAllAction", () => {
  it("collapses when nothing is collapsed", () => {
    expect(nextCollapseAllAction(["a", "b"], new Set())).toBe("collapse");
  });

  it("collapses the rest when partially collapsed", () => {
    expect(nextCollapseAllAction(["a", "b"], new Set(["a"]))).toBe("collapse");
  });

  it("expands only when everything is collapsed", () => {
    expect(nextCollapseAllAction(["a", "b"], new Set(["a", "b"]))).toBe("expand");
  });

  it("collapses on an empty list rather than reporting 'all collapsed'", () => {
    expect(nextCollapseAllAction([], new Set())).toBe("collapse");
  });
});

describe("chunkThreads", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

  it("renders everything when the list fits", () => {
    expect(chunkThreads(list(40), 100)).toEqual({
      visible: list(40),
      remaining: 0,
      moreLabel: null,
    });
  });

  it("renders exactly the limit when the list is exactly full", () => {
    const chunk = chunkThreads(list(100), 100);
    expect(chunk.visible).toHaveLength(100);
    expect(chunk.moreLabel).toBeNull();
  });

  it("holds back the tail past the limit", () => {
    const chunk = chunkThreads(list(150), 100);
    expect(chunk.visible).toHaveLength(100);
    expect(chunk.visible[99]).toBe("t99");
    expect(chunk.remaining).toBe(50);
  });

  it("labels the button with the exact count when one more click finishes it", () => {
    expect(chunkThreads(list(150), 100).moreLabel).toBe("Show 50 more");
  });

  it("says how many are still hidden when more than one click remains", () => {
    expect(chunkThreads(list(350), 100).moreLabel).toBe("Show 100 more (250 hidden)");
  });

  it("advances as the limit grows, keeping earlier cards", () => {
    const first = chunkThreads(list(250), 100);
    const second = chunkThreads(list(250), 200);
    expect(second.visible.slice(0, 100)).toEqual(first.visible);
    expect(second.remaining).toBe(50);
  });

  it("handles an empty list", () => {
    expect(chunkThreads([], 100)).toEqual({ visible: [], remaining: 0, moreLabel: null });
  });

  it("treats a negative limit as zero rather than slicing from the end", () => {
    const chunk = chunkThreads(list(5), -10);
    expect(chunk.visible).toEqual([]);
    expect(chunk.remaining).toBe(5);
  });
});

describe("threadSignature", () => {
  const base = {
    author: "user",
    createdAt: "2025-01-01T00:00:00Z",
    body: "why?",
    resolved: false,
    anchor: { text: "some passage" },
    replies: [{ author: "claude", createdAt: "2025-01-02T00:00:00Z", body: "because" }],
  };

  it("is stable for identical content", () => {
    expect(threadSignature(base)).toBe(threadSignature({ ...base }));
  });

  it("changes when the body is edited", () => {
    expect(threadSignature({ ...base, body: "why not?" })).not.toBe(threadSignature(base));
  });

  it("changes when a reply is added", () => {
    const more = {
      ...base,
      replies: [...base.replies, { author: "user", createdAt: "2025-01-03T00:00:00Z", body: "ok" }],
    };
    expect(threadSignature(more)).not.toBe(threadSignature(base));
  });

  it("changes when a reply is edited in place", () => {
    const edited = {
      ...base,
      replies: [{ ...base.replies[0], body: "because of X" }],
    };
    expect(threadSignature(edited)).not.toBe(threadSignature(base));
  });

  it("changes when the thread resolves", () => {
    expect(threadSignature({ ...base, resolved: true })).not.toBe(threadSignature(base));
  });

  it("changes when the anchored text is rewritten", () => {
    expect(threadSignature({ ...base, anchor: { text: "other passage" } })).not.toBe(
      threadSignature(base),
    );
  });

  it("changes when the thread starts (or stops) waiting on Claude", () => {
    // A dispatch flips the pending flag with no content change at all. When
    // that wasn't part of the signature, the live editor's reconciler kept the
    // old card and the "Claude is working…" row never appeared.
    expect(threadSignature(base, true)).not.toBe(threadSignature(base, false));
    expect(threadSignature(base)).toBe(threadSignature(base, false));
  });

  it("changes when the waiting row's text changes", () => {
    // `mc_status` moves the phase while everything else stands still, so the
    // row's text is what has to be in the signature, not merely "is waiting".
    expect(threadSignature(base, "Claude: reading 2 of 3")).not.toBe(
      threadSignature(base, "Claude: opening threads"),
    );
  });
});
