// Inline-comment format — the default storage layout in v0.27+. Comments
// live in two places inside the .md file itself:
//
//   1. Anchored span: paired HTML comments wrap the highlighted text
//      `<!--mc:a:ID-->...<!--mc:/a:ID-->` (ID = 5-char base36)
//   2. Threads region: a single block at the end of the file holding one
//      `<!--mc:t {JSON}-->` line per thread, fenced by
//      `<!--mc:threads:begin-->` / `<!--mc:threads:end-->`
//
// Round-trip guarantee: parse(serialize(parse(md))) == parse(md). The
// reverse is not guaranteed character-for-character (whitespace inside the
// threads region is normalized), but the *parse* is stable.
//
// Markers inside fenced code blocks and inline code spans are ignored — we
// don't want a literal `<!--mc:a:xxx-->` shown in a code example to be
// interpreted as a real anchor.

export interface InlineComment {
  /** Unique within the thread. Convention: c1, c2, ... */
  id: string;
  /** Set when this comment replies to another in the same thread. */
  parent?: string;
  author: string;
  /** ISO-8601 UTC timestamp. */
  ts: string;
  /** Markdown body. */
  body: string;
  /** ISO-8601 UTC timestamp. Present iff the body has been edited. */
  editedTs?: string;
  /** Tombstone — the comment is hidden in the UI but preserved so reply trees stay coherent. */
  deleted?: boolean;
}

export interface InlineThread {
  /** 5-char base36 ID. Stable across edits. Used in `mc:a` markers. */
  id: string;
  /** Anchor text at creation time. Used as a fallback locator if a marker is deleted. */
  quote: string;
  status: "open" | "resolved";
  resolvedBy?: string;
  resolvedTs?: string;
  comments: InlineComment[];
}

/**
 * A pending edit Claude proposes instead of applying directly (suggest mode).
 *
 * The original text stays in the prose, wrapped in the same paired
 * `<!--mc:a:ID-->…<!--mc:/a:ID-->` markers a comment uses (here ID = the
 * suggestion's `anchorId`), so the file still renders as the original in any
 * other Markdown viewer. The proposed replacement lives only in the
 * `<!--mc:s {JSON}-->` line. Accepting swaps the anchored original for
 * `proposed`; rejecting drops the suggestion and keeps the original.
 */
export interface InlineSuggestion {
  /** 5-char base36 id; also the id of the anchor markers wrapping `original`. */
  anchorId: string;
  /** Optional link to a comment thread this suggestion discusses. */
  threadId?: string;
  author: string;
  /** ISO-8601 UTC timestamp. */
  ts: string;
  /** The current text, wrapped by this suggestion's anchor markers. */
  original: string;
  /** The proposed replacement text. */
  proposed: string;
  /** Why the change — Claude's rationale, shown in the suggestion card. */
  note?: string;
}

export interface ParsedDocument {
  /**
   * Raw markdown source (input unchanged). All offset references in the
   * other fields are into this string.
   */
  source: string;
  /** Threads in document order (by first marker occurrence; unanchored last). */
  threads: InlineThread[];
  /** Pending suggestions in document order (by anchor position; unanchored last). */
  suggestions: InlineSuggestion[];
  /** Marker positions keyed by thread id AND suggestion anchorId. */
  anchors: Map<string, AnchorRange>;
  /**
   * Threads referenced in `<!--mc:t ...-->` but with no matching anchor
   * markers in the prose. Surface in UI as "broken anchor — fix with quote
   * fallback".
   */
  unanchoredThreadIds: string[];
  /** Suggestions in `<!--mc:s ...-->` whose anchor markers are missing. */
  unanchoredSuggestionIds: string[];
  /**
   * Half-open `[start, end)` range covering the threads region (including
   * the begin/end fences). `null` if no threads region present yet.
   */
  threadsRegion: { start: number; end: number } | null;
  /**
   * Half-open `[start, end)` range covering YAML / TOML frontmatter at
   * the very top of the file, including the leading and trailing fence
   * lines and the trailing newline after the closing fence. `null` when
   * the file has no frontmatter. The range is stripped from the
   * rendered preview and is off-limits for thread anchors.
   */
  frontmatter: { start: number; end: number } | null;
}

