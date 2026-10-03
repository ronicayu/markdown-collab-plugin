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
  isInCode,
  mintThreadId,
  parse,
  replaceThread,
  startPastHeadingPrefix,
  withThreads,
  type InlineSuggestion,
  type InlineThread,
  type ParsedDocument,
  type ReviewCheckpoint,
} from "../inlineComments/format";
import { opOpenAt } from "../inlineComments/docOps";
import { checkIntegrity } from "../inlineComments/integrity";
import { isThreadStale } from "../inlineComments/staleness";
import {
  collapseWs,
  locateAnchorInLiveText,
  locateNthOccurrence,
  normalizeWs,
} from "./liveAnchorLocator";
import type { BlockEdit } from "./blockEdits";
import {
  editorBlockCount,
  editorRangeToSource,
  markdownBlocks,
  spliceMarkdownBlocks,
  type BlockSplice,
  type EditorPoint,
  type MarkdownBlock,
} from "./sourcePositions";

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
  /**
   * The anchored span in prose offsets (`proseOf(source)`, the string the
   * editor parses); -1 when unanchored. The read-only editor highlights by
   * these instead of searching for `anchor.text` (docs/one-view-design.md).
   */
  proseStart: number;
  proseEnd: number;
  /** The anchored text changed after this thread's last comment (P1.3). */
  stale: boolean;
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
function locateWithContext(
  prose: string,
  anchor: CollabCommentAnchor,
): { start: number; end: number } | null {
  return locateAnchorInLiveText(prose, {
    text: anchor.text,
    contextBefore: normalizeWs(anchor.contextBefore),
    contextAfter: normalizeWs(anchor.contextAfter),
  });
}

function locateTextOnly(prose: string, text: string): { start: number; end: number } | null {
  return locateAnchorInLiveText(prose, { text, contextBefore: "", contextAfter: "" });
}

function locate(
  prose: string,
  anchor: CollabCommentAnchor,
): { start: number; end: number } | null {
  return locateWithContext(prose, anchor) ?? locateTextOnly(prose, anchor.text);
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
// The last bridge built. A push to the webview runs `proseOf`, `commentsOf`
// and `suggestionsOf` on the same source in a row, and edit mode splices
// against it once per keystroke; nothing mutates a bridge once built.
let lastBridge: Bridge | null = null;

function buildBridge(source: string): Bridge {
  if (lastBridge && lastBridge.parsed.source === source) return lastBridge;
  lastBridge = computeBridge(source);
  return lastBridge;
}

function computeBridge(source: string): Bridge {
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
      proseStart: span ? span.proseStart : -1,
      proseEnd: span ? span.proseEnd : -1,
      stale: isThreadStale(parsed, thread.id),
      replies: visible.slice(1).map((r) => ({ id: r.id, author: r.author, body: r.body, createdAt: r.ts })),
    });
  }
  return out;
}

/** A pending suggestion the live-editor sidebar renders (suggest mode). */
export interface CollabSuggestion {
  anchorId: string;
  threadId?: string;
  author: string;
  ts: string;
  original: string;
  proposed: string;
  note?: string;
  /** Locator for the original text in the live editor (same scheme as comments). */
  anchor: CollabCommentAnchor;
  /** Which occurrence of `anchor.text` the marker wraps, 0-based; -1 if unanchored. */
  anchorOrdinal: number;
  /** The anchored span in prose offsets, as on `CollabComment`; -1 when unanchored. */
  proseStart: number;
  proseEnd: number;
}

