const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const { parseRawColors } = require("../dist/livesync.js");
const { withFallbacks } = require("../dist/terminal/osc.js");
const net = require("node:net");

const { generateTheme } = require("../dist/theme/generate.js");

const RED = withFallbacks({ background: [0, 0, 0], foreground: [255, 255, 255], ansi: new Array(16).fill(null) });
const BLUE = withFallbacks({ background: [0, 0, 40], foreground: [230, 230, 255], ansi: new Array(16).fill(null) });

test("a colours file with both ends missing is not a palette", () => {
  assert.equal(parseRawColors("{}"), null);
  assert.equal(parseRawColors('{"background":[0,0,0]}'), null);
  assert.equal(parseRawColors("not json"), null);
});

test("a full colours file round-trips through withFallbacks", () => {
  const palette = parseRawColors(
    JSON.stringify({ background: [0, 0, 0], foreground: [255, 255, 255], ansi: new Array(16).fill(null) }),
  );
  assert.deepEqual(palette.background, [0, 0, 0]);
  assert.deepEqual(palette.foreground, [255, 255, 255]);
  assert.equal(palette.ansi.length, 16);
});

/** loads the generated bridge extension in a sandbox with a fake vscode, so
 * the live-settings watch is exercised the same way serve-web would run it,
 * not just checked for valid syntax. os.homedir() is pointed at a scratch
 * directory too, since activate() also stands up the real ipc socket and this
 * must not touch the actual home directory while doing it. */
function loadBridgeSandbox(extensionSource, fakeHome, vscodeOverrides = {}) {
  const updates = [];
  const spawned = [];
  const vscode = {
    workspace: { getConfiguration: () => ({ update: (key, value) => updates.push({ key, value }) }) },
    ConfigurationTarget: { Global: 1 },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => {} },
    window: { tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) } },
    ...vscodeOverrides,
  };
  const realOs = require("node:os");
  const sandboxModules = {
    vscode,
    os: { ...realOs, homedir: () => fakeHome },
    child_process: { spawn: (cmd, args) => (spawned.push({ cmd, args }), { unref() {} }) },
  };
  const sandbox = {
    require: (id) => sandboxModules[id] ?? require(id),
    module: { exports: {} },
    exports: {},
    console,
    process,
    setTimeout,
    clearTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  new vm.Script(extensionSource).runInContext(sandbox);
  return { extension: sandbox.module.exports, updates, spawned };
}

