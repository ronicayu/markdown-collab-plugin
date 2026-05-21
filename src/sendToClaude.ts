import * as path from "path";
import * as vscode from "vscode";
import { loadSidecar, sidecarPathFor } from "./sidecar";
import type { Comment } from "./types";

export type SendMode =
  | "terminal"
  | "channel"
  | "mcp-channel"
  | "clipboard"
  | "ask";

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

/**
 * Build the payload sent to Claude when the user clicks "Ask Claude to
 * Review This Doc" (v2 Review Mode). The doc need not have any existing
 * comments — Claude will create review threads from scratch. If the
 * caller passes a focus directive, embed it on its own line so the skill
 * can use it as the primary filter for what warrants a thread.
 */
export function buildReviewRequestPayload(
  doc: vscode.TextDocument,
  focus: string | undefined,
): { kind: "ok"; payload: ReviewPayload } | { kind: "no-workspace" } {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return { kind: "no-workspace" };
  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  const trimmedFocus = focus?.trim();
  const promptLines: string[] = [
    `Use the vs-markdown-collab skill in Review Mode on \`${rel}\`.`,
  ];
  if (trimmedFocus) promptLines.push(`Focus: ${trimmedFocus}`);
  promptLines.push(
    "Open a review thread for every substantive concern. There is no upper bound — leave as many as the doc warrants. Do not edit prose; the human triages from the sidebar.",
  );
  return {
    kind: "ok",
    payload: {
      prompt: promptLines.join("\n"),
      file: rel,
      unresolvedCount: 0,
      comments: [],
    },
  };
}
