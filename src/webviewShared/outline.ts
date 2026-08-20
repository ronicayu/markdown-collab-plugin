// The document outline behind the table-of-contents panel.
//
// Pure: headings in, a tree out. The surfaces differ in how they render and
// how they scroll, but "what are this document's headings, and which contains
// which" is one question with one answer, and it is the part worth testing.
//
// Headings come from the markdown source rather than the rendered DOM. Reading
// the DOM would mean the outline disagrees with the document whenever a
// renderer changes, and would miss headings scrolled out of a virtualized view.

import { slugifyHeading } from "../inlineComments/linkParse";

/** One heading, with its children nested underneath. */
export interface OutlineNode {
  /** 1–6. */
  level: number;
  /** Heading text with inline markup stripped — this is a label, not markdown. */
  text: string;
  /** 0-based line in the text the outline was built from. */
  line: number;
  /** GitHub-style slug, for matching a `#fragment` link. */
  slug: string;
  children: OutlineNode[];
}

const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_RE = /^[ \t]{0,3}(```+|~~~+)/;

/**
 * Strip the inline markup a heading can carry, so the panel shows a label
 * rather than backticks and brackets. Deliberately not a markdown render: this
 * text goes into a title attribute and a flat list item, and markup there is
 * noise at best and an injection surface at worst.
 */
export function headingLabel(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// The slug comes from `linkParse`, which is what both surfaces already use to
// resolve a `#fragment` to a heading. A second definition here would be a
// second answer to "which heading is this?" — and the weaker version this
// replaces dropped non-ASCII letters, so clicking "Café" in the outline would
// have scrolled nowhere.
export { slugifyHeading as slugify } from "../inlineComments/linkParse";

/**
 * Every heading in `markdown`, flat and in document order.
 *
 * Fenced code is skipped: a `# comment` inside a shell example is not a
 * heading, and a table of contents that lists one is worse than useless
 * because clicking it scrolls somewhere arbitrary.
 */
export function headings(markdown: string): Array<Omit<OutlineNode, "children">> {
  const lines = markdown.split("\n");
  const out: Array<Omit<OutlineNode, "children">> = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;

  const push = (level: number, raw: string, line: number): void => {
    const text = headingLabel(raw);
    if (!text) return;
    const base = slugifyHeading(text);
    // GitHub disambiguates repeats with -1, -2 …; a TOC with two identical
    // slugs would scroll both entries to the first heading.
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ level, text, line, slug: n === 0 ? base : `${base}-${n}` });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const atx = ATX_RE.exec(line);
    if (atx) {
      push(atx[1].length, atx[2], i);
      continue;
    }
    // Setext: the underline belongs to the line above, which must be prose.
    const setext = SETEXT_RE.exec(line);
    if (setext && i > 0) {
      const above = lines[i - 1].trim();
      if (above && !ATX_RE.test(lines[i - 1]) && !SETEXT_RE.test(lines[i - 1])) {
        push(setext[1][0] === "=" ? 1 : 2, above, i - 1);
      }
    }
  }
  return out;
}

/**
 * Nest a flat heading list by level.
 *
 * Real documents skip levels (an `h1` followed by an `h3`) and start at the
 * wrong one (a file whose first heading is `h2`). Both are handled by nesting
 * against whatever is on the stack rather than assuming a well-formed
 * hierarchy — an outline that drops headings because the document is untidy is
 * an outline nobody trusts.
 */
export function buildOutline(markdown: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const h of headings(markdown)) {
    const node: OutlineNode = { ...h, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

/** Total headings in a tree — for the panel's "N headings" label. */
export function outlineSize(nodes: readonly OutlineNode[]): number {
  return nodes.reduce((n, node) => n + 1 + outlineSize(node.children), 0);
}

/**
 * The node whose heading most recently precedes `line` — the section the
 * reader is currently in, for highlighting as they scroll.
 */
export function activeSlug(nodes: readonly OutlineNode[], line: number): string | null {
  // Tracked as two locals rather than an object: assigning an object inside a
  // closure narrows `best` to `never` on read, and the workaround is uglier
  // than just keeping the fields apart.
  let bestSlug: string | null = null;
  let bestLine = -1;
  const walk = (list: readonly OutlineNode[]): void => {
    for (const n of list) {
      if (n.line <= line && n.line >= bestLine) {
        bestSlug = n.slug;
        bestLine = n.line;
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return bestSlug;
}
