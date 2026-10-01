import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

function base(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(HOME, fallback);
}

// hm
const DATA_HOME = base("XDG_DATA_HOME", ".local/share");
const STATE_HOME = base("XDG_STATE_HOME", ".local/state");
const CACHE_HOME = base("XDG_CACHE_HOME", ".cache");

export const INSTALL_ROOT =
  process.env.TODE_INSTALL_ROOT && path.isAbsolute(process.env.TODE_INSTALL_ROOT)
    ? process.env.TODE_INSTALL_ROOT
    : path.resolve(__dirname, "..", "..");


export const DEFAULT_INSTALL_ROOT = path.join(HOME, ".local", "lib", "tode");

export const DATA_DIR = path.join(DATA_HOME, "tode");
export const STATE_DIR = path.join(STATE_HOME, "tode");
export const CACHE_DIR = path.join(CACHE_HOME, "tode");

export const LOGS_DIR = path.join(STATE_DIR, "logs");

