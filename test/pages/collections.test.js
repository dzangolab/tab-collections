// The Collections page (C1–C11 in docs/testing-plan.md).
import { fake } from '../fake-browser.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, makeCollection, putCollection } from '../../src/common.js';
import { fire, loadPage, resetPage, sentTypes, settle, setValue, text } from './harness.js';

const A = 'https://a.example/'; const B = 'https://b.example/'; const C = 'https://c.example/';
let alpha; let beta;

beforeEach(() => {
  resetPage();
  alpha = makeCollection({ name: 'Alpha', description: 'First one', pages: [{ url: A }] });
  beta = makeCollection({ name: 'Beta', pages: [{ url: B }, { url: C }] });
  fake.store.collections = { [beta.id]: beta, [alpha.id]: alpha };
});

const ok = (result = null) => () => result;
const cards = (page) => [...page.doc.querySelectorAll('#cards .card')];
const card = (page, name) => cards(page).find((c) => text(c.querySelector('.card-name')) === name);
const toast = (page) => text(page.$('toast'));
const buttons = (node) => [...node.querySelectorAll('button')].map(text);

// The Collections page in a tab of its own window.
function inTab() {
  const w = fake.openWindow(['chrome-extension://test/collections.html']);
  fake.currentTabId = fake.windows.get(w).tabIds[0];
  return w;
}

async function importFile(page, name, data) {
  const input = page.$('importFile');
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name, text: async () => (typeof data === 'string' ? data : JSON.stringify(data)) }] });
  fire(input, 'change');
  await settle();
}

