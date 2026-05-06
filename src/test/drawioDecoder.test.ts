// Tests for the drawio file XML decoder. The decoder must accept all
// three on-disk shapes drawio produces:
//
//   1. Bare `<mxGraphModel>` (legacy older exports)
//   2. `<mxfile><diagram>...mxGraphModel xml...</diagram></mxfile>`
//      (uncompressed multi-page format)
//   3. `<mxfile><diagram>BASE64</diagram></mxfile>` where the inner
//      payload is base64( deflateRaw( encodeURIComponent( xml ) ) ).
//
// We synthesise a known-good compressed payload here using pako so the
// test doesn't depend on having a real drawio file on disk.

import { describe, expect, it } from "vitest";
import pako from "pako";
import { decodeDrawioFile } from "../collab/drawioDecoder";

const SAMPLE_MODEL_XML = `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="2" value="Hello" style="rounded=0;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="120" height="40" as="geometry" />
    </mxCell>
  </root>
</mxGraphModel>`;

function makeCompressedDiagramPayload(modelXml: string): string {
  const uri = encodeURIComponent(modelXml);
  const bytes = new TextEncoder().encode(uri);
  const deflated = pako.deflateRaw(bytes);
  // Encode without depending on Buffer in webview env — but tests run in
  // Node so Buffer is fine here.
  return Buffer.from(deflated).toString("base64");
}

describe("decodeDrawioFile", () => {
  it("returns the inner XML unchanged for a bare <mxGraphModel> document", () => {
    const r = decodeDrawioFile(SAMPLE_MODEL_XML);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mxGraphModelXml).toContain("<mxCell");
  });

  it("returns the inner XML unchanged with an XML declaration", () => {
    const r = decodeDrawioFile(`<?xml version="1.0" encoding="UTF-8"?>\n${SAMPLE_MODEL_XML}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mxGraphModelXml).toContain("<mxGraphModel");
  });

  it("extracts an uncompressed <mxfile><diagram> body", () => {
    const file = `<mxfile host="app.diagrams.net" modified="2026-01-01T00:00:00.000Z" agent="test" version="22.0.0">
  <diagram id="abc" name="Page-1">${SAMPLE_MODEL_XML}</diagram>
</mxfile>`;
    const r = decodeDrawioFile(file);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mxGraphModelXml).toContain("<mxGraphModel");
      expect(r.mxGraphModelXml).toContain("Hello");
    }
  });

  it("decompresses a compressed <mxfile><diagram> body", () => {
    const compressed = makeCompressedDiagramPayload(SAMPLE_MODEL_XML);
    const file = `<mxfile><diagram id="x" name="Page-1">${compressed}</diagram></mxfile>`;
    const r = decodeDrawioFile(file);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mxGraphModelXml).toContain("<mxGraphModel");
      expect(r.mxGraphModelXml).toContain("Hello");
    }
  });

  it("handles a compressed payload that has internal whitespace from a pretty-printer", () => {
    const compressed = makeCompressedDiagramPayload(SAMPLE_MODEL_XML);
    // Insert newlines + indentation as a generator might.
    const formatted = compressed.replace(/(.{60})/g, "$1\n      ");
    const file = `<mxfile>
  <diagram id="x" name="Page-1">
      ${formatted}
  </diagram>
</mxfile>`;
    const r = decodeDrawioFile(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mxGraphModelXml).toContain("<mxGraphModel");
  });

  it("only decodes the FIRST diagram in a multi-page file", () => {
    const compressed = makeCompressedDiagramPayload(SAMPLE_MODEL_XML);
    const file = `<mxfile>
  <diagram id="a" name="First">${compressed}</diagram>
  <diagram id="b" name="Second">${compressed}</diagram>
</mxfile>`;
    const r = decodeDrawioFile(file);
    expect(r.ok).toBe(true);
  });

  it("rejects an empty input", () => {
    expect(decodeDrawioFile("")).toEqual({ ok: false, reason: "empty" });
    expect(decodeDrawioFile("   \n  ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects XML that isn't an mxfile or mxGraphModel", () => {
    const r = decodeDrawioFile("<svg><circle/></svg>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-mxfile");
  });

  it("rejects an mxfile with an empty <diagram> element", () => {
    const r = decodeDrawioFile("<mxfile><diagram></diagram></mxfile>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-diagram");
  });

  it("returns decode-failed for a base64 payload that isn't deflated XML", () => {
    const garbage = Buffer.from("not really compressed").toString("base64");
    const file = `<mxfile><diagram id="x">${garbage}</diagram></mxfile>`;
    const r = decodeDrawioFile(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("decode-failed");
  });
});
