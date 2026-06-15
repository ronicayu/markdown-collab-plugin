// Bridge between the live (collab) editor and the inline-comment storage
// format (`src/inlineComments/format.ts`). The collab editor keeps the
// Milkdown document as *prose only* — the invisible `<!--mc:...-->` markers
// and the `<!--mc:threads:begin-->` JSON block never reach the webview.
// This module is the seam that:
//
//   - strips the markers + threads region out of the .md source to produce
//     the prose the editor shows (`proseOf`), with an offset map so we can
//     translate back and forth;
//   - projects the parsed threads into the flat comment shape the webview
//     sidebar already consumes (`commentsOf`);
//   - applies comment CRUD by rewriting the inline source (`addThreadFromAnchor`,
//     `replyToThread`, `setThreadResolved`, `deleteThread`); and
//   - re-materializes the markers after a prose edit (`mergeProseEdit`), so
//     anchors keep tracking the text they were attached to.
//
// It is intentionally free of any `vscode` dependency so it can be unit
// tested directly, mirroring how format.ts is tested.

import {
  addThread,
  appendReply,
  mintThreadId,
  parse,
  replaceThread,
  startPastHeadingPrefix,
  withThreads,
  type InlineThread,
  type ParsedDocument,
} from "../inlineComments/format";
import {
  collapseWs,
  locateAnchorInLiveText,
  locateNthOccurrence,
  normalizeWs,
} from "./liveAnchorLocator";

/** Anchor shape exchanged with the webview (markdown-source space). */
export interface CollabCommentAnchor {
  text: string;
  contextBefore: string;
  contextAfter: string;
}

/** Flat per-thread comment the webview sidebar renders. `id` is the thread id. */
export interface CollabComment {
  id: string;
  /** Id of the thread's root comment (distinct from the thread/anchor id). */
  rootCommentId: string;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  anchor: CollabCommentAnchor;
  /** Which occurrence of `anchor.text` the marker wraps, 0-based; -1 if unanchored. */
  anchorOrdinal: number;
  replies: Array<{ id: string; author: string; body: string; createdAt: string }>;
}

/** How many chars of surrounding prose to capture as anchor context. */
const CONTEXT_CHARS = 24;

// `locateAnchorInLiveText` runs the anchor's context through `stripInlineMarkup`
// (which drops newlines) but the haystack side only collapses whitespace to a
// single space — so context spanning a blank line ("bank.\n\nA" vs "bank. A")
// fails to match. Collapse our context the same way the haystack is collapsed
// before handing it to the locator (normalizeWs, shared with the locator).

/**
 * Locate an anchor in `prose`, preferring its context for disambiguation but
 * falling back to a unique text-only match when the context has drifted (e.g.
 * the user edited the surrounding prose). The fallback only ever returns an
 * unambiguous single hit, so it never silently mis-anchors a duplicated quote.
 */
function locate(
  prose: string,
  anchor: CollabCommentAnchor,
): { start: number; end: number } | null {
  const withContext = locateAnchorInLiveText(prose, {
    text: anchor.text,
    contextBefore: normalizeWs(anchor.contextBefore),
    contextAfter: normalizeWs(anchor.contextAfter),
  });
  if (withContext) return withContext;
  return locateAnchorInLiveText(prose, { text: anchor.text, contextBefore: "", contextAfter: "" });
}

const openMarker = (id: string): string => `<!--mc:a:${id}-->`;
const closeMarker = (id: string): string => `<!--mc:/a:${id}-->`;

/** Remove any embedded anchor markers from a string (e.g. a quote that captured another thread's markers). */
const stripMarkerComments = (s: string): string =>
  s.replace(/<!--mc:a:[a-z0-9]{1,12}-->/g, "").replace(/<!--mc:\/a:[a-z0-9]{1,12}-->/g, "");

interface Bridge {
  prose: string;
  parsed: ParsedDocument;
  /** prose offset -> source offset (length prose.length + 1). */
  proseToSrc: number[];
  /** thread id -> its span in prose space. Absent when the thread is unanchored. */
  anchorsInProse: Map<string, { proseStart: number; proseEnd: number }>;
}

