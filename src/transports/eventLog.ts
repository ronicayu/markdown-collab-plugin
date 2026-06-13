import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { ReviewPayload } from "../sendToClaude";

export const EVENT_LOG_REL = path.join(".markdown-collab", ".events.jsonl");

export interface EventEnvelope extends ReviewPayload {
  id: string;
  ts: string;
}

/**
 * Append-only newline-delimited JSON log under
 * `<workspace>/.markdown-collab/.events.jsonl`. Claude Code reads it via a
 * background `mdc-tail.mjs` paired with the `Monitor` tool — each appended
 * line surfaces as a model notification. Append-only so neither racing
 * appenders nor live readers see torn state.
 */
export class EventLog {
  private readonly logPath: string;
  private ensured = false;

  constructor(workspaceRoot: string) {
    this.logPath = path.join(workspaceRoot, EVENT_LOG_REL);
  }

  public get path(): string {
    return this.logPath;
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
}
