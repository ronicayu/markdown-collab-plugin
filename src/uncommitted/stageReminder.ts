/**
 * The stage-time reminder's once-per-file gate. Staging a file that still
 * carries review threads gets one nudge toward "Remove All Review Data" —
 * never an automatic finalize, because threads live across days on purpose.
 * "Once per session" means once per instance of this gate: the controller owns
 * one, so a window reload starts fresh.
 */
export class SessionThreadReminderGate {
  private readonly remindedKeys = new Set<string>();

  /**
   * True the first time `key` is passed, until `reset`. Marks `key` as seen as
   * a side effect, so callers must act on a `true` result immediately.
   */
  shouldRemind(key: string): boolean {
    if (this.remindedKeys.has(key)) return false;
    this.remindedKeys.add(key);
    return true;
  }

  reset(key?: string): void {
    if (key === undefined) this.remindedKeys.clear();
    else this.remindedKeys.delete(key);
  }
}
