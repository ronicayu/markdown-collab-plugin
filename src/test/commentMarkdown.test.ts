// Comment bodies render as markdown.
//
// They always *were* markdown — Claude writes lists and fenced code into
// replies constantly, and GitHub/GitLab comments are markdown by definition —
// but the three surfaces showed them three ways: inline-only markdown in the
// comments view, escaped text with regex autolinking in the live editor, and
// flat text in the PR view. A reply containing a bulleted list read as a
// run-on line with stray hyphens in two of the three.

import { describe, expect, it } from "vitest";
import { createCommentRenderer } from "../webviewShared/markdownPipeline";

const md = createCommentRenderer();
const render = (s: string): string => md.render(s);

describe("comment markdown", () => {
  it("renders a bulleted list as a list", () => {
    const html = render("Three things:\n\n- one\n- two\n- three\n");
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)).toHaveLength(3);
  });

  it("renders a fenced code block", () => {
    expect(render("Try:\n\n```js\nconst x = 1;\n```\n")).toContain("<pre><code");
  });

  it("keeps inline emphasis, code and links working", () => {
    const html = render("**bold**, `code`, and [a link](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
  });

  it("treats a single newline as a line break, the way comment UIs do", () => {
    // CommonMark would join these into one paragraph; a two-line reply should
    // stay two lines.
    expect(render("first line\nsecond line")).toContain("<br>");
  });

  it("autolinks a bare URL, which the old regex existed to do", () => {
    expect(render("see https://example.com/x for detail")).toContain(
      '<a href="https://example.com/x"',
    );
  });
});

describe("what a comment body cannot do", () => {
  it("escapes raw HTML instead of injecting it", () => {
    const html = render('<img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
  });

  it("escapes a script tag", () => {
    expect(render("<script>alert(1)</script>")).not.toContain("<script>");
  });

  it("renders an image as a link rather than fetching a remote URL", () => {
    // A comment body can come from anyone — Claude, a colleague's commit,
    // another user on a PR. Rendering `![](https://…)` would make opening a
    // review fetch a third-party URL and hand its author the reader's IP.
    const html = render("![a screenshot](https://tracker.example/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://tracker.example/pixel.png"');
    expect(html).toContain("a screenshot");
  });

  it("falls back to the src when an image has no alt text", () => {
    expect(render("![](https://x.test/y.png)")).toContain("https://x.test/y.png");
  });

  it("escapes markup inside an image's alt text", () => {
    const html = render('![<script>](https://x.test/y.png)');
    expect(html).not.toContain("<script>");
  });
});

describe("the document renderer is left alone", () => {
  it("still joins soft-wrapped prose into a paragraph", async () => {
    // The document under review is CommonMark: a hard break there would
    // change how every wrapped paragraph in every .md renders.
    const { createMarkdownRenderer } = await import("../webviewShared/markdownPipeline");
    expect(createMarkdownRenderer().render("first line\nsecond line")).not.toContain("<br>");
  });

  it("still renders images in the document itself", async () => {
    const { createMarkdownRenderer } = await import("../webviewShared/markdownPipeline");
    expect(createMarkdownRenderer().render("![x](y.png)")).toContain("<img");
  });
});
