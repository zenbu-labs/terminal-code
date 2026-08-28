import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BRIDGE_DIR, STARTUP_OPEN_FILE } from "./bridge";
import { ipcSocketDir } from "./browserglue";
import { CSS_FILE, PORT_FILE, SERVER_LOG, STATE_FILE, currentServer, origin } from "./codeserver/server";
import { CLI_DATA_DIR, CLI_DIR, installedVscodeCli, installedVscodeServer } from "./codeserver/vendored";
import {
  EXTENSIONS_DIR,
  KEYBINDINGS_RECORD,
  LIVE_THEME_FILE,
  PALETTE_CACHE,
  SEEDED_SETTINGS,
  SETTINGS,
  THEME_EXTENSION_ID,
  USER_DIR,
  VSCODE_DIR,
} from "./profile";
import {
  BROWSER_HOME,
  CACHE_DIR,
  DATA_DIR,
  INSTALL_ROOT,
  RUNTIME_DIR,
  STATE_DIR,
  VENDOR_DIR,
} from "./runtime/paths";
import { PINNED_VERSION } from "./runtime/release";
import { ghosttyConfigDir, isGhostty } from "./shortcuts/backends/ghostty";
import { isKitty, kittyConfigDir } from "./shortcuts/backends/kitty";
import { DECISIONS_FILE } from "./shortcuts/store";

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Everything here is looked at, never resolved: a skill dump must not be the
 * thing that starts downloading a runtime. */
function runtimeSources(): string {
  const sources: string[] = [];
  const override = process.env.TODE_TERMINAL_BROWSER_BIN;
  if (override) sources.push(`override via TODE_TERMINAL_BROWSER_BIN at ${override}`);
  if (fs.existsSync(path.join(VENDOR_DIR, "terminal-browser")))
    sources.push(`vendored in ${path.join(VENDOR_DIR, "terminal-browser")}`);
  if (fs.existsSync(path.join(RUNTIME_DIR, "terminal-browser", PINNED_VERSION)))
    sources.push(`fetched at ${path.join(RUNTIME_DIR, "terminal-browser", PINNED_VERSION)}`);
  if (sources.length === 0) return "not on disk yet — the next open downloads it";
  return sources.join("; ");
}

