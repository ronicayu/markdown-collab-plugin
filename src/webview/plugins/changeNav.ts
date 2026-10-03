// Change-navigation toolbar for the live editor's uncommitted-diff overlay
// (10x-plan-6 P4 phase B) — the same "N changes" / "i / N" counter and
// prev/next arrows as the review view's #diff-nav
// (src/inlineComments/webview/client.ts), built as its own DOM island
// because client.ts assembles the live editor's layout at runtime rather
// than serving a fixed HTML skeleton the way the review view's
// webviewShell.ts does.
//
// Reuses `createDiffNav` (src/webviewShared/diffNav.ts) for the actual
// stepping/counting/wrap-around — that piece is already shared with the
// review view, so there's nothing diff-specific left to reimplement here
// beyond the DOM and the small "uncommitted changes" badge.
//
// Keyboard is NOT wired here. The review view's n/p handler now lives in the
// shared sidebar module (src/webviewShared/threadSidebar.ts), whose
// `ThreadSidebarHandle.setChangeNavigation(step)` hook exists for exactly
// this — it steps changes instead of threads while a diff is showing.
// `step` below has the matching `(delta: 1 | -1) => void` shape, ready to
// hand to that hook once client.ts wires the live editor up to it (that
// wiring isn't in yet as of this file — see the round-6 P4 report).

import { createDiffNav } from "../../webviewShared/diffNav";

export interface ChangeNavHandle {
  /** Mount point: badge + arrows + counter. Hidden while there's nothing to show. */
  el: HTMLElement;
  /** Word the badge ("uncommitted changes", "new file — uncommitted", …); `null` hides it. */
  setBadge(text: string | null): void;
  /** Replace the navigable stops, in document order. Hides the arrows (not the badge) when empty. */
  setStops(stops: HTMLElement[]): void;
  /** Step to the next (+1) / previous (-1) change and scroll it into view. */
  step(delta: 1 | -1): void;
  nextChange(): void;
  prevChange(): void;
}

export function buildChangeNav(): ChangeNavHandle {
  const el = document.createElement("div");
  el.id = "mdc-diff-toolbar";
  el.className = "mdc-diff-toolbar";
  el.hidden = true;

  const badge = document.createElement("span");
  badge.id = "mdc-diff-badge";
  badge.className = "mdc-diff-badge";
  badge.hidden = true;

  const nav = document.createElement("span");
  nav.id = "mdc-diff-nav";
  nav.className = "mdc-diff-nav";
  nav.hidden = true;

  const prev = document.createElement("button");
  prev.type = "button";
  prev.id = "mdc-diff-prev";
  prev.className = "mdc-icon-btn";
  prev.title = "Previous change (p)";
  prev.setAttribute("aria-label", "Previous change");
  prev.textContent = "↑";

  const count = document.createElement("span");
  count.id = "mdc-diff-nav-count";
  count.className = "mdc-diff-nav-count";

  const next = document.createElement("button");
  next.type = "button";
  next.id = "mdc-diff-next";
  next.className = "mdc-icon-btn";
  next.title = "Next change (n)";
  next.setAttribute("aria-label", "Next change");
  next.textContent = "↓";

  nav.append(prev, count, next);
  el.append(badge, nav);

  const diffNav = createDiffNav({
    container: nav,
    prev,
    next,
    count,
    currentClass: "mdc-diff-current",
  });

  const updateVisibility = (): void => {
    el.hidden = badge.hidden && nav.hidden;
  };

  return {
    el,
    setBadge(text: string | null): void {
      badge.hidden = text === null;
      badge.textContent = text ?? "";
      updateVisibility();
    },
    setStops(stops: HTMLElement[]): void {
      // createDiffNav toggles `nav.hidden` itself (empty stops = hide).
      diffNav.setStops(stops);
      updateVisibility();
    },
    step: (delta) => diffNav.step(delta),
    nextChange: () => diffNav.step(1),
    prevChange: () => diffNav.step(-1),
  };
}
