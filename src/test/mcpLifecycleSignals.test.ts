// The mapping from tool calls to lifecycle signals (10x-plan-2 P0.2).
//
// `pendingSignalsFromToolCalls` lives in a vscode-importing module, so this
// tests the rule it encodes against the tracker directly — the same three
// transitions, asserted where they're observable: a call means active, a status
// beacon names the phase, and the closing check ends the pass.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ClaudePendingTracker, type PendingInputThread } from "../inlineComments/claudePending";

const DOC = "file:///ws/guide.md";
const threads: PendingInputThread[] = [{ id: "a1", status: "open", comments: [{ author: "ronica" }] }];

/** The rule under test, applied to a tracker instance. */
function applySignal(
  tracker: ClaudePendingTracker,
  event: { tool: string; file?: string; note?: string },
): void {
  if (event.tool === "mc_status") {
    if (event.file) tracker.noteActivity(event.file, { phase: event.note });
    else tracker.noteActivityEverywhere({ phase: event.note });
    return;
  }
  if (!event.file) return;
  if (event.tool === "mc_check") tracker.noteComplete(event.file);
  else tracker.noteActivity(event.file);
}

function tracker(): ClaudePendingTracker {
  const t = new ClaudePendingTracker();
  t.mark(DOC, threads, ["a1"], "protocol");
  return t;
}

describe("tool calls as lifecycle signals", () => {
  it("any document tool means Claude is working on that file", () => {
    const t = tracker();
    expect(t.status(DOC, threads).active).toBe(false);
    applySignal(t, { tool: "mc_list", file: DOC });
    expect(t.status(DOC, threads).active).toBe(true);
    t.dispose();
  });

  it("mc_status names the phase without being a document edit", () => {
    const t = tracker();
    applySignal(t, { tool: "mc_status", file: DOC, note: "opening threads" });
    expect(t.status(DOC, threads).phase).toBe("opening threads");
    t.dispose();
  });

  it("mc_check ends the pass — the skill runs it last on every file", () => {
    const t = tracker();
    applySignal(t, { tool: "mc_reply", file: DOC });
    expect(t.pending(DOC, threads)).toEqual(["a1"]);
    applySignal(t, { tool: "mc_check", file: DOC });
    expect(t.pending(DOC, threads)).toEqual([]);
    t.dispose();
  });

  it("a fileless status reaches every waiting document", () => {
    const t = tracker();
    const other = "file:///ws/other.md";
    t.mark(other, threads, ["a1"], "protocol");
    applySignal(t, { tool: "mc_status", note: "reading 2 of 3 files" });
    expect(t.status(DOC, threads).phase).toBe("reading 2 of 3 files");
    expect(t.status(other, threads).phase).toBe("reading 2 of 3 files");
    t.dispose();
  });

  it("a fileless non-status call is not a signal about anything", () => {
    const t = tracker();
    applySignal(t, { tool: "mc_list" });
    expect(t.status(DOC, threads).active).toBe(false);
    t.dispose();
  });
});

describe("the host wires the same rule", () => {
  // The implementation under test lives next to `vscode`, so this pins the two
  // copies together rather than letting the tested rule drift from the shipped
  // one.
  const source = readFileSync(resolve(__dirname, "../mcpServer/index.ts"), "utf8");

  it("routes mc_check to completion and everything else to activity", () => {
    expect(source).toMatch(/mc_check.*noteComplete|noteComplete\(/s);
    expect(source).toMatch(/noteActivity\(/);
    expect(source).toMatch(/noteActivityEverywhere\(/);
  });

  it("is fed by the server's onToolCall hook", () => {
    const extension = readFileSync(resolve(__dirname, "../extension.ts"), "utf8");
    expect(extension).toMatch(/onToolCall:\s*pendingSignalsFromToolCalls/);
  });

  it("marks protocol evidence only for the mcp send mode", () => {
    const extension = readFileSync(resolve(__dirname, "../extension.ts"), "utf8");
    expect(extension).toMatch(/markPayloadPending\(payload, folder, mode === "mcp" \? "protocol" : "inferred"\)/);
  });
});
