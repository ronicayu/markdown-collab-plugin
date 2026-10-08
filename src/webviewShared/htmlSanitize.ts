// Raw HTML in the document under review, rendered without trusting it.
//
// Documents use HTML for what Markdown can't say — `<details>`, `<sup>`,
// `<kbd>`, a centred `<div>`, an HTML table — and showing that as escaped
// source made those documents hard to read. But the document may come from
// anyone, so nothing in it is ever handed to the DOM parser as written.
//
// Allowlist and rebuild: every tag is matched, and a tag on the allowlist is
// re-emitted from its name plus the attributes that pass a per-attribute check,
// with every value re-escaped. Text between tags is escaped. Anything that
// isn't a well-formed allowlisted tag — `<script>`, `<iframe>`, `<style>`, an
// unknown element, a stray `<` — stays visible as literal text, the way all
// raw HTML used to look, so a reviewer still sees exactly what the file holds.
// A `style` attribute is rebuilt from an allowlist of cosmetic properties with
// checked values (see htmlStyle.ts); `class`, `id`, `on*` and `data-*` never
// survive, and the webviews' CSP (nonce-only scripts) stays as a second line of defence.
//
// Works on fragments, not documents: an opening tag and its closing tag may
// arrive in different calls (markdown-it gives `<details>` and `</details>`
// their own blocks; Milkdown gives `<sup>` and `</sup>` their own nodes). Each
// tag is sanitized on its own, which is what makes that safe.
//
// Pure: no DOM, so the unit tests exercise exactly what the webviews run.

import { safeDimension, safeSrc } from "./htmlImage";
import { readableTextColor, safeStyle } from "./htmlStyle";

export interface SanitizeOptions {
  /** Rewrite an image `src` that passed the safety check (e.g. to a webview URI). */
  resolveSrc?: (src: string) => string;
  /**
   * The output goes into a shadow root inside a `contain: paint` box (see
   * shadowHtml.ts), where CSS can neither leak out nor paint outside the box.
   * There, `class`, `id`, any `style` declaration and `<style>` elements are
   * kept as written; only what executes, navigates or submits is still
   * refused. Only for a fragment `isSelfContained` accepts.
   */
  shadow?: boolean;
}

/** Elements that render. Roughly what GitHub keeps, minus anything interactive. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strike", "strong",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt",
  "u", "ul", "var", "wbr",
]);

/**
 * Allowed only in shadow-rendered fragments: `<style>`, whose rules can't
 * leave the shadow root, and sectioning elements that carry nothing but
 * layout (and classes for that `<style>` to target).
 */
const SHADOW_TAGS: ReadonlySet<string> = new Set([
  "style", "section", "article", "header", "footer", "nav", "aside", "main", "address", "hgroup",
]);

/** Elements with no content and no closing tag. */
const VOID_TAGS: ReadonlySet<string> = new Set(["br", "col", "hr", "img", "wbr"]);

/**
 * Inline formatting elements a document writes as `<x>text</x>`. The live
 * editor sees the two tags as separate nodes and pairs them itself; these are
 * the ones it pairs.
 */
export const INLINE_PAIR_TAGS: ReadonlySet<string> = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark",
  "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var",
]);

/** Elements that make a fragment lay out as a block rather than inline. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "blockquote", "center", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "h1",
  "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "summary", "table", "ul",
  "section", "article", "header", "footer", "nav", "aside", "main", "address", "hgroup",
]);

type AttrCheck = (value: string) => string | null;

const anything: AttrCheck = (v) => v;
const count: AttrCheck = (v) => (/^\d{1,4}$/.test(v.trim()) ? v.trim() : null);
const oneOf =
  (...allowed: string[]): AttrCheck =>
  (v) => {
    const t = v.trim().toLowerCase();
    return allowed.includes(t) ? t : null;
  };
const dimension: AttrCheck = (v) => safeDimension(v) ?? null;
const boolean: AttrCheck = () => "";

/** On every allowed element. */
const GLOBAL_ATTRS: Record<string, AttrCheck> = {
  title: anything,
  style: safeStyle,
  lang: (v) => (/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(v.trim()) ? v.trim() : null),
  dir: oneOf("ltr", "rtl", "auto"),
  align: oneOf("left", "right", "center", "justify"),
};

