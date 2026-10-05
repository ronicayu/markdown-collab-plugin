// Plain-DOM builders shared by every comment panel, so the surfaces render the
// same markup and pick up the shared `comments.css` styles. No view-specific
// data models leak in here: callers pass strings + callbacks.

import type MarkdownIt from "markdown-it";
import { createCommentRenderer } from "./markdownPipeline";
import { formatRelativeTime } from "../collab/relativeTime";
import { agentDisplayName, isAgentComment, WAITING_FOR_AGENT } from "../agentIdentity";
import { diffWords, exceedsTokenCap, isBulkRewrite, MAX_DIFF_TOKENS, suggestionGist } from "./wordDiff";

/**
 * The agent's display name for an agent comment, the author unchanged for a
 * human. `isAgentComment` only has the author string here (the card option
 * doesn't carry the JSON `agent` flag), so it falls back to the known-slug
 * check — every slug this extension has ever written.
 */
function authorLabel(author: string): string {
  return isAgentComment({ author }) ? agentDisplayName(author).noun : author;
}

export interface ComposerHandle {
  el: HTMLElement;
  textarea: HTMLTextAreaElement;
  setBusy(message: string): void;
  setError(message: string): void;
}

export interface ComposerOptions {
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  initialValue?: string;
  rows?: number;
  meta?: string;
  /** Focus the textarea on mount (default true). */
  autofocus?: boolean;
  onSubmit(body: string): void;
  onCancel?(): void;
}

export function buildComposer(opts: ComposerOptions): ComposerHandle {
  const el = document.createElement("div");
  el.className = "mc-composer";

  if (opts.meta) {
    const meta = document.createElement("div");
    meta.className = "mc-composer__meta";
    meta.textContent = opts.meta;
    el.appendChild(meta);
  }

  const textarea = document.createElement("textarea");
  textarea.placeholder = opts.placeholder ?? "Your comment…";
  textarea.rows = opts.rows ?? 3;
  if (opts.initialValue) textarea.value = opts.initialValue;

  const actions = document.createElement("div");
  actions.className = "mc-composer__actions";

  const submit = document.createElement("button");
  submit.className = "mc-btn mc-btn--primary";
  submit.textContent = opts.submitLabel ?? "Comment";
  submit.disabled = textarea.value.trim().length === 0;

  const cancel = opts.onCancel ? document.createElement("button") : null;
  if (cancel) {
    cancel.className = "mc-btn mc-btn--quiet";
    cancel.textContent = opts.cancelLabel ?? "Cancel";
    cancel.addEventListener("click", () => opts.onCancel?.());
  }

  const status = document.createElement("span");
  status.className = "mc-composer__status";

  textarea.addEventListener("input", () => {
    submit.disabled = textarea.value.trim().length === 0;
    status.textContent = "";
    status.classList.remove("mc-composer__status--error");
  });
  submit.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (!body) return;
    opts.onSubmit(body);
  });
  // Consistent keyboard shortcuts in every view: Cmd/Ctrl+Enter submits, Esc cancels.
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !submit.disabled) {
      e.preventDefault();
      submit.click();
    } else if (e.key === "Escape" && opts.onCancel) {
      e.preventDefault();
      opts.onCancel();
    }
  });

  actions.appendChild(submit);
  if (cancel) actions.appendChild(cancel);
  actions.appendChild(status);
  el.append(textarea, actions);

  if (opts.autofocus !== false) requestAnimationFrame(() => textarea.focus());

  return {
    el,
    textarea,
    setBusy(message: string): void {
      submit.disabled = true;
      if (cancel) cancel.disabled = true;
      textarea.disabled = true;
      status.classList.remove("mc-composer__status--error");
      status.textContent = message;
    },
    setError(message: string): void {
      submit.disabled = textarea.value.trim().length === 0;
      if (cancel) cancel.disabled = false;
      textarea.disabled = false;
      status.classList.add("mc-composer__status--error");
      status.textContent = message;
    },
  };
}

