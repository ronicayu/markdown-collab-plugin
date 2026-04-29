import * as fs from "fs/promises";
import * as path from "path";
import type { ReviewPayload } from "../sendToClaude";

export const EVENT_LOG_REL = path.join(".markdown-collab", ".events.jsonl");

interface EventEnvelope extends ReviewPayload {
  ts: string;
}

/**
 * Append-only newline-delimited JSON log under
 * `<workspace>/.markdown-collab/.events.jsonl`. Claude Code reads it via a
 * background `tail -f` paired with the `Monitor` tool — each appended line
 * surfaces as a model notification, so the button-click → Claude pipeline
 * is event-driven with no long-poll or HTTP server. The log is created
 * lazily on first event and never truncated.
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

  public async append(payload: ReviewPayload): Promise<void> {
    if (!this.ensured) {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      this.ensured = true;
    }
    const envelope: EventEnvelope = { ...payload, ts: new Date().toISOString() };
    // appendFile is a single syscall on POSIX; for line-sized writes (<4KB)
    // it is atomic with respect to other concurrent appenders, so a Claude
    // `tail -f` reader never sees a torn line.
    await fs.appendFile(this.logPath, JSON.stringify(envelope) + "\n", "utf8");
  }
}

