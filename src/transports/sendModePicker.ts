// The "how should this reach Claude?" quick-pick, as data.
//
// Pulled out of `commands/send.ts` and kept vscode-free so the item list is
// unit-testable directly, and so the guard that every settings-enum value
// has a picker entry (and vice versa) can import this instead of parsing a
// live QuickPick.

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
  /**
   * The extension can run Claude itself: the binary resolved, the workspace is
   * trusted, the tool server is up, and headless hasn't failed here before.
   * Only then is it listed — an option that fails on click is worse than none.
   */
  headlessAvailable?: boolean;
}

/**
 * Terminal leads and always carries "recommended": it's the mode actually
 * used, not headless — headless was built
 * for "people who can't use a terminal", who can't sign in to Claude Code
 * either. It is *offered*, never chosen — this list only appears when
 * nothing was auto-detected, and picking stays the human's call. Headless, when
 * available, is listed second: a way to not
 * keep a terminal open, not the default path. Clipboard is last either way.
 *
 * The terminal item stays agent-neutral: the mode types into the
 * terminal the user is using, not necessarily Claude — "Connect an Agent" can
 * leave Cursor CLI or Codex running there instead.
 */
export function buildSendModeItems(opts: SendModePickerOptions): SendModePickerItem[] {
  const headless = opts.headlessAvailable === true;
  const terminal: SendModePickerItem = {
    label: "Type into the active terminal (recommended)",
    description: "Types the prompt into whatever's running there. Works everywhere.",
    detail: "Goes to the terminal you're using, if something is running in it.",
    mode: "terminal",
  };
  const clipboard: SendModePickerItem = {
    label: "Copy to clipboard",
    description: "Paste it into your agent yourself.",
    mode: "clipboard",
  };
  if (!headless) return [terminal, clipboard];
  return [
    terminal,
    {
      label: "Run Claude for me",
      description: "Claude works in the background if you'd rather not keep a terminal open.",
      detail:
        "Needs Claude Code installed and signed in. Claude can only read files and use the review tools — click the status bar to cancel.",
      mode: "headless",
    },
    clipboard,
  ];
}
