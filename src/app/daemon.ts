import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app, ipcMain } from "@zenbu-labs/pixel/electron";
import { WebView, createRoot } from "@zenbu-labs/pixel";
import type { Root, WebViewHandle } from "@zenbu-labs/pixel";
import { createElement } from "react";

import { ipcSocketDir, sendToExtension } from "../ipc";
import { parseRawColors } from "../livesync";
import { cachedPalette, currentTheme, installCss, installTheme, setLiveTheme, transparencyEnabled } from "../profile";
import type { TerminalPalette } from "../terminal/osc";
import { MESSAGE_CHANNEL } from "./messages";
import type { ThemeMessage, TimingMessage } from "./messages";
import { browserProfileDir, daemonSocket, lines } from "./protocol";
import type { OpenRequest, Reply, Request } from "./protocol";

fs.mkdirSync(browserProfileDir(), { recursive: true });
app.setPath("userData", browserProfileDir());
app.setPath("sessionData", browserProfileDir());

const IDLE_EXIT_MS = 15_000;
const SOCKET = daemonSocket();

interface Window {
  view: WebViewHandle | null;
  request: OpenRequest;
  transparent: boolean;
}

const windows = new Map<Root, Window>();
let idle: ReturnType<typeof setTimeout> | null = null;
let lastPalette: TerminalPalette | null = null;

function scheduleIdleExit() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (windows.size === 0) app.exit(0);
  }, IDLE_EXIT_MS);
}

ipcMain.on(MESSAGE_CHANNEL, (event, message: ThemeMessage | TimingMessage | null) => {
  if (!message) return;
  if (message.type === "timing" && message.page) {
    const timingFile = [...windows.values()].find((window) => window.view?.webContents.id === event.sender.id)
      ?.request.timingFile;
    if (timingFile) {
      try {
        fs.writeFileSync(timingFile, JSON.stringify(message.page));
      } catch {}
    }
    return;
  }
  if (message.type !== "theme" || !message.colors) return;
  const palette = parseRawColors(JSON.stringify(message.colors));
  if (!palette) return;
  lastPalette = palette;
  broadcastTheme(palette);
});

function broadcastTheme(palette: TerminalPalette) {
  const theme = currentTheme(palette) as unknown as Record<string, unknown>;
  let names: string[];
  try {
    names = fs.readdirSync(ipcSocketDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".sock")) continue;
    const socket = path.join(ipcSocketDir(), name);
    sendToExtension(socket, { files: [], folders: [], add: false, theme }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
          try {
            fs.rmSync(socket, { force: true });
          } catch {}
        }
      },
    );
  }
}

function page(window: Window, url: string) {
  return createElement(WebView, {
    key: window.transparent ? "clear" : "opaque",
    ref: (handle: WebViewHandle | null) => {
      window.view = handle;
    },
    src: url,
    style: { width: "100%", height: "100%" },
    preload: path.join(__dirname, "preload.js"),
    proxy: window.request.proxy,
    partition: window.request.partition,
    clipboardRead: true,
    onOpenWindow: "popup",
    onContextMenu: () => {},
    ...(window.transparent ? { browserWindowOptions: { transparent: true, backgroundColor: "#00000000" } } : {}),
  });
}

function applyTransparency(on: boolean) {
  const palette = lastPalette ?? cachedPalette();
  if (palette) {
    installTheme(palette, on);
    installCss(palette, on);
    setLiveTheme(currentTheme(palette, on));
  }
  for (const [root, window] of windows) {
    if (window.transparent === on) continue;
    const url = window.view?.state.url || window.request.url;
    window.transparent = on;
    window.view = null;
    root.render(page(window, url));
  }
}

function openWindow(request: OpenRequest, onClosed: (code: number) => void): Root {
  const root = createRoot({
    name: "tode",
    tty: request.tty,
    sessionEnv: request.env,
    onExit(code) {
      if (!windows.delete(root)) return;
      onClosed(code);
      scheduleIdleExit();
    },
  });
  const window: Window = { view: null, request, transparent: transparencyEnabled() };
  try {
    root.render(page(window, request.url));
    windows.set(root, window);
  } catch (error) {
    root.stop(1);
    throw error;
  }
  return root;
}

function serve() {
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  const server = net.createServer((connection) => {
    let root: Root | null = null;
    const reply = (value: Reply) => {
      try {
        connection.write(`${JSON.stringify(value)}\n`);
      } catch {}
    };
    connection.on(
      "data",
      lines((line) => {
        const request = JSON.parse(line) as Request;
        switch (request.cmd) {
          case "open":
            if (root) return;
            if (idle) clearTimeout(idle);
            try {
              root = openWindow(request, (code) => {
                reply({ event: "closed", code });
                connection.end();
              });
              reply({ ok: true, pid: process.pid });
            } catch (error) {
              reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
              connection.end();
              scheduleIdleExit();
            }
            return;
          case "resize":
            root?.nudgeResize();
            return;
          case "close":
            root?.stop();
            return;
          case "shutdown":
            for (const open of windows.keys()) open.stop();
            setTimeout(() => app.exit(0), 100);
            return;
          case "transparency":
            applyTransparency(request.on);
            reply({ ok: true, pid: process.pid });
            connection.end();
            return;
        }
      }),
    );
    connection.on("error", () => {});
    connection.on("close", () => root?.stop());
  });
  server.on("error", (error) => {
    process.stderr.write(`tode window: socket error: ${error.message}\n`);
    app.exit(1);
  });
  server.listen(SOCKET);
  scheduleIdleExit();
}

// A window process for this version may already be serving the socket.
const probe = net.connect(SOCKET);
probe.once("connect", () => {
  probe.destroy();
  app.exit(0);
});
probe.once("error", () => serve());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const open of windows.keys()) open.stop();
    setTimeout(() => app.exit(0), 200);
  });
}
