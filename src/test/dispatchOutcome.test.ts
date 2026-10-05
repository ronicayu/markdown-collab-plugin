import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { dispatchReviewPayload } from "../commands/send";
import { claudePending } from "../claudePendingService";
import { parse as parseInline } from "../inlineComments/format";
import { startReviewPassWatch } from "../reviewPassWatch";
import { headlessAvailability, runHeadless } from "../transports/headlessHost";
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
const payload = { prompt: "do the review", file: "doc.md", unresolvedCount: 1, comments: [{ id: "t1" }] } as never;
const log = { info: vi.fn(), warn: vi.fn(), trace: vi.fn(), scope: () => log } as never;
const realMark = claudePending.mark.bind(claudePending);
const spyOnMark = () => vi.spyOn(claudePending, "mark").mockClear().mockImplementation(() => undefined);
const threadLine = (id: string) =>
  `<!--mc:t {"id":"${id}","quote":"q","status":"open","comments":[{"id":"c1","author":"ronica","ts":"2026-09-01T00:00:00.000Z","body":"q"}]}-->`;
const docText = `<!--mc:a:t1-->One<!--mc:/a:t1--> and <!--mc:a:t2-->two<!--mc:/a:t2-->.\n\n<!--mc:threads:begin-->\n${threadLine("t1")}\n${threadLine("t2")}\n<!--mc:threads:end-->\n`;
const docKey = vscode.Uri.file("/ws/doc.md").toString();
const folder = { uri: vscode.Uri.file("/ws"), name: "ws", index: 0 } as never;

