import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../runtime/paths";
import { fetchVerified, targetTriple, unpack } from "../runtime/fetch";

export const CODE_SERVER_VERSION = "4.132.0";

const CODE_SERVER_BUILDS: Record<string, { asset: string; sha256: string; size: number }> = {
  "darwin-x64": {
    asset: "macos-amd64",
    sha256: "eddc7a8ea9d4575ae3e4813c624f7e012be191a0670d2e5187a6301fd59f6307",
    size: 230542235,
  },
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
