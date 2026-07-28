// Pick a send mode from what's actually running (10x-plan P3.1).
//
// The first "Send to Claude" click used to open a four-way quick-pick whose
// options the README needs a comparison table to explain — terminal vs event
// log vs MCP channel vs clipboard — before the user has any way to know which
// of them their setup supports. Most of the time the environment answers the
// question: a `claude` REPL is running in a terminal, or the MCP channel
// server has written its endpoint file. Detect that, use it, and say so.
//
// Pure: the caller supplies the two facts, so the policy is testable and the
// probing stays in the transports.

import type { SendMode } from "../sendToClaude";

export interface SendModeEvidence {
  /** A visible terminal has a `claude` REPL running in it. */
  claudeTerminal: boolean;
  /** The MCP channel server has written a usable endpoint descriptor. */
  mcpChannelEndpoint: boolean;
}

export interface SendModeDetection {
  mode: SendMode;
  /** One line for the toast — what was detected and how to change it. */
  reason: string;
}

/**
 * The mode to use without asking, or null when nothing is detected and the
 * user has to be shown the quick-pick after all.
 *
 * Terminal wins over the MCP channel when both are present: the terminal is
 * live evidence (a shell-integration event fired for a running `claude`),
 * whereas the endpoint file can outlive the server that wrote it. A stale
 * choice there is recoverable — the caller falls back to asking when the push
 * reports the server isn't running — but the cheaper signal should not be the
 * first guess.
 */
export function detectSendMode(evidence: SendModeEvidence): SendModeDetection | null {
  if (evidence.claudeTerminal) {
    return {
      mode: "terminal",
      reason: "Sent to your running Claude terminal.",
    };
  }
  if (evidence.mcpChannelEndpoint) {
    return {
      mode: "mcp-channel",
      reason: "Sent via the MCP channel to your Claude session.",
    };
  }
  return null;
}

/** The suffix appended to a detection toast, naming the escape hatch. */
export const CHANGE_HINT =
  ' Run "Markdown Collab: Reset Send Mode" to pick a different one.';
