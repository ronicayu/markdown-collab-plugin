// A send that asks for suggestions has to carry that to the prompt. It used to
// be a setting that four of five send paths forgot to read (v0.34.59); it is
// now chosen per send — "Send as suggestions" — and passed along explicitly.

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

// Suggestions are chosen per send, not by a setting: the two sends that can
// ask for them take the choice from their caller, and nothing reads a mode.
describe("the sends that can ask for suggestions take the choice per send", () => {
  it("send-all and send-thread pass the caller's choice; nothing reads a suggest-mode setting", () => {
    const send = fs.readFileSync(path.join(__dirname, "..", "commands/send.ts"), "utf8");
    expect(send).toContain("buildInlinePayload(doc, { suggestMode: suggest })");
    expect(send).toContain("suggestMode: suggestFrom(opts),");
    for (const host of ["commands/send.ts", "collab/sidebarHost.ts", "mcpServer/index.ts", "skillCli/guardHook.ts"]) {
      expect(fs.readFileSync(path.join(__dirname, "..", host), "utf8"), host).not.toContain("proposeEditsAsSuggestions");
    }
  });
});

// ---------------------------------------------------------------------------
// The same class of bug, for the "Claude is working…" indicator (P1.2): a
// dispatch that forgets to mark its threads pending leaves the user staring at
// a card that says nothing while Claude works.
// ---------------------------------------------------------------------------

describe("dispatch marks its threads pending", () => {
  // Marking lives in `dispatchReviewPayload`'s delivery branches rather than
  // in each command, so a new send path cannot forget it — the earlier draft
  // of this feature marked at call sites and immediately missed one.
  // dispatchReviewPayload lives in src/commands/send.ts.
  const source = fs.readFileSync(path.join(__dirname, "..", "commands/send.ts"), "utf8");

  function dispatcherBody(): string {
    const start = source.indexOf("async function dispatchReviewPayload(");
    expect(start, "dispatchReviewPayload not found").toBeGreaterThan(-1);
    const next = source.indexOf("\nasync function ", start + 1);
    const end = next === -1 ? source.length : next;
    return source.slice(start, end);
  }

  it("marks pending inside the dispatcher, not at the call sites", () => {
    expect(dispatcherBody()).toMatch(/markPayloadPending\(payload, folder\)/);
  });

  it("marks on every branch that delivers or copies, and not on a cancelled send", () => {
    const body = dispatcherBody();
    const clipboard = body.slice(body.indexOf('if (mode === "clipboard")'));
    expect(clipboard).toMatch(/markPayloadPending\(payload, folder\)/);
    const copiedInTerminal = body.slice(body.indexOf("const deliverToTerminal"), body.indexOf("const settle"));
    expect(copiedInTerminal).toMatch(/reason !== "copied"\) return "cancelled";\s+await markPayloadPending\(payload, folder\)/);
    expect((body.match(/markPayloadPending\(/g) ?? []).length).toBe(4);
  });

  it("derives the threads from the payload rather than a caller argument", () => {
    // payload.comments carries thread ids for comment-addressing sends and is
    // empty for review-mode, which is exactly the right marking behavior.
    expect(source).toMatch(/const threadIds = payload\.comments\.map/);
  });
});
