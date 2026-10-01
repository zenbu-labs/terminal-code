import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app, ipcMain } from "@zenbu-labs/pixel/electron";
import { createRoot } from "@zenbu-labs/pixel";
import type { Root, WebViewHandle } from "@zenbu-labs/pixel";

import { ipcSocketDir, sendToExtension } from "../ipc";
import { parseRawColors } from "../livesync";
import { generateTheme } from "../theme/generate";
import { MESSAGE_CHANNEL } from "./messages";
import type { ThemeMessage, TimingMessage } from "./messages";
import { daemonSocket, lines } from "./protocol";
import type { OpenRequest, Reply, Request } from "./protocol";

const IDLE_EXIT_MS = 15_000;
const SOCKET = daemonSocket();

const windows = new Map<Root, { view: WebViewHandle; timingFile?: string }>();
let idle: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleExit() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (windows.size === 0) app.exit(0);
  }, IDLE_EXIT_MS);
}

ipcMain.on(MESSAGE_CHANNEL, (event, message: ThemeMessage | TimingMessage | null) => {
  if (!message) return;
  if (message.type === "timing" && message.page) {
    const timingFile = [...windows.values()].find((window) => window.view.webContents.id === event.sender.id)?.timingFile;
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
  const theme = generateTheme(palette) as unknown as Record<string, unknown>;
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
});

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
  try {
    const view = root.loadURL(request.url, {
      preload: path.join(__dirname, "preload.js"),
      proxy: request.proxy,
      partition: request.partition,
      clipboardRead: true,
      onOpenWindow: "popup",
      onContextMenu: () => {},
    });
    windows.set(root, { view, timingFile: request.timingFile });
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
