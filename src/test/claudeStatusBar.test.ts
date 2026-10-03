import { describe, expect, it } from "vitest";
import { chooseStatusBarView, protocolTooltip, statusBarText } from "../claudeStatusBar";
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

  it("names the phase the agent reported, under the agent's name", () => {
    expect(
      statusBarText(
        { threadIds: ["a1"], evidence: "protocol", active: true, phase: "reading 2 of 3", agent: "claude" },
        FILE,
      ),
    ).toContain("Claude: reading 2 of 3");
    expect(
      statusBarText(
        { threadIds: ["a1"], evidence: "protocol", active: true, phase: "reading", agent: "codex" },
        FILE,
      ),
    ).toContain("Codex: reading");
  });

  it("reads generic when protocol evidence has no agent recorded", () => {
    const text = (s: Partial<Parameters<typeof statusBarText>[0]>): string | null =>
      statusBarText({ threadIds: ["a1"], evidence: "protocol", active: true, ...s }, FILE);
    expect(text({ phase: "reading" })).toContain("Agent: reading");
    expect(text({})).toBe(`$(loading~spin) The agent is working on ${FILE}`);
    expect(text({ active: false })).toBe(`$(loading~spin) Sent ${FILE} to the agent`);
    expect(text({})).not.toContain("Claude");
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

// 1.3: the tooltip used to hardcode "Claude" regardless of which agent's
// tool calls actually earned the wait — now it's built from the same
// `status.agent` value `statusBarText` already resolves.
describe("protocolTooltip", () => {
  it("names the agent the evidence came from", () => {
    expect(protocolTooltip("codex")).toBe("Markdown Collab: Codex is working through the review tools");
  });

  it("reads generic when no agent is recorded", () => {
    expect(protocolTooltip(undefined)).toBe("Markdown Collab: The agent is working through the review tools");
  });

  it("title-cases an unrecognized slug rather than showing it raw", () => {
    expect(protocolTooltip("some-other-tool")).toBe(
      "Markdown Collab: Some-other-tool is working through the review tools",
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

// 10x-plan-4 P2.2: with a live review pass and a headless run both able to
// want this one status bar item, the order they're offered in is the whole
// module header's second half — pinned here as a pure function so the
// ordering itself is tested without a real status bar item or any of the
// trackers behind it.
describe("chooseStatusBarView — priority order", () => {
  const headless = { text: "$(loading~spin) Claude is reviewing a.md · 3s", tooltip: "headless" };
  const reviewPass = { text: "$(clock) Sent for review · 1m 20s", tooltip: "review pass" };
  const pending = { text: "$(loading~spin) Claude: reading", tooltip: protocolTooltip("claude") };
  const notice = { text: "$(check) Claude finished a.md", tooltip: "notice" };

  it("nothing wants the item: hidden", () => {
    expect(chooseStatusBarView({ headless: null, reviewPass: null, pending: null, notice: null })).toBeNull();
  });

  it("an active headless run wins over everything else", () => {
    const choice = chooseStatusBarView({ headless, reviewPass, pending, notice });
    expect(choice).toMatchObject({ source: "headless", command: "markdownCollab.headlessRunMenu" });
  });

  it("a live review pass wins over a per-thread wait and a finished notice", () => {
    const choice = chooseStatusBarView({ headless: null, reviewPass, pending, notice });
    expect(choice).toMatchObject({ source: "review-pass", command: "markdownCollab.reviewPassMenu" });
  });

  it("a per-thread protocol wait wins over a finished/failed headless notice", () => {
    const choice = chooseStatusBarView({ headless: null, reviewPass: null, pending, notice });
    expect(choice).toMatchObject({ source: "pending", text: pending.text, tooltip: pending.tooltip });
    expect(choice?.command).toBeUndefined();
  });

  it("a finished/failed headless notice is the last resort", () => {
    const choice = chooseStatusBarView({ headless: null, reviewPass: null, pending: null, notice });
    expect(choice).toMatchObject({ source: "notice", command: "markdownCollab.headlessRunMenu" });
  });
});
