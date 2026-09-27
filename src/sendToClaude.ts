import * as path from "path";
import * as vscode from "vscode";
import { folderForDocument } from "./workspaceFolder";
import type { Comment } from "./types";
import { parse as parseInline } from "./inlineComments/format";
import { deltaScope } from "./inlineComments/deltaReview";
import { buildDeltaPrompt } from "./inlineComments/deltaPrompt";
import { workflowOpener, type SkillDelivery } from "./skillDelivery";

// 10x-plan-4 P0.3: `mcp` folded into `terminal`, `channel` / `mcp-channel`
// were deleted outright. P0.1 added `headless` — the extension runs Claude
// itself — as one more entry in the picker builder
// (`transports/sendModePicker.ts`), not a second list to keep in sync.
export type SendMode = "headless" | "terminal" | "clipboard" | "ask";

/**
 * The line appended to every terminal and clipboard delivery.
 *
 * There used to be a separate `mcp` mode for this; folding it into `terminal`
 * only works because the line is harmless when the tools aren't there — the
 * skill's own CLI fallback covers that case, so the directive can go out
 * unconditionally instead of being gated on a mode the human had to pick.
 */
export function mcpToolsDirective(): string {
  return (
    "If the `markdown-collab` MCP tools are in your tool list, use them for this pass — mc_list to read, " +
    "mc_reply / mc_open / mc_rewrite / mc_suggest to act, mc_status to say what you're doing, and mc_check " +
    "on each file when you're done; if they aren't, use the `mdc` CLI as the skill describes."
  );
}

export interface ReviewPayload {
  /** The prompt for a session with the skill installed (terminal, clipboard). */
  prompt: string;
  /**
   * The same prompt for a session whose skill rides along as the system
   * prompt (a headless run) — identical except for its opener.
   *
   * Carried on the payload because the delivery is only known once the send
   * mode is, and that is decided in `dispatchReviewPayload`, after the builder
   * has already run; rebuilding there would need the document back. Optional
   * so a hand-built payload still dispatches (it falls back to `prompt`).
   */
  inlineSkillPrompt?: string;
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
  opts: { delta?: boolean; skillDelivery?: SkillDelivery } = {},
):
  | { kind: "ok"; payload: ReviewPayload; fullPass: boolean }
  /** Delta pass on a file that hasn't moved since the last one. */
  | { kind: "unchanged" } {
  // A loose .md still gets a review: the folder is only the base its path is
  // made relative to, and its own directory serves for that.
  const folder = folderForDocument(doc.uri);
  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  const trimmedFocus = focus?.trim();

  if (opts.delta) {
    // 10x-plan-2 P1.1: cost the pass at what the edit cost, not what the
    // document costs. The scope comes from the checkpoint the last pass left.
    const scope = deltaScope(parseInline(doc.getText()));
    if (scope.kind === "unchanged") return { kind: "unchanged" };
    const deltaFor = (delivery: SkillDelivery): string | null => {
      const body = buildDeltaPrompt(rel, scope, trimmedFocus, delivery);
      return body === null ? null : `${body}\n\n${reviewModeClosing(1)}`;
    };
    const prompt = deltaFor(opts.skillDelivery ?? "installed");
    if (prompt === null) return { kind: "unchanged" };
    return {
      kind: "ok",
      fullPass: scope.kind === "no-checkpoint",
      payload: {
        prompt,
        inlineSkillPrompt: deltaFor("inline") ?? prompt,
        file: rel,
        unresolvedCount: 0,
        comments: [],
      },
    };
  }

  const promptFor = (delivery: SkillDelivery): string => {
    const promptLines: string[] = [`${workflowOpener(delivery)} in Review Mode on \`${rel}\`.`];
    if (trimmedFocus) promptLines.push(`Focus: ${trimmedFocus}`);
    promptLines.push(reviewModeClosing(1));
    return promptLines.join("\n");
  };
  return {
    kind: "ok",
    fullPass: true,
    payload: {
      prompt: promptFor(opts.skillDelivery ?? "installed"),
      inlineSkillPrompt: promptFor("inline"),
      file: rel,
      unresolvedCount: 0,
      comments: [],
    },
  };
}
