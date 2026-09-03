import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { writeBrowserScripts } from "./browserglue";
import { EXTENSIONS_DIR, USER_DIR } from "./profile";
import { STATE_DIR } from "./runtime/paths";
import { spawnRuntime } from "./runtime/release";
import type { Runtime } from "./runtime/release";
import type { TerminalPalette } from "./terminal/osc";

export function sshOpen(
  runtime: Runtime,
  target: string,
  options: {
    remotePath?: string;
    palette: TerminalPalette;
    version: string;
    split?: string;
    size?: string;
  },
): Promise<number> {
  const bundle = writeBundle(options.palette, options.version, options.remotePath);
  const scripts = writeBrowserScripts();
  const argv = [
    "open",
    "--app-mode",
    "--ssh",
    target,
    "--ssh-bundle",
    bundle,
    "--ssh-bundle-dir",
    "${XDG_DATA_HOME:-$HOME/.local/share}/tode/bundles",
    `--preload=${scripts.preload}`,
    `--main-script=${scripts.mainScript}`,
  ];
  if (options.split) argv.push("--split", options.split);
  if (options.size) argv.push("--size", options.size);
  const child = spawnRuntime(runtime, argv, { stdio: "inherit" });
  return new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`could not start terminal-browser: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

export function sshForward(target: string, args: string[]): number {
  const { destination, hostArgs } = resolveSshDestination(target);
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

function resolveSshDestination(target: string): { destination: string; hostArgs: string[] } {
  const words = target.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const tokens = words[0] === "ssh" ? words.slice(1) : words;
    const hostArgs: string[] = [];
    let found: string | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith("-")) {
        hostArgs.push(token);
        if (SSH_VALUE_FLAGS.has(token) && i + 1 < tokens.length) hostArgs.push(tokens[++i]);
        continue;
      }
      if (found) {
        throw new Error(`invalid --ssh ${target} (both ${found} and ${token} look like destinations)`);
      }
      found = token;
    }
    if (!found) throw new Error(`invalid --ssh ${target} (no destination)`);
    return { destination: found, hostArgs };
  }
  const single = words[0] ?? "";
  if (!single.includes("@") && !single.includes(":")) {
    const alias = shellAlias(single);
    if (alias) {
      const parsed = parseSshCommand(alias);
      if (parsed) return parsed;
    }
  }
  const match = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+)(:(\d+))?$/.exec(single);
  if (!match) {
    throw new Error(`invalid --ssh ${target} (user@host, host, user@host:port, or an ssh alias)`);
  }
  return {
    destination: `${match[1] ?? ""}${match[2]}`,
    hostArgs: match[4] ? ["-p", match[4]] : [],
  };
}

function shellAlias(name: string): string[] | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const shell = process.env.SHELL ?? "/bin/sh";
  const result = spawnSync(shell, ["-ic", `alias ${name}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const line = result.stdout.trim().split("\n").pop() ?? "";
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  const tokens = unquote(line.slice(eq + 1).trim())
    .split(/\s+/)
    .filter(Boolean);
  if (!/(^|\/)ssh$/.test(tokens[0] ?? "")) return null;
  return tokens.slice(1);
}

function unquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value.replaceAll("\\ ", " ");
}

const SSH_VALUE_FLAGS = new Set(
  "-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -R -S -W -w".split(" "),
);

function parseSshCommand(tokens: string[]): { destination: string; hostArgs: string[] } | null {
  const hostArgs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      hostArgs.push(token);
      if (SSH_VALUE_FLAGS.has(token) && i + 1 < tokens.length) hostArgs.push(tokens[++i]);
      continue;
    }
    return { destination: token, hostArgs };
  }
  return null;
}
