const assert = require("node:assert/strict");
const { test } = require("node:test");

const { checkDaemon } = require("../dist/doctor/checks.js");

const state = {
  pid: 101,
  port: 9001,
  injectorPid: 102,
  injectorPort: 9002,
  version: "4.132.0",
  startedAt: 1,
};

const probes = (overrides = {}) => ({
  alive: () => true,
  command: (pid) =>
    pid === state.pid
      ? "code-server --auth none --bind-addr 127.0.0.1:9001 --app-name tode"
      : "node injector-main.js 9001 9002",
  probePort: async () => true,
  ...overrides,
});

test("reports a healthy owned daemon", async () => {
  const result = await checkDaemon({ state, ...probes() });
  assert.equal(result.status, "ok");
  assert.equal(result.fixable, true);
});

test("reports absent daemon as repairable", async () => {
  const result = await checkDaemon({ state: null });
  assert.equal(result.status, "warning");
  assert.equal(result.fixable, true);
});

test("reports dead recorded processes as repairable stale state", async () => {
  const result = await checkDaemon({
    state,
    ...probes({ alive: (pid) => pid !== state.injectorPid }),
  });
  assert.equal(result.status, "warning");
  assert.deepEqual(result.details.deadPids, [state.injectorPid]);
});

test("blocks a live but unverified process", async () => {
  const result = await checkDaemon({
    state,
    ...probes({ command: () => "unrelated-process --bind-addr 127.0.0.1:9001" }),
  });
  assert.equal(result.status, "error");
  assert.equal(result.fixable, false);
  assert.deepEqual(result.details.unownedPids, [state.pid, state.injectorPid]);
});

test("reports an unresponsive owned endpoint", async () => {
  const result = await checkDaemon({
    state,
    ...probes({ probePort: async (port) => port === state.port }),
  });
  assert.equal(result.status, "error");
  assert.equal(result.fixable, true);
  assert.deepEqual(result.details, { upstream: true, injector: false });
});

test("blocks an unattributed process occupying a daemon port", async () => {
  const result = await checkDaemon({
    state,
    ...probes({ portOwner: (port) => (port === state.injectorPort ? 999 : port === state.port ? state.pid : null) }),
  });
  assert.equal(result.status, "error");
  assert.equal(result.fixable, false);
  assert.deepEqual(result.details.occupiedPorts, [{ port: state.injectorPort, pid: 999 }]);
});

test("reports malformed daemon state as a non-fixable error", async () => {
  const result = await checkDaemon({ state: { pid: 0 } });
  assert.equal(result.status, "error");
  assert.equal(result.fixable, false);
});
