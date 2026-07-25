// Tests for the `mdc` CLI (10x-plan P0.1).
//
// Two layers:
//   1. Staleness — the committed src/skillCli/generated.ts must match a fresh
//      bundle of src/skillCli/mdc.ts. Editing the CLI without rebuilding would
//      otherwise ship a stale helper to every user.
//   2. Behaviour — the bundled script is executed with real `node` against
//      real temp files, the same way Claude will run it. Following the
//      pattern in tailScript.test.ts.

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLI_SCRIPT_CONTENT } from "../skillCli/generated";
import { parse } from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";

let tmp: string;
let scriptPath: string;

beforeAll(() => {
  // The script is written once into a stable temp dir; each test gets its own
  // document beside it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdc-cli-"));
  scriptPath = path.join(dir, "mdc.mjs");
  fs.writeFileSync(scriptPath, CLI_SCRIPT_CONTENT, "utf8");
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdc-doc-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function json(r: RunResult): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`expected JSON on stdout, got: ${JSON.stringify(r.stdout)} / ${r.stderr}`);
  }
}

function writeDoc(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const DOC = `# API Guide

The retry policy uses exponential backoff with a cap of 30 seconds.

Authentication requires a bearer token on every request.
`;

describe("mdc CLI: the bundle is current", () => {
  it("generated.ts matches a fresh bundle of mdc.ts", async () => {
    // Importing the builder rather than shelling out keeps this fast and
    // gives a precise failure message.
    // Untyped ESM build script — the import is deliberately loose.
    const mod = (await import("../../scripts/build-skill-cli.mjs" as string)) as {
      buildSkillCli: () => Promise<string>;
    };
    const { buildSkillCli } = mod;
    const fresh = await buildSkillCli();
    expect(
      fresh === CLI_SCRIPT_CONTENT,
      "src/skillCli/generated.ts is stale — run `npm run bundle:skill-cli` and commit the result",
    ).toBe(true);
  });

  it("is a dependency-free ESM script with a shebang", () => {
    expect(CLI_SCRIPT_CONTENT.startsWith("#!/usr/bin/env node")).toBe(true);
    // Only node: builtins may be imported — the script runs from
    // ~/.claude/skills/, where there is no node_modules to resolve against.
    const imports = [...CLI_SCRIPT_CONTENT.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec.startsWith("node:"), `unexpected non-builtin import: ${spec}`).toBe(true);
    }
  });
});

describe("mdc CLI: reading", () => {
  it("check reports a clean document and exits 0", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["check", doc]);
    expect(r.status).toBe(0);
    expect(json(r).ok).toBe(true);
  });

  it("list returns threads with their live anchored text", () => {
    const doc = writeDoc("a.md", DOC);
    run(["open", doc, "--quote", "exponential backoff", "--body", "configurable?"]);
    const r = run(["list", doc]);
    expect(r.status).toBe(0);
    const data = json(r);
    expect(data.threadCount).toBe(1);
    expect(data.threads[0].anchored).toBe(true);
    expect(data.threads[0].anchoredText).toBe("exponential backoff");
  });

  it("list --actionable hides threads Claude already answered", () => {
    const doc = writeDoc("a.md", DOC);
    const opened = json(run(["open", doc, "--quote", "bearer token", "--body", "q"]));
    // Authored by claude, so it is not awaiting Claude.
    expect(json(run(["list", doc, "--actionable"])).threads).toHaveLength(0);

    // A human reply makes it actionable again.
    const raw = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(
      doc,
      raw.replace(
        /"comments":\[(.*?)\]/,
        (_m, inner) =>
          `"comments":[${inner},{"id":"c2","author":"ronica","ts":"2026-07-25T00:00:00.000Z","body":"yes"}]`,
      ),
      "utf8",
    );
    const actionable = json(run(["list", doc, "--actionable"])).threads;
    expect(actionable).toHaveLength(1);
    expect(actionable[0].id).toBe(opened.threadId);
  });
});

describe("mdc CLI: mutation keeps markers intact", () => {
  it("open anchors a passage and leaves the document healthy", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["open", doc, "--quote", "exponential backoff", "--body", "Is the cap configurable?"]);
    expect(r.status).toBe(0);
    const after = fs.readFileSync(doc, "utf8");
    expect(checkIntegrity(after).ok).toBe(true);
    const t = parse(after).threads[0];
    expect(t.quote).toBe("exponential backoff");
    expect(t.comments[0].author).toBe("claude");
  });

  it("reply appends a claude comment without touching prose", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "bearer token", "--body", "q"])).threadId;
    const proseBefore = fs.readFileSync(doc, "utf8");
    const r = run(["reply", doc, id, "--body", "answered"]);
    expect(r.status).toBe(0);
    expect(json(r).commentId).toBe("c2");
    const after = fs.readFileSync(doc, "utf8");
    // Prose is identical; only the threads region grew.
    expect(after.slice(0, after.indexOf("<!--mc:threads:begin-->"))).toBe(
      proseBefore.slice(0, proseBefore.indexOf("<!--mc:threads:begin-->")),
    );
    expect(checkIntegrity(after).ok).toBe(true);
  });

  it("rewrite replaces the anchored span, keeps both markers, and updates the quote", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"])).threadId;
    const r = run(["rewrite", doc, id, "--with", "exponential backoff with jitter"]);
    expect(r.status).toBe(0);

    const after = fs.readFileSync(doc, "utf8");
    expect(checkIntegrity(after).ok).toBe(true);
    const parsed = parse(after);
    const a = parsed.anchors.get(id)!;
    expect(after.slice(a.openEnd, a.closeStart)).toBe("exponential backoff with jitter");
    expect(parsed.threads[0].quote).toBe("exponential backoff with jitter");
    // Exactly one marker pair for this id — no duplication, no split.
    expect(after.split(`<!--mc:a:${id}-->`)).toHaveLength(2);
    expect(after.split(`<!--mc:/a:${id}-->`)).toHaveLength(2);
  });

  it("resolve flips status without disturbing the anchor", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "bearer token", "--body", "q"])).threadId;
    expect(run(["resolve", doc, id]).status).toBe(0);
    const parsed = parse(fs.readFileSync(doc, "utf8"));
    expect(parsed.threads[0].status).toBe("resolved");
    expect(parsed.anchors.has(id)).toBe(true);
  });
});

