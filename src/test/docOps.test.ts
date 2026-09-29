// 10x-plan-4 P1.2: docOps' agent-writing ops (opReply/opOpen/opResolve/
// opSuggest) take an `author` parameter, default `"claude"` for every caller
// that predates this change, and stamp `agent: true` regardless of which
// slug `author` is — a mdc/MCP call is agent-authored by construction.

import { describe, expect, it } from "vitest";
import {
  DocOpError,
  locatePassage,
  opEdit,
  opList,
  opOpen,
  opReopen,
  opReply,
  opResolve,
  opSuggest,
  parseOccurrence,
} from "../inlineComments/docOps";
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

// ux-review-2026-09 0.1: `mdc open --occurrence banana` passed NaN through,
// and NaN slips past every range check — the op wrapped nothing at byte 0,
// recorded an empty quote, and reported success. The ops refuse it now,
// whichever front end forgot to validate.
describe("docOps: occurrence must be a non-negative integer", () => {
  const TWICE = "# T\n\nalpha one, alpha two.\n";

  it("opOpen refuses the CLI's old Number('banana') instead of anchoring an empty thread at byte 0", () => {
    let err: unknown;
    try {
      opOpen("# Occ\n\nOnly one alpha here.\n", "alpha", "which?", Number("banana"), NOW);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocOpError);
    expect((err as DocOpError).code).toBe("invalid_arguments");
  });

  it.each([Number.NaN, -1, 1.5, Infinity])("opOpen, opSuggest and opEdit refuse %s", (occurrence) => {
    expect(() => opOpen(TWICE, "alpha", "x", occurrence, NOW)).toThrow(/occurrence must be a non-negative integer/);
    expect(() => opSuggest(TWICE, "alpha", "beta", { occurrence }, NOW)).toThrow(DocOpError);
    expect(() => opEdit(TWICE, "alpha", "beta", occurrence)).toThrow(DocOpError);
  });

  it("locatePassage refuses NaN even when the quote appears exactly once", () => {
    expect(() => locatePassage(DOC, "nested lists", Number.NaN)).toThrow(DocOpError);
  });

  it("locatePassage refuses an empty quote instead of scanning forever", () => {
    expect(() => locatePassage(DOC, "")).toThrow(/quote must not be empty/);
  });

  it("valid occurrences still pick the right passage", () => {
    const { next } = opOpen(TWICE, "alpha", "x", 2, NOW);
    expect(next).toMatch(/alpha one, <!--mc:a:\w+-->alpha<!--mc:\/a:\w+--> two/);
  });
});

describe("parseOccurrence", () => {
  it("absent means 0", () => {
    expect(parseOccurrence(undefined)).toBe(0);
    expect(parseOccurrence(null)).toBe(0);
  });

  it("takes an integer or a string of digits", () => {
    expect(parseOccurrence(2)).toBe(2);
    expect(parseOccurrence("2")).toBe(2);
    expect(parseOccurrence("0")).toBe(0);
  });

  it.each(["banana", "", "-1", "1.5", "0x2", "1e0", true, {}, -1, Number.NaN])("refuses %j", (v) => {
    expect(() => parseOccurrence(v)).toThrow(DocOpError);
  });
});

// ux-review-2026-09 0.6: a reply used to land on a resolved thread and stay
// there, filtered out of the human's default Open view.
describe("docOps: an agent reply reopens a resolved thread", () => {
  function resolvedThread(): { source: string; threadId: string } {
    const opened = opOpen(DOC, "nested lists", "human question", 0, NOW, "claude");
    const { next } = opResolve(opened.next, opened.result.threadId, NOW, "ronica");
    return { source: next, threadId: opened.result.threadId };
  }

  it("an agent's reply reopens it and says so", () => {
    const { source, threadId } = resolvedThread();
    const { next, result } = opReply(source, threadId, "one more thing", NOW, "codex");
    expect(result.reopened).toBe(true);
    const thread = parse(next).threads.find((t) => t.id === threadId)!;
    expect(thread.status).toBe("open");
    expect(thread.resolvedBy).toBeUndefined();
    expect(thread.resolvedTs).toBeUndefined();
    expect(thread.comments.at(-1)).toMatchObject({ author: "codex", agent: true, body: "one more thing" });
  });

  it("a human's reply leaves it resolved", () => {
    const { source, threadId } = resolvedThread();
    const { next, result } = opReply(source, threadId, "noting for later", NOW, "ronica", false);
    expect(result.reopened).toBe(false);
    const thread = parse(next).threads.find((t) => t.id === threadId)!;
    expect(thread.status).toBe("resolved");
    expect(thread.resolvedBy).toBe("ronica");
    expect(thread.comments.at(-1)!.agent).toBeUndefined();
  });

  it("a reply to an open thread reports reopened: false", () => {
    const opened = opOpen(DOC, "nested lists", "human question", 0, NOW);
    const { result } = opReply(opened.next, opened.result.threadId, "answer", NOW);
    expect(result.reopened).toBe(false);
  });

  // The hover's Reopen link (ux-review 3.7) needs the inverse of opResolve
  // outright, not a reply to smuggle it in.
  it("opReopen clears the resolver's mark and leaves the comments alone", () => {
    const { source, threadId } = resolvedThread();
    const before = parse(source).threads.find((t) => t.id === threadId)!;
    const { next } = opReopen(source, threadId);
    const thread = parse(next).threads.find((t) => t.id === threadId)!;
    expect(thread.status).toBe("open");
    expect(thread.resolvedBy).toBeUndefined();
    expect(thread.resolvedTs).toBeUndefined();
    expect(thread.comments).toEqual(before.comments);
  });

  it("opReopen refuses an unknown thread id", () => {
    expect(() => opReopen(DOC, "nope1")).toThrow(DocOpError);
  });
});

