import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { alive, kill, sleep } from "../app/control";
import { installedShim } from "../runtime/shim";
import { listenerState } from "./listener";
import { LISTENER_LOG, loggingEnabled } from "./settings";

const LABEL = "dev.zenbu.terminal-code.local-rendering";
const UNIT = "terminal-code-local-rendering.service";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT_FILE = path.join(
  process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config"),
  "systemd",
  "user",
  UNIT,
);

const LISTENER_FLAG = "--local-rendering-listener";

function command(): string[] {
  const shim = installedShim();
  return shim ? [shim, LISTENER_FLAG] : [process.execPath, path.resolve(__dirname, "..", "main.js"), LISTENER_FLAG];
}

function environment(): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: "1",
    PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":"),
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith("TERMINAL_CODE_LOCAL_RENDERING_") ||
      key.startsWith("PIXEL_PAIR_") ||
      key === "TERMINAL_CODE_LINK_PROTOCOL" ||
      key.startsWith("XDG_") ||
      key === "TODE_INSTALL_ROOT"
    ) {
      env[key] = value;
    }
  }
  return env;
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(): string {
  const args = command().map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  const env = Object.entries(environment())
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath())}</string>
</dict>
</plist>
`;
}

function unit(): string {
  const quote = (arg: string) => (/[\s"\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg);
  const env = Object.entries(environment())
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=terminal-code local rendering listener

[Service]
ExecStart=${command().map(quote).join(" ")}
${env}
Restart=on-failure
RestartSec=10
StandardOutput=${loggingEnabled() ? `append:${LISTENER_LOG}` : "null"}
StandardError=${loggingEnabled() ? `append:${LISTENER_LOG}` : "null"}

[Install]
WantedBy=default.target
`;
}

function hasSystemd(): boolean {
  return spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
}

export type ServiceKind = "launchd" | "systemd" | "process";

function isListener(pid: number): boolean {
  const listed = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return listed.status === 0 && listed.stdout.includes(LISTENER_FLAG);
}

async function stopStray(): Promise<void> {
  const state = listenerState();
  if (state && state.pid !== process.pid && alive(state.pid) && isListener(state.pid)) await kill(state.pid);
}

export async function restartService(): Promise<void> {
  if (process.platform === "darwin" && fs.existsSync(PLIST)) {
    spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { stdio: "ignore" });
  } else if (fs.existsSync(UNIT_FILE)) {
    spawnSync("systemctl", ["--user", "try-restart", UNIT], { stdio: "ignore" });
  } else {
    const state = listenerState();
    if (!state || !alive(state.pid) || !isListener(state.pid)) return;
    await installService();
  }
}

function logPath(): string {
  return loggingEnabled() ? LISTENER_LOG : "/dev/null";
}

export async function installService(): Promise<ServiceKind> {
  if (loggingEnabled()) fs.mkdirSync(path.dirname(LISTENER_LOG), { recursive: true });
  await stopStray();
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
    fs.writeFileSync(PLIST, plist());
    const loaded = spawnSync("launchctl", ["bootstrap", domain, PLIST], { encoding: "utf8" });
    if (loaded.status !== 0) throw new Error(`launchctl bootstrap failed: ${(loaded.stderr || "").trim()}`);
    return "launchd";
  }
  if (hasSystemd()) {
    fs.mkdirSync(path.dirname(UNIT_FILE), { recursive: true });
    fs.writeFileSync(UNIT_FILE, unit());
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const started = spawnSync("systemctl", ["--user", "enable", "--now", UNIT], { encoding: "utf8" });
    if (started.status !== 0) throw new Error(`systemctl failed: ${(started.stderr || "").trim()}`);
    spawnSync("systemctl", ["--user", "restart", UNIT], { stdio: "ignore" });
    return "systemd";
  }
  const log = fs.openSync(logPath(), "a");
  const [bin, ...args] = command();
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...environment() } });
  child.unref();
  return "process";
}

export async function removeService(): Promise<void> {
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { stdio: "ignore" });
    fs.rmSync(PLIST, { force: true });
  } else if (fs.existsSync(UNIT_FILE)) {
    spawnSync("systemctl", ["--user", "disable", "--now", UNIT], { stdio: "ignore" });
    fs.rmSync(UNIT_FILE, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
  await stopStray();
}

export function serviceDescription(): string {
  if (process.platform === "darwin") {
    if (!fs.existsSync(PLIST)) return "not installed";
    const printed = spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { encoding: "utf8" });
    const state = /state = (\S+)/.exec(printed.stdout ?? "")?.[1];
    return `launchd agent ${LABEL} (${printed.status === 0 ? (state ?? "loaded") : "not loaded"})`;
  }
  if (fs.existsSync(UNIT_FILE)) {
    const active = spawnSync("systemctl", ["--user", "is-active", UNIT], { encoding: "utf8" }).stdout?.trim();
    return `systemd user unit ${UNIT} (${active || "unknown"})`;
  }
  return "no service installed";
}

export async function waitForListener(withinMs: number): Promise<ReturnType<typeof listenerState>> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const state = listenerState();
    if (state && alive(state.pid) && Date.now() - state.updatedAt < withinMs + 15_000) return state;
    await sleep(200);
  }
  return null;
}
