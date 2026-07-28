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
  /**
   * Workspace-relative path of the document under review. For a multi-file
   * review pass this is a human label ("3 files under docs/") and the paths
   * themselves are in `files` — consumers that need real paths must read
   * `files` first and fall back to `file`.
   */
  file: string;
  /**
   * Every file in the request, workspace-relative. Present only for
   * multi-file review passes; a single-file payload carries just `file`.
   */
  files?: string[];
  unresolvedCount: number;
  comments: Comment[];
}

/**
 * The terms of a Review Mode pass, shared by the single-file and multi-file
 * prompts: unbounded thread count (see the skill's "No upper bound" rule) and
 * no prose edits, because the human triages from the sidebar.
 */
export function reviewModeClosing(fileCount: number): string {
  const subject = fileCount === 1 ? "the doc warrants" : "the docs warrant";
  return (
    "Open a review thread for every substantive concern. There is no upper bound — " +
    `leave as many as ${subject}. Do not edit prose; the human triages from the sidebar.`
  );
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
  promptLines.push(reviewModeClosing(1));
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
