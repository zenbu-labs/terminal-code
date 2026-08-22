export interface DoctorOptions {
  json: boolean;
  fix: boolean;
}

export type DoctorArgs =
  | { kind: "ok"; options: DoctorOptions }
  | { kind: "usage-error"; message: string };

export function parseDoctorArgs(args: readonly string[]): DoctorArgs {
  let json = false;
  let fix = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--fix") {
      fix = true;
      continue;
    }
    return { kind: "usage-error", message: `unknown doctor option ${arg}` };
  }

  return { kind: "ok", options: { json, fix } };
}
