#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectDoctorContext } from "./doctor/context";
import { parseDoctorArgs } from "./doctor/command";
import { runDoctor } from "./doctor/orchestrator";
import { makeUsageReport, renderDoctorText, serializeDoctorJson } from "./doctor/report";

import {
  CSS_FILE,
  codeServerBin,
  ensureServer,
  origin,
  stopServer,
} from "./codeserver/server";
import { CODE_SERVER_VERSION, ensureCodeServer, narrateFetch } from "./codeserver/vendored";
import { installBridge, requestStartupOpen } from "./bridge";
import { BOOT_AFTER_APPLY, autoApplyShared, shortcutsCommand } from "./shortcuts/wizard";
import { importCommand } from "./import/command";
import { runImport } from "./import/run";
import type { Editor } from "./import/editors";
import { runOnboarding } from "./onboarding";
import { parseGoto, runningWindow, sendToExtension } from "./ipc";
import type { OpenFile } from "./ipc";
import { EXTENSIONS_DIR, VSCODE_DIR, registerThemeExtension } from "./profile";
import {
  ensureFont,
  installCss,
  installKeybindings,
  setLiveTheme,
  setThemeFile,
  installSettings,
  installTheme,
  readPalette,
} from "./profile";
import { Pane, launchBrowser } from "./launch";
import { resolveRuntime, resolveRuntimeWithProgress } from "./runtime/release";
import { INSTALL_ROOT } from "./runtime/paths";
import { skillCommand } from "./skill";
import { sshForward, sshOpen } from "./ssh";
import { resolveTarget, workbenchUrl } from "./target";
import type { TerminalPalette } from "./terminal/osc";
import { uninstallCommand } from "./uninstall";
import { upgrade } from "./upgrade";
import { hex } from "./theme/color";
import { generateTheme, semanticColors } from "./theme/generate";

// hm? does it ever get installed at home dir local?
function shimPath(): string {
  const binHome = process.env.XDG_BIN_HOME ?? path.join(os.homedir(), ".local", "bin");
  return path.join(binHome, "tode");
}

function todeCommand(): string[] {
  const shim = shimPath();
  if (fs.existsSync(shim)) return [shim];
  return [process.execPath, process.argv[1]];
}

async function bootEditorUrl(): Promise<string> {
  const { palette } = await readPalette();
  ensureFont();
  installTheme(palette);
  installCss(palette);
  installSettings();
  setLiveTheme(generateTheme(palette));
  installBridge(todeCommand());
  installKeybindings();
  const server = await ensureServer();
  return workbenchUrl(origin(server), resolveTarget(undefined, process.cwd()));
}

