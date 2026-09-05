import type { MainCtx, ThemeMessage, TimingMessage } from "./ctx";

export function browserMain(ctx: MainCtx): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const { parseRawColors } = require(ctx.modules.livesync) as typeof import("../livesync");
  const { generateTheme } = require(ctx.modules.generate) as typeof import("../theme/generate");
  const { sendToExtension: sendToWindow, endpointOf } = require(ctx.modules.ipc) as typeof import("../ipc");
  const { ipcMain } = require("electron") as {
    ipcMain: { on(channel: string, listener: (event: unknown, message: unknown) => void): void };
  };

  ipcMain.on("tode:message", (_event, message) => {
    const timed = message as TimingMessage | null | undefined;
    if (timed && timed.type === "timing" && timed.page) {
      try {
        fs.writeFileSync(ctx.timingFile, JSON.stringify(timed.page));
      } catch { }
      return;
    }
    const themed = message as ThemeMessage | null | undefined;
    if (!themed || themed.type !== "theme" || !themed.colors) return;
    const palette = parseRawColors(JSON.stringify(themed.colors));
    if (!palette) return;
    const theme = generateTheme(palette) as unknown as Record<string, unknown>;
    let names: string[];
    try {
      names = fs.readdirSync(ctx.socketDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".sock")) continue;
      const file = path.join(ctx.socketDir, name);
      const endpoint = endpointOf(file);
      if (!endpoint) continue;
      sendToWindow(endpoint, { files: [], folders: [], add: false, theme }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
            try {
              fs.rmSync(file, { force: true });
            } catch { }
          }
        },
      );
    }
  });
}