export interface AnchorRange {
  /** Offset of the first character of the opening marker. */
  openStart: number;
  /** Offset just past the last character of the opening marker. */
  openEnd: number;
  /** Offset of the first character of the closing marker. */
  closeStart: number;
  /** Offset just past the last character of the closing marker. */
  closeEnd: number;
}

const OPEN_RE = /<!--mc:a:([a-z0-9]{1,12})-->/g;
const CLOSE_RE = /<!--mc:\/a:([a-z0-9]{1,12})-->/g;
const THREADS_BEGIN = "<!--mc:threads:begin-->";
const THREADS_END = "<!--mc:threads:end-->";
const THREAD_LINE_RE = /<!--mc:t\s+(\{[\s\S]*?\})\s*-->/g;
const SUGGESTION_LINE_RE = /<!--mc:s\s+(\{[\s\S]*?\})\s*-->/g;

/** Compute a [start, end) bitmap of "this offset is inside code". */
function buildCodeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  // Pass 1: fenced code blocks (```...``` or ~~~...~~~ at line start).
  const fenceLineRe = /^[ \t]{0,3}(```+|~~~+)[^\n]*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let inFence = false;
  let fenceMarker = "";
  let fenceStart = 0;
  while ((fenceMatch = fenceLineRe.exec(source)) !== null) {
    if (!inFence) {
      inFence = true;
      fenceMarker = fenceMatch[1];
      fenceStart = fenceMatch.index;
    } else if (fenceMatch[1].startsWith(fenceMarker[0]) && fenceMatch[1].length >= fenceMarker.length) {
      const fenceEnd = fenceMatch.index + fenceMatch[0].length;
      for (let i = fenceStart; i < fenceEnd; i++) mask[i] = 1;
      inFence = false;
      fenceMarker = "";
    }
  }
  if (inFence) {
    // Unterminated fence — mask to end of file.
    for (let i = fenceStart; i < source.length; i++) mask[i] = 1;
  }

  // Pass 2: inline code spans (`...`). Skip pairs that are already inside
  // a fenced block.
  const tickRe = /`+/g;
  let tickMatch: RegExpExecArray | null;
  const ticks: Array<{ start: number; end: number; len: number }> = [];
  while ((tickMatch = tickRe.exec(source)) !== null) {
    const start = tickMatch.index;
    if (mask[start]) continue;
    ticks.push({ start, end: start + tickMatch[0].length, len: tickMatch[0].length });
  }
  const used = new Set<number>();
  for (let i = 0; i < ticks.length; i++) {
    if (used.has(i)) continue;
    const open = ticks[i];
    for (let j = i + 1; j < ticks.length; j++) {
      if (used.has(j)) continue;
      const close = ticks[j];
      if (close.len !== open.len) continue;
      for (let k = open.start; k < close.end; k++) mask[k] = 1;
      used.add(i);
      used.add(j);
      break;
    }
  }

  // Pass 3: indented code blocks. Any line starting with 4+ spaces (and
  // not preceded by a paragraph line) is a code block. We approximate
  // pragmatically: 4-space-indent lines that aren't already in a fence.
  // This is intentionally loose — false positives just mean we ignore a
  // marker, which a reviewer can fix by un-indenting their code sample.
  let lineStart = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      if (!mask[lineStart] && source.slice(lineStart, lineStart + 4) === "    ") {
        for (let k = lineStart; k < i; k++) mask[k] = 1;
      }
      lineStart = i + 1;
    }
  }
  return mask;
}

/**
 * True when `[start, end)` touches a fenced block, an indented block, or an
 * inline code span.
 *
 * Markers inside code are deliberately ignored by the parser so a literal
 * `<!--mc:a:xxx-->` in a code sample is inert. That protection cuts both
 * ways: markers written there for a *real* thread are inert too, so the
 * thread would come back unanchored with no explanation. Callers use this
 * to refuse up front instead.
 */
