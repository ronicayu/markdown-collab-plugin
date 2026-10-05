// Reduced-motion-aware `scrollIntoView`, shared by every webview surface.
//
// `scrollIntoView({ behavior: "smooth" })` is decoration, not information: a
// user who has "reduce motion" on at the OS level shouldn't get it back just
// because a webview added another jump target. Every call site under
// src/inlineComments/webview/, src/webview/, src/pr/webview/, and
// src/webviewShared/ must go through this — see
// src/test/reducedMotionGuard.test.ts.

export function smoothScrollIntoView(el: Element, block: ScrollLogicalPosition): void {
  const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  el.scrollIntoView({ behavior, block });
}