export async function skillText(): Promise<string> {
  const version = read(path.join(INSTALL_ROOT, "VERSION"));
  const channel = read(path.join(INSTALL_ROOT, "CHANNEL"));
  const install = version
    ? `release ${version} on channel ${channel ?? "unknown"}`
    : "a working tree, not a release (no VERSION file — upgrade and uninstall refuse it)";
  const binHome = process.env.XDG_BIN_HOME ?? path.join(os.homedir(), ".local", "bin");
  const shim = path.join(binHome, "tode");

  const server = await currentServer();
  const daemon = server
    ? `up ${Math.round((Date.now() - server.startedAt) / 60000)}m — serve-web pid ${server.pid} on 127.0.0.1:${server.port}, ` +
    `injector pid ${server.injectorPid}; windows load ${origin(server)} (always the injector, never the server directly)`
    : "not running — the next `tode` starts it";
  const cli = installedVscodeCli();
  const vscodeServer = installedVscodeServer();

  const sockets = listDir(ipcSocketDir()).filter((entry) => entry.endsWith(".sock"));
  const inWindow = process.env.TODE_IPC;

  const extensions = listDir(EXTENSIONS_DIR).filter(
    (entry) => !entry.startsWith(".") && entry !== "extensions.json",
  );
  const terminals = [
    ...(isGhostty() ? [`ghostty, config in ${ghosttyConfigDir()}`] : []),
    ...(isKitty() ? [`kitty, config in ${kittyConfigDir()}`] : []),
  ];

  return `---
name: tode
description: Working knowledge of this machine's tode install (the terminal code editor). Where its VS Code profile, extensions, keybindings, themes, terminal shortcut overrides, logs and daemon state live, which files are safe to edit and which are regenerated, and how to reach running windows. Regenerate with \`tode --skill\` — every path is resolved live and the state section reflects the moment it ran.
---

# tode

tode is a code editor that runs in the terminal: one warm \`code serve-web\`
serves the real VS Code workbench, an injecting proxy sits in front of it, and
terminal-browser draws each window as a terminal pane. Everything below was
resolved on this machine when \`tode --skill\` ran — env overrides are already
applied, and the state section is live. Re-run it rather than trusting a copy.

## State right now

- install root: ${INSTALL_ROOT} — ${install}
- shim: ${shim} ${fs.existsSync(shim) ? "(present)" : "(absent — run installs go through node directly)"}
- terminal-browser pin ${PINNED_VERSION}: ${runtimeSources()}
- VS Code cli: ${cli ?? `not fetched yet — the first open puts it under ${CLI_DIR}`}
- VS Code server: ${vscodeServer ?? `not fetched yet — serve-web downloads it under ${path.join(CLI_DATA_DIR, "serve-web")} on the first window`}
- daemon: ${daemon}
- open windows: ${sockets.length} socket(s) in ${ipcSocketDir()}${sockets.length ? ` — ${sockets.join(", ")}` : ""}
- this shell ${inWindow ? `is inside a tode window (TODE_IPC=${inWindow})` : "is not inside a tode window (no TODE_IPC)"}
- terminal detected for shortcut overrides: ${terminals.length ? terminals.join("; ") : "none (ghostty and kitty are supported)"}
- installed extensions (${extensions.length}): ${extensions.length ? extensions.join(", ") : "none"}

## The editor profile — settings, keybindings, snippets, extensions

There is exactly one profile, under ${VSCODE_DIR}. Flags like --profile and
--user-data-dir are deliberately swallowed; every window and every extension
operation uses this one.

A workbench in a browser keeps its user data in the browser, not in the
server's data dir, so these files are tode's record of the intent and two
carriers take them the rest of the way: settings ride in on the workbench page
as configuration defaults (the injector reads settings.json on every load, so a
reload is enough), and keybindings ride in on the bridge extension. Anything
set from inside the editor still wins over both, and lives in the browser.

- ${path.join(USER_DIR, "settings.json")} — live settings. tode owns these keys
  and rewrites them on every open (edits to them are lost):
  ${Object.keys(SETTINGS).join(", ")}.
  These keys were seeded once and an edit of yours wins:
  ${Object.keys(SEEDED_SETTINGS).join(", ")}.
  Every other key is untouched — add or change freely.
- ${path.join(USER_DIR, "keybindings.json")} — safe to edit. tode replaces only
  the entries it wrote last time (recorded in ${KEYBINDINGS_RECORD}) and
  carries everything else through. An extension can only add bindings, so a
  removal ("-command") is recorded here but never reaches the workbench.
- ${path.join(USER_DIR, "snippets")} and tasks.json — plain vscode files, never
  touched after an import.
- ${EXTENSIONS_DIR} — the extensions tree plus its extensions.json registry.
  Manage with \`tode --install-extension <id|vsix>\`, \`--uninstall-extension\`,
  \`--list-extensions\` (these run the downloaded VS Code server against the
  right dirs; a bare \`code\` call would look for a desktop install). Two entries are generated by tode itself
  and rewritten on every open, so never hand-edit them: ${path.basename(BRIDGE_DIR)}
  (the IPC bridge) and ${THEME_EXTENSION_ID}-<fingerprint> (the terminal theme).
- an open window picks extension changes up on its next reload.

## Theme

- \`tode --theme\` reads the terminal palette over OSC and rebuilds everything;
  \`tode --theme <file.json>\` sets a vscode theme document instead.
- ${LIVE_THEME_FILE} — the full generated theme. Open windows watch it and
  restyle without a reload, so writing a valid vscode theme document here is
  the live-update path. It is regenerated from the palette on the next open.
- ${PALETTE_CACHE} — cached terminal colours; delete to force a re-read.
- ${CSS_FILE} — css the proxy injects into every workbench page; regenerated
  on every open. Its siblings ${path.basename(CSS_FILE)}.timing.json and .launch.json feed \`tode --timing\`.

## Terminal shortcut overrides

The wizard (\`tode --shortcut-setup\`, \`--undo\` to revert) frees contested chords
by writing one tode-owned file into the terminal's config dir and a single
include line into the terminal's own config — nothing the user wrote is edited.

- decisions live in ${DECISIONS_FILE}
- ghostty: <config>/tode/keybinds.ghostty via \`config-file = ?tode/keybinds.ghostty\`
- kitty: <config>/tode/keybinds.kitty.conf via \`include tode/keybinds.kitty.conf\`
- prefer re-running the wizard over editing these; it reconciles against the
  live terminal keymap.

## Reaching a running window

Each window's bridge extension listens on a unix socket in ${ipcSocketDir()}
and exports its address as TODE_IPC into its integrated terminals. Protocol:
connect, send one JSON line, close. The shape:

  {"files":[{"path":"/abs","line":1,"column":1}],"folders":["/abs"],"add":false,"wait":false,"diff":["/a","/b"],"view":"scm","theme":{...}}

The tode CLI does this for you: inside a window, \`tode <file>\` opens there,
\`tode -r <folder>\` replaces the workspace, \`--review\` focuses source control.
${STARTUP_OPEN_FILE} is a one-shot marker with the parts of an open the url cannot carry (gotos, diffs, a view to focus); the bridge replays it once at startup.

## Daemon and processes

- ${STATE_FILE} — pids and ports of the VS Code server and the injector; treat as
  read-only, \`tode --shutdown\` removes it properly.
- ${PORT_FILE} — the injector's sticky port, reused while free so saved
  workspaces and the chromium cache stay valid.
- ${SERVER_LOG} — combined server + injector log, append-only.
- the workbench is served by \`code serve-web --without-connection-token\` on
  127.0.0.1, --server-data-dir ${VSCODE_DIR} (so user data ${path.join(VSCODE_DIR, "data")},
  extensions ${EXTENSIONS_DIR}) and --cli-data-dir ${CLI_DATA_DIR}.

## Homes on disk

- data ${DATA_DIR} — profile, theme, generated scripts, the fetched VS Code cli
  (${CLI_DIR}), the servers it downloads (${CLI_DATA_DIR}) and terminal-browser
  trees (${RUNTIME_DIR})
- state ${STATE_DIR} — daemon state, logs, ipc sockets, install receipt (install.json)
- cache ${CACHE_DIR} — converted app icons and the browser's cache
- terminal-browser gets its own homes so the user's are untouched:
  data ${BROWSER_HOME.data}, state ${BROWSER_HOME.state}, cache ${BROWSER_HOME.cache},
  chromium ${BROWSER_HOME.appData}
- \`tode --uninstall\` removes all of the above plus the install root, shim,
  font and ghostty overrides.

## Environment variables

- TODE_IPC — set inside tode windows; the window's socket
- TODE_INSTALL_ROOT — overrides the install tree
- TODE_VSCODE_CLI — use your own VS Code \`code\` cli binary
- TODE_VSCODE_UPDATE_ORIGIN — where the cli is looked up and downloaded from
- TODE_TERMINAL_BROWSER_BIN — use your own terminal-browser
- TODE_RELEASE_ORIGIN — where upgrades and runtime downloads come from
- TODE_BROWSER_DATA/_STATE/_CACHE/_RUN/_APPDATA — move the browser homes
- XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME / XDG_BIN_HOME — move tode's homes and the shim

## Commands

open: \`tode [path...]\` (-g goto, -d diff, -a add, -r reuse, -n new pane, -w wait,
--split/--size, --review, --install-extension, --list-extensions). Every bare
word is a path; commands are flags in first position: --shortcut-setup,
--import, --theme, --timing (alone: the last page load), --upgrade,
--shutdown, --uninstall, --skill (this document).
`;
}

export async function skillCommand(): Promise<number> {
  process.stdout.write(await skillText());
  return 0;
}
