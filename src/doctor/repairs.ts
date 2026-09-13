import fs from "node:fs";

import {
  answering,
  currentServer,
  ensureServer,
  readServerState,
  stopServer,
  STATE_FILE,
} from "../codeserver/server";
import type { ServerState } from "../codeserver/server";
import { ensureCodeServer } from "../codeserver/vendored";
import { installBridge } from "../bridge";
import {
  ensureFont,
  installCss,
  installKeybindings,
  installSettings,
  installTheme,
  readPalette,
  setLiveTheme,
} from "../profile";
import { generateTheme } from "../theme/generate";
import { providerFor } from "../shortcuts/provider";
import type { ProviderConflict, ShortcutProvider } from "../shortcuts/provider";
import { applyRecordedDecisions } from "../shortcuts/wizard";
import { loadDecisions } from "../shortcuts/store";
import type { Decision } from "../shortcuts/store";
import { resolveRuntime } from "../runtime/release";
import type { ResolveOptions } from "../runtime/release";
import type { DoctorContext } from "./context";
import { ownsServerProcess, systemProcessProbe } from "./process";
import type { ProcessProbe } from "./process";
import type { DoctorAction, DoctorCheck } from "./model";

export interface RepairDependencies {
  mkdir?: (directory: string) => void;
  resolveRuntime?: (options?: ResolveOptions) => Promise<unknown>;
  ensureCodeServer?: (onProgress?: (fraction: number) => void) => Promise<string>;
  readPalette?: typeof readPalette;
  ensureFont?: typeof ensureFont;
  installTheme?: typeof installTheme;
  installCss?: typeof installCss;
  setLiveTheme?: typeof setLiveTheme;
  installSettings?: typeof installSettings;
  installKeybindings?: typeof installKeybindings;
  installBridge?: typeof installBridge;
  todeCommand?: () => string[];
  provider?: ShortcutProvider | null;
  applyRecordedDecisions?: typeof applyRecordedDecisions;
  readServerState?: () => ServerState | null;
  removeServerState?: () => void;
  ensureServer?: () => Promise<ServerState>;
  currentServer?: typeof currentServer;
  stopServer?: () => boolean;
  processProbe?: ProcessProbe;
  probePort?: (port: number) => Promise<boolean>;
  portOwner?: (port: number) => number | null;
  sleep?: (milliseconds: number) => Promise<void>;
  daemonStartupTimeoutMs?: number;
  stderr?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedAction(id: string, checkIds: string[], error: unknown, reversible = false): DoctorAction {
  return {
    id,
    status: "failed",
    reversible,
    message: errorMessage(error),
    checkIds,
    error: { kind: error instanceof Error ? error.name : "Error", message: errorMessage(error) },
  };
}

function resultAction(
  id: string,
  changed: boolean,
  message: string,
  checkIds: string[],
  details: Record<string, unknown> = {},
  reversible = true,
): DoctorAction {
  return {
    id,
    status: changed ? "changed" : "unchanged",
    reversible,
    message,
    checkIds,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function blockedAction(
  id: string,
  message: string,
  checkIds: string[],
  details: Record<string, unknown> = {},
): DoctorAction {
  return {
    id,
    status: "blocked",
    reversible: true,
    message,
    checkIds,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function progress(stderr: ((message: string) => void) | undefined, label: string) {
  let announced = false;
  let lastPercent = -1;
  return (fraction: number) => {
    if (!stderr) return;
    if (!announced) {
      stderr(`tode: repairing ${label}\n`);
      announced = true;
    }
    const percent = Math.round(fraction * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    stderr(`tode: ${label} ${percent}%\n`);
  };
}

function checkFor(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((check) => check.id === id);
}

function shouldRepair(check: DoctorCheck | undefined): boolean {
  return !!check && check.status !== "ok" && check.fixable;
}

async function repairManagedState(
  context: DoctorContext,
  check: DoctorCheck,
  deps: RepairDependencies,
): Promise<DoctorAction> {
  const mkdir = deps.mkdir ?? ((directory: string) => fs.mkdirSync(directory, { recursive: true }));
  const names: Record<string, string> = {
    data: context.paths.data,
    state: context.paths.state,
    cache: context.paths.cache,
    runtime: context.paths.runtime,
    logs: context.paths.logs,
  };
  const created: string[] = [];
  try {
    for (const [name, directory] of Object.entries(names)) {
      if (context.exists(directory)) continue;
      mkdir(directory);
      created.push(name);
    }
    return resultAction(
      "paths.create-managed-directories",
      created.length > 0,
      created.length > 0 ? "created missing managed directories" : "managed directories are already present",
      [check.id],
      { created },
      true,
    );
  } catch (error) {
    return failedAction("paths.create-managed-directories", [check.id], error, true);
  }
}

async function repairRuntime(
  check: DoctorCheck,
  deps: RepairDependencies,
): Promise<DoctorAction> {
  try {
    const resolve = deps.resolveRuntime ?? ((options?: ResolveOptions) => resolveRuntime(options));
    const onProgress = progress(deps.stderr, "terminal-browser");
    await resolve({ onProgress: (_stage, fraction) => onProgress(fraction) });
    return resultAction(
      "runtime.terminalBrowser.repair",
      true,
      "terminal-browser runtime is available",
      [check.id],
      {},
      false,
    );
  } catch (error) {
    return failedAction("runtime.terminalBrowser.repair", [check.id], error, false);
  }
}

async function repairCodeServer(
  check: DoctorCheck,
  deps: RepairDependencies,
): Promise<DoctorAction> {
  try {
    const ensure = deps.ensureCodeServer ?? ensureCodeServer;
    await ensure(progress(deps.stderr, "code-server"));
    return resultAction(
      "runtime.codeServer.repair",
      true,
      "code-server runtime is available",
      [check.id],
      {},
      false,
    );
  } catch (error) {
    return failedAction("runtime.codeServer.repair", [check.id], error, false);
  }
}

async function repairProfile(
  check: DoctorCheck,
  deps: RepairDependencies,
): Promise<DoctorAction[]> {
  const readPaletteFn = deps.readPalette ?? readPalette;
  const ensureFontFn = deps.ensureFont ?? ensureFont;
  const installThemeFn = deps.installTheme ?? installTheme;
  const installCssFn = deps.installCss ?? installCss;
  const setLiveThemeFn = deps.setLiveTheme ?? setLiveTheme;
  const installSettingsFn = deps.installSettings ?? installSettings;
  const installKeybindingsFn = deps.installKeybindings ?? installKeybindings;
  const installBridgeFn = deps.installBridge ?? installBridge;
  const command = deps.todeCommand ?? (() => [process.execPath, process.argv[1] ?? "tode"]);

  try {
    const { palette } = await readPaletteFn();
    const font = ensureFontFn();
    const theme = installThemeFn(palette);
    const cssChanged = installCssFn(palette);
    const liveThemeChanged = setLiveThemeFn(generateTheme(palette));
    const settingsChanged = installSettingsFn();
    const keybindingsChanged = installKeybindingsFn();
    const bridgeChanged = installBridgeFn(command());
    return [
      resultAction("profile.font", font === "installed", font === "installed" ? "installed managed font" : "managed font is present", [check.id], { state: font }),
      resultAction("profile.theme", theme.changed, theme.changed ? "generated managed theme" : "managed theme is current", [check.id], { fingerprint: theme.fingerprint }),
      resultAction("profile.css", cssChanged, cssChanged ? "generated managed CSS" : "managed CSS is current", [check.id]),
      resultAction("profile.live-theme", liveThemeChanged, liveThemeChanged ? "updated live theme" : "live theme is current", [check.id]),
      resultAction("profile.settings", settingsChanged, settingsChanged ? "updated managed settings" : "managed settings are current", [check.id]),
      resultAction("profile.keybindings", keybindingsChanged, keybindingsChanged ? "updated managed keybindings" : "managed keybindings are current", [check.id]),
      resultAction("profile.bridge", bridgeChanged, bridgeChanged ? "generated bridge extension" : "bridge extension is current", [check.id]),
    ];
  } catch (error) {
    return [failedAction("profile.generatedState.repair", [check.id], error, true)];
  }
}

function hasDecision(conflict: ProviderConflict, choices: Record<string, Decision>): boolean {
  return Boolean(
    choices[conflict.editorId] ||
      choices[`import:${conflict.editorId}`] ||
      Object.keys(choices).some((id) => id.startsWith(`claim:${conflict.editorId}`)),
  );
}

function relevantDecision(conflict: ProviderConflict, choices: Record<string, Decision>): boolean {
  const decision = choices[conflict.editorId];
  return decision?.choice === "terminal" || decision?.choice === "editor" || decision?.choice === "keep" || hasDecision(conflict, choices);
}

function repairShortcuts(
  check: DoctorCheck,
  deps: RepairDependencies,
): DoctorAction[] {
  const provider = deps.provider === undefined ? providerFor() : deps.provider;
  if (!provider) {
    return [blockedAction("shortcuts.apply-decisions", "shortcut provider is unavailable", [check.id], { reason: "unsupported-provider" })];
  }
  try {
    const ready = provider.ready();
    if (ready) {
      return [blockedAction("shortcuts.apply-decisions", ready, [check.id], { provider: provider.id })];
    }
    const conflicts = provider.scan();
    const choices = { ...(loadDecisions()?.choices ?? {}) };
    const unresolved = conflicts.filter(
      (conflict) => !conflict.shared && !hasDecision(conflict, choices),
    );
    const freshShared = conflicts.filter(
      (conflict) => conflict.shared && conflict.current !== null && !choices[conflict.editorId],
    );
    for (const conflict of freshShared) {
      choices[conflict.editorId] = { choice: "terminal", action: conflict.current ?? undefined };
    }
    const applicable = conflicts.some((conflict) => relevantDecision(conflict, choices));
    const actions: DoctorAction[] = [];
    if (applicable) {
      const apply = deps.applyRecordedDecisions ?? applyRecordedDecisions;
      const outcome = apply(provider, conflicts, choices);
      actions.push(
        resultAction(
          "shortcuts.apply-decisions",
          true,
          unresolved.length > 0 ? "applied saved/shared decisions; unresolved conflicts were left unchanged" : "applied saved shortcut decisions",
          [check.id],
          {
            provider: provider.id,
            configCategory: outcome.configPath.split(/[\\/]/).pop() ?? "managed-shortcuts",
            keybindingsChanged: outcome.keybindingsChanged,
            reloadedLive: outcome.reloadedLive,
            reloadHint: outcome.reloadHint,
          },
        ),
      );
    } else {
      actions.push(
        resultAction("shortcuts.apply-decisions", false, "no saved or shared shortcut changes were needed", [check.id], { provider: provider.id }),
      );
    }
    if (unresolved.length > 0) {
      actions.push(
        blockedAction(
          "shortcuts.needs-input",
          "left unresolved shortcut conflicts unchanged",
          [check.id],
          { provider: provider.id, unresolved: unresolved.length, reason: "needs_input" },
        ),
      );
    }
    return actions;
  } catch (error) {
    return [failedAction("shortcuts.apply-decisions", [check.id], error, true)];
  }
}

function validState(state: ServerState | null): state is ServerState {
  return !!state &&
    Number.isInteger(state.pid) && state.pid > 0 &&
    Number.isInteger(state.injectorPid) && state.injectorPid > 0 &&
    Number.isInteger(state.port) && state.port > 0 && state.port < 65536 &&
    Number.isInteger(state.injectorPort) && state.injectorPort > 0 && state.injectorPort < 65536 &&
    typeof state.version === "string";
}

async function verifyOwnedServer(
  state: ServerState,
  probe: ProcessProbe,
  probePort: (port: number) => Promise<boolean>,
  portOwner?: (port: number) => number | null,
): Promise<boolean> {
  if (portOwner) {
    const owners = [portOwner(state.port), portOwner(state.injectorPort)];
    if (owners.some((pid) => pid !== null && pid !== state.pid && pid !== state.injectorPid)) return false;
  }
  if (!probe.alive(state.pid) || !probe.alive(state.injectorPid)) return false;
  if (!ownsServerProcess("code-server", state, probe.command(state.pid))) return false;
  if (!ownsServerProcess("injector", state, probe.command(state.injectorPid))) return false;
  const [upstream, injector] = await Promise.all([probePort(state.port), probePort(state.injectorPort)]);
  return upstream && injector;
}

async function waitForOwnedServer(
  state: ServerState,
  probe: ProcessProbe,
  probePort: (port: number) => Promise<boolean>,
  portOwner: ((port: number) => number | null) | undefined,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (await verifyOwnedServer(state, probe, probePort, portOwner)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(100, remaining));
  }
}

async function repairDaemon(
  check: DoctorCheck,
  deps: RepairDependencies,
): Promise<DoctorAction> {
  const probe = deps.processProbe ?? systemProcessProbe;
  const probePort = deps.probePort ?? answering;
  const portOwner = deps.portOwner ?? probe.portOwner;
  const readState = deps.readServerState ?? readServerState;
  const removeState = deps.removeServerState ?? (() => fs.rmSync(STATE_FILE, { force: true }));
  const start = deps.ensureServer ?? ensureServer;
  const current = deps.currentServer ?? currentServer;
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startupTimeoutMs = deps.daemonStartupTimeoutMs ?? 30_000;
  const stop = deps.stopServer ?? stopServer;
  let state = readState();

  try {
    if (state && !validState(state)) {
      return blockedAction("daemon.lifecycle", "daemon state is invalid and was left unchanged", [check.id], { reason: "invalid-state" });
    }

    if (state) {
      const processes = [
        { kind: "code-server" as const, pid: state.pid },
        { kind: "injector" as const, pid: state.injectorPid },
      ];
      const liveUnowned = processes.filter(
        ({ kind, pid }) => probe.alive(pid) && !ownsServerProcess(kind, state!, probe.command(pid)),
      );
      if (liveUnowned.length > 0) {
        return blockedAction(
          "daemon.lifecycle",
          "refused to signal an unverified process",
          [check.id],
          { reason: "unverified-pid", pids: liveUnowned.map(({ pid }) => pid) },
        );
      }

      const allDead = processes.every(({ pid }) => !probe.alive(pid));
      if (allDead) {
        removeState();
        state = null;
      } else {
        const ownedState = state;
        if (portOwner) {
          const occupied = [ownedState.port, ownedState.injectorPort]
            .map((port) => ({ port, pid: portOwner(port) }))
            .filter(({ pid }) => pid !== null && pid !== ownedState.pid && pid !== ownedState.injectorPid);
          if (occupied.length > 0) {
            return blockedAction(
              "daemon.lifecycle",
              "refused to repair a daemon with an unattributed port owner",
              [check.id],
              { reason: "unattributed-port", occupiedPorts: occupied },
            );
          }
        }
        const healthy = await verifyOwnedServer(ownedState, probe, probePort, portOwner);
        if (healthy) {
          return resultAction("daemon.lifecycle", false, "owned daemon is already healthy", [check.id]);
        }
        stop();
        state = null;
      }
    }

    const started = await start();
    const verified = await waitForOwnedServer(
      started,
      probe,
      probePort,
      portOwner,
      startupTimeoutMs,
      sleep,
    );
    if (!verified) {
      const observed = await current().catch(() => null);
      if (!observed || !(await waitForOwnedServer(observed, probe, probePort, portOwner, 1000, sleep))) {
        throw new Error("started daemon did not pass ownership and localhost endpoint verification");
      }
    }
    return resultAction(
      "daemon.lifecycle",
      true,
      "started and verified the owned local daemon",
      [check.id],
      { ports: [started.port, started.injectorPort] },
      true,
    );
  } catch (error) {
    return failedAction("daemon.lifecycle", [check.id], error, true);
  }
}

export async function repairChecks(
  checks: DoctorCheck[],
  context: DoctorContext,
  deps: RepairDependencies = {},
): Promise<DoctorAction[]> {
  const actions: DoctorAction[] = [];
  const managed = checkFor(checks, "paths.managedState");
  if (shouldRepair(managed)) actions.push(await repairManagedState(context, managed!, deps));

  const runtime = checkFor(checks, "runtime.terminalBrowser");
  if (shouldRepair(runtime)) actions.push(await repairRuntime(runtime!, deps));

  const codeServer = checkFor(checks, "runtime.codeServer");
  if (shouldRepair(codeServer)) actions.push(await repairCodeServer(codeServer!, deps));

  const profile = checkFor(checks, "profile.generatedState");
  if (shouldRepair(profile)) actions.push(...(await repairProfile(profile!, deps)));

  const shortcuts = checkFor(checks, "shortcuts.configuration");
  if (shouldRepair(shortcuts) || shortcuts?.status === "needs_input") {
    actions.push(...repairShortcuts(shortcuts!, deps));
  }

  const daemon = checkFor(checks, "daemon.state");
  if (shouldRepair(daemon)) {
    const prerequisiteFailure = actions.some(
      (action) =>
        action.status === "failed" &&
        ["runtime.terminalBrowser.repair", "runtime.codeServer.repair", "profile.generatedState.repair"].includes(action.id),
    );
    if (prerequisiteFailure) {
      actions.push({
        id: "daemon.lifecycle",
        status: "skipped",
        reversible: true,
        message: "daemon repair skipped because a prerequisite repair failed",
        checkIds: [daemon!.id],
        details: { reason: "dependency-failed" },
      });
    } else {
      actions.push(await repairDaemon(daemon!, deps));
    }
  }
  return actions;
}
