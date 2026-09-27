// The "Other agent" fallback snippet (10x-plan-4 P1.1) — no file is ever
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
});