export function isInCode(source: string, start: number, end: number): boolean {
  const mask = buildCodeMask(source);
  const last = Math.max(start, Math.min(end, source.length) - 1);
  for (let i = Math.max(0, start); i <= last && i < source.length; i++) {
    if (mask[i]) return true;
  }
  return false;
}

interface RawMarker {
  kind: "open" | "close";
  id: string;
  start: number;
  end: number;
}

function findMarkers(source: string, mask: Uint8Array): RawMarker[] {
  const markers: RawMarker[] = [];
  for (const [re, kind] of [
    [OPEN_RE, "open"] as const,
    [CLOSE_RE, "close"] as const,
  ]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (mask[m.index]) continue;
      markers.push({ kind, id: m[1], start: m.index, end: m.index + m[0].length });
    }
  }
  markers.sort((a, b) => a.start - b.start);
  return markers;
}

function pairAnchors(markers: RawMarker[]): { anchors: Map<string, AnchorRange>; unpaired: RawMarker[] } {
  const anchors = new Map<string, AnchorRange>();
  const openByid = new Map<string, RawMarker>();
  const unpaired: RawMarker[] = [];
  for (const m of markers) {
    if (m.kind === "open") {
      // Duplicate open — keep the first, mark later as unpaired so we don't
      // silently overwrite a valid anchor.
      if (openByid.has(m.id) || anchors.has(m.id)) {
        unpaired.push(m);
        continue;
      }
      openByid.set(m.id, m);
    } else {
      const open = openByid.get(m.id);
      if (!open) {
        unpaired.push(m);
        continue;
      }
      anchors.set(m.id, {
        openStart: open.start,
        openEnd: open.end,
        closeStart: m.start,
        closeEnd: m.end,
      });
      openByid.delete(m.id);
    }
  }
  for (const m of openByid.values()) unpaired.push(m);
  return { anchors, unpaired };
}

function findThreadsRegion(source: string): { start: number; end: number; body: string } | null {
  const begin = source.lastIndexOf(THREADS_BEGIN);
  if (begin === -1) return null;
  const end = source.indexOf(THREADS_END, begin + THREADS_BEGIN.length);
  if (end === -1) return null;
  const endAfter = end + THREADS_END.length;
  return {
    start: begin,
    end: endAfter,
    body: source.slice(begin + THREADS_BEGIN.length, end),
  };
}

/**
 * A `<!--mc:t ...-->` line that could not be turned into a thread.
 * `offset` is relative to the threads-region body.
 */
export interface MalformedThreadLine {
  /** The raw JSON text between `<!--mc:t ` and `-->`. */
  raw: string;
  /** Offset of the line within the threads-region body. */
  offset: number;
  reason: "json-parse-error" | "missing-id";
}

function parseThreads(body: string, malformed?: MalformedThreadLine[]): InlineThread[] {
  const threads: InlineThread[] = [];
  let m: RegExpExecArray | null;
  THREAD_LINE_RE.lastIndex = 0;
  while ((m = THREAD_LINE_RE.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as Partial<InlineThread>;
      if (!obj || typeof obj.id !== "string") {
        malformed?.push({ raw: m[1], offset: m.index, reason: "missing-id" });
        continue;
      }
      threads.push({
        id: obj.id,
        quote: typeof obj.quote === "string" ? obj.quote : "",
        status: obj.status === "resolved" ? "resolved" : "open",
        resolvedBy: obj.resolvedBy,
        resolvedTs: obj.resolvedTs,
        comments: Array.isArray(obj.comments) ? obj.comments.filter(isValidComment) : [],
      });
    } catch {
      // Malformed JSON — skipped by `parse()` so a damaged line never takes
      // the whole document down. `inspect()` surfaces it instead.
      malformed?.push({ raw: m[1], offset: m.index, reason: "json-parse-error" });
    }
  }
  return threads;
}

