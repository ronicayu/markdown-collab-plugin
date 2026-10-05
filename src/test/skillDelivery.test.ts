// The prompt a headless run sends. The skill isn't installed
// there — it rides along as the system prompt — so every builder can open with
// a pointer to "the workflow in your instructions" instead of naming a skill,
// and the rest of each prompt is the same text either way.

import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORMAT_SPEC_URL } from "../agents";
import { addThread } from "../inlineComments/format";
import {
  SUGGEST_MODE_DIRECTIVE,
  buildInlinePayload,
  buildSingleThreadPayload,
  suggestModeDirective,
} from "../inlineComments/sendToClaude";
import { buildDeltaPrompt } from "../inlineComments/deltaPrompt";
import { buildMultiFileReviewPayload } from "../multiFileReview";
import { buildReviewRequestPayload } from "../sendToClaude";
import { workflowOpener } from "../skillDelivery";
import { Uri, workspace } from "./vscode-stub";

const ROOT = "/ws";
const INSTALLED =
  "Use the Markdown Collab review skill (`markdown-collab:review` in Claude Code, `markdown-collab` elsewhere, or `vs-markdown-collab` on older installs) — " +
  "or, if you don't have it, follow the \"Markdown review comments\" section of this workspace's AGENTS.md " +
  `(if it has none, the format is defined at ${FORMAT_SPEC_URL}) —`;
const INLINE = "Follow the Markdown Collab review workflow in your instructions";

const DOC = addThread("The retry uses exponential backoff.", 15, 34, {
  author: "ronica",
  body: "which cap?",
  ts: "2026-07-28T12:00:00.000Z",
}).source;

function fakeDoc(text: string, rel = "docs/guide.md") {
  return { uri: Uri.file(path.join(ROOT, rel)), getText: () => text } as never;
}

/** Everything after the first line — must not depend on the delivery. */
const rest = (prompt: string): string => prompt.split("\n").slice(1).join("\n");

beforeEach(() => {
  const folder = { uri: Uri.file(ROOT), name: "ws", index: 0 };
  (workspace as any).workspaceFolders = [folder];
  (workspace as any).getWorkspaceFolder = () => folder;
});
afterEach(() => {
  (workspace as any).workspaceFolders = undefined;
  (workspace as any).getWorkspaceFolder = () => undefined;
});

describe("workflowOpener", () => {
  it("defaults to the installed skill", () => {
    expect(workflowOpener()).toBe(INSTALLED);
    expect(workflowOpener("inline")).toBe(INLINE);
  });

  it("names the skill under each of its three names", () => {
    for (const name of ["`markdown-collab:review` in Claude Code", "`markdown-collab` elsewhere", "`vs-markdown-collab` on older installs"]) {
      expect(workflowOpener()).toContain(name);
    }
  });

  it("the headless opener names no skill", () => {
    expect(workflowOpener("inline")).not.toContain("markdown-collab");
  });
});

describe("every payload carries both openers", () => {
  it("address-all: installed by default, inline variant alongside", () => {
    const p = buildInlinePayload(fakeDoc(DOC))!;
    expect(p.prompt.startsWith(`${INSTALLED} to address the 1 unresolved review comment`)).toBe(true);
    expect(p.inlineSkillPrompt!.startsWith(`${INLINE} to address the 1 unresolved review comment`)).toBe(true);
    expect(rest(p.inlineSkillPrompt!)).toBe(rest(p.prompt));
    expect(p.inlineSkillPrompt).not.toContain("vs-markdown-collab");
  });

  it("address-all with skillDelivery inline puts the inline opener in `prompt`", () => {
    const p = buildInlinePayload(fakeDoc(DOC), { skillDelivery: "inline" })!;
    expect(p.prompt.startsWith(INLINE)).toBe(true);
  });

  it("single thread", () => {
    const id = /<!--mc:a:([a-z0-9]+)-->/.exec(DOC)![1]!;
    const p = buildSingleThreadPayload(fakeDoc(DOC), id)!;
    expect(p.prompt.startsWith(`${INSTALLED} on \`docs/guide.md\`.`)).toBe(true);
    expect(p.inlineSkillPrompt!.startsWith(`${INLINE} on \`docs/guide.md\`.`)).toBe(true);
    expect(rest(p.inlineSkillPrompt!)).toBe(rest(p.prompt));
  });

  it("suggest mode names the tool, not the CLI, when there is no CLI", () => {
    const p = buildInlinePayload(fakeDoc(DOC), { suggestMode: true })!;
    expect(p.prompt).toContain(SUGGEST_MODE_DIRECTIVE);
    expect(p.inlineSkillPrompt).toContain(suggestModeDirective("inline"));
    expect(p.inlineSkillPrompt).toContain("`mc_suggest`");
    expect(p.inlineSkillPrompt).not.toContain("mdc suggest");
  });

  it("review request", () => {
    const r = buildReviewRequestPayload(fakeDoc("# Doc\n\nBody.\n", "a.md"), "tone");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.payload.prompt.startsWith(`${INSTALLED} in Review Mode on \`a.md\`.`)).toBe(true);
    expect(r.payload.inlineSkillPrompt!.startsWith(`${INLINE} in Review Mode on \`a.md\`.`)).toBe(true);
    expect(rest(r.payload.inlineSkillPrompt!)).toBe(rest(r.payload.prompt));
    expect(r.payload.inlineSkillPrompt).toContain("Focus: tone");
  });

  it("delta review, first pass and incremental", () => {
    expect(buildDeltaPrompt("a.md", { kind: "no-checkpoint", existing: [] }, undefined, "inline")).toBe(
      `${INLINE} in Review Mode on \`a.md\`.`,
    );
    const delta = { kind: "no-checkpoint" as const, existing: [] };
    expect(buildDeltaPrompt("a.md", delta)).toBe(`${INSTALLED} in Review Mode on \`a.md\`.`);
  });

  it("multi-file review", () => {
    const p = buildMultiFileReviewPayload([
      { rel: "docs/a.md", bytes: 1 },
      { rel: "docs/b.md", bytes: 1 },
    ]);
    expect(p.prompt.startsWith(`${INSTALLED} in Review Mode on these 2 files:`)).toBe(true);
    expect(p.inlineSkillPrompt!.startsWith(`${INLINE} in Review Mode on these 2 files:`)).toBe(true);
    expect(rest(p.inlineSkillPrompt!)).toBe(rest(p.prompt));
    expect(buildMultiFileReviewPayload([{ rel: "x.md", bytes: 1 }], undefined, { skillDelivery: "inline" }).prompt.startsWith(INLINE)).toBe(true);
  });
});
