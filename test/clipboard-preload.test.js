'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { host, preload, tick, deferred } = require('./helpers/clipboard');

for (const type of ['copy', 'cut']) {
  test(`${type} reads trusted plain text synchronously without trimming`, () => {
    const page = preload();
    let text = '  text\n';
    page.dispatch(type, { isTrusted: true, clipboardData: { getData: format => {
      assert.equal(format, 'text/plain'); return text;
    } } });
    text = '';
    assert.equal(page.sends.length, 1);
    assert.equal(page.sends[0][0], 'tode:message');
    assert.equal(page.sends[0][1].type, 'tode-clipboard-event');
    assert.equal(page.sends[0][1].text, '  text\n');
  });
  test(`${type} rejects synthetic events and ignores absent or empty data`, () => {
    const page = preload();
    page.dispatch(type, { isTrusted: false, clipboardData: { getData: () => 'fake' } });
    page.dispatch(type, { isTrusted: true });
    page.dispatch(type, { isTrusted: true, clipboardData: { getData: () => '' } });
    assert.equal(page.sends.length, 0);
  });
}

test('subframes do not install clipboard hooks', () => {
  const clipboard = { writeText: async () => {} };
  const original = clipboard.writeText;
  const page = preload({ clipboard, mainFrame: false });
  assert.equal(page.documentListeners.size, 0);
  assert.equal(clipboard.writeText, original);
});

test('no copy-on-selection handler is introduced and theme forwarding is retained', () => {
  const page = preload();
  assert.equal(page.documentListeners.has('mouseup'), false);
  assert.equal(page.themes.length, 1);
  page.themes[0]({ background: '#000' });
  assert.equal(page.sends[0][1].type, 'theme');
});

test('writeText preserves its receiver, arguments and result, and signals only after success', async () => {
  const pending = deferred(), calls = [];
  const clipboard = { writeText: function (...args) { calls.push([this, args]); return pending.promise; } };
  const page = preload({ clipboard });
  const result = clipboard.writeText('/project/file.ts', 'extra');
  assert.equal(page.sends.length, 0);
  assert.equal(calls[0][0], clipboard);
  assert.deepEqual(calls[0][1], ['/project/file.ts', 'extra']);
  pending.resolve('native result');
  assert.equal(await result, 'native result');
  assert.equal(page.sends[0][1].type, 'tode-clipboard-api');
  assert.equal(page.sends[0][1].text, '/project/file.ts');
});

for (const method of ['writeText', 'write']) {
  test(`a failed ${method} preserves its original error and never signals`, async () => {
    const failure = new Error('NotAllowedError');
    const clipboard = { [method]: async () => { throw failure; } };
    const page = preload({ clipboard });
    await assert.rejects(clipboard[method]('denied'), error => error === failure);
    assert.equal(page.sends.length, 0);
  });
}

test('write forwards text/plain rather than HTML or image data', async () => {
  const clipboard = { write: async () => 'ok' };
  const page = preload({ clipboard });
  await clipboard.write([{ types: ['text/html', 'text/plain'], getType: async type => {
    assert.equal(type, 'text/plain'); return new Blob(['relative/file.ts']);
  } }]);
  assert.equal(page.sends[0][1].text, 'relative/file.ts');
});

test('empty, non-string writeText and image-only writes do not forward text', async () => {
  const clipboard = { writeText: async () => {}, write: async () => {} };
  const page = preload({ clipboard });
  await clipboard.writeText('');
  await clipboard.writeText({ toString: () => 'object' });
  await clipboard.write([{ types: ['image/png'] }]);
  assert.equal(page.sends.length, 0);
});

test('a broken notification or ClipboardItem does not reject a successful write', async () => {
  const clipboard = { writeText: async () => 'ok', write: async () => 'ok' };
  const page = preload({ clipboard });
  page.main.postMessage = () => { throw new Error('unavailable'); };
  assert.equal(await clipboard.writeText('text'), 'ok');
  assert.equal(await clipboard.write([{ types: ['text/plain'], getType: async () => { throw new Error('unavailable'); } }]), 'ok');
});

test('unavailable and locked Clipboard API methods do not prevent trusted event hooks', () => {
  const absent = preload({ clipboard: null });
  assert.equal(absent.documentListeners.has('copy'), true);
  const clipboard = {};
  Object.defineProperty(clipboard, 'writeText', { value: async () => {}, configurable: false });
  const locked = preload({ clipboard });
  assert.equal(locked.documentListeners.has('cut'), true);
});

test('cross-window and malformed signals cannot become trusted clipboard events', () => {
  const page = preload();
  page.post({ source: 'tode-clipboard-fix-v1', text: 'fake' }, {});
  page.post({ source: 'other', text: 'fake' });
  page.post({ source: 'tode-clipboard-fix-v1', text: {} });
  page.post({ source: 'tode-clipboard-fix-v1', text: '' });
  assert.equal(page.sends.length, 0);
  page.post({ source: 'tode-clipboard-fix-v1', text: 'page claim', type: 'tode-clipboard-event' });
  assert.equal(page.sends[0][1].type, 'tode-clipboard-api');
});

test('the complete preload/host path forwards real events but rejects forged API claims', async () => {
  const target = host();
  const page = preload({ relay: message => target.bridge.handleClipboardMessage(target.event, message, target.windows) });
  page.dispatch('copy', { isTrusted: true, clipboardData: { getData: () => 'menu text' } });
  assert.deepEqual(target.copies, ['menu text']);
  page.post({ source: 'tode-clipboard-fix-v1', text: 'forged text' });
  await tick();
  assert.deepEqual(target.copies, ['menu text']);
});