function parseSuggestions(body: string): InlineSuggestion[] {
  const suggestions: InlineSuggestion[] = [];
  let m: RegExpExecArray | null;
  SUGGESTION_LINE_RE.lastIndex = 0;
  while ((m = SUGGESTION_LINE_RE.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as Partial<InlineSuggestion>;
      if (
        !obj ||
        typeof obj.anchorId !== "string" ||
        typeof obj.original !== "string" ||
        typeof obj.proposed !== "string"
      ) {
        continue;
      }
      suggestions.push({
        anchorId: obj.anchorId,
        threadId: typeof obj.threadId === "string" ? obj.threadId : undefined,
        author: typeof obj.author === "string" ? obj.author : "claude",
        ts: typeof obj.ts === "string" ? obj.ts : "",
        original: obj.original,
        proposed: obj.proposed,
        note: typeof obj.note === "string" ? obj.note : undefined,
      });
    } catch {
      // Malformed JSON — skipped, like a malformed thread line. `inspect()`
      // surfaces the count delta.
    }
  }
  return suggestions;
}

function isValidComment(c: unknown): c is InlineComment {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.author === "string" &&
    typeof o.ts === "string" &&
    typeof o.body === "string"
  );
}

/**
 * Detect a YAML (`---`) or TOML (`+++`) frontmatter block at the very
 * top of the source. The opening fence must be the first non-BOM line;
 * the closing fence must be on its own line and match the opening
 * format. Returns `null` when no valid block is found.
 *
 * The returned range covers everything from the opening `---` to the
 * `\n` that ends the closing fence's line — stripping that range
 * eliminates the frontmatter cleanly without leaving a blank gap at
 * the top of the prose.
 */
export function findFrontmatter(source: string): { start: number; end: number } | null {
  // Skip a UTF-8 BOM so files saved with one still detect frontmatter.
  const offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  // Opening fence: exactly `---` or `+++` followed by an end-of-line or EOF.
  const head = source.slice(offset, offset + 4);
  let fence: string | null = null;
  if (head.startsWith("---") && (head.length === 3 || head[3] === "\n" || head[3] === "\r")) {
    fence = "---";
  } else if (head.startsWith("+++") && (head.length === 3 || head[3] === "\n" || head[3] === "\r")) {
    fence = "+++";
  }
  if (!fence) return null;

  // Walk lines after the opening fence looking for a matching closing
  // fence line (`---` or `...` for YAML; `+++` for TOML). Bail if EOF
  // hits first — partial frontmatter isn't a frontmatter.
  let cursor = offset + fence.length;
  // Eat the newline after the opening fence (it might be missing if
  // the doc is a one-liner, in which case there's no closing fence
  // either).
  if (source[cursor] === "\r") cursor++;
  if (source[cursor] === "\n") cursor++;
  else return null;

  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const realLineEnd = lineEnd === -1 ? source.length : lineEnd;
    let line = source.slice(cursor, realLineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const isClosing =
      (fence === "---" && (line === "---" || line === "...")) ||
      (fence === "+++" && line === "+++");
    if (isClosing) {
      // Include the trailing newline (if any) so stripping the range
      // doesn't leave a blank gap before the first real content line.
      const end = lineEnd === -1 ? source.length : lineEnd + 1;
      return { start: 0, end };
    }
    if (lineEnd === -1) return null;
    cursor = lineEnd + 1;
  }
  return null;
}

export function parse(source: string): ParsedDocument {
  const mask = buildCodeMask(source);
  const markers = findMarkers(source, mask);
  const { anchors } = pairAnchors(markers);
  const region = findThreadsRegion(source);
  const threads = region ? parseThreads(region.body) : [];
  const suggestions = region ? parseSuggestions(region.body) : [];
  const frontmatter = findFrontmatter(source);

  // Sort threads by anchor position; threads without an anchor go to the end.
  threads.sort((a, b) => {
    const ai = anchors.get(a.id)?.openStart ?? Number.POSITIVE_INFINITY;
    const bi = anchors.get(b.id)?.openStart ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });
  suggestions.sort((a, b) => {
    const ai = anchors.get(a.anchorId)?.openStart ?? Number.POSITIVE_INFINITY;
    const bi = anchors.get(b.anchorId)?.openStart ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });

  const unanchoredThreadIds = threads.filter((t) => !anchors.has(t.id)).map((t) => t.id);
  const unanchoredSuggestionIds = suggestions
    .filter((s) => !anchors.has(s.anchorId))
    .map((s) => s.anchorId);

  return {
    source,
    threads,
    suggestions,
    anchors,
    unanchoredThreadIds,
    unanchoredSuggestionIds,
    threadsRegion: region ? { start: region.start, end: region.end } : null,
    frontmatter,
  };
}

