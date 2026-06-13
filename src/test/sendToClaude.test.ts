import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { buildReviewRequestPayload } from "../sendToClaude";

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
