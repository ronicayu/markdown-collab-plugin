// What the raw text editor should show for a reviewed .md file (10x-plan-3 P0.1).
//
// The inline format is the product's core virtue — review state travels inside
// the document — but its first impression in the plain text editor is
// `<!--mc:a:x7k2p-->` marker soup and a wall of thread JSON at the bottom. The
// extension knows exactly what every one of those bytes means and, until now,
// said nothing: no decorations, no folding, no hovers. A collaborator opening
// the file sees something that looks corrupted.
//
// This module is the pure half: given a parsed document it returns offset
// ranges to decorate, a fold for the threads region, and the hover text for a
// position. No `vscode` import, so the interesting logic is unit-testable and
// the wiring in `index.ts` stays thin enough to read.

import type { InlineThread, ParsedDocument } from "../inlineComments/format";
import { isClaudeUnread } from "../inlineComments/claudeUnread";
import { formatRelativeTime } from "../collab/relativeTime";

/** Half-open `[start, end)` offsets into the document source. */
export interface OffsetRange {
  start: number;
  end: number;
}

export interface PresenceRanges {
  /**
   * The marker comments themselves. Dimmed rather than hidden: a user who
   * wants to see exactly what is in their file must be able to, and the
   * markers are how the format keeps its promise.
   */
  markers: OffsetRange[];
  /** Anchored spans of open threads. */
  openSpans: OffsetRange[];
  /** Anchored spans of resolved threads — same idea, quieter. */
  resolvedSpans: OffsetRange[];
  /** Anchored originals of pending suggestions, which read as tracked changes. */
  suggestionSpans: OffsetRange[];
  /** Threads region including its fences, or null when the file has none. */
  threadsRegion: OffsetRange | null;
}

/** Everything the decoration pass needs, in one walk of the parse. */
export function presenceRanges(parsed: ParsedDocument): PresenceRanges {
  const markers: OffsetRange[] = [];
  const openSpans: OffsetRange[] = [];
  const resolvedSpans: OffsetRange[] = [];
  const suggestionSpans: OffsetRange[] = [];

  const suggestionIds = new Set(parsed.suggestions.map((s) => s.anchorId));
  const statusById = new Map(parsed.threads.map((t) => [t.id, t.status] as const));

  for (const [id, a] of parsed.anchors) {
    markers.push({ start: a.openStart, end: a.openEnd });
    markers.push({ start: a.closeStart, end: a.closeEnd });
    // The anchored text is what sits between the markers.
    const span = { start: a.openEnd, end: a.closeStart };
    if (span.end <= span.start) continue; // an empty anchor highlights nothing
    if (suggestionIds.has(id)) suggestionSpans.push(span);
    else if (statusById.get(id) === "resolved") resolvedSpans.push(span);
    else openSpans.push(span);
  }

  return {
    markers,
    openSpans,
    resolvedSpans,
    suggestionSpans,
    threadsRegion: parsed.threadsRegion,
  };
}

/** Does this document carry any inline review state at all? */
export function hasPresence(parsed: ParsedDocument): boolean {
  return parsed.anchors.size > 0 || parsed.threadsRegion !== null;
}