/** A marker found in the prose that has no counterpart. */
export interface UnpairedMarker {
  kind: "open" | "close";
  id: string;
  /** Offset of the first character of the marker. */
  start: number;
  /** Offset just past the last character of the marker. */
  end: number;
}

/**
 * Everything `parse()` deliberately swallows, for callers that need to
 * *diagnose* a document rather than render it. `parse()` stays lenient —
 * a damaged line must never take the whole document down — so integrity
 * checking reads from here instead.
 */
export interface DocumentInspection {
  parsed: ParsedDocument;
  /** Open markers with no close (and vice versa), plus duplicate opens. */
  unpairedMarkers: UnpairedMarker[];
  /** `<!--mc:t ...-->` lines that produced no thread. */
  malformedThreadLines: MalformedThreadLine[];
  /** Thread ids appearing on more than one thread line. */
  duplicateThreadIds: string[];
  /** Anchor markers in the prose with no matching thread in the threads region. */
  orphanAnchorIds: string[];
}

/**
 * Diagnostic pass over a document. Shares every helper with `parse()` —
 * this is a second view of the same parse, never a second parser.
 */
export function inspect(source: string): DocumentInspection {
  const mask = buildCodeMask(source);
  const markers = findMarkers(source, mask);
  const { anchors, unpaired } = pairAnchors(markers);
  const region = findThreadsRegion(source);
  const malformedThreadLines: MalformedThreadLine[] = [];
  const threads = region ? parseThreads(region.body, malformedThreadLines) : [];
  const suggestions = region ? parseSuggestions(region.body) : [];

  const seen = new Set<string>();
  const duplicateThreadIds: string[] = [];
  for (const t of threads) {
    if (seen.has(t.id)) {
      if (!duplicateThreadIds.includes(t.id)) duplicateThreadIds.push(t.id);
    }
    seen.add(t.id);
  }
  // A `mc:a` anchor is legitimate if it belongs to a thread OR a suggestion.
  const anchorOwners = new Set(seen);
  for (const s of suggestions) anchorOwners.add(s.anchorId);

  const orphanAnchorIds = [...anchors.keys()].filter((id) => !anchorOwners.has(id));

  return {
    parsed: parse(source),
    unpairedMarkers: unpaired.map((m) => ({ kind: m.kind, id: m.id, start: m.start, end: m.end })),
    malformedThreadLines,
    duplicateThreadIds,
    orphanAnchorIds,
  };
}

/** Render the threads region as text, with leading/trailing newlines suitable for appending to a markdown file. */
export function renderThreadsRegion(
  threads: InlineThread[],
  suggestions: InlineSuggestion[] = [],
): string {
  if (threads.length === 0 && suggestions.length === 0) return "";
  const lines = [THREADS_BEGIN];
  for (const t of threads) {
    const obj: Record<string, unknown> = {
      id: t.id,
      quote: t.quote,
      status: t.status,
    };
    if (t.resolvedBy) obj.resolvedBy = t.resolvedBy;
    if (t.resolvedTs) obj.resolvedTs = t.resolvedTs;
    obj.comments = t.comments;
    lines.push(`<!--mc:t ${safeStringify(obj)}-->`);
  }
  for (const s of suggestions) {
    const obj: Record<string, unknown> = { anchorId: s.anchorId };
    if (s.threadId) obj.threadId = s.threadId;
    obj.author = s.author;
    obj.ts = s.ts;
    obj.original = s.original;
    obj.proposed = s.proposed;
    if (s.note) obj.note = s.note;
    lines.push(`<!--mc:s ${safeStringify(obj)}-->`);
  }
  lines.push(THREADS_END);
  return lines.join("\n");
}

