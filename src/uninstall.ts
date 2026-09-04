import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { stopServer } from "./codeserver/server";
import { FONT_ASSET, assetPath, userFontsDir } from "./profile";
import {
  CACHE_DIR,
  DATA_DIR,
  DEFAULT_INSTALL_ROOT,
  INSTALL_ROOT,
  RUNTIME_DIR,
  STATE_DIR,
  VENDOR_DIR,
} from "./runtime/paths";
import { PINNED_VERSION } from "./runtime/release";
import { ghosttyConfigDir, reloadGhostty, removeFreed } from "./shortcuts/backends/ghostty";
import {
  kittyConfigDir,
  reloadKitty,
  removeFreed as removeKittyFreed,
} from "./shortcuts/backends/kitty";


function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask.question(question, (answer) => {
      ask.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function localBrowserBin(): string | null {
  const candidates = [
    path.join(VENDOR_DIR, "terminal-browser", "bin", "terminal-browser"),
    path.join(RUNTIME_DIR, "terminal-browser", PINNED_VERSION, "bin", "terminal-browser"),
  ];
  return candidates.find((bin) => fs.existsSync(bin)) ?? null;
}

function removeDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function removeFont(): boolean {
  const target = path.join(userFontsDir(), FONT_ASSET);
  try {
    const theirs = fs.readFileSync(target);
    const ours = fs.readFileSync(assetPath(FONT_ASSET));
    if (!theirs.equals(ours)) return false;
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function removeShim(): boolean {
  const binHome =
    process.env.XDG_BIN_HOME && path.isAbsolute(process.env.XDG_BIN_HOME)
      ? process.env.XDG_BIN_HOME
      : path.join(os.homedir(), ".local", "bin");
  const shim = path.join(binHome, "tode");
  try {
    const contents = fs.readFileSync(shim, "utf8");
    if (!contents.includes("TODE_INSTALL_ROOT")) return false;
    fs.rmSync(shim, { force: true });
    return true;
  } catch {
    return false;
  }
}

function spinner(label: string): () => void {
  if (!process.stdout.isTTY) return () => {};
  // dont think this actually works
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let at = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[at++ % frames.length]} ${label}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  };
}

export async function uninstallCommand(args: string[]): Promise<number> {
  const yes = args.includes("--yes") || args.includes("-y");
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write("pass --yes to uninstall without a prompt\n");
      return 1;
    }
    if (!(await confirm("Uninstall terminal-code? [y/N] "))) return 0;
  }

  const stop = spinner("uninstalling");

  stopServer();
  const browser = localBrowserBin();
  if (browser) {
    await new Promise<void>((resolve) => {
      const child = spawn(browser, ["shutdown"], { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  }

  if (removeFreed(ghosttyConfigDir())) reloadGhostty();
  if (removeKittyFreed(kittyConfigDir())) reloadKitty();

  removeFont();

  for (const dir of [DATA_DIR, STATE_DIR, CACHE_DIR]) removeDir(dir);

  for (const root of new Set([INSTALL_ROOT, DEFAULT_INSTALL_ROOT])) {
    if (fs.existsSync(path.join(root, "VERSION"))) removeDir(root);
  }
  removeShim();

  stop();
  process.stdout.write("done\n");
  return 0;
}
