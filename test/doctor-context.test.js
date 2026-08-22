const assert = require("node:assert/strict");
const { test } = require("node:test");

const { collectDoctorContext } = require("../dist/doctor/context.js");

test("collects platform, runtime, terminal and managed paths without writing", () => {
  const seen = [];
  const context = collectDoctorContext({
    env: { ...process.env, TERM_PROGRAM: "ghostty" },
    tty: { stdin: true, stdout: true, stderr: true },
    codeServerBinary: "/fixture/code-server",
    exists: (file) => {
      seen.push(file);
      return false;
    },
  });

  assert.equal(context.environment.terminalProvider.id, "ghostty");
  assert.equal(context.environment.tty.stdout, true);
  assert.equal(context.runtime.codeServerBinary, "/fixture/code-server");
  assert.ok(context.runtime.terminalBrowserVersion);
  assert.ok(context.paths.data);
  assert.deepEqual(seen, []);
});

test("unsupported environment does not fabricate a provider", () => {
  const context = collectDoctorContext({
    env: { ...process.env, TERM_PROGRAM: "unknown", TERM: "dumb" },
    tty: { stdin: false, stdout: false, stderr: false },
    exists: () => false,
  });

  assert.equal(context.environment.terminalProvider, null);
  assert.equal(context.environment.tty.stdout, false);
});
