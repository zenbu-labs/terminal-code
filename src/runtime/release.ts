
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BROWSER_HOME, RUNTIME_DIR, VENDOR_DIR } from "./paths";

export const PINNED_VERSION = "v0.7.3";

const RELEASE_ORIGIN = process.env.TODE_RELEASE_ORIGIN ?? "https://terminal-browser.sh/install";

const SYSTEM_INSTALL = path.join(
  process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local/share"),
  "terminal-browser",
  "app",
);

export interface Release {
  version: string;
  channel: string;
  url: string;
  sha256: string;
  size: number;
}

export type Source = "override" | "vendored" | "pinned" | "cloned" | "downloaded";

export function targetTriple(): string {
  return `${process.platform === "darwin" ? "darwin" : "linux"}-${
    process.arch === "arm64" ? "arm64" : "x64"
  }`;
}

const VENDORED = path.join(VENDOR_DIR, "terminal-browser");

export interface Runtime {
  bin: string;
  root: string;
  version: string;
  source: Source;
}

export async function lookup(version: string): Promise<Release> {
  const url = `${RELEASE_ORIGIN}/v/${version}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`no release ${version} (${response.status} from ${url})`);
  const script = await response.text();
  const field = (name: string) => {
    const found = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
    if (!found) throw new Error(`release ${version} did not report ${name}`);
    return found[1];
  };
  const target = targetTriple();
  const row = field("PLATFORMS")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] === target);
  if (!row || row.length < 4) throw new Error(`release ${version} has no build for ${target}`);
  return {
    version: field("VERSION"),
    channel: field("CHANNEL"),
    url: row[1],
    sha256: row[2],
    size: Number(row[3]),
  };
}

export interface RuntimeInspection {
  source: Source | "missing" | "invalid";
  version: string | null;
  root: string;
  binary: string | null;
  valid: boolean;
  reason?: string;
}

export interface RuntimeInspectionOptions {
  version?: string;
  override?: string | null;
  vendoredRoot?: string;
  pinnedRoot?: string;
  systemRoot?: string;
  exists?: (file: string) => boolean;
  readVersion?: (root: string) => string | null;
}

function versionAt(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Where the electron binary lives inside a terminal-browser tree. macOS ships
 * an app bundle; linux ships the bare electron layout. */
export function electronEntry(root: string): string {
  return process.platform === "darwin"
    ? path.join(root, "electron", "terminal-browser.app", "Contents", "MacOS", "terminal-browser")
    : path.join(root, "electron", "electron");
}

function runtimeUsable(
  root: string,
  version: string,
  exists: (file: string) => boolean,
  readVersion: (root: string) => string | null,
): boolean {
  return (
    readVersion(root) === version &&
    exists(path.join(root, "cli", "dist", "main.js")) &&
    exists(electronEntry(root))
  );
}

export function inspectRuntime(options: RuntimeInspectionOptions = {}): RuntimeInspection {
  const version = options.version ?? PINNED_VERSION;
  const exists = options.exists ?? fs.existsSync;
  const readVersion = options.readVersion ?? versionAt;
  const override = options.override === undefined ? process.env.TODE_TERMINAL_BROWSER_BIN ?? null : options.override;
  const vendoredRoot = options.vendoredRoot ?? VENDORED;
  const pinnedRoot = options.pinnedRoot ?? rootFor(version);
  const systemRoot = options.systemRoot ?? SYSTEM_INSTALL;

  if (override) {
    const root = path.resolve(path.dirname(override), "..");
    const valid = exists(override);
    return {
      source: valid ? "override" : "invalid",
      version: valid ? readVersion(root) ?? "override" : null,
      root,
      binary: override,
      valid,
      ...(valid ? {} : { reason: "TODE_TERMINAL_BROWSER_BIN does not exist" }),
    };
  }

  const candidates: { source: Source; root: string }[] = [
    ...(version === PINNED_VERSION ? [{ source: "vendored" as const, root: vendoredRoot }] : []),
    { source: "pinned", root: pinnedRoot },
    { source: "cloned", root: systemRoot },
  ];
  let invalidRoot: string | null = null;

  for (const candidate of candidates) {
    if (runtimeUsable(candidate.root, version, exists, readVersion)) {
      return {
        source: candidate.source,
        version,
        root: candidate.root,
        binary: path.join(candidate.root, "bin", "terminal-browser"),
        valid: true,
      };
    }
    if (readVersion(candidate.root) !== null) invalidRoot ??= candidate.root;
  }

  const root = invalidRoot ?? pinnedRoot;
  return {
    source: invalidRoot ? "invalid" : "missing",
    version: readVersion(root),
    root,
    binary: path.join(root, "bin", "terminal-browser"),
    valid: false,
    reason: invalidRoot ? "runtime is missing a required executable" : "runtime is not installed",
  };
}

function usable(root: string, version: string): boolean {
  return runtimeUsable(root, version, fs.existsSync, versionAt);
}


function rootFor(version: string): string {
  return path.join(RUNTIME_DIR, "terminal-browser", version);
}

function writeLauncher(root: string) {
  const bin = path.join(root, "bin", "terminal-browser");
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const electron = path.relative(root, electronEntry(root));
  const scrollHelper =
    process.platform === "darwin"
      ? `export NATIVE_SCROLL_HELPER="\${NATIVE_SCROLL_HELPER:-$ROOT/bin/native-scroll-helper}"\n`
      : "";
  fs.writeFileSync(
    bin,
    `#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
${scrollHelper}export XDG_DATA_HOME=\${TODE_BROWSER_DATA:-${quote(BROWSER_HOME.data)}}
export XDG_STATE_HOME=\${TODE_BROWSER_STATE:-${quote(BROWSER_HOME.state)}}
export XDG_CACHE_HOME=\${TODE_BROWSER_CACHE:-${quote(BROWSER_HOME.cache)}}
# XDG_RUNTIME_DIR keeps the session's own value: the Wayland socket lives there,
# and the daemon socket is already namespaced by a hash of the install root.
if [ -n "\${TODE_BROWSER_RUN:-}" ]; then export XDG_RUNTIME_DIR="\$TODE_BROWSER_RUN"; fi
export TERMINAL_BROWSER_APPDATA=\${TODE_BROWSER_APPDATA:-${quote(BROWSER_HOME.appData)}}
exec "$ROOT/${electron}" "$ROOT/cli/dist/main.js" "$@"
`,
  );
  fs.chmodSync(bin, 0o755);
  for (const dir of Object.values(BROWSER_HOME)) fs.mkdirSync(dir, { recursive: true });
  return bin;
}

export function unpack(tarball: string, root: string) {
  const staging = `${root}.unpacking`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", staging, "--strip-components", "1"]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.renameSync(staging, root);
}

function cloneTree(from: string, to: string): boolean {
  const staging = `${to}.cloning`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    execFileSync("cp", ["-Rc", from, staging], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("cp", ["-R", from, staging], { stdio: "ignore" });
    } catch {
      fs.rmSync(staging, { recursive: true, force: true });
      return false;
    }
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(staging, to);
  return true;
}

export async function fetchVerified(
  url: string,
  sha256: string,
  size: number,
  tarball: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} from ${url})`);
  }
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  const hash = crypto.createHash("sha256");
  const file = fs.createWriteStream(tarball);
  let read = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    read += chunk.byteLength;
    if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
    if (size) onProgress?.(read / size);
  }
  await new Promise<void>((resolve, reject) => {
    file.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  const got = hash.digest("hex");
  if (got !== sha256) {
    fs.rmSync(tarball, { force: true });
    throw new Error(`download corrupted: expected ${sha256}, got ${got}`);
  }
  return tarball;
}

function download(release: Release, onProgress?: (fraction: number) => void): Promise<string> {
  const tarball = path.join(RUNTIME_DIR, `${release.version}.tar.gz`);
  return fetchVerified(release.url, release.sha256, release.size, tarball, onProgress);
}

export interface ResolveOptions {
  version?: string;
  onProgress?(stage: "cloning" | "downloading", fraction: number): void;
}

export async function resolveRuntimeWithProgress(): Promise<Runtime> {
  let announced = false;
  let lastPercent = -1;
  return resolveRuntime({
    onProgress: (stage, fraction) => {
      if (stage === "downloading") {
        if (!announced) {
          process.stderr.write(`tode: fetching terminal-browser ${PINNED_VERSION}\n`);
          announced = true;
        }
        const percent = Math.round(fraction * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
        process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
      }
      if (stage === "cloning" && !announced) {
        process.stderr.write(`tode: reusing the terminal-browser ${PINNED_VERSION} already installed\n`);
        announced = true;
      }
    },
  });
}

export async function resolveRuntime(options: ResolveOptions = {}): Promise<Runtime> {
  const version = options.version ?? PINNED_VERSION;

  const override = process.env.TODE_TERMINAL_BROWSER_BIN;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`TODE_TERMINAL_BROWSER_BIN is not there: ${override}`);
    const root = path.resolve(path.dirname(override), "..");
    return { bin: override, root, version: versionAt(root) ?? "override", source: "override" };
  }

  if (version === PINNED_VERSION && usable(VENDORED, version)) {
    return { bin: writeLauncher(VENDORED), root: VENDORED, version, source: "vendored" };
  }

  const root = rootFor(version);
  if (usable(root, version)) {
    return { bin: writeLauncher(root), root, version, source: "pinned" };
  }

  if (usable(SYSTEM_INSTALL, version)) {
    options.onProgress?.("cloning", 0);
    if (cloneTree(SYSTEM_INSTALL, root)) {
      options.onProgress?.("cloning", 1);
      return { bin: writeLauncher(root), root, version, source: "cloned" };
    }
  }

  const release = await lookup(version);
  const tarball = await download(release, (fraction) => options.onProgress?.("downloading", fraction));
  unpack(tarball, root);
  fs.rmSync(tarball, { force: true });
  if (!usable(root, version)) throw new Error(`unpacked ${version} but it is missing pieces`);
  return { bin: writeLauncher(root), root, version, source: "downloaded" };
}
