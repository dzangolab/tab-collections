// Unit tests for the pure helpers in src/common.js (U1–U15 in docs/testing-plan.md).
import { fake } from '../fake-browser.js'; // must come first: common.js reads the API when loaded
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExport, cleanPages, diffPages, getCollections, groupByWorkspace, hasPages, isIgnorableUrl, makeCollection,
  normalizeUrl, parseImport, plural, putCollection, removeCollection, sameUrlList, saveCollections, slug, suggestName,
  suspiciousGrowth, vivaldiData, workspaceCreated, workspaceKey,
} from '../../src/common.js';

const p = (url, title = '') => ({ url, title });

beforeEach(() => fake.reset());

describe('U1 cleanPages', () => {
  test('drops ignorable URLs and keeps the order of the rest', () => {
    assert.deepEqual(
      cleanPages([p('https://b.com'), p('about:blank'), p('https://a.com'), p('chrome://newtab/')]).map((x) => x.url),
      ['https://b.com', 'https://a.com'],
    );
  });
});

describe('U2 diffPages', () => {
  const A = p('https://a.com'); const B = p('https://b.com'); const C = p('https://c.com');
  test('added', () => assert.deepEqual(diffPages([A], [A, B]), { added: [B], removed: [], reordered: false }));
  test('removed', () => assert.deepEqual(diffPages([A, B], [A]), { added: [], removed: [B], reordered: false }));
  test('both', () => assert.deepEqual(diffPages([A, B], [A, C]), { added: [C], removed: [B], reordered: false }));
  test('duplicates count as a multiset', () => {
    assert.deepEqual(diffPages([A, A, B], [A, B]), { added: [], removed: [A], reordered: false });
    assert.deepEqual(diffPages([A], [A, A]), { added: [A], removed: [], reordered: false });
  });
  test('reordered only without additions or removals', () => {
    assert.equal(diffPages([A, B], [B, A]).reordered, true);
    assert.equal(diffPages([A, B], [B, A, C]).reordered, false);
    assert.equal(diffPages([A, B], [A, B]).reordered, false);
  });
  test('empty inputs', () => {
    assert.deepEqual(diffPages([], []), { added: [], removed: [], reordered: false });
    assert.deepEqual(diffPages([], [A]).added, [A]);
    assert.deepEqual(diffPages([A], []).removed, [A]);
  });
});

describe('U3 groupByWorkspace', () => {
  const tab = (windowId, index, url, d) => ({ windowId, index, url, title: url, vivExtData: d && JSON.stringify(d) });
  test('null without Vivaldi data', () => assert.equal(groupByWorkspace([{ windowId: 1, index: 0, url: 'https://a.com' }]), null));
  test('groups by rounded workspace id, skips panels and ignorable URLs, none last', () => {
    const groups = groupByWorkspace([
      tab(2, 0, 'https://c.com', { workspaceId: 2.0000001 }),
      tab(1, 1, 'https://b.com', { workspaceId: 1 }),
      tab(1, 0, 'https://a.com', { workspaceId: 1 }),
      tab(1, 2, 'https://loose.com', {}),
      tab(1, 3, 'https://panel.com', { panelId: 'x', workspaceId: 1 }),
      tab(1, 4, 'chrome://newtab/', { workspaceId: 1 }),
    ]);
    assert.deepEqual(groups.map((g) => [g.key, g.pages.map((x) => x.url)]), [
      ['1', ['https://a.com', 'https://b.com']],
      ['2', ['https://c.com']],
      ['none', ['https://loose.com']],
    ]);
  });
});

describe('U4 hasPages', () => {
  test('false without a page that has a URL', () => {
    for (const c of [null, {}, { pages: [] }, { pages: [{ url: '' }, { title: 'x' }] }, { pages: 'x' }]) assert.equal(hasPages(c), false);
  });
  test('true with one page that has a URL', () => assert.equal(hasPages({ pages: [{ url: '' }, p('https://a.com')] }), true));
});

describe('U5 isIgnorableUrl', () => {
  test('ignorable', () => {
    for (const u of [
      '', undefined, 'about:blank', 'about:newtab', 'favorites://', 'chrome://newtab/', 'chrome://new-tab-page/',
      'chrome-search://local-ntp', 'edge://newtab/', 'brave://newtab/', 'opera://startpage/', 'vivaldi://startpage/',
      'chrome://vivaldi-webui/startpage', 'chrome://startpageshared/', 'chrome-extension://test/collections.html',
    ]) assert.equal(isIgnorableUrl(u), true, String(u));
  });
  test('not ignorable', () => {
    for (const u of ['https://a.com', 'http://localhost:3000', 'file:///tmp/x.html', 'chrome://settings/', 'chrome-extension://other/x.html']) {
      assert.equal(isIgnorableUrl(u), false, u);
    }
  });
});

