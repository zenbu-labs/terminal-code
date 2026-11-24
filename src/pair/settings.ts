import fs from "node:fs";
import path from "node:path";

import { PROTOCOL } from "@zenbu-labs/pixel/pair";

import { DATA_DIR, INSTALL_ROOT, LOGS_DIR, STATE_DIR } from "../runtime/paths";

export const DEFAULT_PORT = 47291;
export const LINK_PROTOCOL: [number, number] = linkProtocol();

function linkProtocol(): [number, number] {
  const given = process.env.TERMINAL_CODE_LINK_PROTOCOL?.match(/^(\d+)-(\d+)$/);
  return given ? [Number(given[1]), Number(given[2])] : [1, 1];
}

export const PIXEL_PROTOCOL: [number, number] = pixelProtocol();

function pixelProtocol(): [number, number] {
  const given = process.env.PIXEL_PAIR_PROTOCOL?.match(/^(\d+)-(\d+)$/);
  return given ? [Number(given[1]), Number(given[2])] : [PROTOCOL[0], PROTOCOL[1]];
}

export const PAIR_DIR = path.join(STATE_DIR, "pair");
export const TUNNELS_DIR = path.join(PAIR_DIR, "tunnels");
export const ATTEMPT_FILE = path.join(PAIR_DIR, "last-attempt.json");
export const LISTENER_FILE = path.join(PAIR_DIR, "listener.json");
export const LISTENER_LOG = path.join(LOGS_DIR, "local-rendering.log");
export const SETTINGS_FILE = path.join(DATA_DIR, "local-rendering.json");

export interface Settings {
  enabled: boolean;
  allowPeers: string[];
}

export function readSettings(): Settings {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<Settings>;
    return {
      enabled: parsed.enabled === true,
      allowPeers: Array.isArray(parsed.allowPeers) ? parsed.allowPeers.filter((p) => typeof p === "string") : [],
    };
  } catch {
    return { enabled: false, allowPeers: [] };
  }
}

export function writeSettings(settings: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(`${SETTINGS_FILE}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
}

export function pairPort(): number {
  const configured = Number(process.env.TERMINAL_CODE_LOCAL_RENDERING_PORT);
  return Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : DEFAULT_PORT;
}

export function privateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(dir);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

export function installChannel(): string {
  try {
    return fs.readFileSync(path.join(INSTALL_ROOT, "CHANNEL"), "utf8").trim() || "stable";
  } catch {
    return "stable";
  }
}

export function installCommand(): string {
  const base = process.env.TODE_RELEASE_ORIGIN ?? "https://tode.sh/install";
  return `curl -fsSL ${installChannel() === "dev" ? `${base}/dev` : base} | bash`;
}
