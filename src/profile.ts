import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CSS_FILE } from "./codeserver/server";
import { FONT_FALLBACKS, injectedCss } from "./codeserver/inject";
import { parseJsonc, readKey, setKeys } from "./jsonc";
import { DATA_DIR } from "./runtime/paths";
import { CLAIM_DECISION_ID, IMPORT_DECISION_ID, QUIT_CHORD, QUIT_COMMAND, claimBindings, fallbackBindings, hintBindings, loadDecisions, overrideBindings, quitBindings, quitWhen, decisionsStamp } from "./shortcuts/store";
import { queryTerminal, withFallbacks } from "./terminal/osc";
import type { ParsedReplies, TerminalPalette } from "./terminal/osc";
import { hex } from "./theme/color";
import {
  THEME_NAME,
  generateTheme,
  paletteFingerprint,
  themeFingerprint,
} from "./theme/generate";

export const VSCODE_DIR = path.join(DATA_DIR, "vscode");
export const USER_DIR = path.join(VSCODE_DIR, "user-data", "User");
export const EXTENSIONS_DIR = path.join(VSCODE_DIR, "extensions");
export const THEME_EXTENSION_ID = "tode.tode-theme";

function themeExtensionDir(fingerprint: string): string {
  return path.join(EXTENSIONS_DIR, `${THEME_EXTENSION_ID}-${fingerprint}`);
}

function forgetOldThemeExtensions(keep: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(EXTENSIONS_DIR);
  } catch {
    return;
  }
  const prefix = `${THEME_EXTENSION_ID}-`;
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry !== keep) {
      fs.rmSync(path.join(EXTENSIONS_DIR, entry), { recursive: true, force: true });
    }
  }
}
// hm
export const PALETTE_CACHE = path.join(DATA_DIR, "palette.json");
// hm
export const LIVE_THEME_FILE = path.join(DATA_DIR, "live-theme.json");

export const FONT_FAMILY = "JetBrains Mono";
const FONT_FILE = "JetBrainsMono-Regular.ttf";

export function assetPath(name: string): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "fonts", name);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`bundled font missing: ${name}`);
  }
}

export const FONT_ASSET = FONT_FILE;

// interesting, we actually install the font at a legimate location?
export function userFontsDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Fonts");
  const dataHome =
    process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
      ? process.env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "fonts");
}

export function ensureFont(): "installed" | "present" {
  const target = path.join(userFontsDir(), FONT_FILE);
  if (fs.existsSync(target)) return "present";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(assetPath(FONT_FILE), target);
  if (process.platform !== "darwin") {
    try {
      execFileSync("fc-cache", ["-f", path.dirname(target)], { stdio: "ignore" });
    } catch { }
  }
  return "installed";
}

export function cachedPalette(): TerminalPalette | null {
  try {
    return JSON.parse(fs.readFileSync(PALETTE_CACHE, "utf8")) as TerminalPalette;
  } catch {
    return null;
  }
}

function completeAnswer(asked: ParsedReplies | null): boolean {
  return !!asked?.background && !!asked.foreground && asked.ansi.every((slot) => slot !== null);
}

export function resolvePalette(
  asked: ParsedReplies | null,
  cached: TerminalPalette | null,
): { palette: TerminalPalette; source: "terminal" | "cache" | "default" } {
  if (completeAnswer(asked)) return { palette: withFallbacks(asked), source: "terminal" };
  if (asked?.background) {
    const base = cached ?? withFallbacks(null);
    return {
      palette: {
        background: asked.background,
        foreground: asked.foreground ?? base.foreground,
        ansi: base.ansi.map((slot, at) => asked.ansi[at] ?? slot),
      },
      source: cached ? "cache" : "default",
    };
  }
  if (cached) return { palette: cached, source: "cache" };
  return { palette: withFallbacks(null), source: "default" };
}

export async function readPalette(): Promise<{ palette: TerminalPalette; source: "terminal" | "cache" | "default" }> {
  const resolved = resolvePalette(await queryTerminal(), cachedPalette());
  if (resolved.source === "terminal") {
    fs.mkdirSync(path.dirname(PALETTE_CACHE), { recursive: true });
    fs.writeFileSync(PALETTE_CACHE, `${JSON.stringify(resolved.palette, null, 2)}\n`);
  }
  return resolved;
}

function writeIfChanged(file: string, contents: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === contents) return false;
  } catch { }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return true;
}

/**
 * sus
 */
export interface ThemeDocument {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  semanticHighlighting?: boolean;
}

export function installTheme(palette: TerminalPalette): { changed: boolean; fingerprint: string } {
  return installThemeJson(generateTheme(palette), paletteFingerprint(palette));
}

