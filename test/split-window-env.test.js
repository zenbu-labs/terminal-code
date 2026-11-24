const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

// Swap pixel's terminal module for a fake Ghostty that records the command
// --split hands to the new pane, so no real terminal is needed.
const terminalPath = require.resolve("@zenbu-labs/pixel/terminal", { paths: [path.join(__dirname, "..", "dist")] });
const real = require(terminalPath);
const splits = [];
const fakeGhostty = {
  name: "ghostty",
  getCurrentPane: async () => ({ id: "pane-1", tab: "1:1", tty: "/dev/ttys001", command: null }),
  split: async (request) => {
    splits.push(request);
  },
};
require.cache[terminalPath].exports = {
  ...real,
  detect: () => fakeGhostty,
  canSplit: () => true,
  findOwner: () => null,
  callerTty: () => ({ path: "/dev/ttys001" }),
};

const { Pane } = require("../dist/launch.js");

test("--split starts the window process with ELECTRON_RUN_AS_NODE=1", async () => {
  delete process.env.PIXEL_EMBED;
  const pane = new Pane({ split: "right" });
  pane.open("http://127.0.0.1:8080/");
  assert.equal(await pane.exited(), 0);
  assert.equal(splits.length, 1);
  const command = splits[0].command;
  // A Ghostty split pane gets Ghostty's environment, not the caller's, so the
  // shim's `export ELECTRON_RUN_AS_NODE=1` does not reach it. Without it,
  // process.execPath (Electron Helper) boots Chromium instead of node.
  const exec = command.indexOf(process.execPath);
  assert.ok(exec >= 0, `command runs process.execPath: ${JSON.stringify(command)}`);
  assert.ok(
    command.slice(0, exec).includes("ELECTRON_RUN_AS_NODE=1"),
    `split command must set ELECTRON_RUN_AS_NODE=1 before ${process.execPath}, got ${JSON.stringify(command)}`,
  );
});
