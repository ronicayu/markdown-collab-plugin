// Parse markdown link hrefs and compute heading slugs. Pure functions —
// shared by the webview client (for in-doc # navigation) and the panel
// host (for cross-file navigation). No DOM, no vscode API.

export interface ParsedLinkHref {
  /** Path portion (decoded, with `./` stripped). Empty when href is fragment-only. */
  path: string;
  /** Heading fragment (without leading `#`), or null. Lower-priority than `line`. */
  heading: string | null;
  /** 1-based line number from a `:N` suffix, or null. */
  line: number | null;
  /** Query string (without leading `?`), or null. Carried through verbatim. */
  query: string | null;
}

/**
 * Split a markdown link href into path / fragment / line / query.
 *
 * Supports:
 * - `foo/bar.md`
 * - `foo/bar.md#section-heading`
 * - `foo/bar.md:42` — jump to line 42
 * - `#in-doc-heading` — same-doc heading jump (path empty)
 * - `?q=1#h` — query, then heading
 *
 * `:N` is recognized only at the end of the path (before any `#` / `?`)
 * and only when `N` is a positive integer. This avoids eating Windows
 * drive letters or port numbers in absolute URLs (callers should peel
 * off schemes before calling).
 */
export function parseLinkHref(raw: string): ParsedLinkHref {
  let rest = raw;

  // Pull off the fragment first.
  let heading: string | null = null;
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) {
    heading = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }

  // Then the query.
  let query: string | null = null;
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  // `:N` suffix → line number. Anchor to end-of-string. Bound to keep
  // sane: a positive integer with at most 9 digits (no GB-line files).
  let line: number | null = null;
  const lineMatch = /:([1-9]\d{0,8})$/.exec(rest);
  if (lineMatch) {
    line = Number(lineMatch[1]);
    rest = rest.slice(0, rest.length - lineMatch[0].length);
  }

  // Decode the path; tolerate badly-encoded input by falling back to raw.
  let p = rest;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw on decode error */
  }
  if (p.startsWith("./")) p = p.slice(2);

  return { path: p, heading, line, query };
}

/**
 * Slugify a markdown heading the way GitHub's renderer does. This is the
 * format markdown-it `anchor`-style plugins emit when given default
 * options, and is the de facto standard for in-doc heading links.
 *
 * Rules:
 * - lowercase
 * - strip punctuation except `-` and `_`
 * - whitespace runs collapse to a single `-`
 * - leading / trailing `-` stripped
 *
 * Returns an empty string when the heading has no slug-safe characters.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "") // drop punctuation
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
