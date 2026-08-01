// `opOpenAt` — opening a thread on an exact range (10x-plan-3 P0.2).
//
// The verb behind "Comment on Selection". It exists separately from `opOpen`
// because the two have genuinely different contracts: Claude names a quote and
// must be refused when it is ambiguous, while a human has already pointed at
// one specific range, where "that text appears three times" would be a nonsense
// answer.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { DocOpError, opOpenAt } from "../inlineComments/docOps";
import { parse } from "../inlineComments/format";

const DOC = `---
title: Guide
---

# Guide

The retry policy uses exponential backoff with jitter.

\`\`\`js
const backoff = 1000; // exponential backoff
\`\`\`

The word backoff appears in several places, including here.
`;

const NOW = (): string => "2026-01-15T10:00:00.000Z";

function open(source: string, needle: string, body = "why?", occurrence = 0) {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = source.indexOf(needle, at + 1);
  return opOpenAt(source, at, at + needle.length, body, "ronica", NOW);
}

describe("opOpenAt", () => {
  it("anchors exactly the selected range", () => {
    const { next, result } = open(DOC, "exponential backoff");
    const parsed = parse(next);
    const anchor = parsed.anchors.get(result.threadId)!;
    expect(next.slice(anchor.openEnd, anchor.closeStart)).toBe("exponential backoff");
    expect(result.quote).toBe("exponential backoff");
  });

  it("attributes the comment to the human, not to claude", () => {
    // opOpen hard-codes "claude" because Claude is its only caller. This one
    // is the human's, and a thread the human opened must not look like a
    // review finding.
    const { next, result } = open(DOC, "exponential backoff", "is this full jitter?");
    const thread = parse(next).threads.find((t) => t.id === result.threadId)!;
    expect(thread.comments[0].author).toBe("ronica");
    expect(thread.comments[0].body).toBe("is this full jitter?");
  });

  it("takes the occurrence the user selected, not the first match", () => {
    // The whole reason this verb exists: "backoff" appears three times here,
    // and opOpen would refuse the request as ambiguous.
    const at = DOC.lastIndexOf("backoff");
    const { next, result } = opOpenAt(DOC, at, at + "backoff".length, "here", "ronica", NOW);
    const anchor = parse(next).anchors.get(result.threadId)!;
    expect(anchor.openStart).toBeGreaterThan(DOC.indexOf("```js"));
  });

  it("refuses an empty selection", () => {
    expect(() => opOpenAt(DOC, 10, 10, "x", "ronica", NOW)).toThrow(DocOpError);
    try {
      opOpenAt(DOC, 10, 10, "x", "ronica", NOW);
    } catch (e) {
      expect((e as DocOpError).code).toBe("empty_selection");
    }
  });

  it("refuses an inverted range", () => {
    try {
      opOpenAt(DOC, 40, 10, "x", "ronica", NOW);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as DocOpError).code).toBe("empty_selection");
    }
  });

  it("refuses a range outside the document", () => {
    try {
      opOpenAt(DOC, 5, DOC.length + 50, "x", "ronica", NOW);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as DocOpError).code).toBe("out_of_range");
    }
  });

  it("refuses a selection inside a fenced code block", () => {
    // The parser strips markers in code, so a thread anchored there would be
    // orphaned the moment it was written.
    const at = DOC.indexOf("const backoff");
    try {
      opOpenAt(DOC, at, at + 13, "x", "ronica", NOW);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as DocOpError).code).toBe("not_anchorable");
    }
  });

  it("refuses a selection inside frontmatter", () => {
    const at = DOC.indexOf("title: Guide");
    try {
      opOpenAt(DOC, at, at + 12, "x", "ronica", NOW);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as DocOpError).code).toBe("not_anchorable");
    }
  });

  it("leaves the prose byte-identical apart from the markers", () => {
    const { next } = open(DOC, "exponential backoff");
    const stripped = next
      .replace(/<!--mc:a:[a-z0-9]+-->/g, "")
      .replace(/<!--mc:\/a:[a-z0-9]+-->/g, "")
      .replace(/\n*<!--mc:threads:begin-->[\s\S]*<!--mc:threads:end-->\n*/, "\n");
    expect(stripped).toBe(DOC);
  });

  it("can open a second thread on a document that already has one", () => {
    const first = open(DOC, "exponential backoff");
    const second = open(first.next, "several places");
    const parsed = parse(second.next);
    expect(parsed.threads).toHaveLength(2);
    expect(parsed.unanchoredThreadIds).toEqual([]);
  });
});

describe("the editor's comment path uses the shared verb", () => {
  // The same rule 10x-plan-2 P0.1 set for the CLI and the MCP tools, now that
  // there is a third front end: the human's. A hand-rolled `addThread` call in
  // extension.ts would compile fine and skip the integrity gate.
  const extension = readFileSync(resolve(__dirname, "../extension.ts"), "utf8");

  it("calls opOpenAt rather than the format engine's mutators", () => {
    expect(extension).toContain("opOpenAt(");
    for (const mutator of ["addThread", "addSuggestion", "appendReply", "replaceThread"]) {
      expect(extension, `extension.ts must not call ${mutator} itself`).not.toMatch(
        new RegExp(`\\b${mutator}\\s*\\(`),
      );
    }
  });

  it("writes through a WorkspaceEdit, so the comment is undoable", () => {
    const fn = extension.slice(extension.indexOf("async function invokeCommentOnSelection"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("new vscode.WorkspaceEdit()");
    expect(body).toContain("applyEdit");
    expect(body).not.toMatch(/fs\.|writeFile/);
  });
});
