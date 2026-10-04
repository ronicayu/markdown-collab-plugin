export type Activity = "running" | "idle" | "unknown";

export type ShellEvent = { kind: "start"; command: string } | { kind: "end" };

export interface TerminalCandidate<T> {
  terminal: T;
  name: string;
  activity: Activity;
  command?: string;
}

export type TargetDecision<T> =
  | { kind: "none" }
  | { kind: "idle" }
  | { kind: "send"; terminal: T }
  | { kind: "confirm"; terminal: T }
  | { kind: "pick"; terminals: TerminalCandidate<T>[] };

const PLAIN_SHELL_RE = /^-?(zsh|bash|sh|fish|pwsh|powershell|cmd|nu|ksh|csh|tcsh|dash)(\.exe)?$/i;

export function terminalActivity(event: ShellEvent | undefined, name: string): Activity {
  if (event) return event.kind === "start" ? "running" : "idle";
  // Titles follow the foreground process, so a non-shell title means something was started before we activated.
  return PLAIN_SHELL_RE.test(name.trim()) ? "unknown" : "running";
}

export function chooseTarget<T>(
  terminals: TerminalCandidate<T>[],
  active: T | undefined,
  lastTarget: T | undefined,
): TargetDecision<T> {
  if (terminals.length === 0) return { kind: "none" };

  const activeCandidate = terminals.find((c) => c.terminal === active);
  if (activeCandidate?.activity === "running") return { kind: "send", terminal: activeCandidate.terminal };

  const last = terminals.find((c) => c.terminal === lastTarget);
  if (last && last.activity !== "idle") return { kind: "send", terminal: last.terminal };

  const running = terminals.filter((c) => c.activity === "running");
  if (running.length === 1) return { kind: "send", terminal: running[0]!.terminal };
  if (running.length > 1) return { kind: "pick", terminals: running };

  if (activeCandidate?.activity === "unknown") return { kind: "confirm", terminal: activeCandidate.terminal };
  return { kind: "idle" };
}
