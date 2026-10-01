import fs from "node:fs";
import path from "node:path";

import { INSTALL_ROOT, STATE_DIR } from "../runtime/paths";

export const DAEMON_DIR = path.join(STATE_DIR, "daemon");

export function daemonSocket(): string {
  let version = "dev";
  try {
    version = fs.readFileSync(path.join(INSTALL_ROOT, "VERSION"), "utf8").trim() || "dev";
  } catch {}
  return path.join(DAEMON_DIR, `${version}.sock`);
}

export interface OpenRequest {
  cmd: "open";
  tty: string;
  url: string;
  env: Record<string, string | undefined>;
  proxy?: string;
  partition?: string;
  timingFile?: string;
}

export type Request = OpenRequest | { cmd: "resize" } | { cmd: "close" } | { cmd: "shutdown" };

export type Reply = { ok: true; pid: number } | { ok: false; error: string } | { event: "closed"; code: number };

export function lines(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };
}
