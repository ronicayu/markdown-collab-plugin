import * as path from "path";

/**
 * True when `target` is `root` itself or nested inside it. Used to confine
 * link-routing to the workspace folder of the previewed document. Both
 * arguments must be absolute filesystem paths. The comparison is
 * case-sensitive on POSIX and case-insensitive on win32 (matching how the
 * filesystem itself behaves), and uses `path.relative` so symlinks at the
 * boundary collapse correctly.
 */
export function isInsideRoot(target: string, root: string): boolean {
  const a = path.resolve(target);
  const b = path.resolve(root);
  if (a === b) return true;
  const rel = path.relative(b, a);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}