describe('U6 makeCollection', () => {
  test('defaults', () => {
    const c = makeCollection();
    assert.match(c.id, /^[0-9a-f-]{36}$/);
    assert.equal(c.name, 'Untitled collection');
    assert.equal(c.description, '');
    assert.deepEqual(c.pages, []);
    assert.equal(typeof c.createdAt, 'number');
    assert.equal(typeof c.updatedAt, 'number');
  });
  test('trims the name, normalizes URLs, drops pages without one', () => {
    const c = makeCollection({ name: '  Work  ', pages: [{ url: 'a.com', title: 1 }, { url: '  ' }, { title: 'x' }] });
    assert.equal(c.name, 'Work');
    assert.deepEqual(c.pages, [{ url: 'https://a.com', title: '1' }]);
  });
  test('keeps a given id and createdAt', () => {
    const c = makeCollection({ id: 'abc', createdAt: 5 });
    assert.equal(c.id, 'abc');
    assert.equal(c.createdAt, 5);
  });
});

describe('U7 normalizeUrl', () => {
  const cases = {
    'example.com': 'https://example.com',
    '  example.com/x  ': 'https://example.com/x',
    'localhost:3000/x': 'http://localhost:3000/x',
    'localhost': 'http://localhost',
    '127.0.0.1': 'http://127.0.0.1',
    'http://a.com': 'http://a.com',
    'file:///tmp/a.html': 'file:///tmp/a.html',
    'chrome://settings': 'chrome://settings',
    '': '',
    '   ': '',
  };
  for (const [input, want] of Object.entries(cases)) test(JSON.stringify(input), () => assert.equal(normalizeUrl(input), want));
  test('null and undefined', () => { assert.equal(normalizeUrl(null), ''); assert.equal(normalizeUrl(undefined), ''); });
});

describe('U8 parseImport', () => {
  const col = { id: 'c1', name: 'A', description: 'd', pages: [p('https://a.com')], createdAt: 7 };
  test('an export object', () => {
    const { collections, skipped } = parseImport(JSON.stringify({ format: 'tab-collections', collections: [col] }));
    assert.equal(skipped, 0);
    assert.equal(collections.length, 1);
    assert.equal(collections[0].id, 'c1');
    assert.equal(collections[0].createdAt, 7);
  });
  test('a bare array', () => assert.equal(parseImport(JSON.stringify([col, col])).collections.length, 2));
  test('a single collection', () => assert.equal(parseImport(JSON.stringify(col)).collections[0].name, 'A'));
  test('invalid JSON', () => assert.throws(() => parseImport('{'), /not valid JSON/));
  test('no list', () => {
    assert.throws(() => parseImport('{"x":1}'), /No collections found/);
    assert.throws(() => parseImport('null'), /No collections found/);
  });
  test('invalid entry', () => {
    assert.throws(() => parseImport('[{"pages":[]}]'), /invalid collection entry/);
    assert.throws(() => parseImport('[{"name":"x"}]'), /invalid collection entry/);
    assert.throws(() => parseImport('[null]'), /invalid collection entry/);
  });
  test('drops bad pages, skips collections left empty', () => {
    const { collections, skipped } = parseImport(JSON.stringify([
      { name: 'ok', pages: [null, 5, { url: 3 }, { url: 'b.com' }] },
      { name: 'empty', pages: [] },
      { name: 'blank', pages: [{ url: '' }] },
    ]));
    assert.deepEqual(collections.map((c) => [c.name, c.pages.map((x) => x.url)]), [['ok', ['https://b.com']]]);
    assert.equal(skipped, 2);
  });
  test('invalid id and createdAt are replaced', () => {
    const [c] = parseImport(JSON.stringify([{ id: '', name: 'x', pages: [p('https://a.com')], createdAt: 'yesterday' }])).collections;
    assert.notEqual(c.id, '');
    assert.equal(typeof c.createdAt, 'number');
  });
});

describe('U9 plural and slug', () => {
  test('plural', () => {
    assert.equal(plural(0, 'page'), '0 pages');
    assert.equal(plural(1, 'page'), '1 page');
    assert.equal(plural(2, 'page'), '2 pages');
  });
  test('slug', () => {
    assert.equal(slug('My Work: Tabs!'), 'my-work-tabs');
    assert.equal(slug('!!!'), 'collection');
  });
});

