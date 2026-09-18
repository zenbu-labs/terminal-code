const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { test } = require("node:test");

const { explain, includeSystemCertificates, untrustedCertificate } = require("../dist/runtime/net.js");

function store(certificates) {
  return {
    set: [],
    getCACertificates(type) {
      if (!(type in certificates)) throw new Error(`no ${type} store`);
      return certificates[type];
    },
    setDefaultCACertificates(certs) {
      this.set.push([...certs]);
    },
  };
}

test("the system roots join the bundled ones", () => {
  const merging = store({ default: ["bundled"], system: ["proxy"] });
  includeSystemCertificates(merging);
  assert.deepEqual(merging.set, [["bundled", "proxy"]]);
});

test("a store this runtime cannot read leaves trust as it was", () => {
  assert.doesNotThrow(() => includeSystemCertificates({}));
  const unreadable = store({ default: ["bundled"] });
  includeSystemCertificates(unreadable);
  assert.deepEqual(unreadable.set, []);
});

test("an untrusted chain is recognised through the cause chain", () => {
  const cause = Object.assign(new Error("self signed certificate in certificate chain"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });
  assert.equal(untrustedCertificate(new TypeError("fetch failed", { cause })), true);
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(untrustedCertificate(new TypeError("fetch failed", { cause: refused })), false);
});

test("a failure reports the reason fetch hides on the cause", () => {
  const reset = Object.assign(new Error("Client network socket disconnected"), {
    code: "ECONNRESET",
  });
  assert.equal(
    explain(new TypeError("fetch failed", { cause: reset })),
    "fetch failed: Client network socket disconnected (ECONNRESET)",
  );
  // a code the message already carries would only be noise
  const missing = Object.assign(new Error("getaddrinfo ENOTFOUND tode.sh"), { code: "ENOTFOUND" });
  assert.equal(
    explain(new TypeError("fetch failed", { cause: missing })),
    "fetch failed: getaddrinfo ENOTFOUND tode.sh",
  );
  const untrusted = Object.assign(new Error("self signed certificate in certificate chain"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });
  assert.match(explain(new TypeError("fetch failed", { cause: untrusted })), /NODE_EXTRA_CA_CERTS/);
  assert.equal(explain("not an error at all"), "not an error at all");
});

// The real thing: a server signed by a root Node does not bundle is exactly
// the shape a TLS-inspecting proxy takes, and the merge has to reach a fetch
// whose TLS context was already built from the narrower list.
test("merging the system roots is what lets a download through", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-net-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ], { stdio: "ignore" });
  } catch {
    t.skip("openssl is not available to sign a test certificate");
    return;
  }

  const signed = fs.readFileSync(cert, "utf8");
  const server = https.createServer({ key: fs.readFileSync(key), cert: signed }, (_req, res) => {
    res.writeHead(200);
    res.end("a release manifest");
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((closed) => server.close(closed)));
  const url = `https://localhost:${server.address().port}/`;

  const bundled = tls.getCACertificates("default");
  t.after(() => tls.setDefaultCACertificates(bundled));
  await assert.rejects(fetch(url), (error) => untrustedCertificate(error));

  includeSystemCertificates({
    getCACertificates: (type) => (type === "system" ? [signed] : tls.getCACertificates(type)),
    setDefaultCACertificates: (certs) => tls.setDefaultCACertificates(certs),
  });
  const response = await fetch(url);
  assert.equal(await response.text(), "a release manifest");
});
