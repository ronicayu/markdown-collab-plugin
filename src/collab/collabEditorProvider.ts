import * as crypto from "crypto";
import * as os from "os";
import * as vscode from "vscode";

const VIEW_TYPE = "markdownCollab.collabEditor";

interface InitPayload {
  type: "init";
  text: string;
  room: string;
  serverUrl: string;
  user: { name: string; color: string };
}

interface EditMessage {
  type: "edit";
  text: string;
}

interface ReadyMessage {
  type: "ready";
}

interface ReadyWithContentMessage {
  type: "ready-with-content";
  length: number;
  synced: boolean;
  error?: string;
}

interface WebviewErrorMessage {
  type: "webview-error";
  stage: string;
  message: string;
}

type ClientMessage =
  | EditMessage
  | ReadyMessage
  | ReadyWithContentMessage
  | WebviewErrorMessage;

// Test-only observability. The webview reports its post-init content
// length (and whether the relay sync succeeded) via the
// `ready-with-content` message. Tests can read this map to assert that
// the editor actually has non-empty content for a given document — which
// catches the user-facing "empty editor" bug that pure relay-side checks
// would miss.
const lastReadyByUri = new Map<string, ReadyWithContentMessage>();
export function _getLastReadyForTests(uri: vscode.Uri): ReadyWithContentMessage | undefined {
  return lastReadyByUri.get(uri.toString());
}

const lastWebviewErrorByUri = new Map<string, WebviewErrorMessage>();
export function _getLastWebviewErrorForTests(
  uri: vscode.Uri,
): WebviewErrorMessage | undefined {
  return lastWebviewErrorByUri.get(uri.toString());
}

export class CollabEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = VIEW_TYPE;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ): vscode.Disposable {
    const provider = new CollabEditorProvider(context.extensionUri, output);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "out", "webview");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };

    panel.webview.html = this.renderHtml(panel.webview);

    const config = vscode.workspace.getConfiguration("markdownCollab");
    const serverUrl = config.get<string>("collab.serverUrl", "ws://localhost:1234");
    const userName = config.get<string>("collab.userName", "") || os.userInfo().username;
    const room = computeRoom(document.uri);
    const user = { name: userName, color: pickColor(userName) };

    // Track our own writes so the workspace.onDidChangeTextDocument handler
    // doesn't bounce them back as "external" updates and overwrite the
    // webview's Y.Text mid-edit.
    let pendingApply = false;

    const applyEditFromWebview = async (text: string): Promise<void> => {
      if (document.getText() === text) return;
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, fullRange, text);
      pendingApply = true;
      try {
        await vscode.workspace.applyEdit(edit);
      } catch (e) {
        this.output.appendLine(
          `CollabEditor applyEdit failed: ${(e as Error).message}`,
        );
      } finally {
        pendingApply = false;
      }
    };

    const messageSub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as ClientMessage | undefined;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        const payload: InitPayload = {
          type: "init",
          text: document.getText(),
          room,
          serverUrl,
          user,
        };
        void panel.webview.postMessage(payload);
      } else if (msg.type === "edit") {
        void applyEditFromWebview(msg.text);
      } else if (msg.type === "ready-with-content") {
        lastReadyByUri.set(document.uri.toString(), msg);
        this.output.appendLine(
          `CollabEditor: webview ready for ${document.uri.fsPath} — content length=${msg.length}, synced=${msg.synced}${msg.error ? `, error=${msg.error}` : ""}`,
        );
      } else if (msg.type === "webview-error") {
        // Surface webview-side failures (Milkdown init errors, ProseMirror
        // schema mismatches, etc.) into the extension's output channel so
        // they're visible without opening the webview devtools.
        lastWebviewErrorByUri.set(document.uri.toString(), msg);
        this.output.appendLine(
          `CollabEditor: webview error for ${document.uri.fsPath} (${msg.stage}): ${msg.message}`,
        );
      }
    });

    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (pendingApply) return;
      void panel.webview.postMessage({
        type: "externalChange",
        text: e.document.getText(),
      });
    });

    panel.onDidDispose(() => {
      messageSub.dispose();
      docSub.dispose();
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "client.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "client.css"),
    );
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = [
      `default-src 'none'`,
      // Milkdown / ProseMirror inject some inline `style` attributes
      // (e.g. for cursors). Allow them via 'unsafe-inline' under
      // style-src; this is the same posture the existing preview panel
      // uses for markdown-it rendered HTML.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: https:`,
      // y-websocket needs ws:// to localhost or wherever the user pointed
      // markdownCollab.collab.serverUrl. Allow any ws/wss target — the user
      // controls the URL via settings.
      `connect-src ws: wss:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function computeRoom(uri: vscode.Uri): string {
  // Hash the absolute fsPath so the room name doesn't leak filesystem layout
  // to peers but still uniquely identifies the document. Anyone with the
  // same absolute path on the same y-websocket server joins the same room.
  return crypto.createHash("sha1").update(uri.fsPath).digest("hex").slice(0, 16);
}

function pickColor(name: string): string {
  const palette = [
    "#e06c75",
    "#98c379",
    "#e5c07b",
    "#61afef",
    "#c678dd",
    "#56b6c2",
    "#d19a66",
    "#abb2bf",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}
