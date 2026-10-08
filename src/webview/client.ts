import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  prosePluginsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/core";
import { bulletListSchema, commonmark } from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask, gfm } from "@milkdown/preset-gfm";
import type { Ctx } from "@milkdown/ctx";
import type { NodeSchema } from "@milkdown/transformer";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { nord } from "@milkdown/theme-nord";
import "@milkdown/theme-nord/style.css";
import "./host.css";
import "./plugins/plugins.css";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "prosemirror-state";
import { CellSelection } from "@milkdown/prose/tables";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PmDocNode } from "prosemirror-model";
import { buildComposer, type ComposerHandle } from "../webviewShared/commentUi";
import { createThreadSidebar } from "../webviewShared/threadSidebar";
import type { DispatchOutcome, SidebarMessage, SidebarState, SidebarThread, SkillStatus } from "../webviewShared/sidebarProtocol";
import { matchesFilter, type ThreadFilter } from "../webviewShared/threadListState";
import { locateAnchorInLiveText, locateNthOccurrence } from "../collab/liveAnchorLocator";
import { renderedRangeToPmRange, renderedTextOf } from "../collab/pmPositionMapper";
import {
  buildSourceIndex,
  editorSelectionPoints,
  editorSelectionToSource,
  sourceRangeToEditor,
  type EditorPoint,
  type PmBlockLike,
  type PmNodeLike,
  type SourceIndex,
} from "../collab/sourcePositions";
import { diffBlocks, markdownBlockNodes, type BlockEditsMessage } from "../collab/blockEdits";
import { decodeNamedReference, installSourcePositions } from "./sourcePositionPlugin";
import { slugifyHeading } from "../inlineComments/linkParse";
import { resolveImageSrc, type ImageBaseUris } from "../webviewShared/imageSrc";
import { parseHtmlImage } from "../webviewShared/htmlImage";
import { classifyHtml, INLINE_PAIR_TAGS, isBlockHtml, isSelfContained, sanitizeHtml } from "../webviewShared/htmlSanitize";
import { mountShadowHtml, SHADOW_WRAPPER_CLASS, ShadowStyles, splitStyles } from "../webviewShared/shadowHtml";
import { makeHtmlTagPairPlugin } from "./plugins/htmlTagPairPlugin";
import { displayLine, topLevelBlockLines } from "../webviewShared/lineNumbers";
import { smoothScrollIntoView } from "../webviewShared/scrollIntoView";
import { buildOutline } from "../webviewShared/outline";
import { buildOutlinePanel, type OutlinePanelHandle } from "../webviewShared/outlinePanel";
import { inlineBreakPlugin } from "./plugins/inlineBreakPlugin";
import { makePlantumlPlugin, setPlantumlConfig, type PlantumlConfig } from "./plugins/plantumlWidgetPlugin";
import { makeTaskListPlugin } from "./plugins/taskListPlugin";
import { makeSuggestionHighlightPlugin, SUGGESTION_HIGHLIGHT_KEY } from "./plugins/suggestionHighlightPlugin";
import { makeDiffStripesPlugin, DIFF_STRIPES_KEY, type DiffState } from "./plugins/diffStripesPlugin";
import { buildChangeNav, type ChangeNavHandle } from "./plugins/changeNav";

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
};

interface CommentSummary {
  id: string;
  rootCommentId: string;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  anchor: { text: string; contextBefore: string; contextAfter: string };
  /** Which occurrence of `anchor.text` the marker wraps (0-based; -1 if unanchored). */
  anchorOrdinal: number;
  /** The anchored span in the prose this editor parsed; -1 when unanchored. Read-only mode places by these. */
  proseStart?: number;
  proseEnd?: number;
  /** The anchored text changed after this thread's last comment. */
  stale?: boolean;
  replies: Array<{ id: string; author: string; body: string; createdAt: string }>;
}

interface SuggestionSummary {
  anchorId: string;
  threadId?: string;
  author: string;
  ts: string;
  original: string;
  proposed: string;
  note?: string;
  anchor: { text: string; contextBefore: string; contextAfter: string };
  /** Which occurrence of `anchor.text` the marker wraps (0-based; -1 if unanchored). */
  anchorOrdinal: number;
  /** The anchored span in prose offsets; -1 when unanchored. Read-only mode places by these. */
  proseStart?: number;
  proseEnd?: number;
}

/** The sidebar's fields on `init` and `sidecar-changed`; see collab/sidebarHost.ts. */
interface SidebarPush {
  /** Every thread with its full comment list; absent, the cards are built from `comments`. */
  threads?: SidebarThread[];
  suggestMode?: boolean;
  agentName?: string;
}

interface InitMessage extends SidebarPush {
  type: "init";
  text: string;
  user: { name: string; color: string };
  comments: CommentSummary[];
  suggestions?: SuggestionSummary[];
  pendingThreadIds?: string[];
  pendingLabel?: string;
  frontmatter?: string;
  imageBaseUris?: ImageBaseUris;
  plantuml?: PlantumlConfig;
  /** Source line per prose line; present only when line numbers are on. */
  lineMap?: number[];
  /** Read-only mode: no editing; comments anchor by source position. */
  readOnly?: boolean;
  /**
   * The host's `DiffState` (src/inlineComments/inlineCommentsPanel.ts), copied
   * because the webview bundle can't import a vscode-touching module.
   * Absent/null = plain live editor.
   */
  diff?: DiffState | null;
  /** The host's document epoch; edit mode's reports carry it. */
  epoch?: number;
}

interface LineMapMessage {
  type: "line-map";
  lineMap?: number[];
}

interface ChangeSummary {
  start: number;
  end: number;
  text: string;
  heading: string | null;
}

interface ExternalChangeMessage {
  type: "externalChange";
  text: string;
  /** Where the disk-side (Claude) edit landed, for the presence affordances. */
  changed?: ChangeSummary | null;
  /** The host's document epoch after this re-render; edit mode's next report carries it. */
  epoch?: number;
  /** Set when the host re-rendered because it couldn't take an edit: says why, instead of the external-edit notice. */
  toast?: string;
  /** The person's own edit, written after the editor was rebuilt without it: nothing to announce. */
  quiet?: boolean;
  /**
   * The person's own undo or redo: put the caret at the change and scroll it
   * into view, instead of restoring the previous scroll position.
   */
  reveal?: boolean;
}

interface FrontmatterMessage {
  type: "frontmatter";
  frontmatter: string;
}

interface SidecarChangedMessage extends SidebarPush {
  type: "sidecar-changed";
  comments: CommentSummary[];
  suggestions?: SuggestionSummary[];
  pendingThreadIds?: string[];
  /** Host-decided wording for the waiting row. */
  pendingLabel?: string;
  /** Same contract as `InitMessage.diff`. */
  diff?: DiffState | null;
}

interface AddCommentResultMessage {
  type: "add-comment-result";
  ok: boolean;
  error?: string;
}

interface ReplyCommentResultMessage {
  type: "reply-comment-result";
  ok: boolean;
  commentId: string;
  error?: string;
}

interface ToggleResolveResultMessage {
  type: "toggle-resolve-result";
  ok: boolean;
  commentId: string;
  resolved?: boolean;
  error?: string;
}

interface DeleteCommentResultMessage {
  type: "delete-comment-result";
  ok: boolean;
  commentId: string;
  error?: string;
}

interface OpenLinkResultMessage {
  type: "open-link-result";
  ok: boolean;
  href: string;
  reason?: string;
}

interface DrawioReadResultMessage {
  type: "drawio-read-result";
  requestId: string;
  href: string;
  ok: boolean;
  content?: string;
  error?: string;
}

interface SkillStatusMessage {
  type: "skill-status";
  status: SkillStatus;
}

/** An agent was just asked to review: the thread ids that existed then. */
interface ReviewPendingMessage {
  type: "review-pending";
  existingIds: string[];
}

/** Land on a thread: a hover link, a tree row or the unread walk opened this view on it. */
interface RevealThreadMessage {
  type: "reveal-thread";
  threadId: string;
}

/**
 * How a send from the sidebar went: `outcome` says whether it was handed to
 * the agent, only copied, or went nowhere; `saved` when the file on disk had
 * the editor's text first. The host doesn't send when the save fails — the
 * agent would read the old version.
 */
interface SendResultMessage {
  type: "send-result";
  outcome: DispatchOutcome;
  saved: boolean;
}

type IncomingMessage =
  | InitMessage
  | ExternalChangeMessage
  | FrontmatterMessage
  | SidecarChangedMessage
  | AddCommentResultMessage
  | ReplyCommentResultMessage
  | ToggleResolveResultMessage
  | DeleteCommentResultMessage
  | OpenLinkResultMessage
  | LineMapMessage
  | DrawioReadResultMessage
  | SkillStatusMessage
  | ReviewPendingMessage
  | SendResultMessage
  | RevealThreadMessage;

const vscode = acquireVsCodeApi();

let editor: Editor | null = null;
// `init` messages run one at a time: a second one (a mode switch) waits for
// the first editor to finish building before replacing it.
let initQueue: Promise<void> = Promise.resolve();
let userName: string = "user";
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
// Debounces the human's edits before posting them to the host. Module-scoped so
// an incoming external (Claude) change can cancel a still-pending stale post —
// otherwise that post would fire after the external change and overwrite it.
let editDebounce: ReturnType<typeof setTimeout> | null = null;
// Edit mode: the document as last parsed from the host or last posted to it,
// and the host epoch it belongs to. An edit is reported as the top-level blocks
// the current document doesn't share with this one; the host drops a report
// from an epoch it has left.
let editBaseDoc: PmDocNode | null = null;
let editEpoch = 0;
/** The open add-comment composer, so a failed add can re-enable it. */
let addComposer: ComposerHandle | null = null;

const sidebarState: {
  comments: CommentSummary[];
  suggestions: SuggestionSummary[];
  collapsed: boolean;
  notice: string | null;
} = {
  comments: [],
  suggestions: [],
  collapsed: false,
  notice: null,
};

// The thread sidebar renders the latest push (`sidebarPush`) with this editor's
// own mode; it is shared with the review view's threads pane
// (webviewShared/threadSidebar.ts), and everything it asks of the document
// comes back through these callbacks.
const sidebarPush: Omit<SidebarState, "readOnly"> = {
  threads: [],
  suggestions: [],
  suggestMode: false,
  pendingThreadIds: [],
};

/**
 * The one path every sidebar-protocol message goes out through, whether it
 * comes from the sidebar itself or from the document toolbar's mode switch.
 */
function postSidebarMessage(msg: SidebarMessage): void {
  // Edits still in the debounce go first, whatever the message: the host
  // writes a reply or an accepted suggestion over the file as it has it,
  // the mode switch re-reads the file, and the agent reads it from disk.
  flushBlockEdits();
  vscode.postMessage(msg);
}

const threadSidebar = createThreadSidebar({
  post: postSidebarMessage,
  getState: () => vscode.getState(),
  setState: (state) => {
    const before = threadFilter();
    vscode.setState(state);
    // Highlights follow the list's filter, as in the review view.
    if (threadFilter() !== before) forceHighlightRefresh();
  },
  revealInDocument: (threadId) => {
    const comment = sidebarState.comments.find((c) => c.id === threadId);
    if (comment) jumpToAnchor(comment);
  },
  revealSuggestionInDocument: (anchorId) => {
    const mark = editorContainer?.querySelector<HTMLElement>(
      `.mdc-anchor-highlight--suggestion[data-suggestion-id="${cssEscape(anchorId)}"]`,
    );
    if (mark) smoothScrollIntoView(mark, "center");
  },
});

let sidebarEl: HTMLElement | null = null;
let composerEl: HTMLElement | null = null;
let editorContainer: HTMLElement | null = null;
let frontmatterEl: HTMLElement | null = null;
let layoutEl: HTMLElement | null = null;
// The padded, `overflow: auto` wrapper inside `.mdc-editor-pane`; the pane is a
// plain flex column so the document toolbar above can span its full width and
// never scroll.
let editorScrollEl: HTMLElement | null = null;
let commentsToggleBtn: HTMLButtonElement | null = null;
let modeToggleGroupEl: HTMLElement | null = null;
let modeToggleRadios: NodeListOf<HTMLInputElement> | null = null;