/**
 * `JSON.stringify` + escape any literal `-->` (and the leading `<!--`)
 * that would otherwise terminate or confuse the surrounding HTML
 * comment in which we embed the JSON. We escape `>` after `--` to
 * `>`; on read, `JSON.parse` reverses the `>` back to `>` so
 * comment bodies round-trip losslessly. Belt-and-braces — also escape
 * `<` after `!` to `<` in case an AI emits a literal `<!-- block.
 */
function safeStringify(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/-->/g, "--\\u003e")
    .replace(/<!--/g, "\\u003c!--");
}

/**
 * Replace (or insert) the threads region of `source` with `threads` and
 * `suggestions`. When `suggestions` is omitted, the source's existing
 * suggestions are preserved — so thread operations never disturb pending
 * suggestions, and suggestion operations pass the updated list explicitly.
 */
export function withThreads(
  source: string,
  threads: InlineThread[],
  suggestions?: InlineSuggestion[],
): string {
  const region = findThreadsRegion(source);
  const keepSuggestions = suggestions ?? parse(source).suggestions;
  const rendered = renderThreadsRegion(threads, keepSuggestions);
  if (region) {
    const before = source.slice(0, region.start);
    const after = source.slice(region.end);
    if (rendered === "") {
      // Removing the region. Collapse the newline run on BOTH sides of where
      // it sat down to a single separator: stripping only one newline (as we
      // used to) left an extra behind on every removal, so an add/remove
      // cycle appended a blank line to the document each time it ran.
      const head = before.replace(/\n+$/, "");
      const tail = after.replace(/^\n+/, "");
      const joiner = before.endsWith("\n") || after.startsWith("\n") ? "\n" : "";
      return head + joiner + tail;
    }
    return before + rendered + after;
  }
  if (rendered === "") return source;
  // Normalize the trailing newline run before appending so a document that
  // already carries blank lines doesn't grow another one.
  return `${source.replace(/\n+$/, "")}\n\n${rendered}\n`;
}

const ID_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Mint a 5-char base36 id that doesn't collide with any existing thread. */
export function mintThreadId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = "";
    for (let i = 0; i < 5; i++) {
      id += ID_CHARSET[Math.floor(Math.random() * ID_CHARSET.length)];
    }
    if (!taken.has(id)) return id;
  }
  // Astronomically unlikely. Surface rather than silently loop forever.
  throw new Error("Could not mint a unique thread id after 50 attempts");
}

/**
 * If `start` lands on the leading `#`/whitespace prefix of an ATX heading
 * line, return the offset of the first character after that prefix. An open
 * anchor marker placed before the `#`s would push them off the line start so
 * the line stops rendering as a heading; `## <!--mc:a-->Heading<!--mc:/a-->`
 * keeps it a heading. No-op when the line isn't a heading or `start` is
 * already past the prefix; never moves past `limit` (the selection end).
 */
export function startPastHeadingPrefix(text: string, start: number, limit: number): number {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  const lineEnd = text.indexOf("\n", lineStart);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const m = /^[ \t]{0,3}#{1,6}[ \t]+/.exec(line);
  if (!m) return start;
  const contentStart = lineStart + m[0].length;
  if (start >= contentStart) return start; // already past the prefix
  return Math.min(contentStart, limit); // bump, but don't cross the selection end
}

