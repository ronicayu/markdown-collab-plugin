// The "how should this reach Claude?" quick-pick, as data (10x-plan-4 P0.3).
//
// Pulled out of `commands/send.ts` and kept vscode-free so the item list is
// unit-testable directly, and so the guard that every settings-enum value
// has a picker entry (and vice versa) can import this instead of parsing a
// live QuickPick. A later initiative adds a fourth mode (`headless`) — the
// point of this file existing on its own is that adding one is one more
// entry in `buildSendModeItems`, not a second list to keep in sync.

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

/**
 * Build the picker's items, terminal first.
 *
 * `terminalDetected` is the same evidence `detectSendMode` uses — when it's
 * true the caller has already auto-selected terminal without asking, so in
 * practice this only ever runs with it false, but the parameter keeps the
 * item list honest (and testable) rather than hard-coding the "nothing
 * detected" wording as a constant.
 */
export function buildSendModeItems(opts: { terminalDetected: boolean }): SendModePickerItem[] {
  return [
    {
      label: "Send to your Claude terminal (recommended)",
      description: "Types the prompt into your running Claude session. Works everywhere.",
      ...(opts.terminalDetected
        ? {}
        : { detail: "No Claude terminal detected — you'll be offered to start one." }),
      mode: "terminal",
    },
    {
      label: "Copy to clipboard",
      description: "Paste it into Claude yourself.",
      mode: "clipboard",
    },
  ];
}
