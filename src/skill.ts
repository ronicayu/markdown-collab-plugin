import * as fs from "fs/promises";
import * as path from "path";

export const SKILL_REL_PATH = ".claude/skills/vs-markdown-collab/SKILL.md";
export const CLI_SCRIPT_REL = ".claude/skills/vs-markdown-collab/mdc.mjs";

export const CLI_SCRIPT_CONTENT = `#!/usr/bin/env node
// Markdown Collab agent helper.
//
// Filters sidecars to actionable comments only and applies targeted
// mutations (reply / delete / set-anchor). Lets the agent operate on a
// large corpus of resolved comments without loading any of them into
// context. All writes are atomic (temp + rename) and validate the
// schema before committing.
//
// Usage:
//   node mdc.mjs list [--workspace <ws>] [--file <rel-md-path>]
//   node mdc.mjs reply <sidecar> <commentId> --body <text>
//   node mdc.mjs delete <sidecar> <commentId>
//   node mdc.mjs set-anchor <sidecar> <commentId> --text <s> [--before <s>] [--after <s>]
//   node mdc.mjs validate <sidecar>

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function fail(msg, code = 1) {
  process.stderr.write(\`mdc: \${msg}\\n\`);
  process.exit(code);
}

function flag(name, def) {
  const i = rest.indexOf(name);
  if (i === -1) return def;
  return rest[i + 1];
}

function readSidecar(p) {
  if (!existsSync(p)) fail(\`sidecar not found: \${p}\`, 2);
  let raw;
  try { raw = readFileSync(p, "utf8"); }
  catch (e) { fail(\`read failed: \${p}: \${e.message}\`, 2); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { fail(\`invalid JSON in \${p}: \${e.message}\`, 2); }
  if (!data || data.version !== 1 || typeof data.file !== "string" || !Array.isArray(data.comments)) {
    fail(\`schema mismatch in \${p} (need version=1)\`, 2);
  }
  return data;
}

function writeSidecar(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = \`\${p}.tmp.\${randomBytes(8).toString("hex")}\`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, p);
}

function nowZ() {
  // Strip sub-second precision so display formatters don't show ms.
  return new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
}

function isActionable(c) {
  if (c.resolved) return false;
  const replies = c.replies || [];
  if (replies.length === 0) return true;
  return replies[replies.length - 1].author !== "ai";
}

function findSidecars(workspaceRoot, mdRel) {
  if (mdRel) {
    const sc = join(workspaceRoot, ".markdown-collab", \`\${mdRel}.json\`);
    return existsSync(sc) ? [sc] : [];
  }
  const root = join(workspaceRoot, ".markdown-collab");
  if (!existsSync(root)) return [];
  const out = [];
  function walk(dir) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".md.json")) out.push(p);
    }
  }
  walk(root);
  return out;
}

if (cmd === "list") {
  const ws = flag("--workspace", process.cwd());
  const md = flag("--file");
  const sidecars = findSidecars(ws, md);
  const out = [];
  for (const sc of sidecars) {
    const data = readSidecar(sc);
    for (const c of data.comments) {
      if (!isActionable(c)) continue;
      out.push({
        sidecar: sc,
        file: data.file,
        id: c.id,
        anchor: c.anchor,
        body: c.body,
        author: c.author,
        createdAt: c.createdAt,
        replies: c.replies,
      });
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\\n");
  process.exit(0);
}

if (cmd === "reply") {
  const sc = rest[0];
  const id = rest[1];
  const body = flag("--body");
  if (!sc || !id || body == null) fail("usage: reply <sidecar> <id> --body <text>");
  const data = readSidecar(sc);
  const c = data.comments.find((x) => x.id === id);
  if (!c) fail(\`comment \${id} not found\`, 3);
  c.replies.push({ author: "ai", body, createdAt: nowZ() });
  writeSidecar(sc, data);
  process.stdout.write(\`ok: replied to \${id}\\n\`);
  process.exit(0);
}

if (cmd === "delete") {
  const sc = rest[0];
  const id = rest[1];
  if (!sc || !id) fail("usage: delete <sidecar> <id>");
  const data = readSidecar(sc);
  const before = data.comments.length;
  data.comments = data.comments.filter((c) => c.id !== id);
  if (data.comments.length === before) fail(\`comment \${id} not found\`, 3);
  writeSidecar(sc, data);
  process.stdout.write(\`ok: deleted \${id}\\n\`);
  process.exit(0);
}

if (cmd === "set-anchor") {
  const sc = rest[0];
  const id = rest[1];
  const text = flag("--text");
  const before = flag("--before", "");
  const after = flag("--after", "");
  if (!sc || !id || text == null) fail("usage: set-anchor <sidecar> <id> --text <s> [--before <s>] [--after <s>]");
  if (text.replace(/\\s/g, "").length < 8) fail("anchor.text needs >= 8 non-whitespace chars", 4);
  const data = readSidecar(sc);
  const c = data.comments.find((x) => x.id === id);
  if (!c) fail(\`comment \${id} not found\`, 3);
  c.anchor = { text, contextBefore: before, contextAfter: after };
  writeSidecar(sc, data);
  process.stdout.write(\`ok: anchor updated for \${id}\\n\`);
  process.exit(0);
}

if (cmd === "validate") {
  const sc = rest[0];
  if (!sc) fail("usage: validate <sidecar>");
  const data = readSidecar(sc);
  process.stdout.write(\`ok: version=\${data.version} comments=\${data.comments.length}\\n\`);
  process.exit(0);
}

fail("unknown command. supported: list | reply | delete | set-anchor | validate");
`;

