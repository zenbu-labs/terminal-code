import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { DATA_DIR, LOGS_DIR, STATE_DIR } from "../runtime/paths";
import { CODE_SERVER_VERSION, ensureCodeServer, installedCodeServer, narrateFetch } from "./vendored";

const VSCODE_DIR = path.join(DATA_DIR, "vscode");
export const STATE_FILE = path.join(STATE_DIR, "server.json");

export interface ServerState {
  pid: number;
  port: number;
  /** the injecting proxy the browser actually talks to */
  injectorPid: number;
  injectorPort: number;
  version: string;
  startedAt: number;
}
/**
 * this is odd i would say
 */

export const CSS_FILE = path.join(DATA_DIR, "inject.css");
// kept apart from the run state, which is cleared on every stop
export const PORT_FILE = path.join(DATA_DIR, "injector.port");

function fontAsset(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "fonts", "JetBrainsMono-Regular.ttf");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return "";
  }
}

export function codeServerBin(): string {
  const found = installedCodeServer();
  if (found) return found;
  throw new Error(`code-server ${CODE_SERVER_VERSION} not found`);
}

function readState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ServerState;
  } catch {
    return null;
  }
}

export function readServerState(): ServerState | null {
  return readState();
}

function writeState(state: ServerState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function answering(port: number, timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function currentServer(): Promise<ServerState | null> {
  const state = readState();
  if (!state || !running(state.pid) || !running(state.injectorPid)) return null;
  const [up, proxied] = await Promise.all([answering(state.port), answering(state.injectorPort)]);
  return up && proxied ? state : null;
}

function serverVersion(bin: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { encoding: "utf8" }, (error, stdout) => {
      resolve(error ? "unknown" : stdout.split("\n")[0].trim());
    });
  });
}

let booting: Promise<ServerState> | null = null;

export function ensureServer(): Promise<ServerState> {
  if (!booting) {
    booting = startServer();
    booting.catch(() => {
      booting = null;
    });
  }
  return booting;
}

async function startServer(): Promise<ServerState> {
  const existing = await currentServer();
  if (existing) return existing;

  const bin = await ensureCodeServer(narrateFetch(`code-server ${CODE_SERVER_VERSION}`));
  // asked now, awaited after the injector is up — the version is a detail for
  // `tode daemon status`, not something the boot should stall on
  const version = serverVersion(bin);
  const port = await freePort();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const log = fs.openSync(path.join(LOGS_DIR, "code-server.log"), "a");
  const child = spawn(
    bin,
    [
      "--auth",
      "none",
      "--bind-addr",
      `127.0.0.1:${port}`,
      "--user-data-dir",
      path.join(VSCODE_DIR, "user-data"),
      "--extensions-dir",
      path.join(VSCODE_DIR, "extensions"),
      "--app-name",
      "tode",
      "--disable-telemetry",
      "--disable-update-check",
      "--disable-workspace-trust",
      "--disable-getting-started-override",
      "--ignore-last-opened",
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        EXTENSIONS_GALLERY: JSON.stringify({
          serviceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery",
          itemUrl: "https://marketplace.visualstudio.com/items",
          cacheUrl: "https://vscode.blob.core.windows.net/gallery/index",
          controlUrl: "",
        }),
      },
    },
  );
  child.unref();
  if (!child.pid) throw new Error("could not start code-server");

  const injector = await startInjector(port, log);
  void codeServerReady(port, child.pid).then((up) => {
    if (up) void warmUp(injector.port);
  });
  const state = {
    pid: child.pid,
    port,
    injectorPid: injector.pid,
    injectorPort: injector.port,
    version: await version,
    startedAt: Date.now(),
  };
  writeState(state);
  return state;
}

async function codeServerReady(port: number, pid: number): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await answering(port)) return true;
    if (!running(pid)) return false;
    await sleep(60);
  }
  return false;
}

async function injectorPort(portFile: string): Promise<number> {
  let previous = 0;
  try {
    previous = Number(fs.readFileSync(portFile, "utf8").trim());
  } catch {}
  const port = previous && (await available(previous)) ? previous : await freePort();
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port));
  return port;
}

export function available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

export async function startInjector(
  upstream: number,
  log: number,
  portFile = PORT_FILE,
): Promise<{ pid: number; port: number }> {
  const port = await injectorPort(portFile);
  // interesting? a script?
  const script = path.join(__dirname, "injector-main.js");
  const font = fontAsset();
  const child = spawn(process.execPath, [script, String(upstream), String(port), CSS_FILE, font], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  if (!child.pid) throw new Error("could not start the css injector");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await answering(port)) return { pid: child.pid, port };
    if (!running(child.pid)) throw new Error("the css injector exited during start");
    await sleep(40);
  }
  throw new Error("the css injector did not start within 10s");
}

async function warmUp(port: number): Promise<void> {
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: "text/html" },
    });
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    await Promise.all(
      assets.slice(0, 4).map((asset) =>
        fetch(new URL(asset, `http://127.0.0.1:${port}/`)).then((r) => r.arrayBuffer()).catch(() => null),
      ),
    );
  } catch {}
}

export function stopServer(): boolean {
  const state = readState();
  if (!state) return false;
  let stopped = false;
  for (const pid of [state.injectorPid, state.pid]) {
    if (pid && running(pid)) {
      process.kill(pid, "SIGTERM");
      stopped = true;
    }
  }
  fs.rmSync(STATE_FILE, { force: true });
  return stopped;
}

export function origin(state: ServerState): string {
  return `http://127.0.0.1:${state.injectorPort}/`;
}
