// Send-to-Claude support for the inline-comments view.
//
// Inline comments live inside the .md file itself, so we build the payload
// directly from the parser output and shim it into the `ReviewPayload` shape
// the transports (terminal / clipboard) expect.
//
// The prompt explicitly documents the on-disk inline format so Claude can
// parse and update threads in place — replying on the relevant
// `<!--mc:t {...}-->` line after addressing each thread.

import * as path from "path";
import * as vscode from "vscode";
import { folderForDocument, promptPathFor } from "../workspaceFolder";
import type { ReviewPayload } from "../sendToClaude";
import type { Comment } from "../types";
import { workflowOpener, type SkillDelivery } from "../skillDelivery";
import { parse, type InlineComment, type InlineThread } from "./format";

export interface InlineReviewPayload extends ReviewPayload {
  /** Original inline-format threads (kept alongside the shimmed Comment[] for transports that want richer data). */
  inlineThreads: InlineThread[];
}

/**
 * Convert a single open thread to a `ReviewPayload`-compatible shape.
 * Returns null when the thread is not found or is already resolved.
 */
export function buildSingleThreadPayload(
  doc: vscode.TextDocument,
  threadId: string,
  opts?: { suggestMode?: boolean; skillDelivery?: SkillDelivery },
): InlineReviewPayload | null {
  const folder = folderForDocument(doc.uri);
  if (!folder) return null;
  const parsed = parse(doc.getText());
  const thread = parsed.threads.find((t) => t.id === threadId && t.status === "open");
  if (!thread) return null;
  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  const shown = promptPathFor(doc.uri);
  const promptFor = (delivery: SkillDelivery): string => {
    const lines = [
      `${workflowOpener(delivery)} on \`${shown}\`.`,
      `Address only the open thread with id ${thread.id} (anchored on: ${JSON.stringify(thread.quote)}).`,
    ];
    // Suggest mode is a property of the request, not of how many threads it
    // covers — sending one thread must respect the toggle exactly like sending
    // all of them.
    if (opts?.suggestMode) lines.push("", suggestModeDirective(delivery));
    return lines.join("\n");
  };
  return {
    file: rel,
    unresolvedCount: 1,
    prompt: promptFor(opts?.skillDelivery ?? "installed"),
    inlineSkillPrompt: promptFor("inline"),
    comments: [threadToComment(thread)],
    inlineThreads: [thread],
  };
}

/**
 * Convert open inline threads to a `ReviewPayload`-compatible shape.
 * Returns null when there's nothing to send. When `suggestMode` is set, the
 * prompt asks Claude to propose its edits as suggestions rather than applying
 * them directly.
 */
export function buildInlinePayload(
  doc: vscode.TextDocument,
  opts?: { suggestMode?: boolean; skillDelivery?: SkillDelivery },
): InlineReviewPayload | null {
  const folder = folderForDocument(doc.uri);
  if (!folder) return null;
  const parsed = parse(doc.getText());
  const open = parsed.threads.filter((t) => t.status === "open");
  if (open.length === 0) return null;

  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  const shown = promptPathFor(doc.uri);
  const comments: Comment[] = open.map((t) => threadToComment(t));
  return {
    file: rel,
    unresolvedCount: open.length,
    prompt: buildPrompt(shown, open, opts?.suggestMode ?? false, opts?.skillDelivery ?? "installed"),
    inlineSkillPrompt: buildPrompt(shown, open, opts?.suggestMode ?? false, "inline"),
    comments,
    inlineThreads: open,
  };
}

/**
 * The suggest-mode directive for a terminal or clipboard send. The reader may
 * have the MCP tools, the skill's `mdc` CLI, or neither, so it names all three.
 */
export const SUGGEST_MODE_DIRECTIVE =
  "Work in SUGGEST MODE: propose every edit as a suggestion instead of editing the prose directly — " +
  "with `mc_suggest` if you have the `markdown-collab` MCP tools, with `mdc suggest` if you have the `mdc` CLI, " +
  'otherwise by hand as the "Suggesting an edit" bullet of the "Markdown review comments" section of AGENTS.md describes. ' +
  "The reviewer will accept or reject each one.";

/**
 * The suggest-mode directive for a delivery. A headless run has no `mdc` CLI
 * and no AGENTS.md route — only the tools — so it names only `mc_suggest`.
 */
export function suggestModeDirective(delivery: SkillDelivery): string {
  if (delivery === "installed") return SUGGEST_MODE_DIRECTIVE;
  return (
    "Work in SUGGEST MODE: propose every edit as a suggestion via `mc_suggest` " +
    "instead of editing the prose directly. The reviewer will accept or reject each one."
  );
}

function threadToComment(t: InlineThread): Comment {
  const live = t.comments.filter((c) => !c.deleted);
  const root = live[0] ?? { id: "c1", author: "unknown", ts: new Date().toISOString(), body: "" };
  const replies = live.slice(1).map((c) => ({ author: c.author, body: c.body, createdAt: c.ts }));
  return {
    id: t.id,
    anchor: {
      text: t.quote,
      // Inline comments don't track separate before/after context — the
      // anchor markers in the file are the source of truth. Stub these
      // out so the shape conforms.
      contextBefore: "",
      contextAfter: "",
    },
    body: root.body,
    author: root.author,
    createdAt: root.ts,
    resolved: false,
    replies,
  };
}

function buildPrompt(
  shown: string,
  threads: InlineThread[],
  suggestMode = false,
  delivery: SkillDelivery = "installed",
): string {
  // Point at the review workflow — it is the source of truth for the inline
  // format and the reply/resolve rules, so we don't re-document them here. A
  // concise thread listing follows for context.
  const n = threads.length;
  const lines: string[] = [
    `${workflowOpener(delivery)} to address the ${n} unresolved review comment${n === 1 ? "" : "s"} on \`${shown}\`.`,
  ];
  if (suggestMode) lines.push("", suggestModeDirective(delivery));
  lines.push("", "Open threads:");
  for (const t of threads) {
    const live = t.comments.filter((c) => !c.deleted);
    const latest = live.length > 0 ? ` | latest: ${oneLine(live[live.length - 1].body)}` : "";
    lines.push(`— ${t.id} | anchored: ${JSON.stringify(t.quote)}${latest}`);
  }
  return lines.join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Exported for tests — exposes the comment shimming so tests don't need to import internal helpers. */
export const _internal = { threadToComment, buildPrompt };
export type _InternalInlineComment = InlineComment;
