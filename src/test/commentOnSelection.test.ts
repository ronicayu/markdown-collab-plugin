// `opOpenAt` — opening a thread on an exact range.
//
// The verb behind "Comment on Selection". It exists separately from `opOpen`
// because the two have genuinely different contracts: Claude names a quote and
// must be refused when it is ambiguous, while a human has already pointed at
// one specific range, where "that text appears three times" would be a nonsense
// answer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { DocOpError, opOpenAt } from "../inlineComments/docOps";
import { parse } from "../inlineComments/format";
import { safeHoverTargetUri } from "../commands/comments";
import { readHostSources } from "./hostSources";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// M1: the three commands a hover's command: link can reach — resolveThread,
// replyToThread, revealThread — must refuse an argument that doesn't name a
// real Markdown file inside the workspace, since any extension (or a
// malicious webview) can invoke a VS Code command with any argument it likes,
// hover escaping notwithstanding.
describe("safeHoverTargetUri (M1)", () => {
  const WS_ROOT = "/workspace/proj";

  beforeEach(() => {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(WS_ROOT), name: "proj", index: 0 },
    ];
  });

  afterEach(() => {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it("accepts a file: URI of a .md file inside the workspace", () => {
    const uri = safeHoverTargetUri(`file://${WS_ROOT}/notes.md`);
    expect(uri?.fsPath).toBe(`${WS_ROOT}/notes.md`);
  });

  it("accepts .markdown too", () => {
    expect(safeHoverTargetUri(`file://${WS_ROOT}/notes.markdown`)).not.toBeNull();
  });

  it("refuses a non-file scheme", () => {
    expect(safeHoverTargetUri(`command:markdownCollab.resolveThread?evil`)).toBeNull();
    expect(safeHoverTargetUri(`http://evil.example.com/notes.md`)).toBeNull();
  });

  it("refuses a path outside the workspace", () => {
    expect(safeHoverTargetUri(`file:///etc/notes.md`)).toBeNull();
  });

  it("refuses a non-.md file", () => {
    expect(safeHoverTargetUri(`file://${WS_ROOT}/notes.txt`)).toBeNull();
    expect(safeHoverTargetUri(`file://${WS_ROOT}/.git/config`)).toBeNull();
  });

  it("refuses undefined and an unparseable URI", () => {
    expect(safeHoverTargetUri(undefined)).toBeNull();
    expect(safeHoverTargetUri("not a uri at all")).toBeNull();
  });
});

describe("the editor's comment path uses the shared verb", () => {
  // The same rule set for the CLI and the MCP tools, now that
  // there is a third front end: the human's. A hand-rolled `addThread` call in
  // extension.ts (now: any host source — split into
  // src/commands/*.ts) would compile fine and skip the integrity gate.
  const extension = readHostSources();

  it("calls opOpenAt rather than the format engine's mutators", () => {
    expect(extension).toContain("opOpenAt(");
    for (const mutator of ["addThread", "addSuggestion", "appendReply", "replaceThread"]) {
      expect(extension, `extension.ts must not call ${mutator} itself`).not.toMatch(
        new RegExp(`\\b${mutator}\\s*\\(`),
      );
    }
  });

  it("writes through a WorkspaceEdit, so the comment is undoable", () => {
    const fnOf = (src: string, sig: string) => {
      const from = src.slice(src.indexOf(sig));
      return from.slice(0, from.indexOf("\n}\n"));
    };
    // The command hands its op to `applyOp`, which runs it through the
    // document's write queue, whose `mutateDocument` lands it as a WorkspaceEdit.
    const body = fnOf(extension, "async function invokeCommentOnSelection");
    expect(body).toContain("applyOp(");
    expect(body).not.toMatch(/fs\.|writeFile/);
    expect(fnOf(extension, "async function applyOp<")).toContain("mutateDocument(");
    const queue = fnOf(readFileSync(join(__dirname, "../collab/documentWriteQueue.ts"), "utf8"), "export function mutateDocument<");
    expect(queue).toContain("new vscode.WorkspaceEdit()");
    expect(queue).toContain("applyEdit");
  });
});
