// Cursor CLI's `.cursor/mcp.json` writer (10x-plan-4 P1.1).

import { describe, expect, it } from "vitest";
import { cursorMcpEntry, mergeCursorMcpJson } from "../mcpServer/clients/cursor";
import { ENV_TOKEN, ENV_URL, MCP_SERVER_NAME } from "../mcpServer/registration";

describe("cursorMcpEntry", () => {
  it("carries env references, not a port or a token", () => {
    const entry = cursorMcpEntry();
    const text = JSON.stringify(entry);
    expect(entry.url).toBe(`\${env:${ENV_URL}}`);
    expect(entry.headers.Authorization).toBe(`Bearer \${env:${ENV_TOKEN}}`);
    // The whole point: no port digits, no token-shaped hex string.
    expect(text).not.toMatch(/:\d{2,5}\//);
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
  });
});

describe("mergeCursorMcpJson", () => {
  it("creates the file when there is none", () => {
    const { text, replaced } = mergeCursorMcpJson(null);
    expect(replaced).toBe(false);
    const parsed = JSON.parse(text!);
    expect(parsed.mcpServers[MCP_SERVER_NAME].url).toBe(`\${env:${ENV_URL}}`);
  });

  it("keeps every other server intact", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { url: "https://example.com/mcp" },
      },
      unrelatedTopLevelKey: true,
    });
    const merged = JSON.parse(mergeCursorMcpJson(existing).text!);
    expect(merged.mcpServers.other.url).toBe("https://example.com/mcp");
    expect(merged.unrelatedTopLevelKey).toBe(true);
    expect(merged.mcpServers[MCP_SERVER_NAME]).toBeDefined();
  });

  it("writes nothing when the entry already matches", () => {
    const first = mergeCursorMcpJson(null).text!;
    const second = mergeCursorMcpJson(first);
    expect(second.text).toBeNull();
  });

  it("contains no port digits and no token anywhere in a fresh write", () => {
    const text = mergeCursorMcpJson(null).text!;
    expect(text).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
  });
});
