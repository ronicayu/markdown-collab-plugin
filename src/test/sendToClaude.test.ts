import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { buildReviewPayload, buildReviewRequestPayload } from "../sendToClaude";
import type { Sidecar } from "../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-send-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  (vscode.workspace as unknown as Record<string, unknown>).getWorkspaceFolder = (
    _u: unknown,
  ) => undefined;
});

function stubDoc(absPath: string): vscode.TextDocument {
  return { uri: { fsPath: absPath } } as unknown as vscode.TextDocument;
}

function silentChannel(): vscode.OutputChannel {
  const lines: string[] = [];
  return {
    appendLine: (s: string) => lines.push(s),
  } as unknown as vscode.OutputChannel;
}

async function seedSidecar(rel: string, body: Sidecar): Promise<string> {
  const target = path.join(tmpDir, ".markdown-collab", rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(body, null, 2), "utf8");
  return target;
}

function setFolder(absPath: string): void {
  const folder = {
    uri: { fsPath: absPath },
    name: path.basename(absPath),
    index: 0,
  };
  (vscode.workspace as unknown as Record<string, unknown>).getWorkspaceFolder = (
    _u: unknown,
  ) => folder;
}

function commentFixture(id: string, resolved = false) {
  return {
    id,
    anchor: { text: "anchored phrase", contextBefore: "", contextAfter: "" },
    body: "consider rephrasing",
    author: "human" as const,
    createdAt: "2026-04-01T00:00:00Z",
    resolved,
    replies: [],
  };
}

describe("buildReviewPayload", () => {
  it("returns no-workspace when the doc is outside any folder", async () => {
    const result = await buildReviewPayload(
      stubDoc(path.join(tmpDir, "nope.md")),
      silentChannel(),
    );
    expect(result.kind).toBe("no-workspace");
  });

  it("returns no-sidecar when no .markdown-collab/ entry exists for the doc", async () => {
    setFolder(tmpDir);
    const result = await buildReviewPayload(
      stubDoc(path.join(tmpDir, "missing.md")),
      silentChannel(),
    );
    expect(result.kind).toBe("no-sidecar");
  });

  it("returns empty when every comment is resolved", async () => {
    setFolder(tmpDir);
    await seedSidecar("guide.md.json", {
      version: 1,
      file: "guide.md",
      comments: [commentFixture("c_aaaaaaaa", true)],
    });
    const result = await buildReviewPayload(
      stubDoc(path.join(tmpDir, "guide.md")),
      silentChannel(),
    );
    expect(result.kind).toBe("empty");
  });

  it("returns ok with a prompt naming the relative path and the unresolved set", async () => {
    setFolder(tmpDir);
    await seedSidecar("docs/guide.md.json", {
      version: 1,
      file: "docs/guide.md",
      comments: [
        commentFixture("c_aaaaaaaa", false),
        commentFixture("c_bbbbbbbb", true),
        commentFixture("c_cccccccc", false),
      ],
    });
    const result = await buildReviewPayload(
      stubDoc(path.join(tmpDir, "docs", "guide.md")),
      silentChannel(),
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.payload.unresolvedCount).toBe(2);
    expect(result.payload.file).toBe(path.join("docs", "guide.md"));
    expect(result.payload.prompt).toContain("vs-markdown-collab skill");
    expect(result.payload.prompt).toContain(path.join("docs", "guide.md"));
    expect(result.payload.comments.map((c) => c.id)).toEqual([
      "c_aaaaaaaa",
      "c_cccccccc",
    ]);
  });
});

describe("buildReviewRequestPayload", () => {
  it("returns no-workspace when the doc is outside any folder", () => {
    const result = buildReviewRequestPayload(
      stubDoc(path.join(tmpDir, "stray.md")),
      undefined,
    );
    expect(result.kind).toBe("no-workspace");
  });

  it("emits a payload naming the rel path with no Focus: line when focus is undefined", () => {
    setFolder(tmpDir);
    const result = buildReviewRequestPayload(
      stubDoc(path.join(tmpDir, "docs", "spec.md")),
      undefined,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.payload.file).toBe(path.join("docs", "spec.md"));
    expect(result.payload.unresolvedCount).toBe(0);
    expect(result.payload.comments).toEqual([]);
    expect(result.payload.prompt).toContain("Review Mode");
    expect(result.payload.prompt).toContain(path.join("docs", "spec.md"));
    expect(result.payload.prompt).not.toContain("Focus:");
  });

  it("emits a Focus: line when focus is provided, trimmed of surrounding whitespace", () => {
    setFolder(tmpDir);
    const result = buildReviewRequestPayload(
      stubDoc(path.join(tmpDir, "README.md")),
      "  check API examples for correctness  ",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.payload.prompt).toContain(
      "Focus: check API examples for correctness",
    );
    // No leading/trailing whitespace creeping into the focus line
    expect(result.payload.prompt).not.toMatch(/Focus:\s+\s/);
  });

  it("treats a whitespace-only focus as no focus", () => {
    setFolder(tmpDir);
    const result = buildReviewRequestPayload(
      stubDoc(path.join(tmpDir, "README.md")),
      "   \t  ",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.payload.prompt).not.toContain("Focus:");
  });

  it("instructs Claude not to edit prose and not to cap thread count", () => {
    setFolder(tmpDir);
    const result = buildReviewRequestPayload(
      stubDoc(path.join(tmpDir, "README.md")),
      undefined,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.payload.prompt).toMatch(/do not edit prose/i);
    expect(result.payload.prompt).toMatch(/no upper bound|no maximum|as many/i);
  });
});
