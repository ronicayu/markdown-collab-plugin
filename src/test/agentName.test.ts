import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_NAME,
  agentAuthorId,
  agentName,
  isAgentAuthor,
  normalizeAgentName,
  setAgentName,
} from "../agentName";
import { agentsSnippet, AGENTS_SNIPPET } from "../agents";
import { isAnswered, pendingLabel } from "../inlineComments/claudePending";
import { isClaudeReviewed, isClaudeUnread } from "../inlineComments/claudeUnread";
import { opList, opReply, opResolve } from "../inlineComments/docOps";
import { addThread } from "../inlineComments/format";
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

describe("who counts as the agent in a thread", () => {
  it("derives the author id from the name", () => {
    expect(agentAuthorId()).toBe("claude");
    setAgentName("Codex CLI");
    expect(agentAuthorId()).toBe("codex-cli");
  });

  it("recognises the configured agent and, always, the legacy claude id", () => {
    setAgentName("Codex");
    expect(isAgentAuthor("codex")).toBe(true);
    expect(isAgentAuthor("Codex")).toBe(true);
    // Threads written before the setting existed, or by the Claude skill.
    expect(isAgentAuthor("claude")).toBe(true);
    expect(isAgentAuthor("ronica")).toBe(false);
    expect(isAgentAuthor(undefined)).toBe(false);
  });

  it("a thread opened by the configured agent is unread until the human answers", () => {
    setAgentName("Codex");
    const opened = { status: "open" as const, comments: [{ author: "codex" }] };
    expect(isClaudeUnread(opened)).toBe(true);
    const answered = { status: "open" as const, comments: [{ author: "codex" }, { author: "ronica" }] };
    expect(isClaudeUnread(answered)).toBe(false);
    expect(isClaudeReviewed(answered)).toBe(true);
  });

  it("a reply from the configured agent clears the waiting row", () => {
    setAgentName("Codex");
    const snapshot = { threadId: "t1", commentCount: 1, since: 0, lastSignal: 0, evidence: "inferred" as const };
    const thread = { id: "t1", status: "open" as const, comments: [{ author: "ronica" }, { author: "codex" }] };
    expect(isAnswered(snapshot, thread)).toBe(true);
  });

  it("comments the extension writes for the agent carry its id", () => {
    setAgentName("Codex");
    const doc = "# Doc\n\nSome anchored words here.\n";
    const at = doc.indexOf("anchored words");
    const seeded = addThread(doc, at, at + 14, { author: "ronica", body: "fix this", ts: "2026-01-01T00:00:00.000Z" });

    const replied = opReply(seeded.source, seeded.thread.id, "done").next;
    const thread = opList(replied).threads[0]!;
    expect(thread.comments.at(-1)!.author).toBe("codex");
    // …and that reply is no longer "owed".
    expect(opList(replied, true).threads).toHaveLength(0);

    const resolved = opResolve(replied, seeded.thread.id).next;
    expect(resolved).toContain('"resolvedBy":"codex"');
  });

  it("AGENTS.md tells the agent which id to sign with", () => {
    setAgentName("Codex");
    expect(agentsSnippet()).toContain('"author":"codex"');
    expect(agentsSnippet()).not.toContain('"author":"claude"');
    // The exported constant is the default agent's version.
    expect(AGENTS_SNIPPET).toContain('"author":"claude"');
  });
});
