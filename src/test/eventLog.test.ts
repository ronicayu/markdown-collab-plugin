import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EVENT_LOG_REL, EventLog } from "../transports/eventLog";
import type { ReviewPayload } from "../sendToClaude";

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
});
