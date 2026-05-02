# Real-time Collaborative Editor (experimental)

Branch: `experiment/codemirror-yjs-webview`.

## What this is

A spike to test the **Webview + CodeMirror 6 + Yjs** path discussed in chat.
The existing CommentController-based UI is untouched — this adds a *second*
editor type for `.md` files that opens in a webview instead of Monaco.

```
┌──────────────────────────────────────────────┐
│ VSCode window A         VSCode window B      │
│ ┌──────────────┐       ┌──────────────┐      │
│ │ webview      │       │ webview      │      │
│ │ CodeMirror 6 │ <───> │ CodeMirror 6 │      │
│ │ Yjs doc      │  ws   │ Yjs doc      │      │
│ └──────┬───────┘       └──────┬───────┘      │
│        │ postMessage          │ postMessage  │
│  ┌─────▼──────┐         ┌─────▼──────┐       │
│  │ ext host A │         │ ext host B │       │
│  │ TextDocument          │ TextDocument       │
│  └─────┬──────┘         └─────┬──────┘       │
│        │ FS write             │ FS write     │
│        └──────────► .md ◄─────┘              │
│                                              │
│        ┌────────────────────────────┐        │
│        │ y-websocket relay (port    │        │
│        │ 1234, embedded in ext A)   │        │
│        └────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

## Files added

| File | Role |
|------|------|
| `src/webview/client.ts` | CodeMirror 6 editor + Yjs doc + `y-codemirror.next` binding + `WebsocketProvider`. Bundled via esbuild → `out/webview/client.js` (~592 KB minified). |
| `src/collab/collabEditorProvider.ts` | `CustomTextEditorProvider`. Hosts the webview, ferries init state + edits between webview and `TextDocument`. |
| `src/collab/server.ts` | Minimal `y-websocket`-compatible relay (HTTP + WebSocket, in-memory `Y.Doc` per room). No persistence — the on-disk markdown is the source of truth. Server-side seeding via `?init=<base64>` query param eliminates the first-peer race. |
| `src/collab/seedEncoding.ts` | Shared UTF-8-safe base64 codec used by webview encoder + server decoder. |
| `tsconfig.webview.json` | Type-checks the webview against `DOM` lib (main `tsconfig.json` excludes `src/webview`). |
| `src/test/collabServer.test.ts` | 8 integration tests: two-client sync, room isolation, server-side seeding (incl. unicode), awareness propagation, HTTP probe signature. |
| `src/test/seedEncoding.test.ts` | 5 unit tests: ASCII/unicode/empty/control-byte round-trips + Buffer.from interop. |

`package.json`:
- New custom editor: `markdownCollab.collabEditor` (priority `option`, so the
  default Markdown editor is unchanged — users opt in via Reopen With…).
- New command: `markdownCollab.openCollabEditor`.
- New settings: `markdownCollab.collab.serverUrl`,
  `markdownCollab.collab.startLocalServer`, `markdownCollab.collab.userName`.
- Bundle script: `bundle:webview` (esbuild).

## Smoke test (single machine, two windows)

1. `npm run compile` — produces `out/extension.js` + `out/webview/client.js`.
2. `code --extensionDevelopmentPath=$(pwd)` — opens VSCode window A with the
   extension loaded. The output channel "Markdown Collab" should log
   `y-websocket relay listening on ws://127.0.0.1:1234`.
3. Open any `.md` file. From the file's tab title context menu pick
   **Reopen Editor With…** → **Markdown Collab (real-time, experimental)**.
4. Open a second window B against the same workspace
   (`code --new-window --extensionDevelopmentPath=$(pwd) <folder>`).
   Window B will hit `EADDRINUSE` on port 1234, probe the existing server,
   recognize the relay signature, and reuse it. (No setting toggle needed.)
5. In window B, open the same `.md` and reopen with the collab editor.
6. Type in either window — edits stream to the other within ~50ms; remote
   cursors are colored. The badge in the bottom-right shows
   `connected · N peers`.
7. Close both windows; reopen one. The file content reflects the last edits
   (the `CustomTextEditorProvider` mirrors webview edits back to the
   `TextDocument` and VSCode persists on save).

## Cross-machine

Run the relay anywhere reachable (or expose the local port via tailscale /
ngrok). On each machine:
```jsonc
"markdownCollab.collab.startLocalServer": false,
"markdownCollab.collab.serverUrl": "ws://your-host:1234"
```
Room names are `sha1(absoluteFsPath).slice(0, 16)` — peers must agree on the
absolute path to land in the same room. Different machines with different
checkouts will *not* match unless you normalize that.

## What works (verified by 13 new tests + an end-to-end smoke run)

- Two clients sync edits in both directions through the relay.
- Rooms are isolated (an edit in room A never leaks to room B).
- Server seeds a fresh room from the first client's `?init=...` and ignores
  the param for every later connection — no duplicate-seed race.
- UTF-8 seeding round-trips (CJK, emoji, accented chars all preserved).
- Awareness state (cursors, user info) propagates between peers.
- HTTP probe at `GET /` returns the relay signature, so a second VSCode
  window reliably distinguishes "our relay is already running" from
  "something else is squatting on port 1234".
- Compiled Node smoke run (relay + two real Yjs clients) confirms the
  full lifecycle including dispose.

## Known gaps (deliberate, this is a spike)

- **No persistence in the relay.** If everyone disconnects, the in-memory
  `Y.Doc` is lost. The on-disk file is still authoritative; next time anyone
  opens the file, the first peer reseeds via `?init=`. Adding
  `y-leveldb` would survive restarts but pulls a native dep.
- **No bidirectional CRDT for the on-disk file.** Edits made in the
  *standard* Monaco editor while the collab editor is also open will be
  echoed into the webview as `externalChange` (full replace), losing
  collaborator cursors. The two editor types should not be open at once.
- **Comments are not synced.** The existing `.md.json` sidecar / comment
  controller is wholly separate. If this experiment graduates, comments
  would move into a Y.Map alongside the Y.Text.
- **Bundle size: 592 KB minified** (down from 1.2 MB unminified). Acceptable
  for a webview; further savings would need code-splitting CodeMirror
  language packs.
- **Port 1234 hardcoded.** Collisions are detected and reused if the
  responder is our own relay; an unrelated process on 1234 logs a warning
  and the webview shows `offline`. A future iteration could probe a range
  of ports.

## How to throw it away

Everything is on this branch. To delete:

```
git checkout main
git branch -D experiment/codemirror-yjs-webview
npm uninstall yjs y-websocket y-protocols y-codemirror.next \
  codemirror @codemirror/lang-markdown @codemirror/state \
  @codemirror/view @codemirror/commands esbuild ws @types/ws
```
