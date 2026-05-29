/**
 * Shared markdown-it plugin that turns ```plantuml / ```puml fenced
 * blocks into `<img>` tags pointing at a PlantUML server.
 *
 * Encoding is the simple `~h<hex>` path — the source is converted to
 * UTF-8 bytes and emitted as a hex string after `~h`. Avoids a deflate
 * dependency and keeps the module identical in the host process and
 * the bundled webview. Trade-off is longer URLs vs deflate+base64; for
 * realistic diagrams (a few KB of source) we stay well under any
 * server's URL limit.
 *
 * Installed AFTER `installSourceOffsetPlugin` so its fence rule wraps
 * ours — we capture the previously-registered rule and chain to it for
 * non-plantuml fences.
 */

import type MarkdownIt from "markdown-it";

export interface PlantumlOptions {
  /** Base URL of a PlantUML server, no trailing slash. Default: https://www.plantuml.com/plantuml */
  serverUrl?: string;
  /** Image format the server should produce. Default: svg. */
  format?: "svg" | "png";
}

const DEFAULT_SERVER = "https://www.plantuml.com/plantuml";

export function installPlantumlPlugin(md: MarkdownIt, opts: PlantumlOptions = {}): void {
  const server = (opts.serverUrl ?? DEFAULT_SERVER).replace(/\/+$/, "");
  const format = opts.format ?? "svg";
  const prev = md.renderer.rules.fence;

  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const tok = tokens[idx];
    const info = (tok.info ?? "").trim();
    const lang = info.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "plantuml" || lang === "puml") {
      return renderPlantumlFence(tok.content, server, format);
    }
    if (prev) return prev(tokens, idx, options, env, slf);
    // markdown-it's default fence renderer always exists, so this
    // shouldn't be reachable in practice — defensive fallback.
    return "";
  };
}

export function renderPlantumlFence(source: string, server: string, format: "svg" | "png"): string {
  const encoded = encodeAsHex(source.trim());
  const url = `${server.replace(/\/+$/, "")}/${format}/~h${encoded}`;
  // Wrap in <figure> so users can target it for layout overrides; mark
  // with `loading="lazy"` because PlantUML servers can be slow and we
  // don't want the initial paint to block on every diagram.
  return (
    `<figure class="mc-plantuml">` +
    `<img src="${escapeAttr(url)}" alt="PlantUML diagram" loading="lazy">` +
    `</figure>\n`
  );
}

/** UTF-8 bytes → lowercase hex string. */
export function encodeAsHex(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
