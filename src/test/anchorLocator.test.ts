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
});
