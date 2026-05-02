// Shared seed-text encoding for the `?init=...` query param.
//
// The webview cannot just call `btoa(text)` because btoa only accepts
// Latin-1 — anything with a non-ASCII codepoint throws. We UTF-8 encode
// first, then map each byte to a Latin-1 char, then btoa that. The server
// reverses with Buffer.from(b64, 'base64').toString('utf-8').
//
// Node ≥16 ships `btoa`, `atob`, and `TextEncoder` as globals, so this
// module runs unchanged in both the webview bundle and Node tests.

export function encodeSeedText(text: string): string {
  const utf8 = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < utf8.byteLength; i++) {
    binary += String.fromCharCode(utf8[i]!);
  }
  return btoa(binary);
}

export function decodeSeedText(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