/** Wrap `[selStart, selEnd)` in `source` with anchor markers and append a thread. */
export function addThread(
  source: string,
  selStart: number,
  selEnd: number,
  comment: { author: string; body: string; ts?: string },
): { source: string; thread: InlineThread } {
  if (selEnd < selStart) throw new Error("selEnd must be >= selStart");
  // Keep the open marker out of a heading's `#` prefix so the line stays a heading.
  selStart = startPastHeadingPrefix(source, selStart, selEnd);
  const parsed = parse(source);
  const id = mintThreadId(parsed.threads.map((t) => t.id));
  // Strip any *other* thread's markers the selection happens to span — a quote
  // is the verbatim anchored text, never embedded `<!--mc:...-->` markup. A
  // marker-laden quote would otherwise show up raw in comment UIs and break
  // re-anchoring (it can't be found in the marker-free rendered text).
  const quote = source.slice(selStart, selEnd).replace(OPEN_RE, "").replace(CLOSE_RE, "");
  const openMarker = `<!--mc:a:${id}-->`;
  const closeMarker = `<!--mc:/a:${id}-->`;
  const ts = comment.ts ?? new Date().toISOString();
  const thread: InlineThread = {
    id,
    quote,
    status: "open",
    comments: [{ id: "c1", author: comment.author, ts, body: comment.body }],
  };
  assertAnchorable(parsed, source, selStart, selEnd);
  const withMarkers =
    source.slice(0, selStart) + openMarker + source.slice(selStart, selEnd) + closeMarker + source.slice(selEnd);
  const nextThreads = [...parsed.threads, thread];
  return { source: withThreads(withMarkers, nextThreads), thread };
}

/**
 * Throw if `[selStart, selEnd)` cannot carry an anchor: inside the threads
 * region or frontmatter (invisible in the rendered view) or inside code
 * (markers there are ignored by the parser, so the anchor would silently
 * break). Shared by comment and suggestion anchoring.
 */
function assertAnchorable(
  parsed: ParsedDocument,
  source: string,
  selStart: number,
  selEnd: number,
): void {
  if (parsed.threadsRegion) {
    if (selStart >= parsed.threadsRegion.start && selStart < parsed.threadsRegion.end) {
      throw new Error("Cannot anchor inside the threads region");
    }
    if (selEnd > parsed.threadsRegion.start && selEnd <= parsed.threadsRegion.end) {
      throw new Error("Cannot anchor inside the threads region");
    }
  }
  if (parsed.frontmatter) {
    if (selStart >= parsed.frontmatter.start && selStart < parsed.frontmatter.end) {
      throw new Error("Cannot anchor inside the frontmatter");
    }
    if (selEnd > parsed.frontmatter.start && selEnd <= parsed.frontmatter.end) {
      throw new Error("Cannot anchor inside the frontmatter");
    }
  }
  if (isInCode(source, selStart, selEnd)) {
    throw new Error("Cannot anchor inside a code block or code span");
  }
}

/** Replace a thread by id. If `next === null`, remove it (and its anchor markers). */
export function replaceThread(source: string, id: string, next: InlineThread | null): string {
  const parsed = parse(source);
  let nextThreads: InlineThread[];
  if (next === null) {
    nextThreads = parsed.threads.filter((t) => t.id !== id);
  } else {
    if (next.id !== id) throw new Error("replaceThread: id mismatch");
    nextThreads = parsed.threads.map((t) => (t.id === id ? next : t));
    if (!parsed.threads.some((t) => t.id === id)) nextThreads.push(next);
  }
  let body = source;
  if (next === null) {
    body = stripAnchorMarkers(body, id);
  }
  return withThreads(body, nextThreads);
}

/** Remove both anchor markers for `id` from `source`. Idempotent. */
export function stripAnchorMarkers(source: string, id: string): string {
  const open = `<!--mc:a:${id}-->`;
  const close = `<!--mc:/a:${id}-->`;
  return source.split(open).join("").split(close).join("");
}

/** Strip ALL inline-comment markers and the threads region. Used for the "rendered" view. */
export function stripAllInlineMarkup(source: string): string {
  const region = findThreadsRegion(source);
  const stripped = region ? source.slice(0, region.start).replace(/\n+$/, "\n") + source.slice(region.end) : source;
  return stripped.replace(OPEN_RE, "").replace(CLOSE_RE, "");
}

