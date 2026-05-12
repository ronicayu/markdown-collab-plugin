// Send-to-Claude support for the inline-comments view.
//
// The existing sidecar-based pipeline (`src/sendToClaude.ts`) reads
// comments from a JSON sidecar. Inline comments live inside the .md
// file itself, so we build the payload directly from the parser output
// and shim it into the same `ReviewPayload` shape so the existing
// transports (terminal / channel / mcp-channel / clipboard) can handle
// delivery without modification.
//
// The prompt explicitly documents the on-disk format so Claude (which
// today only knows the sidecar shape via the vs-markdown-collab skill)
// can parse and update threads in place — set `"status":"resolved"` on
// the relevant `<!--mc:t {...}-->` line after addressing each thread.

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
  const lines: string[] = [];
  lines.push(
    `Address the following unresolved review threads in ${rel}.`,
    "",
    "These comments are stored INLINE in the markdown file itself, not in a sidecar.",
    "Format:",
    "  - Each anchored span is wrapped in paired HTML comments:",
    "      <!--mc:a:ID-->anchored text<!--mc:/a:ID-->",
    "  - Threads live in a block at the end of the file:",
    "      <!--mc:threads:begin-->",
    "      <!--mc:t {\"id\":\"ID\",\"quote\":\"...\",\"status\":\"open\",\"comments\":[...]}-->",
    "      <!--mc:threads:end-->",
    "",
    "When you're done addressing a thread, mark it resolved by changing its",
    `\`"status":"open"\` to \`"status":"resolved"\` on the matching <!--mc:t ...--> line`,
    "(and add \"resolvedBy\" and \"resolvedTs\" fields).",
    "",
    `Open threads (${threads.length}):`,
    "",
  );
  for (const t of threads) {
    lines.push(`— ID ${t.id} | anchored: ${JSON.stringify(t.quote)}`);
    const live = t.comments.filter((c) => !c.deleted);
    for (const c of live) {
      lines.push(`  [${c.author}${c.parent ? ` → ${c.parent}` : ""}] ${oneLine(c.body)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Exported for tests — exposes the comment shimming so tests don't need to import internal helpers. */
export const _internal = { threadToComment, buildPrompt };
export type _InternalInlineComment = InlineComment;
