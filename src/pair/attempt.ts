import fs from "node:fs";
import os from "node:os";

import { COMMAND } from "../runtime/shim";
import { ATTEMPT_FILE, PAIR_DIR, installCommand, privateDir } from "./settings";

export type Reason =
  | "unreachable"
  | "not-listening"
  | "no-answer"
  | "not-allowed"
  | "off-tailnet"
  | "untrusted-address"
  | "screen-too-old"
  | "server-too-old"
  | "refused"
  | "lost"
  | "failed";

export type Route = "tunnel" | "direct";

export interface Failure {
  route: Route;
  target: string;
  reason: Reason;
  detail: string;
  peerVersion?: string;
}

export interface Attempt {
  at: number;
  ok: boolean;
  route?: Route;
  target?: string;
  peerVersion?: string;
  peerHost?: string;
  failures: Failure[];
  summary: string;
  steps: string[];
  toasted?: number;
}

export function sshEndpoints(env: NodeJS.ProcessEnv = process.env): { client: string; server: string; port?: string } | null {
  const connection = (env.SSH_CONNECTION ?? "").trim().split(/\s+/);
  if (connection.length >= 3 && connection[0]) return { client: connection[0], server: connection[2], port: connection[3] };
  const client = (env.SSH_CLIENT ?? "").trim().split(/\s+/)[0];
  return client ? { client, server: os.hostname() } : null;
}

export function thisServer(env: NodeJS.ProcessEnv = process.env): string {
  const ssh = sshEndpoints(env);
  const port = ssh?.port && ssh.port !== "22" ? ` -p ${ssh.port}` : "";
  return `${os.userInfo().username}@${ssh?.server ?? os.hostname()}${port}`;
}

export function summarize(failure: Failure): string {
  switch (failure.reason) {
    case "unreachable":
      return `this server can't reach your local machine at ${failure.target}`;
    case "not-listening":
      return `your local machine (${failure.target}) isn't accepting local rendering`;
    case "no-answer":
      return `something at ${failure.target} accepted the connection but never answered like ${COMMAND}`;
    case "not-allowed":
      return `your local machine refused this server: ${failure.detail}`;
    case "off-tailnet":
      return `your local machine only accepts connections over the tailnet, and this server reached it from outside (${failure.detail})`;
    case "untrusted-address":
      return `your ssh connection didn't come over the tailnet (${failure.detail}), so this server won't connect to it directly`;
    case "screen-too-old":
      return `${COMMAND} on your local machine${failure.peerVersion ? ` (${failure.peerVersion})` : ""} is too old for this server`;
    case "server-too-old":
      return `${COMMAND} on this server is too old for your local machine${failure.peerVersion ? ` (${failure.peerVersion})` : ""}`;
    case "refused":
      return `your local machine couldn't start rendering: ${failure.detail}`;
    case "lost":
      return `the connection to your local machine dropped (${failure.target})`;
    case "failed":
      return `local rendering failed: ${failure.detail}`;
  }
}

const indent = (lines: string[]) => lines.map((line) => `    ${line}`);

function installSteps(): string[] {
  return [
    `please run install/upgrade ${COMMAND} (this command will upgrade if already installed):`,
    ...indent([installCommand()]),
  ];
}

export function nextSteps(failure: Failure): string[] {
  switch (failure.reason) {
    case "unreachable":
    case "off-tailnet":
    case "untrusted-address":
      return [
        "Connect from your local machine to this server instead. On your local machine, run:",
        ...indent([`${COMMAND} --setup-ssh ${thisServer()}`]),
      ];
    case "not-listening":
    case "no-answer":
    case "screen-too-old":
      return [
        "On your local machine,",
        ...installSteps(),
        "then turn on local rendering there:",
        ...indent([`${COMMAND} --enable-local-rendering-over-ssh`]),
      ];
    case "server-too-old":
      return ["On this server, run:", ...indent([`${COMMAND} --upgrade`])];
    case "not-allowed":
      return [
        "To let this server render on your local machine, run there:",
        ...indent([`${COMMAND} --enable-local-rendering-over-ssh --allow-peer ${os.hostname()}`]),
      ];
    case "refused":
    case "lost":
    case "failed":
      return [`Run ${COMMAND} --local-rendering-doctor here for details.`];
  }
}

export function recordAttempt(attempt: Omit<Attempt, "at">): Attempt {
  const record: Attempt = { at: Date.now(), ...attempt };
  try {
    privateDir(PAIR_DIR);
    fs.writeFileSync(`${ATTEMPT_FILE}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${ATTEMPT_FILE}.tmp`, ATTEMPT_FILE);
  } catch {}
  return record;
}

export function lastAttempt(): Attempt | null {
  try {
    return JSON.parse(fs.readFileSync(ATTEMPT_FILE, "utf8")) as Attempt;
  } catch {
    return null;
  }
}

export function fallback(failures: Failure[]): Attempt {
  const first = failures[0];
  return recordAttempt({
    ok: false,
    failures,
    summary: summarize(first),
    steps: nextSteps(first),
  });
}
