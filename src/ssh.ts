import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { connectSsh, resolveSshTarget } from "@zenbu-labs/pixel/ssh";

import { Pane } from "./launch";
import { EXTENSIONS_DIR, USER_DIR } from "./profile";
import { STATE_DIR } from "./runtime/paths";
import type { TerminalPalette } from "./terminal/osc";

const REMOTE_BUNDLES_DIR = "${XDG_DATA_HOME:-$HOME/.local/share}/tode/bundles";

export async function sshOpen(
  target: string,
  options: {
    remotePath?: string;
    palette: TerminalPalette;
    version: string;
    split?: string;
    size?: string;
  },
): Promise<number> {
  const session = await connectSsh({
    target,
    bundle: writeBundle(options.palette, options.version, options.remotePath),
    remoteBase: REMOTE_BUNDLES_DIR,
    status: (line) => process.stderr.write(`ssh: ${line}\n`),
  });
  const pane = new Pane({
    split: options.split,
    size: options.size,
    proxy: session.view.proxy,
    partition: session.view.partition,
  });
  pane.open(session.url!);
  return pane.exited();
}

export function sshForward(target: string, args: string[]): number {
  const { destination, hostArgs } = resolveSshTarget(target);
  const tode = '"$HOME/.local/bin/tode"';
  const hint = `tode is not installed on ${destination}, run: tode --ssh ${target}`;
  const command = [
    `[ -x ${tode} ] || { echo '${hint}' >&2; exit 127; };`,
    `exec ${tode}`,
    ...args.map(shellQuote),
  ].join(" ");
  const result = spawnSync("ssh", [...hostArgs, destination, command], { stdio: "inherit" });
  return result.status ?? 1;
}

function writeBundle(
  palette: TerminalPalette,
  version: string,
  remotePath: string | undefined,
): string {
  const dir = path.join(STATE_DIR, "ssh-bundle");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, contents: string, executable = false) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    if (executable) fs.chmodSync(file, 0o755);
  };
  write("manifest.json", `${JSON.stringify({ name: "tode" })}\n`);
  write("version", `${version}\n`);
  write("palette.json", `${JSON.stringify(palette)}\n`);
  stageProfile(dir);
  write(
    "ensure",
    `#!/bin/sh
set -e
tode="$HOME/.local/bin/tode"
want="$(cat "$(dirname "$0")/version")"
have="$("$tode" --version 2>/dev/null || true)"
if [ "$want" = dev ]; then
  [ -n "$have" ] || curl -fsSL https://tode.sh/install/dev | bash
elif [ "$have" != "$want" ]; then
  curl -fsSL "https://tode.sh/install/v/$want" | bash
fi
"$tode" --help 2>/dev/null | grep -q -- --serve || {
  echo "the tode on this server ($("$tode" --version 2>/dev/null)) does not support --serve" >&2
  exit 1
}
`,
    true,
  );
  write(
    "setup",
    `#!/bin/sh
set -e
./ensure
"$HOME/.local/bin/tode" --serve --prepare --palette "$(pwd)/palette.json" --import "$(pwd)/profile"
`,
    true,
  );
  write(
    "start",
    `#!/bin/sh
set -e
./ensure
here="$(pwd)"
cd "$HOME"
exec "$HOME/.local/bin/tode" --serve --palette "$here/palette.json"${
      remotePath ? ` ${shellQuote(remotePath)}` : ""
    }
`,
    true,
  );
  return dir;
}

function stageProfile(bundleDir: string): void {
  const profile = path.join(bundleDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  for (const file of ["settings.json", "keybindings.json", "tasks.json"]) {
    try {
      fs.copyFileSync(path.join(USER_DIR, file), path.join(profile, file));
    } catch {}
  }
  try {
    fs.cpSync(path.join(USER_DIR, "snippets"), path.join(profile, "snippets"), {
      recursive: true,
    });
  } catch {}
  fs.writeFileSync(path.join(profile, "extensions.txt"), `${extensionIds().join("\n")}\n`);
}

function extensionIds(): string[] {
  try {
    const listed = JSON.parse(fs.readFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), "utf8"));
    if (!Array.isArray(listed)) return [];
    return listed
      .filter((entry) => typeof entry?.identifier?.id === "string")
      .map((entry) =>
        typeof entry.version === "string"
          ? `${entry.identifier.id}@${entry.version}`
          : entry.identifier.id,
      );
  } catch {
    return [];
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
