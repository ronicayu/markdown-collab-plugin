// The name the UI uses for the AI agent on the other side of a review.
//
// The plugin started out Claude-only and is now agent-agnostic, so every
// user-visible "Claude" goes through here. Pure — no `vscode`, no DOM — so the
// host, both webview bundles and the unit tests share it. Each bundle holds its
// own copy of the module state: the host sets it from the
// `markdownCollab.agentName` setting and ships the value to the webviews in
// their state messages, where they call `setAgentName`.
//
// Deliberately NOT routed through here: the on-disk author id (`"claude"`,
// part of the file format), command IDs, and labels for features that only
// exist for Claude Code (its terminal, skill install and MCP channel).

export const DEFAULT_AGENT_NAME = "Claude";

const MAX_LENGTH = 40;

let current = DEFAULT_AGENT_NAME;

/** Trim and bound a raw setting value; blank or non-string falls back to the default. */
export function normalizeAgentName(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_AGENT_NAME;
  const trimmed = raw.replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH).trim();
  return trimmed || DEFAULT_AGENT_NAME;
}

export function agentName(): string {
  return current;
}

/** Returns true when the name actually changed (callers re-render on that). */
export function setAgentName(raw: unknown): boolean {
  const next = normalizeAgentName(raw);
  if (next === current) return false;
  current = next;
  return true;
}
