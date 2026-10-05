// Draw.io diagrams in the inline (review) webview.
//
// `.drawio` files aren't a browser image format, so `![alt](x.drawio)` renders
// a placeholder (`.mc-drawio`) that asks the host for the file's XML and hands
// it to the shared `renderDrawioToSvg` (`src/webview/drawioRenderer.ts`) to
// turn into an inline `<svg>`. That renderer calls into mxgraph's own factory
// function, which both shipped bundles' strict-mode wrapping breaks (see
// drawioRenderer.ts's `loadMx`) — this pins the fix by driving the real
// shipped bundle end to end, the same way htmlImage.spec.ts pins the live
// editor's raw-HTML image handling.

import { expect, test } from "@playwright/test";
import pako from "pako";
import { awaitPosted, bootInlineView, bootLiveEditor, pushToWebview } from "./harness";
import { inlineInit, liveInit } from "./fixtures";

// A minimal, uncompressed drawio file: `decodeDrawioFile` (drawioDecoder.ts)
// accepts a `<diagram>` whose text content is already `<mxGraphModel>` XML, no
// base64/deflate needed. One rectangle is enough to make mxgraph emit an SVG.
const MXFILE = [
  "<mxfile>",
  '<diagram id="d1" name="Page-1">',
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">',
  "<root>",
  '<mxCell id="0" />',
  '<mxCell id="1" parent="0" />',
  '<mxCell id="2" value="Node" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">',
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry" />',
  "</mxCell>",
  "</root>",
  "</mxGraphModel>",
  "</diagram>",
  "</mxfile>",
].join("");

const SOURCE = "# Doc\n\n![Diagram](diagram.drawio)\n";

test("a drawio image placeholder resolves to an inline <svg>", async ({ page }) => {
  await bootInlineView(page, inlineInit(SOURCE));

  const placeholder = page.locator(".mc-drawio");
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder.locator("svg")).toHaveCount(0);

  const req = await awaitPosted(page, "drawio-read");
  await pushToWebview(page, {
    type: "drawio-read-result",
    requestId: req.requestId,
    href: req.href,
    ok: true,
    content: MXFILE,
  });

  await expect(placeholder.locator("svg")).toHaveCount(1);
  await expect(placeholder).toHaveClass(/ready/);
});

// The live (Milkdown) editor promotes a paragraph to the diagram widget for
// both diagram syntaxes: a bare link alone in its own paragraph
// (`[text](x.drawio)`) and an image alone in its own paragraph
// (`![alt](x.drawio)`) — both reach the same shared `renderDrawioToSvg`.
const LIVE_SOURCE = "# Doc\n\n[Diagram](diagram.drawio)\n";

test("the live editor's link-syntax diagram also resolves to an inline <svg>", async ({ page }) => {
  await bootLiveEditor(page, liveInit(LIVE_SOURCE));

  // The widget requests the file's XML the moment it mounts, during the same
  // tick `bootLiveEditor` waits out before its own `clearPosted` — so the
  // request itself is gone from the posted log by the time we get here.
  // `handleDrawioReadResult` keys its cache lookup by `href`, not `requestId`
  // (client.ts:1552-1554), so the reply doesn't need the original id.
  const placeholder = page.locator(".mdc-drawio");
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toContainText("Loading diagram");

  await pushToWebview(page, {
    type: "drawio-read-result",
    requestId: "drawio-1",
    href: "diagram.drawio",
    ok: true,
    content: MXFILE,
  });

  await expect(placeholder.locator("svg")).toHaveCount(1);
});