export interface CardAction {
  label: string;
  onClick(): void;
  variant?: "link" | "danger";
  title?: string;
  /**
   * Two-step confirm. The first click swaps the button label to
   * `confirmLabel` for `timeoutMs`; a second click within that window fires
   * `onClick` and shows `busyLabel`.
   */
  confirm?: { confirmLabel?: string; busyLabel?: string; timeoutMs?: number };
}

export interface CommentCardOptions {
  author: string;
  /** ISO-8601 (or epoch ms) — rendered as relative time. Omit to hide. */
  timestamp?: string | number;
  note?: string;
  /**
   * How this comment reached the file — "via tools" / "via cli" / "via file".
   * Agent comments only; the caller gates this on its own `isAgentComment`
   * check and omits it for a human's comment. `title` is the one-sentence
   * explanation shown as a tooltip.
   */
  via?: { label: string; title: string };
  /** Plain-text body. Rendered as text (callers that want markdown set `bodyEl`). */
  body?: string;
  /** Pre-rendered body element (e.g. markdown HTML), used instead of `body`. */
  bodyEl?: HTMLElement;
  badges?: string[];
  /**
   * Claude has been sent this thread and hasn't replied yet. Renders a muted
   * row under the body — deliberately in the card rather than a toast, because
   * the wait belongs to a specific thread and the human is looking at the list,
   * not at the corner of the screen.
   */
  pending?: boolean;
  /**
   * What that row says. The host decides the wording from how much it actually
   * knows: a phase Claude reported over MCP, or the vaguer inferred default.
   * Omitted means the default.
   */
  pendingLabel?: string;
  /**
   * Announce the pending row to screen readers as it changes. Off by default:
   * the pending row is shared by all three review surfaces, but only the inline
   * view asked for the live announcement.
   */
  pendingAriaLive?: boolean;
  reply?: boolean;
  actions?: CardAction[];
  onClick?(): void;
}

/**
 * Render a comment body as markdown. Raw HTML is escaped (`html: false`), so a
 * comment cannot inject markup into the surface displaying it.
 */
export function buildCommentBody(body: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "mc-card__body-md";
  el.innerHTML = commentRenderer().render(body);
  return el;
}

let sharedCommentRenderer: MarkdownIt | null = null;
function commentRenderer(): MarkdownIt {
  if (!sharedCommentRenderer) sharedCommentRenderer = createCommentRenderer();
  return sharedCommentRenderer;
}

