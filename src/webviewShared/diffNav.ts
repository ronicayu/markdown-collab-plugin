// Prev/next-change navigation for the diff-striped views — the uncommitted
// review panel and the PR/MR review panel. GitHub and GitLab put arrows on
// their diffs because scrolling a long document hunting for the next stripe
// is the reviewer's tax on every file; these are the same arrows.
//
// The wrap-around stepping is `stepIndex` from findState — the find bar
// already solved "cycle through N things in both directions".

import { stepIndex } from "./findState";

export interface DiffNavHandle {
  /**
   * Replace the navigation stops (changed blocks / removed-text widgets, in
   * document order). Hides the controls when there are none, resets the
   * cursor — a re-render invalidates the old elements anyway.
   */
  setStops(stops: HTMLElement[]): void;
  /** Step to the next (+1) / previous (-1) change and scroll it into view. */
  step(delta: 1 | -1): void;
}

export function createDiffNav(opts: {
  /** Wrapper element shown only when there are stops. */
  container: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  /** Counter element; reads "N changes" idle, "i / N" once stepping. */
  count: HTMLElement;
  /** Class applied to the current stop so CSS can outline it. */
  currentClass: string;
}): DiffNavHandle {
  let stops: HTMLElement[] = [];
  let index = -1;

  const renderCount = (): void => {
    opts.count.textContent =
      index === -1
        ? `${stops.length} change${stops.length === 1 ? "" : "s"}`
        : `${index + 1} / ${stops.length}`;
  };

  const step = (delta: 1 | -1): void => {
    if (stops.length === 0) return;
    if (index >= 0 && index < stops.length) stops[index].classList.remove(opts.currentClass);
    index = stepIndex(index === -1 && delta === -1 ? 0 : index, delta, stops.length);
    const target = stops[index];
    target.classList.add(opts.currentClass);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    renderCount();
  };

  opts.prev.addEventListener("click", () => step(-1));
  opts.next.addEventListener("click", () => step(1));

  return {
    setStops(next: HTMLElement[]): void {
      stops = next;
      index = -1;
      opts.container.hidden = stops.length === 0;
      renderCount();
    },
    step,
  };
}

/**
 * True when a keydown should be treated as a navigation shortcut — i.e. the
 * user isn't typing. GitHub uses n/p on diffs; same here.
 */
export function isNavKeyContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return false;
  const tag = target.tagName;
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
}
