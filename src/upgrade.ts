import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_INSTALL_ROOT, INSTALL_ROOT, STATE_DIR } from "./runtime/paths";
import { targetTriple } from "./runtime/release";

const ORIGIN = process.env.TODE_RELEASE_ORIGIN ?? "https://tode.sh/install";

export interface Build {
  version: string;
  channel: string;
  platform: string;
  file: string;
  sha256: string;
  size: number;
  url: string;
}

/** What the release worker serves: one entry per target, each carrying its
 * own download url. */
interface Manifest {
  version: string;
  channel: string;
  platforms: Record<string, { file: string; sha256: string; size: number; url: string }>;
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function installed(): { version: string; channel: string } | null {
  const version = readTrimmed(path.join(INSTALL_ROOT, "VERSION"));
  const channel = readTrimmed(path.join(INSTALL_ROOT, "CHANNEL"));
  if (!version || !channel) return null;
  return { version, channel };
}

function buildFor(manifest: Manifest): Build {
  const target = targetTriple();
  const build = manifest.platforms?.[target];
  if (!build) {
    throw new Error(`tode ${manifest.version} has no build for ${target}`);
  }
  return { version: manifest.version, channel: manifest.channel, platform: target, ...build };
}

export async function latest(channel: string): Promise<Build> {
  const url = channel === "stable" ? `${ORIGIN}/latest.json` : `${ORIGIN}/${channel}/latest.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not read ${url} (${response.status})`);
  return buildFor((await response.json()) as Manifest);
}

/** A pinned version's manifest, for `tode upgrade --version`. */
export async function release(version: string): Promise<Build> {
  const url = `${ORIGIN}/v/${version}/manifest.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`no release ${version} (${response.status} from ${url})`);
  return buildFor((await response.json()) as Manifest);
}

async function fetchBuild(build: Build, onProgress?: (fraction: number) => void): Promise<string> {
  const response = await fetch(build.url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} from ${build.url})`);
  }
  const dir = fs.mkdtempSync(path.join(path.dirname(INSTALL_ROOT), ".tode-upgrade-"));
  const tarball = path.join(dir, build.file);
  const hash = crypto.createHash("sha256");
  const file = fs.createWriteStream(tarball);
  let read = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    read += chunk.byteLength;
    if (!file.write(chunk)) await new Promise<void>((r) => file.once("drain", () => r()));
    if (build.size) onProgress?.(read / build.size);
  }
  await new Promise<void>((resolve, reject) => {
    file.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  const got = hash.digest("hex");
  if (got !== build.sha256) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`download corrupted: expected ${build.sha256}, got ${got}`);
  }
  return tarball;
}

/** Unpacks beside the install and renames over it, so a failure at any point
 * leaves the working install exactly as it was. */
function swapIn(tarball: string, root: string) {
  const staging = `${root}.new`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", staging, "--strip-components", "1"]);
  if (!fs.existsSync(path.join(staging, "dist", "main.js"))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error("the new tarball is missing dist/main.js");
  }
  const previous = `${root}.old`;
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(root)) fs.renameSync(root, previous);
  fs.renameSync(staging, root);
  fs.rmSync(previous, { recursive: true, force: true });
}

function writeReceipt(build: Build) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(STATE_DIR, "install.json"),
    `${JSON.stringify(
      {
        version: build.version,
        channel: build.channel,
        target: build.platform,
        root: INSTALL_ROOT,
        installed: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

export interface UpgradeOptions {
  check?: boolean;
  version?: string;
  onStage?(stage: "checking" | "downloading" | "installing", fraction: number): void;
}

export type Outcome =
  | { kind: "not-an-install"; root: string }
  | { kind: "current"; version: string; channel: string }
  | { kind: "available"; from: string; build: Build }
  | { kind: "upgraded"; from: string; build: Build };

export async function upgrade(options: UpgradeOptions = {}): Promise<Outcome> {
  const here = installed();
  if (!here) return { kind: "not-an-install", root: INSTALL_ROOT };

  options.onStage?.("checking", 0);
  const build = options.version ? await release(options.version) : await latest(here.channel);

  if (build.version === here.version && !options.version) {
    return { kind: "current", version: here.version, channel: here.channel };
  }
  if (options.check) return { kind: "available", from: here.version, build };

  const tarball = await fetchBuild(build, (f) => options.onStage?.("downloading", f));
  options.onStage?.("installing", 0);
  try {
    swapIn(tarball, INSTALL_ROOT);
  } finally {
    fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
  }
  writeReceipt(build);

  const shim = path.join(
    process.env.XDG_BIN_HOME ?? path.join(os.homedir(), ".local", "bin"),
    "tode",
  );
  const shipped = path.join(INSTALL_ROOT, "bin", "tode");
  if (fs.existsSync(shim) && fs.existsSync(shipped)) {
    fs.copyFileSync(shipped, shim);
    fs.chmodSync(shim, 0o755);
  }

  return { kind: "upgraded", from: here.version, build };
}

export { DEFAULT_INSTALL_ROOT };
