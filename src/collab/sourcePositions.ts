// Source positions for the live editor's read-only mode. Every visible character
// of a text block knows the exact source bytes it came from, so a highlight is
// "the characters whose bytes lie inside the anchor" and a new comment is "the
// bytes under the selected characters". Nothing is searched.
//
// Offsets are into the string the editor parsed (the file with frontmatter,
// markers and the threads region removed). The host translates prose <-> file
// offsets; this module never sees the file.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type RunKind = 0 | 1;

export type SourceRun = [start: number, end: number, visibleLength: number, kind: RunKind];

export interface BlockSource {
  start: number;
  end: number;
  runs: SourceRun[] | null;
}

export const SOURCE_ATTR = "mcSrc";

interface MdPoint {
  offset?: number;
}

export interface MdNode {
  type: string;
  value?: unknown;
  children?: MdNode[];
  position?: { start: MdPoint; end: MdPoint };
  data?: Record<string, unknown>;
}

// The mdast nodes the editor turns into a block of inline text. List items,
// blockquotes and footnote definitions hold paragraphs, so they're covered by
// the paragraphs inside them.
const TEXT_CONTAINERS = new Set(["paragraph", "heading", "tableCell"]);

// Milkdown's `remarkLineBreak` replaces every `[\t ]*` + line ending inside a
// text node with a break node, which contributes no text. A run's visible
// length has to apply the same rule, or the run lengths stop summing to the
// block's text and the block is (correctly, but needlessly) left unmapped.
const LINE_BREAK = /[\t ]*(?:\r?\n|\r)/g;

export function visibleTextOf(value: string, kind: RunKind): string {
  return kind === 1 ? value : value.replace(LINE_BREAK, "");
}

/**
 * Record, on every text container in `tree`, its source range and its text
 * runs in document order (`data.mcSrc`). Meant to run as an mdast transform
 * inside the parser, before other transforms split text nodes and drop their
 * positions; a leaf without a position makes the whole block unmappable
 * (`runs: null`) rather than guessed at.
 */
