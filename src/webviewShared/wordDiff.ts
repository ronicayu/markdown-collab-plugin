// Word-level diff for the suggestion card (round-6 P2.2).
//
// Dependency-free: tokenizes on whitespace/punctuation boundaries and finds
// the longest common subsequence of tokens, so a one-word change reads as a
// struck-through word next to its replacement inside the sentence, instead of
// the whole paragraph doubled into a `-` old / `+` new pair. `commentUi.ts`
// falls back to that old block view past `isBulkRewrite`'s guard, where a
// word-by-word diff would be mostly red and green and harder to read than two
// plain paragraphs.

/**
 * One run of the diff: a stretch of tokens that's unchanged, removed, or
 * added. Adjacent tokens of the same kind are merged as the walk goes, so
 * `text` is usually several words wide, not one token.
 */
export interface DiffOp {
  kind: "equal" | "del" | "ins";
  text: string;
}

// Three kinds of token: a run of word characters, a run of whitespace, or a
// single punctuation character. `tokenize(s).join("")` always reproduces `s`
// exactly, which is what lets the diff re-render the text verbatim.
const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/** A run of pure whitespace doesn't count as a "changed word" — two sentences
 * that differ only in spacing shouldn't read as 100% rewritten. */
function isMeaningful(token: string): boolean {
  return !/^\s+$/.test(token);
}

function countMeaningful(tokens: string[]): number {
  let n = 0;
  for (const t of tokens) if (isMeaningful(t)) n++;
  return n;
}

/**
 * Longest common subsequence of two token arrays, walked back into a
 * run-length-encoded list of equal/del/ins ops. O(n·m) time and space — fine
 * at prose-sentence scale; `isBulkRewrite`'s length guard is what keeps this
 * from ever running on a paragraph large enough for that to matter.
 */
export function diffTokens(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  const push = (kind: DiffOp["kind"], text: string): void => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i]!);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i]!);
      i++;
    } else {
      push("ins", b[j]!);
      j++;
    }
  }
  while (i < n) push("del", a[i++]!);
  while (j < m) push("ins", b[j++]!);
  return ops;
}

/** Word-level diff between two strings (tokenizes both, then `diffTokens`). */
export function diffWords(original: string, proposed: string): DiffOp[] {
  return diffTokens(tokenize(original), tokenize(proposed));
}

/** Past this length on either side, a word diff is too big to read as one
 * sentence — fall back regardless of how much of it actually changed. */
const MAX_INLINE_LEN = 600;
/** Past this fraction of the longer side's tokens changed, the diff is mostly
 * red and green and reads worse than two plain old/new paragraphs. */
const MAX_CHANGE_RATIO = 0.6;

/**
 * Should the suggestion card fall back to the whole-block old/new view
 * instead of one inline sentence? True once either side is long, or once
 * more of the longer side's tokens differ than match it.
 */
export function isBulkRewrite(original: string, proposed: string): boolean {
  if (original.length > MAX_INLINE_LEN || proposed.length > MAX_INLINE_LEN) return true;
  const ops = diffTokens(tokenize(original), tokenize(proposed));
  const longer = Math.max(countMeaningful(tokenize(original)), countMeaningful(tokenize(proposed)), 1);
  let equalCount = 0;
  for (const op of ops) if (op.kind === "equal") equalCount += countMeaningful(tokenize(op.text));
  return (longer - equalCount) / longer > MAX_CHANGE_RATIO;
}
