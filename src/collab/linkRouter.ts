// Classify an `href` from a link the user clicked in the collab editor.
//
// A link can be one of:
//   - external: http(s) / mailto — open in the OS handler
//   - workspace: a file inside one of the workspace folders — open via
//     vscode.open so the user's preferred editor handles it
//   - fragment: pure `#anchor` within the current doc — caller decides
//     what to do (currently we just no-op)
//   - blocked: anything we refuse (file://, javascript:, traversal that
//     escapes the workspace, control chars, …)
//
// This module is a pure function — no `vscode` import — so it can be
// unit-tested in vitest without a webview/Extension Host.

import * as path from "path";

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export type LinkClassification =
  | { kind: "external"; href: string }
  | { kind: "workspace"; targetFsPath: string; fragment?: string }
  | { kind: "fragment"; id: string }
  | { kind: "blocked"; reason: string };

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function looksAbsoluteScheme(href: string): boolean {
  // RFC 3986 scheme: ALPHA *(ALPHA / DIGIT / + / - / .) ":"
  return /^[a-z][a-z0-9+\-.]*:/i.test(href);
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function isInside(rootAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(rootAbs, candidateAbs);
  if (rel === "") return true; // candidate IS the root
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function pickContainingRoot(currentDocFsPath: string, roots: string[]): string | null {
  // Prefer the deepest root that contains the current doc — handles
  // nested workspace folders correctly.
  let best: string | null = null;
  for (const root of roots) {
    if (isInside(root, currentDocFsPath)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

export function classifyLink(
  href: string,
  currentDocFsPath: string,
  workspaceRoots: string[],
): LinkClassification {
  if (typeof href !== "string" || href.length === 0) {
    return { kind: "blocked", reason: "empty href" };
  }
  if (hasControlChars(href)) {
    return { kind: "blocked", reason: "control characters in href" };
  }

  // Pure-fragment links: '#section'.
  if (href.startsWith("#")) {
    return { kind: "fragment", id: href.slice(1) };
  }

  if (looksAbsoluteScheme(href)) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return { kind: "blocked", reason: "malformed URL" };
    }
    if (EXTERNAL_SCHEMES.has(url.protocol)) {
      return { kind: "external", href };
    }
    return { kind: "blocked", reason: `disallowed scheme: ${url.protocol}` };
  }

  // From here on the href is treated as a path — possibly with a
  // ?query (rare in markdown) and/or a #fragment we want to preserve.
  const hashIdx = href.indexOf("#");
  const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : undefined;
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const queryIdx = pathPart.indexOf("?");
  const cleanPath = queryIdx >= 0 ? pathPart.slice(0, queryIdx) : pathPart;

  // Decode the path segments so '%20' → ' ', etc.
  const segments = cleanPath.split("/").map((s) => safeDecode(s));
  if (segments.some((s) => s === null)) {
    return { kind: "blocked", reason: "malformed percent-encoding" };
  }
  const decoded = (segments as string[]).join("/");

  if (workspaceRoots.length === 0) {
    return { kind: "blocked", reason: "no workspace roots to resolve against" };
  }

  let baseDir: string;
  let resolved: string;

  if (decoded.startsWith("/")) {
    // Workspace-root-relative. Pick the workspace folder that contains
    // the current doc; if the current doc is loose (outside all roots)
    // we have no idea which root the author meant.
    const root = pickContainingRoot(currentDocFsPath, workspaceRoots);
    if (!root) {
      return { kind: "blocked", reason: "current doc is outside any workspace folder" };
    }
    baseDir = root;
    resolved = path.resolve(root, decoded.replace(/^\/+/, ""));
  } else {
    // Document-relative. Need a base dir; if the doc is loose AND there
    // are no workspace roots that contain it, we still resolve relative
    // to the doc's directory but verify the result against the roots
    // before returning workspace-classified.
    baseDir = path.dirname(currentDocFsPath);
    resolved = path.resolve(baseDir, decoded);
  }

  // Verify the resolved path lives inside one of the workspace roots.
  // This is the central guardrail against `../../../../etc/passwd`.
  const containingRoot = workspaceRoots.find((root) => isInside(root, resolved));
  if (!containingRoot) {
    return { kind: "blocked", reason: "path escapes the workspace" };
  }

  return { kind: "workspace", targetFsPath: resolved, fragment };
}
