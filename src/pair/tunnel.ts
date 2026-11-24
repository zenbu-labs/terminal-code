import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Duplex, PassThrough } from "node:stream";

import { resolveSshTarget } from "@zenbu-labs/pixel/ssh";

import { installVersion } from "../app/protocol";
import { COMMAND } from "../runtime/shim";
import { Mux, nextControl, pipeBoth } from "./link";
import { serveLink } from "./screen";
import { LINK_PROTOCOL, PAIR_DIR, TUNNELS_DIR, installCommand, privateDir } from "./settings";

const PREAMBLE = Buffer.from("\nterminal-code-tunnel\n");
const PING_MS = 5000;
const DEAD_MS = 20_000;

function keepAlive(mux: Mux, dead: () => void): void {
  let heard = Date.now();
  const previous = mux.onControl;
  mux.onControl = (message) => {
    heard = Date.now();
    if (message.type !== "ping") previous(message);
  };
  const timer = setInterval(() => {
    if (Date.now() - heard > DEAD_MS) {
      clearInterval(timer);
      dead();
      return;
    }
    mux.control({ type: "ping" });
  }, PING_MS);
  timer.unref();
  mux.onClose(() => clearInterval(timer));
}

export async function runTunnel(): Promise<number> {
  privateDir(PAIR_DIR);
  privateDir(TUNNELS_DIR);
  const socketPath = path.join(TUNNELS_DIR, `${process.pid}.sock`);
  fs.rmSync(socketPath, { force: true });
  const removeSocket = () => fs.rmSync(socketPath, { force: true });
  process.on("exit", removeSocket);

  process.stdout.write(PREAMBLE);
  const mux = new Mux(Duplex.from({ readable: process.stdin, writable: process.stdout }), true);
  const server = net.createServer((connection) => {
    pipeBoth(connection, mux.open({ type: "connection" }));
  });
  const leave = () => {
    server.close();
    removeSocket();
    process.exit(0);
  };
  mux.onClose(leave);
  keepAlive(mux, leave);
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, leave);

  const umask = process.umask(0o177);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  }).finally(() => process.umask(umask));
  fs.chmodSync(socketPath, 0o600);
  mux.control({ type: "tunnel", version: installVersion(), link: LINK_PROTOCOL, host: os.hostname() });
  return new Promise<number>(() => {});
}

const REMOTE_SCRIPT = [
  `tc="$HOME/.local/bin/terminal-code"`,
  `[ -x "$tc" ] || tc="$HOME/.local/bin/tode"`,
  `[ -x "$tc" ] || { echo "terminal-code-missing" >&2; exit 127; }`,
  `exec "$tc" --local-rendering-tunnel`,
].join("; ");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function ask(question: string): Promise<string> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    prompt.question(question, (answer) => {
      prompt.close();
      resolve(answer.trim());
    });
    prompt.on("close", () => resolve(""));
  });
}

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function afterPreamble(source: NodeJS.ReadableStream): PassThrough {
  const out = new PassThrough();
  let seen = Buffer.alloc(0);
  let found = false;
  source.on("data", (chunk: Buffer) => {
    if (found) {
      out.write(chunk);
      return;
    }
    seen = Buffer.concat([seen, chunk]);
    const at = seen.indexOf(PREAMBLE);
    if (at < 0) {
      if (seen.length > 1 << 20) seen = seen.subarray(seen.length - PREAMBLE.length);
      return;
    }
    found = true;
    out.write(seen.subarray(at + PREAMBLE.length));
  });
  source.on("end", () => out.end());
  return out;
}

