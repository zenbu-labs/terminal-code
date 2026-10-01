import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function targetTriple(): string {
  return `${process.platform === "darwin" ? "darwin" : "linux"}-${
    process.arch === "arm64" ? "arm64" : "x64"
  }`;
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
