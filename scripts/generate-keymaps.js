#!/usr/bin/env node
/* Regenerates assets/keymaps/vscode-<platform>.json from VS Code itself, so
   the wizard's picture of "chords the editor binds" is derived, never
   hand-maintained. Run it when the bindings VS Code ships change.

   How: `code serve-web` starts with a scratch profile holding one tiny extension
   that runs "Open Default Keyboard Shortcuts (JSON)" and writes the document
   to disk. The keymap follows the *client* platform, so a headless Chrome
   visits once as itself (macOS) and once wearing the linux user agent. */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { ensureVscodeCli, narrateFetch } = require(path.join(ROOT, "dist/codeserver/vendored.js"));
const { freePort, answering, serveWebArgs } = require(path.join(ROOT, "dist/codeserver/server.js"));
const { parseJsonc } = require(path.join(ROOT, "dist/jsonc.js"));

/* Enough of the devtools protocol to set the page's user agent and send it
   somewhere — this script is the only thing in the repo that drives a browser
   this way, so the glue lives here rather than shipping in dist. */

/** The workbench reads the user agent (and userAgentData) to pick its keymap;
 * wearing this dumps the linux table from a mac. */
const LINUX_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

async function pageTarget(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no page target";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) throw new Error(`cdp list failed (${response.status})`);
      const page = (await response.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(last);
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  static connect(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("cdp connect timed out"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpSession(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("cdp connect failed"));
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const DUMP_EXTENSION = `const vscode = require("vscode");
const fs = require("fs");
exports.activate = async () => {
  const out = process.env.KEYMAP_DUMP_FILE;
  if (!out) return;
  for (let i = 0; i < 150; i++) {
    try {
      await vscode.commands.executeCommand("workbench.action.openDefaultKeybindingsFile");
      const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
      const text = doc ? doc.getText() : "";
      if (text.includes('"key"')) {
        // the version lands first so a finished dump always has one beside it
        fs.writeFileSync(out + ".version", vscode.version);
        fs.writeFileSync(out, text);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
};
`;

async function vscodeCli() {
  try {
    return await ensureVscodeCli(narrateFetch("the VS Code cli"));
  } catch (error) {
    console.error(`could not fetch the VS Code cli: ${error.message}`);
    process.exit(1);
  }
}

/** serve-web keeps the profile under --server-data-dir: data/ for user data,
 * extensions/ for extensions, which is where scratchProfile() writes. Only the
 * profile is scratch — --cli-data-dir is left as serveWebArgs has it, so the
 * dump reuses the server already on this machine instead of pulling another. */
function scratchServerArgs(port, scratch) {
  return serveWebArgs(port).map((arg, at, args) =>
    args[at - 1] === "--server-data-dir" ? scratch : arg,
  );
}

function scratchProfile() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tode-keymap-"));
  const extension = path.join(scratch, "extensions", "tode.keymap-dump-1.0.0");
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(
    path.join(extension, "package.json"),
    JSON.stringify({
      name: "keymap-dump",
      publisher: "tode",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      main: "./extension.js",
      activationEvents: ["*"],
    }),
  );
  fs.writeFileSync(path.join(extension, "extension.js"), DUMP_EXTENSION);
  return scratch;
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One platform's dump: fresh server, fresh headless page, one file. */
async function dump(platform) {
  const scratch = scratchProfile();
  const dumpFile = path.join(scratch, "dump.json");
  const serverPort = await freePort();
  const server = spawn(
    await vscodeCli(),
    scratchServerArgs(serverPort, scratch),
    { env: { ...process.env, KEYMAP_DUMP_FILE: dumpFile }, stdio: "ignore" },
  );
  const chromePort = await freePort();
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${path.join(scratch, "chrome")}`,
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    await waitFor(() => answering(serverPort), 30_000, "the VS Code server");
    await waitFor(() => answering(chromePort), 15_000, "chrome devtools");
    const url = `http://127.0.0.1:${serverPort}/`;
    // the emulation override lives only as long as the debug session, so the
    // session stays open until the dump is on disk
    const target = await pageTarget(chromePort);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    try {
      if (platform === "linux") {
        await session.send("Emulation.setUserAgentOverride", {
          userAgent: LINUX_USER_AGENT,
          platform: "Linux x86_64",
          acceptLanguage: "en-US",
          userAgentMetadata: {
            platform: "Linux",
            platformVersion: "",
            architecture: "x86",
            model: "",
            mobile: false,
            brands: [{ brand: "Chromium", version: "150" }],
          },
        });
      }
      await session.send("Page.navigate", { url });
      await waitFor(() => fs.existsSync(dumpFile), 10 * 60_000, `the ${platform} keymap dump`);
    } finally {
      session.close();
    }
    const bindings = parseJsonc(fs.readFileSync(dumpFile, "utf8"));
    if (!Array.isArray(bindings) || bindings.length < 100) {
      throw new Error(`the ${platform} dump does not look like a keymap (${bindings?.length} entries)`);
    }
    return { bindings, version: fs.readFileSync(`${dumpFile}.version`, "utf8").trim() };
  } finally {
    chrome.kill("SIGKILL");
    server.kill("SIGTERM");
    // chrome can still be flushing its profile as it dies; a failed cleanup
    // must not eat a successful dump
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}

async function main() {
  const out = path.join(ROOT, "assets", "keymaps");
  fs.mkdirSync(out, { recursive: true });
  for (const platform of ["mac", "linux"]) {
    process.stderr.write(`dumping the ${platform} keymap from the VS Code server\n`);
    const { bindings, version } = await dump(platform);
    const file = path.join(out, `vscode-${platform}.json`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ vscode: version, platform, bindings }, null, 1)}\n`,
    );
    process.stderr.write(`  ${bindings.length} bindings -> ${path.relative(ROOT, file)}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
