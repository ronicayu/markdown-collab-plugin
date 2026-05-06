// Resolve a drawio link href to an absolute filesystem path, with the
// safety property that the resolved path stays inside the workspace
// folder. Webview-supplied paths must never be trusted to read arbitrary
// host files: an absolute path or a `..`-laden relative path could
// otherwise escape the workspace and exfiltrate ssh keys, env files,
// etc. We resolve relative to the markdown document's directory, then
// hard-check containment under the workspace root.

import * as path from "path";

export interface ResolveOk {
  ok: true;
  absolutePath: string;
}

export interface ResolveErr {
  ok: false;
  reason: "empty-href" | "absolute-not-allowed" | "outside-workspace" | "wrong-extension";
}

export type ResolveResult = ResolveOk | ResolveErr;

const ALLOWED_EXTENSIONS = [".drawio", ".drawio.xml", ".xml"];

export function resolveDrawioHref(
  href: string,
  documentPath: string,
  workspaceRoot: string,
): ResolveResult {
  const trimmed = (href || "").trim();
  if (!trimmed) return { ok: false, reason: "empty-href" };

  // Reject `file://`, `http://`, `https://`, etc. Drawio-from-link is a
  // workspace-relative feature; remote diagrams aren't fetched.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { ok: false, reason: "absolute-not-allowed" };
  }
  // Reject absolute filesystem paths. Even if they happen to land inside
  // the workspace, accepting them encourages brittle docs.
  if (path.isAbsolute(trimmed)) {
    return { ok: false, reason: "absolute-not-allowed" };
  }

  const lower = trimmed.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { ok: false, reason: "wrong-extension" };
  }

  const docDir = path.dirname(documentPath);
  const candidate = path.resolve(docDir, trimmed);
  const normalizedRoot = path.resolve(workspaceRoot);
  const rel = path.relative(normalizedRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "outside-workspace" };
  }

  return { ok: true, absolutePath: candidate };
}

export function isDrawioHref(href: string): boolean {
  const trimmed = (href || "").trim().toLowerCase();
  if (!trimmed) return false;
  // Strip any fragment or query.
  const cleaned = trimmed.split("#")[0]!.split("?")[0]!;
  return ALLOWED_EXTENSIONS.some((ext) => cleaned.endsWith(ext));
}
