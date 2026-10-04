// Pure builder for the send-mode quick-pick (10x-plan-4 P0.3), plus the guard
// that keeps it in lockstep with package.json's `markdownCollab.sendMode`
// enum — a mode listed in one place and not the other is either an option
// nobody can reach or a setting nobody is offered.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { buildSendModeItems, type PickerSendMode } from "../transports/sendModePicker";

const NO_JARGON = [
  /bracketed paste/i,
  /\bREPL\b/i,
  /\bMonitor\b/,
  /\bmdc\b/,
  /\.mjs\b/,
  /\.jsonl\b/,
];

describe("buildSendModeItems", () => {
  it("lists terminal first, labelled recommended", () => {
    const items = buildSendModeItems({});
    expect(items[0]!.mode).toBe("terminal");
    expect(items[0]!.label).toMatch(/recommended/i);
  });

  it("describes terminal in agent-neutral language — it types into whatever's there, not necessarily Claude", () => {
    const items = buildSendModeItems({});
    const terminal = items.find((i) => i.mode === "terminal")!;
    expect(terminal.description).toBe(
      "Types the prompt into whatever's running there. Works everywhere.",
    );
    expect(terminal.label).not.toMatch(/claude/i);
    expect(terminal.description).not.toMatch(/claude/i);
  });

  it("tells the human where the terminal send goes in the detail line", () => {
    const terminal = buildSendModeItems({}).find((i) => i.mode === "terminal")!;
    expect(terminal.detail).toBe("Goes to the terminal you're using, if something is running in it.");
    expect(terminal.detail).not.toMatch(/claude/i);
  });

  it("lists clipboard too", () => {
    const items = buildSendModeItems({});
    expect(items.some((i) => i.mode === "clipboard")).toBe(true);
  });

  // 10x-plan-6 P0.1: headless is listed only when it would actually run —
  // the grill established terminal is what's actually used, so it leads and
  // keeps "recommended" whether or not headless is on offer.
  it("leaves headless out when it isn't available", () => {
    for (const headlessAvailable of [undefined, false]) {
      const items = buildSendModeItems({ headlessAvailable });
      expect(items.map((i) => i.mode)).toEqual(["terminal", "clipboard"]);
    }
  });

  it("keeps terminal first and recommended, with headless second, when headless is available", () => {
    const items = buildSendModeItems({ headlessAvailable: true });
    expect(items.map((i) => i.mode)).toEqual(["terminal", "headless", "clipboard"]);
    expect(items[0]!.label).toBe("Type into the active terminal (recommended)");
    // Only one item may claim "recommended".
    expect(items.filter((i) => /recommended/i.test(i.label))).toHaveLength(1);
    expect(items[1]!.label).toBe("Run Claude for me");
  });

  it("tells the human what headless may do before they pick it", () => {
    const headless = buildSendModeItems({ headlessAvailable: true }).find(
      (i) => i.mode === "headless",
    )!;
    expect(headless.detail).toMatch(/only read files and use the review tools/);
    expect(headless.detail).toMatch(/cancel/i);
    expect(headless.detail).toMatch(/installed and signed in/i);
  });

  it("carries no jargon in any label, description, or detail", () => {
    for (const headlessAvailable of [false, true]) {
      for (const item of buildSendModeItems({ headlessAvailable })) {
        for (const field of [item.label, item.description, item.detail]) {
          if (!field) continue;
          for (const re of NO_JARGON) {
            expect(field, `"${field}" should not match ${re}`).not.toMatch(re);
          }
        }
      }
    }
  });
});

describe("picker/settings parity", () => {
  // Every concrete mode the picker can hand back must be a value someone can
  // actually set in `markdownCollab.sendMode`, and vice versa (minus `ask`,
  // which isn't a delivery — it's what leads to the picker in the first
  // place). `headless` (10x-plan-4 P0.1) is only listed when available, so the
  // builder is asked both ways.
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
  );
  const enumValues: string[] =
    packageJson.contributes.configuration.properties["markdownCollab.sendMode"].enum;
  const settingsModes = enumValues.filter((m) => m !== "ask");

  const pickerModes = [
    ...new Set(
      [true, false].flatMap((headlessAvailable) =>
        buildSendModeItems({ headlessAvailable }).map((i) => i.mode),
      ),
    ),
  ] satisfies PickerSendMode[];

  it("every settings-enum mode (except ask) appears in the picker builder", () => {
    for (const mode of settingsModes) {
      expect(pickerModes, `${mode} is a valid setting but never offered in the picker`).toContain(
        mode,
      );
    }
  });

  it("every picker mode is a valid settings-enum value", () => {
    for (const mode of pickerModes) {
      expect(settingsModes, `${mode} is offered in the picker but not a valid setting`).toContain(
        mode,
      );
    }
  });
});
