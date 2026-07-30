// "The text changed since this comment" (10x-plan-2 P1.3).
//
// A thread whose anchored passage was rewritten after the last comment looks
// exactly like a live one: same quote in the header, same replies, same badge.
// The human triages against a comment that may no longer apply, and a delta
// review has no way to tell either.
//
// The fix is one optional field. Each thread can carry a hash of its anchored
// span as it read when the last comment was written; if the live span hashes
// differently, the text moved since someone last looked at it. Three properties
// make this cheap enough to be worth it:
//
//   - The parser already re-reads every span on every pass, so the comparison
//     is a string hash over text that's in hand.
//   - The field is optional. A file written by an older version has no hash,
//     and the answer for it is "unknown", never "unchanged" — an absent hash
//     must never render as a clean bill of health.
//   - It lives inline like everything else. No sidecar, no migration.
//
// Deliberately NOT reusing `quote`: that field is the creation-time text kept
// as a re-anchoring locator, and moving it whenever someone comments would
// break the repair path that depends on it.

import type { InlineThread, ParsedDocument } from "./format";

/**
 * A short, stable hash of the anchored text (FNV-1a, 32-bit, hex).
 *
 * Not cryptographic and doesn't need to be: it answers "is this the same string
 * as before", where both sides are the extension's own data and nobody gains
 * anything by forging a collision. Written by hand rather than with `crypto`
 * because this module is bundled into the webviews and the dependency-free
 * `mdc.mjs` alike.
 */
export function hashAnchorText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The live text between a thread's markers, or null when it has no anchor. */
export function anchoredTextOf(parsed: ParsedDocument, threadId: string): string | null {
  const a = parsed.anchors.get(threadId);
  if (!a) return null;
  return parsed.source.slice(a.openEnd, a.closeStart);
}

/**
 * Has this thread's anchored text changed since its last comment?
 *
 * `false` for a thread with no stored hash (unknown, not unchanged) and for an
 * unanchored thread (already surfaced as a broken anchor — two badges saying
 * different things about the same failure is worse than one).
 */
export function isThreadStale(parsed: ParsedDocument, threadId: string): boolean {
  const thread = parsed.threads.find((t) => t.id === threadId);
  if (!thread?.anchorHash) return false;
  const live = anchoredTextOf(parsed, threadId);
  if (live === null) return false;
  return hashAnchorText(live) !== thread.anchorHash;
}

/** Every thread whose anchored text has moved since its last comment. */
export function staleThreadIds(parsed: ParsedDocument): string[] {
  return parsed.threads.filter((t) => isThreadStale(parsed, t.id)).map((t) => t.id);
}

/**
 * The hash to store on a thread whose comment was just written — i.e. what the
 * author was looking at. Returns undefined for an unanchored thread, so a
 * thread that lost its markers doesn't acquire a hash of nothing.
 */
export function currentAnchorHash(parsed: ParsedDocument, threadId: string): string | undefined {
  const live = anchoredTextOf(parsed, threadId);
  return live === null ? undefined : hashAnchorText(live);
}

/**
 * The thread with its anchor hash refreshed to the live text — call this
 * whenever a comment lands on it, because whoever wrote that comment was
 * looking at the text as it reads now. Leaves an unanchored thread's hash
 * alone: there is nothing to have looked at.
 */
export function withRefreshedAnchorHash(parsed: ParsedDocument, thread: InlineThread): InlineThread {
  const hash = currentAnchorHash(parsed, thread.id);
  return hash === undefined ? thread : { ...thread, anchorHash: hash };
}
