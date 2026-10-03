// The one host-wide review-pass tracker (10x-plan-4 P2.2).
//
// Same role as `claudePendingService.ts`, for the pure tracker in
// `reviewPassPending.ts`: a single shared instance and a fan-out so the status
// bar (the only view this has today — there is no panel-level "review pass"
// card) re-renders the moment a pass changes, whether that change came from a
// document edit, a `FileSystemWatcher` tick, or an MCP tool call.

import { ReviewPassTracker } from "./reviewPassPending";

type Listener = (folderKey: string) => void;

const listeners = new Set<Listener>();

/** Shared tracker. Keyed by `folder.uri.toString()` — "one live pass per workspace folder". */
export const reviewPassPending = new ReviewPassTracker((folderKey) => {
  for (const listener of [...listeners]) {
    try {
      listener(folderKey);
    } catch {
      // A broken listener must not stop the others from clearing their state.
    }
  }
});

/** Subscribe to pass-state changes. Like `onPendingChanged`, neither end of
 * this has a file write to hang off reliably: a timeout and an "arrived" via
 * a disk-only write both need to be observable with no document open. */
export function onReviewPassChanged(listener: Listener): { dispose(): void } {
  listeners.add(listener);
  return {
    dispose() {
      listeners.delete(listener);
    },
  };
}