export async function setupSshCommand(args: string[]): Promise<number> {
  let target = args.join(" ").trim();
  if (!target) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${COMMAND}: --setup-ssh needs a destination (user@host)\n`);
      return 1;
    }
    target = await ask("ssh destination (user@host): ");
    if (!target) return 1;
  }
  let destination: string;
  let hostArgs: string[];
  try {
    ({ destination, hostArgs } = resolveSshTarget(target));
  } catch (error) {
    process.stderr.write(`${COMMAND}: ${(error as Error).message}\n`);
    return 1;
  }

  const batch = spawnSync("ssh", [...hostArgs, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", destination, "true"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (batch.status !== 0) {
    const said = batch.stderr ?? "";
    if (/permission denied|password|keyboard-interactive/i.test(said)) {
      process.stdout.write(`${destination} asks for a password\n`);
    } else if (/host key verification failed/i.test(said)) {
      process.stdout.write(`${destination} isn't a known host yet; ssh will ask you to confirm its key\n`);
    } else if (said.trim()) {
      process.stderr.write(said);
      return 1;
    }
  }

  const child = spawn(
    "ssh",
    [
      ...hostArgs,
      "-T",
      "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=3",
      "-o", "ConnectTimeout=15",
      destination,
      `sh -c ${shellQuote(REMOTE_SCRIPT)}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    errors = (errors + text).slice(-4000);
    if (!text.includes("terminal-code-missing")) process.stderr.write(text);
  });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 255));
    child.on("error", () => resolve(255));
  });

  const mux = new Mux(Duplex.from({ readable: afterPreamble(child.stdout), writable: child.stdin }), false);
  const hello = await Promise.race([nextControl(mux, 24 * 60 * 60 * 1000), exited.then(() => null)]);
  if (!hello || hello.type !== "tunnel") {
    const code = await Promise.race([exited, new Promise<number>((resolve) => setTimeout(() => resolve(255), 2000))]);
    child.kill();
    return explainFailure(destination, code, errors);
  }
  const range = Array.isArray(hello.link) ? (hello.link as number[]) : [0, 0];
  if (range[1] < LINK_PROTOCOL[0] || LINK_PROTOCOL[1] < range[0]) {
    child.kill();
    process.stderr.write(
      range[1] < LINK_PROTOCOL[0]
        ? `${COMMAND} on ${destination} (${String(hello.version)}) is too old for this one. On ${destination}, run:\n    ${COMMAND} --upgrade\n`
        : `${COMMAND} here (${installVersion()}) is too old for ${destination} (${String(hello.version)}). Here,\nplease run install/upgrade ${COMMAND} (this command will upgrade if already installed):\n    ${installCommand()}\n`,
    );
    return 1;
  }

  const host = String(hello.host ?? destination);
  process.stdout.write(
    `connected to ${destination} (${COMMAND} ${String(hello.version)})\n` +
      `${COMMAND} on ${host} now renders here\n` +
      `ctrl+c disconnects\n`,
  );
  keepAlive(mux, () => child.kill());
  mux.onOpen = (channel) => {
    void serveLink(channel, {
      authorize: async () => ({ ok: true, who: host }),
      log: (line) => process.stdout.write(`${stamp()} ${line}\n`),
    });
  };
  let stopping = false;
  const stop = () => {
    stopping = true;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  const code = await exited;
  mux.close();
  process.stdout.write(`disconnected from ${destination}\n`);
  return stopping ? 0 : code || 1;
}

function explainFailure(destination: string, code: number, errors: string): number {
  if (code === 127 || errors.includes("terminal-code-missing")) {
    process.stderr.write(
      `${COMMAND} isn't installed on ${destination}. On ${destination}, ` +
        `please run install/upgrade ${COMMAND} (this command will upgrade if already installed):\n` +
        `    ${installCommand()}\n`,
    );
    return 1;
  }
  if (/unknown option --local-rendering-tunnel/.test(errors)) {
    process.stderr.write(
      `${COMMAND} on ${destination} is too old for --setup-ssh. On ${destination}, ` +
        `please run install/upgrade ${COMMAND} (this command will upgrade if already installed):\n` +
        `    ${installCommand()}\n`,
    );
    return 1;
  }
  process.stderr.write(`couldn't connect to ${destination} (ssh exited with ${code})\n`);
  return code || 1;
}