// `![alt](x.drawio)` still parses to a real `image` node (unlike the link
// form, which is just marked-up text), so the image nodeView would otherwise
// render a broken <img> for a non-image src alongside the diagram widget —
// that image is hidden (`.mdc-drawio-image-hidden`) once the paragraph
// promotes to the widget.
test("the live editor's image-syntax diagram (![alt](x.drawio)) also resolves to an inline <svg>", async ({
  page,
}) => {
  await bootLiveEditor(page, liveInit(SOURCE));

  const placeholder = page.locator(".mdc-drawio");
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toContainText("Loading diagram");
  await expect(page.locator("img.mdc-image")).toBeHidden();

  await pushToWebview(page, {
    type: "drawio-read-result",
    requestId: "drawio-1",
    href: "diagram.drawio",
    ok: true,
    content: MXFILE,
  });

  await expect(placeholder.locator("svg")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Security review: mxgraph's npm build never attaches its classes to
// `window`, so `mxCodec.prototype.decode`'s `window[node.nodeName]` lookup
// found nothing and every model decoded to zero cells — the two tests above
// only ever checked `<svg>` exists, which an empty-viewport SVG still
// satisfies. The naive fix (`Object.assign(window, mx)`) plus HTML labels
// would also open a script-injection hole (see drawioRenderer.ts's
// `hardenMx`). These fixtures pin both: a realistic multi-cell diagram
// actually decodes and renders its shapes/labels, and a malicious one can't
// run script or leak a request through it.
// ---------------------------------------------------------------------------

// Two labelled boxes and a labelled edge — enough to exercise mxCell,
// mxGeometry and mxPoint/Array (the edge's source point + waypoint), all of
// which route through mxCodec.prototype.decode's generic (and, before the
// fix, always-failing) node-name lookup.
const REALISTIC_MODEL_XML = [
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">',
  "<root>",
  '<mxCell id="0" />',
  '<mxCell id="1" parent="0" />',
  '<mxCell id="2" value="Box A" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">',
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry" />',
  "</mxCell>",
  '<mxCell id="3" value="Box B" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">',
  '<mxGeometry x="240" y="40" width="120" height="60" as="geometry" />',
  "</mxCell>",
  '<mxCell id="4" value="Edge Label" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="2" target="3">',
  '<mxGeometry relative="1" as="geometry">',
  '<mxPoint x="160" y="70" as="sourcePoint" />',
  '<Array as="points"><mxPoint x="200" y="20" /></Array>',
  "</mxGeometry>",
  "</mxCell>",
  "</root>",
  "</mxGraphModel>",
].join("");

function wrapMxfile(diagramBody: string): string {
  return `<mxfile><diagram id="d1" name="Page-1">${diagramBody}</diagram></mxfile>`;
}

/** The reverse of `decodeDrawioFile`'s `decompressDiagram` (drawioDecoder.ts):
 * uri-encode, UTF-8 encode, raw-deflate, base64. */
function compressDiagram(xml: string): string {
  const uriEncoded = encodeURIComponent(xml);
  const deflated = pako.deflateRaw(new TextEncoder().encode(uriEncoded));
  return Buffer.from(deflated).toString("base64");
}

const REALISTIC_UNCOMPRESSED = wrapMxfile(REALISTIC_MODEL_XML);
const REALISTIC_COMPRESSED = wrapMxfile(compressDiagram(REALISTIC_MODEL_XML));

const REALISTIC_FIXTURES = [
  ["uncompressed", REALISTIC_UNCOMPRESSED],
  ["compressed", REALISTIC_COMPRESSED],
] as const;

for (const [label, xml] of REALISTIC_FIXTURES) {
  test(`a realistic diagram (${label}) decodes real cells and shows its labels — classic view`, async ({ page }) => {
    await bootInlineView(page, inlineInit(SOURCE));
    const placeholder = page.locator(".mc-drawio");
    const req = await awaitPosted(page, "drawio-read");
    await pushToWebview(page, {
      type: "drawio-read-result",
      requestId: req.requestId,
      href: req.href,
      ok: true,
      content: xml,
    });

    const svg = placeholder.locator("svg");
    await expect(svg).toHaveCount(1);
    // Each vertex/edge mxgraph actually draws is its own shape element; an
    // unpatched decode (zero cells) leaves only the SVG's own empty wrapper
    // <g>s, so this is >0 only once real cells came through.
    await expect(async () => {
      expect(await svg.locator("rect, path").count()).toBeGreaterThan(0);
    }).toPass();
    await expect(svg).toContainText("Box A");
    await expect(svg).toContainText("Box B");
    await expect(svg).toContainText("Edge Label");
  });

  test(`a realistic diagram (${label}) decodes real cells and shows its labels — live editor`, async ({ page }) => {
    await bootLiveEditor(page, liveInit(LIVE_SOURCE));
    const placeholder = page.locator(".mdc-drawio");
    await expect(placeholder).toContainText("Loading diagram");
    await pushToWebview(page, {
      type: "drawio-read-result",
      requestId: "drawio-1",
      href: "diagram.drawio",
      ok: true,
      content: xml,
    });

    const svg = placeholder.locator("svg");
    await expect(svg).toHaveCount(1);
    await expect(async () => {
      expect(await svg.locator("rect, path").count()).toBeGreaterThan(0);
    }).toPass();
    await expect(svg).toContainText("Box A");
    await expect(svg).toContainText("Box B");
    await expect(svg).toContainText("Edge Label");
  });
}

// A style="html=1" label carrying a raw <img onerror=...> tag, plus an
// mxStylesheet eval payload smuggled in under a cell via a bogus `as`
// attribute — nothing about mxCodec's generic decodeChild requires a child
// element's tag name to match what the parent "expects", so a malicious
// document can route any tag through the same lookup a legitimate
// <mxGeometry>/<mxPoint> would use.
const MALICIOUS_MODEL_XML = [
  "<mxGraphModel>",
  "<root>",
  '<mxCell id="0" />',
  '<mxCell id="1" parent="0" />',
  '<mxCell id="2" value="&lt;img src=https://example.invalid/x onerror=window.__mcDrawioImgPwned=1&gt;" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">',
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry" />',
  '<mxStylesheet as="evil"><add as="x"><add as="k">window.__mcDrawioEvalPwned=1</add></add></mxStylesheet>',
  "</mxCell>",
  "</root>",
  "</mxGraphModel>",
].join("");
const MALICIOUS_XML = wrapMxfile(MALICIOUS_MODEL_XML);

test("a malicious diagram (HTML-label onerror + mxStylesheet eval payload) runs no script and leaks no request", async ({
  page,
}) => {
  await bootInlineView(page, inlineInit(SOURCE));
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));

  const placeholder = page.locator(".mc-drawio");
  const req = await awaitPosted(page, "drawio-read");
  await pushToWebview(page, {
    type: "drawio-read-result",
    requestId: req.requestId,
    href: req.href,
    ok: true,
    content: MALICIOUS_XML,
  });

  const svg = placeholder.locator("svg");
  await expect(svg).toHaveCount(1);
  // Give the (should-never-fire) onerror handler a beat to fire if it were
  // going to — there's no image element for it to attach to, so nothing to
  // await; this just guards against a race where the assertion below runs
  // before a real script injection would have had a chance to execute.
  await page.waitForTimeout(200);

  expect(
    await page.evaluate(() => (window as unknown as { __mcDrawioImgPwned?: unknown }).__mcDrawioImgPwned),
  ).toBeUndefined();
  expect(
    await page.evaluate(() => (window as unknown as { __mcDrawioEvalPwned?: unknown }).__mcDrawioEvalPwned),
  ).toBeUndefined();
  expect(requests.some((u) => u.includes("example.invalid"))).toBe(false);

  // No real <img> was ever created — setHtmlLabels(false) means the label
  // rendered as an inert SVG <text>, tags and all, not parsed markup.
  await expect(svg.locator("img")).toHaveCount(0);
  await expect(svg).toContainText("img src=");
});
