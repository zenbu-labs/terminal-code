import fs from "node:fs";
import path from "node:path";

import type { BridgeCtx } from "./bridge/ctx";
import { bridgeMain } from "./bridge/extension";
import type { OpenRequest } from "./ipc";
import { DATA_DIR } from "./runtime/paths";
import { EXTENSIONS_DIR, LIVE_THEME_FILE } from "./profile";
import {
  IMPORT_DECISION_ID,
  QUIT_CHORD,
  QUIT_COMMAND,
  hintWhen,
  loadDecisions,
  quitWhen,
} from "./shortcuts/store";

const BRIDGE_ID = "tode.tode-bridge";
const BRIDGE_VERSION = "1.5.1";

export const STARTUP_OPEN_FILE = path.join(DATA_DIR, "startup-open.json");

export function requestStartupOpen(request: Partial<OpenRequest>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_OPEN_FILE, `${JSON.stringify({ ...request, at: Date.now() })}\n`);
}
export const BRIDGE_DIR = path.join(EXTENSIONS_DIR, `${BRIDGE_ID}-${BRIDGE_VERSION}`);

/**
 *
 * i need to map out the code this is basically gonna be a giant code review session
 *
 * the obvious question is where is the entrypoint of the program
 * so i can start traversing it
 *
 *
 */
function manifest(): unknown {
  const quitBinding = { command: QUIT_COMMAND, key: QUIT_CHORD, when: quitWhen() };
  const hintBinding =
    QUIT_CHORD === "ctrl+c"
      ? []
      : [{ command: "tode.quitHint", key: "ctrl+c", when: hintWhen() }];
  return {
    name: "tode-bridge",
    displayName: "terminal-code",
    publisher: "tode",
    version: BRIDGE_VERSION,
    engines: { vscode: "^1.80.0" },
    main: "./extension.js",
    // "*" on purpose: onStartupFinished is deferred until the workbench has
    // idled, which makes tode --review flip the view seconds late. The bridge
    // is a few file reads and a socket, cheap enough to run during startup.
    activationEvents: ["*"],
    contributes: {
      // registerCommand alone makes a command exist — a keybinding can run it
      // without any declaration here. Declaring it is what lists it in the
      // command palette, so only the one deliberate action is declared:
      // confirmQuit (the ctrl+c reflex) and quitHint (the redirect toast) are
      // keybinding targets, and a palette full of quit flavours reads as noise
      commands: [{ command: "tode.quit", title: "Quit", category: "terminal-code" }],
      keybindings: [quitBinding, ...hintBinding],
    },
  };
}

// hm this is complicated, i dont think the decision choice case makes sense
export function quitHintMessage(): string {
  const choices = loadDecisions()?.choices ?? {};
  const decision = choices[IMPORT_DECISION_ID] ?? choices[QUIT_CHORD];
  if (decision?.choice === "editor" && decision.key) {
    return `Press ${decision.key} to quit terminal-code`;
  }
  if (decision?.choice === "keep") {
    return `${QUIT_CHORD} is taken. Quit terminal-code from the command palette, or run: tode --shortcut-setup`;
  }
  return `Press ${QUIT_CHORD} to quit terminal-code`;
}

export function bridgeSource(ctx: BridgeCtx): string {
  return `"use strict";\n(${bridgeMain.toString()})(${JSON.stringify(ctx)});\n`;
}

function writeIfChanged(file: string, contents: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === contents) return false;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return true;
}

export function installBridge(tode: string[]): boolean {
  const wroteManifest = writeIfChanged(
    path.join(BRIDGE_DIR, "package.json"),
    `${JSON.stringify(manifest(), null, 2)}\n`,
  );
  const wroteSource = writeIfChanged(
    path.join(BRIDGE_DIR, "extension.js"),
    bridgeSource({
      tode,
      liveThemeFile: LIVE_THEME_FILE,
      quitHint: quitHintMessage(),
      startupOpenFile: STARTUP_OPEN_FILE,
    }),
  );
  registerBridge();
  return wroteManifest || wroteSource;
}

interface ExtensionEntry {
  identifier: { id: string };
  version: string;
  relativeLocation?: string;
  location?: { path?: string; scheme?: string; $mid?: number };
  metadata?: Record<string, unknown>;
}

export function registerBridge(): void {
  const file = path.join(EXTENSIONS_DIR, "extensions.json");
  let listed: ExtensionEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) listed = parsed;
  } catch {
    if (fs.existsSync(file)) return;
  }
  const entry: ExtensionEntry = {
    identifier: { id: BRIDGE_ID },
    version: BRIDGE_VERSION,
    relativeLocation: path.basename(BRIDGE_DIR),
    location: { $mid: 1, path: BRIDGE_DIR, scheme: "file" },
    metadata: { isApplicationScoped: false, isMachineScoped: false, installedTimestamp: 0 },
  };
  const without = listed.filter((item) => item.identifier?.id !== BRIDGE_ID);
  writeIfChanged(file, `${JSON.stringify([...without, entry], null, 2)}\n`);
}
