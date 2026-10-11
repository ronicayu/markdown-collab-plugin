import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { CLAUDE_SETUP_MISSING, maybePromptSkillUpdate } from "../commands/setup";
import { installedLocalPlugin, setUpClaudePlugin } from "../claudePlugin";
import { lookupClaude } from "../transports/headlessHost";
import { AGENTS_SNIPPET } from "../agents";
import { SKILL_REL_PATH } from "../skill";

const home = vi.hoisted(() => ({ dir: "", fingerprint: "fp1" }));

vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => home.dir,
}));
vi.mock("../claudePlugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claudePlugin")>()),
  installedLocalPlugin: vi.fn(),
  setUpClaudePlugin: vi.fn(),
}));
vi.mock("../transports/headlessHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transports/headlessHost")>()),
  lookupClaude: vi.fn(),
}));
vi.mock("../skill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skill")>()),
  skillFingerprint: vi.fn(() => home.fingerprint),
}));

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

const NO_AGENT = "Markdown Collab: no agent is connected yet to read and act on your comments.";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never;

describe("the startup skill nudge", () => {
  let wsDir: string;
  let globalState: Map<string, unknown>;
  let workspaceState: Map<string, unknown>;
  let context: never;
  let show: Mock<any[], any>;

  const run = () => maybePromptSkillUpdate(context, log);
  const messages = () => show.mock.calls.map((c) => c[0]);
  const writeSkill = (text: string) => {
    mkdirSync(path.dirname(path.join(home.dir, SKILL_REL_PATH)), { recursive: true });
    writeFileSync(path.join(home.dir, SKILL_REL_PATH), text);
  };

  beforeEach(() => {
    home.dir = mkdtempSync(path.join(nodeOs.tmpdir(), "mc-home-"));
    home.fingerprint = "fp1";
    wsDir = mkdtempSync(path.join(nodeOs.tmpdir(), "mc-ws-"));
    globalState = new Map();
    workspaceState = new Map();
    const memento = (m: Map<string, unknown>) => ({
      get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
      update: async (k: string, v: unknown) => void m.set(k, v),
      keys: () => [...m.keys()],
    });
    context = {
      extension: { packageJSON: {} },
      extensionPath: "/ext",
      globalStorageUri: vscode.Uri.file("/storage"),
      globalState: memento(globalState),
      workspaceState: memento(workspaceState),
    } as never;
    show = vi.fn(async () => undefined);
    win.showInformationMessage = show;
    cmds.executeCommand = vi.fn(async () => undefined);
    ws.isTrusted = true;
    ws.workspaceFolders = [{ uri: vscode.Uri.file(wsDir), name: "ws", index: 0 }];
  });

  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
    ws.workspaceFolders = undefined;
  });

  it("says no agent is connected when nothing is", async () => {
    await run();

    expect(messages()).toEqual([NO_AGENT]);
    expect(show.mock.calls[0].slice(1)).toEqual(["Connect an Agent", "Not now"]);
  });

  it("opens Connect an Agent when the button is clicked", async () => {
    show.mockResolvedValueOnce("Connect an Agent");

    await run();

    expect(cmds.executeCommand).toHaveBeenCalledWith("markdownCollab.connectAgent");
  });

  it.each(["copilot", "cursor-inapp"])("stays quiet when %s is connected for this workspace", async (id) => {
    workspaceState.set(`markdownCollab.connectedAgents:file://${wsDir}`, [id]);

    await run();

    expect(show).not.toHaveBeenCalled();
    expect(globalState.size).toBe(0);
  });

  it("stays quiet when AGENTS.md already carries the Markdown Collab section", async () => {
    writeFileSync(path.join(wsDir, "AGENTS.md"), `# Repo\n\n${AGENTS_SNIPPET}`);

    await run();

    expect(show).not.toHaveBeenCalled();
    expect(globalState.size).toBe(0);
  });

  it("still says it when AGENTS.md exists without the section", async () => {
    writeFileSync(path.join(wsDir, "AGENTS.md"), "# Repo\n\nBuild with make.\n");

    await run();

    expect(messages()).toEqual([NO_AGENT]);
  });

  it("stays quiet when the .mcp.json registration was accepted", async () => {
    workspaceState.set(`markdownCollab.mcpJsonConsent:file://${wsDir}`, "yes");

    await run();

    expect(show).not.toHaveBeenCalled();
  });

  it("does not say it a second time when the bundled skill changes", async () => {
    await run();
    home.fingerprint = "fp2";
    await run();

    expect(messages()).toEqual([NO_AGENT]);
  });

  it("says it once per machine, so a later workspace with no agent is not nagged either", async () => {
    await run();
    ws.workspaceFolders = [{ uri: vscode.Uri.file(path.join(wsDir, "other")), name: "other", index: 0 }];
    await run();

    expect(show).toHaveBeenCalledTimes(1);
  });

  describe("when an installed skill is out of date", () => {
    beforeEach(() => writeSkill("an older skill"));

    it("offers the update", async () => {
      await run();

      expect(messages()).toEqual([
        "Markdown Collab: the Claude skill is out of date. Update it so Claude follows the latest comment-handling behavior.",
      ]);
      expect(show.mock.calls[0].slice(1)).toEqual(["Update", "Not now"]);
    });

    it("offers it once per bundled skill version", async () => {
      await run();
      await run();
      expect(show).toHaveBeenCalledTimes(1);

      home.fingerprint = "fp2";
      await run();
      expect(show).toHaveBeenCalledTimes(2);
    });

    it("offers it even when an agent is connected", async () => {
      workspaceState.set(`markdownCollab.connectedAgents:file://${wsDir}`, ["copilot"]);

      await run();

      expect(show).toHaveBeenCalledTimes(1);
    });

    it("does not use up the once-per-machine no-agent nudge", async () => {
      await run();
      rmSync(path.join(home.dir, ".claude"), { recursive: true, force: true });
      await run();

      expect(messages()[1]).toBe(NO_AGENT);
    });
  });

  describe("when Claude Code is installed without the plugin or the skill", () => {
    const pkg = () => (context as unknown as { extension: { packageJSON: { version?: string } } }).extension.packageJSON;

    beforeEach(() => {
      pkg().version = "1.0.0";
      (lookupClaude as Mock).mockResolvedValue({ ok: true, claude: { path: "/usr/bin/claude" } });
      (installedLocalPlugin as Mock).mockResolvedValue(null);
    });

    it("offers Set Up Claude Code", async () => {
      await run();

      expect(messages()).toEqual([CLAUDE_SETUP_MISSING]);
      expect(show.mock.calls[0].slice(1)).toEqual(["Set Up Claude Code", "Not now"]);
    });

    it("runs Set Up Claude Code when the button is clicked", async () => {
      show.mockResolvedValueOnce("Set Up Claude Code");

      await run();

      expect(cmds.executeCommand).toHaveBeenCalledWith("markdownCollab.installClaudeSkill");
    });

    // The gap this closes: another agent's AGENTS.md section used to silence
    // the only startup prompt, so a Claude Code user there was never told.
    it("offers it even when another agent is connected", async () => {
      writeFileSync(path.join(wsDir, "AGENTS.md"), `# Repo\n\n${AGENTS_SNIPPET}`);

      await run();

      expect(messages()).toEqual([CLAUDE_SETUP_MISSING]);
    });

    it("offers it once per extension version, not once per machine", async () => {
      await run();
      await run();
      expect(show).toHaveBeenCalledTimes(1);

      pkg().version = "1.0.1";
      await run();
      expect(messages()).toEqual([CLAUDE_SETUP_MISSING, CLAUDE_SETUP_MISSING]);
    });

    it("stays quiet about it when the plugin is installed and current", async () => {
      (installedLocalPlugin as Mock).mockResolvedValue({ id: "markdown-collab@markdown-collab", version: "1.0.0" });

      await run();

      expect(messages()).not.toContain(CLAUDE_SETUP_MISSING);
    });

    it("leaves an installed standalone skill to the out-of-date check", async () => {
      writeSkill("an older skill");

      await run();

      expect(messages()).toEqual([
        "Markdown Collab: the Claude skill is out of date. Update it so Claude follows the latest comment-handling behavior.",
      ]);
    });

    it("falls back to the no-agent nudge when Claude Code isn't found", async () => {
      (lookupClaude as Mock).mockResolvedValue({ ok: false, error: "not on PATH" });

      await run();

      expect(messages()).toEqual([NO_AGENT]);
    });
  });

  // It used to ask "Update?" once per extension version; one "Not now" left
  // the person on the old hooks and skill until the next release.
  describe("when the installed plugin is older than the extension", () => {
    const pkg = () => (context as unknown as { extension: { packageJSON: { version?: string } } }).extension.packageJSON;
    let warn: Mock<any[], any>;

    beforeEach(() => {
      pkg().version = "1.0.1";
      (lookupClaude as Mock).mockResolvedValue({ ok: true, claude: { path: "/usr/bin/claude" } });
      (installedLocalPlugin as Mock).mockResolvedValue({ id: "markdown-collab@markdown-collab-local", version: "1.0.0" });
      (setUpClaudePlugin as Mock).mockReset();
      warn = vi.fn(async () => undefined);
      win.showWarningMessage = warn;
    });

    it("updates it without asking, then says so and what to restart", async () => {
      (setUpClaudePlugin as Mock).mockResolvedValue({ ok: true, version: "1.0.1" });

      await run();

      expect(setUpClaudePlugin).toHaveBeenCalledTimes(1);
      expect((setUpClaudePlugin as Mock).mock.calls[0][0]).toMatchObject({
        sourcePluginDir: path.join("/ext", "plugin"),
      });
      expect(messages()).toEqual([
        "Markdown Collab updated its Claude Code plugin (1.0.0 → 1.0.1). Restart running Claude sessions (or run /reload-plugins) to pick it up.",
      ]);
      expect(show.mock.calls[0]).toHaveLength(1); // no buttons: nothing to decide
    });

    it("does it once per extension version", async () => {
      (setUpClaudePlugin as Mock).mockResolvedValue({ ok: true, version: "1.0.1" });
      await run();
      await run();
      expect(setUpClaudePlugin).toHaveBeenCalledTimes(1);
    });

    it("says why a failed update failed, and Retry tries again", async () => {
      (setUpClaudePlugin as Mock)
        .mockResolvedValueOnce({ ok: false, reason: "claude plugin install exited 1" })
        .mockResolvedValueOnce({ ok: true, version: "1.0.1" });
      warn.mockResolvedValueOnce("Retry");

      await run();
      await vi.waitFor(() => expect(setUpClaudePlugin).toHaveBeenCalledTimes(2));

      expect(warn.mock.calls[0]).toEqual([
        "Markdown Collab couldn't update its Claude Code plugin (still 1.0.0) — claude plugin install exited 1.",
        "Retry",
      ]);
      await vi.waitFor(() => expect(messages()).toHaveLength(1));
      expect(messages()[0]).toContain("(1.0.0 → 1.0.1)");
    });

    it("leaves a current plugin alone", async () => {
      (installedLocalPlugin as Mock).mockResolvedValue({ id: "markdown-collab@markdown-collab-local", version: "1.0.1" });

      await run();

      expect(setUpClaudePlugin).not.toHaveBeenCalled();
      expect(show).not.toHaveBeenCalled();
    });
  });
});
