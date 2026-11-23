// The sync file format and its encryption, src/sync/file.js (F1–F7 in docs/testing-plan.md).
import { fake } from '../fake-browser.js'; // must come first: common.js reads the API when loaded
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImport } from '../../src/common.js';
import {
  base64ToUtf8, decrypt, encrypt, ENCRYPTED_FORMAT, readSyncFile, utf8ToBase64, writeSyncFile,
} from '../../src/sync/file.js';

void fake;
const col = { id: 'c1', name: 'Café ☕', description: 'd', pages: [{ url: 'https://a.example/', title: 'A' }], createdAt: 1, updatedAt: 2 };
const snapshot = { collections: { c1: col }, tombstones: { gone: 5 } };

describe('sync file', () => {
  test('F1 a plain file round-trips, with tombstones, and no changing timestamp', async () => {
    const text = await writeSyncFile(snapshot, '');
    assert.equal(JSON.parse(text).exportedAt, undefined);
    assert.equal(text, await writeSyncFile(snapshot, ''), 'the same data gives the same file');
    const r = await readSyncFile(text, '');
    assert.deepEqual(r.snapshot, snapshot);
    assert.equal(r.encrypted, false);
  });

  test('F2 a plain sync file can be imported by hand', async () => {
    const { collections } = parseImport(await writeSyncFile(snapshot, ''));
    assert.deepEqual(collections.map((c) => c.name), ['Café ☕']);
  });

  test('F3 no file yet: an empty snapshot', async () => {
    assert.deepEqual((await readSyncFile(null, '')).snapshot, { collections: {}, tombstones: {} });
  });

  test('F4 an encrypted file round-trips and holds no plain text', async () => {
    const text = await writeSyncFile(snapshot, 'correct horse');
    assert.equal(JSON.parse(text).format, ENCRYPTED_FORMAT);
    assert.ok(!text.includes('Café') && !text.includes('a.example'));
    const r = await readSyncFile(text, 'correct horse');
    assert.deepEqual(r.snapshot, snapshot);
    assert.equal(r.encrypted, true);
    assert.equal(r.salt.length, 16);
  });

  test('F5 a wrong or missing passphrase is refused with a clear message', async () => {
    const env = await encrypt('{}', 'right', { iterations: 1000 });
    await assert.rejects(decrypt(env, 'wrong'), /Wrong passphrase/);
    await assert.rejects(readSyncFile(JSON.stringify(env), ''), /encrypted\. Enter its passphrase/);
  });

  test('F6 encryption on, but the file is plain: refused', async () => {
    await assert.rejects(readSyncFile(await writeSyncFile(snapshot, ''), 'secret'), /isn’t encrypted/);
  });

  test('F7 not a Tab Collections file, or not JSON: refused', async () => {
    await assert.rejects(readSyncFile('{"hello":1}', ''), /isn’t a Tab Collections file/);
    await assert.rejects(readSyncFile('<html>', ''), /isn’t valid JSON/);
  });

  test('F8 UTF-8 base64 helpers', () => {
    assert.equal(base64ToUtf8(utf8ToBase64('Café ☕')), 'Café ☕');
    assert.equal(base64ToUtf8('Q2Fm\nw6k='), 'Café', 'line breaks, as GitHub sends, are ignored');
  });
});
