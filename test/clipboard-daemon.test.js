'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { host, source, tick } = require('./helpers/clipboard');

function daemon(options) {
  const target = host(options);
  const ipcMain = new EventEmitter(), probe = new EventEmitter(), writes = [];
  let accept, rootOptions;
  const handle = target.window.view;
  const root = Object.assign(target.rootView, {
    render: element => element.props.ref(handle),
    stop: () => rootOptions.onExit(0),
  });
  const mocks = {
    'node:fs': { mkdirSync() {}, rmSync() {}, writeFileSync: (...args) => writes.push(args) },
    'node:net': { connect: () => probe, createServer: callback => {
      accept = callback;
      return { on() {}, listen() {} };
    } },
    'node:path': require('node:path'),
    '@zenbu-labs/pixel/electron': { ipcMain, app: { setPath() {}, exit() {} } },
    '@zenbu-labs/pixel': { WebView: 'WebView', createRoot: options => { rootOptions = options; return root; } },
    react: { createElement: (type, props) => ({ type, props }) },
    '../ipc': {}, '../livesync': {},
    '../profile': { transparencyEnabled: () => false },
    './messages': { MESSAGE_CHANNEL: 'tode:message' },
    './clipboard': target.bridge,
    './protocol': {
      browserProfileDir: () => '/tmp/fake-tode-profile',
      buildStamp: () => 'test', daemonSocket: () => '/tmp/fake-tode.sock',
      daemonPidFile: () => '/tmp/fake-tode.pid',
      lines: callback => data => String(data).split('\n').filter(Boolean).forEach(callback),
    },
  };
  vm.runInNewContext(source('dist/app/daemon.js'), {
    __filename: '/tmp/tode/dist/app/daemon.js', __dirname: '/tmp/tode/dist/app',
    exports: {}, require: name => {
      if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
      return mocks[name];
    },
    process: { pid: 123, on() {}, stderr: { write() {} } },
    setTimeout: () => 1, clearTimeout() {},
  });
  probe.emit('error', new Error('not serving yet'));
  const connection = Object.assign(new EventEmitter(), { write() {}, end() {} });
  accept(connection);
  connection.emit('data', JSON.stringify({ cmd: 'open', url: 'http://127.0.0.1:35589/', timingFile: '/tmp/fake-timing.json' }));
  return { ...target, root, writes,
    ipc: message => ipcMain.emit('tode:message', target.event, message),
  };
}

test('the compiled daemon forwards trusted Copy/Cut IPC to the correct root', () => {
  const app = daemon();
  app.ipc({ type: 'tode-clipboard-event', text: 'menu text' });
  assert.deepEqual(app.copies, ['menu text']);
});

test('the actual daemon forwards confirmed API text and rejects unconfirmed text', async () => {
  const app = daemon({ native: 'path' });
  app.ipc({ type: 'tode-clipboard-api', text: 'path' });
  await tick();
  app.ipc({ type: 'tode-clipboard-api', text: 'forged' });
  await tick();
  assert.deepEqual(app.copies, ['path']);
});

test('closed daemon windows cannot continue to publish clipboard messages', () => {
  const app = daemon();
  app.root.stop();
  app.ipc({ type: 'tode-clipboard-event', text: 'closed' });
  assert.deepEqual(app.copies, []);
});

test('the original page timing IPC path remains functional', () => {
  const app = daemon();
  app.ipc({ type: 'timing', page: { at: 42 } });
  const saved = app.writes.find(([file]) => file === '/tmp/fake-timing.json');
  assert.equal(saved[1], JSON.stringify({ at: 42 }));
});
