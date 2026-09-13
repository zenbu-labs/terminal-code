const assert = require("node:assert/strict");
const { test } = require("node:test");

const { collectDoctorContext } = require("../dist/doctor/context.js");
const { checkShortcuts } = require("../dist/doctor/checks.js");

const context = collectDoctorContext({
  env: { ...process.env, TERM_PROGRAM: "ghostty" },
  tty: { stdin: true, stdout: true, stderr: true },
  exists: () => true,
});

const provider = (overrides = {}) => ({
  id: "fake",
  name: "Fake Terminal",
  detect: () => true,
  ready: () => null,
  scan: () => [],
  takenAs: () => null,
  trigger: (chord) => chord,
  describe: (action) => action,
  apply: () => {
    throw new Error("mutation must not run during check");
  },
  onApplied: () => {
    throw new Error("reload must not run during check");
  },
  undo: () => {
    throw new Error("undo must not run during check");
  },
  reloadHint: () => "reload",
  ...overrides,
});

test("unsupported provider is reported without a repair action", () => {
  const result = checkShortcuts(context, { provider: null, decisions: null });
  assert.equal(result.status, "warning");
  assert.equal(result.fixable, false);
});

test("provider readiness failure is reported without scanning or mutating", () => {
  let scanned = false;
  const result = checkShortcuts(context, {
    provider: provider({
      ready: () => "terminal config is not ready",
      scan: () => {
        scanned = true;
        return [];
      },
    }),
    decisions: null,
  });
  assert.equal(result.status, "warning");
  assert.equal(result.message, "terminal config is not ready");
  assert.equal(scanned, false);
});

test("unresolved conflicts require user input", () => {
  const result = checkShortcuts(context, {
    provider: provider({
      scan: () => [{ editorId: "cmd+x", shared: undefined }],
    }),
    decisions: null,
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.fixable, false);
  assert.deepEqual(result.actionIds, ["shortcuts.apply-decisions"]);
  assert.equal(result.details.unresolved, 1);
});

test("saved decisions and shared conflicts are repairable", () => {
  const conflicts = [
    { editorId: "cmd+x" },
    { editorId: "cmd+y", shared: { action: "copy", note: "shared" } },
  ];
  const result = checkShortcuts(context, {
    provider: provider({ scan: () => conflicts }),
    decisions: {
      version: 1,
      terminal: "fake",
      choices: { "cmd+x": { choice: "terminal" } },
    },
  });
  assert.equal(result.status, "warning");
  assert.equal(result.fixable, true);
  assert.equal(result.details.conflicts, 2);
  assert.deepEqual(result.actionIds, ["shortcuts.apply-decisions"]);
});

test("provider scan errors are captured as check errors", () => {
  const result = checkShortcuts(context, {
    provider: provider({ scan: () => { throw new Error("cannot inspect terminal"); } }),
    decisions: null,
  });
  assert.equal(result.status, "error");
  assert.equal(result.fixable, false);
  assert.equal(result.message, "cannot inspect terminal");
});
