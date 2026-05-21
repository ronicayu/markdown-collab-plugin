import { describe, expect, it } from "vitest";
import { parseLinkHref, slugifyHeading } from "../inlineComments/linkParse";

describe("parseLinkHref", () => {
  it("returns the bare path when no fragment, line, or query is present", () => {
    expect(parseLinkHref("docs/spec.md")).toEqual({
      path: "docs/spec.md",
      heading: null,
      line: null,
      query: null,
    });
  });

  it("extracts the heading fragment", () => {
    expect(parseLinkHref("foo.md#section-heading")).toEqual({
      path: "foo.md",
      heading: "section-heading",
      line: null,
      query: null,
    });
  });

  it("extracts a positive integer line suffix", () => {
    expect(parseLinkHref("foo.md:42")).toEqual({
      path: "foo.md",
      heading: null,
      line: 42,
      query: null,
    });
  });

  it("does not treat a non-numeric suffix as a line", () => {
    expect(parseLinkHref("foo:bar.md")).toEqual({
      path: "foo:bar.md",
      heading: null,
      line: null,
      query: null,
    });
  });

  it("treats `:0` as not a line (we require >= 1)", () => {
    expect(parseLinkHref("foo.md:0").line).toBe(null);
  });

  it("strips a single leading `./` from the path", () => {
    expect(parseLinkHref("./foo.md").path).toBe("foo.md");
  });

  it("decodes URI-encoded characters in the path", () => {
    expect(parseLinkHref("my%20doc.md").path).toBe("my doc.md");
  });

  it("falls back to the raw path when decoding fails", () => {
    // %ZZ is invalid; decodeURIComponent throws. Caller should still
    // see something usable.
    expect(parseLinkHref("bad%ZZpath.md").path).toBe("bad%ZZpath.md");
  });

  it("returns an empty path for fragment-only hrefs", () => {
    expect(parseLinkHref("#somewhere")).toEqual({
      path: "",
      heading: "somewhere",
      line: null,
      query: null,
    });
  });

  it("handles combined path + line + heading", () => {
    expect(parseLinkHref("docs/spec.md:12#api")).toEqual({
      path: "docs/spec.md",
      heading: "api",
      line: 12,
      query: null,
    });
  });

  it("extracts a query string", () => {
    expect(parseLinkHref("foo.md?x=1&y=2")).toEqual({
      path: "foo.md",
      heading: null,
      line: null,
      query: "x=1&y=2",
    });
  });

  it("ordering: query comes before fragment", () => {
    expect(parseLinkHref("foo.md?q=1#heading")).toEqual({
      path: "foo.md",
      heading: "heading",
      line: null,
      query: "q=1",
    });
  });
});

describe("slugifyHeading", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugifyHeading("My Heading")).toBe("my-heading");
  });

  it("drops punctuation other than hyphens and underscores", () => {
    expect(slugifyHeading("What's the deal, anyway?")).toBe("whats-the-deal-anyway");
  });

  it("collapses consecutive whitespace into a single hyphen", () => {
    expect(slugifyHeading("a   b\tc")).toBe("a-b-c");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugifyHeading("foo - bar")).toBe("foo-bar");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugifyHeading("  - hi -  ")).toBe("hi");
  });

  it("preserves underscores", () => {
    expect(slugifyHeading("snake_case_heading")).toBe("snake_case_heading");
  });

  it("returns an empty string for punctuation-only headings", () => {
    expect(slugifyHeading("!?!")).toBe("");
  });

  it("strips diacritics from unicode letters (NFKD normalize + combining strip)", () => {
    expect(slugifyHeading("Café Résumé")).toBe("cafe-resume");
  });

  it("preserves non-Latin letters that aren't decomposable", () => {
    expect(slugifyHeading("日本 語")).toBe("日本-語");
  });
});
