// The sync screens: the Sync panel, status and notice on the Collections page, conflict strips,
// and the popup's Sync row (Y1–Y10 in docs/testing-plan.md).
import { fake } from '../fake-browser.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCollection } from '../../src/common.js';
import { fire, loadPage, resetPage, sentTypes, settle, setValue, submit, text } from './harness.js';

const A = 'https://a.example/';
let beta;
beforeEach(() => {
  resetPage();
  beta = makeCollection({ id: 'b', name: 'Beta', pages: [{ url: A, title: 'A' }] });
  fake.store.collections = { b: beta };
});

const ok = (result = null) => () => result;
const connected = (over = {}) => ({
  configured: true, backend: 'github', label: 'GitHub', where: 'github.com/o/r · tab-collections.json', encrypted: false,
  mode: 'auto', lastSyncAt: Date.now(), lastError: null, remoteChanged: false, unsynced: false, conflicts: {}, ...over,
});
const openCollections = (status, handlers = {}, opts = {}) => loadPage('collections', {
  handlers: { driftStatus: ok({}), syncStatus: ok(status), ...handlers }, ...opts,
});
const toast = (page) => text(page.$('toast'));
const button = (root, label) => [...root.querySelectorAll('button')].find((b) => text(b) === label);
const input = (page, name) => page.$('syncPanel').querySelector(`[name=${name}]`);

describe('Y1–Y4 setup form', () => {
  test('Y1 not set up: the form, no Sync button in the top bar', async () => {
    const page = await openCollections({ configured: false });
    assert.equal(page.$('sync').hidden, true);
    assert.ok(page.$('syncPanel').querySelector('form'));
    assert.match(text(page.$('syncPanel')), /A fine-grained personal access token/);
  });

  test('Y2 WebDAV shows the file address and username instead of the repository', async () => {
    const page = await openCollections({ configured: false });
    const form = page.$('syncPanel').querySelector('form');
    setValue(input(page, 'backend'), 'webdav', 'change');
    assert.equal(input(page, 'url').closest('.grid').hidden, false);
    assert.equal(input(page, 'repo').closest('.grid').hidden, true);
    assert.match(text(form), /app password/);
  });

  test('Y3 valid settings: asks for the one server, then sets up sync', async () => {
    const page = await openCollections({ configured: false }, { syncSetup: ok() });
    setValue(input(page, 'repo'), 'me/tabs');
    setValue(input(page, 'token'), 'secret');
    submit(page.$('syncPanel').querySelector('form'));
    await settle();
    assert.deepEqual(fake.permissionRequests, [['https://api.github.com/*']]);
    const setup = page.sent.find((m) => m.type === 'syncSetup');
    assert.deepEqual(
      [setup.config.server, setup.config.repo, setup.config.branch, setup.config.path, setup.config.passphrase],
      ['https://github.com', 'me/tabs', 'main', 'tab-collections.json', ''],
    );
    assert.equal(toast(page), 'Sync is set up');
  });

  test('Y4 refused: bad settings, mismatched passphrases, or no access to the server', async () => {
    const page = await openCollections({ configured: false }, { syncSetup: ok() });
    const form = page.$('syncPanel').querySelector('form');
    setValue(input(page, 'repo'), 'no-slash');
    setValue(input(page, 'token'), 'secret');
    submit(form);
    await settle();
    assert.match(toast(page), /owner\/name/);
    setValue(input(page, 'repo'), 'me/tabs');
    input(page, 'encrypt').checked = true;
    fire(input(page, 'encrypt'), 'change');
    setValue(input(page, 'passphrase'), 'one');
    setValue(input(page, 'passphrase2'), 'two');
    submit(form);
    await settle();
    assert.match(toast(page), /passphrases differ/);
    setValue(input(page, 'passphrase2'), 'one');
    fake.options.grantPermissions = false;
    submit(form);
    await settle();
    assert.match(toast(page), /needs access to that server/);
    assert.ok(!sentTypes(page).includes('syncSetup'));
  });

  test('Y4b filled-in defaults; <owner> must be replaced; the server follows the backend unless typed', async () => {
    const page = await openCollections({ configured: false }, { syncSetup: ok() });
    assert.deepEqual(['server', 'repo', 'branch', 'path'].map((n) => input(page, n).value),
      ['https://github.com', '<owner>/tab-collections', 'main', 'tab-collections.json']);
    setValue(input(page, 'token'), 'secret');
    submit(page.$('syncPanel').querySelector('form'));
    await settle();
    assert.equal(toast(page), 'Replace <owner> with your user or organisation name.');
    setValue(input(page, 'backend'), 'gitlab', 'change');
    assert.equal(input(page, 'server').value, 'https://gitlab.com');
    setValue(input(page, 'server'), 'https://git.mine.example');
    setValue(input(page, 'backend'), 'gitea', 'change');
    assert.equal(input(page, 'server').value, 'https://git.mine.example');
  });

  test('Y4c the token and both passphrases have an eye button that shows the value, then hides it', async () => {
    const page = await openCollections({ configured: false });
    for (const name of ['token', 'passphrase', 'passphrase2']) {
      const field = input(page, name);
      const eye = field.parentElement.querySelector('button.reveal');
      assert.equal(field.type, 'password');
      assert.equal(eye.type, 'button', 'never submits the form');
      fire(eye, 'click');
      assert.equal(field.type, 'text');
      assert.equal(eye.getAttribute('aria-pressed'), 'true');
      assert.match(eye.getAttribute('aria-label'), /^Hide the /);
      fire(eye, 'click');
      assert.equal(field.type, 'password');
      assert.match(eye.getAttribute('aria-label'), /^Show the /);
    }
    const tokenEye = input(page, 'token').parentElement.querySelector('button.reveal');
    assert.equal(tokenEye.getAttribute('aria-label'), 'Show the access token');
    setValue(input(page, 'backend'), 'webdav', 'change');
    fire(tokenEye, 'click');
    assert.equal(tokenEye.getAttribute('aria-label'), 'Hide the password', 'follows the field’s label');
    assert.ok(!sentTypes(page).includes('syncSetup'));
  });
});

