import * as fs from "fs/promises";
import * as path from "path";

export const AGENTS_SENTINEL = "## Markdown review comments";

export const AGENTS_SNIPPET = `## Markdown review comments

Markdown Collab stores review feedback in one of two formats per \`.md\` file. Detect which one applies and follow the matching workflow.

### Inline format (default in v0.27+)

Threads live inside the \`.md\` file itself:
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

### Sidecar format (legacy)

Review feedback lives in a JSON sidecar at \`<workspaceRoot>/.markdown-collab/<path>/<name>.md.json\`:
\`{ "version": 1, "file": "<rel>/<name>.md", "comments": Comment[] }\`
where each \`Comment\` is \`{ "id", "anchor": { "text", "contextBefore", "contextAfter" }, "body", "author", "createdAt", "resolved", "replies": Reply[] }\`.

**Detection:** the \`.md\` file does NOT contain \`<!--mc:threads:begin-->\`, but \`<workspaceRoot>/.markdown-collab/<rel>.md.json\` exists.

When addressing comments in sidecar mode:
1. For every comment where \`resolved: false\`, address it.
2. Append a reply to that comment's \`replies\` array:
   \`{ "author": "ai", "body": "<what you did>", "createdAt": "<ISO8601>" }\`
3. If you rewrite or move the passage an anchor points to, update the same comment's \`anchor.text\`, \`anchor.contextBefore\`, and \`anchor.contextAfter\` so they exactly match the new text in the file. If the passage is removed, leave the anchor untouched — the comment will orphan, which is correct.
4. Write the \`.md\` file FIRST, THEN the sidecar.
5. Do NOT change \`resolved\` — only the human reviewer sets that.
6. The user may post additional replies (author: "user"); treat each new unaddressed user reply the same as a fresh comment.
7. Do NOT create a fresh sidecar to host a brand-new thread — if a file has neither inline markers nor a sidecar, fall back to inline-mode initiation.
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
