import { Duplex } from "node:stream";

export const KIND = { control: 0, pixel: 1, open: 2, data: 3, end: 4 } as const;

const HEADER = 9;
const MAX_FRAME = 32 * 1024 * 1024;

export type Control = { type: string } & Record<string, unknown>;

export class Channel extends Duplex {
  private sentEnd = false;

  constructor(
    private readonly mux: Mux,
    readonly id: number,
  ) {
    super({ allowHalfOpen: false });
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.mux.frame(KIND.data, this.id, chunk, done);
  }

  _final(done: (error?: Error | null) => void): void {
    this.sendEnd();
    done();
  }

  _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.sendEnd();
    this.mux.forget(this.id);
    done(error);
  }

  private sendEnd(): void {
    if (this.sentEnd) return;
    this.sentEnd = true;
    this.mux.frame(KIND.end, this.id, Buffer.alloc(0));
  }
}

export class Mux {
  onControl: (message: Control) => void = () => {};
  onPixel: (message: Uint8Array) => void = () => {};
  onOpen: (channel: Channel, info: Control) => void = (channel) => channel.destroy();
  closed = false;
  private pending: Buffer = Buffer.alloc(0);
  private readonly channels = new Map<number, Channel>();
  private next: number;
  private readonly closedListeners: (() => void)[] = [];

  constructor(
    readonly stream: Duplex,
    opener: boolean,
  ) {
    this.next = opener ? 1 : 2;
    stream.on("data", (chunk: Buffer) => this.feed(chunk));
    stream.on("end", () => this.close());
    stream.on("close", () => this.close());
    stream.on("error", () => this.close());
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closedListeners.push(listener);
  }

  control(message: Control): void {
    this.frame(KIND.control, 0, Buffer.from(JSON.stringify(message)));
  }

  pixel(message: Uint8Array): void {
    this.frame(KIND.pixel, 0, Buffer.from(message.buffer, message.byteOffset, message.byteLength));
  }

  open(info: Control): Channel {
    const channel = new Channel(this, this.next);
    this.next += 2;
    this.channels.set(channel.id, channel);
    this.frame(KIND.open, channel.id, Buffer.from(JSON.stringify(info)));
    return channel;
  }

  frame(kind: number, channel: number, payload: Buffer, written?: (error?: Error | null) => void): void {
    if (this.closed || this.stream.destroyed) {
      written?.(new Error("the link is closed"));
      return;
    }
    const header = Buffer.allocUnsafe(HEADER);
    header.writeUInt32BE(1 + 4 + payload.length, 0);
    header[4] = kind;
    header.writeUInt32BE(channel, 5);
    this.stream.write(header);
    if (this.stream.write(payload) || !written) written?.();
    else this.stream.once("drain", () => written());
  }

  forget(id: number): void {
    this.channels.delete(id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.channels.values()) channel.destroy();
    this.channels.clear();
    this.stream.destroy();
    for (const listener of this.closedListeners.splice(0)) listener();
  }

  private feed(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length < 5 || length > MAX_FRAME) {
        this.close();
        return;
      }
      if (this.pending.length < 4 + length) return;
      const kind = this.pending[4];
      const id = this.pending.readUInt32BE(5);
      const payload = this.pending.subarray(HEADER, 4 + length);
      this.pending = this.pending.subarray(4 + length);
      this.dispatch(kind, id, payload);
      if (this.closed) return;
    }
  }

  private dispatch(kind: number, id: number, payload: Buffer): void {
    switch (kind) {
      case KIND.control: {
        let message: Control;
        try {
          message = JSON.parse(payload.toString("utf8")) as Control;
        } catch {
          return;
        }
        if (message && typeof message.type === "string") this.onControl(message);
        return;
      }
      case KIND.pixel:
        this.onPixel(payload);
        return;
      case KIND.open: {
        if (this.channels.has(id)) return;
        const channel = new Channel(this, id);
        this.channels.set(id, channel);
        let info: Control = { type: "open" };
        try {
          info = JSON.parse(payload.toString("utf8")) as Control;
        } catch {}
        this.onOpen(channel, info);
        return;
      }
      case KIND.data:
        this.channels.get(id)?.push(payload);
        return;
      case KIND.end: {
        const channel = this.channels.get(id);
        if (!channel) return;
        this.channels.delete(id);
        channel.push(null);
        return;
      }
    }
  }
}

export function pipeBoth(a: Duplex, b: Duplex): void {
  a.pipe(b);
  b.pipe(a);
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", close);
  b.on("error", close);
  a.on("close", close);
  b.on("close", close);
}

export function nextControl(mux: Mux, timeoutMs: number): Promise<Control | null> {
  return new Promise((resolve) => {
    const previous = mux.onControl;
    const settle = (message: Control | null) => {
      clearTimeout(timer);
      mux.onControl = previous;
      resolve(message);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    mux.onControl = (message) => settle(message);
    mux.onClose(() => settle(null));
  });
}
