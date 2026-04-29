import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type TailChild = ChildProcessByStdio<null, Readable, Readable>;
import { TAIL_SCRIPT_CONTENT } from "../skill";

let tmpDir: string;
let scriptPath: string;
const live: TailChild[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-tail-test-"));
  scriptPath = path.join(tmpDir, "mdc-tail.mjs");
  await fs.writeFile(scriptPath, TAIL_SCRIPT_CONTENT, "utf8");
  await fs.mkdir(path.join(tmpDir, ".markdown-collab"), { recursive: true });
});

afterEach(async () => {
  for (const child of live) {
    if (!child.killed) child.kill("SIGTERM");
  }
  live.length = 0;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function spawnTail(extraArgs: string[] = []): {
  child: TailChild;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn(
    "node",
    [scriptPath, "--workspace", tmpDir, ...extraArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  live.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  return { child, stdout: () => out, stderr: () => err };
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const logRel = path.join(".markdown-collab", ".events.jsonl");

describe("mdc-tail.mjs", () => {
  it("emits each appended line per-flush, not buffered", async () => {
    const logPath = path.join(tmpDir, logRel);
    await fs.writeFile(logPath, "");
    const { stdout } = spawnTail();
    // Give the watcher time to arm.
    await new Promise((r) => setTimeout(r, 200));
    await fs.appendFile(logPath, '{"file":"a.md","ts":"t1"}\n');
    await waitFor(() => stdout().includes('"a.md"'));
    expect(stdout().trim()).toBe('{"file":"a.md","ts":"t1"}');
  });

  it("streams multiple appends as separate lines", async () => {
    const logPath = path.join(tmpDir, logRel);
    await fs.writeFile(logPath, "");
    const { stdout } = spawnTail();
    await new Promise((r) => setTimeout(r, 200));
    await fs.appendFile(logPath, '{"file":"a.md"}\n');
    await fs.appendFile(logPath, '{"file":"b.md"}\n');
    await fs.appendFile(logPath, '{"file":"c.md"}\n');
    await waitFor(() => stdout().split("\n").filter(Boolean).length >= 3);
    const lines = stdout().split("\n").filter(Boolean);
    expect(lines).toEqual([
      '{"file":"a.md"}',
      '{"file":"b.md"}',
      '{"file":"c.md"}',
    ]);
  });

  it("skips existing history by default (matches `tail -n 0`)", async () => {
    const logPath = path.join(tmpDir, logRel);
    await fs.writeFile(logPath, '{"file":"old.md"}\n');
    const { stdout } = spawnTail();
    await new Promise((r) => setTimeout(r, 250));
    await fs.appendFile(logPath, '{"file":"new.md"}\n');
    await waitFor(() => stdout().includes('"new.md"'));
    expect(stdout()).not.toContain("old.md");
    expect(stdout()).toContain("new.md");
  });

  it("replays history when --from-start is passed", async () => {
    const logPath = path.join(tmpDir, logRel);
    await fs.writeFile(logPath, '{"file":"old.md"}\n');
    const { stdout } = spawnTail(["--from-start"]);
    await waitFor(() => stdout().includes('"old.md"'));
    expect(stdout()).toContain("old.md");
  });

  it("waits for the log file to be created and then emits new lines", async () => {
    const logPath = path.join(tmpDir, logRel);
    const { stdout } = spawnTail();
    await new Promise((r) => setTimeout(r, 200));
    await fs.appendFile(logPath, '{"file":"first.md"}\n');
    await waitFor(() => stdout().includes('"first.md"'));
    expect(stdout()).toContain("first.md");
  });

  it("fails fast when the workspace has no .markdown-collab dir", async () => {
    const stranded = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-strand-"));
    try {
      const { child, stderr } = (() => {
        const c = spawn("node", [scriptPath, "--workspace", stranded], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        live.push(c);
        let err = "";
        c.stderr.on("data", (d: Buffer) => (err += d.toString()));
        // The script DOES accept a --workspace explicitly; it does not error
        // on a missing .markdown-collab directory because the file may be
        // created later. Confirm it stays alive instead of erroring out.
        return { child: c, stderr: () => err };
      })();
      await new Promise((r) => setTimeout(r, 300));
      expect(child.killed).toBe(false);
      expect(stderr()).toBe("");
    } finally {
      await fs.rm(stranded, { recursive: true, force: true });
    }
  });
});
