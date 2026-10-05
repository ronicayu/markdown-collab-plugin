import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { buildInlinePayload } from "../inlineComments/sendToClaude";
import { resolveWorkspaceFile } from "../mcpServer/index";
import { callTool, type ToolDeps } from "../mcpServer/tools";
import { buildReviewRequestPayload } from "../sendToClaude";
import { promptPathFor } from "../workspaceFolder";

type Folder = { uri: vscode.Uri; name: string; index: number };

const ws = vscode.workspace as unknown as Record<string, unknown>;
const REL = path.join("docs", "README.md");
const BODY = "# Guide\n\nThe parser handles nested lists correctly.\n";
const threadLine = `<!--mc:t {"id":"t1","quote":"One","status":"open","comments":[{"id":"c1","author":"ronica","ts":"2026-09-01T00:00:00.000Z","body":"q"}]}-->`;
const INLINE_BODY = `<!--mc:a:t1-->One<!--mc:/a:t1--> and more.\n\n<!--mc:threads:begin-->\n${threadLine}\n<!--mc:threads:end-->\n`;

let base: string;
let rootA: string;
let rootB: string;

function openFolders(...roots: string[]): Folder[] {
  const folders = roots.map((r, index) => ({ uri: vscode.Uri.file(r), name: path.basename(r), index }));
  ws.workspaceFolders = folders;
  ws.getWorkspaceFolder = (u: { fsPath: string }) =>
    folders.find((f) => u.fsPath === f.uri.fsPath || u.fsPath.startsWith(f.uri.fsPath + path.sep));
  return folders;
}

function docAt(absPath: string, text = BODY): vscode.TextDocument {
  return { uri: vscode.Uri.file(absPath), getText: () => text } as unknown as vscode.TextDocument;
}