let cachedMarkdown = "";

// Read-only mode: set once from `init`. The editor
// never changes its document except by re-parsing a string from the host, so
// `sourceMarkdown` is always exactly the string the document was parsed from
// — the string every source position in it indexes. (`cachedMarkdown` is the
// editor's own serialization in edit mode, which is not that string.)
let readOnly = false;
let sourceMarkdown = "";
let sourceIndexCache: { doc: unknown; index: SourceIndex } | null = null;

function sourceIndexFor(doc: unknown): SourceIndex {
  if (!sourceIndexCache || sourceIndexCache.doc !== doc || sourceIndexCache.index.markdown !== sourceMarkdown) {
    sourceIndexCache = {
      doc,
      index: buildSourceIndex(doc as PmNodeLike, sourceMarkdown, decodeNamedReference),
    };
  }
  return sourceIndexCache.index;
}

// The composer reads `live → pendingSelection → lastNonEmptySelection`, in that
// order. `pendingSelection` is snapshotted on the button's `mousedown` in case
// `preventDefault` fails (some Milkdown plugin paths). `lastNonEmptySelection`
// is kept in sync with the PM state because the floating button (position:
// fixed, outside the editor's DOM subtree) can blur the editor *before* its own
// mousedown fires, leaving `pendingSelection` empty; it is the final fallback.
let pendingSelection: { from: number; to: number } | null = null;
let lastNonEmptySelection: { from: number; to: number } | null = null;

function captureCurrentSelection(): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const sel = view.state.selection;
    if (!sel.empty) pendingSelection = { from: sel.from, to: sel.to };
  });
}

function updateLastNonEmptySelection(): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const sel = view.state.selection;
    if (!sel.empty) lastNonEmptySelection = { from: sel.from, to: sel.to };
  });
}

const HIGHLIGHT_PLUGIN_KEY = new PluginKey("mdc-anchor-highlight");
const CLAUDE_EDIT_KEY = new PluginKey("mdc-claude-edit");

// Decorates the span an outside writer just edited (from an externalChange) so
// the change is visible, not silent. The decoration fades itself via
// `flashOutsideEdit`.
function makeClaudeEditPlugin(): Plugin {
  return new Plugin({
    key: CLAUDE_EDIT_KEY,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => {
        const meta = tr.getMeta(CLAUDE_EDIT_KEY);
        if (meta === "clear") return DecorationSet.empty;
        if (meta && typeof meta === "object" && "from" in meta) {
          const { from, to } = meta as { from: number; to: number };
          return DecorationSet.create(tr.doc, [Decoration.inline(from, to, { class: "mdc-claude-edit" })]);
        }
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return CLAUDE_EDIT_KEY.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

let claudeEditTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Highlight the just-edited text `changedText` and fade it after a few
 * seconds. Returns true when the text was found and decorated. Best-effort: a
 * change whose text carries markdown syntax isn't a substring of the rendered
 * content, so it isn't flashed — the notice still fires.
 */
function flashOutsideEdit(changedText: string): boolean {
  const needle = changedText.trim();
  if (!editor || needle.length === 0) return false;
  let placed = false;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const hay = renderedTextOf(view.state.doc);
    const at = hay.indexOf(needle);
    if (at === -1) return;
    const pm = renderedRangeToPmRange(view.state.doc, at, at + needle.length);
    if (!pm) return;
    view.dispatch(view.state.tr.setMeta(CLAUDE_EDIT_KEY, { from: pm.from, to: pm.to }));
    placed = true;
  });
  if (!placed) return false;
  if (claudeEditTimer) clearTimeout(claudeEditTimer);
  claudeEditTimer = setTimeout(() => {
    editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(CLAUDE_EDIT_KEY, "clear"));
    });
  }, 4500);
  return true;
}

let imageBaseUris: ImageBaseUris = { docDir: "", workspaceFolder: null };

let lineMap: number[] | null = null;

let currentDiff: DiffState | null = null;
let changeNav: ChangeNavHandle | null = null;

let outlinePaneEl: HTMLElement | null = null;
let outlineVisible = false;
const collapsedOutline = new Set<string>();

const outlinePanel: OutlinePanelHandle = buildOutlinePanel({
  collapsed: collapsedOutline,
  onNavigate: (node) => scrollEditorToHeadingIndex(node.index),
});

/**
 * Positional, not by name: `scrollEditorToFragment` matches a slug against the
 * rendered heading text, which cannot distinguish two sections with the same
 * name — the outline disambiguates the second to `what-changed-1`, no rendered
 * heading spells that, and the entry did nothing when clicked.
 */
function scrollEditorToHeadingIndex(index: number): void {
  editor?.action((ctx) => {
    const root = ctx.get(editorViewCtx).dom as HTMLElement;
    const target = root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")[index];
    if (target) smoothScrollIntoView(target, "start");
  });
}

function refreshOutline(): void {
  outlinePanel.update(buildOutline(cachedMarkdown));
}

function setOutlineVisible(visible: boolean): void {
  outlineVisible = visible;
  if (outlinePaneEl) outlinePaneEl.hidden = !visible;
  // The grid template needs the extra column, or every pane shifts one slot.
  layoutEl?.classList.toggle("mdc-layout--outline", visible);
  if (visible) refreshOutline();
}

async function init(msg: InitMessage): Promise<void> {
  userName = msg.user.name || "user";
  if (msg.imageBaseUris) imageBaseUris = msg.imageBaseUris;
  setPlantumlConfig(msg.plantuml);
  lineMap = Array.isArray(msg.lineMap) ? msg.lineMap : null;

  buildLayout();
  // After buildLayout: the class goes on the editor root, which does not exist
  // until the layout is built.
  applyLineNumberLayout();
  sidebarState.comments = msg.comments ?? [];
  sidebarState.suggestions = msg.suggestions ?? [];
  takeSidebarPush(msg);
  cachedMarkdown = msg.text;
  readOnly = msg.readOnly === true;
  sourceMarkdown = msg.text;
  currentDiff = msg.diff ?? null;
  renderFrontmatter(msg.frontmatter ?? "");
  renderSidebar();

  editor = await createEditor(msg.text);
  resetEditBase(msg.epoch);

  forceHighlightRefresh();
  forceSuggestionHighlightRefresh();
  forceDiffRefresh();
  reportReady(true);

  installAddCommentAffordance();
}

/**
 * Read-only installs the source-position schema and never edits; edit mode
 * reports each edit as the blocks it changed (`flushBlockEdits`).
 */
async function createEditor(text: string): Promise<Editor> {
  // Test seam: a spec stretches the build across a turn of the event loop.
  await (testHooks?.beforeEditorBuild as (() => Promise<void>) | undefined)?.();
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorContainer!);
      ctx.set(defaultValueCtx, text);
      if (readOnly) {
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
        installSourcePositions(ctx);
      }
      installTightLists(ctx);
      ctx.update(prosePluginsCtx, (prev) =>
        prev.concat([
          makeFlattenCellSelectionPlugin(),
          makeMermaidPlugin(),
          makePlantumlPlugin(),
          makeDrawioPlugin(),
          makeImageResolvePlugin(),
          makeHtmlTagPairPlugin(),
          makeAnchorHighlightPlugin(),
          makeSuggestionHighlightPlugin(
            () => sidebarState.suggestions,
            // Read-only: by source position, like threads; edit mode keeps the text search.
            readOnly ? (doc, s) => sourceRangesFor(doc, s.proseStart, s.proseEnd, s.anchor.text) : undefined,
          ),
          makeTaskListPlugin(),
          makeLineNumberPlugin(),
          makeClaudeEditPlugin(),
          makeDiffStripesPlugin(() => currentDiff, () => sourceMarkdown),
          // Editing only: Reading's view is never editable, so there's no
          // local undo and no caret for the workbench to hand back.
          ...(readOnly ? [] : [makeUndoRedoKeyPlugin(), makeEditorFocusPlugin()]),
        ]),
      );
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
        // The outline is derived from the markdown, so it follows every edit —
        // including Claude's, which arrive as external changes.
        if (markdown !== prevMarkdown) queueMicrotask(refreshOutline);
        // Read-only: the document only ever changes by re-parsing the host's
        // text, so there is never an edit to report.
        if (readOnly) return;
        cachedMarkdown = markdown;
        // Which blocks changed is read off the base when the debounce fires; an
        // external change resets the base, so it never reports itself.
        scheduleBlockEdits();
        // Don't rebuild highlights here: the plugin's apply() already maps the
        // existing decorations through this edit (so a highlight tracks text
        // changed inside it). Rebuilding from the not-yet-re-anchored
        // sidebarState.comments would drop a just-edited highlight (its stored
        // quote no longer matches). The authoritative rebuild arrives when the
        // host re-anchors and pushes fresh comments (sidecar-changed).
      });
    })
    .config(nord)
    .use(inlineBreakPlugin)
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .create();
}

const UNDO_REDO_KEY = new PluginKey("mdc-undo-redo");

/**
 * The file's undo history is the only one: there is no local ProseMirror
 * history. Mod-z / Mod-Shift-z / Mod-y flush any edit still in the debounce —
 * so a keystroke reaches the file before the undo does, over the same message
 * channel — then ask the host to undo or redo the document. They never touch
 * the document themselves; the file's answer comes back as an `externalChange`
 * with `reveal`.
 *
 * The same plugin cancels the browser's own historyUndo/historyRedo
 * `beforeinput`, so contenteditable's built-in undo can never rewrite
 * ProseMirror's DOM out from under its model. It posts nothing for those.
 */
function makeUndoRedoKeyPlugin(): Plugin {
  const ask = (type: "undo" | "redo"): boolean => {
    flushBlockEdits();
    vscode.postMessage({ type });
    return true;
  };
  return new Plugin({
    key: UNDO_REDO_KEY,
    props: {
      handleKeyDown(_view, event) {
        // Not with Alt: on some layouts AltGr (Ctrl+Alt) + a letter types a character.
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
        const key = event.key.toLowerCase();
        if (key === "z") return ask(event.shiftKey ? "redo" : "undo");
        if (key === "y") return ask("redo");
        return false;
      },
      handleDOMEvents: {
        beforeinput(_view, event) {
          const inputType = (event as InputEvent).inputType;
          if (inputType !== "historyUndo" && inputType !== "historyRedo") return false;
          event.preventDefault();
          return true;
        },
      },
    },
  });
}

const EDITOR_FOCUS_KEY = new PluginKey("mdc-editor-focus");

// Coalesced across both the DOM focus/blur plugin below and the explicit
// `reportEditorFocus(false)` a switch to Reading sends (reinitEditor) — only
// a real change in state is worth a message.
let lastReportedFocus: boolean | null = null;

function reportEditorFocus(focused: boolean): void {
  if (lastReportedFocus === focused) return;
  lastReportedFocus = focused;
  vscode.postMessage({ type: "editor-focus", focused });
}

/**
 * Tells the host where the caret is: `{ type: "editor-focus", focused }` on
 * every gain/loss of DOM focus. Drives `markdownCollab.liveEditorTyping`
 * (package.json's keybinding table), which keeps the workbench's own binding
 * for a key the editor handles from also firing.
 */
function makeEditorFocusPlugin(): Plugin {
  return new Plugin({
    key: EDITOR_FOCUS_KEY,
    props: {
      handleDOMEvents: {
        focus: () => {
          reportEditorFocus(true);
          return false;
        },
        blur: () => {
          reportEditorFocus(false);
          return false;
        },
      },
    },
  });
}

/**
 * Serialize a list as tight or loose as it was parsed. Milkdown keeps a
 * list's and an item's `spread` as the string "true" / "false", and the
 * bullet list and list item hand that string on to remark, which only reads a
 * boolean — so every edit to a tight bullet list wrote it back loose, a blank
 * line between every item (the ordered list converts; these two don't). The
 * list item is GFM's, which converts for task items only.
 */
