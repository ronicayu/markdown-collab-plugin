// What the live editor's sidebar needs from the document (10x-plan-6 P4,
// sidebar parity) — the same thread list the review view's panel serializes,
// plus the agent name its toolbar shows.
//
// Kept free of `vscode` so the webview e2e fixtures build real payloads from
// it, the way they already do with `serialize` and `commentsOf`.

import { agentDisplayName, isAgentComment } from "../agentIdentity";
import { parse, type ParsedDocument } from "../inlineComments/format";
import { serialize } from "../inlineComments/serializeState";
import type { SidebarThread } from "../webviewShared/sidebarProtocol";

export interface SidebarDocumentFields {
  /** Every thread with its full comment list — the review view's `state.threads`. */
  threads: SidebarThread[];
  /** Who the Send button and the waiting row name. */
  agentName: string;
}

/** The document-derived half of a sidebar push. */
export function sidebarDocumentFields(source: string): SidebarDocumentFields {
  const parsed = parse(source);
  return {
    // `serialize` also maps anchors into prose space; the sidebar only reads
    // whether a thread has one (and their order), so the base doesn't matter.
    threads: serialize(parsed).threads,
    agentName: mostRecentAgentName(parsed),
  };
}

/**
 * The display name of the agent that most recently wrote to this file —
 * across every comment and suggestion, whichever has the latest timestamp —
 * or "Claude" when no agent has written here yet. The review view's panel has
 * its own copy (inlineCommentsPanel.ts), removed with that view.
 */
export function mostRecentAgentName(parsed: ParsedDocument): string {
  let latestTs: string | undefined;
  let latestAuthor: string | undefined;
  const consider = (entry: { author: string; ts: string; agent?: boolean }): void => {
    if (!isAgentComment(entry)) return;
    if (latestTs === undefined || entry.ts > latestTs) {
      latestTs = entry.ts;
      latestAuthor = entry.author;
    }
  };
  for (const thread of parsed.threads) {
    for (const comment of thread.comments) consider(comment);
  }
  for (const suggestion of parsed.suggestions) consider(suggestion);
  return agentDisplayName(latestAuthor ?? "claude").noun;
}
