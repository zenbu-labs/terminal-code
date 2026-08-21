const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

/* the modules below resolve their homes at load time, so the scratch ones have
   to be in the environment before the first require */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tode-vscode-"));
process.env.XDG_DATA_HOME = path.join(HOME, "share");
process.env.XDG_STATE_HOME = path.join(HOME, "state");
delete process.env.TODE_VSCODE_CLI;

const {
  CLI_DATA_DIR,
  CLI_DIR,
  ensureVscodeCli,
  installedVscodeCli,
  installedVscodeServer,
  latestCli,
} = require("../dist/codeserver/vendored.js");
const { serveWebArgs } = require("../dist/codeserver/server.js");

/** an update service that answers exactly like update.code.visualstudio.com */
async function updateService(answer, asset) {
  const server = http.createServer((request, response) => {
    if (asset && request.url === "/asset") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(asset);
      return;
    }
    if (!answer) {
      response.writeHead(404);
      response.end("nope");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    // fetch keeps its sockets alive, so they are dropped rather than waited for
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** the shape the cli ships in: one gzipped tar holding the `code` binary */
function cliTarball(body) {
  const scratch = fs.mkdtempSync(path.join(HOME, "pack-"));
  fs.writeFileSync(path.join(scratch, "code"), body);
  const tarball = path.join(scratch, "cli.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", scratch, "code"]);
  return fs.readFileSync(tarball);
}

function withOrigin(origin, run) {
  const previous = process.env.TODE_VSCODE_UPDATE_ORIGIN;
  process.env.TODE_VSCODE_UPDATE_ORIGIN = origin;
  return run().finally(() => {
    if (previous === undefined) delete process.env.TODE_VSCODE_UPDATE_ORIGIN;
    else process.env.TODE_VSCODE_UPDATE_ORIGIN = previous;
  });
}

test("the workbench is served by code serve-web, on loopback, out of tode's own dirs", () => {
  const args = serveWebArgs(41234);
  assert.equal(args[0], "serve-web", "the real cli's own web server, not a fork");
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--host"), "127.0.0.1", "never reachable off this machine");
  assert.equal(value("--port"), "41234");
  assert.ok(args.includes("--without-connection-token"), "the injector is the only client");
  assert.ok(args.includes("--accept-server-license-terms"), "otherwise it stops and asks");
  assert.ok(args.includes("--disable-telemetry"));
  // the server derives its user data and extensions from --server-data-dir; a
  // --user-data-dir would be ignored, so the profile has to live under this one
  assert.equal(value("--server-data-dir"), path.join(process.env.XDG_DATA_HOME, "tode", "vscode"));
  assert.equal(value("--cli-data-dir"), CLI_DATA_DIR, "servers land in tode's tree, not ~/.vscode-cli");
  const { USER_DIR, EXTENSIONS_DIR } = require("../dist/profile.js");
  assert.equal(USER_DIR, path.join(value("--server-data-dir"), "data", "User"));
  assert.equal(EXTENSIONS_DIR, path.join(value("--server-data-dir"), "extensions"));
});

test("the cli that gets fetched is the one the update service names for this machine", async () => {
  const service = await updateService({
    url: "unused",
    version: "cafe1234",
    productVersion: "1.105.2",
    sha256hash: "deadbeef",
    size: 12,
  });
  try {
    const release = await withOrigin(service.origin, () => latestCli());
    assert.equal(release.version, "1.105.2");
    assert.equal(release.commit, "cafe1234", "the version field of the document is the commit");
    assert.equal(release.sha256, "deadbeef");
  } finally {
    await service.close();
  }
});

test("an update service with nothing to offer is reported, not half-installed", async () => {
  const service = await updateService({ version: "cafe1234" });
  try {
    await assert.rejects(
      withOrigin(service.origin, () => latestCli()),
      /did not name a cli-.* build to download/,
    );
  } finally {
    await service.close();
  }
  const gone = await updateService(null);
  try {
    await assert.rejects(
      withOrigin(gone.origin, () => latestCli()),
      /did not answer \(404/,
    );
  } finally {
    await gone.close();
  }
});

test("the downloaded cli is checked against the digest the service published", async () => {
  const asset = cliTarball("#!/bin/sh\necho 1.105.2\n");
  const sha256 = crypto.createHash("sha256").update(asset).digest("hex");
  const service = await updateService(
    { url: null, version: "cafe1234", productVersion: "1.105.2", sha256hash: sha256, size: asset.length },
    asset,
  );
  try {
    // a tampered download is refused and nothing is left behind to be run
    const bad = await updateService(
      {
        url: `${service.origin}/asset`,
        version: "cafe1234",
        productVersion: "9.9.9",
        sha256hash: crypto.createHash("sha256").update("something else").digest("hex"),
        size: asset.length,
      },
      asset,
    );
    await assert.rejects(withOrigin(bad.origin, () => ensureVscodeCli()), /download corrupted/);
    await bad.close();
    assert.equal(installedVscodeCli(), null, "a corrupted download installs nothing");

    const good = await updateService(
      {
        url: `${service.origin}/asset`,
        version: "cafe1234",
        productVersion: "1.105.2",
        sha256hash: sha256,
        size: asset.length,
      },
      asset,
    );
    const bin = await withOrigin(good.origin, () => ensureVscodeCli());
    await good.close();
    assert.equal(bin, path.join(CLI_DIR, "1.105.2", "code"));
    assert.ok(fs.statSync(bin).mode & 0o111, "the cli is executable");
    assert.equal(installedVscodeCli(), bin, "and is found again without another download");
  } finally {
    await service.close();
    fs.rmSync(CLI_DIR, { recursive: true, force: true });
  }
});

test("a version that would escape the cli directory is refused, not turned into a path", async () => {
  for (const productVersion of ["../../../../tmp/pwned", "1.105.2/../..", ".", "..", "-rf", "/etc"]) {
    const service = await updateService({
      url: "http://127.0.0.1:1/asset",
      version: "cafe1234",
      productVersion,
      sha256hash: "deadbeef",
      size: 1,
    });
    try {
      await assert.rejects(
        withOrigin(service.origin, () => latestCli()),
        /will not use as a path/,
        `${productVersion} should never become a directory name`,
      );
    } finally {
      await service.close();
    }
  }
  assert.equal(installedVscodeCli(), null, "and nothing was written for any of them");
});

test("extension commands find the server serve-web downloaded, never a half-written one", () => {
  const cache = path.join(CLI_DATA_DIR, "serve-web");
  fs.rmSync(cache, { recursive: true, force: true });
  assert.equal(installedVscodeServer(), null, "nothing to find before the first window");

  const landed = path.join(cache, "aaaa1111", "bin", "code-server");
  fs.mkdirSync(path.dirname(landed), { recursive: true });
  fs.writeFileSync(landed, "#!/bin/sh\n");
  // the cli stages a download beside the finished ones and keeps an lru index
  const staging = path.join(cache, "bbbb2222.staging", "bin", "code-server");
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  fs.writeFileSync(staging, "#!/bin/sh\n");
  fs.writeFileSync(path.join(cache, "lru.json"), "{}");

  assert.equal(installedVscodeServer(), landed);

  const newer = path.join(cache, "cccc3333", "bin", "code-server");
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.writeFileSync(newer, "#!/bin/sh\n");
  const later = Date.now() / 1000 + 60;
  fs.utimesSync(newer, later, later);
  assert.equal(installedVscodeServer(), newer, "the newest server wins after an update");
});