function installTightLists(ctx: Ctx): void {
  const booleanSpread = (node: PmDocNode): PmDocNode =>
    typeof node.attrs.spread === "boolean"
      ? node
      : node.type.create({ ...node.attrs, spread: node.attrs.spread === "true" }, node.content, node.marks);
  const wrap = (schema: NodeSchema, applies: (node: PmDocNode) => boolean): NodeSchema => {
    const runner = schema.toMarkdown.runner;
    return {
      ...schema,
      toMarkdown: {
        ...schema.toMarkdown,
        runner: (state, node) => runner(state, applies(node) ? booleanSpread(node) : node),
      },
    };
  };
  ctx.update(bulletListSchema.key, (prev) => (c) => wrap(prev(c), () => true));
  ctx.update(extendListItemSchemaForTask.key, (prev) => (c) => wrap(prev(c), (node) => node.attrs.checked == null));
}

/**
 * A second `init`: the host switched this panel's mode (`set-read-only`) and
 * re-sent the file. Only the editor is rebuilt — read-only with the
 * source-position schema, edit mode without it — on the file's current text;
 * the layout and the sidebar stay.
 */
async function reinitEditor(msg: InitMessage): Promise<void> {
  // Keystrokes still in the debounce go to the host before the editor that
  // holds them is destroyed; it writes them and sends them back.
  flushBlockEdits();
  const previous = editor;
  editor = null;
  editBaseDoc = null;
  // Milkdown's listener debounces `markdownUpdated` by 200 ms and does not
  // cancel it on destroy. Fired on a destroyed editor, its serializer reads a
  // context that is gone and throws from a timer nothing can catch — which
  // the window error handler then reports to the user as a failure. The edit
  // it would report was flushed just above, so unsubscribe before teardown:
  // the pending handler finds no listener and serializes nothing.
  previous?.action((ctx) => {
    ctx.get(listenerCtx).listeners.markdownUpdated.length = 0;
  });
  await previous?.destroy();
  if (editorContainer) editorContainer.innerHTML = "";
  readOnly = msg.readOnly === true;
  // The view that held the caret is gone, and destroying its container may
  // not fire a DOM blur. Say so in either mode: a rebuilt Editing view reports
  // focus again when the caret actually returns to it, and until then the
  // workbench keeps its own bindings.
  reportEditorFocus(false);
  cachedMarkdown = msg.text;
  sourceMarkdown = msg.text;
  sourceIndexCache = null;
  pendingSelection = null;
  lastNonEmptySelection = null;
  lastHighlightSig = " ";
  lineMap = Array.isArray(msg.lineMap) ? msg.lineMap : null;
  currentDiff = msg.diff ?? null;
  sidebarState.comments = msg.comments ?? [];
  sidebarState.suggestions = msg.suggestions ?? [];
  takeSidebarPush(msg);
  renderFrontmatter(msg.frontmatter ?? "");
  renderSidebar();
  editor = await createEditor(msg.text);
  applyLineNumberLayout();
  resetEditBase(msg.epoch);
  forceHighlightRefresh();
  forceSuggestionHighlightRefresh();
  forceDiffRefresh();
  refreshOutline();
  reportReady(true);
}

function topLevelBlocks(doc: PmDocNode): Array<{ node: PmDocNode; pos: number }> {
  const out: Array<{ node: PmDocNode; pos: number }> = [];
  let pos = 0;
  for (const node of markdownBlockNodes(doc)) {
    out.push({ node, pos });
    pos += node.nodeSize;
  }
  return out;
}

/** The document the host just sent is the base the next edit is diffed against. */
function resetEditBase(epoch: number | undefined): void {
  if (typeof epoch === "number") editEpoch = epoch;
  editor?.action((ctx) => {
    editBaseDoc = ctx.get(editorViewCtx).state.doc;
  });
}

function scheduleBlockEdits(): void {
  if (editDebounce) clearTimeout(editDebounce);
  editDebounce = setTimeout(flushBlockEdits, 250);
}

/**
 * Post the top-level blocks the document changed since `editBaseDoc` and make
 * the current document the base. Posts nothing when no block's Markdown
 * changed — a heading id or list label a plugin rewrote, a character typed and
 * deleted again.
 */
function flushBlockEdits(): void {
  if (editDebounce) {
    clearTimeout(editDebounce);
    editDebounce = null;
  }
  const base = editBaseDoc;
  if (!editor || readOnly || !base) return;
  let message: BlockEditsMessage | null = null;
  try {
    editor.action((ctx) => {
      const doc = ctx.get(editorViewCtx).state.doc;
      message = blockEditsBetween(base, doc, ctx.get(serializerCtx));
      editBaseDoc = doc;
    });
  } catch (err) {
    // The edit can't be reported, so the document no longer matches the
    // file: stop diffing against it and let the host re-render from the file
    // (a new base arrives with it) and say so.
    editBaseDoc = null;
    postError("edit-blocks", err);
    return;
  }
  if (message) vscode.postMessage(message);
}

function blockEditsBetween(
  base: PmDocNode,
  doc: PmDocNode,
  serializer: (content: PmDocNode) => string,
): BlockEditsMessage | null {
  // Blocks are serialized together so the serializer sees their neighbours
  // (two adjacent lists get different markers), and without the final newline:
  // a block's source range ends at its last character.
  const serialize = (nodes: readonly PmDocNode[]): string =>
    serializer(doc.type.create(null, nodes as PmDocNode[])).replace(/\n+$/, "");
  const same = (a: PmDocNode, b: PmDocNode): boolean => a.eq(b) || serialize([a]) === serialize([b]);
  const baseBlocks = markdownBlockNodes(base);
  const changes = diffBlocks(baseBlocks, markdownBlockNodes(doc), same);
  if (changes.length === 0) return null;
  return {
    type: "edit-blocks",
    epoch: editEpoch,
    baseTypes: baseBlocks.map((n) => n.type.name),
    edits: changes.map((c) => ({
      from: c.from,
      to: c.to,
      markdown: c.nodes.length > 0 ? serialize(c.nodes) : "",
      types: c.nodes.map((n) => n.type.name),
    })),
  };
}

function buildLayout(): void {
  document.body.innerHTML = "";
  layoutEl = document.createElement("div");
  layoutEl.className = "mdc-layout";
  document.body.appendChild(layoutEl);

  outlinePaneEl = document.createElement("div");
  outlinePaneEl.className = "mdc-outline-pane";
  outlinePaneEl.hidden = !outlineVisible;
  outlinePaneEl.appendChild(outlinePanel.el);
  layoutEl.appendChild(outlinePaneEl);
  layoutEl.classList.toggle("mdc-layout--outline", outlineVisible);

  const editorPane = document.createElement("div");
  editorPane.className = "mdc-editor-pane";
  layoutEl.appendChild(editorPane);

  // Document toolbar: outline, the Reading/Editing switch, the comments
  // toggle. A fixed-height sibling of the scrolling content below (not a
  // child of it), so it spans the pane's full width and never scrolls with
  // the document.
  editorPane.appendChild(buildDocToolbar());

  const editorScroll = document.createElement("div");
  editorScroll.className = "mdc-editor-scroll";
  editorPane.appendChild(editorScroll);
  editorScrollEl = editorScroll;

  // Uncommitted-diff toolbar: badge + prev/next arrows, sticky above everything
  // else in the scrolling content. Hidden by `buildChangeNav` until a diff
  // actually shows something.
  changeNav = buildChangeNav();
  editorScroll.appendChild(changeNav.el);

  // Frontmatter panel sits above the Milkdown body. The body editor mounts
  // into its own element so ProseMirror never touches the frontmatter DOM.
  frontmatterEl = document.createElement("div");
  frontmatterEl.className = "mdc-frontmatter";
  frontmatterEl.hidden = true;
  editorScroll.appendChild(frontmatterEl);

  editorContainer = document.createElement("div");
  editorContainer.className = "mdc-editor-root";
  editorScroll.appendChild(editorContainer);

  sidebarEl = document.createElement("aside");
  sidebarEl.className = "mdc-sidebar";
  sidebarEl.id = "mdc-sidebar";
  sidebarEl.setAttribute("aria-label", "Review comments");
  layoutEl.appendChild(sidebarEl);

  syncCollapsedClass();
}

function buildDocToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "mdc-doc-toolbar";
  bar.appendChild(buildOutlineToggle());

  const right = document.createElement("div");
  right.className = "mdc-doc-toolbar__right";
  right.appendChild(buildModeToggle());
  right.appendChild(buildCommentsToggle());
  bar.appendChild(right);
  return bar;
}

function buildModeToggle(): HTMLElement {
  const group = document.createElement("div");
  group.id = "edit-mode-toggle";
  group.className = "mc-segmented";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Editing mode");
  group.dataset.mode = "read";
  group.title = "Reading is read-only — only comments change the file. Editing lets you edit the text in place.";
  group.innerHTML =
    '<label class="segment"><input type="radio" name="edit-mode" value="read" checked><span>Reading</span></label>' +
    '<label class="segment"><input type="radio" name="edit-mode" value="edit"><span>Editing</span></label>';
  modeToggleGroupEl = group;
  modeToggleRadios = group.querySelectorAll<HTMLInputElement>('input[name="edit-mode"]');
  // The mode is the host's to change (it rebuilds the editor); `updateDocToolbarMode`
  // repaints this from `readOnly` on every render.
  modeToggleRadios.forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked) postSidebarMessage({ type: "set-read-only", readOnly: r.value === "read" });
    }),
  );
  return group;
}

function updateDocToolbarMode(readOnlyNow: boolean): void {
  if (!modeToggleGroupEl || !modeToggleRadios) return;
  modeToggleGroupEl.dataset.mode = readOnlyNow ? "read" : "edit";
  for (const r of modeToggleRadios) {
    r.checked = r.value === (readOnlyNow ? "read" : "edit");
    r.closest("label")?.classList.toggle("active", r.checked);
  }
}

/** Reachable with the sidebar collapsed. */
function buildCommentsToggle(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mc-icon-btn";
  btn.id = "mdc-comments-toggle";
  btn.setAttribute("aria-controls", "mdc-sidebar");
  // `.mc-badge` is comments.css's card-tag pill; the `--count` modifier
  // (controls.css) shrinks it to a number beside the glyph without restyling
  // those tags, since this page loads both files.
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v6A1.5 1.5 0 0 1 12.5 10H8l-3.2 2.8a.5.5 0 0 1-.8-.38V10h-.5A1.5 1.5 0 0 1 2 8.5v-6z"/></svg>' +
    '<span class="mc-badge mc-badge--count" hidden></span>';
  btn.addEventListener("click", () => {
    sidebarState.collapsed = !sidebarState.collapsed;
    syncCollapsedClass();
  });
  commentsToggleBtn = btn;
  return btn;
}

function syncCollapsedClass(): void {
  if (!layoutEl) return;
  const collapsed = sidebarState.collapsed;
  layoutEl.classList.toggle("mdc-layout--collapsed", collapsed);
  if (commentsToggleBtn) {
    const label = collapsed ? "Show comments" : "Hide comments";
    commentsToggleBtn.title = label;
    commentsToggleBtn.setAttribute("aria-label", label);
    commentsToggleBtn.setAttribute("aria-pressed", String(!collapsed));
    // The open count is never lost when the sidebar (and its own counts) are hidden.
    const openCount = sidebarPush.threads.filter((t) => t.status === "open").length;
    const badge = commentsToggleBtn.querySelector<HTMLElement>(".mc-badge");
    if (badge) {
      const show = collapsed && openCount > 0;
      badge.hidden = !show;
      badge.textContent = show ? String(openCount) : "";
    }
  }
}

function renderSidebar(): void {
  if (!sidebarEl) return;
  syncCollapsedClass();
  if (threadSidebar.el.parentElement !== sidebarEl) mountSidebar(sidebarEl);
  updateDocToolbarMode(readOnly);
  threadSidebar.render({ ...sidebarPush, readOnly });
}

