// Codex's `.codex/config.toml` upsert (10x-plan-4 P1.1) — a tiny, pure,
// line-based TOML table writer, not a TOML library. See
// `src/mcpServer/clients/codex.ts` for why: Codex doesn't expand `${VAR}` in
// `url`, so the literal port has to live in the file, which is also the one
// thing that can make this file go stale.

import { describe, expect, it } from "vitest";
import { codexEntry, codexTablePresent, mergeCodexToml } from "../mcpServer/clients/codex";
import { ENV_TOKEN } from "../mcpServer/registration";

describe("codexEntry", () => {
  it("carries the literal loopback URL and the token's env var name, never the token", () => {
    const entry = codexEntry(51234);
    expect(entry.url).toBe("http://127.0.0.1:51234/mcp");
    expect(entry.bearer_token_env_var).toBe(ENV_TOKEN);
  });
});

describe("mergeCodexToml", () => {
  it("creates the file fresh when there is none", () => {
    const { text, replaced } = mergeCodexToml(null, 51234);
    expect(replaced).toBe(false);
    expect(text).toContain("[mcp_servers.markdown-collab]");
    expect(text).toContain('url = "http://127.0.0.1:51234/mcp"');
    expect(text).toContain(`bearer_token_env_var = "${ENV_TOKEN}"`);
    // No token, ever.
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("appends after existing tables, preserving them and their comments", () => {
    const existing = [
      "# a top-level comment",
      "[other_table]",
      'foo = "bar"',
      "",
    ].join("\n");
    const merged = mergeCodexToml(existing, 51234);
    expect(merged.replaced).toBe(false);
    expect(merged.text).toContain("# a top-level comment");
    expect(merged.text).toContain("[other_table]");
    expect(merged.text).toContain('foo = "bar"');
    expect(merged.text).toContain("[mcp_servers.markdown-collab]");
  });

  it("replaces only our table's body, up to the next header, leaving later tables alone", () => {
    const existing = [
      "[other_table]",
      'foo = "bar"',
      "",
      "[mcp_servers.markdown-collab]",
      'url = "http://127.0.0.1:1111/mcp"',
      'bearer_token_env_var = "STALE"',
      "# a stale comment inside our table",
      "",
      "[another_table]",
      "baz = 1",
    ].join("\n");
    const merged = mergeCodexToml(existing, 51234);
    expect(merged.replaced).toBe(true);
    expect(merged.text).toContain('foo = "bar"'); // other_table untouched
    expect(merged.text).toContain("[another_table]");
    expect(merged.text).toContain("baz = 1");
    expect(merged.text).toContain('url = "http://127.0.0.1:51234/mcp"');
    expect(merged.text).not.toContain("STALE");
    expect(merged.text).not.toContain("a stale comment inside our table");
  });

  it("handles the quoted header spelling and preserves it", () => {
    const existing = [
      '[mcp_servers."markdown-collab"]',
      'url = "http://127.0.0.1:1111/mcp"',
      'bearer_token_env_var = "OLD"',
      "",
    ].join("\n");
    const merged = mergeCodexToml(existing, 51234);
    expect(merged.text).toContain('[mcp_servers."markdown-collab"]');
    expect(merged.text).not.toContain("[mcp_servers.markdown-collab]\n");
    expect(merged.text).toContain('url = "http://127.0.0.1:51234/mcp"');
  });

  it("writes nothing when the table already matches (round trip)", () => {
    const first = mergeCodexToml(null, 51234).text!;
    const second = mergeCodexToml(first, 51234);
    expect(second.text).toBeNull();
    expect(second.replaced).toBe(true);
  });

  it("rewrites when the port moved", () => {
    const first = mergeCodexToml(null, 51234).text!;
    const second = mergeCodexToml(first, 61234);
    expect(second.text).not.toBeNull();
    expect(second.text).toContain("http://127.0.0.1:61234/mcp");
    expect(second.text).not.toContain("51234");
  });

  it("never puts a token in the output", () => {
    const text = mergeCodexToml(null, 51234).text!;
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
  });
});

describe("codexTablePresent", () => {
  it("detects either header spelling", () => {
    expect(codexTablePresent("[mcp_servers.markdown-collab]\n")).toBe(true);
    expect(codexTablePresent('[mcp_servers."markdown-collab"]\n')).toBe(true);
    expect(codexTablePresent("[other_table]\n")).toBe(false);
    expect(codexTablePresent("")).toBe(false);
  });
});
