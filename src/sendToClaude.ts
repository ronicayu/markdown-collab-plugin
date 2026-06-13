import * as path from "path";
import * as vscode from "vscode";
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
