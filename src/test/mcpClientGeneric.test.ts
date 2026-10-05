// The "Other agent" fallback snippet — no file is ever
// written for this one, so the only contract to test is the text shown to
// the human.

import { describe, expect, it } from "vitest";
import { genericSnippet } from "../mcpServer/clients/generic";

describe("genericSnippet", () => {
  const text = genericSnippet("http://127.0.0.1:51234/mcp", "deadbeef".repeat(8));

  it("includes the URL and the token in the human-readable summary", () => {
    expect(text).toContain("http://127.0.0.1:51234/mcp");
    expect(text).toContain("deadbeef".repeat(8));
  });

  it("warns the token is session-scoped", () => {
    expect(text.toLowerCase()).toMatch(/session|reload|closes/);
  });

  it("embeds a generic mcpServers JSON snippet built from the same values", () => {
    const match = text.match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const snippet = JSON.parse(match![1]!);
    expect(snippet.mcpServers["markdown-collab"].url).toBe("http://127.0.0.1:51234/mcp");
    expect(snippet.mcpServers["markdown-collab"].headers.Authorization).toBe(
      `Bearer ${"deadbeef".repeat(8)}`,
    );
  });

  it("says this editor session, never VS Code", () => {
    expect(text).toContain("this editor session");
    expect(text).not.toContain("VS Code");
  });

  it("has no Windsurf block by default", () => {
    expect(text).not.toMatch(/windsurf|serverUrl/i);
  });
});

describe("genericSnippet for Windsurf", () => {
  const url = "http://127.0.0.1:51234/mcp";
  const token = "deadbeef".repeat(8);
  const text = genericSnippet(url, token, "windsurf");

  it("shows Windsurf's serverUrl shape, built from the same values", () => {
    const snippet = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]!);
    expect(snippet).toEqual({
      mcpServers: {
        "markdown-collab": { serverUrl: url, headers: { Authorization: `Bearer ${token}` } },
      },
    });
  });

  it("says where to paste it and to press Refresh", () => {
    expect(text).toContain("~/.codeium/windsurf/mcp_config.json");
    expect(text).toContain("Settings → Cascade → MCP Servers → View raw config");
    expect(text).toContain("Refresh");
  });

  it("says the token changes on reload and Cascade still works from AGENTS.md", () => {
    expect(text).toMatch(/pasted again after a reload/);
    expect(text).toContain("Cascade still works from AGENTS.md");
  });

  it("says the keys are unverified and falls back to the generic snippet", () => {
    expect(text).toContain("These Windsurf keys have not been verified against a real Windsurf install");
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!));
    expect(blocks).toHaveLength(2);
    expect(blocks[1].mcpServers["markdown-collab"]).toEqual({
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it("never says VS Code", () => {
    expect(text).not.toContain("VS Code");
  });
});
