import * as path from "path";
import * as vscode from "vscode";
import { folderForDocument, promptPathFor } from "./workspaceFolder";
import type { Comment } from "./types";
import { parse as parseInline } from "./inlineComments/format";
import { deltaScope } from "./inlineComments/deltaReview";
import { buildDeltaPrompt } from "./inlineComments/deltaPrompt";
import { workflowOpener, type SkillDelivery } from "./skillDelivery";

// `headless` (the extension runs Claude itself) is one more entry in the picker builder
// (`transports/sendModePicker.ts`), not a second list to keep in sync.
export type SendMode = "headless" | "terminal" | "clipboard" | "ask";

/**
 * The line appended to every terminal and clipboard delivery: the one rule,
 * and where `mdc` is for each kind of reader. Said in the prompt itself, not
 * only in the skill: an agent that had the skill only by reference kept
 * reaching for its own Edit tool and broke markers. The MCP tools stay named
 * for a session that has them — they are the same engine.
 */
export function mcpToolsDirective(): string {
  return (
    "Change this file's review comments only with `mdc` — plain `mdc` in Claude Code with the Markdown Collab " +
    "plugin, `node ~/.agents/skills/markdown-collab/mdc.mjs` for other agents — or the `markdown-collab` MCP " +
    "tools if they are in your tool list. Never edit a `<!--mc:…-->` marker or thread line yourself, with an " +
    "Edit tool or otherwise: a hand edit breaks the comments. Finish each file you touched with `mdc check <file>` " +
    "(or `mc_check`). If you have neither, stop and ask the human to run Markdown Collab: Connect an Agent."
  );
}

export interface ReviewPayload {
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
 * prompts: rank by severity, open threads for the five that
 * matter most, summarize the rest, and no prose edits — the human triages
 * from the sidebar. Multi-file passes cap and summarize per file, not once
 * across the whole pass (`multiFileReview.ts`'s `CROSS_DOCUMENT_DIMENSION`
 * covers the one thing that *is* pass-wide: consistency between the files).
 */
export function reviewModeClosing(fileCount: number): string {
  const perFile = fileCount === 1 ? "" : " in each file";
  const summaryOwner = fileCount === 1 ? "one summary thread" : "that file's own summary thread";
  return (
    `Rank concerns by severity and open a thread for the five that matter most${perFile}. Put everything else in ` +
    `${summaryOwner}, anchored to the document's title (or its first heading) — "Also noticed (N): …", one line ` +
    "per item naming its passage, so the human can ask to open specific ones. A focus directive can raise or " +
    'remove the cap ("give me ten", "everything"). Do not edit prose; the human triages from the sidebar.'
  );
}

/**
 * The doc need not have any existing
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
  const shown = promptPathFor(doc.uri);
  const trimmedFocus = focus?.trim();

  if (opts.delta) {
    // Cost the pass at what the edit cost, not what the
    // document costs. The scope comes from the checkpoint the last pass left.
    const scope = deltaScope(parseInline(doc.getText()));
    if (scope.kind === "unchanged") return { kind: "unchanged" };
    const deltaFor = (delivery: SkillDelivery): string | null => {
      const body = buildDeltaPrompt(shown, scope, trimmedFocus, delivery);
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
    const promptLines: string[] = [`${workflowOpener(delivery)} in Review Mode on \`${shown}\`.`];
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
