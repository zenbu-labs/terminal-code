import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBrowserScripts } from "./browserglue";
import { CSS_FILE } from "./codeserver/server";
import { spawnRuntime } from "./runtime/release";
import type { Runtime } from "./runtime/release";
import type { TerminalPalette } from "./terminal/osc";

const APP_NAME = "terminal-code";
const APP_ID = "terminal-code";

export interface LaunchOptions {
  split?: string;
  size?: string;
  stages?: [string, number][];
}

function browserArgv(url: string, options: LaunchOptions): string[] {
  const argv = [url, "--app-mode", `--app-name=${APP_NAME}`, `--app-id=${APP_ID}`]
  const scripts = writeBrowserScripts();
  argv.push(`--preload=${scripts.preload}`, `--main-script=${scripts.mainScript}`);
  if (options.split) argv.push("--split", options.split);
  if (options.size) argv.push("--size", options.size);
  return argv;
}

export function registerSelf(runtime: Runtime): void {
  const bin = path.join(
    process.env.XDG_BIN_HOME ?? path.join(os.homedir(), ".local", "bin"),
    "tode",
  );
  if (!fs.existsSync(bin)) return;
  try {
    const child = spawnRuntime(
      runtime,
      ["register-app", "--name", APP_NAME, "--id", APP_ID, "--bin", bin, "--args", "."],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export class Pane {
  private child: ChildProcess | null = null;
  private exit: Promise<number> | null = null;

  constructor(
    private readonly runtime: Runtime,
    private readonly options: LaunchOptions = {},
  ) { }

  owned(): boolean {
    return this.child !== null;
  }

  open(url: string): void {
    if (this.child) return;
    try {
      fs.writeFileSync(
        `${CSS_FILE}.launch.json`,
        JSON.stringify({ spawnedAt: Date.now(), stages: this.options.stages ?? [] }),
      );
    } catch { }
    const child = spawnRuntime(this.runtime, ["open", ...browserArgv(url, this.options)], {
      stdio: "inherit",
    });
    this.child = child;
    this.exit = new Promise<number>((resolve) => {
      child.on("error", (error) => {
        process.stderr.write(`could not start terminal-browser: ${error.message}\n`);
        resolve(1);
      });
      child.on("exit", (code) => resolve(code ?? 0));
    });
  }

  exited(): Promise<number> {
    return this.exit ?? new Promise<number>(() => { });
  }
}

export function launchBrowser(
  runtime: Runtime,
  url: string,
  _palette: TerminalPalette,
  options: LaunchOptions = {},
): Promise<number> {
  const pane = new Pane(runtime, options);
  pane.open(url);
  return pane.exited();
}
