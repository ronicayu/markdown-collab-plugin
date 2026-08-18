// The markdown-it pipeline, built once (10x-plan P2.3).
//
// Two of the three review surfaces render with markdown-it: the inline
// comments view and the PR/MR review view. (The live editor is
// Milkdown/ProseMirror and always will be — converging that is not realistic,
// which is why the plan scopes P2.3 to the asset/embed layer.) Those two used
// to construct their renderer with the same options and the same plugins, by
// copy-paste, in two files — which is how the PR view ended up with its own
// stale image resolver while the inline view got the fixed one.
//
// One factory, one place to add an embed type, and a test can render exactly
// what the surfaces render rather than a replica of it.

import MarkdownIt from "markdown-it";
import { installSourceOffsetPlugin } from "../inlineComments/webview/renderWithOffsets";
import { installLineNumberPlugin } from "./lineNumbers";
import { installPlantumlPlugin, type PlantumlOptions } from "../plantumlPlugin";

/** markdown-it options both surfaces use. Kept explicit — these are a contract. */
export const MARKDOWN_OPTIONS = {
  /** No raw HTML: the source is under review and may be untrusted. */
  html: false,
  linkify: true,
  /** Single newlines are not line breaks — CommonMark, matching GitHub. */
  breaks: false,
} as const;

/**
 * Build the renderer. `installSourceOffsetPlugin` must come first: the
 * PlantUML plugin chains to whatever fence rule was registered before it, so
 * installing them the other way round loses mermaid and source offsets on
 * every fence.
 */
export function createMarkdownRenderer(): MarkdownIt {
  const md = new MarkdownIt({ ...MARKDOWN_OPTIONS });
  installSourceOffsetPlugin(md);
  // After the offset plugin: this one only sets an attribute on block tokens,
  // and both surfaces want it available whether or not the user has line
  // numbers switched on (the client decides whether to paint them).
  installLineNumberPlugin(md);
  return md;
}

/**
 * The renderer for *comment bodies* — replies, review findings, suggestion
 * notes — as opposed to the document under review.
 *
 * Separate from `createMarkdownRenderer` on purpose. Comment bodies want none
 * of the document machinery (source offsets, line numbers, diagram fences),
 * and they want two things the document does not:
 *
 * - **Hard line breaks.** A comment is written like a message, and every
 *   comment UI a person has used treats a newline as a newline. CommonMark
 *   would join the lines of a two-line reply into a paragraph.
 * - **No remote images.** A comment body can come from anyone — Claude, a
 *   colleague's commit, another user on a pull request — and rendering
 *   `![](https://…)` would make opening a review fetch a third-party URL,
 *   handing whoever wrote it the reader's IP and a read receipt. GitHub
 *   proxies images for exactly this reason and this extension has no proxy,
 *   so an image renders as a link instead, labelled so nothing looks lost.
 */
export function createCommentRenderer(): MarkdownIt {
  const md = new MarkdownIt({ ...MARKDOWN_OPTIONS, breaks: true });
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const src = token.attrGet("src") ?? "";
    const alt = token.content || src;
    const href = md.utils.escapeHtml(src);
    const label = md.utils.escapeHtml(alt);
    return `<a class="mc-card__image-link" href="${href}" title="Images in comments are shown as links">🖼 ${label}</a>`;
  };
  return md;
}

/**
 * Install the PlantUML fence renderer once per renderer instance. Both
 * surfaces learn the server URL from their host's init message, which arrives
 * after the renderer is built, so this is idempotent and safe to call on
 * every message.
 */
export function ensurePlantuml(md: MarkdownIt, opts: PlantumlOptions | undefined): boolean {
  if (!opts || installed.has(md)) return false;
  installPlantumlPlugin(md, opts);
  installed.add(md);
  return true;
}

const installed = new WeakSet<MarkdownIt>();
