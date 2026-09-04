import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseJsonc, setKeys } from "../jsonc";
import {
  EXTENSIONS_DIR,
  USER_DIR,
  applySettings,
  managedSettings,
  mergeKeybindings,
  registerThemeExtension,
} from "../profile";
import type { Editor } from "./editors";

export interface ImportReport {
  settings: { imported: number; keptByTode: string[] } | null;
  keybindings: number | null;
  snippets: string[];
  tasks: boolean;
  extensions: { copied: string[]; skipped: { id: string; why: string }[] };
}

function copyTree(from: string, to: string): boolean {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  try {
    // clones rather than copies on apfs, which matters for hundreds of megabytes
    fs.cpSync(from, to, { recursive: true });
    return true;
  } catch {
    try {
      execFileSync("cp", ["-R", from, to], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

function importSettings(editor: Editor): ImportReport["settings"] {
  const from = path.join(editor.userDir, "settings.json");
  if (!fs.existsSync(from)) return null;
  const theirs = parseJsonc<Record<string, unknown>>(fs.readFileSync(from, "utf8"));
  if (!theirs) return null;
  const managed = managedSettings();
  const target = path.join(USER_DIR, "settings.json");
  let current = "{}";
  try {
    current = fs.readFileSync(target, "utf8") || "{}";
  } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, applySettings(setKeys(current, theirs)));
  return {
    imported: Object.keys(theirs).length,
    keptByTode: Object.keys(theirs).filter((key) => key in managed),
  };
}

function importKeybindings(editor: Editor): number | null {
  const from = path.join(editor.userDir, "keybindings.json");
  if (!fs.existsSync(from)) return null;
  const theirs = parseJsonc<Record<string, unknown>[]>(fs.readFileSync(from, "utf8"));
  if (!Array.isArray(theirs)) return null;
  return mergeKeybindings(theirs);
}

function importSnippets(editor: Editor): string[] {
  const from = path.join(editor.userDir, "snippets");
  let names: string[];
  try {
    names = fs.readdirSync(from);
  } catch {
    return [];
  }
  const to = path.join(USER_DIR, "snippets");
  fs.mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of names) {
    try {
      fs.copyFileSync(path.join(from, name), path.join(to, name));
      copied.push(name);
    } catch {}
  }
  return copied;
}

function importTasks(editor: Editor): boolean {
  const from = path.join(editor.userDir, "tasks.json");
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.copyFileSync(from, path.join(USER_DIR, "tasks.json"));
  return true;
}

interface ExtensionEntry {
  identifier: { id: string; uuid?: string };
  version: string;
  relativeLocation?: string;
  location?: { path?: string; scheme?: string; $mid?: number };
  metadata?: Record<string, unknown>;
}

function importExtensions(
  editor: Editor,
  onProgress?: (done: number, total: number, id: string) => void,
): ImportReport["extensions"] {
  const copied: string[] = [];
  const skipped: { id: string; why: string }[] = [];
  if (!editor.extensionsDir) return { copied, skipped };
  let listed: ExtensionEntry[];
  try {
    listed = JSON.parse(fs.readFileSync(path.join(editor.extensionsDir, "extensions.json"), "utf8"));
  } catch {
    return { copied, skipped: [{ id: "extensions.json", why: "could not be read" }] };
  }
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

  const target = path.join(EXTENSIONS_DIR, "extensions.json");
  let existing: ExtensionEntry[] = [];
  try {
    existing = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {}

  const kept = new Map(existing.map((entry) => [entry.identifier.id, entry]));
  let done = 0;
  for (const entry of listed) {
    const folder = entry.relativeLocation ?? path.basename(entry.location?.path ?? "");
    const from = path.join(editor.extensionsDir, folder);
    done += 1;
    onProgress?.(done, listed.length, entry.identifier.id);
    if (!folder || !fs.existsSync(from)) {
      skipped.push({ id: entry.identifier.id, why: "its folder is missing" });
      continue;
    }
    const to = path.join(EXTENSIONS_DIR, folder);
    if (!copyTree(from, to)) {
      skipped.push({ id: entry.identifier.id, why: "could not be copied" });
      continue;
    }
    kept.set(entry.identifier.id, {
      ...entry,
      relativeLocation: folder,
      location: { $mid: 1, path: to, scheme: "file" },
    });
    copied.push(entry.identifier.id);
  }
  fs.writeFileSync(target, `${JSON.stringify([...kept.values()], null, 2)}\n`);
  registerThemeExtension();
  return { copied, skipped };
}

export function runImport(
  editor: Editor,
  onProgress?: (done: number, total: number, id: string) => void,
): ImportReport {
  return {
    extensions: importExtensions(editor, onProgress),
    settings: importSettings(editor),
    keybindings: importKeybindings(editor),
    snippets: importSnippets(editor),
    tasks: importTasks(editor),
  };
}
