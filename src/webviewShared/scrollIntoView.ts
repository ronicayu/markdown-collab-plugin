// Reduced-motion-aware `scrollIntoView`, shared by every webview surface
// (10x-plan-4 P2.4).
//
// The inline-comments client grew this first (0.35.1), for its own jump
// targets (n/p thread navigation, "Next unread from Claude"). Once the live
// editor, the PR/MR view, and the shared diff-nav helper each had their own
// smooth-scrolling call sites, the media-query check either had to be copied
// at every one of them or centralized — and a copy is exactly the kind of
// thing that drifts the next time only one of them gets fixed.
//
// `scrollIntoView({ behavior: "smooth" })` is decoration, not information: a
// user who has "reduce motion" on at the OS level shouldn't get it back just
// because a webview added another jump target. Every call site under
// src/inlineComments/webview/, src/webview/, src/pr/webview/, and
// src/webviewShared/ must go through this — see
// src/test/reducedMotionGuard.test.ts.

/**
 * `scrollIntoView` that drops to `"auto"` when the OS has "reduce motion" on.
 */
export function smoothScrollIntoView(el: Element, block: ScrollLogicalPosition): void {
  const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  el.scrollIntoView({ behavior, block });
}
