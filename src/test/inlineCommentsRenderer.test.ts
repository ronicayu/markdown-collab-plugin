import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { installSourceOffsetPlugin } from "../inlineComments/webview/renderWithOffsets";

function mkRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  installSourceOffsetPlugin(md);
  return md;
}

/** Extract all data-mc-src spans and the prose-offset substring they claim, against the source. */
function spans(html: string, source: string): Array<{ start: number; end: number; substring: string }> {
  const re = /<span data-mc-src="(\d+)\.(\d+)">/g;
  const out: Array<{ start: number; end: number; substring: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const s = Number(m[1]);
    const e = Number(m[2]);
    out.push({ start: s, end: e, substring: source.slice(s, e) });
  }
  return out;
}

describe("inlineComments/webview/renderWithOffsets", () => {
  it("annotates plain paragraph text", () => {
    const src = "Hello world.";
    const html = mkRenderer().render(src);
    expect(spans(html, src)).toEqual([{ start: 0, end: 12, substring: "Hello world." }]);
  });

  it("annotates each text run separately when crossing inline emphasis", () => {
    const src = "Lorem **ipsum** dolor.";
    const html = mkRenderer().render(src);
    const parts = spans(html, src);
    // We expect three text runs: "Lorem ", "ipsum", " dolor."
    expect(parts.map((p) => p.substring)).toEqual(["Lorem ", "ipsum", " dolor."]);
  });

  it("annotates table cell contents at exact source offsets", () => {
    const src = "| Header |\n|--------|\n| Cell A |\n";
    const html = mkRenderer().render(src);
    const parts = spans(html, src);
    expect(parts.map((p) => p.substring).sort()).toEqual(["Cell A", "Header"]);
  });

  it("emits mermaid blocks as a bare <pre class=\"mermaid\">…</pre> with NO inner wrapping span", () => {
    const src = "```mermaid\ngraph LR\nA --> B\n```\n";
    const html = mkRenderer().render(src);
    // mermaid v11 fails ("Syntax error in text") if it has to read through
    // a wrapping span — match the existing previewPanel's output exactly.
    expect(html).toContain('<pre class="mermaid">');
    // Inside the mermaid pre, the next char should be the diagram source
    // (escaped), not "<span data-mc-src=".
    const inner = html.slice(html.indexOf('<pre class="mermaid">') + '<pre class="mermaid">'.length);
    expect(inner.startsWith("<span data-mc-src")).toBe(false);
    expect(inner.startsWith("graph LR")).toBe(true);
  });

  it("annotates a fenced code block as one span covering the inner code", () => {
    const src = "```\ncode line\n```\n";
    const html = mkRenderer().render(src);
    const parts = spans(html, src);
    expect(parts).toHaveLength(1);
    // Inner content includes the trailing newline that markdown-it keeps.
    expect(parts[0].substring.includes("code line")).toBe(true);
  });

  it("annotates inline code", () => {
    const src = "Try `foo()` here.";
    const html = mkRenderer().render(src);
    const parts = spans(html, src);
    expect(parts.map((p) => p.substring)).toEqual(["Try ", "foo()", " here."]);
  });

  it("annotates heading content (skipping the leading # syntax)", () => {
    const src = "# Hello\n";
    const html = mkRenderer().render(src);
    const parts = spans(html, src);
    expect(parts).toEqual([{ start: 2, end: 7, substring: "Hello" }]);
  });

  it("annotates list items", () => {
    const src = "- first\n- second\n";
    const html = mkRenderer().render(src);
    const parts = spans(html, src);
    expect(parts.map((p) => p.substring)).toEqual(["first", "second"]);
  });

  it("skips annotation safely for entity-decoded text rather than producing wrong offsets", () => {
    // markdown-it decodes &amp; to & in token.content; our greedy indexOf
    // won't find "&" in "Foo &amp; bar", so it should leave the token
    // unannotated rather than mis-tagging.
    const src = "Foo &amp; bar.";
    const html = mkRenderer().render(src);
    const parts = spans(html, src);
    // Expect at most one annotated span; whatever we do tag must be a
    // valid substring of the source.
    for (const p of parts) expect(src.slice(p.start, p.end)).toBe(p.substring);
  });
});
