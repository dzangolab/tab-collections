// The sync engine (src/sync/engine.js) through the background's messages, against a fake server
// (SE1–SE15 in docs/testing-plan.md). "Another device" writes the sync file directly.
import { fake } from '../fake-browser.js';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCollection, putCollection, removeCollection, send } from '../../src/common.js';
import { readSyncFile, writeSyncFile } from '../../src/sync/file.js';
import { CHECK_ALARM, PUSH_DELAY_MS } from '../../src/sync/engine.js';
import { configFor, fakeRemote } from '../fake-remote.js';

await import('../../src/background.js');

const realFetch = globalThis.fetch;
let remote;
let mine;

beforeEach(() => {
  fake.reset();
  remote = fakeRemote('github');
  globalThis.fetch = remote.fetch;
  mine = makeCollection({ id: 'm', name: 'Mine', pages: [{ url: 'https://a.example/', title: 'A' }] });
  fake.store.collections = { m: mine };
});
afterEach(async () => {
  mock.timers.reset();
  await fake.flush();
  globalThis.fetch = realFetch;
});

const setup = (over = {}) => send({ type: 'syncSetup', config: { ...configFor('github'), mode: 'auto', ...over } });
const remoteSnap = async (pass = '') => (await readSyncFile(remote.text, pass)).snapshot;
const puts = () => remote.requests.filter((r) => r.method === 'PUT').length;
const col = (id, name, urls) => makeCollection({ id, name, pages: urls.map((url) => ({ url, title: url })) });
// Another device: changes the sync file.
async function elsewhere(change, pass = '') {
  const snap = await remoteSnap(pass);
  change(snap);
  remote.put(await writeSyncFile(snap, pass));
}

describe('SE1–SE3 setup', () => {
  test('SE1 an empty sync file gets this device’s collections; a periodic check is scheduled', async () => {
    await setup();
    assert.deepEqual(Object.keys((await remoteSnap()).collections), ['m']);
    assert.equal(fake.store.syncConfig.token, 't0k');
    assert.ok(fake.alarms.get(CHECK_ALARM));
    const status = await send({ type: 'syncStatus' });
    assert.equal(status.configured, true);
    assert.equal(status.unsynced, false);
    assert.ok(status.lastSyncAt);
  });

  test('SE2 an existing sync file: the collections on both sides are united', async () => {
    remote.put(await writeSyncFile({ collections: { t: col('t', 'Theirs', ['https://t.example/']) }, tombstones: {} }, ''));
    await setup();
    assert.deepEqual(Object.keys(fake.store.collections).sort(), ['m', 't']);
    assert.deepEqual(Object.keys((await remoteSnap()).collections).sort(), ['m', 't']);
  });

  test('SE3 bad settings or a wrong passphrase: refused, nothing saved', async () => {
    remote.put(await writeSyncFile({ collections: {}, tombstones: {} }, 'right'));
    await assert.rejects(setup({ passphrase: 'wrong' }), /Wrong passphrase/);
    await assert.rejects(setup({ repo: 'no-slash' }), /owner\/name/);
    await assert.rejects(setup({ server: 'http://insecure.example' }), /https/);
    assert.equal(fake.store.syncConfig, undefined);
  });
});

describe('SE4–SE7 automatic mode', () => {
  test('SE4 a local edit is pushed a few seconds later, in one write for several edits', async () => {
    await setup();
    const before = puts();
    mock.timers.enable({ apis: ['setTimeout'] });
    await putCollection({ ...mine, name: 'Renamed' });
    await fake.flush();
    await putCollection({ ...fake.store.collections.m, description: 'and described' });
    await fake.flush();
    assert.equal(puts(), before, 'not yet');
    mock.timers.tick(PUSH_DELAY_MS);
    await fake.flush();
    assert.equal(puts(), before + 1);
    const m = (await remoteSnap()).collections.m;
    assert.deepEqual([m.name, m.description], ['Renamed', 'and described']);
  });

  test('SE5 the sync’s own writes don’t start another sync', async () => {
    remote.put(await writeSyncFile({ collections: { t: col('t', 'Theirs', ['https://t.example/']) }, tombstones: {} }, ''));
    await setup();
    const requests = remote.requests.length;
    mock.timers.enable({ apis: ['setTimeout'] });
    mock.timers.tick(PUSH_DELAY_MS);
    await fake.flush();
    assert.equal(remote.requests.length, requests);
  });

  test('SE6 the periodic check merges remote changes in', async () => {
    await setup();
    await elsewhere((s) => { s.collections.m.name = 'Renamed elsewhere'; });
    fake.fireAlarm(CHECK_ALARM);
    await fake.flush();
    assert.equal(fake.store.collections.m.name, 'Renamed elsewhere');
  });

  test('SE7 deletions travel both ways, as tombstones', async () => {
    fake.store.collections.x = col('x', 'X', ['https://x.example/']);
    await setup();
    await removeCollection('x');
    await send({ type: 'syncNow' });
    const snap = await remoteSnap();
    assert.equal(snap.collections.x, undefined);
    assert.ok(snap.tombstones.x);
    await elsewhere((s) => { delete s.collections.m; s.tombstones.m = Date.now(); });
    await send({ type: 'syncNow' });
    assert.equal(fake.store.collections.m, undefined);
  });
});

