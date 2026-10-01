import fs from "node:fs";
import path from "node:path";

import type { BridgeCtx } from "./bridge/ctx";
import { bridgeMain } from "./bridge/extension";
import type { OpenRequest } from "./ipc";
import { DATA_DIR } from "./runtime/paths";
import { daemonSocket } from "./app/protocol";
import { EXTENSIONS_DIR, LIVE_THEME_FILE, TRANSPARENCY_SETTING } from "./profile";
import {
  IMPORT_DECISION_ID,
  QUIT_CHORD,
  QUIT_COMMAND,
  hintWhen,
  loadDecisions,
  quitWhen,
} from "./shortcuts/store";

const BRIDGE_ID = "tode.tode-bridge";
const BRIDGE_VERSION = "1.6.0";

export const STARTUP_OPEN_FILE = path.join(DATA_DIR, "startup-open.json");

export function requestStartupOpen(request: Partial<OpenRequest>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_OPEN_FILE, `${JSON.stringify({ ...request, at: Date.now() })}\n`);
}
export const BRIDGE_DIR = path.join(EXTENSIONS_DIR, `${BRIDGE_ID}-${BRIDGE_VERSION}`);


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
    activationEvents: ["*"],
    contributes: {
      commands: [
        { command: "tode.quit", title: "Quit", category: "terminal-code" },
        { command: "tode.enableTransparency", title: "Enable Transparency", category: "terminal-code" },
        { command: "tode.disableTransparency", title: "Disable Transparency", category: "terminal-code" },
      ],
      menus: {
        commandPalette: [
          { command: "tode.enableTransparency", when: "!tode.transparent" },
          { command: "tode.disableTransparency", when: "tode.transparent" },
        ],
      },
      configuration: {
        title: "terminal-code",
        properties: {
          [TRANSPARENCY_SETTING]: {
            type: "boolean",
            default: false,
            description:
              "Make the editor transparent. Takes effect when the window is reloaded.",
          },
        },
      },
      keybindings: [quitBinding, ...hintBinding],
    },
  };
}

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
      daemonSocket: daemonSocket(),
      transparencySetting: TRANSPARENCY_SETTING,
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
    return;
  }
  const entry: ExtensionEntry = {
    identifier: { id: BRIDGE_ID },
    version: BRIDGE_VERSION,
    relativeLocation: path.basename(BRIDGE_DIR),
    location: { $mid: 1, path: BRIDGE_DIR, scheme: "file" },
    metadata: { isApplicationScoped: false, isMachineScoped: false, installedTimestamp: 0 },
  };
  const without = listed.filter((item) => item.identifier?.id !== BRIDGE_ID);
  fs.writeFileSync(file, `${JSON.stringify([...without, entry], null, 2)}\n`);
}
