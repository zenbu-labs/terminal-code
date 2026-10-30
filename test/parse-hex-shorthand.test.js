const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseHex } = require("../dist/theme/color.js");

test("parseHex accepts the 3-digit shorthand", () => {
  assert.deepEqual(parseHex("#fff"), [255, 255, 255]);
  assert.deepEqual(parseHex("#000"), [0, 0, 0]);
  assert.deepEqual(parseHex("#f80"), [255, 136, 0]);
  assert.deepEqual(parseHex("abc"), [170, 187, 204]);
});
