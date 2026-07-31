// The logger's contract: scoped lines, bounded payloads, and — the part that
// matters most — nothing credential-shaped ever reaching the channel. The
// output channel is the thing users paste into public issues, and the MCP
// server mints a per-session bearer token into the same process.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { composeLine, formatData, loggerFor, redact, type LogSink } from "../logging";

function capture(): { sink: LogSink; lines: Array<[string, string]> } {
  const lines: Array<[string, string]> = [];
  const sink: LogSink = {
    trace: (m) => lines.push(["trace", m]),
    info: (m) => lines.push(["info", m]),
    warn: (m) => lines.push(["warn", m]),
    error: (m) => lines.push(["error", m]),
  };
  return { sink, lines };
}

describe("redact", () => {
  it("strips a bearer token from a header line", () => {
    expect(redact("Authorization: Bearer abc123def456ghi789")).toBe(
      "Authorization: Bearer «redacted»",
    );
  });

  it("strips our own session token, which is a long hex run", () => {
    const token = "a".repeat(64);
    expect(redact(`url=http://127.0.0.1:7391/mcp token=${token}`)).not.toContain(token);
  });

  it("strips token-shaped values out of JSON payloads", () => {
    const line = JSON.stringify({ token: "s3cr3t-value-long-enough", port: 7391 });
    const out = redact(line);
    expect(out).not.toContain("s3cr3t-value-long-enough");
    expect(out).toContain("7391");
  });

  it("catches the other credential spellings", () => {
    for (const key of ["access_token", "api_key", "apiKey", "password", "secret"]) {
      expect(redact(`${key}=hunter2hunter2hunter2`)).not.toContain("hunter2hunter2hunter2");
    }
  });

  it("leaves ordinary prose and short hex alone", () => {
    const line = "thread a1b2c on docs/guide.md — 3 unresolved";
    expect(redact(line)).toBe(line);
  });
});

describe("formatData", () => {
  it("renders objects as JSON", () => {
    expect(formatData({ mode: "terminal", threads: 2 })).toBe('{"mode":"terminal","threads":2}');
  });

  it("renders an Error as its stack", () => {
    const err = new Error("boom");
    expect(formatData(err)).toContain("boom");
  });

  it("truncates a payload big enough to bury the log", () => {
    const out = formatData("x".repeat(5000));
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("5000 chars");
  });

  it("survives a circular object rather than throwing inside a log call", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatData(circular)).not.toThrow();
  });
});

describe("composeLine", () => {
  it("tags the line with its scope", () => {
    expect(composeLine("send", "delivering", { mode: "terminal" })).toBe(
      '[send] delivering — {"mode":"terminal"}',
    );
  });

  it("omits the separator when there is no payload", () => {
    expect(composeLine("mcp", "tool server stopped")).toBe("[mcp] tool server stopped");
  });

  it("redacts the composed line, not just the message", () => {
    const out = composeLine("mcp", "listening", { url: `http://x/?token=${"f".repeat(40)}` });
    expect(out).not.toContain("f".repeat(40));
  });
});

describe("Logger", () => {
  it("routes each level to its sink method", () => {
    const { sink, lines } = capture();
    const log = loggerFor(sink);
    log.trace("t");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map(([level]) => level)).toEqual(["trace", "info", "warn", "error"]);
  });

  it("keeps the scope on a child logger", () => {
    const { sink, lines } = capture();
    loggerFor(sink).scope("pr").info("submitting");
    expect(lines[0][1]).toBe("[pr] submitting");
  });

  it("times a successful operation at trace", async () => {
    const { sink, lines } = capture();
    const result = await loggerFor(sink).scope("send").time("dispatch", async () => 42);
    expect(result).toBe(42);
    expect(lines[0][0]).toBe("trace");
    expect(lines[0][1]).toContain("[send] dispatch ok");
    expect(lines[0][1]).toMatch(/"ms":\d+/);
  });

  it("logs a failed operation at error and rethrows it unchanged", async () => {
    const { sink, lines } = capture();
    const boom = new Error("nope");
    await expect(
      loggerFor(sink).time("dispatch", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(lines[0][0]).toBe("error");
    expect(lines[0][1]).toContain("dispatch failed after");
  });
});

// Guard tests: the properties that fail silently and only in production.
describe("logging invariants", () => {
  const root = resolve(__dirname, "../..");
  const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

  it("the channel is a LogOutputChannel, so levels and timestamps exist", () => {
    // Without `{ log: true }` this is a plain text buffer: no per-line level,
    // no timestamps, and no level picker for the user to turn up.
    expect(read("src/logging.ts")).toContain('createOutputChannel("Markdown Collab", { log: true })');
  });

  it("nothing else in the extension creates its own output channel", () => {
    // A second channel is a second place to look, which defeats the point.
    const offenders: string[] = [];
    for (const rel of ["src/extension.ts", "src/mcpServer/index.ts", "src/pr/prReviewController.ts", "src/reviewView.ts", "src/collab/collabEditorProvider.ts"]) {
      if (read(rel).includes("createOutputChannel")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the MCP server never logs its own URL, which carries the token", () => {
    const mcp = read("src/mcpServer/index.ts");
    // `server.url` is `http://127.0.0.1:PORT` plus the token in the header, but
    // the descriptor and env var forms embed it — logging the port is enough.
    expect(mcp).not.toMatch(/log\.(info|warn|trace|error)\([^)]*server\.url/);
    expect(mcp).not.toMatch(/log\.(info|warn|trace|error)\([^)]*\btoken\b/);
  });
});

// Not about logging, but it is the same class of defect: something that works
// on a developer's machine and only there.
describe("the webview e2e harness resolves its imports the same way everywhere", () => {
  it("imports TypeScript statically, never through a runtime import()", () => {
    // A runtime `await import("../../inlineComments/webviewShell")` passed
    // locally and failed on GitHub's runner with `SyntaxError: Unexpected
    // token 'export'`, taking all 13 inline-view specs with it on the v0.34.72
    // tag. Static imports go through Playwright's transform, which is the one
    // path both environments agree on.
    const harness = readFileSync(
      resolve(__dirname, "webview-e2e/harness.ts"),
      "utf8",
    );
    // Comments stripped first: the comment above the fixed import names the
    // construct it replaced, and a guard that a comment can trip is a guard
    // that gets deleted.
    const code = harness.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toMatch(/await import\(/);
    expect(harness).toContain('import { inlineCommentsAppBody } from "../../inlineComments/webviewShell"');
  });
});
