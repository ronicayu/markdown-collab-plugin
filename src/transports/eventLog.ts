import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { ReviewPayload } from "../sendToClaude";
import { loadSidecar, sidecarPathFor } from "../sidecar";
import type { Comment } from "../types";

export const EVENT_LOG_REL = path.join(".markdown-collab", ".events.jsonl");
export const EVENT_ACKED_REL = path.join(".markdown-collab", ".events.acked.jsonl");

export interface EventEnvelope extends ReviewPayload {
  id: string;
  ts: string;
}

interface AckEntry {
  id: string;
  ts: string;
}

/**
 * Append-only newline-delimited JSON log under
 * `<workspace>/.markdown-collab/.events.jsonl`. Claude Code reads it via a
 * background `mdc-tail.mjs` paired with the `Monitor` tool — each appended
 * line surfaces as a model notification.
 *
 * A sibling `.events.acked.jsonl` records the ids of events whose comments
 * have all been addressed by Claude (last reply is from `ai`, or comment is
 * resolved/deleted). The tailer skips acked events, so once Claude finishes
 * a batch the corresponding event stops surfacing on subsequent restarts /
 * `--from-start` replays. Both files are append-only so neither racing
 * appenders nor live readers see torn state.
 */
export class EventLog {
  private readonly logPath: string;
  private readonly ackedPath: string;
  private readonly workspaceRoot: string;
  private ensured = false;
  private reconciling = false;
  private reconcilePending = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.logPath = path.join(workspaceRoot, EVENT_LOG_REL);
    this.ackedPath = path.join(workspaceRoot, EVENT_ACKED_REL);
  }

  public get path(): string {
    return this.logPath;
  }

  public get ackedFilePath(): string {
    return this.ackedPath;
  }

  public async append(payload: ReviewPayload): Promise<EventEnvelope> {
    if (!this.ensured) {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      this.ensured = true;
    }
    const envelope: EventEnvelope = {
      ...payload,
      id: "evt_" + crypto.randomBytes(6).toString("hex"),
      ts: new Date().toISOString(),
    };
    await fs.appendFile(this.logPath, JSON.stringify(envelope) + "\n", "utf8");
    return envelope;
  }

  /**
   * Scan unacked events; for every event whose referenced comments are now
   * all "addressed" (last reply is `ai`, or the comment was resolved /
   * deleted), append an ack line. Idempotent: re-running with no new state
   * change is a no-op.
   *
   * Serialized via a single in-flight guard so multiple sidecar mutations
   * in quick succession coalesce into one reconcile pass.
   */
  public async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.reconcilePending = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcilePending = false;
        await this.reconcileInner();
      } while (this.reconcilePending);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileInner(): Promise<void> {
    const events = await readJsonLines<EventEnvelope>(this.logPath);
    if (events.length === 0) return;
    const ackedIds = new Set(
      (await readJsonLines<AckEntry>(this.ackedPath)).map((a) => a.id),
    );
    const sidecarCache = new Map<string, Comment[] | null>();
    const newAcks: AckEntry[] = [];
    for (const ev of events) {
      if (!ev.id || ackedIds.has(ev.id)) continue;
      if (await this.allAddressed(ev, sidecarCache)) {
        newAcks.push({ id: ev.id, ts: new Date().toISOString() });
        ackedIds.add(ev.id);
      }
    }
    if (newAcks.length === 0) return;
    await fs.mkdir(path.dirname(this.ackedPath), { recursive: true });
    const text = newAcks.map((a) => JSON.stringify(a)).join("\n") + "\n";
    await fs.appendFile(this.ackedPath, text, "utf8");
  }

  private async allAddressed(
    ev: EventEnvelope,
    sidecarCache: Map<string, Comment[] | null>,
  ): Promise<boolean> {
    if (!Array.isArray(ev.comments) || ev.comments.length === 0) return true;
    const sidecarPath = sidecarPathFor(
      path.join(this.workspaceRoot, ev.file),
      this.workspaceRoot,
    );
    if (!sidecarPath) return false;
    let comments: Comment[] | null | undefined = sidecarCache.get(sidecarPath);
    if (comments === undefined) {
      const loaded = await loadSidecar(sidecarPath);
      comments = loaded ? loaded.sidecar.comments : null;
      sidecarCache.set(sidecarPath, comments);
    }
    if (!comments) {
      // Sidecar gone (e.g. file deleted). Nothing left to address.
      return true;
    }
    const byId = new Map(comments.map((c) => [c.id, c]));
    for (const expected of ev.comments) {
      const live = byId.get(expected.id);
      if (!live) continue; // deleted ⇒ addressed
      if (live.resolved) continue;
      const lastReply = live.replies[live.replies.length - 1];
      if (lastReply && lastReply.author === "ai") continue;
      return false;
    }
    return true;
  }
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed lines — append-only log, never abort on a single
      // bad line.
    }
  }
  return out;
}
