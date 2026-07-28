import { describe, expect, it } from "vitest";
import { CHANGE_HINT, detectSendMode } from "../transports/detectSendMode";

describe("detectSendMode", () => {
  it("uses the terminal when a claude REPL is running", () => {
    const d = detectSendMode({ claudeTerminal: true, mcpChannelEndpoint: false })!;
    expect(d.mode).toBe("terminal");
    expect(d.reason).toMatch(/terminal/i);
  });

  it("uses the MCP channel when its endpoint exists and no terminal does", () => {
    const d = detectSendMode({ claudeTerminal: false, mcpChannelEndpoint: true })!;
    expect(d.mode).toBe("mcp-channel");
    expect(d.reason).toMatch(/channel/i);
  });

  it("prefers the terminal when both are available", () => {
    // The terminal is live evidence; an endpoint file can outlive its server.
    const d = detectSendMode({ claudeTerminal: true, mcpChannelEndpoint: true })!;
    expect(d.mode).toBe("terminal");
  });

  it("returns null when nothing is detected, so the caller still asks", () => {
    expect(detectSendMode({ claudeTerminal: false, mcpChannelEndpoint: false })).toBeNull();
  });

  it("never auto-selects a mode that needs manual setup", () => {
    // channel (tail loop) and clipboard both require the human to do something
    // afterwards, so they must stay explicit choices.
    for (const claudeTerminal of [true, false]) {
      for (const mcpChannelEndpoint of [true, false]) {
        const d = detectSendMode({ claudeTerminal, mcpChannelEndpoint });
        if (!d) continue;
        expect(["terminal", "mcp-channel"]).toContain(d.mode);
      }
    }
  });

  it("names the escape hatch in the change hint", () => {
    expect(CHANGE_HINT).toMatch(/Reset Send Mode/);
  });
});
