import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AGENTS_SENTINEL, AGENTS_SNIPPET, ensureAgentsSnippet } from "../agents";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-agents-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("AGENTS_SNIPPET constant", () => {
  it("contains the sentinel heading", () => {
    expect(AGENTS_SNIPPET).toContain(AGENTS_SENTINEL);
  });
});

describe("ensureAgentsSnippet", () => {
  it("returns 'created' and writes the snippet when AGENTS.md is absent", async () => {
    const result = await ensureAgentsSnippet(tmpDir);
    expect(result).toBe("created");
    const written = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8");
    expect(written).toBe(AGENTS_SNIPPET);
    expect(written.endsWith("\n")).toBe(true);
  });

  it("returns 'appended' when AGENTS.md exists without the sentinel", async () => {
    const original = "# Project Agents\n\nSome prior content.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, original, "utf8");
    const result = await ensureAgentsSnippet(tmpDir);
    expect(result).toBe("appended");
    const written = await fs.readFile(target, "utf8");
    expect(written).toBe(original + "\n\n" + AGENTS_SNIPPET);
  });

  it("returns 'already-present' and leaves content unchanged when the sentinel exists", async () => {
    const existing =
      "# Project Agents\n\n" +
      AGENTS_SENTINEL +
      "\n\nCustom notes about the review process live here.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, existing, "utf8");
    const result = await ensureAgentsSnippet(tmpDir);
    expect(result).toBe("already-present");
    const after = await fs.readFile(target, "utf8");
    expect(after).toBe(existing);
  });

  it("is idempotent: second call returns 'already-present' with no duplication", async () => {
    const first = await ensureAgentsSnippet(tmpDir);
    expect(first).toBe("created");
    const second = await ensureAgentsSnippet(tmpDir);
    expect(second).toBe("already-present");
    const written = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8");
    // Only one occurrence of the sentinel.
    const occurrences = written.split(AGENTS_SENTINEL).length - 1;
    expect(occurrences).toBe(1);
    expect(written).toBe(AGENTS_SNIPPET);
  });

  it("preserves prior unrelated sections when appending", async () => {
    const original =
      "# Project Agents\n\n## Existing Section\n\nImportant prior text that must survive.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, original, "utf8");
    await ensureAgentsSnippet(tmpDir);
    const after = await fs.readFile(target, "utf8");
    expect(after.startsWith(original)).toBe(true);
    expect(after).toContain("Existing Section");
    expect(after).toContain("Important prior text that must survive.");
    expect(after).toContain(AGENTS_SENTINEL);
  });
});
