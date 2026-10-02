#!/usr/bin/env node
// Serves the shortcuts wizard UI on 127.0.0.1 with a mocked terminal backend,
// no terminal-browser or Ghostty/kitty needed — open the printed url in any
// browser. Decisions land in a throwaway dir via XDG overrides, so nothing on
// this machine is touched; "apply" exercises the real session code paths.
//
//   node scripts/dev-shortcuts-ui.mjs
//
// Tweak CONFLICTS below to shape what the page shows.

import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sandbox = path.join(root, ".dev-ui-sandbox");

process.env.XDG_DATA_HOME = path.join(sandbox, "data");
process.env.XDG_STATE_HOME = path.join(sandbox, "state");
process.env.XDG_CACHE_HOME = path.join(sandbox, "cache");

const { startManager } = await import(path.join(root, "dist", "shortcuts", "web.js"));
const { managerSession, normalizeChord } = await import(
  path.join(root, "dist", "shortcuts", "wizard.js")
);

/** What scan() reports as contested: ghostty-shaped rows. current is the
 * action ghostty runs today; editor.command is what vscode wants instead. */
const CONFLICTS = [
  {
    editorId: "ctrl+shift+c",
    trigger: "super+shift+c",
    current: "copy_to_clipboard",
    editor: { means: "copy", command: "workbench.action.editor.copy" },
    others: [],
    inTerminal: "runs copy to clipboard in Ghostty, so copy never reaches the editor",
    short: "copy to clipboard",
    freed: "copy to clipboard goes",
    tradeoff: "Ghostty's copy to clipboard stops working",
  },
  {
    editorId: "ctrl+shift+v",
    trigger: "super+shift+v",
    current: "paste_from_clipboard",
    editor: { means: "paste", command: "editor.action.clipboardPasteAction" },
    others: [],
    inTerminal: "runs paste from clipboard in Ghostty, so paste never reaches the editor",
    short: "paste from clipboard",
    freed: "paste from clipboard goes",
    tradeoff: "Ghostty's paste from clipboard stops working",
  },
  {
    editorId: "ctrl+shift+f",
    trigger: "super+shift+f",
    current: null,
    editor: { means: "find in files", command: "workbench.action.findInFiles" },
    others: [],
    inTerminal: "runs what it ran before in Ghostty, so find in files never reaches the editor",
    short: "what it ran before",
    freed: "what it ran before goes",
    tradeoff: "Ghostty's what it ran before stops working",
  },
];

const TAKEN_AS = new Map([
  ["ctrl+shift+k", "clear_screen"],
  ["ctrl+shift+w", "close_window"],
]);

const provider = {
  id: "mock-ghostty",
  name: "Ghostty",
  detect: () => true,
  ready: () => null,
  scan: () => CONFLICTS.map((conflict) => ({ ...conflict })),
  takenAs: (chord) => TAKEN_AS.get(chord) ?? null,
  trigger: (chord) => chord,
  describe: (action) => action.replaceAll("_", " "),
  apply: () => "",
  onApplied: () => false,
  undo: () => false,
  reloadHint: () => "reload Ghostty (cmd+shift+,) or restart it for this to take effect",
};

const palette = {
  background: [13, 15, 19],
  foreground: [230, 233, 239],
  ansi: [
    [26, 27, 30], [229, 72, 77], [48, 164, 108], [245, 165, 36],
    [93, 156, 255], [186, 148, 255], [94, 201, 227], [200, 205, 215],
    [90, 96, 106], [255, 108, 112], [76, 194, 138], [255, 196, 84],
    [124, 178, 255], [206, 176, 255], [126, 220, 240], [235, 238, 245],
  ],
};

const session = managerSession(provider);
const manager = await startManager({
  rows: session.rows,
  taken: session.taken,
  normalize: normalizeChord,
  decide: session.decide,
  confirm: () => {
    session.confirm();
    return { note: `applied — ${provider.reloadHint()} (mock: nothing was reloaded)` };
  },
  next: async () => null,
  continues: false,
  reloadHint: provider.reloadHint(),
  terminalName: provider.name,
  palette,
  intro: true,
});

console.log(`shortcuts ui: http://127.0.0.1:${manager.port}  (sandbox: ${sandbox})`);
console.log("ctrl-c to stop");
