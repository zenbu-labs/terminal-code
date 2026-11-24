import type net from "node:net";
import os from "node:os";
import type { Duplex } from "node:stream";

import { handleLocalRendering } from "@zenbu-labs/pixel/pair";
import type { LocalRenderLaunch, Started } from "@zenbu-labs/pixel/pair";

import { linesOf } from "../app/control";
import { installVersion } from "../app/protocol";
import type { Reply } from "../app/protocol";
import { openSession } from "../launch";
import { Mux, nextControl } from "./link";
import type { Control } from "./link";
import { LINK_PROTOCOL, PIXEL_PROTOCOL } from "./settings";
import { socksServer } from "./socks";
import { COMMAND } from "../runtime/shim";

export type Authorize = (
  hello: Control,
) => Promise<{ ok: true; who: string } | { ok: false; who: string; why: string; reason?: string }>;

export interface ServeOptions {
  authorize: Authorize;
  log(line: string): void;
}

const HELLO_TIMEOUT_MS = 8000;

function overlaps(theirs: unknown): boolean {
  if (!Array.isArray(theirs) || theirs.length !== 2) return false;
  const [low, high] = theirs.map(Number);
  return low <= LINK_PROTOCOL[1] && LINK_PROTOCOL[0] <= high;
}

export async function serveLink(stream: Duplex, options: ServeOptions): Promise<void> {
  const mux = new Mux(stream, true);
  const hello = await nextControl(mux, HELLO_TIMEOUT_MS);
  if (!hello || hello.type !== "hello") {
    mux.close();
    return;
  }
  const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}) => {
    options.log(`refused ${String(hello.host ?? "?")}: ${message}`);
    mux.control({ type: "refused", reason, message, version: installVersion(), link: LINK_PROTOCOL, ...extra });
    setTimeout(() => mux.close(), 200);
  };
  if (!overlaps(hello.link)) {
    return refuse("link", `link protocol ${JSON.stringify(hello.link)} on the server, ${LINK_PROTOCOL.join("-")} on the local machine`);
  }
  const verdict = await options.authorize(hello).catch((error: Error) => ({
    ok: false as const,
    who: String(hello.host ?? "?"),
    why: `couldn't verify who is connecting: ${error.message}`,
  }));
  if (!verdict.ok) return refuse(("reason" in verdict && verdict.reason) || "not-allowed", verdict.why);
  mux.control({ type: "welcome", version: installVersion(), link: LINK_PROTOCOL, pixel: PIXEL_PROTOCOL, host: os.hostname() });
  if (hello.probe) {
    options.log(`checked by ${verdict.who}`);
    setTimeout(() => mux.close(), 200);
    return;
  }
  options.log(`rendering for ${verdict.who} (${COMMAND} ${String(hello.version)})`);
  const handled = handleLocalRendering({
    send: (message) => mux.pixel(message),
    start: (launch) => streamedWindow(launch, mux, options.log),
    log: (line) => options.log(`  ${line}`),
  });
  mux.onPixel = (message) => handled.receive(message);
  mux.onClose(() => handled.disconnected());
  await handled.closed;
  mux.close();
  options.log(`stopped rendering for ${verdict.who}`);
}

interface WindowMeta {
  url: string;
  port: number;
  host: string;
}

function windowMeta(meta: unknown): WindowMeta | null {
  const given = (meta ?? {}) as Record<string, unknown>;
  if (typeof given.url !== "string" || typeof given.port !== "number") return null;
  let parsed: URL;
  try {
    parsed = new URL(given.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== given.port) return null;
  const host = typeof given.host === "string" && given.host ? given.host : "server";
  return { url: parsed.toString(), port: given.port, host };
}

function partitionFor(host: string): string {
  return `persist:pair-${host.toLowerCase().replace(/[^a-z0-9.-]/g, "_").slice(0, 64)}`;
}

function streamedWindow(launch: LocalRenderLaunch, mux: Mux, log: (line: string) => void): Started {
  const target = windowMeta(launch.meta);
  let socket: net.Socket | null = null;
  let proxy: net.Server | null = null;
  let stopped = false;
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = (code) => {
      proxy?.close();
      resolve(code);
    };
  });

  void (async () => {
    if (!target) {
      log(`refused to render a page that isn't the server's ${COMMAND}`);
      return settle(1);
    }
    const front = await socksServer(target.port, () => mux.open({ type: "connect", port: target.port }));
    proxy = front.server;
    if (stopped) return settle(0);
    const session = await openSession({
      cmd: "open",
      tty: "",
      url: target.url,
      env: launch.env,
      proxy: `socks5://127.0.0.1:${front.port}`,
      partition: partitionFor(target.host),
    });
    socket = session.socket;
    if ("ok" in session.reply && !session.reply.ok) {
      log(`renderer: ${session.reply.error}`);
      session.socket.destroy();
      return settle(1);
    }
    if (stopped) session.socket.write(`${JSON.stringify({ cmd: "close" })}\n`);
    linesOf(session.socket).on("line", (event: Reply) => {
      if ("event" in event && event.event === "closed") settle(event.code);
    });
    session.socket.on("close", () => settle(0));
    session.socket.on("error", () => settle(1));
  })().catch((error: Error) => {
    log(`renderer: ${error.message}`);
    settle(1);
  });

  return {
    exited,
    stop() {
      stopped = true;
      if (!socket) return;
      try {
        socket.write(`${JSON.stringify({ cmd: "close" })}\n`);
      } catch {}
      setTimeout(() => socket?.destroy(), 3000).unref();
    },
  };
}
