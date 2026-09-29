// Guards for Connect an Agent (10x-plan-4 P1.1):
//   - which quick-pick entries show up for a given host's capabilities;
//   - `engines.vscode` stays low so Cursor/Windsurf/VSCodium users aren't
//     locked out by a feature only some hosts have (feature-detected instead,
//     see `hasCursorInAppApi` / `hasCopilotProviderApi`);
//   - the command and the provider contribution point are actually declared.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { buildConnectAgentItems, buildDisconnectAgentItems } from "../commands/setup";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));

describe("buildConnectAgentItems", () => {
  it("always offers Claude Code, Cursor CLI, Codex, and the generic fallback", () => {
    const ids = buildConnectAgentItems({ cursorInApp: false, copilot: false }).map((i) => i.id);
    expect(ids).toEqual(["claude", "cursor-cli", "codex", "other"]);
  });

  it("adds Cursor's in-app agent only when that API exists", () => {
    const ids = buildConnectAgentItems({ cursorInApp: true, copilot: false }).map((i) => i.id);
    expect(ids).toContain("cursor-inapp");
  });

  it("adds Copilot only when that API exists", () => {
    const ids = buildConnectAgentItems({ cursorInApp: false, copilot: true }).map((i) => i.id);
    expect(ids).toContain("copilot");
  });

  it("offers every entry when every capability is present, in a stable order", () => {
    const ids = buildConnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id);
    expect(ids).toEqual(["claude", "cursor-inapp", "cursor-cli", "codex", "copilot", "other"]);
  });

  it("every item carries a one-line, non-empty description", () => {
    for (const item of buildConnectAgentItems({ cursorInApp: true, copilot: true })) {
      expect(item.description).toBeTruthy();
      expect(item.description).not.toContain("\n");
    }
  });

  // 1.1: Connect an Agent → Claude Code is the one setup front door now — its
  // description has to say it does both the plugin install and the
  // `.mcp.json` registration, not just the latter.
  it("the Claude Code item's description names both the plugin and .mcp.json", () => {
    const claude = buildConnectAgentItems({ cursorInApp: false, copilot: false }).find(
      (i) => i.id === "claude",
    )!;
    expect(claude.description).toMatch(/plugin/i);
    expect(claude.description).toMatch(/\.mcp\.json/);
  });
});

// 4.4: "Connect an Agent has no inverse" — same guard shape as
// buildConnectAgentItems above, for the QuickPick that undoes it.
describe("buildDisconnectAgentItems", () => {
  it("always offers Claude Code, Cursor CLI, Codex, and Other", () => {
    const ids = buildDisconnectAgentItems({ cursorInApp: false, copilot: false }).map((i) => i.id);
    expect(ids).toEqual(["claude", "cursor-cli", "codex", "other"]);
  });

  it("adds Cursor's in-app agent and Copilot only when those APIs exist — same gating as Connect", () => {
    const withBoth = buildDisconnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id);
    expect(withBoth).toEqual(["claude", "cursor-inapp", "cursor-cli", "codex", "copilot", "other"]);
  });

  it("every item's detail says exactly what running it removes", () => {
    for (const item of buildDisconnectAgentItems({ cursorInApp: true, copilot: true })) {
      expect(item.detail, `${item.id} has no detail`).toBeTruthy();
    }
  });

  it("ids match buildConnectAgentItems' ids one for one", () => {
    const connectIds = buildConnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id).sort();
    const disconnectIds = buildDisconnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id).sort();
    expect(disconnectIds).toEqual(connectIds);
  });
});

describe("engines.vscode", () => {
  it("stays at ^1.80.0 — feature-detect Cursor/Copilot APIs instead of raising the floor", () => {
    expect(pkg.engines.vscode).toBe("^1.80.0");
  });

  it("the installed @types/vscode range is unchanged too", () => {
    expect(pkg.devDependencies["@types/vscode"]).toBe("^1.80.0");
  });
});

describe("package.json contributions", () => {
  it("declares the Connect an Agent command", () => {
    const command = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "markdownCollab.connectAgent",
    );
    expect(command).toBeTruthy();
    expect(command.title).toMatch(/Connect an Agent/);
  });

  it("still declares the Claude Code registration command as a working alias", () => {
    const command = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "markdownCollab.registerMcpServer",
    );
    expect(command).toBeTruthy();
  });

  it("declares the Disconnect Agent command (4.4)", () => {
    const command = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "markdownCollab.disconnectAgent",
    );
    expect(command).toBeTruthy();
    expect(command.title).toMatch(/Disconnect/i);
  });

  it("declares exactly one mcpServerDefinitionProviders entry, matching the Copilot provider id", () => {
    const providers = pkg.contributes.mcpServerDefinitionProviders;
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("markdownCollab.mcpServerDefinitionProvider");
    expect(providers[0].label).toBeTruthy();
  });
});
