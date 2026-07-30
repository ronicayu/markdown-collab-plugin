import { describe, expect, it } from "vitest";
import { statusBarText } from "../claudeStatusBar";
import { ClaudePendingTracker, type PendingInputThread } from "../inlineComments/claudePending";

const FILE = "docs/guide.md";

describe("statusBarText", () => {
  it("says nothing when nothing is waiting", () => {
    expect(statusBarText({ threadIds: [], evidence: "protocol", active: true }, FILE)).toBeNull();
  });

  // An inferred wait is an assumption. Putting it in the status bar — the one
  // place visible from everywhere — would make the extension's least reliable
  // claim its most prominent one.
  it("says nothing for an inferred wait, however long", () => {
    expect(statusBarText({ threadIds: ["a1"], evidence: "inferred", active: true }, FILE)).toBeNull();
  });

  it("names the phase Claude reported", () => {
    expect(
      statusBarText({ threadIds: ["a1"], evidence: "protocol", active: true, phase: "reading 2 of 3" }, FILE),
    ).toContain("Claude: reading 2 of 3");
  });

  it("distinguishes sent from actually working", () => {
    expect(statusBarText({ threadIds: ["a1"], evidence: "protocol", active: false }, FILE)).toContain(
      `Sent ${FILE}`,
    );
    expect(statusBarText({ threadIds: ["a1"], evidence: "protocol", active: true }, FILE)).toContain(
      `working on ${FILE}`,
    );
  });

  it("spins while it is up", () => {
    expect(statusBarText({ threadIds: ["a1"], evidence: "protocol", active: true }, FILE)).toContain(
      "$(loading~spin)",
    );
  });
});

describe("peek", () => {
  const thread = (id: string): PendingInputThread => ({
    id,
    status: "open",
    comments: [{ author: "ronica" }],
  });

  it("reads the wait without pruning it", () => {
    // The trap this exists for: `status(docKey, [])` reads as "every thread was
    // deleted" and clears real state. A caller without the parsed document —
    // the status bar — must not be able to do that by accident.
    const tracker = new ClaudePendingTracker();
    tracker.mark("/ws/a.md", [thread("a1")], ["a1"], "protocol");

    expect(tracker.peek("/ws/a.md").threadIds).toEqual(["a1"]);
    expect(tracker.peek("/ws/a.md").evidence).toBe("protocol");
    // Still there after peeking, twice.
    expect(tracker.peek("/ws/a.md").threadIds).toEqual(["a1"]);
    expect(tracker.pending("/ws/a.md", [thread("a1")])).toEqual(["a1"]);

    // Whereas status() with no threads does prune — which is why peek exists.
    expect(tracker.status("/ws/a.md", []).threadIds).toEqual([]);
    tracker.dispose();
  });

  it("is empty for a document that was never marked", () => {
    const tracker = new ClaudePendingTracker();
    expect(tracker.peek("/ws/never.md")).toEqual({
      threadIds: [],
      evidence: "inferred",
      phase: undefined,
      active: false,
    });
    tracker.dispose();
  });
});
