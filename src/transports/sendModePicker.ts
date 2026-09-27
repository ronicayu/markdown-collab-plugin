// The "how should this reach Claude?" quick-pick, as data (10x-plan-4 P0.3).
//
// Pulled out of `commands/send.ts` and kept vscode-free so the item list is
// unit-testable directly, and so the guard that every settings-enum value
// has a picker entry (and vice versa) can import this instead of parsing a
// live QuickPick. P0.1's fourth mode (`headless`) was one more entry here, not
// a second list to keep in sync — which is the point of this file.

import type { SendMode } from "../sendToClaude";

/** The modes this picker ever offers. `ask` isn't a delivery — it's what led here. */
export type PickerSendMode = Exclude<SendMode, "ask">;

export interface SendModePickerItem {
  label: string;
  description: string;
  /** Only set when there's something the human should know before picking. */
  detail?: string;
  mode: PickerSendMode;
}

export interface SendModePickerOptions {
  /** A visible terminal is already running Claude. */
  terminalDetected: boolean;
  /**
   * The extension can run Claude itself: the binary resolved, the workspace is
   * trusted, the tool server is up, and headless hasn't failed here before.
   * Only then is it listed — an option that fails on click is worse than none.
   */
  headlessAvailable?: boolean;
}

/**
 * Build the picker's items.
 *
 * With headless available it comes first and carries "recommended": it is the
 * one path that needs nothing else running. It is *offered*, never chosen —
 * this list only appears when nothing was auto-detected, and picking stays the
 * human's call (10x-plan-4's open question 1). Without it, terminal leads.
 *
 * `terminalDetected` is the same evidence `detectSendMode` uses — when it's
 * true the caller has already auto-selected terminal without asking, so in
 * practice this only ever runs with it false, but the parameter keeps the item
 * list honest (and testable) rather than hard-coding the "nothing detected"
 * wording as a constant.
 */
export function buildSendModeItems(opts: SendModePickerOptions): SendModePickerItem[] {
  const headless = opts.headlessAvailable === true;
  const terminal: SendModePickerItem = {
    label: headless ? "Send to your Claude terminal" : "Send to your Claude terminal (recommended)",
    description: "Types the prompt into your running Claude session. Works everywhere.",
    ...(opts.terminalDetected
      ? {}
      : { detail: "No Claude terminal detected — you'll be offered to start one." }),
    mode: "terminal",
  };
  const clipboard: SendModePickerItem = {
    label: "Copy to clipboard",
    description: "Paste it into Claude yourself.",
    mode: "clipboard",
  };
  if (!headless) return [terminal, clipboard];
  return [
    {
      label: "Run Claude for me — recommended",
      description: "Claude works in the background; progress shows in the status bar.",
      detail: "Claude can only read files and use the review tools. Click the status bar to cancel.",
      mode: "headless",
    },
    terminal,
    clipboard,
  ];
}
