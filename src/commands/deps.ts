// Shared wiring every command family needs (10x-plan-4 P3.2).
//
// `extension.ts` builds one `CommandDeps` in `activate()` and hands it to each
// family's `registerXCommands`. The alternative — each family reaching back
// into `extension.ts` for its logger, its tracker, its maps — would make every
// family a second entry point instead of a leaf that only needs what it's
// given.

import * as vscode from "vscode";
import type { Logger } from "../logging";
import type { ReviewView } from "../reviewView";
import type { TerminalTracker } from "../transports/terminalTracker";
import type { OpenReviewView } from "./reviewViewRouter";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  rootLog: Logger;
  /** `rootLog.scope("activation")` — the scope `activate()` itself logs under. */
  log: Logger;
  reviewLog: Logger;
  sendLog: Logger;
  skillLog: Logger;
  formatLog: Logger;
  diagnosticsLog: Logger;
  terminalTracker: TerminalTracker;
  reviewView: ReviewView;
  /**
   * The one way into the review view, used by the commands, the explorer
   * menus, and the source-editor affordances (hover link, unread walk). `opts`
   * can land it on a thread, overlay the diff, or pick the first thread an
   * agent opened — see src/commands/reviewViewRouter.ts.
   */
  openReviewView: OpenReviewView;
}
