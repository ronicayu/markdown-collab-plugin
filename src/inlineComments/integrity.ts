// Integrity checking and safe repair for inline-comment documents.
//
// `parse()` in format.ts is deliberately lenient: a damaged thread line or
// a stray marker must never take the whole document down. That leniency
// means corruption is *invisible* until a thread quietly stops showing up.
// This module is the counterpart — it names every way a document can be
// broken, and repairs the subset that can be fixed without guessing.
//
// Three consumers share it:
//   - `mdc check` (the CLI Claude runs after editing)
//   - the extension's on-disk watcher (validate-and-repair pass)
//   - the round-trip corpus test harness (as its invariant oracle)
//
// THE PROSE RULE: a repair may add or remove `<!--mc:...-->` markers and
// rewrite the threads region. It may NEVER change a single character of
// prose. Every repair below is checked against that rule by the corpus
// suite, and `repairIntegrity` re-verifies it before returning.

import {
  inspect,
  parse,
  stripAllInlineMarkup,
  stripAnchorMarkers,
  withThreads,
  type InlineThread,
} from "./format";

export type IntegritySeverity = "error" | "warning";

export type IntegrityIssueKind =
  /** An open marker with no close, a close with no open, or a duplicate open. */
  | "unpaired-marker"
  /** A `<!--mc:t ...-->` line that produced no thread (bad JSON / no id). */
  | "malformed-thread-json"
  /** The same thread id on more than one thread line. */
  | "duplicate-thread-id"
  /** Anchor markers in the prose with no matching thread. */
  | "orphan-anchor"
  /** A thread in the threads region with no anchor markers in the prose. */
  | "unanchored-thread";

export interface IntegrityIssue {
  kind: IntegrityIssueKind;
  severity: IntegritySeverity;
  /** Human-readable, safe to show in a notification or print to stderr. */
  message: string;
  threadId?: string;
  /** Byte offset into the source, when the issue has a location. */
  offset?: number;
  /** Whether `repairIntegrity` can fix this without guessing. */
  repairable: boolean;
}

export interface IntegrityReport {
  /** True when there are no issues at all. */
  ok: boolean;
  issues: IntegrityIssue[];
  counts: {
    threads: number;
    anchored: number;
    unanchored: number;
    /** Issues `repairIntegrity` would fix. */
    repairable: number;
  };
}

/**
 * Diagnose a document. Pure — never mutates, never throws on damage.
 *
 * Ordering is stable (by kind, then by offset/id) so callers can diff two
 * reports to see whether a document got better or worse.
 */
export function checkIntegrity(source: string): IntegrityReport {
  const insp = inspect(source);
  const issues: IntegrityIssue[] = [];

  for (const m of insp.unpairedMarkers) {
    issues.push({
      kind: "unpaired-marker",
      severity: "error",
      message:
        m.kind === "open"
          ? `Anchor ${m.id} has an opening marker with no matching close.`
          : `Anchor ${m.id} has a closing marker with no matching open.`,
      threadId: m.id,
      offset: m.start,
      repairable: true,
    });
  }

  for (const m of insp.malformedThreadLines) {
    issues.push({
      kind: "malformed-thread-json",
      severity: "error",
      message:
        m.reason === "json-parse-error"
          ? `A thread line contains invalid JSON and was skipped: ${truncate(m.raw)}`
          : `A thread line has no "id" field and was skipped: ${truncate(m.raw)}`,
      repairable: false,
    });
  }

  for (const id of insp.duplicateThreadIds) {
    issues.push({
      kind: "duplicate-thread-id",
      severity: "error",
      message: `Thread id ${id} appears on more than one thread line; only the last is used.`,
      threadId: id,
      repairable: false,
    });
  }

  for (const id of insp.orphanAnchorIds) {
    issues.push({
      kind: "orphan-anchor",
      severity: "warning",
      message: `Anchor markers for ${id} are in the prose but the thread is gone.`,
      threadId: id,
      offset: insp.parsed.anchors.get(id)?.openStart,
      repairable: true,
    });
  }

  for (const id of insp.parsed.unanchoredThreadIds) {
    const thread = insp.parsed.threads.find((t) => t.id === id);
    const recoverable = thread ? canRecoverByQuote(source, thread) : false;
    issues.push({
      kind: "unanchored-thread",
      severity: "warning",
      message: recoverable
        ? `Thread ${id} lost its anchor markers; its quote still matches exactly one place in the prose.`
        : `Thread ${id} has no anchor markers and its quote cannot be located unambiguously.`,
      threadId: id,
      repairable: recoverable,
    });
  }

  const anchored = insp.parsed.threads.length - insp.parsed.unanchoredThreadIds.length;
  return {
    ok: issues.length === 0,
    issues,
    counts: {
      threads: insp.parsed.threads.length,
      anchored,
      unanchored: insp.parsed.unanchoredThreadIds.length,
      repairable: issues.filter((i) => i.repairable).length,
    },
  };
}