test("the bridge applies the live theme on activation and again on every change, without a reload", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-live-bridge-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installBridge, BRIDGE_DIR } = require("../dist/bridge.js");
  const { LIVE_THEME_FILE } = require("../dist/profile.js");
  try {
    installBridge(["/usr/local/bin/tode"]);
    const source = fs.readFileSync(path.join(BRIDGE_DIR, "extension.js"), "utf8");

    fs.mkdirSync(path.dirname(LIVE_THEME_FILE), { recursive: true });
    fs.writeFileSync(LIVE_THEME_FILE, `${JSON.stringify(generateTheme(RED))}\n`);

    const { extension, updates } = loadBridgeSandbox(source, home);
    const context = { subscriptions: [], environmentVariableCollection: { replace() {} } };
    extension.activate(context);
    try {
      // values crossed the vm sandbox boundary, so they carry that context's
      // Object prototype; comparing serialized form sidesteps the realm mismatch
      const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.equal(updates.length, 2, "activation applies the theme already on disk");
      same(updates[0].value, generateTheme(RED).colors);

      const tmp = `${LIVE_THEME_FILE}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(generateTheme(BLUE))}\n`);
      fs.renameSync(tmp, LIVE_THEME_FILE);
      await new Promise((r) => setTimeout(r, 150));

      // a directory watch can report a single rename as more than one event
      // (platform-dependent), so more than one redundant, idempotent
      // re-application is fine — what must hold is that it settles on the new
      // palette without anyone reloading the window in between
      assert.ok(updates.length > 2, "a live change is applied again, with no reload in between");
      const last = (key) => [...updates].reverse().find((u) => u.key === key)?.value;
      same(last("workbench.colorCustomizations"), generateTheme(BLUE).colors);
      same(last("editor.tokenColorCustomizations"), { textMateRules: generateTheme(BLUE).tokenColors });
    } finally {
      for (const sub of context.subscriptions) sub.dispose();
    }
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the startup marker replays views and diffs once, then burns", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-review-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installBridge, requestStartupOpen, BRIDGE_DIR } = require("../dist/bridge.js");
  try {
    installBridge(["/usr/local/bin/tode"]);
    // the parts of an open the workbench url cannot carry: a diff and a view
    requestStartupOpen({ view: "scm", diff: ["/tmp/a.txt", "/tmp/b.txt"] });
    const source = fs.readFileSync(path.join(BRIDGE_DIR, "extension.js"), "utf8");
    const ran = [];
    const { extension } = loadBridgeSandbox(source, home, {
      commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: (command, ...rest) => ran.push([command, ...rest.map(String)]),
      },
      Uri: { file: (p) => ({ toString: () => `file://${p}` }) },
    });
    const context = { subscriptions: [], environmentVariableCollection: { replace() {} } };
    extension.activate(context);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const commands = JSON.parse(JSON.stringify(ran));
      assert.deepEqual(commands[0], ["workbench.view.scm"]);
      assert.deepEqual(commands[1], ["vscode.diff", "file:///tmp/a.txt", "file:///tmp/b.txt"]);
      const marker = path.join(process.env.XDG_DATA_HOME, "tode", "startup-open.json");
      assert.ok(!fs.existsSync(marker), "the marker is one-shot");
    } finally {
      for (const sub of context.subscriptions) sub.dispose();
    }

    // a second activation without the marker stays on the default view
    const again = loadBridgeSandbox(source, home, {
      commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: (command) => again.ran.push(command),
      },
    });
    again.ran = [];
    const context2 = { subscriptions: [], environmentVariableCollection: { replace() {} } };
    again.extension.activate(context2);
    try {
      assert.equal(again.ran.length, 0);
    } finally {
      for (const sub of context2.subscriptions) sub.dispose();
    }
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("setLiveTheme writes the theme document the bridge will read back", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-live-settings-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { setLiveTheme, LIVE_THEME_FILE } = require("../dist/profile.js");
  try {
    const changed = setLiveTheme(generateTheme(RED));
    assert.equal(changed, true);
    const onDisk = JSON.parse(fs.readFileSync(LIVE_THEME_FILE, "utf8"));
    assert.deepEqual(onDisk, generateTheme(RED));

    const changedAgain = setLiveTheme(generateTheme(RED));
    assert.equal(changedAgain, false, "writing the same theme twice is a no-op");
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("a vscode theme file, comments and all, lands in the live slot and the extension dir", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-theme-file-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { setThemeFile, LIVE_THEME_FILE, EXTENSIONS_DIR, THEME_EXTENSION_ID } = require("../dist/profile.js");
  try {
    const file = path.join(home, "night.json");
    fs.writeFileSync(
      file,
      `{
  // a real theme file has comments and trailing commas
  "name": "Night",
  "type": "dark",
  "colors": { "editor.background": "#101014", },
  "tokenColors": [{ "scope": ["comment"], "settings": { "foreground": "#606070" } }],
}`,
    );
    assert.equal(setThemeFile(file), null);

    const live = JSON.parse(fs.readFileSync(LIVE_THEME_FILE, "utf8"));
    assert.equal(live.colors["editor.background"], "#101014");

    const installed = fs
      .readdirSync(EXTENSIONS_DIR)
      .filter((entry) => entry.startsWith(`${THEME_EXTENSION_ID}-`));
    assert.equal(installed.length, 1, "the theme is installed as the contributed theme");
    const themeOnDisk = JSON.parse(
      fs.readFileSync(path.join(EXTENSIONS_DIR, installed[0], "themes", "tode-terminal.json"), "utf8"),
    );
    assert.equal(themeOnDisk.name, "Night");

    assert.match(setThemeFile(path.join(home, "missing.json")) ?? "", /could not read/);
    fs.writeFileSync(file, `{ "just": "not a theme" }`);
    assert.match(setThemeFile(file) ?? "", /not a vscode theme/);
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the browser main script turns a colours message into a theme at every window socket", async () => {
  const { mainScriptSource } = require("../dist/browserglue.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-browser-main-"));
  const sockDir = path.join(dir, "ipc");
  fs.mkdirSync(sockDir);
  const dist = path.resolve(__dirname, "..", "dist");
  const script = path.join(dir, "browser-main.js");
  fs.writeFileSync(
    script,
    mainScriptSource({
      socketDir: sockDir,
      timingFile: path.join(dir, "timing.json"),
      modules: {
        livesync: path.join(dist, "livesync.js"),
        generate: path.join(dist, "theme", "generate.js"),
        ipc: path.join(dist, "ipc.js"),
      },
    }),
  );
  // the script requires electron for ipcMain; resolve it to a stub the same
  // way the browser process would, through node_modules next to the script
  const electronStub = path.join(dir, "node_modules", "electron");
  fs.mkdirSync(electronStub, { recursive: true });
  fs.writeFileSync(
    path.join(electronStub, "index.js"),
    "exports.subscribed = [];\n" +
      "exports.ipcMain = { on(channel, listener) { exports.subscribed.push({ channel, listener }); } };\n",
  );

  const received = [];
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      received.push(JSON.parse(chunk.toString("utf8").split("\n")[0]));
      connection.end('{"ok":true}\n');
    });
  });
  const sock = path.join(sockDir, "w1.sock");
  await new Promise((r) => server.listen(sock, r));
  try {
    // the pinned build requires the module for its side effects; subscribing
    // to tode's ipc channel is that side effect
    require(script);
    const electron = require(path.join(electronStub, "index.js"));
    assert.equal(electron.subscribed.length, 1);
    assert.equal(electron.subscribed[0].channel, "tode:message");
    const handlers = [(message) => electron.subscribed[0].listener(null, message)];

    // junk does not crash and does not reach the socket
    handlers[0](null);
    handlers[0]({ type: "theme" });
    handlers[0]({ type: "theme", colors: { background: [0, 0, 40] } });

    handlers[0]({
      type: "theme",
      colors: { background: BLUE.background, foreground: BLUE.foreground, ansi: BLUE.ansi },
    });
    const deadline = Date.now() + 2000;
    while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 1, "only the whole palette becomes a theme");
    assert.deepEqual(received[0].theme, JSON.parse(JSON.stringify(generateTheme(BLUE))));
  } finally {
    server.close();
    delete require.cache[script];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a theme over the window socket is applied live and persisted for the next reload", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-socket-theme-"));
  // a unix socket path tops out at 104 bytes on macOS, and os.tmpdir() is
  // already most of that — the state home must stay short
  const state = fs.mkdtempSync("/tmp/tode-st-");
  const prevData = process.env.XDG_DATA_HOME;
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = state;
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installBridge, BRIDGE_DIR } = require("../dist/bridge.js");
  const { LIVE_THEME_FILE } = require("../dist/profile.js");
  const { sendToExtension } = require("../dist/ipc.js");
  try {
    installBridge(["/usr/local/bin/tode"]);
    const source = fs.readFileSync(path.join(BRIDGE_DIR, "extension.js"), "utf8");
    const { extension, updates } = loadBridgeSandbox(source, home);
    let sock = null;
    const context = {
      subscriptions: [],
      environmentVariableCollection: {
        replace(key, value) {
          if (key === "TODE_IPC") sock = value;
        },
      },
    };
    extension.activate(context);
    try {
      const deadline = Date.now() + 2000;
      while (!sock && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(sock, "the bridge listens on its window socket");

      const theme = generateTheme(BLUE);
      await sendToExtension(sock, { files: [], folders: [], add: false, theme });

      const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
      const last = (key) => [...updates].reverse().find((u) => u.key === key)?.value;
      same(last("workbench.colorCustomizations"), theme.colors);
      same(last("editor.tokenColorCustomizations"), { textMateRules: theme.tokenColors });

      const onDisk = JSON.parse(fs.readFileSync(LIVE_THEME_FILE, "utf8"));
      same(onDisk, theme);
    } finally {
      for (const sub of context.subscriptions) sub.dispose();
    }
  } finally {
    process.env.XDG_DATA_HOME = prevData;
    process.env.XDG_STATE_HOME = prevState;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});
