import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import type { ReviewPayload } from "../sendToClaude";

export const ENDPOINT_REL = path.join(".markdown-collab", ".endpoint.json");

const QUEUE_LIMIT = 10;
const MAX_BODY_BYTES = 256 * 1024;

interface Waiter {
  resolve: (payload: ReviewPayload | null) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Long-poll IPC server. Bound to 127.0.0.1 only. Authenticates every request
 * with a per-session bearer token written into a 0600 endpoint file under
 * `<workspace>/.markdown-collab/.endpoint.json`. The Claude-side `mdc-wait`
 * CLI reads that file, blocks on `GET /poll` until a button click in VS Code
 * `POST /enqueue`s a payload, then receives the JSON and returns it to the
 * agent.
 */
export class IpcServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private readonly token: string;
  private readonly queue: ReviewPayload[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly endpointPath: string;
  private hasActivePoller = false;
  private readonly statusEmitter = new vscode.EventEmitter<boolean>();

  /** Fires `true` while a `mdc-wait` is currently long-polling, `false` otherwise. */
  public readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel,
  ) {
    this.token = crypto.randomBytes(32).toString("hex");
    this.endpointPath = path.join(this.workspaceRoot, ENDPOINT_REL);
  }

  public get pollerActive(): boolean {
    return this.hasActivePoller;
  }

  public async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on("error", (err) => {
      this.output.appendLine(`IPC server error: ${err.message}`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    if (!port) {
      throw new Error("IPC server failed to acquire a port");
    }
    await this.writeEndpointFile(port);
    this.output.appendLine(`IPC server listening on 127.0.0.1:${port}`);
  }

  public async dispose(): Promise<void> {
    for (const w of this.waiters) {
      clearTimeout(w.timeout);
      w.resolve(null);
    }
    this.waiters.length = 0;
    this.queue.length = 0;
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    try {
      await fs.unlink(this.endpointPath);
    } catch {
      /* missing is fine */
    }
    this.statusEmitter.dispose();
  }

  /**
   * Enqueue a payload. If a poller is currently waiting it gets the payload
   * immediately; otherwise it sits in the queue (capped at QUEUE_LIMIT —
   * oldest dropped with a log line so the user sees they over-clicked).
   */
  public enqueue(payload: ReviewPayload): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(payload);
      return;
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      const dropped = this.queue.shift();
      this.output.appendLine(
        `IPC queue full; dropped oldest payload for ${dropped?.file ?? "?"}.`,
      );
    }
    this.queue.push(payload);
  }

  // -----------------------------------------------------------------
  // Internal: HTTP handling
  // -----------------------------------------------------------------

  private async writeEndpointFile(port: number): Promise<void> {
    await fs.mkdir(path.dirname(this.endpointPath), { recursive: true });
    const content = JSON.stringify(
      { port, token: this.token, pid: process.pid },
      null,
      2,
    );
    await fs.writeFile(this.endpointPath, content, { mode: 0o600 });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.statusCode = 403;
      res.end();
      return;
    }
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${this.token}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, queued: this.queue.length }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/poll") {
      this.handlePoll(url, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/enqueue") {
      this.handleEnqueue(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  private handlePoll(url: URL, res: http.ServerResponse): void {
    const queued = this.queue.shift();
    if (queued) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(queued));
      return;
    }
    const timeoutSec = Math.max(
      1,
      Math.min(600, Number(url.searchParams.get("timeoutSec")) || 30),
    );
    this.setPollerActive(true);
    const waiter: Waiter = {
      resolve: (payload) => {
        if (res.writableEnded) return;
        if (payload) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(payload));
        } else {
          res.statusCode = 204;
          res.end();
        }
      },
      timeout: setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          this.refreshPollerStatus();
        }
        waiter.resolve(null);
      }, timeoutSec * 1000),
    };
    this.waiters.push(waiter);
    res.on("close", () => {
      const idx = this.waiters.indexOf(waiter);
      if (idx >= 0) {
        this.waiters.splice(idx, 1);
        clearTimeout(waiter.timeout);
        this.refreshPollerStatus();
      }
    });
  }

  private handleEnqueue(req: http.IncomingMessage, res: http.ServerResponse): void {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        res.statusCode = 413;
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(body) as { payload?: ReviewPayload };
        if (!parsed.payload || typeof parsed.payload.prompt !== "string") {
          res.statusCode = 400;
          res.end();
          return;
        }
        this.enqueue(parsed.payload);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.statusCode = 400;
        res.end((e as Error).message);
      }
    });
  }

  private setPollerActive(active: boolean): void {
    if (this.hasActivePoller === active) return;
    this.hasActivePoller = active;
    this.statusEmitter.fire(active);
  }

  private refreshPollerStatus(): void {
    this.setPollerActive(this.waiters.length > 0);
  }
}
