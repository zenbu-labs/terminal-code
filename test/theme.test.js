const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseColor, parseReplies, withFallbacks } = require("../dist/terminal/osc.js");
const { contrast, hex, isDark, parseHex } = require("../dist/theme/color.js");
const { generateTheme, semanticColors, paletteFingerprint } = require("../dist/theme/generate.js");
const { setKey, setKeys, readKey } = require("../dist/jsonc.js");

test("colour replies are scaled from whatever width the terminal used", () => {
  assert.deepEqual(parseColor("rgb:0000/0000/0000"), [0, 0, 0]);
  assert.deepEqual(parseColor("rgb:ffff/ffff/ffff"), [255, 255, 255]);
  assert.deepEqual(parseColor("rgb:ff/80/00"), [255, 128, 0]);
  assert.deepEqual(parseColor("rgb:ffff/8080/0000"), [255, 128, 0]);
  assert.equal(parseColor("nonsense"), null);
});

test("a full reply stream is unpicked into background, foreground and ansi", () => {
  const raw =
    "\x1b]11;rgb:0000/0000/0000\x07" +
    "\x1b]10;rgb:c8c8/cdcd/d7d7\x1b\\" +
    "\x1b]4;0;rgb:1a1a/1b1b/1e1e\x07" +
    "\x1b]4;9;rgb:ffff/6c6c/7070\x07" +
    "\x1b[?62;c";
  const parsed = parseReplies(raw);
  assert.deepEqual(parsed.background, [0, 0, 0]);
  assert.deepEqual(parsed.foreground, [200, 205, 215]);
  assert.deepEqual(parsed.ansi[0], [26, 27, 30]);
  assert.deepEqual(parsed.ansi[9], [255, 108, 112]);
  assert.equal(parsed.ansi[5], null);
});

test("slots the terminal did not answer fall back without losing the ones it did", () => {
  const palette = withFallbacks({ background: [0, 0, 0], foreground: null, ansi: new Array(16).fill(null) });
  assert.deepEqual(palette.background, [0, 0, 0]);
  assert.equal(palette.ansi.length, 16);
  assert.ok(palette.foreground);
});

/** a pure black terminal, which is what a default ghostty install looks like */
const BLACK = withFallbacks({
  background: [0, 0, 0],
  foreground: [255, 255, 255],
  ansi: [
    [0, 0, 0], [204, 62, 68], [56, 163, 91], [191, 141, 47],
    [58, 109, 199], [163, 85, 194], [50, 158, 168], [187, 187, 187],
    [85, 85, 85], [255, 96, 100], [96, 214, 122], [246, 199, 88],
    [88, 154, 255], [214, 130, 245], [96, 214, 214], [255, 255, 255],
  ],
});

test("a black terminal produces a dark theme whose editor is that same black", () => {
  const theme = generateTheme(BLACK);
  assert.equal(theme.type, "dark");
  assert.equal(theme.colors["editor.background"], "#000000");
  assert.equal(theme.colors["terminal.background"], "#000000");
});

test("a light terminal produces a light theme", () => {
  const light = withFallbacks({
    background: [255, 255, 255],
    foreground: [30, 30, 30],
    ansi: BLACK.ansi,
  });
  assert.equal(generateTheme(light).type, "light");
  assert.equal(isDark(parseHex("#ffffff")), false);
});

test("a pure black terminal still gets separated panels", () => {
  const theme = generateTheme(BLACK);
  const distinct = (a, b) => assert.notEqual(theme.colors[a], theme.colors[b], `${a} matches ${b}`);
  distinct("sideBar.background", "editor.background");
  distinct("activityBar.background", "editor.background");
  distinct("editorWidget.background", "editor.background");
  distinct("editorWidget.background", "sideBar.background");
  distinct("editor.lineHighlightBackground", "editor.background");
  distinct("tab.activeBackground", "tab.inactiveBackground");
});

test("a pure white terminal separates the other way", () => {
  const white = withFallbacks({ background: [255, 255, 255], foreground: [0, 0, 0], ansi: BLACK.ansi });
  const theme = generateTheme(white);
  assert.equal(theme.colors["editor.background"], "#ffffff");
  assert.notEqual(theme.colors["sideBar.background"], "#ffffff");
  assert.notEqual(theme.colors["editorWidget.background"], theme.colors["sideBar.background"]);
});

