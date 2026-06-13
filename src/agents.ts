import * as fs from "fs/promises";
import * as path from "path";

export const AGENTS_SENTINEL = "## Markdown review comments";

export const AGENTS_SNIPPET = `## Markdown review comments

Markdown Collab stores review feedback inline in the \`.md\` file itself.

Threads live inside the \`.md\`:
- Anchored spans are wrapped in paired HTML comments: \`<!--mc:a:ID-->anchored text<!--mc:/a:ID-->\`. \`ID\` is 1–12 char base36.
- A block at the end of the file holds one \`<!--mc:t {JSON}-->\` line per thread, fenced by \`<!--mc:threads:begin-->\` and \`<!--mc:threads:end-->\`.
- Each thread JSON: \`{"id":"ID","quote":"<original anchor text>","status":"open"|"resolved","comments":[Comment, …]}\`.
- Each \`Comment\`: \`{"id":"c<N>","parent"?:"c<N>","author":"<name>","ts":"<ISO-8601 UTC>","body":"<markdown>"}\`.

**Detection:** the file contains \`<!--mc:threads:begin-->\`.

When addressing an open thread:
1. Make the prose edit the reviewer asked for. Keep the \`<!--mc:a:ID-->…<!--mc:/a:ID-->\` markers wrapping the rewritten passage; if the passage is removed, delete both markers (the thread will surface as unanchored — that is the correct outcome).
2. Append a new comment to the thread's \`comments\` array on the matching \`<!--mc:t …-->\` line:
   \`{"id":"c<next>","parent":"<last-comment-id>","author":"claude","ts":"<ISO-8601 UTC>","body":"<what you did>"}\`
   where \`<next>\` is the next sequential \`c<N>\` for that thread.
3. Do NOT change \`status\` — only the human reviewer resolves a thread.
4. Do NOT mutate existing comment objects — append only.
5. Only initiate a brand-new thread when the human explicitly asks ("leave a comment on X"). Pick a unique 5-char base36 id, wrap the passage with paired markers, append a fresh \`<!--mc:t …-->\` line with a single \`c1\` comment authored by \`claude\`.

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
