// Per-connection agent identity for the MCP server. Each `tools/call` names its own
// file but nothing else says "which agent is this?"; streamable HTTP's `Mcp-Session-Id`
// (issued on `initialize`, echoed on every request after) is exactly the key. This
// module is the map from that id to the slug `initialize`'s `clientInfo.name` resolved to.
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
