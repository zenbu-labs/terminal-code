import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { callerTty, canSplit, cannotOpenPanes, checkTerminal, detect, findOwner, unsupportedGraphicsMessage } from "@zenbu-labs/pixel/terminal";
import type { Direction } from "@zenbu-labs/pixel/terminal";

import { DAEMON_DIR, daemonSocket, lines } from "./app/protocol";
import type { Reply, Request } from "./app/protocol";
import { CSS_FILE } from "./codeserver/server";
import { bootstrapEntry, daemonEntry, electronBinary } from "./runtime/launcher";
import type { TerminalPalette } from "./terminal/osc";

const APP_NAME = "terminal-code";
const APP_ID = "terminal-code";

export interface LaunchOptions {
  split?: string;
  size?: string;
  stages?: [string, number][];
  proxy?: string;
  partition?: string;
}

function windowCommand(url: string, options: LaunchOptions): string[] {
  const command = [process.execPath, path.resolve(__dirname, "main.js"), "--window", url];
  if (options.proxy) command.push(`--proxy=${options.proxy}`);
  if (options.partition) command.push(`--partition=${options.partition}`);
  return command;
}

function spawnDaemon(): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("PIXEL_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  const log = fs.openSync(path.join(DAEMON_DIR, "daemon.log"), "a");
  const child = spawn(electronBinary(), [bootstrapEntry(), daemonEntry()], {
    detached: true,
    stdio: ["ignore", "ignore", log],
    env,
  });
  child.on("error", () => {});
  child.unref();
}

// Started by a program embedding tode in its own screen, or from inside
// another pixel app's pane: the window joins that host, so nothing here may
// probe or split the terminal.
function hosted(tty: string): boolean {
  return Boolean(process.env.PIXEL_EMBED) || findOwner(tty) !== null;
}

function windowTty(): string | null {
  return process.env.PIXEL_TTY ?? callerTty().path;
}

function connectDaemon(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(daemonSocket());
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function daemonConnection(): Promise<net.Socket> {
  try {
    return await connectDaemon();
  } catch {}
  spawnDaemon();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return await connectDaemon();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("the tode window process did not start");
}

export async function shutdownDaemon(): Promise<boolean> {
  const socket = await connectDaemon().catch(() => null);
  if (!socket) return false;
  socket.write(`${JSON.stringify({ cmd: "shutdown" } satisfies Request)}\n`);
  socket.end();
  return true;
}

function attachWindow(url: string, options: LaunchOptions): { exited: Promise<number>; close(): void } {
  let send = (_request: Request) => {};
  let closeRequested = false;
  const exited = (async () => {
    const tty = windowTty();
    if (!tty) {
      process.stderr.write("tode needs a terminal to draw on\n");
      return 1;
    }
    if (!hosted(tty)) {
      const check = await checkTerminal(detect());
      if (check.graphics === "unsupported") {
        process.stderr.write(unsupportedGraphicsMessage(process.stderr.isTTY === true));
        return 1;
      }
    }
    const socket = await daemonConnection();
    send = (request: Request) => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {}
    };
    if (closeRequested) {
      socket.end();
      return 0;
    }
    send({
      cmd: "open",
      tty,
      url,
      env: process.env,
      proxy: options.proxy,
      partition: options.partition,
      timingFile: `${CSS_FILE}.timing.json`,
    });
    return new Promise<number>((resolve) => {
      socket.on(
        "data",
        lines((line) => {
          const reply = JSON.parse(line) as Reply;
          if ("ok" in reply && !reply.ok) {
            process.stderr.write(`could not open the tode window: ${reply.error}\n`);
            resolve(1);
          } else if ("event" in reply && reply.event === "closed") {
            resolve(reply.code);
          }
        }),
      );
      socket.on("close", () => resolve(0));
      socket.on("error", () => resolve(1));
      process.on("SIGWINCH", () => send({ cmd: "resize" }));
      // The pane is going away either way; a window process that never
      // confirms the close must not keep this shell waiting.
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
          send({ cmd: "close" });
          setTimeout(() => resolve(130), 3000).unref();
        });
      }
    });
  })();
  return {
    exited,
    close() {
      closeRequested = true;
      send({ cmd: "close" });
    },
  };
}

export function registerSelf(): void {
  const bin = path.join(process.env.XDG_BIN_HOME ?? path.join(os.homedir(), ".local", "bin"), "tode");
  if (!fs.existsSync(bin)) return;
  const override = process.env.TERMINAL_BROWSER_INTEROP_DIR;
  const root =
    override && path.isAbsolute(override)
      ? override
      : path.join(os.homedir(), ".local", "share", "terminal-browser-interop");
  const record = {
    version: 1,
    id: APP_ID,
    name: APP_NAME,
    bin,
    args: ["."],
    registeredAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.join(root, "apps"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", `${APP_ID}.json`), `${JSON.stringify(record, null, 2)}\n`);
  } catch {}
}

export class Pane {
  private exit: Promise<number> | null = null;
  private closeWindow: (() => void) | null = null;

  constructor(private readonly options: LaunchOptions = {}) {}

  close(): void {
    this.closeWindow?.();
  }

  owned(): boolean {
    return this.exit !== null;
  }

  open(url: string): void {
    if (this.exit) return;
    try {
      fs.writeFileSync(
        `${CSS_FILE}.launch.json`,
        JSON.stringify({ spawnedAt: Date.now(), stages: this.options.stages ?? [] }),
      );
    } catch {}
    this.exit = this.options.split ? this.openSplit(url, this.options.split) : this.openHere(url);
  }

  exited(): Promise<number> {
    return this.exit ?? new Promise<number>(() => {});
  }

  private openHere(url: string): Promise<number> {
    const window = attachWindow(url, this.options);
    this.closeWindow = () => window.close();
    return window.exited;
  }

  private async openSplit(url: string, direction: string): Promise<number> {
    const tty = windowTty();
    if (tty && hosted(tty)) {
      process.stderr.write("--split is not available inside another program's pane\n");
      return 1;
    }
    const terminal = detect();
    if (!canSplit(terminal)) {
      process.stderr.write(`${cannotOpenPanes(terminal)}\n`);
      return 1;
    }
    const from = await terminal!.getCurrentPane?.({ tty, cwd: process.cwd() });
    if (!from) {
      process.stderr.write(`could not work out which ${terminal!.name} pane this is\n`);
      return 1;
    }
    const size = Number(this.options.size);
    await terminal!.split!({
      from,
      direction: direction as Direction,
      command: windowCommand(url, this.options),
      size: Number.isFinite(size) && size > 0 ? size : null,
      tty,
    });
    return 0;
  }
}

export function launchBrowser(
  url: string,
  _palette: TerminalPalette,
  options: LaunchOptions = {},
): Promise<number> {
  const pane = new Pane(options);
  pane.open(url);
  return pane.exited();
}
