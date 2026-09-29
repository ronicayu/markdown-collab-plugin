// Tests for the `mdc` CLI (10x-plan P0.1).
//
// Two layers:
//   1. Staleness — the committed src/skillCli/generated.ts must match a fresh
//      bundle of src/skillCli/mdc.ts. Editing the CLI without rebuilding would
//      otherwise ship a stale helper to every user.
//   2. Behaviour — the bundled script is executed with real `node` against
//      real temp files, the same way Claude will run it. Following the
//      pattern in tailScript.test.ts.

import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import { createServer, type IncomingHttpHeaders } from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLI_SCRIPT_CONTENT } from "../skillCli/generated";
import { parse } from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";
import { serveMcp } from "../mcpServer/httpServer";
import { ENV_TOKEN, ENV_URL } from "../mcpServer/registration";
import { SessionRegistry } from "../mcpServer/sessions";
import { TOOLS, ToolRefusal, callTool, type ToolDeps } from "../mcpServer/tools";

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

/**
 * The CLI's environment: this process's, minus the extension address a VS
 * Code terminal hands out — run from one, every write here would otherwise be
 * forwarded to the real extension. `ext` puts a (test) address back.
 */
function cliEnv(ext?: { url: string; token: string }): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[ENV_URL];
  delete env[ENV_TOKEN];
  if (ext) {
    env[ENV_URL] = ext.url;
    env[ENV_TOKEN] = ext.token;
  }
  return env;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], { encoding: "utf8", env: cliEnv() });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Like `run`, but pipes `stdinInput` in — for `mdc check --hook`, which reads its target off stdin rather than argv. */
function runWithStdin(args: string[], stdinInput: string): RunResult {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      input: stdinInput,
      env: cliEnv(),
    });
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

describe("mdc CLI: suggest / accept / reject", () => {
  it("suggest stores the proposal and leaves the prose showing the original", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["suggest", doc, "--quote", "exponential backoff", "--with", "exponential backoff with jitter", "--note", "why"]);
    expect(r.status).toBe(0);
    const anchorId = json(r).anchorId;

    const after = fs.readFileSync(doc, "utf8");
    expect(checkIntegrity(after).ok).toBe(true);
    const prose = after.slice(0, after.indexOf("<!--mc:threads:begin-->")).replace(/<!--mc:[^>]*-->/g, "");
    expect(prose).toContain("uses exponential backoff with a cap");
    expect(prose).not.toContain("with jitter");

    const s = parse(after).suggestions[0];
    expect(s.anchorId).toBe(anchorId);
    expect(s.proposed).toBe("exponential backoff with jitter");
    expect(s.note).toBe("why");
  });

  it("accept applies the proposal into the prose and clears the suggestion", () => {
    const doc = writeDoc("a.md", DOC);
    const anchorId = json(run(["suggest", doc, "--quote", "exponential backoff", "--with", "exponential backoff with jitter"])).anchorId;
    expect(run(["accept", doc, anchorId]).status).toBe(0);
    const after = fs.readFileSync(doc, "utf8");
    expect(after).toContain("uses exponential backoff with jitter with a cap");
    expect(parse(after).suggestions).toHaveLength(0);
    expect(checkIntegrity(after).ok).toBe(true);
  });

  it("reject keeps the original and clears the suggestion", () => {
    const doc = writeDoc("a.md", DOC);
    const anchorId = json(run(["suggest", doc, "--quote", "exponential backoff", "--with", "linear backoff"])).anchorId;
    expect(run(["reject", doc, anchorId]).status).toBe(0);
    const after = fs.readFileSync(doc, "utf8");
    expect(after).toBe(DOC); // fully reversible
    expect(parse(after).suggestions).toHaveLength(0);
  });

  it("list surfaces suggestions with original + proposed", () => {
    const doc = writeDoc("a.md", DOC);
    run(["suggest", doc, "--quote", "exponential backoff", "--with", "exponential backoff with jitter"]);
    const data = json(run(["list", doc]));
    expect(data.suggestionCount).toBe(1);
    expect(data.suggestions[0].original).toBe("exponential backoff");
    expect(data.suggestions[0].proposed).toBe("exponential backoff with jitter");
    expect(data.suggestions[0].anchored).toBe(true);
  });

  it("refuses a suggestion inside a code span", () => {
    const doc = writeDoc("c.md", "# C\n\nUse the `backoff` helper.\n");
    const r = run(["suggest", doc, "--quote", "backoff", "--with", "retry"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/code/);
  });

  it("accept fails cleanly on an unknown id, writing nothing", () => {
    const doc = writeDoc("a.md", DOC);
    const before = fs.readFileSync(doc, "utf8");
    const r = run(["accept", doc, "nope1"]);
    expect(r.status).toBe(1);
    expect(fs.readFileSync(doc, "utf8")).toBe(before);
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

describe("mdc CLI: edit", () => {
  it("replaces exact prose text and exits 0", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["edit", doc, "--old", "a cap of 30 seconds", "--new", "a cap of 60 seconds"]);
    expect(r.status).toBe(0);
    const data = json(r);
    expect(data.action).toBe("edit");
    const after = fs.readFileSync(doc, "utf8");
    expect(after).toContain("a cap of 60 seconds");
    expect(checkIntegrity(after).ok).toBe(true);
  });

  it("refuses an ambiguous match and names the --occurrence flag", () => {
    const doc = writeDoc("d.md", "# Dup\n\nThe token expires. The token refreshes.\n");
    const r = run(["edit", doc, "--old", "token", "--new", "key"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/appears 2 times/);
    expect(r.stderr).toMatch(/--occurrence/);
  });

  it("refuses an edit that touches a review marker, leaving the file unchanged", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "bearer token", "--body", "q"])).threadId;
    const before = fs.readFileSync(doc, "utf8");
    const r = run(["edit", doc, "--old", `<!--mc:a:${id}-->bearer`, "--new", "x"]);
    expect(r.status).toBe(1);
    expect(fs.readFileSync(doc, "utf8")).toBe(before);
  });

  it("--new '' deletes the matched text", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["edit", doc, "--old", "a bearer token", "--new", ""]);
    expect(r.status).toBe(0);
    const after = fs.readFileSync(doc, "utf8");
    expect(after).not.toContain("bearer token");
    expect(checkIntegrity(after).ok).toBe(true);
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

