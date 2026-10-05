import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_NAME,
  agentName,
  normalizeAgentName,
  setAgentName,
} from "../agentName";
import { pendingLabel } from "../inlineComments/claudePending";
import { statusBarText } from "../claudeStatusBar";
import { claudeSummary, emptyListMessage } from "../webviewShared/threadListState";

afterEach(() => {
  setAgentName(undefined);
});

describe("normalizeAgentName", () => {
  it("falls back to the default for anything that isn't a usable string", () => {
    for (const raw of [undefined, null, 42, "", "   ", "\n\t"]) {
      expect(normalizeAgentName(raw)).toBe(DEFAULT_AGENT_NAME);
    }
  });

  it("trims, collapses whitespace and bounds the length", () => {
    expect(normalizeAgentName("  Codex \n CLI ")).toBe("Codex CLI");
    expect(normalizeAgentName("x".repeat(100))).toHaveLength(40);
  });
});

describe("setAgentName", () => {
  it("reports whether the name changed, so callers know to re-render", () => {
    expect(setAgentName("Codex")).toBe(true);
    expect(setAgentName("Codex")).toBe(false);
    expect(setAgentName(undefined)).toBe(true);
    expect(agentName()).toBe("Claude");
  });
});

describe("user-facing text follows the configured name", () => {
  it("defaults to Claude, so nothing changes until the setting is touched", () => {
    expect(pendingLabel({ evidence: "inferred", active: false })).toBe("Claude is working…");
  });

  it("the waiting row", () => {
    setAgentName("Codex");
    expect(pendingLabel({ evidence: "inferred", active: false })).toBe("Codex is working…");
    expect(pendingLabel({ evidence: "protocol", active: true, phase: "reading" })).toBe("Codex: reading");
    expect(pendingLabel({ evidence: "protocol", active: false })).toBe("Sent to Codex…");
  });

  it("the status bar", () => {
    setAgentName("Codex");
    const text = statusBarText({ threadIds: ["a1"], evidence: "protocol", active: true }, "doc.md");
    expect(text).toContain("Codex is working on doc.md");
    expect(text).not.toContain("Claude");
  });

  it("the thread-list summary and empty state", () => {
    setAgentName("Codex");
    const threads: Parameters<typeof claudeSummary>[0] = [
      { id: "a", status: "open", comments: [{ author: "claude" }] },
    ];
    expect(claudeSummary(threads).text).toBe("1 new from Codex · 0 reviewed");
    const empty = emptyListMessage("claude-unread");
    expect(empty).toContain("No unread threads from Codex");
    expect(empty).not.toContain("Claude");
  });
});