test("the ansi palette is carried across verbatim", () => {
  const theme = generateTheme(BLACK);
  assert.equal(theme.colors["terminal.ansiRed"], hex(BLACK.ansi[1]));
  assert.equal(theme.colors["terminal.ansiBrightBlue"], hex(BLACK.ansi[12]));
  assert.equal(theme.colors["terminal.ansiBlack"], hex(BLACK.ansi[0]));
});

test("accents are picked by hue, not by slot number", () => {
  const shuffled = withFallbacks({
    background: [0, 0, 0],
    foreground: [255, 255, 255],
    // green sits where red usually does and the other way round
    ansi: BLACK.ansi.map((c, i) => (i === 9 ? BLACK.ansi[10] : i === 10 ? BLACK.ansi[9] : c)),
  });
  const accent = semanticColors(shuffled);
  assert.equal(hex(accent.red), hex(BLACK.ansi[9]), "red should still be the red one");
  assert.equal(hex(accent.green), hex(BLACK.ansi[10]), "green should still be the green one");
});

test("every text colour clears WCAG AA against the editor surface", () => {
  for (const palette of [BLACK, withFallbacks(null)]) {
    const theme = generateTheme(palette);
    const bg = parseHex(theme.colors["editor.background"]);
    const opaque = (value) => /^#[0-9a-f]{6}$/i.test(value);
    for (const token of theme.tokenColors) {
      const fg = token.settings.foreground;
      if (!fg || !opaque(fg)) continue;
      const ratio = contrast(parseHex(fg), bg);
      assert.ok(ratio >= 2.9, `${token.scope} only reaches ${ratio.toFixed(2)}:1`);
    }
  }
});

