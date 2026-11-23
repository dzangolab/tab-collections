// src/background.js driven by fake browser events (B1–B41 in docs/testing-plan.md).
// Assertions go through storage and the fake's windows and tabs, never through internals.
import { fake } from '../fake-browser.js';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCollection, putCollection, removeCollection, send } from '../../src/common.js';

await import('../../src/background.js');

const A = 'https://a.example/'; const B = 'https://b.example/'; const C = 'https://c.example/'; const D = 'https://d.example/';
const NEWTAB = 'chrome://newtab/';

let col;
beforeEach(() => {
  fake.reset();
  col = seedCollection('Three', [A, B, C]);
});
afterEach(async () => {
  await fake.flush();
  assert.deepEqual(fake.errors, [], 'no listener failed');
});

function seedCollection(name, urls, id) {
  const c = makeCollection({ id, name, pages: urls.map((url) => ({ url, title: url })) });
  fake.store.collections = { ...fake.store.collections, [c.id]: c };
  return c;
}
const sessions = () => fake.store.sessions || {};
const pending = () => Object.values(fake.store.pending || {});
const closedDrifts = () => pending().filter((p) => !p.live);

async function open(c = col) {
  const r = await send({ type: 'open', id: c.id });
  await fake.flush();
  return r.windowId;
}
async function close(windowId) {
  fake.closeWindowNow(windowId);
  await fake.flush();
}
async function addTab(windowId, url) {
  const t = fake.addTab(windowId, { url });
  await fake.flush();
  return t.id;
}
const tabIds = (w) => fake.windows.get(w).tabIds;
const sessionUrls = (w) => sessions()[w]?.tabs.map((t) => t.url);
const pages = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://unrelated.example/${i}`, title: `T${i}` }));

// ---------- 2.1 Opening ----------

describe('2.1 opening', () => {
  test('B1 opens one window with exactly the saved pages, and tracks it', async () => {
    const w = await open();
    assert.deepEqual(fake.windowUrls(w), [A, B, C]);
    assert.equal(fake.windowIds().length, 1);
    assert.equal(sessions()[w].collectionId, col.id);
    assert.deepEqual(sessions()[w].baseline, [A, B, C]);
  });

  test('B2 regression: an undecided 89-page drift does not open, only the 3 saved pages', async () => {
    fake.store.pending = {
      p1: { id: 'p1', collectionId: col.id, collectionName: col.name, pages: pages(89), live: false, windowId: 99, closedAt: 1 },
    };
    const w = await open();
    assert.deepEqual(fake.windowUrls(w), [A, B, C]);
    assert.equal(fake.tabs.size, 3);
    assert.equal(closedDrifts().length, 1, 'the drift stays undecided');
  });

  test('B3 an open collection is focused, not opened again', async () => {
    const w = await open();
    fake.openWindow([D]);
    const r = await send({ type: 'open', id: col.id });
    assert.deepEqual(r, { focused: true, windowId: w });
    assert.equal(fake.currentWindowId, w);
    assert.equal(fake.windowIds().length, 2);
  });

  test('B4 a stale session is dropped and a new window opens', async () => {
    const w = await open();
    fake.vanishWindow(w);
    const w2 = await open();
    assert.notEqual(w2, w);
    assert.deepEqual(Object.keys(sessions()), [String(w2)]);
    assert.deepEqual(fake.windowUrls(w2), [A, B, C]);
  });

  test('B5 a window closed before its session is written leaves nothing behind', async () => {
    const create = fake.api.windows.create;
    fake.api.windows.create = async (o) => { const w = await create(o); fake.closeWindowNow(w.id); return w; };
    try {
      await open();
    } finally {
      fake.api.windows.create = create;
    }
    assert.deepEqual(sessions(), {});
    assert.deepEqual(pending(), []);
  });

  test('B6 a stored empty collection refuses to open', async () => {
    const empty = { id: 'e', name: 'Empty', description: '', pages: [] };
    fake.store.collections.e = empty;
    await assert.rejects(send({ type: 'open', id: 'e' }), /This collection has no pages/);
    assert.equal(fake.windowIds().length, 0);
  });

  test('B7 an unknown collection id', async () => {
    await assert.rejects(send({ type: 'open', id: 'nope' }), /Collection not found/);
  });

  test('B8 redirects within 60 s of opening become the baseline', async () => {
    fake.options.loadTabs = true;
    const w = await open();
    const [t1, t2, t3] = tabIds(w);
    fake.completeTab(t1, 'https://a.example/home');
    fake.completeTab(t2);
    fake.completeTab(t3, 'https://c.example/login');
    await fake.flush();
    assert.deepEqual(sessions()[w].baseline, ['https://a.example/home', B, 'https://c.example/login']);
    await close(w);
    assert.deepEqual(pending(), []);
    assert.equal(fake.promptWindows().length, 0);
  });

  test('B9 a redirect after 60 s counts as a change', async () => {
    fake.options.loadTabs = true;
    const w = await open();
    fake.store.sessions[w].openedAt -= 61_000;
    fake.completeTab(tabIds(w)[0], 'https://a.example/later');
    fake.completeTab(tabIds(w)[1]);
    fake.completeTab(tabIds(w)[2]);
    await fake.flush();
    await close(w);
    assert.equal(closedDrifts().length, 1);
    assert.equal(fake.promptWindows().length, 1);
  });
});

