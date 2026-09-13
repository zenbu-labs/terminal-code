const assert = require("node:assert/strict");
const { test } = require("node:test");

const { collectDoctorContext } = require("../dist/doctor/context.js");
const { collectReadOnlyChecks, checkManagedState } = require("../dist/doctor/checks.js");

test("reports supported terminal and TTY as healthy", () => {
  const context = collectDoctorContext({
    env: { ...process.env, TERM_PROGRAM: "ghostty" },
    tty: { stdin: true, stdout: true, stderr: true },
    exists: () => true,
  });

  const checks = collectReadOnlyChecks(context);
  assert.equal(checks.find((check) => check.id === "environment.platform").status, "ok");
  assert.equal(checks.find((check) => check.id === "environment.tty").status, "ok");
  assert.equal(checks.find((check) => check.id === "environment.terminal").status, "ok");
  assert.equal(checks.find((check) => check.id === "paths.managedState").status, "ok");
});

test("reports non-TTY and unknown terminal as warnings", () => {
  const context = collectDoctorContext({
    env: { ...process.env, TERM_PROGRAM: "unknown", TERM: "dumb" },
    tty: { stdin: false, stdout: false, stderr: false },
    exists: () => true,
  });

  const checks = collectReadOnlyChecks(context);
  assert.equal(checks.find((check) => check.id === "environment.tty").status, "warning");
  assert.equal(checks.find((check) => check.id === "environment.terminal").status, "warning");
});

test("missing managed directories are fixable and remain read-only", () => {
  const context = collectDoctorContext({ exists: () => false });
  const result = checkManagedState(context);

  assert.equal(result.id, "paths.managedState");
  assert.equal(result.status, "warning");
  assert.equal(result.fixable, true);
  assert.deepEqual(result.details.missing, ["data", "state", "cache", "runtime", "logs"]);
});
