import { describe, it, expect } from "vitest";
import { extractFrontmatter, renderFrontmatterHtml } from "../previewPanel";

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