export function suggestionsOf(source: string): CollabSuggestion[] {
  const { prose, parsed, anchorsInProse } = buildBridge(source);
  const out: CollabSuggestion[] = [];
  for (const s of parsed.suggestions) {
    const span = anchorsInProse.get(s.anchorId);
    const anchor: CollabCommentAnchor = span
      ? {
          text: prose.slice(span.proseStart, span.proseEnd),
          contextBefore: prose.slice(Math.max(0, span.proseStart - CONTEXT_CHARS), span.proseStart),
          contextAfter: prose.slice(span.proseEnd, span.proseEnd + CONTEXT_CHARS),
        }
      : { text: s.original, contextBefore: "", contextAfter: "" };
    out.push({
      anchorId: s.anchorId,
      threadId: s.threadId,
      author: s.author,
      ts: s.ts,
      original: s.original,
      proposed: s.proposed,
      note: s.note,
      anchor,
      anchorOrdinal: span ? occurrenceIndex(prose, anchor.text, span.proseStart) : -1,
      proseStart: span ? span.proseStart : -1,
      proseEnd: span ? span.proseEnd : -1,
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
 * is adopted as the body (re-anchoring existing threads and suggestions into
 * it, and preserving the review checkpoint); the frontmatter is re-prepended.
 * Returns ok:false only when the offsets are unusable, letting the caller
 * fall back to the text-anchored path.
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
  // Pending suggestions re-anchor the same way — otherwise a comment added
  // elsewhere in the document would silently strand every suggestion's markers.
  for (const s of parsed.suggestions) {
    const span = anchorsInProse.get(s.anchorId);
    if (!span) continue;
    const loc = locate(newBody, {
      text: oldProse.slice(span.proseStart, span.proseEnd),
      contextBefore: oldProse.slice(Math.max(0, span.proseStart - CONTEXT_CHARS), span.proseStart),
      contextAfter: oldProse.slice(span.proseEnd, span.proseEnd + CONTEXT_CHARS),
    });
    if (loc && !kept.some((k) => overlaps(k, loc))) {
      kept.push({ id: s.anchorId, start: loc.start, end: loc.end });
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

  // `withThreads` only keeps whatever suggestions/checkpoint IT can parse back
  // out of the string it's handed — and `frontmatterOf(oldSource) + marked` has
  // no threads region at all (buildBridge stripped it), so without passing
  // `parsed.suggestions`/`parsed.checkpoint` explicitly here, both are silently
  // dropped even though this write never touched either.
  return {
    ok: true,
    source: withThreads(
      frontmatterOf(oldSource) + marked,
      [...parsed.threads, newThread],
      parsed.suggestions,
      parsed.checkpoint,
    ),
  };
}

/**
 * Add a thread on a prose range the read-only editor mapped from a selection
 * (docs/one-view-design.md). Unlike `addThreadAtOffsets`, nothing the editor
 * serialized is adopted: the range is translated to the file's own offsets
 * through the table `proseOf` builds (the review view's add does the same,
 * `mutations.ts`), and `opOpenAt` inserts the two markers and the thread
 * record. Every other byte — prose, other markers, suggestions, the
 * checkpoint — stays as it was.
 *
 * `range.text` is the prose the editor saw under the selection, and
 * `before` / `after` what it saw around it. If the file has changed since,
 * the offsets would land on other text, so the add is refused rather than
 * placed.
 *
 * A boundary inside an autolink or a bare URL, or between an intraword
 * delimiter run and its text, moves to the construct's edge: a marker there
 * would stop the link being a link, or the run flanking its text, wherever
 * the raw file is rendered.
 */
export function addThreadAtProseRange(
  source: string,
  range: { start: number; end: number; text: string; before?: string; after?: string },
  comment: { author: string; body: string; ts?: string },
): { ok: true; source: string } | { ok: false; error: string } {
  const { prose, proseToSrc } = buildBridge(source);
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > prose.length || end <= start) {
    return { ok: false, error: "The selection is outside the document." };
  }
  const changed =
    prose.slice(start, end) !== range.text ||
    (range.before !== undefined && prose.slice(Math.max(0, start - range.before.length), start) !== range.before) ||
    (range.after !== undefined && prose.slice(end, end + range.after.length) !== range.after);
  if (changed) {
    return { ok: false, error: "The document changed since you selected this text. Select it again." };
  }
  // End boundary: just past the last selected character, so a marker that
  // follows it in the file stays outside the new span.
  const { start: srcStart, end: srcEnd } = widenOverSyntax(source, proseToSrc[start]!, proseToSrc[end - 1]! + 1);
  const ts = comment.ts ?? new Date().toISOString();
  try {
    const { next } = opOpenAt(source, srcStart, srcEnd, comment.body, comment.author, () => ts);
    return { ok: true, source: next };
  } catch (e) {
    // addThread refuses code, frontmatter and the threads region; the
    // integrity gate refuses a write that would break the file.
    return { ok: false, error: (e as Error).message };
  }
}

const AUTOLINK =
  /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/y;
const URL_LITERAL = /(?:https?:\/\/|www\.)[^\s<]*/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * `[start, end)` of `source` with each boundary moved out of a construct a
 * marker would break: an autolink (`<https://…>`), a bare URL, or — for a
 * boundary between an intraword `*` / `~` run and its text — the run.
 */
function widenOverSyntax(source: string, start: number, end: number): { start: number; end: number } {
  /** The autolink or URL literal `at` falls strictly inside, as `[from, to)`. */
  const linkAround = (at: number): [number, number] | null => {
    const from = source.lastIndexOf("\n", at - 1) + 1;
    const nl = source.indexOf("\n", at);
    const line = source.slice(from, nl < 0 ? source.length : nl);
    for (let lt = line.lastIndexOf("<", at - from - 1); lt >= 0; lt = lt > 0 ? line.lastIndexOf("<", lt - 1) : -1) {
      AUTOLINK.lastIndex = lt;
      const m = AUTOLINK.exec(line);
      if (m && from + lt < at && at < from + lt + m[0].length) return [from + lt, from + lt + m[0].length];
    }
    URL_LITERAL.lastIndex = 0;
    for (let m = URL_LITERAL.exec(line); m; m = URL_LITERAL.exec(line)) {
      // A link's or a definition's destination (`](https://…)`, `[x]: https://…`) isn't a literal.
      if (/(?:\]\(|\]:[ \t]*)$/.test(line.slice(0, m.index))) continue;
      // GFM leaves trailing punctuation, and an unbalanced `)`, out of the link.
      let url = m[0];
      while (/[?!.,:*_~]$/.test(url) || (url.endsWith(")") && url.split("(").length < url.split(")").length)) {
        url = url.slice(0, -1);
      }
      if (from + m.index < at && at < from + m.index + url.length) return [from + m.index, from + m.index + url.length];
    }
    return null;
  };
  start = linkAround(start)?.[0] ?? start;
  end = linkAround(end)?.[1] ?? end;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  // An opening run right before the text, with a word character before it.
  let run = start;
  while (run > lineStart && (source[run - 1] === "*" || source[run - 1] === "~")) run--;
  if (run < start && run > lineStart && WORD_CHAR.test(source[run - 1]!)) start = run;
  // A closing run right after the text, with a word character after it.
  run = end;
  while (run < source.length && (source[run] === "*" || source[run] === "~")) run++;
  if (run > end && run < source.length && WORD_CHAR.test(source[run]!)) end = run;
  return { start, end };
}

/**
 * Add a thread on an edit-mode selection: its first and last characters,
 * named by structure (`EditorPoint`) — edit mode's document carries no source
 * positions. They're found in the file's own bytes by the alignment the
 * read-only editor uses, and the add goes through `addThreadAtProseRange`:
 * two markers and the record, nothing re-serialized. Refused when the file's
 * bytes there don't explain what the editor showed.
 */
export function addThreadAtEditorRange(
  source: string,
  range: { first: EditorPoint; last: EditorPoint },
  comment: { author: string; body: string; ts?: string },
): { ok: true; source: string } | { ok: false; error: string } {
  const prose = proseOf(source);
  const span = editorRangeToSource(prose, range.first, range.last);
  if (!span) return { ok: false, error: "The document changed since you selected this text. Select it again." };
  return addThreadAtProseRange(source, { start: span.start, end: span.end, text: prose.slice(span.start, span.end) }, comment);
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

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

function diffEnvelope(oldStr: string, newStr: string): EditEnvelope {
  const oldLen = oldStr.length;
  const newLen = newStr.length;
  const minLen = Math.min(oldLen, newLen);
  let prefix = 0;
  while (prefix < minLen && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
  // charCodeAt works in UTF-16 code units, so a boundary can fall between the
  // halves of a surrogate pair (e.g. two emoji sharing a high surrogate). Back
  // the prefix off a trailing high surrogate so it never splits a code point.
  if (prefix > 0 && isHighSurrogate(oldStr.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldStr.charCodeAt(oldLen - 1 - suffix) === newStr.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  // Likewise: don't let the suffix begin on a lone low surrogate.
  if (suffix > 0 && isLowSurrogate(oldStr.charCodeAt(oldLen - suffix))) suffix--;
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
    // Reject a collapse to zero width (the edit deleted the whole anchored
    // text) — leave the thread unanchored rather than emit an empty marker.
    if (mappedEnd > start) return { start, end: mappedEnd };
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
 * `want` (the expected post-edit start) disambiguates repeated context by
 * preferring the bracket nearest it. Returns null when either side is too thin
 * to be specific, or no plausible bracket is found.
 */
function relocateByContext(
  newProse: string,
  collapsedNew: { normalized: string; map: number[] },
  contextBefore: string,
  contextAfter: string,
  want: number,
  oldLen: number,
  delta: number,
): { start: number; end: number } | null {
  // Bracket with only the anchor's own line, not neighbouring rows: a table's
  // separator row (`| :--- |`) re-pads its dash run on every serialize, so
  // context that reaches across the line break would never match again. But for
  // a line-edge anchor the own-line context is empty/too thin, so fall back to
  // the full cross-line context — prose has no re-padded separators to confuse,
  // and table cells always have a `| ` prefix so they keep the own-line form.
  const cbLine = contextBefore.slice(contextBefore.lastIndexOf("\n") + 1);
  const caNl = contextAfter.indexOf("\n");
  const caLine = caNl >= 0 ? contextAfter.slice(0, caNl) : contextAfter;
  let nb = normalizeWs(cbLine);
  let na = normalizeWs(caLine);
  if (nb.length < 2) nb = normalizeWs(contextBefore);
  if (na.length < 2) na = normalizeWs(contextAfter);
  // Need a couple of real chars on each side, else the match is too loose.
  if (nb.length < 2 || na.length < 2) return null;

  const { normalized, map } = collapsedNew;
  // Generous bound on the bracketed gap so we don't swallow a whole table/section
  // when the context repeats; the anchor can only have grown by the edit size.
  const maxGap = Math.max(oldLen * 4, oldLen + Math.abs(delta) + 80);

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
    let start = map[afterB];
    let end = map[aIdx];
    if (start === undefined || end === undefined) continue;
    // The normalized→raw map points a collapsed whitespace run at its first
    // char, so the bracket can include padding spaces/newlines. Trim them so the
    // marker wraps just the anchored text (and never a structural newline).
    while (start < end && /\s/.test(newProse[start]!)) start++;
    while (end > start && /\s/.test(newProse[end - 1]!)) end--;
    if (end <= start) continue; // nothing but whitespace between the brackets
    const dist = Math.abs(start - want);
    if (dist < bestDist) {
      bestDist = dist;
      best = { start, end };
    }
  }
  return best;
}

/**
 * Re-anchor one thread's span into `newProse` by text, tiered most-trustworthy
 * first:
 *   1. context+text match — robust to edits elsewhere and whitespace reflow.
 *   2. diff-bracket — the edit is enclosed by the marker AND padding matches
 *      (precise; also covers doc-edge anchors with no context to bracket).
 *   3. context-bracket — re-anchor by the unchanged surrounding text, which
 *      survives table re-padding the diff envelope can't.
 *   4. text-only — a unique match LAST, and only when it's near where the anchor
 *      was, so a stale duplicate elsewhere can't yank the marker across the doc.
 */
function reanchorThreadByText(
  oldProse: string,
  newProse: string,
  collapsed: () => { normalized: string; map: number[] },
  edit: EditEnvelope,
  span: { proseStart: number; proseEnd: number },
): { start: number; end: number } | null {
  const quote = oldProse.slice(span.proseStart, span.proseEnd);
  const oldLen = span.proseEnd - span.proseStart;
  const contextBefore = oldProse.slice(Math.max(0, span.proseStart - CONTEXT_CHARS), span.proseStart);
  const contextAfter = oldProse.slice(span.proseEnd, span.proseEnd + CONTEXT_CHARS);
  const anchor = { text: quote, contextBefore, contextAfter };
  // Expected raw start of this anchor after the edit: unchanged if it sits in the
  // common prefix (edit is at/after it), else shifted by the length delta.
  const want = span.proseStart <= edit.prefix ? span.proseStart : span.proseStart + edit.delta;
  const loc =
    locateWithContext(newProse, anchor) ??
    mapSpanThroughEnclosedEdit(edit, span.proseStart, span.proseEnd) ??
    relocateByContext(newProse, collapsed(), contextBefore, contextAfter, want, oldLen, edit.delta);
  if (loc) return loc;
  const textHit = locateTextOnly(newProse, quote);
  if (textHit && Math.abs(textHit.start - want) <= Math.max(oldLen * 4, 200)) return textHit;
  return null;
}

/**
 * Recover an unanchored thread (no live marker) by its stored quote: if that
 * exact text occurs *uniquely* in the new prose, re-anchor there. Requires a
 * unique match (locateTextOnly returns null on 0 or >1 hits) so a short or
 * duplicated quote can't grab the wrong occurrence. This is what restores a
 * comment after the user deletes its text and then hits undo.
 */
function recoverUnanchoredByQuote(
  newProse: string,
  quote: string,
): { start: number; end: number } | null {
  if (quote.trim().length === 0) return null;
  const r = locateTextOnly(newProse, quote);
  return r && r.end > r.start ? r : null;
}

export function mergeProseEdit(oldSource: string, newProse: string): string {
  const { prose: oldProse, parsed, anchorsInProse } = buildBridge(oldSource);
  const threads = parsed.threads;
  const suggestions = parsed.suggestions;
  const edit = diffEnvelope(oldProse, newProse);
  // Whitespace-collapsed view of newProse for the context-bracket fallback.
  // Computed at most once per merge (only when a thread actually reaches that
  // tier), not once per thread — mergeProseEdit runs on every debounced edit.
  let collapsedNew: { normalized: string; map: number[] } | null = null;
  const collapsed = (): { normalized: string; map: number[] } =>
    (collapsedNew ??= collapseWs(newProse));

  const placements: Array<{ id: string; start: number; end: number }> = [];
  for (const thread of threads) {
    const span = anchorsInProse.get(thread.id);
    // No marker: try to recover by the stored quote (undo brought deleted text
    // back); otherwise leave it unanchored. With a marker: re-anchor by text.
    const loc = span
      ? reanchorThreadByText(oldProse, newProse, collapsed, edit, span)
      : recoverUnanchoredByQuote(newProse, thread.quote);
    if (loc) placements.push({ id: thread.id, start: loc.start, end: loc.end });
  }
  // Pending suggestions re-anchor the same way threads do — a suggestion's
  // anchor markers get stripped out of the prose the editor sees (buildBridge
  // treats them the same as thread markers), so without this every prose edit
  // would silently unanchor every suggestion in the document.
  for (const s of suggestions) {
    const span = anchorsInProse.get(s.anchorId);
    const loc = span
      ? reanchorThreadByText(oldProse, newProse, collapsed, edit, span)
      : recoverUnanchoredByQuote(newProse, s.original);
    if (loc) placements.push({ id: s.anchorId, start: loc.start, end: loc.end });
  }

  return assembleMarkedSource(oldSource, newProse, threads, suggestions, parsed.checkpoint, placements);
}

/**
 * Wrap each placement's `[start, end)` of `newProse` in its marker (a
 * placement's `id` may be a thread id or a suggestion's `anchorId` — the
 * wrapping itself doesn't care which), dropping overlaps (markers must nest
 * cleanly), then re-prepend the frontmatter the editor never sees and
 * re-append the threads region with `threads`, `suggestions` and `checkpoint`
 * passed through explicitly. That last part matters: the string this builds
 * (`frontmatterOf(oldSource) + marked`) has no threads region at all — it was
 * stripped out by `buildBridge` — so `withThreads` has nothing of its own to
 * fall back to keeping; passing these in is the only way they survive.
 */
function assembleMarkedSource(
  oldSource: string,
  newProse: string,
  threads: InlineThread[],
  suggestions: InlineSuggestion[],
  checkpoint: ReviewCheckpoint | null,
  placements: Array<{ id: string; start: number; end: number }>,
): string {
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

  return withThreads(frontmatterOf(oldSource) + marked, threads, suggestions, checkpoint);
}

/**
 * Re-anchor using positions the editor already tracks. The live editor's anchor
 * highlights are ProseMirror decorations that map through every edit natively
 * (insert/delete inside a span grows/shifts it losslessly), so on each edit the
 * editor can report, per comment, the *current* text of its span and which
 * occurrence of that text it is. Placing the marker at that occurrence lands it
 * exactly where the comment now sits — no quote re-matching, no diff/context
 * heuristics — even when the user edited the anchored text itself.
 *
 * A thread the editor no longer reports (its decoration was dropped because the
 * text was fully deleted) is left unanchored. This is the authoritative edit
 * path; `mergeProseEdit` remains the fallback when no anchor info is supplied.
 */
export function placeAnchorsInProse(
  oldSource: string,
  newProse: string,
  anchors: Array<{ id: string; text: string; ordinal: number }>,
): string {
  const { prose: oldProse, parsed, anchorsInProse } = buildBridge(oldSource);
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const edit = diffEnvelope(oldProse, newProse);
  let collapsedNew: { normalized: string; map: number[] } | null = null;
  const collapsed = (): { normalized: string; map: number[] } =>
    (collapsedNew ??= collapseWs(newProse));

  const placements: Array<{ id: string; start: number; end: number }> = [];
  for (const thread of parsed.threads) {
    const reported = byId.get(thread.id);
    const span = anchorsInProse.get(thread.id);
    let loc: { start: number; end: number } | null = null;
    // Editor reported a live position → place there exactly (works even for a
    // thread that had no inline marker before, e.g. a previously-loose anchor
    // the editor is now tracking).
    if (reported && reported.text.trim().length > 0) {
      const r = locateNthOccurrence(newProse, reported.text, reported.ordinal);
      if (r && r.end > r.start) loc = r;
    }
    // Not reported (decoration destroyed by a cut/paste move) or reported but
    // unplaceable: if it had a marker before, re-anchor by text so it follows
    // its text instead of being dropped. Genuinely-deleted text fails to locate
    // and the thread is left unanchored. A thread that was already unanchored and
    // isn't tracked stays unanchored.
    if (!loc && span) loc = reanchorThreadByText(oldProse, newProse, collapsed, edit, span);
    // Recovery: a thread with no live marker that the editor isn't tracking — its
    // decoration was dropped when its text was deleted and an undo brought the
    // text back (ProseMirror can't resurrect a dropped decoration). Re-anchor to
    // a unique occurrence of its stored quote so it isn't left orphaned.
    if (!loc && !span) loc = recoverUnanchoredByQuote(newProse, thread.quote);
    if (loc) placements.push({ id: thread.id, start: loc.start, end: loc.end });
  }
  // The editor doesn't track suggestion spans as decorations (suggestions show
  // as sidebar cards, not live highlights), so there's no reported position to
  // place by — fall back straight to text re-anchoring, same as an unreported
  // thread.
  for (const s of parsed.suggestions) {
    const span = anchorsInProse.get(s.anchorId);
    let loc: { start: number; end: number } | null = span
      ? reanchorThreadByText(oldProse, newProse, collapsed, edit, span)
      : null;
    if (!loc && !span) loc = recoverUnanchoredByQuote(newProse, s.original);
    if (loc) placements.push({ id: s.anchorId, start: loc.start, end: loc.end });
  }
  return assembleMarkedSource(oldSource, newProse, parsed.threads, parsed.suggestions, parsed.checkpoint, placements);
}

// --- edit mode: block-splice write-back --------------------------------------
//
// docs/one-view-design.md, "Phase B: edit mode". The webview reports which
// top-level blocks an edit changed and their new Markdown (`BlockEdit`); this
// splices each into the file's own bytes at that block's range. Every other
// byte — frontmatter, the threads region, every other block and its markers —
// stays as it was. Nothing here ever adopts a whole-document serialization.

export type BlockEditResult =
  | {
      ok: true;
      source: string;
      /** The span of the old source that changed and its new text: the smallest write. */
      range: { start: number; end: number; text: string };
      /** The new prose and its block table, the base for the next edit. */
      prose: string;
      blocks: MarkdownBlock[];
      /** Anchors inside a changed block whose text couldn't be found again; their markers are gone. */
      unanchored: string[];
    }
  | { ok: false; error: string };

const lineStartOf = (text: string, at: number): number => text.lastIndexOf("\n", at - 1) + 1;

/** `at`, moved past trailing blanks when only blanks follow it on its line. */
function lineEndOf(text: string, at: number): number {
  let j = at;
  while (text[j] === " " || text[j] === "\t") j++;
  return j === text.length || text[j] === "\n" || text[j] === "\r" ? j : at;
}

/** Index of the first difference between two lists, or null when equal. */
function firstDifference(a: readonly string[], b: readonly string[]): number | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return null;
}

/**
 * Keep a re-serialized list's own marker. The serializer writes every bullet
 * as `*` and every ordered delimiter as `.`; beside a list that uses that
 * marker, the edited list would merge into it (CommonMark only separates two
 * adjacent lists by a change of marker), and elsewhere it's churn on every
 * item line. Only lines at column 0 are item markers of the list itself — the
 * serializer indents everything inside an item.
 */
function keepListMarker(prose: string, block: MarkdownBlock, text: string): string {
  const ordered = block.type === "ordered_list";
  const head = prose.slice(block.start, block.start + 11);
  const want = ordered ? /^\d{1,9}([.)])/.exec(head)?.[1] : /^[-+*]/.exec(head)?.[0];
  if (!want) return text;
  const item = ordered ? /^(\d{1,9})([.)])(?=[ \t]|$)/ : /^([-+*])(?=[ \t]|$)/;
  let changed = false;
  const lines = text.split("\n").map((line) => {
    const m = item.exec(line);
    const have = m ? (ordered ? m[2] : m[1]) : undefined;
    if (!m || have === want) return line;
    changed = true;
    return ordered ? m[1] + want + line.slice(m[0].length) : want + line.slice(1);
  });
  if (!changed) return text;
  const rewritten = lines.join("\n");
  // Only if it still parses as the one list it was.
  const check = markdownBlocks(rewritten);
  return check.length === 1 && check[0]!.type === block.type ? rewritten : text;
}

/**
 * Where a marker whose partner lies outside the changed block goes in the new
 * text: through the edit envelope, and when the edit straddles it, to the edge
 * that keeps the edited text inside the span.
 */
function mapMarker(edit: EditEnvelope, at: number, isOpen: boolean, length: number): number {
  const mapped =
    at <= edit.prefix
      ? at
      : at >= edit.oldSuffixStart
        ? at + edit.delta
        : isOpen
          ? edit.prefix
          : edit.oldSuffixStart + edit.delta;
  return Math.max(0, Math.min(length, mapped));
}

// What the format reads as its own wherever it isn't in code (format.ts): an
// anchor marker, a threads region fence, a thread / suggestion / checkpoint line.
const FORMAT_CONSTRUCTS = [
  /<!--mc:a:[a-z0-9]{1,12}-->/g,
  /<!--mc:\/a:[a-z0-9]{1,12}-->/g,
  /<!--mc:threads:(?:begin|end)-->/g,
  /<!--mc:(?:t|s|rev)\s+\{[\s\S]*?\}\s*-->/g,
];

/**
 * Whether `text` has, outside code, something the format would read as a
 * marker or a record. Any other `<!--mc:` — typed as prose, which the
 * serializer writes as `\<!--mc:` — is text. (A backslash doesn't stop the
 * format reading a whole marker, so an escaped one still counts.)
 */
function carriesMarker(text: string): boolean {
  for (const re of FORMAT_CONSTRUCTS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!isInCode(text, m.index, m.index + m[0].length)) return true;
    }
  }
  return false;
}

/**
 * Whether `full` — a parse of the new prose — is `blocks` with `splices`
 * applied: every other block where it was, shifted, and each splice's new
 * blocks, of the sent types, inside its new text.
 */
function sameStructure(full: readonly MarkdownBlock[], blocks: readonly MarkdownBlock[], splices: readonly BlockSplice[]): boolean {
  type Expected = { at: [number, number]; type: string; placeholder: boolean; within?: boolean };
  const expected: Expected[] = [];
  let shift = 0;
  let k = 0;
  const keep = (b: MarkdownBlock): void => {
    expected.push({ at: [b.start + shift, b.end + shift], type: b.type, placeholder: !!b.placeholder });
  };
  for (const s of splices) {
    for (; k < s.from; k++) keep(blocks[k]!);
    const at = s.start + shift;
    for (const type of s.types) expected.push({ at: [at, at + s.length], type, placeholder: false, within: true });
    shift += s.length - (s.end - s.start);
    k = s.to;
  }
  for (; k < blocks.length; k++) keep(blocks[k]!);
  if (full.length !== expected.length) return false;
  return full.every((b, i) => {
    const x = expected[i]!;
    if (b.type !== x.type) return false;
    return x.within ? b.start >= x.at[0] && b.end <= x.at[1] : b.start === x.at[0] && b.end === x.at[1] && !!b.placeholder === x.placeholder;
  });
}

/** Integrity issues of `source` other than a thread without markers, as `kind:id` keys. */
function damageOf(source: string): Set<string> {
  return new Set(
    checkIntegrity(source)
      .issues.filter((i) => i.kind !== "unanchored-thread" && i.kind !== "unanchored-suggestion")
      .map((i) => `${i.kind}:${i.threadId ?? ""}`),
  );
}

// Words, runs of whitespace, and single other characters: re-padding a table
// or splitting `**a `b`**` into `**a** **`b`**` changes only the tokens of
// the markup and the padding, never a word.
const TOKEN = /[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu;

/**
 * Where each character of `a` is in `b`: `map[i]` is its offset there, or -1
 * when the token holding it changed. The common prefix and suffix map
 * directly; the rest is a shortest token diff (Myers). Null when the texts
 * differ in more tokens than are worth aligning.
 */
function alignTexts(a: string, b: string): Int32Array | null {
  const map = new Int32Array(a.length).fill(-1);
  const env = diffEnvelope(a, b);
  for (let i = 0; i < env.prefix; i++) map[i] = i;
  for (let i = env.oldSuffixStart; i < a.length; i++) map[i] = i + env.delta;
  const tokens = (text: string, from: number, to: number): Array<{ at: number; text: string }> =>
    [...text.slice(from, to).matchAll(TOKEN)].map((m) => ({ at: from + m.index!, text: m[0] }));
  const x = tokens(a, env.prefix, env.oldSuffixStart);
  const y = tokens(b, env.prefix, env.oldSuffixStart + env.delta);
  const pairs = matchTokens(x.map((t) => t.text), y.map((t) => t.text), 1000);
  if (!pairs) return null;
  for (const [i, j] of pairs) {
    for (let c = 0; c < x[i]!.text.length; c++) map[x[i]!.at + c] = y[j]!.at + c;
  }
  return map;
}

/** Matched index pairs of a shortest edit script between `x` and `y`, or null past `maxEdits`. */
function matchTokens(x: readonly string[], y: readonly string[], maxEdits: number): Array<[number, number]> | null {
  const n = x.length;
  const m = y.length;
  const limit = Math.min(n + m, maxEdits);
  const off = limit + 1;
  const v = new Int32Array(2 * off + 1);
  // trace[d] holds v[-(d+1) .. d+1] as it was before step d.
  const trace: Int32Array[] = [];
  const at = (t: Int32Array, d: number, k: number): number => t[k + d + 1]!;
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[off + k] = i;
      if (i >= n && j >= m) {
        const pairs: Array<[number, number]> = [];
        let xi = n;
        let yi = m;
        for (let e = d; e > 0; e--) {
          const t = trace[e]!;
          const kk = xi - yi;
          const prevK = kk === -e || (kk !== e && at(t, e, kk - 1) < at(t, e, kk + 1)) ? kk + 1 : kk - 1;
          const prevX = at(t, e, prevK);
          const prevY = prevX - prevK;
          while (xi > prevX && yi > prevY) pairs.push([--xi, --yi]);
          xi = prevX;
          yi = prevY;
        }
        while (xi > 0 && yi > 0) pairs.push([--xi, --yi]);
        return pairs;
      }
    }
  }
  return null;
}

interface PlannedSplice {
  edit: BlockEdit;
  /** Replaced prose range and the text replacing it (separators included). */
  ps: number;
  pe: number;
  text: string;
  /** Replaced source range: the prose range widened over markers glued to its edges. */
  ss: number;
  se: number;
}

/**
 * Apply the live editor's block edits to `source`. `blocks` is the table of
 * `proseOf(source)` (`markdownBlocks`), passed in when the caller has it.
 *
 * Refuses — changing nothing — when the editor's blocks aren't the table's
 * (`baseTypes`), when an edit is malformed, when a range reaches frontmatter
 * or the threads region, or when new text carries a review marker.
 *
 * Markers: an anchor with both markers in a changed block is re-placed in the
 * new text by the same tiered text matching `mergeProseEdit` uses, on that
 * block's text only — or loses its markers when the text is gone. An anchor
 * with one marker outside keeps that one and maps the other. A thread with no
 * markers whose quote is unique in the new prose and falls inside the block
 * gets them back (the text returned by undo).
 */
export function applyBlockEdits(
  source: string,
  request: { baseTypes: readonly string[]; edits: readonly BlockEdit[] },
  blocks: readonly MarkdownBlock[] = markdownBlocks(proseOf(source)),
): BlockEditResult {
  const { prose, proseToSrc, parsed, anchorsInProse } = buildBridge(source);
  const count = editorBlockCount(blocks);
  const fileTypes = blocks.slice(0, count).map((b) => b.type);
  const differ = firstDifference(fileTypes, request.baseTypes);
  if (differ !== null) {
    return {
      ok: false,
      error:
        `the editor shows ${request.baseTypes.length} blocks and the file has ${count}; ` +
        `block ${differ + 1} is ${request.baseTypes[differ] ?? "missing"} in the editor ` +
        `and ${fileTypes[differ] ?? "missing"} in the file`,
    };
  }
  if (request.edits.length === 0) return { ok: false, error: "no edits" };
  let prevTo = -1;
  for (const e of request.edits) {
    const valid =
      Number.isInteger(e.from) &&
      Number.isInteger(e.to) &&
      e.from > prevTo &&
      e.to >= e.from &&
      e.to <= count &&
      typeof e.markdown === "string" &&
      Array.isArray(e.types) &&
      (e.markdown === "") === (e.types.length === 0) &&
      !(e.from === e.to && e.markdown === "");
    if (!valid) return { ok: false, error: "the edit doesn't describe blocks of this document" };
    if (carriesMarker(e.markdown)) return { ok: false, error: "the new text contains a review marker" };
    prevTo = e.to;
  }

  // Markers glued to a range's edges belong to the block inside it.
  const markerFrom = new Map<number, number>();
  const markerTo = new Map<number, number>();
  for (const r of parsed.anchors.values()) {
    markerFrom.set(r.openStart, r.openEnd);
    markerFrom.set(r.closeStart, r.closeEnd);
    markerTo.set(r.openEnd, r.openStart);
    markerTo.set(r.closeEnd, r.closeStart);
  }
  const gluedAfter = (p: number): number => {
    for (let e = markerFrom.get(p); e !== undefined; e = markerFrom.get(p)) p = e;
    return p;
  };
  const gluedBefore = (p: number): number => {
    for (let s = markerTo.get(p); s !== undefined; s = markerTo.get(p)) p = s;
    return p;
  };
  const bodyStart = parsed.frontmatter?.end ?? 0;
  const fenced = [parsed.frontmatter, parsed.threadsRegion].filter((r): r is { start: number; end: number } => !!r);

  // VS Code keeps a document's line endings uniform, so the first one is the file's.
  const eol = /\r\n?|\n/.exec(source)?.[0] ?? "\n";
  const lineEndings = (text: string): number => (text.match(/\r\n?|\n/g) ?? []).length;
  const isBlank = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  /** Just past the last non-blank character before `at` — a block's or a definition's — or -1. */
  const contentEndBefore = (at: number): number => {
    let j = at;
    while (j > 0 && isBlank(prose[j - 1])) j--;
    return j > 0 ? j : -1;
  };
  /** The first non-blank character from `at`, or -1. */
  const contentStartFrom = (at: number): number => {
    let j = at;
    while (j < prose.length && isBlank(prose[j])) j++;
    return j < prose.length ? j : -1;
  };
  /**
   * What lies between blocks `[from, to)` besides blank lines: link reference
   * definitions, which are no block of the editor's (milkdown inlines their
   * links and drops them). A splice over those blocks carries them through.
   */
  const definitionsIn = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (let k = from; k + 1 < to; k++) {
      const gap = prose.slice(blocks[k]!.end, blocks[k + 1]!.start).trim();
      if (gap) out.push(gap);
    }
    return out;
  };

  const planned: PlannedSplice[] = [];
  for (const e of request.edits) {
    let ps: number;
    let pe: number;
    let text = [e.markdown, ...(e.from < e.to ? definitionsIn(e.from, e.to) : [])].filter((t) => t !== "").join("\n\n");
    let after = false;
    // Where the new text meets a neighbour no block of its type met before —
    // an insertion, a deletion, a split or merge that changed the type at an
    // edge — it gets a blank line: a paragraph line runs on into whatever
    // paragraph precedes it, and a list, heading or fence may follow one
    // directly. Where the type is unchanged, so is the gap.
    const typeChangedBefore = e.from === e.to || text === "" || e.types[0] !== blocks[e.from]!.type;
    const typeChangedAfter = e.from === e.to || text === "" || e.types[e.types.length - 1] !== blocks[e.to - 1]!.type;
    if (e.from < e.to) {
      ps = lineStartOf(prose, blocks[e.from]!.start);
      pe = lineEndOf(prose, blocks[e.to - 1]!.end);
      if (text === "") {
        // A deletion takes one separator with it, or the blank lines around
        // the gap would pile up — but no more than a separator: it stops at
        // the nearest text, which may be a definition rather than a block.
        const before = contentEndBefore(ps);
        const next = contentStartFrom(pe);
        if (before >= 0) ps = lineEndOf(prose, before);
        else if (next >= 0) pe = lineStartOf(prose, next);
      } else if (e.to === e.from + 1 && e.types.length === 1 && e.types[0] === blocks[e.from]!.type) {
        if (e.types[0] === "bullet_list" || e.types[0] === "ordered_list") text = keepListMarker(prose, blocks[e.from]!, text);
      }
    } else if (e.from < blocks.length) {
      ps = pe = lineStartOf(prose, blocks[e.from]!.start);
      text = `${text}\n\n`;
    } else if (e.from > 0) {
      ps = pe = lineEndOf(prose, blocks[e.from - 1]!.end);
      text = `\n\n${text}`;
      after = true;
    } else {
      ps = pe = 0; // an empty document
    }
    const left = contentEndBefore(ps);
    const right = contentStartFrom(pe);
    if (text.trim() === "") {
      // A deletion: what's left between the two neighbours is a blank line at least.
      const have = lineEndings(prose.slice(left, ps) + text + prose.slice(pe, right));
      if (left >= 0 && right >= 0 && have < 2) text += "\n".repeat(2 - have);
    } else {
      const lead = lineEndings(prose.slice(Math.max(left, 0), ps) + /^\s*/.exec(text)![0]);
      const trail = lineEndings(/\s*$/.exec(text)![0] + prose.slice(pe, Math.max(right, pe)));
      if (typeChangedBefore && left >= 0 && lead < 2) text = "\n".repeat(2 - lead) + text;
      if (typeChangedAfter && right >= 0 && trail < 2) text += "\n".repeat(2 - trail);
    }
    // The serializer writes `\n`; the new text takes the file's line ending.
    text = text.replace(/\r\n?|\n/g, eol);
    let ss: number;
    let se: number;
    if (ps < pe) {
      ss = gluedBefore(proseToSrc[ps]!);
      se = gluedAfter(proseToSrc[pe - 1]! + 1);
    } else {
      // An insertion goes between the previous block's markers and the next one's.
      ss = se = ps > 0 ? proseToSrc[ps - 1]! + 1 : bodyStart;
      if (after) ss = se = gluedAfter(ss);
    }
    const reaches = fenced.some((r) => (ss < se ? ss < r.end && se > r.start : ss > r.start && ss < r.end));
    if (reaches) return { ok: false, error: "the edit reaches the frontmatter or the comment threads" };
    planned.push({ edit: e, ps, pe, text, ss, se });
  }

  let newProse = prose;
  for (let i = planned.length - 1; i >= 0; i--) {
    const p = planned[i]!;
    newProse = newProse.slice(0, p.ps) + p.text + newProse.slice(p.pe);
  }

  // Every marker a splice writes. `outer` orders markers at one position: an
  // opening by its span's end, a closing by its span's start, so the
  // enclosing span opens first and closes last. A marker whose partner lies
  // outside the block encloses everything in it.
  type Point = { at: number; close: boolean; outer: number; marker: string };
  type Span = { id: string; start: number; end: number };
  const placing: Array<{ p: PlannedSplice; spans: Span[]; points: Point[]; blockStart: number }> = [];
  // Threads and suggestions to recover by a unique quote: those the file has
  // without markers, and those a splice here loses (below).
  const candidates = new Map<string, string>();
  for (const t of parsed.threads) if (!parsed.anchors.has(t.id)) candidates.set(t.id, t.quote);
  for (const sg of parsed.suggestions) if (!parsed.anchors.has(sg.anchorId)) candidates.set(sg.anchorId, sg.original);
  const lost: string[] = [];
  let shift = 0;
  for (const p of planned) {
    const oldText = prose.slice(p.ps, p.pe);
    const edit = diffEnvelope(oldText, p.text);
    // Where each old character went, when a token diff can tell: exact for
    // every word the edit and the serializer's normalization left alone.
    const aligned = oldText.length > 0 ? alignTexts(oldText, p.text) : null;
    let collapsedNew: { normalized: string; map: number[] } | null = null;
    const collapsed = (): { normalized: string; map: number[] } => (collapsedNew ??= collapseWs(p.text));
    const spans: Span[] = [];
    const points: Point[] = [];
    for (const [id, r] of parsed.anchors) {
      const openIn = r.openStart >= p.ss && r.openEnd <= p.se;
      const closeIn = r.closeStart >= p.ss && r.closeEnd <= p.se;
      if (!openIn && !closeIn) continue;
      const span = anchorsInProse.get(id) ?? { proseStart: p.ps, proseEnd: p.ps };
      const local = { proseStart: span.proseStart - p.ps, proseEnd: span.proseEnd - p.ps };
      if (openIn && closeIn) {
        let loc: { start: number; end: number } | null = null;
        if (local.proseEnd > local.proseStart) {
          const s0 = aligned?.[local.proseStart] ?? -1;
          const e0 = aligned?.[local.proseEnd - 1] ?? -1;
          loc = s0 >= 0 && e0 >= s0 ? { start: s0, end: e0 + 1 } : reanchorThreadByText(oldText, p.text, collapsed, edit, local);
        }
        if (loc) spans.push({ id, start: startPastHeadingPrefix(p.text, loc.start, loc.end), end: loc.end });
        else {
          // Its text left this block — perhaps for another block of this edit.
          lost.push(id);
          if (local.proseEnd > local.proseStart) candidates.set(id, oldText.slice(local.proseStart, local.proseEnd));
        }
      } else if (openIn) {
        const s0 = aligned?.[local.proseStart] ?? -1;
        const at = s0 >= 0 ? s0 : mapMarker(edit, local.proseStart, true, p.text.length);
        points.push({ at, close: false, outer: Infinity, marker: openMarker(id) });
      } else {
        const e0 = local.proseEnd > 0 ? (aligned?.[local.proseEnd - 1] ?? -1) : -1;
        const at = e0 >= 0 ? e0 + 1 : mapMarker(edit, local.proseEnd, false, p.text.length);
        points.push({ at, close: true, outer: -Infinity, marker: closeMarker(id) });
      }
    }
    placing.push({ p, spans, points, blockStart: p.ps + shift });
    shift += p.text.length - (p.pe - p.ps);
  }

  // Recovery, once every splice has said what it lost: a block dragged
  // elsewhere arrives as a deletion and an insertion, and its threads go with
  // it only if the insertion may take what the deletion dropped.
  const recovered = new Set<string>();
  for (const pl of placing) {
    for (const [id, quote] of candidates) {
      if (recovered.has(id)) continue;
      const hit = recoverUnanchoredByQuote(newProse, quote);
      if (!hit || hit.start < pl.blockStart || hit.end > pl.blockStart + pl.p.text.length) continue;
      pl.spans.push({ id, start: hit.start - pl.blockStart, end: hit.end - pl.blockStart });
      recovered.add(id);
    }
  }
  const unanchored = lost.filter((id) => !recovered.has(id));

  const marked: string[] = [];
  for (const { p, spans, points } of placing) {
    // Markers must nest: a span may sit inside another (the file had it so),
    // but one that crosses a kept span's edge — or the marker of a thread
    // that runs on past the block — loses its markers.
    const oneSided = points.map((m) => m.at);
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const open: number[] = [];
    for (const sp of spans) {
      while (open.length > 0 && open[open.length - 1]! <= sp.start) open.pop();
      const crosses =
        (open.length > 0 && sp.end > open[open.length - 1]!) || oneSided.some((at) => sp.start < at && at < sp.end);
      if (sp.end <= sp.start || crosses) {
        unanchored.push(sp.id);
        continue;
      }
      open.push(sp.end);
      points.push(
        { at: sp.start, close: false, outer: sp.end, marker: openMarker(sp.id) },
        { at: sp.end, close: true, outer: sp.start, marker: closeMarker(sp.id) },
      );
    }
    // At one position: closing markers first (adjacent spans don't swallow
    // each other); among openings the enclosing span first, among closings
    // the enclosed one first.
    points.sort((a, b) => a.at - b.at || Number(b.close) - Number(a.close) || b.outer - a.outer);
    let out = "";
    let cursor = 0;
    for (const m of points) {
      out += p.text.slice(cursor, m.at) + m.marker;
      cursor = m.at;
    }
    marked.push(out + p.text.slice(cursor));
  }

  let next = source;
  for (let i = planned.length - 1; i >= 0; i--) {
    next = next.slice(0, planned[i]!.ss) + marked[i]! + next.slice(planned[i]!.se);
  }
  const first = planned[0]!;
  const last = planned[planned.length - 1]!;
  const range = {
    start: first.ss,
    end: last.se,
    text: next.slice(first.ss, last.se + next.length - source.length),
  };

  // The rest of the table is unchanged when each splice's window re-parses to
  // its neighbours and its new blocks; otherwise parse it all and compare.
  const splices: BlockSplice[] = planned.map((p) => ({
    from: p.edit.from,
    to: p.edit.to,
    start: p.ps,
    end: p.pe,
    length: p.text.length,
    types: p.edit.types,
  }));
  let table = spliceMarkdownBlocks(blocks, newProse, splices);
  if (!table) {
    // Read back, the file must be what the editor shows: every other block
    // where it was, and the new ones as sent. Anything else — new text that
    // merged with a neighbour, a fence that swallowed the rest — is never
    // written; the editor re-reads the file instead.
    const full = markdownBlocks(newProse);
    if (!sameStructure(full, blocks, splices)) {
      return { ok: false, error: "the new text would read as other blocks than the editor shows" };
    }
    table = full;
  }
  // Nor may it change what the rest of the file is: a `---` left at the top
  // opens frontmatter, and markers must still read as the prose written.
  const written = buildBridge(next);
  const frontmatter = (d: ParsedDocument): string => (d.frontmatter ? d.source.slice(d.frontmatter.start, d.frontmatter.end) : "");
  if (frontmatter(written.parsed) !== frontmatter(parsed)) {
    return { ok: false, error: "the edit would turn the top of the file into frontmatter" };
  }
  if (written.prose !== newProse) return { ok: false, error: "the file wouldn't read back as the edited text" };
  // And the review markers come out no worse than they went in.
  if (placing.some((pl) => pl.points.length > 0) || unanchored.length > 0) {
    const before = damageOf(source);
    const fresh = [...damageOf(next)].filter((k) => !before.has(k));
    if (fresh.length > 0) return { ok: false, error: `the edit would damage the review markers (${fresh.join(", ")})` };
  }
  return { ok: true, source: next, range, prose: newProse, blocks: table, unanchored };
}