export function installThemeJson(
  theme: ThemeDocument,
  fingerprint: string,
): { changed: boolean; fingerprint: string } {
  const dir = themeExtensionDir(fingerprint);
  const already = fs.existsSync(path.join(dir, "themes", "tode-terminal.json"));
  if (!already) {
    const manifest = {
      name: "tode-theme",
      displayName: "terminal-code terminal theme",
      publisher: "tode",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      categories: ["Themes"],
      contributes: {
        themes: [
          {
            label: THEME_NAME,
            uiTheme: theme.type === "light" ? "vs" : "vs-dark",
            path: "./themes/tode-terminal.json",
          },
        ],
      },
    };
    fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(
      path.join(dir, "themes", "tode-terminal.json"),
      `${JSON.stringify(theme, null, 2)}\n`,
    );
  }
  registerThemeExtension(dir);
  forgetOldThemeExtensions(path.basename(dir));
  return { changed: !already, fingerprint };
}

interface ExtensionEntry {
  identifier: { id: string; uuid?: string };
  version: string;
  relativeLocation?: string;
  location?: { path?: string; scheme?: string; $mid?: number };
  metadata?: Record<string, unknown>;
}

function newestThemeExtensionDir(): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(EXTENSIONS_DIR);
  } catch {
    return null;
  }
  const prefix = `${THEME_EXTENSION_ID}-`;
  const withMtime = entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => {
      const full = path.join(EXTENSIONS_DIR, entry);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { full: string; mtime: number } => entry !== null);
  if (withMtime.length === 0) return null;
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].full;
}

export function registerThemeExtension(dir?: string): void {
  const themeDir = dir ?? newestThemeExtensionDir();
  if (!themeDir) return;
  const manifest = path.join(EXTENSIONS_DIR, "extensions.json");
  let listed: ExtensionEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (Array.isArray(parsed)) listed = parsed;
  } catch {
    if (fs.existsSync(manifest)) return;
  }
  const folder = path.basename(themeDir);
  const entry: ExtensionEntry = {
    identifier: { id: THEME_EXTENSION_ID },
    version: "1.0.0",
    relativeLocation: folder,
    location: { $mid: 1, path: themeDir, scheme: "file" },
    metadata: { isApplicationScoped: false, isMachineScoped: false, installedTimestamp: 0 },
  };
  const without = listed.filter((item) => item.identifier?.id !== entry.identifier.id);
  writeIfChanged(manifest, `${JSON.stringify([...without, entry], null, 2)}\n`);
}

const FONT_STACK = `"${FONT_FAMILY}", ${FONT_FALLBACKS}`;

export const SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": THEME_NAME,
  "editor.fontFamily": FONT_STACK,
  "terminal.integrated.fontFamily": FONT_STACK,
  "chat.editor.fontFamily": FONT_STACK,
  "debug.console.fontFamily": FONT_STACK,
  "markdown.preview.fontFamily": FONT_STACK,
  "terminal.integrated.enableImages": true,
  "workbench.startupEditor": "none",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.commandCenter.enabled": false,
  // wait what
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "window.commandCenter": false,
  // The default title format ends in ${appName} — "code-server". The folder is
  // already on the window above this bar, so the file name is the only part
  // left worth showing. ${dirty} puts a dot in front of unsaved work.
  "window.title": "${dirty}${activeEditorShort}",
  // wait why are we applying this?
  "editor.smoothScrolling": false,
  "workbench.list.smoothScrolling": false,
  // huh?
  "terminal.integrated.smoothScrolling": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "workbench.enableExperiments": false,
};

export const SEEDED_SETTINGS: Record<string, unknown> = {
  "workbench.activityBar.location": "top",
  "editor.fontSize": 13,
  "workbench.tree.indent": 12,
  "editor.cursorBlinking": "solid",
  "editor.minimap.enabled": false,
  "scm.defaultViewMode": "tree",
};

export function installCss(palette: TerminalPalette): boolean {
  return writeIfChanged(CSS_FILE, injectedCss(hex(palette.background), FONT_FAMILY));
}

export function setLiveTheme(theme: ThemeDocument): boolean {
  return writeIfChanged(LIVE_THEME_FILE, `${JSON.stringify(theme)}\n`);
}

export function setThemeFile(file: string): string | null {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return `could not read ${file}`;
  }
  const theme = parseJsonc<ThemeDocument>(source);
  if (!theme || typeof theme !== "object" || (!theme.colors && !theme.tokenColors)) {
    return `${file} is not a vscode theme (expected a json document with colors or tokenColors)`;
  }
  installThemeJson(theme, themeFingerprint(theme));
  setLiveTheme(theme);
  return null;
}

export function managedSettings(): Record<string, unknown> {
  return { ...SETTINGS };
}

export function applySettings(source: string): string {
  const absent = Object.fromEntries(
    Object.entries(SEEDED_SETTINGS).filter(([key]) => readKey(source, key) === undefined),
  );
  return setKeys(setKeys(source, absent), SETTINGS);
}

