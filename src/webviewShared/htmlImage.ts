// Recognize an `<img>` written as raw HTML, without opening the door to raw
// HTML in general.
//
// Markdown can't centre an image or set its width, so real documents reach for
// `<img src="x.png" width="400">` and `<p align="center"><img …></p>`
// constantly. Every review surface here escapes raw HTML on purpose — the
// document under review may be untrusted, and `html: false` is the markdown-it
// contract the other two surfaces state explicitly — so those images showed up
// as literal angle-bracket text.
//
// The narrow answer: recognize the *image* case only, extract a fixed set of
// attributes, and let the caller build a real element from those values. No
// HTML is ever parsed into the DOM and nothing else in the blob is honoured, so
// a `<script>`, an `onerror=`, or an `<iframe>` still renders as the escaped
// text it does today.

export interface HtmlImage {
  src: string;
  alt?: string;
  title?: string;
  /** Only a bare number or a number with `px`/`%`, so it can't carry CSS. */
  width?: string;
  height?: string;
  /** True when a wrapping element asked for centering (`align="center"`). */
  centered?: boolean;
}

/** Tags allowed to surround the image and contribute nothing else. */
const WRAPPER_TAGS = new Set(["p", "div", "a", "center", "figure", "span", "picture", "br"]);

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g;

/** Attribute values we will pass on, and nothing else. */
function attributesOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    out.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/**
 * A URL safe to hand to an `<img src>`. Anything with a scheme we don't
 * recognize is refused rather than resolved: `resolveImageSrc` passes an
 * unknown scheme through untouched, and "untouched" must not mean "rendered".
 */
function safeSrc(raw: string): string | null {
  const src = raw.trim();
  if (!src) return null;
  // A scheme-bearing URL must be one of the ones a picture can legitimately use.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(src);
  if (scheme) {
    const ok = /^(https?|data|file|vscode-webview|vscode-webview-resource)$/i.test(scheme[1]);
    if (!ok) return null;
    // `data:` is only a picture if it says it is — `data:text/html,…` is not.
    if (/^data:/i.test(src) && !/^data:image\//i.test(src)) return null;
  }
  return src;
}

/** A dimension is a bare number, or a number with px / %. Never arbitrary CSS. */
function safeDimension(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  return /^\d+(\.\d+)?(px|%)?$/.test(v) ? v : undefined;
}

/**
 * Read a raw-HTML blob as a single image, or return null to leave it as text.
 *
 * Returns null unless the blob contains exactly one `<img>` and everything
 * else in it is whitespace or a permitted wrapper tag — so a paragraph of
 * prose with an image in the middle, or anything carrying a second element
 * with content, keeps today's escaped rendering.
 */
export function parseHtmlImage(raw: string): HtmlImage | null {
  if (!raw || !/<img\b/i.test(raw)) return null;

  IMG_TAG_RE.lastIndex = 0;
  const imgTags = raw.match(IMG_TAG_RE) ?? [];
  if (imgTags.length !== 1) return null;

  // Everything that is not the image must be a bare wrapper.
  let centered = false;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    if (name === "img") continue;
    if (!WRAPPER_TAGS.has(name)) return null;
    const attrs = attributesOf(m[0]);
    if ((attrs.get("align") ?? "").toLowerCase() === "center") centered = true;
    // A wrapper carrying a script handler is not a wrapper we want to honour.
    for (const key of attrs.keys()) {
      if (key.startsWith("on")) return null;
    }
  }
  // Text outside the tags means this blob is prose, not a picture.
  const withoutTags = raw.replace(TAG_RE, "").trim();
  if (withoutTags.length > 0) return null;

  const attrs = attributesOf(imgTags[0]);
  // An `onerror` / `onload` on the image itself is the classic injection; the
  // attribute whitelist below drops it anyway, but refuse the whole blob so
  // nothing about it renders.
  for (const key of attrs.keys()) {
    if (key.startsWith("on")) return null;
  }

  const src = safeSrc(attrs.get("src") ?? "");
  if (!src) return null;

  const style = attrs.get("style");
  if (style && /expression|url\s*\(|javascript:/i.test(style)) return null;

  return {
    src,
    alt: attrs.get("alt"),
    title: attrs.get("title"),
    width: safeDimension(attrs.get("width")),
    height: safeDimension(attrs.get("height")),
    centered: centered || undefined,
  };
}
