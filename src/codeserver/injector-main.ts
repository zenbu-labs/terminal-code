#!/usr/bin/env node
import { createInjector } from "./inject";

const upstream = Number(process.argv[2]);
const port = Number(process.argv[3]);
const cssFile = process.argv[4];
const fontFile = process.argv[5];
const session = process.env.TODE_SESSION_SECRET;
const codeServer = process.env.TODE_CODE_SERVER_SECRET;

if (!upstream || !port || !cssFile || !session || !codeServer) {
  process.stderr.write(
    "usage: TODE_SESSION_SECRET=… TODE_CODE_SERVER_SECRET=… injector-main <upstreamPort> <port> <cssFile> [fontFile]\n",
  );
  process.exit(1);
}

createInjector(upstream, cssFile, fontFile, undefined, { session, codeServer }).listen(port, "127.0.0.1", () => {
  process.stdout.write(`tode injector ${port} -> ${upstream}\n`);
});
