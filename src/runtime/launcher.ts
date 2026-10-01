import fs from "node:fs";
import path from "node:path";

export function pixelRoot(): string {
  return path.dirname(require.resolve("@zenbu-labs/pixel/package.json"));
}

export function pixelVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(pixelRoot(), "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export function electronBinary(): string {
  const dist = path.join(pixelRoot(), "electron", "dist");
  return process.platform === "darwin"
    ? path.join(dist, "Electron.app", "Contents", "MacOS", "pixel")
    : path.join(dist, "pixel");
}

export function bootstrapEntry(): string {
  return path.join(pixelRoot(), "dist", "bootstrap.js");
}

export function daemonEntry(): string {
  return path.resolve(__dirname, "..", "app", "daemon.js");
}