function mountSidebar(host: HTMLElement): void {
  const banner = document.createElement("div");
  banner.className = "mdc-banner-slot";
  const composerSlot = document.createElement("div");
  composerSlot.className = "mdc-composer-slot";
  threadSidebar.headerEl.after(composerSlot);
  // The sidebar's own "…" menu already lives in `.mc-title-actions` (its
  // SHELL); prepend so the order reads "+ Add comment" then "…".
  threadSidebar.titleActionsEl.prepend(buildAddCommentButton());
  host.replaceChildren(banner, threadSidebar.el);
  composerEl = composerSlot;
}

function buildOutlineToggle(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mc-icon-btn";
  btn.dataset.action = "toggle-outline";
  btn.title = "Show or hide the document outline";
  btn.setAttribute("aria-label", "Outline");
  btn.textContent = "☰";
  const sync = (): void => {
    btn.classList.toggle("active", outlineVisible);
    btn.setAttribute("aria-pressed", String(outlineVisible));
  };
  sync();
  btn.addEventListener("click", () => {
    setOutlineVisible(!outlineVisible);
    sync();
  });
  return btn;
}

function buildAddCommentButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mc-icon-btn";
  btn.dataset.action = "add-comment";
  btn.title = "Add a comment on the current selection (Cmd/Ctrl+Shift+M)";
  btn.setAttribute("aria-label", "Add comment");
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 1.5v5h5v1H8v5H7v-5H2v-1h5v-5h1z"/></svg>';
  // preventDefault on mousedown keeps the click from blurring the editor, which
  // would clear the ProseMirror selection before the click handler runs; the
  // snapshot covers the plugin paths that slip past it.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    captureCurrentSelection();
  });
  btn.addEventListener("click", () => openComposerForCurrentSelection());
  return btn;
}

function takeSidebarPush(
  msg: SidebarPush & {
    comments?: CommentSummary[];
    suggestions?: SuggestionSummary[];
    pendingThreadIds?: string[];
    pendingLabel?: string;
  },
): void {
  sidebarPush.threads = msg.threads ?? threadsFromSummaries(msg.comments ?? []);
  sidebarPush.suggestions = (msg.suggestions ?? []).map((s) => ({
    anchorId: s.anchorId,
    author: s.author,
    ts: s.ts,
    original: s.original,
    proposed: s.proposed,
    note: s.note,
    anchored: s.anchorOrdinal >= 0,
  }));
  sidebarPush.suggestMode = msg.suggestMode ?? false;
  sidebarPush.agentName = msg.agentName;
  sidebarPush.pendingThreadIds = msg.pendingThreadIds ?? [];
  sidebarPush.pendingLabel = msg.pendingLabel;
}

/**
 * Cards for a push that carries only the flat comment list: every comment, in
 * order, without the agent/via/edited details only `threads` has.
 */
function threadsFromSummaries(comments: CommentSummary[]): SidebarThread[] {
  return comments.map((c) => ({
    id: c.id,
    quote: c.anchor.text,
    status: c.resolved ? "resolved" : "open",
    comments: [
      { id: c.rootCommentId, author: c.author, ts: c.createdAt, body: c.body },
      ...c.replies.map((r) => ({ id: r.id, author: r.author, ts: r.createdAt, body: r.body })),
    ],
    anchor: c.anchorOrdinal >= 0 ? { proseStart: c.proseStart ?? 0, proseEnd: c.proseEnd ?? 0 } : null,
    stale: c.stale,
  }));
}

// Update only the transient notice banner — used by showNotice so a "Updated
// from disk" flash doesn't rebuild the whole comment list (which would drop
// focus from an in-progress reply).
function renderNotice(): void {
  if (!sidebarEl) return;
  const slot = sidebarEl.querySelector<HTMLElement>(".mdc-banner-slot");
  if (!slot) {
    renderSidebar();
    return;
  }
  if (!sidebarState.notice) {
    slot.innerHTML = "";
    return;
  }
  if (noticeJump) {
    slot.innerHTML = `<button type="button" class="mdc-banner mdc-banner--info mdc-banner--jump" title="Scroll to the edit">${escapeHtml(sidebarState.notice)} ↗</button>`;
    slot.querySelector<HTMLButtonElement>(".mdc-banner--jump")?.addEventListener("click", () => {
      const mark = editorContainer?.querySelector<HTMLElement>(".mdc-claude-edit");
      if (mark) smoothScrollIntoView(mark, "center");
    });
  } else {
    slot.innerHTML = `<div class="mdc-banner mdc-banner--info" role="status">${escapeHtml(sidebarState.notice)}</div>`;
  }
}

// ProseMirror documents carry no source positions, so the line a block came
// from has to be recovered. CommonMark's top-level block sequence and the
// editor's top-level node sequence are the same list, so the Nth block line
// belongs to the Nth node — and when the two counts disagree (raw HTML, an
// unusual construct, a doc mid-edit) the gutter switches off for that render
// instead of showing a column that is silently off by one from some point on.
//
// The numbers are painted as widget decorations rather than DOM the editor
// owns, so they can never end up in the serialized markdown.
const lineNumberPluginKey = new PluginKey("mdc-line-numbers");

function makeLineNumberPlugin(): Plugin {
  const build = (doc: PmDocNode): DecorationSet => {
    if (!lineMap) return DecorationSet.empty;
    const blockLines = topLevelBlockLines(cachedMarkdown);
    const decos: Decoration[] = [];
    let index = 0;
    let mismatched = false;
    doc.forEach((_node: PmDocNode, offset: number) => {
      const proseLine = blockLines[index++];
      if (proseLine === undefined) {
        mismatched = true;
        return;
      }
      const src = displayLine(lineMap!, proseLine);
      if (src === null) return;
      decos.push(
        Decoration.widget(offset + 1, () => {
          const el = document.createElement("span");
          el.className = "mdc-line-number";
          el.textContent = String(src);
          el.setAttribute("contenteditable", "false");
          return el;
        }, { side: -1, key: `ln-${offset}-${src}` }),
      );
    });
    // Fewer blocks than nodes means the alignment is already wrong somewhere.
    if (mismatched || blockLines.length !== doc.childCount) return DecorationSet.empty;
    return DecorationSet.create(doc, decos);
  };

  return new Plugin({
    key: lineNumberPluginKey,
    state: {
      init: (_config, state) => build(state.doc),
      apply: (tr, old: DecorationSet, _oldState, newState) =>
        tr.docChanged || tr.getMeta(lineNumberPluginKey) ? build(newState.doc) : old,
    },
    props: {
      decorations(state) {
        return lineNumberPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

/** The gutter width is a layout concern, so it lives on the root, not the plugin. */
function applyLineNumberLayout(): void {
  document
    .querySelector(".mdc-editor-root")
    ?.classList.toggle("with-line-numbers", lineMap !== null);
}

function refreshLineNumbers(): void {
  editor?.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(lineNumberPluginKey, "refresh"));
  });
}

function makeAnchorHighlightPlugin(): Plugin {
  return new Plugin({
    key: HIGHLIGHT_PLUGIN_KEY,
    state: {
      init: (_cfg, state) => buildAnchorDecorations(state.doc, sidebarState.comments, cachedMarkdown),
      apply: (tr, oldDecos) => {
        const meta = tr.getMeta(HIGHLIGHT_PLUGIN_KEY);
        if (meta?.refresh) {
          return buildAnchorDecorations(tr.doc, sidebarState.comments, cachedMarkdown);
        }
        // Map existing highlights through the edit instead of rebuilding from the
        // stored anchor text: a rebuild loses a highlight the moment you edit
        // *inside* it (the old quote no longer matches). A fresh rebuild with
        // re-anchored comments follows via forceHighlightRefresh once the host
        // writes the moved markers and re-sends the comments.
        return oldDecos.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return HIGHLIGHT_PLUGIN_KEY.getState(state) as DecorationSet | undefined;
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
          ".mdc-anchor-highlight",
        );
        if (!target) return false;
        const commentId = target.getAttribute("data-comment-id");
        if (!commentId) return false;
        revealCommentInSidebar(commentId);
        target.classList.remove("mdc-anchor-highlight--pulse");
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        void target.offsetWidth; // restart CSS animation
        target.classList.add("mdc-anchor-highlight--pulse");
        return true;
      },
    },
  });
}

interface DocLike {
  descendants: (
    cb: (
      node: { isText: boolean; nodeSize: number; text?: string; type: { name: string } },
      pos: number,
    ) => boolean | void,
  ) => void;
}

function buildAnchorDecorations(
  doc: DocLike,
  comments: CommentSummary[],
  _markdownSource: string,
): DecorationSet {
  if (comments.length === 0) return DecorationSet.empty;
  if (readOnly) return buildSourceAnchorDecorations(doc, comments);
  const decos: Decoration[] = [];
  // Resolve every anchor against the LIVE PM doc's rendered text (what the user
  // sees), not a markdown stripper. anchor.text was authored against the
  // markdown source, so strip markup chars off the small anchor strings, not
  // off the full document, before searching. The haystack is the mapper's own
  // text-node walk, not `doc.textContent` — see `renderedTextOf`.
  const haystack = renderedTextOf(doc);
  const decoratedIds: string[] = [];
  const shows = filterShows();
  for (const c of comments) {
    // Anchored threads: the marker already tells us which occurrence of the
    // text is anchored (anchorOrdinal), so find that occurrence directly — no
    // surrounding-context match (which broke on table/heading/list markdown).
    // Unanchored threads have no marker, so fall back to the context locator.
    const rendered =
      c.anchorOrdinal >= 0
        ? locateNthOccurrence(haystack, c.anchor.text, c.anchorOrdinal)
        : locateAnchorInLiveText(haystack, c.anchor);
    if (!rendered) continue;
    const pmRange = renderedRangeToPmRange(doc, rendered.start, rendered.end);
    if (!pmRange) continue;
    const attrs = anchorAttrs(c, shows(c));
    if (shows(c)) decoratedIds.push(c.id);
    // The 4th arg (spec) carries the id so a lookup can read it back off the
    // mapped decoration without parsing DOM attributes.
    decos.push(Decoration.inline(pmRange.from, pmRange.to, attrs, { id: c.id }));
  }
  // Report which anchors actually got highlighted (only when it changes) so an
  // integration test in a real VS Code + Milkdown can assert the outcome — the
  // test host can't read the webview DOM directly.
  reportHighlights(decoratedIds);
  return DecorationSet.create(doc as never, decos);
}

/**
 * Read-only placement: the editor ranges holding exactly the characters whose
 * source bytes lie inside an anchored span. No text search, so no wrong
 * occurrence. An anchor without markers has no span and gets no range —
 * guessing it from its quote is what misplaced them.
 */
function sourceRangesFor(
  doc: unknown,
  start: number | undefined,
  end: number | undefined,
  text: string,
): Array<{ from: number; to: number }> {
  // The host derived the span and the text from one version of the file. If
  // the text isn't at the span in the string this document was parsed from,
  // the list describes another version — place nothing until the next push.
  if (start === undefined || end === undefined || start < 0 || end <= start) return [];
  if (sourceMarkdown.slice(start, end) !== text) return [];
  return sourceRangeToEditor(sourceIndexFor(doc), start, end);
}

function buildSourceAnchorDecorations(doc: DocLike, comments: CommentSummary[]): DecorationSet {
  const decos: Decoration[] = [];
  const decoratedIds: string[] = [];
  const shows = filterShows();
  for (const c of comments) {
    const ranges = sourceRangesFor(doc, c.proseStart, c.proseEnd, c.anchor.text);
    if (ranges.length === 0) continue;
    const attrs = anchorAttrs(c, shows(c));
    if (shows(c)) decoratedIds.push(c.id);
    for (const r of ranges) decos.push(Decoration.inline(r.from, r.to, attrs, { id: c.id }));
  }
  reportHighlights(decoratedIds);
  return DecorationSet.create(doc as never, decos);
}

/** The sidebar's thread filter, which it keeps in the webview state; Open when unset. */
function threadFilter(): ThreadFilter {
  const f = (vscode.getState() as { threadFilter?: unknown } | undefined)?.threadFilter;
  return f === "all" || f === "resolved" || f === "claude-unread" ? f : "open";
}

/** Whether the sidebar's current filter lists a thread — only those are highlighted, as in the review view. */
function filterShows(): (c: CommentSummary) => boolean {
  const filter = threadFilter();
  const threads = new Map(sidebarPush.threads.map((t) => [t.id, t]));
  return (c) =>
    matchesFilter(
      threads.get(c.id) ?? { id: c.id, status: c.resolved ? "resolved" : "open", comments: [{ author: c.author }] },
      filter,
    );
}

/**
 * A thread's decoration. One the filter hides is still decorated, invisibly,
 * so the jump to it keeps working; a resolved one it shows is greyed.
 */
function anchorAttrs(c: CommentSummary, shown: boolean): Record<string, string> {
  if (!shown) return { class: "mdc-anchor-tracked", "data-comment-id": c.id };
  return {
    class: c.resolved ? "mdc-anchor-highlight mdc-anchor-highlight--resolved" : "mdc-anchor-highlight",
    "data-comment-id": c.id,
    title: `Comment by ${c.author}: ${truncate(c.body, 100)}`,
  };
}

let lastHighlightSig = " ";
function reportHighlights(ids: string[]): void {
  const sig = ids.join(",");
  if (sig === lastHighlightSig) return;
  lastHighlightSig = sig;
  vscode.postMessage({ type: "highlight-report", ids });
}

function forceHighlightRefresh(): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(HIGHLIGHT_PLUGIN_KEY, { refresh: true }));
  });
}