export function annotateSourceRuns(tree: MdNode): void {
  const visit = (node: MdNode): void => {
    if (TEXT_CONTAINERS.has(node.type)) {
      stamp(node);
      return; // text containers don't nest
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

function stamp(node: MdNode): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;
  const runs: SourceRun[] = [];
  let complete = true;
  const collect = (children: MdNode[]): void => {
    for (const child of children) {
      if (child.type === "text" || child.type === "inlineCode") {
        const s = child.position?.start.offset;
        const e = child.position?.end.offset;
        if (s === undefined || e === undefined) {
          complete = false;
          continue;
        }
        const kind: RunKind = child.type === "text" ? 0 : 1;
        const length = visibleTextOf(typeof child.value === "string" ? child.value : "", kind).length;
        // An empty run adds no text node (ProseMirror has no empty text).
        if (length > 0) runs.push([s, e, length, kind]);
      } else if (child.children) {
        // Emphasis, strong, links, strikethrough: their text is ours. Images,
        // HTML, breaks and footnote references produce no text and no run.
        collect(child.children);
      }
    }
  };
  collect(node.children ?? []);
  const src: BlockSource = { start, end, runs: complete ? runs : null };
  node.data = { ...(node.data ?? {}), [SOURCE_ATTR]: src };
}

/** Decode a named character reference (`amp` → `&`); undefined when it isn't one. */
export type DecodeNamed = (name: string) => string | undefined;

const BACKSLASH = 92;
const AMP = 38;
const LF = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const GT = 62;
const BACKTICK = 96;

// CommonMark's character reference shapes, with micromark's length limits.
const CHAR_REF = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/y;

const isAsciiPunct = (c: number): boolean =>
  (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);

// Source bytes inside a run that produce no text: line endings, the spaces
// around them, and a continuation line's container prefix (`>`, indentation).
const isSkippable = (c: number): boolean => c === SPACE || c === TAB || c === LF || c === CR || c === GT;

/** micromark's numeric reference rule: controls, surrogates and out-of-range become U+FFFD. */
function decodeNumeric(digits: string, base: number): string {
  const code = Number.parseInt(digits, base);
  if (
    code < 9 ||
    code === 11 ||
    (code > 13 && code < 32) ||
    (code > 126 && code < 160) ||
    (code > 55295 && code < 57344) ||
    (code > 64975 && code < 65008) ||
    (code & 65535) === 65535 ||
    (code & 65535) === 65534 ||
    code > 1114111
  ) {
    return "�";
  }
  return String.fromCodePoint(code);
}

/**
 * Map each character of `visible` (one run's text as the editor shows it) to
 * the source span that produced it, writing `[starts[at+i], ends[at+i])`.
 * Returns false when the text can't be explained by the run's source — the
 * caller then treats the whole block as unmappable. Never partially guesses:
 * every character either matches a source byte (or an escape / character
 * reference) or the run fails.
 */
export function alignRun(
  markdown: string,
  run: SourceRun,
  visible: string,
  decodeNamed: DecodeNamed,
  starts: Int32Array,
  ends: Int32Array,
  at: number,
): boolean {
  return run[3] === 1
    ? alignCode(markdown, run[0], run[1], visible, starts, ends, at)
    : alignText(markdown, run[0], run[1], visible, decodeNamed, starts, ends, at);
}

function alignText(
  md: string,
  s: number,
  e: number,
  vis: string,
  decodeNamed: DecodeNamed,
  starts: Int32Array,
  ends: Int32Array,
  at: number,
): boolean {
  let j = s;
  let i = 0;
  while (i < vis.length) {
    if (j >= e) return false;
    const c = md.charCodeAt(j);
    const want = vis.charCodeAt(i);
    // A backslash escape is one unit: both bytes belong to the character, so
    // a marker can never land between `\` and `*`. (When the escaped byte
    // isn't the character we want, the backslash is literal — an autolink.)
    if (c === BACKSLASH && j + 1 < e && isAsciiPunct(md.charCodeAt(j + 1)) && md.charCodeAt(j + 1) === want) {
      starts[at + i] = j;
      ends[at + i] = j + 2;
      i++;
      j += 2;
      continue;
    }
    if (c === AMP) {
      CHAR_REF.lastIndex = j;
      const m = CHAR_REF.exec(md);
      if (m && j + m[0].length <= e) {
        const decoded =
          m[3] !== undefined
            ? decodeNamed(m[3])
            : m[1] !== undefined
              ? decodeNumeric(m[1], 10)
              : decodeNumeric(m[2]!, 16);
        if (decoded && vis.startsWith(decoded, i)) {
          for (let k = 0; k < decoded.length; k++) {
            starts[at + i + k] = j;
            ends[at + i + k] = j + m[0].length;
          }
          i += decoded.length;
          j += m[0].length;
          continue;
        }
      }
    }
    if (c === want) {
      starts[at + i] = j;
      ends[at + i] = j + 1;
      i++;
      j++;
      continue;
    }
    if (isSkippable(c)) {
      j++;
      continue;
    }
    return false;
  }
  for (; j < e; j++) if (!isSkippable(md.charCodeAt(j))) return false;
  return true;
}

function alignCode(
  md: string,
  s: number,
  e: number,
  vis: string,
  starts: Int32Array,
  ends: Int32Array,
  at: number,
): boolean {
  let cs = s;
  while (cs < e && md.charCodeAt(cs) === BACKTICK) cs++;
  const fence = cs - s;
  let ce = e - fence;
  if (fence === 0 || ce < cs) return false;
  for (let k = ce; k < e; k++) if (md.charCodeAt(k) !== BACKTICK) return false;
  // CommonMark strips one space (a line ending counts) from each side when
  // both sides have one and the content isn't all spaces.
  const isPad = (c: number): boolean => c === SPACE || c === LF || c === CR;
  if (ce - cs >= 2 && isPad(md.charCodeAt(cs)) && isPad(md.charCodeAt(ce - 1))) {
    let allPad = true;
    for (let k = cs; k < ce && allPad; k++) allPad = isPad(md.charCodeAt(k));
    if (!allPad) {
      cs++;
      ce--;
    }
  }
  let j = cs;
  let i = 0;
  while (i < vis.length) {
    if (j >= ce) return false;
    const c = md.charCodeAt(j);
    const want = vis.charCodeAt(i);
    if (c === want) {
      starts[at + i] = j;
      ends[at + i] = j + 1;
      i++;
      j++;
    } else if (want === SPACE && (c === LF || c === CR)) {
      // A line ending inside a code span renders as a space.
      const width = c === CR && md.charCodeAt(j + 1) === LF ? 2 : 1;
      starts[at + i] = j;
      ends[at + i] = j + width;
      i++;
      j += width;
    } else if (c === SPACE || c === TAB || c === GT) {
      j++; // a continuation line's prefix inside a blockquote or list item
    } else {
      return false;
    }
  }
  return j === ce;
}

/** The slice of a ProseMirror node the index reads (so tests can pass plain objects). */
export interface PmNodeLike {
  isText: boolean;
  text?: string | null;
  nodeSize: number;
  attrs: Record<string, unknown>;
  type: { name: string };
  descendants: (cb: (node: PmNodeLike, pos: number, parent: PmNodeLike | null) => boolean | void) => void;
}

interface IndexedBlock {
  start: number;
  end: number;
  /** Every run aligned and the lengths agreed — only then are spans trusted. */
  mapped: boolean;
  text: string;
  pos: Int32Array;
  /** Source span of each character; -1 when the block is unmapped. */
  srcStart: Int32Array;
  srcEnd: Int32Array;
  code: Uint8Array;
}

/** Text the index can't map: outside any annotated container (code blocks, mostly). */
interface ForeignText {
  from: number;
  to: number;
  text: string;
  code: boolean;
}

export interface SourceIndex {
  markdown: string;
  blocks: IndexedBlock[];
  foreign: ForeignText[];
}

export function buildSourceIndex(doc: PmNodeLike, markdown: string, decodeNamed: DecodeNamed): SourceIndex {
  const blocks: IndexedBlock[] = [];
  const foreign: ForeignText[] = [];
  doc.descendants((node, pos, parent) => {
    const src = node.attrs?.[SOURCE_ATTR] as BlockSource | null | undefined;
    if (src) {
      blocks.push(indexBlock(node, pos, src, markdown, decodeNamed));
      return false;
    }
    if (node.isText && node.text) {
      foreign.push({
        from: pos,
        to: pos + node.text.length,
        text: node.text,
        code: parent?.type.name === "code_block",
      });
    }
    return true;
  });
  return { markdown, blocks, foreign };
}

function indexBlock(
  node: PmNodeLike,
  nodePos: number,
  src: BlockSource,
  markdown: string,
  decodeNamed: DecodeNamed,
): IndexedBlock {
  let text = "";
  const positions: number[] = [];
  node.descendants((child, rel) => {
    if (child.isText && child.text) {
      // `rel` is relative to the container's content, which starts one past it.
      for (let k = 0; k < child.text.length; k++) positions.push(nodePos + 1 + rel + k);
      text += child.text;
    }
    return true;
  });
  const n = text.length;
  const aligned = alignContainer(markdown, src, text, decodeNamed);
  return {
    start: src.start,
    end: src.end,
    mapped: aligned !== null,
    text,
    pos: Int32Array.from(positions),
    srcStart: aligned?.starts ?? new Int32Array(n).fill(-1),
    srcEnd: aligned?.ends ?? new Int32Array(n).fill(-1),
    code: aligned?.code ?? new Uint8Array(n),
  };
}

/**
 * Each character of a text container's `text` (as the editor shows it) with
 * the source span it came from, and whether it's inline code. Null unless the
 * run lengths sum to the text and every run aligns — nothing is guessed.
 */
function alignContainer(
  markdown: string,
  src: BlockSource,
  text: string,
  decodeNamed: DecodeNamed,
): { starts: Int32Array; ends: Int32Array; code: Uint8Array } | null {
  const runs = src.runs;
  if (!runs) return null;
  let total = 0;
  for (const r of runs) total += r[2];
  if (total !== text.length) return null;
  const starts = new Int32Array(text.length).fill(-1);
  const ends = new Int32Array(text.length).fill(-1);
  const code = new Uint8Array(text.length);
  let at = 0;
  for (const r of runs) {
    if (!alignRun(markdown, r, text.slice(at, at + r[2]), decodeNamed, starts, ends, at)) return null;
    if (r[3] === 1) code.fill(1, at, at + r[2]);
    at += r[2];
  }
  return { starts, ends, code };
}

/**
 * The editor ranges whose characters came from source `[start, end)`: one per
 * block the range touches, from its first such character to its last. Empty
 * when no mapped character lies inside — never an approximation.
 */
export function sourceRangeToEditor(index: SourceIndex, start: number, end: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  if (!(end > start)) return out;
  for (const b of index.blocks) {
    if (!b.mapped || b.end <= start || b.start >= end) continue;
    let first = -1;
    let last = -1;
    for (let i = 0; i < b.text.length; i++) {
      if (b.srcStart[i]! >= start && b.srcEnd[i]! <= end) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) out.push({ from: b.pos[first]!, to: b.pos[last]! + 1 });
  }
  return out;
}

export type SelectionMapping =
  | { ok: true; start: number; end: number; text: string }
  | { ok: false; reason: "empty" | "code" | "unmapped" };

interface SelectedChar {
  pos: number;
  ch: string;
  srcStart: number;
  srcEnd: number;
  code: boolean;
}

/**
 * Map an editor selection `[from, to)` to the source range under its visible
 * characters, trimmed of whitespace at both ends. `text` is what the user
 * sees selected. Refuses rather than guesses: a selection touching code
 * (the format can't anchor there), or whose first or last character has no
 * trusted source span.
 */
export function editorSelectionToSource(index: SourceIndex, from: number, to: number): SelectionMapping {
  const chars: SelectedChar[] = [];
  for (const b of index.blocks) {
    if (b.pos.length === 0 || b.pos[b.pos.length - 1]! < from || b.pos[0]! >= to) continue;
    for (let i = 0; i < b.text.length; i++) {
      const p = b.pos[i]!;
      if (p < from || p >= to) continue;
      chars.push({ pos: p, ch: b.text[i]!, srcStart: b.srcStart[i]!, srcEnd: b.srcEnd[i]!, code: b.code[i] === 1 });
    }
  }
  for (const f of index.foreign) {
    if (f.to <= from || f.from >= to) continue;
    for (let p = Math.max(f.from, from); p < Math.min(f.to, to); p++) {
      chars.push({ pos: p, ch: f.text[p - f.from]!, srcStart: -1, srcEnd: -1, code: f.code });
    }
  }
  chars.sort((a, b) => a.pos - b.pos);
  let lo = 0;
  let hi = chars.length - 1;
  while (lo <= hi && /\s/.test(chars[lo]!.ch)) lo++;
  while (hi >= lo && /\s/.test(chars[hi]!.ch)) hi--;
  if (lo > hi) return { ok: false, reason: "empty" };
  for (let i = lo; i <= hi; i++) if (chars[i]!.code) return { ok: false, reason: "code" };
  const first = chars[lo]!;
  const last = chars[hi]!;
  if (first.srcStart < 0 || last.srcEnd < 0 || last.srcEnd <= first.srcStart) {
    return { ok: false, reason: "unmapped" };
  }
  let text = "";
  for (let i = lo; i <= hi; i++) text += chars[i]!.ch;
  return { ok: true, start: first.srcStart, end: last.srcEnd, text };
}

// Edit mode writes back one top-level block at a time. The webview names
// blocks by their index among the editor's top-level nodes; the host finds their bytes in this table. The index only
// means the same thing on both sides because the table is built with the
// parser milkdown runs and lists exactly the root children milkdown turns into
// top-level nodes — `editorTypeOf` is that correspondence.

export interface MarkdownBlock {
  start: number;
  end: number;
  /** The top-level ProseMirror node milkdown makes of it (`paragraph`, `bullet_list`, …). */
  type: string;
  /** A lone `<br />`: milkdown's empty-paragraph placeholder. */
  placeholder?: boolean;
}

// `remarkPreserveEmptyLine` deletes an html node with exactly these values,
// which leaves the paragraph `remarkHtmlTransformer` wrapped it in empty.
const EMPTY_LINE_HTML = new Set(["<br />", "<br>", "<br >", "<br/>"]);

/**
 * The top-level node milkdown builds from a root child, or null for none.
 * `remarkHtmlTransformer` wraps a root `html` node in a paragraph;
 * remark-inline-links deletes every `definition`. A type this doesn't know
 * keeps its mdast name, which no ProseMirror node has — so it can only ever
 * show up as a mismatch, never as a wrong match.
 */
function editorTypeOf(node: MdNode & { ordered?: boolean | null }): string | null {
  switch (node.type) {
    case "definition":
      return null;
    case "html":
      return "paragraph";
    case "code":
      return "code_block";
    case "thematicBreak":
      return "hr";
    case "list":
      return node.ordered ? "ordered_list" : "bullet_list";
    case "footnoteDefinition":
      return "footnote_definition";
    default:
      return node.type; // paragraph, heading, blockquote, table
  }
}

let gfmSyntax: ReturnType<typeof gfm> | null = null;
let gfmTree: ReturnType<typeof gfmFromMarkdown> | null = null;

/** Every top-level block of `markdown`, in order, with the ProseMirror type each becomes. */
export function markdownBlocks(markdown: string): MarkdownBlock[] {
  const tree = fromMarkdown(markdown, {
    extensions: [(gfmSyntax ??= gfm())],
    mdastExtensions: [(gfmTree ??= gfmFromMarkdown())],
  }) as unknown as MdNode;
  const out: MarkdownBlock[] = [];
  for (const child of tree.children ?? []) {
    const type = editorTypeOf(child);
    if (type === null) continue;
    const start = child.position?.start.offset ?? -1;
    const end = child.position?.end.offset ?? -1;
    const placeholder = child.type === "html" && EMPTY_LINE_HTML.has(String(child.value ?? "").trim());
    out.push(placeholder ? { start, end, type, placeholder } : { start, end, type });
  }
  return out;
}

/**
 * How many of `blocks` the editor counts. The serializer writes an empty
 * paragraph as `<br />` except the document's last, which it writes as
 * nothing — so the editor never counts the empty paragraphs at its end
 * (`markdownBlockNodes`), and the run of placeholders at the end here is left
 * out to match.
 */
export function editorBlockCount(blocks: readonly MarkdownBlock[]): number {
  let count = blocks.length;
  while (count > 0 && blocks[count - 1]!.placeholder) count--;
  return count;
}

export interface BlockSplice {
  from: number;
  to: number;
  start: number;
  end: number;
  length: number;
  types: readonly string[];
}

const lineStartOf = (text: string, at: number): number => text.lastIndexOf("\n", at - 1) + 1;

/**
 * The table of `next` — the prose `blocks` describes with `splices` applied,
 * in order and not overlapping — or null when a splice changed more than its
 * own blocks.
 *
 * Only the window from the block before a splice to the block after it is
 * re-parsed. Block structure is parsed a line at a time, left to right, and
 * everything before the window is unchanged, so the window's first line starts
 * a top-level block exactly as it does in the whole document. If the window
 * reproduces both neighbours unchanged and the new blocks have the expected
 * types, the rest of the document parses as it did; otherwise (the new text
 * merged into a neighbour, an unclosed fence swallowed the rest) this returns
 * null and the caller parses the whole prose.
 */
export function spliceMarkdownBlocks(
  blocks: readonly MarkdownBlock[],
  next: string,
  splices: readonly BlockSplice[],
): MarkdownBlock[] | null {
  const out: MarkdownBlock[] = [];
  let shift = 0;
  let copied = 0;
  const moved = (b: MarkdownBlock): MarkdownBlock => ({ ...b, start: b.start + shift, end: b.end + shift });
  for (const s of splices) {
    // Blocks up to (not including) the one before the splice are untouched.
    const prevIndex = s.from - 1;
    for (; copied < Math.max(0, prevIndex); copied++) out.push(moved(blocks[copied]!));
    const prev = prevIndex >= 0 ? moved(blocks[prevIndex]!) : null;
    const delta = s.length - (s.end - s.start);
    const nextBlock = s.to < blocks.length ? { ...blocks[s.to]!, start: blocks[s.to]!.start + shift + delta, end: blocks[s.to]!.end + shift + delta } : null;
    const windowStart = prev ? lineStartOf(next, prev.start) : 0;
    const windowEnd = nextBlock ? nextBlock.end : next.length;
    const parsed = markdownBlocks(next.slice(windowStart, windowEnd)).map((b) => ({
      ...b,
      start: b.start + windowStart,
      end: b.end + windowStart,
    }));
    const expected = (prev ? 1 : 0) + s.types.length + (nextBlock ? 1 : 0);
    if (parsed.length !== expected) return null;
    const same = (a: MarkdownBlock, b: MarkdownBlock): boolean =>
      a.start === b.start && a.end === b.end && a.type === b.type && !!a.placeholder === !!b.placeholder;
    if (prev && !same(parsed[0]!, prev)) return null;
    if (nextBlock && !same(parsed[parsed.length - 1]!, nextBlock)) return null;
    const middle = parsed.slice(prev ? 1 : 0, prev ? 1 + s.types.length : s.types.length);
    if (middle.some((b, i) => b.type !== s.types[i])) return null;
    if (prev) out.push(prev);
    out.push(...middle);
    copied = s.to;
    shift += delta;
  }
  for (; copied < blocks.length; copied++) out.push(moved(blocks[copied]!));
  return out;
}

// Edit mode's document can't carry source positions (a split or join copies a
// block's attrs onto both halves), and after an edit the file's bytes for that
// block are the serializer's, not what the editor first parsed. So a comment's
// selection is named by structure instead — which top-level block, which text
// container in it, which character of that container's text — and the host
// finds those characters in the file's own bytes with the same alignment the
// read-only mode uses. The container's text travels with it: if the file's
// bytes there don't explain it, the file changed, and the comment is refused.

export interface EditorPoint {
  block: number;
  /** That block's node type, checked against the file's. */
  type: string;
  /** Index among the block's text containers (paragraph, heading, table cell) that have text, in document order. */
  container: number;
  offset: number;
  text: string;
}

/** The characters a text container shows, from its mdast leaves (`stamp`'s rule, by value). */
function visibleTextOfNode(node: MdNode): string {
  let out = "";
  for (const child of node.children ?? []) {
    if (child.type === "text" || child.type === "inlineCode") {
      out += visibleTextOf(typeof child.value === "string" ? child.value : "", child.type === "text" ? 0 : 1);
    } else if (child.children) {
      out += visibleTextOfNode(child);
    }
  }
  return out;
}

function decodeNamedByParser(name: string): string | undefined {
  const reference = `&${name};`;
  const tree = fromMarkdown(reference) as unknown as MdNode;
  const value = tree.children?.[0]?.children?.[0]?.value;
  return typeof value === "string" && value !== reference ? value : undefined;
}

/**
 * The source range of `markdown` from `first`'s start to `last`'s end — the
 * first and last characters of an edit-mode selection — or null when the
 * file's bytes at either don't explain the editor's text there.
 */
export function editorRangeToSource(markdown: string, first: EditorPoint, last: EditorPoint): { start: number; end: number } | null {
  const tree = fromMarkdown(markdown, {
    extensions: [(gfmSyntax ??= gfm())],
    // The annotation runs first, before GFM splits text nodes and drops their positions.
    mdastExtensions: [{ transforms: [(t) => annotateSourceRuns(t as unknown as MdNode)] }, (gfmTree ??= gfmFromMarkdown())],
  }) as unknown as MdNode;
  const roots = (tree.children ?? []).filter((c) => editorTypeOf(c) !== null);
  const locate = (p: EditorPoint, edge: "start" | "end"): number => {
    const root = roots[p.block];
    if (!root || editorTypeOf(root) !== p.type) return -1;
    const containers: BlockSource[] = [];
    const visit = (node: MdNode): void => {
      const src = node.data?.[SOURCE_ATTR] as BlockSource | undefined;
      if (src) {
        if (visibleTextOfNode(node).length > 0) containers.push(src);
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    const src = containers[p.container];
    if (!src || !(p.offset >= 0 && p.offset < p.text.length)) return -1;
    const aligned = alignContainer(markdown, src, p.text, decodeNamedByParser);
    if (!aligned) return -1;
    return edge === "start" ? aligned.starts[p.offset]! : aligned.ends[p.offset]!;
  };
  const start = locate(first, "start");
  const end = locate(last, "end");
  return start >= 0 && end > start ? { start, end } : null;
}

export type EditorSelection =
  | { ok: true; first: EditorPoint; last: EditorPoint; text: string }
  | { ok: false; reason: "empty" | "code" | "unmapped" };

export interface PmBlockLike extends PmNodeLike {
  marks?: ReadonlyArray<{ type: { name: string } }>;
}

const PM_TEXT_CONTAINERS = new Set(["paragraph", "heading", "table_cell", "table_header"]);

/**
 * Name the selection `[from, to)` of edit mode's document by structure: its
 * first and last visible characters (trimmed of whitespace, as the read-only
 * mapping trims) as `EditorPoint`s. `blocks` are the top-level nodes the
 * host's table counts (`markdownBlockNodes`), each with its position. Refuses
 * a selection with no text, one touching code, or one whose boundary isn't in
 * a text container.
 */
export function editorSelectionPoints(
  blocks: ReadonlyArray<{ node: PmBlockLike; pos: number }>,
  from: number,
  to: number,
): EditorSelection {
  const chars: Array<{ pos: number; ch: string; code: boolean; point: EditorPoint | null }> = [];
  blocks.forEach(({ node: block, pos: blockPos }, index) => {
    if (blockPos + block.nodeSize <= from || blockPos >= to) return;
    let container = -1;
    const takeContainer = (node: PmNodeLike, nodePos: number): void => {
      let text = "";
      const positions: number[] = [];
      const code: boolean[] = [];
      node.descendants((child, rel) => {
        if (child.isText && child.text) {
          const isCode = !!(child as PmBlockLike).marks?.some((m) => m.type.name === "inlineCode");
          for (let k = 0; k < child.text.length; k++) {
            positions.push(nodePos + 1 + rel + k);
            code.push(isCode);
          }
          text += child.text;
        }
        return true;
      });
      if (text.length === 0) return;
      container++;
      for (let i = 0; i < text.length; i++) {
        if (positions[i]! < from || positions[i]! >= to) continue;
        chars.push({ pos: positions[i]!, ch: text[i]!, code: code[i]!, point: { block: index, type: block.type.name, container, offset: i, text } });
      }
    };
    if (PM_TEXT_CONTAINERS.has(block.type.name)) {
      takeContainer(block, blockPos);
      return;
    }
    block.descendants((node, rel, parent) => {
      const pos = blockPos + 1 + rel;
      if (PM_TEXT_CONTAINERS.has(node.type.name)) {
        takeContainer(node, pos);
        return false;
      }
      if (node.isText && node.text) {
        // Text outside a container: a code block's.
        for (let k = 0; k < node.text.length; k++) {
          const p = pos + k;
          if (p >= from && p < to) chars.push({ pos: p, ch: node.text[k]!, code: parent?.type.name === "code_block", point: null });
        }
      }
      return true;
    });
  });
  chars.sort((a, b) => a.pos - b.pos);
  let lo = 0;
  let hi = chars.length - 1;
  while (lo <= hi && /\s/.test(chars[lo]!.ch)) lo++;
  while (hi >= lo && /\s/.test(chars[hi]!.ch)) hi--;
  if (lo > hi) return { ok: false, reason: "empty" };
  let text = "";
  for (let i = lo; i <= hi; i++) {
    if (chars[i]!.code) return { ok: false, reason: "code" };
    text += chars[i]!.ch;
  }
  const first = chars[lo]!.point;
  const last = chars[hi]!.point;
  if (!first || !last) return { ok: false, reason: "unmapped" };
  return { ok: true, first, last, text };
}
