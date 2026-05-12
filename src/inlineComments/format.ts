// Inline-comment format for the experimental "comments live in the markdown"
// view. Comments are stored in two places inside the .md file itself:
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

export interface ParsedDocument {
  /**
   * Raw markdown source (input unchanged). All offset references in the
   * other fields are into this string.
   */
  source: string;
  /** Threads in document order (by first marker occurrence; unanchored last). */
  threads: InlineThread[];
  /** Marker positions keyed by thread id. */
  anchors: Map<string, AnchorRange>;
  /**
   * Threads referenced in `<!--mc:t ...-->` but with no matching anchor
   * markers in the prose. Surface in UI as "broken anchor — fix with quote
   * fallback".
   */
  unanchoredThreadIds: string[];
  /**
   * Half-open `[start, end)` range covering the threads region (including
   * the begin/end fences). `null` if no threads region present yet.
   */
  threadsRegion: { start: number; end: number } | null;
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

function parseThreads(body: string): InlineThread[] {
  const threads: InlineThread[] = [];
  let m: RegExpExecArray | null;
  THREAD_LINE_RE.lastIndex = 0;
  while ((m = THREAD_LINE_RE.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as Partial<InlineThread>;
      if (!obj || typeof obj.id !== "string") continue;
      threads.push({
        id: obj.id,
        quote: typeof obj.quote === "string" ? obj.quote : "",
        status: obj.status === "resolved" ? "resolved" : "open",
        resolvedBy: obj.resolvedBy,
        resolvedTs: obj.resolvedTs,
        comments: Array.isArray(obj.comments) ? obj.comments.filter(isValidComment) : [],
      });
    } catch {
      // Malformed JSON — skip silently. UI shows count delta vs anchors.
    }
  }
  return threads;
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

export function parse(source: string): ParsedDocument {
  const mask = buildCodeMask(source);
  const markers = findMarkers(source, mask);
  const { anchors } = pairAnchors(markers);
  const region = findThreadsRegion(source);
  const threads = region ? parseThreads(region.body) : [];

  // Sort threads by anchor position; threads without an anchor go to the end.
  threads.sort((a, b) => {
    const ai = anchors.get(a.id)?.openStart ?? Number.POSITIVE_INFINITY;
    const bi = anchors.get(b.id)?.openStart ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });

  const unanchoredThreadIds = threads.filter((t) => !anchors.has(t.id)).map((t) => t.id);

  return {
    source,
    threads,
    anchors,
    unanchoredThreadIds,
    threadsRegion: region ? { start: region.start, end: region.end } : null,
  };
}

/** Render the threads region as text, with leading/trailing newlines suitable for appending to a markdown file. */
export function renderThreadsRegion(threads: InlineThread[]): string {
  if (threads.length === 0) return "";
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

/** Replace (or insert) the threads region of `source` with `threads`. */
export function withThreads(source: string, threads: InlineThread[]): string {
  const region = findThreadsRegion(source);
  const rendered = renderThreadsRegion(threads);
  if (region) {
    const before = source.slice(0, region.start);
    const after = source.slice(region.end);
    if (rendered === "") {
      // Removing region — also strip a single trailing newline before it
      // so we don't accumulate blank lines on repeated empty-state saves.
      return before.replace(/\n$/, "") + after;
    }
    return before + rendered + after;
  }
  if (rendered === "") return source;
  const sep = source.endsWith("\n") ? "" : "\n";
  return source + sep + "\n" + rendered + "\n";
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

/** Wrap `[selStart, selEnd)` in `source` with anchor markers and append a thread. */
export function addThread(
  source: string,
  selStart: number,
  selEnd: number,
  comment: { author: string; body: string; ts?: string },
): { source: string; thread: InlineThread } {
  if (selEnd < selStart) throw new Error("selEnd must be >= selStart");
  const parsed = parse(source);
  const id = mintThreadId(parsed.threads.map((t) => t.id));
  const quote = source.slice(selStart, selEnd);
  const openMarker = `<!--mc:a:${id}-->`;
  const closeMarker = `<!--mc:/a:${id}-->`;
  const ts = comment.ts ?? new Date().toISOString();
  const thread: InlineThread = {
    id,
    quote,
    status: "open",
    comments: [{ id: "c1", author: comment.author, ts, body: comment.body }],
  };
  // Insert markers. If the selection lies inside the threads region, that's
  // a user error — refuse rather than corrupt the file.
  if (parsed.threadsRegion) {
    if (selStart >= parsed.threadsRegion.start && selStart < parsed.threadsRegion.end) {
      throw new Error("Cannot anchor a comment inside the threads region");
    }
    if (selEnd > parsed.threadsRegion.start && selEnd <= parsed.threadsRegion.end) {
      throw new Error("Cannot anchor a comment inside the threads region");
    }
  }
  const withMarkers =
    source.slice(0, selStart) + openMarker + source.slice(selStart, selEnd) + closeMarker + source.slice(selEnd);
  const nextThreads = [...parsed.threads, thread];
  return { source: withThreads(withMarkers, nextThreads), thread };
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