function forceSuggestionHighlightRefresh(): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(SUGGESTION_HIGHLIGHT_KEY, { refresh: true }));
  });
}

/**
 * Rebuild the diff-stripes decorations from `currentDiff`, then refresh what
 * hangs off them: the toolbar's badge, its navigable stops (read back off the
 * editor's own DOM, which ProseMirror updates synchronously inside `dispatch`),
 * and the sidebar's n/p dispatch (steps changes while a diff is showing,
 * threads otherwise — `ThreadSidebarHandle.setChangeNavigation`).
 */
function forceDiffRefresh(): void {
  if (!editor || !changeNav) return;
  const nav = changeNav;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(DIFF_STRIPES_KEY, { refresh: true }));
  });
  const diff = currentDiff;
  nav.setBadge(
    !diff
      ? null
      : diff.isNew
        ? "new file — uncommitted"
        : diff.addedRanges.length === 0 && (diff.removed ?? []).length === 0
          ? "no uncommitted prose changes"
          : "uncommitted changes",
  );
  const stops = editorContainer
    ? Array.from(editorContainer.querySelectorAll<HTMLElement>(".mdc-diff-changed, .mdc-diff-removed"))
    : [];
  nav.setStops(stops);
  threadSidebar.setChangeNavigation(diff && stops.length > 0 ? (delta) => nav.step(delta) : null);
}

/**
 * The host opened this view on a thread: make its card the current one and
 * scroll the document to its highlight. An unanchored thread has only its card.
 */
function revealThreadFromHost(threadId: string): void {
  revealCommentInSidebar(threadId);
  const anchored = sidebarPush.threads.find((t) => t.id === threadId)?.anchor;
  const comment = sidebarState.comments.find((c) => c.id === threadId);
  if (anchored && comment) jumpToAnchor(comment);
}

function revealCommentInSidebar(commentId: string): void {
  if (!sidebarEl) return;
  if (sidebarState.collapsed) {
    sidebarState.collapsed = false;
    syncCollapsedClass();
  }
  // The sidebar makes it the current card, widening its filter if that one
  // hides the thread.
  threadSidebar.revealThread(commentId);
}

function jumpToAnchor(comment: CommentSummary): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let pmRange: { from: number; to: number } | null = null;
    if (readOnly) {
      // Read-only: the highlight already sits at the thread's source position;
      // jump to it rather than re-finding the text.
      const set = HIGHLIGHT_PLUGIN_KEY.getState(view.state) as DecorationSet | undefined;
      const deco = set?.find(undefined, undefined, (spec) => (spec as { id?: string }).id === comment.id)[0];
      if (!deco) {
        showToast("Couldn't locate this comment's anchor in the document. The text may have changed.");
        return;
      }
      pmRange = { from: deco.from, to: deco.to };
    } else {
      const haystack = renderedTextOf(view.state.doc);
      const rendered =
        comment.anchorOrdinal >= 0
          ? locateNthOccurrence(haystack, comment.anchor.text, comment.anchorOrdinal)
          : locateAnchorInLiveText(haystack, comment.anchor);
      if (!rendered) {
        showToast("Couldn't locate this comment's anchor in the document. The text may have changed.");
        return;
      }
      pmRange = renderedRangeToPmRange(
        view.state.doc as unknown as Parameters<typeof renderedRangeToPmRange>[0],
        rendered.start,
        rendered.end,
      );
    }
    if (!pmRange) return;
    try {
      const dom = view.domAtPos(pmRange.from).node as Element | null;
      if (dom && (dom as HTMLElement).scrollIntoView) {
        smoothScrollIntoView(dom as HTMLElement, "center");
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      const highlight = document.querySelector<HTMLElement>(
        `.mdc-anchor-highlight[data-comment-id="${cssEscape(comment.id)}"]`,
      );
      if (highlight) {
        highlight.classList.remove("mdc-anchor-highlight--pulse");
        void highlight.offsetWidth;
        highlight.classList.add("mdc-anchor-highlight--pulse");
      }
    }, 150);
  });
}

interface MermaidApi {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const candidate = (mod as { default?: unknown }).default ?? mod;
      const api = candidate as MermaidApi;
      // Follow the editor theme, as the classic panel did: a light diagram on a
      // dark background reads as a rendering bug.
      const isDark =
        document.body.classList.contains("vscode-dark") ||
        document.body.classList.contains("vscode-high-contrast") ||
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      try {
        api.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark ? "dark" : "default" });
      } catch {
        /* idempotent */
      }
      return api;
    });
  }
  return mermaidPromise;
}

let mermaidIdCounter = 0;
const mermaidPluginKey = new PluginKey("mdc-mermaid");
interface MermaidEntry { src: string; status: "pending" | "ready" | "error"; svg?: string; error?: string }
const mermaidCache = new Map<string, MermaidEntry>();

