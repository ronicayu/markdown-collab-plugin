// Set Up Claude Code's plugin path (10x-plan-4 P0.2): the local marketplace
// the extension writes, and the `claude plugin …` sequence that installs from
// it. Every process is a scripted fake runner, so each branch — unsupported
// CLI, already registered, registered elsewhere, stale or disabled install,
// any step failing — is exercised without Claude Code.
//
// The command shapes and `--json` outputs the fakes return were recorded from
// Claude Code 2.1.283 against an isolated CLAUDE_CONFIG_DIR.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LOCAL_MARKETPLACE_NAME,
  LOCAL_PLUGIN_ID,
  installedLocalPlugin,
  localMarketplaceJson,
  parseMarketplaceList,
  parsePluginList,
  setUpClaudePlugin,
  writeLocalMarketplace,
  type ClaudeRunner,
  type RunResult,
} from "../claudePlugin";

let tmp: string;
let source: string;
let marketplaceDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-plugin-"));
  source = path.join(tmp, "ext", "plugin");
  marketplaceDir = path.join(tmp, "storage", "claude-marketplace");
  fs.mkdirSync(path.join(source, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.mkdirSync(path.join(source, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(source, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "markdown-collab", version: "0.36.0", description: "the plugin" }),
  );
  // 0644, the way a .vsix extraction leaves it.
  fs.writeFileSync(path.join(source, "bin", "mdc"), "#!/bin/sh\nexec node lib/mdc.mjs\n", { mode: 0o644 });
  fs.writeFileSync(path.join(source, "lib", "mdc.mjs"), "#!/usr/bin/env node\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

/** `claude plugin marketplace list --json`, as recorded. */
function marketplaces(...entries: Array<{ name: string; path: string }>): string {
  return JSON.stringify(entries.map((e) => ({ ...e, source: "directory", installLocation: e.path })));
}

/** `claude plugin list --json`, as recorded. */
function plugins(...entries: Array<{ id: string; version: string; enabled?: boolean }>): string {
  return JSON.stringify(entries.map((e) => ({ scope: "user", enabled: true, ...e })));
}

/**
 * A fake `claude`: answers by the command (the args joined with spaces, minus
 * the marketplace dir), records every call.
 */
function fakeClaude(answers: Record<string, RunResult | (() => RunResult)>) {
  const calls: string[] = [];
  const run: ClaudeRunner = async (args) => {
    const key = args.map((a) => (a === marketplaceDir ? "<dir>" : a)).join(" ");
    calls.push(key);
    const a = answers[key];
    if (a === undefined) return ok();
    return typeof a === "function" ? a() : a;
  };
  return { run, calls };
}

const FRESH_SEQUENCE = [
  "plugin --help",
  "plugin marketplace list --json",
  "plugin marketplace add <dir>",
  `plugin marketplace update ${LOCAL_MARKETPLACE_NAME}`,
  `plugin install ${LOCAL_PLUGIN_ID} --scope user`,
  "plugin list --json",
];

describe("setUpClaudePlugin", () => {
  it("fresh machine: writes the marketplace, registers it, refreshes, installs", async () => {
    const claude = fakeClaude({
      "plugin marketplace list --json": ok("[]"),
      "plugin list --json": ok(plugins({ id: LOCAL_PLUGIN_ID, version: "0.36.0" })),
    });
    const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(outcome).toEqual({ ok: true, version: "0.36.0" });
    expect(claude.calls).toEqual(FRESH_SEQUENCE);

    const manifest = JSON.parse(fs.readFileSync(path.join(marketplaceDir, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(manifest.name).toBe("markdown-collab-local");
    expect(manifest.plugins).toEqual([
      { name: "markdown-collab", source: "./plugins/markdown-collab", description: "the plugin", version: "0.36.0" },
    ]);
    const copied = path.join(marketplaceDir, "plugins", "markdown-collab");
    expect(fs.readFileSync(path.join(copied, "lib", "mdc.mjs"), "utf8")).toBe("#!/usr/bin/env node\n");
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(copied, "bin", "mdc")).mode & 0o777).toBe(0o755);
    }
  });

  it("doesn't add a marketplace that's already registered at this directory", async () => {
    const claude = fakeClaude({
      "plugin marketplace list --json": ok(marketplaces({ name: LOCAL_MARKETPLACE_NAME, path: marketplaceDir })),
      "plugin list --json": ok(plugins({ id: LOCAL_PLUGIN_ID, version: "0.36.0" })),
    });
    await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(claude.calls).not.toContain("plugin marketplace add <dir>");
    expect(claude.calls).not.toContain(`plugin marketplace remove ${LOCAL_MARKETPLACE_NAME}`);
  });

  it("re-points a marketplace registered at another directory (another VS Code's storage)", async () => {
    const claude = fakeClaude({
      "plugin marketplace list --json": ok(
        marketplaces({ name: LOCAL_MARKETPLACE_NAME, path: "/elsewhere/claude-marketplace" }),
      ),
    });
    await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    const remove = claude.calls.indexOf(`plugin marketplace remove ${LOCAL_MARKETPLACE_NAME}`);
    expect(remove).toBeGreaterThan(0);
    expect(claude.calls.indexOf("plugin marketplace add <dir>")).toBeGreaterThan(remove);
  });

  it("leaves other marketplaces alone", async () => {
    const claude = fakeClaude({
      "plugin marketplace list --json": ok(marketplaces({ name: "claude-plugins-official", path: "/x" })),
    });
    await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(claude.calls).toContain("plugin marketplace add <dir>");
    expect(claude.calls.some((c) => c.includes("remove"))).toBe(false);
  });

  it("adds anyway when the marketplace list can't be read", async () => {
    const claude = fakeClaude({ "plugin marketplace list --json": fail("unknown option --json") });
    const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(outcome.ok).toBe(true);
    expect(claude.calls).toContain("plugin marketplace add <dir>");
  });

  it("updates an install that's another version (install alone is a no-op then)", async () => {
    const claude = fakeClaude({
      "plugin list --json": ok(plugins({ id: LOCAL_PLUGIN_ID, version: "0.35.3" })),
    });
    const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(outcome).toEqual({ ok: true, version: "0.36.0" });
    expect(claude.calls[claude.calls.length - 1]).toBe(`plugin update ${LOCAL_PLUGIN_ID}`);
  });

  it("re-enables a plugin the user had switched off — they just asked for it", async () => {
    const claude = fakeClaude({
      "plugin list --json": ok(plugins({ id: LOCAL_PLUGIN_ID, version: "0.36.0", enabled: false })),
    });
    await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(claude.calls).toContain(`plugin enable ${LOCAL_PLUGIN_ID}`);
    expect(claude.calls).not.toContain(`plugin update ${LOCAL_PLUGIN_ID}`);
  });

  it("reports a CLI without plugin commands as unsupported, and touches nothing", async () => {
    const claude = fakeClaude({ "plugin --help": fail("error: unknown command 'plugin'") });
    const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(outcome).toMatchObject({ ok: false, unsupported: true });
    expect(claude.calls).toEqual(["plugin --help"]);
    expect(fs.existsSync(marketplaceDir)).toBe(false);
  });

  it("fails with the reason when the shipped plugin has no manifest", async () => {
    fs.rmSync(path.join(source, ".claude-plugin"), { recursive: true });
    const claude = fakeClaude({});
    const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/local marketplace/);
  });

  for (const [step, key] of [
    ["plugin marketplace add", "plugin marketplace add <dir>"],
    ["plugin marketplace update", `plugin marketplace update ${LOCAL_MARKETPLACE_NAME}`],
    ["plugin install", `plugin install ${LOCAL_PLUGIN_ID} --scope user`],
  ] as const) {
    it(`stops at a failing \`${step}\`, naming the step and the CLI's last stderr line`, async () => {
      const claude = fakeClaude({ [key]: fail("Loading…\nsomething specific went wrong", 3) });
      const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
      expect(outcome).toEqual({
        ok: false,
        reason: `\`claude ${step}\` exited 3: something specific went wrong`,
      });
      expect(claude.calls[claude.calls.length - 1]).toBe(key);
    });
  }

  it("names a step that never finished (timeout, spawn error)", async () => {
    const claude = fakeClaude({
      [`plugin install ${LOCAL_PLUGIN_ID} --scope user`]: { code: null, stdout: "", stderr: "", error: "timed out" },
    });
    const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(outcome).toEqual({ ok: false, reason: "`claude plugin install` did not finish: timed out" });
  });

  it("fails when the version update fails", async () => {
    const claude = fakeClaude({
      "plugin list --json": ok(plugins({ id: LOCAL_PLUGIN_ID, version: "0.35.3" })),
      [`plugin update ${LOCAL_PLUGIN_ID}`]: fail("nope"),
    });
    const outcome = await setUpClaudePlugin({ run: claude.run, sourcePluginDir: source, marketplaceDir });
    expect(outcome).toEqual({ ok: false, reason: "`claude plugin update` exited 1: nope" });
  });
});

describe("writeLocalMarketplace", () => {
  it("replaces the previous copy wholesale, so files a newer version dropped don't linger", async () => {
    await writeLocalMarketplace(source, marketplaceDir);
    const stale = path.join(marketplaceDir, "plugins", "markdown-collab", "lib", "old-helper.mjs");
    fs.writeFileSync(stale, "old");
    await writeLocalMarketplace(source, marketplaceDir);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("writes a marketplace manifest the CLI accepts: name, owner, one relative-path plugin", () => {
    const parsed = JSON.parse(localMarketplaceJson({ name: "markdown-collab", version: "1.2.3" }));
    expect(parsed).toMatchObject({
      name: LOCAL_MARKETPLACE_NAME,
      owner: { name: "Ronica" },
      plugins: [{ name: "markdown-collab", source: "./plugins/markdown-collab", version: "1.2.3" }],
    });
    expect(parsed.plugins[0]).not.toHaveProperty("description");
  });
});

describe("the --json parsers", () => {
  it("read the recorded shapes", () => {
    expect(parseMarketplaceList(marketplaces({ name: "a", path: "/p" }))).toEqual([{ name: "a", path: "/p" }]);
    expect(parsePluginList(plugins({ id: LOCAL_PLUGIN_ID, version: "0.35.3" }))).toEqual([
      { id: LOCAL_PLUGIN_ID, version: "0.35.3", enabled: true, scope: "user" },
    ]);
  });

  it("return null for anything that isn't a JSON array, and skip malformed entries", () => {
    for (const bad of ["", "not json", "{}", "null", "3"]) {
      expect(parseMarketplaceList(bad), bad).toBeNull();
      expect(parsePluginList(bad), bad).toBeNull();
    }
    expect(parsePluginList('[{"version":"1"}, null, {"id":"x"}]')).toEqual([
      { id: "x", version: "", enabled: true, scope: undefined },
    ]);
  });
});

describe("installedLocalPlugin", () => {
  it("finds our plugin, ignores others, and says null when the list fails", async () => {
    const listed = fakeClaude({
      "plugin list --json": ok(
        plugins({ id: "markdown-collab@markdown-collab", version: "9.9.9" }, { id: LOCAL_PLUGIN_ID, version: "0.35.3" }),
      ),
    });
    expect(await installedLocalPlugin(listed.run)).toMatchObject({ id: LOCAL_PLUGIN_ID, version: "0.35.3" });
    expect(await installedLocalPlugin(fakeClaude({ "plugin list --json": ok("[]") }).run)).toBeNull();
    expect(await installedLocalPlugin(fakeClaude({ "plugin list --json": fail("boom") }).run)).toBeNull();
  });
});
