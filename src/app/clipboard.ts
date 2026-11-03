import { clipboard } from "@zenbu-labs/pixel/electron";
import type { IpcMainEvent, WebContents } from "@zenbu-labs/pixel/electron";
import type { Root, WebViewHandle } from "@zenbu-labs/pixel";

interface ClipboardWindow {
  view: Pick<WebViewHandle, "webContents"> | null;
}

const states = new WeakMap<WebContents, { sequence: number }>();
const READ_CLIPBOARD = `(async () => {
  try {
    const permission = await navigator.permissions.query({ name: "clipboard-read" });
    if (permission.state !== "granted") return null;
    return await navigator.clipboard.readText();
  } catch { return null; }
})()`;

function stateFor(contents: WebContents) {
  const state = states.get(contents);
  if (state) return state;
  const current = { sequence: 0 };
  states.set(contents, current);
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) current.sequence++;
  });
  contents.once("destroyed", () => { current.sequence++; });
  return current;
}

export function handleClipboardMessage(
  event: IpcMainEvent,
  message: unknown,
  windows: ReadonlyMap<Root, ClipboardWindow>,
): boolean {
  if (!message || typeof message !== "object" || !("type" in message)
    || (message.type !== "tode-clipboard-event" && message.type !== "tode-clipboard-api")) return false;
  try {
    const text = "text" in message ? message.text : undefined;
    const contents = event.sender;
    if (typeof text !== "string" || !text || !contents || contents.isDestroyed()) return true;
    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame) return true;
    const entry = [...windows].find(([, window]) => window.view?.webContents === contents);
    if (!entry) return true;
    const [root, window] = entry;
    const state = stateFor(contents);
    const sequence = ++state.sequence;
    const copy = () => {
      if (!contents.isDestroyed() && state.sequence === sequence && windows.get(root) === window
        && window.view?.webContents === contents && contents.mainFrame === frame) {
        root.setClipboard(text);
      }
    };
    if (message.type === "tode-clipboard-event") copy();
    else void confirmWrite(contents, text).then((confirmed) => { if (confirmed) copy(); }).catch(() => {});
  } catch {}
  return true;
}

async function confirmWrite(contents: WebContents, text: string): Promise<boolean> {
  let actual;
  try { actual = await clipboard.readText(); } catch {}
  if (actual === text) return true;
  try {
    actual = await contents.executeJavaScriptInIsolatedWorld(1013, [{ code: READ_CLIPBOARD }]);
  } catch {}
  return actual === text;
}
