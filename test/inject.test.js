const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createInjector, injectedCss, FONT_ROUTE } = require("../dist/codeserver/inject.js");

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

async function withPair(handler, run) {
  const { server: upstream, seen } = fakeUpstream(handler);
  const upstreamPort = await listen(upstream);
  const cssFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tode-css-")), "inject.css");
  fs.writeFileSync(cssFile, "html{background:#101010 !important;}");
  const proxy = createInjector(upstreamPort, cssFile);
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

const BUNDLED_STACK = `"JetBrains Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace`;

const css = (fontStack = BUNDLED_STACK) =>
  injectedCss({ background: "#101010", bundledFamily: "JetBrains Mono", fontStack });

test("the css paints the root, which is what covers the uncovered row", () => {
  assert.match(css(), /html,body\{background:#101010 !important;\}/);
});

test("the css carries the font for the interface as well as an @font-face", () => {
  const sheet = css();
  assert.match(sheet, /@font-face\{font-family:"JetBrains Mono";src:url\("\/__tode\/font.ttf"\)/);
  assert.match(sheet, /\.monaco-workbench\{[^}]*font-family:"JetBrains Mono"/);
  assert.match(sheet, /--monaco-monospace-font:"JetBrains Mono"/);
});

test("a chosen stack is what the workbench is told to render in", () => {
  const sheet = css(`"JetBrainsMono NF", monospace`);
  assert.match(sheet, /\.monaco-workbench\{[^}]*font-family:"JetBrainsMono NF", monospace !important;\}/);
  assert.match(sheet, /--monaco-monospace-font:"JetBrainsMono NF", monospace;/);
  assert.doesNotMatch(
    sheet.replace(/@font-face\{[^}]*\}/, ""),
    /JetBrains Mono"/,
    "nothing outside the @font-face may still force the bundled family",
  );
});

test("the bundled font keeps its @font-face even when another stack is chosen", () => {
  const sheet = css("Cascadia Mono, monospace");
  assert.match(sheet, /@font-face\{font-family:"JetBrains Mono";src:url\("\/__tode\/font.ttf"\)/);
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

test("the empty editor stays empty: the watermark is always hidden", () => {
  assert.match(css(), /\.editor-group-watermark\{display:none !important;\}/);
});

