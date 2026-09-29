import * as fs from "fs/promises";
import * as path from "path";

export const AGENTS_SENTINEL = "## Markdown review comments";

// The hierarchy below matches skillText.ts's `changePaths` (0.4): MCP tools
// first, the `mdc` CLI second, hand-editing last and only when neither
// exists. AGENTS.md reaches every kind of agent, most of which have no skill
// loader to read the fuller version from, so this is the same rule in miniature
// — not a fourth, independent set of instructions to drift from the other three.
export const AGENTS_SNIPPET = `## Markdown review comments

Markdown Collab stores review feedback inline in the \`.md\` file itself — anchored spans wrapped in paired \`<!--mc:a:ID-->…<!--mc:/a:ID-->\` markers, threads recorded one \`<!--mc:t {JSON}-->\` line per thread between \`<!--mc:threads:begin-->\`/\`<!--mc:threads:end-->\`. Detect a reviewed file by the literal string \`<!--mc:threads:begin-->\`.

Never hand-edit a marker or a thread line directly — one dropped \`-->\` silently orphans a reviewer's comment. Three ways to change one, in order:

1. **The \`markdown-collab\` MCP tools**, if they're in your tool list (offer "Markdown Collab: Connect an Agent…" if not): \`mc_list\` reads open threads with their live anchored text; \`mc_reply\`/\`mc_open\`/\`mc_rewrite\` act on them; \`mc_edit\` changes prose outside anchored spans; \`mc_resolve\` only when the human asks; \`mc_suggest\` in suggest mode; \`mc_check\` on every file you touch, last.
2. **The \`mdc\` CLI**, if it's on PATH: \`mdc <verb> <file> [args]\` — list / reply / open / rewrite / edit / resolve / suggest / check, same rules as the tools above.
3. **Hand-editing, only when neither exists:**
   - Reply: find the thread's \`<!--mc:t {…}-->\` line and append \`{"id":"c<next>","parent":"<last-comment-id>","author":"<you>","ts":"<ISO-8601 UTC>","body":"<what you did>"}\` to its \`comments\` array. Never change \`status\`; never edit or remove an existing comment.
   - New thread, only on explicit request ("leave a comment on X"): pick a unique id, wrap the passage in \`<!--mc:a:ID-->…<!--mc:/a:ID-->\`, append a fresh \`<!--mc:t {…}-->\` line with a single \`c1\` comment.
   - Rewriting an anchored passage keeps both markers on the new wording; removing the passage deletes both markers and leaves the thread unanchored — the correct outcome, don't re-anchor to nearby text.

`;

export async function ensureAgentsSnippet(
  workspaceRoot: string,
): Promise<"created" | "appended" | "already-present"> {
  const target = path.join(workspaceRoot, "AGENTS.md");
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }

  if (existing === null) {
    await fs.writeFile(target, AGENTS_SNIPPET, "utf8");
    return "created";
  }

  if (existing.includes(AGENTS_SENTINEL)) {
    return "already-present";
  }

  const appended = existing + "\n\n" + AGENTS_SNIPPET;
  await fs.writeFile(target, appended, "utf8");
  return "appended";
}
