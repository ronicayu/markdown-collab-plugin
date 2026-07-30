// A human-readable summary of a review pass (10x-plan-2 P3.2).
//
// After a pass the state is all there — who opened what, what got resolved,
// which suggestions are still waiting — but reading it means scrolling a sidebar
// thread by thread. The thing people actually want next is a paragraph they can
// paste into a PR description or a message: what was reviewed, what came out of
// it, what is still open.
//
// A pure function over parsed documents. No Claude round-trip: everything it
// says is already in the files, and asking a model to restate facts it can read
// would be slower, costlier, and occasionally wrong.

import type { InlineThread, ParsedDocument } from "./inlineComments/format";
import { staleThreadIds } from "./inlineComments/staleness";

export interface DigestFile {
  /** Workspace-relative path. */
  rel: string;
  parsed: ParsedDocument;
}

export interface DigestCounts {
  threads: number;
  open: number;
  resolved: number;
  /** Threads opened by claude — the review pass's own findings. */
  fromClaude: number;
  /** Open threads whose last word is the human's: Claude owes a reply. */
  awaitingClaude: number;
  /** Open threads Claude answered and the human hasn't come back to. */
  awaitingHuman: number;
  suggestions: number;
  /** Threads whose anchored text moved after their last comment (P1.3). */
  stale: number;
}

function lastLive(t: InlineThread) {
  const live = t.comments.filter((c) => !c.deleted);
  return live[live.length - 1];
}

export function countsFor(parsed: ParsedDocument): DigestCounts {
  const stale = new Set(staleThreadIds(parsed));
  const counts: DigestCounts = {
    threads: parsed.threads.length,
    open: 0,
    resolved: 0,
    fromClaude: 0,
    awaitingClaude: 0,
    awaitingHuman: 0,
    suggestions: parsed.suggestions.length,
    stale: 0,
  };
  for (const t of parsed.threads) {
    if (t.status === "resolved") counts.resolved++;
    else counts.open++;
    const live = t.comments.filter((c) => !c.deleted);
    if (live[0]?.author === "claude") counts.fromClaude++;
    if (stale.has(t.id)) counts.stale++;
    if (t.status === "open") {
      const last = lastLive(t);
      if (last?.author === "claude") counts.awaitingHuman++;
      else if (last) counts.awaitingClaude++;
    }
  }
  return counts;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** First line of a comment body, trimmed for a bullet. */
function gist(body: string, max = 120): string {
  const line = body.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The digest as Markdown.
 *
 * Written to be pasted somewhere else, so: no VS Code-only affordances, thread
 * ids included (they are how a reader finds the thread), and quotes trimmed to
 * one line so a long anchor doesn't swallow the summary.
 */
export function buildReviewDigest(
  files: DigestFile[],
  now: () => string = () => new Date().toISOString(),
): string {
  const lines: string[] = ["# Review summary", "", `_Generated ${now()}_`, ""];

  const totals: DigestCounts = {
    threads: 0,
    open: 0,
    resolved: 0,
    fromClaude: 0,
    awaitingClaude: 0,
    awaitingHuman: 0,
    suggestions: 0,
    stale: 0,
  };
  for (const f of files) {
    const c = countsFor(f.parsed);
    for (const key of Object.keys(totals) as Array<keyof DigestCounts>) totals[key] += c[key];
  }

  if (totals.threads === 0 && totals.suggestions === 0) {
    lines.push(
      files.length === 1
        ? `\`${files[0]!.rel}\` has no review threads.`
        : `No review threads in ${plural(files.length, "file")}.`,
    );
    return `${lines.join("\n")}\n`;
  }

  const headline = [
    plural(totals.threads, "thread"),
    `${totals.open} open`,
    `${totals.resolved} resolved`,
  ];
  if (totals.suggestions > 0) headline.push(plural(totals.suggestions, "pending suggestion"));
  lines.push(
    files.length === 1
      ? `\`${files[0]!.rel}\` — ${headline.join(", ")}.`
      : `${plural(files.length, "file")} — ${headline.join(", ")}.`,
    "",
  );

  // What the reader has to do next, stated before the detail.
  const next: string[] = [];
  if (totals.awaitingHuman > 0) next.push(`${totals.awaitingHuman} waiting on you to read Claude's reply`);
  if (totals.awaitingClaude > 0) next.push(`${totals.awaitingClaude} not yet answered by Claude`);
  if (totals.suggestions > 0) next.push(`${totals.suggestions} suggestion(s) to accept or reject`);
  if (totals.stale > 0) next.push(`${totals.stale} anchored on text that has since changed`);
  if (next.length > 0) lines.push(`**Still open:** ${next.join("; ")}.`, "");

  for (const file of files) {
    const c = countsFor(file.parsed);
    if (c.threads === 0 && c.suggestions === 0) continue;
    if (files.length > 1) {
      lines.push(`## \`${file.rel}\``, "", `${c.open} open, ${c.resolved} resolved.`, "");
    }

    const open = file.parsed.threads.filter((t) => t.status === "open");
    const resolved = file.parsed.threads.filter((t) => t.status === "resolved");
    const stale = new Set(staleThreadIds(file.parsed));

    if (open.length > 0) {
      lines.push("### Open", "");
      for (const t of open) {
        const live = t.comments.filter((c2) => !c2.deleted);
        const flags: string[] = [];
        if (live[0]?.author === "claude") flags.push("from Claude");
        if (stale.has(t.id)) flags.push("text changed since");
        const suffix = flags.length > 0 ? ` _(${flags.join(", ")})_` : "";
        lines.push(`- **\`${t.id}\`** on "${gist(t.quote, 60)}" — ${gist(live[0]?.body ?? "")}${suffix}`);
        const reply = live.length > 1 ? live[live.length - 1] : undefined;
        if (reply) lines.push(`  - ${reply.author}: ${gist(reply.body)}`);
      }
      lines.push("");
    }

    if (resolved.length > 0) {
      lines.push("### Resolved", "");
      for (const t of resolved) {
        const live = t.comments.filter((c2) => !c2.deleted);
        lines.push(`- \`${t.id}\` on "${gist(t.quote, 60)}" — ${gist(live[0]?.body ?? "")}`);
      }
      lines.push("");
    }

    if (file.parsed.suggestions.length > 0) {
      lines.push("### Pending suggestions", "");
      for (const s of file.parsed.suggestions) {
        lines.push(
          `- \`${s.anchorId}\`: "${gist(s.original, 60)}" → "${gist(s.proposed, 60)}"${
            s.note ? ` — ${gist(s.note)}` : ""
          }`,
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").replace(/\n{3,}$/, "\n")}\n`;
}
