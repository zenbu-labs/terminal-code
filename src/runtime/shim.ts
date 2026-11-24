import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHIM_NAMES = ["terminal-code", "tode"];

export const COMMAND = invokedName();

function invokedName(): string {
  const given = process.env.TERMINAL_CODE_COMMAND;
  delete process.env.TERMINAL_CODE_COMMAND;
  if (given && SHIM_NAMES.includes(given)) return given;
  const script = path.basename(process.argv[1] ?? "");
  return SHIM_NAMES.includes(script) ? script : SHIM_NAMES[0];
}

export function binHome(): string {
  const configured = process.env.XDG_BIN_HOME;
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), ".local", "bin");
}

export function shimPaths(): string[] {
  return SHIM_NAMES.map((name) => path.join(binHome(), name));
}

export function installedShim(): string | null {
  const preferred = path.join(binHome(), COMMAND);
  if (fs.existsSync(preferred)) return preferred;
  return shimPaths().find((shim) => fs.existsSync(shim)) ?? null;
}