// 10x-plan-4 P2.2 integrating-session note: `mc_check` has always stamped a
// review checkpoint on a healthy document; `mdc check` (no `--repair`) didn't,
// even though the README's "changes since last pass" section always claimed
// either front end does it. `opCheckAndCheckpoint` (docOps.ts) is now the one
// place both call, so a terminal Claude using the CLI gets an incremental
// next pass too.
describe("mdc CLI: check writes a review checkpoint", () => {
  it("a healthy document gets a checkpoint, reported in the JSON and readable back from the file", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["check", doc]);
    expect(r.status).toBe(0);
    const data = json(r);
    expect(data.ok).toBe(true);
    expect(typeof data.checkpointed).toBe("string");
    const after = fs.readFileSync(doc, "utf8");
    expect(parse(after).checkpoint?.ts).toBe(data.checkpointed);
  });

  it("a second check updates the checkpoint's ts", async () => {
    const doc = writeDoc("a.md", DOC);
    const first = json(run(["check", doc]));
    // A real clock tick, not a fake one — the CLI stamps `Date.now()`, and a
    // same-millisecond rerun would make a strict inequality a coin flip.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = json(run(["check", doc]));
    expect(second.checkpointed).not.toBe(first.checkpointed);
    expect(Date.parse(second.checkpointed)).toBeGreaterThan(Date.parse(first.checkpointed));
  });

  it("a broken document gets no checkpoint at all, and is left untouched", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"])).threadId;
    const raw = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, raw.replace(`<!--mc:/a:${id}-->`, ""), "utf8");
    const before = fs.readFileSync(doc, "utf8");

    const r = run(["check", doc]);
    expect(r.status).toBe(2);
    expect(json(r).checkpointed).toBeUndefined();
    expect(fs.readFileSync(doc, "utf8")).toBe(before);
  });

  it("check --hook stays read-only — no checkpoint, ever", () => {
    const doc = writeDoc("hook-checkpoint.md", DOC);
    const before = fs.readFileSync(doc, "utf8");
    const stdin = JSON.stringify({ cwd: tmp, tool_input: { file_path: doc } });
    const r = runWithStdin(["check", "--hook"], stdin);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(doc, "utf8")).toBe(before);
    expect(parse(fs.readFileSync(doc, "utf8")).checkpoint).toBeNull();
  });

  it("check --repair stays checkpoint-free too — repair is a distinct affordance", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"])).threadId;
    const healthy = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, healthy.replace(`<!--mc:/a:${id}-->`, ""), "utf8");
    const r = run(["check", doc, "--repair"]);
    expect(r.status).toBe(0);
    expect(json(r).checkpointed).toBeUndefined();
    expect(parse(fs.readFileSync(doc, "utf8")).checkpoint).toBeNull();
  });
});

