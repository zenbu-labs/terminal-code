import fs from "node:fs";

import { alive } from "../app/control";
import { installVersion } from "../app/protocol";
import { COMMAND } from "../runtime/shim";
import { lastAttempt, nextSteps, sshEndpoints, summarize } from "./attempt";
import type { Failure } from "./attempt";
import { listenAddresses, listenerState } from "./listener";
import { link, localAddress, targets } from "./remote";
import type { Target } from "./remote";
import { installService, removeService, serviceDescription, waitForListener } from "./service";
import { LISTENER_LOG, installChannel, loggingEnabled, pairPort, readSettings, writeSettings } from "./settings";
import { self, tailnetAddresses, tailscaleCli } from "./tailscale";

const out = (line = "") => process.stdout.write(`${line}\n`);
const row = (label: string, value: string) => out(`  ${label.padEnd(18)} ${value}`);
const more = (value: string) => out(`  ${"".padEnd(18)} ${value}`);

function ago(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

interface Check {
  target: Target;
  ok: boolean;
  line: string;
  host?: string;
  ms?: number;
  failure?: Failure;
}

async function check(target: Target): Promise<Check> {
  const linked = await link(target, true);
  if ("reason" in linked) {
    const summary = summarize(linked);
    const line = summary.includes(linked.detail) ? summary : `${summary} (${linked.detail})`;
    return { target, ok: false, line: `✗ ${target.label}: ${line}`, failure: linked };
  }
  linked.mux.close();
  const host = String(linked.welcome.host ?? "?");
  return {
    target,
    ok: true,
    host,
    ms: linked.ms,
    line: `✓ ${target.label}: ${COMMAND} ${String(linked.welcome.version)} on ${host}, answered in ${linked.ms}ms`,
  };
}

function takeAll(args: string[], name: string): string[] {
  const found: string[] = [];
  for (let at = args.indexOf(name); at >= 0; at = args.indexOf(name)) {
    if (args[at + 1] === undefined) throw new Error(`${name} needs a value`);
    found.push(args[at + 1]);
    args.splice(at, 2);
  }
  return found;
}

export async function enableCommand(args: string[]): Promise<number> {
  let allow: string[];
  try {
    allow = takeAll(args, "--allow-peer");
  } catch (error) {
    process.stderr.write(`${COMMAND}: ${(error as Error).message}\n`);
    return 1;
  }
  const settings = readSettings();
  writeSettings({ enabled: true, allowPeers: [...new Set([...settings.allowPeers, ...allow])] });

  const ssh = sshEndpoints();
  if (ssh) return enableOnServer();
  return enableOnScreen();
}

async function enableOnServer(): Promise<number> {
  const checks = await Promise.all(targets(true).map(check));
  const working = checks.find((c) => c.ok);
  if (working) {
    out(`local rendering enabled (${COMMAND} on ${working.host} answered in ${working.ms}ms)`);
    return 0;
  }
  out("local rendering enabled");
  out();
  for (const c of checks) out(c.line);
  const failure = checks.find((c) => c.failure)?.failure;
  if (!failure) {
    out(`couldn't work out your local machine's address; set TERMINAL_CODE_LOCAL_RENDERING_ADDRESS`);
    return 1;
  }
  out();
  for (const line of nextSteps(failure)) out(line);
  return 0;
}

async function enableOnScreen(): Promise<number> {
  try {
    await installService();
  } catch (error) {
    process.stderr.write(`${COMMAND}: couldn't start the listener: ${(error as Error).message}\n`);
    return 1;
  }
  out(`local rendering enabled: when ${COMMAND} is running over ssh it will be allowed to offload rendering to your local cli`);
  out();
  out(`Note: ${COMMAND} --enable-local-rendering-over-ssh must be ran on both the local and remote machine for the CLI's to pair`);
  const state = await waitForListener(8000);
  if ((state?.addresses ?? []).length > 0) return 0;
  out();
  if (listenAddresses().length === 0) {
    out("this machine has no tailnet address, so servers can't connect to it directly.");
    out(`servers can still render here through ${COMMAND} --setup-ssh <user@server>`);
  } else {
    out(
      loggingEnabled()
        ? `the listener didn't come up; see ${LISTENER_LOG}`
        : "the listener didn't come up; rerun with TERMINAL_CODE_LOCAL_RENDERING_LOG=1 to log why",
    );
  }
  return 0;
}

export async function disableCommand(): Promise<number> {
  const settings = readSettings();
  writeSettings({ ...settings, enabled: false });
  await removeService();
  out("local rendering over ssh is off");
  return 0;
}

function logTail(lines: number): string[] {
  try {
    return fs.readFileSync(LISTENER_LOG, "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

export async function doctorCommand(): Promise<number> {
  const settings = readSettings();
  const ssh = sshEndpoints();
  out(`${COMMAND} local rendering doctor`);
  out();
  row("version", `${installVersion()} (${installChannel()})`);
  row("local rendering", settings.enabled ? "on" : `off — turn on with ${COMMAND} --enable-local-rendering-over-ssh`);

  out();
  out(`this machine as the server (${COMMAND} here renders on your local machine)`);
  row("ssh session", ssh ? `from ${ssh.client} to ${ssh.server}` : "not in an ssh session");
  const address = localAddress();
  if (address) {
    row(
      "local machine",
      `${address}:${pairPort()}${process.env.TERMINAL_CODE_LOCAL_RENDERING_ADDRESS ? " (TERMINAL_CODE_LOCAL_RENDERING_ADDRESS)" : ""}`,
    );
  }
  const found = targets(settings.enabled);
  const tunnels = found.filter((t) => t.route === "tunnel");
  row("ssh tunnels", tunnels.length > 0 ? tunnels.map((t) => t.socketFile).join(", ") : `none (${COMMAND} --setup-ssh opens one)`);
  const checks = await Promise.all(found.map(check));
  if (checks.length === 0) row("checks", ssh && !settings.enabled ? "skipped, local rendering is off" : "nothing to check");
  checks.forEach((c, at) => (at === 0 ? row("checks", c.line) : more(c.line)));
  const attempt = lastAttempt();
  if (attempt) {
    row(
      "last open",
      attempt.ok
        ? `${ago(attempt.at)}: rendered on ${attempt.peerHost ?? attempt.target} ${attempt.route === "tunnel" ? "through the ssh tunnel" : "over a direct connection"}`
        : `${ago(attempt.at)}: fell back to rendering here, ${attempt.summary}`,
    );
    for (const failure of attempt.failures) more(`${failure.route} ${failure.target}: ${failure.reason}, ${failure.detail}`);
  }
  const failing = checks.find((c) => c.failure)?.failure;
  if (failing && !checks.some((c) => c.ok)) {
    out();
    out("  next steps");
    for (const line of nextSteps(failing)) out(`    ${line}`);
  }

  out();
  out(`this machine as the screen (${COMMAND} on servers renders here)`);
  const state = listenerState();
  const running = state && alive(state.pid);
  row(
    "listener",
    running
      ? `running (pid ${state.pid}) on ${state.addresses.length > 0 ? state.addresses.map((a) => `${a}:${state.port}`).join(", ") : "no address yet"}`
      : "not running",
  );
  if (running && Object.keys(state.failed).length > 0) {
    for (const [where, why] of Object.entries(state.failed)) more(`can't listen on ${where}: ${why}`);
  }
  row("service", serviceDescription());
  const tailnet = tailnetAddresses();
  row("tailnet address", tailnet.length > 0 ? tailnet.join(", ") : "none");
  const cli = tailscaleCli();
  if (!cli) row("tailscale", "CLI not found, incoming connections can't be verified");
  else {
    try {
      const me = await self(cli);
      row("tailscale", `${cli}, ${me.host} as ${me.login ?? me.userId}`);
    } catch (error) {
      row("tailscale", `${cli}: ${(error as Error).message}`);
    }
  }
  row(
    "allowed",
    `your own untagged tailnet devices${settings.allowPeers.length > 0 ? `, plus ${settings.allowPeers.join(", ")}` : ""}`,
  );
  if (process.env.TERMINAL_CODE_LOCAL_RENDERING_TRUST) row("trusted networks", process.env.TERMINAL_CODE_LOCAL_RENDERING_TRUST);
  const tail = loggingEnabled() ? logTail(8) : [];
  if (tail.length > 0) {
    row("log", LISTENER_LOG);
    for (const line of tail) more(line);
  }
  return 0;
}
