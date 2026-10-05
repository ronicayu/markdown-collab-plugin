// Milkdown glue for source positions in the live editor's read-only mode. The
// mapping itself is pure and lives in `src/collab/sourcePositions.ts`; this
// file only gets its annotation from the parser into the ProseMirror document.
//
// Installed only when the editor is read-only. In edit mode a split or join
// copies a block's attrs onto both halves, so the positions would be wrong
// after the first keystroke — and edit mode doesn't use them.

import type { Ctx } from "@milkdown/ctx";
import { remarkPluginsCtx } from "@milkdown/core";
import { headingSchema, paragraphSchema } from "@milkdown/preset-commonmark";
import { tableCellSchema, tableHeaderSchema } from "@milkdown/preset-gfm";
import type { NodeSchema, RemarkPlugin } from "@milkdown/transformer";
import { annotateSourceRuns, SOURCE_ATTR, type MdNode } from "../collab/sourcePositions";

/**
 * Remark attacher that registers `annotateSourceRuns` as an mdast transform.
 * Transforms run inside `fromMarkdown`, in registration order — and this one
 * is prepended, so it sees every leaf with its position, before GFM's
 * autolink-literal transform and milkdown's `remarkLineBreak` replace text
 * nodes with position-less pieces.
 */
function remarkSourceRuns(this: { data: () => Record<string, unknown> }): void {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] };
  (data.fromMarkdownExtensions ??= []).push({
    transforms: [(tree: MdNode) => annotateSourceRuns(tree)],
  });
}

/**
 * Declare the `mcSrc` attr and stamp it onto the node the original runner
 * produces. Wrapping (not re-implementing) the runner keeps milkdown's own
 * parse logic — heading levels, cell alignment — whatever it becomes.
 */
function withSourceAttr(schema: NodeSchema): NodeSchema {
  const runner = schema.parseMarkdown.runner;
  return {
    ...schema,
    attrs: { ...(schema.attrs ?? {}), [SOURCE_ATTR]: { default: null } },
    parseMarkdown: {
      ...schema.parseMarkdown,
      runner: (state, node, type) => {
        runner(state, node, type);
        const src = (node.data as Record<string, unknown> | undefined)?.[SOURCE_ATTR];
        if (!src) return;
        // The runner closed its node into the parent, so it's the parent's
        // last child. Anything else means the runner did something new —
        // leave the node unannotated (unmapped) rather than stamp the wrong one.
        const parent = state.top();
        const produced = parent?.content[parent.content.length - 1];
        if (!parent || !produced || produced.type !== type) return;
        parent.content[parent.content.length - 1] = type.create(
          { ...produced.attrs, [SOURCE_ATTR]: src },
          produced.content,
          produced.marks,
        );
      },
    },
  };
}

export function installSourcePositions(ctx: Ctx): void {
  // Prepended: the config runs before any `$remark` plugin registers, so this
  // is first in the chain and its transform is first inside the parser.
  ctx.update(remarkPluginsCtx, (plugins) => [
    { plugin: remarkSourceRuns as unknown as RemarkPlugin["plugin"], options: {} },
    ...plugins,
  ]);
  for (const schema of [paragraphSchema, headingSchema, tableCellSchema, tableHeaderSchema]) {
    ctx.update(schema.key, (prev) => (c) => withSourceAttr(prev(c)));
  }
}

// micromark's browser build decodes named references by letting the HTML
// parser do it; doing the same here means the aligner agrees with the parser
// on every name, not just the common ones.
let decoderEl: HTMLElement | null = null;

/** `amp` → `&`; undefined when the name isn't a character reference. */
export function decodeNamedReference(name: string): string | undefined {
  decoderEl ??= document.createElement("i");
  const reference = `&${name};`;
  decoderEl.innerHTML = reference;
  const decoded = decoderEl.textContent ?? "";
  // Legacy names need no semicolon, so `&notit;` parses as `¬it;` — a
  // trailing `;` left over means the match wasn't the whole name.
  if (decoded.charCodeAt(decoded.length - 1) === 59 && name !== "semi") return undefined;
  return decoded === reference ? undefined : decoded;
}
