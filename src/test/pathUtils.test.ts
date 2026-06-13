import { describe, it, expect } from "vitest";
import * as path from "path";
import { isInsideRoot } from "../pathUtils";

describe("isInsideRoot", () => {
  it("returns true when target equals root", () => {
    const root = path.resolve("/tmp/ws");
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it("returns true for a descendant", () => {
    const root = path.resolve("/tmp/ws");
    expect(isInsideRoot(path.join(root, "docs/spec.md"), root)).toBe(true);
  });

  it("returns false for a sibling that shares a prefix", () => {
    const root = path.resolve("/tmp/ws");
    const sibling = path.resolve("/tmp/ws-other/file.md");
    expect(isInsideRoot(sibling, root)).toBe(false);
  });

  it("returns false for a parent-traversal escape", () => {
    const root = path.resolve("/tmp/ws/docs");
    const escape = path.resolve("/tmp/ws/secret.md");
    expect(isInsideRoot(escape, root)).toBe(false);
  });

  it("returns false for an absolute path completely outside the tree", () => {
    expect(isInsideRoot("/etc/passwd", path.resolve("/tmp/ws"))).toBe(false);
  });
});
