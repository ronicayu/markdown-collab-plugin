// Guard for the title-bar icon and contributed keybindings.
//
// Round 3 proposed `cmd+k cmd+m` / `cmd+k cmd+c` / `cmd+k cmd+n`; all three
// turned out to collide with VS Code defaults (Toggle Maximize Editor Group,
// Add Line Comment, and — depending on keyboard layout — nothing reserved,
// but kept out anyway since it was never verified). This asserts the icon,
// the menu entry, and the keybindings block against package.json directly, so
// a future edit can't silently reintroduce one of the denylisted chords or
// drop the Markdown scoping that keeps every binding from squatting globally.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));

const OPEN_VIEW_COMMAND = "markdownCollab.openInlineCommentsView";

// Chords that round 3 proposed and turned out to already be spoken for by VS
// Code core or its bundled extensions — verified against the 1.139 bundle.
const DENYLISTED_CHORDS = [
  "cmd+k cmd+m",
  "cmd+k cmd+c",
  "ctrl+k ctrl+m",
  "ctrl+k ctrl+c",
  "cmd+k cmd+n",
  "ctrl+k ctrl+n",
];

describe("the title-bar icon", () => {
  it("is contributed on the open-view command", () => {
    const command = pkg.contributes.commands.find((c: { command: string }) => c.command === OPEN_VIEW_COMMAND);
    expect(command).toBeTruthy();
    expect(command.icon).toBe("$(comment-discussion)");
  });

  it("has exactly one editor/title entry, in the navigation group, scoped to Markdown", () => {
    const entries = (pkg.contributes.menus["editor/title"] ?? []) as Array<{
      command: string;
      group?: string;
      when?: string;
    }>;
    const ours = entries.filter((e) => e.command === OPEN_VIEW_COMMAND);
    expect(ours).toHaveLength(1);
    expect(entries).toHaveLength(1); // no other command from this extension rides along
    expect(ours[0].group).toBe("navigation");
    expect(ours[0].when).toBeTruthy();
    expect(ours[0].when).toMatch(/resourceLangId == markdown/);
  });
});

// These shadow the workbench's own single-key
// bindings (Cmd+Z, Cmd+B, …) on purpose, but only while the caret is in the
// live editor in Editing mode — the `when` context key is the scoping
// mechanism here, not a cmd+k prefix. A chord command would miss every one
// of the keys it exists to intercept.
const KEY_HANDLED_COMMAND = "markdownCollab.liveEditor.keyHandledInEditor";

describe("contributed keybindings", () => {
  const keybindings = pkg.contributes.keybindings as Array<{
    command: string;
    key?: string;
    mac?: string;
    when?: string;
  }>;

  it("exists and covers the three P2.1 commands", () => {
    expect(keybindings.length).toBeGreaterThanOrEqual(3);
    const commands = keybindings.map((k) => k.command);
    expect(commands).toContain("markdownCollab.openInlineCommentsView");
    expect(commands).toContain("markdownCollab.commentOnSelection");
    expect(commands).toContain("markdownCollab.nextUnreadFromClaude");
  });

  it("every entry has a non-empty when clause naming markdown or the inline webview", () => {
    for (const kb of keybindings) {
      expect(kb.when, `${kb.command} has no "when"`).toBeTruthy();
      expect(
        /markdown/i.test(kb.when!),
        `${kb.command}'s "when" (${kb.when}) doesn't mention markdown or the inline webview`,
      ).toBe(true);
    }
  });

  it("uses no chord VS Code or its bundled extensions already bind", () => {
    for (const kb of keybindings) {
      for (const chord of [kb.key, kb.mac].filter((c): c is string => !!c)) {
        expect(DENYLISTED_CHORDS, `${kb.command} uses denylisted chord "${chord}"`).not.toContain(
          chord.toLowerCase(),
        );
      }
    }
  });

  it("scopes every chord under a cmd+k / ctrl+k prefix — nothing single-key or unscoped", () => {
    for (const kb of keybindings) {
      if (kb.command === KEY_HANDLED_COMMAND) continue; // single-key by design — see below
      for (const chord of [kb.key, kb.mac].filter((c): c is string => !!c)) {
        expect(chord, `${kb.command}'s chord "${chord}" isn't a two-part chord`).toMatch(/\s/);
      }
    }
  });
});

describe("the live-editor key-passthrough keybindings", () => {
  const keybindings = (
    pkg.contributes.keybindings as Array<{ command: string; key?: string; mac?: string; when?: string }>
  ).filter((k) => k.command === KEY_HANDLED_COMMAND);

  const TABLE: Array<{ key: string; mac?: string; when?: string }> = [
    { key: "ctrl+z", mac: "cmd+z" },
    { key: "ctrl+shift+z", mac: "cmd+shift+z" },
    { key: "ctrl+y", when: "markdownCollab.liveEditorTyping && !isMac" },
    { key: "ctrl+b", mac: "cmd+b" },
    { key: "ctrl+i", mac: "cmd+i" },
    { key: "ctrl+e", mac: "cmd+e" },
    { key: "ctrl+shift+b", mac: "cmd+shift+b" },
  ];

  it("has exactly the seven chords the spec's table lists, each bound to the no-op command", () => {
    expect(keybindings).toHaveLength(TABLE.length);
    for (const row of TABLE) {
      const match = keybindings.find((k) => k.key === row.key);
      expect(match, `no keybinding for "${row.key}"`).toBeTruthy();
      expect(match!.mac).toBe(row.mac);
      expect(match!.when).toBe(row.when ?? "markdownCollab.liveEditorTyping");
    }
  });

  it("is declared, hidden from the Command Palette, and registered nowhere else as a real command", () => {
    const declared = pkg.contributes.commands.find((c: { command: string }) => c.command === KEY_HANDLED_COMMAND);
    expect(declared, `${KEY_HANDLED_COMMAND} is not contributed`).toBeTruthy();
    const paletteEntries = (pkg.contributes.menus.commandPalette ?? []) as Array<{ command: string; when?: string }>;
    const hidden = paletteEntries.filter((e) => e.command === KEY_HANDLED_COMMAND);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.when).toBe("false");
  });
});

describe("Reset Send Mode", () => {
  it("test_resetSendMode_isContributedAndNotHiddenFromThePalette", () => {
    const declared = pkg.contributes.commands.find((c: { command: string }) => c.command === "markdownCollab.resetSendMode");
    expect(declared?.title).toBe("Markdown Collab: Reset Send Mode");
    const paletteEntries = (pkg.contributes.menus.commandPalette ?? []) as Array<{ command: string }>;
    expect(paletteEntries.filter((e) => e.command === "markdownCollab.resetSendMode")).toEqual([]);
  });
});
