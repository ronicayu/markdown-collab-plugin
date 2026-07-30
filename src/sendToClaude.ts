import * as path from "path";
import * as vscode from "vscode";
import type { Comment } from "./types";

export type SendMode =
  | "terminal"
  /** Terminal delivery, but Claude acts through the extension's MCP tools. */
  | "mcp"
  | "channel"
  | "mcp-channel"
  | "clipboard"
  | "ask";

/**
 * The line appended to a prompt in `mcp` mode.
 *
 * The tools can't start a turn — only a delivered prompt does — so `mcp` mode
 * is terminal delivery plus this directive. What it buys is the write path:
 * every change lands as a `WorkspaceEdit` the human can undo, checked before it
 * applies, instead of a disk write the extension learns about afterwards.
 */
export function mcpToolsDirective(): string {
  return (
    "Use the `markdown-collab` MCP tools for this pass — mc_list to read, mc_reply / mc_open / mc_rewrite / " +
    "mc_suggest to act, mc_status to say what you're doing, and mc_check on each file when you're done. " +
    "They write through the editor, so nothing races an unsaved buffer and the human can undo you."
  );
}

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
