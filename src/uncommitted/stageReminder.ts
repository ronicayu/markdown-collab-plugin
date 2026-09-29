/**
 * The stage-time reminder's once-per-file gate (10x-plan-6 P5.1).
 *
 * Staging a file that still carries review threads gets one nudge toward
 * "Remove All Review Data" — never an automatic finalize, because threads
 * live across days on purpose and the file is the maintainer's to strip when
 * *they* decide it's done. "Once per file per session" means once per file
 * per instance of this gate: the controller owns one for its own lifetime,
 * so a window reload starts fresh, but staging the same file twice in one
 * session only prompts the first time.
 *
 * Pure and vscode-free so the gate itself is unit-testable without a tree
 * view or a webview around it.
 */
export class SessionThreadReminderGate {
  private readonly remindedKeys = new Set<string>();

  /**
   * True the first time `key` is passed; false on every later call for the
   * same key, until `reset`. Marks `key` as seen as a side effect — callers
   * are expected to act on a `true` result immediately (show the toast),
   * since asking again without showing anything would silently burn the
   * one reminder this file gets.
   */
  shouldRemind(key: string): boolean {
    if (this.remindedKeys.has(key)) return false;
    this.remindedKeys.add(key);
    return true;
  }

  /** Re-arms one key, or every key when none is given. Test hook. */
  reset(key?: string): void {
    if (key === undefined) this.remindedKeys.clear();
    else this.remindedKeys.delete(key);
  }
}
