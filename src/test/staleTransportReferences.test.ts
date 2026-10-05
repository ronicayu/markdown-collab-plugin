// 10x-plan-4 P0.3 deleted the channel transports outright, not just hid
// them. This is the trip-wire: none of the strings that only ever meant
// "the event-log / MCP-channel send modes" may resurface in anything a user
// or Claude reads — the README, the shipped skill, the walkthrough copy, or
// package.json.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { SKILL_CONTENT } from "../skill";

const ROOT = path.resolve(__dirname, "..", "..");

const STALE_STRINGS = ["mdc-tail", "mdc-channel", "events.jsonl", "Monitor"];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("no stale channel-transport references remain", () => {
  const targets: Array<{ label: string; content: string }> = [
    { label: "README.md", content: read("README.md") },
    { label: "SKILL_CONTENT", content: SKILL_CONTENT },
    { label: "media/walkthrough/send.md", content: read("media/walkthrough/send.md") },
    { label: "media/walkthrough/agents.md", content: read("media/walkthrough/agents.md") },
    { label: "package.json", content: read("package.json") },
  ];

  for (const { label, content } of targets) {
    for (const needle of STALE_STRINGS) {
      it(`${label} does not mention "${needle}"`, () => {
        expect(content).not.toContain(needle);
      });
    }
  }
});
