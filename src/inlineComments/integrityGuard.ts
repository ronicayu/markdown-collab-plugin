// Watch-time integrity guard (10x-plan P0.2).
//
// The `mdc` CLI stops Claude from breaking markers. It cannot stop the human,
// a formatter, a merge, or another tool — and today that damage is discovered
// lazily, as a "broken anchor" badge, often long after the context needed to
// fix it is gone.
//
// This module is the defense-in-depth layer: every watched `.md` change is
// checked, and the user is told immediately, once per distinct problem.
//
// Deliberately NOT auto-writing repairs. `repairIntegrity` is safe by
// construction (markers only, prose never), but a review tool that silently
// rewrites the file it is reviewing spends exactly the trust it exists to
// build. The guard reports and offers a one-click repair instead; the
// decision stays with the human.

import { checkIntegrity, type IntegrityIssue } from "./integrity";

/** Any inline-comment marker at all — the cheap "is this our document" test. */
const ANY_MARKER_RE = /<!--mc:(a:|\/a:|t\s|threads:)/;

export interface GuardDecision {
  fsPath: string;
  issues: IntegrityIssue[];
  /** Issues `repairIntegrity` can fix without guessing. */
  repairableCount: number;
  /** Stable identity of this problem set, used to avoid repeat notifications. */
  signature: string;
}

/**
 * Check one document. Returns null when it is healthy or carries no
 * inline-comment markup at all.
 *
 * The marker pre-test matters: the watcher sees every `.md` in the workspace,
 * and most of them have nothing to do with this extension. Note it tests for
 * *any* marker, not just the threads fence — a file whose threads region was
 * destroyed but whose anchors remain is precisely the damaged case we must
 * not skip.
 */
export function evaluateDocument(fsPath: string, text: string): GuardDecision | null {
  if (!ANY_MARKER_RE.test(text)) return null;
  const report = checkIntegrity(text);
  if (report.ok) return null;
  return {
    fsPath,
    issues: report.issues,
    repairableCount: report.counts.repairable,
    signature: signatureOf(report.issues),
  };
}

/**
 * Order-independent identity for a set of issues. Two checks of the same
 * damage produce the same signature, so the user is notified once rather
 * than on every keystroke-triggered save.
 */
function signatureOf(issues: IntegrityIssue[]): string {
  return issues
    .map((i) => `${i.kind}:${i.threadId ?? "-"}`)
    .sort()
    .join("|");
}

/**
 * Per-file memory of what the user has already been told.
 *
 * Rules:
 *   - a new problem set notifies
 *   - the same problem set stays quiet
 *   - a document going healthy clears the memory, so if the same damage
 *     reappears later it is reported again (it is new information then)
 */
export class IntegrityGuard {
  private readonly lastSignature = new Map<string, string>();

  /**
   * Returns a decision when the user should be told, null otherwise.
   * Always call this — it maintains the memory that makes dedup work.
   */
  consider(fsPath: string, text: string): GuardDecision | null {
    const decision = evaluateDocument(fsPath, text);
    if (!decision) {
      this.lastSignature.delete(fsPath);
      return null;
    }
    if (this.lastSignature.get(fsPath) === decision.signature) return null;
    this.lastSignature.set(fsPath, decision.signature);
    return decision;
  }

  /** Drop memory for a file (deleted, or renamed away). */
  forget(fsPath: string): void {
    this.lastSignature.delete(fsPath);
  }

  /** Forget everything — used on dispose. */
  clear(): void {
    this.lastSignature.clear();
  }
}

/**
 * One-line summary for a notification. Leads with the count because that is
 * what the user needs to decide whether to look now, and names the file
 * because the notification appears with no other context.
 */
export function summarize(decision: GuardDecision, fileLabel: string): string {
  const n = decision.issues.length;
  const noun = n === 1 ? "problem" : "problems";
  const repairable = decision.repairableCount;
  const tail =
    repairable === 0
      ? "None can be repaired automatically."
      : repairable === n
        ? "All can be repaired automatically."
        : `${repairable} of them can be repaired automatically.`;
  return `${n} comment-anchor ${noun} in ${fileLabel}. ${tail}`;
}
