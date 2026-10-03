# Editing mode: one owner per key (0.35.22)

Two reports, one cause.

- **Cmd+Z "always scrolls to the end of the doc".**
- **Cmd+B makes text bold and also toggles the side bar.**

A keydown inside a webview is handled by the page, and is then forwarded to
the workbench, which resolves its own keybinding for it. So in Editing mode:

| key | the editor did | the workbench also did |
| --- | --- | --- |
| Cmd+B | toggle bold | toggle the side bar |
| Cmd+Shift+B | blockquote | Run Build Task |
| Cmd+I, Cmd+E | italic, inline code | whatever the host binds (in Cursor, its agent panes) |
| Cmd+Z | ProseMirror undo | `undo` → the custom editor's document undo |

Cmd+Z therefore ran **two undo systems**: ProseMirror's history in the page,
and VS Code's undo of the text document. The document undo changed the file,
the host saw a change it had not written and pushed it back as an outside
change — announced as "Claude updated this document" — and the page applied
it by replacing the whole document. ProseMirror maps undo history through
every step; a whole-document replacement maps all of it onto the end of the
new document. The next Cmd+Z undid nothing locally and put the cursor, and
the scroll, at the end of the file.

## Decisions

1. **The file's undo history is the only one.** It already holds everything
   the product calls undoable: typing (each block edit is a `WorkspaceEdit`),
   "Accept all N — one undo step", an agent's edit through the tools. The
   page's own ProseMirror history goes. Cmd+Z in the Markdown Collab view
   undoes the last change to the file, as it does in the text editor.
2. **An outside change is applied as the smallest replacement,** never the
   whole document, so the cursor stays on its text.
3. **Keys the editor handles are not also handled by the workbench** while
   the caret is in the editor in Editing mode.

## Page (`src/webview/client.ts`)

### Applying a document from the host — `applyExternalChange`

Replace only what differs, at character precision:

```ts
const start = prev.content.findDiffStart(next.content);
if (start == null) return;                       // same document: dispatch nothing
let { a: endA, b: endB } = prev.content.findDiffEnd(next.content)!;
const overlap = start - Math.min(endA, endB);
if (overlap > 0) { endA += overlap; endB += overlap; }
tr.replace(start, endA, next.slice(start, endB));
```

The result must equal the parsed file: if `!tr.doc.eq(next)` (or `replace`
throws), fall back to replacing the differing run of top-level blocks (the
implementation already in the working tree), and if that does not produce
`next` either, to the whole document. `addToHistory: false` and `external`
metas stay. `resetEditBase(epoch)` still runs, also when nothing was
dispatched.

New optional field on the `externalChange` message: **`reveal: true`** — the
change is the person's own undo or redo. Then, in the same transaction, put
the selection at the end of the replaced range (`endB`, mapped; for a pure
deletion that is the deletion point), `scrollIntoView()`, and do not restore
the previous `scrollTop`. Without `reveal`, behaviour is as now: no
scrolling, previous `scrollTop` restored, the cursor mapped by ProseMirror
(the manual "restore to the old absolute offset" is gone — it moved the
cursor whenever the change was above it).

### Undo and redo keys

- Remove `@milkdown/plugin-history` from the editor (`.use(history)` and the
  import; drop the dependency from `package.json` only if nothing else
  imports it).
- In Editing mode a ProseMirror plugin handles `Mod-z` → undo and
  `Mod-Shift-z` / `Mod-y` → redo, before anything else can:
  `flushBlockEdits()` (so keystrokes still in the debounce reach the file
  first — same message channel, so they arrive first), then
  `vscode.postMessage({ type: "undo" })` / `{ type: "redo" }`, and returns
  `true`. It never changes the document itself; the file's undo comes back
  as an `externalChange` with `reveal`.
- The same plugin cancels `beforeinput` with `inputType` `historyUndo` /
  `historyRedo`, so the browser's own undo can never rewrite ProseMirror's
  DOM. It posts nothing for those.
- Reading mode is untouched: the editor is not editable, Cmd+Z is the
  workbench's, which undoes the file's last change as before.

### Telling the host where the caret is

`{ type: "editor-focus", focused: boolean }`, posted when the ProseMirror
view gains or loses focus in Editing mode, and `focused: false` when the
editor is rebuilt read-only. Coalesce: post only on a change.

## Host (`src/collab/collabEditorProvider.ts`)

- **`undo` / `redo` messages:** through the same queue as block edits
  (`enqueueEdit`), so they run after any edit still being written:
  `if (panel.active) await vscode.commands.executeCommand(msg.type)`. With
  the custom editor active, the workbench's `undo` / `redo` undo the text
  document for that editor. Skipped (logged) when the panel is not the
  active editor — the command acts on whatever is.
- **Change handler (`onDidChangeTextDocument`):** when `e.reason` is
  `TextDocumentChangeReason.Undo` or `.Redo` and the prose changed, push
  `{ type: "externalChange", text, quiet: true, reveal: true }` instead of
  the `changed` summary. This is the person's own action in either mode: no
  "Claude updated…" notice, no flash, and the view goes to the change.
  Everything else in the handler is unchanged.
- **Context key `markdownCollab.liveEditorTyping`:** `setContext` true when
  an `editor-focus` with `focused: true` arrives from the active panel in
  Editing mode; false on `focused: false`, when the panel stops being
  active (`onDidChangeViewState`), on a switch to Reading, and on dispose
  (only if this panel is the one that set it). One helper, called from each
  of those places.

## Manifest (`package.json`)

