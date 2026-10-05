// Reading a `.drawio` file for a webview, once. Both review surfaces render
// embedded draw.io diagrams and need the same thing from the host: resolve an
// href against the document and the workspace root, refuse anything outside it,
// read the XML. No vscode import — just the path checks (`resolveDrawioHref`)
// plus an injected reader.

import { drawioRejectReasonMessage, resolveDrawioHref } from "./drawioFileResolver";

export interface DrawioReadResult {
  type: "drawio-read-result";
  requestId: string;
  href: string;
  ok: boolean;
  content?: string;
  error?: string;
}

export interface DrawioReadRequest {
  requestId: string;
  href: string;
  /** Absolute path of the `.md` the href was written in. */
  documentPath: string;
  /** Absolute path of the containing workspace folder, or null when loose. */
  workspaceRoot: string | null;
}

/**
 * Resolve `href` against the document and workspace root, then read it.
 *
 * Never throws: every failure — outside the workspace, wrong extension,
 * unreadable — comes back as `ok: false` with a message the webview shows in
 * place of the diagram, because a broken diagram must not take down the panel
 * that renders the review around it.
 */
export async function runDrawioRead(
  request: DrawioReadRequest,
  readFile: (absPath: string) => Promise<string>,
  appendLog: (line: string) => void = () => {},
): Promise<DrawioReadResult> {
  const { requestId, href, documentPath, workspaceRoot } = request;
  if (!workspaceRoot) {
    return fail(requestId, href, "Markdown file is outside any workspace folder.");
  }
  const resolved = resolveDrawioHref(href, documentPath, workspaceRoot);
  if (!resolved.ok) {
    return fail(requestId, href, drawioRejectReasonMessage(resolved.reason));
  }
  try {
    const content = await readFile(resolved.absolutePath);
    return { type: "drawio-read-result", requestId, href, ok: true, content };
  } catch (e) {
    const message = (e as Error).message ?? "Unknown read error";
    appendLog(`drawio-read failed for ${resolved.absolutePath}: ${message}`);
    return fail(requestId, href, `Could not read ${href}: ${message}`);
  }
}

function fail(requestId: string, href: string, error: string): DrawioReadResult {
  return { type: "drawio-read-result", requestId, href, ok: false, error };
}
