'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
function moduleAt(relative, mocks) {
  const exports = {};
  vm.runInNewContext(source(relative), { exports, process: { platform: process.platform }, require: name => {
    if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`);
    return mocks[name];
  } }, { filename: relative });
  return exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function host({ native = '', permission = 'prompt', renderer = '', read } = {}) {
  const copies = [], nativeReads = [], isolatedReads = [], queries = [];
  const state = { native, permission, renderer, destroyed: false };
  const frame = {};
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => state.destroyed,
    executeJavaScriptInIsolatedWorld: async (id, scripts) => {
      isolatedReads.push(id);
      return vm.runInNewContext(scripts[0].code, { navigator: {
        permissions: { query: async descriptor => {
          queries.push(descriptor.name);
          return { state: state.permission };
        } },
        clipboard: { readText: () => read ? read() : Promise.resolve(state.renderer) },
      } });
    },
  });
  const electron = { clipboard: { readText: () => {
    nativeReads.push(true);
    if (state.native instanceof Error) throw state.native;
    return state.native;
  } } };
  const bridge = moduleAt('dist/app/clipboard.js', { '@zenbu-labs/pixel/electron': electron });
  const rootView = { setClipboard: text => copies.push(text) };
  const window = { view: { webContents: contents } };
  const windows = new Map([[rootView, window]]);
  const event = { sender: contents, senderFrame: frame };
  return { copies, nativeReads, isolatedReads, queries, state, contents, window, windows, event, rootView, bridge,
    send: (type, text, override = {}) => bridge.handleClipboardMessage({ ...event, ...override }, { type, text }, windows),
  };
}
function preload({ clipboard = {}, mainFrame = true, relay } = {}) {
  const sends = [], documentListeners = new Map(), windowListeners = new Map(), themes = [];
  const isolatedWindow = {};
  isolatedWindow.top = mainFrame ? isolatedWindow : {};
  isolatedWindow.addEventListener = (type, listener) => windowListeners.set(type, listener);
  const post = (data, source = isolatedWindow) => windowListeners.get('message')?.({ data, source });
  const main = vm.createContext({ navigator: { clipboard } });
  main.window = main;
  main.postMessage = data => post(data);
  const electron = {
    ipcRenderer: { send: (channel, message) => {
      sends.push([channel, message]);
      relay?.(message);
    } },
    webFrame: { executeJavaScript: async code => vm.runInContext(code, main) },
  };
  vm.runInNewContext(source('dist/app/preload.js'), {
    exports: {}, require: name => { if (name !== 'electron') throw new Error(name); return electron; },
    process: { isMainFrame: mainFrame }, window: isolatedWindow,
    document: { addEventListener: (type, listener) => documentListeners.set(type, listener) },
    pixel: { onTheme: listener => themes.push(listener) },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    performance: { getEntriesByType: () => [], getEntriesByName: () => [] },
  });
  return { sends, main, themes, documentListeners, post,
    dispatch: (type, event) => documentListeners.get(type)?.(event),
  };
}
module.exports = { source, moduleAt, host, preload, tick, deferred };
