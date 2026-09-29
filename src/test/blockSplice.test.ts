// Edit mode's block-splice write-back (docs/one-view-design.md, "Phase B"),
// host half and the pure diff. The whole path — a keystroke in the shipped
// bundle, its `edit-blocks` message, this splice — is gated on every block of
// the spike's 17 documents in webview-e2e/blockSplice.spec.ts; these pin the
// pieces on documents small enough to reason about.

import { describe, expect, it } from "vitest";
import { applyBlockEdits, proseOf } from "../collab/inlineBridge";
import { diffBlocks, markdownBlockNodes } from "../collab/blockEdits";
import type { BlockEdit } from "../collab/blockEdits";
import { editorBlockCount, markdownBlocks, spliceMarkdownBlocks } from "../collab/sourcePositions";
import { checkpointFor } from "../inlineComments/deltaReview";
import { addSuggestion, addThread, parse, withThreads } from "../inlineComments/format";
import { oneViewCorpus } from "./support/oneViewCorpus";

const TS = "2026-09-29T00:00:00.000Z";

/** The editor's block types for `source` — what the webview sends as `baseTypes`. */
function typesOf(source: string): string[] {
  const blocks = markdownBlocks(proseOf(source));
  return blocks.slice(0, editorBlockCount(blocks)).map((b) => b.type);
}

function splice(source: string, edits: BlockEdit[]): ReturnType<typeof applyBlockEdits> {
  return applyBlockEdits(source, { baseTypes: typesOf(source), edits });
}

function ok(r: ReturnType<typeof applyBlockEdits>): Extract<ReturnType<typeof applyBlockEdits>, { ok: true }> {
  if (!r.ok) throw new Error(r.error);
  return r;
}

function withThread(source: string, text: string, occurrence = 0): string {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = source.indexOf(text, at + 1);
  return addThread(source, at, at + text.length, { author: "ronica", body: `on ${text}`, ts: TS }).source;
}

/** The text between a thread's markers, or null when it has none. */
function anchored(source: string, id: string): string | null {
  const a = parse(source).anchors.get(id);
  return a ? source.slice(a.openEnd, a.closeStart) : null;
}

const regionOf = (source: string): string => {
  const r = parse(source).threadsRegion;
  return r ? source.slice(r.start, r.end) : "";
};

const DOC = [
  "---",
  "title: T",
  "---",
  "# Notes",
  "",
  "The parser handles nested lists.",
  "",
  "- one",
  "- two",
  "",
  "Last paragraph here.",
  "",
].join("\n");

