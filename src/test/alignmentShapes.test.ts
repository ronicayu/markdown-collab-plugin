// Coverage for additional markdown shapes that affect anchor
// alignment. Each shape has a known relationship to PM's textContent;
// the stripper must replicate it.
//
// Reference: how PM (with the @milkdown commonmark + gfm presets we
// use) renders each shape's textContent, based on the schema:
//
//   shape                        | textContent contains
//   --------------------------- |-------------------------------
//   `# Heading`                  | "Heading" (the `# ` is stripped)
//   `Title\n=====`               | "Title" (the underline is stripped)
//   `Title\n-----`               | "Title" (the underline is stripped)
//   `---` / `***` / `___` (HR)  | nothing
//   ` ```js\nbody\n``` `          | "body" (fences stripped, body kept)
//   `    indented code`          | "indented code" (4 leading spaces stripped)
//   `[text][ref]` + reflink def  | "text"
//   `\*literal\*`                | "*literal*" (backslashes stripped)
//   `- [x] done`                 | "done" (task-list checkbox stripped)
//   `> a\n> b`                   | "ab"
//   `> > nested`                 | "nested"
//
// Some of these we already get for free; others my stripper needs to
// learn. Tests below pin every shape with an explicit assertion.

import { describe, expect, it } from "vitest";
import { stripInlineMarkup } from "../collab/anchorExtractor";

function stripped(md: string): string {
  return stripInlineMarkup(md).stripped;
}

describe("alignment for other markdown shapes", () => {
  // ---- horizontal rules ----
  it("strips a `---` horizontal rule line entirely", () => {
    expect(stripped("Before\n\n---\n\nAfter")).toBe("BeforeAfter");
  });

  it("strips a `***` horizontal rule line entirely", () => {
    expect(stripped("Before\n\n***\n\nAfter")).toBe("BeforeAfter");
  });

  it("strips a `___` horizontal rule line entirely", () => {
    expect(stripped("Before\n\n___\n\nAfter")).toBe("BeforeAfter");
  });

  it("strips an HR with extra spaces (`  ---  `)", () => {
    expect(stripped("Before\n\n  ---  \n\nAfter")).toBe("BeforeAfter");
  });

  // ---- Setext headings ----
  it("strips the `=====` underline of a Setext H1 but keeps the title", () => {
    expect(stripped("My Title\n========\n\nBody")).toBe("My TitleBody");
  });

  it("strips the `-----` underline of a Setext H2 but keeps the title", () => {
    expect(stripped("Sub Title\n---------\n\nBody")).toBe("Sub TitleBody");
  });

  // ---- Fenced code blocks ----
  it("preserves the body of a fenced code block but drops the fences", () => {
    const md = "Before\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nAfter";
    // Body is "const x = 1;console.log(x);" (newlines stripped, fences gone).
    expect(stripped(md)).toBe("Beforeconst x = 1;console.log(x);After");
  });

  it("preserves the body of a tilde-fenced code block", () => {
    const md = "Before\n\n~~~\nbody line\n~~~\n\nAfter";
    expect(stripped(md)).toBe("Beforebody lineAfter");
  });

  // ---- Indented code ----
  it("strips the 4-space indent of an indented code block but keeps the body", () => {
    const md = "Before\n\n    let y = 2\n    let z = 3\n\nAfter";
    expect(stripped(md)).toBe("Beforelet y = 2let z = 3After");
  });

  // ---- Reference-style links ----
  it("strips the `[ref]` part of a reference-style link, keeping the visible label", () => {
    const md = "Click [the docs][corrections-link] please.";
    expect(stripped(md)).toBe("Click the docs please.");
  });

  it("strips the link-reference definition lines", () => {
    const md = "[corrections-link]: http://corrections.md\n\nVisible text here.";
    expect(stripped(md)).toBe("Visible text here.");
  });

  // ---- Escape sequences ----
  it("strips backslash from \\* (emphasis escape)", () => {
    expect(stripped("Use \\*literal asterisks\\* here.")).toBe("Use *literal asterisks* here.");
  });

  it("strips backslash from \\[ (link bracket escape)", () => {
    expect(stripped("Show \\[literal brackets\\] here.")).toBe("Show [literal brackets] here.");
  });

  it("preserves a doubled backslash as a single backslash", () => {
    expect(stripped("path\\\\subdir")).toBe("path\\subdir");
  });

  // ---- Task lists ----
  it("strips the `[x]` checkbox of a task-list item but keeps the body", () => {
    expect(stripped("- [x] complete this task")).toBe("complete this task");
  });

  it("strips the `[ ]` checkbox of a task-list item but keeps the body", () => {
    expect(stripped("- [ ] not done yet")).toBe("not done yet");
  });

  // ---- Blockquote variants ----
  it("collapses a multi-line blockquote into one stripped string", () => {
    expect(stripped("> first line\n> second line")).toBe("first linesecond line");
  });

  it("strips nested `> >` blockquotes", () => {
    expect(stripped("> outer\n> > nested\n> outer again")).toBe("outernestedouter again");
  });

  it("strips `>` prefix on a line with no space after it", () => {
    expect(stripped(">just text")).toBe("just text");
  });

  // ---- Mixed shapes ----
  it("a paragraph followed by HR followed by a list strips all separators", () => {
    const md = "First para.\n\n---\n\n- item one\n- item two";
    expect(stripped(md)).toBe("First para.item oneitem two");
  });

  it("a Setext heading followed by a fenced code block aligns correctly", () => {
    const md = "Title\n=====\n\n```\nbody\n```\n\nEnd.";
    expect(stripped(md)).toBe("TitlebodyEnd.");
  });
});
