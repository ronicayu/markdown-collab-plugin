import * as path from "path";

type Handler = (...args: unknown[]) => Promise<unknown>;

export async function vscodeForCommands() {
  const stub = await import("../vscode-stub");

  class Uri {
    constructor(readonly fsPath: string) {}
    static file(p: string): Uri {
      return new Uri(p);
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri(path.join(base.fsPath, ...parts));
    }
    toString(): string {
      return `file://${this.fsPath}`;
    }
  }

  const handlers = new Map<string, Handler>();
  const commands = {
    handlers,
    registerCommand: (id: string, handler: Handler) => {
      handlers.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: async () => undefined,
  };

  return { ...stub, Uri, commands, FileType: { File: 1, Directory: 2 } };
}

export function commandHandler(commands: unknown, id: string): Handler {
  const handler = (commands as { handlers: Map<string, Handler> }).handlers.get(id);
  if (!handler) throw new Error(`${id} was not registered`);
  return handler;
}

export function commandDeps(): never {
  const logger: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "warn", "error"]) logger[level] = () => undefined;
  logger.scope = () => logger;
  return {
    context: { subscriptions: [], workspaceState: {}, globalState: {} },
    sendLog: logger,
    reviewLog: logger,
    formatLog: logger,
    terminalTracker: {},
    reviewView: {},
    openReviewView: async () => undefined,
  } as never;
}
