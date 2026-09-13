import { execFileSync } from "node:child_process";

import type { ServerState } from "../codeserver/server";

export type OwnedProcessKind = "code-server" | "injector";

export interface ProcessProbe {
  alive(pid: number): boolean;
  command(pid: number): string | null;
  portOwner?(port: number): number | null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function command(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function portOwner(port: number): number | null {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = /^p(\\d+)$/m.exec(output);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export const systemProcessProbe: ProcessProbe = { alive, command, portOwner };

export function ownsServerProcess(
  kind: OwnedProcessKind,
  state: ServerState,
  commandLine: string | null,
): boolean {
  if (!commandLine) return false;
  if (kind === "code-server") {
    return (
      commandLine.includes("code-server") &&
      commandLine.includes("--app-name") &&
      commandLine.includes("tode") &&
      commandLine.includes(`127.0.0.1:${state.port}`)
    );
  }
  return (
    commandLine.includes("injector-main.js") &&
    commandLine.includes(String(state.port)) &&
    commandLine.includes(String(state.injectorPort))
  );
}
