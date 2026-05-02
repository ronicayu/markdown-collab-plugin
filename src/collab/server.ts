// Minimal y-websocket-compatible relay server.
//
// Implements the wire protocol expected by the y-websocket client:
//   - Sync step 1/2/update messages (y-protocols/sync)
//   - Awareness updates (y-protocols/awareness)
//   - Authoritative Y.Doc kept in memory per "room" (URL pathname)
//
// Persistence is intentionally absent — this is a relay for live sessions
// only. The on-disk markdown file remains the source of truth; the
// CustomTextEditorProvider mirrors webview edits back to TextDocument
// so a fresh page load (no peers) recovers from the file.

import * as http from "http";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { decoding, encoding } from "lib0";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { decodeSeedText } from "./seedEncoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>;
}

const rooms = new Map<string, Room>();

// Race-free initial seeding. The relay is single-process, so the first
// connection that brings an `?init=...` query string for a fresh room wins.
// Every later connection finds the room already populated and ignores its
// own init param. Without this, two clients racing to be "the first peer"
// would both seed and produce duplicated text.
function getOrCreateRoom(name: string, initialText: string | undefined): Room {
  const existing = rooms.get(name);
  if (existing) return existing;

  const doc = new Y.Doc();
  if (initialText && initialText.length > 0) {
    doc.getText("doc").insert(0, initialText);
  }
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // server is never an editor
  const room: Room = { doc, awareness, conns: new Map() };
  rooms.set(name, room);

  doc.on("update", (update: Uint8Array, _origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    broadcast(room, encoding.toUint8Array(enc));
  });

  awareness.on(
    "update",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      broadcast(room, encoding.toUint8Array(enc));
    },
  );

  return room;
}

function broadcast(room: Room, message: Uint8Array): void {
  for (const conn of room.conns.keys()) {
    if (conn.readyState === WebSocket.OPEN) {
      try {
        conn.send(message);
      } catch {
        closeConn(room, conn);
      }
    }
  }
}

function closeConn(room: Room, conn: WebSocket): void {
  const controlled = room.conns.get(conn);
  if (controlled) {
    room.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      Array.from(controlled),
      null,
    );
  }
  try {
    conn.close();
  } catch {
    /* already closed */
  }
}

function onMessage(room: Room, conn: WebSocket, data: Uint8Array): void {
  try {
    const dec = decoding.createDecoder(data);
    const enc = encoding.createEncoder();
    const messageType = decoding.readVarUint(dec);
    if (messageType === MESSAGE_SYNC) {
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
      // readSyncMessage always writes the messageType byte; only forward if
      // the protocol actually emitted a payload beyond it.
      if (encoding.length(enc) > 1) {
        conn.send(encoding.toUint8Array(enc));
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(dec),
        conn,
      );
    }
  } catch (e) {
    console.error("[markdown-collab y-server] message error", e);
  }
}

function decodeInitParam(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeSeedText(raw);
  } catch {
    return undefined;
  }
}

function onConnection(conn: WebSocket, req: http.IncomingMessage): void {
  conn.binaryType = "arraybuffer";
  // Use a dummy base because req.url is path + query only. URLSearchParams
  // gives us ?init=<base64>; the decoded text is only used the *first* time
  // a room is created, which `getOrCreateRoom` enforces.
  const url = new URL(req.url ?? "/", "http://localhost");
  const roomName = url.pathname.slice(1) || "default";
  const initialText = decodeInitParam(url.searchParams.get("init"));
  const room = getOrCreateRoom(roomName, initialText);
  room.conns.set(conn, new Set());

  conn.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Array.isArray(data)
          ? new Uint8Array(Buffer.concat(data))
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    onMessage(room, conn, bytes);
  });

  conn.on("close", () => closeConn(room, conn));
  conn.on("error", () => closeConn(room, conn));

  // Send sync step 1 + current awareness so the new client converges fast.
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    conn.send(encoding.toUint8Array(enc));
  }
  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(awarenessStates.keys()),
      ),
    );
    conn.send(encoding.toUint8Array(enc));
  }
}

export interface CollabServerHandle {
  port: number;
  roomCount: () => number;
  dispose: () => Promise<void>;
}

export function startCollabServer(
  port: number,
  log: (line: string) => void,
): Promise<CollabServerHandle> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("markdown-collab y-websocket relay\n");
    });
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", onConnection);

    const onError = (err: Error): void => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", onError);
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      log(`y-websocket relay listening on ws://127.0.0.1:${actualPort}`);
      resolve({
        port: actualPort,
        roomCount: () => rooms.size,
        dispose: () =>
          new Promise<void>((done) => {
            // Force-close any lingering sockets so .close() doesn't hang on
            // half-open connections during test teardown.
            for (const ws of wss.clients) {
              try {
                ws.terminate();
              } catch {
                /* already gone */
              }
            }
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}

// Test-only escape hatch. Production code never needs this — the relay is
// process-wide so two tests sharing the module would otherwise leak rooms
// across tests.
export function _resetRoomsForTests(): void {
  for (const room of rooms.values()) {
    for (const conn of room.conns.keys()) {
      try {
        conn.terminate();
      } catch {
        /* already gone */
      }
    }
    room.doc.destroy();
  }
  rooms.clear();
}
