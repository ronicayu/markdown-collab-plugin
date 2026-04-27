import { describe, it, expect } from "vitest";
import * as path from "path";
import {
  extractFrontmatter,
  isInsideRoot,
  isInsideTag,
  locateSelectionInSource,
  renderFrontmatterHtml,
  wrapFirstOutsideTags,
} from "../previewPanel";

describe("extractFrontmatter", () => {
  it("returns null when no frontmatter is present", () => {
    const r = extractFrontmatter("# Heading\n\nbody");
    expect(r.yaml).toBeNull();
    expect(r.rest).toBe("# Heading\n\nbody");
    expect(r.consumed).toBe(0);
  });

  it("strips a simple frontmatter block from the start", () => {
    const text = "---\ntitle: Spec\nauthor: ada\n---\n# Heading\nbody";
    const r = extractFrontmatter(text);
    expect(r.yaml).toBe("title: Spec\nauthor: ada");
    expect(r.rest).toBe("# Heading\nbody");
    expect(r.consumed).toBe("---\ntitle: Spec\nauthor: ada\n---\n".length);
  });

  it("does not match when the leading --- isn't on its own line", () => {
    const text = "--- inline ---\nbody";
    const r = extractFrontmatter(text);
    expect(r.yaml).toBeNull();
  });

  it("supports CRLF line endings", () => {
    const text = "---\r\nkey: v\r\n---\r\nbody";
    const r = extractFrontmatter(text);
    expect(r.yaml).toBe("key: v");
    expect(r.rest).toBe("body");
  });

  it("does not match a thematic break that just happens to start the file", () => {
    // Thematic break followed by content without a closing ---. extract
    // should not consume the entire file.
    const text = "---\nnot frontmatter, no closing\n";
    const r = extractFrontmatter(text);
    expect(r.yaml).toBeNull();
  });
});

describe("renderFrontmatterHtml", () => {
  it("renders simple key:value pairs as a table", () => {
    const html = renderFrontmatterHtml("title: Spec\nauthor: ada");
    expect(html).toContain("mdc-frontmatter");
    expect(html).toContain("<th>title</th>");
    expect(html).toContain("<td>Spec</td>");
    expect(html).toContain("<th>author</th>");
    expect(html).toContain("<td>ada</td>");
    expect(html).not.toContain("raw");
  });

  it("strips matching surrounding quotes from values", () => {
    const html = renderFrontmatterHtml('title: "Quoted"\nname: \'single\'');
    expect(html).toContain("<td>Quoted</td>");
    expect(html).toContain("<td>single</td>");
  });

  it("escapes HTML in keys and values", () => {
    const html = renderFrontmatterHtml('title: <script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to <pre> when YAML uses indentation", () => {
    const html = renderFrontmatterHtml("nested:\n  key: value");
    expect(html).toContain("mdc-frontmatter raw");
    expect(html).toContain("<pre>");
    expect(html).toContain("nested:");
  });

  it("falls back to <pre> when a line lacks a colon", () => {
    const html = renderFrontmatterHtml("title: spec\njust-a-tag");
    expect(html).toContain("mdc-frontmatter raw");
  });

  it("returns an empty string for an empty frontmatter block", () => {
    expect(renderFrontmatterHtml("")).toBe("");
  });
});

describe("isInsideTag", () => {
  it("returns false for offsets in plain text", () => {
    expect(isInsideTag("hello world", 5)).toBe(false);
  });

  it("returns true for offsets between < and >", () => {
    // <p>x</p> — offset 1 is between < and the next >
    expect(isInsideTag("<p>x</p>", 1)).toBe(true);
  });

  it("returns false immediately after a closing >", () => {
    expect(isInsideTag("<p>x", 3)).toBe(false);
  });

  it("treats start-of-string as outside any tag", () => {
    expect(isInsideTag("<p>x", 0)).toBe(false);
  });
});

describe("wrapFirstOutsideTags", () => {
  it("wraps the text content, not occurrences inside attributes", () => {
    const html = '<a href="foo">foo</a>';
    const out = wrapFirstOutsideTags(html, "foo", (s) => `<mark>${s}</mark>`);
    expect(out).toBe('<a href="foo"><mark>foo</mark></a>');
  });

  it("returns null when the only match lies inside a tag", () => {
    const html = '<a href="needle"></a>';
    const out = wrapFirstOutsideTags(html, "needle", (s) => `<mark>${s}</mark>`);
    expect(out).toBeNull();
  });

  it("returns null when the needle is not present", () => {
    const html = "<p>nothing here</p>";
    const out = wrapFirstOutsideTags(html, "absent", (s) => s);
    expect(out).toBeNull();
  });

  it("returns null for an empty needle", () => {
    expect(wrapFirstOutsideTags("<p>x</p>", "", (s) => s)).toBeNull();
  });

  it("wraps the FIRST text-content occurrence and leaves later matches alone", () => {
    const html = "<p>foo</p><p>foo</p>";
    const out = wrapFirstOutsideTags(html, "foo", (s) => `<mark>${s}</mark>`);
    expect(out).toBe("<p><mark>foo</mark></p><p>foo</p>");
  });
});

describe("locateSelectionInSource", () => {
  it("returns the unique exact range when the selection appears once", () => {
    const r = locateSelectionInSource("alpha bravo charlie", "bravo");
    expect(r).toEqual({ start: 6, end: 11 });
  });

  it("returns null when the selection appears multiple times in source", () => {
    const r = locateSelectionInSource("foo bar foo", "foo");
    expect(r).toBeNull();
  });

  it("trims whitespace before searching", () => {
    const r = locateSelectionInSource("alpha bravo", "  bravo  ");
    expect(r).toEqual({ start: 6, end: 11 });
  });

  it("falls back to whitespace-normalized matching", () => {
    // Source has a real newline+spaces inside the run; selection is the
    // visible text with single spaces.
    const source = "first line\nfoo\n\n  bar baz\nlast";
    const r = locateSelectionInSource(source, "foo bar baz");
    expect(r).not.toBeNull();
    if (r) {
      expect(source.slice(r.start, r.end)).toMatch(/foo[\s]+bar baz/);
    }
  });

  it("returns null for empty / whitespace-only selection", () => {
    expect(locateSelectionInSource("anything", "")).toBeNull();
    expect(locateSelectionInSource("anything", "   \n\t")).toBeNull();
  });
});

describe("isInsideRoot", () => {
  it("returns true when target equals root", () => {
    const root = path.resolve("/tmp/ws");
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it("returns true for a descendant", () => {
    const root = path.resolve("/tmp/ws");
    expect(isInsideRoot(path.join(root, "docs/spec.md"), root)).toBe(true);
  });

  it("returns false for a sibling that shares a prefix", () => {
    const root = path.resolve("/tmp/ws");
    const sibling = path.resolve("/tmp/ws-other/file.md");
    expect(isInsideRoot(sibling, root)).toBe(false);
  });

  it("returns false for a parent-traversal escape", () => {
    const root = path.resolve("/tmp/ws/docs");
    const escape = path.resolve("/tmp/ws/secret.md");
    expect(isInsideRoot(escape, root)).toBe(false);
  });

  it("returns false for an absolute path completely outside the tree", () => {
    expect(isInsideRoot("/etc/passwd", path.resolve("/tmp/ws"))).toBe(false);
  });
});
