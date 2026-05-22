import { describe, expect, it } from "vitest";
import { addThread, findFrontmatter, parse } from "../inlineComments/format";

describe("findFrontmatter", () => {
  it("returns null for a doc with no frontmatter", () => {
    expect(findFrontmatter("# Hello\n\nbody\n")).toBe(null);
  });

  it("detects a YAML frontmatter block", () => {
    const src = "---\ntitle: Foo\nauthor: Bar\n---\n\n# Heading\n";
    const fm = findFrontmatter(src);
    expect(fm).not.toBe(null);
    if (!fm) return;
    expect(src.slice(fm.start, fm.end)).toBe("---\ntitle: Foo\nauthor: Bar\n---\n");
  });

  it("accepts `...` as the closing fence for YAML frontmatter", () => {
    const src = "---\ntitle: Foo\n...\n# Heading\n";
    const fm = findFrontmatter(src);
    expect(fm).not.toBe(null);
    if (!fm) return;
    expect(src.slice(fm.start, fm.end)).toBe("---\ntitle: Foo\n...\n");
  });

  it("detects a TOML frontmatter block (+++ fences)", () => {
    const src = "+++\ntitle = \"Foo\"\n+++\n# Heading\n";
    const fm = findFrontmatter(src);
    expect(fm).not.toBe(null);
    if (!fm) return;
    expect(src.slice(fm.start, fm.end)).toBe("+++\ntitle = \"Foo\"\n+++\n");
  });

  it("returns null when the opening fence is not at the very top", () => {
    const src = "intro\n---\ntitle: Foo\n---\n";
    expect(findFrontmatter(src)).toBe(null);
  });

  it("returns null when the opening fence has no matching close", () => {
    expect(findFrontmatter("---\ntitle: Foo\n\n# Heading\n")).toBe(null);
  });

  it("does NOT cross-match YAML opener with TOML closer", () => {
    expect(findFrontmatter("---\ntitle: Foo\n+++\n# Heading\n")).toBe(null);
  });

  it("ignores a UTF-8 BOM before the opening fence", () => {
    const src = "﻿---\ntitle: Foo\n---\nbody\n";
    const fm = findFrontmatter(src);
    expect(fm).not.toBe(null);
    if (!fm) return;
    // The BOM is at offset 0; the fence range starts at 0 still (we
    // don't gain anything by trimming the BOM out, callers strip the
    // full [start, end) and the leading BOM survives on the prose
    // side — acceptable).
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\ntitle: Foo\r\n---\r\n# Heading\r\n";
    const fm = findFrontmatter(src);
    expect(fm).not.toBe(null);
    if (!fm) return;
    expect(src.slice(fm.start, fm.end)).toBe("---\r\ntitle: Foo\r\n---\r\n");
  });

  it("returns null for a fence opening followed by EOF", () => {
    expect(findFrontmatter("---")).toBe(null);
  });
});

describe("parse() surfaces frontmatter on ParsedDocument", () => {
  it("attaches the frontmatter range when present", () => {
    const src = "---\ntitle: Foo\n---\n\n# Heading\n";
    const parsed = parse(src);
    expect(parsed.frontmatter).toEqual({ start: 0, end: 19 });
  });

  it("leaves frontmatter as null when absent", () => {
    expect(parse("# Heading\n").frontmatter).toBe(null);
  });

  it("doesn't confuse a horizontal rule with frontmatter", () => {
    // Setext heading uses `---` after a line of text — that's a real
    // heading, not frontmatter. The opening-fence-at-top-of-file rule
    // prevents this from being mis-detected.
    expect(parse("Heading\n---\n\nbody\n").frontmatter).toBe(null);
  });
});

describe("addThread refuses selections inside frontmatter", () => {
  const src = "---\ntitle: my doc\nauthor: me\n---\n\nBody starts here.\n";
  // Source layout:
  //  0  '-'  3  '\n' 4  't' …  17 '\n' 18 'a' …  28 '\n' 29 '-' 32 '\n'
  //  33 '\n' 34 'B'
  // Frontmatter range is [0, 33).

  it("rejects an anchor that starts inside frontmatter", () => {
    const selStart = src.indexOf("title");
    const selEnd = selStart + "title: my doc".length;
    expect(() =>
      addThread(src, selStart, selEnd, { author: "me", body: "x" }),
    ).toThrow(/frontmatter/i);
  });

  it("rejects an anchor that straddles the frontmatter boundary", () => {
    const selStart = src.indexOf("my doc");
    const selEnd = src.indexOf("Body starts here.");
    expect(() =>
      addThread(src, selStart, selEnd, { author: "me", body: "x" }),
    ).toThrow(/frontmatter/i);
  });

  it("allows an anchor immediately after the frontmatter block", () => {
    const selStart = src.indexOf("Body starts here.");
    const selEnd = selStart + "Body starts here.".length;
    const result = addThread(src, selStart, selEnd, { author: "me", body: "x" });
    expect(result.source).toContain("<!--mc:a:");
    expect(result.source).toContain("Body starts here.");
  });
});
