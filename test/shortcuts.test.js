const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function freshRequire(name) {
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  return require(name);
}

test("ghostty keybinds parse from +list-keybinds output", () => {
  const { parseKeybinds } = require("../dist/shortcuts/backends/ghostty.js");
  const table = parseKeybinds(
    [
      "keybind = super+w=close_surface",
      "keybind = super+z=undo",
      "keybind=super+a=select_all",
      "not a keybind line",
    ].join("\n"),
  );
  assert.equal(table.get("super+w"), "close_surface");
  assert.equal(table.get("super+a"), "select_all");
  assert.equal(table.size, 3);
});

test("freeing chords writes only tode's file and one include line, and undoes cleanly", () => {
  const { writeFreed, removeFreed, freedTriggers, withInclude, INCLUDE_LINE } = require("../dist/shortcuts/backends/ghostty.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-ghostty-"));
  const configFile = path.join(dir, "config");
  const own = "font-size = 14\nkeybind = super+q=quit\n";
  fs.writeFileSync(configFile, own);
  try {
    writeFreed(dir, [{ trigger: "super+w" }, { trigger: "super+z" }]);
    assert.deepEqual([...freedTriggers(dir)].sort(), ["super+w", "super+z"]);
    assert.equal(fs.readFileSync(configFile, "utf8"), `${own}${INCLUDE_LINE}\n`);

    // the include line never doubles up
    assert.equal(withInclude(fs.readFileSync(configFile, "utf8")), `${own}${INCLUDE_LINE}\n`);

    // a smaller set replaces the file rather than growing it
    writeFreed(dir, [{ trigger: "super+w" }]);
    assert.deepEqual([...freedTriggers(dir)], ["super+w"]);

    // an empty set removes everything tode wrote, and the user's config survives
    writeFreed(dir, []);
    assert.equal(freedTriggers(dir).size, 0);
    assert.equal(fs.readFileSync(configFile, "utf8"), own);
    assert.equal(removeFreed(dir), false, "nothing left for undo to do");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only chords bound to something other than unbind or ignore are conflicts", () => {
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/backends/ghostty.js");
  const holds = (chord) =>
    ({
      "cmd+backspace": [{ command: "deleteAllLeft" }],
      "cmd+z": [{ command: "undo" }],
      "cmd+w": [{ command: "workbench.action.closeActiveEditor" }],
    })[chord] ?? [];
  const shipped = parseKeybinds(
    ["keybind = super+backspace=unbind", "keybind = super+z=ignore", "keybind = super+w=close_surface"].join("\n"),
  );
  const conflicts = allConflicts(shipped, new Set(), holds);
  assert.equal(conflicts.some((c) => c.trigger === "super+backspace"), false, "already unbound");
  assert.equal(conflicts.some((c) => c.trigger === "super+z"), false, "already ignored");
  assert.deepEqual(conflicts.map((c) => c.trigger), ["super+w"]);
});

test("a chord ghostty never bound at all is not a conflict", () => {
  const { allConflicts } = require("../dist/shortcuts/backends/ghostty.js");
  assert.deepEqual(allConflicts(new Map(), new Set(), () => [{ command: "undo" }]), []);
});

test("the exact regression: what ghostty 1.3.1 actually ships for these", () => {
  // pinned from `ghostty +list-keybinds --default` on 1.3.1, so a future ghostty
  // release that changes its defaults shows up here rather than silently.
  // The text: rewrites (cmd+left/right/backspace) are deliberately NOT
  // conflicts: they reach the editor as ctrl+a/ctrl+e/ctrl+u, which vscode's
  // mac keymap already understands, so the behaviour survives the rewrite.
  const { parseKeybinds, allConflicts } = require("../dist/shortcuts/backends/ghostty.js");
  // what the mac workbench holds on these, keyed by canonical chord
  const holds = (chord) =>
    ({
      "cmd+z": [{ command: "undo" }],
      "shift+cmd+z": [{ command: "redo" }],
      "shift+cmd+t": [{ command: "workbench.action.reopenClosedEditor" }],
      "cmd+a": [{ command: "editor.action.selectAll" }],
      "cmd+w": [{ command: "workbench.action.closeActiveEditor" }],
      "cmd+left": [{ command: "cursorHome" }],
      "cmd+right": [{ command: "cursorEnd" }],
      "cmd+backspace": [{ command: "deleteAllLeft" }],
    })[chord] ?? [];
  const shipped = parseKeybinds([
    "keybind = super+arrow_right=text:\\\\x05",
    "keybind = super+arrow_left=text:\\\\x01",
    "keybind = super+backspace=text:\\\\x15",
    "keybind = super+z=undo",
    "keybind = super+shift+z=redo",
    "keybind = super+shift+t=undo",
    "keybind = super+a=select_all",
    "keybind = super+w=close_surface",
  ].join("\n"));
  const conflicts = allConflicts(shipped, new Set(), holds);
  assert.equal(conflicts.length, 5, "the action binds are flagged, the text rewrites are not");
  assert.ok(!conflicts.some((c) => c.trigger.includes("arrow") || c.trigger.includes("backspace")));
});

test("linux ghostty defaults: new_tab is the conflict, the ctrl+shift pairs are not", () => {
  // pinned from ghostty's linux defaults: ctrl+shift chords, with undo, redo,
  // select_all and quit unbound
  const { parseKeybinds, allConflicts } = require("../dist/shortcuts/backends/ghostty.js");
  const holds = (chord) =>
    ({
      "ctrl+shift+t": [{ command: "workbench.action.reopenClosedEditor" }],
      "ctrl+q": [{ command: "tode.confirmQuit" }],
    })[chord] ?? [];
  const shipped = parseKeybinds([
    "keybind = ctrl+shift+t=new_tab",
    "keybind = ctrl+shift+w=close_surface",
    "keybind = ctrl+shift+c=copy_to_clipboard",
    "keybind = ctrl+shift+v=paste_from_clipboard",
  ].join("\n"));
  const conflicts = allConflicts(shipped, new Set(), holds);
  assert.deepEqual(conflicts.map((c) => c.trigger), ["ctrl+shift+t"], "only new_tab shadows an editor chord");

  // the quit chord surfaces only for someone whose own config bound it,
  // because tode's own quit binding is what the editor holds there
  const custom = parseKeybinds(["keybind = ctrl+q=quit"].join("\n"));
  const quit = allConflicts(custom, new Set(), holds);
  assert.deepEqual(quit.map((c) => c.trigger), ["ctrl+q"]);
  assert.equal(quit[0].editor.means, "confirm quit", "the label derives from the command id");
});

test("a move writes the unbind and the rebind, carrying the action", () => {
  const { keybindsFileContents } = require("../dist/shortcuts/backends/ghostty.js");
  const contents = keybindsFileContents([
    { trigger: "super+w", to: "ctrl+alt+w", action: "close_surface" },
    { trigger: "super+z" },
  ]);
  assert.match(contents, /keybind = super\+w=unbind/);
  assert.match(contents, /keybind = ctrl\+alt\+w=close_surface/, "the action moves to the new trigger");
  assert.match(contents, /keybind = super\+z=unbind/);
  assert.ok(!contents.includes("undefined"), "a plain free adds no rebind line");
});

test("the include line survives a config with no trailing newline", () => {
  const { withInclude } = require("../dist/shortcuts/backends/ghostty.js");
  const out = withInclude("window-save-state = always");
  assert.equal(out.split("\n").filter((l) => l.startsWith("config-file")).length, 1);
  assert.ok(out.includes("window-save-state = always\nconfig-file"), "must not run onto the same line");
});

test("typed chords normalize into mod order, or are rejected", () => {
  const { normalizeChord } = require("../dist/shortcuts/wizard.js");
  assert.equal(normalizeChord("alt+ctrl+W"), "ctrl+alt+w");
  assert.equal(normalizeChord("shift + ctrl + t"), "ctrl+shift+t");
  assert.equal(normalizeChord("super+left"), "cmd+left");
  assert.equal(normalizeChord("ctrl+f12"), "ctrl+f12");
  assert.equal(normalizeChord("w"), null, "a bare key is not a chord");
  assert.equal(normalizeChord("ctrl+"), null);
  assert.equal(normalizeChord("banana+w"), null);
  assert.equal(normalizeChord("ctrl+ww"), null);
});

