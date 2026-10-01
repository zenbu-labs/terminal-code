import fs from "node:fs";
import http from "node:http";
import net from "node:net";

export const FONT_ROUTE = "/__tode/font.ttf";

export function createInjector(
  upstreamPort: number,
  cssFile: string,
  fontFile?: string,
  holdMs = 20_000,
): http.Server {
  const upstreamHost = `127.0.0.1:${upstreamPort}`;

  const readCss = (): string => {
    try {
      return fs.readFileSync(cssFile, "utf8");
    } catch {
      return "";
    }
  };

  // code-server checks that a request comes from its own origin, so the
  // rewritten headers have to say so even though the browser said otherwise
  const forwardHeaders = (incoming: http.IncomingHttpHeaders, wantsHtml: boolean) => {
    const headers: http.IncomingHttpHeaders = { ...incoming, host: upstreamHost };
    for (const name of ["origin", "referer"] as const) {
      const value = headers[name];
      if (typeof value === "string") {
        headers[name] = value.replace(/^https?:\/\/[^/]+/, `http://${upstreamHost}`);
      }
    }
    // an encoded body cannot be edited, so documents are asked for in the clear
    if (wantsHtml) headers["accept-encoding"] = "identity";
    return headers;
  };

  const started = Date.now();
  let everAnswered = false;
  const server: http.Server = http.createServer((request, response) => {
    // serving the font here means the page has it whether or not it was ever
    // installed into the operating system
    if (fontFile && request.url?.startsWith(FONT_ROUTE)) {
      try {
        const font = fs.readFileSync(fontFile);
        response.writeHead(200, {
          "content-type": "font/ttf",
          "content-length": String(font.byteLength),
          "cache-control": "public, max-age=31536000, immutable",
        });
        response.end(font);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    const wantsHtml = (request.headers.accept ?? "").includes("text/html");
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: forwardHeaders(request.headers, wantsHtml),
      },
      (from) => {
        everAnswered = true;
        const type = from.headers["content-type"] ?? "";
        const css = readCss();
        if (!type.includes("text/html") || !css) {
          response.writeHead(from.statusCode ?? 502, from.headers);
          from.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        from.on("data", (chunk: Buffer) => chunks.push(chunk));
        from.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const style = `<style id="tode-injected">${css}</style>`;
          const patched = body.includes("</head>")
            ? body.replace("</head>", `${style}</head>`)
            : `${style}${body}`;
          const out = Buffer.from(patched, "utf8");
          const headers = { ...from.headers, "content-length": String(out.byteLength) };
          delete headers["content-encoding"];
          // the whole body is in hand now, and a length cannot be sent alongside
          // the chunked encoding the upstream may have used
          delete headers["transfer-encoding"];
          response.writeHead(from.statusCode ?? 200, headers);
          response.end(out);
        });
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      // code-server may still be booting: the browser was started alongside it
      // rather than after it, so the request waits instead of failing
      if (error.code === "ECONNREFUSED" && !everAnswered && Date.now() - started < holdMs) {
        setTimeout(() => server.emit("request", request, response), 60);
        return;
      }
      if (!response.headersSent) response.writeHead(502);
      response.end("tode: code-server is not answering\n");
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, client: net.Socket, clientHead: Buffer) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: forwardHeaders(request.headers, false),
    });
    upstream.on("upgrade", (from, target: net.Socket, upstreamHead: Buffer) => {
      const lines = Object.entries(from.headers).map(([name, value]) => `${name}: ${value}`);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      // whatever arrived in the same packet as each handshake belongs to the
      // other end, and has already been read off its socket
      if (upstreamHead?.length) client.write(upstreamHead);
      if (clientHead?.length) target.write(clientHead);
      target.pipe(client);
      client.pipe(target);
      // an upgraded socket allows half open, so a browser going away shows up as
      // "end" and never as "close". Watching only for close would leave the
      // connection to code-server behind on every reload.
      const drop = () => {
        target.destroy();
        client.destroy();
      };
      for (const event of ["end", "close", "error"] as const) {
        target.on(event, drop);
        client.on(event, drop);
      }
    });
    upstream.on("error", () => client.destroy());
    upstream.end();
  });

  return server;
}


export const FONT_FALLBACKS = `Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace`;

const CLEARED_SURFACES = [
  "html",
  "body",
  ".monaco-workbench",
  ".monaco-workbench .part",
  ".monaco-workbench .part>.content",
  ".monaco-workbench .part>.title",
  ".monaco-workbench.floating-panels>.monaco-grid-view",
  ".monaco-workbench.floating-panels .part",
  ".monaco-workbench.style-override .monaco-pane-view .pane",
  ".monaco-workbench.style-override .monaco-pane-view .pane>.pane-header",
  ".editor-group-container>.tabs",
  ".monaco-editor-background",
  ".monaco-editor .margin",
  ".monaco-list .monaco-list-rows",
  ".terminal-outer-container",
  ".xterm-viewport",
  ".xterm-rows",
];

export function injectedCss(background: string, fontFamily: string, transparent = false): string {
  const stack = `"${fontFamily}", ${FONT_FALLBACKS}`;
  const fill = transparent ? "transparent" : background;
  return [
    `@font-face{font-family:"${fontFamily}";src:url("${FONT_ROUTE}") format("truetype");font-weight:100 900;font-display:block;}`,
    `html,body{background:${fill} !important;}`,
    "html{overflow:hidden;}",
    "body{margin:0;}",
    `.monaco-workbench{background:${fill};font-family:${stack} !important;}`,
    transparent ? `${CLEARED_SURFACES.join(",")}{background:transparent !important;}` : "",
    `.monaco-workbench .part,.monaco-workbench .monaco-list,.monaco-workbench .monaco-inputbox,`,
    `.monaco-workbench input,.monaco-workbench select,.monaco-workbench textarea,`,
    `.monaco-menu,.quick-input-widget,.monaco-hover,.notifications-toasts`,
    `{font-family:${stack} !important;}`,
    `:root{--monaco-monospace-font:${stack};}`,
    ".editor-group-watermark{display:none !important;}",
  ].join("");
}
