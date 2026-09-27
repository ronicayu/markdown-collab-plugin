// The review view renders its empty state on open; it must not hold that first
// paint on a `claude --version` probe (10x-plan-4 P2.4 follow-up). So there are
// two answers: `headlessAvailableNow` — synchronous, null while the lookup is
// still running — and `headlessAvailability`, which waits for it.

import { beforeEach, describe, expect, it, vi } from "vitest";

let probeRelease: (() => void) | null = null;

vi.mock("vscode", () => ({
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: () => "" }),
  },
  window: {},
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
}));

vi.mock("../mcpServer", () => ({
  currentMcpServer: () => ({ url: "http://127.0.0.1:1/mcp", token: "t", port: 1 }),
}));

vi.mock("../transports/claudeBinary", async (importOriginal) => {
  const real = await importOriginal<typeof import("../transports/claudeBinary")>();
  return {
    ...real,
    resolveClaudeBinary: () => ({ ok: true, path: "/fake/claude", source: "path" }),
    probeClaudeVersion: () =>
      new Promise((resolve) => {
        probeRelease = () =>
          resolve({ ok: true, version: { major: 2, minor: 1, patch: 283, raw: "2.1.283" } });
      }),
  };
});

const memento = { get: () => undefined, update: async () => undefined, keys: () => [] };

describe("headlessAvailableNow", () => {
  beforeEach(async () => {
    probeRelease = null;
    const host = await import("../transports/headlessHost");
    await host.resetHeadlessFailures(memento as never);
  });

  it("is null while the lookup runs, then the real answer", async () => {
    const host = await import("../transports/headlessHost");
    expect(host.headlessAvailableNow(memento as never)).toBeNull();
    const pending = host.headlessAvailability(memento as never);
    expect(host.headlessAvailableNow(memento as never)).toBeNull();
    probeRelease!();
    const a = await pending;
    expect(a.ok).toBe(true);
    // Settled: answered synchronously from now on.
    expect(host.headlessAvailableNow(memento as never)).toBe(true);
  });
});