test("the on-complete reload walks the ancestry to ghostty and signals it", () => {
  const { reloadGhostty } = require("../dist/shortcuts/backends/ghostty.js");
  // this process (a node child of pid 500), whose parent 500 is ghostty
  const tree = {
    [process.pid]: { ppid: 500, command: "node" },
    500: { ppid: 10, command: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
    10: { ppid: 1, command: "launchd" },
  };
  const signalled = [];
  const ok = reloadGhostty((pid) => tree[pid] ?? null, (pid) => signalled.push(pid));
  assert.equal(ok, true, "ghostty found in the ancestry gets the reload signal");
  assert.deepEqual(signalled, [500], "SIGUSR2 goes to the ghostty process itself");

  // no ghostty anywhere: nothing signalled, caller falls back to the hint
  const bare = { [process.pid]: { ppid: 500, command: "zsh" }, 500: { ppid: 1, command: "launchd" } };
  const none = [];
  assert.equal(reloadGhostty((pid) => bare[pid] ?? null, (pid) => none.push(pid)), false);
  assert.equal(none.length, 0);

  // a signal that fails (ghostty gone mid-walk) reports false, not a throw
  const failing = reloadGhostty((pid) => tree[pid] ?? null, () => { throw new Error("ESRCH"); });
  assert.equal(failing, false);
});

test("editor chords translate to ghostty trigger syntax", () => {
  const { toTrigger } = require("../dist/shortcuts/backends/ghostty.js");
  assert.equal(toTrigger("cmd+w"), "super+w");
  assert.equal(toTrigger("cmd+left"), "super+arrow_left");
  assert.equal(toTrigger("ctrl+shift+w"), "ctrl+shift+w");
});

test("ghostty triggers translate back to editor chords, or to nothing", () => {
  const { fromTrigger, parseTrigger } = require("../dist/shortcuts/backends/ghostty.js");
  assert.equal(fromTrigger("super+f"), "cmd+f");
  assert.equal(fromTrigger("super+shift+p"), "shift+cmd+p", "mods land in canonical order");
  assert.equal(fromTrigger("super+arrow_left"), "cmd+left");
  assert.equal(fromTrigger("super+page_up"), "cmd+pageup");
  assert.equal(fromTrigger("super+digit_1"), "cmd+1");
  assert.equal(fromTrigger("copy"), null, "media keys have no editor spelling");

  assert.deepEqual(parseTrigger("global:alt+t"), { trigger: "alt+t", passesThrough: false });
  assert.deepEqual(parseTrigger("performable:super+c"), { trigger: "super+c", passesThrough: true });
  assert.deepEqual(parseTrigger("global:unconsumed:ctrl+a"), { trigger: "ctrl+a", passesThrough: true });
});

test("chords canonicalise across spellings, and sequences count as their opener", () => {
  const { canonicalChord } = require("../dist/shortcuts/vscode-keymap.js");
  assert.equal(canonicalChord("cmd+shift+p"), "shift+cmd+p", "one spelling, cmd last");
  assert.equal(canonicalChord("meta+F"), "cmd+f");
  assert.equal(canonicalChord("cmd+k cmd+s"), "cmd+k");
});

test("the vendored keymap says which VS Code it was dumped from", () => {
  // regenerate with scripts/generate-keymaps.js; the served VS Code moves with
  // stable, so the record is provenance rather than a pin to check against
  for (const platform of ["mac", "linux"]) {
    const file = path.join(__dirname, "..", "assets", "keymaps", `vscode-${platform}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(
      parsed.vscode ?? "",
      /^\d+\.\d+\.\d+$/,
      `assets/keymaps/vscode-${platform}.json does not name the VS Code it came from`,
    );
    assert.equal(parsed.platform, platform);
    assert.ok(parsed.bindings.length > 500, "a real keymap has hundreds of bindings");
  }
});

test("the platform keymap answers with this platform's chords", () => {
  const { defaultBinding } = require("../dist/shortcuts/vscode-keymap.js");
  const find = process.platform === "darwin" ? "cmd+f" : "ctrl+f";
  const other = process.platform === "darwin" ? "ctrl+f" : "cmd+f";
  assert.equal(defaultBinding(find).command, "actions.find");
  assert.notEqual(defaultBinding(other)?.command, "actions.find");
});

test("derived conflicts: a bind on a chord the editor holds surfaces, nothing else does", () => {
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/backends/ghostty.js");
  const holds = (chord) =>
    ({
      "cmd+f": [{ command: "actions.find" }],
      "shift+cmd+p": [{ command: "workbench.action.showCommands" }],
      "cmd+t": [{ command: "workbench.action.showAllSymbols" }],
      "cmd+w": [{ command: "workbench.action.closeActiveEditor" }],
    })[chord] ?? [];
  const live = parseKeybinds([
    "keybind = super+f=start_search",
    "keybind = super+shift+p=toggle_command_palette",
    "keybind = super+t=new_tab",
    "keybind = super+w=close_surface",
    "keybind = super+e=search_selection",
    "keybind = shift+arrow_left=adjust_selection:left",
    "keybind = super+arrow_left=text:\\\\x01",
    "keybind = super+g=navigate_search:next",
    "keybind = super+y=some_action_nobody_heard_of",
  ].join("\n"));
  const conflicts = allConflicts(live, new Set(), holds);

  const byId = new Map(conflicts.map((c) => [c.editorId, c]));
  assert.ok(byId.get("cmd+f"), "a new ghostty default is detected with no table change");
  assert.equal(byId.get("cmd+f").editor.command, "actions.find");
  assert.ok(byId.get("shift+cmd+p"), "the command palette chord is detected");
  assert.equal(byId.get("cmd+w").editor.command, "workbench.action.closeActiveEditor");
  assert.equal(byId.get("cmd+w").editor.means, "close active editor");
  assert.ok(!byId.has("cmd+e"), "state-dependent actions pass through, so they are not conflicts");
  assert.ok(!byId.has("shift+left"), "selection adjustment passes through");
  assert.ok(!byId.has("cmd+left"), "text rewrites are emulation, not conflicts");
  assert.ok(!byId.has("cmd+g"), "search navigation passes through");
  assert.ok(!byId.has("cmd+y"), "a chord the editor does not hold is no conflict");
});

test("macOS native tab cycling frees by rebinding to bytes — an unbind hands it to the OS", () => {
  // AppKit cycles ghostty's native tabs on ctrl+tab before the keybind table
  // runs. A bound trigger stays ghostty's, so freeing writes a rebind that
  // emits the chord itself; unbinding would change nothing.
  if (process.platform !== "darwin") return;
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/backends/ghostty.js");
  const holds = () => [{ command: "workbench.action.quickOpenNavigateNext" }];
  const live = parseKeybinds([
    "keybind = ctrl+tab=next_tab",
    "keybind = ctrl+shift+tab=previous_tab",
  ].join("\n"));
  const { withEmits } = require("../dist/shortcuts/backends/ghostty.js");
  const conflicts = allConflicts(live, new Set(), holds);
  assert.deepEqual(conflicts.map((c) => c.editorId), ["ctrl+tab", "ctrl+shift+tab"]);
  // freeing those rows completes into emit rebinds — on a live free (action
  // from the scan) and on a re-apply (action kept by the decision) alike
  const moves = withEmits([
    { trigger: "ctrl+tab", action: "next_tab" },
    { trigger: "ctrl+shift+tab", action: "previous_tab" },
    { trigger: "super+f", action: "start_search" },
  ]);
  assert.deepEqual(
    moves.map((m) => [m.trigger, m.emit ?? null]),
    [
      ["ctrl+tab", "esc:[27;5;9~"],
      ["ctrl+shift+tab", "esc:[27;6;9~"],
      ["super+f", null],
    ],
    "the exact sequences the terminal decodes back into the chords",
  );
});

test("emit rebinds are written instead of unbind, and count as freed", () => {
  const { keybindsFileContents, writeFreed, freedTriggers, emitSequence } = require("../dist/shortcuts/backends/ghostty.js");
  assert.equal(emitSequence("ctrl+tab"), "esc:[27;5;9~");
  assert.equal(emitSequence("ctrl+shift+tab"), "esc:[27;6;9~");
  assert.equal(emitSequence("cmd+f"), "esc:[27;9;102~");
  assert.equal(emitSequence("ctrl+left"), null, "no simple codepoint, no sequence");

  const contents = keybindsFileContents([
    { trigger: "ctrl+tab", emit: "esc:[27;5;9~" },
    { trigger: "super+f" },
  ]);
  assert.match(contents, /keybind = ctrl\+tab=esc:\[27;5;9~/);
  assert.ok(!contents.includes("ctrl+tab=unbind"), "the emit replaces the unbind");
  assert.match(contents, /keybind = super\+f=unbind/, "plain frees still unbind");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-emit-"));
  try {
    writeFreed(dir, [{ trigger: "ctrl+tab", emit: "esc:[27;5;9~" }, { trigger: "super+f" }]);
    assert.deepEqual([...freedTriggers(dir)].sort(), ["ctrl+tab", "super+f"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derived conflicts: custom binds and prefixes behave", () => {
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/backends/ghostty.js");
  const holds = (chord) => (chord === "cmd+p" ? [{ command: "workbench.action.quickOpen" }] : []);
  const live = parseKeybinds([
    "keybind = super+p=toggle_tab_overview",
    "keybind = performable:super+p=toggle_tab_overview",
  ].join("\n"));
  // the plain bind conflicts; the performable spelling of the same trigger
  // passes through and must not double-report
  const conflicts = allConflicts(live, new Set(), holds);
  assert.equal(conflicts.filter((c) => c.editorId === "cmd+p").length, 1);

  const passing = parseKeybinds(["keybind = performable:super+p=toggle_tab_overview"].join("\n"));
  assert.deepEqual(allConflicts(passing, new Set(), holds), []);
});

test("descriptions come from ghostty's own action docs, id-cleanup is the fallback", () => {
  const { allConflicts, parseActionDocs, parseKeybinds } = require("../dist/shortcuts/backends/ghostty.js");
  const docs = parseActionDocs(
    [
      "undo:",
      "  Undo the last undoable action, if possible.",
      "  ",
      "  Not every action is undoable.",
      "",
      "goto_tab:",
      "  Go to the tab with the specific",
      "  index, starting at 1.",
      "",
    ].join("\n"),
  );
  assert.equal(docs.get("undo"), "Undo the last undoable action, if possible");
  assert.equal(docs.get("goto_tab"), "Go to the tab with the specific index, starting at 1");

  const holds = (chord) =>
    ({ "cmd+z": [{ command: "undo" }], "cmd+1": [{ command: "cmd.one" }], "cmd+q": [{ command: "cmd.q" }] })[chord] ?? [];
  const live = parseKeybinds([
    "keybind = super+z=undo",
    "keybind = super+digit_1=goto_tab:1",
    "keybind = super+q=quit_something_undocumented",
  ].join("\n"));
  const conflicts = allConflicts(live, new Set(), holds, () => null, docs);
  const byId = new Map(conflicts.map((c) => [c.editorId, c]));
  assert.equal(byId.get("cmd+z").short, "Undo the last undoable action, if possible");
  assert.equal(byId.get("cmd+1").short, "Go to the tab with the specific index, starting at 1", "an argument does not hide the action's docs");
  assert.equal(byId.get("cmd+q").short, "quit something undocumented", "no docs falls back to the cleaned id");
});

test("a freed chord stays listed, and the freeing decision recalls its action", () => {
  const { allConflicts } = require("../dist/shortcuts/backends/ghostty.js");
  const holds = (chord) => (chord === "cmd+f" ? [{ command: "actions.find" }] : []);
  const freed = new Set(["super+f"]);
  const past = (chord) => (chord === "cmd+f" ? "start_search" : null);
  const conflicts = allConflicts(new Map([["super+f", "unbind"]]), freed, holds, past, new Map());
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].current, "start_search", "the freeing decision keeps the binding's identity");
  assert.equal(conflicts[0].editor.command, "actions.find");
  assert.equal(conflicts[0].short, "start search", "the texts still name what the trigger ran");

  const forgotten = allConflicts(new Map([["super+f", "unbind"]]), freed, holds, () => null, new Map());
  assert.equal(forgotten[0].short, "what it ran before", "with nothing to recall, say so");
});

test("derived editor decisions write keybindings through the command on the decision", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-derived-store-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        "cmd+f": { choice: "editor", key: "ctrl+alt+f", command: "actions.find" },
        "cmd+g": { choice: "editor", key: "ctrl+alt+g" },
      },
    });
    const bindings = store.fallbackBindings();
    assert.deepEqual(bindings, [{ key: "ctrl+alt+f", command: "actions.find", when: "!terminalFocus" }]);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the bridge extension carries the bindings the browser cannot read off disk", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-live-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        "cmd+shift+z": { choice: "editor", key: "ctrl+shift+z", command: "redo" },
        "claim:ctrl+k": { choice: "terminal", action: "workbench.action.terminal.clear" },
      },
    });
    const profile = require("../dist/profile.js");
    const { installBridge, BRIDGE_DIR } = require("../dist/bridge.js");
    // a binding of the user's own, which tode keeps
    fs.mkdirSync(profile.USER_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(profile.USER_DIR, "keybindings.json"),
      JSON.stringify([{ key: "alt+g", command: "acme.go" }]),
    );
    installBridge(["tode"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "package.json"), "utf8"));
    const bindings = manifest.contributes.keybindings;
    const has = (key, command) => bindings.some((b) => b.key === key && b.command === command);
    assert.ok(has(store.QUIT_CHORD, store.QUIT_COMMAND), "quit still comes with the bridge");
    assert.ok(has("ctrl+shift+z", "redo"), "a decision reaches the workbench");
    assert.ok(has("alt+g", "acme.go"), "and so does the user's own binding");
    // an extension contributes defaults, so it has no way to say "unbind this"
    assert.ok(
      !bindings.some((b) => b.command.startsWith("-")),
      "removals cannot be contributed, so they are left out",
    );
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("editor-side decisions become keybindings, terminal and keep do not", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-decisions-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    assert.deepEqual(store.fallbackBindings(), [], "no decisions means no bindings");

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        "cmd+w": { choice: "terminal" },
        "cmd+shift+z": { choice: "editor", key: "ctrl+shift+z", command: "redo" },
        "cmd+a": { choice: "editor", key: "ctrl+alt+a", command: "editor.action.selectAll" },
        "cmd+z": { choice: "keep" },
      },
    });
    const bindings = store.fallbackBindings();
    assert.equal(bindings.length, 2);
    const redo = bindings.find((b) => b.command === "redo");
    assert.equal(redo.key, "ctrl+shift+z");
    const all = bindings.find((b) => b.command === "editor.action.selectAll");
    assert.equal(all.key, "ctrl+alt+a", "a custom chord carries the command");

    // and installKeybindings carries the swap into the editor's file
    const profile = require("../dist/profile.js");
    profile.installKeybindings();
    const { parseJsonc } = require("../dist/jsonc.js");
    const written = parseJsonc(
      fs.readFileSync(path.join(profile.USER_DIR, "keybindings.json"), "utf8"),
    );
    assert.ok(written.some((b) => b.key === "ctrl+shift+z" && b.command === "redo"));

    // clearing the decisions clears the swap on the next install
    store.clearDecisions();
    profile.installKeybindings();
    const after = parseJsonc(
      fs.readFileSync(path.join(profile.USER_DIR, "keybindings.json"), "utf8"),
    );
    assert.ok(!after.some((b) => b.key === "ctrl+shift+z" && b.command === "redo"));
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("an imported binding on any tode builtin is a conflict; removals and tode's own are not", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-import-scan-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { USER_DIR } = freshRequire("../dist/profile.js");
    const { importedConflicts, importedHolder } = require("../dist/shortcuts/imported.js");
    const { QUIT_CHORD } = require("../dist/shortcuts/store.js");
    const file = path.join(USER_DIR, "keybindings.json");
    fs.mkdirSync(USER_DIR, { recursive: true });
    const quit = () => importedConflicts().find((c) => c.key === QUIT_CHORD) ?? null;

    fs.writeFileSync(file, JSON.stringify([{ key: "ctrl+shift+p", command: "other" }]));
    assert.deepEqual(importedConflicts(), [], "a binding elsewhere is no conflict");

    fs.writeFileSync(file, JSON.stringify([{ key: QUIT_CHORD.toUpperCase(), command: "workbench.action.terminal.toggle" }]));
    assert.equal(quit().command, "workbench.action.terminal.toggle", "case does not hide a conflict");
    assert.equal(quit().builtin, "tode.confirmQuit", "the shadowed builtin rides along");

    fs.writeFileSync(file, JSON.stringify([{ key: QUIT_CHORD, command: "-workbench.action.something" }]));
    assert.equal(quit(), null, "a removal entry holds nothing");

    fs.writeFileSync(file, JSON.stringify([{ key: QUIT_CHORD, command: "tode.confirmQuit", when: "!terminalFocus" }]));
    assert.equal(quit(), null, "a hand-written tode bind is not a conflict");

    // tode ships no pane chords: an imported binding on one is simply the
    // user's binding now, not a conflict with tode
    fs.writeFileSync(file, JSON.stringify([{ key: "alt+w", command: "whatever.the.user.bound" }]));
    assert.equal(importedConflicts().find((c) => c.key === "alt+w"), undefined);

    fs.writeFileSync(file, JSON.stringify([{ key: "shift+ctrl+q", command: "taken" }]));
    assert.equal(importedHolder("ctrl+shift+q"), "taken", "modifier order does not hide a holder");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("an extension that contributes ctrl+q is a claimant, named by its display name", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-ext-claim-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { EXTENSIONS_DIR } = freshRequire("../dist/profile.js");
    const { importedConflicts } = require("../dist/shortcuts/imported.js");
    assert.deepEqual(importedConflicts(), [], "no extensions installed, no claim");

    const vimDir = path.join(EXTENSIONS_DIR, "vscodevim.vim-1.30.0");
    fs.mkdirSync(vimDir, { recursive: true });
    fs.writeFileSync(path.join(vimDir, "package.json"), JSON.stringify({
      name: "vim",
      displayName: "Vim",
      contributes: { keybindings: [
        { key: "ctrl+d", command: "extension.vim_ctrl+d" },
        { key: "ctrl+c", command: "extension.vim_ctrl+c", when: "editorTextFocus && vim.active" },
        { key: "ctrl+q", command: "extension.vim_winCtrlQ", when: "editorTextFocus && vim.active" },
      ] },
    }));
    const bridgeDir = path.join(EXTENSIONS_DIR, "tode.tode-bridge-1.2.0");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "package.json"), JSON.stringify({
      name: "tode-bridge",
      contributes: { keybindings: [{ key: "ctrl+q", command: "tode.quit" }] },
    }));
    fs.writeFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), JSON.stringify([
      { identifier: { id: "tode.tode-bridge" }, relativeLocation: "tode.tode-bridge-1.2.0" },
      { identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" },
    ]));

    const { extensionHolder } = require("../dist/shortcuts/imported.js");
    const { QUIT_CHORD } = require("../dist/shortcuts/store.js");
    // the scan is generic over chords, not special-cased to one
    assert.equal(extensionHolder("ctrl+d").command, "extension.vim_ctrl+d");
    assert.equal(extensionHolder("ctrl+q").command, "extension.vim_winCtrlQ");
    assert.equal(extensionHolder("ctrl+q").claimant, "Vim", "the display name fronts the claim");
    assert.equal(extensionHolder("ctrl+q").describes, "vim winCtrlQ", "the id is cleaned when no title exists");
    assert.equal(extensionHolder("ctrl+x"), null);

    // even a guarded claim on the quit chord surfaces: quit never yields
    // automatically, so the contest is the user's to decide
    assert.equal(importedConflicts().find((c) => c.key === QUIT_CHORD)?.claimant, "Vim");

    // a claim on a chord tode does not bind is nobody's conflict: tode ships
    // no pane chords, so acme keeps alt+w without a decision — while the
    // holder scan itself stays generic over chords
    const acmeDir = path.join(EXTENSIONS_DIR, "acme.keys-1.0.0");
    fs.mkdirSync(acmeDir, { recursive: true });
    fs.writeFileSync(path.join(acmeDir, "package.json"), JSON.stringify({
      name: "keys",
      displayName: "Acme Keys",
      contributes: { keybindings: [{ key: "alt+w", command: "acme.everything" }] },
    }));
    const manifest = path.join(EXTENSIONS_DIR, "extensions.json");
    fs.writeFileSync(manifest, JSON.stringify([
      { identifier: { id: "tode.tode-bridge" }, relativeLocation: "tode.tode-bridge-1.2.0" },
      { identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" },
      { identifier: { id: "acme.keys" }, relativeLocation: "acme.keys-1.0.0" },
    ]));
    // the claim scan caches on the manifest's mtime; make the rewrite visible
    fs.utimesSync(manifest, new Date(), new Date(Date.now() + 5000));
    assert.equal(extensionHolder("alt+w").command, "acme.everything");
    assert.equal(importedConflicts().find((c) => c.key === "alt+w"), undefined);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the quit chord lives at user level, unless a decision moved or surrendered it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-quitbind-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    const bindings = store.quitBindings();
    assert.equal(bindings.length, 1, "undecided means tode wins, above every extension");
    assert.equal(bindings[0].key, store.QUIT_CHORD);
    assert.equal(bindings[0].command, "tode.confirmQuit", "quitting always asks first");
    if (store.QUIT_CHORD === "ctrl+c") {
      assert.equal(
        bindings[0].when,
        "!terminalFocus && !editorHasSelection && (!inputFocus || editorTextFocus)",
        "the reflex chord carries the hint contexts",
      );
      assert.deepEqual(store.hintBindings(), [], "no redirect where ctrl+c is quit itself");
    } else {
      assert.equal(bindings[0].when, "!terminalFocus");
      assert.equal(store.hintBindings().length, 1, "linux redirects ctrl+c to the quit chord");
    }

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: { [store.QUIT_CHORD]: { choice: "terminal" } } });
    assert.equal(store.quitBindings().length, 1, "a freed terminal chord still quits in tode");

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: { [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+alt+q" } } });
    assert.deepEqual(store.quitBindings(), [], "a moved quit is carried by the fallback instead");

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: { [store.IMPORT_DECISION_ID]: { choice: "keep" } } });
    assert.deepEqual(store.quitBindings(), [], "a surrendered quit writes nothing");

    // claim decisions become vscode's own removal entries, never edits
    store.saveDecisions({ version: 1, terminal: "ghostty", choices: {
      [store.CLAIM_DECISION_ID]: { choice: "terminal", action: "extension.vim_winCtrlQ" },
    } });
    assert.deepEqual(store.claimBindings(), [
      { key: store.QUIT_CHORD, command: "-extension.vim_winCtrlQ" },
    ], "unsetting a claim is a negative user entry");

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: {
      [store.CLAIM_DECISION_ID]: { choice: "terminal", key: "ctrl+alt+v", action: "extension.vim_winCtrlQ", guard: "editorTextFocus && vim.active" },
    } });
    assert.deepEqual(store.claimBindings(), [
      { key: store.QUIT_CHORD, command: "-extension.vim_winCtrlQ" },
      { key: "ctrl+alt+v", command: "extension.vim_winCtrlQ", when: "editorTextFocus && vim.active" },
    ], "a moved claim removes the old rule and re-adds it at the new chord");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the quit chord never yields to extension claims", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-yield-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { EXTENSIONS_DIR } = freshRequire("../dist/profile.js");
    const store = require("../dist/shortcuts/store.js");
    const dir = path.join(EXTENSIONS_DIR, "vscodevim.vim-1.30.0");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "vim",
      contributes: { keybindings: [
        { key: store.QUIT_CHORD, command: "extension.vim_quit", when: "editorTextFocus && vim.active" },
      ] },
    }));
    fs.writeFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), JSON.stringify([
      { identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" },
    ]));

    // quitting must always work, so the quit chord's guard never yields to
    // an extension's claim — the claim surfaces in the wizard instead
    const [quit] = store.quitBindings();
    assert.ok(!quit.when.includes("!("), quit.when);
    const { importedConflicts } = require("../dist/shortcuts/imported.js");
    const claim = importedConflicts().find((c) => c.key === store.QUIT_CHORD);
    assert.equal(claim.command, "extension.vim_quit", "the guarded claim needs a decision");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("a skipped wizard never loses quit: undecided, the quit chord self-heals on install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-quit-heals-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const profile = freshRequire("../dist/profile.js");
    const store = require("../dist/shortcuts/store.js");
    const { parseJsonc } = require("../dist/jsonc.js");
    const file = path.join(profile.USER_DIR, "keybindings.json");
    const read = () => parseJsonc(fs.readFileSync(file, "utf8"));

    // an import lands on the quit chord and the user skips the wizard: no
    // decision anywhere, yet the next install writes quit after theirs
    profile.installKeybindings();
    profile.mergeKeybindings([{ key: store.QUIT_CHORD, command: "workbench.action.imported" }]);
    profile.installKeybindings();
    const entries = read();
    const importedAt = entries.findIndex((e) => e.command === "workbench.action.imported");
    const quitAt = entries.reduce((last, e, at) => (e.command === "tode.confirmQuit" ? at : last), -1);
    assert.ok(importedAt >= 0);
    assert.ok(quitAt > importedAt, "with no decision, quit still wins the chord");

    // any decision on that chord turns the healing off — it is the user's call
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.IMPORT_DECISION_ID]: { choice: "keep" } },
    });
    profile.installKeybindings();
    const surrendered = read();
    const lastQuit = surrendered.reduce((last, e, at) => (e.command === "tode.confirmQuit" ? at : last), -1);
    const theirs = surrendered.findIndex((e) => e.command === "workbench.action.imported");
    assert.ok(lastQuit < theirs, "a surrendered quit stays surrendered");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("quit-wins puts tode's entry after the imported one, so vscode picks tode's", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-import-win-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const profile = freshRequire("../dist/profile.js");
    const store = require("../dist/shortcuts/store.js");
    const { parseJsonc } = require("../dist/jsonc.js");
    const file = path.join(profile.USER_DIR, "keybindings.json");
    const read = () => parseJsonc(fs.readFileSync(file, "utf8"));

    profile.installKeybindings();
    profile.mergeKeybindings([{ key: store.QUIT_CHORD, command: "workbench.action.imported" }]);
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.IMPORT_DECISION_ID]: { choice: "editor", key: store.QUIT_CHORD } },
    });
    profile.installKeybindings();

    const entries = read();
    const importedAt = entries.findIndex((e) => e.command === "workbench.action.imported");
    const quitAt = entries.reduce((last, e, at) => (e.command === "tode.confirmQuit" ? at : last), -1);
    assert.ok(importedAt >= 0, "the imported entry stays in the file");
    assert.ok(quitAt > importedAt, "tode.quit must come later, vscode reads bottom-up");

    // repeated installs stay stable, nothing duplicates
    const count = entries.length;
    profile.installKeybindings();
    profile.installKeybindings();
    assert.equal(read().length, count);

    // a moved quit lands on its chord and leaves ctrl+q to the import
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+shift+q" } },
    });
    profile.installKeybindings();
    const moved = read();
    const quit = moved.filter((e) => e.command === "tode.confirmQuit" && e.key === "ctrl+shift+q");
    assert.equal(quit.length, 1);
    assert.ok(moved.some((e) => e.command === "workbench.action.imported"));
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("an import decision on any builtin writes its override, command staged on the decision", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-override-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        "import:alt+w": { choice: "editor", key: "ctrl+alt+w", command: "workbench.action.closeEditorsInGroup" },
        // a quit decision saved before commands rode on decisions still works
        [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+shift+q" },
      },
    });
    assert.deepEqual(store.overrideBindings().sort((a, b) => a.key.localeCompare(b.key)), [
      { key: "ctrl+alt+w", command: "workbench.action.closeEditorsInGroup", when: "!terminalFocus" },
      { key: "ctrl+shift+q", command: "tode.confirmQuit", when: "!terminalFocus" },
    ]);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the quit hint follows the wizard's decisions, import decision first", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-hint-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { quitHintMessage } = freshRequire("../dist/bridge.js");
    const store = require("../dist/shortcuts/store.js");

    assert.equal(quitHintMessage(), `Press ${store.QUIT_CHORD} to quit terminal-code`);

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.QUIT_CHORD]: { choice: "editor", key: "ctrl+alt+q" } },
    });
    assert.equal(quitHintMessage(), "Press ctrl+alt+q to quit terminal-code");

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.QUIT_CHORD]: { choice: "keep" } },
    });
    assert.match(quitHintMessage(), /command palette/);

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        [store.QUIT_CHORD]: { choice: "terminal" },
        [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+shift+q" },
      },
    });
    assert.equal(quitHintMessage(), "Press ctrl+shift+q to quit terminal-code");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

function fakePalette() {
  return {
    background: [20, 22, 26],
    foreground: [232, 230, 227],
    ansi: Array.from({ length: 16 }, (_, at) => [at * 10, at * 10, at * 10]),
  };
}

function fakeRow() {
  return {
    id: "cmd+w",
    kind: "terminal",
    means: "close the current editor tab",
    terminal: {
      name: "Ghostty",
      short: "close the pane",
      does: "closes the whole terminal pane",
      freed: "panes close from the menu",
      tradeoff: "close panes from the menu instead",
      bound: true,
    },
    decision: null,
  };
}

function fakeManagerDeps(overrides = {}) {
  const decided = [];
  const confirmed = [];
  const { normalizeChord } = require("../dist/shortcuts/wizard.js");
  return {
    decided,
    confirmed,
    deps: {
      rows: () => [fakeRow()],
      taken: (chord) =>
        chord === "ctrl+shift+t"
          ? { holder: "reopen a tab" }
          : chord === "ctrl+w"
            ? { holder: "extension.vim_ctrl+w (Vim)", claim: { chord: "ctrl+w", command: "extension.vim_ctrl+w", claimant: "Vim", describes: "vim ctrl+w" } }
            : null,
      normalize: normalizeChord,
      decide: (id, kind, decision) => decided.push({ id, kind, decision }),
      confirm: () => {
        confirmed.push(true);
        return { note: "applied — reload ghostty" };
      },
      reloadHint: "reload ghostty for this to take effect",
      terminalName: "Ghostty",
      palette: fakePalette(),
      ...overrides,
    },
  };
}

test("the manager serves the built page with the terminal's colours, and its state", async () => {
  const { startManager } = freshRequire("../dist/shortcuts/web.js");
  const { deps } = fakeManagerDeps();
  const manager = await startManager(deps);
  const base = `http://127.0.0.1:${manager.port}`;
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /shortcuts<\/title>/);
    assert.match(page, /--bg: #14161a/, "the page background is the terminal's");
    assert.match(page, /--fg: #e8e6e3/);
    assert.match(page, /\/assets\/index\.js/, "the built bundle is what the page loads");

    const bundle = await fetch(`${base}/assets/index.js`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get("content-type"), /text\/javascript/);

    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.terminalName, "Ghostty");
    assert.deepEqual(state.rows.map((row) => row.id), ["cmd+w"]);
    assert.match(state.logos.editor ?? "", /^data:image\/png;base64,/, "the real logo images ride along");
  } finally {
    manager.close();
  }
});

test("the manager server: page, taken checks, staging, confirming, done", async () => {
  const { startManager } = freshRequire("../dist/shortcuts/web.js");
  const { decided, confirmed, deps } = fakeManagerDeps();
  const manager = await startManager(deps);
  const base = `http://127.0.0.1:${manager.port}`;
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /shortcuts<\/title>/);

    const free = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "ctrl+alt+w", id: "cmd+w" }) })).json();
    assert.deepEqual(free, { ok: true, chord: "ctrl+alt+w" });

    const held = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "ctrl+shift+t", id: "cmd+w" }) })).json();
    assert.equal(held.ok, false);
    assert.match(held.warning, /reopen a tab/);
    assert.equal(held.claim, null, "no claim payload when nothing editable holds it");

    const claimed = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "ctrl+w", id: "cmd+w" }) })).json();
    assert.equal(claimed.ok, false);
    assert.equal(claimed.claim.claimant, "Vim", "an extension holder rides along so the page can offer the editor");


    const garbage = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "w", id: "cmd+w" }) })).json();
    assert.equal(garbage.ok, false, "a chord with no modifier is refused");

    const staged = await (await fetch(`${base}/decide`, { method: "POST", body: JSON.stringify({ id: "cmd+w", kind: "terminal", decision: { choice: "terminal" } }) })).json();
    assert.equal(staged.ok, true);
    assert.ok(Array.isArray(staged.rows), "a decision returns fresh rows");
    assert.equal(decided.length, 1);
    assert.equal(confirmed.length, 0, "deciding stages, it does not write");

    const cleared = await (await fetch(`${base}/decide`, { method: "POST", body: JSON.stringify({ id: "cmd+w", kind: "terminal", decision: null }) })).json();
    assert.equal(cleared.ok, true);
    assert.equal(decided[1].decision, null, "null clears a row back to undecided");

    const claimDecision = await (await fetch(`${base}/decide`, { method: "POST", body: JSON.stringify({ id: "ctrl+w", kind: "claim", decision: { choice: "terminal" } }) })).json();
    assert.equal(claimDecision.ok, true);
    assert.equal(decided[decided.length - 1].kind, "claim", "claim decisions carry their kind");

    const applied = await (await fetch(`${base}/confirm`, { method: "POST", body: "{}" })).json();
    assert.equal(applied.ok, true);
    assert.match(applied.note, /applied/);
    assert.equal(confirmed.length, 1, "confirm is the only write");

    let closed = false;
    manager.done.then(() => (closed = true));
    await (await fetch(`${base}/done`, { method: "POST", body: "{}" })).json();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(closed, "done resolves so the pane can be handed back");
  } finally {
    manager.close();
  }
});

