// The three-way merge of src/sync/merge.js (M1–M20 in docs/testing-plan.md).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, merge, mergeCollection, mergePages, sameCollection } from '../../src/sync/merge.js';

const pg = (url, title = url) => ({ url, title });
const col = (id, name, urls, over = {}) => ({
  id, name, description: '', pages: urls.map((u) => (typeof u === 'string' ? pg(u) : u)), createdAt: 1, updatedAt: 1, ...over,
});
const snap = (cols = [], tombstones = {}) => ({ collections: Object.fromEntries(cols.map((c) => [c.id, c])), tombstones });
const urls = (c) => c.pages.map((p) => p.url);

describe('M1 sameCollection', () => {
  test('ignores timestamps', () => {
    assert.ok(sameCollection(col('a', 'A', ['x']), col('a', 'A', ['x'], { updatedAt: 9, createdAt: 5 })));
  });
  test('sees name, description, page and title changes', () => {
    const a = col('a', 'A', ['x']);
    assert.ok(!sameCollection(a, col('a', 'B', ['x'])));
    assert.ok(!sameCollection(a, col('a', 'A', ['x'], { description: 'd' })));
    assert.ok(!sameCollection(a, col('a', 'A', ['y'])));
    assert.ok(!sameCollection(a, col('a', 'A', [pg('x', 'other')])));
  });
});

describe('M2–M7 mergePages', () => {
  test('M2 additions on each side are both kept, where they were added', () => {
    const r = mergePages([pg('a'), pg('b')], [pg('a'), pg('x'), pg('b')], [pg('a'), pg('b'), pg('y')]);
    assert.deepEqual(r.pages.map((p) => p.url), ['a', 'x', 'b', 'y']);
    assert.equal(r.conflict, false);
  });
  test('M3 a removal on either side is removed', () => {
    const r = mergePages([pg('a'), pg('b'), pg('c')], [pg('a'), pg('c')], [pg('a'), pg('b')]);
    assert.deepEqual(r.pages.map((p) => p.url), ['a']);
  });
  test('M4 a title changed on one side is taken', () => {
    const r = mergePages([pg('a', 'old')], [pg('a', 'old')], [pg('a', 'new')]);
    assert.deepEqual(r.pages, [pg('a', 'new')]);
    assert.equal(r.conflict, false);
  });
  test('M5 the same title changed differently on both sides is a conflict', () => {
    const r = mergePages([pg('a', 'old')], [pg('a', 'mine')], [pg('a', 'theirs')]);
    assert.equal(r.conflict, true);
  });
  test('M6 a reorder on one side wins, with the other side’s additions', () => {
    const r = mergePages([pg('a'), pg('b'), pg('c')], [pg('a'), pg('b'), pg('c'), pg('x')], [pg('c'), pg('b'), pg('a')]);
    assert.deepEqual(r.pages.map((p) => p.url), ['c', 'x', 'b', 'a'], 'x stays after c, the page it followed');
  });
  test('M7 a URL listed twice counts as two pages', () => {
    const r = mergePages([pg('a')], [pg('a'), pg('a')], [pg('a')]);
    assert.deepEqual(r.pages.map((p) => p.url), ['a', 'a']);
  });
});

describe('M8–M11 mergeCollection', () => {
  const base = col('c', 'Name', ['a', 'b']);
  test('M8 a rename on one side and a page added on the other are both kept', () => {
    const r = mergeCollection(base, col('c', 'Renamed', ['a', 'b']), col('c', 'Name', ['a', 'b', 'x']));
    assert.equal(r.conflict, false);
    assert.equal(r.col.name, 'Renamed');
    assert.deepEqual(urls(r.col), ['a', 'b', 'x']);
  });
  test('M9 both renamed differently: a conflict', () => {
    assert.equal(mergeCollection(base, col('c', 'Mine', ['a', 'b']), col('c', 'Theirs', ['a', 'b'])).conflict, true);
  });
  test('M10 the same rename on both sides is not a conflict', () => {
    const r = mergeCollection(base, col('c', 'Same', ['a', 'b'], { updatedAt: 5 }), col('c', 'Same', ['a', 'b'], { updatedAt: 7 }));
    assert.equal(r.conflict, false);
    assert.equal(r.col.updatedAt, 7);
  });
  test('M11 every page removed between the two sides: a conflict, never an empty collection', () => {
    assert.equal(mergeCollection(base, col('c', 'Name', ['a']), col('c', 'Name', ['b'])).conflict, true);
  });
  test('M11b no base (same id added on both sides): different names conflict, pages are united', () => {
    assert.equal(mergeCollection(null, col('c', 'One', ['a']), col('c', 'Two', ['a'])).conflict, true);
    const r = mergeCollection(null, col('c', 'One', ['a']), col('c', 'One', ['b']));
    assert.equal(r.conflict, false);
    assert.deepEqual(urls(r.col), ['a', 'b']);
  });
});

