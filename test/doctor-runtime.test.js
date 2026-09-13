const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const {
  PINNED_VERSION,
  electronEntry,
  inspectRuntime,
} = require("../dist/runtime/release.js");
const {
  CODE_SERVER_VERSION,
  inspectCodeServer,
} = require("../dist/codeserver/vendored.js");

function runtimeFixture(root, version = PINNED_VERSION) {
  const files = new Set([
    path.join(root, "VERSION"),
    path.join(root, "cli", "dist", "main.js"),
    electronEntry(root),
  ]);
  return {
    exists: (file) => files.has(file),
    readVersion: (candidate) => candidate === root ? version : null,
  };
}

test("inspects a valid vendored runtime without creating a launcher", () => {
  const root = "/fixture/vendored";
  const result = inspectRuntime({
    vendoredRoot: root,
    pinnedRoot: "/fixture/pinned",
    systemRoot: "/fixture/system",
    ...runtimeFixture(root),
  });

  assert.deepEqual(result, {
    source: "vendored",
    version: PINNED_VERSION,
    root,
    binary: path.join(root, "bin", "terminal-browser"),
    valid: true,
  });
});

test("distinguishes missing and invalid runtime trees", () => {
  const missing = inspectRuntime({
    vendoredRoot: "/fixture/vendored",
    pinnedRoot: "/fixture/pinned",
    systemRoot: "/fixture/system",
    exists: () => false,
    readVersion: () => null,
  });
  assert.equal(missing.source, "missing");
  assert.equal(missing.valid, false);

  const invalid = inspectRuntime({
    vendoredRoot: "/fixture/vendored",
    pinnedRoot: "/fixture/pinned",
    systemRoot: "/fixture/system",
    exists: (file) => file.endsWith("/VERSION"),
    readVersion: (root) => root === "/fixture/vendored" ? PINNED_VERSION : null,
  });
  assert.equal(invalid.source, "invalid");
  assert.equal(invalid.reason, "runtime is missing a required executable");
});

test("inspects an explicit runtime override without probing release endpoints", () => {
  const result = inspectRuntime({
    override: "/fixture/runtime/bin/terminal-browser",
    exists: (file) => file === "/fixture/runtime/bin/terminal-browser",
    readVersion: (root) => root === "/fixture/runtime" ? "dev" : null,
  });

  assert.equal(result.source, "override");
  assert.equal(result.valid, true);
  assert.equal(result.version, "dev");
});

test("inspects pinned code-server binary without provisioning", () => {
  const root = "/fixture/code-server";
  const binary = path.join(root, "bin", "code-server");
  const result = inspectCodeServer({
    root,
    exists: (file) => file === binary,
  });

  assert.deepEqual(result, {
    source: "pinned",
    version: CODE_SERVER_VERSION,
    root,
    binary,
    valid: true,
  });
});

test("reports missing configured code-server override", () => {
  const result = inspectCodeServer({
    override: "/fixture/missing-code-server",
    exists: () => false,
  });

  assert.equal(result.source, "invalid");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "code-server binary is not present");
});