describe("applyBlockEdits: a keystroke changes its own block only", () => {
  it("rewrites the edited paragraph and no other byte", () => {
    const r = ok(splice(DOC, [{ from: 1, to: 2, markdown: "The parser handles nested lists!", types: ["paragraph"] }]));
    expect(r.source).toBe(DOC.replace("nested lists.", "nested lists!"));
    expect(r.range).toEqual({
      start: DOC.indexOf("The parser"),
      end: DOC.indexOf("lists.") + "lists.".length,
      text: "The parser handles nested lists!",
    });
    expect(r.restructured).toBe(false);
    expect(r.blocks).toEqual(markdownBlocks(proseOf(r.source)));
  });

  it("re-anchors a thread inside the block and leaves every other marker and the threads block alone", () => {
    const source = withThread(withThread(withThread(DOC, "parser"), "Notes"), "Last paragraph");
    const [notes, parser, last] = parse(source).threads.map((t) => t.id);
    const r = ok(splice(source, [{ from: 1, to: 2, markdown: "A new parser handles nested lists.", types: ["paragraph"] }]));
    expect(anchored(r.source, parser!)).toBe("parser");
    expect(r.source.indexOf("A new <!--mc:a:")).toBeGreaterThan(0);
    expect(anchored(r.source, notes!)).toBe("Notes");
    expect(anchored(r.source, last!)).toBe("Last paragraph");
    expect(regionOf(r.source)).toBe(regionOf(source));
    // Outside the paragraph's line, the file is byte-for-byte what it was.
    const line = (s: string): string => s.split("\n").find((l) => l.includes("handles"))!;
    expect(r.source.split("\n").filter((l) => !l.includes("handles"))).toEqual(
      source.split("\n").filter((l) => !l.includes("handles")),
    );
    expect(line(r.source).replace(/<!--mc:\/?a:[a-z0-9]+-->/g, "")).toBe("A new parser handles nested lists.");
  });

  it("drops the markers of a thread whose text the edit deleted, keeping its record", () => {
    const source = withThread(DOC, "nested lists");
    const id = parse(source).threads[0]!.id;
    const r = ok(splice(source, [{ from: 1, to: 2, markdown: "The parser is done.", types: ["paragraph"] }]));
    expect(r.unanchored).toEqual([id]);
    expect(parse(r.source).anchors.has(id)).toBe(false);
    expect(regionOf(r.source)).toBe(regionOf(source));
  });

  it("gives a marker-less thread its markers back when its text returns to the block (undo)", () => {
    const source = withThread(DOC, "nested lists");
    const id = parse(source).threads[0]!.id;
    const deleted = ok(splice(source, [{ from: 1, to: 2, markdown: "The parser is done.", types: ["paragraph"] }])).source;
    const undone = ok(splice(deleted, [{ from: 1, to: 2, markdown: "The parser handles nested lists.", types: ["paragraph"] }]));
    expect(anchored(undone.source, id)).toBe("nested lists");
  });

  it("keeps pending suggestions and the review checkpoint", () => {
    const at = DOC.indexOf("Last paragraph");
    const withSuggestion = addSuggestion(DOC, at, at + 4, { author: "claude", proposed: "Final", ts: TS }).source;
    const source = withThreads(withSuggestion, [], undefined, checkpointFor(withSuggestion, () => TS));
    const r = ok(splice(source, [{ from: 1, to: 2, markdown: "Edited.", types: ["paragraph"] }]));
    expect(parse(r.source).suggestions).toEqual(parse(source).suggestions);
    expect(parse(r.source).checkpoint).toEqual(parse(source).checkpoint);
    expect(anchored(r.source, parse(source).suggestions[0]!.anchorId)).toBe("Last");
  });

  it("keeps a thread through the serializer's normalization of the rest of the block", () => {
    // Milkdown writes `**a `b` c**` as `**a** **`b`** **c**`: the words move,
    // and there are two "writes" to choose from. The token alignment keeps the
    // thread on the one it was on.
    const source = withThread("**0.2 `mdc` writes raw; the MCP path writes through.**\n", "writes", 1);
    const id = parse(source).threads[0]!.id;
    const r = ok(
      splice(source, [
        { from: 0, to: 1, markdown: "**0.2** **`mdc`** **writes raw; the MCP path writes through.Z**", types: ["paragraph"] },
      ]),
    );
    expect(r.source.indexOf("path <!--mc:a:")).toBeGreaterThan(0);
    expect(anchored(r.source, id)).toBe("writes");
  });

  it("keeps a thread nested inside another, as the file had it", () => {
    const source = withThread(withThread(DOC, "handles nested lists"), "nested");
    const [outer, inner] = parse(source).threads.map((t) => t.id);
    const r = ok(splice(source, [{ from: 1, to: 2, markdown: "The parser handles nested lists correctly.", types: ["paragraph"] }]));
    expect(r.unanchored).toEqual([]);
    expect(anchored(r.source, outer!)).toBe(`handles <!--mc:a:${inner}-->nested<!--mc:/a:${inner}--> lists`);
  });

  it("takes `<!--mc:` inside code as the text it is", () => {
    const source = "Markers look like `<!--mc:a:x-->`.\n";
    const r = ok(splice(source, [{ from: 0, to: 1, markdown: "Markers look like `<!--mc:a:x-->`!", types: ["paragraph"] }]));
    expect(r.source).toBe("Markers look like `<!--mc:a:x-->`!\n");
  });

  it("moves markers glued to the block's edges with it", () => {
    const source = withThread(DOC, "The parser handles nested lists.");
    const id = parse(source).threads[0]!.id;
    const r = ok(splice(source, [{ from: 1, to: 2, markdown: "The parser handles nested lists.!", types: ["paragraph"] }]));
    expect(anchored(r.source, id)).toBe("The parser handles nested lists.");
  });

  it("keeps the outside marker of a thread that crosses the block's edge", () => {
    const at = DOC.indexOf("handles");
    const end = DOC.indexOf("one") + 3;
    const { source, thread } = addThread(DOC, at, end, { author: "ronica", body: "x", ts: TS });
    const r = ok(splice(source, [{ from: 2, to: 3, markdown: "- one more\n- two", types: ["bullet_list"] }]));
    const a = parse(r.source).anchors.get(thread.id)!;
    expect(r.source.slice(0, a.openStart)).toBe(source.slice(0, parse(source).anchors.get(thread.id)!.openStart));
    expect(r.source.slice(a.openEnd, a.closeStart)).toBe("handles nested lists.\n\n- one");
  });

  it("splices a split over the one block it came from", () => {
    const r = ok(
      splice(DOC, [{ from: 1, to: 2, markdown: "The parser handles\n\nnested lists.", types: ["paragraph", "paragraph"] }]),
    );
    expect(r.source).toBe(DOC.replace("handles nested", "handles\n\nnested"));
    expect(r.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph", "bullet_list", "paragraph"]);
  });

  it("splices a merge over the union of the blocks it joined", () => {
    const r = ok(splice(DOC, [{ from: 0, to: 2, markdown: "# NotesThe parser handles nested lists.", types: ["heading"] }]));
    expect(r.source).toBe(DOC.replace("# Notes\n\nThe parser", "# NotesThe parser"));
  });

  it("inserts a block between two, before the first, and after the last", () => {
    const between = ok(splice(DOC, [{ from: 1, to: 1, markdown: "<br />", types: ["paragraph"] }]));
    expect(between.source).toBe(DOC.replace("# Notes\n\n", "# Notes\n\n<br />\n\n"));
    const first = ok(splice(DOC, [{ from: 0, to: 0, markdown: "Intro.", types: ["paragraph"] }]));
    expect(first.source).toBe(DOC.replace("---\n# Notes", "---\nIntro.\n\n# Notes"));
    const last = ok(splice(DOC, [{ from: 4, to: 4, markdown: "Appendix.", types: ["paragraph"] }]));
    expect(last.source).toBe(DOC.replace("here.\n", "here.\n\nAppendix.\n"));
    for (const r of [between, first, last]) expect(r.restructured).toBe(false);
  });

  it("deletes a block with one separator, so blank lines don't pile up", () => {
    expect(ok(splice(DOC, [{ from: 2, to: 3, markdown: "", types: [] }])).source).toBe(DOC.replace("- one\n- two\n\n", ""));
    expect(ok(splice(DOC, [{ from: 0, to: 1, markdown: "", types: [] }])).source).toBe(DOC.replace("# Notes\n\n", ""));
  });

  it("splices two edits of one message independently", () => {
    const r = ok(
      splice(DOC, [
        { from: 0, to: 1, markdown: "# Notes!", types: ["heading"] },
        { from: 3, to: 4, markdown: "Last paragraph there.", types: ["paragraph"] },
      ]),
    );
    expect(r.source).toBe(DOC.replace("# Notes", "# Notes!").replace("here.", "there."));
  });

  it("types into an empty document and deletes everything", () => {
    const typed = ok(applyBlockEdits("", { baseTypes: [], edits: [{ from: 0, to: 0, markdown: "Hi", types: ["paragraph"] }] }));
    expect(typed.source).toBe("Hi");
    const emptied = ok(splice(DOC, [{ from: 0, to: 4, markdown: "", types: [] }]));
    expect(proseOf(emptied.source).trim()).toBe("");
    expect(emptied.source.startsWith("---\ntitle: T\n---\n")).toBe(true);
  });
});

describe("applyBlockEdits: list markers", () => {
  it("keeps a list's own bullet instead of the serializer's `*`", () => {
    const r = ok(splice(DOC, [{ from: 2, to: 3, markdown: "* one\n* twos", types: ["bullet_list"] }]));
    expect(r.source).toBe(DOC.replace("- two", "- twos"));
  });

  it("keeps an ordered list's delimiter, so it doesn't merge with the next list", () => {
    const source = "1) paren\n2) second\n\n3. three\n4. four\n";
    const r = ok(splice(source, [{ from: 0, to: 1, markdown: "1. paren\n2. secondZ", types: ["ordered_list"] }]));
    expect(r.source).toBe("1) paren\n2) secondZ\n\n3. three\n4. four\n");
    expect(r.restructured).toBe(false);
  });
});

describe("applyBlockEdits: refusals and restructuring", () => {
  it("refuses when the editor's blocks aren't the file's", () => {
    const r = applyBlockEdits(DOC, {
      baseTypes: ["heading", "paragraph", "paragraph", "paragraph"],
      edits: [{ from: 1, to: 2, markdown: "x", types: ["paragraph"] }],
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("block 3 is paragraph in the editor and bullet_list in the file") });
  });

  it("refuses an edit that isn't blocks of this document", () => {
    expect(splice(DOC, [{ from: 3, to: 9, markdown: "x", types: ["paragraph"] }]).ok).toBe(false);
    expect(splice(DOC, [{ from: 2, to: 1, markdown: "x", types: ["paragraph"] }]).ok).toBe(false);
    expect(
      splice(DOC, [
        { from: 1, to: 2, markdown: "x", types: ["paragraph"] },
        { from: 2, to: 3, markdown: "y", types: ["paragraph"] },
      ]).ok,
    ).toBe(false);
  });

  it("refuses new text carrying a review marker", () => {
    const r = splice(DOC, [{ from: 1, to: 2, markdown: "x <!--mc:a:zz-->y", types: ["paragraph"] }]);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("review marker") });
  });

  it("refuses a block whose bytes run through the threads region", () => {
    const source = "Para one\n<!--mc:threads:begin-->\n<!--mc:threads:end-->\nstill the same paragraph.\n";
    expect(typesOf(source)).toEqual(["paragraph"]);
    const r = splice(source, [{ from: 0, to: 1, markdown: "Edited.", types: ["paragraph"] }]);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("comment threads") });
  });

  it("writes an edit that merges with a neighbour, and says the editor must re-read the file", () => {
    const source = "Intro.\n\n- a\n- b\n";
    const r = ok(splice(source, [{ from: 0, to: 1, markdown: "- x", types: ["bullet_list"] }]));
    expect(r.source).toBe("- x\n\n- a\n- b\n");
    expect(r.restructured).toBe(true);
    expect(r.blocks.map((b) => b.type)).toEqual(["bullet_list"]);
  });
});

