// Narrow a whole-document rewrite to the span that actually changed
// (10x-plan P3.2).
//
// Every comment operation runs the document through the format engine and
// produces a new string, which used to be applied as a single `WorkspaceEdit`
// replacing the entire file. That is correct but wasteful: replying to a
// thread changes one line in the threads region, and rewriting 500 KB to say
// so makes VS Code re-tokenize the whole buffer, disturbs folds and
// decorations, and writes a diff that looks like "everything changed" to
// anything watching the file.
//
// Stripping the common prefix and suffix gives the minimal replacement for
// the kinds of edits the engine actually makes (insert markers, rewrite one
// thread line, drop a thread). It is not a real diff — two distant changes
// collapse into one span covering both — which is the right trade here: still
// correct, still much smaller than the file, and no diff library.

export interface MinimalEdit {
  /** Start offset in the OLD text of the range to replace. */
  start: number;
  /** End offset in the OLD text of the range to replace (exclusive). */
  end: number;
  /** Text to put there. */
  replacement: string;
}

/**
 * The smallest single replacement turning `before` into `after`, or null when
 * they are identical.
 */
export function minimalEdit(before: string, after: string): MinimalEdit | null {
  if (before === after) return null;

  const maxPrefix = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;

  // Don't let the suffix scan run back past the prefix in either string, or
  // an edit like "aa" → "aaa" would produce overlapping bounds.
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    start: prefix,
    end: before.length - suffix,
    replacement: after.slice(prefix, after.length - suffix),
  };
}
