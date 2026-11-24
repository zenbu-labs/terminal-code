import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { transferToLocalRendering } from "@zenbu-labs/pixel/pair";
import type { LocalRenderingResult } from "@zenbu-labs/pixel/pair";

import { installVersion } from "../app/protocol";
import { alive } from "../app/control";
import { currentServer, windowUrl } from "../codeserver/server";
import { COMMAND } from "../runtime/shim";
import { fallback, recordAttempt, sshEndpoints, summarize } from "./attempt";
import type { Failure, Reason, Route } from "./attempt";
import { Mux, nextControl, pipeBoth } from "./link";
import type { Control } from "./link";
import { LINK_PROTOCOL, PIXEL_PROTOCOL, TUNNELS_DIR, pairPort, readSettings } from "./settings";
import { isTailnetAddress, trusted } from "./tailscale";

const DIRECT_TIMEOUT_MS = 2500;
const HANDSHAKE_TIMEOUT_MS = 6000;

export interface Target {
  route: Route;
  label: string;
  connect: net.NetConnectOpts;
  address?: string;
  socketFile?: string;
}

export function localAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.TERMINAL_CODE_LOCAL_RENDERING_ADDRESS?.trim();
  if (configured) return configured;
  return sshEndpoints(env)?.client ?? null;
}

export function tunnelSockets(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(TUNNELS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".sock"))
    .map((name) => path.join(TUNNELS_DIR, name))
    .filter((file) => {
      const pid = Number(path.basename(file, ".sock"));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return true;
      fs.rmSync(file, { force: true });
      return false;
    });
}

export function targets(enabled = readSettings().enabled): Target[] {
  if (!enabled) return [];
  const found: Target[] = tunnelSockets().map((socketFile) => ({
    route: "tunnel" as const,
    label: `ssh tunnel ${path.basename(socketFile)}`,
    connect: { path: socketFile },
    socketFile,
  }));
  const address = localAddress();
  if (address) {
    found.push({
      route: "direct",
      label: `${address.includes(":") ? `[${address}]` : address}:${pairPort()}`,
      connect: { host: address, port: pairPort() },
      address,
    });
  }
  return found;
}

function dial(target: Target): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.connect);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    }, DIRECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function dialFailure(target: Target, error: NodeJS.ErrnoException): Failure {
  const reason: Reason = error.code === "ECONNREFUSED" ? "not-listening" : "unreachable";
  const detail =
    error.code === "ETIMEDOUT" ? `no answer within ${DIRECT_TIMEOUT_MS / 1000}s` : `${error.code ?? ""} ${error.message}`.trim();
  return { route: target.route, target: target.label, reason, detail };
}

export interface Linked {
  mux: Mux;
  welcome: Control;
  ms: number;
}

function olderLink(theirs: unknown): "screen" | "server" {
  const range = Array.isArray(theirs) ? (theirs as number[]) : [0, 0];
  return Number(range[1]) < LINK_PROTOCOL[0] ? "screen" : "server";
}

