'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { host, tick, deferred } = require('./helpers/clipboard');
const API = 'tode-clipboard-api', EVENT = 'tode-clipboard-event';

test('native read-back confirms an API write without reading the renderer', async () => {
  const target = host({ native: 'path' });
  assert.equal(target.send(API, 'path'), true);
  await tick();
  assert.deepEqual(target.copies, ['path']);
  assert.equal(target.isolatedReads.length, 0);
});

test('asynchronous native read-back is awaited without requiring renderer permission', async () => {
  const target = host({ native: Promise.resolve('native async') });
  target.send(API, 'native async');
  await tick();
  assert.deepEqual(target.copies, ['native async']);
  assert.equal(target.isolatedReads.length, 0);
});

test('a rejected native read can fall back to an already-granted renderer read', async () => {
  const target = host({ native: Promise.reject(new Error('unavailable')), permission: 'granted', renderer: 'text' });
  target.send(API, 'text');
  await tick();
  assert.deepEqual(target.copies, ['text']);
});

test('trusted messages are forwarded only to their owning window', () => {
  const first = host(), second = host();
  first.windows.set(second.rootView, second.window);
  first.bridge.handleClipboardMessage(second.event, { type: EVENT, text: 'second window' }, first.windows);
  assert.deepEqual(first.copies, []);
  assert.deepEqual(second.copies, ['second window']);
});

test('a newer API notification supersedes a pending read', async () => {
  const pending = deferred();
  const target = host({ native: pending.promise });
  target.send(API, 'old');
  target.state.native = Promise.resolve('new');
  target.send(API, 'new');
  pending.resolve('old');
  await tick();
  assert.deepEqual(target.copies, ['new']);
});

for (const permission of ['prompt', 'denied']) {
  test(`a page-provided payload cannot copy when read permission is ${permission}`, async () => {
    let reads = 0;
    const target = host({ permission, read: () => { reads++; return Promise.resolve('fake'); } });
    target.send(API, 'fake');
    await tick();
    assert.equal(reads, 0);
    assert.deepEqual(target.copies, []);
    assert.deepEqual(target.queries, ['clipboard-read']);
  });
}

test('isolated read-back with an existing grant can confirm a native mismatch', async () => {
  const target = host({ native: new Error('unavailable'), permission: 'granted', renderer: 'path' });
  target.send(API, 'path');
  await tick();
  assert.deepEqual(target.copies, ['path']);
  assert.deepEqual(target.isolatedReads, [1013]);
});

for (const read of [async () => 'different', async () => { throw new Error('denied'); }]) {
  test('mismatching or failed renderer read-back does not forward the payload', async () => {
    const target = host({ permission: 'granted', read });
    target.send(API, 'fake');
    await tick();
    assert.deepEqual(target.copies, []);
  });
}

test('unsupported messages remain available to the existing theme/timing handler', () => {
  const target = host();
  assert.equal(target.bridge.handleClipboardMessage(target.event, { type: 'theme' }, target.windows), false);
  assert.equal(target.bridge.handleClipboardMessage(target.event, null, target.windows), false);
});

test('subframes, unknown windows, destroyed senders and malformed payloads are ignored', async () => {
  const target = host({ native: 'text' });
  target.send(EVENT, 'text', { senderFrame: {} });
  target.send(EVENT, 'text', { senderFrame: null });
  target.send(EVENT, {});
  target.send(API, null);
  target.send(EVENT, '');
  target.windows.clear();
  target.send(EVENT, 'text');
  target.state.destroyed = true;
  target.send(API, 'text');
  await tick();
  assert.deepEqual(target.copies, []);
  assert.equal(target.nativeReads.length, 0);
});

for (const kind of ['navigation', 'destroyed', 'window closed', 'view replaced', 'frame replaced', 'newer copy']) {
  test(`pending API validation is discarded after ${kind}`, async () => {
    const pending = deferred();
    const target = host({ permission: 'granted', read: () => pending.promise });
    target.send(API, 'old');
    await tick();
    if (kind === 'navigation') target.contents.emit('did-start-navigation', {}, 'http://localhost/new', false, true);
    if (kind === 'destroyed') target.contents.emit('destroyed');
    if (kind === 'window closed') target.windows.clear();
    if (kind === 'view replaced') target.window.view = null;
    if (kind === 'frame replaced') target.contents.mainFrame = {};
    if (kind === 'newer copy') target.send(EVENT, 'new');
    pending.resolve('old');
    await tick();
    assert.deepEqual(target.copies, kind === 'newer copy' ? ['new'] : []);
  });
}

test('subframe and same-document navigation do not cancel a valid main-frame read', async () => {
  const pending = deferred();
  const target = host({ permission: 'granted', read: () => pending.promise });
  target.send(API, 'text');
  await tick();
  target.contents.emit('did-start-navigation', {}, 'url', false, false);
  target.contents.emit('did-start-navigation', {}, 'url#hash', true, true);
  pending.resolve('text');
  await tick();
  assert.deepEqual(target.copies, ['text']);
});

test('lifecycle listeners register once per WebContents', () => {
  const target = host();
  target.send(EVENT, 'first'); target.send(EVENT, 'second');
  assert.equal(target.contents.listenerCount('did-start-navigation'), 1);
  assert.equal(target.contents.listenerCount('destroyed'), 1);
});