function makeMermaidPlugin(): Plugin {
  return new Plugin({
    key: mermaidPluginKey,
    state: {
      init: (_cfg, state) => buildMermaidDecorations(state.doc),
      apply: (tr, oldDecos) => {
        if (tr.docChanged) return buildMermaidDecorations(tr.doc);
        // The async render in makeMermaidWidget dispatches this meta once it
        // settles, so a diagram that just finished rendering (or just failed)
        // gets its source hidden/revealed without waiting for the next edit.
        if (tr.getMeta(mermaidPluginKey) === "refresh") return buildMermaidDecorations(tr.doc);
        return oldDecos.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return mermaidPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

function refreshMermaidDecorations(): void {
  editor?.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(mermaidPluginKey, "refresh"));
  });
}

// A paragraph whose only inline content is a single link whose href ends in
// `.drawio` / `.drawio.xml` / `.xml` becomes an inline diagram; links mixed
// with other text keep their regular click behavior.
//
// File content is owned by the extension: the widget posts `drawio-read` with a
// request id and completes on the matching `drawio-read-result`. A per-href
// cache avoids re-requesting on every PM transaction (every keystroke
// re-renders decorations).

const drawioPluginKey = new PluginKey("mdc-drawio");

interface DrawioCacheEntry {
  href: string;
  status: "pending" | "ready" | "error";
  svg?: SVGSVGElement;
  error?: string;
  // Re-render hooks: each rendered widget registers itself so the
  // entry can paint once content/error arrives. The set is cleared
  // when the entry resolves but lazy widget creation can still find
  // the cached value via status.
  listeners: Set<() => void>;
}

const drawioCache = new Map<string, DrawioCacheEntry>();
let drawioRequestCounter = 0;
const drawioPendingRequests = new Map<string, string>();

function isDrawioHrefForWidget(href: string): boolean {
  const cleaned = (href || "").trim().toLowerCase().split("#")[0]!.split("?")[0]!;
  if (!cleaned) return false;
  // Reject schemes — only workspace-relative paths are eligible. The
  // extension-side resolver enforces the same rule, but rejecting here
  // avoids the round-trip for obviously-out-of-scope hrefs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return false;
  return cleaned.endsWith(".drawio") || cleaned.endsWith(".drawio.xml") || cleaned.endsWith(".xml");
}

interface PmNode {
  type: { name: string };
  isText?: boolean;
  childCount?: number;
  child?: (i: number) => PmNode;
  marks?: Array<{ type: { name: string }; attrs: Record<string, unknown> }>;
  text?: string;
  textContent?: string;
  attrs?: Record<string, unknown>;
}

interface DrawioParagraphMatch {
  href: string;
  /**
   * Set only for the `![alt](x.drawio)` form: the image node's size, so
   * `buildDrawioDecorations` can hide the (otherwise broken) `<img>` the image
   * nodeView would render for a non-image src.
   */
  hideChildSize?: number;
}

// Matches a paragraph that is a diagram reference and nothing else — either
// `[text](x.drawio)` (a single text node under a link mark) or
// `![alt](x.drawio)` (a single image node), whitespace-padding allowed. Both
// forms promote the paragraph to the same inline diagram widget; only the
// image form also needs its own (would-be-broken) rendering hidden.
function paragraphDrawioMatch(paragraph: PmNode): DrawioParagraphMatch | null {
  if (paragraph.type.name !== "paragraph") return null;
  const childCount = paragraph.childCount ?? 0;
  // PM may split text into multiple nodes if marks change, but a
  // single-link (or single-image) paragraph has exactly one child.
  if (childCount !== 1) return null;
  const child = paragraph.child?.(0);
  if (!child) return null;
  if (child.isText) {
    const linkMark = (child.marks ?? []).find((m) => m.type.name === "link");
    if (!linkMark) return null;
    const href = String(linkMark.attrs.href ?? "");
    // The visible text can be any caption — we don't constrain it. But if the
    // user wrote `[label] (file.drawio)` (extra space after `]`), PM still
    // parses it as a link; we accept that too.
    return isDrawioHrefForWidget(href) ? { href } : null;
  }
  if (child.type.name === "image") {
    const src = String(child.attrs?.src ?? "");
    if (!isDrawioHrefForWidget(src)) return null;
    return { href: src, hideChildSize: 1 };
  }
  return null;
}

function buildDrawioDecorations(doc: DocLike): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    const match = paragraphDrawioMatch(node as unknown as PmNode);
    if (!match) return true;
    if (match.hideChildSize) {
      const from = pos + 1; // past the paragraph's own opening token
      decos.push(
        Decoration.node(from, from + match.hideChildSize, { class: "mdc-drawio-image-hidden" }),
      );
    }
    decos.push(
      Decoration.widget(pos, () => makeDrawioWidget(match.href), {
        side: 1,
        ignoreSelection: true,
        key: `drawio-${pos}-${match.href}`,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc as never, decos);
}

function makeDrawioWidget(href: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mdc-drawio";
  wrap.setAttribute("data-href", href);
  const target = document.createElement("div");
  target.className = "mdc-drawio__render";
  wrap.appendChild(target);

  const paint = (): void => {
    const entry = drawioCache.get(href);
    if (!entry) {
      target.textContent = "Loading diagram…";
      return;
    }
    if (entry.status === "pending") {
      target.textContent = "Loading diagram…";
      return;
    }
    if (entry.status === "error") {
      target.innerHTML = `<div class="mdc-drawio__error">${escapeHtml(entry.error ?? "Could not render diagram.")}</div>`;
      return;
    }
    if (entry.status === "ready" && entry.svg) {
      target.innerHTML = "";
      target.appendChild(entry.svg.cloneNode(true) as SVGSVGElement);
    }
  };

  const existing = drawioCache.get(href);
  if (existing) {
    existing.listeners.add(paint);
    paint();
  } else {
    requestDrawio(href, paint);
    paint();
  }

  return wrap;
}

function requestDrawio(href: string, repaint: () => void): void {
  const entry: DrawioCacheEntry = {
    href,
    status: "pending",
    listeners: new Set([repaint]),
  };
  drawioCache.set(href, entry);
  const requestId = `drawio-${++drawioRequestCounter}`;
  drawioPendingRequests.set(requestId, href);
  vscode.postMessage({ type: "drawio-read", requestId, href });
}

function handleDrawioReadResult(msg: DrawioReadResultMessage): void {
  drawioPendingRequests.delete(msg.requestId);
  const entry = drawioCache.get(msg.href);
  if (!entry) return;

  if (!msg.ok || typeof msg.content !== "string") {
    entry.status = "error";
    entry.error = msg.error ?? "Could not load diagram.";
    flushDrawioListeners(entry);
    return;
  }

  void (async () => {
    try {
      const { renderDrawioToSvg } = await import("./drawioRenderer");
      const result = await renderDrawioToSvg(msg.content!);
      if (result.ok) {
        entry.status = "ready";
        entry.svg = result.svg;
      } else {
        entry.status = "error";
        entry.error = result.message;
      }
    } catch (e) {
      entry.status = "error";
      entry.error = (e as Error).message;
    }
    flushDrawioListeners(entry);
  })();
}

function flushDrawioListeners(entry: DrawioCacheEntry): void {
  for (const fn of entry.listeners) {
    try {
      fn();
    } catch (e) {
      postError("drawio-paint", e);
    }
  }
  entry.listeners.clear();
}

function makeDrawioPlugin(): Plugin {
  return new Plugin({
    key: drawioPluginKey,
    state: {
      init: (_cfg, state) => buildDrawioDecorations(state.doc),
      apply: (tr, oldDecos) =>
        tr.docChanged ? buildDrawioDecorations(tr.doc) : oldDecos.map(tr.mapping, tr.doc),
    },
    props: {
      decorations(state) {
        return drawioPluginKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

// Milkdown's GFM preset wires `prosemirror-tables`' `tableEditing`
// plugin, which promotes any drag that touches a cell boundary into a
// `CellSelection` covering the whole cell(s). For commenting, that
// snap-to-cell behaviour is wrong: the user wants to highlight a
// substring of a cell, not the cell itself. We can't disable the
// promotion (it's hardcoded inside the table-editing plugin's mousedown
// handler), so instead we run `appendTransaction` after every state
// update and, whenever the resulting selection is a `CellSelection`,
// rewrite it to a plain `TextSelection` covering only the visible text
// of the selected cell range. The user sees a normal text-range
// highlight; the comment anchor records the actual text they meant.
// Render markdown images with a webview-loadable src. Milkdown renders the
// node's raw `src` (e.g. `../diagrams/x.png`), which a webview can't fetch; this
// nodeView rewrites the src for DISPLAY only — the underlying node keeps the
// original path, so the markdown round-trips unchanged on save.
type PmImageNode = { attrs: Record<string, unknown>; type: { name: string } };
/** Milkdown keeps raw HTML as an opaque node whose `value` attr is the source. */
type PmHtmlNode = { attrs: Record<string, unknown>; type: { name: string } };
/**
 * Swap the classes this file manages on a node view's dom, leaving the ones
 * ProseMirror adds from node decorations (the tag pair plugin's) alone.
 */
function setOwnClasses(dom: HTMLElement, classes: string[]): void {
  for (const c of (dom.dataset.mdcOwn ?? "").split(" ")) if (c) dom.classList.remove(c);
  dom.classList.add(...classes);
  dom.dataset.mdcOwn = classes.join(" ");
}

function makeImageResolvePlugin(): Plugin {
  const apply = (img: HTMLImageElement, node: PmImageNode): void => {
    img.setAttribute("src", resolveImageSrc(String(node.attrs.src ?? ""), imageBaseUris));
    const alt = String(node.attrs.alt ?? "");
    const title = String(node.attrs.title ?? "");
    if (alt) img.setAttribute("alt", alt);
    else img.removeAttribute("alt");
    if (title) img.setAttribute("title", title);
    else img.removeAttribute("title");
  };
  // Markdown can't centre an image or set its width, so documents write those
  // as raw HTML. Milkdown keeps raw HTML as an opaque `html` node and renders
  // its source as escaped text. `parseHtmlImage` recognizes the image case only
  // (strict attribute whitelist, safe schemes, refuses anything with another
  // element or an `on*` handler); everything else keeps the escaped rendering.
  const applyHtml = (dom: HTMLElement, node: PmHtmlNode): boolean => {
    const parsed = parseHtmlImage(String(node.attrs.value ?? ""));
    if (!parsed) return false;
    setOwnClasses(dom, parsed.centered ? ["mdc-html-image", "mdc-html-image--center"] : ["mdc-html-image"]);
    const img = document.createElement("img");
    img.className = "mdc-image";
    img.setAttribute("src", resolveImageSrc(parsed.src, imageBaseUris));
    if (parsed.alt !== undefined) img.setAttribute("alt", parsed.alt);
    if (parsed.title !== undefined) img.setAttribute("title", parsed.title);
    if (parsed.width !== undefined) img.setAttribute("width", parsed.width);
    if (parsed.height !== undefined) img.setAttribute("height", parsed.height);
    dom.replaceChildren(img);
    return true;
  };

  // Everything else that's raw HTML. Each case keeps the node an opaque atom
  // (so the markdown round-trips unchanged) and only decides what it shows:
  // - a comment: nothing while reading; its source while editing.
  // - one inline formatting tag (`<sup>`, `</kbd>`): its source, which the tag
  //   pair plugin hides while reading once it finds the partner.
  // - anything else: the sanitized fragment, or — when that shows nothing, like
  //   a lone `</details>` — the same hidden/source split as a comment.
  // One per editor: every shadow-rendered block in this document shares the
  // document's `<style>` rules, wherever in it they sit.
  const shadowStyles = new ShadowStyles();
  const renderHtml = (dom: HTMLElement, node: PmHtmlNode): void => {
    // An update can move a node between cases: drop what a shadow mount set.
    dom.removeAttribute("style");
    dom.classList.remove(SHADOW_WRAPPER_CLASS);
    if (applyHtml(dom, node)) return shadowStyles.set(dom, null);
    const raw = String(node.attrs.value ?? "");
    const showSource = (): void => {
      setOwnClasses(dom, readOnly ? ["mdc-html-hidden"] : ["mdc-html-raw"]);
      dom.textContent = readOnly ? "" : raw;
    };
    const snippet = classifyHtml(raw);
    if (snippet.kind !== "fragment") shadowStyles.set(dom, null);
    if (snippet.kind === "comment") return showSource();
    if (snippet.kind === "tag" && INLINE_PAIR_TAGS.has(snippet.tag.name)) {
      setOwnClasses(dom, readOnly ? ["mdc-html-raw", "mdc-html-tag", "mdc-html-tag--reading"] : ["mdc-html-raw", "mdc-html-tag"]);
      dom.textContent = raw;
      return;
    }
    const resolveSrc = (src: string): string => resolveImageSrc(src, imageBaseUris);
    // A complete fragment renders as written — its own CSS included — in a
    // contained shadow root. Only a fragment that leans on the blocks around
    // it (a `<details>` closed later, a lone `</div>`) takes the inline path.
    if (isSelfContained(raw)) {
      const { css, html } = splitStyles(sanitizeHtml(raw, { resolveSrc, shadow: true }));
      shadowStyles.set(dom, css || null);
      // A block that is only a `<style>`: applied, and shown like a comment.
      if (!html.trim()) return showSource();
      setOwnClasses(dom, ["mdc-html"]);
      mountShadowHtml(dom, html, isBlockHtml(html), shadowStyles);
      return;
    }
    shadowStyles.set(dom, null);
    const html = sanitizeHtml(raw, { resolveSrc });
    dom.innerHTML = html;
    // A `<details>` whose body is markdown arrives without that body (it's in
    // the following blocks), so a closed one would hide nothing and look empty.
    for (const d of dom.querySelectorAll("details")) d.open = true;
    if (!dom.textContent?.trim() && !dom.querySelector("img, hr, br, table")) return showSource();
    setOwnClasses(dom, isBlockHtml(html) ? ["mdc-html", "mdc-html--block"] : ["mdc-html"]);
  };

  return new Plugin({
    props: {
      nodeViews: {
        image: (node: PmImageNode) => {
          const dom = document.createElement("img");
          dom.className = "mdc-image";
          apply(dom, node);
          return {
            dom,
            update: (next: PmImageNode) => {
              if (next.type.name !== "image") return false;
              apply(dom, next);
              return true;
            },
          };
        },
        html: (node: PmHtmlNode) => {
          const dom = document.createElement("span");
          dom.setAttribute("contenteditable", "false");
          renderHtml(dom, node);
          return {
            dom,
            update: (next: PmHtmlNode) => {
              if (next.type.name !== "html") return false;
              renderHtml(dom, next);
              return true;
            },
            destroy: () => shadowStyles.set(dom, null),
          };
        },
      },
    },
  });
}

function makeFlattenCellSelectionPlugin(): Plugin {
  return new Plugin({
    appendTransaction(_trs, _oldState, newState) {
      const sel = newState.selection;
      if (!(sel instanceof CellSelection)) return null;
      const $a = sel.$anchorCell;
      const $h = sel.$headCell;
      const lo = $a.pos <= $h.pos ? $a : $h;
      const hi = $a.pos <= $h.pos ? $h : $a;
      const loCell = lo.nodeAfter;
      const hiCell = hi.nodeAfter;
      if (!loCell || !hiCell) return null;
      // Inner text positions: skip past the cell open token (+1) and stop
      // before the cell close token (nodeSize - 1, since outer +1 was
      // already paid).
      const from = lo.pos + 1;
      const to = hi.pos + hiCell.nodeSize - 1;
      if (from >= to) return null;
      return newState.tr.setSelection(TextSelection.create(newState.doc, from, to));
    },
  });
}

function buildMermaidDecorations(doc: DocLike): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if ((node.type as { name?: string }).name !== "code_block") return true;
    const lang = ((node as unknown as { attrs?: { language?: string } }).attrs ?? {}).language;
    if (lang !== "mermaid") return true;
    const src = (node as unknown as { textContent: string }).textContent;
    // Hide the fence source once its diagram has rendered. Left visible while
    // pending (so there isn't a blank gap before the first render) and on error
    // (so the source is there to fix).
    if (mermaidCache.get(src)?.status === "ready") {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "mdc-mermaid-source-hidden" }));
    }
    decos.push(
      Decoration.widget(pos, () => makeMermaidWidget(src), {
        side: -1,
        ignoreSelection: true,
        key: `mermaid-${pos}-${src.length}`,
      }),
    );
    return true;
  });
  return DecorationSet.create(doc as never, decos);
}

function makeMermaidWidget(src: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mdc-mermaid";
  const target = document.createElement("div");
  target.className = "mdc-mermaid__render";
  wrap.appendChild(target);
  if (!src.trim()) {
    target.innerHTML = "<em>(empty mermaid block)</em>";
    return wrap;
  }
  const cached = mermaidCache.get(src);
  if (cached) {
    if (cached.status === "ready") target.innerHTML = cached.svg ?? "";
    else if (cached.status === "error") target.innerHTML = `<div class="mdc-mermaid__error">${escapeHtml(cached.error ?? "render failed")}</div>`;
    else target.textContent = "Rendering mermaid…";
  } else {
    mermaidCache.set(src, { src, status: "pending" });
    target.textContent = "Rendering mermaid…";
    void loadMermaid()
      .then(async (mermaid) => {
        const id = `mdc-mermaid-${++mermaidIdCounter}`;
        try {
          const { svg } = await mermaid.render(id, src);
          mermaidCache.set(src, { src, status: "ready", svg });
          target.innerHTML = svg;
        } catch (e) {
          const message = (e as Error).message;
          mermaidCache.set(src, { src, status: "error", error: message });
          target.innerHTML = `<div class="mdc-mermaid__error">Mermaid render failed: ${escapeHtml(message)}</div>`;
        }
        // Either branch changed this src's cache status, which decides
        // whether the fence source is hidden — repaint the decoration set.
        refreshMermaidDecorations();
      })
      .catch((e) => {
        const message = (e as Error).message;
        mermaidCache.set(src, { src, status: "error", error: message });
        target.innerHTML = `<div class="mdc-mermaid__error">Failed to load mermaid: ${escapeHtml(message)}</div>`;
        refreshMermaidDecorations();
      });
  }
  return wrap;
}

function installAddCommentAffordance(): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mdc-add-comment-btn";
  button.textContent = "+ Add comment";
  button.style.display = "none";
  document.body.appendChild(button);

  // A mouse drag-selection in the editor is in progress. The button sits just
  // right of the selection's end — mid-drag, under the pointer. In a read-only
  // view nothing clamps the native selection to the editor (there is no
  // contenteditable host), so dragging over the button extended the selection
  // to the button's place in the DOM, after the sidebar; ProseMirror ignores a
  // selection that leaves the editor and keeps the prefix it last saw. So the
  // button waits for the release.
  let dragging = false;
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0 || !editorContainer?.contains(e.target as Node)) return;
      dragging = true;
      button.style.display = "none";
    },
    true,
  );
  const endDrag = (): void => {
    dragging = false;
  };
  document.addEventListener("mouseup", endDrag, true);
  window.addEventListener("blur", endDrag);

  const updateButton = (): void => {
    if (!editor || !editorContainer) return;
    if (dragging) {
      button.style.display = "none";
      return;
    }
    interface ButtonCoords { top: number; left: number }
    let coords: ButtonCoords | null = null;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const sel = view.state.selection;
      if (sel.empty) return;
      try {
        const c = view.coordsAtPos(sel.to);
        coords = { top: c.top, left: c.right };
      } catch {
        /* ignore */
      }
    });
    const c = coords as ButtonCoords | null;
    if (c) {
      button.style.display = "block";
      button.style.top = `${c.top}px`;
      button.style.left = `${c.left + 6}px`;
    } else {
      button.style.display = "none";
    }
  };

  // Refresh the floating button's position and keep lastNonEmptySelection in
  // lock-step with PM's state, on every selection-affecting event.
  const refresh = (): void => {
    updateLastNonEmptySelection();
    updateButton();
  };
  document.addEventListener("selectionchange", () => setTimeout(refresh, 0));
  document.addEventListener("mouseup", () => setTimeout(refresh, 0));
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      setTimeout(refresh, 0);
    }
  });
  // Belt-and-suspenders for the floating button: a capture-phase pointerdown
  // anywhere snapshots PM's selection before any focus shift or setTimeout-0
  // refresh can run, closing the race where a fast click on the button beats
  // the prior selectionchange's deferred refresh.
  window.addEventListener("pointerdown", () => {
    updateLastNonEmptySelection();
  }, true);

  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    captureCurrentSelection();
    updateLastNonEmptySelection();
  });
  button.addEventListener("click", () => {
    button.style.display = "none";
    openComposerForCurrentSelection();
  });
}

