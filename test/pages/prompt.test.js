// The "Update collection?" prompt (R1–R9 in docs/testing-plan.md).
import { fake } from '../fake-browser.js';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCollection, resolvePending } from '../../src/common.js';
import { fire, loadPage, resetPage, settle, submit, text } from './harness.js';

const A = 'https://a.example/'; const B = 'https://b.example/'; const C = 'https://c.example/'; const D = 'https://d.example/';
const page4 = (url) => ({ url, title: url });
let col;

beforeEach(() => {
  resetPage();
  mock.timers.enable({ apis: ['setTimeout'] }); // the prompt's 5-minute auto-close
  col = makeCollection({ name: 'Three', description: 'Desc', pages: [A, B, C].map(page4) });
  fake.store.collections = { [col.id]: col };
});
afterEach(() => mock.timers.reset());

function seedPending(over = {}) {
  fake.store.pending = { p1: { id: 'p1', collectionId: col.id, collectionName: 'Three', pages: [A, B, D].map(page4), live: false, windowId: 9, closedAt: 1, baseline: null, ...over } };
}
const openPrompt = (opts = {}) => loadPage('prompt', { search: '?id=p1', handlers: { adopt: () => null }, ...opts });
const buttons = (page) => [...page.doc.querySelectorAll('.buttons button')];
const button = (page, label) => [...page.doc.querySelectorAll('button')].find((b) => text(b) === label);
const headings = (page) => [...page.doc.querySelectorAll('h2')].map(text);

describe('prompt', () => {
  test('R1 lists what was added and removed', async () => {
    seedPending();
    const page = await openPrompt();
    assert.deepEqual(headings(page), ['Update “Three” collection', '1 page added', '1 page removed', 'Save as a new collection']);
    const [added, removed] = page.doc.querySelectorAll('ul.changes');
    assert.match(text(added), /d\.example/);
    assert.match(text(removed), /c\.example/);
    assert.equal(page.doc.title, 'Update “Three” collection');
  });

  test('R1 a reorder', async () => {
    seedPending({ pages: [C, B, A].map(page4) });
    const page = await openPrompt();
    assert.match(text(page.doc.body), /The same pages are there, but in a different order\./);
  });

  test('R1 compares against the URLs the pages resolved to', async () => {
    seedPending({ pages: ['https://a.example/home', B, C].map(page4), baseline: ['https://a.example/home', B, C] });
    const page = await openPrompt();
    assert.deepEqual(headings(page), ['Update “Three” collection', 'Save as a new collection']);
  });

  describe('R2 the default button', () => {
    test('Restore by default', async () => {
      seedPending();
      const page = await openPrompt();
      assert.deepEqual(buttons(page).map(text), ['Update', 'Restore']);
      assert.equal(text(page.doc.activeElement), 'Restore');
      assert.equal(button(page, 'Restore').className, 'primary');
    });
    test('Update when the setting says so', async () => {
      seedPending();
      fake.store.settings = { closeDefault: 'update' };
      const page = await openPrompt();
      assert.equal(text(page.doc.activeElement), 'Update');
      assert.equal(button(page, 'Update').className, 'primary');
    });
    test('Update for an open window, with no Restore', async () => {
      seedPending({ live: true });
      const page = await openPrompt();
      assert.deepEqual(buttons(page).map(text), ['Update']);
      assert.equal(text(page.doc.activeElement), 'Update');
    });
  });

  test('R3 Update takes the pages and closes the prompt', async () => {
    seedPending();
    const page = await openPrompt();
    fire(button(page, 'Update'), 'click');
    await settle();
    assert.deepEqual(fake.store.collections[col.id].pages.map((p) => p.url), [A, B, D]);
    assert.deepEqual(fake.store.pending, {});
    assert.ok(page.closed >= 1);
    assert.deepEqual(page.sent, [], 'a closed window is not adopted');
  });

  test('R3 Update of an open window keeps tracking it', async () => {
    const w = fake.openWindow([A, B, D]);
    seedPending({ live: true, windowId: w });
    const page = await openPrompt();
    fire(button(page, 'Update'), 'click');
    await settle();
    assert.deepEqual(page.sent, [{ type: 'adopt', windowId: w, collectionId: col.id, baseline: [A, B, D] }]);
  });

  test('R4 Restore keeps the collection', async () => {
    seedPending();
    const page = await openPrompt();
    fire(button(page, 'Restore'), 'click');
    await settle();
    assert.deepEqual(fake.store.collections[col.id].pages.map((p) => p.url), [A, B, C]);
    assert.deepEqual(fake.store.pending, {});
    assert.ok(page.closed >= 1);
  });

  test('R5 Save as new', async () => {
    seedPending();
    const page = await openPrompt();
    submit(page.doc.querySelector('form'));
    await settle();
    const copy = Object.values(fake.store.collections).find((c) => c.id !== col.id);
    assert.equal(copy.name, 'Three (copy)');
    assert.equal(copy.description, 'Desc');
    assert.deepEqual(copy.pages.map((p) => p.url), [A, B, D]);
    assert.deepEqual(fake.store.collections[col.id].pages.map((p) => p.url), [A, B, C]);
    assert.deepEqual(fake.store.pending, {});
  });

  describe('R6 no pages left', () => {
    test('a closed window: Restore only', async () => {
      seedPending({ pages: [] });
      const page = await openPrompt();
      assert.deepEqual(buttons(page).map(text), ['Restore']);
      assert.equal(page.doc.querySelector('form'), null);
      assert.match(text(page.doc.body), /no pages left\. A collection needs at least one page/);
    });
    test('an open window: Close only', async () => {
      seedPending({ pages: [], live: true });
      const page = await openPrompt();
      assert.deepEqual(buttons(page).map(text), ['Close']);
      fire(button(page, 'Close'), 'click');
      await settle();
      assert.ok(page.closed >= 1);
      assert.deepEqual(fake.store.collections[col.id].pages.length, 3);
    });
  });

  describe('R7 the collection was deleted', () => {
    test('Save as new or Discard', async () => {
      seedPending();
      fake.store.collections = {};
      const page = await openPrompt();
      assert.equal(headings(page)[0], '“Three” no longer exists');
      assert.deepEqual(buttons(page).map(text), ['Save as new collection', 'Discard']);
      fire(button(page, 'Save as new collection'), 'click');
      await settle();
      assert.deepEqual(Object.values(fake.store.collections).map((c) => c.name), ['Three']);
    });
    test('Discard only, without pages', async () => {
      seedPending({ pages: [] });
      fake.store.collections = {};
      const page = await openPrompt();
      assert.deepEqual(buttons(page).map(text), ['Discard']);
    });
  });

  test('R8 nothing to review', async () => {
    const page = await openPrompt();
    assert.equal(headings(page)[0], 'Nothing to review');
  });

  describe('R9 auto-close', () => {
    test('after 5 minutes', async () => {
      seedPending();
      const page = await openPrompt();
      mock.timers.tick(5 * 60_000 - 1);
      await settle();
      assert.equal(page.closed, 0);
      mock.timers.tick(1);
      await settle();
      assert.equal(page.closed, 1);
      assert.equal(Object.keys(fake.store.pending).length, 1, 'the change stays undecided');
    });
    test('on switching to another window, once it had focus', async () => {
      seedPending();
      const page = await openPrompt();
      fire(page.win, 'focus');
      fire(page.win, 'blur');
      await settle();
      assert.equal(page.closed, 1);
    });
    test('when handled elsewhere', async () => {
      seedPending();
      const page = await openPrompt();
      await resolvePending('p1');
      await settle();
      assert.equal(page.closed, 1);
    });
  });
});