export interface RepairAction {
  kind: IntegrityIssueKind;
  threadId?: string;
  /** Past-tense description of what was done, for logging. */
  description: string;
}

export interface RepairResult {
  source: string;
  repairs: RepairAction[];
  /** Issues still present after repair. */
  remaining: IntegrityIssue[];
}

/**
 * Fix what can be fixed without guessing, leave the rest reported.
 *
 * Repairs, in order (each is marker-or-threads-region-only):
 *   1. strip unpaired markers — a half-anchor renders as literal junk and
 *      confuses the pairer on the next parse
 *   2. strip orphan anchors — markers whose thread no longer exists
 *   3. re-anchor unanchored threads whose quote occurs exactly once
 *
 * Returns the original source untouched when nothing is repairable, so
 * callers can cheaply skip a write.
 */
export function repairIntegrity(source: string): RepairResult {
  const before = checkIntegrity(source);
  if (before.counts.repairable === 0) {
    return { source, repairs: [], remaining: before.issues };
  }

  const proseBefore = stripAllInlineMarkup(source);
  const repairs: RepairAction[] = [];
  let next = source;

  // 1. Unpaired markers — delete from the end backwards so earlier offsets
  //    stay valid as we splice.
  const unpaired = [...inspect(next).unpairedMarkers].sort((a, b) => b.start - a.start);
  for (const m of unpaired) {
    next = next.slice(0, m.start) + next.slice(m.end);
    repairs.push({
      kind: "unpaired-marker",
      threadId: m.id,
      description: `Removed a stray ${m.kind === "open" ? "opening" : "closing"} marker for ${m.id}.`,
    });
  }

  // 2. Orphan anchors — both markers present, thread gone.
  for (const id of inspect(next).orphanAnchorIds) {
    next = stripAnchorMarkers(next, id);
    repairs.push({
      kind: "orphan-anchor",
      threadId: id,
      description: `Removed anchor markers for ${id}, whose thread no longer exists.`,
    });
  }

  // 3. Unanchored threads whose quote is unique — re-wrap that occurrence.
  //    Re-parsed each iteration because each rewrap shifts offsets.
  for (;;) {
    const parsed = parse(next);
    const target = parsed.threads.find(
      (t) => parsed.unanchoredThreadIds.includes(t.id) && canRecoverByQuote(next, t),
    );
    if (!target) break;
    const rewrapped = rewrapByQuote(next, target);
    if (rewrapped === null) break;
    next = rewrapped;
    repairs.push({
      kind: "unanchored-thread",
      threadId: target.id,
      description: `Re-anchored thread ${target.id} to the unique occurrence of its quote.`,
    });
  }

  // The prose rule, enforced rather than trusted. If any repair changed a
  // character of prose, discard the whole batch — a reported problem beats
  // a silent corruption.
  if (stripAllInlineMarkup(next) !== proseBefore) {
    return {
      source,
      repairs: [],
      remaining: [
        ...before.issues,
        {
          kind: "unpaired-marker",
          severity: "error",
          message:
            "Automatic repair was abandoned: it would have altered prose text. The document is unchanged.",
          repairable: false,
        },
      ],
    };
  }

  return { source: next, repairs, remaining: checkIntegrity(next).issues };
}

/**
 * Can this thread's quote be located unambiguously in the prose?
 *
 * "Prose" here means the document with all markers and the threads region
 * stripped — otherwise a quote that sits next to another thread's markers
 * would never match. Requires exactly one occurrence: zero means the text
 * is gone, more than one means we'd be guessing.
 */
function canRecoverByQuote(source: string, thread: InlineThread): boolean {
  if (!thread.quote || thread.quote.trim() === "") return false;
  return countOccurrences(stripAllInlineMarkup(source), thread.quote) === 1;
}

/**
 * Wrap the unique occurrence of `thread.quote` in fresh anchor markers.
 * Returns null when the quote is not uniquely locatable *in the raw source*
 * — the marker-stripped text can contain a match that spans other threads'
 * markers, which we must not split.
 */
function rewrapByQuote(source: string, thread: InlineThread): string | null {
  const region = parse(source).threadsRegion;
  const searchEnd = region ? region.start : source.length;
  const haystack = source.slice(0, searchEnd);
  if (countOccurrences(haystack, thread.quote) !== 1) return null;
  const at = haystack.indexOf(thread.quote);
  if (at === -1) return null;
  const open = `<!--mc:a:${thread.id}-->`;
  const close = `<!--mc:/a:${thread.id}-->`;
  return (
    source.slice(0, at) +
    open +
    source.slice(at, at + thread.quote.length) +
    close +
    source.slice(at + thread.quote.length)
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Re-export so consumers need only one import. */
export { withThreads };