describe("mdc CLI: check --hook", () => {
  it("garbage stdin exits 0 with empty stderr", () => {
    const r = runWithStdin(["check", "--hook"], "not json {{{");
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("a healthy document exits 0", () => {
    const doc = writeDoc("hook-healthy.md", DOC);
    json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"]));
    const stdin = JSON.stringify({ cwd: tmp, tool_input: { file_path: doc } });
    const r = runWithStdin(["check", "--hook"], stdin);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("a document with a removed close marker exits 2 and names the problem on stderr", () => {
    const doc = writeDoc("hook-broken.md", DOC);
    const id = json(run(["open", doc, "--quote", "exponential backoff", "--body", "q"])).threadId;
    const raw = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, raw.replace(`<!--mc:/a:${id}-->`, ""), "utf8");

    const stdin = JSON.stringify({ cwd: tmp, tool_input: { file_path: doc } });
    const r = runWithStdin(["check", "--hook"], stdin);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("comment-marker problem");
  });
});

// ux-review-2026-09 0.1: `--occurrence banana` became NaN, NaN slipped past
// every range check, and the file got an empty thread at byte 0 that `check`
// then called clean.
describe("mdc CLI: --occurrence is validated", () => {
  const OCC = "# Occ\n\nOnly one alpha here.\n";

  it("open --occurrence banana is refused, writes nothing, and the file still checks clean", () => {
    const doc = writeDoc("occ.md", OCC);
    const r = run(["open", doc, "--quote", "alpha", "--body", "which?", "--occurrence", "banana"]);
    expect(r.status).toBe(1);
    expect(json(r)).toEqual({
      ok: false,
      code: "invalid_arguments",
      message: '--occurrence takes a 1-based number, got "banana"',
    });
    expect(r.stderr).toContain("mdc: --occurrence takes a 1-based number");
    expect(fs.readFileSync(doc, "utf8")).toBe(OCC);
    expect(run(["check", doc]).status).toBe(0);
  });

  it.each(["-1", "1.5", "0x2"])("edit and suggest refuse --occurrence %s too", (occurrence) => {
    const doc = writeDoc("occ.md", OCC);
    for (const args of [
      ["edit", doc, "--old", "alpha", "--new", "beta", "--occurrence", occurrence],
      ["suggest", doc, "--quote", "alpha", "--with", "beta", "--occurrence", occurrence],
    ]) {
      const r = run(args);
      expect(r.status, args[0]).toBe(1);
      expect(json(r).code, args[0]).toBe("invalid_arguments");
    }
    expect(fs.readFileSync(doc, "utf8")).toBe(OCC);
  });

  it("a bare --occurrence with no number is refused rather than read as 0", () => {
    const doc = writeDoc("occ.md", OCC);
    const r = run(["open", doc, "--quote", "alpha", "--body", "x", "--occurrence"]);
    expect(r.status).toBe(1);
    expect(json(r).message).toBe("--occurrence needs a number");
  });

  it("check exits 2 on the document the bug used to write", () => {
    const doc = writeDoc("occ.md", OCC);
    const id = json(run(["open", doc, "--quote", "alpha", "--body", "which?"])).threadId;
    const raw = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(
      doc,
      `<!--mc:a:${id}--><!--mc:/a:${id}-->` +
        raw.replace(`<!--mc:a:${id}-->alpha<!--mc:/a:${id}-->`, "alpha").replace('"quote":"alpha"', '"quote":""'),
      "utf8",
    );
    const r = run(["check", doc]);
    expect(r.status).toBe(2);
    expect(json(r).issues).toEqual([expect.objectContaining({ kind: "empty-quote", threadId: id, repairable: false })]);
  });
});

// ux-review-2026-09 0.5: a value starting with `--` used to be read as the
// next flag, and the error blamed a missing --body.
describe("mdc CLI: flag values are taken as given", () => {
  it("--body may start with dashes", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["open", doc, "--quote", "bearer token", "--body", "--this starts with dashes"]);
    expect(r.status).toBe(0);
    expect(parse(fs.readFileSync(doc, "utf8")).threads[0]!.comments[0]!.body).toBe("--this starts with dashes");
  });

  it("--with and --new may be flag-shaped too, and -h as a value is not a help request", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "bearer token", "--body", "q"])).threadId;
    expect(run(["rewrite", doc, id, "--with", "--token"]).status).toBe(0);
    expect(run(["edit", doc, "--old", "30 seconds", "--new", "--repair"]).status).toBe(0);
    const r = run(["reply", doc, id, "--body", "-h"]);
    expect(r.status).toBe(0);
    const after = fs.readFileSync(doc, "utf8");
    expect(after).toContain("a cap of --repair.");
    expect(parse(after).anchors.has(id)).toBe(true);
    expect(parse(after).threads[0]!.quote).toBe("--token");
    expect(parse(after).threads[0]!.comments.at(-1)!.body).toBe("-h");
  });

  it("boolean flags still take no value", () => {
    const doc = writeDoc("a.md", DOC);
    run(["open", doc, "--quote", "bearer token", "--body", "q"]);
    // `--actionable` must not swallow the file path that follows it.
    const r = run(["list", "--actionable", doc]);
    expect(r.status).toBe(0);
    expect(json(r).threadCount).toBe(1);
  });
});

