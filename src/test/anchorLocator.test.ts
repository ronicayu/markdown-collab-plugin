import { describe, expect, it } from "vitest";
import { stripInlineMarkup } from "../collab/anchorExtractor";
import { locateAnchorInRendered, mdRangeToRenderedRange } from "../collab/anchorLocator";

function strip(md: string): { stripped: string; map: number[] } {
  return stripInlineMarkup(md);
}

describe("locateAnchorInRendered", () => {
  it("locates a plain-text anchor in the rendered text", () => {
    const md = "Hello world. This is a paragraph with the anchor target string.";
    const r = locateAnchorInRendered(
      {
        text: "the anchor target string",
        contextBefore: "paragraph with ",
        contextAfter: ".",
      },
      md,
      strip(md),
    );
    expect(r).not.toBeNull();
    // Rendered text equals the markdown source here (no markup to strip).
    expect(md.slice(r!.start, r!.end)).toBe("the anchor target string");
  });

  it("locates an anchor that spans link markup, returning rendered offsets that skip the markup", () => {
    const md = "Click [the docs](http://x.com) for more details.";
    const positionMap = strip(md);
    // Anchor stored by the WYSIWYG extractor when the user selected
    // "the docs for more details" in rendered text — anchor.text covers
    // the link's URL markup.
    const anchor = {
      text: "the docs](http://x.com) for more details",
      contextBefore: "Click [",
      contextAfter: ".",
    };
    const r = locateAnchorInRendered(anchor, md, positionMap);
    expect(r).not.toBeNull();
    // Rendered text = "Click the docs for more details."
    // The matching range should cover "the docs for more details" (no
    // markup chars).
    expect(positionMap.stripped.slice(r!.start, r!.end)).toBe("the docs for more details");
  });

  it("returns null when the anchor doesn't resolve in the markdown source", () => {
    const md = "Some unrelated text.";
    const r = locateAnchorInRendered(
      {
        text: "definitely not here",
        contextBefore: "",
        contextAfter: "",
      },
      md,
      strip(md),
    );
    expect(r).toBeNull();
  });
});

describe("mdRangeToRenderedRange", () => {
  it("translates 1:1 when there is no markup between the bounds", () => {
    const md = "abcdefghij";
    const positionMap = strip(md);
    const r = mdRangeToRenderedRange(2, 7, positionMap);
    expect(r).toEqual({ start: 2, end: 7 });
  });

  it("collapses skipped link-URL markup so the rendered range is shorter than the markdown range", () => {
    const md = "x [foo](http://y.com) z";
    const positionMap = strip(md);
    // Markdown range covers "[foo](http://y.com)" → md positions 2..21
    const r = mdRangeToRenderedRange(2, 21, positionMap);
    expect(r).not.toBeNull();
    // Rendered text is "x foo z"; the rendered range covers "foo".
    expect(positionMap.stripped.slice(r!.start, r!.end)).toBe("foo");
  });

  it("returns null when the range falls entirely on stripped markup", () => {
    const md = "x [foo](http://y.com) z";
    const positionMap = strip(md);
    // The range "(http://y.com)" → md positions 6..21 — all of these
    // chars are stripped (URL part of the link), so no rendered chars
    // fall inside.
    const r = mdRangeToRenderedRange(7, 20, positionMap);
    expect(r).toBeNull();
  });

  it("translates a range that starts at md position 0", () => {
    const md = "abcdefghij";
    const r = mdRangeToRenderedRange(0, 5, strip(md));
    expect(r).toEqual({ start: 0, end: 5 });
  });

  it("translates a range that ends at md.length", () => {
    const md = "abcdefghij";
    const r = mdRangeToRenderedRange(5, md.length, strip(md));
    expect(r).toEqual({ start: 5, end: 10 });
  });

  it("returns null when mdEnd === mdStart (zero-length range)", () => {
    const md = "abcdef";
    expect(mdRangeToRenderedRange(2, 2, strip(md))).toBeNull();
  });

  it("returns null for an empty source", () => {
    expect(mdRangeToRenderedRange(0, 0, strip(""))).toBeNull();
  });

  it("translates correctly across multiple stripped runs back-to-back", () => {
    const md = "x **A** *B* z";
    const positionMap = strip(md);
    // stripped = "x A B z"
    expect(positionMap.stripped).toBe("x A B z");
    // Range covering "A B" → stripped positions 2..5
    // Reverse to md positions: A is at md 4, B is at md 9
    // Range covering A-to-B in md = [4, 10) (just past 'B' at md 9)
    const r = mdRangeToRenderedRange(4, 10, positionMap);
    expect(r).not.toBeNull();
    expect(positionMap.stripped.slice(r!.start, r!.end)).toBe("A B");
  });
});

describe("locateAnchorInRendered — additional scenarios", () => {
  it("locates an anchor immediately at the start of the doc", () => {
    const md = "Foo bar baz, this is the second sentence.";
    const r = locateAnchorInRendered(
      { text: "Foo bar baz", contextBefore: "", contextAfter: "," },
      md,
      strip(md),
    );
    expect(r).not.toBeNull();
    expect(r!.start).toBe(0);
  });

  it("locates an anchor at the very end of the doc", () => {
    const md = "Beginning, then the final clause string here";
    const r = locateAnchorInRendered(
      { text: "the final clause string here", contextBefore: "then ", contextAfter: "" },
      md,
      strip(md),
    );
    expect(r).not.toBeNull();
    expect(md.slice(r!.start, r!.end)).toBe("the final clause string here");
  });

  it("locates an anchor inside a heading (block-level prefix is preserved)", () => {
    const md = "# Heading title that is long enough\n\nBody.";
    const r = locateAnchorInRendered(
      { text: "Heading title that is long", contextBefore: "# ", contextAfter: " enough" },
      md,
      strip(md),
    );
    expect(r).not.toBeNull();
    expect(md.slice(r!.start, r!.end)).toBe("Heading title that is long");
  });

  it("returns null when the anchor text doesn't appear at all", () => {
    const md = "Some unrelated content.";
    const r = locateAnchorInRendered(
      { text: "definitely not in there", contextBefore: "", contextAfter: "" },
      md,
      strip(md),
    );
    expect(r).toBeNull();
  });
});
