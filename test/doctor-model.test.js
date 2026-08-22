const assert = require("node:assert/strict");
const { test } = require("node:test");

const { summarize } = require("../dist/doctor/model.js");

const check = (status, id = status) => ({
  id,
  status,
  severity: status === "error" ? "error" : "warning",
  fixable: status !== "needs_input",
  message: id,
});

const action = (status, id = status) => ({
  id,
  status,
  reversible: true,
  message: id,
  checkIds: [id],
});

test("summarize counts check and action outcomes", () => {
  assert.deepEqual(
    summarize(
      [check("ok"), check("warning"), check("needs_input"), check("skipped")],
      [action("changed"), action("blocked"), action("failed")],
    ),
    {
      status: "error",
      checks: 4,
      ok: 1,
      warnings: 1,
      errors: 0,
      needsInput: 1,
      changed: 1,
      blocked: 1,
      failed: 1,
      exitCode: 1,
    },
  );
});

test("needs_input maps to exit code 2 when no error exists", () => {
  assert.equal(summarize([check("needs_input")], []).exitCode, 2);
  assert.equal(summarize([check("needs_input")], []).status, "needs_input");
});

test("warning does not fail a healthy report", () => {
  const result = summarize([check("ok"), check("warning")], [action("unchanged")]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "warning");
});

test("error and failed action take precedence over needs_input", () => {
  assert.equal(summarize([check("error"), check("needs_input")], []).exitCode, 1);
  assert.equal(summarize([check("needs_input")], [action("failed")]).exitCode, 1);
});

test("empty checks are healthy", () => {
  assert.deepEqual(summarize([], []), {
    status: "ok",
    checks: 0,
    ok: 0,
    warnings: 0,
    errors: 0,
    needsInput: 0,
    changed: 0,
    blocked: 0,
    failed: 0,
    exitCode: 0,
  });
});

test("blocked needs_input action maps to exit code 2", () => {
  const result = summarize([], [{ ...action("blocked"), details: { reason: "needs_input" } }]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "needs_input");
});