describe("the block table", () => {
  it("lists what milkdown makes top-level nodes of, and nothing else", () => {
    const md = [
      "# ATX",
      "Setext",
      "------",
      "para",
      "",
      "***",
      "",
      "```js\ncode\n```",
      "",
      "    indented",
      "",
      "> quote",
      "",
      "- a",
      "",
      "1. b",
      "",
      "| h |\n| - |\n| c |",
      "",
      "<div>html</div>",
      "",
      "[ref]: https://example.com",
      "",
      "Text.[^1]",
      "",
      "[^1]: Note.",
      "",
      "<br />",
      "",
    ].join("\n");
    const blocks = markdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "hr",
      "code_block",
      "code_block",
      "blockquote",
      "bullet_list",
      "ordered_list",
      "table",
      "paragraph",
      "paragraph",
      "footnote_definition",
      "paragraph",
    ]);
    // The trailing `<br />` is milkdown's empty-paragraph placeholder, which the editor doesn't count.
    expect(blocks[blocks.length - 1]!.placeholder).toBe(true);
    expect(editorBlockCount(blocks)).toBe(blocks.length - 1);
    expect(md.slice(blocks[4]!.start, blocks[4]!.end)).toBe("```js\ncode\n```");
  });

  // The incremental update must agree with a full parse whenever it answers:
  // replace blocks of each corpus document with text that may or may not stay
  // one block of the same type, and compare. Every block of the short
  // documents with every replacement; the long ones (a full parse is ~40 ms)
  // every tenth block with the replacements that reach furthest.
  it("updates in place exactly when a full parse agrees", () => {
    const replacements = ["Z", "- x", "# h", "```", "    code", "<!--", "===", "---", "| a |\n| - |", "[x]: /y", "<br />", "> q"];
    const farReaching = ["- x", "```", "<!--", "==="];
    let answered = 0;
    let declined = 0;
    for (const doc of oneViewCorpus()) {
      if (doc.name === "CHANGELOG") continue; // same shapes as README, 17× the blocks
      const prose = proseOf(doc.source);
      const blocks = markdownBlocks(prose);
      const long = prose.length > 5000;
      for (let i = 0; i < blocks.length; i += long ? 10 : 1) {
        const own = prose.slice(blocks[i]!.start, blocks[i]!.end) + "Z";
        for (const text of [own, ...(long ? farReaching : replacements)]) {
          const next = prose.slice(0, blocks[i]!.start) + text + prose.slice(blocks[i]!.end);
          const full = markdownBlocks(next);
          const types = markdownBlocks(text).map((b) => b.type);
          const s = { from: i, to: i + 1, start: blocks[i]!.start, end: blocks[i]!.end, length: text.length, types };
          const table = spliceMarkdownBlocks(blocks, next, [s]);
          if (table) {
            answered++;
            expect(table, `${doc.name} block ${i} → ${JSON.stringify(text)}`).toEqual(full);
          } else {
            declined++;
          }
        }
      }
    }
    expect(answered).toBeGreaterThan(400);
    expect(declined).toBeGreaterThan(0);
  });
});

