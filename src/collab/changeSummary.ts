// Summarize a disk-side (Claude / external) prose change for the live editor's
// presence affordances (10x-plan P1.2).
//
// Given the editor's previous prose and the new prose, compute the single
// changed span (a prefix/suffix diff — good enough to point the eye at "what
// changed") and the nearest heading above it, so the editor can flash the span
// and show "Claude edited §Heading". Pure and offset-based; the webview maps
// the returned prose range to editor positions.

export interface ChangeSummary {
  /** Changed span in the NEW prose, half-open `[start, end)`. */
  start: number;
  end: number;
  /**
   * The new prose in the changed span. The webview locates THIS in the
   * editor's rendered text to place the "Claude edited" highlight — offsets
   * are prose-space and don't map to the rendered doc, but the text does.
   * Empty for a pure deletion.
   */
  text: string;
  /** Text of the nearest ATX heading at or above the change, or null. */
  heading: string | null;
}

/**
 * The minimal changed span between `oldText` and `newText`: strip the common
 * prefix and the common suffix, and what remains in `newText` is the change.
 * Returns null when the texts are equal. When the change is a pure deletion
 * (nothing left in newText), `start === end` marks the deletion point.
 */
export function summarizeChange(oldText: string, newText: string): ChangeSummary | null {
  if (oldText === newText) return null;

  const maxPrefix = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const start = prefix;
  const end = newText.length - suffix;
  return { start, end, text: newText.slice(start, end), heading: nearestHeadingAbove(newText, start) };
}

/**
 * The most recent ATX heading (`# …` through `###### …`) on or before the line
 * containing `offset`. Returns the heading's text (without the `#`s or a
 * trailing `#` run), or null when the change is above the first heading.
 */
export function nearestHeadingAbove(text: string, offset: number): string | null {
  let heading: string | null = null;
  let lineStart = 0;
  const cap = Math.min(offset, text.length);
  while (lineStart <= cap) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const m = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (m) heading = m[1].trim();
    if (lineEnd >= cap) break;
    lineStart = lineEnd + 1;
  }
  return heading;
}