export async function link(target: Target, probe = false): Promise<Linked | Failure> {
  const begun = Date.now();
  if (target.address && !isTailnetAddress(target.address) && !trusted(target.address)) {
    return {
      route: target.route,
      target: target.label,
      reason: "untrusted-address",
      detail: `${target.address} is not a tailnet address`,
    };
  }
  let socket: net.Socket;
  try {
    socket = await dial(target);
  } catch (error) {
    if (target.socketFile && (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      fs.rmSync(target.socketFile, { force: true });
    }
    return dialFailure(target, error as NodeJS.ErrnoException);
  }
  const mux = new Mux(socket, false);
  mux.control({
    type: "hello",
    app: "terminal-code",
    version: installVersion(),
    link: LINK_PROTOCOL,
    host: os.hostname(),
    user: os.userInfo().username,
    probe,
  });
  const reply = await nextControl(mux, HANDSHAKE_TIMEOUT_MS);
  const failure = (reason: Reason, detail: string, peerVersion?: unknown): Failure => {
    mux.close();
    return {
      route: target.route,
      target: target.label,
      reason,
      detail,
      ...(typeof peerVersion === "string" ? { peerVersion } : {}),
    };
  };
  if (!reply) return failure("no-answer", `no handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s`);
  if (reply.type === "refused") {
    const detail = String(reply.message ?? reply.reason ?? "refused");
    if (reply.reason === "link") {
      const older = olderLink(reply.link);
      return failure(older === "screen" ? "screen-too-old" : "server-too-old", detail, reply.version);
    }
    if (reply.reason === "not-allowed") return failure("not-allowed", detail, reply.version);
    if (reply.reason === "off-tailnet") return failure("off-tailnet", detail, reply.version);
    return failure("refused", detail, reply.version);
  }
  if (reply.type !== "welcome") return failure("no-answer", `unexpected reply ${reply.type}`);
  const pixel = Array.isArray(reply.pixel) ? (reply.pixel as unknown[]).map(Number) : null;
  if (pixel && (pixel[1] < PIXEL_PROTOCOL[0] || PIXEL_PROTOCOL[1] < pixel[0])) {
    const detail = `pixel protocol ${PIXEL_PROTOCOL.join("-")} here, ${pixel.join("-")} there`;
    return failure(pixel[1] < PIXEL_PROTOCOL[0] ? "screen-too-old" : "server-too-old", detail, reply.version);
  }
  return { mux, welcome: reply, ms: Date.now() - begun };
}

function pixelFailure(target: Target, peerVersion: string | undefined, error: Extract<LocalRenderingResult, { started: false }>["error"]): Failure {
  const base = { route: target.route, target: target.label, ...(peerVersion ? { peerVersion } : {}) };
  switch (error.kind) {
    case "protocol":
      return {
        ...base,
        reason: error.older === "screen" ? "screen-too-old" : "server-too-old",
        detail: `pixel protocol ${error.remote.join("-")} here, ${error.screen.join("-")} there`,
      };
    case "refused":
      return { ...base, reason: "refused", detail: error.message };
    case "disconnected":
      return { ...base, reason: "lost", detail: "the connection closed before rendering started" };
    case "timeout":
      return { ...base, reason: "failed", detail: "rendering didn't start in time" };
    default:
      return { ...base, reason: "failed", detail: error.kind };
  }
}

function note(line: string): void {
  process.stderr.write(`${COMMAND}: ${line}\n`);
}

async function freshUrl(url: string): Promise<string> {
  const server = await currentServer();
  const next = new URL(url).searchParams.get("next");
  return server && next ? windowUrl(server, new URL(next, url).toString()) : url;
}

export async function renderLocally(url: string): Promise<number | string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.PIXEL_EMBED) return null;
  const tried = targets();
  if (tried.length === 0) return null;
  const parsed = new URL(url);
  const port = Number(parsed.port);
  const failures: Failure[] = [];
  let spent = false;

  for (const target of tried) {
    const linked = await link(target);
    if ("reason" in linked) {
      failures.push(linked);
      continue;
    }
    const { mux, welcome } = linked;
    const attemptUrl = spent ? await freshUrl(url) : url;
    spent = true;
    const peerVersion = typeof welcome.version === "string" ? welcome.version : undefined;
    const peerHost = typeof welcome.host === "string" ? welcome.host : undefined;
    const rendering = transferToLocalRendering({
      send: (message) => mux.pixel(message),
      meta: { url: attemptUrl, port, host: os.hostname() },
    });
    mux.onPixel = (message) => rendering.receive(message);
    mux.onClose(() => rendering.disconnected());
    mux.onOpen = (channel, info) => {
      if (Number(info.port) !== port) {
        channel.destroy();
        return;
      }
      pipeBoth(channel, net.connect({ host: "127.0.0.1", port }));
    };
    const result = await rendering.done;
    mux.close();
    if (result.started && !result.lost) {
      recordAttempt({ ok: true, route: target.route, target: target.label, peerVersion, peerHost, failures, summary: `rendered on ${peerHost ?? target.label}`, steps: [] });
      return result.code;
    }
    if (!result.started && result.error.kind === "cancelled") return 130;
    if (!result.started && result.error.kind === "noTerminal") return null;
    const failure: Failure = result.started
      ? { route: target.route, target: peerHost ?? target.label, reason: "lost", detail: "the connection dropped while rendering", ...(peerVersion ? { peerVersion } : {}) }
      : pixelFailure(target, peerVersion, result.error);
    failures.push(failure);
    if (result.started) break;
  }

  fallback(failures);
  note(`rendering on this server, ${summarize(failures[0])}`);
  note(`run ${COMMAND} --local-rendering-doctor for details`);
  return spent ? freshUrl(url) : null;
}
