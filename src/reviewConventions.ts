// Standing review conventions (10x-plan-2 P1.2).
//
// Every review starts from zero. Terminology, tone, the house style, and the
// "we know, don't flag it" exceptions have to be retyped into the focus prompt
// each time, or Claude re-litigates them forever. The per-run focus is the right
// place for "check the API examples today"; it is the wrong place for "the
// product is called Markdown Collab, never 'the plugin'", which is true every
// time and belongs to the project.
//
// So: a plain Markdown file at `.markdown-collab/conventions.md` that the human
// owns and edits, appended to every review payload under a `Conventions:`
// header. Deliberately prose, not schema — it is written for Claude to read, and
// the moment it grows keys and validation it becomes config sprawl that has to
// be documented, migrated, and kept in sync with the skill.
//
// Pure and vscode-free so the payload assembly is testable; the file reading
// lives in the caller.

/** Where the file lives, relative to the workspace root. */
export const CONVENTIONS_REL = ".markdown-collab/conventions.md";

/**
 * How much of it rides along on every dispatch. Generous for prose a human
 * actually maintains, small enough that a runaway file can't crowd out the
 * document under review.
 */
export const MAX_CONVENTIONS_BYTES = 4 * 1024;

export interface ConventionsBlock {
  /** The text to append, header included. Empty when there is nothing to send. */
  text: string;
  /** True when the file was longer than the cap and was cut. */
  truncated: boolean;
}

/**
 * The file without its HTML comments, blank runs collapsed.
 *
 * Comments are how the scaffold explains itself and how the human leaves notes
 * to themselves; neither is an instruction to Claude, and shipping "delete these
 * instructions" inside a review prompt is worse than shipping nothing.
 */
function commentFreeBody(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether the file says anything yet. Headings alone don't count: a file that is
 * still only the scaffold must weigh nothing, or every payload carries a block
 * that says nothing and Claude weighs it as if it did.
 */
function isEmptyConventions(raw: string): boolean {
  return commentFreeBody(raw)
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("")
    .trim() === "";
}

/**
 * The `Conventions:` block for a review payload, or an empty block when the
 * file is absent, blank, or nothing but the scaffold.
 */
export function conventionsBlock(raw: string | null): ConventionsBlock {
  if (raw === null || isEmptyConventions(raw)) return { text: "", truncated: false };

  const body = commentFreeBody(raw);
  const truncated = Buffer.byteLength(body, "utf8") > MAX_CONVENTIONS_BYTES;
  const kept = truncated ? truncateToBytes(body, MAX_CONVENTIONS_BYTES) : body;

  const lines = [
    "Conventions: standing rules for this project, from `.markdown-collab/conventions.md`.",
    "They apply to every review pass. A per-run focus narrows what you look for; these say how",
    "this project wants things said. Where they conflict with the focus, the focus wins for scope",
    "and the conventions still hold for wording.",
    "",
    kept,
  ];
  if (truncated) {
    lines.push(
      "",
      `[truncated at ${MAX_CONVENTIONS_BYTES / 1024} KB — the rest of the file was not sent; shorten it so nothing is lost]`,
    );
  }
  return { text: lines.join("\n"), truncated };
}

/** Cut to a byte budget without splitting a character or a line mid-way. */
function truncateToBytes(text: string, max: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > max) break;
    kept.push(line);
    used += cost;
  }
  // A single line longer than the whole budget still has to be cut somewhere.
  if (kept.length === 0) return Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  return kept.join("\n");
}

/** Append the conventions block to a prompt, when there is one. */
export function withConventions(prompt: string, raw: string | null): string {
  const block = conventionsBlock(raw);
  return block.text === "" ? prompt : `${prompt}\n\n${block.text}`;
}

/** The commented template a fresh conventions file starts from. */
export const CONVENTIONS_TEMPLATE = `# Review conventions

<!--
Standing rules for Claude's review passes on this project. Plain prose — write
what you'd tell a new reviewer on their first day. Everything outside HTML
comments is sent with every review request, so keep it under 4 KB and delete
what stops being true.

Delete these instructions once you've written yours.
-->

## Terminology

<!-- e.g. The product is "Markdown Collab", never "the plugin" or "the extension". -->

## Tone

<!-- e.g. Second person, present tense. No exclamation marks in reference docs. -->

## Standing focuses

<!-- e.g. Always check that code examples match the current CLI flags. -->

## Known and accepted — don't flag these

<!-- e.g. The setup section is deliberately repeated in the README and the guide. -->
`;
