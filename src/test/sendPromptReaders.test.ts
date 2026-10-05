import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORMAT_SPEC_URL } from "../agents";
import { addThread, parse } from "../inlineComments/format";
import { buildInlinePayload, buildSingleThreadPayload } from "../inlineComments/sendToClaude";
import { buildMultiFileReviewPayload } from "../multiFileReview";
import { buildReviewRequestPayload, mcpToolsDirective } from "../sendToClaude";
import { Uri, workspace } from "./vscode-stub";

const ROOT = "/ws";
const DOC = addThread("The retry uses exponential backoff.", 15, 34, {
  author: "ronica",
  body: "which cap?",
  ts: "2026-07-28T12:00:00.000Z",
}).source;

function fakeDoc(text: string, rel = "docs/guide.md") {
  return { uri: Uri.file(path.join(ROOT, rel)), getText: () => text } as never;
}

const terminalPrompt = (prompt: string): string => `${prompt}\n\n${mcpToolsDirective()}`;

beforeEach(() => {
  const folder = { uri: Uri.file(ROOT), name: "ws", index: 0 };
  (workspace as any).workspaceFolders = [folder];
  (workspace as any).getWorkspaceFolder = () => folder;
});
afterEach(() => {
  (workspace as any).workspaceFolders = undefined;
  (workspace as any).getWorkspaceFolder = () => undefined;
});

function expectsEveryKindOfReader(prompt: string): void {
  expect(prompt).toContain("`markdown-collab:review`");
  expect(prompt).toContain("if you don't have it");
  expect(prompt).toContain('"Markdown review comments" section of this workspace\'s AGENTS.md');
  expect(prompt).toContain(FORMAT_SPEC_URL);
  expect(prompt).not.toContain("if you are not Claude Code");
  expect(prompt).not.toContain("as the skill describes");
  expect(prompt).toContain("use the `mdc` CLI if the skill gave you one, otherwise edit the file by hand");
  expect(prompt.match(/`mdc`/g)).toHaveLength(1);
}

describe("the terminal and clipboard prompts, for an agent with the skill, the tools, or neither", () => {
  it("a comment send points at the skill, AGENTS.md's section and the format spec", () => {
    expectsEveryKindOfReader(terminalPrompt(buildInlinePayload(fakeDoc(DOC))!.prompt));
  });

  it("a single-thread send does too", () => {
    const id = parse(DOC).threads[0]!.id;
    expectsEveryKindOfReader(terminalPrompt(buildSingleThreadPayload(fakeDoc(DOC), id)!.prompt));
  });

  it("a review request does too", () => {
    const r = buildReviewRequestPayload(fakeDoc("# Doc\n\nBody.\n", "a.md"), "tone");
    if (r.kind !== "ok") throw new Error("expected ok");
    expectsEveryKindOfReader(terminalPrompt(r.payload.prompt));
  });

  it("a multi-file review does too", () => {
    const p = buildMultiFileReviewPayload([
      { rel: "docs/a.md", bytes: 1 },
      { rel: "docs/b.md", bytes: 1 },
    ]);
    expectsEveryKindOfReader(terminalPrompt(p.prompt));
  });

  it("every opener continues into its own sentence", () => {
    const id = parse(DOC).threads[0]!.id;
    const r = buildReviewRequestPayload(fakeDoc("# Doc\n", "a.md"), undefined);
    if (r.kind !== "ok") throw new Error("expected ok");
    const openers = [
      buildInlinePayload(fakeDoc(DOC))!.prompt.split("\n")[0],
      buildSingleThreadPayload(fakeDoc(DOC), id)!.prompt.split("\n")[0],
      r.payload.prompt.split("\n")[0],
      buildMultiFileReviewPayload([{ rel: "a.md", bytes: 1 }]).prompt.split("\n")[0],
    ];
    for (const line of openers) expect(line).toMatch(/AGENTS\.md \(if it has none, the format is defined at \S+\) — (to address|on|in Review Mode)/);
  });

  it("suggest mode names mc_suggest, mdc suggest and the by-hand route", () => {
    const prompt = buildInlinePayload(fakeDoc(DOC), { suggestMode: true })!.prompt;
    expect(prompt).toContain("`mc_suggest` if you have the `markdown-collab` MCP tools");
    expect(prompt).toContain("`mdc suggest` if you have the `mdc` CLI");
    expect(prompt).toContain('otherwise by hand as the "Suggesting an edit" bullet');
    expect(prompt).toContain("AGENTS.md");
  });

  it("a single-thread send in suggest mode names all three routes too", () => {
    const id = parse(DOC).threads[0]!.id;
    const prompt = buildSingleThreadPayload(fakeDoc(DOC), id, { suggestMode: true })!.prompt;
    expect(prompt).toContain("`mc_suggest`");
    expect(prompt).toContain("`mdc suggest`");
    expect(prompt).toContain("by hand");
  });
});

describe("the headless prompt", () => {
  const INLINE_OPENER = "Follow the Markdown Collab review workflow in your instructions";

  it("keeps its opener and has no AGENTS.md or format-spec pointer", () => {
    const prompt = buildInlinePayload(fakeDoc(DOC))!.inlineSkillPrompt!;
    expect(prompt.startsWith(`${INLINE_OPENER} to address the 1 unresolved review comment on \`docs/guide.md\`.`)).toBe(true);
    expect(prompt).not.toContain("AGENTS.md");
    expect(prompt).not.toContain(FORMAT_SPEC_URL);
    expect(prompt).not.toContain("mdc");
  });

  it("keeps its suggest wording, which names only mc_suggest", () => {
    const prompt = buildInlinePayload(fakeDoc(DOC), { suggestMode: true })!.inlineSkillPrompt!;
    expect(prompt).toContain(
      "Work in SUGGEST MODE: propose every edit as a suggestion via `mc_suggest` " +
        "instead of editing the prose directly. The reviewer will accept or reject each one.",
    );
    expect(prompt).not.toContain("mdc suggest");
    expect(prompt).not.toContain("by hand");
  });
});