test("a hopeless low contrast palette is still pushed to something readable", () => {
  const murky = withFallbacks({
    background: [20, 20, 20],
    foreground: [40, 40, 40],
    ansi: new Array(16).fill([28, 28, 30]),
  });
  const theme = generateTheme(murky);
  const bg = parseHex(theme.colors["editor.background"]);
  const fg = parseHex(theme.colors["editor.foreground"]);
  assert.equal(hex(bg), "#141414");
  for (const token of theme.tokenColors) {
    const colour = token.settings.foreground;
    if (!colour || !/^#[0-9a-f]{6}$/i.test(colour)) continue;
    assert.ok(contrast(parseHex(colour), bg) >= 2.9, `${token.scope} stayed muddy`);
  }
});

test("the fingerprint follows the palette", () => {
  const other = withFallbacks({ background: [1, 0, 0], foreground: [255, 255, 255], ansi: BLACK.ansi });
  assert.equal(paletteFingerprint(BLACK), paletteFingerprint(BLACK));
  assert.notEqual(paletteFingerprint(BLACK), paletteFingerprint(other));
});

test("settings edits keep the comments and the keys around them", () => {
  const before = `{
  // a note the user wrote
  "editor.tabSize": 4,
  "files.autoSave": "off"
}`;
  const after = setKeys(before, { "workbench.colorTheme": "Tode Terminal", "editor.tabSize": 2 });
  assert.match(after, /\/\/ a note the user wrote/);
  assert.equal(readKey(after, "editor.tabSize"), 2);
  assert.equal(readKey(after, "files.autoSave"), "off");
  assert.equal(readKey(after, "workbench.colorTheme"), "Tode Terminal");
});

test("settings can be written into an empty or absent file", () => {
  assert.equal(readKey(setKey("", "a", 1), "a"), 1);
  assert.equal(readKey(setKey("{}", "a", 1), "a"), 1);
  assert.equal(readKey(setKey("{\n}\n", "a", "x"), "a"), "x");
});

test("writing settings twice is stable", () => {
  const once = setKeys("{}", { "workbench.colorTheme": "Tode Terminal", "editor.fontSize": 13 });
  const twice = setKeys(once, { "workbench.colorTheme": "Tode Terminal", "editor.fontSize": 13 });
  assert.equal(once, twice);
});

test("jsonc reading survives comments and trailing commas", () => {
  const { parseJsonc } = require("../dist/jsonc.js");
  const source = `{
  // a line comment
  "a": 1, /* block */
  "url": "https://example.com/not-a-comment",
  "nested": { "b": [1, 2,] },
}`;
  assert.deepEqual(parseJsonc(source), {
    a: 1,
    url: "https://example.com/not-a-comment",
    nested: { b: [1, 2] },
  });
});

test("jsonc reading handles a keybindings array", () => {
  const { parseJsonc } = require("../dist/jsonc.js");
  const parsed = parseJsonc(`// mine\n[ { "key": "cmd+k", "command": "x" }, ]`);
  assert.deepEqual(parsed, [{ key: "cmd+k", command: "x" }]);
});

test("jsonc reading returns null rather than throwing on nonsense", () => {
  const { parseJsonc } = require("../dist/jsonc.js");
  assert.equal(parseJsonc("{ this is not json"), null);
});

test("seeded settings fill gaps but never overwrite what is already there", () => {
  const { applySettings } = require("../dist/profile.js");
  const { readKey } = require("../dist/jsonc.js");
  const fresh = applySettings("{}");
  assert.equal(readKey(fresh, "workbench.activityBar.location"), "top");

  const chosen = applySettings(`{"workbench.activityBar.location": "default"}`);
  assert.equal(readKey(chosen, "workbench.activityBar.location"), "default");
});

const FONT_SETTING_KEYS = [
  "editor.fontFamily",
  "terminal.integrated.fontFamily",
  "chat.editor.fontFamily",
  "debug.console.fontFamily",
  "markdown.preview.fontFamily",
];

test("font defaults are seeded when absent", () => {
  const { applySettings, FONT_FAMILY } = require("../dist/profile.js");
  const { FONT_FALLBACKS } = require("../dist/codeserver/inject.js");
  const expected = `"${FONT_FAMILY}", ${FONT_FALLBACKS}`;
  const out = applySettings("{}");
  for (const key of FONT_SETTING_KEYS) assert.equal(readKey(out, key), expected);
});

test("font defaults preserve explicit user choices", () => {
  const { applySettings } = require("../dist/profile.js");
  const choices = Object.fromEntries(
    FONT_SETTING_KEYS.map((key, at) => [key, `User Font ${at}, monospace`]),
  );
  const out = applySettings(setKeys("{}", choices));
  for (const [key, value] of Object.entries(choices)) assert.equal(readKey(out, key), value);
});

test("applying font defaults repeatedly is stable", () => {
  const { applySettings } = require("../dist/profile.js");
  const first = applySettings("{}");
  assert.equal(applySettings(first), first);

  const chosen = applySettings(setKeys(first, { "editor.fontFamily": "\"JetBrainsMono NF\", monospace" }));
  assert.equal(applySettings(chosen), chosen);
});

test("font choices survive the import merge and are not managed by tode", () => {
  const { applySettings, managedSettings } = require("../dist/profile.js");
  const imported = {
    "editor.fontFamily": "\"JetBrainsMono NF\", monospace",
    "terminal.integrated.fontFamily": "Cascadia Mono, monospace",
    "chat.editor.fontFamily": "User Chat Font",
    "debug.console.fontFamily": "User Debug Font",
    "markdown.preview.fontFamily": "User Markdown Font",
    "editor.tabSize": 8,
  };
  const out = applySettings(setKeys(`{"workbench.colorTheme": "Monokai"}`, imported));
  const managed = managedSettings();

  for (const [key, value] of Object.entries(imported)) assert.equal(readKey(out, key), value);
  for (const key of FONT_SETTING_KEYS) assert.equal(Object.hasOwn(managed, key), false);
  assert.equal(readKey(out, "workbench.colorTheme"), "Terminal Code");
});

/** runs `body` against a throwaway data home, with the modules reloaded so they
 * resolve their paths inside it */
function inFreshDataHome(prefix, body) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  try {
    const profile = require("../dist/profile.js");
    const { CSS_FILE } = require("../dist/codeserver/server.js");
    const { withFallbacks } = require("../dist/terminal/osc.js");
    const writeSettings = (source) => {
      fs.mkdirSync(profile.USER_DIR, { recursive: true });
      fs.writeFileSync(path.join(profile.USER_DIR, "settings.json"), source);
    };
    const installedCss = () => {
      profile.installCss(withFallbacks(null));
      return fs.readFileSync(CSS_FILE, "utf8");
    };
    body({ profile, writeSettings, installedCss });
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
}

test("the injected css renders in the font the user chose", () => {
  inFreshDataHome("tode-css-font-", ({ writeSettings, installedCss }) => {
    writeSettings(`{"editor.fontFamily": "\\"JetBrainsMono NF\\", monospace"}`);
    const css = installedCss();
    assert.match(css, /\.monaco-workbench\{[^}]*font-family:"JetBrainsMono NF", monospace !important;\}/);
    assert.match(css, /--monaco-monospace-font:"JetBrainsMono NF", monospace;/);
    assert.match(css, /@font-face\{font-family:"JetBrains Mono";/, "the bundled font still loads");
  });
});

test("a changed font reaches the css on the next install, not only the first", () => {
  inFreshDataHome("tode-css-font-change-", ({ writeSettings, installedCss }) => {
    writeSettings(`{}`);
    assert.match(installedCss(), /--monaco-monospace-font:"JetBrains Mono"/);

    writeSettings(`{"editor.fontFamily": "Cascadia Mono, monospace"}`);
    assert.match(installedCss(), /--monaco-monospace-font:Cascadia Mono, monospace;/);
  });
});

test("a font tode cannot use falls back to the bundled stack", () => {
  inFreshDataHome("tode-css-font-bad-", ({ profile, writeSettings, installedCss }) => {
    for (const value of ["", "   ", "a} body{display:none", "a;color:red", "a/*x*/"]) {
      writeSettings(JSON.stringify({ "editor.fontFamily": value }));
      assert.equal(profile.userFontStack(), null, `${value} must be refused`);
      assert.ok(installedCss().includes(`--monaco-monospace-font:${profile.FONT_STACK};`));
    }

    writeSettings(`{"editor.fontFamily": 13}`);
    assert.equal(profile.userFontStack(), null, "a number is not a font stack");

    writeSettings(`{ this is not json`);
    assert.equal(profile.userFontStack(), null, "nonsense is not a font stack");
  });
});

test("no settings file at all still produces the bundled stack", () => {
  inFreshDataHome("tode-css-font-none-", ({ profile, installedCss }) => {
    assert.equal(profile.userFontStack(), null);
    assert.ok(installedCss().includes(`--monaco-monospace-font:${profile.FONT_STACK};`));
  });
});

test("managed settings always win, even over an import", () => {
  const { applySettings } = require("../dist/profile.js");
  const { readKey } = require("../dist/jsonc.js");
  const out = applySettings(`{"workbench.colorTheme": "Monokai", "editor.tabSize": 8}`);
  assert.equal(readKey(out, "workbench.colorTheme"), "Terminal Code");
  assert.equal(readKey(out, "editor.tabSize"), 8);
});

test("installing keybindings never eats the ones already in the file", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-kb-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installKeybindings, mergeKeybindings, USER_DIR } = require("../dist/profile.js");
  const { parseJsonc } = require("../dist/jsonc.js");
  const file = path.join(USER_DIR, "keybindings.json");
  const read = () => parseJsonc(fs.readFileSync(file, "utf8"));
  try {
    installKeybindings();
    const todeOnly = read().length;
    assert.ok(todeOnly > 0);

    const mine = [
      { key: "ctrl+u", command: "cursorMove", when: "editorTextFocus && vim.mode == 'Normal'" },
      { key: "ctrl+d", command: "cursorMove", when: "editorTextFocus && vim.mode == 'Normal'" },
    ];
    assert.equal(mergeKeybindings(mine), 2);
    assert.equal(read().length, todeOnly + 2);

    // the bug: a later plain run used to rewrite the file with only tode's
    installKeybindings();
    const after = read();
    assert.equal(after.length, todeOnly + 2, "imported bindings were dropped");
    assert.ok(after.some((b) => b.key === "ctrl+u" && b.command === "cursorMove"));

    // running twice more must stay stable
    installKeybindings();
    installKeybindings();
    assert.equal(read().length, todeOnly + 2);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the bridge maps quit per platform, always behind a confirm", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-bridge-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installBridge, BRIDGE_DIR } = require("../dist/bridge.js");
  try {
    installBridge(["/usr/local/bin/tode"]);
    const pkg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "package.json"), "utf8"));
    const { QUIT_CHORD } = require("../dist/shortcuts/store.js");
    const quit = pkg.contributes.keybindings[0];
    assert.equal(quit.key, QUIT_CHORD);
    assert.equal(quit.command, "tode.confirmQuit", "quitting always asks first");
    assert.match(quit.when, /!terminalFocus/, "the quit chord is left alone in the terminal");
    // extension carve-outs are derived from installed claims (none here);
    // that mechanism is covered by the shortcuts store tests
    if (QUIT_CHORD === "ctrl+c") {
      assert.equal(pkg.contributes.keybindings.length, 1, "no redirect hint where ctrl+c is quit itself");
      assert.match(quit.when, /!editorHasSelection/, "a selection keeps its chord");
    } else {
      const hint = pkg.contributes.keybindings[1];
      assert.equal(hint.key, "ctrl+c");
      assert.equal(hint.command, "tode.quitHint");
      assert.match(hint.when, /!editorTextFocus/, "ctrl+c in the editor must stay copy");
      assert.match(hint.when, /!terminalFocus/, "ctrl+c in the terminal is the shell's");
      const { hintWhen } = require("../dist/shortcuts/store.js");
      assert.equal(hint.when, hintWhen(), "the manifest and the keybindings file must agree");
    }

    const command = pkg.contributes.commands[0];
    assert.equal(command.command, "tode.quit");
    assert.equal(`${command.category}: ${command.title}`, "terminal-code: Quit");

    // "*" is rejected for an extension that ships code, and it fails silently
    assert.notEqual(pkg.engines.vscode, "*");
    assert.match(pkg.engines.vscode, /^\^?\d+\.\d+/);

    const source = fs.readFileSync(path.join(BRIDGE_DIR, "extension.js"), "utf8");
    assert.match(source, /registerCommand\("tode\.quit"/);
    assert.match(source, /registerCommand\("tode\.confirmQuit"/);
    assert.match(source, /registerCommand\("tode\.quitHint"/);
    assert.match(source, /"Do you want to quit terminal-code\?", \{ modal: true \}, "Quit"/, "quit confirms before acting");
    assert.match(source, /showErrorMessage\(QUIT_HINT, \{ modal: true \}\)/, "the hint is a modal, not a corner toast");
    assert.match(source, /onDidChangeTabs/);
    assert.match(source, /\/usr\/local\/bin\/tode/);
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the theme extension also declares a usable engine range", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-theme-eng-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installTheme, EXTENSIONS_DIR } = require("../dist/profile.js");
  const { withFallbacks } = require("../dist/terminal/osc.js");
  try {
    installTheme(withFallbacks(null));
    const dir = fs.readdirSync(EXTENSIONS_DIR).find((d) => d.startsWith("tode.tode-theme"));
    const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSIONS_DIR, dir, "package.json"), "utf8"));
    assert.notEqual(pkg.engines.vscode, "*");
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("goto accepts file, file:line and file:line:column", () => {
  const { parseGoto } = require("../dist/ipc.js");
  assert.deepEqual(parseGoto("src/a.ts:12:5"), { path: "src/a.ts", line: 12, column: 5 });
  assert.deepEqual(parseGoto("src/a.ts:12"), { path: "src/a.ts", line: 12, column: 1 });
  assert.deepEqual(parseGoto("src/a.ts"), { path: "src/a.ts" });
  // a real path wins over the line-number reading of it
  assert.deepEqual(parseGoto("/etc/hosts"), { path: "/etc/hosts" });
});

test("a window is only reused when it answers", async () => {
  const { runningWindow } = require("../dist/ipc.js");
  const prev = process.env.TODE_IPC;
  try {
    delete process.env.TODE_IPC;
    assert.equal(await runningWindow(), null);
    process.env.TODE_IPC = "/tmp/definitely-not-a-socket-xyz";
    assert.equal(await runningWindow(), null, "an address nothing listens on is not a window");
  } finally {
    if (prev === undefined) delete process.env.TODE_IPC;
    else process.env.TODE_IPC = prev;
  }
});

test("open requests reach a listening window", async () => {
  const net = require("node:net");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { sendToExtension, windowAddress } = require("../dist/ipc.js");
  const { endpoint } = windowAddress(fs.mkdtempSync(path.join(os.tmpdir(), "tode-ipc-")), "w");
  const seen = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      seen.push(JSON.parse(buf.split("\n")[0]));
      c.end(JSON.stringify({ ok: true }) + "\n");
    });
  });
  await new Promise((r) => server.listen(endpoint, r));
  try {
    await sendToExtension(endpoint, { files: [{ path: "/a.ts", line: 3, column: 2 }], folders: [], add: false });
    assert.deepEqual(seen[0].files, [{ path: "/a.ts", line: 3, column: 2 }]);
  } finally {
    server.close();
  }
});

