// What the live editor's sidebar needs from the document — the same thread list
// the review view's panel serializes, plus the agent name its toolbar shows.
// Free of `vscode` so the webview e2e fixtures build real payloads from it.

import { agentDisplayName, isAgentComment } from "../agentIdentity";
import { parse, type ParsedDocument } from "../inlineComments/format";
import { serialize } from "../inlineComments/serializeState";
import type { SidebarThread, SkillStatus } from "../webviewShared/sidebarProtocol";

export interface SidebarDocumentFields {
  threads: SidebarThread[];
  /**
   * Who the Send button and the waiting row name. Absent when no agent has
   * written in this file yet: the sidebar then words those generically ("your
   * agent") rather than guessing one.
   */
  agentName?: string;
}

export function sidebarDocumentFields(source: string): SidebarDocumentFields {
  const parsed = parse(source);
  const agentName = mostRecentAgentName(parsed);
  return {
    // `serialize` also maps anchors into prose space; the sidebar only reads
    // whether a thread has one (and their order), so the base doesn't matter.
    threads: serialize(parsed).threads,
    // Omitted, not defaulted, when no agent has written here.
    ...(agentName === undefined ? {} : { agentName }),
  };
}

/**
 * The display name of the agent that most recently wrote to this file —
 * across every comment and suggestion, whichever has the latest timestamp —
 * or `undefined` when no agent has written here yet (the wording rule: name
 * the agent only when the code knows it).
 */
export function mostRecentAgentName(parsed: ParsedDocument): string | undefined {
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
  return latestAuthor === undefined ? undefined : agentDisplayName(latestAuthor).noun;
}

/**
 * What the skill banner is told. The banner says "the Claude skill isn't
 * installed — Claude won't know how to act on these comments", which only
 * means something to someone running Claude Code; a Cursor- or Codex-only
 * machine would be nagged about a skill it has no use for. Without Claude Code
 * on the machine the status is "current" (the banner stays hidden), whatever
 * the skill files say.
 */
export function skillBannerStatus(status: SkillStatus, claudeCodeDetected: boolean): SkillStatus {
  return claudeCodeDetected ? status : "current";
}
