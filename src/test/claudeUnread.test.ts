import { describe, expect, it } from "vitest";
import {
  isClaudeReviewed,
  isClaudeUnread,
  unreadAgentSlug,
  type ClaudeUnreadThread,
} from "../inlineComments/claudeUnread";

function thread(
  comments: Array<{ author: string; deleted?: boolean; agent?: boolean }>,
  status: "open" | "resolved" = "open",
): ClaudeUnreadThread {
  return { status, comments };
}

describe("isClaudeUnread", () => {
  it("returns true when the only non-deleted comment is from claude and status is open", () => {
    expect(isClaudeUnread(thread([{ author: "claude" }]))).toBe(true);
  });

  it("returns false when a human has replied", () => {
    expect(
      isClaudeUnread(
        thread([{ author: "claude" }, { author: "ronica" }]),
      ),
    ).toBe(false);
  });

  it("returns false when the thread is resolved", () => {
    expect(isClaudeUnread(thread([{ author: "claude" }], "resolved"))).toBe(false);
  });

  it("returns false when the first non-deleted comment is human (claude is a reply)", () => {
    expect(
      isClaudeUnread(thread([{ author: "ronica" }, { author: "claude" }])),
    ).toBe(false);
  });

  it("returns false when every comment is deleted", () => {
    expect(
      isClaudeUnread(thread([{ author: "claude", deleted: true }])),
    ).toBe(false);
  });

  it("ignores deleted comments when locating the first author", () => {
    // Claude's c1 was deleted, but it's a reply to a (deleted) human c0.
    // The "first live" comment is now claude — current contract treats
    // this as unread. Documenting via test, not enforcing the historical
    // intent — historical author chains are not tracked once deleted.
    expect(
      isClaudeUnread(
        thread([
          { author: "ronica", deleted: true },
          { author: "claude" },
        ]),
      ),
    ).toBe(true);
  });
});

describe("isClaudeReviewed", () => {
  it("returns true when a human has replied to a claude-initiated thread", () => {
    expect(
      isClaudeReviewed(
        thread([{ author: "claude" }, { author: "ronica" }]),
      ),
    ).toBe(true);
  });

  it("returns true when a claude-initiated thread is resolved", () => {
    expect(isClaudeReviewed(thread([{ author: "claude" }], "resolved"))).toBe(true);
  });

  it("returns false when only claude has commented and the thread is open", () => {
    expect(isClaudeReviewed(thread([{ author: "claude" }]))).toBe(false);
  });

  it("returns false for a human-initiated thread (even if resolved)", () => {
    expect(
      isClaudeReviewed(
        thread(
          [{ author: "ronica" }, { author: "claude" }],
          "resolved",
        ),
      ),
    ).toBe(false);
  });

  it("returns false for an empty (all-deleted) thread", () => {
    expect(
      isClaudeReviewed(thread([{ author: "claude", deleted: true }])),
    ).toBe(false);
  });
});

describe("isClaudeUnread × isClaudeReviewed — mutual exclusion on claude-initiated threads", () => {
  it("an open claude-only thread is unread, not reviewed", () => {
    const t = thread([{ author: "claude" }]);
    expect(isClaudeUnread(t)).toBe(true);
    expect(isClaudeReviewed(t)).toBe(false);
  });

  it("a claude-initiated thread with a human reply is reviewed, not unread", () => {
    const t = thread([{ author: "claude" }, { author: "ronica" }]);
    expect(isClaudeUnread(t)).toBe(false);
    expect(isClaudeReviewed(t)).toBe(true);
  });

  it("a resolved claude-initiated thread is reviewed, not unread", () => {
    const t = thread([{ author: "claude" }], "resolved");
    expect(isClaudeUnread(t)).toBe(false);
    expect(isClaudeReviewed(t)).toBe(true);
  });
});

// 10x-plan-4 P1.2: any agent, not just Claude, can open or answer a thread —
// "unread"/"reviewed" is about whether a HUMAN has engaged, not which agent.
describe("isClaudeUnread / isClaudeReviewed — non-Claude agents", () => {
  it("a codex-only open thread is unread", () => {
    expect(isClaudeUnread(thread([{ author: "codex" }]))).toBe(true);
  });

  it("a thread Codex opened and Cursor also replied to is still unread (no human yet)", () => {
    expect(isClaudeUnread(thread([{ author: "codex" }, { author: "cursor" }]))).toBe(true);
  });

  it("a human reply closes out a codex-initiated thread same as a claude one", () => {
    const t = thread([{ author: "codex" }, { author: "ronica" }]);
    expect(isClaudeUnread(t)).toBe(false);
    expect(isClaudeReviewed(t)).toBe(true);
  });

  it("the explicit agent flag is enough even for an unrecognized slug", () => {
    expect(isClaudeUnread(thread([{ author: "some-future-agent", agent: true }]))).toBe(true);
  });
});

describe("unreadAgentSlug", () => {
  it("names the agent that opened an unread thread", () => {
    expect(unreadAgentSlug(thread([{ author: "codex" }]))).toBe("codex");
    expect(unreadAgentSlug(thread([{ author: "claude" }]))).toBe("claude");
  });

  it("is undefined once the thread is no longer unread", () => {
    expect(unreadAgentSlug(thread([{ author: "claude" }, { author: "ronica" }]))).toBeUndefined();
    expect(unreadAgentSlug(thread([{ author: "ronica" }]))).toBeUndefined();
  });
});
