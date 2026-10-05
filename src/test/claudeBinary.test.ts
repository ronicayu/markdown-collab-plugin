// Finding and identifying `claude`. The search order is the
// product decision here — an explicit setting beats PATH, and PATH beats the
// installer locations VS Code's own PATH often lacks — so it is tested against
// an injected machine rather than whatever this one has installed.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseClaudeVersion,
  probeClaudeVersion,
  quoteForCmd,
  resolveClaudeBinary,
  spawnCommand,
  versionAtLeast,
  wellKnownClaudePaths,
  type ResolveEnv,
} from "../transports/claudeBinary";

function machine(opts: Partial<ResolveEnv> & { files?: string[] }): ResolveEnv {
  const files = new Set(opts.files ?? []);
  return {
    platform: opts.platform ?? "darwin",
    env: opts.env ?? {},
    homedir: opts.homedir ?? "/Users/me",
    isExecutable: (p) => files.has(p),
  };
}

describe("parseClaudeVersion", () => {
  it("parses the CLI's own format", () => {
    expect(parseClaudeVersion("2.1.283 (Claude Code)\n")).toEqual({
      major: 2,
      minor: 1,
      patch: 283,
      raw: "2.1.283 (Claude Code)",
    });
  });

  it("tolerates a bare version and rejects nonsense", () => {
    expect(parseClaudeVersion("10.0.1")).toMatchObject({ major: 10, minor: 0, patch: 1 });
    expect(parseClaudeVersion("command not found")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
  });

  it("compares versions numerically, not as strings", () => {
    const v = parseClaudeVersion("2.1.283")!;
    expect(versionAtLeast(v, [2, 1, 259])).toBe(true);
    expect(versionAtLeast(v, [2, 1, 283])).toBe(true);
    expect(versionAtLeast(v, [2, 1, 284])).toBe(false);
    expect(versionAtLeast(v, [2, 2, 0])).toBe(false);
    expect(versionAtLeast(parseClaudeVersion("2.10.0")!, [2, 9, 999])).toBe(true);
  });
});

describe("resolveClaudeBinary", () => {
  it("prefers the setting over PATH", () => {
    const m = machine({
      env: { PATH: "/usr/bin:/opt/bin" },
      files: ["/custom/claude", "/opt/bin/claude"],
    });
    expect(resolveClaudeBinary("/custom/claude", m)).toEqual({ ok: true, path: "/custom/claude", source: "setting" });
  });

  it("expands ~ in the setting", () => {
    const m = machine({ files: ["/Users/me/bin/claude"] });
    expect(resolveClaudeBinary("~/bin/claude", m)).toMatchObject({ ok: true, path: "/Users/me/bin/claude" });
  });

  it("does not silently run a different claude when the setting is wrong", () => {
    const m = machine({ env: { PATH: "/opt/bin" }, files: ["/opt/bin/claude"] });
    const r = resolveClaudeBinary("/nope/claude", m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("/nope/claude");
  });

  it("searches PATH in order", () => {
    const m = machine({
      env: { PATH: "/usr/bin::/first:/second" },
      files: ["/second/claude", "/first/claude"],
    });
    expect(resolveClaudeBinary("", m)).toEqual({ ok: true, path: "/first/claude", source: "path" });
  });

  it("falls back to the installer locations VS Code's PATH often lacks", () => {
    const home = "/Users/me";
    for (const found of [
      `${home}/.local/bin/claude`,
      `${home}/.claude/local/claude`,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]) {
      const m = machine({ env: { PATH: "/usr/bin:/bin" }, homedir: home, files: [found] });
      expect(resolveClaudeBinary("", m)).toEqual({ ok: true, path: found, source: "well-known" });
    }
  });

  it("reports not found with nothing anywhere", () => {
    const r = resolveClaudeBinary("  ", machine({ env: { PATH: "/usr/bin" } }));
    expect(r.ok).toBe(false);
  });

  it("on Windows, tries claude.exe and the npm .cmd shim on PATH", () => {
    const m = machine({
      platform: "win32",
      homedir: "C:\\Users\\me",
      env: { Path: "C:\\Windows;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      files: ["C:\\tools\\claude.cmd"],
    });
    expect(resolveClaudeBinary("", m)).toEqual({ ok: true, path: "C:\\tools\\claude.cmd", source: "path" });
  });

  it("on Windows, falls back to the native installer and the npm global dir", () => {
    const env = { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\me", APPDATA: "C:\\Users\\me\\AppData\\Roaming" };
    expect(wellKnownClaudePaths(machine({ platform: "win32", env }))).toEqual([
      "C:\\Users\\me\\.local\\bin\\claude.exe",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
    ]);
    const m = machine({ platform: "win32", env, files: ["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"] });
    expect(resolveClaudeBinary("", m)).toMatchObject({ ok: true, source: "well-known" });
  });
});

describe("spawnCommand", () => {
  it("spawns directly everywhere but a Windows batch shim", () => {
    expect(spawnCommand("/usr/local/bin/claude", ["-p", "a b"], "darwin")).toEqual({
      command: "/usr/local/bin/claude",
      args: ["-p", "a b"],
      shell: false,
    });
    expect(spawnCommand("C:\\x\\claude.exe", ["-p"], "win32").shell).toBe(false);
  });

  it("quotes every argument when the shell has to parse them", () => {
    const spec = spawnCommand("C:\\Program Files\\npm\\claude.cmd", ["-p", "C:\\Users\\A B\\mcp.json", "mcp__markdown-collab__*"], "win32");
    expect(spec.shell).toBe(true);
    expect(spec.command).toBe('"C:\\Program Files\\npm\\claude.cmd"');
    expect(spec.args).toEqual(["-p", '"C:\\Users\\A B\\mcp.json"', "mcp__markdown-collab__*"]);
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
    expect(quoteForCmd("")).toBe('""');
  });
});

describe.skipIf(process.platform === "win32")("probeClaudeVersion", () => {
  let dir: string;
  const script = (name: string, body: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-probe-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads the version from a working binary", async () => {
    const bin = script("good", 'echo "2.1.283 (Claude Code)"');
    const r = await probeClaudeVersion(bin);
    expect(r).toMatchObject({ ok: true, version: { major: 2, minor: 1, patch: 283 } });
  });

  it("fails a binary that exits non-zero or prints no version", async () => {
    expect((await probeClaudeVersion(script("bad", "echo nope; exit 3"))).ok).toBe(false);
    expect((await probeClaudeVersion(script("silent", "exit 0"))).ok).toBe(false);
  });

  it("fails a binary that doesn't exist", async () => {
    expect((await probeClaudeVersion(path.join(dir, "missing"))).ok).toBe(false);
  });

  it("gives up on a probe that hangs", async () => {
    const r = await probeClaudeVersion(script("hang", "sleep 10"), { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/did not answer/);
  });
});
