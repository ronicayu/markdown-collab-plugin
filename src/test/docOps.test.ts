// 10x-plan-4 P1.2: docOps' agent-writing ops (opReply/opOpen/opResolve/
// opSuggest) take an `author` parameter, default `"claude"` for every caller
// that predates this change, and stamp `agent: true` regardless of which
// slug `author` is — a mdc/MCP call is agent-authored by construction.

import { describe, expect, it } from "vitest";
import { opOpen, opReply, opResolve, opSuggest } from "../inlineComments/docOps";
import { parse } from "../inlineComments/format";

const DOC = `# Guide

The parser handles nested lists correctly.

Suggest mode ships behind a setting.
`;

const NOW = () => "2026-08-01T00:00:00.000Z";

describe("docOps: author defaults to claude", () => {
  it("opOpen with no author given writes claude, agent: true", () => {
    const { next } = opOpen(DOC, "nested lists", "note", 0, NOW);
    const thread = parse(next).threads[0]!;
    expect(thread.comments[0]).toMatchObject({ author: "claude", agent: true });
  });
});

describe("docOps: a non-default author sets author + agent: true", () => {
  it("opOpen", () => {
    const { next } = opOpen(DOC, "nested lists", "what about ordered?", 0, NOW, "codex");
    const thread = parse(next).threads[0]!;
    expect(thread.comments[0]).toMatchObject({ author: "codex", agent: true });
  });

  it("opReply", () => {
    const opened = opOpen(DOC, "nested lists", "human question", 0, NOW, "claude");
    const threadId = opened.result.threadId;
    const { next } = opReply(opened.next, threadId, "codex answers", NOW, "codex");
    const thread = parse(next).threads.find((t) => t.id === threadId)!;
    expect(thread.comments.at(-1)).toMatchObject({ author: "codex", agent: true });
  });

  it("opResolve", () => {
    const opened = opOpen(DOC, "nested lists", "human question", 0, NOW, "claude");
    const threadId = opened.result.threadId;
    const { next } = opResolve(opened.next, threadId, NOW, "cursor");
    const thread = parse(next).threads.find((t) => t.id === threadId)!;
    expect(thread.status).toBe("resolved");
    expect(thread.resolvedBy).toBe("cursor");
  });

  it("opSuggest", () => {
    const { next } = opSuggest(
      DOC,
      "Suggest mode ships behind a setting.",
      "Suggest mode is off by default.",
      {},
      NOW,
      "gemini",
    );
    const suggestion = parse(next).suggestions[0]!;
    expect(suggestion).toMatchObject({ author: "gemini", agent: true });
  });
});
