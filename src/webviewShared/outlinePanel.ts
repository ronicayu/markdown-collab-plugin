// The table-of-contents panel, built once for both rendered surfaces.
//
// A tree of headings with expand/collapse per node, a click that scrolls the
// surface, and a highlight for the section being read. The surfaces differ only
// in how they scroll to a heading, which arrives as a callback.
//
// Collapse state is keyed by slug rather than by position, so it survives an
// edit that adds a paragraph above — keying by index would silently transfer a
// user's collapsed section to whatever moved into its place.

import { outlineSize, type OutlineNode } from "./outline";

export interface OutlinePanelOptions {
  /** Scroll the surface to this heading. */
  onNavigate(node: OutlineNode): void;
  /** Slugs the user has collapsed, mutated in place as they toggle. */
  collapsed: Set<string>;
  /** Persist `collapsed` after a change. */
  onCollapseChanged?(): void;
}

export interface OutlinePanelHandle {
  el: HTMLElement;
  /** Re-render for a new outline. */
  update(nodes: OutlineNode[]): void;
  /** Highlight the section containing the reader, by slug. */
  setActive(slug: string | null): void;
}

/** Build the panel. Call `update` to fill it. */
export function buildOutlinePanel(opts: OutlinePanelOptions): OutlinePanelHandle {
  const el = document.createElement("div");
  el.className = "mc-outline";

  const header = document.createElement("div");
  header.className = "mc-outline__header";
  const title = document.createElement("span");
  title.className = "mc-outline__title";
  title.textContent = "Outline";
  const count = document.createElement("span");
  count.className = "mc-outline__count";
  header.append(title, count);

  const list = document.createElement("div");
  list.className = "mc-outline__list";
  list.setAttribute("role", "tree");
  list.setAttribute("aria-label", "Document outline");

  el.append(header, list);

  let current: OutlineNode[] = [];
  let activeSlug: string | null = null;

  const rowFor = (node: OutlineNode, depth: number): HTMLElement => {
    const row = document.createElement("div");
    row.className = "mc-outline__row";
    row.dataset.slug = node.slug;
    row.setAttribute("role", "treeitem");
    row.style.setProperty("--mc-outline-depth", String(depth));
    if (node.slug === activeSlug) row.classList.add("active");

    const hasChildren = node.children.length > 0;
    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = "mc-outline__twisty";
    if (hasChildren) {
      const isCollapsed = opts.collapsed.has(node.slug);
      twisty.textContent = isCollapsed ? "▸" : "▾";
      twisty.setAttribute(
        "aria-label",
        `${isCollapsed ? "Expand" : "Collapse"} ${node.text}`,
      );
      row.setAttribute("aria-expanded", String(!isCollapsed));
      twisty.addEventListener("click", (e) => {
        // Stop the row's own click: toggling a section is not navigating to it.
        e.stopPropagation();
        if (opts.collapsed.has(node.slug)) opts.collapsed.delete(node.slug);
        else opts.collapsed.add(node.slug);
        opts.onCollapseChanged?.();
        render();
      });
    } else {
      // A spacer, so leaf labels line up with their siblings' text rather than
      // sliding left into the twisty column.
      twisty.className = "mc-outline__twisty mc-outline__twisty--leaf";
      twisty.tabIndex = -1;
      twisty.setAttribute("aria-hidden", "true");
    }

    const label = document.createElement("span");
    label.className = `mc-outline__label mc-outline__label--h${node.level}`;
    label.textContent = node.text;
    label.title = node.text;

    row.append(twisty, label);
    row.addEventListener("click", () => opts.onNavigate(node));
    return row;
  };

  const render = (): void => {
    list.replaceChildren();
    const total = outlineSize(current);
    count.textContent = total === 0 ? "" : `${total}`;

    if (total === 0) {
      const empty = document.createElement("p");
      empty.className = "mc-outline__empty";
      // Says what to do, not just that there is nothing — an empty panel with
      // "No headings" in it teaches nobody anything.
      empty.textContent = "No headings yet. Add one with # to build an outline.";
      list.appendChild(empty);
      return;
    }

    const walk = (nodes: readonly OutlineNode[], depth: number): void => {
      for (const node of nodes) {
        list.appendChild(rowFor(node, depth));
        if (!opts.collapsed.has(node.slug)) walk(node.children, depth + 1);
      }
    };
    walk(current, 0);
  };

  return {
    el,
    update(nodes) {
      current = nodes;
      render();
    },
    setActive(slug) {
      if (slug === activeSlug) return;
      activeSlug = slug;
      for (const row of Array.from(list.querySelectorAll<HTMLElement>(".mc-outline__row"))) {
        row.classList.toggle("active", row.dataset.slug === slug);
      }
    },
  };
}
