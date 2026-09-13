const assert = require("node:assert/strict");
const { test } = require("node:test");

const { runDoctor } = require("../dist/doctor/orchestrator.js");
const { serializeDoctorJson } = require("../dist/doctor/report.js");

const context = {
  environment: {
    platform: "darwin",
    architecture: "arm64",
    targetTriple: "darwin-arm64",
    tty: { stdin: false, stdout: false, stderr: false },
    terminalProvider: null,
  },
  paths: {
    install: "/managed/install",
    vendor: "/managed/vendor",
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
  exists: () => true,
};

const check = (status, id = "example.check") => ({
  id,
  status,
  severity: status === "error" ? "error" : status === "warning" || status === "needs_input" ? "warning" : "info",
  fixable: status !== "ok",
  message: status,
});

test("check-only runs the registry once and emits one JSON document", async () => {
  let collections = 0;
  const report = await runDoctor(
    { json: true, fix: false },
    {
      context,
      now: () => 1000,
      collectChecks: async () => {
        collections += 1;
        return [check("ok")];
      },
    },
  );
  assert.equal(collections, 1);
  assert.equal(report.summary.exitCode, 0);
  const encoded = serializeDoctorJson(report);
  assert.equal(encoded.split("\n").filter(Boolean).length > 1, true);
  assert.deepEqual(JSON.parse(encoded), report);
});

test("fix runs initial checks, repairs, and final checks", async () => {
  let collections = 0;
  let repaired = false;
  const report = await runDoctor(
    { json: true, fix: true },
    {
      context,
      now: () => 2000,
      collectChecks: async () => {
        collections += 1;
        return [check(repaired ? "ok" : "warning")];
      },
      repairChecks: async () => {
        repaired = true;
        return [{ id: "example.repair", status: "changed", reversible: true, message: "changed", checkIds: ["example.check"] }];
      },
    },
  );
  assert.equal(collections, 2);
  assert.equal(report.summary.status, "ok");
  assert.equal(report.summary.changed, 1);
  assert.equal(report.summary.exitCode, 0);
});

test("collector exceptions become a report error", async () => {
  const report = await runDoctor(
    { json: true, fix: false },
    { context, collectChecks: async () => { throw new Error("read failed"); } },
  );
  assert.equal(report.checks[0].id, "doctor.checks");
  assert.equal(report.summary.exitCode, 1);
});

test("needs_input remains exit code 2 without a failed action", async () => {
  const report = await runDoctor(
    { json: true, fix: true },
    {
      context,
      collectChecks: async () => [check("needs_input", "shortcuts.configuration")],
      repairChecks: async () => [{
        id: "shortcuts.needs-input",
        status: "blocked",
        reversible: true,
        message: "left unchanged",
        checkIds: ["shortcuts.configuration"],
      }],
    },
  );
  assert.equal(report.summary.exitCode, 2);
  assert.equal(report.summary.blocked, 1);
  assert.equal(report.summary.failed, 0);
});