describe('Y5–Y8 set up', () => {
  test('Y5 the top bar shows Sync and the status; Sync syncs', async () => {
    const page = await openCollections(connected({ lastSyncAt: Date.now() - 120_000 }), { syncNow: ok() });
    assert.equal(page.$('sync').hidden, false);
    assert.equal(text(page.$('syncStatus')), 'Synced 2 min ago');
    fire(page.$('sync'), 'click');
    await settle();
    assert.ok(sentTypes(page).includes('syncNow'));
  });

  test('Y6 the panel: where, mode, Disconnect', async () => {
    const page = await openCollections(connected({ encrypted: true }), { syncMode: ok(), syncDisconnect: ok() }, { confirm: [true] });
    const panel = page.$('syncPanel');
    assert.match(text(panel), /Syncing with GitHub: github\.com\/o\/r · tab-collections\.json\s*Encrypted/);
    setValue(panel.querySelector('select'), 'manual', 'change');
    await settle();
    assert.deepEqual(page.sent.find((m) => m.type === 'syncMode'), { type: 'syncMode', mode: 'manual' });
    fire(button(panel, 'Disconnect'), 'click');
    await settle();
    assert.ok(sentTypes(page).includes('syncDisconnect'));
  });

  test('Y7 a failure or changes from another device show a notice with Sync', async () => {
    let page = await openCollections(connected({ lastError: 'Access denied' }));
    assert.match(text(page.$('syncNotice')), /Sync failed: Access denied/);
    resetPage();
    fake.store.collections = { b: beta };
    page = await openCollections(connected({ remoteChanged: true, mode: 'manual' }));
    assert.match(text(page.$('syncNotice')), /changed on another device/);
    assert.ok(button(page.$('syncNotice'), 'Sync'));
  });

  test('Y8 a conflict: a strip on the card with Keep mine, Keep theirs and Keep both', async () => {
    const theirs = { ...beta, name: 'Beta there' };
    const page = await openCollections(connected({ conflicts: { b: { theirs } } }), { syncResolve: ok() });
    const card = page.doc.querySelector('#cards .card');
    assert.match(text(card), /changed on another device too \(there: “Beta there”, 1 page\)/);
    fire(button(card, 'Keep both'), 'click');
    await settle();
    assert.deepEqual(page.sent.find((m) => m.type === 'syncResolve'), { type: 'syncResolve', id: 'b', choice: 'both' });
  });
});