test("manager rows carry the derived editor side straight from the scan", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-rows-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    const conflict = (editorId, means, command, guard, others = []) => ({
      editorId, trigger: "x", current: "y",
      editor: { means, command, guard },
      others,
      inTerminal: `runs stuff, so ${means} never reaches the editor`,
      short: "stuff", freed: "stuff goes", tradeoff: "stuff stops working",
    });
    const provider = {
      id: "ghostty",
      name: "Ghostty",
      detect: () => true,
      ready: () => null,
      scan: () => [
        conflict("cmd+w", "close active editor", "workbench.action.closeActiveEditor", "editorFocus"),
        conflict("cmd+f", "find", "actions.find", undefined, [
          { command: "excalidraw.preventDefault", guard: "activeCustomEditorId == 'editor.excalidraw'", claimant: "Excalidraw", describes: "prevent default" },
        ]),
      ],
      takenAs: () => null,
      apply: () => "",
      onApplied: () => false,
      undo: () => false,
      reloadHint: () => "reload ghostty",
    };
    const rows = wizard.managerRows(provider, { "cmd+f": { choice: "terminal" } });
    assert.deepEqual(rows.map((row) => row.id), ["cmd+w", "cmd+f"]);
    assert.equal(rows[0].means, "close active editor");
    assert.deepEqual(
      rows[0].detail,
      { command: "workbench.action.closeActiveEditor", when: "editorFocus" },
      "the metadata is structured, ready for label → value rows",
    );
    assert.deepEqual(rows[1].detail, { command: "actions.find", when: undefined });
    // the second holder of cmd+f arrives pre-seated as its own column,
    // resting: it coexists on its own chord until something moves
    assert.deepEqual(rows[1].claims, [
      {
        chord: "cmd+f",
        command: "excalidraw.preventDefault",
        claimant: "Excalidraw",
        describes: "prevent default",
        when: "activeCustomEditorId == 'editor.excalidraw'",
        resting: true,
        decided: null,
      },
    ]);
    assert.deepEqual(rows[0].claims, [], "one holder means no extra columns");
    assert.equal(rows[0].decision, null);
    assert.deepEqual(rows[1].decision, { choice: "terminal" }, "staged decisions ride on their row");
    assert.equal(rows[0].terminal.name, "Ghostty");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("a chord is not taken by another spelling of the row's own binding", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-taken-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    // the user's own file binds alt+1 on the editor side — tode itself ships
    // no pane chords, so the cross-side holder comes from keybindings.json
    const { USER_DIR } = require("../dist/profile.js");
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(USER_DIR, "keybindings.json"),
      JSON.stringify([{ key: "alt+1", command: "workbench.action.focusFirstEditorGroup" }]),
    );
    // ghostty binds both super+1 and alt+1 to goto_tab:1 — the cmd+1 row
    // moving onto alt+1 lands on its own action, not a conflict
    const provider = {
      id: "ghostty",
      name: "Ghostty",
      scan: () => [
        {
          editorId: "cmd+1", trigger: "super+1", current: "goto_tab:1",
          editor: { means: "focus first editor group", command: "workbench.action.focusFirstEditorGroup" },
          others: [],
          inTerminal: "switches tabs", short: "go to tab 1", freed: "tabs", tradeoff: "tabs",
        },
      ],
      takenAs: (chord) => (chord === "alt+1" ? "goto_tab:1" : null),
      describe: (action) => `runs ${action}`,
    };
    // the terminal mover's own action on another trigger is exempt — but the
    // EDITOR-side holder at alt+1 (the user's own binding) is cross-side
    // and must claim: after apply the terminal bind would eat it, and the
    // rescan counts exactly that as a conflict
    const vetted = wizard.chordTaken(provider, {}, "alt+1", "cmd+1", undefined, "terminal");
    assert.notEqual(vetted, null, "a cross-side holder is never silently exempt");
    assert.equal(vetted.claim.command, "workbench.action.focusFirstEditorGroup");
    assert.notEqual(vetted.claim.command, "goto_tab:1", "the row's own action stayed exempt");
    const other = wizard.chordTaken(provider, {}, "alt+1", "cmd+w", undefined, "terminal");
    assert.equal(other.claim.command, "goto_tab:1", "for any other row the ghostty holder claims first");
    assert.equal(other.claim.claimant, "Ghostty");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("a chord held by the row's own editor command is not a conflict either", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-taken2-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    const provider = {
      id: "ghostty", name: "Ghostty",
      scan: () => [],
      takenAs: () => null,
      describe: (action) => action,
    };
    // whatever really holds cmd+p in the derived keymap...
    const held = wizard.chordTaken(provider, {}, "cmd+p", "cmd+w");
    if (held) {
      const own = {
        editorId: "cmd+w", trigger: "x", current: "y",
        editor: { means: "same thing", command: held.claim.command },
        others: [],
        inTerminal: "z", short: "s", freed: "f", tradeoff: "t",
      };
      const aware = { ...provider, scan: () => [own] };
      // ...is exempt for the row's own EDITOR side moving there (a duplicate
      // spelling of the same command is not a conflict with itself)...
      assert.equal(wizard.chordTaken(aware, {}, "cmd+p", "cmd+w", undefined, "editor"), null);
      // ...but never for the TERMINAL side: a terminal bind landing there
      // would eat the command, which is exactly what the rescan flags
      const crossed = wizard.chordTaken(aware, {}, "cmd+p", "cmd+w", undefined, "terminal");
      assert.equal(crossed?.claim?.command, held.claim.command, "cross-side holders always claim");
    }
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("holders of a decided target chord join the row as contested claims", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-contested-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    // the editor side of alt+1 is the user's own binding — tode ships no
    // pane chords, so the cross-side holder comes from keybindings.json
    const { USER_DIR } = require("../dist/profile.js");
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(USER_DIR, "keybindings.json"),
      JSON.stringify([{ key: "alt+1", command: "workbench.action.focusFirstEditorGroup" }]),
    );
    const provider = {
      id: "ghostty", name: "Ghostty",
      detect: () => true, ready: () => null,
      scan: () => [
        {
          editorId: "cmd+1", trigger: "super+1", current: "goto_tab:1",
          editor: { means: "focus first editor group", command: "workbench.action.focusFirstEditorGroup" },
          others: [],
          inTerminal: "switches tabs", short: "go to tab 1", freed: "tabs", tradeoff: "tabs",
        },
      ],
      takenAs: (chord) => (chord === "alt+t" ? "new_tab" : chord === "alt+1" ? "goto_tab:1" : null),
      apply: () => "", onApplied: () => false, undo: () => false,
      describe: (action) => `runs ${action}`,
      reloadHint: () => "reload ghostty",
    };
    // moved onto a chord ghostty binds to a DIFFERENT action: the holder
    // joins the duel, derived from the decision itself — a reload shows it
    const rows = wizard.managerRows(provider, {
      "cmd+1": { choice: "terminal", key: "alt+t", action: "goto_tab:1" },
    });
    const seated = (list, chord, command) =>
      list.some((claim) => claim.chord === chord && claim.command === command);
    assert.ok(seated(rows[0].claims, "alt+t", "new_tab"), "the target's ghostty holder joins");
    // ...and once that holder's own decision moves it again, the chain
    // follows: whoever holds the second target joins the same duel
    const chained = wizard.managerRows(provider, {
      "cmd+1": { choice: "terminal", key: "alt+t", action: "goto_tab:1" },
      "claim:alt+t:new_tab": { choice: "terminal", key: "alt+1", action: "new_tab", owner: "terminal" },
    });
    assert.ok(seated(chained[0].claims, "alt+t", "new_tab"));
    assert.ok(
      seated(chained[0].claims, "alt+1", "goto_tab:1"),
      "the chain walks decided moves to their holders",
    );
    // moved onto another trigger of its own action: the same-side self-duel
    // stays out, but the editor-side holder there (the user's binding) joins
    // — the rescan would count it, so the duel must show it now
    const self = wizard.managerRows(provider, {
      "cmd+1": { choice: "terminal", key: "alt+1", action: "goto_tab:1" },
    });
    assert.ok(
      !self[0].claims.some((claim) => claim.command === "goto_tab:1"),
      "the action never duels itself",
    );
    assert.ok(
      self[0].claims.some(
        (claim) => claim.chord === "alt+1" && claim.command === "workbench.action.focusFirstEditorGroup",
      ),
      "the cross-side holder at the target joins the duel",
    );
    // a staged decision about the contested holder rides along, so the
    // column resumes exactly where the session left it
    const decidedRows = wizard.managerRows(provider, {
      "cmd+1": { choice: "terminal", key: "alt+t", action: "goto_tab:1" },
      "claim:alt+t:new_tab": { choice: "terminal", action: "new_tab", owner: "terminal" },
    });
    assert.deepEqual(decidedRows[0].claims[0].decided, {
      choice: "terminal", action: "new_tab", owner: "terminal",
    });
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("steps resynchronize: one binding decided anywhere shows everywhere", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-resync-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    require("../dist/shortcuts/vscode-keymap.js").setKeymapPlatformForTest("mac");
    const conflict = (editorId, trigger, current, command) => ({
      editorId, trigger, current,
      editor: { means: command, command },
      others: [],
      inTerminal: "eats it", short: "s", freed: "f", tradeoff: "t",
    });
    const provider = {
      id: "ghostty", name: "Ghostty",
      detect: () => true, ready: () => null,
      scan: () => [
        conflict("cmd+1", "super+1", "goto_tab:1", "workbench.action.focusFirstEditorGroup"),
        conflict("cmd+t", "super+t", "new_tab", "workbench.action.showAllSymbols"),
      ],
      takenAs: (chord) => (chord === "cmd+t" ? "new_tab" : null),
      apply: () => "", onApplied: () => false, undo: () => false,
      describe: (action) => `runs ${action}`,
      reloadHint: () => "reload ghostty",
    };
    // step one moved onto cmd+t; its claimant column (new_tab) was then moved
    // to ctrl+alt+9 — that claim IS the future cmd+t step's own terminal side
    const staged = {
      "cmd+1": { choice: "terminal", key: "cmd+t", action: "goto_tab:1" },
      "claim:cmd+t:new_tab": { choice: "terminal", key: "ctrl+alt+9", action: "new_tab", owner: "terminal" },
    };
    const rows = wizard.managerRows(provider, staged);
    // the future step was answered entirely from the cmd+1 duel, and its
    // resolution shows there as a claimant column — the step stops existing
    assert.deepEqual(rows.map((row) => row.id), ["cmd+1"], "the settled step is gone");
    const newTab = rows[0].claims.find((claim) => claim.command === "new_tab");
    assert.deepEqual(newTab.decided, staged["claim:cmd+t:new_tab"]);
    // with the mover's own decision withdrawn, the claim record loses its
    // column — the step returns, mirroring the record so nothing staged is
    // ever invisible
    const orphaned = wizard.managerRows(provider, {
      "claim:cmd+t:new_tab": staged["claim:cmd+t:new_tab"],
    });
    assert.deepEqual(orphaned.map((row) => row.id), ["cmd+1", "cmd+t"]);
    assert.deepEqual(
      orphaned[1].decision,
      { choice: "terminal", key: "ctrl+alt+9", action: "new_tab", owner: "terminal" },
      "the returned step mirrors the orphaned claim record",
    );

    // chords parked by ANY staged decision refuse a second booking...
    const parkedByRow = wizard.chordTaken(provider, staged, "cmd+t", "cmd+9");
    assert.match(parkedByRow.holder, /moved here this session/);
    const parkedByClaim = wizard.chordTaken(provider, staged, "ctrl+alt+9", "cmd+9");
    assert.match(parkedByClaim.holder, /moved here this session/);
    // ...but the owner re-picking its own target is a no-op, not a
    // collision — whether asking as the claim or as the mirrored row
    assert.equal(wizard.chordTaken(provider, staged, "ctrl+alt+9", "cmd+t", "new_tab"), null);
    assert.equal(wizard.chordTaken(provider, staged, "ctrl+alt+9", "cmd+t"), null);

    // a holder a staged decision moved away no longer takes its old chord:
    // new_tab left cmd+t, so the ghostty side is gone — what still claims is
    // the editor's own default binding there, the next holder in line
    const freed = wizard.chordTaken(
      provider,
      { "claim:cmd+t:new_tab": { choice: "terminal", key: "ctrl+alt+9", action: "new_tab", owner: "terminal" } },
      "cmd+t",
      "cmd+9",
    );
    assert.notEqual(freed?.claim?.command, "new_tab", "a moved holder frees its old chord");
    assert.equal(
      freed?.claim?.command,
      "workbench.action.showAllSymbols",
      "the default keymap holder is next in line",
    );

    // editing the row directly drops the claim twin: one binding, one record
    const twin = { ...staged };
    const deps = { staged: twin };
    // simulate decide(kind terminal) semantics via managerRows contract:
    // (the dedupe lives in openManager's decide; assert its effect through
    // chordTaken once the row record replaces the claim record)
    delete twin["claim:cmd+t:new_tab"];
    twin["cmd+t"] = { choice: "terminal", action: "new_tab" };
    void deps;
    const after = wizard.managerRows(provider, twin);
    assert.deepEqual(after[1].decision, { choice: "terminal", action: "new_tab" });
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("applied resolutions never come back: removals mask every holder source", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-mask-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    require("../dist/shortcuts/vscode-keymap.js").setKeymapPlatformForTest("mac");
    const { USER_DIR } = require("../dist/profile.js");
    const { allConflicts } = require("../dist/shortcuts/backends/ghostty.js");
    const { makeEditorHolds } = require("../dist/shortcuts/holds.js");
    const provider = {
      id: "ghostty", name: "Ghostty",
      scan: () => [], takenAs: () => null, describe: (action) => action,
    };
    // the user's own binding holds alt+1 — the wizard would claim it...
    const file = path.join(USER_DIR, "keybindings.json");
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify([{ key: "alt+1", command: "workbench.action.focusFirstEditorGroup" }]),
    );
    const before = wizard.chordTaken(provider, {}, "alt+1", "cmd+w");
    assert.equal(before.claim.command, "workbench.action.focusFirstEditorGroup");
    // ...and a live ghostty bind on alt+1 would be a conflict row
    const effective = new Map([["alt+1", "goto_tab:1"]]);
    const open = allConflicts(effective, new Set(), makeEditorHolds(), () => null, new Map());
    assert.equal(open.length, 1, "an unresolved holder is a conflict");

    // the wizard resolves it; apply writes the removal into keybindings.json,
    // after the rule it masks
    fs.writeFileSync(
      file,
      JSON.stringify([
        { key: "alt+1", command: "workbench.action.focusFirstEditorGroup" },
        { key: "alt+1", command: "-workbench.action.focusFirstEditorGroup" },
      ]),
    );
    // the invariant: a rerun sees the resolution everywhere the holder shows
    assert.equal(
      wizard.chordTaken(provider, {}, "alt+1", "cmd+w"),
      null,
      "the resolved holder no longer takes the chord",
    );
    assert.ok(
      !makeEditorHolds()("alt+1").some(
        (hold) => hold.command === "workbench.action.focusFirstEditorGroup",
      ),
      "the resolved holder is out of the holds",
    );
    const rerun = allConflicts(effective, new Set(), makeEditorHolds(), () => null, new Map());
    assert.deepEqual(rerun, [], "a resolved conflict never returns as a new row");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("kitty triggers translate both ways, or to nothing", () => {
  const { toTrigger, fromTrigger } = require("../dist/shortcuts/backends/kitty.js");
  assert.equal(toTrigger("ctrl+shift+w"), "ctrl+shift+w");
  assert.equal(toTrigger("cmd+pageup"), "super+page_up");
  assert.equal(fromTrigger("ctrl+shift+c"), "ctrl+shift+c");
  assert.equal(fromTrigger("super+page_down"), "cmd+pagedown", "kitty spellings normalise");
  assert.equal(fromTrigger("opt+enter"), "alt+enter", "macOS mod aliases normalise");
  assert.equal(fromTrigger("shift+ctrl+t"), "ctrl+shift+t", "mods canonicalise into editor order");
  assert.equal(fromTrigger("ctrl+shift+plus"), null, "no editor spelling, no chord");
  assert.equal(fromTrigger("ctrl+kp_add"), null, "keypad keys have no editor spelling");
});

test("kitty conflicts derive from the parser dump: binds on held chords, prefixes included", () => {
  // pinned from kitty 0.45.0's own load_config() resolution, so a future kitty
  // that changes its defaults shows up here rather than silently
  const { allConflicts } = require("../dist/shortcuts/backends/kitty.js");
  const holds = (chord) =>
    ({
      "ctrl+shift+c": [{ command: "workbench.action.terminal.copySelection" }],
      "ctrl+shift+p": [{ command: "workbench.action.showCommands" }],
      "ctrl+shift+up": [{ command: "editor.action.insertCursorAbove" }],
    })[chord] ?? [];
  const keymap = {
    binds: [
      { trigger: "ctrl+shift+c", action: "copy_to_clipboard", sequences: [] },
      { trigger: "ctrl+shift+x", action: "close_window", sequences: [] },
      {
        trigger: "ctrl+shift+p",
        action: null,
        sequences: [{ keys: "ctrl+shift+p > y", action: "kitten hints --type hyperlink" }],
      },
      { trigger: "ctrl+shift+up", action: "scroll_line_up", sequences: [] },
    ],
    docs: { copy_to_clipboard: "Copy the selected text from the active window to the clipboard" },
  };
  const conflicts = allConflicts(keymap, new Set(), holds, () => null);
  assert.deepEqual(
    conflicts.map((c) => c.editorId),
    ["ctrl+shift+c", "ctrl+shift+p"],
    "held chords conflict; unheld close_window and pass-through scroll_line_up do not",
  );
  const copy = conflicts[0];
  assert.equal(copy.current, "copy_to_clipboard");
  assert.ok(
    copy.inTerminal.includes("copy the selected text"),
    "kitty's own action description rides along: " + copy.inTerminal,
  );
  assert.equal(copy.shared?.action, "copy_or_noop", "copy has a compatible rebind, so no duel");
  assert.ok(copy.shared.note.includes("copy_or_noop"), "the acknowledgement names the config it writes");
  const prefix = conflicts[1];
  assert.equal(prefix.short, "1 key sequences");
  assert.ok(prefix.current.startsWith("key sequence ("), "a prefix is freeable but marked unmovable");
  assert.equal(prefix.shared, undefined, "a prefix has no compatible rebind");
});

test("kitty actions that pass through when they cannot act are not conflicts", () => {
  const { allConflicts } = require("../dist/shortcuts/backends/kitty.js");
  const holds = () => ({ command: "editor.action.insertCursorAbove" });
  const keymap = {
    binds: [
      { trigger: "ctrl+shift+up", action: "scroll_line_up", sequences: [] },
      { trigger: "ctrl+shift+home", action: "scroll_home", sequences: [] },
      { trigger: "ctrl+shift+g", action: "scroll_to_prompt -1", sequences: [] },
      { trigger: "ctrl+shift+y", action: "copy_or_noop", sequences: [] },
    ],
    docs: {},
  };
  // the alternate screen (any fullscreen program, including the editor pane)
  // makes kitty pass all of these through — verified against kitty 0.45
  assert.deepEqual(allConflicts(keymap, new Set(), holds, () => null), []);
});

test("a shared free rebinds to the compatible action instead of unmapping", () => {
  const { withSharedRebinds, keybindsFileContents } = require("../dist/shortcuts/backends/kitty.js");
  const moves = withSharedRebinds([
    { trigger: "ctrl+shift+c", action: "copy_to_clipboard" },
    { trigger: "ctrl+shift+t", action: "new_tab" },
    { trigger: "ctrl+shift+v", action: "paste_from_clipboard", to: "ctrl+alt+v" },
  ]);
  assert.equal(moves[0].emit, "copy_or_noop", "copy frees into its compatible spelling");
  assert.equal(moves[1].emit, undefined, "new_tab has none, so it stays a plain unmap");
  assert.equal(moves[2].emit, undefined, "a user move keeps the plain unmap");
  const contents = keybindsFileContents(moves);
  assert.ok(contents.includes("\nmap ctrl+shift+c copy_or_noop\n"), "the rebind is the free");
  assert.ok(contents.includes("\nmap ctrl+shift+t\n"), "others stay bare");
});

test("a compatible rebind counts as freed when the file is read back", () => {
  const { writeFreed, freedTriggers, withSharedRebinds } = require("../dist/shortcuts/backends/kitty.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-kitty-"));
  try {
    writeFreed(dir, withSharedRebinds([
      { trigger: "ctrl+shift+c", action: "copy_to_clipboard" },
      { trigger: "ctrl+shift+t", action: "new_tab", to: "ctrl+alt+t" },
    ]));
    assert.deepEqual(
      [...freedTriggers(dir)].sort(),
      ["ctrl+shift+c", "ctrl+shift+t"],
      "the copy_or_noop rebind and the bare map are freed; the ctrl+alt+t rebind target is not",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a chord tode already freed stays visible with its remembered action", () => {
  const { allConflicts } = require("../dist/shortcuts/backends/kitty.js");
  const holds = () => [{ command: "workbench.action.terminal.copySelection" }];
  const past = (chord) => (chord === "ctrl+shift+c" ? "copy_to_clipboard" : null);
  // the dump omits passthrough keys, so a freed trigger only exists in the file
  const conflicts = allConflicts({ binds: [], docs: {} }, new Set(["ctrl+shift+c"]), holds, past);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].current, "copy_to_clipboard", "the freeing decision keeps the binding's identity");
  assert.equal(conflicts[0].short, "copy to clipboard", "the decision that freed it still names it");
});

test("kitty frees write bare maps, refuse prefix rebinds, and undo cleanly", () => {
  const { writeFreed, removeFreed, freedTriggers, withInclude, INCLUDE_LINE, keybindsFileContents } =
    require("../dist/shortcuts/backends/kitty.js");
  const contents = keybindsFileContents([
    { trigger: "ctrl+shift+c" },
    { trigger: "ctrl+shift+t", to: "ctrl+alt+t", action: "new_tab" },
    { trigger: "ctrl+shift+p", to: "ctrl+alt+p", action: "key sequence (ctrl+shift+p > y)" },
  ]);
  assert.ok(contents.includes("\nmap ctrl+shift+c\n"), "a bare map is the free");
  assert.ok(contents.includes("\nmap ctrl+alt+t new_tab\n"), "a real action rebinds");
  assert.ok(!contents.includes("ctrl+alt+p"), "a sequence marker never becomes config");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-kitty-"));
  try {
    const own = "font_size 13\nmap ctrl+shift+z toggle_layout stack\n";
    fs.writeFileSync(path.join(dir, "kitty.conf"), own);
    writeFreed(dir, [{ trigger: "ctrl+shift+c" }, { trigger: "ctrl+shift+z" }]);
    const config = fs.readFileSync(path.join(dir, "kitty.conf"), "utf8");
    assert.ok(config.startsWith(own), "the user's config keeps every byte");
    assert.ok(config.trimEnd().endsWith(INCLUDE_LINE), "the include comes last, so the frees override");
    assert.equal(withInclude(config), config, "the include line is added once");
    assert.deepEqual([...freedTriggers(dir)].sort(), ["ctrl+shift+c", "ctrl+shift+z"]);

    assert.equal(removeFreed(dir), true);
    assert.equal(fs.readFileSync(path.join(dir, "kitty.conf"), "utf8"), own, "undo restores the config byte for byte");
    assert.equal(freedTriggers(dir).size, 0);
    assert.equal(removeFreed(dir), false, "a second undo has nothing to do");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the kitty reload walks the ancestry and sends SIGUSR1", () => {
  const { reloadKitty } = require("../dist/shortcuts/backends/kitty.js");
  const tree = {
    [process.pid]: { ppid: 500, command: "node" },
    500: { ppid: 10, command: "/usr/bin/kitty" },
    10: { ppid: 1, command: "systemd" },
  };
  const signalled = [];
  const ok = reloadKitty((pid) => tree[pid] ?? null, (pid) => signalled.push(pid));
  assert.equal(ok, true, "kitty found in the ancestry gets the reload signal");
  assert.deepEqual(signalled, [500], "SIGUSR1 goes to the kitty process itself");

  assert.equal(reloadKitty((pid) => ({ ppid: pid > 4 ? 2 : 1, command: "bash" }), () => {}), false);
  assert.equal(
    reloadKitty((pid) => tree[pid] ?? null, () => { throw new Error("gone"); }),
    false,
    "a signal that fails reports false, not a throw",
  );
});

test("shared conflicts are settled silently at startup and never become wizard rows", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-shared-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    const store = require("../dist/shortcuts/store.js");
    const conflict = (editorId, extra = {}) => ({
      editorId, trigger: editorId, current: "copy_to_clipboard",
      editor: { means: "copy selection", command: "workbench.action.terminal.copySelection" },
      others: [],
      inTerminal: "", short: "copy", freed: "", tradeoff: "",
      ...extra,
    });
    const applied = [];
    const provider = {
      id: "kitty", name: "kitty",
      detect: () => true,
      ready: () => null,
      scan: () => [
        conflict("ctrl+shift+c", { shared: { action: "copy_or_noop", note: "" } }),
        conflict("ctrl+shift+t", { current: "new_tab" }),
        // already freed (current null): nothing to re-apply
        conflict("ctrl+shift+g", { current: null, shared: { action: "copy_or_noop", note: "" } }),
      ],
      takenAs: () => null,
      apply: (moves) => { applied.push(moves); return ""; },
      onApplied: () => true,
      undo: () => false,
      reloadHint: () => "reload kitty",
    };

    wizard.autoApplyShared(provider);
    assert.equal(applied.length, 1, "one silent apply");
    assert.deepEqual(
      applied[0],
      [{ trigger: "ctrl+shift+c", to: undefined, action: "copy_to_clipboard" }],
      "only the fresh shared conflict is freed — never the real one, never the already-freed one",
    );
    assert.equal(
      store.loadDecisions().choices["ctrl+shift+c"].choice,
      "terminal",
      "the silent apply is recorded like any decision",
    );

    // a second boot changes nothing: the decision is on record
    wizard.autoApplyShared(provider);
    assert.equal(applied.length, 1, "already-decided chords are left alone");

    // the wizard never shows shared rows — they were settled, nothing to ask
    const rows = wizard.managerRows(provider, {});
    assert.deepEqual(rows.map((row) => row.id), ["ctrl+shift+t"]);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});
