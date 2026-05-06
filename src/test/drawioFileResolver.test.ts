// Tests for the drawio link → workspace path resolver. The resolver is
// the security boundary for the inline viewer: it decides whether a
// webview-supplied href is allowed to read a host file. The properties
// we want pinned:
//
//   1. Reject schemes (http:, file:, javascript:) — only relative paths
//      are accepted.
//   2. Reject absolute filesystem paths even if they fall inside the
//      workspace (forces docs to use repo-relative references).
//   3. Reject `..`-traversal that escapes the workspace root.
//   4. Reject hrefs whose extension isn't on the small whitelist.
//   5. Accept normal relative references and return the resolved
//      absolute path.

import { describe, expect, it } from "vitest";
import * as path from "path";
import { isDrawioHref, resolveDrawioHref } from "../collab/drawioFileResolver";

const ROOT = "/work/repo";
const DOC = "/work/repo/docs/spec.md";

describe("resolveDrawioHref", () => {
  it("accepts a sibling .drawio file", () => {
    expect(resolveDrawioHref("flow.drawio", DOC, ROOT)).toEqual({
      ok: true,
      absolutePath: path.resolve("/work/repo/docs/flow.drawio"),
    });
  });

  it("accepts a workspace-rooted relative path via `..`", () => {
    expect(resolveDrawioHref("../diagrams/api.drawio", DOC, ROOT)).toEqual({
      ok: true,
      absolutePath: path.resolve("/work/repo/diagrams/api.drawio"),
    });
  });

  it("accepts a .drawio.xml extension", () => {
    expect(resolveDrawioHref("flow.drawio.xml", DOC, ROOT)).toEqual({
      ok: true,
      absolutePath: path.resolve("/work/repo/docs/flow.drawio.xml"),
    });
  });

  it("accepts a bare .xml extension (some drawio exports use it)", () => {
    const r = resolveDrawioHref("model.xml", DOC, ROOT);
    expect(r.ok).toBe(true);
  });

  it("rejects http:// schemes", () => {
    expect(resolveDrawioHref("http://example.com/x.drawio", DOC, ROOT)).toEqual({
      ok: false,
      reason: "absolute-not-allowed",
    });
  });

  it("rejects file:// schemes", () => {
    expect(resolveDrawioHref("file:///etc/passwd", DOC, ROOT)).toEqual({
      ok: false,
      reason: "absolute-not-allowed",
    });
  });

  it("rejects javascript: schemes", () => {
    expect(resolveDrawioHref("javascript:alert(1)", DOC, ROOT)).toEqual({
      ok: false,
      reason: "absolute-not-allowed",
    });
  });

  it("rejects absolute filesystem paths", () => {
    expect(resolveDrawioHref("/etc/passwd", DOC, ROOT).ok).toBe(false);
  });

  it("rejects absolute paths even inside the workspace", () => {
    // Even if the path happens to land inside ROOT, accepting it would
    // encourage absolute-path docs that break for other contributors.
    expect(resolveDrawioHref("/work/repo/docs/x.drawio", DOC, ROOT).ok).toBe(false);
  });

  it("rejects `..` traversal that escapes the workspace root", () => {
    expect(resolveDrawioHref("../../outside.drawio", DOC, ROOT)).toEqual({
      ok: false,
      reason: "outside-workspace",
    });
  });

  it("rejects hrefs without an allowed extension", () => {
    expect(resolveDrawioHref("readme.md", DOC, ROOT)).toEqual({
      ok: false,
      reason: "wrong-extension",
    });
    expect(resolveDrawioHref("flow", DOC, ROOT)).toEqual({
      ok: false,
      reason: "wrong-extension",
    });
  });

  it("rejects an empty href", () => {
    expect(resolveDrawioHref("", DOC, ROOT)).toEqual({ ok: false, reason: "empty-href" });
    expect(resolveDrawioHref("   ", DOC, ROOT)).toEqual({ ok: false, reason: "empty-href" });
  });
});

describe("isDrawioHref", () => {
  it("matches plain .drawio", () => {
    expect(isDrawioHref("flow.drawio")).toBe(true);
  });

  it("matches .drawio.xml", () => {
    expect(isDrawioHref("flow.drawio.xml")).toBe(true);
  });

  it("ignores trailing fragments and queries", () => {
    expect(isDrawioHref("flow.drawio#page=2")).toBe(true);
    expect(isDrawioHref("flow.drawio?ref=1")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDrawioHref("FLOW.DRAWIO")).toBe(true);
  });

  it("rejects unrelated extensions", () => {
    expect(isDrawioHref("readme.md")).toBe(false);
    expect(isDrawioHref("image.png")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isDrawioHref("")).toBe(false);
    expect(isDrawioHref("   ")).toBe(false);
  });
});
