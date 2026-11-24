import fs from "node:fs";
import net from "node:net";

import { LISTENER_FILE, PAIR_DIR, SETTINGS_FILE, pairPort, privateDir, readSettings } from "./settings";
import { serveLink } from "./screen";
import type { Authorize } from "./screen";
import { isTailnetAddress, judge, plainAddress, self, tailnetAddresses, tailscaleCli, trusted, whois } from "./tailscale";

const RESCAN_MS = 10_000;

export interface ListenerState {
  pid: number;
  port: number;
  addresses: string[];
  failed: Record<string, string>;
  startedAt: number;
  updatedAt: number;
}

export function listenAddresses(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.TERMINAL_CODE_LOCAL_RENDERING_LISTEN?.split(",").map((a) => a.trim()).filter(Boolean);
  return configured && configured.length > 0 ? configured : tailnetAddresses();
}

export function authorizePeer(remoteAddress: string, env: NodeJS.ProcessEnv = process.env): Authorize {
  const ip = plainAddress(remoteAddress);
  return async () => {
    if (trusted(ip, env)) return { ok: true, who: `${ip} (trusted network)` };
    if (!isTailnetAddress(ip)) return { ok: false, who: ip, why: `${ip} is not a tailnet address`, reason: "off-tailnet" };
    const cli = tailscaleCli();
    if (!cli) return { ok: false, who: ip, why: "the tailscale CLI isn't installed here, so the connection can't be verified" };
    const [me, peer] = await Promise.all([self(cli), whois(cli, ip)]);
    return judge(me, peer, readSettings().allowPeers);
  };
}

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

export function listenerState(): ListenerState | null {
  try {
    return JSON.parse(fs.readFileSync(LISTENER_FILE, "utf8")) as ListenerState;
  } catch {
    return null;
  }
}

export async function runListener(): Promise<number> {
  if (!readSettings().enabled) {
    log("local rendering is off, not listening");
    return 0;
  }
  privateDir(PAIR_DIR);
  const port = pairPort();
  const servers = new Map<string, net.Server>();
  const failed: Record<string, string> = {};
  const startedAt = Date.now();

  const writeState = () => {
    const state: ListenerState = {
      pid: process.pid,
      port,
      addresses: [...servers.keys()],
      failed,
      startedAt,
      updatedAt: Date.now(),
    };
    try {
      fs.writeFileSync(`${LISTENER_FILE}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(`${LISTENER_FILE}.tmp`, LISTENER_FILE);
    } catch {}
  };

  const listen = (address: string) => {
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      const peer = socket.remoteAddress ?? "?";
      void serveLink(socket, { authorize: authorizePeer(peer), log: (line) => log(`[${plainAddress(peer)}] ${line}`) }).catch(
        (error: Error) => log(`[${peer}] ${error.message}`),
      );
    });
    servers.set(address, server);
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (failed[address] !== error.code) log(`can't listen on ${address}:${port}: ${error.message}`);
      failed[address] = error.code ?? error.message;
      servers.delete(address);
      server.close();
      writeState();
    });
    server.listen({ host: address, port }, () => {
      delete failed[address];
      log(`listening on ${address.includes(":") ? `[${address}]` : address}:${port}`);
      writeState();
    });
  };

  const rescan = () => {
    const wanted = new Set(listenAddresses());
    for (const [address, server] of servers) {
      if (wanted.has(address)) continue;
      server.close();
      servers.delete(address);
      log(`stopped listening on ${address}`);
    }
    for (const address of wanted) if (!servers.has(address)) listen(address);
    if (wanted.size === 0 && Object.keys(failed).length === 0) failed["*"] = "no tailnet address on this machine";
    else delete failed["*"];
    writeState();
  };
  rescan();
  setInterval(rescan, RESCAN_MS);

  const stopIfDisabled = () => {
    if (readSettings().enabled) return;
    log("local rendering was turned off");
    process.exit(0);
  };
  fs.watchFile(SETTINGS_FILE, { interval: 2000 }, stopIfDisabled);

  const leave = () => {
    try {
      const state = listenerState();
      if (state?.pid === process.pid) fs.rmSync(LISTENER_FILE, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", leave);
  process.on("SIGINT", leave);
  return new Promise<number>(() => {});
}
