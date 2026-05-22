// Parse markdown link hrefs and compute heading slugs. Pure functions —
// shared by the webview client (for in-doc # navigation) and the panel
// host (for cross-file navigation). No DOM, no vscode API.

/**
 * True when `href` looks like an absolute URL (worth handing off to the
 * OS via `openExternal`) rather than a relative file path.
 *
 * RFC 3986 says scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) —
 * which means `foo.md:42` is technically a valid scheme syntactically.
 * To avoid mis-detecting filenames with `:line` suffixes as URLs, we
 * require either:
 *
 *   - the scheme is followed by `//` (web URLs: http, https, file, ftp), OR
 *   - the scheme is one of the well-known no-slash schemes (`mailto`, `tel`).
 *
 * Returns the matched scheme (lowercased) when absolute, or `null`
 * otherwise. Callers can inspect the scheme for allow-listing.
 */
export function detectUrlScheme(href: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const rest = href.slice(m[0].length);
  if (scheme === "mailto" || scheme === "tel") return scheme;
  if (rest.startsWith("//")) return scheme;
  return null;
}

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

  // GitHub-style `#L42` (or `#L42-L50`) in the fragment — treat as a
  // line hint and clear the heading so downstream code doesn't try to
  // slug-match a heading named "L42". A `:N` suffix already on the
  // path takes priority over this; we only fill from the fragment
  // when no explicit line was given.
  if (line === null && heading) {
    const lineFragMatch = /^L([1-9]\d{0,8})(?:[-:]L?[1-9]\d{0,8})?$/i.exec(heading);
    if (lineFragMatch) {
      line = Number(lineFragMatch[1]);
      heading = null;
    }
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
