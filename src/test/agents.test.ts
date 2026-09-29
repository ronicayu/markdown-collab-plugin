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

// 0.4: the snippet used to teach hand-editing the markers directly — "exactly
// what mdc.ts and skillText.ts call the single most common way this workflow
// breaks" (docs/ux-review-2026-09.md). It now follows the same hierarchy the
// skill uses: MCP tools, then the `mdc` CLI, then hand-editing as a last resort.
describe("AGENTS_SNIPPET hierarchy", () => {
  it("orders MCP tools before the mdc CLI before hand-editing", () => {
    const mcpAt = AGENTS_SNIPPET.indexOf("MCP tools");
    const mdcAt = AGENTS_SNIPPET.indexOf("mdc");
    const handEditAt = AGENTS_SNIPPET.indexOf("Hand-editing");
    expect(mcpAt).toBeGreaterThan(-1);
    expect(mdcAt).toBeGreaterThan(-1);
    expect(handEditAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeLessThan(mdcAt);
    expect(mdcAt).toBeLessThan(handEditAt);
  });

  it("names hand-editing as a last resort, not the primary instruction", () => {
    expect(AGENTS_SNIPPET).toMatch(/only when neither exists/i);
  });

  it("lists the mdc CLI verbs in one line", () => {
    expect(AGENTS_SNIPPET).toContain(
      "list / reply / open / rewrite / edit / resolve / suggest / check",
    );
  });

  it("stays under ~35 lines", () => {
    expect(AGENTS_SNIPPET.split("\n").length).toBeLessThanOrEqual(35);
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
