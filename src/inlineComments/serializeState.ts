// The wire shape the inline-comments webview renders, and the pure function
// that produces it from a parsed document.
//
// Split out of `inlineCommentsPanel.ts` (which imports `vscode`) so anything
// outside the Extension Host can build a real init payload: the webview e2e
// harness boots the shipped client bundle against exactly the state the panel
// would have pushed, instead of a hand-written approximation that drifts.

import type { InlineComment, ParsedDocument } from "./format";
import { mapProseToSource, sourceLineForProseLine } from "./proseMapping";
import { staleThreadIds } from "./staleness";

/** Serializable view of `ParsedDocument` for the webview. */
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
    /** The anchored text changed after this thread's last comment (P1.3). */
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