export function buildCommentCard(opts: CommentCardOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = opts.reply ? "mc-card mc-card--reply" : "mc-card";

  const meta = document.createElement("div");
  meta.className = "mc-card__meta";
  const author = document.createElement("span");
  author.className = "mc-card__author";
  author.textContent = authorLabel(opts.author);
  meta.appendChild(author);
  if (opts.timestamp !== undefined) {
    const time = document.createElement("span");
    time.className = "mc-card__time";
    time.textContent = formatRelativeTime(opts.timestamp);
    meta.appendChild(time);
  }
  if (opts.via) {
    const via = document.createElement("span");
    via.className = "mc-card__via";
    via.textContent = opts.via.label;
    via.title = opts.via.title;
    meta.appendChild(via);
  }
  if (opts.note) {
    const note = document.createElement("span");
    note.className = "mc-card__time";
    note.textContent = `· ${opts.note}`;
    meta.appendChild(note);
  }
  for (const b of opts.badges ?? []) {
    const badge = document.createElement("span");
    badge.className = b.toLowerCase() === "resolved" ? "mc-badge mc-badge--resolved" : "mc-badge";
    badge.textContent = b;
    meta.appendChild(badge);
  }
  card.appendChild(meta);

  const bodyEl = opts.bodyEl ?? (() => {
    const d = document.createElement("div");
    d.textContent = opts.body ?? "";
    return d;
  })();
  bodyEl.classList.add("mc-card__body");
  card.appendChild(bodyEl);

  if (opts.pending) {
    const working = document.createElement("div");
    working.className = "mc-card__pending";
    if (opts.pendingAriaLive) {
      working.setAttribute("role", "status");
      working.setAttribute("aria-live", "polite");
    }
    const dot = document.createElement("span");
    dot.className = "mc-card__pending-dot";
    working.appendChild(dot);
    const label = document.createElement("span");
    label.textContent = opts.pendingLabel ?? WAITING_FOR_AGENT;
    working.appendChild(label);
    card.appendChild(working);
  }

  if (opts.actions && opts.actions.length > 0) {
    const row = document.createElement("div");
    row.className = "mc-card__actions";
    for (const a of opts.actions) {
      const btn = document.createElement("button");
      btn.className = a.variant === "danger" ? "mc-btn mc-btn--quiet mc-btn--danger" : "mc-btn mc-btn--quiet";
      btn.textContent = a.label;
      if (a.title) btn.title = a.title;
      btn.addEventListener("click", (e) => {
        // Don't let an action bubble to a card-level click handler.
        e.stopPropagation();
        if (a.confirm) armConfirm(btn, a.confirm, a.onClick);
        else a.onClick();
      });
      row.appendChild(btn);
    }
    card.appendChild(row);
  }

  if (opts.onClick) {
    card.style.cursor = "pointer";
    card.addEventListener("click", opts.onClick);
  }

  return card;
}

export interface SuggestionCardOptions {
  author: string;
  timestamp?: string | number;
  note?: string;
  /** Current text (shown struck through). */
  original: string;
  /** Proposed replacement (shown as an insertion). */
  proposed: string;
  /**
   * False when the suggestion lost its anchor markers — the change can no
   * longer be placed, so Accept is disabled and only Reject remains.
   */
  anchored?: boolean;
  onAccept(): void;
  onReject(): void;
  onClick?(): void;
  /**
   * Collapse support. Omitted (as the classic panel always omits it), the card
   * has no collapse chrome at all. Given, `collapsed` is the card's current
   * state and `onToggleCollapse` fires from the chevron or (while collapsed)
   * the header; the caller owns the actual state, the same way
   * `onAccept`/`onReject` don't mutate anything themselves.
   */
  collapsed?: boolean;
  onToggleCollapse?(): void;
}

