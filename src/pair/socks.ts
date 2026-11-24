import net from "node:net";
import type { Duplex } from "node:stream";

import { pipeBoth } from "./link";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function socksServer(port: number, open: () => Duplex): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((client) => serve(client, port, open));
  server.on("error", () => {});
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve({ server, port: address.port });
      else reject(new Error("the rendering proxy got no port"));
    });
  });
}

function reply(client: net.Socket, status: number): void {
  client.write(Buffer.from([5, status, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function serve(client: net.Socket, allowed: number, open: () => Duplex): void {
  let buffer = Buffer.alloc(0);
  let greeted = false;
  client.on("error", () => client.destroy());
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!greeted) {
      if (buffer.length < 2) return;
      if (buffer[0] !== 5) return void client.destroy();
      const count = buffer[1];
      if (buffer.length < 2 + count) return;
      const methods = buffer.subarray(2, 2 + count);
      buffer = buffer.subarray(2 + count);
      if (!methods.includes(0)) return void client.end(Buffer.from([5, 0xff]));
      client.write(Buffer.from([5, 0]));
      greeted = true;
    }
    if (buffer.length < 5) return;
    const [version, command, , kind] = buffer;
    let host: string;
    let at: number;
    if (kind === 1) {
      if (buffer.length < 10) return;
      host = [...buffer.subarray(4, 8)].join(".");
      at = 8;
    } else if (kind === 3) {
      const length = buffer[4];
      if (buffer.length < 5 + length + 2) return;
      host = buffer.subarray(5, 5 + length).toString("latin1");
      at = 5 + length;
    } else if (kind === 4) {
      if (buffer.length < 22) return;
      const words: string[] = [];
      for (let i = 4; i < 20; i += 2) words.push(buffer.readUInt16BE(i).toString(16));
      host = net.isIPv6(words.join(":")) ? words.join(":").replace(/^(0:)+1$/, "::1") : words.join(":");
      at = 20;
    } else {
      reply(client, 8);
      return void client.end();
    }
    const port = buffer.readUInt16BE(at);
    const rest = buffer.subarray(at + 2);
    client.off("data", onData);
    if (version !== 5 || command !== 1) {
      reply(client, 7);
      return void client.end();
    }
    if (!LOOPBACK.has(host.toLowerCase()) || port !== allowed) {
      reply(client, 2);
      return void client.end();
    }
    const channel = open();
    reply(client, 0);
    if (rest.length > 0) channel.write(rest);
    pipeBoth(client, channel);
  };
  client.on("data", onData);
}
