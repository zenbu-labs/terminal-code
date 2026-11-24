import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { INSTALL_ROOT } from "../runtime/paths";
import { DAEMON_DIR, lines } from "./protocol";
import type { Reply, Request } from "./protocol";
import { COMMAND } from "../runtime/shim";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function connectDaemon(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

const parsers = new WeakMap<net.Socket, EventEmitter>();


export function linesOf(socket: net.Socket): EventEmitter {
  let emitter = parsers.get(socket);
  if (!emitter) {
    const target = new EventEmitter();
    socket.on(
      "data",
      lines((line) => {
        let reply: Reply;
        try {
          reply = JSON.parse(line) as Reply;
        } catch {
          return;
        }
        target.emit("line", reply);
      }),
    );
    parsers.set(socket, target);
    emitter = target;
  }
  return emitter;
}

export function ask(socket: net.Socket, request: Request, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const emitter = linesOf(socket);
    const settle = (outcome: () => void) => {
      clearTimeout(timer);
      emitter.off("line", onLine);
      socket.off("close", onClose);
      outcome();
    };
    const onLine = (reply: Reply) => settle(() => resolve(reply));
    const onClose = () => settle(() => reject(new Error(`the ${COMMAND} window process closed the connection`)));
    const timer = setTimeout(() => settle(() => reject(new Error(`the ${COMMAND} window process did not answer`))), timeoutMs);
    emitter.once("line", onLine);
    socket.once("close", onClose);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, within: number): Promise<boolean> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
}

export async function kill(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await gone(pid, 2000)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await gone(pid, 1000);
}


const DAEMON_ENTRY = path.join(INSTALL_ROOT, "dist", "app", "daemon.js");

function isOurDaemon(command: string): boolean {
  return command.includes("@zenbu-labs/pixel/dist/bootstrap.js") && command.includes(DAEMON_ENTRY);
}

function processTable(): Map<number, string> {
  const table = new Map<number, string>();
  let listing: string;
  try {
    listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return table;
  }
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), match[2]);
  }
  return table;
}

interface DaemonFiles {
  version: string;
  socket: string;
  pidFile: string;
  pid: number | null;
}


function daemons(table: Map<number, string>): DaemonFiles[] {
  let names: string[];
  try {
    names = fs.readdirSync(DAEMON_DIR);
  } catch {
    return [];
  }
  const versions = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".sock")) versions.add(name.slice(0, -".sock".length));
    else if (name.endsWith(".pid")) versions.add(name.slice(0, -".pid".length));
  }
  return [...versions].map((version) => {
    const pidFile = path.join(DAEMON_DIR, `${version}.pid`);
    let pid: number | null = null;
    try {
      const read = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(read) && read > 0 && isOurDaemon(table.get(read) ?? "")) pid = read;
    } catch {}
    return { version, socket: path.join(DAEMON_DIR, `${version}.sock`), pidFile, pid };
  });
}

function forget(daemon: DaemonFiles): void {
  for (const file of [daemon.socket, daemon.pidFile]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

export interface Windows {
  count: number;
  unknown: boolean;
}

export async function openWindows(): Promise<Windows> {
  const found = daemons(processTable());
  const answers = await Promise.all(
    found.map(async (daemon): Promise<number | null | undefined> => {
      let socket: net.Socket | null = null;
      try {
        socket = await connectDaemon(daemon.socket);
      } catch {
        return undefined;
      }
      try {
        const reply = await ask(socket, { cmd: "status" }, 1500);
        return "ok" in reply && reply.ok ? (reply.windows ?? 0) : null;
      } catch {
        return null;
      } finally {
        socket.destroy();
      }
    }),
  );
  const windows: Windows = { count: 0, unknown: false };
  for (const answer of answers) {
    if (answer === null) windows.unknown = true;
    else if (answer !== undefined) windows.count += answer;
  }
  return windows;
}

export interface Stopped {
  daemons: number;
  windows: number;
  killed: number;
}

async function stopOne(daemon: DaemonFiles, result: Stopped): Promise<void> {
  let socket: net.Socket | null = null;
  try {
    socket = await connectDaemon(daemon.socket);
  } catch {}
  if (!socket) {
    if (daemon.pid !== null) {
      await kill(daemon.pid);
      result.daemons += 1;
      result.killed += 1;
    }
    forget(daemon);
    return;
  }
  let answer: Reply | null;
  try {
    answer = await ask(socket, { cmd: "shutdown" }, 2500);
  } catch (error) {
    answer = (error as Error).message.includes("closed") ? { ok: true, pid: daemon.pid ?? 0 } : null;
  }
  socket.destroy();
  result.daemons += 1;
  const pid = answer && "ok" in answer && answer.ok && answer.pid ? answer.pid : daemon.pid;
  if (answer && "ok" in answer && answer.ok) {
    result.windows += answer.windows ?? 0;
    if (pid && !(await gone(pid, 2000))) {
      await kill(pid);
      result.killed += 1;
    }
  } else if (pid) {
    await kill(pid);
    result.killed += 1;
  }
  forget(daemon);
}


export async function shutdownDaemons(): Promise<Stopped> {
  const result: Stopped = { daemons: 0, windows: 0, killed: 0 };
  const table = processTable();
  const known = daemons(table);
  await Promise.all(known.map((daemon) => stopOne(daemon, result)));
  const seen = new Set(known.map((daemon) => daemon.pid));
  const strays = [...table].filter(
    ([pid, command]) => !seen.has(pid) && pid !== process.pid && isOurDaemon(command) && alive(pid),
  );
  await Promise.all(
    strays.map(async ([pid]) => {
      await kill(pid);
      result.daemons += 1;
      result.killed += 1;
    }),
  );
  return result;
}