export function buildSuggestionCard(opts: SuggestionCardOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = "mc-card mc-suggestion";
  const collapsible = !!opts.onToggleCollapse;
  if (collapsible) card.classList.toggle("collapsed", !!opts.collapsed);

  const meta = document.createElement("div");
  meta.className = "mc-card__meta";
  const author = document.createElement("span");
  author.className = "mc-card__author";
  author.textContent = authorLabel(opts.author);
  meta.appendChild(author);
  const verb = document.createElement("span");
  verb.className = "mc-card__time";
  verb.textContent = "suggests an edit";
  meta.appendChild(verb);
  if (opts.timestamp !== undefined) {
    const time = document.createElement("span");
    time.className = "mc-card__time";
    time.textContent = formatRelativeTime(opts.timestamp);
    meta.appendChild(time);
  }
  const badge = document.createElement("span");
  badge.className = "mc-badge mc-badge--suggestion";
  badge.textContent = "suggestion";
  meta.appendChild(badge);

  if (collapsible) {
    // A one-line gist stands in for the meta row while collapsed
    // (threadSidebar.css swaps the two on `.mc-suggestion.collapsed`), with the
    // chevron at the row's right edge.
    const headRow = document.createElement("div");
    headRow.className = "mc-suggestion__head";
    headRow.appendChild(meta);
    const summary = document.createElement("div");
    summary.className = "mc-suggestion__summary";
    summary.textContent = `Suggestion · ${authorLabel(opts.author)} · ${suggestionGist(opts.original, opts.proposed)}`;
    headRow.appendChild(summary);
    const chevron = buildCollapseToggle({
      extraClass: "mc-suggestion__collapse thread-collapse",
      ariaLabel: "Collapse or expand this suggestion",
      title: "Collapse / expand this suggestion",
      expanded: !opts.collapsed,
      onToggle: (e) => {
        e.stopPropagation();
        opts.onToggleCollapse!();
      },
    });
    headRow.appendChild(chevron);
    // While collapsed the header is effectively the whole card, so clicking
    // anywhere in it (the chevron handles its own click) expands. Expanded, a
    // click here is left to bubble to the card's own `onClick` (reveal in the
    // document) instead: folding the card back up from under someone reading it
    // would be a bad surprise for a plain click.
    headRow.addEventListener("click", (e) => {
      if (!card.classList.contains("collapsed")) return;
      e.stopPropagation();
      opts.onToggleCollapse!();
    });
    card.appendChild(headRow);
  } else {
    card.appendChild(meta);
  }

  card.appendChild(buildSuggestionDiff(opts.original, opts.proposed));

  if (opts.note) {
    // Claude's rationale, which is prose it writes like any other comment.
    const note = buildCommentBody(opts.note);
    note.classList.add("mc-suggestion__note");
    card.appendChild(note);
  }

  const actions = document.createElement("div");
  actions.className = "mc-card__actions";
  const accept = document.createElement("button");
  accept.className = "mc-btn mc-btn--primary";
  accept.textContent = "Accept";
  if (opts.anchored === false) {
    accept.disabled = true;
    accept.title = "This suggestion lost its anchor and can't be applied — reject it.";
  }
  accept.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onAccept();
  });
  const reject = document.createElement("button");
  reject.className = "mc-btn mc-btn--quiet";
  reject.textContent = "Reject";
  reject.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onReject();
  });
  actions.append(accept, reject);
  card.appendChild(actions);

  if (opts.onClick) {
    card.style.cursor = "pointer";
    card.addEventListener("click", opts.onClick);
  }
  return card;
}

/**
 * The suggestion's diff, in whichever form fits it. A small edit renders as one
 * paragraph with the changed words struck through / inserted in place.
 * `isBulkRewrite` decides which form is the default; either way a toggle lets
 * the human switch, because the ratio guess is exactly that, a guess.
 *
 * The inline view is never built until it's actually shown: `buildInlineDiff`
 * walks `diffWords`' O(n·m) LCS table, and building it unconditionally — even
 * while the block view was the one on screen — let a huge pasted-in suggestion
 * freeze the webview on every render. Past `exceedsTokenCap`, it's never built
 * at all; the toggle itself is disabled so no click can trigger it either.
 */
function buildSuggestionDiff(original: string, proposed: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mc-suggestion__diffwrap";

  const blockEl = buildDiff(original, proposed);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "mc-btn mc-btn--link mc-suggestion__toggle";
  wrap.append(blockEl, toggle);

  if (exceedsTokenCap(original) || exceedsTokenCap(proposed)) {
    blockEl.hidden = false;
    toggle.disabled = true;
    toggle.textContent = "Show inline";
    toggle.title = `This suggestion is too large to diff word by word (over ${MAX_DIFF_TOKENS} words on one side) — showing the full old/new text instead.`;
    return wrap;
  }

  let inlineEl: HTMLElement | null = null;
  let showInline = !isBulkRewrite(original, proposed);
  const applyMode = (): void => {
    if (showInline && !inlineEl) {
      inlineEl = buildInlineDiff(original, proposed);
      wrap.insertBefore(inlineEl, blockEl);
    }
    if (inlineEl) inlineEl.hidden = !showInline;
    blockEl.hidden = showInline;
    toggle.textContent = showInline ? "Show old / new" : "Show inline";
    toggle.title = showInline
      ? "Show the change as two full paragraphs instead of one."
      : "Show the change as one sentence with the edited words marked.";
  };
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    showInline = !showInline;
    applyMode();
  });
  applyMode();

  return wrap;
}

