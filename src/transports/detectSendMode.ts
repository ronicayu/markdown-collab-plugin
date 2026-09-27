// Pick a send mode from what's actually running (10x-plan P3.1).
//
// The first "Send to Claude" click used to open a quick-pick whose options
// needed a comparison table to explain before the user had any way to know
// which their setup supported. Most of the time the environment answers the
// question: a `claude` REPL is already running in a terminal. Detect that,
// use it, and say so.
//
// Pure: the caller supplies the fact, so the policy is testable and the
// probing stays in the transports.

import type { SendMode } from "../sendToClaude";

export interface SendModeEvidence {
  /** A visible terminal has a `claude` REPL running in it. */
  claudeTerminal: boolean;
}

export interface SendModeDetection {
  mode: SendMode;
  /** One line for the toast — what was detected and how to change it. */
  reason: string;
}

/**
 * The mode to use without asking, or null when nothing is detected and the
 * user has to be shown the quick-pick after all.
 */
export function detectSendMode(evidence: SendModeEvidence): SendModeDetection | null {
  if (evidence.claudeTerminal) {
    return {
      mode: "terminal",
      reason: "Sent to your running Claude terminal.",
    };
  }
  return null;
}

/** The suffix appended to a detection toast, naming the escape hatch. */
export const CHANGE_HINT =
  ' Run "Markdown Collab: Reset Send Mode" to pick a different one.';
