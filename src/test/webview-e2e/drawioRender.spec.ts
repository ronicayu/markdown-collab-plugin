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

// The live (Milkdown) editor only promotes a paragraph to the diagram widget
// for link syntax today (`![](x.drawio)` isn't recognized there yet — a
// separate, tracked gap, not this bug); a bare link alone in its own
// paragraph is what actually reaches the same shared `renderDrawioToSvg`.
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
