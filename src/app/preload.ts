import { ipcRenderer, webFrame } from "electron";
import type { ClipboardMessage, ThemeMessage, TimingMessage } from "./messages";

const CHANNEL = "tode:message";
const deliver = (message: ClipboardMessage | ThemeMessage | TimingMessage) => ipcRenderer.send(CHANNEL, message);

if (process.isMainFrame) {
  for (const type of ["copy", "cut"]) {
    document.addEventListener(type, (event) => {
      const clipboardEvent = event as ClipboardEvent;
      if (!clipboardEvent.isTrusted) return;
      const text = clipboardEvent.clipboardData?.getData("text/plain");
      if (text) deliver({ type: "tode-clipboard-event", text });
    });
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "tode-clipboard-fix-v1") return;
    if (typeof event.data.text !== "string" || !event.data.text) return;
    deliver({ type: "tode-clipboard-api", text: event.data.text });
  });
  void webFrame.executeJavaScript(`(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    for (const method of ["writeText", "write"]) {
      const original = clipboard[method];
      if (typeof original !== "function") continue;
      try {
        Object.defineProperty(clipboard, method, {
          configurable: true,
          writable: true,
          value: async function(...args) {
            const result = await Reflect.apply(original, this, args);
            try {
              let text;
              if (method === "writeText") {
                if (typeof args[0] === "string") text = args[0];
              } else {
                for (const item of args[0]) {
                  if (item.types.includes("text/plain")) {
                    text = await (await item.getType("text/plain")).text();
                    break;
                  }
                }
              }
              if (text) window.postMessage({ source: "tode-clipboard-fix-v1", text }, "*");
            } catch {}
            return result;
          },
        });
      } catch {}
    }
  })()`).catch(() => {});
}

pixel.onTheme((theme) => deliver({ type: "theme", colors: theme }));

if (window === window.top) {
  const send = () => {
    try {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const marks: Record<string, number> = {};
      for (const mark of performance.getEntriesByType("mark")) {
        if (mark.name.startsWith("code/")) marks[mark.name] = Math.round(mark.startTime);
      }
      if (Object.keys(marks).length === 0) return;
      deliver({
        type: "timing",
        page: {
          at: Date.now(),
          origin: Math.round(performance.timeOrigin),
          responseEnd: Math.round(nav?.responseEnd ?? 0),
          domInteractive: Math.round(nav?.domInteractive ?? 0),
          loadEnd: Math.round(nav?.loadEventEnd ?? 0),
          marks,
        },
      });
    } catch { }
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