/** Added to `GLOBAL_ATTRS` (and replacing its `style` check) in shadow-rendered fragments. */
const SHADOW_ATTRS: Record<string, AttrCheck> = {
  class: anything,
  id: anything,
  style: (v) => {
    const color = readableTextColor(v);
    const kept = v.trim().replace(/;\s*$/, "");
    if (!kept) return null;
    return color ? `${kept}; color: ${color}` : kept;
  },
};

const TAG_ATTRS: Record<string, Record<string, AttrCheck>> = {
  a: { href: (v) => safeHref(v) },
  img: { alt: anything, width: dimension, height: dimension },
  td: { colspan: count, rowspan: count, valign: oneOf("top", "middle", "bottom", "baseline"), width: dimension },
  th: { colspan: count, rowspan: count, valign: oneOf("top", "middle", "bottom", "baseline"), width: dimension, scope: oneOf("row", "col", "rowgroup", "colgroup") },
  col: { span: count, width: dimension },
  colgroup: { span: count, width: dimension },
  ol: { start: count, type: (v) => (/^[1aAiI]$/.test(v.trim()) ? v.trim() : null), reversed: boolean },
  li: { value: count },
  details: { open: boolean },
  time: { datetime: anything },
};

/** One HTML comment. */
const COMMENT_RE = /<!--[\s\S]*?-->/;
/** One well-formed start or end tag; quoted values may contain `>`. */
const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const TOKEN_RE = new RegExp(`${COMMENT_RE.source}|${TAG_RE.source}`, "g");
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A link target: relative, a fragment, or http(s)/mailto. Never `javascript:`. */
export function safeHref(raw: string): string | null {
  // Control characters and whitespace are ignored by URL parsing, so
  // `java\tscript:` must be judged as `javascript:`.
  const v = raw.replace(/[\u0000- \u007f]/g, "");
  if (!v) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) return null;
  return raw.trim();
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Decode the entities an attribute value is likely to use. Partial on purpose:
 * the output re-escapes every `&`, so an entity left undecoded reaches the
 * browser as literal text and can't change meaning after the checks ran.
 */
function decodeEntities(v: string): string {
  return v.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);?/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text between tags: keep entity references, escape every other `&`, `<` and `>`. */
