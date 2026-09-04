import type { OpenRequest } from "../ipc";
import type { BridgeCtx } from "./ctx";

/** The deliberately small part of vscode's API that the bridge uses. Keeping
 * it structural means the generated extension remains dependency-free without
 * giving up typechecking while it is authored here. */
interface Disposable {
  dispose(): void;
}

interface Uri {
  with(change: { scheme?: string; path?: string }): Uri;
  toString(): string;
}

interface BridgeTheme extends Record<string, unknown> {
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

interface BridgeRequest extends Omit<OpenRequest, "theme"> {
  theme?: BridgeTheme;
}

interface VscodeApi {
  ConfigurationTarget: { Global: unknown };
  TextEditorRevealType: { InCenter: unknown };
  Position: new (line: number, column: number) => unknown;
  Selection: new (anchor: unknown, active: unknown) => unknown;
  Range: new (start: unknown, end: unknown) => unknown;
  Uri: {
    file(target: string): Uri;
    from(parts: { scheme: string; authority: string; path: string }): Uri;
    parse(target: string): Uri;
  };
  commands: {
    registerCommand(command: string, callback: () => unknown): Disposable;
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  };
  env: {
    remoteAuthority?: string;
    openExternal(target: Uri): PromiseLike<boolean>;
  };
  window: {
    showErrorMessage(
      message: string,
      options: { modal: boolean },
      ...items: string[]
    ): PromiseLike<string | undefined>;
    showTextDocument(
      document: { uri: Uri },
      options: { preview: boolean },
    ): Promise<{
      selection: unknown;
      revealRange(range: unknown, revealType: unknown): void;
    }>;
    tabGroups: {
      all: Array<{
        tabs: Array<{ input?: { uri?: Uri; modified?: Uri } }>;
      }>;
      onDidChangeTabs(listener: () => void): Disposable;
    };
  };
  workspace: {
    getConfiguration(): {
      update(key: string, value: unknown, target: unknown): unknown;
    };
    workspaceFolders?: readonly { uri: Uri }[];
    openTextDocument(uri: Uri): Promise<{ uri: Uri }>;
    updateWorkspaceFolders(start: number, deleteCount: number, ...folders: Array<{ uri: Uri }>): boolean;
  };
}

interface ExtensionContext {
  subscriptions: Disposable[];
  environmentVariableCollection: { replace(name: string, value: string): void };
}

export function bridgeMain(ctx: BridgeCtx): void {
  const fs = require("fs") as typeof import("node:fs");
  const net = require("net") as typeof import("node:net");
  const os = require("os") as typeof import("node:os");
  const path = require("path") as typeof import("node:path");
  const vscode = require("vscode") as VscodeApi;

  const LIVE_THEME_FILE = ctx.liveThemeFile;
  const QUIT_HINT = ctx.quitHint;
  const STARTUP_OPEN_FILE = ctx.startupOpenFile;

  const VIEW_COMMANDS: Record<string, string> = { scm: "workbench.view.scm" };

  function focusView(view: string): void {
    const command = VIEW_COMMANDS[view];
    if (command) void vscode.commands.executeCommand(command);
  }

  function applyStartupOpen(): void {
    let parsed: (Partial<BridgeRequest> & { at?: number }) | null;
    try {
      parsed = JSON.parse(fs.readFileSync(STARTUP_OPEN_FILE, "utf8"));
    } catch {
      return;
    }
    try {
      fs.rmSync(STARTUP_OPEN_FILE, { force: true });
    } catch {}
    if (!parsed || Date.now() - (parsed.at || 0) > 120000) return;
    void open({ files: [], folders: [], add: false, ...parsed, wait: false }, () => {});
  }

  const NL = String.fromCharCode(10);

  function quitTode(): void {
    void vscode.env.openExternal(vscode.Uri.parse("terminal-browser://quit"));
  }

  function applyThemeDocument(theme: BridgeTheme | null | undefined): void {
    if (!theme || typeof theme !== "object") return;
    const cfg = vscode.workspace.getConfiguration();
    const target = vscode.ConfigurationTarget.Global;
    if (theme.colors) {
      cfg.update("workbench.colorCustomizations", theme.colors, target);
    }
    if (theme.tokenColors) {
      cfg.update("editor.tokenColorCustomizations", { textMateRules: theme.tokenColors }, target);
    }
  }

  function applyLiveTheme(): void {
    let theme: BridgeTheme;
    try {
      theme = JSON.parse(fs.readFileSync(LIVE_THEME_FILE, "utf8"));
    } catch {
      return;
    }
    applyThemeDocument(theme);
  }

  function persistLiveTheme(theme: BridgeTheme): void {
    try {
      fs.mkdirSync(path.dirname(LIVE_THEME_FILE), { recursive: true });
      fs.writeFileSync(`${LIVE_THEME_FILE}.tmp`, JSON.stringify(theme) + NL);
      fs.renameSync(`${LIVE_THEME_FILE}.tmp`, LIVE_THEME_FILE);
    } catch {}
  }

  function watchLiveTheme(): () => void {
    applyLiveTheme();
    const dir = path.dirname(LIVE_THEME_FILE);
    const name = path.basename(LIVE_THEME_FILE);
    let timer: NodeJS.Timeout | null = null;
    let watcher: import("node:fs").FSWatcher | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== name) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(applyLiveTheme, 30);
      });
    } catch {}
    return () => {
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
    };
  }

  function socketPath(): string {
    const stateHome =
      process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
        ? process.env.XDG_STATE_HOME
        : path.join(os.homedir(), ".local", "state");
    const dir = path.join(stateHome, "tode", "ipc");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `w${process.pid}-${Date.now()}.sock`);
  }

  // Both branches below build a uri out of a path, and a uri path is not a
  // windows path: forward slashes, and a drive letter behind a leading slash.
  // Uri.file is the one that takes a native path, so it keeps the original.
  // Kept local because this function is serialised into the extension whole
  // and cannot reach anything it did not bring with it.
  function uriPath(target: string): string {
    const slashed = target.replaceAll("\\", "/");
    return slashed.startsWith("/") ? slashed : `/${slashed}`;
  }

  function workspaceUri(target: string): Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.with({ path: uriPath(target) });
    if (vscode.env.remoteAuthority) {
      return vscode.Uri.from({
        scheme: "vscode-remote",
        authority: vscode.env.remoteAuthority,
        path: uriPath(target),
      });
    }
    return vscode.Uri.file(target);
  }

  function sameUri(a: Uri, b: Uri): boolean {
    return a.toString() === b.toString();
  }

  function alreadyOpen(uri: Uri): boolean {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.some((folder) => sameUri(folder.uri, uri));
  }

  async function open(request: BridgeRequest, acknowledge: () => void): Promise<void> {
    if (request.theme) {
      applyThemeDocument(request.theme);
      persistLiveTheme(request.theme);
      return;
    }
    if (request.view) focusView(request.view);
    if (request.diff && request.diff.length === 2) {
      const left = vscode.Uri.file(request.diff[0]);
      const right = vscode.Uri.file(request.diff[1]);
      await vscode.commands.executeCommand("vscode.diff", left, right);
    }
    const opened: string[] = [];
    for (const file of request.files || []) {
      // like vim: a file that does not exist yet opens as a buffer bound to
      // its path — the untitled scheme keeps the path as the save target
      const uri = fs.existsSync(file.path)
        ? vscode.Uri.file(file.path)
        : vscode.Uri.file(file.path).with({ scheme: "untitled" });
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      opened.push(document.uri.toString());
      if (file.line) {
        const line = Math.max(0, file.line - 1);
        const column = Math.max(0, (file.column || 1) - 1);
        const at = new vscode.Position(line, column);
        editor.selection = new vscode.Selection(at, at);
        editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
      }
    }

    const wanted = (request.folders || []).map(workspaceUri).filter((uri) => {
      return !alreadyOpen(uri);
    });

    if (wanted.length === 0) {
      if (request.wait && opened.length > 0) await untilClosed(opened);
      acknowledge();
      return;
    }

    acknowledge();
    for (const uri of wanted) {
      if (request.add) {
        const at = (vscode.workspace.workspaceFolders || []).length;
        vscode.workspace.updateWorkspaceFolders(at, 0, { uri });
      } else {
        await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
      }
    }
  }

  function untilClosed(uris: string[]): Promise<void> {
    const waiting = uris.slice();
    const anyStillOpen = () => {
      const open: Record<string, boolean> = {};
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (input?.uri) open[input.uri.toString()] = true;
          if (input?.modified) open[input.modified.toString()] = true;
        }
      }
      return waiting.some((uri) => open[uri]);
    };
    if (!anyStillOpen()) return Promise.resolve();
    return new Promise((resolve) => {
      const subscription = vscode.window.tabGroups.onDidChangeTabs(() => {
        if (anyStillOpen()) return;
        subscription.dispose();
        resolve();
      });
    });
  }

  function activate(context: ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand("tode.quit", quitTode));

    let confirmShowing = false;
    context.subscriptions.push(
      vscode.commands.registerCommand("tode.confirmQuit", () => {
        if (confirmShowing) return;
        confirmShowing = true;
        vscode.window
          .showErrorMessage("Do you want to quit terminal-code?", { modal: true }, "Quit")
          .then(
            (picked) => {
              confirmShowing = false;
              if (picked === "Quit") quitTode();
            },
            () => {
              confirmShowing = false;
            },
          );
      }),
    );

    // er don't know if we want this think about it
    let hintShowing = false;
    context.subscriptions.push(
      vscode.commands.registerCommand("tode.quitHint", () => {
        if (hintShowing) return;
        hintShowing = true;
        const done = () => {
          hintShowing = false;
        };
        vscode.window.showErrorMessage(QUIT_HINT, { modal: true }).then(done, done);
      }),
    );

    // huh?
    applyStartupOpen();

    const stopWatchingSettings = watchLiveTheme();
    context.subscriptions.push({ dispose: stopWatchingSettings });

    const sock = socketPath();
    const server = net.createServer((connection) => {
      let buffer = "";
      connection.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf(NL);
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        let request: BridgeRequest;
        try {
          request = JSON.parse(line);
        } catch {
          connection.end(JSON.stringify({ ok: false, error: "bad request" }) + NL);
          return;
        }
        let answered = false;
        const acknowledge = () => {
          if (answered) return;
          answered = true;
          connection.end(JSON.stringify({ ok: true }) + NL);
        };
        Promise.resolve(open(request, acknowledge)).then(acknowledge, (error: unknown) => {
          if (answered) return;
          answered = true;
          connection.end(JSON.stringify({ ok: false, error: String(error) }) + NL);
        });
      });
      connection.on("error", () => {});
    });
    server.on("error", () => {});
    server.listen(sock, () => {
      context.environmentVariableCollection.replace("TODE_IPC", sock);
    });
    context.subscriptions.push({
      dispose: () => {
        try {
          server.close();
        } catch {}
        try {
          fs.rmSync(sock, { force: true });
        } catch {}
      },
    });
  }

  module.exports.activate = activate;
  module.exports.deactivate = () => {};
}
