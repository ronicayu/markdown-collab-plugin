import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ENDPOINT_REL, IpcServer } from "../transports/ipcServer";
import type { ReviewPayload } from "../sendToClaude";

let tmpDir: string;
let server: IpcServer;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-ipc-test-"));
});

afterEach(async () => {
  if (server) await server.dispose();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function silentChannel(): vscode.OutputChannel {
  return {
    appendLine: () => undefined,
  } as unknown as vscode.OutputChannel;
}

async function readEndpoint(): Promise<{ port: number; token: string; pid: number }> {
  const raw = await fs.readFile(path.join(tmpDir, ENDPOINT_REL), "utf8");
  return JSON.parse(raw);
}

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(opts: {
  port: number;
  method: "GET" | "POST";
  pathname: string;
  token?: string | null;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {};
    if (opts.token !== null) {
      headers["Authorization"] = `Bearer ${opts.token ?? ""}`;
    }
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(opts.body).toString();
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.pathname,
        method: opts.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function fixturePayload(): ReviewPayload {
  return {
    prompt: "Use the vs-markdown-collab skill to address ...",
    file: "guide.md",
    unresolvedCount: 2,
    comments: [],
  };
}

describe("IpcServer", () => {
  it("writes endpoint file with port + token + pid on start", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    const ep = await readEndpoint();
    expect(ep.port).toBeGreaterThan(0);
    expect(ep.token).toMatch(/^[0-9a-f]{64}$/);
    expect(ep.pid).toBe(process.pid);
  });

  it("removes endpoint file on dispose", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    const endpointPath = path.join(tmpDir, ENDPOINT_REL);
    await fs.access(endpointPath);
    await server.dispose();
    await expect(fs.access(endpointPath)).rejects.toThrow();
  });

  it("rejects requests without a bearer token", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    const { port } = await readEndpoint();
    const res = await rawRequest({ port, method: "GET", pathname: "/health", token: null });
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    const { port } = await readEndpoint();
    const res = await rawRequest({
      port,
      method: "GET",
      pathname: "/health",
      token: "wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("returns the queued payload immediately when poll arrives after enqueue", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    server.enqueue(fixturePayload());
    const { port, token } = await readEndpoint();
    const res = await rawRequest({
      port,
      method: "GET",
      pathname: "/poll?timeoutSec=2",
      token,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.file).toBe("guide.md");
  });

  it("resolves an in-flight long poll when enqueue happens after the request", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    const { port, token } = await readEndpoint();
    const pollPromise = rawRequest({
      port,
      method: "GET",
      pathname: "/poll?timeoutSec=5",
      token,
    });
    // Give the request a tick to register as a waiter.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.pollerActive).toBe(true);
    server.enqueue(fixturePayload());
    const res = await pollPromise;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).file).toBe("guide.md");
  });

  it("returns 204 when the long-poll times out without any enqueue", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    const { port, token } = await readEndpoint();
    const res = await rawRequest({
      port,
      method: "GET",
      pathname: "/poll?timeoutSec=1",
      token,
    });
    expect(res.status).toBe(204);
    expect(server.pollerActive).toBe(false);
  });

  it("accepts a payload via POST /enqueue and returns it on the next poll", async () => {
    server = new IpcServer(tmpDir, silentChannel());
    await server.start();
    const { port, token } = await readEndpoint();
    const post = await rawRequest({
      port,
      method: "POST",
      pathname: "/enqueue",
      token,
      body: JSON.stringify({ payload: fixturePayload() }),
    });
    expect(post.status).toBe(200);
    const poll = await rawRequest({
      port,
      method: "GET",
      pathname: "/poll?timeoutSec=2",
      token,
    });
    expect(poll.status).toBe(200);
    expect(JSON.parse(poll.body).file).toBe("guide.md");
  });
});