// Why a read-only selection can't take a comment, keyed by the mapper's reason.
const READ_ONLY_REFUSALS = {
  empty: "Select some non-whitespace text to comment on.",
  code: "Comments can't be anchored inside code. Select text outside the code block or code span.",
  unmapped:
    "This selection doesn't map exactly to the Markdown source, so the comment could land in the wrong place. Select different text.",
} as const;

function openComposerForCurrentSelection(): void {
  if (!editor || !composerEl) return;
  let anchor: import("../types").Anchor | null = null;
  // Read-only mode: the prose span under the selection and the bytes there,
  // taken now — if the file changes before Save, the host sees they differ.
  let proseRange: { start: number; end: number; text: string } | null = null;
  // Edit mode: the selection's first and last characters, named by structure,
  // with the text of the containers they're in — checked the same way.
  let editRange: { first: EditorPoint; last: EditorPoint } | null = null;
  let displayText = "";
  let failureReason = "";
  // Order: live selection, then pendingSelection, then lastNonEmptySelection —
  // see the comment on those.
  const captured = pendingSelection;
  pendingSelection = null;
  const recent = lastNonEmptySelection;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const live = view.state.selection;
    let selFrom: number;
    let selTo: number;
    if (!live.empty) {
      selFrom = live.from;
      selTo = live.to;
    } else if (captured) {
      selFrom = captured.from;
      selTo = captured.to;
    } else if (recent) {
      selFrom = recent.from;
      selTo = recent.to;
    } else {
      failureReason = "No text is selected. Highlight some text in the editor first.";
      return;
    }
    if (selFrom === selTo) {
      failureReason = "No text is selected. Highlight some text in the editor first.";
      return;
    }
    if (readOnly) {
      // Each selected character knows its source bytes, so the comment goes
      // exactly there — or, when a boundary has no trusted bytes, nowhere.
      const mapped = editorSelectionToSource(sourceIndexFor(view.state.doc), selFrom, selTo);
      if (!mapped.ok) {
        failureReason = READ_ONLY_REFUSALS[mapped.reason];
        return;
      }
      displayText = mapped.text;
      proseRange = { start: mapped.start, end: mapped.end, text: sourceMarkdown.slice(mapped.start, mapped.end) };
      anchor = {
        text: mapped.text,
        contextBefore: sourceMarkdown.slice(Math.max(0, mapped.start - 24), mapped.start),
        contextAfter: sourceMarkdown.slice(mapped.end, mapped.end + 24),
      };
      return;
    }
    // Edit mode: this document carries no source positions (a split or join
    // copies them onto both halves), so the selection is named by structure —
    // block, text container, character — for the host to find in the file's
    // own bytes. Nothing the editor serializes goes with it.
    const named = editorSelectionPoints(
      topLevelBlocks(view.state.doc) as unknown as Array<{ node: PmBlockLike; pos: number }>,
      selFrom,
      selTo,
    );
    if (!named.ok) {
      failureReason = READ_ONLY_REFUSALS[named.reason];
      return;
    }
    displayText = named.text;
    editRange = { first: named.first, last: named.last };
    anchor = { text: named.text, contextBefore: "", contextAfter: "" };
  });

  if (!anchor) {
    showToast(failureReason || "Couldn't anchor this selection.");
    return;
  }
  const finalAnchor: import("../types").Anchor = anchor;
  const finalRange = proseRange as { start: number; end: number; text: string } | null;
  const finalEditRange = editRange as { first: EditorPoint; last: EditorPoint } | null;

  const preview = displayText.slice(0, 120) + (displayText.length > 120 ? "…" : "");
  composerEl.innerHTML = "";
  const composer = buildComposer({
    meta: `Commenting on: ${preview}`,
    placeholder: "Write a comment…",
    submitLabel: "Save",
    cancelLabel: "Cancel",
    rows: 3,
    onSubmit: (body) => {
      composer.setBusy("Saving…");
      addComposer = composer;
      if (finalRange) {
        // Read-only: the host maps this prose span to the file's own bytes and
        // inserts the two markers there — nothing else is rewritten.
        vscode.postMessage({
          type: "add-comment",
          anchor: finalAnchor,
          body,
          author: userName,
          proseStart: finalRange.start,
          proseEnd: finalRange.end,
          proseText: finalRange.text,
        });
        return;
      }
      // Edits still in the debounce reach the file before the comment does,
      // so the host finds the text the selection was named against.
      flushBlockEdits();
      vscode.postMessage({
        type: "add-comment",
        anchor: finalAnchor,
        body,
        author: userName,
        editRange: finalEditRange,
        epoch: editEpoch,
      });
    },
    onCancel: () => {
      addComposer = null;
      if (composerEl) composerEl.innerHTML = "";
    },
  });
  composerEl.appendChild(composer.el);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(text: string, durationMs = 4500): void {
  let toast = document.querySelector<HTMLElement>(".mdc-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "mdc-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("mdc-toast--visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.classList.remove("mdc-toast--visible"), durationMs);
}

function reportReady(synced: boolean): void {
  if (!editor) return;
  let length = 0;
  let error: string | undefined;
  try {
    editor.action((ctx) => {
      const serializer = ctx.get(serializerCtx);
      const view = ctx.get(editorViewCtx);
      length = serializer(view.state.doc).length;
    });
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
  }
  vscode.postMessage({ type: "ready-with-content", length, synced, error });
}

/**
 * The fallback behind the character-precise replace in `applyExternalChange`:
 * replace the run of top-level blocks that differ between `prev` and `next`.
 * Used when a single content-level `replace` step doesn't land on `next`
 * exactly (an edit shape it can't express, or one `tr.replace` itself
 * throws on). Returns the position just past the replaced range in the
 * resulting document, or null when no top-level block differs.
 */
function applyBlockLevelReplacement(tr: Transaction, prev: PmDocNode, next: PmDocNode): number | null {
  // Common prefix and suffix of top-level blocks; the middle is what changed.
  let start = 0;
  while (start < prev.childCount && start < next.childCount && prev.child(start).eq(next.child(start))) start++;
  let prevEnd = prev.childCount;
  let nextEnd = next.childCount;
  while (prevEnd > start && nextEnd > start && prev.child(prevEnd - 1).eq(next.child(nextEnd - 1))) {
    prevEnd--;
    nextEnd--;
  }
  if (start === prevEnd && start === nextEnd) return null; // the same document
  const offsetOf = (doc: PmDocNode, index: number): number => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
    return pos;
  };
  tr.replaceWith(
    offsetOf(prev, start),
    offsetOf(prev, prevEnd),
    next.content.cut(offsetOf(next, start), offsetOf(next, nextEnd)),
  );
  return offsetOf(next, nextEnd);
}

function applyExternalChange(
  text: string,
  changed?: ChangeSummary | null,
  epoch?: number,
  toast?: string,
  quiet?: boolean,
  reveal?: boolean,
): void {
  if (!editor) return;
  // Cancel a still-pending local edit post. The keystroke that scheduled it
  // predates this external (Claude) change, so letting it fire would overwrite
  // Claude's edit with our stale text.
  if (editDebounce) {
    clearTimeout(editDebounce);
    editDebounce = null;
  }
  const scroller = editorScrollEl; // .mdc-editor-scroll (overflow:auto) — see buildLayout
  const prevScrollTop = scroller?.scrollTop ?? 0;

  cachedMarkdown = text;
  // The source positions in the re-parsed document index this string.
  sourceMarkdown = text;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parser = ctx.get(parserCtx);
    const next = parser(text);
    if (!next) return;
    const prev = view.state.doc;

    const start = prev.content.findDiffStart(next.content);
    if (start == null) return; // same document: dispatch nothing

    // Replace only what differs, at character precision — not the whole
    // document, so the cursor stays on its text and the undo history keeps
    // every keystroke outside the changed span. A whole-document replacement
    // mapped everything onto the end of the new document — so Cmd+Z after an
    // agent's edit undid nothing and jumped to the end of the file.
    let tr = view.state.tr;
    let revealTo = next.content.size;
    let landed = false;
    try {
      const diffEnd = prev.content.findDiffEnd(next.content);
      if (diffEnd) {
        let { a: endA, b: endB } = diffEnd;
        const overlap = start - Math.min(endA, endB);
        if (overlap > 0) {
          endA += overlap;
          endB += overlap;
        }
        tr.replace(start, endA, next.slice(start, endB));
        if (tr.doc.eq(next)) {
          revealTo = endB;
          landed = true;
        }
      }
    } catch {
      /* falls through to the block-level replacement */
    }

    if (!landed) {
      tr = view.state.tr;
      const blockEnd = applyBlockLevelReplacement(tr, prev, next);
      if (blockEnd != null && tr.doc.eq(next)) {
        revealTo = blockEnd;
        landed = true;
      }
    }

    if (!landed) {
      tr = view.state.tr;
      tr.replaceWith(0, prev.content.size, next.content);
      revealTo = next.content.size;
    }

    // Marked external so no plugin treats the agent's disk-side edit as ours.
    tr.setMeta("addToHistory", false);
    tr.setMeta("external", true);
    if (reveal) {
      // The person's own undo/redo: land the caret at the end of the
      // replaced range (the deletion point, for a pure deletion) and scroll
      // to it, instead of restoring the old scroll position below.
      const pos = Math.max(0, Math.min(revealTo, tr.doc.content.size));
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
      tr.scrollIntoView();
    }
    view.dispatch(tr);
    if (reveal && !view.hasFocus()) {
      // A transaction's scrollIntoView only acts on a view that holds the DOM
      // selection. An undo made from the sidebar, or in Reading mode, still
      // has to show what changed.
      const at = view.domAtPos(view.state.selection.from);
      const el = at.node.nodeType === Node.ELEMENT_NODE ? (at.node as Element) : at.node.parentElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  });
  // Edit mode diffs the next edit against the file's text, not what was typed before it.
  resetEditBase(epoch);

  // Without `reveal`, keep the viewport where it was — the replacement
  // doesn't scroll on its own, and the changed blocks may have been above it.
  // `reveal` already scrolled to the change above, via `tr.scrollIntoView()`.
  if (!reveal && scroller) {
    requestAnimationFrame(() => {
      scroller.scrollTop = prevScrollTop;
    });
  }
  forceHighlightRefresh();
  forceSuggestionHighlightRefresh();
  forceDiffRefresh();

  // The host re-read the file because it couldn't take an edit: say that, not "edited on disk".
  if (toast) {
    showToast(toast, 8000);
    return;
  }
  // Nothing happened the person needs to hear about (an edit of theirs, written late).
  if (quiet) return;

  // Presence: flash the span that changed and name the nearest heading in a
  // clickable notice. Falls back to a plain notice when there's no locatable
  // span (e.g. a pure deletion, or the range didn't map). Who wrote it is
  // unknown here — an agent, a save from another window, git all arrive the
  // same way — so the notice names no one.
  const flashed = changed ? flashOutsideEdit(changed.text) : false;
  const where = changed?.heading ? `Edited outside this view: §${changed.heading}` : "This document was updated outside this view";
  showNotice(where, flashed);
}

