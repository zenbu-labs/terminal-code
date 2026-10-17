const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createInjector,
  injectedCss,
  enterUrl,
  mintTicket,
  ticketValid,
  FONT_ROUTE,
  ENTER_ROUTE,
  SESSION_COOKIE,
  CODE_SERVER_COOKIE,
} = require("../dist/codeserver/inject.js");

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// an upgraded socket is detached from the server, so close() can wait forever on
// one. The listener is what matters here, so give up on the callback quickly.
const close = (server) =>
  new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.closeAllConnections?.();
    server.close(done);
    setTimeout(done, 100).unref();
  });

/** stands in for code-server, and remembers the headers it was handed */
function fakeUpstream(handler) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    handler(request, response);
  });
  server.on("upgrade", (request, socket) => {
    seen.push({ url: request.url, headers: request.headers, upgrade: true });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
    socket.write("hello-from-upstream");
  });
  return { server, seen };
}

async function withPair(handler, run, auth) {
  const { server: upstream, seen } = fakeUpstream(handler);
  const upstreamPort = await listen(upstream);
  const cssFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tode-css-")), "inject.css");
  fs.writeFileSync(cssFile, "html{background:#101010 !important;}");
  const proxy = createInjector(upstreamPort, cssFile, undefined, undefined, auth);
  const proxyPort = await listen(proxy);
  try {
    await run({ proxyPort, upstreamPort, seen, cssFile });
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

const get = async (port, headers = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
  return { status: response.status, body: await response.text(), headers: response.headers };
};

test("css lands in the html document before the head closes", async () => {
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head><title>x</title></head><body>hi</body></html>");
    },
    async ({ proxyPort }) => {
      const { body } = await get(proxyPort, { accept: "text/html" });
      assert.match(body, /<style id="tode-injected">html\{background:#101010 !important;\}<\/style><\/head>/);
      assert.match(body, /<body>hi<\/body>/);
    },
  );
});

test("content-length is corrected for the longer body", async () => {
  await withPair(
    (_request, response) => {
      const body = "<html><head></head><body>hi</body></html>";
      response.writeHead(200, { "content-type": "text/html", "content-length": String(body.length) });
      response.end(body);
    },
    async ({ proxyPort }) => {
      const { body, headers } = await get(proxyPort, { accept: "text/html" });
      assert.equal(Number(headers.get("content-length")), Buffer.byteLength(body));
    },
  );
});

test("anything that is not html goes through untouched", async () => {
  const payload = JSON.stringify({ hello: "world" });
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
    },
    async ({ proxyPort }) => {
      const { body } = await get(proxyPort);
      assert.equal(body, payload);
    },
  );
});

test("a document with no head still gets the css", async () => {
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<body>bare</body>");
    },
    async ({ proxyPort }) => {
      const { body } = await get(proxyPort, { accept: "text/html" });
      assert.match(body, /tode-injected/);
      assert.match(body, /bare/);
    },
  );
});

test("upstream is told the request came from itself", async () => {
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head></head></html>");
    },
    async ({ proxyPort, upstreamPort, seen }) => {
      await get(proxyPort, { accept: "text/html", origin: `http://127.0.0.1:${proxyPort}` });
      assert.equal(seen[0].headers.host, `127.0.0.1:${upstreamPort}`);
      assert.equal(seen[0].headers.origin, `http://127.0.0.1:${upstreamPort}`);
    },
  );
});

test("documents are requested uncompressed so they can be edited", async () => {
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head></head></html>");
    },
    async ({ proxyPort, seen }) => {
      await get(proxyPort, { accept: "text/html", "accept-encoding": "gzip, br" });
      assert.equal(seen[0].headers["accept-encoding"], "identity");
    },
  );
});

test("a websocket upgrade is carried across", async () => {
  await withPair(
    (_request, response) => response.end("unused"),
    async ({ proxyPort, seen }) => {
      const net = require("node:net");
      const received = await new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, "127.0.0.1", () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
          );
        });
        let text = "";
        socket.on("data", (chunk) => {
          text += chunk.toString("utf8");
          if (text.includes("hello-from-upstream")) {
            socket.destroy();
            resolve(text);
          }
        });
        socket.on("error", reject);
        setTimeout(() => reject(new Error("no upgrade within 2s")), 2000);
      });
      assert.match(received, /101 Switching Protocols/);
      assert.match(received, /hello-from-upstream/);
      assert.ok(seen.some((entry) => entry.upgrade && entry.url === "/ws"));
    },
  );
});

test("an upstream that is down becomes a plain error, not a crash", async () => {
  const cssFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tode-css-")), "inject.css");
  fs.writeFileSync(cssFile, "html{}");
  const proxy = createInjector(1, cssFile, undefined, 50);
  const port = await listen(proxy);
  try {
    const { status } = await get(port);
    assert.equal(status, 502);
  } finally {
    await close(proxy);
  }
});

