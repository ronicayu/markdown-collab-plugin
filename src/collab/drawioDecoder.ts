// Decode a .drawio file's XML payload into the inner mxGraphModel XML
// that mxgraph can render.
//
// drawio supports two on-disk shapes:
//
// 1. Plain — `<mxfile><diagram>...mxGraphModel xml...</diagram></mxfile>`
//    The diagram's text content is the mxGraphModel XML directly.
//
// 2. Compressed — `<mxfile><diagram>BASE64...</diagram></mxfile>`
//    The diagram's text content is base64( deflateRaw( encodeURIComponent(
//    mxGraphModel xml ) ) ). drawio uses raw deflate (no zlib wrapper)
//    plus URI encoding to keep the payload ASCII-clean inside XML.
//
// For multi-page files we just decode the first <diagram>; the inline
// link viewer is single-page by design.
//
// The decoder is split out from the renderer so we can unit-test the
// format handling without pulling in mxgraph's DOM-heavy module.

import pako from "pako";

export type DecodeResult =
  | { ok: true; mxGraphModelXml: string }
  | { ok: false; reason: "empty"; detail?: string }
  | { ok: false; reason: "not-mxfile"; detail?: string }
  | { ok: false; reason: "no-diagram"; detail?: string }
  | { ok: false; reason: "decode-failed"; detail?: string };

export function decodeDrawioFile(rawXml: string): DecodeResult {
  const trimmed = (rawXml ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // The file may already be a bare <mxGraphModel ...> document — that's
  // legitimately what an older drawio export produces. Pass it through
  // unchanged.
  if (/^<\?xml[^>]*\?>\s*<mxGraphModel\b/i.test(trimmed) || /^<mxGraphModel\b/i.test(trimmed)) {
    return { ok: true, mxGraphModelXml: trimmed };
  }

  if (!/<mxfile\b/i.test(trimmed)) {
    return { ok: false, reason: "not-mxfile", detail: "Expected <mxfile> or <mxGraphModel> root." };
  }

  const diagramText = extractFirstDiagramText(trimmed);
  if (diagramText === null) {
    return { ok: false, reason: "no-diagram", detail: "Could not find a <diagram> element with content." };
  }

  // If the diagram body is already mxGraphModel XML, use it as is.
  if (/<mxGraphModel\b/i.test(diagramText)) {
    return { ok: true, mxGraphModelXml: diagramText };
  }

  // Otherwise treat as the compressed shape.
  const decoded = decompressDiagram(diagramText);
  if (!decoded.ok) return decoded;
  if (!/<mxGraphModel\b/i.test(decoded.mxGraphModelXml)) {
    return {
      ok: false,
      reason: "decode-failed",
      detail: "Decompressed payload did not contain <mxGraphModel>.",
    };
  }
  return decoded;
}

// Extracts the text content of the first <diagram> in an mxfile. The
// drawio XML never nests <diagram> inside <diagram>, so a non-greedy
// regex over the trimmed source is safe and avoids pulling in a full
// XML parser at this level.
function extractFirstDiagramText(xml: string): string | null {
  const match = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/i.exec(xml);
  if (!match) return null;
  const body = match[1] ?? "";
  const trimmed = body.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function decompressDiagram(payload: string): DecodeResult {
  // Strip any inner whitespace introduced by pretty-printers — base64
  // is whitespace-insensitive but DOMParser-decoded text content
  // sometimes carries indentation we want to drop.
  const stripped = payload.replace(/\s+/g, "");
  if (stripped.length === 0) {
    return { ok: false, reason: "no-diagram", detail: "Diagram body is empty after whitespace strip." };
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(stripped);
  } catch (e) {
    return {
      ok: false,
      reason: "decode-failed",
      detail: `base64 decode failed: ${(e as Error).message}`,
    };
  }
  let inflated: Uint8Array;
  try {
    inflated = pako.inflateRaw(bytes);
  } catch (e) {
    return {
      ok: false,
      reason: "decode-failed",
      detail: `inflate failed: ${(e as Error).message}`,
    };
  }
  let uriEncoded: string;
  try {
    uriEncoded = new TextDecoder("utf-8").decode(inflated);
  } catch (e) {
    return {
      ok: false,
      reason: "decode-failed",
      detail: `text decode failed: ${(e as Error).message}`,
    };
  }
  let xml: string;
  try {
    xml = decodeURIComponent(uriEncoded);
  } catch (e) {
    return {
      ok: false,
      reason: "decode-failed",
      detail: `uri decode failed: ${(e as Error).message}`,
    };
  }
  return { ok: true, mxGraphModelXml: xml };
}

function base64ToBytes(b64: string): Uint8Array {
  // Use the platform decoder when present (browsers, Node 16+ via
  // globalThis.atob). Fall back to Buffer for older Node test envs.
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback — tests run under Node, so this path is exercised.
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
