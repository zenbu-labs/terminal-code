import fs from "node:fs";
import net from "node:net";
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
}

/** Where a window listens, and the file in the ipc directory that says so.
 *
 * Windows cannot listen on a filesystem path, so there a window listens on a
 * named pipe and the file holds its name. Everywhere else the file is the
 * socket. Either way the directory lists one file per window. */
export function windowAddress(dir: string, name: string): { endpoint: string; file: string } {
  const file = path.join(dir, `${name}.sock`);
  if (process.platform !== "win32") return { endpoint: file, file };
  return { endpoint: String.raw`\\.\pipe\tode-ipc-${name}`, file };
}

/** The address behind a file the ipc directory listed. */
export function endpointOf(file: string): string | null {
  try {
    if (fs.statSync(file).isSocket()) return file;
  } catch {
    return null;
  }
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Whether anything is listening, asked by connecting.
 *
 * A named pipe leaves nothing on disk to look at, and a socket file outlives
 * the window that made it, so the only answer either can give is an answer. */
export function answers(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(endpoint);
    const settle = (alive: boolean) => {
      clearTimeout(timer);
      connection.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    connection.on("connect", () => settle(true));
    connection.on("error", () => settle(false));
  });
}

export async function runningWindow(): Promise<string | null> {
  const endpoint = process.env.TODE_IPC;
  if (!endpoint) return null;
  return (await answers(endpoint)) ? endpoint : null;
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
