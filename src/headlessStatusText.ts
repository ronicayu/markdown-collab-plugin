// What a headless run looks like in the status bar and its toasts
// (10x-plan-4 P0.1).
//
// A headless run is the one send mode where the extension knows — rather than
// guesses — that Claude is working: it owns the process and reads its event
// stream. So this is the one place the status bar may say "Claude is
// reviewing" in so many words, with a clock on it. The module-header rule in
// claudeStatusBar.ts still holds for every other mode: a terminal send never
// earns this text, because nothing there is observed.
//
// Pure: the status bar module feeds it a state and a clock.

import type { HeadlessState } from "./transports/headless";

/** `42s`, `1m 20s`, `1h 05m` — the elapsed part of the status bar text. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface HeadlessStatusView {
  text: string;
  tooltip: string;
}

/**
 * The status bar item for a run in `state`, or null when it should step aside
 * (a cancel the human asked for needs no announcement).
 */
export function headlessStatusBar(
  state: HeadlessState,
  fileLabel: string,
  now: number,
): HeadlessStatusView | null {
  switch (state.kind) {
    case "starting":
    case "working": {
      const elapsed = formatElapsed(now - state.startedAt);
      const phase = state.kind === "working" ? state.phase : undefined;
      // An `mc_status` phase is Claude's own words for what it is doing, and
      // says more than the file name does.
      const doing = phase ? `Claude: ${phase}` : `Claude is reviewing ${fileLabel}`;
      const lines = [`Claude is reviewing ${fileLabel} in the background.`];
      if (state.kind === "starting") lines.push("Starting Claude Code…");
      else if (state.lastTool) {
        lines.push(
          `Last tool: ${state.lastTool} · ${state.toolCount} tool call${state.toolCount === 1 ? "" : "s"}`,
        );
      } else lines.push("Reading — no tool calls yet.");
      lines.push("Click to cancel, show logs, or open the review view.");
      return { text: `$(loading~spin) ${doing} · ${elapsed}`, tooltip: lines.join("\n") };
    }
    case "done":
      return {
        text: `$(check) Claude finished ${fileLabel}`,
        tooltip: `Claude finished reviewing ${fileLabel}. Click to open the review view.`,
      };
    case "failed":
      return {
        text: "$(warning) Claude run failed",
        tooltip: `The Claude run on ${fileLabel} failed: ${firstLine(state.detail, 200)}\nClick to show logs.`,
      };
    case "cancelled":
      if (state.reason === "user") return null;
      return {
        text: "$(warning) Claude run timed out",
        tooltip: `The Claude run on ${fileLabel} ran past its time budget and was stopped. Click to show logs.`,
      };
  }
}

/** First non-empty line of `text`, capped at `max` characters. */
export function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The done toast: Claude's own first line, short enough for a notification. */
export function headlessDoneToast(fileLabel: string, text: string): string {
  const head = firstLine(text, 160);
  return head ? head : `Claude finished ${fileLabel}.`;
}

/**
 * The report's footer. The cost is Claude Code's own estimate, and labelled as
 * one — it is not what a subscription bills.
 */
export function headlessReportFooter(numTurns?: number, costUsd?: number): string {
  const parts: string[] = [];
  if (numTurns !== undefined) parts.push(`${numTurns} turn${numTurns === 1 ? "" : "s"}`);
  if (costUsd !== undefined) parts.push(`~$${costUsd.toFixed(2)} (estimate)`);
  return parts.join(" · ");
}

/** The "Show report" document: Claude's final message plus the footer. */
export function headlessReportDocument(text: string, numTurns?: number, costUsd?: number): string {
  const footer = headlessReportFooter(numTurns, costUsd);
  const body = text.trim() || "_Claude finished without a written report._";
  return footer ? `${body}\n\n---\n\n${footer}\n` : `${body}\n`;
}
