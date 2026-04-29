import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import type { EventEnvelope } from "./eventLog";

export const CHANNEL_FILE_REL = path.join(".markdown-collab", ".channel.json");

export type McpChannelResult =
  | { ok: true }
  | { ok: false; reason: "not-running" | "auth" | "http"; detail?: string };

interface ChannelEndpoint {
  port: number;
  token: string;
  pid?: number;
}

/**
 * Push a payload to the bundled `mdc-channel.mjs` MCP server, which forwards
 * it to Claude as a `notifications/claude/channel` event. Reads the endpoint
 * descriptor written by the server at startup; returns "not-running" if the
 * file is missing (no Claude Code session has spawned the server yet).
 */
export async function sendViaMcpChannel(
  workspaceRoot: string,
  envelope: EventEnvelope,
): Promise<McpChannelResult> {
  const filePath = path.join(workspaceRoot, CHANNEL_FILE_REL);
  let descriptor: ChannelEndpoint;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    descriptor = JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "not-running" };
    }
    return { ok: false, reason: "http", detail: (e as Error).message };
  }
  if (
    typeof descriptor.port !== "number" ||
    typeof descriptor.token !== "string"
  ) {
    return { ok: false, reason: "not-running", detail: "malformed endpoint file" };
  }
  return new Promise<McpChannelResult>((resolve) => {
    const body = JSON.stringify(envelope);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: descriptor.port,
        path: "/push",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
          authorization: `Bearer ${descriptor.token}`,
        },
      },
      (res) => {
        // Drain body so the socket recycles.
        res.resume();
        if (res.statusCode === 200) resolve({ ok: true });
        else if (res.statusCode === 401)
          resolve({ ok: false, reason: "auth" });
        else
          resolve({
            ok: false,
            reason: "http",
            detail: `status ${res.statusCode}`,
          });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") {
        resolve({ ok: false, reason: "not-running", detail: "connection refused" });
      } else {
        resolve({ ok: false, reason: "http", detail: err.message });
      }
    });
    req.write(body);
    req.end();
  });
}