test("the css paints the root, which is what covers the uncovered row", () => {
  const css = injectedCss("#101010", "JetBrains Mono");
  assert.match(css, /html,body\{background:#101010 !important;\}/);
});

test("the css carries the font for the interface as well as an @font-face", () => {
  const css = injectedCss("#101010", "JetBrains Mono");
  assert.match(css, /@font-face\{font-family:"JetBrains Mono";src:url\("\/__tode\/font.ttf"\)/);
  assert.match(css, /\.monaco-workbench\{[^}]*font-family:"JetBrains Mono"/);
  assert.match(css, /--monaco-monospace-font:"JetBrains Mono"/);
});

test("the font is served by the proxy so no system install is needed", async () => {
  const fontFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tode-font-")), "f.ttf");
  fs.writeFileSync(fontFile, Buffer.from([0, 1, 0, 0, 9, 9]));
  const upstream = http.createServer((_q, r) => r.end("nope"));
  const upstreamPort = await listen(upstream);
  const cssFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tode-css-")), "inject.css");
  fs.writeFileSync(cssFile, "html{}");
  const proxy = createInjector(upstreamPort, cssFile, fontFile);
  const port = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${FONT_ROUTE}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "font/ttf");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 1, 0, 0, 9, 9]));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

const CSP = "default-src 'self'; script-src 'self' 'nonce-1nline-m4p'; style-src 'self' 'unsafe-inline'";

test("the proxy injects css and never a script", async () => {
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "content-security-policy": CSP });
      response.end("<html><head></head><body>x</body></html>");
    },
    async ({ proxyPort }) => {
      const { body } = await get(proxyPort, { accept: "text/html" });
      assert.match(body, /tode-injected/, "the css goes in, style-src allows inline");
      assert.doesNotMatch(body, /<script/, "scripting is the preload's and the browser's job");
    },
  );
});

test("a request waits while code-server is still booting, then goes through", async () => {
  const late = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end("<html><head></head><body>up</body></html>");
  });
  const port = await listen(late);
  await close(late);

  const cssFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tode-css-")), "inject.css");
  fs.writeFileSync(cssFile, "html{}");
  const proxy = createInjector(port, cssFile, undefined, 10_000);
  const proxyPort = await listen(proxy);
  const revived = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end("<html><head></head><body>up</body></html>");
  });
  try {
    const pending = get(proxyPort, { accept: "text/html" });
    // nothing is listening upstream yet, exactly as when code-server is booting
    await new Promise((resolve) => setTimeout(resolve, 300));
    await new Promise((resolve) => revived.listen(port, "127.0.0.1", resolve));
    const { status, body } = await pending;
    assert.equal(status, 200);
    assert.match(body, /up/);
  } finally {
    await close(proxy);
    await close(revived);
  }
});

/** a raw http exchange, for headers fetch() will not let a caller forge */
function rawRequest(port, text) {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(received));
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 1500);
  });
}

const htmlUpstream = (_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<html><head></head><body>ok</body></html>");
};

test("a request whose host is not this port is refused before anything is forwarded", async () => {
  await withPair(htmlUpstream, async ({ proxyPort, seen }) => {
    const reply = await rawRequest(
      proxyPort,
      `GET / HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`,
    );
    assert.match(reply, /^HTTP\/1.1 403/);
    assert.equal(seen.length, 0, "code-server never hears about it");
  });
});

test("a cross-origin request is refused, even though the host is right", async () => {
  await withPair(htmlUpstream, async ({ proxyPort, seen }) => {
    const { status } = await get(proxyPort, { origin: "https://attacker.example" });
    assert.equal(status, 403);
    assert.equal(seen.length, 0);
  });
});

test("a cross-origin websocket upgrade never reaches code-server (CVE-2023-26114 stays fixed)", async () => {
  await withPair(htmlUpstream, async ({ proxyPort, seen }) => {
    const reply = await rawRequest(
      proxyPort,
      `GET /ws HTTP/1.1\r\nHost: attacker.example\r\nOrigin: https://attacker.example\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
    );
    assert.match(reply, /^HTTP\/1.1 403/);
    assert.doesNotMatch(reply, /101 Switching Protocols/);
    assert.equal(seen.length, 0);
  });
});

test("localhost is as good as 127.0.0.1 for the host and origin", async () => {
  await withPair(htmlUpstream, async ({ proxyPort, seen }) => {
    const reply = await rawRequest(
      proxyPort,
      `GET / HTTP/1.1\r\nHost: localhost:${proxyPort}\r\nOrigin: http://localhost:${proxyPort}\r\n` +
        `Connection: close\r\n\r\n`,
    );
    assert.match(reply, /^HTTP\/1.1 200/);
    assert.equal(seen.length, 1);
  });
});