// ux-review-2026-09 0.7: failures used to be prose on stderr only, while the
// help promised JSON on stdout.
describe("mdc CLI: failures print JSON too", () => {
  function failure(r: RunResult): { ok: boolean; code: string; message: string } {
    // One line: a caller can split stdout on newlines.
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    return json(r);
  }

  it("a refusal carries the op's code, on stdout and stderr both", () => {
    const doc = writeDoc("a.md", DOC);
    const r = run(["reply", doc, "nosuch", "--body", "x"]);
    expect(r.status).toBe(1);
    expect(failure(r)).toEqual({ ok: false, code: "thread_not_found", message: "no thread with id nosuch in this file" });
    expect(r.stderr).toBe("mdc: no thread with id nosuch in this file\n");
  });

  it("an integrity-class refusal keeps exit 2", () => {
    const doc = writeDoc("a.md", DOC);
    const anchorId = json(run(["suggest", doc, "--quote", "exponential backoff", "--with", "jitter"])).anchorId;
    const raw = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, raw.replace(`<!--mc:a:${anchorId}-->`, "").replace(`<!--mc:/a:${anchorId}-->`, ""), "utf8");
    const r = run(["accept", doc, anchorId]);
    expect(r.status).toBe(2);
    expect(failure(r).code).toBe("unanchored");
  });

  it("a missing file, a missing flag and an unknown command each get a code", () => {
    expect(failure(run(["list", path.join(tmp, "absent.md")])).code).toBe("file_not_found");
    const doc = writeDoc("a.md", DOC);
    const missing = run(["reply", doc, "t1"]);
    expect(missing.status).toBe(1);
    expect(failure(missing)).toEqual({ ok: false, code: "usage", message: "missing required --body" });
    const unknown = run(["frobnicate"]);
    expect(unknown.status).toBe(1);
    expect(failure(unknown)).toEqual({ ok: false, code: "usage", message: "unknown command: frobnicate" });
    // The usage text is for a human, so it goes to stderr, not into the JSON.
    expect(unknown.stderr).toContain("mdc list <file>");
  });

  it("the help text describes the failure shape", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('on failure {"ok":false,"code":"…","message":"…"}');
    expect(r.stdout).not.toContain("All commands print JSON to stdout.");
  });
});

