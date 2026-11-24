import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

const CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/usr/sbin/tailscale",
];

export function tailscaleCli(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/tailscale`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function run(cli: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

export function plainAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isTailnetAddress(address: string): boolean {
  const ip = plainAddress(address);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return net.isIPv6(ip) && ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function tailnetAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isTailnetAddress(entry.address)) found.push(entry.address);
    }
  }
  return [...new Set(found)];
}

export interface Self {
  userId: number;
  login: string | null;
  host: string;
  dnsName: string;
}

export async function self(cli: string): Promise<Self> {
  const status = JSON.parse(await run(cli, ["status", "--json"])) as {
    BackendState?: string;
    Self?: { UserID?: number; HostName?: string; DNSName?: string };
    User?: Record<string, { LoginName?: string }>;
  };
  if (status.BackendState && status.BackendState !== "Running") {
    throw new Error(`tailscale is ${status.BackendState.toLowerCase()}`);
  }
  const userId = Number(status.Self?.UserID);
  return {
    userId,
    login: status.User?.[String(userId)]?.LoginName ?? null,
    host: status.Self?.HostName ?? "",
    dnsName: (status.Self?.DNSName ?? "").replace(/\.$/, ""),
  };
}

export interface Peer {
  userId: number;
  login: string;
  host: string;
  dnsName: string;
  tags: string[];
}

export async function whois(cli: string, address: string): Promise<Peer> {
  const answer = JSON.parse(await run(cli, ["whois", "--json", plainAddress(address)])) as {
    Node?: { Name?: string; ComputedName?: string; Hostinfo?: { Hostname?: string }; Tags?: string[]; User?: number };
    UserProfile?: { ID?: number; LoginName?: string };
  };
  const dnsName = (answer.Node?.Name ?? "").replace(/\.$/, "");
  return {
    userId: Number(answer.UserProfile?.ID ?? answer.Node?.User),
    login: answer.UserProfile?.LoginName ?? "",
    host: answer.Node?.ComputedName ?? answer.Node?.Hostinfo?.Hostname ?? dnsName.split(".")[0] ?? "",
    dnsName,
    tags: answer.Node?.Tags ?? [],
  };
}

export type Verdict = { ok: true; who: string } | { ok: false; who: string; why: string };

export function judge(me: Self, peer: Peer, allowPeers: string[]): Verdict {
  const who = peer.tags.length > 0 ? `${peer.host} (${peer.tags.join(", ")})` : `${peer.host} (${peer.login})`;
  const named = allowPeers.some((allowed) => {
    const wanted = allowed.toLowerCase();
    return [peer.host, peer.dnsName, peer.login].some((name) => name && name.toLowerCase() === wanted);
  });
  if (named) return { ok: true, who };
  if (peer.tags.length === 0 && Number.isFinite(me.userId) && peer.userId === me.userId) return { ok: true, who };
  return {
    ok: false,
    who,
    why:
      peer.tags.length > 0
        ? `${peer.host} is a tagged device, not one of your own`
        : `${peer.host} belongs to ${peer.login}, not ${me.login ?? "you"}`,
  };
}
