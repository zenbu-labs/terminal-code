const assert = require("node:assert/strict");
const { test } = require("node:test");

const { collectDoctorContext } = require("../dist/doctor/context.js");
const { checkGeneratedProfile } = require("../dist/doctor/checks.js");

test("reports all generated profile artifacts when they are missing", () => {
  const result = checkGeneratedProfile(collectDoctorContext({ exists: () => false }));

  assert.equal(result.id, "profile.generatedState");
  assert.equal(result.status, "warning");
  assert.equal(result.fixable, true);
  assert.deepEqual(result.details.missing, [
    "font",
    "css",
    "liveTheme",
    "settings",
    "keybindingsRecord",
    "extensionsRegistry",
    "bridgeManifest",
    "bridgeSource",
  ]);
});

test("reports generated profile as healthy without inspecting user file contents", () => {
  const checked = [];
  const result = checkGeneratedProfile(
    collectDoctorContext({
      exists: (file) => {
        checked.push(file);
        return true;
      },
    }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(result.details, undefined);
  assert.ok(checked.length > 0);
});
