// The stage-time reminder's once-per-file-per-session gate.

import { describe, expect, it } from "vitest";
import { SessionThreadReminderGate } from "../uncommitted/stageReminder";

describe("SessionThreadReminderGate", () => {
  it("reminds the first time a file is staged", () => {
    const gate = new SessionThreadReminderGate();
    expect(gate.shouldRemind("guide.md")).toBe(true);
  });

  it("never reminds twice for the same file in one session", () => {
    const gate = new SessionThreadReminderGate();
    expect(gate.shouldRemind("guide.md")).toBe(true);
    expect(gate.shouldRemind("guide.md")).toBe(false);
    expect(gate.shouldRemind("guide.md")).toBe(false);
  });

  it("tracks each file independently", () => {
    const gate = new SessionThreadReminderGate();
    expect(gate.shouldRemind("a.md")).toBe(true);
    expect(gate.shouldRemind("b.md")).toBe(true);
    expect(gate.shouldRemind("a.md")).toBe(false);
    expect(gate.shouldRemind("b.md")).toBe(false);
  });

  it("re-arms one key on reset(key), leaving the others reminded", () => {
    const gate = new SessionThreadReminderGate();
    gate.shouldRemind("a.md");
    gate.shouldRemind("b.md");
    gate.reset("a.md");
    expect(gate.shouldRemind("a.md")).toBe(true);
    expect(gate.shouldRemind("b.md")).toBe(false);
  });

  it("re-arms every key on reset()", () => {
    const gate = new SessionThreadReminderGate();
    gate.shouldRemind("a.md");
    gate.shouldRemind("b.md");
    gate.reset();
    expect(gate.shouldRemind("a.md")).toBe(true);
    expect(gate.shouldRemind("b.md")).toBe(true);
  });
});
