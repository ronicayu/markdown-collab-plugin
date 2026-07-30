// MCP JSON-RPC, the subset an extension-hosted tool server needs.
//
// Hand-rolled rather than pulled from the SDK, for the same reason
// `mdc-channel.mjs` is: the surface is initialize + tools/list + tools/call +
// ping, the extension bundle ships as one esbuilt file, and a protocol
// dependency in the host would be the largest thing in it. Kept pure (no http,
// no vscode) so every branch is unit-testable without a socket.
//
// Transport is streamable HTTP with JSON responses (see httpServer.ts). This
// server never initiates server→client messages, so it does not open an SSE
// stream and answers GET with 405 — which the transport spec allows.

/** Protocol revision this server implements. */
export const PROTOCOL_VERSION = "2025-06-18";

/** Revisions we will accept from a client, newest first. */
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC reserved codes, plus the one MCP adds for an unknown tool. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** One tool as advertised by `tools/list`. */
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** What a tool handler returns — MCP's content-block result. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  /**
   * True when the tool refused. MCP deliberately reports tool failures as
   * results rather than JSON-RPC errors, so the model sees the reason and can
   * correct itself instead of the call vanishing into the transport.
   */
  isError?: boolean;
}

export interface ProtocolHandlers {
  serverInfo: { name: string; version: string };
  /** Shown to the client after initialize — the server's own usage notes. */
  instructions?: string;
  tools: readonly McpTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/** Pick the newest protocol revision both sides know. */
export function negotiateVersion(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSION;
}

/**
 * Handle one JSON-RPC message. Returns the response to send, or `null` for a
 * notification (which must be answered with 202 and an empty body, not with a
 * response object carrying a null id).
 */
export async function handleRpc(
  msg: unknown,
  h: ProtocolHandlers,
): Promise<JsonRpcResponse | null> {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return err(null, RPC_INVALID_REQUEST, "expected a JSON-RPC request object");
  }
  const req = msg as JsonRpcRequest;
  if (typeof req.method !== "string") {
    return err(req.id ?? null, RPC_INVALID_REQUEST, "missing method");
  }
  // Notifications carry no id and get no response.
  const isNotification = req.id === undefined || req.id === null;
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateVersion(req.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: h.serverInfo,
        ...(h.instructions ? { instructions: h.instructions } : {}),
      });

    case "notifications/initialized":
    case "initialized":
      return null;

    case "ping":
      return isNotification ? null : ok(id, {});

    case "tools/list":
      return ok(id, { tools: h.tools });

    case "tools/call": {
      const name = req.params?.name;
      if (typeof name !== "string") {
        return err(id, RPC_INVALID_PARAMS, "tools/call requires a string `name`");
      }
      const rawArgs = req.params?.arguments;
      if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
        return err(id, RPC_INVALID_PARAMS, "tools/call `arguments` must be an object");
      }
      if (!h.tools.some((t) => t.name === name)) {
        return err(id, RPC_METHOD_NOT_FOUND, `unknown tool: ${name}`);
      }
      try {
        const result = await h.callTool(name, (rawArgs as Record<string, unknown>) ?? {});
        return ok(id, result);
      } catch (e) {
        // A throw here is a bug in the server, not a refused operation —
        // refusals come back as `isError` results from the handler.
        return err(id, RPC_INTERNAL_ERROR, `${name} failed: ${(e as Error).message}`);
      }
    }

    default:
      if (isNotification) return null;
      return err(id, RPC_METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}
