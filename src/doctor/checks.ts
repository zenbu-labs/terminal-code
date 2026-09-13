import path from "node:path";

import { providerFor } from "../shortcuts/provider";
import type { ShortcutProvider } from "../shortcuts/provider";
import { loadDecisions } from "../shortcuts/store";
import type { Decisions } from "../shortcuts/store";
import { inspectCodeServer } from "../codeserver/vendored";
import { answering, readServerState } from "../codeserver/server";
import type { ServerState } from "../codeserver/server";
import { systemProcessProbe, ownsServerProcess } from "./process";
import { BRIDGE_DIR } from "../bridge";
import { managedProfilePaths } from "../profile";
import { inspectRuntime } from "../runtime/release";
import type { DoctorContext } from "./context";
import type { DoctorCheck } from "./model";

const supportedPlatforms = new Set<NodeJS.Platform>(["darwin", "linux"]);

export function checkEnvironment(context: DoctorContext): DoctorCheck[] {
  const platformCheck: DoctorCheck = supportedPlatforms.has(context.environment.platform)
    ? {
        id: "environment.platform",
        status: "ok",
        severity: "info",
        fixable: false,
        message: `${context.environment.platform}-${context.environment.architecture} is supported`,
        details: { targetTriple: context.environment.targetTriple },
      }
    : {
        id: "environment.platform",
        status: "error",
        severity: "error",
        fixable: false,
        message: `${context.environment.platform} is not supported by terminal-code`,
        details: { targetTriple: context.environment.targetTriple },
      };

  const ttyCheck: DoctorCheck = context.environment.tty.stdout
    ? {
        id: "environment.tty",
        status: "ok",
        severity: "info",
        fixable: false,
        message: "stdout is attached to a TTY",
        details: { ...context.environment.tty },
      }
    : {
        id: "environment.tty",
        status: "warning",
        severity: "warning",
        fixable: false,
        message: "stdout is not attached to a TTY; interactive terminal queries are unavailable",
        details: { ...context.environment.tty },
      };

  const terminalCheck: DoctorCheck = context.environment.terminalProvider
    ? {
        id: "environment.terminal",
        status: "ok",
        severity: "info",
        fixable: false,
        message: `detected ${context.environment.terminalProvider.name}`,
        details: { provider: context.environment.terminalProvider.id },
      }
    : {
        id: "environment.terminal",
        status: "warning",
        severity: "warning",
        fixable: false,
        message: "no supported Ghostty or Kitty terminal was detected",
      };

  return [platformCheck, ttyCheck, terminalCheck];
}

export function checkTerminalBrowser(context: DoctorContext): DoctorCheck {
  const result = inspectRuntime({ override: context.runtime.terminalBrowserOverride });
  return {
    id: "runtime.terminalBrowser",
    status: result.valid ? "ok" : "error",
    severity: result.valid ? "info" : "error",
    fixable: true,
    message: result.valid ? `terminal-browser ${result.version} is available` : result.reason ?? "terminal-browser is unavailable",
    details: {
      source: result.source,
      version: result.version,
      binary: result.binary,
    },
  };
}

export function checkCodeServer(context: DoctorContext): DoctorCheck {
  const result = inspectCodeServer({
    version: context.runtime.codeServerVersion,
    override: context.runtime.codeServerOverride,
  });
  return {
    id: "runtime.codeServer",
    status: result.valid ? "ok" : "error",
    severity: result.valid ? "info" : "error",
    fixable: true,
    message: result.valid ? `code-server ${result.version} is available` : result.reason ?? "code-server is unavailable",
    details: {
      source: result.source,
      version: result.version,
      binary: result.binary,
    },
  };
}

export function checkGeneratedProfile(context: DoctorContext): DoctorCheck {
  const profile = managedProfilePaths();
  const managedFiles: Record<string, string> = {
    font: profile.font,
    css: profile.css,
    liveTheme: profile.liveTheme,
    settings: profile.settings,
    keybindingsRecord: profile.keybindingsRecord,
    extensionsRegistry: profile.extensionsRegistry,
    bridgeManifest: path.join(BRIDGE_DIR, "package.json"),
    bridgeSource: path.join(BRIDGE_DIR, "extension.js"),
  };
  const missing = Object.entries(managedFiles)
    .filter(([, file]) => !context.exists(file))
    .map(([name]) => name);

  if (missing.length === 0) {
    return {
      id: "profile.generatedState",
      status: "ok",
      severity: "info",
      fixable: true,
      message: "generated profile artifacts are present",
    };
  }

  return {
    id: "profile.generatedState",
    status: "warning",
    severity: "warning",
    fixable: true,
    message: `${missing.length} generated profile artifact${missing.length === 1 ? " is" : "s are"} missing`,
    details: { missing },
  };
}