describe("diffBlocks", () => {
  interface N {
    type: { name: string };
    content: { size: number };
    md: string;
  }
  const node = (md: string): N => ({ type: { name: "paragraph" }, content: { size: md.length }, md });
  const same = (a: N, b: N): boolean => a.md === b.md;
  const range = (changes: Array<{ from: number; to: number; nodes: N[] }>) =>
    changes.map((c) => ({ from: c.from, to: c.to, md: c.nodes.map((n) => n.md) }));

  it("reports only the node a step rebuilt", () => {
    const base = ["a", "b", "c"].map(node);
    expect(range(diffBlocks(base, [base[0]!, node("bZ"), base[2]!], same))).toEqual([{ from: 1, to: 2, md: ["bZ"] }]);
  });

  it("drops a rebuilt node whose Markdown didn't change", () => {
    const base = ["a", "b"].map(node);
    expect(diffBlocks(base, [node("a"), base[1]!], same)).toEqual([]);
  });

  it("keeps two edits in one debounce as two changes", () => {
    const base = ["a", "b", "c"].map(node);
    expect(range(diffBlocks(base, [node("a!"), base[1]!, node("c!")], same))).toEqual([
      { from: 0, to: 1, md: ["a!"] },
      { from: 2, to: 3, md: ["c!"] },
    ]);
    expect(range(diffBlocks(base, [node("a!"), node("b"), node("c!")], same))).toEqual([
      { from: 0, to: 1, md: ["a!"] },
      { from: 2, to: 3, md: ["c!"] },
    ]);
  });

  it("makes a split and a merge one change over the union", () => {
    const base = ["x", "ab", "y"].map(node);
    expect(range(diffBlocks(base, [base[0]!, node("a"), node("b"), base[2]!], same))).toEqual([
      { from: 1, to: 2, md: ["a", "b"] },
    ]);
    const two = ["x", "a", "b", "y"].map(node);
    expect(range(diffBlocks(two, [two[0]!, node("ab"), two[3]!], same))).toEqual([{ from: 1, to: 3, md: ["ab"] }]);
  });

  it("sees Enter at a block's end as an insertion after it", () => {
    const base = ["a", "b"].map(node);
    expect(range(diffBlocks(base, [node("a"), node(""), base[1]!], same))).toEqual([{ from: 1, to: 1, md: [""] }]);
  });

  it("sees a dragged block as one deletion and one insertion", () => {
    const base = ["a", "b", "c", "d"].map(node);
    expect(range(diffBlocks(base, [base[0]!, base[3]!, base[1]!, base[2]!], same))).toEqual([
      { from: 1, to: 1, md: ["d"] },
      { from: 3, to: 4, md: [] },
    ]);
  });

  it("leaves out a trailing empty paragraph, milkdown's placeholder", () => {
    const nodes = [node("a"), node("")];
    const doc = { childCount: 2, child: (i: number) => nodes[i]! };
    expect(markdownBlockNodes(doc)).toEqual([nodes[0]]);
  });
});
