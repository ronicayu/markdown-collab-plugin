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
    const items = buildSendModeItems({ terminalDetected: true });
    expect(items[0]!.mode).toBe("terminal");
    expect(items[0]!.label).toMatch(/recommended/i);
  });

  it("describes terminal in plain language", () => {
    const items = buildSendModeItems({ terminalDetected: true });
    const terminal = items.find((i) => i.mode === "terminal")!;
    expect(terminal.description).toBe(
      "Types the prompt into your running Claude session. Works everywhere.",
    );
  });

  it("adds a detail on the terminal item only when no terminal is detected", () => {
    const detected = buildSendModeItems({ terminalDetected: true }).find((i) => i.mode === "terminal")!;
    expect(detected.detail).toBeUndefined();

    const notDetected = buildSendModeItems({ terminalDetected: false }).find(
      (i) => i.mode === "terminal",
    )!;
    expect(notDetected.detail).toBe(
      "No Claude terminal detected — you'll be offered to start one.",
    );
  });

  it("lists clipboard too", () => {
    const items = buildSendModeItems({ terminalDetected: true });
    expect(items.some((i) => i.mode === "clipboard")).toBe(true);
  });

  it("carries no jargon in any label, description, or detail", () => {
    for (const terminalDetected of [true, false]) {
      for (const item of buildSendModeItems({ terminalDetected })) {
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
  // place). A future mode (`headless`, a later initiative) only has to be
  // added in both places for this test to keep passing.
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
  );
  const enumValues: string[] =
    packageJson.contributes.configuration.properties["markdownCollab.sendMode"].enum;
  const settingsModes = enumValues.filter((m) => m !== "ask");

  const pickerModes = [
    ...new Set(
      [true, false].flatMap((terminalDetected) =>
        buildSendModeItems({ terminalDetected }).map((i) => i.mode),
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
