// Decide whether a URL the webview asked us to open is one we are willing
// to hand to vscode.env.openExternal.
//
// The webview surface includes user-controlled markdown content. A
// reviewer (or a third party whose comment got pasted in) can author
// links like `[click](javascript:alert(1))` or `[doc](file:///etc/passwd)`.
// We allow only the schemes a normal review workflow needs and reject
// the rest. Returning false is the safe default — the click is silently
// dropped and a toast informs the user.

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isExternalLinkSafe(rawHref: string): boolean {
  if (typeof rawHref !== "string" || rawHref.length === 0) return false;
  // Reject ASCII control characters (\x00-\x1F) and DEL (\x7F).
  // Newlines in a mailto: target can inject extra mail headers; tabs or
  // CR inside an HTTP URL get parsed in surprising ways depending on
  // the OS opener.
  if (hasControlChars(rawHref)) return false;
  const lower = rawHref.toLowerCase();
  if (lower.startsWith("mailto:")) return true;
  let url: URL;
  try {
    url = new URL(rawHref);
  } catch {
    return false;
  }
  return ALLOWED_SCHEMES.has(url.protocol);
}
