import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, window, workspace } from "./vscode-stub";
import { startMcpServer } from "../mcpServer";
import { maybePromptSkillUpdate } from "../commands/setup";
import { getCliRunner, setCliGate, setCliRunner } from "../pr/cli";

vi.mock("../editorPresence");
vi.mock("../collab/collabEditorProvider");
vi.mock("../inlineComments/inlineCommentsPanel");
vi.mock("../pr/prReviewController");
vi.mock("../uncommitted/uncommittedController");
vi.mock("../mcpServer", () => ({
  startMcpServer: vi.fn(async () => null),
  pendingSignalsFromToolCalls: vi.fn(),
  ensureMcpJsonRegistration: vi.fn(),
}));
vi.mock("../mcpServer/agentConnections");
vi.mock("../transports/headlessHost");
vi.mock("../claudeStatusBar");
vi.mock("../transports/terminalTracker");
vi.mock("../commands/send");
vi.mock("../commands/review");
vi.mock("../commands/comments");
vi.mock("../commands/setup");
vi.mock("../commands/diagnostics");
vi.mock("../commands/reviewViewRouter");

const noop = () => undefined;
const w = workspace as any;
const win = window as any;
const cmds = commands as any;

let grant: (() => void) | undefined;
let executed: string[];
let subscriptions: Array<{ dispose?: () => void } | undefined>;

async function activateExtension(): Promise<void> {
  const { activate } = await import("../extension");
  subscriptions = [];
  activate({
    subscriptions,
    extensionPath: "/x",
    extensionUri: {},
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    extension: { packageJSON: {} },
  } as any);
}

beforeEach(() => {
  grant = undefined;
  executed = [];
  vi.mocked(startMcpServer).mockClear();
  vi.mocked(maybePromptSkillUpdate).mockClear();
  w.workspaceFolders = undefined;
  w.textDocuments = [];
  w.findFiles = async () => [];
  w.onDidGrantWorkspaceTrust = (cb: () => void) => {
    grant = cb;
    return { dispose: () => (grant = undefined) };
  };
  win.createOutputChannel = () => ({ trace: noop, info: noop, warn: noop, error: noop, appendLine: noop, show: noop, dispose: noop });
  cmds.executeCommand = async (id: string) => {
    executed.push(id);
    return undefined;
  };
});

afterEach(() => {
  for (const s of subscriptions) s?.dispose?.();
  w.isTrusted = true;
  setCliGate(() => true);
});

describe("activation in Restricted Mode", () => {
  it("starts neither the tool server nor the skill check while untrusted", async () => {
    w.isTrusted = false;
    await activateExtension();

    expect(startMcpServer).not.toHaveBeenCalled();
    expect(maybePromptSkillUpdate).not.toHaveBeenCalled();
  });

  it("closes the git gate while untrusted", async () => {
    w.isTrusted = false;
    const run = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    setCliRunner(run);
    await activateExtension();

    await expect(getCliRunner()("git", ["status"])).rejects.toThrow("disabled in Restricted Mode");
    expect(run).not.toHaveBeenCalled();
  });

  it("starts both once when trust is granted and refreshes the uncommitted tree", async () => {
    w.isTrusted = false;
    await activateExtension();

    w.isTrusted = true;
    const fire = grant!;
    fire();
    grant?.();

    expect(startMcpServer).toHaveBeenCalledTimes(1);
    expect(maybePromptSkillUpdate).toHaveBeenCalledTimes(1);
    expect(executed).toContain("markdownCollab.uncommittedRefresh");
  });

  it("starts both straight away in a trusted workspace without waiting for a grant", async () => {
    await activateExtension();

    expect(startMcpServer).toHaveBeenCalledTimes(1);
    expect(maybePromptSkillUpdate).toHaveBeenCalledTimes(1);
    expect(grant).toBeUndefined();
  });

  it("closes the git gate before any controller that runs git is constructed", () => {
    const source = readFileSync(resolve(__dirname, "../extension.ts"), "utf8");
    const gate = source.indexOf("setCliGate(");

    expect(gate).toBeGreaterThan(-1);
    for (const controller of ["new PrReviewController(", "new UncommittedChangesController("]) {
      expect(source.indexOf(controller)).toBeGreaterThan(gate);
    }
  });
});
