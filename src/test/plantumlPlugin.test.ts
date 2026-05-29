import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { encodeAsHex, installPlantumlPlugin, renderPlantumlFence } from "../plantumlPlugin";

describe("encodeAsHex", () => {
  it("encodes ASCII as lowercase hex bytes", () => {
    expect(encodeAsHex("AB")).toBe("4142");
    expect(encodeAsHex("hi")).toBe("6869");
  });

  it("encodes UTF-8 multi-byte chars", () => {
    // U+00E9 (é) = c3 a9 in UTF-8
    expect(encodeAsHex("é")).toBe("c3a9");
    // U+1F600 (😀) = f0 9f 98 80 in UTF-8
    expect(encodeAsHex("😀")).toBe("f09f9880");
  });

  it("returns empty string for empty input", () => {
    expect(encodeAsHex("")).toBe("");
  });
});

describe("renderPlantumlFence", () => {
  it("builds the right URL with ~h prefix and chosen format", () => {
    const html = renderPlantumlFence("Bob -> Alice : hi", "https://example.com/plantuml", "svg");
    expect(html).toContain('<img src="https://example.com/plantuml/svg/~h');
    expect(html).toContain(encodeAsHex("Bob -> Alice : hi"));
    expect(html).toContain('class="mc-plantuml"');
    expect(html).toContain('loading="lazy"');
  });

  it("respects png format", () => {
    const html = renderPlantumlFence("A -> B", "https://example.com/plantuml", "png");
    expect(html).toContain("/png/~h");
  });

  it("strips trailing slash on server URL", () => {
    const html = renderPlantumlFence("X", "https://example.com/plantuml/", "svg");
    // No double slash before /svg/.
    expect(html).not.toContain("plantuml//svg");
    expect(html).toContain("plantuml/svg/~h");
  });
});

describe("installPlantumlPlugin", () => {
  it("renders ```plantuml fences as <img> and leaves other fences alone", () => {
    const md = new MarkdownIt();
    installPlantumlPlugin(md, { serverUrl: "https://example.com/plantuml" });
    const out = md.render("```plantuml\n@startuml\nBob -> Alice\n@enduml\n```\n");
    expect(out).toContain('<figure class="mc-plantuml">');
    expect(out).toContain('src="https://example.com/plantuml/svg/~h');
  });

  it("handles ```puml as the alias", () => {
    const md = new MarkdownIt();
    installPlantumlPlugin(md, { serverUrl: "https://example.com/plantuml" });
    const out = md.render("```puml\nA -> B\n```\n");
    expect(out).toContain('<figure class="mc-plantuml">');
  });

  it("falls through to the previous fence renderer for non-plantuml fences", () => {
    const md = new MarkdownIt();
    installPlantumlPlugin(md, { serverUrl: "https://example.com/plantuml" });
    const out = md.render("```js\nconsole.log(1);\n```\n");
    expect(out).toContain('<pre><code class="language-js">');
    expect(out).not.toContain("mc-plantuml");
  });

  it("chains over an earlier custom fence renderer (mermaid + plantuml coexist)", () => {
    const md = new MarkdownIt();
    md.renderer.rules.fence = (tokens, idx) => {
      const lang = tokens[idx].info.trim().toLowerCase();
      if (lang === "mermaid") return `<pre class="mermaid">${tokens[idx].content}</pre>`;
      return `<pre>${tokens[idx].content}</pre>`;
    };
    installPlantumlPlugin(md, { serverUrl: "https://example.com/plantuml" });
    expect(md.render("```mermaid\ngraph TD\n```\n")).toContain('<pre class="mermaid">');
    expect(md.render("```plantuml\nA -> B\n```\n")).toContain("mc-plantuml");
    expect(md.render("```js\nlet x = 1;\n```\n")).toContain("<pre>let x = 1;");
  });
});
