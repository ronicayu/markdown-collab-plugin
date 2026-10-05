// Who holds the review workflow when a prompt goes out (10x-plan-4 P0.1).
//
// Every send used to open with "Use the vs-markdown-collab skill…". That is
// right for a Claude session with the skill installed and wrong for a headless
// run: there the skill text rides along as the system prompt, and a prompt that
// names a skill Claude can't find sends it looking for one instead of working.
// The opener is the only part of a prompt that differs between the two, so it is
// the only part that takes the parameter — everything after it keeps one code
// path, and a wording fix lands in both deliveries at once.
//
// Pure: imported by the vscode-free prompt builders.

import { FORMAT_SPEC_URL } from "./agents";

/**
 * `installed` — terminal and clipboard sends, read by whichever agent receives
 * them: Claude Code with the skill (as the plugin's `markdown-collab:review`,
 * or on older installs the standalone `vs-markdown-collab`), or any other agent.
 * `inline` — the skill text is the system prompt (headless runs).
 */
export type SkillDelivery = "installed" | "inline";

/**
 * The words every send prompt opens with. The caller finishes the sentence.
 *
 * The prompt is built before anything knows which agent will read it, so the
 * installed opener words each path by what the reader has: the skill (by both
 * of its names) for Claude Code, otherwise the "Markdown review comments"
 * section Connect an Agent wrote into AGENTS.md, otherwise the format spec.
 * It ends on a dash so every caller's "to address…", "in Review Mode…" or
 * "on `file`" continues it.
 */
export function workflowOpener(delivery: SkillDelivery = "installed"): string {
  if (delivery === "inline") {
    return "Follow the Markdown Collab review workflow in your instructions";
  }
  return (
    "Use the Markdown Collab review skill (`markdown-collab:review`, or `vs-markdown-collab` on older installs) — " +
    "or, if you don't have it, follow the \"Markdown review comments\" section of this workspace's AGENTS.md " +
    `(if it has none, the format is defined at ${FORMAT_SPEC_URL}) —`
  );
}