/**
 * Strip the mc markers + threads region from `source`, keeping frontmatter
 * (the collab editor shows and edits frontmatter as ordinary content).
 * Produces the prose plus the offset map needed to translate back.
 */
function buildBridge(source: string): Bridge {
  const parsed = parse(source);

  // Skip intervals: every anchor marker, plus the whole threads region
  // (and one preceding newline so removing it doesn't leave a blank line).
  const skips: Array<[number, number]> = [];
  for (const a of parsed.anchors.values()) {
    skips.push([a.openStart, a.openEnd]);
    skips.push([a.closeStart, a.closeEnd]);
  }
  if (parsed.threadsRegion) {
    const start =
      parsed.threadsRegion.start > 0 && source[parsed.threadsRegion.start - 1] === "\n"
        ? parsed.threadsRegion.start - 1
        : parsed.threadsRegion.start;
    // Also swallow one trailing newline after the region. `withThreads`
    // writes "<prose>\n<region>\n", so without this the closing newline
    // survives stripping and the prose gains a trailing "\n" on every
    // round-trip — which makes the editor↔document echo non-idempotent.
    let end = parsed.threadsRegion.end;
    if (source[end] === "\n") end += 1;
    skips.push([start, end]);
  }
  // Frontmatter is kept out of the editor body — Milkdown would render the
  // `---` fences as thematic breaks and mangle the YAML on save. It's shown
  // in a dedicated block and re-prepended on write (see frontmatterOf /
  // mergeProseEdit).
  if (parsed.frontmatter) {
    skips.push([parsed.frontmatter.start, parsed.frontmatter.end]);
  }
  skips.sort((a, b) => a[0] - b[0]);

  const proseChars: string[] = [];
  const proseToSrc: number[] = [];
  let skipIdx = 0;
  for (let i = 0; i < source.length; i++) {
    while (skipIdx < skips.length && i >= skips[skipIdx][1]) skipIdx++;
    if (skipIdx < skips.length && i >= skips[skipIdx][0] && i < skips[skipIdx][1]) continue;
    proseToSrc.push(i);
    proseChars.push(source[i]!);
  }
  proseToSrc.push(source.length);
  const prose = proseChars.join("");

  const anchorsInProse = new Map<string, { proseStart: number; proseEnd: number }>();
  for (const [id, range] of parsed.anchors) {
    const ps = findProseIndex(proseToSrc, range.openEnd);
    const pe = findProseIndex(proseToSrc, range.closeStart);
    if (ps !== null && pe !== null) anchorsInProse.set(id, { proseStart: ps, proseEnd: pe });
  }

  return { prose, parsed, proseToSrc, anchorsInProse };
}

function findProseIndex(proseToSrc: number[], srcOffset: number): number | null {
  for (let i = 0; i < proseToSrc.length; i++) {
    if (proseToSrc[i] === srcOffset) return i;
    if (proseToSrc[i]! > srcOffset) return i; // marker boundary collapse — nearest prose index
  }
  return null;
}

/** The prose the collab editor should display (frontmatter, markers + threads region removed). */
export function proseOf(source: string): string {
  return buildBridge(source).prose;
}

/** The raw frontmatter block (including fences + trailing newline), or "" when absent. */
export function frontmatterOf(source: string): string {
  const fm = parse(source).frontmatter;
  return fm ? source.slice(fm.start, fm.end) : "";
}

