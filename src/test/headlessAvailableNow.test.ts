// "Is Claude Code on this machine?" shares the one `claude --version` lookup
// headless availability uses (the skill banner asks it on every editor open):
// however many callers there are, there is one probe, and an untrusted
// workspace is never probed. (The file keeps the name of the synchronous
// `headlessAvailableNow` that used to live here, retired with the empty-state
// label that read it.)

import { beforeEach, describe, expect, it, vi } from "vitest";

let probeRelease: (() => void) | null = null;
let probeCalls = 0;
let trusted = true;

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
        probeCalls++;
        probeRelease = () =>
          resolve({ ok: true, version: { major: 2, minor: 1, patch: 283, raw: "2.1.283" } });
      }),
  };
});

const memento = { get: () => undefined, update: async () => undefined, keys: () => [] };

describe("claudeBinaryFound", () => {
  beforeEach(async () => {
    probeRelease = null;
    probeCalls = 0;
    trusted = true;
    const host = await import("../transports/headlessHost");
    await host.resetHeadlessFailures(memento as never);
  });

  it("waits for the lookup, then says whether claude was found", async () => {
    const host = await import("../transports/headlessHost");
    const answer = host.claudeBinaryFound();
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    probeRelease!();
    expect(await answer).toBe(true);
  });

  it("shares one probe with headless availability and with every other caller", async () => {
    const host = await import("../transports/headlessHost");
    const a = host.claudeBinaryFound();
    const b = host.claudeBinaryFound();
    const c = host.headlessAvailability(memento as never);
    probeRelease!();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect((await c).ok).toBe(true);
    expect(probeCalls).toBe(1);
  });

  it("is false, without probing, in an untrusted workspace", async () => {
    trusted = false;
    const host = await import("../transports/headlessHost");
    expect(await host.claudeBinaryFound()).toBe(false);
    expect(probeCalls).toBe(0);
  });
});
