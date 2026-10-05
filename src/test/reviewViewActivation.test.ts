import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Uri, commands, window, workspace } from "./vscode-stub";
import { addThread } from "../inlineComments/format";

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

const MD = "/ws/docs/a.md";
const DOC = "# Guide\n\nThe retry policy uses exponential backoff.\n";

function docWithOpenThread(): { healthy: string; broken: string } {
  const at = DOC.indexOf("exponential backoff");
  const r = addThread(DOC, at, at + "exponential backoff".length, {
    author: "ronica",
    body: "configurable?",
    ts: "2026-07-25T12:00:00.000Z",
  });
  return { healthy: r.source, broken: r.source.replace(`<!--mc:/a:${r.thread.id}-->`, "") };
}

const noop = () => undefined;
const w = workspace as any;
const win = window as any;
const cmds = commands as any;

let text = "";
let showWarningMessage: Mock<any[], any>;
let fireChange: (u: unknown) => void;
let subscriptions: Array<{ dispose?: () => void } | undefined>;
let contextCalls: any[][];

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

const hasReview = () =>
  [...contextCalls].reverse().find((c) => c[0] === "setContext" && c[1] === "markdownCollab.hasReview")?.[2];

beforeEach(() => {
  text = docWithOpenThread().healthy;
  contextCalls = [];
  showWarningMessage = vi.fn(async () => undefined);
  w.workspaceFolders = [{ uri: Uri.file("/ws"), name: "ws", index: 0 }];
  w.textDocuments = [{ uri: Uri.file(MD), getText: () => text }];
  w.findFiles = async () => [Uri.file(MD)];
  w.createFileSystemWatcher = () => ({
    onDidCreate: () => ({ dispose: noop }),
    onDidChange: (cb: (u: unknown) => void) => {
      fireChange = cb;
      return { dispose: noop };
    },
    onDidDelete: () => ({ dispose: noop }),
    dispose: noop,
  });
  win.createOutputChannel = () => ({ trace: noop, info: noop, warn: noop, error: noop, appendLine: noop, show: noop, dispose: noop });
  win.showWarningMessage = showWarningMessage;
  cmds.executeCommand = async (...args: any[]) => {
    contextCalls.push(args);
    return undefined;
  };
});

afterEach(() => {
  for (const s of subscriptions) s?.dispose?.();
  w.workspaceFolders = undefined;
  w.textDocuments = [];
});

describe("ReviewView after activation", () => {
  it("shows the review tree for a workspace with an open thread without the tree being expanded", async () => {
    await activateExtension();
    await vi.waitFor(() => expect(hasReview()).toBe(true));
  });

  it("warns about a marker an agent breaks by hand without the tree being expanded", async () => {
    await activateExtension();
    await vi.waitFor(() => expect(hasReview()).toBe(true));

    text = docWithOpenThread().broken;
    fireChange(Uri.file(MD));

    await vi.waitFor(() => expect(showWarningMessage).toHaveBeenCalledTimes(1));
  });
});