export const SKILL_CONTENT = `---
name: vs-markdown-collab
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace (a workspace containing a .markdown-collab/ folder). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document. Trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md".
---

# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. Each \`.md\` file's comments live in a sibling sidecar JSON under \`.markdown-collab/\`. The user runs the IDE; you do the writing.

**Always drive the workflow through the bundled CLI helper at \`~/.claude/skills/vs-markdown-collab/mdc.mjs\`.** The CLI filters out resolved comments and AI-replied threads at the source so your context window only ever sees the actionable subset, and applies mutations atomically with the right schema. Hand-editing the JSON is allowed only as a last resort and must preserve the schema (\`version: 1\`, \`comments: []\`, \`anchor.text\` ≥ 8 non-whitespace chars).

## Sidecar layout (reference)

For a file at \`<workspaceRoot>/<rel>/<name>.md\`:
- Sidecar path: \`<workspaceRoot>/.markdown-collab/<rel>/<name>.md.json\`
- Schema: \`{ "version": 1, "file": "<rel>/<name>.md", "comments": Comment[] }\`
- \`Comment\`: \`{ "id", "anchor": { "text", "contextBefore", "contextAfter" }, "body", "author", "createdAt", "resolved", "replies": Reply[] }\`
- \`Reply\`: \`{ "author", "body", "createdAt" }\`

Anchors are resolved against the \`.md\` text by exact match → context match → whitespace-normalized match. \`anchor.text\` must contain at least **8 non-whitespace characters** to remain valid.

## CLI helper

\`mdc.mjs\` is a Node script with no external dependencies. Invoke with:

\`\`\`
node ~/.claude/skills/vs-markdown-collab/mdc.mjs <subcommand> [...args]
\`\`\`

Subcommands:

- \`list [--workspace <ws>] [--file <rel-md>]\` — print JSON of **actionable** comments only (unresolved AND last reply not from \`"ai"\`). Default workspace is \`pwd\`. Use \`--file\` to scope to one .md path (relative to workspace root). Each entry has \`{sidecar, file, id, anchor, body, author, createdAt, replies}\` so you have everything you need without reading the whole file.
- \`reply <sidecar> <commentId> --body "<text>"\` — append a reply with \`author: "ai"\` and a current UTC timestamp. The CLI handles the \`Z\` suffix correctly; do not pre-compute a timestamp.
- \`set-anchor <sidecar> <commentId> --text "<s>" [--before "<s>"] [--after "<s>"]\` — overwrite the anchor (used only when you rewrote the anchored passage in place; see Phase 4).
- \`delete <sidecar> <commentId>\` — remove the comment (and its replies) from the sidecar entirely. **Only when the human has explicitly asked you to delete.** See "Deletion" below.
- \`validate <sidecar>\` — light sanity check (parses, version=1, returns count).

The CLI writes atomically (temp file + rename) and validates the schema before committing.

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

1. Confirm the workspace has \`.markdown-collab/\` (check via \`ls\` or by running the CLI; an empty list means nothing to do).
2. Run \`mdc.mjs list\` (with \`--file <path>\` if the user scoped to a particular doc). The output is the only context you need — do NOT read raw sidecars unless \`list\` returns something inconsistent.

### Phase 2 — Plan

Group the actionable entries by \`file\`. For each file, sort the entries by anchor location (top of file first) so later edits don't invalidate earlier offsets. For each entry, write down:
- The user's intent (from \`body\` and the trailing human reply, if any).
- The concrete edit you will apply (rewrite / append / delete).
- Whether the anchored passage will be rewritten in place (anchor will be updated) or removed (anchor will orphan).

If two entries target overlapping or adjacent passages, decide an order that preserves both intents. Prefer combining edits in a single rewrite over sequential conflicting edits.

### Phase 3 — Edit & sync

For each entry, in order:

1. **Edit the \`.md\` file first.** This invariant is critical — if interrupted between writes, a stale sidecar pointing at old text is recoverable; a fresh sidecar pointing at vanished text is not.

2. **Update the anchor** ONLY when you rewrote the anchored passage in place. If you DELETED the anchored passage (the comment said "remove this", "drop this section", "cut", etc.), leave the anchor untouched — the comment will correctly surface as an orphan in the UI, and the human can then resolve or delete it. Never re-anchor a deleted comment to neighbouring text; that produces a misleading link to content the comment was never about.

   When you DID rewrite the passage, run:
   \`\`\`
   node ~/.claude/skills/vs-markdown-collab/mdc.mjs set-anchor <sidecar> <id> \\
     --text "<verbatim substring of the new passage, ≥ 8 non-whitespace chars>" \\
     --before "<up to 40 chars immediately before>" \\
     --after  "<up to 40 chars immediately after>"
   \`\`\`
   The new \`text\` must quote the new wording of the same idea, not an unrelated nearby sentence. Verify the new anchor occurs exactly once in the new file before you set it.

   If you cannot honestly say the new anchor points to a rewritten version of the same idea, leave the anchor untouched and let the comment orphan.

3. **Append your reply:**
   \`\`\`
   node ~/.claude/skills/vs-markdown-collab/mdc.mjs reply <sidecar> <id> \\
     --body "<one or two sentences quoting the new wording, naming the section, etc.>"
   \`\`\`
   Be specific. Don't say "done" with no detail.

4. **For comments you cannot fully address** (ambiguous request, missing information, conflicting with another comment), still reply via the CLI with what you tried and what you need from the human. Do not pretend it's done.

### Phase 4 — Deletion (opt-in)

You only delete a thread when the human's body or trailing reply unambiguously asks for it:
- "delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"

When deleting:
\`\`\`
node ~/.claude/skills/vs-markdown-collab/mdc.mjs delete <sidecar> <id>
\`\`\`

Do not delete to "clean up" resolved threads, do not delete after you addressed a comment (the human resolves), and do not delete because the anchor orphaned.

### Phase 5 — Invariants

You MUST NOT:
- Change \`comment.resolved\`. Only the human resolves comments.
- Delete a comment that the human has not explicitly asked to delete (Phase 4).
- Modify \`anchor\` for comments whose target text was unchanged or deleted (only rewrites trigger anchor updates — see Phase 3 step 2).
- Re-anchor a comment to nearby unrelated text after a deletion. Let it orphan.
- Touch \`comment.id\`, \`comment.author\`, \`comment.createdAt\`, or any reply's existing fields.
- Bump \`sidecar.version\`.
- Edit a sidecar whose \`.md\` file you have not just modified (no speculative anchor "cleanups").

### Phase 6 — Verify

Before reporting done:
- Run \`mdc.mjs list\` again. Confirm the entries you addressed are gone from the actionable list (because your reply was the last and now \`author === "ai"\`).
- For any anchor you updated, grep the \`.md\` file to confirm \`anchor.text\` plus its surrounding context occurs exactly once.
- For any comment you deleted, run \`mdc.mjs validate <sidecar>\` and confirm the count decreased by one.

If any check fails, fix it before reporting.

## Reporting

Tell the user, per file:
- Comments addressed (id + one-line summary of each change).
- Comments deleted on explicit request (id).
- Comments left as orphans because their anchor target was removed (id + why).
- Comments answered without a code change (id + the question / clarification you replied with).
- Anything you skipped and why.

Use the comment id (\`c_xxxxxxxx\`) so they can find each thread in VS Code.

## Anti-patterns

- Don't read whole sidecars when \`mdc.mjs list\` will give you exactly the actionable subset.
- Don't write the sidecar before the \`.md\`.
- Don't hand-edit JSON when a CLI subcommand exists for the same operation.
- Don't reply with vague "applied" — say what you applied.
- Don't fabricate that you handled a comment you couldn't actually address.
- Don't update an anchor unless you actually rewrote its target.
- Don't re-anchor a deleted passage to nearby unrelated text. Deletions become orphans by design.
- Don't delete a thread the human didn't explicitly tell you to delete.
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

  // The CLI helper is auto-generated and silently kept in sync — never a
  // user-edited file, so we always overwrite it (when content differs).
  // Don't gate this on the SKILL.md path so a user with a customized SKILL.md
  // can still pick up CLI fixes.
  await syncCliScript(homeDir);

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

async function syncCliScript(homeDir: string): Promise<void> {
  const target = path.join(homeDir, CLI_SCRIPT_REL);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }
  if (existing === CLI_SCRIPT_CONTENT) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, CLI_SCRIPT_CONTENT, "utf8");
  // Best-effort executable bit; ignore on platforms that don't honour it.
  try {
    await fs.chmod(target, 0o755);
  } catch {
    /* Windows / restricted FS — irrelevant, we invoke via `node` */
  }
}
