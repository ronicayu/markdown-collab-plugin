import { beforeEach, describe, expect, it, vi } from "vitest";

let trusted = false;
let probes = 0;

vi.mock("vscode", () => ({
  workspace: {
    get isTrusted() {
      return trusted;
    },
    getConfiguration: () => ({ get: () => "" }),
  },
  window: {},
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
}));

vi.mock("../mcpServer", () => ({ currentMcpServer: () => null }));

vi.mock("../transports/claudeBinary", async (importOriginal) => {
  const real = await importOriginal<typeof import("../transports/claudeBinary")>();
  return {
    ...real,
    resolveClaudeBinary: () => ({ ok: true, path: "/fake/claude", source: "path" }),
    probeClaudeVersion: async () => {
      probes++;
      return { ok: true, version: { major: 2, minor: 1, patch: 283, raw: "2.1.283" } };
    },
  };
});

describe("lookupClaude in Restricted Mode", () => {
  beforeEach(async () => {
    probes = 0;
    trusted = false;
    const host = await import("../transports/headlessHost");
    await host.resetHeadlessFailures({ update: async () => undefined } as never);
  });

  it("does not probe and says the workspace isn't trusted", async () => {
    const host = await import("../transports/headlessHost");
    expect(await host.lookupClaude()).toEqual({ ok: false, error: "this workspace isn't trusted" });
    expect(probes).toBe(0);
  });

  it("probes once after trust is granted, because the untrusted answer was never cached", async () => {
    const host = await import("../transports/headlessHost");
    await host.lookupClaude();
    trusted = true;
    expect((await host.lookupClaude()).ok).toBe(true);
    await host.lookupClaude();
    expect(probes).toBe(1);
  });
});
