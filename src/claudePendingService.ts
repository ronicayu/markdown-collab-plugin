// The one place that knows which threads are waiting on Claude (10x-plan P1.2).
//
// The tracker itself is pure and lives in `inlineComments/claudePending.ts`.
// This module owns the single host-wide instance and the fan-out to whichever
// views are open, so the inline comments panel and the live editor show the
// same "Claude is working…" state for the same document — including when the
// send came from a command palette invocation with no panel open at all.

import { ClaudePendingTracker } from "./inlineComments/claudePending";

type Listener = (docKey: string) => void;

const listeners = new Set<Listener>();

/**
 * Shared tracker. Keyed by `uri.toString()` — the same key the panel registry
 * uses, so a view can match its own document without a path comparison.
 */
export const claudePending = new ClaudePendingTracker((docKey) => {
  for (const listener of [...listeners]) {
    try {
      listener(docKey);
    } catch {
      // A broken listener must not stop the others from clearing their state.
    }
  }
});

/**
 * Subscribe to pending-set changes. Neither end of this has a file write to
 * hang off: marking happens when the payload goes out (before Claude touches
 * anything) and expiry happens on a timer, so views that only re-render on
 * document change would show the indicator late and clear it never.
 */
export function onPendingChanged(listener: Listener): { dispose(): void } {
  listeners.add(listener);
  return {
    dispose() {
      listeners.delete(listener);
    },
  };
}
