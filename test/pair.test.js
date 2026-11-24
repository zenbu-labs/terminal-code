const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pair-"));
process.env.XDG_STATE_HOME = path.join(HOME, "state");
process.env.XDG_DATA_HOME = path.join(HOME, "data");

const { Mux } = require("../dist/pair/link.js");
const { socksServer } = require("../dist/pair/socks.js");
const { judge, isTailnetAddress } = require("../dist/pair/tailscale.js");
const { sshEndpoints, nextSteps, thisServer } = require("../dist/pair/attempt.js");
const { link, localAddress, targets } = require("../dist/pair/remote.js");
const { sshTarget } = require("../dist/pair/tunnel.js");
const { serveLink } = require("../dist/pair/screen.js");
const { authorizePeer } = require("../dist/pair/listener.js");
const { LINK_PROTOCOL, TUNNELS_DIR } = require("../dist/pair/settings.js");

function socketPair() {
  return new Promise((resolve) => {
    const server = net.createServer((accepted) => {
      server.close();
      resolve([client, accepted]);
    });
    let client;
    server.listen(0, "127.0.0.1", () => {
      client = net.connect(server.address().port, "127.0.0.1");
    });
  });
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

test("the link carries controls, pixel messages and channels both ways", async () => {
  const [a, b] = await socketPair();
  const opener = new Mux(a, true);
  const other = new Mux(b, false);
  const controls = [];
  other.onControl = (message) => controls.push(message);
  const pixels = [];
  other.onPixel = (message) => pixels.push(Buffer.from(message).toString());
  const opened = new Promise((resolve) => {
    other.onOpen = (channel, info) => resolve({ channel, info });
  });

  opener.control({ type: "hello", n: 1 });
  opener.pixel(new Uint8Array(Buffer.from("frame")));
  const channel = opener.open({ type: "connect", port: 9 });
  const { channel: far, info } = await opened;
  assert.deepEqual(controls, [{ type: "hello", n: 1 }]);
  assert.deepEqual(pixels, ["frame"]);
  assert.equal(info.port, 9);

  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const received = [];
  far.on("data", (chunk) => received.push(chunk));
  const ended = once(far, "end");
  channel.end(big);
  await ended;
  assert.ok(Buffer.concat(received).equals(big));

  const closed = new Promise((resolve) => other.onClose(resolve));
  opener.close();
  await closed;
});

test("the window proxy only reaches the server's own code-server", async () => {
  const [a, b] = await socketPair();
  const screen = new Mux(a, true);
  const server = new Mux(b, false);
  server.onOpen = (channel, info) => {
    assert.equal(info.port, 41234);
    channel.on("data", (chunk) => channel.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  };
  const front = await socksServer(41234, () => screen.open({ type: "connect", port: 41234 }));

  const connect = (host, port) =>
    new Promise((resolve) => {
      const client = net.connect(front.port, "127.0.0.1");
      const chunks = [];
      client.on("data", (chunk) => chunks.push(chunk));
      client.on("connect", () => {
        client.write(Buffer.from([5, 1, 0]));
        const ip = host.split(".").map(Number);
        const request = Buffer.from([5, 1, 0, 1, ...ip, port >> 8, port & 255]);
        setTimeout(() => client.write(Buffer.concat([request, Buffer.from("ping")])), 20);
      });
      setTimeout(() => {
        client.destroy();
        resolve(Buffer.concat(chunks));
      }, 300);
    });

  const allowed = await connect("127.0.0.1", 41234);
  assert.deepEqual([...allowed.subarray(0, 4)], [5, 0, 5, 0]);
  assert.equal(allowed.subarray(12).toString(), "echo:ping");

  const otherPort = await connect("127.0.0.1", 22);
  assert.equal(otherPort[3], 2, "another loopback port is refused");
  const elsewhere = await connect("10.0.0.1", 41234);
  assert.equal(elsewhere[3], 2, "another host is refused");

  front.server.close();
  screen.close();
});

test("only your own untagged devices, or ones you named, are trusted", () => {
  const me = { userId: 1, login: "rob@zenbu.dev", host: "laptop", dnsName: "laptop.ts.net" };
  const mine = { userId: 1, login: "rob@zenbu.dev", host: "mini", dnsName: "mini.ts.net", tags: [] };
  const theirs = { userId: 2, login: "eve@x.dev", host: "evebox", dnsName: "evebox.ts.net", tags: [] };
  const tagged = { userId: 99, login: "tagged-devices", host: "ci", dnsName: "ci.ts.net", tags: ["tag:server"] };
  assert.equal(judge(me, mine, []).ok, true);
  assert.equal(judge(me, theirs, []).ok, false);
  assert.match(judge(me, theirs, []).why, /belongs to eve@x.dev/);
  assert.equal(judge(me, tagged, []).ok, false);
  assert.match(judge(me, tagged, []).why, /tagged/);
  assert.equal(judge(me, tagged, ["CI"]).ok, true);
  assert.equal(judge(me, { ...mine, tags: ["tag:x"] }, []).ok, false, "a tag overrides ownership");
});

test("tailnet addresses and the ssh client address", () => {
  assert.equal(isTailnetAddress("100.84.69.30"), true);
  assert.equal(isTailnetAddress("::ffff:100.64.0.1"), true);
  assert.equal(isTailnetAddress("100.128.0.1"), false);
  assert.equal(isTailnetAddress("fd7a:115c:a1e0::1"), true);
  assert.equal(isTailnetAddress("192.168.64.1"), false);
  assert.deepEqual(sshEndpoints({ SSH_CONNECTION: "100.84.69.30 50000 100.117.136.47 22" }), {
    client: "100.84.69.30",
    server: "100.117.136.47",
    port: "22",
  });
  assert.equal(localAddress({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22", TERMINAL_CODE_LOCAL_RENDERING_ADDRESS: "9.9.9.9" }), "9.9.9.9");
  assert.equal(localAddress({}), null);
});

test("a peer outside the tailnet is refused unless its network is trusted", async () => {
  const refused = await authorizePeer("192.168.64.13", {})({});
  assert.equal(refused.ok, false);
  assert.match(refused.why, /not a tailnet address/);
  assert.equal(refused.reason, "off-tailnet");
  const failure = { route: "direct", target: "x", reason: "off-tailnet", detail: refused.why };
  assert.match(nextSteps(failure).join("\n"), /--setup-ssh/);
  const trusted = await authorizePeer("::ffff:192.168.64.13", { TERMINAL_CODE_LOCAL_RENDERING_TRUST: "192.168.64.0/24" })({});
  assert.equal(trusted.ok, true);
});

async function screenOn(authorize, range) {
  const server = net.createServer((socket) => {
    void serveLink(socket, { authorize, log: () => {} });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = { route: "direct", label: "test", connect: { host: "127.0.0.1", port: server.address().port } };
  return { server, target };
}

test("the handshake says why a screen won't render", async () => {
  const allow = async () => ({ ok: true, who: "me" });
  const deny = async () => ({ ok: false, who: "eve", why: "evebox belongs to eve@x.dev" });

  const open = await screenOn(allow);
  const welcomed = await link(open.target, true);
  assert.ok(!("reason" in welcomed), JSON.stringify(welcomed));
  assert.equal(welcomed.welcome.type, "welcome");
  welcomed.mux.close();
  open.server.close();

  const closed = await screenOn(deny);
  const denied = await link(closed.target, true);
  assert.equal(denied.reason, "not-allowed");
  assert.match(denied.detail, /eve@x.dev/);
  assert.match(nextSteps(denied).join("\n"), /--allow-peer/);
  closed.server.close();
});

test("a link protocol the other side doesn't speak names the older side", async () => {
  const server = net.createServer((socket) => {
    const mux = new Mux(socket, true);
    mux.onControl = () => mux.control({ type: "refused", reason: "link", version: "9.9.9", link: [LINK_PROTOCOL[1] + 1, LINK_PROTOCOL[1] + 2] });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const failure = await link({ route: "direct", label: "test", connect: { host: "127.0.0.1", port: server.address().port } }, true);
  assert.equal(failure.reason, "server-too-old");
  assert.equal(failure.peerVersion, "9.9.9");
  assert.match(nextSteps(failure).join("\n"), /--upgrade/);
  server.close();
});

test("nothing listening and nothing reachable are told apart", async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  probe.close();
  const refused = await link({ route: "direct", label: "test", connect: { host: "127.0.0.1", port } }, true);
  assert.equal(refused.reason, "not-listening");
  assert.match(nextSteps(refused).join("\n"), /install\/upgrade terminal-code[\s\S]*--enable-local-rendering-over-ssh/);

  const unreachable = await link({ route: "direct", label: "test", connect: { host: "192.0.2.1", port: 47291 } }, true);
  assert.equal(unreachable.reason, "unreachable");
  assert.match(nextSteps(unreachable).join("\n"), /--setup-ssh/);
});

test("the tunnel's socket is private and goes away with the connection", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "dist", "main.js"), "--local-rendering-tunnel"], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let seen = Buffer.alloc(0);
  await new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      seen = Buffer.concat([seen, chunk]);
      if (seen.includes(Buffer.from('"type":"tunnel"'))) resolve();
    });
  });
  assert.ok(seen.toString().startsWith("\nterminal-code-tunnel\n"));
  const socketFile = path.join(TUNNELS_DIR, `${child.pid}.sock`);
  assert.equal(fs.statSync(socketFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(TUNNELS_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(TUNNELS_DIR)).mode & 0o777, 0o700);

  const exited = once(child, "exit");
  child.stdin.end();
  await exited;
  assert.equal(fs.existsSync(socketFile), false);
});

test("the server only connects directly to a tailnet or trusted address", async () => {
  const target = { route: "direct", label: "10.1.2.3:47291", connect: { host: "10.1.2.3", port: 47291 }, address: "10.1.2.3" };
  const refused = await link(target, true);
  assert.equal(refused.reason, "untrusted-address");
  assert.match(nextSteps(refused).join("\n"), /--setup-ssh/);

  process.env.TERMINAL_CODE_LOCAL_RENDERING_TRUST = "127.0.0.1";
  try {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    probe.close();
    const local = { route: "direct", label: "local", connect: { host: "127.0.0.1", port }, address: "127.0.0.1" };
    assert.equal((await link(local, true)).reason, "not-listening");
  } finally {
    delete process.env.TERMINAL_CODE_LOCAL_RENDERING_TRUST;
  }
});

test("turning local rendering off on the server stops tunnels too", () => {
  fs.mkdirSync(TUNNELS_DIR, { recursive: true });
  const socketFile = path.join(TUNNELS_DIR, `${process.pid}.sock`);
  fs.writeFileSync(socketFile, "");
  try {
    assert.deepEqual(targets(false), []);
    assert.ok(targets(true).some((t) => t.route === "tunnel"));
  } finally {
    fs.rmSync(socketFile, { force: true });
  }
});

test("the suggested --setup-ssh command carries the port, and ipv6 parses", () => {
  const user = os.userInfo().username;
  assert.equal(thisServer({ SSH_CONNECTION: "100.84.69.30 50000 100.117.136.47 22" }), `${user}@100.117.136.47`);
  assert.equal(thisServer({ SSH_CONNECTION: "100.84.69.30 50000 fd7a:115c:a1e0::1 2222" }), `${user}@fd7a:115c:a1e0::1 -p 2222`);
  assert.deepEqual(sshTarget(`${user}@fd7a:115c:a1e0::1 -p 2222`), { destination: `${user}@fd7a:115c:a1e0::1`, hostArgs: ["-p", "2222"] });
  assert.deepEqual(sshTarget("rob@[fd7a::1]"), { destination: "rob@fd7a::1", hostArgs: [] });
  assert.equal(sshTarget("rob@dev-mini").destination, "rob@dev-mini");
  assert.equal(sshTarget(""), null);
});
