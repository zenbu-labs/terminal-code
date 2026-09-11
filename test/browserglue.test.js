const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const { preloadSource, mainScriptSource } = require("../dist/browserglue.js");

// The generated scripts must be self-contained: a bare vm context has no module
// scope to lean on, so any closure the source functions capture — or any helper
// a tsconfig change makes tsc inject — throws ReferenceError right here.

test("the preload forwards terminal themes to the main script", () => {
  const sent = [];
  let subscriber = null;
  const sandbox = workbenchSandbox(sent, []);
  sandbox.terminalBrowser.onTheme = (cb) => {
    subscriber = cb;
    return () => {};
  };
  // a frame that is not the top document keeps the timing story out of the way
  sandbox.window = { top: {} };
  vm.runInNewContext(preloadSource({}), sandbox);
  assert.ok(subscriber, "the preload subscribed to theme changes");
  const theme = { background: [30, 32, 38], foreground: [220, 220, 220], ansi: [] };
  subscriber(theme);
  // vm objects carry the other realm's prototypes, so compare plain data
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: "theme", colors: theme }]);
});

test("the preload resets stale browser zoom", () => {
  const zoomFactors = [];
  const sandbox = workbenchSandbox([], [], zoomFactors);
  sandbox.window = { top: {} };
  vm.runInNewContext(preloadSource({}), sandbox);
  assert.deepEqual(zoomFactors, [1]);
});

// The timing flow runs on real timers; an unref'd wrapper keeps the preload's
// long 30s fallback from holding the test process open.
const timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval,
  clearTimeout,
};

function workbenchSandbox(sent, classes, zoomFactors = []) {
  const sandbox = {
    // the pinned build's api is theme-only — no send. Everything bound for
    // the main script leaves over electron's ipc, required by the preload.
    terminalBrowser: { theme: () => null, onTheme: () => () => {} },
    require: (id) => {
      assert.equal(id, "electron", "the preload requires only electron");
      return {
        ipcRenderer: {
          send: (channel, message) => {
            assert.equal(channel, "tode:message");
            sent.push(message);
          },
        },
        webFrame: { setZoomFactor: (factor) => zoomFactors.push(factor) },
      };
    },
    document: { documentElement: { classList: { add: (c) => classes.push(c) } } },
    performance: {
      timeOrigin: 1000.4,
      getEntriesByType: (type) =>
        type === "navigation"
          ? [{ responseEnd: 12.6, domInteractive: 30.2, loadEventEnd: 80.9 }]
          : [
              { name: "code/didStartRenderer", startTime: 5.4 },
              { name: "code/didStartWorkbench", startTime: 50.5 },
              { name: "unrelated", startTime: 1 },
            ],
      getEntriesByName: (name) => (name === "code/didStartWorkbench" ? [{}] : []),
    },
    ...timers,
  };
  sandbox.window = { top: null };
  sandbox.window.top = sandbox.window;
  return sandbox;
}

test("the preload reports the workbench marks once the workbench is up", async () => {
  const sent = [];
  const classes = [];
  vm.runInNewContext(preloadSource({}), workbenchSandbox(sent, classes));
  // the poll notices the workbench mark within 25ms, the send follows 50ms on
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(classes, [], "no skeleton anywhere: the preload leaves the dom alone");
  const timing = JSON.parse(JSON.stringify(sent)).find((m) => m.type === "timing");
  assert.ok(timing, "the workbench marks were sent");
  assert.equal(timing.page.origin, 1000);
  assert.equal(timing.page.responseEnd, 13);
  assert.equal(timing.page.loadEnd, 81);
  assert.deepEqual(timing.page.marks, {
    "code/didStartRenderer": 5,
    "code/didStartWorkbench": 51,
  });
});

test("a child frame subscribes to themes but stays out of the timing story", async () => {
  const sent = [];
  const classes = [];
  const sandbox = workbenchSandbox(sent, classes);
  sandbox.window = { top: {} };
  vm.runInNewContext(preloadSource({}), sandbox);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(classes, []);
  assert.deepEqual(sent, []);
});

const IPC_STUB = "tode-test-ipc";

const mainCtx = (socketDir) => ({
  socketDir,
  timingFile: path.join(socketDir, "timing.json"),
  modules: {
    livesync: require.resolve("../dist/livesync.js"),
    generate: require.resolve("../dist/theme/generate.js"),
    ipc: IPC_STUB,
  },
});

// everything but the ipc module and electron is the real thing, so the theme
// really runs through parseRawColors and generateTheme before a socket
function loadMainScript(ctx, sendToWindow) {
  let onMessage = null;
  const sandbox = {
    require: (id) => {
      if (id === IPC_STUB) return { sendToExtension: sendToWindow };
      if (id === "electron") {
        return {
          ipcMain: {
            on: (channel, listener) => {
              assert.equal(channel, "tode:message");
              onMessage = (message) => listener(null, message);
            },
          },
        };
      }
      return require(id);
    },
  };
  // the pinned build requires the module for its side effects and calls
  // nothing, so running the source is the whole load
  vm.runInNewContext(mainScriptSource(ctx), sandbox);
  assert.ok(onMessage, "the main script subscribed to tode's ipc channel");
  return onMessage;
}

const themeMessage = () => ({
  type: "theme",
  colors: { background: [30, 32, 38], foreground: [220, 220, 220], ansi: [] },
});

test("the main script themes every window socket", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-glue-"));
  fs.writeFileSync(path.join(dir, "one.sock"), "");
  fs.writeFileSync(path.join(dir, "two.sock"), "");
  fs.writeFileSync(path.join(dir, "not-a-socket.txt"), "");
  const calls = [];
  const onMessage = loadMainScript(mainCtx(dir), (socket, request) => {
    calls.push({ socket, request });
    return Promise.resolve();
  });
  onMessage(themeMessage());
  assert.deepEqual(
    calls.map((call) => path.basename(call.socket)).sort(),
    ["one.sock", "two.sock"],
  );
  for (const { request } of calls) {
    const plain = JSON.parse(JSON.stringify(request));
    assert.deepEqual(plain.files, []);
    assert.deepEqual(plain.folders, []);
    assert.equal(plain.add, false);
    assert.equal(typeof plain.theme, "object");
  }
});

test("a dead socket is cleaned up after a refused send", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-glue-"));
  const gone = path.join(dir, "gone.sock");
  fs.writeFileSync(gone, "");
  const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  const onMessage = loadMainScript(mainCtx(dir), () => Promise.reject(refused));
  onMessage(themeMessage());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(gone), false);
});

test("the main script writes the workbench timing where tode timing reads it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-glue-"));
  const ctx = mainCtx(dir);
  const onMessage = loadMainScript(ctx, () => {
    throw new Error("a timing message must not touch the theme sockets");
  });
  const page = {
    at: 1,
    origin: 2,
    responseEnd: 3,
    domInteractive: 4,
    loadEnd: 5,
    marks: { "code/didStartWorkbench": 500 },
  };
  onMessage({ type: "timing", page });
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.timingFile, "utf8")), page);
  // a timing message without a page writes nothing and reaches no socket
  onMessage({ type: "timing" });
});

test("junk messages reach no socket", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-glue-"));
  fs.writeFileSync(path.join(dir, "one.sock"), "");
  const onMessage = loadMainScript(mainCtx(dir), () => {
    throw new Error("a junk message reached a socket");
  });
  onMessage(null);
  onMessage("theme");
  onMessage({ type: "open", colors: {} });
  onMessage({ type: "theme" });
});