test('Y9 the Collection page shows the conflict strip too', async () => {
  const page = await loadPage('collection', {
    search: '?id=b',
    handlers: { driftStatus: ok({}), syncStatus: ok(connected({ conflicts: { b: { theirs: null } } })) },
  });
  assert.match(text(page.$('drift')), /deleted on another device/);
  assert.deepEqual([...page.$('drift').querySelectorAll('button')].map(text), ['Keep mine', 'Delete']);
});

test('Y10 the popup: a Sync row only when sync is set up', async () => {
  fake.openWindow([A]);
  let page = await loadPage('popup', { handlers: { driftStatus: ok({}), syncStatus: ok({ configured: false }) } });
  assert.equal(page.$('syncRow').hidden, true);
  resetPage();
  fake.store.collections = { b: beta };
  fake.openWindow([A]);
  page = await loadPage('popup', { handlers: { driftStatus: ok({}), syncStatus: ok(connected({ unsynced: true, mode: 'manual' })), syncNow: ok() } });
  assert.equal(page.$('syncRow').hidden, false);
  assert.equal(text(page.$('syncText')), 'Local changes not synced yet');
  fire(button(page.$('syncRow'), 'Sync'), 'click');
  await settle();
  assert.ok(sentTypes(page).includes('syncNow'));
});

describe('Y11 Edit settings', () => {
  const config = {
    backend: 'github', server: 'https://github.com', repo: 'me/tabs', branch: 'main', path: 'tab-collections.json',
    token: 'secret-token', passphrase: 'pass', mode: 'manual',
  };
  async function editing(handlers = {}) {
    fake.store.syncConfig = config;
    const page = await openCollections(connected({ encrypted: true, mode: 'manual' }), { syncUpdate: ok(), ...handlers });
    fire(button(page.$('syncPanel'), 'Edit settings'), 'click');
    await settle();
    return page;
  }

  test('the form, filled in with the current settings, token and passphrase included', async () => {
    const page = await editing();
    const panel = page.$('syncPanel');
    assert.match(text(panel), /Edit sync settings/);
    assert.deepEqual(['backend', 'server', 'repo', 'branch', 'path', 'token', 'passphrase', 'passphrase2', 'mode'].map((n) => input(page, n).value),
      ['github', 'https://github.com', 'me/tabs', 'main', 'tab-collections.json', 'secret-token', 'pass', 'pass', 'manual']);
    assert.equal(input(page, 'encrypt').checked, true);
    assert.equal(input(page, 'token').type, 'password', 'hidden until the eye is clicked');
    assert.deepEqual([...panel.querySelectorAll('.row button')].map(text), ['Save', 'Cancel']);
  });

  test('a re-render while editing (after a sync, say) keeps what the user typed', async () => {
    const page = await editing();
    setValue(input(page, 'token'), 'typing…');
    fake.store.syncState = { lastSyncAt: Date.now() };
    await fake.api.storage.local.set({ syncState: { lastSyncAt: Date.now() } });
    await settle();
    assert.equal(input(page, 'token').value, 'typing…');
  });

  test('Save sends the new settings, then shows the connected panel again', async () => {
    const page = await editing();
    setValue(input(page, 'token'), 'new-token');
    submit(page.$('syncPanel').querySelector('form'));
    await settle();
    const sent = page.sent.find((m) => m.type === 'syncUpdate');
    assert.deepEqual([sent.config.token, sent.config.passphrase, sent.config.mode], ['new-token', 'pass', 'manual']);
    assert.ok(!sentTypes(page).includes('syncSetup'));
    assert.equal(toast(page), 'Sync settings saved');
    assert.ok(button(page.$('syncPanel'), 'Edit settings'), 'back to the connected panel');
  });

  test('Cancel goes back without saving', async () => {
    const page = await editing();
    fire(button(page.$('syncPanel'), 'Cancel'), 'click');
    await settle();
    assert.ok(button(page.$('syncPanel'), 'Edit settings'));
    assert.ok(!sentTypes(page).includes('syncUpdate'));
  });
});
