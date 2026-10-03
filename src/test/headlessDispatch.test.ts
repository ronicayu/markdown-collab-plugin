// Source-level guards for how the dispatcher treats headless (10x-plan-4
// P0.1). The behavior is covered end to end in the integration suite; these
// pin the rules that a refactor could quietly break while every test that
// exercises one path still passes.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { detectSendMode } from "../transports/detectSendMode";

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const send = read("commands/send.ts");

function dispatcherBody(): string {
  const start = send.indexOf("async function dispatchReviewPayload(");
  const next = send.indexOf("\nasync function ", start + 1);
  return send.slice(start, next === -1 ? send.length : next);
}

describe("headless is offered, never chosen", () => {
  it("auto-detection never picks it", () => {
    // Open question 1 of 10x-plan-4 is Ronica's: until it's answered, nothing
    // but the human's pick (or their setting) runs Claude in the background.
    for (const claudeTerminal of [true, false]) {
      expect(detectSendMode({ claudeTerminal })?.mode).not.toBe("headless");
    }
  });

  it("is re-checked at send time, not trusted from a remembered choice", () => {
    const body = dispatcherBody();
    const branch = body.slice(body.indexOf('if (mode === "headless")'));
    expect(branch).toMatch(/headlessAvailability\(/);
    // …and falls back to the terminal, naming why, when it can't run.
    expect(branch).toMatch(/unavailableReasonText\(/);
    expect(branch).toMatch(/mode = "terminal"/);
  });
});

describe("the headless delivery", () => {
  const body = dispatcherBody();
  const branch = body.slice(body.indexOf('if (mode === "headless")'), body.indexOf('if (mode === "clipboard")'));

  it("sends the inline-skill prompt, not the one naming an installed skill", () => {
    expect(branch).toMatch(/payload\.inlineSkillPrompt \?\? payload\.prompt/);
  });

  it("does not append the terminal's tools-or-CLI directive", () => {
    // There is no CLI in a headless run; the system prompt already says so.
    expect(branch).not.toMatch(/delivered\.prompt|mcpToolsDirective/);
  });

  it("marks the payload's threads pending, like every delivery that reaches Claude", () => {
    expect(branch).toMatch(/markPayloadPending\(payload, folder\)/);
  });

  it("hands the terminal path back for the fallbacks", () => {
    expect(branch).toMatch(/fallbackToTerminal: \(\) => deliverToTerminal\(/);
  });
});

describe("conventions ride along on both prompts", () => {
  it("applies withConventions to the inline-skill prompt too", () => {
    expect(dispatcherBody()).toMatch(/inlineSkillPrompt: withConventions\(payload\.inlineSkillPrompt, conventions\)/);
  });
});
