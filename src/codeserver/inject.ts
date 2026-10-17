import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

export const FONT_ROUTE = "/__tode/font.ttf";
export const ENTER_ROUTE = "/__tode/enter";
export const SESSION_COOKIE = "tode-session";
export const CODE_SERVER_COOKIE = "code-server-session";
const TICKET_TTL_MS = 2 * 60_000;

export interface InjectorAuth {
  session: string;
  codeServer: string;
}

export function newSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

function sign(secret: string, expires: number): string {
  return crypto.createHmac("sha256", secret).update(`enter:${expires}`).digest("hex");
}

export function mintTicket(secret: string, now = Date.now()): string {
  const expires = now + TICKET_TTL_MS;
  return `${expires}.${sign(secret, expires)}`;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function ticketValid(secret: string, ticket: string, now = Date.now()): boolean {
  const dot = ticket.indexOf(".");
  if (dot < 1) return false;
  const expires = Number(ticket.slice(0, dot));
  if (!Number.isFinite(expires) || expires < now || expires > now + TICKET_TTL_MS) return false;
  return same(ticket.slice(dot + 1), sign(secret, expires));
}

export function enterUrl(origin: string, secret: string, destination: string): string {
  const wanted = new URL(destination);
  const url = new URL(ENTER_ROUTE, origin);
  url.searchParams.set("ticket", mintTicket(secret));
  url.searchParams.set("next", `${wanted.pathname}${wanted.search}`);
  return url.toString();
}

function cookies(header: string | undefined): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    found.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return found;
}

function withoutCookie(header: string | undefined, name: string): string {
  return (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${name}=`))
    .join("; ");
}

export function createInjector(
  upstreamPort: number,
  cssFile: string,
  fontFile?: string,
  holdMs = 20_000,
  auth?: InjectorAuth,
): http.Server {
  const upstreamHost = `127.0.0.1:${upstreamPort}`;

  const ownHosts = (): string[] => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    return [`127.0.0.1:${port}`, `localhost:${port}`];
  };
  const sameOrigin = (headers: http.IncomingHttpHeaders): boolean => {
    const host = (headers.host ?? "").trim().toLowerCase();
    if (!ownHosts().includes(host)) return false;
    const origin = headers.origin;
    if (origin === undefined) return true;
    if (typeof origin !== "string") return false;
    let originHost: string;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:") return false;
      originHost = parsed.host.toLowerCase();
    } catch {
      return false;
    }
    return ownHosts().includes(originHost);
  };
  const redeemed = new Map<string, number>();
  const redeem = (ticket: string): boolean => {
    if (!auth || !ticketValid(auth.session, ticket)) return false;
    const now = Date.now();
    for (const [spent, expires] of redeemed) if (expires < now) redeemed.delete(spent);
    if (redeemed.has(ticket)) return false;
    redeemed.set(ticket, Number(ticket.slice(0, ticket.indexOf("."))));
    return true;
  };
  const entered = (headers: http.IncomingHttpHeaders): boolean => {
    if (!auth) return true;
    const presented = cookies(headers.cookie).get(SESSION_COOKIE);
    return presented !== undefined && same(presented, auth.session);
  };

  const readCss = (): string => {
    try {
      return fs.readFileSync(cssFile, "utf8");
    } catch {
      return "";
    }
  };

  // code-server checks that a request comes from its own origin, so the
  // rewritten headers have to say so. Only requests sameOrigin() already
  // accepted get here, so this never launders a foreign origin.
  const forwardHeaders = (incoming: http.IncomingHttpHeaders, wantsHtml: boolean) => {
    const headers: http.IncomingHttpHeaders = { ...incoming, host: upstreamHost };
    for (const name of ["origin", "referer"] as const) {
      const value = headers[name];
      if (typeof value === "string") {
        headers[name] = value.replace(/^https?:\/\/[^/]+/, `http://${upstreamHost}`);
      }
    }
    if (auth) {
      const rest = withoutCookie(withoutCookie(headers.cookie, SESSION_COOKIE), CODE_SERVER_COOKIE);
      headers.cookie = [`${CODE_SERVER_COOKIE}=${auth.codeServer}`, rest].filter(Boolean).join("; ");
    }
    // an encoded body cannot be edited, so documents are asked for in the clear
    if (wantsHtml) headers["accept-encoding"] = "identity";
    return headers;
  };

  const started = Date.now();
  let everAnswered = false;
  const refuse = (response: http.ServerResponse, status: number, reason: string) => {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(`tode: ${reason}\n`);
  };
  const server: http.Server = http.createServer((request, response) => {
    if (!sameOrigin(request.headers)) {
      refuse(response, 403, "this is not the window's origin");
      return;
    }
    if (auth && request.url?.startsWith(`${ENTER_ROUTE}?`)) {
      const query = new URL(request.url, "http://127.0.0.1").searchParams;
      const next = query.get("next") ?? "/";
      if (!entered(request.headers) && !redeem(query.get("ticket") ?? "")) {
        refuse(response, 403, "this window's ticket has been used or has expired, open tode again");
        return;
      }
      response.writeHead(303, {
        location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
        "set-cookie": `${SESSION_COOKIE}=${auth.session}; Path=/; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!entered(request.headers)) {
      refuse(response, 401, "only tode windows may use this port");
      return;
    }
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
    if (!sameOrigin(request.headers) || !entered(request.headers)) {
      const status = sameOrigin(request.headers) ? "401 Unauthorized" : "403 Forbidden";
      client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      return;
    }
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