describe('Collections page', () => {
  test('C1 cards: name, description, pages, state, “This window”', async () => {
    const w = inTab();
    fake.store.sessions = { [w]: { collectionId: beta.id, tabs: [] } };
    const page = await loadPage('collections', { handlers: { driftStatus: ok({ [beta.id]: { windowId: w, changed: false } }) } });
    assert.deepEqual(cards(page).map((c) => text(c.querySelector('.card-name'))), ['Alpha', 'Beta']);
    const [a, b] = cards(page);
    assert.equal(text(a.querySelector('.card-desc')), 'First one');
    assert.equal(text(a.querySelector('.card-pages')), '1 page');
    assert.equal(text(b.querySelector('.card-pages')), '2 pages');
    assert.equal(text(a.querySelector('.card-state')), 'Closed');
    assert.equal(text(b.querySelector('.card-state')), 'Open');
    assert.equal(a.querySelector('.badge-current'), null);
    assert.equal(text(b.querySelector('.badge-current')), 'This window');
    assert.equal(b.classList.contains('current'), true);
    assert.equal(page.$('empty').hidden, true);
  });

  test('C1 no collections: the empty state', async () => {
    fake.store.collections = {};
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    assert.equal(cards(page).length, 0);
    assert.equal(page.$('empty').hidden, false);
  });

  test('C2 the filter matches names and descriptions', async () => {
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    setValue(page.$('filter'), 'first');
    await settle();
    assert.deepEqual(cards(page).map((c) => text(c.querySelector('.card-name'))), ['Alpha']);
    setValue(page.$('filter'), 'zzz');
    await settle();
    assert.equal(cards(page).length, 0);
    assert.equal(page.$('noMatch').hidden, false);
  });

  test('C3 the toggle opens and closes; an error flips it back with a toast', async () => {
    let fail = false;
    const page = await loadPage('collections', {
      handlers: {
        driftStatus: ok({}),
        open: () => { if (fail) throw new Error('Could not open'); return { opened: true }; },
        closeCollection: ok(),
      },
    });
    const input = card(page, 'Alpha').querySelector('input[role=switch]');
    input.checked = true;
    fire(input, 'change');
    await settle();
    assert.deepEqual(page.sent.at(-1), { type: 'open', id: alpha.id });

    input.checked = false;
    fire(input, 'change');
    await settle();
    assert.deepEqual(page.sent.at(-1), { type: 'closeCollection', id: alpha.id });

    fail = true;
    input.checked = true;
    fire(input, 'change');
    await settle();
    assert.equal(input.checked, false);
    assert.equal(toast(page), 'Could not open');
  });

  test('C4 delete asks first', async () => {
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) }, confirm: [false, true] });
    fire(card(page, 'Alpha').querySelector('button.danger'), 'click');
    await settle();
    assert.ok(fake.store.collections[alpha.id], 'cancelled: kept');
    assert.match(page.confirms[0], /Delete the collection “Alpha”\?/);
    fire(card(page, 'Alpha').querySelector('button.danger'), 'click');
    await settle();
    assert.equal(fake.store.collections[alpha.id], undefined);
    assert.equal(toast(page), 'Collection deleted');
    assert.equal(cards(page).length, 1);
  });

  test('C5 New collection opens an unsaved Collection page and stores nothing', async () => {
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    const before = structuredClone(fake.store.collections);
    fire(page.$('new'), 'click');
    await settle();
    assert.deepEqual(page.navigations, ['collection.html?new=1']);
    assert.deepEqual(fake.store.collections, before);
  });

  test('C6 export', async () => {
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    fire(page.$('export'), 'click');
    await settle();
    const [d] = page.downloads;
    assert.match(d.filename, /^tab-collections-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(await d.blob.text());
    assert.equal(data.format, 'tab-collections');
    assert.deepEqual(data.collections.map((c) => c.name).sort(), ['Alpha', 'Beta']);
  });

  test('C6 export with no collections', async () => {
    fake.store.collections = {};
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    fire(page.$('export'), 'click');
    await settle();
    assert.equal(page.downloads.length, 0);
    assert.equal(toast(page), 'Nothing to export yet');
  });

  describe('C7 import', () => {
    const gamma = () => makeCollection({ name: 'Gamma', pages: [{ url: C }] });
    test('new and replaced collections, after a confirmation that names the replaced ones', async () => {
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
      const g = gamma();
      const renamed = { ...alpha, name: 'Alpha 2' };
      await importFile(page, 'backup.json', buildExport([g, renamed, { name: 'Empty', pages: [] }]));
      assert.match(page.confirms[0], /^Import 2 collections from “backup\.json”\?/);
      assert.match(page.confirms[0], /1 collection without pages will be skipped/);
      assert.match(page.confirms[0], /1 collection already exist and will be replaced:\n• Alpha/);
      assert.equal(fake.store.collections[g.id].name, 'Gamma');
      assert.equal(fake.store.collections[alpha.id].name, 'Alpha 2');
      assert.equal(Object.keys(fake.store.collections).length, 3);
      assert.equal(toast(page), 'Imported 2 collections, skipped 1 without pages');
    });
    test('cancelled: nothing stored', async () => {
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) }, confirm: [false] });
      const before = structuredClone(fake.store.collections);
      await importFile(page, 'x.json', [gamma()]);
      assert.deepEqual(fake.store.collections, before);
    });
    test('only empty collections', async () => {
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
      await importFile(page, 'e.json', [{ name: 'E', pages: [] }, { name: 'F', pages: [] }]);
      assert.deepEqual(page.alerts, ['Nothing to import: the 2 collections in “e.json” have no pages.']);
      assert.equal(page.confirms.length, 0);
    });
    test('an invalid file', async () => {
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
      await importFile(page, 'bad.json', '{nope');
      assert.deepEqual(page.alerts, ['Import failed: The file is not valid JSON.']);
    });
  });

  test('C8 Vivaldi workspaces', async () => {
    const ws = (id) => JSON.stringify({ workspaceId: id });
    fake.openWindow([{ url: A, vivExtData: ws(1) }, { url: B, vivExtData: ws(2) }, { url: C, vivExtData: '{}' }]);
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    assert.equal(page.$('vivaldi').hidden, false);
    const dialog = page.$('wsDialog');
    dialog.showModal = () => {};
    fire(page.$('vivaldi'), 'click');
    await settle();
    const rows = [...page.doc.querySelectorAll('#wsList .ws')];
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.querySelector('input[type=checkbox]').checked), [true, true, false]);
    assert.match(text(rows[2]), /Tabs not in any workspace/);
    rows[1].querySelector('input[type=text]').value = 'Second';
    dialog.returnValue = 'create';
    fire(dialog, 'close');
    await settle();
    const names = Object.values(fake.store.collections).map((c) => c.name).sort();
    assert.deepEqual(names, ['Alpha', 'Beta', 'Second', 'a.example']);
    assert.equal(toast(page), 'Created 2 collections');
  });

  test('C8 no Vivaldi data: the button stays hidden', async () => {
    fake.openWindow([A]);
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    assert.equal(page.$('vivaldi').hidden, true);
  });

  test('C9 the close setting', async () => {
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    assert.equal(page.$('closeDefault').value, 'keep');
    setValue(page.$('closeDefault'), 'update', 'change');
    await settle();
    assert.equal(fake.store.settings.closeDefault, 'update');
    assert.equal(toast(page), 'Setting saved');
  });

  describe('C10 drift strip', () => {
    const closedDrift = (pages) => ({ d1: { id: 'd1', collectionId: beta.id, collectionName: 'Beta', live: false, pages, closedAt: 1 } });
    test('a closed drift: Details, Update and Restore', async () => {
      fake.store.pending = closedDrift([{ url: A, title: '' }]);
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
      const strip = card(page, 'Beta').querySelector('.drift-strip');
      assert.deepEqual(buttons(strip), ['Details', 'Update', 'Restore']);
      assert.equal(card(page, 'Alpha').querySelector('.drift-strip'), null);
      fire([...strip.querySelectorAll('button')][2], 'click');
      await settle();
      assert.deepEqual(fake.store.pending, {});
      assert.equal(toast(page), 'Collection restored');
      assert.equal(card(page, 'Beta').querySelector('.drift-strip'), null);
    });
    test('a closed drift: Update takes its pages', async () => {
      fake.store.pending = closedDrift([{ url: A, title: 'A' }]);
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
      fire([...card(page, 'Beta').querySelectorAll('.drift-strip button')][1], 'click');
      await settle();
      assert.deepEqual(fake.store.collections[beta.id].pages, [{ url: A, title: 'A' }]);
      assert.equal(toast(page), 'Collection updated');
    });
    test('a closed drift with no pages: no Update', async () => {
      fake.store.pending = closedDrift([]);
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
      assert.deepEqual(buttons(card(page, 'Beta').querySelector('.drift-strip')), ['Details', 'Restore']);
    });
    test('a live drift: Details and Update, no Restore', async () => {
      const page = await loadPage('collections', {
        handlers: { driftStatus: ok({ [beta.id]: { windowId: 4, changed: true, empty: false } }), updateFromWindow: ok() },
      });
      const strip = card(page, 'Beta').querySelector('.drift-strip');
      assert.deepEqual(buttons(strip), ['Details', 'Update']);
      fire([...strip.querySelectorAll('button')][1], 'click');
      await settle();
      assert.deepEqual(page.sent.at(-1), { type: 'updateFromWindow', windowId: 4 });
    });
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://many.example/${i}`, title: '' }));
    test('a closed drift that grows suspiciously: Update opens the review instead', async () => {
      fake.store.pending = closedDrift(many);
      const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
      fire([...card(page, 'Beta').querySelectorAll('.drift-strip button')][1], 'click');
      await settle();
      assert.deepEqual(fake.store.collections[beta.id].pages.map((x) => x.url), [B, C]);
      assert.equal(fake.promptWindows().length, 1);
      assert.equal(toast(page), 'Check the tabs before updating');
    });
    test('a live drift that grows suspiciously: Update asks for the review instead', async () => {
      const page = await loadPage('collections', {
        handlers: { driftStatus: ok({ [beta.id]: { windowId: 4, changed: true, count: 86, empty: false } }), reviewWindow: ok() },
      });
      fire([...card(page, 'Beta').querySelectorAll('.drift-strip button')][1], 'click');
      await settle();
      assert.deepEqual(page.sent.at(-1), { type: 'reviewWindow', windowId: 4 });
      assert.ok(!sentTypes(page).includes('updateFromWindow'));
      assert.equal(toast(page), 'Check the tabs before updating');
    });
    test('a live drift with no pages left: Details only', async () => {
      const page = await loadPage('collections', { handlers: { driftStatus: ok({ [beta.id]: { windowId: 4, changed: true, empty: true } }) } });
      assert.deepEqual(buttons(card(page, 'Beta').querySelector('.drift-strip')), ['Details']);
    });
  });

  test('C11 a change made elsewhere renders again', async () => {
    const page = await loadPage('collections', { handlers: { driftStatus: ok({}) } });
    await putCollection(makeCollection({ name: 'Gamma', pages: [{ url: C }] }));
    await settle();
    assert.deepEqual(cards(page).map((c) => text(c.querySelector('.card-name'))), ['Alpha', 'Beta', 'Gamma']);
    assert.ok(sentTypes(page).filter((t) => t === 'driftStatus').length >= 2);
  });
});