export interface ShortcutCheckOptions {
  provider?: ShortcutProvider | null;
  decisions?: Decisions | null;
}

function hasRecordedDecision(conflictId: string, decisions: Decisions | null): boolean {
  const choices = decisions?.choices ?? {};
  return Boolean(
    choices[conflictId] ||
      choices[`import:${conflictId}`] ||
      Object.keys(choices).some((id) => id.startsWith(`claim:${conflictId}`)),
  );
}

export function checkShortcuts(
  context: DoctorContext,
  options: ShortcutCheckOptions = {},
): DoctorCheck {
  const provider = options.provider === undefined ? providerFor() : options.provider;
  const decisions = options.decisions === undefined ? loadDecisions() : options.decisions;

  if (!provider) {
    return {
      id: "shortcuts.configuration",
      status: "warning",
      severity: "warning",
      fixable: false,
      message: "shortcut setup is unavailable for the detected terminal",
      details: { provider: context.environment.terminalProvider?.id ?? null },
    };
  }

  const notReady = provider.ready();
  if (notReady) {
    return {
      id: "shortcuts.configuration",
      status: "warning",
      severity: "warning",
      fixable: false,
      message: notReady,
      details: { provider: provider.id },
    };
  }

  let conflicts;
  try {
    conflicts = provider.scan();
  } catch (error) {
    return {
      id: "shortcuts.configuration",
      status: "error",
      severity: "error",
      fixable: false,
      message: error instanceof Error ? error.message : String(error),
      details: { provider: provider.id },
    };
  }

  const unresolved = conflicts.filter(
    (conflict) => !conflict.shared && !hasRecordedDecision(conflict.editorId, decisions),
  );
  const fixable = conflicts.length > 0 && unresolved.length === 0;

  if (unresolved.length > 0) {
    return {
      id: "shortcuts.configuration",
      status: "needs_input",
      severity: "warning",
      fixable: false,
      message: `${unresolved.length} shortcut conflict${unresolved.length === 1 ? " has" : "s have"} no saved decision`,
      details: {
        provider: provider.id,
        conflicts: conflicts.length,
        unresolved: unresolved.length,
      },
      actionIds: ["shortcuts.apply-decisions"],
    };
  }

  return {
    id: "shortcuts.configuration",
    status: conflicts.length === 0 ? "ok" : "warning",
    severity: conflicts.length === 0 ? "info" : "warning",
    fixable,
    message:
      conflicts.length === 0
        ? "no unresolved shortcut conflicts detected"
        : `${conflicts.length} shortcut conflict${conflicts.length === 1 ? " is" : "s are"} ready for saved-decision repair`,
    details: { provider: provider.id, conflicts: conflicts.length },
    actionIds: fixable ? ["shortcuts.apply-decisions"] : undefined,
  };
}

export interface DaemonCheckOptions {
  state?: ServerState | null;
  alive?: (pid: number) => boolean;
  command?: (pid: number) => string | null;
  probePort?: (port: number) => Promise<boolean>;
  portOwner?: (port: number) => number | null;
}

function validServerState(state: ServerState | null): state is ServerState {
  return !!state &&
    Number.isInteger(state.pid) && state.pid > 0 &&
    Number.isInteger(state.injectorPid) && state.injectorPid > 0 &&
    Number.isInteger(state.port) && state.port > 0 && state.port < 65536 &&
    Number.isInteger(state.injectorPort) && state.injectorPort > 0 && state.injectorPort < 65536 &&
    typeof state.version === "string";
}

