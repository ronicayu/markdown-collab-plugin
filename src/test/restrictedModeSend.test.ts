import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { dispatchReviewPayload } from "../commands/send";
import { headlessAvailability, runHeadless } from "../transports/headlessHost";
import { sendViaTerminal, startClaudeTerminal } from "../transports/terminal";
import { TerminalTracker } from "../transports/terminalTracker";
import { fakeTerminal, installFakeTerminalHost } from "./support/fakeTerminalHost";

vi.mock("../transports/headlessHost", () => ({
  headlessAvailability: vi.fn(),
  runHeadless: vi.fn(),
  cancelHeadlessRuns: vi.fn(),
  headlessStatusSnapshot: vi.fn(),
  resetHeadlessFailures: vi.fn(),
}));

vi.mock("../reviewPassWatch", () => ({ startReviewPassWatch: vi.fn() }));

const REMEMBERED_KEY = "markdownCollab.rememberedSendMode";
const CONVENTIONS = "ALWAYS-CITE-THE-STYLE-GUIDE";
const payload = { prompt: "do the review", file: "doc.md", unresolvedCount: 1, comments: [] } as never;
const log = { info: vi.fn(), warn: vi.fn(), trace: vi.fn(), scope: () => log } as never;
const folder = { uri: vscode.Uri.file("/ws"), name: "ws", index: 0 } as never;
const ws = vscode.workspace as unknown as Record<string, unknown>;

describe("sending in Restricted Mode", () => {
  let host: ReturnType<typeof installFakeTerminalHost>;
  let tracker: TerminalTracker;
  let settings: Record<string, unknown>;
  let stored: Map<string, unknown>;
  let update: Mock<any[], any>;
  let terminal: ReturnType<typeof fakeTerminal>;

  beforeEach(() => {
    host = installFakeTerminalHost();
    tracker = new TerminalTracker();
    tracker.activate([]);
    terminal = fakeTerminal("zsh");
    host.terminals = [terminal];
    host.activeTerminal = terminal;
    host.start(terminal, "claude");
    settings = {};
    stored = new Map();
    update = vi.fn();
    ws.isTrusted = false;
    ws.getConfiguration = () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback });
    ws.fs = { readFile: async () => Buffer.from(CONVENTIONS) };
    ws.openTextDocument = async () => ({ getText: () => "" });
    (vscode.Uri as unknown as Record<string, unknown>).joinPath = (base: { fsPath: string }, ...parts: string[]) =>
      vscode.Uri.file([base.fsPath, ...parts].join("/"));
    vi.mocked(headlessAvailability).mockReset();
    vi.mocked(runHeadless).mockReset();
  });

  afterEach(() => {
    ws.isTrusted = true;
  });

  const dispatch = (forceMode?: "headless") =>
    dispatchReviewPayload(
      payload,
      log,
      tracker,
      { get: (key: string) => stored.get(key), update, keys: () => [] } as never,
      folder,
      undefined,
      forceMode ? { forceMode } : undefined,
    );

  const expectCopiedOnly = async (outcome: Promise<unknown>) => {
    expect(await outcome).toBe("copied");
    expect(host.clipboard).toHaveBeenCalledTimes(1);
    const copied = (host.clipboard.mock.calls as unknown as string[][])[0][0];
    expect(copied).toContain("do the review");
    expect(copied).not.toContain(CONVENTIONS);
    expect(host.info.mock.calls[0]?.[0]).toContain("Restricted Mode");
    expect(host.quickPick).not.toHaveBeenCalled();
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(headlessAvailability).not.toHaveBeenCalled();
    expect(runHeadless).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  };

  it("copies the prompt when the sendMode setting says terminal", async () => {
    settings.sendMode = "terminal";
    await expectCopiedOnly(dispatch());
  });

  it("copies the prompt when the caller forces headless", async () => {
    await expectCopiedOnly(dispatch("headless"));
  });

  it("copies the prompt when a terminal was remembered for this workspace", async () => {
    stored.set(REMEMBERED_KEY, "terminal");
    await expectCopiedOnly(dispatch());
  });

  it("copies the prompt without asking when the send mode is ask and a Claude terminal is running", async () => {
    settings.sendMode = "ask";
    await expectCopiedOnly(dispatch());
  });

  it("copies in the terminal transport instead of writing to a terminal", async () => {
    const result = await sendViaTerminal({ prompt: "do the review" } as never, tracker);
    expect(result).toEqual({ ok: false, reason: "copied" });
    expect(host.clipboard).toHaveBeenCalledWith("do the review");
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("opens no Claude terminal and types nothing", () => {
    const createTerminal = vi.fn(() => terminal);
    (vscode.window as unknown as Record<string, unknown>).createTerminal = createTerminal;
    terminal.sendText.mockClear();

    expect(startClaudeTerminal(tracker)).toBeUndefined();

    expect(createTerminal).not.toHaveBeenCalled();
    expect(terminal.sendText).not.toHaveBeenCalled();
  });
});
