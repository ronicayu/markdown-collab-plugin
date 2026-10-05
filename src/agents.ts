import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { FORMAT_SPEC_URL, HAND_EDIT_RULES } from "./handEditRules";

export const AGENTS_SENTINEL = "## Markdown review comments";

export { FORMAT_SPEC_URL };

// The file format is the API for every agent that isn't Claude Code, and `mdc`
// is only ever on PATH inside a Claude Code session. So
// this leads with the contract (docs/format.md), names the tools as the better
// path when an agent happens to have them, and says plainly who has `mdc` and
// what to do without it: ask the human to run Repair.
export const AGENTS_SNIPPET = `## Markdown review comments

Markdown Collab stores review feedback inline in the \`.md\` file itself — anchored spans wrapped in paired \`<!--mc:a:ID-->…<!--mc:/a:ID-->\` markers, threads recorded one \`<!--mc:t {JSON}-->\` line per thread between \`<!--mc:threads:begin-->\`/\`<!--mc:threads:end-->\` at the end of the file. Detect a reviewed file by the literal string \`<!--mc:threads:begin-->\`.

**The file format is the contract:** [\`docs/format.md\`](${FORMAT_SPEC_URL}) in the Markdown Collab repository defines every marker and field. If the \`markdown-collab\` MCP tools are in your tool list, use them instead of editing by hand — \`mc_list\`, then \`mc_reply\`/\`mc_open\`/\`mc_rewrite\`/\`mc_edit\`/\`mc_suggest\`, and \`mc_check\` last — they keep the markers intact and the human can undo them. Otherwise edit the file by hand, carefully; one dropped \`-->\` silently orphans a reviewer's comment:

${HAND_EDIT_RULES.map((rule) => `- ${rule}`).join("\n")}

**Then check the file.** The \`mdc\` CLI exists only inside Claude Code sessions: if \`mdc\` is on your PATH, run \`mdc check <file>\`; otherwise ask the human to run "Markdown Collab: Repair Comment Anchors" on the file.

`;

/**
 * Every snippet an earlier version wrote, as `sectionHash` sees it. A section
 * that still hashes to one of these is ours and untouched, so it is replaced
 * with the current text; anything else under the heading was edited by hand
 * and is left alone. When `AGENTS_SNIPPET` changes, add its old hash here —
 * agents.test.ts pins the current one so that step can't be skipped.
 */
const PRIOR_SNIPPET_HASHES = new Set([
  "e523ef2be85bcea3", // 1.0: the JSON sidecar workflow
  "44edbc6df78836a3", // 0.27: inline format, sidecar kept as legacy
  "04c086242ea7cfed", // 0.34: inline only, hand-editing instructions
  "5b05cecb60496801", // 0.35.12: MCP tools, then mdc, then hand-editing
  "bdb3734674cf348c", // 0.35.41: the format contract and hand-editing steps, before suggestions and heading anchors
]);

/** Line endings and trailing whitespace don't make a section someone's edit. */
export function sectionHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trimEnd()).digest("hex").slice(0, 16);
}

/**
 * Our section of AGENTS.md: from the sentinel heading to the next heading of
 * the same or a higher level, or the end of the file. Null when the heading
 * isn't there as a line of its own.
 */
function findSection(text: string): { start: number; end: number } | null {
  const heading = /^## Markdown review comments[ \t]*\r?$/m.exec(text);
  if (!heading) return null;
  const bodyStart = heading.index + heading[0].length;
  const next = /^#{1,2}[ \t]/m.exec(text.slice(bodyStart));
  return { start: heading.index, end: next ? bodyStart + next.index : text.length };
}

/** Whether the workspace's AGENTS.md already carries our section. Read-only. */
export async function agentsSectionPresent(workspaceRoot: string): Promise<boolean> {
  try {
    return findSection(await fs.readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8")) !== null;
  } catch {
    return false;
  }
}

export type AgentsSnippetOutcome =
  /** No AGENTS.md; one was written with the snippet. */
  | "created"
  /** AGENTS.md existed without the section; the snippet was appended. */
  | "appended"
  /** The section was an earlier version's, untouched; it now reads as the current one. */
  | "refreshed"
  /** The section is already the current snippet. */
  | "already-present"
  /** The section was edited by hand. Nothing was written. */
  | "customized";

/**
 * Refuse to write through a symlink: `lstat` the target itself (if it
 * exists) and its parent directory, following neither. A symlinked
 * workspace folder or a symlinked AGENTS.md could otherwise send this write
 * somewhere the human never agreed to. Duplicated (rather than shared) in
 * `mcpServer/agentConnections.ts` and `mcpServer/index.ts`, which guard the
 * same class of write for the other agent-connection files — each is small
 * and self-contained, and none of the three otherwise depends on the others.
 */
export async function refuseSymlink(targetPath: string): Promise<string | null> {
  for (const p of [path.dirname(targetPath), targetPath]) {
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) return `${p} is a symlink`;
    } catch {
      /* doesn't exist yet — nothing to refuse there */
    }
  }
  return null;
}

/**
 * Write the snippet into the workspace's AGENTS.md, or bring an earlier
 * version of it up to date.
 * Never overwrites a section someone edited: that is
 * reported as `customized` and left for the human.
 */
export async function ensureAgentsSnippet(workspaceRoot: string): Promise<AgentsSnippetOutcome> {
  const target = path.join(workspaceRoot, "AGENTS.md");
  const symlink = await refuseSymlink(target);
  if (symlink) throw new Error(`refusing to write through a symlink: ${symlink}`);
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

  const section = findSection(existing);
  if (!section) {
    // The sentinel text without its heading line (quoted in prose, or under a
    // `###`) is still someone's mention of it — not ours to append beside.
    if (existing.includes(AGENTS_SENTINEL)) return "customized";
    await fs.writeFile(target, existing + "\n\n" + AGENTS_SNIPPET, "utf8");
    return "appended";
  }

  const current = sectionHash(existing.slice(section.start, section.end));
  if (current === sectionHash(AGENTS_SNIPPET)) return "already-present";
  if (!PRIOR_SNIPPET_HASHES.has(current)) return "customized";

  // The snippet ends in a blank line, so whatever followed our section keeps
  // exactly one blank line above it.
  const after = existing.slice(section.end).replace(/^(\r?\n)+/, "");
  await fs.writeFile(target, existing.slice(0, section.start) + AGENTS_SNIPPET + after, "utf8");
  return "refreshed";
}
