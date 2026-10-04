import { beforeEach, describe, expect, it } from "vitest";
import { TerminalTracker } from "../transports/terminalTracker";
import { fakeTerminal, installFakeTerminalHost } from "./support/fakeTerminalHost";

const asTerminal = (t: unknown) => t as never;

describe("TerminalTracker", () => {
  let host: ReturnType<typeof installFakeTerminalHost>;
  let tracker: TerminalTracker;

  beforeEach(() => {
    host = installFakeTerminalHost();
    tracker = new TerminalTracker();
    tracker.activate([]);
  });

  it("reports running after a command starts and idle after it ends", () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.start(t, "npm test");
    expect(tracker.activity(asTerminal(t))).toBe("running");
    expect(tracker.runningCommand(asTerminal(t))).toBe("npm test");
    host.end(t, "npm test");
    expect(tracker.activity(asTerminal(t))).toBe("idle");
    expect(tracker.runningCommand(asTerminal(t))).toBeUndefined();
  });

  it("falls back to the terminal name when no event was seen", () => {
    expect(tracker.activity(asTerminal(fakeTerminal("zsh")))).toBe("unknown");
    expect(tracker.activity(asTerminal(fakeTerminal("node")))).toBe("running");
  });

  it("detects a running claude command, and stops once it ends", () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    expect(tracker.anyClaudeTerminal()).toBe(false);
    host.start(t, "claude --resume");
    expect(tracker.anyClaudeTerminal()).toBe(true);
    host.end(t, "claude --resume");
    expect(tracker.anyClaudeTerminal()).toBe(false);
  });

  it("does not treat another running command as claude", () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.start(t, "codex");
    expect(tracker.anyClaudeTerminal()).toBe(false);
  });

  it("counts a terminal we started claude in as running claude without shell integration", () => {
    const bare = installFakeTerminalHost({ withShellIntegration: false });
    const noEvents = new TerminalTracker();
    noEvents.activate([]);
    const t = fakeTerminal("zsh");
    bare.terminals = [t];
    noEvents.markClaudeStarted(asTerminal(t));
    expect(noEvents.anyClaudeTerminal()).toBe(true);
    expect(noEvents.activity(asTerminal(t))).toBe("running");
    expect(noEvents.lastTarget).toBe(t);
  });

  it("remembers the last target", () => {
    const t = fakeTerminal("zsh");
    expect(tracker.lastTarget).toBeUndefined();
    tracker.setLastTarget(asTerminal(t));
    expect(tracker.lastTarget).toBe(t);
  });

  it("forgets a closed terminal's events and last target", () => {
    const t = fakeTerminal("zsh");
    host.terminals = [t];
    host.start(t, "claude");
    tracker.setLastTarget(asTerminal(t));
    host.close(t);
    expect(tracker.lastTarget).toBeUndefined();
    expect(tracker.activity(asTerminal(t))).toBe("unknown");
  });
});
