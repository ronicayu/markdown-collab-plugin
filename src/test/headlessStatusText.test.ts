// The status bar and toasts for a headless run (10x-plan-4 P0.1). Every state
// a run can be in has one rendering, pinned here — including the two that
// render as nothing, which is a decision too.

import { describe, expect, it } from "vitest";
import {
  firstLine,
  formatElapsed,
  headlessDoneToast,
  headlessReportDocument,
  headlessReportFooter,
  headlessStatusBar,
} from "../headlessStatusText";
import type { HeadlessState } from "../transports/headless";

const FILE = "docs/guide.md";
const T0 = 1_000_000;

describe("formatElapsed", () => {
  it("reads like a stopwatch", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(42_900)).toBe("42s");
    expect(formatElapsed(80_000)).toBe("1m 20s");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59m 59s");
    expect(formatElapsed(65 * 60_000)).toBe("1h 05m");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("headlessStatusBar", () => {
  it("starting: spins, names the file, and starts the clock", () => {
    const view = headlessStatusBar({ kind: "starting", startedAt: T0, toolCount: 0 }, FILE, T0 + 3000)!;
    expect(view.text).toBe(`$(loading~spin) Claude is reviewing ${FILE} · 3s`);
    expect(view.tooltip).toContain("Starting Claude Code");
  });

  it("working: the elapsed time, and the last tool without its prefix in the tooltip", () => {
    const state: HeadlessState = {
      kind: "working",
      startedAt: T0,
      toolCount: 3,
      lastTool: "mc_open",
    };
    const view = headlessStatusBar(state, FILE, T0 + 80_000)!;
    expect(view.text).toBe(`$(loading~spin) Claude is reviewing ${FILE} · 1m 20s`);
    expect(view.tooltip).toContain("Last tool: mc_open · 3 tool calls");
    expect(view.tooltip).not.toContain("mcp__");
    expect(view.tooltip).toMatch(/cancel/i);
  });

  it("working, before any tool call", () => {
    const view = headlessStatusBar({ kind: "working", startedAt: T0, toolCount: 0 }, FILE, T0)!;
    expect(view.tooltip).toContain("no tool calls yet");
  });

  it("an mc_status phase replaces 'is reviewing <file>'", () => {
    const view = headlessStatusBar(
      { kind: "working", startedAt: T0, toolCount: 1, lastTool: "mc_status", phase: "reading 2 of 3 files" },
      FILE,
      T0 + 5000,
    )!;
    expect(view.text).toBe("$(loading~spin) Claude: reading 2 of 3 files · 5s");
    expect(view.tooltip).toContain("1 tool call");
    expect(view.tooltip).not.toContain("1 tool calls");
  });

  it("done: a check mark and the file", () => {
    const view = headlessStatusBar(
      { kind: "done", startedAt: T0, endedAt: T0 + 9000, toolCount: 4, text: "ok" },
      FILE,
      T0 + 9000,
    )!;
    expect(view.text).toBe(`$(check) Claude finished ${FILE}`);
    expect(view.text).not.toContain("loading");
  });

  it("failed: a warning that points at the logs", () => {
    const view = headlessStatusBar(
      { kind: "failed", startedAt: T0, endedAt: T0 + 1, toolCount: 0, reason: "exit", detail: "Claude Code exited with code 1 before finishing\nmore" },
      FILE,
      T0 + 1,
    )!;
    expect(view.text).toBe("$(warning) Claude run failed");
    expect(view.tooltip).toContain("exited with code 1");
    expect(view.tooltip).not.toContain("more");
    expect(view.tooltip).toMatch(/show logs/i);
  });

  it("a timeout is a warning; a cancel the human asked for is nothing", () => {
    const base = { kind: "cancelled" as const, startedAt: T0, endedAt: T0 + 1, toolCount: 2 };
    expect(headlessStatusBar({ ...base, reason: "timeout" }, FILE, T0)!.text).toBe("$(warning) Claude run timed out");
    expect(headlessStatusBar({ ...base, reason: "user" }, FILE, T0)).toBeNull();
  });
});

describe("done toast and report", () => {
  it("the toast is Claude's first line, capped at 160 characters", () => {
    expect(headlessDoneToast(FILE, "\n\n**guide.md** — opened 2 threads.\nDetails…")).toBe(
      "**guide.md** — opened 2 threads.",
    );
    const long = "x".repeat(400);
    expect(headlessDoneToast(FILE, long)).toHaveLength(160);
    expect(headlessDoneToast(FILE, long).endsWith("…")).toBe(true);
    expect(headlessDoneToast(FILE, "   ")).toBe(`Claude finished ${FILE}.`);
    expect(firstLine("a\nb", 10)).toBe("a");
  });

  it("the report carries the full text and a footer with turns and an estimated cost", () => {
    const doc = headlessReportDocument("Line one.\n\nLine two.", 7, 0.4217);
    expect(doc).toContain("Line one.\n\nLine two.");
    expect(doc.trimEnd().endsWith("7 turns · ~$0.42 (estimate)")).toBe(true);
    expect(headlessReportFooter(1, undefined)).toBe("1 turn");
    expect(headlessReportFooter(undefined, 0.001)).toBe("~$0.00 (estimate)");
    expect(headlessReportDocument("", undefined, undefined)).toContain("without a written report");
  });
});
