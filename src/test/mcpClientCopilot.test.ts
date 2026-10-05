// GitHub Copilot's MCP server definition provider. Runs
// against the vscode stub (`src/test/vscode-stub.ts`, extended with a minimal
// `McpHttpServerDefinition`) rather than a real extension host, since the
// class only touches `EventEmitter`, `Uri.parse`, and that one constructor.

import { describe, expect, it, vi } from "vitest";
import { CopilotMcpProvider } from "../mcpServer/clients/copilot";

describe("CopilotMcpProvider", () => {
  it("provides nothing before Connect an Agent → Copilot has run", () => {
    const provider = new CopilotMcpProvider();
    expect(provider.isConnected()).toBe(false);
    expect(provider.provideMcpServerDefinitions()).toEqual([]);
  });

  it("still provides nothing when connected but no server is live yet", () => {
    const provider = new CopilotMcpProvider();
    provider.setConnected(true);
    expect(provider.provideMcpServerDefinitions()).toEqual([]);
  });

  it("provides exactly one HTTP definition, with the right URL and bearer header, once connected and live", () => {
    const provider = new CopilotMcpProvider();
    provider.setConnected(true);
    provider.setLiveServer({ url: "http://127.0.0.1:51234/mcp", token: "t".repeat(64) });

    const defs = provider.provideMcpServerDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.uri.toString()).toBe("http://127.0.0.1:51234/mcp");
    expect(defs[0]!.headers.Authorization).toBe(`Bearer ${"t".repeat(64)}`);
    expect(defs[0]!.label).toBe("Markdown Collab review tools");
  });

  it("fires onDidChangeMcpServerDefinitions when the user connects", () => {
    const provider = new CopilotMcpProvider();
    const onChange = vi.fn();
    provider.onDidChangeMcpServerDefinitions(onChange);

    provider.setConnected(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Setting the same value again is not a new event.
    provider.setConnected(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("fires onDidChangeMcpServerDefinitions when a connected session gets a fresh token/port", () => {
    const provider = new CopilotMcpProvider();
    const onChange = vi.fn();
    provider.setConnected(true);
    provider.onDidChangeMcpServerDefinitions(onChange);

    provider.setLiveServer({ url: "http://127.0.0.1:1/mcp", token: "a" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDidChangeMcpServerDefinitions for a live-server update while disconnected", () => {
    const provider = new CopilotMcpProvider();
    const onChange = vi.fn();
    provider.onDidChangeMcpServerDefinitions(onChange);

    provider.setLiveServer({ url: "http://127.0.0.1:1/mcp", token: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("goes back to [] once disconnected, even with a live server remembered", () => {
    const provider = new CopilotMcpProvider();
    provider.setConnected(true);
    provider.setLiveServer({ url: "http://127.0.0.1:1/mcp", token: "a" });
    provider.setConnected(false);
    expect(provider.provideMcpServerDefinitions()).toEqual([]);
  });
});
