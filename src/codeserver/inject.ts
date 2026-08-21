import fs from "node:fs";
import http from "node:http";
import net from "node:net";

import { parseJsonc } from "../jsonc";

/** The VS Code server in front of a proxy that puts tode's css into the workbench page.
 *
 * The page needs the css before its first paint, and reaching in over the
 * devtools protocol after the fact means a visible flash, so the html is edited
 * on its way through instead. Everything that is not the document is piped
 * straight across. Nothing but css goes in: the workbench's startup timing
 * lives in the browser preload (src/browser/preload.ts), and links that leave
 * the workbench open as terminal-browser's own popups over the pane
 * (--open-tabs-in-popup-stack). */
export const FONT_ROUTE = "/__tode/font.ttf";

/** The workbench in a browser keeps its user data in the browser, not in the
 * server's --server-data-dir, so a settings file on disk would never be read.
 * The document carries the embedder's options instead, and configurationDefaults
 * is the supported way in: tode's settings arrive as defaults on every load,
 * which is what "tode owns these keys" already meant, and anything the user
 * sets in the editor still wins. */
const CONFIG_META = /(<meta\s+id="vscode-workbench-web-configuration"\s+data-settings=")([^"]*)(")/;

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
};

function decodeAttribute(value: string): string {
  return value.replace(/&quot;|&amp;|&lt;|&gt;|&#39;/g, (entity) => ENTITIES[entity]);
}

function encodeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function withWorkbenchDefaults(html: string, defaults: Record<string, unknown>): string {
  const found = html.match(CONFIG_META);
  if (!found) return html;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(decodeAttribute(found[2])) as Record<string, unknown>;
  } catch {
    return html;
  }
  const merged = {
    ...config,
    // the folder was asked for by name; a prompt in front of it is only in the way
    enableWorkspaceTrust: false,
    configurationDefaults: {
      ...((config.configurationDefaults as Record<string, unknown>) ?? {}),
      ...defaults,
    },
  };
  return html.replace(CONFIG_META, `$1${encodeAttribute(JSON.stringify(merged))}$3`);
}

export function createInjector(
  upstreamPort: number,
  cssFile: string,
  fontFile?: string,
  holdMs = 20_000,
  settingsFile?: string,
): http.Server {
  const readCss = (): string => {
    try {
      return fs.readFileSync(cssFile, "utf8");
    } catch {
      return "";
    }
  };

  const readDefaults = (): Record<string, unknown> => {
    if (!settingsFile) return {};
    try {
      const parsed = parseJsonc(fs.readFileSync(settingsFile, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  // The browser talks to the injector and the workbench talks to whatever the
  // host header said, so the client's own host is carried through: one origin
  // for the document, its resources and its websocket. Rewriting it to the
  // upstream would leave the page fetching across origins, which the
  // workbench's own content security policy refuses.
  const forwardHeaders = (incoming: http.IncomingHttpHeaders, wantsHtml: boolean) => {
    const headers: http.IncomingHttpHeaders = { ...incoming };
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
        const defaults = readDefaults();
        if (!type.includes("text/html") || (!css && Object.keys(defaults).length === 0)) {
          response.writeHead(from.statusCode ?? 502, from.headers);
          from.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        from.on("data", (chunk: Buffer) => chunks.push(chunk));
        from.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const style = css ? `<style id="tode-injected">${css}</style>` : "";
          const styled = body.includes("</head>")
            ? body.replace("</head>", `${style}</head>`)
            : `${style}${body}`;
          const patched = withWorkbenchDefaults(styled, defaults);
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
      // the server may still be booting: the browser was started alongside it
      // rather than after it, so the request waits instead of failing
      if (error.code === "ECONNREFUSED" && !everAnswered && Date.now() - started < holdMs) {
        setTimeout(() => server.emit("request", request, response), 60);
        return;
      }
      if (!response.headersSent) response.writeHead(502);
      response.end("tode: the VS Code server is not answering\n");
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
      // connection to the server behind on every reload.
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

export function injectedCss(background: string, fontFamily: string): string {
  const stack = `"${fontFamily}", ${FONT_FALLBACKS}`;
  return [
    `@font-face{font-family:"${fontFamily}";src:url("${FONT_ROUTE}") format("truetype");font-weight:100 900;font-display:block;}`,
    `html,body{background:${background} !important;}`,
    "html{overflow:hidden;}",
    "body{margin:0;}",
    `.monaco-workbench{background:${background};font-family:${stack} !important;}`,
    `.monaco-workbench .part,.monaco-workbench .monaco-list,.monaco-workbench .monaco-inputbox,`,
    `.monaco-workbench input,.monaco-workbench select,.monaco-workbench textarea,`,
    `.monaco-menu,.quick-input-widget,.monaco-hover,.notifications-toasts`,
    `{font-family:${stack} !important;}`,
    `:root{--monaco-monospace-font:${stack};}`,
    ".editor-group-watermark{display:none !important;}",
  ].join("");
}
