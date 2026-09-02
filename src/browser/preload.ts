import type { TerminalBrowserApi } from "./api";
import type { PreloadCtx, ThemeMessage, TimingMessage } from "./ctx";

declare const terminalBrowser: TerminalBrowserApi;

export function preloadMain(_ctx: PreloadCtx): void {
  const { ipcRenderer, webFrame } = require("electron") as {
    ipcRenderer: { send(channel: string, message: unknown): void };
    webFrame: { setZoomFactor(factor: number): void };
  };
  webFrame.setZoomFactor(1);
  const deliver = (message: unknown) => ipcRenderer.send("tode:message", message);

  terminalBrowser.onTheme((theme) => {
    const message: ThemeMessage = { type: "theme", colors: theme };
    deliver(message);
  });

  if (window !== window.top) return;
  const send = () => {
    try {
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const marks: Record<string, number> = {};
      for (const mark of performance.getEntriesByType("mark")) {
        if (mark.name.startsWith("code/")) marks[mark.name] = Math.round(mark.startTime);
      }
      if (Object.keys(marks).length === 0) return;
      const message: TimingMessage = {
        type: "timing",
        page: {
          at: Date.now(),
          origin: Math.round(performance.timeOrigin),
          responseEnd: Math.round(nav?.responseEnd ?? 0),
          domInteractive: Math.round(nav?.domInteractive ?? 0),
          loadEnd: Math.round(nav?.loadEventEnd ?? 0),
          marks,
        },
      };
      deliver(message);
    } catch {}
  };
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    setTimeout(send, 50);
  };
  const poll = setInterval(() => {
    if (performance.getEntriesByName("code/didStartWorkbench").length) {
      clearInterval(poll);
      settle();
    }
  }, 25);
  setTimeout(() => {
    clearInterval(poll);
    settle();
  }, 30000);
}
