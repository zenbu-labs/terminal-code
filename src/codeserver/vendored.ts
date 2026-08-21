import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../runtime/paths";
import { fetchVerified, targetTriple } from "../runtime/release";

/** Microsoft's own `code` cli — the one that ships with VS Code — is what tode
 * serves the workbench with: `code serve-web` fetches the real VS Code server
 * and puts the workbench on a port. Nothing here is a fork, so there is no
 * build for tode to pin against: the update service names the current stable
 * cli, and the sha256 it reports is what the download is checked against. */
export const VSCODE_QUALITY = "stable";

function updateOrigin(): string {
  return process.env.TODE_VSCODE_UPDATE_ORIGIN ?? "https://update.code.visualstudio.com";
}

/** tode target -> the cli build the update service publishes for it. */
const CLI_TARGETS: Record<string, string> = {
  "darwin-arm64": "cli-darwin-arm64",
  "linux-x64": "cli-linux-x64",
  "linux-arm64": "cli-linux-arm64",
};

/** unpacked `code` clis, one directory per version */
export const CLI_DIR = path.join(DATA_DIR, "vscode-cli");

/** the cli's own store — `serve-web` keeps the servers it downloads here,
 * clear of a ~/.vscode-cli the user may be running tunnels out of */
export const CLI_DATA_DIR = path.join(DATA_DIR, "vscode-cli-data");

export interface CliRelease {
  /** the product version, e.g. 1.105.2 */
  version: string;
  /** the vscode commit it was built from */
  commit: string;
  url: string;
  sha256: string;
  size: number;
}

export function cliRoot(version: string): string {
  return path.join(CLI_DIR, version);
}

/** The newest of the binaries a directory of versioned trees holds, ignoring
 * the `<name>.staging` and `<name>.unpacking` trees a half-done download
 * leaves behind. */
function newestBin(dir: string, binIn: (entry: string) => string): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const found: { bin: string; at: number }[] = [];
  for (const entry of entries) {
    if (entry.includes(".staging") || entry.includes(".unpacking")) continue;
    const bin = binIn(entry);
    try {
      found.push({ bin, at: fs.statSync(bin).mtimeMs });
    } catch {}
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.bin ?? null;
}

export function installedVscodeCli(): string | null {
  const configured = process.env.TODE_VSCODE_CLI;
  if (configured) return configured;
  return newestBin(CLI_DIR, (entry) => path.join(CLI_DIR, entry, "code"));
}

/** The VS Code server `code serve-web` downloaded, once it has served a page.
 * It is the binary the workbench actually runs on, and the one extensions have
 * to be installed with — the cli's own `code ext` drives a desktop install. */
export function installedVscodeServer(): string | null {
  const cache = path.join(CLI_DATA_DIR, "serve-web");
  return newestBin(cache, (entry) => path.join(cache, entry, "bin", "code-server"));
}

export function narrateFetch(label: string): (fraction: number) => void {
  let announced = false;
  let lastPercent = -1;
  return (fraction) => {
    if (!announced) {
      process.stderr.write(`tode: fetching ${label}\n`);
      announced = true;
    }
    const percent = Math.round(fraction * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
  };
}

/** The version names a directory under CLI_DIR, so it has to be a plain name.
 * The update service is Microsoft's over https, but a version is the one field
 * here that becomes a path, and a "../.." in it would put the download
 * somewhere else entirely. */
function safeVersion(version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version) || version.includes("..")) {
    throw new Error(`the VS Code update service named a version tode will not use as a path: ${version}`);
  }
  return version;
}

/** What the update service serves for this machine right now. The document is
 * the one VS Code updates itself from, so the digest in it is the digest the
 * download has to have. */
export async function latestCli(): Promise<CliRelease> {
  const target = CLI_TARGETS[targetTriple()];
  if (!target) throw new Error(`no VS Code cli build for ${targetTriple()}`);
  const url = `${updateOrigin()}/api/update/${target}/${VSCODE_QUALITY}/latest`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the VS Code update service did not answer (${response.status} from ${url})`);
  }
  const release = (await response.json()) as {
    url?: string;
    version?: string;
    productVersion?: string;
    sha256hash?: string;
    size?: number;
  };
  if (!release.url || !release.version || !release.sha256hash) {
    throw new Error(`the VS Code update service did not name a ${target} build to download`);
  }
  return {
    version: safeVersion(release.productVersion ?? release.version),
    commit: release.version,
    url: release.url,
    sha256: release.sha256hash,
    size: release.size ?? 0,
  };
}

/** The cli comes as a gzipped tarball on linux and a zip on macos, each of
 * them the single `code` binary. */
function unpackCli(archive: string, root: string) {
  const staging = `${root}.unpacking`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const head = Buffer.alloc(2);
  const handle = fs.openSync(archive, "r");
  try {
    fs.readSync(handle, head, 0, 2, 0);
  } finally {
    fs.closeSync(handle);
  }
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  if (gzipped) execFileSync("tar", ["-xzf", archive, "-C", staging]);
  else execFileSync("unzip", ["-q", "-o", archive, "-d", staging]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.renameSync(staging, root);
}

export async function ensureVscodeCli(onProgress?: (fraction: number) => void): Promise<string> {
  const already = installedVscodeCli();
  if (already) return already;

  const release = await latestCli();
  const root = cliRoot(release.version);
  const archive = `${root}.download`;
  await fetchVerified(release.url, release.sha256, release.size, archive, onProgress);
  unpackCli(archive, root);
  fs.rmSync(archive, { force: true });
  const bin = path.join(root, "code");
  if (!fs.existsSync(bin)) {
    throw new Error(`unpacked the VS Code cli ${release.version} but it holds no code binary`);
  }
  fs.chmodSync(bin, 0o755);
  return bin;
}
