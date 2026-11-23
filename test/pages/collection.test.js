// The Collection page (E1–E13 in docs/testing-plan.md).
import { fake } from '../fake-browser.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCollection, putCollection, removeCollection } from '../../src/common.js';
import { fire, loadPage, resetPage, sentTypes, settle, setValue, submit, text } from './harness.js';

const A = 'https://a.example/'; const B = 'https://b.example/'; const C = 'https://c.example/';
let col;

beforeEach(() => {
  resetPage();
  col = makeCollection({ name: 'Three', description: 'Desc', pages: [A, B, C].map((url) => ({ url, title: url.slice(8, 9).toUpperCase() })) });
  fake.store.collections = { [col.id]: col };
});

const ok = (result = null) => () => result;
const handlers = { driftStatus: ok({}), open: ok({ opened: true }) };
const openPage = (search = `?id=${col.id}`, opts = {}) => loadPage('collection', { search, handlers, ...opts });
const cards = (page) => [...page.doc.querySelectorAll('#pages .page-card')];
const urls = (page) => cards(page).map((c) => c.querySelector('.url-in').value);
const toast = (page) => text(page.$('toast'));
const stored = () => fake.store.collections[col.id];
const cmdS = (page) => fire(page.doc, 'keydown', { key: 's', metaKey: true });

async function addPage(page, url, title = '') {
  page.$('addUrl').value = url;
  page.$('addTitle').value = title;
  submit(page.$('addForm'));
  await settle();
}