function fail(message: string): never {
  process.stderr.write(`tode: ${message}\n`);
  process.exit(1);
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function takeAll(args: string[], ...names: string[]): string[] {
  const found: string[] = [];
  for (let at = 0; at < args.length;) {
    if (!names.includes(args[at])) {
      at += 1;
      continue;
    }
    const value = args[at + 1];
    if (value === undefined) fail(`${args[at]} needs a value`);
    found.push(value);
    args.splice(at, 2);
  }
  return found;
}

function takeBool(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

const HELP = `Usage: tode [path...] [options]
       tode doctor [--json] [--fix]
       tode --<command>

  tode                  Open the folder in the current working directory
  tode <folder>         Open the specified folder
  tode <file>           Open the specified file


Options:
  -g, --goto <f:l:c>    Open a file at a line and column
  -a, --add <folder>    Add a folder to the active workspace
  -n, --new-window      Open a new pane even for a file
  -w, --wait            Wait until the file is closed again
  -d, --diff <a> <b>    Compare two files
  -r, --reuse-window    Open folder in this window rather than a new pane
  --install-extension   Install an extension by id or vsix path
  --uninstall-extension Remove an extension
  --list-extensions     List installed extensions
  --split <direction>   Open in a new pane: right, left, down, up
  --size <fraction>     The % a new split will take up (0.2 to 0.95)
  --timing              Report how long each stage of this open took
  --review              Open on the source control panel
  --ssh <user@host>     Run terminal-code on an ssh server

Commands, each as the first argument:
  doctor [--json] [--fix]
                        Diagnose terminal-code; --json is parseable stdout,
                        --fix may download verified runtimes, modify managed
                        config, and start the owned local daemon
  --shortcut-setup      Resolve shortcut conflicts between terminal-code and the current terminal
  --timing              Profile terminal-code launch
  --import [editor]     Bring settings, keybindings, snippets and extensions
                        over from vscode compatible editors
  --theme [file]        Set editor theme
  --serve [path]        Start code server and print its url
  --skill               An agent skill to assist with modifying terminal-code
  --upgrade [--check]   Upgrade terminal-code to the latest version
  --shutdown            Stop all terminal-code activities
  --uninstall [--yes]   Remove all terminal-code data from this machine
`;


/**
 * i dont think this stuff is necessary come back to this
 */
const IGNORED: string[] = [
  "--verbose",
  "--disable-gpu",
  "--disable-telemetry",
  "--disable-updates",
  "--no-sandbox",
  "--skip-release-notes",
  "--skip-welcome",
  "--disable-workspace-trust",
];

const IGNORED_WITH_VALUE: string[] = [
  "--log",
  "--locale",
  "--sync",
  "--profile",
  "--user-data-dir",
  "--extensions-dir",
];

const UNSUPPORTED: [string, string][] = [
  ["--disable-extensions", "extensions are per code-server, not per window"],
  ["--disable-extension", "extensions are per code-server, not per window"],
];

function dropIgnored(args: string[]): void {
  for (const flag of IGNORED_WITH_VALUE) takeAll(args, flag);
  for (const flag of IGNORED) takeBool(args, flag);
  for (const [flag, why] of UNSUPPORTED) {
    const had = takeBool(args, flag) || takeAll(args, flag).length > 0;
    if (had) process.stderr.write(`tode: ignoring ${flag}, ${why}\n`);
  }
}

async function openCommand(args: string[]): Promise<number> {
  dropIgnored(args);
  const adding = takeBool(args, "-a") || takeBool(args, "--add");
  const going = takeBool(args, "-g") || takeBool(args, "--goto");
  const diffing = takeBool(args, "-d") || takeBool(args, "--diff");
  const extensions = takeAll(args, "--install-extension");
  const removals = takeAll(args, "--uninstall-extension");
  if (extensions.length > 0 || removals.length > 0) return manageExtensions(extensions, removals);
  if (takeBool(args, "--list-extensions")) {
    return listExtensions(takeBool(args, "--show-versions"));
  }

  const newWindow = takeBool(args, "-n") || takeBool(args, "--new-window");
  const reuse = takeBool(args, "-r") || takeBool(args, "--reuse-window");
  const wait = takeBool(args, "-w") || takeBool(args, "--wait");
  const split = takeFlag(args, "--split");
  const size = takeFlag(args, "--size");
  const timing = takeBool(args, "--timing");
  const review = takeBool(args, "--review");
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) fail(`unknown option ${unknown}`);
  if (size !== undefined && !split) fail("--size only applies with --split");

  if (diffing && args.length !== 2) fail("--diff takes two files");
  const pair = diffing ? args.map((f) => path.resolve(process.cwd(), f)) : [];
  const gotos = going && !diffing ? args.map(parseGoto) : [];

  const positional = diffing || going ? [] : args;
  const wanted = positional.map((argument) => resolveTarget(argument, process.cwd()));
  const files: OpenFile[] = [
    ...wanted.filter((t) => t.file).map((t) => ({ path: t.file! })),
    ...gotos.map((goto) => ({ ...goto, path: path.resolve(process.cwd(), goto.path) })),
  ];
  const folders = wanted
    .filter((t) => t.folder)
    .map((t) => t.folder!)
    .filter((folder, at, all) => all.indexOf(folder) === at);

  const here = adding || reuse;
  const window = newWindow ? null : runningWindow();
  const sendFolders = here ? folders : [];
  const opensAPane = folders.length > 0 && !here;

  if (
    window &&
    !opensAPane &&
    (files.length > 0 || sendFolders.length > 0 || pair.length > 0 || review)
  ) {
    await sendToExtension(
      window,
      {
        files,
        folders: sendFolders,
        add: adding,
        wait,
        diff: pair,
        ...(review ? { view: "scm" } : {}),
      },
      wait ? 0 : 4000,
    ).catch((error) => fail(`could not reach the tode window: ${error.message}`));
    return 0;
  }

  const mark = Date.now();
  const stages: [string, number][] = [];
  const done = (label: string) => stages.push([label, Date.now() - mark]);

  const target = wanted[0] ?? resolveTarget(undefined, process.cwd());
  const runtime = await resolveRuntimeWithProgress();
  done("runtime");
  await ensureCodeServer(narrateFetch(`code-server ${CODE_SERVER_VERSION}`));
  const { palette } = await readPalette();
  ensureFont();
  installTheme(palette);
  installCss(palette);
  installSettings();
  setLiveTheme(generateTheme(palette));
  done("profile");
  autoApplyShared();

  let finalized: Promise<string> | null = null;
  const finalize = () =>
  (finalized ??= (async () => {
    installBridge(todeCommand());
    installKeybindings();
    const server = await ensureServer();
    done("code-server");
    const startupFiles = files.filter((file) => file.line !== undefined || file.path !== target.file);
    if (review || startupFiles.length > 0 || pair.length > 0) {
      requestStartupOpen({
        ...(startupFiles.length > 0 ? { files: startupFiles } : {}),
        ...(pair.length > 0 ? { diff: pair } : {}),
        ...(review ? { view: "scm" } : {}),
      });
    }
    return workbenchUrl(origin(server), target);
  })());

  void ensureServer().catch(() => {});

  const pane = new Pane(runtime, { split, size, stages });
  await runOnboarding(pane, finalize, palette);
  if (pane.owned()) return pane.exited();

  const url = await finalize();
  if (timing) {
    for (const [label, ms] of stages) process.stderr.write(`  ${label.padEnd(12)} ${ms}ms\n`);
  }
  return launchBrowser(runtime, url, palette, { split, size, stages }).catch((error: Error) =>
    fail(error.message),
  );
}

function importProfile(dir: string): void {
  const editor: Editor = { name: "this machine", userDir: dir, extensionsDir: null, lastUsed: 0 };
  process.stdout.write("importing settings\n");
  const report = runImport(editor);
  const parts: string[] = [];
  if (report.settings) parts.push(`${report.settings.imported} settings`);
  if (report.keybindings) parts.push(`${report.keybindings} keybindings`);
  if (report.snippets.length) parts.push(`${report.snippets.length} snippet files`);
  if (report.tasks) parts.push("tasks");
  if (parts.length) process.stdout.write(`imported ${parts.join(", ")}\n`);
  installExtensions(path.join(dir, "extensions.txt"));
}

function installExtensions(listFile: string): void {
  let ids: string[];
  try {
    ids = fs.readFileSync(listFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return;
  }
  const have = new Set(installedExtensions().map((id) => id.toLowerCase()));
  const missing = ids.filter((entry) => !have.has(entry.split("@")[0].toLowerCase()));
  if (missing.length === 0) return;
  process.stdout.write(`installing ${missing.length} extensions\n`);
  const args = missing.flatMap((id) => ["--install-extension", id]);
  if (extensionCommand(args) !== 0) {
    process.stderr.write("  some extensions could not be installed\n");
  }
  registerThemeExtension();
}

function installedExtensions(): string[] {
  const result = spawnSync(
    codeServerBin(),
    ["--list-extensions", "--extensions-dir", EXTENSIONS_DIR, "--user-data-dir", path.join(VSCODE_DIR, "user-data")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function extensionCommand(args: string[], quiet = false): number {
  const result = spawnSync(
    codeServerBin(),
    [...args, "--extensions-dir", EXTENSIONS_DIR, "--user-data-dir", path.join(VSCODE_DIR, "user-data")],
    { stdio: quiet ? ["ignore", "inherit", "ignore"] : "inherit" },
  );
  return result.status ?? 1;
}

function listExtensions(withVersions: boolean): number {
  return extensionCommand(withVersions ? ["--list-extensions", "--show-versions"] : ["--list-extensions"], true);
}

function manageExtensions(install: string[], remove: string[]): number {
  for (const id of remove) {
    const code = extensionCommand(["--uninstall-extension", id]);
    if (code !== 0) return code;
  }
  for (const id of install) {
    const code = extensionCommand(["--install-extension", id]);
    if (code !== 0) return code;
  }
  registerThemeExtension();
  if (install.length > 0) process.stdout.write("open tode again to pick it up\n");
  return 0;
}

function swatch(color: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  return `\x1b[48;2;${r};${g};${b}m   \x1b[0m`;
}

async function themeCommand(file?: string): Promise<number> {
  if (file) {
    const error = setThemeFile(file);
    if (error) {
      process.stderr.write(`tode: ${error}\n`);
      return 1;
    }
    installBridge(todeCommand());
    process.stdout.write(`theme set from ${file} — open windows follow without a reload\n`);
    return 0;
  }
  const { palette, source } = await readPalette();
  // slop copy fixme
  const where = {
    terminal: "read from this terminal",
    cache: "from the cache, this terminal did not answer",
    default: "built in default, no terminal answered and nothing cached",
  }[source];
  const accent = semanticColors(palette);
  const line = (label: string, color: string) => `  ${swatch(color)} ${color}  ${label}\n`;
  process.stdout.write(`palette ${where}\n`);
  process.stdout.write(line("background", hex(palette.background)));
  process.stdout.write(line("foreground", hex(palette.foreground)));
  process.stdout.write(`  ${palette.ansi.map((c) => swatch(hex(c))).join("")}  ansi 0-15\n`);
  for (const [name, color] of Object.entries(accent)) process.stdout.write(line(name, hex(color)));
  const { changed, fingerprint } = installTheme(palette);
  setLiveTheme(generateTheme(palette));
  installBridge(todeCommand());
  installCss(palette);
  installSettings();
  installKeybindings();
  process.stdout.write(
    `\ntheme ${fingerprint} ${changed ? "written" : "already current"}\nfont ${ensureFont()}\n`,
  );
  return 0;
}

type PageTiming = import("./browser/ctx").PageTiming;

const STAGES: [string, string][] = [
  ["renderer started", "code/didStartRenderer"],
  ["workbench script loaded", "code/didLoadWorkbenchMain"],
  ["workbench starting", "code/willStartWorkbench"],
  ["editors restored", "code/didRestoreEditors"],
  ["workbench ready", "code/didStartWorkbench"],
  ["settled", "code/LifecyclePhase/Eventually"],
];

function timingCommand(): number {
  let page: PageTiming;
  try {
    page = JSON.parse(fs.readFileSync(`${CSS_FILE}.timing.json`, "utf8")) as PageTiming;
  } catch {
    process.stdout.write("no page timing recorded yet, open tode once\n");
    return 0;
  }
  let launch: { spawnedAt: number; stages: [string, number][] } | null = null;
  try {
    launch = JSON.parse(fs.readFileSync(`${CSS_FILE}.launch.json`, "utf8"));
  } catch { }
  const bar = (ms: number, of: number) => "\u2588".repeat(Math.max(1, Math.round((ms / of) * 34)));
  const total = Math.max(page.marks["code/didStartWorkbench"] ?? 0, page.loadEnd, 1);
  const seconds = Math.round((Date.now() - page.at) / 1000);
  process.stdout.write(`page load, ${seconds}s ago\n\n`);
  const beforeNavigation = launch ? page.origin - launch.spawnedAt : null;
  const rows: [string, number][] = [
    ...(launch
      ? ([
        ...launch.stages.map(([label, ms]) => [`tode: ${label}`, ms - launch!.stages[launch!.stages.length - 1][1]] as [string, number]),
      ] as [string, number][])
      : []),
    ...(beforeNavigation !== null && beforeNavigation >= 0
      ? ([["browser start to navigation", beforeNavigation]] as [string, number][])
      : []),
    ["document arrived", page.responseEnd],
    ["dom interactive", page.domInteractive],
    ...STAGES.filter(([, mark]) => page.marks[mark] != null).map(
      ([label, mark]) => [label, page.marks[mark]] as [string, number],
    ),
  ];
  for (const [label, ms] of rows) {
    process.stdout.write(`  ${label.padEnd(24)} ${String(ms).padStart(5)}ms  ${bar(ms, total)}\n`);
  }
  return 0;
}

async function shutdownCommand(): Promise<number> {
  const stopped = stopServer();
  const runtime = await resolveRuntime().catch(() => null);
  if (runtime) {
    await new Promise<void>((resolve) => {
      const child = spawn(runtime.bin, ["shutdown"], { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  }
  process.stdout.write(stopped ? "tode stopped\n" : "nothing was running\n");
  return 0;
}

async function upgradeCommand(args: string[]): Promise<number> {
  const check = takeBool(args, "--check");
  const version = takeFlag(args, "--version");
  let announced = false;
  let lastPercent = -1;
  const outcome = await upgrade({
    check,
    version,
    onStage: (stage, fraction) => {
      if (stage !== "downloading") return;
      if (!announced) {
        process.stderr.write("tode: downloading\n");
        announced = true;
      }
      const percent = Math.round(fraction * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
    },
  });

  switch (outcome.kind) {
    case "not-an-install":
      fail(`${outcome.root} is a working tree, not an install — use git pull`);
    // eslint-disable-next-line no-fallthrough
    case "current":
      process.stdout.write(`tode ${outcome.version} is the newest on ${outcome.channel}\n`);
      return 0;
    case "available":
      process.stdout.write(`tode ${outcome.build.version} is available (you have ${outcome.from})\n`);
      return 0;
    case "upgraded": {
      stopServer();
      process.stdout.write(`tode ${outcome.from} -> ${outcome.build.version}\n`);
      return 0;
    }
  }
}

function installedVersion(): string {
  try {
    return fs.readFileSync(path.join(INSTALL_ROOT, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

const FORWARDED_OVER_SSH = [
  "--install-extension",
  "--uninstall-extension",
  "--list-extensions",
  "--shutdown",
  "--upgrade",
];

async function sshCommand(target: string | undefined, args: string[]): Promise<number> {
  if (!target || target.startsWith("-")) fail("--ssh needs a value (user@host or an ssh alias)");
  if (args.some((arg) => FORWARDED_OVER_SSH.includes(arg))) return sshForward(target, args);
  const split = takeFlag(args, "--split");
  const size = takeFlag(args, "--size");
  const unsupported = args.find((arg) => arg.startsWith("-"));
  if (unsupported) fail(`${unsupported} is not supported with --ssh yet`);
  if (args.length > 1) fail("--ssh opens one folder or file");
  const runtime = await resolveRuntimeWithProgress();
  const { palette } = await readPalette();
  return sshOpen(runtime, target, {
    remotePath: args[0],
    palette,
    version: installedVersion(),
    split,
    size,
  });
}

async function serveCommand(args: string[]): Promise<number> {
  const paletteFile = takeFlag(args, "--palette");
  const importDir = takeFlag(args, "--import");
  const prepare = takeBool(args, "--prepare");
  const requested = args.find((arg) => !arg.startsWith("-"));
  await ensureCodeServer(narrateFetch(`code-server ${CODE_SERVER_VERSION}`));
  const palette = paletteFile
    ? (JSON.parse(fs.readFileSync(paletteFile, "utf8")) as TerminalPalette)
    : (await readPalette()).palette;
  if (importDir) importProfile(importDir);
  ensureFont();
  installTheme(palette);
  installCss(palette);
  installSettings();
  setLiveTheme(generateTheme(palette));
  autoApplyShared();
  if (prepare) return 0;
  installBridge(todeCommand());
  installKeybindings();
  const server = await ensureServer();
  const target = resolveTarget(requested, process.cwd());
  process.stdout.write(`READY ${workbenchUrl(origin(server), target)}\n`);
  return 0;
}

async function doctorCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const fix = args.includes("--fix");
  const parsed = parseDoctorArgs(args);
  if (parsed.kind === "usage-error") {
    const report = makeUsageReport(collectDoctorContext(), { json, fix }, parsed.message);
    if (json) process.stdout.write(serializeDoctorJson(report));
    else process.stderr.write(renderDoctorText(report));
    return 64;
  }

  const report = await runDoctor(parsed.options);
  if (parsed.options.json) process.stdout.write(serializeDoctorJson(report));
  else process.stdout.write(renderDoctorText(report));
  return report.summary.exitCode;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${installedVersion()}\n`);
    return 0;
  }
  const sshAt = args.indexOf("--ssh");
  if (sshAt >= 0) {
    const target = args[sshAt + 1];
    args.splice(sshAt, 2);
    return sshCommand(target, args);
  }
  if (args[0] === "--serve") return serveCommand(args.slice(1));
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "doctor") return doctorCommand(args.slice(1));
  if (args[0] === "--shortcut-setup") {
    const rest = args.slice(1);
    const noBoot = takeBool(rest, "--no-boot");
    const code = await shortcutsCommand(rest, noBoot ? undefined : bootEditorUrl);
    if (code === BOOT_AFTER_APPLY) return noBoot ? 0 : openCommand([]);
    return code;
  }
  if (args[0] === "--import") return importCommand(args.slice(1));
  if (args[0] === "--theme") return themeCommand(args[1]);
  // alone it reads the last load's story; next to a path it stays the open
  // option that reports this open's stages
  if (args[0] === "--timing" && args.length === 1) return timingCommand();
  if (args[0] === "--skill") return skillCommand();
  if (args[0] === "--upgrade") return upgradeCommand(args.slice(1));
  if (args[0] === "--shutdown") return shutdownCommand();
  if (args[0] === "--uninstall") return uninstallCommand(args.slice(1));
  return openCommand(args);
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