describe("mdc CLI: --help anywhere", () => {
  it.each([
    ["reply", "--help"],
    ["open", "x.md", "--quote", "q", "-h"],
    ["check", "--hook", "--help"],
  ])("mdc %s … prints the usage and exits 0", (...args) => {
    const r = run(args);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("mdc — Markdown Collab inline-comment CLI")).toBe(true);
  });
});

// ux-review-2026-09 0.6.
describe("mdc CLI: reply reopens a resolved thread", () => {
  it("reports reopened: true and leaves the thread open", () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "bearer token", "--body", "q"])).threadId;
    expect(run(["resolve", doc, id]).status).toBe(0);
    const r = run(["reply", doc, id, "--body", "one more thing"]);
    expect(r.status).toBe(0);
    expect(json(r)).toMatchObject({ action: "reply", threadId: id, reopened: true, integrityOk: true });
    expect(parse(fs.readFileSync(doc, "utf8")).threads[0]!.status).toBe("open");
    expect(json(run(["reply", doc, id, "--body", "and another"])).reopened).toBe(false);
  });
});

// --- forwarding to the extension (ux-review-2026-09 0.2) -------------------

/** `run`, but asynchronous — a server in this process has to be able to answer. */
function runAsync(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile("node", [scriptPath, ...args], { encoding: "utf8", env, cwd }, (err, stdout, stderr) => {
      const status = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ status, stdout, stderr });
    });
  });
}

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: any;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "hang-up";

const TOKEN = "t".repeat(64);

/** A stand-in for the extension's server: records every request, answers with `respond`. */
async function fakeExtension(
  respond: (msg: any) => Reply,
): Promise<{ ext: { url: string; token: string }; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = respond(body);
      if (reply === "hang-up") {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ext: { url: `http://127.0.0.1:${port}/mcp`, token: TOKEN },
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const INITIALIZED = (msg: any): Reply => ({
  status: 200,
  headers: { "mcp-session-id": "sess-1" },
  body: { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} } },
});

/** Answer `initialize`, then hand the tools/call to `call`. */
function tools(call: (msg: any) => Reply): (msg: any) => Reply {
  return (msg) => (msg.method === "initialize" ? INITIALIZED(msg) : call(msg));
}

const toolResult = (msg: any, value: unknown, isError = false): Reply => ({
  status: 200,
  body: {
    jsonrpc: "2.0",
    id: msg.id,
    result: { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) },
  },
});

