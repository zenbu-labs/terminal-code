import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { callerTty, canSplit, cannotOpenPanes, checkTerminal, detect, findOwner, unsupportedGraphicsMessage } from "@zenbu-labs/pixel/terminal";
import type { Direction } from "@zenbu-labs/pixel/terminal";

import { ask, connectDaemon, linesOf, sleep } from "./app/control";
import { DAEMON_DIR, buildStamp, daemonSocket } from "./app/protocol";
import type { OpenRequest, Reply, Request } from "./app/protocol";
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

// A split pane starts with the terminal's environment, not ours, so the
// shim's ELECTRON_RUN_AS_NODE=1 does not reach it. Without it Electron boots
// Chromium instead of node; `env` sets it for any terminal's split.
function windowCommand(url: string, options: LaunchOptions): string[] {
  const command = ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", process.execPath, path.resolve(__dirname, "main.js"), "--window", url];
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

const OPEN_TIMEOUT_MS = 20_000;

async function daemonConnection(): Promise<net.Socket> {
  try {
    return await connectDaemon(daemonSocket());
  } catch {}
  spawnDaemon();
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await connectDaemon(daemonSocket());
    } catch {
      await sleep(100);
    }
  }
  throw new Error("the tode window process did not start");
}

function stale(reply: Reply): boolean {
  return "ok" in reply && !reply.ok && reply.error === "stale";
}

async function daemonGone(within: number): Promise<void> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    try {
      (await connectDaemon(daemonSocket())).destroy();
    } catch {
      return;
    }
    await sleep(100);
  }
}

async function openSession(request: OpenRequest): Promise<{ socket: net.Socket; reply: Reply }> {
  const build = buildStamp(daemonEntry());
  let socket = await daemonConnection();
  let reply = await ask(socket, { ...request, build }, OPEN_TIMEOUT_MS);
  if (stale(reply)) {
    socket.destroy();
    await daemonGone(5000);
    socket = await daemonConnection();
    reply = await ask(socket, { ...request, build }, OPEN_TIMEOUT_MS);
  }
  return { socket, reply };
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
    let session: { socket: net.Socket; reply: Reply };
    try {
      session = await openSession({
        cmd: "open",
        tty,
        url,
        env: process.env,
        proxy: options.proxy,
        partition: options.partition,
        timingFile: `${CSS_FILE}.timing.json`,
      });
    } catch (error) {
      process.stderr.write(`could not open the tode window: ${(error as Error).message}\n`);
      return 1;
    }
    const { socket, reply } = session;
    send = (request: Request) => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {}
    };
    if ("ok" in reply && !reply.ok) {
      process.stderr.write(`could not open the tode window: ${reply.error}\n`);
      socket.destroy();
      return 1;
    }
    if (closeRequested) {
      send({ cmd: "close" });
      socket.end();
      return 0;
    }
    return new Promise<number>((resolve) => {
      linesOf(socket).on("line", (event: Reply) => {
        if ("event" in event && event.event === "closed") resolve(event.code);
      });
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