export async function checkDaemon(options: DaemonCheckOptions = {}): Promise<DoctorCheck> {
  const state = options.state === undefined ? readServerState() : options.state;
  if (!state) {
    return {
      id: "daemon.state",
      status: "warning",
      severity: "warning",
      fixable: true,
      message: "terminal-code daemon is not running",
    };
  }

  if (!validServerState(state)) {
    return {
      id: "daemon.state",
      status: "error",
      severity: "error",
      fixable: false,
      message: "daemon state is malformed and cannot be safely repaired",
    };
  }

  const probe = {
    alive: options.alive ?? systemProcessProbe.alive,
    command: options.command ?? systemProcessProbe.command,
    port: options.probePort ?? answering,
  };
  const processes = [
    { kind: "code-server" as const, pid: state.pid },
    { kind: "injector" as const, pid: state.injectorPid },
  ];
  const dead = processes.filter(({ pid }) => !probe.alive(pid));
  if (dead.length > 0) {
    return {
      id: "daemon.state",
      status: "warning",
      severity: "warning",
      fixable: true,
      message: "daemon state references a stopped process",
      details: { deadPids: dead.map(({ pid }) => pid) },
    };
  }

  const unowned = processes.filter(
    ({ kind, pid }) => !ownsServerProcess(kind, state, probe.command(pid)),
  );
  if (unowned.length > 0) {
    return {
      id: "daemon.state",
      status: "error",
      severity: "error",
      fixable: false,
      message: "daemon state references a process that cannot be verified as terminal-code-owned",
      details: { unownedPids: unowned.map(({ pid }) => pid) },
    };
  }

  const portOwner = options.portOwner ?? systemProcessProbe.portOwner;
  if (portOwner) {
    const occupied = [state.port, state.injectorPort]
      .map((port) => ({ port, pid: portOwner(port) }))
      .filter(({ pid }) => pid !== null && pid !== state.pid && pid !== state.injectorPid);
    if (occupied.length > 0) {
      return {
        id: "daemon.state",
        status: "error",
        severity: "error",
        fixable: false,
        message: "a daemon localhost port is occupied by an unattributed process",
        details: { occupiedPorts: occupied.map(({ port, pid }) => ({ port, pid })) },
      };
    }
  }

  const [upstream, injector] = await Promise.all([
    probe.port(state.port),
    probe.port(state.injectorPort),
  ]);
  if (!upstream || !injector) {
    return {
      id: "daemon.state",
      status: "error",
      severity: "error",
      fixable: true,
      message: "owned daemon processes are alive but a localhost endpoint is not responding",
      details: { upstream, injector },
    };
  }

  return {
    id: "daemon.state",
    status: "ok",
    severity: "info",
    fixable: true,
    message: "owned code-server and injector daemon are healthy",
    details: { port: state.port, injectorPort: state.injectorPort },
  };
}

const managedDirectories = (context: DoctorContext): Record<string, string> => ({
  data: context.paths.data,
  state: context.paths.state,
  cache: context.paths.cache,
  runtime: context.paths.runtime,
  logs: context.paths.logs,
});

export function checkManagedState(context: DoctorContext): DoctorCheck {
  const missing = Object.entries(managedDirectories(context))
    .filter(([, directory]) => !context.exists(directory))
    .map(([name]) => name);

  if (missing.length === 0) {
    return {
      id: "paths.managedState",
      status: "ok",
      severity: "info",
      fixable: true,
      message: "managed directories are present",
    };
  }

  return {
    id: "paths.managedState",
    status: "warning",
    severity: "warning",
    fixable: true,
    message: `${missing.length} managed director${missing.length === 1 ? "y is" : "ies are"} missing`,
    details: { missing },
  };
}

export function collectReadOnlyChecks(context: DoctorContext): DoctorCheck[] {
  return [
    ...checkEnvironment(context),
    checkManagedState(context),
    checkTerminalBrowser(context),
    checkCodeServer(context),
    checkGeneratedProfile(context),
    checkShortcuts(context),
  ];
}

export interface CheckRegistryOptions {
  daemon?: DaemonCheckOptions;
  shortcuts?: ShortcutCheckOptions;
}

function checkFailure(id: string, error: unknown): DoctorCheck {
  return {
    id,
    status: "error",
    severity: "error",
    fixable: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function collectDoctorChecks(
  context: DoctorContext,
  options: CheckRegistryOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    checks.push(...checkEnvironment(context));
  } catch (error) {
    checks.push(checkFailure("environment", error));
  }
  const entries: [string, () => DoctorCheck][] = [
    ["paths.managedState", () => checkManagedState(context)],
    ["runtime.terminalBrowser", () => checkTerminalBrowser(context)],
    ["runtime.codeServer", () => checkCodeServer(context)],
    ["profile.generatedState", () => checkGeneratedProfile(context)],
    ["shortcuts.configuration", () => checkShortcuts(context, options.shortcuts)],
  ];
  for (const [id, run] of entries) {
    try {
      checks.push(run());
    } catch (error) {
      checks.push(checkFailure(id, error));
    }
  }
  try {
    checks.push(await checkDaemon(options.daemon));
  } catch (error) {
    checks.push(checkFailure("daemon.state", error));
  }
  return checks;
}
