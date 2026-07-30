import { describe, expect, it } from "vitest";
import {
  ENV_TOKEN,
  ENV_URL,
  MCP_SERVER_NAME,
  descriptorJson,
  mcpJsonEntry,
  mergeMcpJson,
  preferredPort,
} from "../mcpServer/registration";

describe("mcpJsonEntry", () => {
  const entry = mcpJsonEntry(51234);

  it("declares the http transport, which Claude Code requires alongside a url", () => {
    // An entry with a url and no type is read as a stdio server and skipped.
    expect(entry.type).toBe("http");
    expect(entry.url).toContain("/mcp");
  });

  it("carries no token, only an environment reference", () => {
    const text = JSON.stringify(entry);
    expect(text).toContain(`\${${ENV_TOKEN}}`);
    expect(entry.headers.Authorization).toBe(`Bearer \${${ENV_TOKEN}}`);
    // The whole point: this file gets committed.
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("prefers the env URL and keeps the live port only as the fallback", () => {
    expect(entry.url).toBe(`\${${ENV_URL}:-http://127.0.0.1:51234/mcp}`);
  });

  it("binds nothing but loopback in the fallback", () => {
    expect(mcpJsonEntry(1).url).toContain("127.0.0.1");
    expect(mcpJsonEntry(1).url).not.toContain("0.0.0.0");
  });
});

describe("mergeMcpJson", () => {
  it("creates the file when there is none", () => {
    const { text, replaced } = mergeMcpJson(null, 51234);
    expect(replaced).toBe(false);
    expect(JSON.parse(text!).mcpServers[MCP_SERVER_NAME].type).toBe("http");
  });

  it("keeps every other server intact", () => {
    const existing = JSON.stringify({
      mcpServers: {
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
      },
      someOtherKey: { keep: true },
    });
    const merged = JSON.parse(mergeMcpJson(existing, 51234).text!);
    expect(merged.mcpServers.sentry.url).toBe("https://mcp.sentry.dev/mcp");
    expect(merged.someOtherKey).toEqual({ keep: true });
    expect(merged.mcpServers[MCP_SERVER_NAME]).toBeDefined();
  });

  it("replaces our own stale entry when the port moves", () => {
    const first = mergeMcpJson(null, 51234).text!;
    const second = mergeMcpJson(first, 51999);
    expect(second.replaced).toBe(true);
    expect(second.text).toContain("51999");
    expect(second.text).not.toContain("51234");
  });

  // Activation runs on every window open; rewriting an unchanged file would
  // show up as a spurious diff in the user's source control view every time.
  it("returns nothing to write when the entry is already correct", () => {
    const first = mergeMcpJson(null, 51234).text!;
    expect(mergeMcpJson(first, 51234).text).toBeNull();
  });

  it("refuses to touch a malformed .mcp.json rather than clobbering it", () => {
    expect(() => mergeMcpJson("{ this is not json", 1)).toThrow(/not valid JSON/);
    expect(() => mergeMcpJson("[]", 1)).toThrow(/JSON object/);
  });

  it("treats an empty file as no file", () => {
    expect(mergeMcpJson("   \n", 51234).text).toContain(MCP_SERVER_NAME);
  });
});

describe("preferredPort", () => {
  it("is stable for a workspace, so the registered URL survives a reload", () => {
    expect(preferredPort("/home/r/docs")).toBe(preferredPort("/home/r/docs"));
  });

  it("differs between workspaces, so two windows don't fight over one port", () => {
    expect(preferredPort("/home/r/docs")).not.toBe(preferredPort("/home/r/other"));
  });

  it("stays inside the dynamic port range", () => {
    for (const p of ["/", "/a", "/home/r/docs", "C:\\Users\\r\\docs", "x".repeat(500)]) {
      const port = preferredPort(p);
      expect(port).toBeGreaterThanOrEqual(49152);
      expect(port).toBeLessThanOrEqual(65279);
    }
  });
});

describe("descriptorJson", () => {
  it("is the gitignored side, so it may carry the token", () => {
    const text = descriptorJson({
      url: "http://127.0.0.1:51234/mcp",
      port: 51234,
      token: "deadbeef",
      pid: 42,
      startedAt: "2026-07-30T00:00:00.000Z",
      version: "0.34.62",
    });
    expect(JSON.parse(text).token).toBe("deadbeef");
    expect(text.endsWith("\n")).toBe(true);
  });
});
