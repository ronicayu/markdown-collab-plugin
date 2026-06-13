// Send-to-Claude support for the inline-comments view.
//
// Inline comments live inside the .md file itself, so we build the payload
// directly from the parser output and shim it into the `ReviewPayload` shape
// the transports (terminal / channel / mcp-channel / clipboard) expect.
//
// The prompt explicitly documents the on-disk inline format so Claude can
// parse and update threads in place — replying on the relevant
// `<!--mc:t {...}-->` line after addressing each thread.

import * as path from "path";
import * as vscode from "vscode";
import type { ReviewPayload } from "../sendToClaude";
import type { Comment } from "../types";
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
): InlineReviewPayload | null {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return null;
  const parsed = parse(doc.getText());
  const thread = parsed.threads.find((t) => t.id === threadId && t.status === "open");
  if (!thread) return null;
  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  const prompt = [
    `Use the vs-markdown-collab skill on \`${rel}\`.`,
    `Address only the open thread with id ${thread.id} (anchored on: ${JSON.stringify(thread.quote)}).`,
  ].join("\n");
  return {
    file: rel,
    unresolvedCount: 1,
    prompt,
    comments: [threadToComment(thread)],
    inlineThreads: [thread],
  };
}

/**
 * Convert open inline threads to a `ReviewPayload`-compatible shape.
 * Returns null when there's nothing to send.
 */
export function buildInlinePayload(doc: vscode.TextDocument): InlineReviewPayload | null {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return null;
  const parsed = parse(doc.getText());
  const open = parsed.threads.filter((t) => t.status === "open");
  if (open.length === 0) return null;

  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  const comments: Comment[] = open.map((t) => threadToComment(t));
  return {
    file: rel,
    unresolvedCount: open.length,
    prompt: buildPrompt(rel, open),
    comments,
    inlineThreads: open,
  };
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

function buildPrompt(rel: string, threads: InlineThread[]): string {
  // Invoke the vs-markdown-collab skill — it is the source of truth for the
  // inline format and the reply/resolve rules, so we don't re-document them
  // here. A concise thread listing follows for context.
  const n = threads.length;
  const lines: string[] = [
    `Use the vs-markdown-collab skill to address the ${n} unresolved review comment${n === 1 ? "" : "s"} on \`${rel}\`.`,
    "",
    "Open threads:",
  ];
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
