// The HTTP transport, driven over a real socket.
//
// The security properties here are the ones that matter most in the whole
// feature — a token-authenticated listener on the user's machine — so they are
// tested against the actual server rather than the functions it calls.

import { afterEach, describe, expect, it } from "vitest";
import { isBrowserOrigin, serveMcp, tokenMatches, type McpHttpServer } from "../mcpServer/httpServer";
import type { ProtocolHandlers } from "../mcpServer/protocol";

const TOKEN = "a".repeat(64);

const handlers: ProtocolHandlers = {
  serverInfo: { name: "markdown-collab", version: "test" },
  tools: [
    {
      name: "mc_list",
      description: "List review threads in a document.",
      inputSchema: { type: "object", properties: {}, required: ["file"] },
    },
  ],
  callTool: async (name) => ({ content: [{ type: "text", text: `called ${name}` }] }),
};

let server: McpHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(port?: number): Promise<McpHttpServer> {
  server = await serveMcp({ token: TOKEN, handlers, port });
  return server;
}

interface Reply {
  status: number;
  body: string;
  headers: Headers;
}

async function post(
  s: McpHttpServer,
  payload: unknown,
  init: { token?: string | null; headers?: Record<string, string>; method?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(s.url, {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" || init.method === "DELETE" ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("tokenMatches", () => {
  it("accepts the exact bearer token", () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a wrong, absent, or differently-shaped credential", () => {
    expect(tokenMatches(`Bearer ${"b".repeat(64)}`, TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false); // no scheme
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches("Bearer ", TOKEN)).toBe(false);
  });
});

describe("isBrowserOrigin", () => {
  it("is true only for a real Origin header", () => {
    expect(isBrowserOrigin("https://evil.example")).toBe(true);
    expect(isBrowserOrigin("http://localhost:3000")).toBe(true);
    expect(isBrowserOrigin(undefined)).toBe(false);
    expect(isBrowserOrigin("")).toBe(false);
    expect(isBrowserOrigin("null")).toBe(false);
  });
});

describe("serveMcp", () => {
  it("binds loopback only", async () => {
    const s = await start();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("answers a real initialize handshake", async () => {
    const s = await start();
    const r = await post(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).result.serverInfo.name).toBe("markdown-collab");
  });

  it("lists and calls tools", async () => {
    const s = await start();
    const list = JSON.parse((await post(s, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body);
    expect(list.result.tools[0].name).toBe("mc_list");

    const call = JSON.parse(
      (await post(s, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mc_list" } })).body,
    );
    expect(call.result.content[0].text).toBe("called mc_list");
  });

  it("refuses a request with no token, and says how to authenticate", async () => {
    const s = await start();
    const r = await post(s, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: null });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("refuses a request with the wrong token", async () => {
    const s = await start();
    const r = await post(s, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "b".repeat(64) });
    expect(r.status).toBe(401);
  });

  // DNS rebinding: a page the user has open resolves a hostname to 127.0.0.1
  // and posts to this port. MCP clients send no Origin, so anything that does
  // is a browser and gets nothing — even with a valid token.
  it("refuses a request carrying a browser Origin", async () => {
    const s = await start();
    const r = await post(
      s,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { headers: { origin: "https://evil.example" } },
    );
    expect(r.status).toBe(403);
  });

  it("404s a path that isn't the MCP endpoint", async () => {
    const s = await start();
    const res = await fetch(`${s.url}/../push`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("405s GET, because this server opens no SSE stream", async () => {
    const s = await start();
    expect((await post(s, null, { method: "GET" })).status).toBe(405);
  });

  it("accepts DELETE as a no-op session teardown", async () => {
    const s = await start();
    expect((await post(s, null, { method: "DELETE" })).status).toBe(204);
  });

  it("reports a parse error as JSON-RPC, not a crash", async () => {
    const s = await start();
    const res = await fetch(s.url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text()).error.code).toBe(-32700);
  });

  it("answers a notification-only POST with 202 and no body", async () => {
    const s = await start();
    const r = await post(s, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(r.body).toBe("");
  });

  it("answers a batch with one response per request", async () => {
    const s = await start();
    const r = await post(s, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    const parsed = JSON.parse(r.body);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((m: any) => m.id)).toEqual([1, 2]);
  });

  it("falls back to another port when the preferred one is taken", async () => {
    const first = await start();
    const second = await serveMcp({ token: TOKEN, handlers, port: first.port });
    try {
      expect(second.port).not.toBe(first.port);
      expect(second.port).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });

  it("stops answering once closed", async () => {
    const s = await start();
    const url = s.url;
    await s.close();
    server = null;
    await expect(
      fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    ).rejects.toThrow();
  });
});