describe('U10 putCollection and saveCollections', () => {
  const full = () => makeCollection({ name: 'Full', pages: [p('https://a.com')] });
  test('refuse an empty collection', async () => {
    await assert.rejects(putCollection(makeCollection({ name: 'Empty' })), /“Empty”: a collection needs at least one page/);
    await assert.rejects(saveCollections({ x: { id: 'x', name: 'X', pages: [] } }), /needs at least one page/);
    assert.deepEqual(await getCollections(), {});
  });
  test('an unchanged, already stored empty collection is accepted', async () => {
    const legacy = { id: 'old', name: 'Old', pages: [] };
    fake.store.collections = { old: legacy };
    const c = full();
    await putCollection(c);
    assert.deepEqual(Object.keys(await getCollections()).sort(), ['old', c.id].sort());
    await removeCollection(c.id);
    assert.deepEqual(Object.keys(await getCollections()), ['old']);
  });
  test('a changed stored empty collection is refused', async () => {
    fake.store.collections = { old: { id: 'old', name: 'Old', pages: [] } };
    await assert.rejects(saveCollections({ old: { id: 'old', name: 'Renamed', pages: [] } }), /needs at least one page/);
  });
  test('putCollection sets updatedAt', async () => {
    const c = full();
    c.updatedAt = 1;
    await putCollection(c);
    assert.ok((await getCollections())[c.id].updatedAt > 1);
  });
});

describe('U11 removeCollection', () => {
  test('removes the collection and its pending changes only', async () => {
    const a = makeCollection({ name: 'A', pages: [p('https://a.com')] });
    const b = makeCollection({ name: 'B', pages: [p('https://b.com')] });
    fake.store.collections = { [a.id]: a, [b.id]: b };
    fake.store.pending = {
      p1: { id: 'p1', collectionId: a.id, live: false },
      p2: { id: 'p2', collectionId: a.id, live: true },
      p3: { id: 'p3', collectionId: b.id, live: false },
    };
    await removeCollection(a.id);
    assert.deepEqual(Object.keys(fake.store.collections), [b.id]);
    assert.deepEqual(Object.keys(fake.store.pending), ['p3']);
  });
});

describe('U12 sameUrlList', () => {
  test('same order only', () => {
    assert.equal(sameUrlList(['a', 'b'], ['a', 'b']), true);
    assert.equal(sameUrlList(['a', 'b'], ['b', 'a']), false);
    assert.equal(sameUrlList(['a'], ['a', 'a']), false);
    assert.equal(sameUrlList([], []), true);
  });
});

describe('U13 suggestName', () => {
  test('no host', () => assert.equal(suggestName([p('not a url'), p('')]), 'Workspace'));
  test('strips www, dedupes, counts the rest', () => {
    assert.equal(suggestName([p('https://www.a.com/1'), p('https://a.com/2'), p('https://b.com')]), 'a.com, b.com');
    assert.equal(suggestName(['a', 'b', 'c', 'd', 'e'].map((h) => p(`https://${h}.com`))), 'a.com, b.com +3');
  });
});

describe('U14 vivaldiData, workspaceKey and workspaceCreated', () => {
  test('vivaldiData', () => {
    assert.deepEqual(vivaldiData({ vivExtData: { workspaceId: 1 } }), { workspaceId: 1 });
    assert.deepEqual(vivaldiData({ vivExtData: '{"workspaceId":2}' }), { workspaceId: 2 });
    assert.equal(vivaldiData({ vivExtData: '{' }), null);
    assert.equal(vivaldiData({}), null);
    assert.equal(vivaldiData(null), null);
  });
  test('workspaceKey', () => {
    assert.equal(workspaceKey({ workspaceId: 1700000000000.0002 }), '1700000000000');
    assert.equal(workspaceKey({ workspaceId: '42' }), '42');
    for (const d of [null, {}, { workspaceId: '' }, { workspaceId: 'x' }]) assert.equal(workspaceKey(d), 'none');
  });
  test('workspaceCreated', () => {
    assert.equal(workspaceCreated('1700000000000').getTime(), 1700000000000);
    assert.equal(workspaceCreated('42'), null);
    assert.equal(workspaceCreated('none'), null);
  });
});

describe('U15 export round trip', () => {
  test('buildExport → parseImport keeps the collection', () => {
    const c = makeCollection({ name: 'A', description: 'd', pages: [p('https://a.com', 'A')], createdAt: 3 });
    const [back] = parseImport(JSON.stringify(buildExport([c]))).collections;
    for (const k of ['id', 'name', 'description', 'pages', 'createdAt']) assert.deepEqual(back[k], c[k], k);
  });
});

describe('U16 suspiciousGrowth', () => {
  test('a jump of more than 10 tabs to more than double', () => {
    assert.equal(suspiciousGrowth(4, 86), true);
    assert.equal(suspiciousGrowth(0, 11), true);
  });
  test('small or proportionate growth is not suspicious', () => {
    assert.equal(suspiciousGrowth(4, 14), false, 'only 10 more');
    assert.equal(suspiciousGrowth(20, 40), false, 'exactly double');
    assert.equal(suspiciousGrowth(30, 50), false, 'less than double');
    assert.equal(suspiciousGrowth(10, 3), false, 'shrinking');
  });
});