const AUTH = { session: "s".repeat(64), codeServer: "c".repeat(64) };

test("with a secret, nothing is served until the window has entered", async () => {
  await withPair(
    htmlUpstream,
    async ({ proxyPort, seen }) => {
      const { status } = await get(proxyPort, { accept: "text/html" });
      assert.equal(status, 401);
      const wrong = await get(proxyPort, { cookie: `${SESSION_COOKIE}=${"x".repeat(64)}` });
      assert.equal(wrong.status, 401);
      assert.equal(seen.length, 0);
      const upgrade = await rawRequest(
        proxyPort,
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      );
      assert.match(upgrade, /^HTTP\/1.1 401/);
      assert.equal(seen.length, 0);
    },
    AUTH,
  );
});

test("the entry url trades a ticket for the session cookie and sends the window on", async () => {
  await withPair(
    htmlUpstream,
    async ({ proxyPort, seen }) => {
      const origin = `http://127.0.0.1:${proxyPort}/`;
      const url = enterUrl(origin, AUTH.session, `${origin}?folder=%2Ftmp%2Fproject`);
      assert.ok(url.startsWith(`${origin.slice(0, -1)}${ENTER_ROUTE}?`));
      assert.ok(!url.includes(AUTH.session), "the secret itself never goes in a url");
      const response = await fetch(url, { redirect: "manual" });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/?folder=%2Ftmp%2Fproject");
      const cookie = response.headers.get("set-cookie");
      assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=${AUTH.session}; Path=/; HttpOnly; SameSite=Strict`));
      assert.equal(seen.length, 0);

      const page = await get(proxyPort, { accept: "text/html", cookie: `${SESSION_COOKIE}=${AUTH.session}` });
      assert.equal(page.status, 200);
      assert.match(page.body, /tode-injected/);
      // code-server gets its own credential, and never the window's
      assert.equal(seen[0].headers.cookie, `${CODE_SERVER_COOKIE}=${AUTH.codeServer}`);
    },
    AUTH,
  );
});

test("a stale or forged ticket is refused, but an entered window may reload the entry url", async () => {
  await withPair(
    htmlUpstream,
    async ({ proxyPort }) => {
      const base = `http://127.0.0.1:${proxyPort}${ENTER_ROUTE}?next=%2F&ticket=`;
      const old = mintTicket(AUTH.session, Date.now() - 3 * 60_000);
      assert.equal((await fetch(`${base}${old}`, { redirect: "manual" })).status, 403);
      const forged = mintTicket("not-the-secret");
      assert.equal((await fetch(`${base}${forged}`, { redirect: "manual" })).status, 403);
      const again = await fetch(`${base}${old}`, {
        redirect: "manual",
        headers: { cookie: `${SESSION_COOKIE}=${AUTH.session}` },
      });
      assert.equal(again.status, 303);
    },
    AUTH,
  );
});

test("a ticket is good exactly once, so a copy taken from a process list is worthless", async () => {
  await withPair(
    htmlUpstream,
    async ({ proxyPort }) => {
      const url = `http://127.0.0.1:${proxyPort}${ENTER_ROUTE}?next=%2F&ticket=${mintTicket(AUTH.session)}`;
      assert.equal((await fetch(url, { redirect: "manual" })).status, 303);
      assert.equal((await fetch(url, { redirect: "manual" })).status, 403);
    },
    AUTH,
  );
});

test("the entry url only ever sends the window somewhere on this origin", async () => {
  await withPair(
    htmlUpstream,
    async ({ proxyPort }) => {
      const ticket = mintTicket(AUTH.session);
      const url = `http://127.0.0.1:${proxyPort}${ENTER_ROUTE}?ticket=${ticket}&next=${encodeURIComponent("//evil.example/x")}`;
      const response = await fetch(url, { redirect: "manual" });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/");
    },
    AUTH,
  );
});

test("tickets expire and cannot be post-dated", () => {
  const now = Date.now();
  assert.ok(ticketValid("k", mintTicket("k", now), now));
  assert.ok(!ticketValid("k", mintTicket("k", now - 3 * 60_000), now));
  assert.ok(!ticketValid("k", mintTicket("k", now + 60 * 60_000), now));
  assert.ok(!ticketValid("k", "garbage", now));
  assert.ok(!ticketValid("k", mintTicket("other", now), now));
});

test("the empty editor stays empty: the watermark is always hidden", () => {
  const css = injectedCss("#101010", "JetBrains Mono");
  assert.match(css, /\.editor-group-watermark\{display:none !important;\}/);
});