test("a window that refuses is reported, not swallowed", async () => {
  const net = require("node:net");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { sendToExtension, windowAddress } = require("../dist/ipc.js");
  const { endpoint } = windowAddress(fs.mkdtempSync(path.join(os.tmpdir(), "tode-ipc-")), "refuses");
  const server = net.createServer((c) => c.end(JSON.stringify({ ok: false, error: "nope" }) + "\n"));
  await new Promise((r) => server.listen(endpoint, r));
  try {
    await assert.rejects(
      () => sendToExtension(endpoint, { files: [], folders: [], add: false }),
      /nope/,
    );
  } finally {
    server.close();
  }
});

test("the generated extension is valid javascript", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const vm = require("node:vm");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-syntax-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installBridge, BRIDGE_DIR } = require("../dist/bridge.js");
  try {
    installBridge(["/usr/local/bin/tode"]);
    const source = fs.readFileSync(path.join(BRIDGE_DIR, "extension.js"), "utf8");
    // a syntax error here means the extension never activates, and nothing says so
    assert.doesNotThrow(() => new vm.Script(source), "generated extension must parse");
    // escapes have to survive being written through a template literal
    assert.doesNotMatch(source, /indexOf\("\n/, "a newline escape collapsed into a real newline");
    assert.match(source, /net\.createServer/);
    assert.match(source, /environmentVariableCollection\.replace\("TODE_IPC"/);
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("code's flags are taken, not rejected", () => {
  const { execFileSync } = require("node:child_process");
  const help = execFileSync("node", [require("node:path").join(__dirname, "..", "dist", "main.js"), "--help"], {
    encoding: "utf8",
  });
  for (const flag of ["-g, --goto", "-a, --add", "-n, --new-window", "-w, --wait", "-d, --diff", "-r, --reuse-window"]) {
    assert.match(help, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${flag} should be documented`);
  }
});

test("a folder request is acknowledged before the window reloads", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-ack-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installBridge, BRIDGE_DIR } = require("../dist/bridge.js");
  try {
    installBridge(["/usr/local/bin/tode"]);
    const source = fs.readFileSync(path.join(BRIDGE_DIR, "extension.js"), "utf8");
    const acknowledgement = /acknowledge\(\);\s+for \(const uri of wanted\)/.exec(source);
    const ackAt = acknowledgement?.index ?? -1;
    const openAt = source.indexOf("vscode.openFolder");
    assert.ok(ackAt > 0, "the folder loop must be preceded by an acknowledgement");
    assert.ok(ackAt < openAt, "openFolder reloads the window, so the reply must go first");
    assert.match(source, /alreadyOpen/, "reopening the folder already open should do nothing");
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("help states the routing rules for a tode terminal", () => {
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const help = execFileSync("node", [path.join(__dirname, "..", "dist", "main.js"), "--help"], {
    encoding: "utf8",
  });
  assert.match(help, /-r, --reuse-window\s+Open folder in this window/);
  assert.match(help, /--shortcut-setup/);
});

test("-r is a real flag now, not something quietly dropped", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
  const ignored = source.slice(source.indexOf("const IGNORED:"), source.indexOf("const IGNORED_WITH_VALUE"));
  assert.doesNotMatch(ignored, /"-r"/, "-r must not be in the ignored list");
  assert.doesNotMatch(ignored, /"--reuse-window"/);
  assert.match(source, /takeBool\(args, "-r"\)/);
});

test("changing the palette gets a new theme folder, so a warm browser cannot cache it stale", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-theme-cache-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installTheme, EXTENSIONS_DIR } = require("../dist/profile.js");
  const { withFallbacks } = require("../dist/terminal/osc.js");
  try {
    // registerThemeExtension only rewrites extensions.json once one already
    // exists — matches the real machine, where other extensions got there first
    fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), "[]\n");
    const first = withFallbacks({ background: [0, 0, 0], foreground: [255, 255, 255], ansi: new Array(16).fill([100, 100, 100]) });
    const { fingerprint: fp1 } = installTheme(first);
    const dirsAfterFirst = fs.readdirSync(EXTENSIONS_DIR).filter((d) => d.startsWith("tode.tode-theme-"));
    assert.deepEqual(dirsAfterFirst, [`tode.tode-theme-${fp1}`]);

    // re-installing the identical palette must not touch the folder at all —
    // this is the "skip when nothing changed" optimisation, still working
    const before = fs.statSync(path.join(EXTENSIONS_DIR, dirsAfterFirst[0], "themes", "tode-terminal.json")).mtimeMs;
    const repeat = installTheme(first);
    assert.equal(repeat.changed, false);
    const after = fs.statSync(path.join(EXTENSIONS_DIR, dirsAfterFirst[0], "themes", "tode-terminal.json")).mtimeMs;
    assert.equal(before, after);

    // the actual bug: a real theme change must produce a genuinely new folder
    // name, which is what makes it a new url a cached browser cannot conflate
    // with the old one
    const second = withFallbacks({ background: [255, 255, 255], foreground: [0, 0, 0], ansi: new Array(16).fill([200, 200, 200]) });
    const { changed, fingerprint: fp2 } = installTheme(second);
    assert.equal(changed, true);
    assert.notEqual(fp1, fp2, "two different palettes must not collide on the same fingerprint");
    const dirsAfterSecond = fs.readdirSync(EXTENSIONS_DIR).filter((d) => d.startsWith("tode.tode-theme-"));
    assert.deepEqual(dirsAfterSecond, [`tode.tode-theme-${fp2}`], "the stale folder must be gone, not just superseded");

    const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), "utf8"));
    const entry = manifest.find((e) => e.identifier.id === "tode.tode-theme");
    assert.equal(entry.relativeLocation, `tode.tode-theme-${fp2}`, "extensions.json must point at the new folder");
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("registerThemeExtension with no argument finds the theme actually on disk", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-theme-reg-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installTheme, registerThemeExtension, EXTENSIONS_DIR } = require("../dist/profile.js");
  const { withFallbacks } = require("../dist/terminal/osc.js");
  try {
    const { fingerprint } = installTheme(withFallbacks(null));
    // simulate an extensions.json rewritten by something else, e.g. an install,
    // that dropped tode's own entry
    fs.writeFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), "[]\n");
    registerThemeExtension();
    const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), "utf8"));
    const entry = manifest.find((e) => e.identifier.id === "tode.tode-theme");
    assert.ok(entry, "the theme must be re-registered");
    assert.equal(entry.relativeLocation, `tode.tode-theme-${fingerprint}`);
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("skill emits SKILL.md frontmatter with every path resolved from the env", () => {
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-skill-"));
  try {
    const out = execFileSync("node", [path.join(__dirname, "..", "dist", "main.js"), "--skill"], {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(home, "share"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        // a bare shell: not inside a window, no terminal detected
        TODE_IPC: "",
        TERM: "xterm",
        TERM_PROGRAM: "",
        GHOSTTY_RESOURCES_DIR: "",
        KITTY_WINDOW_ID: "",
        KITTY_PID: "",
      },
    });
    assert.match(out, /^---\nname: tode\ndescription: .+\n---\n/);
    // paths come from the env the process saw, not from wherever it was built
    assert.ok(out.includes(path.join(home, "share", "tode")), "data home must be resolved");
    assert.ok(out.includes(path.join(home, "state", "tode", "server.json")), "state home must be resolved");
    assert.match(out, /daemon: not running/);
    assert.match(out, /is not inside a tode window/);
    assert.match(out, /none \(ghostty and kitty are supported\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a partial palette answer keeps its slots but is never authoritative", () => {
  const { resolvePalette } = require("../dist/profile.js");
  const ansi = (base) => Array.from({ length: 16 }, (_, at) => [base + at, 0, 0]);
  const full = { background: [1, 2, 3], foreground: [250, 250, 250], ansi: ansi(0) };
  assert.equal(resolvePalette(full, null).source, "terminal", "a complete answer is the terminal's");

  // the ssh shape: bg arrived, fg and 15 ansi slots ran out the clock
  const cached = { background: [9, 9, 9], foreground: [200, 200, 200], ansi: ansi(100) };
  const partial = { background: [1, 2, 3], foreground: null, ansi: [[7, 7, 7], ...new Array(15).fill(null)] };
  const blended = resolvePalette(partial, cached);
  assert.equal(blended.source, "cache", "a blend is never reported as the terminal's answer");
  assert.deepEqual(blended.palette.background, [1, 2, 3], "the slot that really arrived wins");
  assert.deepEqual(blended.palette.foreground, [200, 200, 200], "missing slots come from the cache");
  assert.deepEqual(blended.palette.ansi[0], [7, 7, 7]);
  assert.deepEqual(blended.palette.ansi[5], [105, 0, 0]);

  assert.equal(resolvePalette(partial, null).source, "default", "no cache leaves only built-ins");
  assert.equal(resolvePalette(null, cached).source, "cache");
  assert.equal(resolvePalette(null, null).source, "default");
});
