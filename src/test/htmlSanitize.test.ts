import { describe, expect, it } from "vitest";
import { classifyHtml, isBlockHtml, safeHref, sanitizeHtml } from "../webviewShared/htmlSanitize";

describe("sanitizeHtml: what documents use renders", () => {
  it.each([
    ["<sup>2</sup>", "<sup>2</sup>"],
    ["<kbd>Ctrl</kbd>+<kbd>C</kbd>", "<kbd>Ctrl</kbd>+<kbd>C</kbd>"],
    ["<details>\n<summary>More</summary>", "<details>\n<summary>More</summary>"],
    ["</details>", "</details>"],
    ['<div align="center">\n  <b>Centered</b>\n</div>', '<div align="center">\n  <b>Centered</b>\n</div>'],
    ["<table><tr><td colspan=2>A</td></tr></table>", '<table><tr><td colspan="2">A</td></tr></table>'],
    ['<ol start="3" reversed><li>x</li></ol>', '<ol start="3" reversed><li>x</li></ol>'],
    ["<details open><summary>S</summary>", "<details open><summary>S</summary>"],
    ["a<br/>b<hr>", "a<br>b<hr>"],
    ['<abbr title="HyperText">HTML</abbr>', '<abbr title="HyperText">HTML</abbr>'],
  ])("%j", (raw, expected) => {
    expect(sanitizeHtml(raw)).toBe(expected);
  });

  it("keeps a safe link and image, resolving the image source", () => {
    expect(sanitizeHtml('<a href="https://example.com/a?b=1&amp;c=2">x</a>')).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2">x</a>',
    );
    expect(sanitizeHtml('<a href="#install">x</a>')).toBe('<a href="#install">x</a>');
    expect(
      sanitizeHtml('<img src="img/a.png" alt="A" width="200">', { resolveSrc: (s) => `vscode-webview://w/${s}` }),
    ).toBe('<img src="vscode-webview://w/img/a.png" alt="A" width="200">');
  });

  it("drops HTML comments", () => {
    expect(sanitizeHtml("a <!-- hidden --> b")).toBe("a  b");
  });

  it("keeps entity references in text and escapes bare ampersands", () => {
    expect(sanitizeHtml("<p>&copy; A & B &lt;tag&gt;</p>")).toBe("<p>&copy; A &amp; B &lt;tag&gt;</p>");
  });
});

describe("sanitizeHtml: nothing executable or stylable gets through", () => {
  it.each([
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["<iframe src=https://evil.example></iframe>", "&lt;iframe src=https://evil.example&gt;&lt;/iframe&gt;"],
    ["<style>body{display:none}</style>", "&lt;style&gt;body{display:none}&lt;/style&gt;"],
    ["<svg onload=alert(1)>", "&lt;svg onload=alert(1)&gt;"],
    ["<form action=x><input name=a></form>", "&lt;form action=x&gt;&lt;input name=a&gt;&lt;/form&gt;"],
  ])("shows %j as text", (raw, expected) => {
    expect(sanitizeHtml(raw)).toBe(expected);
  });

  it("strips event handlers, style, class, id and data attributes", () => {
    expect(
      sanitizeHtml('<div onclick="alert(1)" style="position:fixed" class="mdc-x" id="threads-list" data-x="1">t</div>'),
    ).toBe("<div>t</div>");
    expect(sanitizeHtml('<img src="a.png" onerror="alert(1)">')).toBe('<img src="a.png">');
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "jav&#x61;script:alert(1)",
    "&#106;avascript:alert(1)",
    "vbscript:x",
    "data:text/html,<script>alert(1)</script>",
  ])("drops the href %j", (href) => {
    expect(sanitizeHtml(`<a href="${href}">x</a>`)).toBe("<a>x</a>");
  });

  it("leaves an undecoded named entity inert rather than letting it form a scheme", () => {
    // `&colon;` is a real HTML5 entity for ':'. It isn't decoded here, and the
    // output escapes its '&', so the browser sees the literal text "&colon;".
    expect(sanitizeHtml('<a href="javascript&colon;alert(1)">x</a>')).toBe(
      '<a href="javascript&amp;colon;alert(1)">x</a>',
    );
  });

  it("refuses image sources that aren't pictures, keeping the tag as text", () => {
    expect(sanitizeHtml('<img src="javascript:alert(1)">')).toBe('&lt;img src="javascript:alert(1)"&gt;');
    expect(sanitizeHtml('<img src="data:text/html,x">')).toBe('&lt;img src="data:text/html,x"&gt;');
  });

  it("refuses CSS smuggled through a dimension", () => {
    expect(sanitizeHtml('<img src="a.png" width="100;background:url(x)">')).toBe('<img src="a.png">');
  });

  it("escapes a quote-breaking attribute value", () => {
    expect(sanitizeHtml(`<abbr title='a" onmouseover="alert(1)'>x</abbr>`)).toBe(
      '<abbr title="a&quot; onmouseover=&quot;alert(1)">x</abbr>',
    );
  });

  it("escapes a malformed tag and a stray angle bracket", () => {
    expect(sanitizeHtml("a < b <b x='>c</b>")).toBe("a &lt; b &lt;b x='&gt;c</b>");
  });
});

describe("classifyHtml", () => {
  it("recognizes comment-only snippets", () => {
    expect(classifyHtml("<!-- note -->")).toEqual({ kind: "comment" });
    expect(classifyHtml(" <!-- a --> <!-- b --> ")).toEqual({ kind: "comment" });
  });

  it("recognizes a single allowlisted tag, with its clean attributes", () => {
    expect(classifyHtml("<sup>")).toEqual({ kind: "tag", tag: { name: "sup", closing: false, attrs: {} } });
    expect(classifyHtml("</SUP>")).toEqual({ kind: "tag", tag: { name: "sup", closing: true, attrs: {} } });
    expect(classifyHtml('<abbr title="T" onclick="x">')).toEqual({
      kind: "tag",
      tag: { name: "abbr", closing: false, attrs: { title: "T" } },
    });
  });

  it("calls everything else a fragment", () => {
    expect(classifyHtml("<script>")).toEqual({ kind: "fragment" });
    expect(classifyHtml("<b>x</b>")).toEqual({ kind: "fragment" });
    expect(classifyHtml("<details>\n<summary>S</summary>")).toEqual({ kind: "fragment" });
  });
});

describe("isBlockHtml and safeHref", () => {
  it("tells block markup from inline markup", () => {
    expect(isBlockHtml("<div>x</div>")).toBe(true);
    expect(isBlockHtml("<details>\n<summary>S</summary>")).toBe(true);
    expect(isBlockHtml("<b>x</b>")).toBe(false);
  });

  it("allows relative, fragment and http(s)/mailto links", () => {
    for (const ok of ["docs/a.md", "#x", "/abs", "https://a.b", "mailto:a@b.c", "//cdn.example/x"]) {
      expect(safeHref(ok)).toBe(ok);
    }
  });
});
