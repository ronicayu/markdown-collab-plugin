// Render a decoded drawio mxGraphModel XML string into an inline SVG
// element. We rely on mxgraph's browser-mode rendering: build an
// offscreen container, instantiate mxGraph against it, decode the
// model, then lift the resulting SVG out for re-attachment in the
// webview's editor view.
//
// mxgraph is loaded lazily so that webviews that never see a drawio
// link don't pay the ~3MB JS evaluation cost on every open. The
// loader caches the resolved factory so repeated diagrams share one
// initialization.

import { decodeDrawioFile } from "../collab/drawioDecoder";

interface MxFactory {
  mxGraph: new (container: HTMLElement) => MxGraphInstance;
  mxCodec: new (doc: XMLDocument) => { decode(node: Element, into: unknown): void };
  mxUtils: { parseXml(xml: string): XMLDocument };
  mxRectangle: new (x: number, y: number, w: number, h: number) => MxRectangleInstance;
}

/**
 * The subset of mxgraph's internals `hardenMx` reaches into — implementation
 * details of its codec system, not part of the small rendering API above.
 * Every property here is a real own-property of the object the npm
 * `mxgraph` factory returns (verified against `node_modules/mxgraph`'s
 * `__mxOutput.<Name> = ...` assignments); none of it is `window`.
 */
interface MxInternals {
  mxCodec: { prototype: { decode(node: Element, into?: unknown): unknown; updateElements(): void } };
  mxCodecRegistry: {
    getCodec(ctor: unknown): { decode(dec: unknown, node: Element, into?: unknown): unknown } | null;
  };
  mxConstants: { NODETYPE_ELEMENT: number };
  // `allowEval` switches found by grepping node_modules/mxgraph for
  // "allowEval" — see hardenMx's doc comment for which default to true.
  mxObjectCodec: { allowEval: boolean };
  mxStylesheetCodec: { allowEval: boolean };
  mxDefaultToolbarCodec: { allowEval: boolean };
  mxStencil: { allowEval: boolean };
  mxGraphView: { prototype: { allowEval: boolean } };
  // The handful of classes a plain `<mxGraphModel>` diagram's decode can
  // actually reach (see hardenMx's doc comment for how each is reached).
  mxGraphModel: unknown;
  mxCell: unknown;
  mxGeometry: unknown;
  mxPoint: unknown;
}

