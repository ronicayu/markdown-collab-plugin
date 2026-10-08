// Self-contained raw-HTML blocks, rendered in a shadow root.
//
// A document's own CSS — `<style>`, `class`, any `style` declaration — is what
// makes a styled card or table look right, and it is exactly what can restyle
// or cover the review UI around it. Two browser mechanisms take that risk
// away without filtering the CSS:
//
// - A shadow root scopes selectors both ways: the fragment's `<style>` can't
//   reach the editor, and the editor's table striping can't reach the
//   fragment. Inherited properties (colors, fonts, CSS variables) still flow
//   in, so the fragment follows the VS Code theme for free.
// - `contain: paint` on the wrapper makes it the containing block for fixed
//   and absolute descendants and clips painting to its box, so even
//   `position: fixed; inset: 0` stays inside it.
//
// The shadow host is a separate element *inside* the wrapper: a fragment's
// `:host { … !important }` beats outside styles on the host itself, so the
// containment must sit on an ancestor the fragment can't select. It is set
// through the CSSOM here rather than in a stylesheet, so no surface can forget
// it.
//
// A document's `<style>` usually sits in a block of its own (CommonMark ends an
// HTML block at `</style>`), ahead of the blocks whose classes it targets, so
// styles are shared per rendered document: every block's `<style>` rules go
// into one sheet that all of that document's shadow roots adopt. They reach the
// document's own HTML blocks and still nothing outside them.
//
// Scripts are still refused twice over: the sanitizer drops them, and the
// webviews' CSP (nonce-only scripts) applies inside shadow roots too.

import { SHADOW_TEMPLATE_CLASS } from "./shadowTemplate";

/** Class on the wrapper of every shadow-rendered fragment. */
export const SHADOW_WRAPPER_CLASS = "mdc-html-shadow";

/** Base rules inside each shadow root, ahead of the fragment's own `<style>`. */
const BASE_CSS = `
:host { display: block; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35)); padding: 4px 8px; }
a { color: var(--vscode-textLink-foreground, inherit); }
code, kbd, pre, samp { font-family: var(--vscode-editor-font-family, monospace); }
kbd { font-size: 0.85em; padding: 1px 5px; border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35)); border-bottom-width: 2px; border-radius: 4px; }
mark.mc-search { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 210, 0, 0.4)); color: inherit; }
mark.mc-search--current { background: var(--vscode-editor-findMatchBackground, rgba(255, 150, 0, 0.6)); }
`;

let baseSheet: CSSStyleSheet | null = null;
function base(): CSSStyleSheet {
  if (!baseSheet) {
    baseSheet = new CSSStyleSheet();
    baseSheet.replaceSync(BASE_CSS);
  }
  return baseSheet;
}

/**
 * The `<style>` rules of one rendered document, shared by all of its shadow
 * roots. Each contributing block registers under its own key and unregisters
 * when it goes, so an edited or deleted `<style>` block stops applying.
 */
export class ShadowStyles {
  private readonly sheet = new CSSStyleSheet();
  private readonly parts = new Map<object, string>();

  /** Set (or with null, clear) the CSS `owner` contributes. */
  set(owner: object, css: string | null): void {
    const before = this.parts.get(owner);
    if (css) this.parts.set(owner, css);
    else this.parts.delete(owner);
    if (before !== (css || undefined)) this.sheet.replaceSync([...this.parts.values()].join("\n"));
  }

  adopt(root: ShadowRoot): void {
    root.adoptedStyleSheets = [base(), this.sheet];
  }
}

/** Split the `<style>` bodies (as `sanitizeHtml` emits them) out of a fragment. */
export function splitStyles(sanitized: string): { css: string; html: string } {
  const css: string[] = [];
  const html = sanitized.replace(/<style>([\s\S]*?)<\/style>/g, (_whole, body: string) => {
    css.push(body);
    return "";
  });
  return { css: css.join("\n"), html };
}

/**
 * Fill `wrapper` with a fresh shadow host holding `sanitized` (the output of
 * `sanitizeHtml(…, { shadow: true })`, with its `<style>` bodies already moved
 * into `styles`). Safe to call again on the same wrapper: each call replaces
 * the host, since a host takes one shadow root.
 */
export function mountShadowHtml(wrapper: HTMLElement, sanitized: string, block: boolean, styles: ShadowStyles): void {
  wrapper.classList.add(SHADOW_WRAPPER_CLASS);
  wrapper.style.contain = "paint";
  wrapper.style.display = block ? "block" : "inline-block";
  wrapper.style.maxWidth = "100%";
  wrapper.style.overflowX = "auto";
  wrapper.style.verticalAlign = block ? "" : "baseline";
  const host = document.createElement("span");
  host.style.display = "block";
  const root = host.attachShadow({ mode: "open" });
  styles.adopt(root);
  root.innerHTML = sanitized;
  wrapper.replaceChildren(host);
}

/**
 * Replace every shadow template under `root` with its rendered block, all of
 * them sharing the document's `<style>` rules. A block that held only a
 * `<style>` shows nothing.
 */
export function hydrateShadowHtml(root: ParentNode): void {
  const styles = new ShadowStyles();
  const blocks: Array<{ tpl: HTMLTemplateElement; html: string }> = [];
  for (const tpl of root.querySelectorAll<HTMLTemplateElement>(`template.${SHADOW_TEMPLATE_CLASS}`)) {
    const { css, html } = splitStyles(tpl.innerHTML);
    styles.set(tpl, css);
    blocks.push({ tpl, html });
  }
  for (const { tpl, html } of blocks) {
    if (!html.trim()) {
      tpl.remove();
      continue;
    }
    const block = tpl.dataset.block === "1";
    const wrapper = document.createElement(block ? "div" : "span");
    mountShadowHtml(wrapper, html, block, styles);
    tpl.replaceWith(wrapper);
  }
}

/** The shadow roots of every shadow-rendered block under `root`. */
export function shadowRootsIn(root: ParentNode): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  for (const wrapper of root.querySelectorAll<HTMLElement>(`.${SHADOW_WRAPPER_CLASS}`)) {
    const sr = wrapper.firstElementChild?.shadowRoot;
    if (sr) roots.push(sr);
  }
  return roots;
}