describe("mdc CLI: writes go through the running extension", () => {
  it("sends initialize + tools/call with the token and session, and prints the tool's result", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(
      tools((msg) =>
        toolResult(msg, { action: "reply", file: "file:///ws/a.md", threadId: "t1", commentId: "c2", reopened: true }),
      ),
    );
    try {
      // A relative path from the doc's directory: the tool gets it absolute.
      const r = await runAsync(["reply", "a.md", "t1", "--body", "--answered", "--author", "codex"], cliEnv(fake.ext), tmp);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(fake.seen).toHaveLength(2);
      const [init, call] = fake.seen;
      for (const s of fake.seen) {
        expect(s.method).toBe("POST");
        expect(s.url).toBe("/mcp");
        expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(s.headers["content-type"]).toBe("application/json");
        expect(s.headers.origin).toBeUndefined();
      }
      // The session is how the server attributes the reply to the author.
      expect(init!.body).toMatchObject({ jsonrpc: "2.0", method: "initialize", params: { clientInfo: { name: "codex" } } });
      expect(init!.headers["mcp-session-id"]).toBeUndefined();
      expect(call!.headers["mcp-session-id"]).toBe("sess-1");
      expect(call!.body).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "mc_reply", arguments: { file: path.join(fs.realpathSync(tmp), "a.md"), threadId: "t1", body: "--answered" } },
      });
      // Same shape as a direct write, plus where it went; `file` as given.
      expect(json(r)).toEqual({
        action: "reply",
        file: "a.md",
        threadId: "t1",
        commentId: "c2",
        reopened: true,
        integrityOk: true,
        via: "extension",
      });
      // The extension owns the write; this process didn't touch the file.
      expect(fs.readFileSync(doc, "utf8")).toBe(DOC);
    } finally {
      await fake.close();
    }
  });

  it("forwards each mutating verb as its mc_* tool, with the occurrence as a number", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(tools((msg) => toolResult(msg, { action: "x" })));
    try {
      const cases: Array<[string[], string, Record<string, unknown>]> = [
        [["rewrite", doc, "t1", "--with", "new"], "mc_rewrite", { threadId: "t1", with: "new" }],
        [["edit", doc, "--old", "a", "--new", "", "--occurrence", "2"], "mc_edit", { old: "a", new: "", occurrence: 2 }],
        [["open", doc, "--quote", "q", "--body", "b"], "mc_open", { quote: "q", body: "b", occurrence: 0 }],
        [["resolve", doc, "t1"], "mc_resolve", { threadId: "t1" }],
        [["suggest", doc, "--quote", "q", "--with", "w", "--note", "n"], "mc_suggest", { quote: "q", with: "w", note: "n", occurrence: 0 }],
        [["accept", doc, "s1"], "mc_accept", { anchorId: "s1" }],
        [["reject", doc, "s1"], "mc_reject", { anchorId: "s1" }],
      ];
      for (const [args, tool, expected] of cases) {
        fake.seen.length = 0;
        const r = await runAsync(args, cliEnv(fake.ext));
        expect(r.status, tool).toBe(0);
        expect(fake.seen[1]!.body.params, tool).toEqual({ name: tool, arguments: { file: doc, ...expected } });
      }
    } finally {
      await fake.close();
    }
  });

  it("read-only verbs stay local", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(tools((msg) => toolResult(msg, {})));
    try {
      expect((await runAsync(["list", doc], cliEnv(fake.ext))).status).toBe(0);
      expect((await runAsync(["check", doc], cliEnv(fake.ext))).status).toBe(0);
      expect(fake.seen).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("a refusal from the extension is the answer: printed as the error, exit 1, no direct write", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(
      tools((msg) =>
        toolResult(msg, { error: { code: "thread_not_found", message: "no thread with id t1 in this file" } }, true),
      ),
    );
    try {
      const r = await runAsync(["reply", doc, "t1", "--body", "x"], cliEnv(fake.ext));
      expect(r.status).toBe(1);
      expect(json(r)).toEqual({ ok: false, code: "thread_not_found", message: "no thread with id t1 in this file" });
      expect(r.stderr).toBe("mdc: no thread with id t1 in this file\n");
      expect(fs.readFileSync(doc, "utf8")).toBe(DOC);
    } finally {
      await fake.close();
    }
  });

  it("an integrity refusal from the extension keeps exit 2, and ambiguity names the flag", async () => {
    const doc = writeDoc("a.md", DOC);
    let answer: unknown;
    const fake = await fakeExtension(tools((msg) => toolResult(msg, answer, true)));
    try {
      answer = { error: { code: "integrity", message: "refusing to write" } };
      const broken = await runAsync(["rewrite", doc, "t1", "--with", "x"], cliEnv(fake.ext));
      expect(broken.status).toBe(2);
      expect(json(broken).code).toBe("integrity");

      answer = { error: { code: "passage_ambiguous", message: "…", details: { occurrences: 3 } } };
      const ambiguous = await runAsync(["open", doc, "--quote", "q", "--body", "b"], cliEnv(fake.ext));
      expect(ambiguous.status).toBe(1);
      expect(json(ambiguous).message).toMatch(/--occurrence 1\.\.3/);
      expect(fs.readFileSync(doc, "utf8")).toBe(DOC);
    } finally {
      await fake.close();
    }
  });

  it("falls back to a direct write, with one stderr line, when nothing is listening", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(() => ({ status: 500 }));
    const { url } = fake.ext;
    await fake.close(); // the port is now refusing connections
    const r = await runAsync(["open", doc, "--quote", "bearer token", "--body", "q"], cliEnv({ url, token: TOKEN }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(`mdc: extension not reachable at ${url} — writing directly\n`);
    expect(json(r).via).toBeUndefined();
    expect(parse(fs.readFileSync(doc, "utf8")).threads).toHaveLength(1);
  });

  it.each<[string, (msg: any) => Reply]>([
    ["a rejected token (401)", () => ({ status: 401, body: { error: "unauthorized" } })],
    ["a non-JSON-RPC answer", () => ({ status: 200, body: { hello: "world" } })],
    ["a hang-up during initialize", () => "hang-up"],
    [
      "a JSON-RPC error on the call (an older extension without the tool)",
      tools((msg) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } } })),
    ],
  ])("falls back on %s", async (_label, respond) => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(respond);
    try {
      const r = await runAsync(["open", doc, "--quote", "bearer token", "--body", "q"], cliEnv(fake.ext));
      expect(r.status).toBe(0);
      expect(r.stderr).toBe(`mdc: extension not reachable at ${fake.ext.url} — writing directly\n`);
      expect(parse(fs.readFileSync(doc, "utf8")).threads).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("a file outside the extension's workspace is written directly", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(
      tools((msg) => toolResult(msg, { error: { code: "file_not_found", message: "no such file inside the workspace" } }, true)),
    );
    try {
      const r = await runAsync(["open", doc, "--quote", "bearer token", "--body", "q"], cliEnv(fake.ext));
      expect(r.status).toBe(0);
      expect(r.stderr).toBe(`mdc: ${doc} is not in the extension's workspace — writing directly\n`);
      expect(parse(fs.readFileSync(doc, "utf8")).threads).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("a call that went out and never came back is reported, never written a second time", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(tools(() => "hang-up"));
    try {
      const r = await runAsync(["reply", doc, "t1", "--body", "x"], cliEnv(fake.ext));
      expect(r.status).toBe(1);
      expect(json(r).code).toBe("no_answer");
      expect(json(r).message).toMatch(/may already be applied/);
      expect(r.stderr).not.toContain("writing directly");
      expect(fs.readFileSync(doc, "utf8")).toBe(DOC);
    } finally {
      await fake.close();
    }
  });

  it("a missing file is refused before any round trip", async () => {
    const fake = await fakeExtension(tools((msg) => toolResult(msg, {})));
    try {
      const r = await runAsync(["reply", path.join(tmp, "absent.md"), "t1", "--body", "x"], cliEnv(fake.ext));
      expect(r.status).toBe(1);
      expect(json(r).code).toBe("file_not_found");
      expect(fake.seen).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("--direct skips the extension entirely", async () => {
    const doc = writeDoc("a.md", DOC);
    const fake = await fakeExtension(tools((msg) => toolResult(msg, {})));
    try {
      const r = await runAsync(["open", doc, "--quote", "bearer token", "--body", "q", "--direct"], cliEnv(fake.ext));
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(fake.seen).toHaveLength(0);
      expect(parse(fs.readFileSync(doc, "utf8")).threads).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("round-trips through the real server: the reply lands, attributed to --author, and reopens", async () => {
    const doc = writeDoc("a.md", DOC);
    const id = json(run(["open", doc, "--quote", "bearer token", "--body", "q"])).threadId;
    expect(run(["resolve", doc, id]).status).toBe(0);

    // The extension's own server and tools, over the real file — only the
    // WorkspaceEdit is swapped for a plain write.
    const deps: ToolDeps = {
      resolveFile: async (file) => {
        if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new ToolRefusal("file_not_found", `no such file: ${file}`);
        return file;
      },
      readDoc: async (key) => fs.readFileSync(key, "utf8"),
      writeDoc: async (key, next) => fs.writeFileSync(key, next, "utf8"),
    };
    const sessions = new SessionRegistry();
    const server = await serveMcp({
      token: TOKEN,
      handlers: {
        serverInfo: { name: "markdown-collab", version: "test" },
        tools: TOOLS,
        callTool: (name, args, author) => callTool(name, args, deps, author),
        recordSession: (sessionId, clientName) => sessions.record(sessionId, clientName),
        resolveAuthor: (sessionId) => sessions.slugFor(sessionId),
      },
    });
    try {
      const r = await runAsync(
        ["reply", doc, id, "--body", "answered", "--author", "codex"],
        cliEnv({ url: server.url, token: TOKEN }),
      );
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(json(r)).toMatchObject({ action: "reply", file: doc, threadId: id, reopened: true, integrityOk: true, via: "extension" });
      const thread = parse(fs.readFileSync(doc, "utf8")).threads[0]!;
      expect(thread.status).toBe("open");
      expect(thread.comments.at(-1)).toMatchObject({ author: "codex", agent: true, body: "answered" });
    } finally {
      await server.close();
    }
  });
});