function pathInPrompt(prompt: string): string {
  const match = /on `([^`]+)`/.exec(prompt);
  if (!match) throw new Error(`no path in prompt: ${prompt}`);
  return match[1];
}

beforeEach(async () => {
  base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mc-multiroot-")));
  rootA = path.join(base, "alpha");
  rootB = path.join(base, "beta");
  for (const root of [rootA, rootB]) {
    await fsp.mkdir(path.join(root, "docs"), { recursive: true });
    await fsp.writeFile(path.join(root, REL), BODY, "utf8");
  }
  (vscode as unknown as { FileType: unknown }).FileType = { File: 1, Directory: 2 };
  ws.fs = {
    stat: async (uri: { fsPath: string }) => {
      const s = await fsp.stat(uri.fsPath);
      return { type: s.isDirectory() ? 2 : 1 };
    },
  };
});

afterEach(async () => {
  ws.workspaceFolders = undefined;
  ws.getWorkspaceFolder = () => undefined;
  await fsp.rm(base, { recursive: true, force: true });
});

const diskDeps = (): ToolDeps => ({
  resolveFile: async (file) => (await resolveWorkspaceFile(file)).fsPath,
  readDoc: (key) => fsp.readFile(key, "utf8"),
  writeDoc: (key, next) => fsp.writeFile(key, next, "utf8"),
  now: () => "2026-10-05T00:00:00.000Z",
});

describe("the path a send prompt names", () => {
  it("is workspace-relative when one folder is open and holds the file", () => {
    openFolders(rootA);
    const result = buildReviewRequestPayload(docAt(path.join(rootA, REL)), undefined);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(pathInPrompt(result.payload.prompt)).toBe(REL);
    expect(result.payload.file).toBe(REL);
  });

  it("is the absolute path when several folders are open", () => {
    openFolders(rootA, rootB);
    const result = buildReviewRequestPayload(docAt(path.join(rootB, REL)), undefined);
    if (result.kind !== "ok") throw new Error("expected a payload");
    expect(pathInPrompt(result.payload.prompt)).toBe(path.join(rootB, REL));
  });

  it("stays workspace-relative in the payload's own file field, so consumers still join it onto the folder", () => {
    openFolders(rootA, rootB);
    const result = buildReviewRequestPayload(docAt(path.join(rootB, REL)), undefined);
    if (result.kind !== "ok") throw new Error("expected a payload");
    expect(result.payload.file).toBe(REL);
  });

  it("is the absolute path for the inline send of a document in the second folder", () => {
    openFolders(rootA, rootB);
    const payload = buildInlinePayload(docAt(path.join(rootB, REL), INLINE_BODY));
    expect(payload).not.toBeNull();
    expect(pathInPrompt(payload!.prompt)).toBe(path.join(rootB, REL));
    expect(pathInPrompt(payload!.inlineSkillPrompt!)).toBe(path.join(rootB, REL));
    expect(payload!.file).toBe(REL);
  });

  it("is the absolute path for a loose file when no folder is open", () => {
    ws.workspaceFolders = undefined;
    ws.getWorkspaceFolder = () => undefined;
    const loose = path.join(base, "notes.md");
    const result = buildReviewRequestPayload(docAt(loose), undefined);
    if (result.kind !== "ok") throw new Error("expected a payload");
    expect(pathInPrompt(result.payload.prompt)).toBe(loose);
    expect(result.payload.file).toBe("notes.md");
  });

  it("is the absolute path for a file outside the one open folder", () => {
    openFolders(rootA);
    expect(promptPathFor(vscode.Uri.file(path.join(rootB, REL)))).toBe(path.join(rootB, REL));
  });
});

describe("tool calls with several workspace folders open", () => {
  it("act on the second folder's copy when given the absolute path the prompt named", async () => {
    openFolders(rootA, rootB);
    const result = buildReviewRequestPayload(docAt(path.join(rootB, REL)), undefined);
    if (result.kind !== "ok") throw new Error("expected a payload");

    const reply = await callTool(
      "mc_open",
      { file: pathInPrompt(result.payload.prompt), quote: "nested lists", body: "Ordered too?" },
      diskDeps(),
    );

    expect(reply.isError).toBeUndefined();
    expect(await fsp.readFile(path.join(rootB, REL), "utf8")).toContain("Ordered too?");
    expect(await fsp.readFile(path.join(rootA, REL), "utf8")).toBe(BODY);
  });

  it("refuse the bare relative path as ambiguous, name the folders, and change neither copy", async () => {
    openFolders(rootA, rootB);

    const reply = await callTool(
      "mc_open",
      { file: REL, quote: "nested lists", body: "Ordered too?" },
      diskDeps(),
    );

    expect(reply.isError).toBe(true);
    const { error } = JSON.parse(reply.content[0]!.text);
    expect(error.code).toBe("ambiguous_path");
    expect(error.message).toContain("alpha");
    expect(error.message).toContain("beta");
    expect(error.message).toContain("absolute path");
    expect(await fsp.readFile(path.join(rootA, REL), "utf8")).toBe(BODY);
    expect(await fsp.readFile(path.join(rootB, REL), "utf8")).toBe(BODY);
  });

  it("resolve a relative path that exists in only one folder to that folder", async () => {
    openFolders(rootA, rootB);
    await fsp.writeFile(path.join(rootB, "only-b.md"), BODY, "utf8");
    expect((await resolveWorkspaceFile("only-b.md")).fsPath).toBe(path.join(rootB, "only-b.md"));
  });

  it("resolve a relative path from the first folder when only the first has it", async () => {
    openFolders(rootA, rootB);
    await fsp.writeFile(path.join(rootA, "only-a.md"), BODY, "utf8");
    expect((await resolveWorkspaceFile("only-a.md")).fsPath).toBe(path.join(rootA, "only-a.md"));
  });

  it("refuse an absolute path outside every folder", async () => {
    openFolders(rootA, rootB);
    const outside = path.join(base, "elsewhere.md");
    await fsp.writeFile(outside, BODY, "utf8");
    await expect(resolveWorkspaceFile(outside)).rejects.toMatchObject({ code: "file_not_found" });
  });

  it("accept an absolute path inside the only open folder", async () => {
    openFolders(rootA);
    expect((await resolveWorkspaceFile(path.join(rootA, REL))).fsPath).toBe(path.join(rootA, REL));
  });

  it("still resolve a relative path against the only open folder", async () => {
    openFolders(rootA);
    expect((await resolveWorkspaceFile(REL)).fsPath).toBe(path.join(rootA, REL));
  });
});
