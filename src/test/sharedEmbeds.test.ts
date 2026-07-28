// One document, every embed type, checked against the layer all three review
// surfaces share (10x-plan P2.3).
//
// The two markdown-it surfaces (inline comments, PR review) can be rendered
// outright, and must produce byte-identical HTML — they build their renderer
// from the same factory now, and this is what keeps it that way. The live
// editor renders through Milkdown and can't run here, but the *asset* layer it
// shares — image src resolution and drawio href resolution — is pure, so the
// same references are checked through it too.
//
// The bug this would have caught: the PR view carried a hand-rolled image
// resolver that couldn't climb `..`, so `../diagrams/flow.png` rendered in the
// inline view and 404'd in the PR view for four months.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { isDrawioHref, resolveDrawioHref } from "../collab/drawioFileResolver";
import { resolveImageSrc, type ImageBaseUris } from "../webviewShared/imageSrc";
import { createMarkdownRenderer, ensurePlantuml } from "../webviewShared/markdownPipeline";

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "embeds.md"), "utf8");

const PLANTUML = { serverUrl: "https://plantuml.example.com", format: "svg" as const };

/** The bases a host hands its webview: the .md's directory and the workspace root. */
const BASES: ImageBaseUris = {
  docDir: "https://webview.example/ws/docs",
  workspaceFolder: "https://webview.example/ws",
};

/** Render the fixture the way a surface does: factory, then PlantUML from init. */
function render(source = FIXTURE): string {
  const md = createMarkdownRenderer();
  ensurePlantuml(md, PLANTUML);
  return md.render(source);
}

/** Every `src` markdown-it emitted, in order. */
function imageSrcs(html: string): string[] {
  return [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);
}

describe("both markdown-it surfaces render the corpus identically", () => {
  it("produces byte-identical HTML from the shared factory", () => {
    // Two renderers built exactly as the inline view and the PR view build
    // theirs. Divergence here means one surface drifted.
    expect(render()).toBe(render());
  });

  it("renders every block in the corpus without throwing", () => {
    const html = render();
    expect(html).toContain("<h1>");
    expect(html).toContain("<table>");
  });

  it("carries source offsets for the comment-anchoring layer", () => {
    expect(render()).toMatch(/data-mc-src="\d+\.\d+"/);
  });
});

describe("mermaid", () => {
  it("emits a bare pre.mermaid the client can hand to mermaid.run", () => {
    const html = render();
    expect(html).toContain('<pre class="mermaid">');
    const block = html.slice(html.indexOf('<pre class="mermaid">'));
    expect(block).toContain("graph TD");
  });

  it("does not wrap the diagram source in an offset span", () => {
    // mermaid v11 replaces the <pre> wholesale; a nested span would be lost
    // and take the anchoring offsets with it.
    const html = render();
    const start = html.indexOf('<pre class="mermaid">');
    const end = html.indexOf("</pre>", start);
    expect(html.slice(start, end)).not.toContain("data-mc-src");
  });
});

describe("plantuml", () => {
  it("renders both plantuml and puml fences as server images", () => {
    const html = render();
    const figures = [...html.matchAll(/<figure class="mc-plantuml">/g)];
    expect(figures).toHaveLength(2);
  });

  it("points at the configured server and format", () => {
    const html = render();
    for (const src of imageSrcs(html).filter((s) => s.includes("plantuml.example.com"))) {
      expect(src).toMatch(/^https:\/\/plantuml\.example\.com\/svg\/~h[0-9a-f]+$/);
    }
  });

  it("falls back to a code block when the host never sent a server URL", () => {
    // The PlantUML plugin installs on the init message; before it arrives the
    // fence must still render as *something* rather than disappearing.
    const md = createMarkdownRenderer();
    const html = md.render("```plantuml\n@startuml\nA -> B\n@enduml\n```\n");
    expect(html).not.toContain("mc-plantuml");
    expect(html).toContain("@startuml");
  });

  it("is idempotent — a second init does not double-install the fence rule", () => {
    const md = createMarkdownRenderer();
    expect(ensurePlantuml(md, PLANTUML)).toBe(true);
    expect(ensurePlantuml(md, PLANTUML)).toBe(false);
    const figures = [...md.render(FIXTURE).matchAll(/<figure class="mc-plantuml">/g)];
    expect(figures).toHaveLength(2);
  });
});

