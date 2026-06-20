// Shared by the inline-comments preview and the live editor: map a markdown
// image `src` to something a webview can actually load. Webviews can't read
// arbitrary file paths — a relative `![](foo.png)` resolves against the
// webview's own `vscode-webview://` origin and 404s — so the host hands the
// client the `.md`'s directory and the workspace folder as webview URIs, and we
// resolve image references against them here.

export interface ImageBaseUris {
  /** Webview URI of the directory containing the .md file. */
  docDir: string;
  /** Webview URI of the workspace folder, or null when the file is loose. */
  workspaceFolder: string | null;
}

// Join a relative path onto a base webview URI using the browser URL parser, so
// `.` and `..` segments resolve correctly (a hand-rolled segment walk dropped
// the `..` without climbing the base, turning `../diagrams/x.png` into
// `<docDir>/diagrams/x.png` instead of `<docDir>/../diagrams/x.png`).
function joinUri(base: string, rel: string): string {
  try {
    // A trailing slash makes the base behave as a directory, so `../` climbs out
    // of it rather than treating the last path segment as a file.
    return new URL(rel, base.endsWith("/") ? base : base + "/").toString();
  } catch {
    return rel;
  }
}

/**
 * Map a markdown image src to a webview-loadable URI:
 *   - `http(s):`, `data:`, already-webview / `file:` → unchanged
 *   - protocol-relative `//host/x` → `https://host/x`
 *   - leading `/` → resolved against the workspace folder
 *   - everything else (incl. `./` and `../`) → resolved against the .md's dir
 *   - empty / unresolvable → unchanged
 */
export function resolveImageSrc(src: string, bases: ImageBaseUris): string {
  if (!src) return src;
  if (/^(https?:|data:|vscode-webview-resource:|vscode-webview:|file:)/i.test(src)) return src;
  if (src.startsWith("//")) return "https:" + src;
  const cleaned = src.replace(/^\.\//, "");
  if (cleaned.startsWith("/")) {
    if (!bases.workspaceFolder) return src;
    return joinUri(bases.workspaceFolder, cleaned.slice(1));
  }
  if (!bases.docDir) return src;
  return joinUri(bases.docDir, cleaned);
}
