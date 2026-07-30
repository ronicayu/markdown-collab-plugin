// The prompt for "review what changed since last time" (10x-plan-2 P1.1).
//
// Pure string assembly over `deltaScope`, kept separate from the command that
// dispatches it so the wording is testable — and so the two things most likely
// to go wrong are visible in one place: sending a passage Claude has already
// reviewed, and letting it re-raise a concern the human settled.

import type { DeltaScope, ExistingThread } from "./deltaReview";

/** Cap the changed-section text so an enormous edit doesn't blow up the prompt. */
const MAX_SECTION_CHARS = 4000;

function truncate(text: string, max = MAX_SECTION_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[section truncated]`;
}

function threadLines(existing: ExistingThread[]): string[] {
  return existing.map((t) => {
    const flags = [t.status === "resolved" ? "resolved" : "open"];
    if (t.stale) flags.push("text changed since the last comment");
    return `- \`${t.id}\` (${flags.join(", ")}) on "${t.quote}" — ${t.gist}`;
  });
}

/**
 * The body of a delta review request, or null when there is nothing to review.
 *
 * Null happens when the document hasn't moved since the last pass. The caller
 * should say so rather than sending Claude to re-read an unchanged file — the
 * whole point of this feature is not doing that.
 */
export function buildDeltaPrompt(rel: string, scope: DeltaScope, focus?: string): string | null {
  if (scope.kind === "unchanged") return null;

  const trimmedFocus = focus?.trim();
  const lines: string[] = [];

  if (scope.kind === "no-checkpoint") {
    // First pass on this file, or a checkpoint too old to compare against.
    lines.push(`Use the vs-markdown-collab skill in Review Mode on \`${rel}\`.`);
    if (trimmedFocus) lines.push(`Focus: ${trimmedFocus}`);
    if (scope.existing.length > 0) {
      lines.push(
        "",
        "This document already has review threads. Do not re-raise a concern that one of these",
        "already covers — reply to the existing thread instead if you have something to add:",
        ...threadLines(scope.existing),
      );
    }
    return lines.join("\n");
  }

  lines.push(
    `Use the vs-markdown-collab skill in Review Mode on \`${rel}\`, but review only what has`,
    `changed since your last pass (${scope.checkpoint.ts}).`,
  );
  if (trimmedFocus) lines.push("", `Focus: ${trimmedFocus}`);

  lines.push(
    "",
    `Changed since that pass — ${scope.changed.length} section${scope.changed.length === 1 ? "" : "s"}:`,
  );
  for (const section of scope.changed) {
    const title = section.heading ? `§${section.heading}` : "(before the first heading)";
    lines.push("", `### ${title} — ${section.change}, from line ${section.startLine}`, "", truncate(section.text));
  }

  if (scope.removedHeadings.length > 0) {
    lines.push(
      "",
      `Sections that existed at the last pass and are now gone: ${scope.removedHeadings
        .map((h) => `§${h}`)
        .join(", ")}. Flag anything that still refers to them.`,
    );
  }

  lines.push(
    "",
    "Rules for this pass:",
    "- Do not review unchanged prose. It was reviewed already; re-raising it wastes the human's triage.",
    "- Read the rest of the file for context when you need it, but only open threads on the changed sections",
    "  (or on text elsewhere that the change has now made wrong — say why in the body).",
  );

  if (scope.existing.length > 0) {
    lines.push(
      "",
      "Threads that already exist. Cross-reference them by id rather than opening a duplicate:",
      ...threadLines(scope.existing),
      "",
      "- A **resolved** thread is settled. Do not raise it again unless the new text reintroduces the problem —",
      "  and if it does, say which thread it was, e.g. \"this brings back the issue from a1b2c\".",
      "- A thread marked **text changed** was written about a passage that has since been edited. Re-read those",
      "  first: the concern may already be handled, or may have moved.",
    );
  }

  return lines.join("\n");
}
