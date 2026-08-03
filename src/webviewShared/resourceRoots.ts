// Which directories a review webview may load images from.
//
// A webview can only read files under its `localResourceRoots`; anything else
// is refused by the host and the `<img>` shows as broken with no error anywhere
// the user can see. The URL is built correctly and the picture still doesn't
// appear, which makes this the single most confusing way an image can fail.
//
// The rule used to be "the workspace folder, or — when the file is loose — the
// file's own directory". That misses the commonest relative path in real
// documentation: `![](../diagrams/x.png)`. For a loose file it climbs straight
// out of the only granted root, and in a multi-root workspace only the folder
// owning the document was granted, so an image in a sibling root was refused
// too.
//
// Pure and path-based so it can be tested without a webview. `docDir` and its
// parent are granted because a relative image reference can climb at most one
// level in the overwhelming majority of documents; deeper climbs still need the
// workspace folder to cover them, which it normally does.

import * as path from "path";

export interface ResourceRootInput {
  /** Absolute path of the .md being displayed. */
  docFsPath: string;
  /** Absolute paths of every open workspace folder. */
  workspaceFolders: string[];
  /** Extension-owned directories (bundles, mermaid). Always granted. */
  extensionDirs: string[];
}

/**
 * Directories to grant, de-duplicated and with nested paths collapsed into
 * their ancestors (granting `/a/b` when `/a` is already granted is noise in
 * a list a reviewer may have to read).
 */
export function imageResourceRootPaths(input: ResourceRootInput): string[] {
  const docDir = path.dirname(input.docFsPath);
  const parent = path.dirname(docDir);
  const candidates = [
    ...input.extensionDirs,
    ...input.workspaceFolders,
    // Also guarded: a document sitting literally at `/` (or `C:\`) is
    // pathological, but "grant the whole disk" must not be reachable by
    // opening a file in the wrong place.
    isFilesystemRoot(docDir) ? "" : docDir,
    // The parent, so `../diagrams/x.png` — which markdown documents use
    // constantly — resolves for a file opened outside any workspace folder.
    //
    // Never the filesystem root: for a document sitting at `/proj/x.md` the
    // parent is `/`, and granting that would hand the webview read access to
    // the entire disk. One directory up is a bounded, read-only widening; the
    // root is not, and collapsing below would silently swallow every other
    // root in the list.
    isFilesystemRoot(parent) ? "" : parent,
  ].filter((p) => p && p.length > 0);

  const unique = [...new Set(candidates.map((p) => path.resolve(p)))];
  // Drop any path already covered by another. Root ("/" or "C:\") is kept only
  // if it genuinely appears — we never synthesize it.
  return unique.filter(
    (p) => !unique.some((other) => other !== p && isInside(p, other)),
  );
}

/** Is `child` at or below `parent`? */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** `/`, `C:\`, or any path that is its own parent. */
function isFilesystemRoot(p: string): boolean {
  return path.dirname(p) === p;
}
