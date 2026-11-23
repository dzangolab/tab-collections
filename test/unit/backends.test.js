// The sync storage backends, src/sync/backends.js, against fake servers (S1–S8 in docs/testing-plan.md).
import { fake } from '../fake-browser.js'; // must come first: common.js reads the API when loaded
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, AuthError, BackendError, ConflictError, makeBackend, originsFor } from '../../src/sync/backends.js';
import { configFor, fakeRemote } from '../fake-remote.js';

void fake;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setup(backend, over) {
  const remote = fakeRemote(backend);
  globalThis.fetch = remote.fetch;
  return { remote, b: makeBackend(configFor(backend, over)) };
}

describe('S1 API addresses and permissions', () => {
  test('github.com uses api.github.com; Enterprise, GitLab and Gitea use the server’s API path', () => {
    assert.equal(apiBase(configFor('github')), 'https://api.github.com');
    assert.equal(apiBase(configFor('github', { server: 'https://ghe.corp/' })), 'https://ghe.corp/api/v3');
    assert.equal(apiBase(configFor('gitlab')), 'https://gitlab.example/api/v4');
    assert.equal(apiBase(configFor('gitea')), 'https://codeberg.org/api/v1');
  });
  test('asks only for the one server', () => {
    assert.deepEqual(originsFor(configFor('github')), ['https://api.github.com/*']);
    assert.deepEqual(originsFor(configFor('webdav')), ['https://dav.example/*']);
  });
});

for (const backend of ['github', 'gitlab', 'gitea', 'webdav']) {
  describe(`S2–S7 ${backend}`, () => {
    test('S2 no file yet: text null; then a first write creates it', async () => {
      const { remote, b } = setup(backend);
      assert.deepEqual(await b.read(), { text: null, version: null });
      const v = await b.write('{"é":1}\n', null);
      assert.equal(remote.text, '{"é":1}\n');
      assert.ok(v);
    });
    test('S3 read gives the text and version; a write based on it succeeds', async () => {
      const { remote, b } = setup(backend);
      remote.put('one');
      const r = await b.read();
      assert.equal(r.text, 'one');
      const v = await b.write('two', r.version);
      assert.equal(remote.text, 'two');
      assert.equal((await b.read()).version, v, 'write returns the new version');
    });
    test('S4 a write based on an old version is a conflict, and changes nothing', async () => {
      const { remote, b } = setup(backend);
      remote.put('one');
      const { version } = await b.read();
      remote.put('from another device');
      await assert.rejects(b.write('mine', version), ConflictError);
      assert.equal(remote.text, 'from another device');
    });
    test('S5 creating a file that another device just created is a conflict', async () => {
      const { remote, b } = setup(backend);
      remote.put('theirs');
      await assert.rejects(b.write('mine', null), ConflictError);
    });
    test('S6 refused credentials: an AuthError', async () => {
      const { remote, b } = setup(backend);
      remote.status = 401;
      await assert.rejects(b.read(), AuthError);
    });
    test('S7 check: fails clearly when the repository or folder is missing, or the server is unreachable', async () => {
      const { remote, b } = setup(backend);
      await b.check();
      remote.repoExists = false;
      await assert.rejects(b.check(), /not found|doesn’t exist/);
      remote.offline = true;
      await assert.rejects(b.read(), (e) => e instanceof BackendError && /Can’t reach/.test(e.message));
    });
  });
}

test('S8 the token goes in the right header for each backend', async () => {
  const seen = {};
  for (const backend of ['github', 'gitlab', 'gitea', 'webdav']) {
    const { remote, b } = setup(backend);
    await b.read();
    seen[backend] = remote.requests[0].headers.Authorization;
  }
  assert.deepEqual(seen, {
    github: 'Bearer t0k', gitlab: 'Bearer t0k', gitea: 'token t0k', webdav: `Basic ${btoa('me:pw')}`,
  });
});
