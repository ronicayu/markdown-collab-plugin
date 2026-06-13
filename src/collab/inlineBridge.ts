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
import { locateAnchorInLiveText } from "./liveAnchorLocator";

/** Anchor shape exchanged with the webview (markdown-source space). */
export interface CollabCommentAnchor {
  text: string;
  contextBefore: string;
  contextAfter: string;
}

/** Flat per-thread comment the webview sidebar renders. `id` is the thread id. */
export interface CollabComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  anchor: CollabCommentAnchor;
  replies: Array<{ author: string; body: string; createdAt: string }>;
}

/** How many chars of surrounding prose to capture as anchor context. */
const CONTEXT_CHARS = 24;

// `locateAnchorInLiveText` runs the anchor's context through `stripInlineMarkup`
// (which drops newlines) but the haystack side only collapses whitespace to a
// single space — so context spanning a blank line ("bank.\n\nA" vs "bank. A")
// fails to match. Collapse our context the same way the haystack is collapsed
// before handing it to the locator. (Localized here so the shared locator and
// the webview highlight path are untouched.)
const collapseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

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
    contextBefore: collapseWs(anchor.contextBefore),
    contextAfter: collapseWs(anchor.contextAfter),
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
      body: root.body,
      author: root.author,
      createdAt: root.ts,
      resolved: thread.status === "resolved",
      anchor,
      replies: visible.slice(1).map((r) => ({ author: r.author, body: r.body, createdAt: r.ts })),
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
): { ok: true; source: string } | { ok: false; error: string } {
  const { prose, proseToSrc } = buildBridge(source);
  const range = locate(prose, anchor);
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
 * Reconcile a prose-only edit from the editor back into the inline source.
 * Re-locates each anchored thread's text (with its surrounding context, both
 * taken from the pre-edit prose) inside the new prose and re-wraps it with
 * markers; threads whose text vanished or became ambiguous fall back to
 * unanchored (kept in the threads region with no markers). The threads
 * region is then re-appended.
 */
export function mergeProseEdit(oldSource: string, newProse: string): string {
  const { prose: oldProse, parsed, anchorsInProse } = buildBridge(oldSource);
  const threads = parsed.threads;

  const placements: Array<{ id: string; start: number; end: number }> = [];
  for (const thread of threads) {
    const span = anchorsInProse.get(thread.id);
    if (!span) continue; // already unanchored — leave it that way
    const quote = oldProse.slice(span.proseStart, span.proseEnd);
    const contextBefore = oldProse.slice(Math.max(0, span.proseStart - CONTEXT_CHARS), span.proseStart);
    const contextAfter = oldProse.slice(span.proseEnd, span.proseEnd + CONTEXT_CHARS);
    const loc = locate(newProse, { text: quote, contextBefore, contextAfter });
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