// ---------- 2.2 Tracking tabs ----------

describe('2.2 tracking', () => {
  test('B10 the session follows every kind of tab change, in tab order', async () => {
    const w = await open();
    const other = fake.openWindow([D]);
    const check = async (what) => { await fake.flush(); assert.deepEqual(sessionUrls(w), fake.windowUrls(w), what); };

    fake.addTab(w, { url: D }); await check('created');
    fake.moveTab(tabIds(w)[3], 0); await check('moved');
    fake.navigate(tabIds(w)[0], 'https://e.example/'); await check('updated');
    fake.removeTab(tabIds(w)[0]); await check('removed');
    fake.moveTabToWindow(tabIds(w)[0], other); await check('detached');
    fake.moveTabToWindow(tabIds(other)[0], w); await check('attached');
    fake.replaceTab(tabIds(w)[0], 'https://f.example/'); await check('replaced');
  });

  test('B11 tab events in other windows change nothing', async () => {
    const w = await open();
    const before = structuredClone(fake.store.sessions);
    const other = fake.openWindow([D]);
    fake.addTab(other, { url: A });
    fake.navigate(tabIds(other)[0], B);
    fake.removeTab(tabIds(other)[0]);
    await fake.flush();
    assert.deepEqual(fake.store.sessions, before);
    assert.ok(sessions()[w]);
  });

  test('B12 a tab removed because its window is closing does not refresh the session', async () => {
    const w = await open();
    const t = tabIds(w)[2];
    fake.windows.get(w).tabIds.pop(); // gone from the window without its own event
    fake.tabs.delete(t);
    fake.api.tabs.onRemoved._emit(t, { windowId: w, isWindowClosing: true });
    await fake.flush();
    assert.deepEqual(sessionUrls(w), [A, B, C]);
    fake.api.tabs.onRemoved._emit(t, { windowId: w, isWindowClosing: false });
    await fake.flush();
    assert.deepEqual(sessionUrls(w), [A, B]);
  });

  test('B13 a burst of 100 tab events loses no update', async () => {
    const w = await open();
    for (let i = 0; i < 100; i++) fake.addTab(w, { url: `https://burst.example/${i}` });
    await fake.flush();
    assert.equal(sessionUrls(w).length, 103);
    assert.deepEqual(sessionUrls(w), fake.windowUrls(w));
  });
});

// ---------- 2.3 Closing a window ----------

