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

/**
 * `installed` — the skill is installed in Claude Code (terminal, clipboard):
 *   as the plugin's `markdown-collab:review`, or on older installs as the
 *   standalone `vs-markdown-collab` in `~/.claude/skills/`.
 * `inline` — the skill text is the system prompt (headless runs).
 */
export type SkillDelivery = "installed" | "inline";

/**
 * The words every send prompt opens with. The caller finishes the sentence.
 *
 * The prompt is built before anything knows which agent will read it —
 * terminal and clipboard delivery reach Cursor, Codex, and Copilot as well
 * as Claude Code since "Connect an Agent" — so the opener names both paths
 * in one breath: the skill for Claude Code (by both of its names, since a
 * session has whichever Set Up Claude Code managed to install), the MCP
 * tools or the `mdc` CLI for anything else. Each agent recognises its own
 * half and ignores the other.
 */
export function workflowOpener(delivery: SkillDelivery = "installed"): string {
  if (delivery === "inline") {
    return "Follow the Markdown Collab review workflow in your instructions";
  }
  return "Use the Markdown Collab review skill (`markdown-collab:review`, or `vs-markdown-collab` on older installs) — or, if you are not Claude Code, the `markdown-collab` MCP tools or the `mdc` CLI —";
}
