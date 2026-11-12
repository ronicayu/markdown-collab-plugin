// A parsed document in prose space: the stripped prose plus every thread and
// suggestion with its anchor mapped into it. The live editor's sidebar takes
// its thread list from here (src/collab/sidebarState.ts).
//
// Free of `vscode`, so anything outside the Extension Host — unit tests, the
// webview e2e fixtures — can build the same state the host would.

import type { InlineComment, ParsedDocument } from "./format";
import { mapProseToSource, sourceLineForProseLine } from "./proseMapping";
import { staleThreadIds } from "./staleness";

export interface SerializedState {
  /** Markdown source with anchor markers AND threads region stripped — what the preview renders. */
  prose: string;
  /**
   * Per-thread anchor mapped into prose-offset space. `null` if the thread
   * has no paired markers (unanchored — show with a "broken anchor" badge).
   */
  threads: Array<{
    id: string;
    quote: string;
    status: "open" | "resolved";
    resolvedBy?: string;
    resolvedTs?: string;
    comments: InlineComment[];
    /** Position in `prose` (offset-into-stripped-source). Null when unanchored. */
    anchor: { proseStart: number; proseEnd: number } | null;
    /** The anchored text changed after this thread's last comment. */
    stale: boolean;
  }>;
  /**
   * Source line (1-based) for each prose line, so the preview can label blocks
   * with lines in the actual file. Only built when the user asked for line
   * numbers — it is one number per line of the document.
   */
  lineMap?: number[];
  /** Pending suggestions (suggest mode), anchored into the same prose space. */
  suggestions: Array<{
    anchorId: string;
    threadId?: string;
    author: string;
    ts: string;
    original: string;
    proposed: string;
    note?: string;
    /** Null when the suggestion's anchor markers were lost (can't be applied). */
    anchor: { proseStart: number; proseEnd: number } | null;
  }>;
}

export function serialize(
  parsed: ParsedDocument,
  opts: { lineNumbers?: boolean } = {},
): SerializedState {
  const { prose, anchorsInProse } = mapProseToSource(parsed);
  const stale = new Set(staleThreadIds(parsed));
  return {
    // Built only on request: it is one entry per line of the document, and
    // every push would otherwise carry it whether or not anything shows it.
    lineMap: opts.lineNumbers ? sourceLineForProseLine(parsed) : undefined,
    prose,
    threads: parsed.threads.map((t) => {
      const a = anchorsInProse.get(t.id);
      return {
        id: t.id,
        quote: t.quote,
        status: t.status,
        resolvedBy: t.resolvedBy,
        resolvedTs: t.resolvedTs,
        comments: t.comments,
        anchor: a ? { proseStart: a.proseStart, proseEnd: a.proseEnd } : null,
        stale: stale.has(t.id),
      };
    }),
    suggestions: parsed.suggestions.map((s) => {
      // Suggestion anchors live in the same `anchorsInProse` map as thread
      // anchors (keyed by anchorId), already mapped to prose space.
      const a = anchorsInProse.get(s.anchorId);
      return {
        anchorId: s.anchorId,
        threadId: s.threadId,
        author: s.author,
        ts: s.ts,
        original: s.original,
        proposed: s.proposed,
        note: s.note,
        anchor: a ? { proseStart: a.proseStart, proseEnd: a.proseEnd } : null,
      };
    }),
  };
}
