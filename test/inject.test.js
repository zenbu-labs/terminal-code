const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createInjector,
  injectedCss,
  withWorkbenchDefaults,
  FONT_ROUTE,
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

/** stands in for the VS Code server, and remembers the headers it was handed */
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

async function withPair(handler, run, settings) {
  const { server: upstream, seen } = fakeUpstream(handler);
  const upstreamPort = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-css-"));
  const cssFile = path.join(dir, "inject.css");
  fs.writeFileSync(cssFile, "html{background:#101010 !important;}");
  let settingsFile;
  if (settings !== undefined) {
    settingsFile = path.join(dir, "settings.json");
    fs.writeFileSync(settingsFile, settings);
  }
  const proxy = createInjector(upstreamPort, cssFile, undefined, undefined, settingsFile);
  const proxyPort = await listen(proxy);
  try {
    await run({ proxyPort, upstreamPort, seen, cssFile, settingsFile });
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

test("the workbench is left on one origin: the client's own host goes through", async () => {
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head></head></html>");
    },
    async ({ proxyPort, seen }) => {
      await get(proxyPort, { accept: "text/html", origin: `http://127.0.0.1:${proxyPort}` });
      // the server builds the workbench's remote authority out of the host it
      // was asked with, and its content security policy then only allows that
      // one origin — pointing it at the upstream would block every resource
      // the page fetches
      assert.equal(seen[0].headers.host, `127.0.0.1:${proxyPort}`);
      assert.equal(seen[0].headers.origin, `http://127.0.0.1:${proxyPort}`);
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

test("a request waits while the VS Code server is still booting, then goes through", async () => {
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
    // nothing is listening upstream yet, exactly as when serve-web is booting
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
  const css = injectedCss("#101010", "JetBrains Mono");
  assert.match(css, /\.editor-group-watermark\{display:none !important;\}/);
});


const workbenchPage = (settings) =>
  `<html><head><meta id="vscode-workbench-web-configuration" data-settings="${settings
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")}"></head><body></body></html>`;

test("tode's settings reach the workbench as configuration defaults", () => {
  const html = workbenchPage(JSON.stringify({ folderUri: { path: "/w" } }));
  const out = withWorkbenchDefaults(html, { "workbench.colorTheme": "Tode" });
  const settings = JSON.parse(
    out
      .match(/data-settings="([^"]*)"/)[1]
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&"),
  );
  // what the server put there survives
  assert.deepEqual(settings.folderUri, { path: "/w" });
  assert.deepEqual(settings.configurationDefaults, { "workbench.colorTheme": "Tode" });
  // the folder was asked for by name, so it is not put behind a trust prompt
  assert.equal(settings.enableWorkspaceTrust, false);
});

test("a page without the workbench configuration is left alone", () => {
  const plain = "<html><head></head></html>";
  assert.equal(withWorkbenchDefaults(plain, { a: 1 }), plain);
  const broken = workbenchPage("{not json");
  assert.equal(withWorkbenchDefaults(broken, { a: 1 }), broken);
});

test("the settings file is read on every load, so an edit lands on refresh", async () => {
  await withPair(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(workbenchPage("{}"));
    },
    async ({ proxyPort, settingsFile }) => {
      const first = await get(proxyPort, { accept: "text/html" });
      assert.match(first.body, /&quot;workbench.colorTheme&quot;:&quot;Tode&quot;/);
      fs.writeFileSync(settingsFile, '{ "editor.fontSize": 17 }');
      const second = await get(proxyPort, { accept: "text/html" });
      assert.match(second.body, /&quot;editor.fontSize&quot;:17/);
      // and the css is still there alongside it
      assert.match(second.body, /<style id="tode-injected">/);
    },
    '{\n  // tode owns this one\n  "workbench.colorTheme": "Tode",\n}',
  );
});