let noticeJump = false;

// Flash a transient one-line notice in the sidebar header, then clear it, so an
// edit arriving from outside the editor (Claude, another window, git) isn't
// silent. With `jumpToChange` the notice is clickable (scrolls to the
// just-edited span) and lingers long enough to click.
function showNotice(text: string, jumpToChange = false): void {
  sidebarState.notice = text;
  noticeJump = jumpToChange;
  renderNotice();
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(
    () => {
      sidebarState.notice = null;
      noticeJump = false;
      noticeTimer = null;
      renderNotice();
    },
    jumpToChange ? 6000 : 2500,
  );
}

// Render the read-only frontmatter panel above the editor. Milkdown would
// turn the `---` fences into thematic breaks and corrupt the YAML on save, so
// the frontmatter is kept out of the body and surfaced here instead.
function renderFrontmatter(raw: string): void {
  if (!frontmatterEl) return;
  const text = (raw ?? "").replace(/\n+$/, "");
  if (!text.trim()) {
    frontmatterEl.hidden = true;
    frontmatterEl.textContent = "";
    return;
  }
  frontmatterEl.hidden = false;
  frontmatterEl.innerHTML =
    `<div class="mdc-frontmatter-head">` +
    `<span class="mdc-frontmatter-label">Frontmatter</span>` +
    `<span class="mdc-frontmatter-hint">read-only — edit in the plain text editor</span>` +
    `</div>` +
    `<pre class="mdc-frontmatter-body">${escapeHtml(text)}</pre>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^\w-]/g, (c) => `\\${c}`);
}

function postError(stage: string, err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  vscode.postMessage({ type: "webview-error", stage, message });
}

window.addEventListener("error", (e) => postError("uncaught", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => postError("unhandled-rejection", e.reason));

document.addEventListener("keydown", (e) => {
  const isCmdOrCtrl = e.metaKey || e.ctrlKey;
  if (isCmdOrCtrl && e.shiftKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault();
    e.stopPropagation();
    openComposerForCurrentSelection();
  }
});

// A suggestion's highlight scrolls the sidebar to its card, as a thread's does
// (that one goes through the highlight plugin's click handler).
document.addEventListener("click", (e) => {
  const mark = (e.target as HTMLElement | null)?.closest<HTMLElement>(".mdc-anchor-highlight--suggestion");
  const anchorId = mark?.getAttribute("data-suggestion-id");
  if (anchorId) threadSidebar.revealSuggestion(anchorId);
});

document.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement | null)?.closest("a[href]");
  if (!target) return;
  if (target.closest(".mc-composer")) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return;
  const href = (target as HTMLAnchorElement).getAttribute("href") || "";
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  if (href.startsWith("#")) {
    scrollEditorToFragment(href.slice(1));
    return;
  }
  vscode.postMessage({ type: "open-link", href });
});

function scrollEditorToFragment(fragment: string): void {
  if (!fragment || !editor) return;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* malformed escape — match the raw form */
  }
  editor.action((ctx) => {
    const root = ctx.get(editorViewCtx).dom as HTMLElement;
    const byId = root.querySelector<HTMLElement>(`[id="${cssEscape(decoded)}"]`);
    if (byId) {
      smoothScrollIntoView(byId, "start");
      return;
    }
    for (const h of Array.from(root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"))) {
      if (slugifyHeading(h.textContent || "") === decoded) {
        smoothScrollIntoView(h, "start");
        return;
      }
    }
  });
}

window.addEventListener("message", (e: MessageEvent<IncomingMessage>) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    // A second `init` is a mode switch: rebuild the editor, after the first if it's still building.
    initQueue = initQueue.then(async () => {
      const stage = editor ? "reinit" : "init";
      try {
        await (editor ? reinitEditor(msg) : init(msg));
      } catch (err) {
        postError(stage, err);
      }
    });
  } else if (msg.type === "externalChange") {
    // After any `init` still building: applied to no editor, the change and
    // its epoch would be lost, and every later edit would carry the old one.
    initQueue = initQueue
      .then(() => applyExternalChange(msg.text, msg.changed, msg.epoch, msg.toast, msg.quiet, msg.reveal))
      .catch((err) => postError("externalChange", err));
  } else if (msg.type === "frontmatter") {
    renderFrontmatter(msg.frontmatter);
  } else if (msg.type === "line-map") {
    lineMap = Array.isArray(msg.lineMap) ? msg.lineMap : null;
  applyLineNumberLayout();
    refreshLineNumbers();
  } else if (msg.type === "sidecar-changed") {
    sidebarState.comments = msg.comments ?? [];
    sidebarState.suggestions = msg.suggestions ?? [];
    takeSidebarPush(msg);
    // Highlights before the sidebar: rendering it can reveal a thread in the
    // document (an agent's first new thread after a review request), and in
    // Reading mode that jump finds its anchor through these decorations.
    forceHighlightRefresh();
    forceSuggestionHighlightRefresh();
    renderSidebar();
    currentDiff = msg.diff ?? null;
    forceDiffRefresh();
  } else if (msg.type === "add-comment-result") {
    if (msg.ok) {
      addComposer = null;
      if (composerEl) composerEl.innerHTML = "";
      showToast("Comment added.");
      // Belt-and-suspenders: re-run the anchor highlight once the doc has
      // settled (the sidecar-changed refresh can fire before a save-participant
      // re-seed lands), so a fresh comment's highlight shows immediately.
      requestAnimationFrame(() => forceHighlightRefresh());
    } else {
      addComposer?.setError(`Could not save comment: ${msg.error ?? "unknown error"}`);
      showToast(`Could not save comment: ${msg.error ?? "unknown error"}`);
    }
  } else if (msg.type === "reply-comment-result") {
    // Only the older reply message gets a result; the sidebar's `reply` shows
    // up in the next push instead.
    if (msg.ok) showToast("Reply sent.");
    else showToast(`Reply failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "toggle-resolve-result") {
    if (!msg.ok) showToast(`Resolve failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "delete-comment-result") {
    if (!msg.ok) showToast(`Delete failed: ${msg.error ?? "unknown error"}`);
  } else if (msg.type === "open-link-result") {
    if (!msg.ok) showToast(`Could not open link: ${msg.reason ?? msg.href}`);
  } else if (msg.type === "drawio-read-result") {
    handleDrawioReadResult(msg);
  } else if (msg.type === "skill-status") {
    threadSidebar.setSkillStatus(msg.status);
  } else if (msg.type === "review-pending") {
    threadSidebar.notifyReviewPending(msg.existingIds);
  } else if (msg.type === "send-result") {
    // Only what the host confirmed: nothing is claimed about the file before it answers.
    // Names the agent only when the file shows one has written here.
    const agent = sidebarPush.agentName || "your agent";
    const saved = msg.saved && !readOnly ? " — your edits are saved to disk" : "";
    if (msg.outcome === "delivered") showNotice(`Sent to ${agent}${saved}`);
    else if (msg.outcome === "copied") showNotice(`Copied — paste it into your agent${saved}`);
  } else if (msg.type === "reveal-thread") {
    // After any `init` still building: the thread has to be in the list, and
    // its highlight in the document.
    const threadId = msg.threadId;
    initQueue = initQueue.then(() => revealThreadFromHost(threadId)).catch((err) => postError("reveal-thread", err));
  }
});

// VS Code webviews lose document focus the moment the user clicks any
// outer chrome (file tree, terminal, another editor). The next click
// back into the webview is then consumed as a focus-capture gesture
// before its own handler runs — every button feels like it needs two
// clicks. Pre-empt that by stealing focus back the instant the pointer
// re-enters or presses anywhere inside the iframe. Capture phase + no
// preventDefault keeps it transparent to the actual click flow.
window.addEventListener(
  "pointerdown",
  () => {
    if (!document.hasFocus()) window.focus();
  },
  true,
);
window.addEventListener(
  "mouseenter",
  () => {
    if (!document.hasFocus()) window.focus();
  },
  true,
);

// Test seam for the edit-mode gate (webview-e2e/blockSplice.spec.ts). The
// harness defines `__mcTestHooks` before this bundle loads; VS Code never
// does, so in the product none of this exists.
const testHooks = (window as unknown as { __mcTestHooks?: Record<string, unknown> }).__mcTestHooks;
if (testHooks) {
  /**
   * For every top-level block, the `edit-blocks` message typing `ch` at the end
   * of its last text would post: the transaction a keystroke dispatches,
   * applied to a copy of the state (plugins' appended transactions included)
   * and diffed and serialized by the live path. A block with no text (a rule)
   * is selected and typed over, as a keystroke would.
   */
  testHooks.typeAtEveryBlockEnd = (ch: string) => {
    const out: Array<{ index: number; type: string; how: "end" | "selected"; message: BlockEditsMessage | null }> = [];
    editor?.action((ctx) => {
      const state = ctx.get(editorViewCtx).state;
      const serializer = ctx.get(serializerCtx);
      const base = editBaseDoc ?? state.doc;
      let offset = 0;
      markdownBlockNodes(state.doc).forEach((node, index) => {
        let end = node.isTextblock ? offset + 1 + node.content.size : -1;
        node.descendants((child, rel) => {
          if (child.isTextblock) end = offset + 1 + rel + 1 + child.content.size;
          return true;
        });
        const tr =
          end >= 0
            ? state.tr.insertText(ch, end)
            : state.tr.setSelection(NodeSelection.create(state.doc, offset)).insertText(ch);
        const message = blockEditsBetween(base, state.apply(tr).doc, serializer);
        out.push({ index, type: node.type.name, how: end >= 0 ? "end" : "selected", message });
        offset += node.nodeSize;
      });
    });
    return out;
  };
}

vscode.postMessage({ type: "ready" });