/** Project the parsed inline threads into the flat comment list the sidebar renders. */
// 0-based index of `needle`'s occurrence that starts at/just-before `beforePos`,
// i.e. how many occurrences precede it. Lets the live highlight pick the exact
// anchored occurrence by ordinal — the marker already says which one it is — so
// it never has to disambiguate by (fragile, markdown-laden) surrounding context.
function occurrenceIndex(haystack: string, needle: string, beforePos: number): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0 && idx < beforePos) {
    count++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

export function commentsOf(source: string): CollabComment[] {
  const { prose, parsed, anchorsInProse } = buildBridge(source);
  const out: CollabComment[] = [];
  for (const thread of parsed.threads) {
    const visible = thread.comments.filter((c) => !c.deleted);
    const root = visible[0];
    if (!root) continue; // fully-tombstoned thread — nothing to show
    const span = anchorsInProse.get(thread.id);
    const anchor: CollabCommentAnchor = span
      ? {
          text: prose.slice(span.proseStart, span.proseEnd),
          contextBefore: prose.slice(Math.max(0, span.proseStart - CONTEXT_CHARS), span.proseStart),
          contextAfter: prose.slice(span.proseEnd, span.proseEnd + CONTEXT_CHARS),
        }
      : // Defensive: a legacy quote may have captured another thread's markers;
        // strip them so the panel shows clean text and the highlight can match.
        { text: stripMarkerComments(thread.quote), contextBefore: "", contextAfter: "" };
    out.push({
      id: thread.id,
      rootCommentId: root.id,
      body: root.body,
      author: root.author,
      createdAt: root.ts,
      resolved: thread.status === "resolved",
      anchor,
      // Which occurrence of `anchor.text` the marker wraps (-1 when unanchored).
      anchorOrdinal: span ? occurrenceIndex(prose, anchor.text, span.proseStart) : -1,
      replies: visible.slice(1).map((r) => ({ id: r.id, author: r.author, body: r.body, createdAt: r.ts })),
    });
  }
  return out;
}

/**
 * Add a thread anchored at `anchor` (markdown-source-space text + context,
 * as the webview computes it). Locates the span in the prose, maps back to
 * source offsets, and wraps it with markers. Returns the rewritten source,
 * or an error when the anchor can't be located.
 */
export function addThreadFromAnchor(
  source: string,
  anchor: CollabCommentAnchor,
  comment: { author: string; body: string; ts?: string },
  /**
   * Which occurrence of `anchor.text` was selected (0-based, in the editor's
   * rendered text). When the context-based `locate` can't pin the span — the
   * usual case for table cells and other structural markdown, where the stored
   * context carries `|`/`#`/`**` that the rendered text lacks, and any
   * duplicate value (e.g. "Yes") is otherwise un-disambiguable — fall back to
   * placing the marker at this occurrence in the prose. Mirrors the ordinal the
   * highlight uses, so a freshly-placed marker highlights right away.
   */
  ordinal?: number,
): { ok: true; source: string } | { ok: false; error: string } {
  const { prose, proseToSrc } = buildBridge(source);
  const range =
    locate(prose, anchor) ??
    (typeof ordinal === "number" && ordinal >= 0
      ? locateNthOccurrence(prose, anchor.text, ordinal)
      : null);
  if (range) {
    const srcStart = proseToSrc[range.start];
    // End boundary: map the last selected prose char to source, then +1, so we
    // don't swallow a marker that may sit immediately after in source space.
    const srcEnd = range.end === 0 ? proseToSrc[0]! : proseToSrc[range.end - 1]! + 1;
    if (srcStart !== undefined && srcEnd !== undefined) {
      try {
        const { source: next } = addThread(source, srcStart, srcEnd, comment);
        return { ok: true, source: next };
      } catch {
        // Fall through to a loosely-anchored save below.
      }
    }
  }
  // The selected text couldn't be placed as markers in the source — e.g. a
  // table cell or inline-formatted span whose visible text doesn't appear
  // verbatim in the markdown. Save the comment loosely-anchored (quote only,
  // no markers) so it's never lost: the live editor still highlights it by
  // matching the quote against the editor text; other surfaces show it as an
  // unanchored thread.
  const parsed = parse(source);
  const thread: InlineThread = {
    id: mintThreadId(parsed.threads.map((t) => t.id)),
    quote: anchor.text,
    status: "open",
    comments: [
      { id: "c1", author: comment.author, ts: comment.ts ?? new Date().toISOString(), body: comment.body },
    ],
  };
  return { ok: true, source: withThreads(source, [...parsed.threads, thread]) };
}

/**
 * Add a thread at exact selection offsets into `newBody` (the editor's current
 * body markdown). The marker is placed precisely at [selStart, selEnd) — no
 * text search — so commenting can't fail to "locate" the selection even when
 * the stored document has drifted from the editor's serialization. `newBody`
 * is adopted as the body (re-anchoring existing threads into it); the
 * frontmatter is re-prepended. Returns ok:false only when the offsets are
 * unusable, letting the caller fall back to the text-anchored path.
 */
export function addThreadAtOffsets(
  oldSource: string,
  newBody: string,
  selStart: number,
  selEnd: number,
  comment: { author: string; body: string; ts?: string },
): { ok: true; source: string } | { ok: false; error: string } {
  if (
    !Number.isInteger(selStart) ||
    !Number.isInteger(selEnd) ||
    selStart < 0 ||
    selEnd > newBody.length ||
    selStart >= selEnd ||
    newBody.slice(selStart, selEnd).trim().length === 0
  ) {
    return { ok: false, error: "selection offsets out of range" };
  }

  // Keep the open marker out of a heading's `#` prefix so the line stays a heading.
  selStart = startPastHeadingPrefix(newBody, selStart, selEnd);

  const { parsed, prose: oldProse, anchorsInProse } = buildBridge(oldSource);
  const newId = mintThreadId(parsed.threads.map((t) => t.id));
  const newThread: InlineThread = {
    id: newId,
    quote: newBody.slice(selStart, selEnd),
    status: "open",
    comments: [
      { id: "c1", author: comment.author, ts: comment.ts ?? new Date().toISOString(), body: comment.body },
    ],
  };

  // The new comment is placed exactly. Existing threads re-anchor by quote;
  // any that would overlap the new span (or each other) drop to unanchored.
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
    a.start < b.end && b.start < a.end;
  const kept: Array<{ id: string; start: number; end: number }> = [
    { id: newId, start: selStart, end: selEnd },
  ];
  for (const thread of parsed.threads) {
    const span = anchorsInProse.get(thread.id);
    if (!span) continue;
    const loc = locate(newBody, {
      text: oldProse.slice(span.proseStart, span.proseEnd),
      contextBefore: oldProse.slice(Math.max(0, span.proseStart - CONTEXT_CHARS), span.proseStart),
      contextAfter: oldProse.slice(span.proseEnd, span.proseEnd + CONTEXT_CHARS),
    });
    if (loc && !kept.some((k) => overlaps(k, loc))) {
      kept.push({ id: thread.id, start: loc.start, end: loc.end });
    }
  }
  kept.sort((a, b) => a.start - b.start);

  let marked = "";
  let cursor = 0;
  for (const p of kept) {
    marked +=
      newBody.slice(cursor, p.start) +
      openMarker(p.id) +
      newBody.slice(p.start, p.end) +
      closeMarker(p.id);
    cursor = p.end;
  }
  marked += newBody.slice(cursor);

  return { ok: true, source: withThreads(frontmatterOf(oldSource) + marked, [...parsed.threads, newThread]) };
}

/** Append a reply to a thread. Returns the rewritten source, or null if the thread is gone. */
export function replyToThread(
  source: string,
  threadId: string,
  reply: { author: string; body: string; ts?: string },
): string | null {
  const parsed = parse(source);
  const thread = parsed.threads.find((t) => t.id === threadId);
  if (!thread) return null;
  return replaceThread(source, threadId, appendReply(thread, reply));
}

/** Flip a thread's resolved state. Returns the rewritten source, or null if the thread is gone. */
export function setThreadResolved(
  source: string,
  threadId: string,
  resolved: boolean,
  by: string,
  ts?: string,
): string | null {
  const parsed = parse(source);
  const thread = parsed.threads.find((t) => t.id === threadId);
  if (!thread) return null;
  const next: InlineThread = resolved
    ? { ...thread, status: "resolved", resolvedBy: by, resolvedTs: ts ?? new Date().toISOString() }
    : { ...thread, status: "open", resolvedBy: undefined, resolvedTs: undefined };
  return replaceThread(source, threadId, next);
}

/** Remove a thread and its anchor markers. Returns the rewritten source, or null if the thread is gone. */
export function deleteThread(source: string, threadId: string): string | null {
  const parsed = parse(source);
  if (!parsed.threads.some((t) => t.id === threadId)) return null;
  return replaceThread(source, threadId, null);
}

/**
 * Delete a single comment within a thread. If the comment has replies, it is
 * tombstoned (kept as a deleted placeholder so the reply tree survives);
 * otherwise it is dropped outright. If that leaves no live comments, the whole
 * thread (and its anchor) is removed. Returns the rewritten source, or null
 * when the thread or comment isn't found.
 */
export function deleteComment(
  source: string,
  threadId: string,
  commentId: string,
): string | null {
  const parsed = parse(source);
  const thread = parsed.threads.find((t) => t.id === threadId);
  if (!thread) return null;
  if (!thread.comments.some((c) => c.id === commentId)) return null;
  const hasChildren = thread.comments.some((c) => c.parent === commentId && !c.deleted);
  const nextComments = hasChildren
    ? thread.comments.map((c) => (c.id === commentId ? { ...c, deleted: true, body: "" } : c))
    : thread.comments.filter((c) => c.id !== commentId);
  if (nextComments.filter((c) => !c.deleted).length === 0) {
    return replaceThread(source, thread.id, null);
  }
  return replaceThread(source, thread.id, { ...thread, comments: nextComments });
}

/**
 * Reconcile a prose-only edit from the editor back into the inline source.
 * Re-locates each anchored thread's text (with its surrounding context, both
 * taken from the pre-edit prose) inside the new prose and re-wraps it with
 * markers; threads whose text vanished or became ambiguous fall back to
 * unanchored (kept in the threads region with no markers). The threads
 * region is then re-appended.
 */
/**
 * The envelope of a single contiguous edit between two strings: the length of
 * the unchanged common prefix (`prefix`), the offset in `old` where the
 * unchanged common suffix begins (`oldSuffixStart`), and the length delta
 * (`delta = new.length - old.length`). Multi-region edits collapse to the
 * smallest envelope that covers all of them.
 */
interface EditEnvelope {
  prefix: number;
  oldSuffixStart: number;
  delta: number;
}

function diffEnvelope(oldStr: string, newStr: string): EditEnvelope {
  const oldLen = oldStr.length;
  const newLen = newStr.length;
  const minLen = Math.min(oldLen, newLen);
  let prefix = 0;
  while (prefix < minLen && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldStr.charCodeAt(oldLen - 1 - suffix) === newStr.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  return { prefix, oldSuffixStart: oldLen - suffix, delta: newLen - oldLen };
}

/**
 * Map an old marker span `[start, end)` through `edit`, but only when the whole
 * change is enclosed by the span (the edit happened inside the anchored text):
 * `start` sits in the unchanged prefix and `end` in the unchanged suffix. The
 * mapped span keeps the marker wrapped around the edited text. Returns null when
 * the edit isn't cleanly enclosed (e.g. it straddles a boundary or spans a
 * larger reflow), so the caller can leave the thread unanchored.
 */
function mapSpanThroughEnclosedEdit(
  edit: EditEnvelope,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (start <= edit.prefix && end >= edit.oldSuffixStart) {
    const mappedEnd = end + edit.delta;
    if (mappedEnd >= start) return { start, end: mappedEnd };
  }
  return null;
}

/**
 * Re-anchor by the text *bracketing* the anchor, not the anchor text itself.
 * When the user edits inside an anchored span the quote changes (so the text
 * search fails) and table re-padding can defeat the diff envelope — but the
 * context just before and after the span is unchanged. Find where that context
 * sits in the new prose and take everything between as the new anchored text.
 * Matching is whitespace-normalised so table column re-padding doesn't break it.
 *
 * `oldStart`/`delta` disambiguate repeated context by preferring the bracket
 * nearest the anchor's old position. Returns null when either side is too thin
 * to be specific, or no plausible bracket is found.
 */
function relocateByContext(
  newProse: string,
  contextBefore: string,
  contextAfter: string,
  oldStart: number,
  oldLen: number,
  delta: number,
): { start: number; end: number } | null {
  // Bracket with only the anchor's own line, not neighbouring rows: a table's
  // separator row (`| :--- |`) re-pads its dash run on every serialize, so
  // context that reaches across the line break would never match again.
  const cbLine = contextBefore.slice(contextBefore.lastIndexOf("\n") + 1);
  const caNl = contextAfter.indexOf("\n");
  const caLine = caNl >= 0 ? contextAfter.slice(0, caNl) : contextAfter;
  const nb = normalizeWs(cbLine);
  const na = normalizeWs(caLine);
  // Need a couple of real chars on each side, else the match is too loose.
  if (nb.length < 2 || na.length < 2) return null;

  const { normalized, map } = collapseWs(newProse);
  // Generous bound on the bracketed gap so we don't swallow a whole table/section
  // when the context repeats; the anchor can only have grown by the edit size.
  const maxGap = Math.max(oldLen * 4, oldLen + Math.abs(delta) + 80);
  const want = oldStart + delta; // expected raw start of the anchor after the edit

  let best: { start: number; end: number } | null = null;
  let bestDist = Infinity;
  let from = 0;
  while (true) {
    const bIdx = normalized.indexOf(nb, from);
    if (bIdx < 0) break;
    from = bIdx + 1;
    const afterB = bIdx + nb.length; // normalised index where the anchor begins
    const aIdx = normalized.indexOf(na, afterB); // anchor ends where context-after starts
    if (aIdx < 0) continue;
    if (aIdx - afterB > maxGap) continue;
    const start = map[afterB];
    const end = map[aIdx];
    if (start === undefined || end === undefined || end < start) continue;
    const dist = Math.abs(start - want);
    if (dist < bestDist) {
      bestDist = dist;
      best = { start, end };
    }
  }
  return best;
}

export function mergeProseEdit(oldSource: string, newProse: string): string {
  const { prose: oldProse, parsed, anchorsInProse } = buildBridge(oldSource);
  const threads = parsed.threads;

  // The single-edit envelope between old and new prose, used to keep a marker
  // alive when the user edits *inside* the anchored text (which changes the
  // quote, so the text search below can't find it).
  const edit = diffEnvelope(oldProse, newProse);

  const placements: Array<{ id: string; start: number; end: number }> = [];
  for (const thread of threads) {
    const span = anchorsInProse.get(thread.id);
    if (!span) continue; // already unanchored — leave it that way
    const quote = oldProse.slice(span.proseStart, span.proseEnd);
    const contextBefore = oldProse.slice(Math.max(0, span.proseStart - CONTEXT_CHARS), span.proseStart);
    const contextAfter = oldProse.slice(span.proseEnd, span.proseEnd + CONTEXT_CHARS);
    // First try to find the (unchanged) quote — robust to edits elsewhere and to
    // whitespace reflow. If that fails, the edit landed inside this anchor:
    //   1. diff-bracket: when the change is enclosed by the marker AND padding
    //      matches, map the bounds through the edit (precise; also covers anchors
    //      at the doc edge that have no context to bracket with).
    //   2. context-bracket: re-anchor by the unchanged surrounding text, which
    //      survives table re-padding the diff envelope can't.
    const loc =
      locate(newProse, { text: quote, contextBefore, contextAfter }) ??
      mapSpanThroughEnclosedEdit(edit, span.proseStart, span.proseEnd) ??
      relocateByContext(
        newProse,
        contextBefore,
        contextAfter,
        span.proseStart,
        span.proseEnd - span.proseStart,
        edit.delta,
      );
    if (loc) placements.push({ id: thread.id, start: loc.start, end: loc.end });
  }

  // Drop overlaps (keep the earliest); markers must nest cleanly.
  placements.sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: typeof placements = [];
  let lastEnd = -1;
  for (const p of placements) {
    if (p.start < lastEnd) continue;
    kept.push(p);
    lastEnd = p.end;
  }

  let marked = "";
  let cursor = 0;
  for (const p of kept) {
    marked +=
      newProse.slice(cursor, p.start) +
      openMarker(p.id) +
      newProse.slice(p.start, p.end) +
      closeMarker(p.id);
    cursor = p.end;
  }
  marked += newProse.slice(cursor);

  // Re-prepend the frontmatter the editor never sees, so it round-trips
  // verbatim instead of being lost when the body is written back.
  return withThreads(frontmatterOf(oldSource) + marked, threads);
}