describe('M12–M20 merge', () => {
  const a = col('a', 'A', ['x']);
  test('M12 first sync: a device with collections and an empty sync file', () => {
    const r = merge(emptySnapshot(), snap([a]), emptySnapshot());
    assert.deepEqual(r.shared, snap([a]));
    assert.deepEqual(r.local, snap([a]));
    assert.deepEqual(r.conflicts, {});
  });
  test('M13 first sync: collections on both sides are united', () => {
    const b = col('b', 'B', ['y']);
    const r = merge(emptySnapshot(), snap([a]), snap([b]));
    assert.deepEqual(Object.keys(r.shared.collections).sort(), ['a', 'b']);
  });
  test('M14 changed on one side only: that side’s version', () => {
    const edited = col('a', 'A2', ['x']);
    assert.equal(merge(snap([a]), snap([a]), snap([edited])).local.collections.a.name, 'A2');
    assert.equal(merge(snap([a]), snap([edited]), snap([a])).shared.collections.a.name, 'A2');
  });
  test('M15 deleted on one side, unchanged on the other: deleted on both, with the tombstone', () => {
    const r = merge(snap([a]), snap([], { a: 5 }), snap([a]));
    assert.deepEqual(r.shared, snap([], { a: 5 }));
    assert.deepEqual(r.local, snap([], { a: 5 }));
    const r2 = merge(snap([a]), snap([a]), snap([], { a: 6 }));
    assert.deepEqual(r2.local, snap([], { a: 6 }));
  });
  test('M16 deleted on one side, edited on the other: the edit wins', () => {
    const edited = col('a', 'A', ['x', 'y']);
    const r = merge(snap([a]), snap([edited]), snap([], { a: 5 }));
    assert.deepEqual(urls(r.shared.collections.a), ['x', 'y']);
    assert.equal(r.shared.tombstones.a, undefined);
  });
  test('M17 a tombstone stops a stale copy from coming back', () => {
    // This device deleted "a"; the sync file still has it as last synced.
    const r = merge(snap([a]), snap([], { a: 5 }), snap([a]));
    assert.equal(r.local.collections.a, undefined);
  });
  test('M18 a conflict: the sync file keeps theirs, this device keeps mine', () => {
    const mine = col('a', 'Mine', ['x']); const theirs = col('a', 'Theirs', ['x']);
    const r = merge(snap([a]), snap([mine]), snap([theirs]));
    assert.equal(r.shared.collections.a.name, 'Theirs');
    assert.equal(r.local.collections.a.name, 'Mine');
    assert.deepEqual(r.conflicts, { a: { theirs } });
  });
  test('M19 a pinned (unresolved) conflict stays as it is on both sides, with the latest theirs', () => {
    const mine = col('a', 'Mine', ['x']); const theirs = col('a', 'Theirs again', ['x']);
    const r = merge(snap([col('a', 'Theirs', ['x'])]), snap([mine]), snap([theirs]), { pinned: ['a'] });
    assert.equal(r.shared.collections.a.name, 'Theirs again');
    assert.equal(r.local.collections.a.name, 'Mine');
    assert.deepEqual(r.conflicts.a, { theirs });
  });
  test('M20 tombstones on both sides are kept, with the latest date', () => {
    const r = merge(snap([], { a: 1 }), snap([], { a: 3 }), snap([], { a: 2 }));
    assert.deepEqual(r.shared.tombstones, { a: 3 });
  });
});
