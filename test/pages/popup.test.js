// The toolbar popup (P1–P9 in docs/testing-plan.md).
import { fake } from '../fake-browser.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCollection } from '../../src/common.js';
import { fire, loadPage, resetPage, sentTypes, settle, submit, text } from './harness.js';

const A = 'https://a.example/'; const B = 'https://b.example/'; const C = 'https://c.example/';
let alpha; let beta;

beforeEach(() => {
  resetPage();
  alpha = makeCollection({ name: 'Alpha', pages: [{ url: A }] });
  beta = makeCollection({ name: 'Beta', pages: [{ url: B }, { url: C }] });
  fake.store.collections = { [beta.id]: beta, [alpha.id]: alpha };
});

const items = (page) => [...page.doc.querySelectorAll('#list .item')];
const toggle = (item) => item.querySelector('input[role=switch]');
const ok = (result = null) => () => result;

describe('popup', () => {
  test('P1 lists collections by name and marks the current window’s', async () => {
    const w = fake.openWindow([B, C]);
    fake.store.sessions = { [w]: { collectionId: beta.id, tabs: [] } };
    const page = await loadPage('popup', { handlers: { driftStatus: ok({}), windowStatus: ok({ changed: false, name: 'Beta' }) } });
    assert.deepEqual(items(page).map((i) => text(i.querySelector('.nm'))), ['Alpha', 'Beta']);
    assert.deepEqual(items(page).map((i) => text(i.querySelector('.mark'))), ['', '*']);
    assert.deepEqual(items(page).map((i) => text(i.querySelector('.n'))), ['1', '2']);
  });

  test('P2 toggles follow driftStatus, not stored sessions', async () => {
    fake.openWindow([A]);
    fake.store.sessions = { 99: { collectionId: alpha.id, tabs: [] } }; // stale: window 99 is gone
    const page = await loadPage('popup', { handlers: { driftStatus: ok({ [beta.id]: { windowId: 5, changed: false } }) } });
    assert.deepEqual(items(page).map((i) => toggle(i).checked), [false, true]);
  });

  test('P3 toggling off sends closeCollection; an error turns it back on and shows the message', async () => {
    fake.openWindow([A]);
    let fail = false;
    const page = await loadPage('popup', {
      handlers: {
        driftStatus: ok({ [alpha.id]: { windowId: 5, changed: false } }),
        closeCollection: () => { if (fail) throw new Error('Nope'); },
      },
    });
    const input = toggle(items(page)[0]);
    input.checked = false;
    fire(input, 'change');
    await settle();
    assert.deepEqual(page.sent.at(-1), { type: 'closeCollection', id: alpha.id });
    assert.deepEqual(page.alerts, []);

    fail = true;
    input.checked = false;
    fire(input, 'change');
    await settle();
    assert.equal(input.checked, true);
    assert.deepEqual(page.alerts, ['Nope']);
  });

  test('P3 toggling on opens the collection and closes the popup', async () => {
    fake.openWindow([A]);
    const page = await loadPage('popup', { handlers: { driftStatus: ok({}), open: ok({ opened: true }) } });
    const input = toggle(items(page)[1]);
    input.checked = true;
    fire(input, 'change');
    await settle();
    assert.deepEqual(page.sent.at(-1), { type: 'open', id: beta.id });
    assert.equal(page.closed, 1);
  });

  test('P4 a drifted collection shows the warning badge, which opens the review', async () => {
    fake.openWindow([A]);
    const page = await loadPage('popup', { handlers: { driftStatus: ok({ [beta.id]: { windowId: 7, changed: true } }), reviewWindow: ok() } });
    assert.equal(items(page)[0].querySelector('.drift'), null);
    const badge = items(page)[1].querySelector('button.drift');
    assert.ok(badge.querySelector('svg.badge'));
    fire(badge, 'click');
    await settle();
    assert.deepEqual(page.sent.at(-1), { type: 'reviewWindow', windowId: 7 });
    assert.equal(sentTypes(page).includes('open'), false, 'the click does not also open the collection');
    assert.equal(page.closed, 1);
  });

  describe('P5 what Save captures', () => {
    test('the whole window', async () => {
      fake.openWindow([A, B, 'chrome://newtab/']);
      const page = await loadPage('popup', { handlers: { driftStatus: ok({}) } });
      assert.equal(text(page.$('current')), "Save this window's 2 tabs as a new collection:");
    });
    test('the selected tabs', async () => {
      fake.openWindow([{ url: A, highlighted: true, active: true }, { url: B }, { url: C, highlighted: true }]);
      const page = await loadPage('popup', { handlers: { driftStatus: ok({}) } });
      assert.equal(text(page.$('current')), 'Save the selected 2 tabs as a new collection:');
      assert.equal(page.$('saveName').placeholder, 'a.example, c.example');
    });
    test('the current Vivaldi workspace, without web panels', async () => {
      const ws = (id, extra = {}) => JSON.stringify({ workspaceId: id, ...extra });
      fake.openWindow([
        { url: A, active: true, vivExtData: ws(1) },
        { url: B, vivExtData: ws(2) },
        { url: C, vivExtData: ws(1) },
        { url: 'https://panel.example/', vivExtData: ws(1, { panelId: 'p' }) },
      ]);
      const page = await loadPage('popup', { handlers: { driftStatus: ok({}) } });
      assert.equal(text(page.$('current')), "Save this workspace's 2 tabs as a new collection:");
    });
  });

  test('P6 nothing to save: the button is disabled', async () => {
    fake.openWindow(['chrome://newtab/']);
    const page = await loadPage('popup', { handlers: { driftStatus: ok({}) } });
    assert.equal(page.doc.querySelector('#saveForm button').disabled, true);
  });

  test('P7 saving the whole window adopts it', async () => {
    const w = fake.openWindow([A, B]);
    const page = await loadPage('popup', { handlers: { driftStatus: ok({}), saveAndAdopt: ({ collection }) => collection.id } });
    page.$('saveName').value = 'Mine';
    submit(page.$('saveForm'));
    await settle();
    const msg = page.sent.find((m) => m.type === 'saveAndAdopt');
    assert.equal(msg.windowId, w);
    assert.equal(msg.collection.name, 'Mine');
    assert.deepEqual(msg.collection.pages.map((p) => p.url), [A, B]);
    assert.equal(fake.windowUrls(w).at(-1), `chrome-extension://test/collection.html?id=${msg.collection.id}`);
    assert.equal(page.closed, 1);
  });

  test('P8 saving the selected tabs stores a collection without adopting the window', async () => {
    fake.openWindow([{ url: A, highlighted: true, active: true }, { url: B, highlighted: true }, { url: C }]);
    const page = await loadPage('popup', { handlers: { driftStatus: ok({}) } });
    submit(page.$('saveForm'));
    await settle();
    assert.equal(sentTypes(page).includes('saveAndAdopt'), false);
    const saved = Object.values(fake.store.collections).find((c) => c.name === 'a.example, b.example');
    assert.deepEqual(saved.pages.map((p) => p.url), [A, B]);
  });

  describe('P9 in a collection window', () => {
    for (const changed of [false, true]) {
      test(changed ? 'changed' : 'unchanged', async () => {
        const w = fake.openWindow([A]);
        fake.store.sessions = { [w]: { collectionId: alpha.id, tabs: [] } };
        const page = await loadPage('popup', { handlers: { driftStatus: ok({}), windowStatus: ok({ changed, name: 'Alpha' }), reviewWindow: ok() } });
        assert.equal(page.$('saveForm').hidden, true);
        assert.equal(page.$('collectionSection').hidden, false);
        assert.equal(text(page.$('collectionMsg')), changed
          ? 'The tabs in this window differ from the Alpha collection.'
          : 'This window displays the Alpha collection.');
        assert.equal(page.$('saveChanges').hidden, !changed);
        if (changed) {
          fire(page.$('saveChanges'), 'click');
          await settle();
          assert.deepEqual(page.sent.at(-1), { type: 'reviewWindow', windowId: w });
        }
      });
    }
  });
});