describe('Collection page', () => {
  test('E1 a new collection is not stored until saved with a page', async () => {
    fake.store.collections = {};
    const page = await openPage('?new=1');
    assert.equal(page.$('savebar').hidden, false);
    assert.equal(text(page.$('status')), 'Not saved yet');
    assert.equal(page.$('save').disabled, true);
    assert.equal(page.$('revert').hidden, true);
    for (const id of ['open', 'exportOne', 'delete']) assert.equal(page.$(id).hidden, true, id);
    assert.equal(page.$('details').hidden, false, 'name and description are being edited');
    assert.deepEqual(fake.store.collections, {});
  });

  test('E2 the first save creates it, and the page becomes the collection’s', async () => {
    fake.store.collections = {};
    const page = await openPage('?new=1');
    setValue(page.$('name'), 'Fresh');
    await addPage(page, 'a.example');
    assert.equal(page.$('save').disabled, false);
    fire(page.$('save'), 'click');
    await settle();
    const [c] = Object.values(fake.store.collections);
    assert.equal(c.name, 'Fresh');
    assert.deepEqual(c.pages, [{ url: 'https://a.example', title: '' }]);
    assert.deepEqual(page.replaced, [`collection.html?id=${encodeURIComponent(c.id)}`]);
    assert.equal(toast(page), 'Collection created');
    assert.equal(page.$('open').hidden, false);
    assert.equal(page.$('savebar').hidden, true);
  });

  test('E3 adding a page normalizes its URL, and refuses an invalid one', async () => {
    const page = await openPage();
    await addPage(page, 'd.example/x', 'D');
    assert.deepEqual(urls(page), [A, B, C, 'https://d.example/x']);
    assert.equal(text(page.$('count')), '4 web pages');
    await addPage(page, 'not a url');
    assert.equal(toast(page), 'That doesn’t look like a valid URL');
    assert.equal(cards(page).length, 4);
  });

  test('E4 editing in place marks the page dirty; an invalid URL is marked', async () => {
    const page = await openPage();
    assert.equal(page.$('savebar').hidden, true);
    setValue(cards(page)[0].querySelector('.title-in'), 'Renamed');
    assert.equal(page.$('savebar').hidden, false);
    assert.equal(page.doc.body.classList.contains('dirty'), true);
    const url = cards(page)[1].querySelector('.url-in');
    setValue(url, 'https://');
    assert.equal(url.classList.contains('invalid'), true);
    setValue(url, 'b.example/ok');
    assert.equal(url.classList.contains('invalid'), false);
  });

  test('E5 a collection can’t be left without pages', async () => {
    const page = await openPage();
    for (let i = 0; i < 3; i++) fire(cards(page)[0].querySelector('button[title="Remove page"]'), 'click');
    assert.equal(cards(page).length, 0);
    assert.equal(page.$('noPages').hidden, false);
    assert.equal(page.$('save').disabled, true);
    cmdS(page);
    await settle();
    assert.equal(toast(page), 'Add a page first: a collection needs at least one');
    assert.equal(stored().pages.length, 3);
  });

  test('E6 the arrow keys on the handle reorder, and focus follows', async () => {
    const page = await openPage();
    fire(cards(page)[0].querySelector('.drag-handle'), 'keydown', { key: 'ArrowDown' });
    assert.deepEqual(urls(page), [B, A, C]);
    assert.equal(page.doc.activeElement, cards(page)[1].querySelector('.drag-handle'));
    fire(cards(page)[0].querySelector('.drag-handle'), 'keydown', { key: 'ArrowUp' });
    assert.deepEqual(urls(page), [B, A, C], 'nothing above the first');
    fire(cards(page)[2].querySelector('.drag-handle'), 'keydown', { key: 'ArrowUp' });
    assert.deepEqual(urls(page), [B, C, A]);
  });

  test('E7 Cmd+S saves; Revert goes back to the saved version', async () => {
    const page = await openPage();
    fire(cards(page)[0].querySelector('.drag-handle'), 'keydown', { key: 'ArrowDown' });
    cmdS(page);
    await settle();
    assert.deepEqual(stored().pages.map((p) => p.url), [B, A, C]);
    assert.equal(toast(page), 'Saved');
    assert.equal(page.$('savebar').hidden, true);

    setValue(page.$('name'), 'Changed');
    fire(page.$('revert'), 'click');
    await settle();
    assert.equal(page.$('name').value, 'Three');
    assert.equal(page.$('savebar').hidden, true);
    assert.equal(stored().name, 'Three');
  });

  test('E8 leaving with unsaved changes asks first', async () => {
    const page = await openPage();
    const leave = () => { const e = new page.win.Event('beforeunload', { cancelable: true }); page.win.dispatchEvent(e); return e.defaultPrevented; };
    assert.equal(leave(), false);
    setValue(page.$('name'), 'Changed');
    assert.equal(leave(), true);
  });

  test('E9 saved elsewhere: reloads when clean, warns when dirty', async () => {
    const page = await openPage();
    await putCollection({ ...structuredClone(col), name: 'From another tab' });
    await settle();
    assert.equal(text(page.$('title')), 'From another tab');

    setValue(page.$('description'), 'mine');
    await putCollection({ ...structuredClone(stored()), name: 'Again' });
    await settle();
    assert.equal(page.$('external').hidden, false);
    assert.equal(page.$('description').value, 'mine', 'the edits are kept');
    fire(page.$('reload'), 'click');
    await settle();
    assert.equal(text(page.$('title')), 'Again');
    assert.equal(page.$('external').hidden, true);
  });

  test('E10 deleted elsewhere', async () => {
    const page = await openPage();
    await removeCollection(col.id);
    await settle();
    assert.equal(page.$('notFound').hidden, false);
    assert.equal(page.$('editor').hidden, true);
  });

  test('E10 an unknown id', async () => {
    const page = await openPage('?id=nope');
    assert.equal(page.$('notFound').hidden, false);
  });

  test('E11 opening with unsaved changes asks to save first', async () => {
    const page = await openPage('?id=' + col.id, { confirm: [false, true] });
    setValue(page.$('name'), 'Changed');
    fire(page.$('open'), 'click');
    await settle();
    assert.equal(sentTypes(page).includes('open'), false);
    fire(page.$('open'), 'click');
    await settle();
    assert.equal(stored().name, 'Changed');
    assert.deepEqual(page.sent.at(-1), { type: 'open', id: col.id });
  });

  test('E12 exporting with unsaved changes exports the saved version', async () => {
    const page = await openPage();
    setValue(page.$('name'), 'Unsaved name');
    fire(page.$('exportOne'), 'click');
    const [d] = page.downloads;
    assert.equal(d.filename, 'three.collection.json');
    assert.equal(JSON.parse(await d.blob.text()).collections[0].name, 'Three');
    assert.equal(toast(page), 'Exported the last saved version');
  });

  test('E13 an empty collection stored by an earlier version still shows', async () => {
    fake.store.collections.old = { id: 'old', name: 'Old', description: '', pages: [], createdAt: 1, updatedAt: 1 };
    const page = await openPage('?id=old');
    assert.equal(page.$('editor').hidden, false);
    assert.equal(text(page.$('count')), '0 web pages');
    assert.equal(page.$('noPages').hidden, false);
    await addPage(page, A);
    cmdS(page);
    await settle();
    assert.deepEqual(fake.store.collections.old.pages.map((p) => p.url), [A]);
  });

  test('delete asks, then goes back to all collections', async () => {
    const page = await openPage('?id=' + col.id, { confirm: [true] });
    fire(page.$('delete'), 'click');
    await settle();
    assert.equal(stored(), undefined);
    assert.deepEqual(page.navigations, ['collections.html']);
  });
});
