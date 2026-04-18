import * as fs from "fs/promises";
import * as path from "path";

export const AGENTS_SENTINEL = "## Markdown review comments";

export const AGENTS_SNIPPET = `## Markdown review comments

Review feedback for a Markdown file at \`<path>/<name>.md\` lives in the sidecar
\`.markdown-collab/<path>/<name>.md.json\` at the workspace root.

Before editing a Markdown file:
1. Check for its sidecar at \`.markdown-collab/<path>/<name>.md.json\`.
2. For every comment where \`resolved: false\`, address it.
3. Append a reply to that comment's \`replies\` array:
   \`{ "author": "ai", "body": "<what you did>", "createdAt": "<ISO8601>" }\`
4. If you rewrite or move the passage an anchor points to, update the same
   comment's \`anchor.text\`, \`anchor.contextBefore\`, and \`anchor.contextAfter\`
   so they exactly match the new text in the file. This keeps the comment
   attached to the right passage across revisions.
5. Write the \`.md\` file FIRST, THEN the sidecar.
6. Do NOT change \`resolved\` — only the human reviewer sets that.
7. The user may post additional replies (author: "user"); treat each new
   unaddressed user reply the same as a fresh comment.
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
