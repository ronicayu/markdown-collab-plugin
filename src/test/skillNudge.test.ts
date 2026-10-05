import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { maybePromptSkillUpdate } from "../commands/setup";
import { AGENTS_SNIPPET } from "../agents";
import { SKILL_REL_PATH } from "../skill";

const home = vi.hoisted(() => ({ dir: "", fingerprint: "fp1" }));

vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => home.dir,
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
});