function escapeText(v: string): string {
  return v
    .replace(/&(?!(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface CleanTag {
  name: string;
  closing: boolean;
  /** Attributes that passed, decoded. Empty string for a boolean attribute. */
  attrs: Record<string, string>;
}

/** Parse one tag and keep what the allowlist permits, or null to show it as text. */
function cleanTag(closing: string, rawName: string, rawAttrs: string, opts: SanitizeOptions): CleanTag | null {
  const name = rawName.toLowerCase();
  if (!ALLOWED_TAGS.has(name) && !(opts.shadow && SHADOW_TAGS.has(name))) return null;
  if (closing) return { name, closing: true, attrs: {} };
  const attrs: Record<string, string> = {};
  const specific = TAG_ATTRS[name] ?? {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(rawAttrs)) !== null) {
    const attr = m[1].toLowerCase();
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    if (name === "img" && attr === "src") {
      const src = safeSrc(value);
      if (src !== null) attrs.src = opts.resolveSrc ? opts.resolveSrc(src) : src;
      continue;
    }
    const check = (opts.shadow ? SHADOW_ATTRS[attr] : undefined) ?? specific[attr] ?? GLOBAL_ATTRS[attr];
    if (!check) continue;
    const ok = check(value);
    if (ok !== null) attrs[attr] = ok;
  }
  // An image without a usable source has nothing to show: keep it as text.
  if (name === "img" && attrs.src === undefined) return null;
  return { name, closing: false, attrs };
}

function emit(tag: CleanTag): string {
  if (tag.closing) return VOID_TAGS.has(tag.name) ? "" : `</${tag.name}>`;
  const attrs = Object.entries(tag.attrs)
    .map(([k, v]) => (v === "" && (k === "open" || k === "reversed") ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
    .join("");
  return `<${tag.name}${attrs}>`;
}

/**
 * Sanitize a raw-HTML fragment into markup that is safe to assign to
 * `innerHTML`. Comments are dropped; anything not allowlisted is escaped.
 */
export function sanitizeHtml(raw: string, opts: SanitizeOptions = {}): string {
  let out = "";
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(raw)) !== null) {
    out += escapeText(raw.slice(last, m.index));
    last = TOKEN_RE.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    const tag = cleanTag(m[1], m[2], m[3], opts);
    if (tag && tag.name === "style") {
      // Only reachable in shadow mode. Its body is CSS, a raw-text element the
      // parser ends at the first `</style`: copy it verbatim up to exactly
      // there (escaping would break `>` combinators), and drop a stray close.
      if (tag.closing) continue;
      const body = styleBody(raw, last);
      out += `<style>${body.css}</style>`;
      last = TOKEN_RE.lastIndex = body.end;
      continue;
    }
    out += tag ? emit(tag) : escapeText(m[0]);
  }
  return out + escapeText(raw.slice(last));
}

/** The CSS of a `<style>` opened at `from`, and where its closing tag ends. */
function styleBody(raw: string, from: number): { css: string; end: number } {
  const rest = raw.slice(from);
  // The HTML parser's own rule: `</style` followed by whitespace, `/` or `>`.
  const close = /<\/style[\s/>]/i.exec(rest);
  if (!close) return { css: rest, end: raw.length };
  const gt = rest.indexOf(">", close.index);
  return { css: rest.slice(0, close.index), end: from + (gt < 0 ? rest.length : gt + 1) };
}

/**
 * Whether a fragment can be rendered on its own in a shadow root: it holds at
 * least one renderable tag, and every element it opens it also closes, in
 * order. A `<details>` whose `</details>` is in a later block, or a `<p>`
 * relying on an implied end tag, isn't — those keep the inline path, where
 * the surrounding document supplies the rest.
 */
export function isSelfContained(raw: string): boolean {
  const re = new RegExp(TOKEN_RE.source, "g");
  const open: string[] = [];
  let tags = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[0].startsWith("<!--")) continue;
    const name = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(name) && !SHADOW_TAGS.has(name)) continue;
    tags++;
    if (name === "style" && !m[1]) {
      re.lastIndex = styleBody(raw, re.lastIndex).end;
      continue;
    }
    if (VOID_TAGS.has(name)) continue;
    if (m[1]) {
      if (open.pop() !== name) return false;
    } else if (!m[4]) {
      open.push(name);
    }
  }
  return tags > 0 && open.length === 0;
}

/** What one raw-HTML snippet is, for a renderer that handles tags one at a time. */
export type HtmlSnippet =
  | { kind: "comment" }
  | { kind: "tag"; tag: CleanTag }
  | { kind: "fragment" };

/**
 * Classify a snippet: only comments, a single allowlisted tag (an opening
 * `<sup>` waiting for its `</sup>`), or anything else.
 */
export function classifyHtml(raw: string, opts: SanitizeOptions = {}): HtmlSnippet {
  const v = raw.trim();
  if (v.startsWith("<!--") && v.replace(new RegExp(COMMENT_RE.source, "g"), "").trim() === "") {
    return { kind: "comment" };
  }
  const single = new RegExp(`^${TAG_RE.source}$`).exec(v);
  if (single) {
    const tag = cleanTag(single[1], single[2], single[3], opts);
    if (tag) return { kind: "tag", tag };
  }
  return { kind: "fragment" };
}

/** Whether sanitized markup should lay out as a block. */
export function isBlockHtml(sanitized: string): boolean {
  const re = /<([a-z][a-z0-9]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    if (BLOCK_TAGS.has(m[1])) return true;
  }
  return false;
}
