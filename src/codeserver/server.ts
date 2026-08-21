import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { DATA_DIR, LOGS_DIR, STATE_DIR } from "../runtime/paths";
import {
  CLI_DATA_DIR,
  ensureVscodeCli,
  installedVscodeCli,
  installedVscodeServer,
  narrateFetch,
} from "./vendored";

/** `--server-data-dir`: the real server keeps its user data in <dir>/data and
 * its extensions in <dir>/extensions, which is the layout src/profile.ts
 * writes into. */
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
export const CSS_FILE = path.join(DATA_DIR, "inject.css");
// kept apart from the run state, which is cleared on every stop
export const PORT_FILE = path.join(DATA_DIR, "injector.port");

export const SERVER_LOG = path.join(LOGS_DIR, "vscode-server.log");

/** The same file src/profile.ts writes; named here too so the injector can be
 * handed it without server.ts importing profile.ts, which imports this. */
export const SETTINGS_FILE = path.join(VSCODE_DIR, "data", "User", "settings.json");

function fontAsset(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "fonts", "JetBrainsMono-Regular.ttf");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return "";
  }
}

export function vscodeCliBin(): string {
  const found = installedVscodeCli();
  if (found) return found;
  throw new Error("the VS Code cli is not fetched yet");
}

/** How the workbench is served: Microsoft's `code serve-web`, on loopback,
 * with no connection token because the injector in front of it is the only
 * thing that ever connects. */
export function serveWebArgs(port: number): string[] {
  return [
    "serve-web",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--without-connection-token",
    "--accept-server-license-terms",
    "--server-data-dir",
    VSCODE_DIR,
    "--cli-data-dir",
    CLI_DATA_DIR,
    "--disable-telemetry",
  ];
}

function readState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ServerState;
  } catch {
    return null;
  }
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

  const bin = await ensureVscodeCli(narrateFetch("the VS Code cli"));
  // asked now, awaited after the injector is up — the version is a detail for
  // `tode daemon status`, not something the boot should stall on
  const version = serverVersion(bin);
  const port = await freePort();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const log = fs.openSync(SERVER_LOG, "a");
  // serve-web only pulls the server down when a page is asked for, so a first
  // run is a long quiet moment unless it says what it is doing
  if (!installedVscodeServer()) {
    process.stderr.write("tode: fetching the VS Code server, the first window waits on it\n");
  }
  const child = spawn(bin, serveWebArgs(port), {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  if (!child.pid) throw new Error("could not start code serve-web");

  const injector = await startInjector(port, log);
  void serveWebReady(port, child.pid).then((up) => {
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

async function serveWebReady(port: number, pid: number): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await answering(port)) return true;
    if (!running(pid)) return false;
    await sleep(60);
  }
  return false;
}

/** The server itself only lands on disk once serve-web has been asked for a
 * page, so anything that needs the binary — installing an extension, listing
 * them — starts the server and waits for the download to finish. */
export async function ensureVscodeServer(): Promise<string> {
  const already = installedVscodeServer();
  if (already) return already;

  const state = await ensureServer();
  await fetch(origin(state), { headers: { accept: "text/html" } }).catch(() => null);
  const deadline = Date.now() + 10 * 60_000;
  let announced = false;
  while (Date.now() < deadline) {
    const bin = installedVscodeServer();
    if (bin) return bin;
    if (!announced) {
      process.stderr.write("tode: fetching the VS Code server\n");
      announced = true;
    }
    await sleep(500);
  }
  throw new Error(`the VS Code server did not download — see ${SERVER_LOG}`);
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
  const script = path.join(__dirname, "injector-main.js");
  const font = fontAsset();
  const child = spawn(
    process.execPath,
    [script, String(upstream), String(port), CSS_FILE, font, SETTINGS_FILE],
    { detached: true, stdio: ["ignore", log, log] },
  );
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
