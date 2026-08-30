const assert = require("node:assert/strict");
const { test } = require("node:test");

const { repairChecks } = require("../dist/doctor/repairs.js");

const baseContext = {
  environment: {
    platform: "darwin",
    architecture: "arm64",
    targetTriple: "darwin-arm64",
    tty: { stdin: false, stdout: false, stderr: false },
    terminalProvider: null,
  },
  paths: {
    install: "/install",
    vendor: "/install/vendor",
    data: "/managed/data",
    state: "/managed/state",
    cache: "/managed/cache",
    runtime: "/managed/runtime",
    logs: "/managed/logs",
    codeServer: "/managed/code-server",
    browser: { data: "/managed/browser-data", state: "/managed/browser-state", cache: "/managed/browser-cache", appData: "/managed/browser-app" },
  },
  runtime: {
    terminalBrowserVersion: "v0.5.8",
    terminalBrowserOverride: null,
    codeServerVersion: "4.132.0",
    codeServerOverride: null,
    codeServerBinary: null,
  },
  exists: () => false,
};

const check = (id, status = "warning", fixable = true) => ({
  id,
  status,
  severity: status === "error" ? "error" : status === "needs_input" || status === "warning" ? "warning" : "info",
  fixable,
  message: status,
});

test("managed state repair creates only terminal-code directories", async () => {
  const made = [];
  const actions = await repairChecks(
    [check("paths.managedState")],
    baseContext,
    { mkdir: (directory) => made.push(directory) },
  );
  assert.deepEqual(made, ["/managed/data", "/managed/state", "/managed/cache", "/managed/runtime", "/managed/logs"]);
  assert.equal(actions[0].id, "paths.create-managed-directories");
  assert.equal(actions[0].status, "changed");
});

test("runtime repairs use injected verified provisioning paths", async () => {
  let runtimeCalls = 0;
  let codeServerCalls = 0;
  const actions = await repairChecks(
    [check("runtime.terminalBrowser", "error"), check("runtime.codeServer", "error")],
    baseContext,
    {
      resolveRuntime: async () => { runtimeCalls += 1; },
      ensureCodeServer: async () => { codeServerCalls += 1; return "/managed/code-server/bin/code-server"; },
    },
  );
  assert.equal(runtimeCalls, 1);
  assert.equal(codeServerCalls, 1);
  assert.deepEqual(actions.map((action) => action.status), ["changed", "changed"]);
});

test("unresolved shortcuts are blocked without provider mutation", async () => {
  let applied = false;
  const provider = {
    id: "ghostty",
    name: "Ghostty",
    detect: () => true,
    ready: () => null,
    scan: () => [{
      editorId: "ctrl+x",
      trigger: "ctrl+x",
      current: "close_window",
      editor: { means: "close", command: "workbench.action.closeWindow" },
      others: [],
      inTerminal: "closes",
      short: "close",
      freed: "close",
      tradeoff: "close",
    }],
    takenAs: () => "close_window",
    trigger: (chord) => chord,
    describe: (action) => action,
    apply: () => { applied = true; return "/managed/keybinds"; },
    onApplied: () => false,
    undo: () => false,
    reloadHint: () => "reload",
  };
  const actions = await repairChecks(
    [check("shortcuts.configuration", "needs_input", false)],
    baseContext,
    { provider },
  );
  assert.equal(applied, false);
  assert.equal(actions.some((action) => action.status === "blocked"), true);
  assert.equal(actions.find((action) => action.id === "shortcuts.needs-input").details.reason, "needs_input");
});

test("daemon repair never signals a live unverified PID", async () => {
  let stopped = false;
  let started = false;
  const state = { pid: 31, port: 9011, injectorPid: 32, injectorPort: 9012, version: "4.132.0", startedAt: 1 };
  const actions = await repairChecks(
    [check("daemon.state", "error")],
    baseContext,
    {
      readServerState: () => state,
      processProbe: {
        alive: () => true,
        command: () => "unrelated-process",
      },
      stopServer: () => { stopped = true; return true; },
      ensureServer: async () => { started = true; return state; },
    },
  );
  assert.equal(stopped, false);
  assert.equal(started, false);
  assert.equal(actions[0].status, "blocked");
  assert.equal(actions[0].details.reason, "unverified-pid");
});

test("profile repair records changed and unchanged generated artifacts", async () => {
  const calls = [];
  const palette = { background: [0, 0, 0], foreground: [255, 255, 255], ansi: Array.from({ length: 16 }, () => [0, 0, 0]) };
  const actions = await repairChecks(
    [check("profile.generatedState")],
    baseContext,
    {
      readPalette: async () => ({ palette, source: "default" }),
      ensureFont: () => "present",
      installTheme: () => ({ changed: false, fingerprint: "abc" }),
      installCss: () => { calls.push("css"); return true; },
      setLiveTheme: () => { calls.push("theme"); return false; },
      installSettings: () => false,
      installKeybindings: () => true,
      installBridge: () => true,
      todeCommand: () => ["tode"],
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(actions.find((action) => action.id === "profile.css").status, "changed");
  assert.equal(actions.find((action) => action.id === "profile.live-theme").status, "unchanged");
  assert.equal(actions.find((action) => action.id === "profile.font").status, "unchanged");
});

test("stale state with one dead owned PID is cleaned and restarted", async () => {
  let stopped = false;
  let started = false;
  const stale = { pid: 31, port: 9011, injectorPid: 32, injectorPort: 9012, version: "4.132.0", startedAt: 1 };
  const fresh = { pid: 41, port: 9021, injectorPid: 42, injectorPort: 9022, version: "4.132.0", startedAt: 2 };
  const alive = (pid) => pid === stale.injectorPid || pid === fresh.pid || pid === fresh.injectorPid;
  const command = (pid) => pid === stale.injectorPid
    ? "node injector-main.js 9011 9012"
    : pid === fresh.pid
      ? "code-server --bind-addr 127.0.0.1:9021 --app-name tode"
      : "node injector-main.js 9021 9022";
  const actions = await repairChecks(
    [check("daemon.state", "warning")],
    baseContext,
    {
      readServerState: () => stale,
      processProbe: { alive, command },
      probePort: async () => true,
      stopServer: () => { stopped = true; return true; },
      ensureServer: async () => { started = true; return fresh; },
    },
  );
  assert.equal(stopped, true);
  assert.equal(started, true);
  assert.equal(actions[0].status, "changed");
});
