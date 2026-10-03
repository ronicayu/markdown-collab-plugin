// The read-only editor's character ↔ source map (docs/one-view-design.md).
// The full pipeline — milkdown's parser, the schema attrs, the real bundle —
// is exercised by the webview-e2e gates (readOnlyAlignment/readOnlyComment);
// these pin the pure pieces on inputs small enough to reason about.

import { describe, expect, it } from "vitest";
import {
  SOURCE_ATTR,
  alignRun,
  annotateSourceRuns,
  buildSourceIndex,
  editorSelectionToSource,
  sourceRangeToEditor,
  visibleTextOf,
  type BlockSource,
  type MdNode,
  type PmNodeLike,
  type SourceRun,
} from "../collab/sourcePositions";

const NAMED: Record<string, string> = { amp: "&", copy: "©", nbsp: " " };
const decode = (name: string): string | undefined => NAMED[name];

/** Align `visible` against `markdown` as one run; the source slice under each character, or null. */
function align(markdown: string, visible: string, kind: 0 | 1 = 0): string[] | null {
  const run: SourceRun = [0, markdown.length, visible.length, kind];
  const starts = new Int32Array(visible.length);
  const ends = new Int32Array(visible.length);
  if (!alignRun(markdown, run, visible, decode, starts, ends, 0)) return null;
  return Array.from(starts, (s, i) => markdown.slice(s, ends[i]));
}

describe("alignRun", () => {
  it("maps plain text one to one", () => {
    expect(align("plain", "plain")).toEqual(["p", "l", "a", "i", "n"]);
  });

  it("keeps a backslash escape as one unit, so a marker can't split it", () => {
    expect(align("a\\*b", "a*b")).toEqual(["a", "\\*", "b"]);
    expect(align("a\\\\b", "a\\b")).toEqual(["a", "\\\\", "b"]);
  });

  it("gives every decoded character the whole character reference", () => {
    expect(align("a &amp; b", "a & b")).toEqual(["a", " ", "&amp;", " ", "b"]);
    expect(align("&#169;&copy;", "©©")).toEqual(["&#169;", "&copy;"]);
    // An astral code point decodes to two UTF-16 units; both span the reference.
    expect(align("&#x1F600;!", "\u{1F600}!")).toEqual(["&#x1F600;", "&#x1F600;", "!"]);
  });

  it("leaves an unknown name literal, as the parser does", () => {
    expect(align("&foo;", "&foo;")).toEqual(["&", "f", "o", "o", ";"]);
  });

  it("skips line endings and a continuation line's container prefix", () => {
    // `remarkLineBreak` turns the line ending into a break node: no text.
    const visible = visibleTextOf("one\ntwo", 0);
    expect(visible).toBe("onetwo");
    expect(align("one  \n>   two", visible)).toEqual(["o", "n", "e", "t", "w", "o"]);
  });

  it("drops a code span's fences and its one padding space", () => {
    expect(align("`code`", "code", 1)).toEqual(["c", "o", "d", "e"]);
    expect(align("`` `a` ``", "`a`", 1)).toEqual(["`", "a", "`"]);
  });

  it("maps a line ending inside a code span to the space it renders as", () => {
    expect(align("`a\nb`", "a b", 1)).toEqual(["a", "\n", "b"]);
  });

  it("fails rather than guess when the text isn't in the source", () => {
    expect(align("alpha", "alpah")).toBeNull();
    expect(align("*a*", "a")).toBeNull(); // delimiters are never inside a run
  });
});

/** A positioned mdast leaf. */
function leaf(type: string, value: string, start: number, end: number): MdNode {
  return { type, value, position: { start: { offset: start }, end: { offset: end } } };
}

describe("annotateSourceRuns", () => {
  it("records text and code leaves in order, and nothing for images", () => {
    // "An ![image](x.png) and **the image** `x`"
    const md = "An ![image](x.png) and **the image** `x`";
    const para: MdNode = {
      type: "paragraph",
      position: { start: { offset: 0 }, end: { offset: md.length } },
      children: [
        leaf("text", "An ", 0, 3),
        { type: "image", position: { start: { offset: 3 }, end: { offset: 18 } } },
        leaf("text", " and ", 18, 23),
        {
          type: "strong",
          position: { start: { offset: 23 }, end: { offset: 36 } },
          children: [leaf("text", "the image", 25, 34)],
        },
        leaf("text", " ", 36, 37),
        leaf("inlineCode", "x", 37, 40),
      ],
    };
    annotateSourceRuns({ type: "root", children: [para] });
    const src = para.data?.[SOURCE_ATTR] as BlockSource;
    expect(src.start).toBe(0);
    expect(src.end).toBe(md.length);
    // The image's alt text is not a run — which is exactly what stops "image"
    // there from being counted as an occurrence.
    expect(src.runs).toEqual([
      [0, 3, 3, 0],
      [18, 23, 5, 0],
      [25, 34, 9, 0],
      [36, 37, 1, 0],
      [37, 40, 1, 1],
    ]);
  });

  it("marks a block unmappable when a leaf has lost its position", () => {
    const para: MdNode = {
      type: "paragraph",
      position: { start: { offset: 0 }, end: { offset: 4 } },
      children: [{ type: "text", value: "text" }],
    };
    annotateSourceRuns({ type: "root", children: [para] });
    expect((para.data?.[SOURCE_ATTR] as BlockSource).runs).toBeNull();
  });
});

