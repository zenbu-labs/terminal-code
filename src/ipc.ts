import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface OpenFile {
  path: string;
  line?: number;
  column?: number;
}

export interface OpenRequest {
  files: OpenFile[];
  folders: string[];
  add: boolean;
  wait?: boolean;
  diff?: string[];
  view?: string;
  theme?: Record<string, unknown>;
  transparency?: boolean;
}

export function runningWindow(): string | null {
  const socket = process.env.TODE_IPC;
  if (!socket) return null;
  try {
    return fs.statSync(socket).isSocket() ? socket : null;
  } catch {
    return null;
  }
}

export function sendToExtension(socket: string, request: OpenRequest, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    const timer = timeoutMs
      ? setTimeout(() => {
        connection.destroy();
        reject(new Error("the tode window did not answer"));
      }, timeoutMs)
      : null;
    let buffer = "";
    const settle = (error: Error | null) => {
      if (timer) clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolve();
    };
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const reply = JSON.parse(buffer.split("\n")[0]) as { ok?: boolean; error?: string };
        settle(reply.ok ? null : new Error(reply.error ?? "the window refused"));
      } catch {
        settle(new Error("the window sent something unreadable"));
      }
    });
    connection.on("error", (error) => settle(error));
  });
}

export function parseGoto(argument: string): OpenFile {
  if (fs.existsSync(argument)) return { path: argument };
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(argument);
  if (!match) return { path: argument };
  return {
    path: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : 1,
  };
}

export function windowSockets(): string[] {
  try {
    return fs
      .readdirSync(ipcSocketDir())
      .filter((name) => name.endsWith(".sock"))
      .map((name) => path.join(ipcSocketDir(), name));
  } catch {
    return [];
  }
}

export function ipcSocketDir(): string {
  const stateHome =
    process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "tode", "ipc");
}
