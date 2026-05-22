import { describe, expect, it } from "vitest";
import { detectUrlScheme, parseLinkHref, slugifyHeading } from "../inlineComments/linkParse";

describe("detectUrlScheme", () => {
  it("detects http(s) URLs", () => {
    expect(detectUrlScheme("http://example.com")).toBe("http");
    expect(detectUrlScheme("HTTPS://example.com")).toBe("https");
  });

  it("detects file:// URLs", () => {
    expect(detectUrlScheme("file:///etc/hosts")).toBe("file");
  });

  it("detects mailto: and tel: without requiring //", () => {
    expect(detectUrlScheme("mailto:hi@example.com")).toBe("mailto");
    expect(detectUrlScheme("tel:+15551234")).toBe("tel");
  });

  it("returns null for plain relative paths", () => {
    expect(detectUrlScheme("docs/spec.md")).toBe(null);
    expect(detectUrlScheme("./foo.md")).toBe(null);
    expect(detectUrlScheme("../foo.md")).toBe(null);
  });

  it("does NOT mis-detect `foo.md:42` as scheme `foo.md`", () => {
    // This is the bug: dots and digits are valid scheme chars per
    // RFC 3986, so a naive scheme regex eats the filename. The fix
    // requires `//` after the colon (or a known no-slash scheme).
    expect(detectUrlScheme("foo.md:42")).toBe(null);
    expect(detectUrlScheme("src/foo.ts:42")).toBe(null);
    expect(detectUrlScheme("bar:13")).toBe(null);
  });

  it("rejects schemes that look web-ish but lack //", () => {
    expect(detectUrlScheme("http:foo")).toBe(null);
  });

  it("returns null for a heading-only fragment", () => {
    expect(detectUrlScheme("#heading")).toBe(null);
  });
});

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

  describe("GitHub-style #L<n> line fragments", () => {
    it("treats `#L42` as a line number, clearing the heading slot", () => {
      expect(parseLinkHref("src/foo.ts#L42")).toEqual({
        path: "src/foo.ts",
        heading: null,
        line: 42,
        query: null,
      });
    });

    it("accepts lowercase `#l42`", () => {
      expect(parseLinkHref("src/foo.ts#l42").line).toBe(42);
    });

    it("takes the first line in an `#L42-L50` range", () => {
      expect(parseLinkHref("src/foo.ts#L42-L50").line).toBe(42);
    });

    it("also accepts `#L42-50` (no L on the second number)", () => {
      expect(parseLinkHref("src/foo.ts#L42-50").line).toBe(42);
    });

    it("does NOT treat `#L42foo` as a line — needs to be exactly L<digits>", () => {
      expect(parseLinkHref("src/foo.ts#L42foo")).toEqual({
        path: "src/foo.ts",
        heading: "L42foo",
        line: null,
        query: null,
      });
    });

    it("does NOT treat a heading literally called `intro` as a line", () => {
      expect(parseLinkHref("foo.md#intro").heading).toBe("intro");
      expect(parseLinkHref("foo.md#intro").line).toBe(null);
    });

    it("explicit `:N` on the path wins over `#LM` in the fragment", () => {
      expect(parseLinkHref("foo.md:7#L42")).toEqual({
        path: "foo.md",
        heading: "L42",
        line: 7,
        query: null,
      });
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
