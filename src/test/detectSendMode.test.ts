import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
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

  // Ronica's constraint on the extension-hosted MCP server (10x-plan-2 P0):
  // support MCP, never default to it. MCP can be disabled entirely on Claude's
  // side — enterprise policy, --strict-mcp-config, user config — so a mode that
  // gets chosen *for* the user silently breaks for those setups. It is offered
  // in the picker and used only after an explicit pick.
  it("never auto-selects the mcp tool mode, whatever is running", () => {
    for (const claudeTerminal of [true, false]) {
      for (const mcpChannelEndpoint of [true, false]) {
        expect(detectSendMode({ claudeTerminal, mcpChannelEndpoint })?.mode).not.toBe("mcp");
      }
    }
  });

  it("takes no evidence about the tool server at all", () => {
    // The evidence type is the enforcement: detection can't prefer a server it
    // is never told about.
    const evidence: Record<string, boolean> = { claudeTerminal: false, mcpChannelEndpoint: false };
    expect(Object.keys(evidence).some((k) => /mcpServer|toolServer/i.test(k))).toBe(false);
    const source = readFileSync(resolve(__dirname, "../transports/detectSendMode.ts"), "utf8");
    expect(source).not.toMatch(/mode:\s*"mcp"/);
  });
});