describe('SE8–SE9 manual mode', () => {
  test('SE8 local changes wait for Sync; the status says so', async () => {
    await setup({ mode: 'manual' });
    const before = puts();
    mock.timers.enable({ apis: ['setTimeout'] });
    await putCollection({ ...mine, name: 'Renamed' });
    await fake.flush();
    mock.timers.tick(PUSH_DELAY_MS * 10);
    await fake.flush();
    assert.equal(puts(), before);
    assert.equal((await send({ type: 'syncStatus' })).unsynced, true);
    mock.timers.reset();
    await send({ type: 'syncNow' });
    assert.equal((await remoteSnap()).collections.m.name, 'Renamed');
    assert.equal((await send({ type: 'syncStatus' })).unsynced, false);
  });

  test('SE9 remote changes are only announced (with a badge dot) until Sync', async () => {
    await setup({ mode: 'manual' });
    await elsewhere((s) => { s.collections.m.name = 'Renamed elsewhere'; });
    fake.fireAlarm(CHECK_ALARM);
    await fake.flush();
    assert.equal(fake.store.collections.m.name, 'Mine');
    assert.equal((await send({ type: 'syncStatus' })).remoteChanged, true);
    assert.equal(fake.badge, '•');
    await send({ type: 'syncNow' });
    assert.equal(fake.store.collections.m.name, 'Renamed elsewhere');
    assert.equal(fake.badge, '');
  });
});

describe('SE10–SE12 conflicts', () => {
  async function conflicted() {
    await setup();
    await elsewhere((s) => { s.collections.m.name = 'Theirs'; });
    fake.store.collections = { m: { ...fake.store.collections.m, name: 'Ours' } };
    await send({ type: 'syncNow' });
  }

  test('SE10 both renamed: this device keeps its version, the sync file keeps theirs, the user is asked', async () => {
    await conflicted();
    assert.equal(fake.store.collections.m.name, 'Ours');
    assert.equal((await remoteSnap()).collections.m.name, 'Theirs');
    const status = await send({ type: 'syncStatus' });
    assert.equal(status.conflicts.m.theirs.name, 'Theirs');
    assert.equal(fake.badge, '•');
    await send({ type: 'syncNow' });
    assert.equal((await remoteSnap()).collections.m.name, 'Theirs', 'an open conflict isn’t pushed');
  });

  test('SE11 Keep mine pushes this device’s version; Keep theirs takes the other', async () => {
    await conflicted();
    await send({ type: 'syncResolve', id: 'm', choice: 'mine' });
    await send({ type: 'syncNow' });
    assert.equal((await remoteSnap()).collections.m.name, 'Ours');
    assert.equal(fake.badge, '');

    await elsewhere((s) => { s.collections.m.name = 'Theirs 2'; });
    fake.store.collections = { m: { ...fake.store.collections.m, name: 'Ours 2' } };
    await send({ type: 'syncNow' });
    await send({ type: 'syncResolve', id: 'm', choice: 'theirs' });
    assert.equal(fake.store.collections.m.name, 'Theirs 2');
  });

  test('SE12 Keep both keeps theirs and saves mine as a copy, which syncs too', async () => {
    await conflicted();
    await send({ type: 'syncResolve', id: 'm', choice: 'both' });
    await send({ type: 'syncNow' });
    const names = Object.values((await remoteSnap()).collections).map((c) => c.name).sort();
    assert.deepEqual(names, ['Ours (copy)', 'Theirs']);
  });
});

describe('SE13–SE15 robustness', () => {
  test('SE13 another device writes between our read and write: we re-read, merge, and keep both changes', async () => {
    await setup();
    const real = remote.fetch;
    let raced = false;
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'PUT' && !raced) {
        raced = true;
        await elsewhere((s) => { s.collections.t = col('t', 'Theirs', ['https://t.example/']); });
      }
      return real(url, init);
    };
    await putCollection({ ...mine, name: 'Renamed' });
    await send({ type: 'syncNow' });
    const snap = await remoteSnap();
    assert.deepEqual([snap.collections.m.name, !!snap.collections.t], ['Renamed', true]);
    assert.ok(fake.store.collections.t);
  });

  test('SE14 offline: the error is recorded, local changes stay, and the next sync goes through', async () => {
    await setup();
    await putCollection({ ...mine, name: 'Offline edit' });
    remote.offline = true;
    await assert.rejects(send({ type: 'syncNow' }), /Can’t reach/);
    const status = await send({ type: 'syncStatus' });
    assert.match(status.lastError, /Can’t reach/);
    assert.equal(status.unsynced, true);
    remote.offline = false;
    await send({ type: 'syncNow' });
    assert.equal((await remoteSnap()).collections.m.name, 'Offline edit');
    assert.equal((await send({ type: 'syncStatus' })).lastError, null);
  });

  test('SE15 encrypted: the server only sees ciphertext; Disconnect stops syncing and keeps the collections', async () => {
    await setup({ passphrase: 'correct horse' });
    assert.ok(!remote.text.includes('Mine'));
    assert.equal((await remoteSnap('correct horse')).collections.m.name, 'Mine');
    await send({ type: 'syncDisconnect' });
    assert.equal((await send({ type: 'syncStatus' })).configured, false);
    assert.equal(fake.alarms.get(CHECK_ALARM), undefined);
    assert.ok(fake.store.collections.m);
  });
});
