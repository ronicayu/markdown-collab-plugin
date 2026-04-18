// Minimal stub for the `vscode` module so that pure helpers inside
// commentController.ts (which statically imports `vscode`) can still be unit-
// tested under Node + vitest. Only the surface our pure helpers transitively
// touch at import time needs to exist here. Anything VS Code-runtime-specific
// is exported as a no-op/class so that `new` / property access doesn't crash
// when the file is merely imported.

/* eslint-disable @typescript-eslint/no-explicit-any */

class Disposable {
  dispose(): void {
    /* noop */
  }
}

class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable();
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

class Position {
  constructor(public line: number, public character: number) {}
}

class Range {
  start: Position;
  end: Position;
  constructor(
    startLine: number | Position,
    startChar: number | Position,
    endLine?: number,
    endChar?: number,
  ) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine as number, endChar as number);
    }
  }
  isEqual(other: Range): boolean {
    return (
      this.start.line === other.start.line &&
      this.start.character === other.start.character &&
      this.end.line === other.end.line &&
      this.end.character === other.end.character
    );
  }
}

class MarkdownString {
  constructor(public value: string = "") {}
}

class ThemeIcon {
  constructor(public id: string) {}
}

class RelativePattern {
  constructor(public base: any, public pattern: string) {}
}

const CommentMode = { Editing: 0, Preview: 1 } as const;
const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 } as const;
const CommentThreadState = { Unresolved: 0, Resolved: 1 } as const;
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

const noopDisposable = new Disposable();

// Hook points for tests to install fakes without monkey-patching Uri/window.
// Each test resets this by re-assigning the relevant property.
type WatcherFake = {
  onDidCreate: (cb: (uri: any) => void) => Disposable;
  onDidChange: (cb: (uri: any) => void) => Disposable;
  onDidDelete: (cb: (uri: any) => void) => Disposable;
  dispose: () => void;
};

const workspace = {
  textDocuments: [] as any[],
  workspaceFolders: undefined as any,
  getWorkspaceFolder: (_uri: any) => undefined as any,
  onDidOpenTextDocument: () => noopDisposable,
  onDidCloseTextDocument: () => noopDisposable,
  onDidSaveTextDocument: () => noopDisposable,
  onDidRenameFiles: () => noopDisposable,
  onDidChangeWorkspaceFolders: () => noopDisposable,
  openTextDocument: async () => undefined,
  findFiles: async (_pattern: any) => [] as any[],
  asRelativePath: (p: string) => p,
  createFileSystemWatcher: (_glob: string): WatcherFake => ({
    onDidCreate: () => noopDisposable,
    onDidChange: () => noopDisposable,
    onDidDelete: () => noopDisposable,
    dispose: () => undefined,
  }),
};

const window = {
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: () => noopDisposable,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  createOutputChannel: () => ({
    appendLine: () => undefined,
    append: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  createTreeView: () => ({ dispose: () => undefined }),
  showTextDocument: async () => undefined,
};

const comments = {
  createCommentController: (_id: string, _label: string) => ({
    commentingRangeProvider: undefined as any,
    createCommentThread: (_uri: any, _range: any, _cs: any[]) => ({
      uri: _uri,
      range: _range,
      comments: [] as any[],
      collapsibleState: 0,
      canReply: true,
      state: 0,
      label: "",
      contextValue: "",
      dispose: () => undefined,
    }),
    dispose: () => undefined,
  }),
};

const commands = {
  registerCommand: () => noopDisposable,
  executeCommand: async () => undefined,
};

const env = {
  clipboard: {
    writeText: async () => undefined,
  },
};

const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
  parse: (s: string) => ({ fsPath: s, toString: () => s }),
};

class TreeItem {
  constructor(public label: string, public collapsibleState?: number) {}
}

export {
  Disposable,
  EventEmitter,
  Position,
  Range,
  MarkdownString,
  ThemeIcon,
  RelativePattern,
  CommentMode,
  CommentThreadCollapsibleState,
  CommentThreadState,
  TreeItemCollapsibleState,
  TreeItem,
  Uri,
  workspace,
  window,
  comments,
  commands,
  env,
};
