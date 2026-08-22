import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../runtime/paths";
import { fetchVerified, targetTriple, unpack } from "../runtime/release";

/** The code-server build tode is written against. The workbench tode injects
 * into is version-specific, so it pins rather than taking whatever happens to
 * be installed. Bump the version and the hashes together — they come from the
 * digests GitHub publishes on the release assets. */
export const CODE_SERVER_VERSION = "4.132.0";

/** tode target -> the name code-server releases under, and the sha256 GitHub
 * reports for that asset. */
const CODE_SERVER_BUILDS: Record<string, { asset: string; sha256: string; size: number }> = {
  "darwin-arm64": {
    asset: "macos-arm64",
    sha256: "449814f6637faaf9b68544f7bce560f5ec500de688815d5c7f9afa7a51577992",
    size: 211120710,
  },
  "linux-x64": {
    asset: "linux-amd64",
    sha256: "a38d26f4cb81f768feddff79e2937fd3f39c83d3da8be3da7225e1087e62e4ed",
    size: 238758593,
  },
  "linux-arm64": {
    asset: "linux-arm64",
    sha256: "ade569a677d1c04ee66ef153382b7e15bf261f955407663c7ddc6b87f9ee29fc",
    size: 232503176,
  },
};

export function codeServerRoot(version = CODE_SERVER_VERSION): string {
  return path.join(DATA_DIR, "code-server", version);
}

function binAt(root: string): string | null {
  const bin = path.join(root, "bin", "code-server");
  return fs.existsSync(bin) ? bin : null;
}

export function installedCodeServer(): string | null {
  const configured = process.env.TODE_CODE_SERVER;
  if (configured) return configured;
  return binAt(codeServerRoot());
}

export interface CodeServerInspection {
  source: "override" | "pinned" | "missing" | "invalid";
  version: string;
  root: string;
  binary: string;
  valid: boolean;
  reason?: string;
}

export interface CodeServerInspectionOptions {
  version?: string;
  override?: string | null;
  root?: string;
  exists?: (file: string) => boolean;
}

export function inspectCodeServer(options: CodeServerInspectionOptions = {}): CodeServerInspection {
  const version = options.version ?? CODE_SERVER_VERSION;
  const override = options.override === undefined ? process.env.TODE_CODE_SERVER ?? null : options.override;
  const root = options.root ?? codeServerRoot(version);
  const exists = options.exists ?? fs.existsSync;
  const binary = override ?? path.join(root, "bin", "code-server");
  const valid = exists(binary);

  return {
    source: valid ? (override ? "override" : "pinned") : override ? "invalid" : "missing",
    version,
    root,
    binary,
    valid,
    ...(valid ? {} : { reason: "code-server binary is not present" }),
  };
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

export async function ensureCodeServer(
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const already = installedCodeServer();
  if (already) return already;

  const build = CODE_SERVER_BUILDS[targetTriple()];
  if (!build) throw new Error(`no pinned code-server build for ${targetTriple()}`);
  const url =
    `https://github.com/coder/code-server/releases/download/` +
    `v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-${build.asset}.tar.gz`;
  const root = codeServerRoot();
  const tarball = `${root}.tar.gz`;
  await fetchVerified(url, build.sha256, build.size, tarball, onProgress);
  unpack(tarball, root);
  fs.rmSync(tarball, { force: true });
  const bin = binAt(root);
  if (!bin) throw new Error(`unpacked code-server ${CODE_SERVER_VERSION} but it has no bin/code-server`);
  return bin;
}
