// Legacy `markdownCollab.sendMode` values, and the remembered-per-workspace
// equivalent, both normalize to `terminal` (10x-plan-4 P0.3) — `mcp`,
// `channel`, and `mcp-channel` all delivered to a terminal already, and
// `ipc` was `channel`'s name before 0.11.0. Garbage that was never a real
// value at all keeps the older "fall back to ask and warn" behavior.

import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  maybeShowLegacySendModeToast,
  normalizeSendModeValue,
} from "../commands/send";

/** Minimal in-memory vscode.Memento, just enough for the toast gate. */
function fakeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: ((key: string, fallback?: unknown) =>
      store.has(key) ? store.get(key) : fallback) as vscode.Memento["get"],
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
}

describe("normalizeSendModeValue", () => {
  it("passes ask and the concrete modes through unchanged", () => {
    for (const mode of ["ask", "terminal", "clipboard"] as const) {
      expect(normalizeSendModeValue(mode)).toEqual({ kind: "ok", mode });
    }
  });

  it("normalizes every retired mode to terminal", () => {
    for (const legacy of ["mcp", "channel", "mcp-channel", "ipc"]) {
      expect(normalizeSendModeValue(legacy)).toEqual({ kind: "legacy", mode: "terminal" });
    }
  });

  it("falls back unrecognized garbage to ask, distinctly from a legacy value", () => {
    for (const garbage of ["bogus", "", 42, null, undefined, {}]) {
      expect(normalizeSendModeValue(garbage)).toEqual({ kind: "unknown", mode: "ask" });
    }
  });
});

describe("maybeShowLegacySendModeToast", () => {
  it("shows the retirement toast the first time", async () => {
    const calls: string[] = [];
    const original = vscode.window.showInformationMessage;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (
      msg: string,
    ) => {
      calls.push(msg);
      return Promise.resolve(undefined);
    };
    try {
      await maybeShowLegacySendModeToast(fakeMemento());
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/retired/i);
      expect(calls[0]).toMatch(/terminal/i);
    } finally {
      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
        original;
    }
  });

  it("shows the toast at most once per workspace", async () => {
    const calls: string[] = [];
    const original = vscode.window.showInformationMessage;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (
      msg: string,
    ) => {
      calls.push(msg);
      return Promise.resolve(undefined);
    };
    try {
      const memento = fakeMemento();
      await maybeShowLegacySendModeToast(memento);
      await maybeShowLegacySendModeToast(memento);
      await maybeShowLegacySendModeToast(memento);
      expect(calls).toHaveLength(1);
    } finally {
      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
        original;
    }
  });

  it("remembers having shown it in workspaceState, not just in memory", async () => {
    const calls: string[] = [];
    const original = vscode.window.showInformationMessage;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (
      msg: string,
    ) => {
      calls.push(msg);
      return Promise.resolve(undefined);
    };
    try {
      const memento = fakeMemento();
      await maybeShowLegacySendModeToast(memento);
      // A second call against the SAME memento (simulating a later send in
      // the same workspace, possibly a different session) must stay quiet.
      const keys = memento.keys();
      expect(keys.length).toBeGreaterThan(0);
      await maybeShowLegacySendModeToast(memento);
      expect(calls).toHaveLength(1);
    } finally {
      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
        original;
    }
  });
});
