// The document outline behind the table-of-contents panel.

import { describe, expect, it } from "vitest";
import { activeSlug, buildOutline, headingLabel, headings, outlineSize, slugify } from "../webviewShared/outline";

describe("headings", () => {
  it("finds ATX headings with their levels and lines", () => {
    const hs = headings("# One\n\ntext\n\n## Two\n\n### Three\n");
    expect(hs.map((h) => [h.level, h.text, h.line])).toEqual([
      [1, "One", 0],
      [2, "Two", 4],
      [3, "Three", 6],
    ]);
  });

  it("ignores a # inside a fenced code block", () => {
    // A shell comment in an example is not a section, and a TOC entry for it
    // scrolls the reader somewhere arbitrary.
    const hs = headings("# Real\n\n```sh\n# not a heading\necho hi\n```\n\n## Also real\n");
    expect(hs.map((h) => h.text)).toEqual(["Real", "Also real"]);
  });

  it("handles tilde fences too", () => {
    expect(headings("~~~\n# nope\n~~~\n# yes\n").map((h) => h.text)).toEqual(["yes"]);
  });

  it("reads setext headings", () => {
    const hs = headings("Title\n=====\n\nSubtitle\n--------\n");
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [1, "Title"],
      [2, "Subtitle"],
    ]);
  });

  it("strips inline markup so the label is text", () => {
    expect(headings("## The `retry` **policy**\n")[0].text).toBe("The retry policy");
  });

  it("disambiguates repeated headings, as GitHub does", () => {
    const hs = headings("## Notes\n\n## Notes\n\n## Notes\n");
    expect(hs.map((h) => h.slug)).toEqual(["notes", "notes-1", "notes-2"]);
  });

  it("skips a heading whose text is only markup", () => {
    expect(headings("## ``\n")).toEqual([]);
  });
});

describe("buildOutline", () => {
  it("nests by level", () => {
    const tree = buildOutline("# A\n\n## B\n\n### C\n\n## D\n");
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.text)).toEqual(["B", "D"]);
    expect(tree[0].children[0].children.map((c) => c.text)).toEqual(["C"]);
  });

  it("survives a skipped level", () => {
    // h1 → h3 with no h2. Dropping C would make the outline lie about the doc.
    const tree = buildOutline("# A\n\n### C\n");
    expect(tree[0].children.map((c) => c.text)).toEqual(["C"]);
  });

  it("survives a document that starts at h2", () => {
    const tree = buildOutline("## First\n\n## Second\n");
    expect(tree.map((n) => n.text)).toEqual(["First", "Second"]);
  });

  it("puts a later h1 at the root, not under the previous one", () => {
    const tree = buildOutline("# A\n\n## B\n\n# C\n");
    expect(tree.map((n) => n.text)).toEqual(["A", "C"]);
  });

  it("is empty for a document with no headings", () => {
    expect(buildOutline("just prose\n\nmore prose\n")).toEqual([]);
  });

  it("counts every node including nested ones", () => {
    expect(outlineSize(buildOutline("# A\n\n## B\n\n### C\n\n## D\n"))).toBe(4);
  });
});

describe("activeSlug", () => {
  const tree = buildOutline("# A\n\n## B\n\n### C\n\n## D\n");

  it("reports the section a line falls in", () => {
    expect(activeSlug(tree, 0)).toBe("a");
    expect(activeSlug(tree, 3)).toBe("b");
    expect(activeSlug(tree, 5)).toBe("c");
    expect(activeSlug(tree, 20)).toBe("d");
  });

  it("is null above the first heading", () => {
    expect(activeSlug(buildOutline("intro\n\n# A\n"), 0)).toBeNull();
  });
});

describe("slugify / headingLabel", () => {
  it("matches GitHub's fragment form", () => {
    expect(slugify("Choosing a send mode")).toBe("choosing-a-send-mode");
    expect(slugify("What's new? (2026)")).toBe("whats-new-2026");
  });

  it("removes link syntax but keeps the link text", () => {
    expect(headingLabel("See [the docs](https://x.test)")).toBe("See the docs");
  });

  it("drops raw HTML rather than passing it through", () => {
    expect(headingLabel('<img src=x onerror="alert(1)"> Title')).toBe("Title");
  });
});

describe("the outline and link navigation agree on slugs", () => {
  // The outline's slug is what a click hands to the surface's fragment
  // scroller, which slugifies the rendered heading itself. Two definitions
  // would mean an entry that scrolls nowhere — and the first version of this
  // module had its own weaker slugifier that dropped non-ASCII letters.
  it("uses linkParse's slugifyHeading", async () => {
    const { slugifyHeading } = await import("../inlineComments/linkParse");
    expect(slugify).toBe(slugifyHeading);
  });

  it("keeps a non-ASCII heading addressable", () => {
    // The shared slugifier folds diacritics (café → cafe), as GitHub does.
    // What matters is that the outline and the scroller derive the same slug —
    // the replaced version dropped the letter entirely, yielding "caf".
    const [h] = headings("## Café configuration\n");
    expect(h.slug).toBe(slugify("Café configuration"));
    expect(h.slug).toBe("cafe-configuration");
  });
});

describe("headings are addressable by position", () => {
  // Navigation goes by index, not by name: the outline and the renderer agree
  // on how many headings there are and in what order, but two sections with
  // the same name share a slug, and matching by slug left the second one inert.
  it("numbers every heading in document order", () => {
    const hs = headings("# A\n\n## B\n\n### C\n");
    expect(hs.map((h) => h.index)).toEqual([0, 1, 2]);
  });

  it("gives repeated headings distinct indexes even though slugs collide", () => {
    const hs = headings("## Notes\n\n## Notes\n");
    expect(hs.map((h) => h.index)).toEqual([0, 1]);
    // The slugs differ only by GitHub's suffix, which no renderer emits.
    expect(hs.map((h) => h.slug)).toEqual(["notes", "notes-1"]);
  });

  it("keeps indexes stable through nesting", () => {
    const tree = buildOutline("# A\n\n## B\n\n### C\n\n## D\n");
    expect(tree[0].index).toBe(0);
    expect(tree[0].children.map((c) => c.index)).toEqual([1, 3]);
    expect(tree[0].children[0].children.map((c) => c.index)).toEqual([2]);
  });

  it("does not count a heading inside a code fence, so indexes match the DOM", () => {
    // The renderer emits no heading for it either; if one side counted it the
    // index would be off by one for everything below.
    const hs = headings("# A\n\n```\n# fake\n```\n\n## B\n");
    expect(hs.map((h) => [h.text, h.index])).toEqual([
      ["A", 0],
      ["B", 1],
    ]);
  });
});
