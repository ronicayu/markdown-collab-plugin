// Source-offset-aware markdown renderer.
//
// Installs a markdown-it core rule that walks the token stream and tags
// every leaf text/code token with `meta.mcStart`/`meta.mcEnd` (byte
// offsets into the rendered source). Custom renderer rules then wrap
// the rendered HTML in `<span data-mc-src="START.END">…</span>` so the
// webview can read source positions directly from the DOM rather than
// re-searching for matching text.
//
// This is what makes highlighting + selection-to-source mapping work
// reliably inside tables, code blocks, entity-containing text, and any
// nesting markdown-it produces — we don't depend on whitespace-collapse
// heuristics at all.

import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";

// markdown-it's "Token.meta" field is typed as `any`. Tag it with our keys.
interface TokenMeta {
  mcStart?: number;
  mcEnd?: number;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeAttr = (s: string): string => escapeHtml(s).replace(/'/g, "&#39;");

function wrap(start: number | undefined, end: number | undefined, inner: string): string {
  if (start == null || end == null) return inner;
  return `<span data-mc-src="${start}.${end}">${inner}</span>`;
}

export function installSourceOffsetPlugin(md: MarkdownIt): void {
  md.core.ruler.push("mc-source-offsets", (state) => {
    const source: string = state.src;
    const lineStarts = computeLineStarts(source);
    annotateTokenStream(state.tokens, source, lineStarts);
  });

  const originalText: RenderRule = md.renderer.rules.text ?? ((tokens, idx) => escapeHtml(tokens[idx].content));
  md.renderer.rules.text = (tokens, idx, options, env, slf) => {
    const tok = tokens[idx];
    const meta = tok.meta as TokenMeta | null;
    const inner = originalText(tokens, idx, options, env, slf);
    return wrap(meta?.mcStart, meta?.mcEnd, inner);
  };

  const originalCodeInline: RenderRule = md.renderer.rules.code_inline ??
    ((tokens, idx) => `<code>${escapeHtml(tokens[idx].content)}</code>`);
  md.renderer.rules.code_inline = (tokens, idx, options, env, slf) => {
    const tok = tokens[idx];
    const meta = tok.meta as TokenMeta | null;
    const inner = originalCodeInline(tokens, idx, options, env, slf);
    return wrap(meta?.mcStart, meta?.mcEnd, inner);
  };

  md.renderer.rules.fence = (tokens, idx) => {
    const tok = tokens[idx];
    const meta = tok.meta as TokenMeta | null;
    const lang = tok.info ? tok.info.trim().split(/\s+/)[0] : "";
    // Mermaid: emit a <pre class="mermaid"> with the raw source as text;
    // the page-level mermaid runtime renders it into an SVG in place.
    if (lang === "mermaid") {
      const inner = wrap(meta?.mcStart, meta?.mcEnd, escapeHtml(tok.content));
      return `<pre class="mermaid">${inner}</pre>\n`;
    }
    const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : "";
    const code = escapeHtml(tok.content);
    return `<pre><code${langAttr}>${wrap(meta?.mcStart, meta?.mcEnd, code)}</code></pre>\n`;
  };

  md.renderer.rules.code_block = (tokens, idx) => {
    const tok = tokens[idx];
    const meta = tok.meta as TokenMeta | null;
    const code = escapeHtml(tok.content);
    return `<pre><code>${wrap(meta?.mcStart, meta?.mcEnd, code)}</code></pre>\n`;
  };
}

function computeLineStarts(source: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") out.push(i + 1);
  }
  out.push(source.length);
  return out;
}

function rangeForMap(map: [number, number] | null, lineStarts: number[]): { start: number; end: number } | null {
  if (!map) return null;
  const start = lineStarts[map[0]] ?? 0;
  // map[1] is exclusive — points at the line AFTER the block's last line.
  const end = lineStarts[map[1]] ?? lineStarts[lineStarts.length - 1];
  return { start, end };
}

/**
 * Walk the flat block token stream. Maintain a stack of enclosing
 * block ranges so children without their own `.map` (notably the
 * `inline` tokens inside table cells) inherit the parent block's
 * source range — without that, table-cell text never gets annotated.
 *
 * The `inline` token's inline-token search uses a cursor scoped to the
 * inherited block range, which is wider than the cell's actual source
 * span — but each cell's content appears once in the table row, so the
 * forward-only indexOf cursor still pins each cell text to the right
 * source offsets without confusing them with sibling cells.
 */
function annotateTokenStream(tokens: Token[], source: string, lineStarts: number[]): void {
  const stack: Array<{ start: number; end: number; cursor: number }> = [];
  for (const tok of tokens) {
    const own = rangeForMap(tok.map, lineStarts);
    if (own) {
      // Pop any siblings off the stack that ended before us; push this
      // range onto the stack with a cursor that starts at its beginning.
      while (stack.length > 0 && stack[stack.length - 1].end <= own.start) stack.pop();
      stack.push({ start: own.start, end: own.end, cursor: own.start });
    }
    const enclosing = stack[stack.length - 1];
    if (!enclosing) continue;

    if (tok.type === "inline" && tok.children) {
      const advanced = annotateInline(tok.children, source, enclosing.cursor, enclosing.end);
      enclosing.cursor = advanced;
    } else if (tok.type === "fence" || tok.type === "code_block") {
      const advanced = annotateCodeBlock(tok, source, enclosing.cursor, enclosing.end);
      enclosing.cursor = advanced ?? enclosing.cursor;
    }
  }
}

function annotateInline(children: Token[], source: string, blockStart: number, blockEnd: number): number {
  let cursor = blockStart;
  for (const child of children) {
    if (child.type === "text" || child.type === "code_inline") {
      const content = child.content;
      if (!content) continue;
      // Search forward from cursor for the literal content. Markdown-it
      // already resolved escapes/entities into the decoded form, so this
      // is approximate when the source uses entity refs ('&amp;' → '&'),
      // backslash escapes, or autolinks. In those cases we leave the
      // token un-annotated and the webview falls back to "no precise
      // highlight" for that span — better than a wrong one.
      let idx = source.indexOf(content, cursor);
      if (idx === -1 || idx >= blockEnd) {
        // Fenced inline code adds backtick delimiters in source but the
        // token content excludes them. Try advancing past a likely
        // delimiter.
        if (child.type === "code_inline") {
          const back = source.indexOf("`", cursor);
          if (back !== -1 && back < blockEnd) {
            idx = source.indexOf(content, back + 1);
          }
        }
      }
      if (idx === -1 || idx + content.length > blockEnd) {
        cursor = Math.min(cursor + Math.max(content.length, 1), blockEnd);
        continue;
      }
      child.meta = { ...(child.meta ?? {}), mcStart: idx, mcEnd: idx + content.length } as TokenMeta;
      cursor = idx + content.length;
    } else if (child.type === "softbreak" || child.type === "hardbreak") {
      const nl = source.indexOf("\n", cursor);
      if (nl !== -1 && nl < blockEnd) cursor = nl + 1;
    } else if (child.type === "html_inline") {
      // Skip over the raw HTML in source.
      const idx = source.indexOf(child.content, cursor);
      if (idx !== -1 && idx + child.content.length <= blockEnd) {
        cursor = idx + child.content.length;
      }
    } else if (child.type === "image" || child.type === "link_open" || child.type === "link_close") {
      // Don't try to map these — they have non-trivial source forms
      // ([txt](url)) that don't appear as `.content` substrings.
    }
  }
  return cursor;
}

function annotateCodeBlock(tok: Token, source: string, blockStart: number, blockEnd: number): number | null {
  // For a fenced block, `tok.content` is the inner code (no fence lines,
  // no trailing newline of the inner block). Find it within the source
  // range and tag.
  const content = tok.content;
  if (!content) return null;
  const idx = source.indexOf(content, blockStart);
  if (idx === -1 || idx + content.length > blockEnd) return null;
  tok.meta = { ...(tok.meta ?? {}), mcStart: idx, mcEnd: idx + content.length } as TokenMeta;
  return idx + content.length;
}