/** 0-based line number containing `offset`. */
export function lineAt(source: string, offset: number): number {
  let line = 0;
  const cap = Math.min(offset, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * The fold for the threads region, as 0-based line numbers, or null when there
 * is nothing to fold. Folded by default: the region is machine-written state
 * whose contents nobody reads by hand, and it is the single loudest reason a
 * reviewed file looks broken.
 *
 * The end line is the one holding `<!--mc:threads:end-->`; VS Code keeps the
 * start line visible, so the collapsed form still shows the begin fence and the
 * user can see the region exists.
 */
export function threadsFold(
  source: string,
  parsed: ParsedDocument,
): { startLine: number; endLine: number } | null {
  const region = parsed.threadsRegion;
  if (!region) return null;
  const startLine = lineAt(source, region.start);
  // `region.end` is just past the closing fence, so step back inside it.
  const endLine = lineAt(source, Math.max(region.start, region.end - 1));
  if (endLine <= startLine) return null;
  return { startLine, endLine };
}

/**
 * The one-line summary shown as a CodeLens at the top of a reviewed file, or
 * null when the file carries no review state.
 *
 * One lens, top of file only. A lens per thread would compete with the
 * decorations for the same information and turn a reviewed document into a
 * wall of chrome — the per-thread affordance is the hover.
 */
export function presenceLensLabel(parsed: ParsedDocument): string | null {
  const threads = parsed.threads.length;
  const suggestions = parsed.suggestions.length;
  if (threads === 0 && suggestions === 0) return null;

  const parts: string[] = [];
  if (threads > 0) {
    const unresolved = parsed.threads.filter((t) => t.status === "open").length;
    parts.push(`${threads} comment${threads === 1 ? "" : "s"}`);
    // Only when it differs from the total — "3 comments, 3 unresolved" is noise.
    if (unresolved > 0 && unresolved !== threads) parts.push(`${unresolved} unresolved`);
    else if (unresolved === 0) parts.push("all resolved");
  }
  const unread = parsed.threads.filter(isClaudeUnread).length;
  if (unread > 0) parts.push(`${unread} new from Claude`);
  if (suggestions > 0) parts.push(`${suggestions} suggestion${suggestions === 1 ? "" : "s"}`);

  return `${parts.join(" · ")} — open review view`;
}

/** The thread whose anchored span covers `offset`, innermost first. */
export function threadAt(parsed: ParsedDocument, offset: number): InlineThread | null {
  let best: { thread: InlineThread; width: number } | null = null;
  for (const t of parsed.threads) {
    const a = parsed.anchors.get(t.id);
    if (!a) continue;
    if (offset < a.openStart || offset >= a.closeEnd) continue;
    const width = a.closeEnd - a.openStart;
    // Nested anchors are legal; the tightest one is the one being pointed at.
    if (!best || width < best.width) best = { thread: t, width };
  }
  return best?.thread ?? null;
}

/** Author, age, and body of the newest comment that hasn't been deleted. */
function latestLive(thread: InlineThread): { author: string; ts: string; body: string } | null {
  for (let i = thread.comments.length - 1; i >= 0; i--) {
    const c = thread.comments[i];
    if (!c.deleted) return { author: c.author, ts: c.ts, body: c.body };
  }
  return null;
}

/** One quoted line of a comment body, short enough to live in a hover. */
function gist(body: string, max = 220): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Hover markdown for the thread at `offset`, or null when there is none.
 *
 * `commandLinks` is off for the tests and on in the editor: a `command:` URI
 * only resolves inside a trusted MarkdownString, and building the string is
 * the part worth asserting.
 */
export function hoverFor(
  parsed: ParsedDocument,
  offset: number,
  opts: { now?: number; commandLinks?: boolean; file?: string } = {},
): { thread: InlineThread; markdown: string } | null {
  const thread = threadAt(parsed, offset);
  if (!thread) return null;

  const live = thread.comments.filter((c) => !c.deleted);
  const latest = latestLive(thread);
  const lines: string[] = [];

  const badges: string[] = [];
  if (thread.status === "resolved") badges.push("resolved");
  else if (isClaudeUnread(thread)) badges.push("new from Claude");
  if (parsed.suggestions.some((s) => s.threadId === thread.id)) badges.push("has a suggestion");
  lines.push(
    `**Markdown Collab** — ${live.length} comment${live.length === 1 ? "" : "s"}` +
      (badges.length ? ` · ${badges.join(" · ")}` : ""),
  );

  if (latest) {
    lines.push("");
    const when = formatRelativeTime(latest.ts, opts.now);
    lines.push(`**${latest.author}**${when ? ` · ${when}` : ""}`);
    lines.push("");
    lines.push(gist(latest.body));
  }

  if (live.length > 1) {
    lines.push("");
    lines.push(`_+${live.length - 1} earlier — open the review view to read the thread._`);
  }

  if (opts.commandLinks && opts.file) {
    // Encoded as a JSON array, which is what VS Code expects in a command URI.
    const args = encodeURIComponent(JSON.stringify([opts.file, thread.id]));
    lines.push("");
    lines.push(`[Open in review view](command:markdownCollab.revealThread?${args})`);
  }

  return { thread, markdown: lines.join("\n") };
}