- Command **`markdownCollab.liveEditor.keyHandledInEditor`** — does nothing.
  Hidden from the Command Palette the way the other internal commands are.
  Registered in `extension.ts` (or the commands module the others live in).
- Keybindings, all `when: markdownCollab.liveEditorTyping`, all to that
  command, so the workbench's own binding does not also run:

  | key | mac | what the editor does with it |
  | --- | --- | --- |
  | `ctrl+z` | `cmd+z` | undo (posts `undo`) |
  | `ctrl+shift+z` | `cmd+shift+z` | redo |
  | `ctrl+y` | — (`when` adds `!isMac`) | redo |
  | `ctrl+b` | `cmd+b` | bold |
  | `ctrl+i` | `cmd+i` | italic |
  | `ctrl+e` | `cmd+e` | inline code |
  | `ctrl+shift+b` | `cmd+shift+b` | blockquote |

  Outside Editing mode, or with the caret outside the document (the sidebar,
  the terminal, the Explorer), the context is false and every key keeps its
  workbench meaning.

## Unchanged on purpose

Block edits, epochs, the write queue's ordering, the safety net, autosave,
`quiet` external changes, the notice and flash for a real outside change,
Reading mode, the classic view, the PR review view.

## Tests

Page (Playwright, `modeToggle.spec.ts` — rework the "undo after an outside
change" block already in the working tree to this model):

- Cmd+Z in Editing mode posts the pending `edit-blocks` first and then
  `{ type: "undo" }`, and the document does not change until the host
  answers. Cmd+Shift+Z and Ctrl+Y post `redo`.
- The host's answer (`externalChange`, `quiet`, `reveal`, the text before
  the keystroke) removes the keystroke, leaves the caret where it was typed,
  and shows no notice.
- With the view scrolled to the bottom, a `reveal` change at the top scrolls
  it into view; without `reveal`, the same change leaves `scrollTop` alone.
- An outside change above the caret leaves the caret on its text (already
  written; keep).
- An `externalChange` with the text the editor already shows dispatches
  nothing (the document node is the same object before and after).
- Round trip: for a handful of before/after documents (edit inside a
  paragraph, insert a paragraph, delete a list item, change a table cell,
  change a heading level) the editor's document after `externalChange`
  serializes to exactly the pushed text.
- `editor-focus` true on focusing the document in Editing mode, false on
  blur and on a switch to Reading; nothing in Reading mode.

Host (vitest, `collabEditorProvider.test.ts`):

- `undo` / `redo` messages call `executeCommand("undo" / "redo")` after a
  block edit queued before them has been written, and not at all when the
  panel is not active.
- A document change with reason Undo / Redo pushes `quiet: true, reveal:
  true` and no `changed`; any other reason pushes `changed` as before.
- The context key follows `editor-focus`, view-state, mode and dispose.

Manifest (the existing manifest/keybinding tests, and the all-commands
list): the new command is declared, registered and hidden; each keybinding
is present with the `when` above.

Integration (real VS Code, `src/test/integration/suite`): with a file open
in the Markdown Collab editor (`vscode.openWith` …
`markdownCollab.collabEditor`), apply a `WorkspaceEdit`, run
`vscode.commands.executeCommand("undo")`, and assert the document text is
back — the assumption the whole design rests on, checked in the real
workbench.

Gates: `npm run compile`, both `tsc` checks, `npx vitest run`, the targeted
Playwright specs (`modeToggle`, `liveEditor`, `liveEditorDiff`,
`uncommittedDiff`, `readOnlyComment`, `blockSplice`, `liveSidebar`).

## As built

- **Verified in a real VS Code with real key presses:**
  `npm run compile && npm run verify:editor-keys`
  (`scripts/verify-editor-keys.mjs`, Playwright's Electron driver, opens a
  window, not part of CI). Sixteen steps: Cmd+B bolds and leaves the side
  bar alone; Cmd+Z undoes the bold, then the typing, in place, with the
  scroll position unchanged, the file following and no "Claude updated"
  notice; Cmd+Shift+Z redoes; with the caret outside the document Cmd+B
  toggles the side bar again.
- The Extension Host suite cannot stand in for that: its window does not
  deliver `undo` at all, for a plain text editor either. The integration
  test added to `collab.test.ts` runs a control first and skips, saying so,
  in such a host.
- An undo or redo is flushed to disk like any edit (`scheduleAutosave`), so
  an agent reading the file sees it.
- `reveal` scrolls even when the document does not hold the focus (an undo
  made from the sidebar, or in Reading mode): a transaction's
  `scrollIntoView` only acts on a focused view, so the changed node is
  scrolled into view directly in that case.
- The page reports `editor-focus: false` on every rebuild of the editor, not
  only a switch to Reading; the keys go back to the workbench until the
  caret is actually in the new view.
- The undo keys are ignored with Alt held: on some layouts AltGr
  (Ctrl+Alt) + a letter types a character.
- The no-op command is registered with the custom editor provider
  (`CollabEditorProvider.register`), two small ProseMirror plugins carry the
  key handling and the focus reports, and the manifest test that requires
  every keybinding to be a `cmd+k` chord exempts this one command: these
  bindings exist to shadow exact native keys.

## Known and accepted

- Undo granularity is one write to the file: a burst of typing ends at a
  pause of about half a second.
- Cmd+Z undoes whatever changed the file last — including an agent's edit
  or an accepted suggestion. That is what "one undo step" has always
  promised, and what the text editor does.
- While the caret is in the document in Editing mode, Cmd+I and Cmd+E are
  italic and inline code, not the host's (Cursor's) bindings.
