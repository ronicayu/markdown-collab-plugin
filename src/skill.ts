import * as fs from "fs/promises";
import * as path from "path";

export const SKILL_REL_PATH = ".claude/skills/markdown-collab/SKILL.md";

export const SKILL_CONTENT = `---
name: markdown-collab
description: Address review comments, notes, suggestions, or feedback on Markdown (.md) files. TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document in a workspace that contains a .markdown-collab/ folder. Examples of trigger phrases: "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions".
---

# Markdown Collab review comments

For a file at \`<folder>/<path>/<name>.md\`, its review comments live in
\`<folder>/.markdown-collab/<path>/<name>.md.json\`.

## Workflow

1. Read the sidecar. For each comment where \`resolved: false\` and the latest reply is not from \`"ai"\` (or \`replies\` is empty), address it.
2. Edit the \`.md\` file as requested in \`body\` and any subsequent user replies.
3. Write the \`.md\` file FIRST, THEN the sidecar. Never the other way around.
4. Append a reply to that comment's \`replies\`:
   \`{ "author": "ai", "body": "<what you did>", "createdAt": "<ISO8601>" }\`
5. If you rewrote the passage the anchor points to, update \`anchor.text\`, \`anchor.contextBefore\`, and \`anchor.contextAfter\` to match the new text exactly. Preserve at least 8 non-whitespace chars in \`anchor.text\`.
6. Do NOT change \`resolved\` — only the human does that.
7. Do NOT delete, reorder, or re-id comments.
`;

export async function installClaudeSkill(
  homeDir: string,
  options?: { force?: boolean },
): Promise<{ action: "installed" | "already-present" | "exists-differs"; path: string }> {
  const target = path.join(homeDir, SKILL_REL_PATH);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }

  if (existing !== null) {
    if (existing === SKILL_CONTENT) {
      return { action: "already-present", path: target };
    }
    if (!options?.force) {
      return { action: "exists-differs", path: target };
    }
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, SKILL_CONTENT, "utf8");
  return { action: "installed", path: target };
}