describe("dispatchReviewPayload outcome", () => {
  let host: ReturnType<typeof installFakeTerminalHost>;
  let tracker: TerminalTracker;
  let settings: Record<string, unknown>;
  let stored: Map<string, unknown>;
  let memento: vscode.Memento;
  let mark: ReturnType<typeof spyOnMark>;
  let info: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = installFakeTerminalHost();
    tracker = new TerminalTracker();
    tracker.activate([]);
    settings = { sendMode: "terminal" };
    stored = new Map();
    memento = {
      get: (key: string) => stored.get(key),
      update: vi.fn(async (key: string, value: unknown) => void stored.set(key, value)),
      keys: () => [...stored.keys()],
    } as never;
    const ws = vscode.workspace as unknown as Record<string, unknown>;
    ws.getConfiguration = () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback });
    ws.fs = { readFile: async () => Promise.reject(new Error("absent")) };
    ws.openTextDocument = async () => ({ getText: () => "" });
    (vscode.Uri as unknown as Record<string, unknown>).joinPath = (base: { fsPath: string }, ...parts: string[]) =>
      vscode.Uri.file([base.fsPath, ...parts].join("/"));
    info = host.info;
    mark = spyOnMark();
    vi.mocked(headlessAvailability).mockResolvedValue({ ok: false, reason: "no-binary" } as never);
    vi.mocked(runHeadless).mockReset();
  });

  const dispatch = (opts?: { forceMode?: "clipboard" | "terminal" | "headless" }) =>
    dispatchReviewPayload(payload, log, tracker, memento, folder, undefined, opts);

  const runningAgent = () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.activeTerminal = t;
    host.start(t, "claude");
    return t;
  };

  describe("what the send did", () => {
    it("is delivered when the prompt is written to a terminal", async () => {
      runningAgent();
      expect(await dispatch()).toBe("delivered");
    });

    it("is copied in clipboard mode", async () => {
      settings.sendMode = "clipboard";
      expect(await dispatch()).toBe("copied");
      expect(host.clipboard).toHaveBeenCalled();
    });

    it("is copied when Copy instead is chosen in a terminal dialog", async () => {
      info.mockResolvedValueOnce("Copy instead");
      expect(await dispatch()).toBe("copied");
    });

    it("is cancelled when the terminal dialog is dismissed", async () => {
      info.mockResolvedValueOnce(undefined);
      expect(await dispatch()).toBe("cancelled");
      expect(host.clipboard).not.toHaveBeenCalled();
    });

    it("is cancelled when the mode picker is dismissed", async () => {
      settings.sendMode = "ask";
      host.quickPick.mockResolvedValueOnce(undefined);
      expect(await dispatch()).toBe("cancelled");
    });

    it("is delivered when a headless run starts", async () => {
      settings.sendMode = "headless";
      vi.mocked(headlessAvailability).mockResolvedValue({ ok: true } as never);
      vi.mocked(runHeadless).mockResolvedValue("started");
      expect(await dispatch()).toBe("delivered");
    });

    it("is cancelled when the headless run is declined", async () => {
      settings.sendMode = "headless";
      vi.mocked(headlessAvailability).mockResolvedValue({ ok: true } as never);
      vi.mocked(runHeadless).mockResolvedValue("declined");
      expect(await dispatch()).toBe("cancelled");
    });

    it("takes the terminal's outcome when headless is unavailable", async () => {
      settings.sendMode = "headless";
      runningAgent();
      expect(await dispatch()).toBe("delivered");
    });
  });

  describe("the waiting row", () => {
    it("starts after a clipboard-mode copy", async () => {
      settings.sendMode = "clipboard";
      await dispatch();
      expect(mark).toHaveBeenCalledWith(expect.any(String), expect.anything(), ["t1"], "inferred");
    });

    it("starts after Copy instead", async () => {
      info.mockResolvedValueOnce("Copy instead");
      await dispatch();
      expect(mark).toHaveBeenCalledWith(expect.any(String), expect.anything(), ["t1"], "inferred");
    });

    it("watches for the review after Copy instead on a review request", async () => {
      vi.mocked(startReviewPassWatch).mockClear();
      info.mockResolvedValueOnce("Copy instead");
      await dispatchReviewPayload(payload, log, tracker, memento, folder, { kind: "review-request", hasFocus: false });
      expect(startReviewPassWatch).toHaveBeenCalledTimes(1);
    });

    it("does not start after a cancel", async () => {
      info.mockResolvedValueOnce(undefined);
      await dispatch();
      expect(mark).not.toHaveBeenCalled();
    });
  });

  describe("the waiting row after a headless send", () => {
    const twoThreads = { ...(payload as object), comments: [{ id: "t1" }, { id: "t2" }] } as never;
    const waiting = () => claudePending.pending(docKey, parseInline(docText).threads);

    beforeEach(() => {
      mark.mockImplementation(realMark);
      claudePending.clear(docKey);
      (vscode.workspace as unknown as Record<string, unknown>).openTextDocument = async () => ({
        getText: () => docText,
      });
      settings.sendMode = "headless";
      vi.mocked(headlessAvailability).mockResolvedValue({ ok: true } as never);
    });

    const sendTwo = () => dispatchReviewPayload(twoThreads, log, tracker, memento, folder);

    it("a declined headless send leaves no thread waiting", async () => {
      vi.mocked(runHeadless).mockResolvedValue("declined");
      expect(await sendTwo()).toBe("cancelled");
      expect(waiting()).toEqual([]);
    });

    it("a declined headless send does not clear a thread that was already waiting", async () => {
      claudePending.mark(docKey, parseInline(docText).threads, ["t1"], "inferred");
      vi.mocked(runHeadless).mockResolvedValue("declined");
      await sendTwo();
      expect(waiting()).toEqual(["t1"]);
    });

    it("a started headless send leaves its threads waiting", async () => {
      vi.mocked(runHeadless).mockResolvedValue("started");
      await sendTwo();
      expect(waiting().sort()).toEqual(["t1", "t2"]);
    });
  });

  describe("the remembered mode", () => {
    beforeEach(() => {
      settings.sendMode = "ask";
    });

    it("is not written when terminal was picked and the dialog dismissed", async () => {
      host.quickPick.mockResolvedValueOnce({ mode: "terminal" });
      info.mockResolvedValueOnce(undefined);
      expect(await dispatch()).toBe("cancelled");
      expect(memento.update).not.toHaveBeenCalledWith(REMEMBERED_KEY, expect.anything());
    });

    it("is not written when terminal was picked and Copy instead chosen", async () => {
      host.quickPick.mockResolvedValueOnce({ mode: "terminal" });
      info.mockResolvedValueOnce("Copy instead");
      expect(await dispatch()).toBe("copied");
      expect(memento.update).not.toHaveBeenCalledWith(REMEMBERED_KEY, expect.anything());
    });

    it("is terminal once a picked terminal send is delivered", async () => {
      host.quickPick.mockResolvedValueOnce({ mode: "terminal" });
      const t = fakeTerminal("zsh");
      host.terminals = [t];
      host.activeTerminal = t;
      host.start(t, "codex");
      expect(await dispatch()).toBe("delivered");
      expect(stored.get(REMEMBERED_KEY)).toBe("terminal");
    });

    it("is terminal once an auto-detected terminal send is delivered", async () => {
      runningAgent();
      expect(await dispatch()).toBe("delivered");
      expect(stored.get(REMEMBERED_KEY)).toBe("terminal");
      expect(host.quickPick).not.toHaveBeenCalled();
    });

    it("is clipboard once picked, and the toast says how to reset it", async () => {
      host.quickPick.mockResolvedValueOnce({ mode: "clipboard" });
      expect(await dispatch()).toBe("copied");
      expect(stored.get(REMEMBERED_KEY)).toBe("clipboard");
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Run "Markdown Collab: Reset Send Mode" to change later.'));
    });

    it("is headless once a picked headless run starts", async () => {
      host.quickPick.mockResolvedValueOnce({ mode: "headless" });
      vi.mocked(headlessAvailability).mockResolvedValue({ ok: true } as never);
      vi.mocked(runHeadless).mockResolvedValue("started");
      expect(await dispatch()).toBe("delivered");
      expect(stored.get(REMEMBERED_KEY)).toBe("headless");
    });

    it("is not written when a picked headless run is declined", async () => {
      host.quickPick.mockResolvedValueOnce({ mode: "headless" });
      vi.mocked(headlessAvailability).mockResolvedValue({ ok: true } as never);
      vi.mocked(runHeadless).mockResolvedValue("declined");
      expect(await dispatch()).toBe("cancelled");
      expect(stored.has(REMEMBERED_KEY)).toBe(false);
    });

    it("is never written by a forced mode", async () => {
      expect(await dispatch({ forceMode: "clipboard" })).toBe("copied");
      expect(stored.has(REMEMBERED_KEY)).toBe(false);
    });

    it("is rewritten as terminal when it held a retired value", async () => {
      stored.set(REMEMBERED_KEY, "mcp-channel");
      info.mockResolvedValueOnce(undefined);
      expect(await dispatch()).toBe("cancelled");
      expect(stored.get(REMEMBERED_KEY)).toBe("terminal");
    });
  });
});
