import fs from "node:fs";

import { CODE_SERVER_VERSION, codeServerRoot, installedCodeServer } from "../codeserver/vendored";
import { providerFor } from "../shortcuts/provider";
import {
  BROWSER_HOME,
  CACHE_DIR,
  DATA_DIR,
  INSTALL_ROOT,
  LOGS_DIR,
  RUNTIME_DIR,
  STATE_DIR,
  VENDOR_DIR,
} from "../runtime/paths";
import { PINNED_VERSION, targetTriple } from "../runtime/release";

export interface DoctorTty {
  stdin: boolean;
  stdout: boolean;
  stderr: boolean;
}

export interface DoctorContextOptions {
  env?: NodeJS.ProcessEnv;
  tty?: Partial<DoctorTty>;
  exists?: (file: string) => boolean;
  codeServerBinary?: string | null;
}

export interface DoctorContext {
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    targetTriple: string;
    tty: DoctorTty;
    terminalProvider: { id: string; name: string } | null;
  };
  paths: {
    install: string;
    vendor: string;
    data: string;
    state: string;
    cache: string;
    runtime: string;
    logs: string;
    codeServer: string;
    browser: typeof BROWSER_HOME;
  };
  runtime: {
    terminalBrowserVersion: string;
    terminalBrowserOverride: string | null;
    codeServerVersion: string;
    codeServerOverride: string | null;
    codeServerBinary: string | null;
  };
  exists: (file: string) => boolean;
}

function processTty(): DoctorTty {
  return {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
    stderr: Boolean(process.stderr.isTTY),
  };
}

export function collectDoctorContext(options: DoctorContextOptions = {}): DoctorContext {
  const env = options.env ?? process.env;
  const tty = { ...processTty(), ...options.tty };
  const provider = providerFor(env);
  const configuredCodeServer = env.TODE_CODE_SERVER ?? null;
  const codeServerBinary =
    options.codeServerBinary !== undefined
      ? options.codeServerBinary
      : env === process.env
        ? installedCodeServer()
        : configuredCodeServer;

  return {
    environment: {
      platform: process.platform,
      architecture: process.arch,
      targetTriple: targetTriple(),
      tty,
      terminalProvider: provider ? { id: provider.id, name: provider.name } : null,
    },
    paths: {
      install: INSTALL_ROOT,
      vendor: VENDOR_DIR,
      data: DATA_DIR,
      state: STATE_DIR,
      cache: CACHE_DIR,
      runtime: RUNTIME_DIR,
      logs: LOGS_DIR,
      codeServer: codeServerRoot(),
      browser: BROWSER_HOME,
    },
    runtime: {
      terminalBrowserVersion: PINNED_VERSION,
      terminalBrowserOverride: env.TODE_TERMINAL_BROWSER_BIN ?? null,
      codeServerVersion: CODE_SERVER_VERSION,
      codeServerOverride: configuredCodeServer,
      codeServerBinary,
    },
    exists: options.exists ?? fs.existsSync,
  };
}
