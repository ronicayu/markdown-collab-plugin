import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EVENT_ACKED_REL, EVENT_LOG_REL, EventLog } from "../transports/eventLog";
import type { ReviewPayload } from "../sendToClaude";
import type { Comment, Sidecar } from "../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-events-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fixturePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    prompt: "Use the vs-markdown-collab skill ...",
    file: "guide.md",
    unresolvedCount: 1,
    comments: [],
    ...overrides,
  };
}

async function readLines(p: string): Promise<string[]> {
  const raw = await fs.readFile(p, "utf8");
  return raw.split("\n").filter((l) => l.length > 0);
}

describe("EventLog", () => {
  it("creates the event log on first append (parents included)", async () => {
    const log = new EventLog(tmpDir);
    await log.append(fixturePayload());
    const target = path.join(tmpDir, EVENT_LOG_REL);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });

  it("writes one newline-terminated JSON line per append", async () => {
    const log = new EventLog(tmpDir);
    await log.append(fixturePayload({ file: "a.md" }));
    await log.append(fixturePayload({ file: "b.md", unresolvedCount: 3 }));
    const lines = await readLines(path.join(tmpDir, EVENT_LOG_REL));
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.file).toBe("a.md");
    expect(b.file).toBe("b.md");
    expect(b.unresolvedCount).toBe(3);
  });

  it("stamps each line with an ISO timestamp", async () => {
    const log = new EventLog(tmpDir);
    await log.append(fixturePayload());
    const lines = await readLines(path.join(tmpDir, EVENT_LOG_REL));
    const parsed = JSON.parse(lines[0]);
    expect(typeof parsed.ts).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it("appends to an existing log without truncating it", async () => {
    const target = path.join(tmpDir, EVENT_LOG_REL);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{"file":"prior.md"}\n', "utf8");
    const log = new EventLog(tmpDir);
    await log.append(fixturePayload({ file: "new.md" }));
    const lines = await readLines(target);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).file).toBe("prior.md");
    expect(JSON.parse(lines[1]).file).toBe("new.md");
  });

  it("survives concurrent appends without torn lines", async () => {
    const log = new EventLog(tmpDir);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        log.append(fixturePayload({ file: `f${i}.md`, unresolvedCount: i })),
      ),
    );
    const lines = await readLines(path.join(tmpDir, EVENT_LOG_REL));
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const files = lines.map((l) => JSON.parse(l).file).sort();
    expect(files).toEqual(
      Array.from({ length: 10 }, (_, i) => `f${i}.md`).sort(),
    );
  });

  it("stamps each appended line with a unique evt_ id", async () => {
    const log = new EventLog(tmpDir);
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const env = await log.append(fixturePayload({ file: `f${i}.md` }));
      expect(env.id).toMatch(/^evt_[0-9a-f]{12}$/);
      seen.add(env.id);
    }
    expect(seen.size).toBe(5);
  });
});

function commentFixture(id: string, opts: Partial<Comment> = {}): Comment {
  return {
    id,
    anchor: { text: "anchored phrase", contextBefore: "", contextAfter: "" },
    body: "consider rephrasing",
    author: "human",
    createdAt: "2026-04-01T00:00:00Z",
    resolved: false,
    replies: [],
    ...opts,
  };
}

async function seedSidecar(rootDir: string, mdRel: string, sidecar: Sidecar): Promise<void> {
  const sidecarPath = path.join(rootDir, ".markdown-collab", mdRel + ".json");
  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));
}

describe("EventLog.reconcile", () => {
  it("acks an event when every referenced comment has an AI reply", async () => {
    const log = new EventLog(tmpDir);
    const env = await log.append({
      prompt: "x",
      file: "guide.md",
      unresolvedCount: 1,
      comments: [commentFixture("c_aaaaaaaa")],
    });
    await seedSidecar(tmpDir, "guide.md", {
      version: 1,
      file: "guide.md",
      comments: [
        commentFixture("c_aaaaaaaa", {
          replies: [
            { author: "ai", body: "addressed", createdAt: "2026-04-29T00:00:00Z" },
          ],
        }),
      ],
    });
    await log.reconcile();
    const acks = await readLines(path.join(tmpDir, EVENT_ACKED_REL));
    expect(acks).toHaveLength(1);
    expect(JSON.parse(acks[0]).id).toBe(env.id);
  });

  it("acks an event when its referenced comments are resolved", async () => {
    const log = new EventLog(tmpDir);
    await log.append({
      prompt: "x",
      file: "guide.md",
      unresolvedCount: 1,
      comments: [commentFixture("c_aaaaaaaa")],
    });
    await seedSidecar(tmpDir, "guide.md", {
      version: 1,
      file: "guide.md",
      comments: [commentFixture("c_aaaaaaaa", { resolved: true })],
    });
    await log.reconcile();
    const acks = await readLines(path.join(tmpDir, EVENT_ACKED_REL));
    expect(acks).toHaveLength(1);
  });

  it("does NOT ack when at least one comment lacks an AI reply", async () => {
    const log = new EventLog(tmpDir);
    await log.append({
      prompt: "x",
      file: "guide.md",
      unresolvedCount: 2,
      comments: [commentFixture("c_aaaaaaaa"), commentFixture("c_bbbbbbbb")],
    });
    await seedSidecar(tmpDir, "guide.md", {
      version: 1,
      file: "guide.md",
      comments: [
        commentFixture("c_aaaaaaaa", {
          replies: [
            { author: "ai", body: "done", createdAt: "2026-04-29T00:00:00Z" },
          ],
        }),
        commentFixture("c_bbbbbbbb"),
      ],
    });
    await log.reconcile();
    const acks = await fs
      .readFile(path.join(tmpDir, EVENT_ACKED_REL), "utf8")
      .catch(() => "");
    expect(acks).toBe("");
  });

  it("is idempotent — re-running reconcile does not duplicate ack lines", async () => {
    const log = new EventLog(tmpDir);
    await log.append({
      prompt: "x",
      file: "guide.md",
      unresolvedCount: 1,
      comments: [commentFixture("c_aaaaaaaa")],
    });
    await seedSidecar(tmpDir, "guide.md", {
      version: 1,
      file: "guide.md",
      comments: [
        commentFixture("c_aaaaaaaa", {
          replies: [
            { author: "ai", body: "done", createdAt: "2026-04-29T00:00:00Z" },
          ],
        }),
      ],
    });
    await log.reconcile();
    await log.reconcile();
    await log.reconcile();
    const acks = await readLines(path.join(tmpDir, EVENT_ACKED_REL));
    expect(acks).toHaveLength(1);
  });

  it("treats a deleted comment as addressed", async () => {
    const log = new EventLog(tmpDir);
    await log.append({
      prompt: "x",
      file: "guide.md",
      unresolvedCount: 1,
      comments: [commentFixture("c_aaaaaaaa")],
    });
    await seedSidecar(tmpDir, "guide.md", {
      version: 1,
      file: "guide.md",
      comments: [],
    });
    await log.reconcile();
    const acks = await readLines(path.join(tmpDir, EVENT_ACKED_REL));
    expect(acks).toHaveLength(1);
  });
});