interface MxRectangleInstance {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MxGraphInstance {
  container: HTMLElement;
  setEnabled(enabled: boolean): void;
  setHtmlLabels(html: boolean): void;
  setPanning(pan: boolean): void;
  getModel(): unknown;
  getGraphBounds(): MxRectangleInstance;
  view: {
    setScale(scale: number): void;
    setTranslate(x: number, y: number): void;
  };
  refresh(): void;
}

let mxPromise: Promise<MxFactory> | null = null;

function loadMx(): Promise<MxFactory> {
  if (!mxPromise) {
    mxPromise = (async () => {
      // Hoist the few globals mxgraph reads at evaluation time. Without
      // these its bootstrap tries to load resource bundles + stylesheets
      // from a relative path that doesn't exist inside the webview's
      // sandbox, which surfaces as a noisy 404 in devtools but is
      // harmless for our render-only use.
      //
      // mxForceIncludes and mxResourceExtension aren't ones we care about the
      // value of, but they still have to be set: mxClient's bootstrap (see the
      // `.call(globalThis, …)` comment below) does
      // `if (typeof(mxForceIncludes) == 'undefined') { mxForceIncludes = false; }`
      // for both — a bare assignment to an undeclared identifier, which is an
      // implicit global everywhere else but a thrown ReferenceError under
      // strict mode. Pre-setting them as real global properties makes the
      // `typeof` check see them as already defined, so that assignment branch
      // never runs.
      const globals = globalThis as unknown as Record<string, unknown>;
      if (globals.mxBasePath === undefined) globals.mxBasePath = "";
      if (globals.mxLoadResources === undefined) globals.mxLoadResources = false;
      if (globals.mxLoadStylesheets === undefined) globals.mxLoadStylesheets = false;
      if (globals.mxImageBasePath === undefined) globals.mxImageBasePath = "";
      if (globals.mxForceIncludes === undefined) globals.mxForceIncludes = false;
      if (globals.mxResourceExtension === undefined) globals.mxResourceExtension = ".txt";
      const mod = await import("mxgraph");
      const factoryFn = (mod as { default?: unknown }).default ?? mod;
      const fn = factoryFn as unknown as (opts: Record<string, unknown>) => MxFactory;
      // mxgraph's factory (javascript/dist/build.js) is `function (opts) { for
      // (var name in opts) { this[name] = opts[name]; } ... }` — written to be
      // called as a bare sloppy-mode function so `this` defaults to the global
      // object, hoisting mxBasePath etc. onto it for the bare identifier reads
      // later in the same function. The shipped bundles are strict mode
      // ("use strict"), so a bare `fn(...)` call leaves `this` as `undefined`
      // and the very first assignment throws. `.call(globalThis, ...)` gives
      // it back the receiver it expects.
      const mx = fn.call(globalThis, {
        mxBasePath: "",
        mxLoadResources: false,
        mxLoadStylesheets: false,
        mxImageBasePath: "",
        mxForceIncludes: false,
        mxResourceExtension: ".txt",
      });
      hardenMx(mx);
      return mx;
    })();
  }
  return mxPromise;
}

/**
 * Lock down mxgraph's decoder before it ever sees untrusted `.drawio` XML
 * (security review — draw.io rendered nothing, and the obvious fix opened a
 * script-injection hole). Two independent layers, in order:
 *
 * 1. Every `allowEval` switch mxgraph 4.2.2 ships turned on by default —
 *    `mxStylesheetCodec` and `mxDefaultToolbarCodec`, the only two found by
 *    grepping `node_modules/mxgraph` for `allowEval` — is forced off, along
 *    with the ones already `false` by default (`mxObjectCodec`, `mxStencil`,
 *    `mxGraphView`), so a future mxgraph upgrade that flips a default
 *    doesn't silently reopen this. Belt: even if layer 2 below were somehow
 *    bypassed and a malicious node resolved to one of these codecs, its
 *    `<add>`/style-expression text would still just be a string, never
 *    `mxUtils.eval`'d.
 *
 * 2. `mxCodec.prototype.decode` resolves an XML node's constructor via
 *    `window[node.nodeName]` — which this npm build never populates (see
 *    `loadMx`'s doc comment), so an unpatched decode treats every node as
 *    unrecognized, clones it as inert XML instead of building a real
 *    object, and a diagram renders with zero cells. The obvious fix,
 *    `Object.assign(window, mx)`, makes every one of mxgraph's ~140 classes
 *    resolve this way — including `window.mxStylesheet`. Nothing requires a
 *    child node's name to be `mxCell`/`mxGeometry`: `mxObjectCodec`'s
 *    generic `decodeChild` decodes whatever tag is actually there, so a
 *    crafted `<mxCell><mxStylesheet><add as="x"><add as="k">JS</add></add>
 *    </mxStylesheet></mxCell>` would reach `mxStylesheetCodec` regardless of
 *    layer 1 — belt-and-suspenders is what layer 1 *is*, not a substitute
 *    for not exposing that codec's trigger in the first place. Rather than
 *    touching `window` at all, `decode` is replaced with a version that
 *    resolves a node's constructor against a small fixed allowlist instead:
 *    `mxGraphModel` (the decode entry point), `mxCell` (defensive — in
 *    practice `mxGraphModelCodec.decodeRoot`/`mxCodec.decodeCell` already
 *    resolve cells by node-name string, not through this path, but nothing
 *    stops a malformed document from routing one through here), `mxGeometry`
 *    and `mxPoint` (a cell's geometry and an edge's source/target points —
 *    both decoded via this generic path, confirmed by reading
 *    `mxObjectCodec.prototype.decodeChild` in `node_modules/mxgraph`), and
 *    the native `Array` (an edge's waypoint list, `<Array as="points">`,
 *    same path — the real global, not one of mxgraph's own classes, so
 *    nothing attacker-controlled reaches it). A node named anything else —
 *    `mxStylesheet` included — decodes as an inert clone, the exact fallback
 *    the original function already used for a name it didn't recognize.
 */
function hardenMx(mx: MxFactory): void {
  const internals = mx as unknown as MxInternals;
  internals.mxObjectCodec.allowEval = false;
  internals.mxStylesheetCodec.allowEval = false;
  internals.mxDefaultToolbarCodec.allowEval = false;
  internals.mxStencil.allowEval = false;
  internals.mxGraphView.prototype.allowEval = false;

  const allowedNodeNames: Record<string, unknown> = {
    mxGraphModel: internals.mxGraphModel,
    mxCell: internals.mxCell,
    mxGeometry: internals.mxGeometry,
    mxPoint: internals.mxPoint,
    Array,
  };
  const registry = internals.mxCodecRegistry;
  const elementNodeType = internals.mxConstants.NODETYPE_ELEMENT;
  const proto = internals.mxCodec.prototype;
  proto.decode = function (this: { updateElements(): void }, node: Element, into?: unknown): unknown {
    this.updateElements();
    if (node == null || node.nodeType !== elementNodeType) return null;
    const ctor = allowedNodeNames[node.nodeName];
    const dec = ctor != null ? registry.getCodec(ctor) : null;
    if (dec != null) return dec.decode(this, node, into);
    const clone = node.cloneNode(true) as Element;
    clone.removeAttribute("as");
    return clone;
  };
}

export interface RenderOk {
  ok: true;
  svg: SVGSVGElement;
}

export interface RenderErr {
  ok: false;
  message: string;
}

export type RenderResult = RenderOk | RenderErr;

export async function renderDrawioToSvg(rawXml: string): Promise<RenderResult> {
  const decoded = decodeDrawioFile(rawXml);
  if (!decoded.ok) {
    return { ok: false, message: drawioDecodeMessage(decoded) };
  }
  let mx: MxFactory;
  try {
    mx = await loadMx();
  } catch (e) {
    return { ok: false, message: `Failed to load drawio renderer: ${(e as Error).message}` };
  }
  let xmlDoc: XMLDocument;
  try {
    xmlDoc = mx.mxUtils.parseXml(decoded.mxGraphModelXml);
  } catch (e) {
    return { ok: false, message: `mxGraph XML parse failed: ${(e as Error).message}` };
  }

  // mxgraph's renderer requires the container to be in the DOM so it
  // can compute layout. We park it offscreen at a fixed pixel size that
  // is comfortably larger than typical diagrams; the SVG we lift out
  // carries an explicit viewBox so its rendered size is independent of
  // this scratch container.
  const scratch = document.createElement("div");
  scratch.style.cssText = [
    "position: absolute",
    "left: -100000px",
    "top: -100000px",
    "width: 4000px",
    "height: 4000px",
    "overflow: hidden",
    "visibility: hidden",
    "pointer-events: none",
  ].join(";");
  document.body.appendChild(scratch);

  let svgClone: SVGSVGElement;
  try {
    const graph = new mx.mxGraph(scratch);
    graph.setEnabled(false);
    // Plain-text labels only (security review): `mxGraph.isHtmlLabel` just
    // returns this flag for every cell regardless of the cell's own
    // `html=1` style, so `false` here blocks HTML labels graph-wide rather
    // than per-cell. A crafted label like `<img src=x onerror=...>` renders
    // as the literal text of the tag, not a parsed, script-running element.
    graph.setHtmlLabels(false);
    graph.setPanning(false);

    const codec = new mx.mxCodec(xmlDoc);
    codec.decode(xmlDoc.documentElement, graph.getModel());
    graph.refresh();

    const liveSvg = scratch.querySelector("svg");
    if (!liveSvg) {
      return { ok: false, message: "mxGraph did not produce an SVG element." };
    }
    svgClone = liveSvg.cloneNode(true) as SVGSVGElement;

    // Tighten the SVG to the actual diagram bounds. mxgraph's default
    // SVG fills the scratch container; without this clamp the inline
    // rendering carries a 4000×4000 viewport.
    const bounds = graph.getGraphBounds();
    const margin = 8;
    const w = Math.max(1, Math.ceil(bounds.width + 2 * margin));
    const h = Math.max(1, Math.ceil(bounds.height + 2 * margin));
    const vbX = bounds.x - margin;
    const vbY = bounds.y - margin;
    svgClone.setAttribute("width", String(w));
    svgClone.setAttribute("height", String(h));
    svgClone.setAttribute("viewBox", `${vbX} ${vbY} ${w} ${h}`);
    svgClone.style.maxWidth = "100%";
    svgClone.style.height = "auto";
    svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  } finally {
    scratch.remove();
  }

  return { ok: true, svg: svgClone };
}

function drawioDecodeMessage(
  res: Exclude<ReturnType<typeof decodeDrawioFile>, { ok: true }>,
): string {
  switch (res.reason) {
    case "empty":
      return "Drawio file is empty.";
    case "not-mxfile":
      return res.detail ?? "Drawio file is not a valid mxfile.";
    case "no-diagram":
      return res.detail ?? "Drawio file has no <diagram> element.";
    case "decode-failed":
      return res.detail ?? "Could not decode the diagram payload.";
  }
}
