// Which directories a review webview may read images from.
//
// The failure this guards against is uniquely confusing: the `<img src>` is
// built correctly, the file exists, and the picture still doesn't appear —
// because the host refused to serve a path outside `localResourceRoots` and
// said so nowhere the user can see. `![](../diagrams/x.png)`, the commonest
// relative form in real documentation, used to land outside the granted root
// for any file opened without a workspace folder.

import * as path from "path";
import { describe, expect, it } from "vitest";
import { imageResourceRootPaths } from "../webviewShared/resourceRoots";

const EXT = ["/ext/out/webview"];

describe("imageResourceRootPaths", () => {
  it("grants the document's directory and its parent", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/proj/docs/architecture.md",
      workspaceFolders: [],
      extensionDirs: EXT,
    });
    // `../diagrams/x.png` from /proj/docs resolves to /proj/diagrams.
    expect(roots).toContain(path.resolve("/proj"));
  });

  it("covers a ../ image reference for a file opened with no workspace", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/proj/docs/architecture.md",
      workspaceFolders: [],
      extensionDirs: EXT,
    });
    const image = path.resolve("/proj/diagrams/tn5-high-level-architecture.png");
    expect(roots.some((r) => image.startsWith(r + path.sep))).toBe(true);
  });

  it("grants every workspace folder, not just the one owning the document", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/a/docs/x.md",
      workspaceFolders: ["/a", "/b"],
      extensionDirs: EXT,
    });
    expect(roots).toContain(path.resolve("/a"));
    expect(roots).toContain(path.resolve("/b"));
  });

  it("always grants the extension's own directories", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/a/x.md",
      workspaceFolders: ["/a"],
      extensionDirs: ["/ext/out/webview", "/ext/node_modules/mermaid/dist"],
    });
    expect(roots).toContain(path.resolve("/ext/out/webview"));
    expect(roots).toContain(path.resolve("/ext/node_modules/mermaid/dist"));
  });

  it("collapses a directory already covered by an ancestor", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/proj/docs/deep/x.md",
      workspaceFolders: ["/proj"],
      extensionDirs: [],
    });
    // /proj covers /proj/docs and /proj/docs/deep, so only /proj remains.
    expect(roots).toEqual([path.resolve("/proj")]);
  });

  it("does not invent a root the caller never asked for", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/proj/docs/x.md",
      workspaceFolders: ["/proj"],
      extensionDirs: [],
    });
    expect(roots).not.toContain(path.resolve("/"));
  });

  it("de-duplicates when the document sits at a workspace root", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/proj/x.md",
      workspaceFolders: ["/proj"],
      extensionDirs: [],
    });
    expect(roots.filter((r) => r === path.resolve("/proj"))).toHaveLength(1);
  });

  it("ignores empty entries rather than granting the process cwd", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/proj/x.md",
      workspaceFolders: ["", "/proj"],
      extensionDirs: [""],
    });
    expect(roots).toEqual([path.resolve("/proj")]);
  });
});

describe("the filesystem root is never granted", () => {
  // A document at a workspace root has `/` as its parent directory. Granting
  // it would give the webview read access to the whole disk — and, because
  // nested paths collapse into ancestors, would silently replace every other
  // root in the list with `/`.
  it("refuses to climb past a top-level document", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/x.md",
      workspaceFolders: [],
      extensionDirs: ["/ext/out/webview"],
    });
    expect(roots).not.toContain(path.resolve("/"));
    expect(roots).toContain(path.resolve("/ext/out/webview"));
  });

  it("keeps the other roots intact when the document sits at a root", () => {
    const roots = imageResourceRootPaths({
      docFsPath: "/proj/x.md",
      workspaceFolders: ["/proj"],
      extensionDirs: ["/ext/out/webview"],
    });
    expect(roots.sort()).toEqual([path.resolve("/ext/out/webview"), path.resolve("/proj")].sort());
  });
});
