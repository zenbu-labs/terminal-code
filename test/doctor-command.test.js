const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseDoctorArgs } = require("../dist/doctor/command.js");

test("parses no doctor flags as check-only text mode", () => {
  assert.deepEqual(parseDoctorArgs([]), { kind: "ok", options: { json: false, fix: false } });
});

test("parses json and fix flags in either order", () => {
  assert.deepEqual(parseDoctorArgs(["--json", "--fix"]), {
    kind: "ok",
    options: { json: true, fix: true },
  });
  assert.deepEqual(parseDoctorArgs(["--fix", "--json"]), {
    kind: "ok",
    options: { json: true, fix: true },
  });
});

test("rejects unknown options and positional arguments", () => {
  assert.deepEqual(parseDoctorArgs(["--verbose"]), {
    kind: "usage-error",
    message: "unknown doctor option --verbose",
  });
  assert.deepEqual(parseDoctorArgs(["path"]), {
    kind: "usage-error",
    message: "unknown doctor option path",
  });
});

test("does not mutate the input array", () => {
  const args = ["--json", "--fix"];
  const before = [...args];
  parseDoctorArgs(args);
  assert.deepEqual(args, before);
});
