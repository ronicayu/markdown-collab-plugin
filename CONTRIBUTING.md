# Contributing

## Building and testing

```bash
npm install
npm run compile
npm test
```

Three suites, all run in CI and again on every tag:

```bash
npm test                   # Vitest — pure helpers, format engine, prompts
npm run test:integration   # a real Extension Host: TextDocuments, WorkspaceEdits, undo
npm run test:webview       # the shipped webview bundles in Chromium, driven by a real pointer
```

The VS Code API surface is stubbed in `src/test/vscode-stub.ts` for tests of pure helpers.
Press **F5** to launch an Extension Development Host for the handful of things no harness
reaches (explorer context menus, the plugin install flow, a live Claude session).

`npm run compile` also regenerates `plugin/` (the Claude Code plugin) and
`.claude-plugin/marketplace.json` from `src/skillText.ts`, the CLI bundle, and the version in
`package.json`. Both are committed, because the GitHub marketplace serves them straight from
the repository; CI fails if they drift from a fresh generation.

`npm run verify:keys` launches the downloaded VS Code build and presses the contributed chords
for real, from the text editor and from inside the review view's webview. Nothing else can
reach that layer: the Extension Host suite can't press keys, and the Chromium harness has no
VS Code keybinding service. Run it after touching the keybindings or the webview's key handling.

The two GIFs in `media/gifs/` are recorded from the webview harness with `npm run record:gifs`
(needs `ffmpeg`). Re-record them after a change to the review view rather than editing them.

To produce a `.vsix`:

```bash
npx @vscode/vsce package
node scripts/verify-package.mjs markdown-collab-plugin-*.vsix
```

## Releasing

Bump the version in `package.json`, prepend a `## X.Y.Z — <date>` block to `CHANGELOG.md`,
run `npm run compile` so the plugin manifests pick up the version, commit, then tag `vX.Y.Z`
and push the tag. Run `node scripts/release-checklist.mjs` first: it prints where the tag
will publish and fails on anything a script can decide.

The release commit's subject line picks the destination:

| Marker in the commit | What the tag does |
|---|---|
| `[skip-publish]` | GitHub Release with the `.vsix`. Nothing goes public. |
| `[pre-release]` | **Publishes publicly** to the VS Code Marketplace and Open VSX pre-release channels. Users who opted into pre-releases get it as an auto-update; everyone else stays on stable. |
| *(neither)* | **Publishes publicly** as a stable release to both marketplaces. |

A marketplace version must be plain `x.y.z`, so the channel can't be encoded in the tag
name; it lives in the commit message.

The workflow refuses to publish unless the tag matches `package.json`, the CHANGELOG has a
non-empty section for that version, the committed plugin matches a fresh generation, all
three test suites pass, and `verify-package` is happy with the built `.vsix`.
