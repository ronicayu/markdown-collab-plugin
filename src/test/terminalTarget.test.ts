import { describe, expect, it } from "vitest";
import {
  chooseTarget,
  terminalActivity,
  type Activity,
  type TerminalCandidate,
} from "../transports/terminalTarget";

const start = { kind: "start", command: "claude" } as const;
const end = { kind: "end" } as const;

describe("terminalActivity", () => {
  it("is running when the last event is a start with no end after it", () => {
    expect(terminalActivity(start, "zsh")).toBe("running");
  });

  it("is idle when the last event is an end", () => {
    expect(terminalActivity(end, "claude")).toBe("idle");
  });

  it.each(["zsh", "bash", "sh", "fish", "pwsh", "powershell", "cmd", "nu", "ksh", "csh", "tcsh", "dash"])(
    "is unknown for the plain shell name %s when no event was seen",
    (name) => {
      expect(terminalActivity(undefined, name)).toBe("unknown");
    },
  );

  it.each(["-zsh", "ZSH", "  bash  ", "pwsh.exe", "cmd.exe", "-bash.exe"])(
    "treats %j as a plain shell name",
    (name) => {
      expect(terminalActivity(undefined, name)).toBe("unknown");
    },
  );

  it.each(["claude", "node", "codex", "Claude Review", "zsh-5", "python3"])(
    "is running for the non-shell title %s when no event was seen",
    (name) => {
      expect(terminalActivity(undefined, name)).toBe("running");
    },
  );
});

type T = { id: string };

const cand = (id: string, activity: Activity, command?: string): TerminalCandidate<T> => ({
  terminal: { id },
  name: id,
  activity,
  command,
});

describe("chooseTarget", () => {
  it("returns none when no terminals are open", () => {
    expect(chooseTarget<T>([], undefined, undefined)).toEqual({ kind: "none" });
  });

  it("sends to the active terminal when it is running", () => {
    const a = cand("a", "running");
    const b = cand("b", "running");
    expect(chooseTarget([a, b], b.terminal, undefined)).toEqual({ kind: "send", terminal: b.terminal });
  });

  it("prefers a running active terminal over a different last target", () => {
    const a = cand("a", "running");
    const b = cand("b", "running");
    expect(chooseTarget([a, b], b.terminal, a.terminal)).toEqual({ kind: "send", terminal: b.terminal });
  });

  it("sends to the last target when the active terminal is not running", () => {
    const a = cand("a", "running");
    const b = cand("b", "idle");
    expect(chooseTarget([a, b], b.terminal, a.terminal)).toEqual({ kind: "send", terminal: a.terminal });
  });

  it("sends to a last target whose activity is unknown", () => {
    const a = cand("a", "unknown");
    const b = cand("b", "running");
    const c = cand("c", "idle");
    expect(chooseTarget([a, b, c], c.terminal, a.terminal)).toEqual({ kind: "send", terminal: a.terminal });
  });

  it("skips a last target that has gone idle", () => {
    const a = cand("a", "idle");
    const b = cand("b", "running");
    expect(chooseTarget([a, b], undefined, a.terminal)).toEqual({ kind: "send", terminal: b.terminal });
  });

  it("skips a last target that is no longer open", () => {
    const b = cand("b", "running");
    expect(chooseTarget([b], undefined, { id: "closed" })).toEqual({ kind: "send", terminal: b.terminal });
  });

  it("sends to the only running terminal when nothing else matches", () => {
    const a = cand("a", "idle");
    const b = cand("b", "running");
    expect(chooseTarget([a, b], a.terminal, undefined)).toEqual({ kind: "send", terminal: b.terminal });
  });

  it("picks among running terminals when there is more than one", () => {
    const a = cand("a", "running", "claude");
    const b = cand("b", "idle");
    const c = cand("c", "running", "codex");
    expect(chooseTarget([a, b, c], b.terminal, undefined)).toEqual({ kind: "pick", terminals: [a, c] });
  });

  it("asks for confirmation when only the active terminal is unknown", () => {
    const a = cand("a", "unknown");
    const b = cand("b", "idle");
    expect(chooseTarget([a, b], a.terminal, undefined)).toEqual({ kind: "confirm", terminal: a.terminal });
  });

  it("sends to the one other running terminal when the active one is unknown", () => {
    const a = cand("a", "unknown");
    const b = cand("b", "running");
    expect(chooseTarget([a, b], a.terminal, undefined)).toEqual({ kind: "send", terminal: b.terminal });
  });

  it("returns idle when every terminal is idle", () => {
    const a = cand("a", "idle");
    const b = cand("b", "idle");
    expect(chooseTarget([a, b], a.terminal, undefined)).toEqual({ kind: "idle" });
  });

  it("returns idle when nothing is active and nothing is running", () => {
    const a = cand("a", "unknown");
    expect(chooseTarget([a], undefined, undefined)).toEqual({ kind: "idle" });
  });
});
