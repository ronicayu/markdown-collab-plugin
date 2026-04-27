import * as fs from "fs/promises";
import * as path from "path";

export const SKILL_REL_PATH = ".claude/skills/markdown-collab/SKILL.md";

export const SKILL_CONTENT = `---
name: markdown-collab
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace (a workspace containing a .markdown-collab/ folder). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document. Trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md".
---

# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. Each \`.md\` file's comments live in a sibling sidecar JSON under \`.markdown-collab/\`. The user runs the IDE; you do the writing.

## Sidecar layout

For a file at \`<workspaceRoot>/<rel>/<name>.md\`:
- Sidecar path: \`<workspaceRoot>/.markdown-collab/<rel>/<name>.md.json\`
- Schema: \`{ "version": 1, "file": "<rel>/<name>.md", "comments": Comment[] }\`
- \`Comment\`: \`{ "id", "anchor": { "text", "contextBefore", "contextAfter" }, "body", "author", "createdAt", "resolved", "replies": Reply[] }\`
- \`Reply\`: \`{ "author", "body", "createdAt" }\`

Anchors are resolved against the \`.md\` text by exact match → context match → whitespace-normalized match. \`anchor.text\` must contain at least **8 non-whitespace characters** to remain valid.

## When this skill applies

Invoke when:
- The user names one or more \`.md\` files and asks you to act on review comments / feedback / notes.
- The user says "address the markdown collab comments" without naming files (operate workspace-wide).
- The user references a specific comment thread or quote and asks you to apply / respond.

Skip / abort if:
- No \`.markdown-collab/\` directory exists in the workspace — there is nothing to act on. Tell the user.
- The user is asking for a general edit unrelated to review comments.

## Workflow

### Phase 1 — Discover

1. Locate the workspace root (the parent directory of \`.markdown-collab/\`). If the user named files, scope to those; otherwise scan all sidecars: \`find .markdown-collab -name '*.md.json'\`.
2. For each in-scope sidecar, read it and verify \`version === 1\`. If \`version > 1\`, skip with a note — the file is read-only for older clients.
3. Cross-check that \`<workspaceRoot>/<sidecar.file>\` exists. If it does not, the comments are orphaned at the file level — flag and skip.

### Phase 2 — Triage

Build the worklist of comments to address. A comment is **actionable** when ALL of:
- \`resolved === false\`
- \`replies\` is empty, OR the LAST reply's \`author !== "ai"\` (you do not respond to your own prior reply unless the human has spoken since).
- \`body\` (and the trailing human reply, if any) describes a concrete change. Pure questions / discussion that you cannot answer should still get a reply, but do not edit the \`.md\` body for them.

For each comment, resolve its anchor against the current \`.md\` text:
- Run an exact match for \`anchor.text\`.
- If no exact match, try with the surrounding \`contextBefore\` / \`contextAfter\` — this disambiguates duplicate hits.
- If anchor cannot be resolved, mark it ORPHANED — leave the sidecar alone, surface this in the final summary, and instruct the user to re-attach the comment in VS Code (right-click → Re-attach Orphaned Comment).

Group actionable comments by file. Process file-by-file.

### Phase 3 — Plan

Before writing anything, for each file:
- List the comments you will address, ordered by anchor offset (top of file first). Working top-down keeps later anchors stable as you edit.
- For each comment, write down: anchor location (line range), what the user is asking, and the concrete edit you will apply.
- If two comments target overlapping or adjacent passages, decide an order that preserves both intents. Prefer combining edits in a single rewrite over making sequential conflicting edits.

### Phase 4 — Edit & sync

For each file, apply edits in the order from the plan. After each edit:

1. **Write the \`.md\` file FIRST. Sidecar second.** This invariant is critical — if the process is interrupted between writes, a stale sidecar pointing at old text is recoverable; a fresh sidecar pointing at vanished text is not.
2. **Update the anchor** for any comment whose target text you rewrote:
   - Set \`anchor.text\` to a stable substring of the new passage (≥ 8 non-whitespace chars).
   - Update \`anchor.contextBefore\` to the up-to-40-character window immediately before the new \`anchor.text\` in the file.
   - Update \`anchor.contextAfter\` to the up-to-40-character window immediately after.
   - Verify these still uniquely identify the location: the new \`anchor.text\` plus its contexts must occur exactly once in the new file.
3. **Append a reply** to the comment's \`replies\` array describing what you did:
   \`\`\`json
   { "author": "ai", "body": "<one or two sentences explaining the change>", "createdAt": "<ISO 8601 UTC>" }
   \`\`\`
   Be specific — quote the new wording, name the section, link to the heading. Don't say "done" with no detail.
4. **For comments you cannot fully address** (ambiguous request, missing information, conflicting with another comment), reply with what you tried and what you need from the human. Do not pretend it's done.

### Phase 5 — Invariants

You MUST NOT:
- Change \`comment.resolved\`. Only the human resolves comments.
- Delete, reorder, or re-id comments. Only the human deletes.
- Modify \`anchor\` for comments whose target text was unchanged.
- Touch \`comment.id\`, \`comment.author\`, \`comment.createdAt\`, or any reply's existing fields.
- Bump \`sidecar.version\`.
- Edit a sidecar whose \`.md\` file you have not just modified (no speculative anchor "cleanups").

### Phase 6 — Verify

Before reporting done, for each modified sidecar:
- Re-read the sidecar and the \`.md\` file from disk.
- Confirm every anchor still resolves uniquely against the current \`.md\` text using exact + context matching.
- Confirm JSON parses and \`version === 1\` is preserved.
- Confirm you did not accidentally drop any comments (count before vs after, minus zero).

If any invariant fails, fix it before reporting. If you cannot fix it, restore the file from your prior knowledge of pre-edit state and explain what went wrong.

## Reporting

Tell the user, per file:
- Comments addressed (id + one-line summary of each change).
- Comments left as orphans (id + why).
- Comments answered without a code change (id + the question / clarification you replied with).
- Anything you skipped and why.

Use the comment id (\`c_xxxxxxxx\`) so they can find each thread in VS Code.

## Anti-patterns

- Don't write the sidecar before the \`.md\`.
- Don't reply with vague "applied" — say what you applied.
- Don't fabricate that you handled a comment you couldn't actually address.
- Don't update an anchor unless you actually rewrote its target.
- Don't operate on a workspace without a \`.markdown-collab/\` directory — surface this rather than create one.
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
