import * as http from "http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import {
  startCollabServer,
  _resetRoomsForTests,
  type CollabServerHandle,
} from "../collab/server";

// y-websocket needs a global WebSocket constructor. Browsers provide it; in
// Node we point at the `ws` package. WebsocketProvider also accepts a
// per-instance polyfill but tests are simpler with a single global override.
(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

const SILENT = (_line: string): void => {
  /* swallow logs in tests */
};

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function makeClient(
  serverUrl: string,
  room: string,
  initText?: string,
): { doc: Y.Doc; provider: WebsocketProvider; ytext: Y.Text } {
  const doc = new Y.Doc();
  const params: { [k: string]: string } = {};
  if (initText !== undefined) {
    params.init = Buffer.from(initText, "utf-8").toString("base64");
  }
  const provider = new WebsocketProvider(serverUrl, room, doc, {
    connect: true,
    params,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  return { doc, provider, ytext: doc.getText("doc") };
}

describe("collab relay server", () => {
  let server: CollabServerHandle;
  let serverUrl: string;

  beforeEach(async () => {
    _resetRoomsForTests();
    // Port 0 → OS picks a free port. Avoids races with other tests or
    // anything else on the dev machine.
    server = await startCollabServer(0, SILENT);
    serverUrl = `ws://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.dispose();
    _resetRoomsForTests();
  });

  it("propagates a Y.Text edit between two clients in the same room", async () => {
    const a = makeClient(serverUrl, "room-1");
    const b = makeClient(serverUrl, "room-1");

    await waitFor(() => a.provider.wsconnected && b.provider.wsconnected);

    a.ytext.insert(0, "hello world");

    await waitFor(() => b.ytext.toString() === "hello world");
    expect(b.ytext.toString()).toBe("hello world");

    a.provider.destroy();
    b.provider.destroy();
  });

  it("isolates edits between distinct rooms", async () => {
    const a = makeClient(serverUrl, "room-A");
    const b = makeClient(serverUrl, "room-B");

    await waitFor(() => a.provider.wsconnected && b.provider.wsconnected);

    a.ytext.insert(0, "alpha");
    // Give the relay enough time to (incorrectly) leak the update if it would.
    await new Promise((r) => setTimeout(r, 200));

    expect(a.ytext.toString()).toBe("alpha");
    expect(b.ytext.toString()).toBe("");

    a.provider.destroy();
    b.provider.destroy();
  });

  it("seeds a fresh room from the first client's init param", async () => {
    const a = makeClient(serverUrl, "room-seed", "from disk\n");
    await waitFor(() => a.provider.wsconnected);
    await waitFor(() => a.ytext.toString() === "from disk\n");
    expect(a.ytext.toString()).toBe("from disk\n");
    a.provider.destroy();
  });

  it("seeds correctly with multi-byte unicode (markdown is often 中文)", async () => {
    // Webview client uses btoa(String.fromCharCode of UTF-8 bytes); server
    // uses Buffer.from(b64, 'base64').toString('utf-8'). Test guards the
    // round-trip against future "let's just btoa the string" regressions
    // (which would mangle anything outside Latin-1).
    const text = "标题\n\nこんにちは — café 🚀\n";
    const a = makeClient(serverUrl, "room-unicode", text);
    await waitFor(() => a.provider.wsconnected);
    await waitFor(() => a.ytext.toString() === text);
    expect(a.ytext.toString()).toBe(text);
    a.provider.destroy();
  });

  it("ignores the init param for a room that already exists", async () => {
    // First client creates the room with one seed.
    const a = makeClient(serverUrl, "room-seed-2", "first writer\n");
    await waitFor(() => a.provider.wsconnected);
    await waitFor(() => a.ytext.toString() === "first writer\n");

    // Second client tries to seed with different text. Server must ignore
    // the new init and hand back the existing doc state.
    const b = makeClient(serverUrl, "room-seed-2", "second writer\n");
    await waitFor(() => b.provider.wsconnected);
    await waitFor(() => b.ytext.toString() === "first writer\n");
    expect(b.ytext.toString()).toBe("first writer\n");

    a.provider.destroy();
    b.provider.destroy();
  });

  it("propagates awareness state to peers", async () => {
    const a = makeClient(serverUrl, "room-aware");
    const b = makeClient(serverUrl, "room-aware");
    await waitFor(() => a.provider.wsconnected && b.provider.wsconnected);

    a.provider.awareness.setLocalStateField("user", { name: "alice", color: "#fff" });

    await waitFor(() => {
      for (const state of b.provider.awareness.getStates().values()) {
        const user = (state as { user?: { name?: string } }).user;
        if (user?.name === "alice") return true;
      }
      return false;
    });

    a.provider.destroy();
    b.provider.destroy();
  });

  it("responds to HTTP GET / with the relay signature", async () => {
    // The extension's probe (`isOurRelay` in extension.ts) checks for this
    // exact substring to distinguish our relay from an unrelated process
    // squatting on port 1234 — the contract is load-bearing.
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port: server.port, path: "/" },
        (res) => {
          let chunks = "";
          res.setEncoding("utf-8");
          res.on("data", (c) => (chunks += c));
          res.on("end", () => resolve(chunks));
        },
      );
      req.on("error", reject);
    });
    expect(body).toContain("markdown-collab y-websocket relay");
  });

  it("tracks rooms via the test accessor", async () => {
    expect(server.roomCount()).toBe(0);
    const a = makeClient(serverUrl, "room-count-1");
    const b = makeClient(serverUrl, "room-count-2");
    await waitFor(() => a.provider.wsconnected && b.provider.wsconnected);
    // Wait for both connections to have triggered room creation. Use a
    // sync round-trip (insert + observe) rather than a sleep so we don't
    // race the server's connection handler.
    a.ytext.insert(0, "x");
    b.ytext.insert(0, "y");
    await waitFor(() => server.roomCount() === 2);
    expect(server.roomCount()).toBe(2);
    a.provider.destroy();
    b.provider.destroy();
  });
});
