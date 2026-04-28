import * as path from "path";
import * as vscode from "vscode";
import { loadSidecar, sidecarPathFor } from "./sidecar";
import type { Comment } from "./types";

export type SendMode = "terminal" | "ipc" | "clipboard" | "ask";

export interface ReviewPayload {
  prompt: string;
  file: string;
  unresolvedCount: number;
  comments: Comment[];
}

/**
 * Build the payload sent to Claude when the user clicks "Send to Claude" on
 * a doc's preview. Filters the doc's sidecar to unresolved comments only and
 * formats the human-readable prompt line. Returns null when the doc is
 * outside any workspace folder, has no sidecar, or has no unresolved
 * comments — caller surfaces the appropriate UI in each case.
 */
export async function buildReviewPayload(
  doc: vscode.TextDocument,
  output: vscode.OutputChannel,
): Promise<
  | { kind: "ok"; payload: ReviewPayload }
  | { kind: "no-workspace" }
  | { kind: "no-sidecar" }
  | { kind: "empty" }
> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return { kind: "no-workspace" };
  const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
  if (!sidecarPath) return { kind: "no-workspace" };
  const loaded = await loadSidecar(sidecarPath, (m) => output.appendLine(m));
  if (!loaded) return { kind: "no-sidecar" };

  const unresolved = loaded.sidecar.comments.filter((c) => !c.resolved);
  if (unresolved.length === 0) return { kind: "empty" };

  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  return {
    kind: "ok",
    payload: {
      prompt: `Use the vs-markdown-collab skill to address the unresolved review comments on ${rel}.`,
      file: rel,
      unresolvedCount: unresolved.length,
      comments: unresolved,
    },
  };
}