/** Add a reply to an existing thread. Returns the new thread or null if not found. */
export function appendReply(
  thread: InlineThread,
  reply: { author: string; body: string; ts?: string; parent?: string },
): InlineThread {
  const ts = reply.ts ?? new Date().toISOString();
  const nextId = nextCommentId(thread);
  return {
    ...thread,
    comments: [
      ...thread.comments,
      {
        id: nextId,
        author: reply.author,
        ts,
        body: reply.body,
        parent: reply.parent,
      },
    ],
  };
}

function nextCommentId(thread: InlineThread): string {
  let max = 0;
  for (const c of thread.comments) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}

// --- suggestions (suggest mode) --------------------------------------------

/**
 * Wrap `[selStart, selEnd)` (the original text) in anchor markers and append a
 * pending suggestion proposing `proposed` in its place. The file still renders
 * as the original — the proposed text lives only in the `<!--mc:s ...-->` line.
 */
export function addSuggestion(
  source: string,
  selStart: number,
  selEnd: number,
  suggestion: { author: string; proposed: string; note?: string; threadId?: string; ts?: string },
): { source: string; suggestion: InlineSuggestion } {
  if (selEnd < selStart) throw new Error("selEnd must be >= selStart");
  selStart = startPastHeadingPrefix(source, selStart, selEnd);
  const parsed = parse(source);
  // Unique across threads AND existing suggestion anchors.
  const anchorId = mintThreadId([
    ...parsed.threads.map((t) => t.id),
    ...parsed.suggestions.map((s) => s.anchorId),
  ]);
  const original = source.slice(selStart, selEnd).replace(OPEN_RE, "").replace(CLOSE_RE, "");
  assertAnchorable(parsed, source, selStart, selEnd);
  const openMarker = `<!--mc:a:${anchorId}-->`;
  const closeMarker = `<!--mc:/a:${anchorId}-->`;
  const record: InlineSuggestion = {
    anchorId,
    threadId: suggestion.threadId,
    author: suggestion.author,
    ts: suggestion.ts ?? new Date().toISOString(),
    original,
    proposed: suggestion.proposed,
    note: suggestion.note,
  };
  const withMarkers =
    source.slice(0, selStart) + openMarker + source.slice(selStart, selEnd) + closeMarker + source.slice(selEnd);
  const nextSuggestions = [...parsed.suggestions, record];
  return { source: withThreads(withMarkers, parsed.threads, nextSuggestions), suggestion: record };
}

/**
 * Accept a suggestion: replace the anchored original span with the proposed
 * text (marker-safe — the markers are removed with the swap) and drop the
 * `<!--mc:s ...-->` line. Returns the source unchanged if the id is unknown.
 */
export function acceptSuggestion(source: string, anchorId: string): string {
  return resolveSuggestion(source, anchorId, "accept");
}

/**
 * Reject a suggestion: keep the original text (strip its anchor markers) and
 * drop the `<!--mc:s ...-->` line. The linked thread, if any, is untouched.
 */
export function rejectSuggestion(source: string, anchorId: string): string {
  return resolveSuggestion(source, anchorId, "reject");
}

function resolveSuggestion(source: string, anchorId: string, mode: "accept" | "reject"): string {
  const parsed = parse(source);
  const suggestion = parsed.suggestions.find((s) => s.anchorId === anchorId);
  if (!suggestion) return source;
  const anchor = parsed.anchors.get(anchorId);
  let body = source;
  if (anchor) {
    // Replace open + span + close in one splice so no marker is left behind.
    const replacement = mode === "accept" ? suggestion.proposed : source.slice(anchor.openEnd, anchor.closeStart);
    body = source.slice(0, anchor.openStart) + replacement + source.slice(anchor.closeEnd);
  } else {
    // Unanchored suggestion (markers lost). Nothing to swap in the prose; just
    // drop the record. On accept with no anchor we cannot place the change, so
    // it is dropped too — the caller should have checked `anchored` first.
    body = stripAnchorMarkers(body, anchorId);
  }
  const nextSuggestions = parsed.suggestions.filter((s) => s.anchorId !== anchorId);
  return withThreads(body, parsed.threads, nextSuggestions);
}
