const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "dist", "main.js");

function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-doctor-cli-"));
  const env = { ...process.env };
  env.HOME = home;
  env.XDG_DATA_HOME = path.join(home, "data");
  env.XDG_STATE_HOME = path.join(home, "state");
  env.XDG_CACHE_HOME = path.join(home, "cache");
  delete env.TODE_CODE_SERVER;
  delete env.TODE_TERMINAL_BROWSER_BIN;
  delete env.TERM_PROGRAM;
  delete env.GHOSTTY_RESOURCES_DIR;
  delete env.TERM;
  delete env.KITTY_WINDOW_ID;
  delete env.KITTY_PID;
  return env;
}

test("built doctor JSON is one parseable stdout document", () => {
  const result = spawnSync(process.execPath, [entry, "doctor", "--json"], {
    cwd: root,
    env: isolatedEnv(),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 64);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.command, { fix: false, json: true });
  assert.ok(Array.isArray(report.checks));
  assert.ok(Array.isArray(report.actions));
});

test("invalid doctor JSON options return a JSON usage report with exit 64", () => {
  const result = spawnSync(process.execPath, [entry, "doctor", "--json", "--unknown"], {
    cwd: root,
    env: isolatedEnv(),
    encoding: "utf8",
  });
  assert.equal(result.status, 64);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.exitCode, 64);
  assert.equal(report.checks[0].id, "command.usage");
});
