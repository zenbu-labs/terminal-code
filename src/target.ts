import fs from "node:fs";
import path from "node:path";

export interface Target {
  folder: string | null;
  file: string | null;
}

export function resolveTarget(argument: string | undefined, cwd: string): Target {
  const requested = path.resolve(cwd, argument ?? ".");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(requested);
  } catch {
    return { folder: null, file: requested };
  }
  if (stat.isDirectory()) return { folder: requested, file: null };
  return { folder: null, file: requested };
}

// A uri path is not a windows path: it is separated by forward slashes, and a
// drive letter still follows a leading slash.
function uriPath(file: string): string {
  const slashed = file.replaceAll("\\", "/");
  return slashed.startsWith("/") ? slashed : `/${slashed}`;
}

export function workbenchUrl(origin: string, target: Target): string {
  const url = new URL(origin);
  if (target.folder) url.searchParams.set("folder", target.folder);
  if (target.file) {
    const uri = `vscode-remote://${url.host}${uriPath(target.file)}`;
    url.searchParams.set("payload", JSON.stringify([["openFile", uri]]));
  }
  return url.toString();
}
