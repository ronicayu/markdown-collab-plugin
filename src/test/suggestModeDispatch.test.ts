// Suggest mode has to survive the trip from the toggle to the prompt, on
// EVERY send path — regression guard for v0.34.59.
//
// The toggle, the setting, and the badge were all correct; four of the five
// send paths simply never read the flag, including the "Send to Claude" button
// sitting next to the toggle in the inline comments panel. Only the command
// palette passed it, so the feature looked inert from the UI that advertises
// it. Builder-level tests didn't catch it because the builders were fine — the
// call sites were the bug, which is what the last test here pins.

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import {
  SUGGEST_MODE_DIRECTIVE,
  buildInlinePayload,
  buildSingleThreadPayload,
} from "../inlineComments/sendToClaude";
import { Uri, workspace } from "./vscode-stub";

const TS = "2026-07-28T12:00:00.000Z";
const ROOT = "/ws";

/** Minimal TextDocument the payload builders actually touch. */
function fakeDoc(text: string, rel = "docs/guide.md") {
  return {
    uri: Uri.file(path.join(ROOT, rel)),
    getText: () => text,
  } as never;
}

const DOC_TEXT = addThread("The retry uses exponential backoff.", 15, 34, {
  author: "ronica",
  body: "which cap?",
  ts: TS,
}).source;

beforeEach(() => {
  (workspace as any).getWorkspaceFolder = () => ({ uri: Uri.file(ROOT), name: "ws", index: 0 });
});

afterEach(() => {
  (workspace as any).getWorkspaceFolder = () => undefined;
});

describe("buildInlinePayload", () => {
  it("omits the directive when suggest mode is off", () => {
    const p = buildInlinePayload(fakeDoc(DOC_TEXT))!;
    expect(p.prompt).not.toContain(SUGGEST_MODE_DIRECTIVE);
  });

  it("carries the directive when suggest mode is on", () => {
    const p = buildInlinePayload(fakeDoc(DOC_TEXT), { suggestMode: true })!;
    expect(p.prompt).toContain(SUGGEST_MODE_DIRECTIVE);
    expect(p.prompt).toContain("mdc suggest");
  });
});

describe("buildSingleThreadPayload", () => {
  const threadId = () => parse(DOC_TEXT).threads[0]!.id;

  it("omits the directive when suggest mode is off", () => {
    const p = buildSingleThreadPayload(fakeDoc(DOC_TEXT), threadId())!;
    expect(p.prompt).not.toContain(SUGGEST_MODE_DIRECTIVE);
  });

  it("carries the directive when suggest mode is on", () => {
    // Sending ONE thread must respect the toggle exactly like sending all of
    // them — suggest mode is a property of the request, not of its size.
    const p = buildSingleThreadPayload(fakeDoc(DOC_TEXT), threadId(), { suggestMode: true })!;
    expect(p.prompt).toContain(SUGGEST_MODE_DIRECTIVE);
  });

  it("still scopes the request to the one thread in suggest mode", () => {
    const id = threadId();
    const p = buildSingleThreadPayload(fakeDoc(DOC_TEXT), id, { suggestMode: true })!;
    expect(p.prompt).toContain(id);
    expect(p.prompt).toContain("Address only the open thread");
    expect(p.unresolvedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The actual regression: the call sites, not the builders.
// ---------------------------------------------------------------------------

/** Every `buildInlinePayload(` / `buildSingleThreadPayload(` call in a file. */
function payloadCallSites(file: string): Array<{ file: string; call: string; line: number }> {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const lines = source.split("\n");
  const out: Array<{ file: string; call: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\b(buildInlinePayload|buildSingleThreadPayload)\s*\(/.exec(lines[i]);
    if (!m) continue;
    if (/^\s*(import|export)\b/.test(lines[i])) continue;
    // Calls span a few lines once an options object is passed; take a window.
    out.push({ file, call: lines.slice(i, i + 4).join("\n"), line: i + 1 });
  }
  return out;
}

describe("every send path reads the suggest-mode toggle", () => {
  // A source-level guard, deliberately: the bug was a caller forgetting an
  // optional argument, which type-checks fine and which builder tests can't
  // see. Anything that dispatches a payload has to consult the setting.
  const HOSTS = ["extension.ts", "inlineComments/inlineCommentsPanel.ts"];

  it("finds the call sites it means to guard", () => {
    const sites = HOSTS.flatMap(payloadCallSites);
    // 2 in extension.ts (per-thread send + copy) + 1 (send all)
    // + 4 in the panel (send, copy, per-thread send, per-thread copy).
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it("passes a suggestMode option at every call site", () => {
    const missing = HOSTS.flatMap(payloadCallSites).filter(
      (site) => !/suggestMode/.test(site.call),
    );
    expect(
      missing.map((m) => `${m.file}:${m.line}`),
      "a send path that ignores the suggest-mode toggle makes the toggle a lie",
    ).toEqual([]);
  });

  it("reads it from the setting, not from a literal", () => {
    // `{ suggestMode: true }` in a host would pin the mode on regardless of
    // what the user chose; it must come from isSuggestMode()/readSuggestMode().
    for (const site of HOSTS.flatMap(payloadCallSites)) {
      expect(site.call, `${site.file}:${site.line}`).not.toMatch(/suggestMode:\s*(true|false)\b/);
    }
  });
});
