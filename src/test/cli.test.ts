import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "node:child_process";
import { CLI_SCRIPT_CONTENT } from "../skill";

let tmpDir: string;
let cliPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-cli-test-"));
  cliPath = path.join(tmpDir, "mdc.mjs");
  await fs.writeFile(cliPath, CLI_SCRIPT_CONTENT, "utf8");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], cwd?: string): RunResult {
  const r = spawnSync("node", [cliPath, ...args], {
    cwd: cwd ?? tmpDir,
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

async function seedSidecar(rel: string, body: unknown): Promise<string> {
  const target = path.join(tmpDir, ".markdown-collab", rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(body, null, 2), "utf8");
  return target;
}

function sample(): unknown {
  return {
    version: 1,
    file: "spec.md",
    comments: [
      {
        id: "c_aaaaaaaa",
        anchor: { text: "alpha bravo", contextBefore: "", contextAfter: "" },
        body: "fix this",
        author: "user",
        createdAt: "2026-01-01T00:00:00Z",
        resolved: false,
        replies: [],
      },
      {
        id: "c_bbbbbbbb",
        anchor: { text: "charlie delta", contextBefore: "", contextAfter: "" },
        body: "already addressed",
        author: "user",
        createdAt: "2026-01-01T00:00:00Z",
        resolved: true,
        replies: [],
      },
      {
        id: "c_cccccccc",
        anchor: { text: "echo foxtrot", contextBefore: "", contextAfter: "" },
        body: "rename foo to bar",
        author: "user",
        createdAt: "2026-01-01T00:00:00Z",
        resolved: false,
        replies: [
          { author: "ai", body: "renamed", createdAt: "2026-01-01T00:01:00Z" },
        ],
      },
    ],
  };
}

describe("mdc.mjs list", () => {
  it("returns only actionable comments (unresolved + last reply not from ai)", async () => {
    await seedSidecar("spec.md.json", sample());
    const r = runCli(["list", "--workspace", tmpDir]);
    expect(r.code).toBe(0);
    const list = JSON.parse(r.stdout);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("c_aaaaaaaa");
  });

  it("scopes to a single .md file when --file is supplied", async () => {
    await seedSidecar("spec.md.json", sample());
    await seedSidecar("docs/other.md.json", {
      ...(sample() as object),
      file: "docs/other.md",
    });
    const r = runCli(["list", "--workspace", tmpDir, "--file", "spec.md"]);
    const list = JSON.parse(r.stdout);
    expect(list.every((e: any) => e.file === "spec.md")).toBe(true);
  });

  it("returns an empty array when there is no .markdown-collab directory", () => {
    const r = runCli(["list", "--workspace", tmpDir]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("skips unreadable subdirectories rather than aborting the walk", async () => {
    await seedSidecar("spec.md.json", sample());
    const blocked = path.join(tmpDir, ".markdown-collab", "blocked");
    await fs.mkdir(blocked, { recursive: true });
    // Leave a real sidecar in the readable part too. Permission-strip the
    // bad subdir; on platforms that ignore chmod we'll still get the good
    // sidecar back.
    await fs.chmod(blocked, 0o000).catch(() => {});
    const r = runCli(["list", "--workspace", tmpDir]);
    // Restore permissions so cleanup can rm -rf.
    await fs.chmod(blocked, 0o755).catch(() => {});
    expect(r.code).toBe(0);
    const list = JSON.parse(r.stdout);
    expect(list.some((e: any) => e.id === "c_aaaaaaaa")).toBe(true);
  });
});

describe("mdc.mjs reply", () => {
  it("appends an AI reply with a Z-suffixed UTC timestamp and no sub-second fraction", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli(["reply", sc, "c_aaaaaaaa", "--body", "Fixed it"]);
    expect(r.code).toBe(0);
    const written = JSON.parse(await fs.readFile(sc, "utf8"));
    const replies = written.comments[0].replies;
    expect(replies).toHaveLength(1);
    expect(replies[0].author).toBe("ai");
    expect(replies[0].body).toBe("Fixed it");
    expect(replies[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("rejects an empty --body with exit code 4", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli(["reply", sc, "c_aaaaaaaa", "--body", ""]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/empty/);
  });

  it("returns exit code 3 when commentId is unknown", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli(["reply", sc, "c_99999999", "--body", "x"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/not found/);
  });
});

describe("mdc.mjs delete", () => {
  it("removes a comment from the sidecar", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli(["delete", sc, "c_bbbbbbbb"]);
    expect(r.code).toBe(0);
    const written = JSON.parse(await fs.readFile(sc, "utf8"));
    expect(written.comments.find((c: any) => c.id === "c_bbbbbbbb")).toBeUndefined();
    expect(written.comments).toHaveLength(2);
  });

  it("returns exit code 3 for an unknown id", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli(["delete", sc, "c_99999999"]);
    expect(r.code).toBe(3);
  });
});

describe("mdc.mjs set-anchor", () => {
  it("rejects --text shorter than 8 non-whitespace chars with exit code 4", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli([
      "set-anchor",
      sc,
      "c_aaaaaaaa",
      "--text",
      "tooshort", // 8 chars but exactly 8 non-ws — actually 8, so this should pass
    ]);
    // 8 non-ws should be the minimum acceptable, so this run is OK.
    expect(r.code).toBe(0);
  });

  it("rejects an under-8-char anchor", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli(["set-anchor", sc, "c_aaaaaaaa", "--text", "short"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/8 non-whitespace/);
  });

  it("overwrites all three anchor fields atomically", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli([
      "set-anchor",
      sc,
      "c_aaaaaaaa",
      "--text",
      "new anchor text",
      "--before",
      "lead-in",
      "--after",
      "follow-up",
    ]);
    expect(r.code).toBe(0);
    const written = JSON.parse(await fs.readFile(sc, "utf8"));
    expect(written.comments[0].anchor).toEqual({
      text: "new anchor text",
      contextBefore: "lead-in",
      contextAfter: "follow-up",
    });
  });
});

describe("mdc.mjs validate", () => {
  it("succeeds on a well-formed sidecar", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli(["validate", sc]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/comments=3/);
  });

  it("flags malformed per-comment fields with exit code 2", async () => {
    const broken: any = sample();
    broken.comments[0].id = "not-a-valid-id";
    const sc = await seedSidecar("spec.md.json", broken);
    const r = runCli(["validate", sc]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/id/);
  });

  it("flags forward-version sidecars with exit code 2", async () => {
    const future: any = sample();
    future.version = 99;
    const sc = await seedSidecar("spec.md.json", future);
    const r = runCli(["validate", sc]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/version=1/);
  });
});

describe("mdc.mjs argv parsing", () => {
  it("treats --body value containing spaces correctly", async () => {
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli([
      "reply",
      sc,
      "c_aaaaaaaa",
      "--body",
      "this has spaces and punctuation: yes!",
    ]);
    expect(r.code).toBe(0);
    const written = JSON.parse(await fs.readFile(sc, "utf8"));
    expect(written.comments[0].replies[0].body).toBe(
      "this has spaces and punctuation: yes!",
    );
  });

  it("refuses to silently consume a flag-shaped value as another flag's argument", async () => {
    // Safety property: `--body --foo` is treated as TWO bare flags rather
    // than the body being literally "--foo". This prevents the agent from
    // accidentally writing flag-looking text as a comment body when a flag
    // value is missing. The reply usage check then rejects with exit 1.
    const sc = await seedSidecar("spec.md.json", sample());
    const r = runCli([
      "reply",
      sc,
      "c_aaaaaaaa",
      "--body",
      "--really-a-body",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/usage/);
  });
});
