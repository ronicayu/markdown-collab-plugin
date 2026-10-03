import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  handleRpc,
  negotiateVersion,
  type ProtocolHandlers,
} from "../mcpServer/protocol";

const TOOL = {
  name: "mc_list",
  description: "List review threads in a document.",
  inputSchema: { type: "object" as const, properties: {}, required: ["file"] },
};

function handlers(overrides: Partial<ProtocolHandlers> = {}): ProtocolHandlers {
  return {
    serverInfo: { name: "markdown-collab", version: "1.2.3" },
    instructions: "Use mc_list first.",
    tools: [TOOL],
    callTool: async (name, args) => ({
      content: [{ type: "text", text: JSON.stringify({ name, args }) }],
    }),
    ...overrides,
  };
}

const rpc = (method: string, params?: Record<string, unknown>, id: unknown = 1) =>
  handleRpc({ jsonrpc: "2.0", id, method, params }, handlers());

describe("initialize", () => {
  it("echoes a protocol version both sides know", async () => {
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      handlers(),
    );
    expect((r!.result as any).protocolVersion).toBe("2024-11-05");
  });

  it("falls back to our own version when the client asks for one we don't know", () => {
    expect(negotiateVersion("1999-01-01")).toBe(PROTOCOL_VERSION);
    expect(negotiateVersion(undefined)).toBe(PROTOCOL_VERSION);
  });

  it("declares the tools capability and identifies the server", async () => {
    const result = (await rpc("initialize"))!.result as any;
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo).toEqual({ name: "markdown-collab", version: "1.2.3" });
    expect(result.instructions).toContain("mc_list");
  });
});

describe("notifications", () => {
  it("gets no response, so the transport can answer 202", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, handlers())).toBeNull();
  });

  it("an unknown notification is ignored rather than answered with an error", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/cancelled" }, handlers())).toBeNull();
  });
});

describe("tools/list", () => {
  it("returns the catalog verbatim", async () => {
    expect(((await rpc("tools/list"))!.result as any).tools).toEqual([TOOL]);
  });
});

describe("tools/call", () => {
  it("passes name and arguments to the handler", async () => {
    const r = await rpc("tools/call", { name: "mc_list", arguments: { file: "a.md" } });
    expect(JSON.parse((r!.result as any).content[0].text)).toEqual({
      name: "mc_list",
      args: { file: "a.md" },
    });
  });

  it("defaults missing arguments to an empty object", async () => {
    const r = await rpc("tools/call", { name: "mc_list" });
    expect(JSON.parse((r!.result as any).content[0].text).args).toEqual({});
  });

  it("rejects an unknown tool by name", async () => {
    const r = await rpc("tools/call", { name: "rm_rf" });
    expect(r!.error!.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  it("rejects a non-object arguments value", async () => {
    const r = await rpc("tools/call", { name: "mc_list", arguments: "file=a.md" });
    expect(r!.error!.code).toBe(RPC_INVALID_PARAMS);
  });

  // A refusal is a result with isError, not a JSON-RPC error: the model has to
  // see why it was refused to correct itself. A throw, on the other hand, is a
  // bug in the server and belongs in the error channel.
  it("passes an isError result through as a result", async () => {
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mc_list" } },
      handlers({
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "{}" }] }),
      }),
    );
    expect(r!.error).toBeUndefined();
    expect((r!.result as any).isError).toBe(true);
  });

  it("turns a thrown handler into an internal error", async () => {
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mc_list" } },
      handlers({
        callTool: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(r!.error!.message).toContain("boom");
  });
});

// 10x-plan-4 P1.2: the author a `tools/call` gets attributed to comes from
// the session's `initialize`, not a global default — two sessions on the
// same server must never bleed into each other.
describe("session-scoped author", () => {
  function sessionAwareHandlers(): { handlers: ProtocolHandlers; seenAuthors: string[] } {
    const seenAuthors: string[] = [];
    const bySession = new Map<string, string>();
    const h = handlers({
      recordSession: (sessionId, clientName) => {
        bySession.set(sessionId, clientName ?? "");
      },
      resolveAuthor: (sessionId) => {
        const name = sessionId ? bySession.get(sessionId) : undefined;
        return name?.includes("codex") ? "codex" : name?.includes("claude") ? "claude" : "claude";
      },
      callTool: async (name, args, author) => {
        seenAuthors.push(author);
        return { content: [{ type: "text", text: JSON.stringify({ name, args, author }) }] };
      },
    });
    return { handlers: h, seenAuthors };
  }

  it("records clientInfo.name against the session id it arrived on", async () => {
    const { handlers: h } = sessionAwareHandlers();
    await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex-mcp-client" } } },
      h,
      "session-a",
    );
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mc_list", arguments: {} } },
      h,
      "session-a",
    );
    expect(JSON.parse((r!.result as any).content[0].text).author).toBe("codex");
  });

  it("keeps two sessions' authors independent", async () => {
    const { handlers: h, seenAuthors } = sessionAwareHandlers();
    await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } },
      h,
      "claude-session",
    );
    await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex-mcp-client" } } },
      h,
      "codex-session",
    );
    await handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mc_list" } },
      h,
      "codex-session",
    );
    await handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mc_list" } },
      h,
      "claude-session",
    );
    expect(seenAuthors).toEqual(["codex", "claude"]);
  });

  it("defaults to claude when handlers don't implement session tracking at all", async () => {
    const h = handlers({
      callTool: async (_name, _args, author) => ({ content: [{ type: "text", text: JSON.stringify({ author }) }] }),
    });
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mc_list" } },
      h,
      "some-session-nobody-recorded",
    );
    expect(JSON.parse((r!.result as any).content[0].text).author).toBe("claude");
  });
});

describe("malformed input", () => {
  it("rejects a non-object message", async () => {
    expect((await handleRpc("hello", handlers()))!.error!.code).toBe(RPC_INVALID_REQUEST);
  });

  it("rejects a message with no method", async () => {
    expect((await handleRpc({ jsonrpc: "2.0", id: 2 }, handlers()))!.error!.code).toBe(RPC_INVALID_REQUEST);
  });

  it("answers an unknown request method with method-not-found", async () => {
    expect((await rpc("resources/list"))!.error!.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  it("answers ping", async () => {
    expect((await rpc("ping"))!.result).toEqual({});
  });
});