describe("mdc CLI: refuses rather than guesses", () => {
  it("refuses an ambiguous passage and names the occurrence count", () => {
    const doc = writeDoc("d.md", "# Dup\n\nThe token expires. The token refreshes.\n");
    const r = run(["open", doc, "--quote", "token", "--body", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/appears 2 times/);
    // Nothing was written.
    expect(fs.readFileSync(doc, "utf8")).not.toContain("mc:a:");
  });

  it("honours --occurrence to disambiguate", () => {
    const doc = writeDoc("d.md", "# Dup\n\nThe token expires. The token refreshes.\n");
    expect(run(["open", doc, "--quote", "token", "--occurrence", "2", "--body", "x"]).status).toBe(0);
    const after = fs.readFileSync(doc, "utf8");
    // The second occurrence is the one wrapped.
    expect(after).toContain("The token expires. The <!--mc:a:");
  });

  it("refuses to anchor inside a code span", () => {
    const doc = writeDoc("c.md", "# C\n\nUse the `token` helper.\n");
    const r = run(["open", doc, "--quote", "token", "--body", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/code block or code span/);
  });

  it("refuses to rewrite a thread that has lost its anchor", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "bearer token", "--body", "q"])).threadId;
    const raw = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, raw.split(`<!--mc:a:${id}-->`).join("").split(`<!--mc:/a:${id}-->`).join(""), "utf8");
    const r = run(["rewrite", doc, id, "--with", "nope"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no anchor markers/);
  });

  it("reports a missing thread id instead of writing anything", () => {
    const doc = writeDoc("a.md", DOC);
    const before = fs.readFileSync(doc, "utf8");
    const r = run(["reply", doc, "nosuch", "--body", "x"]);
    expect(r.status).toBe(1);
    expect(fs.readFileSync(doc, "utf8")).toBe(before);
  });

  it("reports a missing file", () => {
    const r = run(["check", path.join(tmp, "absent.md")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no such file/);
  });
});

describe("mdc CLI: check and repair", () => {
  it("check exits 2 and names the damage on a corrupted document", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"])).threadId;
    const raw = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, raw.replace(`<!--mc:/a:${id}-->`, ""), "utf8");

    const r = run(["check", doc]);
    expect(r.status).toBe(2);
    const data = json(r);
    expect(data.ok).toBe(false);
    expect(data.issues.map((i: { kind: string }) => i.kind)).toContain("unpaired-marker");
  });

  it("check --repair heals a dropped marker and restores a healthy anchor", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"])).threadId;
    const healthy = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, healthy.replace(`<!--mc:/a:${id}-->`, ""), "utf8");

    const r = run(["check", doc, "--repair"]);
    expect(r.status).toBe(0);
    expect(json(r).repaired).toBeGreaterThan(0);

    const after = fs.readFileSync(doc, "utf8");
    expect(checkIntegrity(after).ok).toBe(true);
    expect(parse(after).anchors.has(id)).toBe(true);
    // Repair restored the document to its pre-corruption state.
    expect(after).toBe(healthy);
  });

  it("repair never invents an anchor for text that is genuinely gone", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"])).threadId;
    const raw = fs.readFileSync(doc, "utf8");
    // Remove the markers AND the text they wrapped.
    fs.writeFileSync(
      doc,
      raw.replace(`<!--mc:a:${id}-->exponential backoff<!--mc:/a:${id}-->`, ""),
      "utf8",
    );
    const proseBefore = fs.readFileSync(doc, "utf8").split("<!--mc:threads:begin-->")[0];

    const r = run(["check", doc, "--repair"]);
    expect(r.status).toBe(2);
    const data = json(r);
    expect(data.ok).toBe(false);
    expect(data.remaining.some((i: { kind: string }) => i.kind === "unanchored-thread")).toBe(true);
    // Prose untouched — no guessing.
    expect(fs.readFileSync(doc, "utf8").split("<!--mc:threads:begin-->")[0]).toBe(proseBefore);
  });
});