export function installSettings(): boolean {
  const file = path.join(USER_DIR, "settings.json");
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch { }
  return writeIfChanged(file, applySettings(source || "{}"));
}

export function builtinKeybindings(): Binding[] {
  return [
    { key: QUIT_CHORD, command: QUIT_COMMAND, when: quitWhen() },
    ...hintBindings(),
  ];
}

export function todeKeybindings(): unknown[] {
  return [
    ...quitBindings(),
    ...hintBindings(),
    ...fallbackBindings().map(({ key, command, when }) =>
      when ? { key, command, when } : { key, command },
    ),
  ];
}

export interface Binding {
  key?: string;
  command?: string;
  when?: string;
}

const KEYBINDINGS_FILE = path.join(USER_DIR, "keybindings.json");

export interface ManagedProfilePaths {
  font: string;
  css: string;
  liveTheme: string;
  settings: string;
  keybindingsRecord: string;
  extensionsRegistry: string;
}

export function managedProfilePaths(): ManagedProfilePaths {
  return {
    font: path.join(userFontsDir(), FONT_FILE),
    css: CSS_FILE,
    liveTheme: LIVE_THEME_FILE,
    settings: path.join(USER_DIR, "settings.json"),
    keybindingsRecord: KEYBINDINGS_RECORD,
    extensionsRegistry: path.join(EXTENSIONS_DIR, "extensions.json"),
  };
}
export const KEYBINDINGS_RECORD = path.join(DATA_DIR, "keybindings.tode.json");

function sameBinding(a: Binding, b: Binding): boolean {
  return a.key === b.key && a.command === b.command && (a.when ?? "") === (b.when ?? "");
}

function readBindings(file: string): Binding[] {
  try {
    const parsed = parseJsonc<Binding[]>(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function holdsStamp(): string {
  const stamp = (file: string) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };
  return [
    stamp(KEYBINDINGS_FILE),
    stamp(KEYBINDINGS_RECORD),
    stamp(path.join(EXTENSIONS_DIR, "extensions.json")),
    stamp(EXTENSIONS_DIR),
    decisionsStamp(),
  ].join(":");
}

export function removalMasked(chord: string, command: string): boolean {
  const canon = (value: string) =>
    value.toLowerCase().split("+").map((part) => part.trim()).sort().join("+");
  const target = `${canon(chord)}:${command}`;
  const negative = (entry: Binding) =>
    !!entry.key &&
    !!entry.command?.startsWith("-") &&
    `${canon(entry.key)}:${entry.command.slice(1)}` === target;
  return (
    readBindings(KEYBINDINGS_FILE).some(negative) ||
    [...overrideBindings(), ...claimBindings()].some(negative)
  );
}

export function foreignBindings(): Binding[] {
  const mine = [...(todeKeybindings() as Binding[]), ...overrideBindings(), ...claimBindings()];
  const previouslyMine = readBindings(KEYBINDINGS_RECORD);
  return readBindings(KEYBINDINGS_FILE).filter(
    (entry) =>
      !previouslyMine.some((old) => sameBinding(old, entry)) &&
      !mine.some((current) => sameBinding(current, entry)),
  );
}

export function installKeybindings(): boolean {
  return writeBindings(todeKeybindings() as Binding[], foreignBindings());
}

function quitWinsBindings(theirs: Binding[]): Binding[] {
  const choices = loadDecisions()?.choices ?? {};
  if (choices[IMPORT_DECISION_ID] || choices[CLAIM_DECISION_ID]) return [];
  const canon = (chord: string) => chord.toLowerCase().split("+").sort().join("+");
  const shadowed = theirs.some(
    (entry) =>
      !!entry.key &&
      !!entry.command &&
      !entry.command.startsWith("-") &&
      canon(entry.key) === canon(QUIT_CHORD) &&
      entry.command !== QUIT_COMMAND,
  );
  return shadowed ? [{ key: QUIT_CHORD, command: QUIT_COMMAND, when: quitWhen() }] : [];
}

function writeBindings(mine: Binding[], theirs: Binding[]): boolean {
  const winners = [...overrideBindings(), ...claimBindings(), ...quitWinsBindings(theirs)];
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(KEYBINDINGS_RECORD), { recursive: true });
  const recordChanged = writeIfChanged(
    KEYBINDINGS_RECORD,
    `${JSON.stringify([...mine, ...winners], null, 2)}\n`,
  );
  const userChanged = writeIfChanged(
    KEYBINDINGS_FILE,
    `// \n${JSON.stringify([...mine, ...theirs, ...winners], null, 2)}\n`,
  );
  return recordChanged || userChanged;
}

export function mergeKeybindings(theirs: Binding[]): number {
  const existing = foreignBindings();
  const added = theirs.filter((entry) => !existing.some((have) => sameBinding(have, entry)));
  writeBindings(todeKeybindings() as Binding[], [...existing, ...added]);
  return added.length;
}