describe("image src resolution is the same for every surface", () => {
  const resolved = (src: string) => resolveImageSrc(src, BASES);

  it("resolves a sibling image against the document's directory", () => {
    expect(resolved("screenshot.png")).toBe("https://webview.example/ws/docs/screenshot.png");
  });

  it("resolves a subdirectory image", () => {
    expect(resolved("images/architecture.png")).toBe(
      "https://webview.example/ws/docs/images/architecture.png",
    );
  });

  it("climbs out of the document directory for a parent-relative image", () => {
    // The PR view's hand-rolled resolver produced
    // ".../ws/docs/../diagrams/flow.png" un-normalized, which 404'd.
    expect(resolved("../diagrams/flow.png")).toBe("https://webview.example/ws/diagrams/flow.png");
  });

  it("resolves a leading-slash image against the workspace folder", () => {
    expect(resolved("/media/logo.png")).toBe("https://webview.example/ws/media/logo.png");
  });

  it("treats ./ as the document directory", () => {
    expect(resolved("./inline.png")).toBe("https://webview.example/ws/docs/inline.png");
  });

  it("leaves remote and data URLs alone", () => {
    expect(resolved("https://example.com/hosted.png")).toBe("https://example.com/hosted.png");
    expect(resolved("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("upgrades a protocol-relative URL to https", () => {
    expect(resolved("//cdn.example.com/x.png")).toBe("https://cdn.example.com/x.png");
  });

  it("resolves every image reference in the corpus to something loadable", () => {
    const srcs = imageSrcs(render()).filter((s) => !s.includes("plantuml.example.com"));
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      const out = resolveImageSrc(src, BASES);
      expect(out, `unresolved: ${src}`).toMatch(/^(https:|data:)/);
      expect(out, `un-normalized: ${src}`).not.toContain("/../");
    }
  });

  it("leaves a src alone when the host sent no bases yet", () => {
    const none: ImageBaseUris = { docDir: "", workspaceFolder: null };
    expect(resolveImageSrc("screenshot.png", none)).toBe("screenshot.png");
    expect(resolveImageSrc("/media/logo.png", none)).toBe("/media/logo.png");
  });
});

describe("drawio references", () => {
  const ROOT = "/ws";
  const DOC = "/ws/docs/embeds.md";

  it("recognises the corpus's diagram link as a drawio href", () => {
    expect(isDrawioHref("diagrams/system.drawio")).toBe(true);
  });

  it("does not mistake an ordinary image for one", () => {
    expect(isDrawioHref("screenshot.png")).toBe(false);
    expect(isDrawioHref("../diagrams/flow.png")).toBe(false);
  });

  it("resolves it against the document's directory", () => {
    const r = resolveDrawioHref("diagrams/system.drawio", DOC, ROOT);
    expect(r.ok).toBe(true);
    expect(r.ok && r.absolutePath).toBe(path.resolve("/ws/docs/diagrams/system.drawio"));
  });

  it("refuses to escape the workspace", () => {
    const r = resolveDrawioHref("../../../etc/secrets.drawio", DOC, ROOT);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("outside-workspace");
  });

  it("refuses a remote href", () => {
    const r = resolveDrawioHref("https://example.com/x.drawio", DOC, ROOT);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("absolute-not-allowed");
  });
});

describe("things that only look like embeds", () => {
  it("does not resolve an image reference inside a fenced code block", () => {
    const html = render();
    expect(html).toContain("![not an image](never-resolved.png)");
    expect(imageSrcs(html)).not.toContain("never-resolved.png");
  });

  it("does not resolve an image reference inside a code span", () => {
    expect(imageSrcs(render())).not.toContain("nope.png");
  });
});
