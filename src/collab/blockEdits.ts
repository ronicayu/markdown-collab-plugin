// Which top-level blocks an edit in the live editor changed (10x-plan-6 P4,
// phase B; design in docs/one-view-design.md, "Phase B: edit mode").
//
// Edit mode used to post the editor's whole serialization on every edit, and
// the host adopted it as the file — so one keystroke rewrote every block the
// serializer formats differently from how it was written (3–624 lines on the
// spike's documents). Now the webview reports only the top-level blocks the
// edit touched, each with its serialized Markdown, and the host splices those
// into the file's own bytes (`applyBlockEdits` in inlineBridge.ts).
//
// Which blocks were touched is read off node identity. ProseMirror documents
// are immutable and share structure: a step rebuilds exactly the top-level
// nodes it touches and reuses every other one by reference. So comparing the
// document as last synced with the host against the current one, node by
// node, says which top-level nodes the transactions in between touched —
// however many there were, including undo (which puts back the old objects)
// and a block dragged elsewhere (the same object at a new index).
//
// Pure and generic over the node type, so it's tested without a browser.

/** One change to the file's top-level blocks, as the webview posts it. */
export interface BlockEdit {
  /** Base block indices `[from, to)` it replaces; `from === to` inserts before `from`. */
  from: number;
  to: number;
  /** The new blocks serialized together, without a trailing newline; "" deletes. */
  markdown: string;
  /** The new blocks' ProseMirror node types, one per block. */
  types: string[];
}

/** The `edit-blocks` message (webview → host). */
export interface BlockEditsMessage {
  type: "edit-blocks";
  /** The host's document epoch the edit is based on (bumped on every re-render it sends). */
  epoch: number;
  /** The base document's block types, so the host can check its table describes the same blocks. */
  baseTypes: string[];
  edits: BlockEdit[];
}

/** The slice of a ProseMirror node the diff reads. */
export interface BlockNodeLike {
  type: { name: string };
  content: { size: number };
}

/**
 * The top-level nodes that stand for Markdown blocks: all of them except a
 * trailing empty paragraph. That one is milkdown's placeholder — an empty
 * document gets one, and so does Enter at the end — and the serializer writes
 * the document's last empty paragraph as nothing, so it has no bytes to map.
 */
export function markdownBlockNodes<N extends BlockNodeLike>(doc: { childCount: number; child(i: number): N }): N[] {
  const nodes: N[] = [];
  for (let i = 0; i < doc.childCount; i++) nodes.push(doc.child(i));
  const last = nodes[nodes.length - 1];
  if (last && last.type.name === "paragraph" && last.content.size === 0) nodes.pop();
  return nodes;
}

/** One changed run: base blocks `[from, to)` became `nodes`. */
export interface BlockChange<N> {
  from: number;
  to: number;
  nodes: N[];
}

/**
 * The runs of `next` that differ from `base`. Nodes shared by reference (the
 * longest increasing run of them) are unchanged; each gap between two is a
 * change. Within a gap, `same` (equal Markdown — a plugin that rewrote an attr
 * the serializer ignores, or a character typed and deleted again) trims the
 * ends; a gap whose two sides have equal length is compared pair by pair, so
 * two blocks edited in one debounce stay two changes. A split or a merge is a
 * gap of unequal sides and stays one change over the union.
 */
export function diffBlocks<N>(base: readonly N[], next: readonly N[], same: (a: N, b: N) => boolean): BlockChange<N>[] {
  let head = 0;
  while (head < base.length && head < next.length && base[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < next.length - head &&
    base[base.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }
  // Pairs [baseIndex, nextIndex] of shared nodes in the middle, in order.
  const anchors = sharedRun(base, next, head, base.length - tail, head, next.length - tail);
  const changes: BlockChange<N>[] = [];
  let a = head;
  let c = head;
  for (const [ai, ci] of [...anchors, [base.length - tail, next.length - tail] as [number, number]]) {
    gapChanges(base, next, a, ai, c, ci, same, changes);
    a = ai + 1;
    c = ci + 1;
  }
  return changes;
}

/** The longest run of nodes shared by reference, in increasing order on both sides. */
function sharedRun<N>(
  base: readonly N[],
  next: readonly N[],
  b0: number,
  b1: number,
  n0: number,
  n1: number,
): Array<[number, number]> {
  const at = new Map<N, number>();
  for (let i = b0; i < b1; i++) at.set(base[i]!, i);
  const pairs: Array<[number, number]> = [];
  for (let j = n0; j < n1; j++) {
    const i = at.get(next[j]!);
    if (i !== undefined) pairs.push([i, j]);
  }
  if (pairs.length === 0) return [];
  // Longest increasing subsequence on the base index (next indices already increase).
  const tails: number[] = [];
  const prev = new Array<number>(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const v = pairs[k]![0];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![0] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
  }
  const run: Array<[number, number]> = [];
  for (let k = tails[tails.length - 1]!; k >= 0; k = prev[k]!) run.push(pairs[k]!);
  return run.reverse();
}

function gapChanges<N>(
  base: readonly N[],
  next: readonly N[],
  a: number,
  b: number,
  c: number,
  d: number,
  same: (x: N, y: N) => boolean,
  out: BlockChange<N>[],
): void {
  if (a === b && c === d) return;
  if (b - a === d - c) {
    let runStart = -1;
    for (let k = 0; k <= b - a; k++) {
      const differs = k < b - a && !same(base[a + k]!, next[c + k]!);
      if (differs && runStart < 0) runStart = k;
      if (!differs && runStart >= 0) {
        out.push({ from: a + runStart, to: a + k, nodes: next.slice(c + runStart, c + k) });
        runStart = -1;
      }
    }
    return;
  }
  while (a < b && c < d && same(base[a]!, next[c]!)) {
    a++;
    c++;
  }
  while (a < b && c < d && same(base[b - 1]!, next[d - 1]!)) {
    b--;
    d--;
  }
  out.push({ from: a, to: b, nodes: next.slice(c, d) });
}