// 10x-plan-6 P1.4: every comment an agent writes records which path it took —
// "tools" through the MCP server, "cli" for `mdc` writing the file itself — and
// a comment written any other way carries no field at all.
describe("docOps: via records how a write arrived", () => {
  it.each(["tools", "cli"] as const)("opOpen stamps via: %s on the first comment", (via) => {
    const { next } = opOpen(DOC, "nested lists", "note", 0, NOW, "codex", via);
    expect(parse(next).threads[0]!.comments[0]).toMatchObject({ author: "codex", agent: true, via });
    expect(next).toContain(`"via":"${via}"`);
  });

  it.each(["tools", "cli"] as const)("opReply stamps via: %s on the reply only", (via) => {
    const opened = opOpen(DOC, "nested lists", "human question", 0, NOW);
    const { next } = opReply(opened.next, opened.result.threadId, "answer", NOW, "claude", true, via);
    const comments = parse(next).threads[0]!.comments;
    expect(comments[0]!.via).toBeUndefined();
    expect(comments[1]).toMatchObject({ body: "answer", via });
  });

  it.each(["tools", "cli"] as const)("opSuggest stamps via: %s on the suggestion record", (via) => {
    const { next } = opSuggest(DOC, "Suggest mode ships behind a setting.", "Off by default.", {}, NOW, "claude", via);
    expect(parse(next).suggestions[0]).toMatchObject({ agent: true, via });
    expect(next).toContain(`"via":"${via}"`);
  });

  it("left undefined, nothing is written — the bytes are what they were before the field existed", () => {
    const opened = opOpen(DOC, "nested lists", "q", 0, NOW);
    const replied = opReply(opened.next, opened.result.threadId, "a", NOW);
    const suggested = opSuggest(replied.next, "Suggest mode ships behind a setting.", "Off.", {}, NOW);
    expect(suggested.next).not.toContain('"via"');
    const parsed = parse(suggested.next);
    expect(parsed.threads[0]!.comments.every((c) => !("via" in c))).toBe(true);
  });

  it("opList exposes via on comments and suggestions, and omits it where absent", () => {
    const opened = opOpen(DOC, "nested lists", "q", 0, NOW, "claude");
    const replied = opReply(opened.next, opened.result.threadId, "a", NOW, "codex", true, "cli");
    const suggested = opSuggest(replied.next, "Suggest mode ships behind a setting.", "Off.", {}, NOW, "claude", "tools");
    const listed = opList(suggested.next);
    expect(listed.threads[0]!.comments[0]).not.toHaveProperty("via");
    expect(listed.threads[0]!.comments[1]).toMatchObject({ author: "codex", via: "cli" });
    expect(listed.suggestions[0]).toMatchObject({ via: "tools" });
    expect(opList(opened.next).suggestions).toEqual([]);
  });

  it("a hand-written comment with an unknown via reads as absent, and a reply beside it still lands", () => {
    const handWritten =
      "Text with <!--mc:a:abc12-->a passage<!--mc:/a:abc12--> in it.\n\n" +
      "<!--mc:threads:begin-->\n" +
      '<!--mc:t {"id":"abc12","quote":"a passage","status":"open","comments":[' +
      '{"id":"c1","author":"ronica","ts":"2026-09-01T00:00:00.000Z","body":"q","via":"file"},' +
      '{"id":"c2","author":"copilot","agent":true,"ts":"2026-09-01T00:01:00.000Z","body":"a","via":7}]}-->\n' +
      "<!--mc:threads:end-->\n";
    const comments = parse(handWritten).threads[0]!.comments;
    expect(comments.map((c) => c.via)).toEqual([undefined, undefined]);
    expect(comments.every((c) => !("via" in c))).toBe(true);
    expect(opList(handWritten).threads[0]!.comments.every((c) => !("via" in c))).toBe(true);

    const { next } = opReply(handWritten, "abc12", "follow-up", NOW, "claude", true, "tools");
    expect(parse(next).threads[0]!.comments.map((c) => c.via)).toEqual([undefined, undefined, "tools"]);
  });
});
