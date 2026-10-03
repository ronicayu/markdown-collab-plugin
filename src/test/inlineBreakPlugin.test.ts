import { describe, expect, it } from "vitest";
import { convertInlineBreaks, type MdastNode } from "../webview/plugins/inlineBreakPlugin";

// Pure-function coverage for the mdast reclassification `inlineBreakPlugin`
// applies. The webview-e2e suite (liveEditorRenderParity.spec.ts) covers the
// actual rendered outcome through the shipped bundle; this pins the tree
// transform in isolation, including the "leave it alone" case that protects
// the empty-paragraph round-trip (see the file's header comment).

function textNode(value: string): MdastNode {
  return { type: "text", value };
}

function brNode(value = "<br />"): MdastNode {
  return { type: "html", value };
}

describe("convertInlineBreaks", () => {
  it("reclassifies an inline <br> that has siblings into a break node", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        { type: "paragraph", children: [textNode("Line one"), brNode(), textNode("Line two")] },
      ],
    };
    convertInlineBreaks(tree);
    const para = tree.children![0]!;
    expect(para.children!.map((n) => n.type)).toEqual(["text", "break", "text"]);
    expect(para.children![1]!.value).toBeUndefined();
  });

  it("leaves a lone <br> (sole child) as an html node", () => {
    // This is the shape commonmark's own remarkPreserveEmptyLinePlugin writes
    // as a placeholder for an empty paragraph, and later strips back out —
    // reclassifying it here would break that round-trip.
    const tree: MdastNode = {
      type: "root",
      children: [{ type: "paragraph", children: [brNode()] }],
    };
    convertInlineBreaks(tree);
    const para = tree.children![0]!;
    expect(para.children![0]!.type).toBe("html");
    expect(para.children![0]!.value).toBe("<br />");
  });

  it("recognizes every <br> spelling remark-parse can produce", () => {
    for (const spelling of ["<br>", "<br/>", "<br />", "<br >"]) {
      const tree: MdastNode = {
        type: "root",
        children: [{ type: "paragraph", children: [textNode("a"), brNode(spelling), textNode("b")] }],
      };
      convertInlineBreaks(tree);
      expect(tree.children![0]!.children![1]!.type).toBe("break");
    }
  });

  it("does not touch an html node that isn't a <br>", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        { type: "paragraph", children: [textNode("a"), { type: "html", value: "<kbd>Esc</kbd>" }, textNode("b")] },
      ],
    };
    convertInlineBreaks(tree);
    expect(tree.children![0]!.children![1]!.type).toBe("html");
  });

  it("leaves a block-level standalone <br> alone even with block siblings", () => {
    // A `<br>` alone on its own line, surrounded by blank lines, parses as an
    // "html" node whose parent is "root" — a block container, not yet
    // wrapped into a paragraph (remarkHtmlTransformer does that later). Root
    // almost always has multiple children (every other block in the doc), so
    // checking *sibling count* here would wrongly reclassify it; the parent's
    // type is what actually distinguishes this from genuine inline content.
    const tree: MdastNode = {
      type: "root",
      children: [{ type: "heading", children: [textNode("Doc")] }, brNode(), { type: "paragraph", children: [textNode("After.")] }],
    };
    convertInlineBreaks(tree);
    expect(tree.children![1]!.type).toBe("html");
    expect(tree.children![1]!.value).toBe("<br />");
  });

  it("recurses into nested containers (list items, blockquotes)", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        {
          type: "blockquote",
          children: [
            { type: "paragraph", children: [textNode("a"), brNode(), textNode("b")] },
          ],
        },
      ],
    };
    convertInlineBreaks(tree);
    const inner = tree.children![0]!.children![0]!;
    expect(inner.children![1]!.type).toBe("break");
  });
});
