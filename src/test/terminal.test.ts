import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { sendViaTerminal, startClaudeTerminal } from "../transports/terminal";
import { TerminalTracker } from "../transports/terminalTracker";
import { fakeTerminal, installFakeTerminalHost, type FakeTerminal } from "./support/fakeTerminalHost";

const payload = { prompt: "do the review" } as never;
const asTerminal = (t: FakeTerminal) => t as never;

describe("sendViaTerminal", () => {
  let host: ReturnType<typeof installFakeTerminalHost>;
  let tracker: TerminalTracker;

  beforeEach(() => {
    host = installFakeTerminalHost();
    tracker = new TerminalTracker();
    tracker.activate([]);
  });

  const send = () => sendViaTerminal(payload, tracker);
  const wrote = (t: FakeTerminal) => t.sendText.mock.calls.length > 0;

  it("pastes into a running active terminal, presses enter, shows it and remembers it", async () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.activeTerminal = t;
    host.start(t, "codex");

    expect(await send()).toEqual({ ok: true, terminalName: "zsh" });
    expect(t.sendText.mock.calls).toEqual([["\x1b[200~do the review\x1b[201~", false], ["", true]]);
    expect(t.show).toHaveBeenCalledWith(true);
    expect(tracker.lastTarget).toBe(t);
  });

  it("goes back to the last target when the active terminal is idle", async () => {
    const agent = fakeTerminal("zsh");
    const other = fakeTerminal("zsh");
    host.terminals = [agent, other];
    host.start(agent, "codex");
    tracker.setLastTarget(asTerminal(agent));
    host.start(other, "ls");
    host.end(other, "ls");
    host.activeTerminal = other;

    expect(await send()).toEqual({ ok: true, terminalName: "zsh" });
    expect(wrote(agent)).toBe(true);
    expect(wrote(other)).toBe(false);
  });

  it("never writes to an idle terminal and offers to copy instead", async () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.activeTerminal = t;
    host.start(t, "ls");
    host.end(t, "ls");
    host.info.mockResolvedValueOnce(undefined);

    expect(await send()).toEqual({ ok: false, reason: "no-target" });
    expect(host.info).toHaveBeenCalledWith(
      "Nothing is running in your terminals. Start your agent in one, then Send again.",
      "Copy instead",
    );
    expect(wrote(t)).toBe(false);
  });

  it("tells the user when no terminal is open", async () => {
    host.info.mockResolvedValueOnce(undefined);

    expect(await send()).toEqual({ ok: false, reason: "no-target" });
    expect(host.info).toHaveBeenCalledWith(
      "No terminal open. Start your agent in a terminal, then Send again.",
      "Copy instead",
    );
  });

  it.each([
    ["none", () => undefined],
    [
      "idle",
      () => {
        const t = fakeTerminal("zsh");
        host.terminals = [t];
        host.start(t, "ls");
        host.end(t, "ls");
      },
    ],
  ])("copies the prompt when Copy instead is chosen with %s", async (_label, setup) => {
    setup();
    host.info.mockResolvedValueOnce("Copy instead");

    expect(await send()).toEqual({ ok: false, reason: "copied" });
    expect(host.clipboard).toHaveBeenCalledWith("do the review");
    expect(host.info).toHaveBeenLastCalledWith("Prompt copied — paste into your agent.");
  });

  it("asks before sending to an active terminal it cannot read", async () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.activeTerminal = t;
    host.info.mockResolvedValueOnce("Send");

    expect(await send()).toEqual({ ok: true, terminalName: "zsh" });
    expect(host.info).toHaveBeenCalledWith(
      `Send to terminal "zsh"? Markdown Collab can't tell what's running there.`,
      "Send",
      "Copy instead",
    );
    expect(wrote(t)).toBe(true);
    expect(tracker.lastTarget).toBe(t);
  });

  it("writes nothing when the confirmation is dismissed", async () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.activeTerminal = t;
    host.info.mockResolvedValueOnce(undefined);

    expect(await send()).toEqual({ ok: false, reason: "cancelled" });
    expect(wrote(t)).toBe(false);
    expect(host.clipboard).not.toHaveBeenCalled();
  });

  it("copies when Copy instead is chosen at the confirmation", async () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.activeTerminal = t;
    host.info.mockResolvedValueOnce("Copy instead");

    expect(await send()).toEqual({ ok: false, reason: "copied" });
    expect(host.clipboard).toHaveBeenCalledWith("do the review");
    expect(wrote(t)).toBe(false);
  });

  describe("when several terminals are running", () => {
    let a: FakeTerminal;
    let b: FakeTerminal;
    let idle: FakeTerminal;

    beforeEach(() => {
      a = fakeTerminal("zsh");
      b = fakeTerminal("bash");
      idle = fakeTerminal("zsh");
      host.terminals = [a, b, idle];
      host.activeTerminal = idle;
      host.start(a, "claude");
      host.start(b, "codex --full-auto");
      host.start(idle, "ls");
      host.end(idle, "ls");
    });

    it("lists only the running terminals with their commands and sends to the choice", async () => {
      host.quickPick.mockImplementationOnce(async (items: Array<{ label: string }>) => items[1]);

      expect(await send()).toEqual({ ok: true, terminalName: "bash" });
      expect(host.quickPick).toHaveBeenCalledWith(
        [
          { label: "zsh", description: "claude", terminal: a },
          { label: "bash", description: "codex --full-auto", terminal: b },
        ],
        { placeHolder: "Which terminal should get the prompt?" },
      );
      expect(wrote(b)).toBe(true);
      expect(wrote(a)).toBe(false);
      expect(tracker.lastTarget).toBe(b);
    });

    it("writes nothing when the picker is dismissed", async () => {
      host.quickPick.mockResolvedValueOnce(undefined);

      expect(await send()).toEqual({ ok: false, reason: "cancelled" });
      expect([a, b, idle].some(wrote)).toBe(false);
    });
  });

  it("logs the decision, the picked terminal and every terminal's activity", async () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.activeTerminal = t;
    host.start(t, "codex");
    const trace = vi.fn();

    await sendViaTerminal(payload, tracker, { log: { trace } as never });

    expect(trace).toHaveBeenCalledWith("terminal resolution", {
      decision: "send",
      picked: "zsh",
      terminals: [{ name: "zsh", activity: "running" }],
    });
  });
});

describe("startClaudeTerminal", () => {
  it("records the new terminal as running claude and as the last target", () => {
    const host = installFakeTerminalHost();
    const created = fakeTerminal("Claude Review");
    (vscode.window as unknown as Record<string, unknown>).createTerminal = () => created;
    const tracker = new TerminalTracker();
    tracker.activate([]);
    host.terminals = [created];

    startClaudeTerminal(tracker);

    expect(created.sendText).toHaveBeenCalledWith("claude", true);
    expect(tracker.activity(asTerminal(created))).toBe("running");
    expect(tracker.runningCommand(asTerminal(created))).toBe("claude");
    expect(tracker.anyClaudeTerminal()).toBe(true);
    expect(tracker.lastTarget).toBe(created);
  });
});
