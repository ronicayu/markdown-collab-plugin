// The session→slug map `handleRpc`/`httpServer.ts` build on.

import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../mcpServer/sessions";

describe("SessionRegistry", () => {
  it("resolves a recorded session to the slug its clientInfo.name maps to", () => {
    const r = new SessionRegistry();
    r.record("s1", "codex-mcp-client");
    expect(r.slugFor("s1")).toBe("codex");
  });

  it("falls back to 'agent' for an unknown session id", () => {
    const r = new SessionRegistry();
    r.record("s1", "codex-mcp-client");
    expect(r.slugFor("s2")).toBe("agent");
  });

  it("falls back to 'agent' for an absent session id", () => {
    const r = new SessionRegistry();
    expect(r.slugFor(undefined)).toBe("agent");
  });

  it("re-recording the same session id updates its slug", () => {
    const r = new SessionRegistry();
    r.record("s1", "claude-code");
    expect(r.slugFor("s1")).toBe("claude");
    r.record("s1", "codex-mcp-client");
    expect(r.slugFor("s1")).toBe("codex");
  });

  it("keeps two sessions independent", () => {
    const r = new SessionRegistry();
    r.record("claude-session", "claude-code");
    r.record("codex-session", "codex-mcp-client");
    expect(r.slugFor("claude-session")).toBe("claude");
    expect(r.slugFor("codex-session")).toBe("codex");
  });

  it("evicts the oldest session once the cap is exceeded", () => {
    const r = new SessionRegistry();
    for (let i = 0; i < 64; i++) r.record(`s${i}`, "codex-mcp-client");
    expect(r.slugFor("s0")).toBe("codex"); // still within the cap
    r.record("s64", "codex-mcp-client"); // pushes past 64 entries
    expect(r.slugFor("s0")).toBe("agent"); // the oldest one is gone
    expect(r.slugFor("s64")).toBe("codex"); // the newest one is fine
  });
});
