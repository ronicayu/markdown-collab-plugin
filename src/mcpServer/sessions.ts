// Per-connection agent identity for the MCP server (10x-plan-4 P1.2).
//
// The server was stateless until now — every request stood on its own, which
// is fine for `tools/call` (each one names its own file) but leaves nothing
// to hang "which agent is this?" off. Streamable HTTP already has the answer:
// the transport issues an `Mcp-Session-Id` on `initialize` and the client
// echoes it on every request after, so a session id is exactly the key this
// needs. This module is the map from that id to the slug `initialize`'s
// `clientInfo.name` resolved to.
//
// Kept pure (no http, no crypto) — `httpServer.ts` mints the id and reads the
// header; this just remembers what it was told.

import { agentSlugFromClientName } from "../agentIdentity";

/** How many connections to remember at once. A workspace only ever has a
 * handful of agents attached; this is generous headroom against a client
 * that reconnects a lot (a new session id per reconnect) without letting an
 * abandoned session's slug live forever. */
const MAX_SESSIONS = 64;

export class SessionRegistry {
  /** Insertion-ordered: `Map` preserves it, and re-`set`ting a key moves it
   * to the end, which is exactly the recency `evict()` needs. */
  private readonly slugs = new Map<string, string>();

  /** Record the slug an `initialize` resolved to, for `sessionId`. */
  record(sessionId: string, clientName: string | undefined): void {
    const slug = agentSlugFromClientName(clientName);
    this.slugs.delete(sessionId);
    this.slugs.set(sessionId, slug);
    this.evict();
  }

  /** The slug for a session, or the generic fallback for one this registry
   * never saw `initialize` on (an unknown or absent session id) — a `tools/call`
   * that skipped or predates the handshake still gets attributed to *some*
   * agent rather than crashing or silently becoming Claude's. */
  slugFor(sessionId: string | undefined): string {
    if (sessionId === undefined) return "agent";
    return this.slugs.get(sessionId) ?? "agent";
  }

  private evict(): void {
    while (this.slugs.size > MAX_SESSIONS) {
      const oldest = this.slugs.keys().next().value;
      if (oldest === undefined) break;
      this.slugs.delete(oldest);
    }
  }
}
