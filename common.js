// Shared helpers used by the background service worker and all extension pages.
// All data lives in chrome.storage.local (client side only):
//   collections: { [id]: { id, name, description, pages: [{url, title}], createdAt, updatedAt } }
//   sessions:    { [windowId]: { collectionId, baseline: [url], initial: {tabId: index}, tabs: [{url, title}], openedAt } }
//   pending:     { [id]: { id, collectionId, collectionName, pages: [{url, title}], closedAt } }

const STORE = chrome.storage.local;
const OWN_PREFIX = chrome.runtime.getURL('');

export async function getAll(key, fallback) {
  const r = await STORE.get(key);
  return r[key] ?? fallback;
}

// ---------- Collections ----------

export const getCollections = () => getAll('collections', {});
export const saveCollections = (collections) => STORE.set({ collections });

export async function getCollection(id) {
  return (await getCollections())[id] || null;
}

export async function putCollection(col) {
  const all = await getCollections();
  col.updatedAt = Date.now();
  all[col.id] = col;
  await saveCollections(all);
  return col;
}

export async function removeCollection(id) {
  const all = await getCollections();
  delete all[id];
  await saveCollections(all);
}

export function newId() {
  return crypto.randomUUID();
}

export function makeCollection({ id, name, description, pages, createdAt } = {}) {
  return {
    id: id || newId(),
    name: (name || '').trim() || 'Untitled collection',
    description: description || '',
    pages: (pages || [])
      .map((p) => ({ url: normalizeUrl(p.url), title: String(p.title || '') }))
      .filter((p) => p.url),
    createdAt: createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------- URLs ----------

export function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (/^(localhost|[\d.]+)(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  return u;
}

// Tabs that should not count as "pages" of a collection (empty new tabs, this extension's own pages).
export function isIgnorableUrl(u) {
  return (
    !u ||
    u === 'about:blank' ||
    u.startsWith('chrome://newtab') ||
    u.startsWith('chrome://new-tab-page') ||
    u.startsWith('chrome-search://') ||
    u.startsWith(OWN_PREFIX)
  );
}

export const cleanPages = (pages) => pages.filter((p) => !isIgnorableUrl(p.url));

export function sameUrlList(a, b) {
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

// Multiset diff by URL: what was added / removed going from `before` to `after`.
export function diffPages(before, after) {
  const count = new Map();
  for (const p of before) count.set(p.url, (count.get(p.url) || 0) + 1);
  const added = [];
  for (const p of after) {
    const n = count.get(p.url) || 0;
    if (n > 0) count.set(p.url, n - 1);
    else added.push(p);
  }
  const left = new Map(count);
  const removed = [];
  for (const p of before) {
    const n = left.get(p.url) || 0;
    if (n > 0) {
      removed.push(p);
      left.set(p.url, n - 1);
    }
  }
  const reordered =
    !added.length && !removed.length && !sameUrlList(before.map((p) => p.url), after.map((p) => p.url));
  return { added, removed, reordered };
}

export function faviconUrl(pageUrl, size = 16) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}

// ---------- Pending "collection changed" reviews ----------

export const getPending = () => getAll('pending', {});

export async function resolvePending(id) {
  const p = await getPending();
  delete p[id];
  await STORE.set({ pending: p });
}

export function openReview(id) {
  return chrome.windows.create({
    url: chrome.runtime.getURL(`prompt.html?id=${encodeURIComponent(id)}`),
    type: 'popup',
    width: 540,
    height: 600,
    focused: true,
  });
}

// ---------- Backup / sharing ----------

export const EXPORT_FORMAT = 'tab-collections';

export function buildExport(collections) {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    collections: collections.map(({ id, name, description, pages, createdAt, updatedAt }) => ({
      id, name, description, pages, createdAt, updatedAt,
    })),
  };
}

export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.collections)
      ? data.collections
      : data && Array.isArray(data.pages)
        ? [data]
        : null;
  if (!list) throw new Error('No collections found in this file.');
  return list.map((c) => {
    if (!c || typeof c.name !== 'string' || !Array.isArray(c.pages)) {
      throw new Error('The file contains an invalid collection entry.');
    }
    return makeCollection({
      id: typeof c.id === 'string' && c.id ? c.id : undefined,
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      pages: c.pages.filter((p) => p && typeof p.url === 'string'),
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : undefined,
    });
  });
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collection';
}

export function readFileText(file) {
  return file.text();
}

// ---------- UI helpers ----------

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || 'Unknown error');
  return res.result;
}

// Focus an already-open manager tab, or open a new one.
export async function openManagerPage(path = 'collections.html') {
  const target = chrome.runtime.getURL(path);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url === target);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: target });
  }
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
