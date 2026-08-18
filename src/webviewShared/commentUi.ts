// Shared comment-panel UI builders.
//
// Plain-DOM, framework-agnostic builders for the pieces every comment panel
// needs — a composer (textarea + submit/cancel + status) and a comment card
// (author / time / body / actions). Imported by the inline-comments, PR/MR
// review, and live-collab webviews so the three surfaces render the same
// markup and pick up the shared `comments.css` styles. No view-specific data
// models leak in here: callers pass strings + callbacks.

import type MarkdownIt from "markdown-it";
import { createCommentRenderer } from "./markdownPipeline";
import { formatRelativeTime } from "../collab/relativeTime";

export interface ComposerHandle {
  /** The composer root element to mount. */
  el: HTMLElement;
  /** The textarea, for callers that need focus / value access. */
  textarea: HTMLTextAreaElement;
  /** Put the composer into a "submitting" state (disables input + shows status). */
  setBusy(message: string): void;
  /** Re-enable after a failed submit and surface an error inline. */
  setError(message: string): void;
}

export interface ComposerOptions {
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  initialValue?: string;
  rows?: number;
  /** Optional one-line note shown above the textarea (e.g. "Comment on lines 3–7"). */
  meta?: string;
  /** Focus the textarea on mount (default true). */
  autofocus?: boolean;
  onSubmit(body: string): void;
  onCancel?(): void;
}

/** Build a shared comment composer. Returns the element plus busy/error helpers. */
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
    cancel.className = "mc-btn mc-btn--ghost";
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
   * `onClick` and shows `busyLabel`. Used for destructive actions (delete)
   * so the confirmation stays on the button itself instead of a dialog.
   */
  confirm?: { confirmLabel?: string; busyLabel?: string; timeoutMs?: number };
}

export interface CommentCardOptions {
  author: string;
  /** ISO-8601 (or epoch ms) — rendered as relative time. Omit to hide. */
  timestamp?: string | number;
  /** Extra muted note in the meta row after the time (e.g. "edited"). */
  note?: string;
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
   * knows: a phase Claude reported over MCP, or the vaguer inferred default
   * (10x-plan-2 P0.2). Omitted means the default.
   */
  pendingLabel?: string;
  /** Render as a nested reply (indented, lighter chrome). */
  reply?: boolean;
  actions?: CardAction[];
  /** Card-level click handler (e.g. reveal the anchored text). */
  onClick?(): void;
}

/**
 * Render a comment body as markdown.
 *
 * Comment bodies have always *been* markdown — Claude writes lists and fenced
 * code into them constantly, and every platform whose comments land here treats
 * them as markdown — but the surfaces showed them three different ways: inline
 * markdown only in the comments view, autolinked plain text in the live editor,
 * and flat text in the PR view. So a reply containing a bulleted list read as
 * a run-on line with stray hyphens in one place and correctly in none.
 *
 * Raw HTML is escaped (`html: false`), so a comment cannot inject markup into
 * the surface displaying it.
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

/** Build a shared comment card (author + relative time + body + actions). */
export function buildCommentCard(opts: CommentCardOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = opts.reply ? "mc-card mc-card--reply" : "mc-card";

  const meta = document.createElement("div");
  meta.className = "mc-card__meta";
  const author = document.createElement("span");
  author.className = "mc-card__author";
  author.textContent = opts.author;
  meta.appendChild(author);
  if (opts.timestamp !== undefined) {
    const time = document.createElement("span");
    time.className = "mc-card__time";
    time.textContent = formatRelativeTime(opts.timestamp);
    meta.appendChild(time);
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
    const dot = document.createElement("span");
    dot.className = "mc-card__pending-dot";
    working.appendChild(dot);
    const label = document.createElement("span");
    label.textContent = opts.pendingLabel ?? "Claude is working\u2026";
    working.appendChild(label);
    card.appendChild(working);
  }

  if (opts.actions && opts.actions.length > 0) {
    const row = document.createElement("div");
    row.className = "mc-card__actions";
    for (const a of opts.actions) {
      const btn = document.createElement("button");
      btn.className = a.variant === "danger" ? "mc-btn mc-btn--link mc-btn--danger" : "mc-btn mc-btn--link";
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
  /** Claude's rationale for the change. */
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
  /** Card-level click, e.g. scroll to the anchored text. */
  onClick?(): void;
}

/**
 * A pending suggestion rendered as an inline diff (original struck through,
 * proposed inserted) with Accept / Reject. The changed middle is emphasized
 * against a plain common prefix/suffix so a small edit reads at a glance.
 */
export function buildSuggestionCard(opts: SuggestionCardOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = "mc-card mc-suggestion";

  const meta = document.createElement("div");
  meta.className = "mc-card__meta";
  const author = document.createElement("span");
  author.className = "mc-card__author";
  author.textContent = opts.author;
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
  card.appendChild(meta);

  card.appendChild(buildDiff(opts.original, opts.proposed));

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
  reject.className = "mc-btn mc-btn--ghost";
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

/** Build the two-row original→proposed diff with the changed middle emphasized. */
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
 * Two-step confirm on a button, in place: first click arms it (swaps the
 * label, auto-disarms after a timeout); a second click while armed fires the
 * action and shows a busy label. Shared so every view's destructive actions
 * confirm the same way.
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
