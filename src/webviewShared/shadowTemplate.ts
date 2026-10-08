// The markup half of shadow-rendered HTML (see shadowHtml.ts), kept DOM-free
// so the markdown-it pipeline that emits it stays importable from node tests.

/** Template class the markdown-it renderer emits for a shadow-rendered block. */
export const SHADOW_TEMPLATE_CLASS = "mc-html-shadow";

/**
 * An inert `<template>` — nothing in it renders, loads or applies — that
 * `hydrateShadowHtml` turns into a shadow-rendered block once the surface has
 * put the rendered HTML in the page.
 */
export function shadowTemplate(sanitized: string, block: boolean): string {
  return `<template class="${SHADOW_TEMPLATE_CLASS}" data-block="${block ? "1" : "0"}">${sanitized}</template>`;
}
