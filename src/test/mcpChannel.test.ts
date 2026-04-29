import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { CHANNEL_FILE_REL, sendViaMcpChannel } from "../transports/mcpChannel";
import type { EventEnvelope } from "../transports/eventLog";

let tmpDir: string;
let server: http.Server | null = null;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-mcp-test-"));
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function envelope(): EventEnvelope {
  return {
    id: "evt_aaaaaaaaaaaa",
    ts: "2026-04-29T00:00:00Z",
    prompt: "address them",
    file: "guide.md",
    unresolvedCount: 1,
    comments: [],
  };
}

async function startStub(handler: http.RequestListener): Promise<{ port: number; token: string }> {
  const token = "test-token";
  await new Promise<void>((resolve, reject) => {
    server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server!.address() as { port: number }).port;
  await fs.mkdir(path.join(tmpDir, ".markdown-collab"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, CHANNEL_FILE_REL),
    JSON.stringify({ port, token, pid: process.pid }),
  );
  return { port, token };
}

describe("sendViaMcpChannel", () => {
  it("returns not-running when no .channel.json exists", async () => {
    const result = await sendViaMcpChannel(tmpDir, envelope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-running");
  });

  it("POSTs the envelope to /push with the bearer token and returns ok on 200", async () => {
    let observedAuth = "";
    let observedBody = "";
    let observedPath = "";
    let observedMethod = "";
    await startStub((req, res) => {
      observedAuth = String(req.headers.authorization ?? "");
      observedPath = req.url ?? "";
      observedMethod = req.method ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        observedBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.end("ok");
      });
    });
    const result = await sendViaMcpChannel(tmpDir, envelope());
    expect(result.ok).toBe(true);
    expect(observedMethod).toBe("POST");
    expect(observedPath).toBe("/push");
    expect(observedAuth).toBe("Bearer test-token");
    const parsed = JSON.parse(observedBody);
    expect(parsed.id).toBe("evt_aaaaaaaaaaaa");
    expect(parsed.file).toBe("guide.md");
  });

  it("propagates 401 as auth failure", async () => {
    await startStub((_req, res) => {
      res.statusCode = 401;
      res.end();
    });
    const result = await sendViaMcpChannel(tmpDir, envelope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("auth");
  });

  it("returns http reason for unexpected status codes", async () => {
    await startStub((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    const result = await sendViaMcpChannel(tmpDir, envelope());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("http");
      expect(result.detail).toContain("500");
    }
  });

  it("treats ECONNREFUSED as not-running (server crashed since file was written)", async () => {
    // Pick a port we won't bind to. 1 is reserved on most systems.
    await fs.mkdir(path.join(tmpDir, ".markdown-collab"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, CHANNEL_FILE_REL),
      JSON.stringify({ port: 1, token: "x", pid: 0 }),
    );
    const result = await sendViaMcpChannel(tmpDir, envelope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-running");
  });
});