describe('2.3 closing a window', () => {
  test('B14 an unchanged window: no prompt', async () => {
    const w = await open();
    await close(w);
    assert.deepEqual(sessions(), {});
    assert.deepEqual(pending(), []);
    assert.equal(fake.promptWindows().length, 0);
  });

  test('B15 a tab added: undecided change and a prompt', async () => {
    const w = await open();
    await addTab(w, D);
    await close(w);
    const [p] = pending();
    assert.equal(p.live, false);
    assert.equal(p.collectionId, col.id);
    assert.deepEqual(p.pages.map((x) => x.url), [A, B, C, D]);
    const [prompt] = fake.promptWindows();
    assert.ok(prompt);
    assert.equal(p.promptWindowId, prompt.id);
    assert.equal(prompt.type, 'popup');
    assert.deepEqual(sessions(), {});
  });

  test('B16 a reorder is a change', async () => {
    const w = await open();
    fake.moveTab(tabIds(w)[2], 0);
    await fake.flush();
    await close(w);
    assert.equal(closedDrifts().length, 1);
  });

  test('B17 extra new-tab pages are not a change', async () => {
    const w = await open();
    await addTab(w, NEWTAB);
    await addTab(w, 'about:blank');
    await close(w);
    assert.deepEqual(pending(), []);
  });

  test('B18 tabs matching the collection edited while open are not a change', async () => {
    const w = await open();
    await putCollection({ ...col, pages: [A, B, C, D].map((url) => ({ url, title: url })) });
    await addTab(w, D);
    await close(w);
    assert.deepEqual(pending(), []);
  });

  test('B19 a window left with only ignorable tabs records no empty drift', async () => {
    const w = await open();
    await addTab(w, NEWTAB);
    for (const t of tabIds(w).slice(0, 3)) fake.removeTab(t);
    await fake.flush();
    await close(w);
    assert.deepEqual(pending(), []);
  });

  test('B20 a window whose collection was deleted while open', async () => {
    const w = await open();
    await removeCollection(col.id);
    await addTab(w, D);
    await close(w);
    assert.deepEqual(sessions(), {});
    assert.deepEqual(pending(), []);
  });

  test('B21 only the newest closed drift of a collection is kept, and the older prompt closes', async () => {
    const w1 = await open();
    await addTab(w1, D);
    await close(w1);
    const [first] = fake.promptWindows();
    const w2 = await open();
    await addTab(w2, 'https://e.example/');
    await close(w2);
    assert.equal(closedDrifts().length, 1);
    assert.deepEqual(closedDrifts()[0].pages.map((x) => x.url), [A, B, C, 'https://e.example/']);
    assert.equal(fake.windows.has(first.id), false);
    assert.equal(fake.promptWindows().length, 1);
  });

  test('B22 a prompt closed without an answer keeps a closed drift', async () => {
    const w = await open();
    await addTab(w, D);
    await close(w);
    await close(fake.promptWindows()[0].id);
    const [p] = pending();
    assert.equal(p.live, false);
    assert.equal(p.promptWindowId, null);
  });

  test('B23 a prompt closed without an answer forgets a live drift', async () => {
    const w = await open();
    await addTab(w, D);
    await send({ type: 'reviewWindow', windowId: w });
    await fake.flush();
    assert.equal(pending()[0].live, true);
    await close(fake.promptWindows()[0].id);
    assert.deepEqual(pending(), []);
  });

  test('B24 without popup windows the prompt opens as a normal window', async () => {
    fake.options.popupWindows = false;
    const w = await open();
    await addTab(w, D);
    await close(w);
    const [prompt] = fake.promptWindows();
    assert.equal(prompt.type, 'normal');
    assert.equal(pending()[0].promptWindowId, prompt.id);
  });

  test('B25 a live drift whose prompt cannot open is dropped', async () => {
    const w = await open();
    await addTab(w, D);
    fake.options.failWindowCreate = true;
    const warn = console.warn;
    console.warn = () => {};
    try {
      await send({ type: 'reviewWindow', windowId: w });
      await fake.flush();
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(pending(), []);
  });

  test('B26 a slow windows.onRemoved: the window stops counting as open at once', async () => {
    const w = await open();
    for (let i = 0; i < 90; i++) fake.addTab(w, { url: `https://many.example/${i}` });
    fake.options.onRemovedDelay = 50;
    fake.closeWindowNow(w); // tab events are still queued; onRemoved comes later
    const status = await send({ type: 'driftStatus' });
    assert.equal(col.id in status, false);
    assert.deepEqual(sessions(), {});
    await fake.flush();
    assert.ok(closedDrifts().length <= 1);
  });
});

// ---------- 2.4 Closing from a toggle ----------

describe('2.4 closeCollection', () => {
  test('B27 closes the window and forgets it', async () => {
    const w = await open();
    await send({ type: 'closeCollection', id: col.id });
    await fake.flush();
    assert.equal(fake.windows.has(w), false);
    assert.deepEqual(sessions(), {});
  });

  test('B28 regression: an already closed window is not an error', async () => {
    const w = await open();
    fake.vanishWindow(w);
    await send({ type: 'closeCollection', id: col.id });
    assert.deepEqual(sessions(), {});
  });

  test('B29 another failure of windows.remove is reported', async () => {
    await open();
    const remove = fake.api.windows.remove;
    fake.api.windows.remove = async () => { throw new Error('Boom'); };
    try {
      await assert.rejects(send({ type: 'closeCollection', id: col.id }), /Boom/);
    } finally {
      fake.api.windows.remove = remove;
    }
  });
});

// ---------- 2.5 State for the pages ----------

describe('2.5 state for the pages', () => {
  test('B30 driftStatus lists live windows only; a stale changed one becomes a drift without a prompt', async () => {
    const other = seedCollection('Other', [D]);
    const w1 = await open();
    const w2 = await open(other);
    await addTab(w2, A);
    fake.vanishWindow(w2);
    const status = await send({ type: 'driftStatus' });
    assert.deepEqual(status, { [col.id]: { windowId: w1, changed: false, empty: false } });
    await fake.flush();
    assert.equal(closedDrifts().length, 1);
    assert.equal(closedDrifts()[0].collectionId, other.id);
    assert.equal(fake.promptWindows().length, 0);
  });

  test('B31 windowStatus', async () => {
    const w = await open();
    assert.deepEqual(await send({ type: 'windowStatus', windowId: w }), { changed: false, name: 'Three' });
    await addTab(w, D);
    assert.deepEqual(await send({ type: 'windowStatus', windowId: w }), { changed: true, name: 'Three' });
    const plain = fake.openWindow([D]);
    assert.equal(await send({ type: 'windowStatus', windowId: plain }), null);
  });

  test('B32 reviewWindow on a changed open window: a live drift and a prompt', async () => {
    const w = await open();
    await addTab(w, D);
    await send({ type: 'reviewWindow', windowId: w });
    await fake.flush();
    const [p] = pending();
    assert.equal(p.live, true);
    assert.equal(p.windowId, w);
    assert.equal(p.promptWindowId, fake.promptWindows()[0].id);
  });

  test('B33 reviewWindow on a window that is not a collection', async () => {
    const plain = fake.openWindow([D]);
    await assert.rejects(send({ type: 'reviewWindow', windowId: plain }), /This window is not a collection/);
  });

  test('B34 updateFromWindow', async () => {
    const w = await open();
    await addTab(w, D);
    await send({ type: 'reviewWindow', windowId: w });
    await fake.flush();
    await send({ type: 'updateFromWindow', windowId: w });
    await fake.flush();
    assert.deepEqual(fake.store.collections[col.id].pages.map((p) => p.url), [A, B, C, D]);
    assert.deepEqual(await send({ type: 'windowStatus', windowId: w }), { changed: false, name: 'Three' });
    assert.deepEqual(pending(), []);
    assert.equal(fake.promptWindows().length, 0);
  });

  test('B35 updateFromWindow refuses to empty the collection', async () => {
    const w = await open();
    await addTab(w, NEWTAB);
    for (const t of tabIds(w).slice(0, 3)) fake.removeTab(t);
    await fake.flush();
    await assert.rejects(send({ type: 'updateFromWindow', windowId: w }), /needs at least one page/);
    assert.equal(fake.store.collections[col.id].pages.length, 3);
  });

  test('B36 saveAndAdopt stores the collection and tracks the window', async () => {
    const w = fake.openWindow([A, D]);
    const c = makeCollection({ name: 'Saved', pages: [{ url: A }, { url: D }] });
    assert.equal(await send({ type: 'saveAndAdopt', windowId: w, collection: c }), c.id);
    assert.ok(fake.store.collections[c.id]);
    assert.deepEqual(sessions()[w].baseline, [A, D]);
    await close(w);
    assert.deepEqual(pending(), []);
  });

  test('B37 adopting a window that has already closed tracks nothing', async () => {
    await send({ type: 'adopt', windowId: 42, collectionId: col.id });
    assert.deepEqual(sessions(), {});
  });

  test('B38 an unknown message type', async () => {
    await assert.rejects(send({ type: 'nope' }), /Unknown message: nope/);
  });
});

// ---------- 2.6 Restart and reload ----------

describe('2.6 browser restart and extension reload', () => {
  const session = (c, urls) => ({ collectionId: c.id, baseline: c.pages.map((p) => p.url), initial: {}, openedAt: 1, tabs: urls.map((url) => ({ url, title: url })) });

  test('B39 onStartup turns changed sessions into drifts without a prompt', async () => {
    const other = seedCollection('Other', [D]);
    const third = seedCollection('Third', [B]);
    fake.store.sessions = { 7: session(col, [A, B, C, D]), 8: session(other, [D]) };
    fake.store.pending = {
      live: { id: 'live', collectionId: col.id, live: true, windowId: 3, promptWindowId: 4, pages: [] },
      old: { id: 'old', collectionId: third.id, live: false, promptWindowId: 5, pages: [{ url: C }] },
    };
    fake.api.runtime.onStartup._emit();
    await fake.flush();
    assert.deepEqual(sessions(), {});
    const byCol = Object.fromEntries(pending().map((p) => [p.collectionId, p]));
    assert.deepEqual(Object.keys(byCol).sort(), [col.id, third.id].sort());
    assert.equal(byCol[col.id].live, false);
    assert.deepEqual(byCol[col.id].pages.map((p) => p.url), [A, B, C, D]);
    assert.equal(byCol[third.id].promptWindowId, null);
    assert.equal(fake.promptWindows().length, 0);
  });

  test('B40 after a restart, reopening opens only the saved pages', async () => {
    fake.store.sessions = { 7: session(col, [...pages(89).map((p) => p.url), A, B, C]) };
    fake.api.runtime.onStartup._emit();
    await fake.flush();
    assert.equal(closedDrifts().length, 1);
    const w = await open();
    assert.deepEqual(fake.windowUrls(w), [A, B, C]);
  });

  test('B41 onInstalled prunes stale sessions and prompts', async () => {
    const other = seedCollection('Other', [D]);
    const third = seedCollection('Third', [B]);
    const promptWin = fake.openWindow(['chrome-extension://test/prompt.html?id=kept']);
    fake.store.sessions = { 7: session(col, [A, B, C, D]) };
    fake.store.pending = {
      liveGone: { id: 'liveGone', collectionId: other.id, live: true, windowId: 3, promptWindowId: 999, pages: [] },
      closedGone: { id: 'closedGone', collectionId: other.id, live: false, promptWindowId: 999, pages: [{ url: A }] },
      kept: { id: 'kept', collectionId: third.id, live: false, promptWindowId: promptWin, pages: [{ url: A }] },
    };
    fake.badge = '3';
    fake.api.runtime.onInstalled._emit({ reason: 'update' });
    await fake.flush();
    assert.deepEqual(sessions(), {});
    const p = fake.store.pending;
    assert.equal(p.liveGone, undefined);
    assert.equal(p.closedGone.promptWindowId, null);
    assert.equal(p.kept.promptWindowId, promptWin);
    assert.equal(closedDrifts().filter((x) => x.collectionId === col.id).length, 1, 'the stale changed session became a drift');
    assert.equal(fake.badge, '');
  });
});
