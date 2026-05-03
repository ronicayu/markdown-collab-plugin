import * as path from "path";
import { describe, expect, it } from "vitest";
import { classifyLink } from "../collab/linkRouter";

const WS = "/Users/me/repo";
const CUR = path.join(WS, "docs", "guide.md");

describe("classifyLink", () => {
  it("treats http/https/mailto as external", () => {
    expect(classifyLink("https://example.com", CUR, [WS]).kind).toBe("external");
    expect(classifyLink("http://example.com", CUR, [WS]).kind).toBe("external");
    expect(classifyLink("mailto:a@b.com", CUR, [WS]).kind).toBe("external");
  });

  it("treats javascript/file/data/vscode-webview as blocked", () => {
    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "vscode-webview://x/",
    ]) {
      expect(classifyLink(href, CUR, [WS]).kind, href).toBe("blocked");
    }
  });

  it("resolves a sibling .md against the current doc's directory", () => {
    const r = classifyLink("./other.md", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "docs", "other.md"));
    }
  });

  it("resolves a parent-relative path", () => {
    const r = classifyLink("../README.md", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "README.md"));
    }
  });

  it("resolves bareword (no leading ./) as relative", () => {
    const r = classifyLink("other.md", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "docs", "other.md"));
    }
  });

  it("treats /-prefixed paths as workspace-root-relative", () => {
    const r = classifyLink("/specs/api.md", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "specs", "api.md"));
    }
  });

  it("blocks parent traversal that escapes the workspace", () => {
    const r = classifyLink("../../../../../../etc/passwd", CUR, [WS]);
    expect(r.kind).toBe("blocked");
  });

  it("treats fragment-only links as fragment", () => {
    const r = classifyLink("#section-2", CUR, [WS]);
    expect(r.kind).toBe("fragment");
    if (r.kind === "fragment") expect(r.id).toBe("section-2");
  });

  it("preserves a fragment when crossing files", () => {
    const r = classifyLink("../README.md#install", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "README.md"));
      expect(r.fragment).toBe("install");
    }
  });

  it("blocks empty / non-string", () => {
    expect(classifyLink("", CUR, [WS]).kind).toBe("blocked");
    expect(classifyLink(undefined as unknown as string, CUR, [WS]).kind).toBe("blocked");
  });

  it("blocks control characters", () => {
    expect(classifyLink("./bad\nfile.md", CUR, [WS]).kind).toBe("blocked");
    expect(classifyLink("./bad\x00file.md", CUR, [WS]).kind).toBe("blocked");
  });

  it("when the current doc is outside any workspace, blocks workspace-style hrefs", () => {
    const outside = "/tmp/loose.md";
    const r = classifyLink("../README.md", outside, [WS]);
    expect(r.kind).toBe("blocked");
  });

  it("when no workspace roots are provided, blocks workspace-style hrefs", () => {
    const r = classifyLink("./other.md", CUR, []);
    expect(r.kind).toBe("blocked");
  });

  it("URL-decodes percent-encoded path segments", () => {
    const r = classifyLink("./has%20space.md", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "docs", "has space.md"));
    }
  });

  it("picks the workspace folder that contains the current doc when multiple are provided", () => {
    const wsA = "/Users/me/repoA";
    const wsB = "/Users/me/repoB";
    const cur = path.join(wsB, "docs", "x.md");
    const r = classifyLink("/api.md", cur, [wsA, wsB]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(wsB, "api.md"));
    }
  });

  // ---- additional branch coverage ----

  it("blocks the special data:text/html URI (XSS attack vector)", () => {
    const r = classifyLink("data:text/html,<script>alert(1)</script>", CUR, [WS]);
    expect(r.kind).toBe("blocked");
  });

  it("preserves a multi-segment fragment", () => {
    const r = classifyLink("#a-b-c-deeply-nested-anchor-name", CUR, [WS]);
    expect(r.kind).toBe("fragment");
    if (r.kind === "fragment") expect(r.id).toBe("a-b-c-deeply-nested-anchor-name");
  });

  it("returns fragment with empty id for a bare '#'", () => {
    const r = classifyLink("#", CUR, [WS]);
    expect(r.kind).toBe("fragment");
    if (r.kind === "fragment") expect(r.id).toBe("");
  });

  it("strips a query string off a workspace path", () => {
    const r = classifyLink("./other.md?v=1", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "docs", "other.md"));
    }
  });

  it("returns fragment alongside workspace path when both are present", () => {
    const r = classifyLink("./other.md?v=1#section", CUR, [WS]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join(WS, "docs", "other.md"));
      expect(r.fragment).toBe("section");
    }
  });

  it("blocks malformed percent-encoded paths", () => {
    const r = classifyLink("./bad%ZZ.md", CUR, [WS]);
    // Browser tolerates malformed % but our decoder rejects.
    expect(r.kind).toBe("blocked");
  });

  it("nested deeply via parent traversal but staying inside workspace is allowed", () => {
    const deepCur = "/Users/me/repo/a/b/c/d/file.md";
    const r = classifyLink("../../../api.md", deepCur, ["/Users/me/repo"]);
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.targetFsPath).toBe(path.join("/Users/me/repo", "a", "api.md"));
    }
  });

  it("rejects an absolute path with a protocol-like prefix that isn't actually a scheme (e.g. 'C:/foo')", () => {
    // On Windows-style paths, "C:/foo" looks scheme-y to URL parsing.
    // RFC 3986 scheme requires alpha first then alphanum/+/-/. — so
    // "C" is a 1-char scheme. URL.parse accepts. We block any
    // scheme not in the allowlist.
    const r = classifyLink("C:/foo/bar.md", CUR, [WS]);
    expect(r.kind).toBe("blocked");
  });
});
