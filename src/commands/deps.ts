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
import type { EventLog } from "../transports/eventLog";
import type { TerminalTracker } from "../transports/terminalTracker";

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
  eventLogs: Map<string, EventLog>;
  /**
   * One way into the review view, used by the command, the explorer menus, and
   * the source-editor affordances (hover link, unread walk). `opts` carries an
   * optional scroll target so a caller can land on a specific thread.
   */
  openInlineView: (
    uri: vscode.Uri,
    opts?: { line?: number; showDiff?: boolean },
  ) => Promise<void>;
  /**
   * Open the review view scrolled to one thread. The source line of the
   * thread's anchor is the scroll target, so this reuses the panel's existing
   * line-based reveal rather than adding a second addressing scheme.
   */
  revealThread: (uri: vscode.Uri, threadId: string) => Promise<void>;
}
