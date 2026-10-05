// Streamable-HTTP transport for the extension-hosted MCP server.
//
// Security posture, in order of what an attacker would try:
//   - binds 127.0.0.1 only, never 0.0.0.0, so nothing off-machine can reach it
//   - re-checks the peer address per request (a bind is not a guarantee once
//     proxies and IPv6 mapping are involved)
//   - requires a bearer token minted fresh per session, compared in constant
//     time, never written into any file that gets committed
//   - rejects a browser-shaped request: MCP clients don't send Origin, and a
//     page that does is a DNS-rebinding attempt at a localhost port
//   - caps the body, because a localhost listener is still a listener
//
// The protocol half lives in protocol.ts; this file is sockets, headers, and
// the refusals above.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { handleRpc, type ProtocolHandlers } from "./protocol";

/** 1 MB: a tool call carrying a rewritten section, with room to spare. */
const MAX_BODY_BYTES = 1024 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface McpHttpServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  token: string;
  handlers: ProtocolHandlers;
  /** Preferred port; 0 (or a taken port) falls back to an ephemeral one. */
  port?: number;
  /** Path the MCP endpoint answers on. */
  path?: string;
  onError?(message: string): void;
  /** A notable refusal worth a log line; a repeated one is reported at most once a minute. */
  onWarn?(message: string): void;
}

const UNAUTHORIZED_REPORT_INTERVAL_MS = 60_000;

/** Constant-time bearer comparison — a length-sensitive `===` leaks the token. */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/**
 * True when the request looks like it came from a web page rather than an MCP
 * client. A localhost server with no origin check is reachable from any site
 * the user has open (DNS rebinding); MCP clients send no Origin at all.
 */
export function isBrowserOrigin(origin: string | undefined): boolean {
  return typeof origin === "string" && origin !== "" && origin !== "null";
}

function send(res: ServerResponse, status: number, body?: unknown, extraHeaders?: Record<string, string>): void {
  if (body === undefined) {
    res.writeHead(status, extraHeaders);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // Nothing here is cacheable and some of it is a token-authenticated reply.
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(text);
}

/** The `Mcp-Session-Id` header value, or undefined when the client sent none. */
function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  return typeof header === "string" ? header : undefined;
}

/** True for a bare (non-batched) `initialize` request — the one message
 * shape allowed to mint a fresh session id (10x-plan-4 P1.2). */
function isInitializeMessage(msg: unknown): boolean {
  return typeof msg === "object" && msg !== null && !Array.isArray(msg) && (msg as { method?: unknown }).method === "initialize";
}

/** 16 random bytes, hex-encoded — plenty of entropy for a session id nothing
 * cryptographic hangs off; it's a map key, not a credential. */
function mintSessionId(): string {
  return randomBytes(16).toString("hex");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start the listener. Resolves once it is accepting connections. */
export async function serveMcp(opts: ServeOptions): Promise<McpHttpServer> {
  const path = opts.path ?? "/mcp";
  let lastUnauthorizedReport = -Infinity;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((e) => {
      opts.onError?.(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? "";
    if (!LOOPBACK.has(remote)) {
      send(res, 403);
      return;
    }
    if (isBrowserOrigin(req.headers.origin as string | undefined)) {
      send(res, 403, { error: "cross-origin requests are not accepted" });
      return;
    }
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      const now = Date.now();
      if (now - lastUnauthorizedReport >= UNAUTHORIZED_REPORT_INTERVAL_MS) {
        lastUnauthorizedReport = now;
        opts.onWarn?.(
          "rejected a request with a wrong or missing token — likely an agent config pasted before the last window reload",
        );
      }
      res.setHeader("www-authenticate", "Bearer");
      send(res, 401, { error: "unauthorized" });
      return;
    }
    const url = (req.url ?? "").split("?")[0];
    if (url !== path) {
      send(res, 404, { error: "not found" });
      return;
    }
    // No SSE stream: this server never speaks first, so there is nothing for a
    // GET to hold open. 405 is the transport's documented answer for that.
    if (req.method === "GET") {
      send(res, 405, { error: "this server does not offer an SSE stream" });
      return;
    }
    // Stateless — there is no session to terminate, but clients send DELETE on
    // shutdown and a 404 there reads as a broken server.
    if (req.method === "DELETE") {
      send(res, 204);
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (e) {
      send(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `parse error: ${(e as Error).message}` },
      });
      return;
    }

    // The session id to attribute this request's calls to (10x-plan-4 P1.2):
    // whatever the client echoed back, or — only for a fresh `initialize` —
    // one minted here and handed back in the response so the client can echo
    // it from then on, per the streamable-HTTP transport's session contract.
    const incomingSessionId = sessionIdFromRequest(req);
    const isInitBatch = Array.isArray(parsed) ? parsed.some(isInitializeMessage) : isInitializeMessage(parsed);
    const sessionId = incomingSessionId ?? (isInitBatch ? mintSessionId() : undefined);
    const sessionHeaders =
      sessionId !== undefined && incomingSessionId === undefined ? { "mcp-session-id": sessionId } : undefined;

    // A batch is a JSON array; answer with an array of the responses that
    // aren't notifications, or 202 when every message was one.
    if (Array.isArray(parsed)) {
      const responses = [];
      for (const one of parsed) {
        const r = await handleRpc(one, opts.handlers, sessionId);
        if (r) responses.push(r);
      }
      if (responses.length === 0) send(res, 202, undefined, sessionHeaders);
      else send(res, 200, responses, sessionHeaders);
      return;
    }

    const response = await handleRpc(parsed, opts.handlers, sessionId);
    if (!response) send(res, 202, undefined, sessionHeaders);
    else send(res, 200, response, sessionHeaders);
  }

  const port = await listen(server, opts.port ?? 0, opts.onError);
  return {
    port,
    url: `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() waits for keep-alive sockets; the extension host shouldn't.
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Bind `preferred`, falling back to an ephemeral port when it is taken. A
 * stable port is worth trying for: the workspace's `.mcp.json` names a URL, and
 * a port that survives a window reload keeps that URL correct.
 */
function listen(server: Server, preferred: number, onError?: (m: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("server did not report a port"));
    };
    const onFirstError = (e: NodeJS.ErrnoException): void => {
      if (preferred !== 0 && (e.code === "EADDRINUSE" || e.code === "EACCES")) {
        onError?.(`port ${preferred} unavailable (${e.code}); falling back to an ephemeral port`);
        server.removeListener("error", onFirstError);
        server.once("error", reject);
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(e);
    };
    server.once("listening", onListening);
    server.once("error", onFirstError);
    server.listen(preferred, "127.0.0.1");
  });
}
