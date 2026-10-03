// Shared "…" / options menu controller (sidebar-chrome-redesign phase 2,
// pr-review-redesign).
//
// One trigger/panel pair open at a time — the header's "…", the footer's
// send-options, or a single card's own menu — tracked centrally rather than
// per-menu, so a click anywhere else (another trigger, the document) closes
// whatever was open first. Escape closes and returns focus to the trigger; an
// outside click closes without stealing focus back from wherever the user
// clicked next.
//
// Extracted out of threadSidebar.ts (the live sidebar) so the PR review
// sidebar can reuse the exact same behaviour instead of a second copy that
// could drift from it (docs/pr-review-redesign.md). Each caller gets its own
// controller instance — and its own pair of document listeners, installed
// once per instance — so the live editor and the PR webview (different pages
// entirely) never share state.

export interface MenuController {
  /** Open `panel` if it isn't already, close it if it is. */
  toggleMenuAt(trigger: HTMLButtonElement, panel: HTMLElement): void;
  /** Close whatever menu is open, if any. `returnFocus` moves focus back to its trigger. */
  closeOpenMenu(returnFocus: boolean): void;
  /**
   * Close the open menu if its panel lives inside `container` — call before
   * clearing a container's contents (e.g. re-rendering a card list) so the
   * controller never keeps a reference to a panel about to be detached.
   */
  closeMenuWithin(container: Node): void;
  /** One `role="menuitem"` button for a "…" menu. */
  buildMenuItem(label: string, onClick: () => void, opts?: { danger?: boolean }): HTMLButtonElement;
}

/**
 * Build a menu controller. Call once per page: it installs document-level
 * click/keydown listeners that live as long as the page.
 */
export function createMenuController(): MenuController {
  let openMenu: { trigger: HTMLButtonElement; panel: HTMLElement } | null = null;

  function closeOpenMenu(returnFocus: boolean): void {
    if (!openMenu) return;
    const { trigger, panel } = openMenu;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    openMenu = null;
    if (returnFocus && trigger.isConnected) trigger.focus();
  }

  function openMenuAt(trigger: HTMLButtonElement, panel: HTMLElement): void {
    closeOpenMenu(false);
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openMenu = { trigger, panel };
    panel.querySelector<HTMLElement>('[role="menuitem"]:not([hidden])')?.focus();
  }

  function toggleMenuAt(trigger: HTMLButtonElement, panel: HTMLElement): void {
    if (openMenu?.panel === panel) closeOpenMenu(false);
    else openMenuAt(trigger, panel);
  }

  document.addEventListener("click", (e) => {
    if (!openMenu) return;
    const target = e.target as Node;
    if (openMenu.panel.contains(target) || openMenu.trigger.contains(target)) return;
    closeOpenMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (!openMenu) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOpenMenu(true);
    }
  });

  function buildMenuItem(label: string, onClick: () => void, opts: { danger?: boolean } = {}): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.className = opts.danger ? "mc-menuitem danger" : "mc-menuitem";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  return {
    toggleMenuAt,
    closeOpenMenu,
    closeMenuWithin(container: Node): void {
      if (openMenu && container.contains(openMenu.panel)) closeOpenMenu(false);
    },
    buildMenuItem,
  };
}
