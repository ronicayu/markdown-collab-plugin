import { describe, expect, it } from "vitest";
import { CHANGE_HINT, detectSendMode } from "../transports/detectSendMode";

describe("detectSendMode", () => {
  it("uses the terminal when a claude REPL is running", () => {
    const d = detectSendMode({ claudeTerminal: true })!;
    expect(d.mode).toBe("terminal");
    expect(d.reason).toBe("Claude is running in a terminal.");
  });

  it("returns null when nothing is detected, so the caller still asks", () => {
    expect(detectSendMode({ claudeTerminal: false })).toBeNull();
  });

  it("names the escape hatch in the change hint", () => {
    expect(CHANGE_HINT).toMatch(/Reset Send Mode/);
  });

  it("never auto-selects a mode that needs manual setup", () => {
    // clipboard requires the human to do something afterwards, so it must
    // stay an explicit choice — detection only ever picks terminal.
    for (const claudeTerminal of [true, false]) {
      const d = detectSendMode({ claudeTerminal });
      if (!d) continue;
      expect(d.mode).toBe("terminal");
    }
  });
});