// --- a ProseMirror-shaped document, just enough for the index -------------------

function text(value: string): PmNodeLike {
  return { isText: true, text: value, nodeSize: value.length, attrs: {}, type: { name: "text" }, descendants: () => {} };
}

function node(name: string, attrs: Record<string, unknown>, children: PmNodeLike[]): PmNodeLike {
  const self: PmNodeLike = {
    isText: false,
    nodeSize: 2 + children.reduce((n, c) => n + c.nodeSize, 0),
    attrs,
    type: { name },
    // ProseMirror's contract: positions relative to this node's content,
    // `false` skips a child's subtree.
    descendants: (cb) => {
      let pos = 0;
      for (const child of children) {
        if (cb(child, pos, self) !== false) child.descendants((n, p, parent) => cb(n, pos + 1 + p, parent));
        pos += child.nodeSize;
      }
    },
  };
  return self;
}

// "Some **bold** text\n\n```\ncode\n```\n" as the editor holds it: a paragraph
// (content starts at position 1) and a code block after it.
const MD = "Some **bold** text\n\n```\ncode\n```\n";
function doc(runs: SourceRun[] | null = [[0, 5, 5, 0], [7, 11, 4, 0], [13, 18, 5, 0]]): PmNodeLike {
  const para = node("paragraph", { [SOURCE_ATTR]: { start: 0, end: 18, runs } }, [text("Some "), text("bold"), text(" text")]);
  return node("doc", {}, [para, node("code_block", {}, [text("code")])]);
}

describe("source index", () => {
  it("decorates exactly the characters whose bytes are inside the anchor", () => {
    const index = buildSourceIndex(doc(), MD, decode);
    // "bold" is source [7, 11); in the editor, positions 6..9.
    expect(sourceRangeToEditor(index, 7, 11)).toEqual([{ from: 6, to: 10 }]);
    // An anchor that wraps the delimiters covers the same characters.
    expect(sourceRangeToEditor(index, 5, 13)).toEqual([{ from: 6, to: 10 }]);
    // A span with no visible character inside decorates nothing.
    expect(sourceRangeToEditor(index, 5, 7)).toEqual([]);
  });

  it("maps a selection back to the bytes under it, trimmed of whitespace", () => {
    const index = buildSourceIndex(doc(), MD, decode);
    expect(editorSelectionToSource(index, 6, 10)).toEqual({ ok: true, start: 7, end: 11, text: "bold" });
    // Across the closing delimiter: the markers wrap it.
    expect(editorSelectionToSource(index, 5, 13)).toEqual({ ok: true, start: 7, end: 16, text: "bold te" });
  });

  it("refuses a selection it can't place, with a reason", () => {
    const index = buildSourceIndex(doc(), MD, decode);
    expect(editorSelectionToSource(index, 5, 6)).toEqual({ ok: false, reason: "empty" }); // the space
    expect(editorSelectionToSource(index, 12, 25)).toEqual({ ok: false, reason: "code" }); // into the code block
    const unmapped = buildSourceIndex(doc(null), MD, decode);
    expect(editorSelectionToSource(unmapped, 6, 10)).toEqual({ ok: false, reason: "unmapped" });
    expect(sourceRangeToEditor(unmapped, 7, 11)).toEqual([]);
  });

  it("leaves a block unmapped when its text disagrees with its runs", () => {
    // Run lengths that don't sum to the block's text: some pipeline step
    // changed the text. Nothing inside it is trusted.
    const index = buildSourceIndex(doc([[0, 5, 5, 0], [7, 11, 4, 0]]), MD, decode);
    expect(sourceRangeToEditor(index, 7, 11)).toEqual([]);
    expect(editorSelectionToSource(index, 6, 10)).toEqual({ ok: false, reason: "unmapped" });
  });
});