/**
 * One paragraph with the changed words wrapped in real `<del>`/`<ins>`
 * elements — the common-word parts render as plain text in between, so a
 * one-word change reads inside the sentence instead of as a doubled block.
 */
function buildInlineDiff(original: string, proposed: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "mc-suggestion__sentence";
  for (const op of diffWords(original, proposed)) {
    if (op.kind === "equal") {
      p.appendChild(document.createTextNode(op.text));
      continue;
    }
    const el = document.createElement(op.kind === "del" ? "del" : "ins");
    el.textContent = op.text;
    p.appendChild(el);
  }
  return p;
}

function buildDiff(original: string, proposed: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mc-suggestion__diff";

  let pre = 0;
  while (pre < original.length && pre < proposed.length && original[pre] === proposed[pre]) pre++;
  let suf = 0;
  while (
    suf < original.length - pre &&
    suf < proposed.length - pre &&
    original[original.length - 1 - suf] === proposed[proposed.length - 1 - suf]
  ) {
    suf++;
  }

  wrap.appendChild(diffRow("del", original, pre, suf));
  wrap.appendChild(diffRow("ins", proposed, pre, suf));
  return wrap;
}

function diffRow(kind: "del" | "ins", text: string, pre: number, suf: number): HTMLElement {
  const row = document.createElement("div");
  row.className = `mc-suggestion__${kind}`;
  const midEnd = text.length - suf;
  const prefix = text.slice(0, pre);
  const middle = text.slice(pre, midEnd);
  const suffix = text.slice(midEnd);
  if (prefix) row.appendChild(document.createTextNode(prefix));
  if (middle) {
    const chg = document.createElement("span");
    chg.className = "mc-suggestion__chg";
    chg.textContent = middle;
    row.appendChild(chg);
  }
  if (suffix) row.appendChild(document.createTextNode(suffix));
  return row;
}

/**
 * Chevron markup for every card's collapse toggle — points down; CSS
 * (comments.css) turns it to point left when the button's `aria-expanded` is
 * false, so the caller only has to keep that attribute current.
 */
const COLLAPSE_CHEVRON_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5l4 4 4-4"/></svg>';

/**
 * The collapse-toggle button used by a thread card (threadSidebar.ts) and this
 * module's own suggestion card: one shared icon and styling, so every card's
 * fold control reads as the same control regardless of which webview mounts it.
 */
export function buildCollapseToggle(opts: {
  /** Extra class(es) the caller still keys its own CSS/selectors off (e.g. "thread-collapse"). */
  extraClass: string;
  ariaLabel: string;
  title: string;
  expanded: boolean;
  onToggle(e: MouseEvent): void;
}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `mc-icon-btn mc-icon-btn--sm ${opts.extraClass}`;
  btn.title = opts.title;
  btn.setAttribute("aria-label", opts.ariaLabel);
  btn.setAttribute("aria-expanded", String(opts.expanded));
  btn.innerHTML = COLLAPSE_CHEVRON_SVG;
  btn.addEventListener("click", opts.onToggle);
  return btn;
}

/**
 * Two-step confirm on a button, in place: first click arms it (swaps the
 * label, auto-disarms after a timeout); a second click while armed fires the
 * action and shows a busy label.
 */
function armConfirm(
  btn: HTMLButtonElement,
  opts: NonNullable<CardAction["confirm"]>,
  action: () => void,
): void {
  if (btn.dataset.armed === "1") {
    action();
    btn.textContent = opts.busyLabel ?? "…";
    btn.disabled = true;
    return;
  }
  const original = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = opts.confirmLabel ?? "Confirm?";
  window.setTimeout(() => {
    if (btn.isConnected && btn.dataset.armed === "1") {
      btn.dataset.armed = "";
      btn.textContent = original;
    }
  }, opts.timeoutMs ?? 3000);
}
