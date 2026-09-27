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
 * `installed` — the skill lives in `~/.claude/skills/` (terminal, clipboard).
 * `inline` — the skill text is the system prompt (headless runs).
 */
export type SkillDelivery = "installed" | "inline";

/** The words every send prompt opens with. The caller finishes the sentence. */
export function workflowOpener(delivery: SkillDelivery = "installed"): string {
  return delivery === "inline"
    ? "Follow the Markdown Collab review workflow in your instructions"
    : "Use the vs-markdown-collab skill";
}
