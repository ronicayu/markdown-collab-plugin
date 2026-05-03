// Tests for the WYSIWYG anchor extractor.
//
// The extractor takes:
//   - renderedText: the full rendered (display) text of the editor
//   - selStart / selEnd: offsets into renderedText
//   - markdownSource: the markdown serialization of the same doc
// and returns an Anchor that, when resolved against `markdownSource` by
// the existing anchor.resolve() helper, points back to the *same* passage
// in the markdown that the user actually selected in the rendered view.
//
// The bug we're guarding against: an earlier extractor used
// `markdownSource.indexOf(selectedText)` which always picks the first
// occurrence — so selecting the link label "here" inside `[here](url)`
// in a doc that ALSO has a bare "here" earlier would silently anchor on
// the bare one. Resolution would succeed but to the wrong passage.

import { describe, expect, it } from "vitest";
import { resolve } from "../anchor";
import { buildAnchorFromSelection } from "../collab/anchorExtractor";

describe("buildAnchorFromSelection", () => {
  it("returns null when the selection is too short", () => {
    const md = "Click here please";
    const r = buildAnchorFromSelection(md, 6, 10, md);
    // "here" is only 4 non-whitespace chars; below MIN_ANCHOR_NON_WS_CHARS.
    expect(r).toBeNull();
  });

  it("anchors plain selection with no markup", () => {
    const md = "This paragraph contains the anchor target string here.";
    // select "the anchor target string here"
    const start = md.indexOf("the anchor target string here");
    const end = start + "the anchor target string here".length;
    const anchor = buildAnchorFromSelection(md, start, end, md);
    expect(anchor).not.toBeNull();
    const resolved = resolve(md, anchor!);
    expect(resolved).not.toBeNull();
    expect(md.slice(resolved!.start, resolved!.end)).toBe("the anchor target string here");
  });

  it("anchors a selection that crosses a markdown link", () => {
    // Rendered text: "Click here in the docs to find more details"
    // Markdown source: "Click [here](http://x.com) in the docs to find more details"
    // The user selects the link label + a few words after it. The
    // anchor we store must include the link's URL markup so it points
    // unambiguously at the bracketed occurrence in the markdown source.
    const rendered = "Click here in the docs to find more details";
    const markdown = "Click [here](http://x.com) in the docs to find more details";
    const sel = "here in the docs";
    const start = rendered.indexOf(sel);
    const end = start + sel.length;
    const anchor = buildAnchorFromSelection(rendered, start, end, markdown);
    expect(anchor).not.toBeNull();
    // The anchor text now includes the URL markup that the rendered
    // selection crossed — that's the only way to make it unique against
    // the markdown source.
    expect(anchor!.text).toBe("here](http://x.com) in the docs");
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
    // The bracketed occurrence is what the user selected.
    const expectedStart = markdown.indexOf("here](http://x.com)");
    expect(resolved!.start).toBe(expectedStart);
  });

  it("anchors text inside a link when bare occurrences exist elsewhere", () => {
    // The bug pattern users reported: "here" appears bare AND inside
    // [here](url). Selecting through the link should anchor to the
    // bracketed occurrence, never the bare one.
    const rendered = "I am here. Click here for more details about it.";
    const markdown = "I am here. Click [here](http://example.com) for more details about it.";
    const sel = "Click here for more details";
    const start = rendered.indexOf(sel);
    const end = start + sel.length;
    const anchor = buildAnchorFromSelection(rendered, start, end, markdown);
    expect(anchor).not.toBeNull();
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
    // The resolved span should land on the bracketed occurrence, not
    // the bare "here" earlier in the doc.
    const expectedStart = markdown.indexOf("Click [here]");
    expect(resolved!.start).toBe(expectedStart);
    // Anchor text spans across the link's bracket + URL markup.
    expect(anchor!.text).toBe("Click [here](http://example.com) for more details");
  });

  // ----- Coverage for the "selection contains a link" user-reported bug -----

  it("link-only selection returns an anchor when the rendered link text is long enough", () => {
    // Rendered: "Read the documentation now."
    // User drag-selects the link text "the documentation".
    const rendered = "Read the documentation now.";
    const markdown = "Read [the documentation](http://example.com/docs) now.";
    const sel = "the documentation";
    const start = rendered.indexOf(sel);
    const end = start + sel.length;
    const anchor = buildAnchorFromSelection(rendered, start, end, markdown);
    expect(anchor).not.toBeNull();
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
    // Stored anchor text should land on the bracketed label (no markup
    // crossed because the selection didn't extend past the closing `]`).
    expect(markdown.slice(resolved!.start, resolved!.end)).toBe("the documentation");
  });

  it("selection that extends from inside the link out into surrounding text", () => {
    const rendered = "Read the documentation now please.";
    const markdown = "Read [the documentation](http://example.com/docs) now please.";
    const sel = "documentation now please";
    const start = rendered.indexOf(sel);
    const end = start + sel.length;
    const anchor = buildAnchorFromSelection(rendered, start, end, markdown);
    expect(anchor).not.toBeNull();
    expect(anchor!.text).toContain("](http://example.com/docs)");
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
  });

  it("selection that wraps an entire paragraph containing one link", () => {
    const rendered = "Here is a paragraph with one link to read for more.";
    const markdown = "Here is a paragraph with one [link](http://example.com) to read for more.";
    const start = 0;
    const end = rendered.length;
    const anchor = buildAnchorFromSelection(rendered, start, end, markdown);
    expect(anchor).not.toBeNull();
    expect(anchor!.text).toBe(markdown);
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
    expect(resolved!.start).toBe(0);
    expect(resolved!.end).toBe(markdown.length);
  });

  it("selection inside a paragraph with TWO links", () => {
    const rendered = "Read the docs first then the changelog later.";
    const markdown = "Read [the docs](http://x.com/docs) first then [the changelog](http://x.com/log) later.";
    // Select from "docs" through "changelog later"
    const sel = "docs first then the changelog later";
    const start = rendered.indexOf(sel);
    const end = start + sel.length;
    const anchor = buildAnchorFromSelection(rendered, start, end, markdown);
    expect(anchor).not.toBeNull();
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
    // The resolved range should encompass both link bodies.
    const text = markdown.slice(resolved!.start, resolved!.end);
    expect(text).toContain("(http://x.com/docs)");
    expect(text).toContain("(http://x.com/log)");
  });

  it("selection between text bold + link wrapper", () => {
    // **important** appears once; link appears once. Selection spans both.
    const rendered = "An important link here please.";
    const markdown = "An **important** [link](http://x.com) here please.";
    const sel = "important link here";
    const start = rendered.indexOf(sel);
    const end = start + sel.length;
    const anchor = buildAnchorFromSelection(rendered, start, end, markdown);
    expect(anchor).not.toBeNull();
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
  });

  it("anchors a phrase that appears multiple times by picking the right occurrence", () => {
    const rendered = "lorem ipsum lorem ipsum lorem ipsum end";
    const markdown = rendered;
    // Select the SECOND "lorem ipsum"
    const first = rendered.indexOf("lorem ipsum");
    const second = rendered.indexOf("lorem ipsum", first + 1);
    const anchor = buildAnchorFromSelection(rendered, second, second + "lorem ipsum".length, markdown);
    expect(anchor).not.toBeNull();
    const resolved = resolve(markdown, anchor!);
    expect(resolved).not.toBeNull();
    expect(resolved!.start).toBe(second);
  });
});
