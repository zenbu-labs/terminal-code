const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { withFallbacks } = require("../dist/terminal/osc.js");
const { generateTheme } = require("../dist/theme/generate.js");
const { injectedCss } = require("../dist/codeserver/inject.js");

const GREY = withFallbacks({ background: [30, 32, 38], foreground: [220, 220, 230], ansi: new Array(16).fill(null) });

const PANE_SURFACES = [
  "editor.background",
  "sideBar.background",
  "activityBar.background",
  "statusBar.background",
  "titleBar.activeBackground",
  "panel.background",
  "editorGroupHeader.tabsBackground",
  "tab.inactiveBackground",
  "terminal.background",
  "minimap.background",
];

test("transparency clears every surface that covers the pane and nothing else changes", () => {
  const opaque = generateTheme(GREY);
  const clear = generateTheme(GREY, { transparent: true });
  for (const key of PANE_SURFACES) {
    assert.equal(clear.colors[key], "#00000000", key);
    assert.match(opaque.colors[key], /^#[0-9a-f]{6}$/i, `${key} stays opaque by default`);
  }
  // highlights become see-through tints rather than solid blocks
  assert.match(clear.colors["list.hoverBackground"], /^#[0-9a-f]{8}$/i);
  assert.match(clear.colors["tab.activeBackground"], /^#[0-9a-f]{8}$/i);
  // overlays keep an opaque surface so text on them stays readable
  for (const key of ["quickInput.background", "editorHoverWidget.background", "menu.background"]) {
    assert.equal(clear.colors[key], opaque.colors[key], key);
  }
  assert.deepEqual(clear.tokenColors, opaque.tokenColors);
  assert.deepEqual(generateTheme(GREY, {}), opaque, "no option means opaque");
});

test("the preload spells the ipc channel the window process listens on", () => {
  const preload = fs.readFileSync(path.resolve(__dirname, "..", "dist", "app", "preload.js"), "utf8");
  const { MESSAGE_CHANNEL } = require("../dist/app/messages.js");
  assert.ok(preload.includes(JSON.stringify(MESSAGE_CHANNEL)));
  // a sandboxed preload cannot load sibling modules
  assert.ok(!/require\("\.\//.test(preload), "the preload requires nothing but electron");
});

test("the injected stylesheet clears the workbench root only when asked", () => {
  const opaque = injectedCss("#1e2026", "JetBrains Mono");
  const clear = injectedCss("#1e2026", "JetBrains Mono", true);
  assert.ok(opaque.includes("html,body{background:#1e2026 !important;}"));
  assert.ok(!opaque.includes("background:transparent"));
  assert.ok(clear.includes("html,body{background:transparent !important;}"));
  assert.ok(clear.includes(".xterm-viewport"), "the terminal canvas is cleared too");
  assert.ok(clear.includes("JetBrains Mono"), "the font rules are unchanged");
});

test("the setting lives in the editor's settings.json and defaults to off", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-transparent-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  try {
    const profile = require("../dist/profile.js");
    const { parseJsonc } = require("../dist/jsonc.js");
    assert.equal(profile.transparencyEnabled(), false);
    assert.equal(profile.setTransparency(true), true);
    assert.equal(profile.transparencyEnabled(), true);
    assert.equal(parseJsonc(fs.readFileSync(profile.SETTINGS_FILE, "utf8"))["tode.transparent"], true);
    assert.equal(profile.setTransparency(true), false, "writing the same value again changes nothing");
    // the managed settings pass leaves the user's choice alone
    profile.installSettings();
    assert.equal(profile.transparencyEnabled(), true);
    // the theme on disk follows the setting, under its own fingerprint
    const on = profile.installTheme(GREY);
    const off = profile.installTheme(GREY, false);
    assert.notEqual(on.fingerprint, off.fingerprint);
    assert.ok(on.fingerprint.endsWith("-clear"));
    assert.equal(profile.setTransparency(false), true);
    assert.equal(profile.transparencyEnabled(), false);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the bridge manifest offers enable and disable, each only when it applies", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-bridge-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  try {
    const bridge = require("../dist/bridge.js");
    bridge.installBridge(["tode"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(bridge.BRIDGE_DIR, "package.json"), "utf8"));
    const commands = manifest.contributes.commands.map((c) => c.command);
    assert.ok(commands.includes("tode.enableTransparency"));
    assert.ok(commands.includes("tode.disableTransparency"));
    const palette = Object.fromEntries(manifest.contributes.menus.commandPalette.map((m) => [m.command, m.when]));
    assert.equal(palette["tode.enableTransparency"], "!tode.transparent");
    assert.equal(palette["tode.disableTransparency"], "tode.transparent");
    assert.equal(manifest.contributes.configuration.properties["tode.transparent"].default, false);
    const source = fs.readFileSync(path.join(bridge.BRIDGE_DIR, "extension.js"), "utf8");
    assert.ok(source.includes('"cmd":"transparency"') || source.includes('cmd: "transparency"'));
    assert.ok(source.includes("showInformationMessage"), "a change offers a reload");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});
