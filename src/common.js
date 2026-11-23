// Shared helpers used by the background service worker and all extension pages.
// All data lives in api.storage.local (client side only):
//   collections: { [id]: { id, name, description, pages: [{url, title}], createdAt, updatedAt } }
//   sessions:    { [windowId]: { collectionId, baseline: [url], initial: {tabId: index}, tabs: [{url, title}], openedAt } }
//   pending:     { [id]: { id, collectionId, collectionName, pages: [{url, title}], closedAt, baseline,
//                          live, windowId, promptWindowId } }
//                changes the user hasn't decided on: a closed window's (live: false) until it is
//                updated or restored; an open window's (live: true) only while its prompt is open
//   settings:    { closeDefault: 'keep' | 'update' }

// Cross-browser API handle: Firefox and Safari expose `browser`, Chromium exposes `chrome`.
// All of them return promises in Manifest V3.
export const api = globalThis.browser ?? globalThis.chrome;

const STORE = api.storage.local;
const IS_CHROMIUM = api.runtime.getURL('').startsWith('chrome-extension://');
const OWN_PREFIX = api.runtime.getURL('');

export async function getAll(key, fallback) {
  const r = await STORE.get(key);
  return r[key] ?? fallback;
}

// ---------- Collections ----------

export const getCollections = () => getAll('collections', {});

// A collection always has at least one page.
export const hasPages = (col) => Array.isArray(col?.pages) && col.pages.some((p) => p?.url);

// Every write of the collections goes through here, so no caller can store an empty one. Empty
// ones stored before this rule stay as they are (unchanged), so saving the others, or deleting
// one, still works.
export async function saveCollections(collections) {
  const stored = await getCollections();
  for (const col of Object.values(collections)) {
    if (hasPages(col)) continue;
    if (stored[col.id] && JSON.stringify(stored[col.id]) === JSON.stringify(col)) continue;
    throw new Error(`Can’t save “${col.name}”: a collection needs at least one page`);
  }
  await STORE.set({ collections });
}

export async function getCollection(id) {
  return (await getCollections())[id] || null;
}

export async function putCollection(col) {
  if (!hasPages(col)) throw new Error(`Can’t save “${col.name}”: a collection needs at least one page`);
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
  const pending = await getPending();
  for (const [k, v] of Object.entries(pending)) if (v.collectionId === id) delete pending[k];
  await STORE.set({ pending });
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
    u.startsWith('about:') || // about:blank, Firefox about:newtab / about:home
    u.startsWith('favorites:') || // Safari start page
    u.startsWith('chrome://newtab') ||
    u.startsWith('chrome://new-tab-page') ||
    u.startsWith('chrome-search://') ||
    /^(edge|brave|opera|vivaldi):\/\/(newtab|startpage)/.test(u) || // other Chromium new-tab pages
    u.startsWith('chrome://vivaldi-webui/startpage') ||
    u.startsWith('chrome://startpageshared') ||
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

const GLOBE_ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="%23888" stroke-width="1.2">' +
  '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13"/></svg>');

// Chromium has a built-in favicon cache (needs the "favicon" permission). Other browsers
// fall back to the site's /favicon.ico, and to a generic globe if that fails.
export function faviconUrl(pageUrl, size = 16) {
  try {
    const page = new URL(pageUrl);
    if (!/^https?:$/.test(page.protocol)) return GLOBE_ICON;
    if (IS_CHROMIUM) {
      const u = new URL(api.runtime.getURL('/_favicon/'));
      u.searchParams.set('pageUrl', pageUrl);
      u.searchParams.set('size', String(size));
      return u.toString();
    }
    return page.origin + '/favicon.ico';
  } catch {
    return GLOBE_ICON;
  }
}

export function faviconImg(pageUrl) {
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => { if (img.src !== GLOBE_ICON) img.src = GLOBE_ICON; });
  img.src = faviconUrl(pageUrl);
  return img;
}

// ---------- Pending "collection changed" reviews ----------

export const getPending = () => getAll('pending', {});

export async function resolvePending(id) {
  const p = await getPending();
  delete p[id];
  await STORE.set({ pending: p });
}

// A closed window's undecided changes, by collection id.
export async function closedDrift() {
  const out = {};
  for (const p of Object.values(await getPending())) if (!p.live) out[p.collectionId] = p;
  return out;
}

// "Update": the collection takes the closed window's tabs.
export async function updateFromPending(pending) {
  const col = await getCollection(pending.collectionId);
  if (col) await putCollection({ ...col, pages: pending.pages.map((p) => ({ url: p.url, title: p.title })) });
  await resolvePending(pending.id);
}

export async function openReview(id) {
  const url = api.runtime.getURL(`prompt.html?id=${encodeURIComponent(id)}`);
  try {
    return await api.windows.create({ url, type: 'popup', width: 540, height: 600, focused: true });
  } catch {
    // Some browsers (e.g. Safari) don't support popup-type windows.
    return api.windows.create({ url, focused: true });
  }
}

// ---------- Settings ----------

// closeDefault: the prompt button focused and highlighted when a drifted window closes.
export const SETTINGS_DEFAULTS = { closeDefault: 'keep' };

export async function getSettings() {
  return { ...SETTINGS_DEFAULTS, ...(await getAll('settings', {})) };
}

export async function saveSetting(key, value) {
  const settings = await getAll('settings', {});
  settings[key] = value;
  await STORE.set({ settings });
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
  const collections = list.map((c) => {
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
  // Collections without a valid page can't be stored: skip them, and say how many.
  const kept = collections.filter(hasPages);
  return { collections: kept, skipped: collections.length - kept.length };
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

// Stroke icons (24×24, currentColor), shared by the extension pages.
const ICONS = {
  back: 'M15 6l-6 6 6 6',
  delete: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  export: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  pages: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 9h18',
};
export function icon(name, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'drag' ? '3.2' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// The strip shown under a collection whose window's tabs have changed. `onRestore` only for a
// closed window: the extension never closes tabs of an open one. No `onUpdate` when the window has
// no pages left.
export function driftStrip({ onDetails, onUpdate, onRestore }) {
  const ns = 'http://www.w3.org/2000/svg';
  const warn = document.createElementNS(ns, 'svg');
  warn.setAttribute('viewBox', '0 0 16 14');
  warn.setAttribute('width', '16');
  warn.setAttribute('height', '14');
  warn.setAttribute('aria-hidden', 'true');
  for (const [d, attrs] of [
    ['M8 .8 15.4 13.2H.6Z', { fill: '#f5b800', stroke: '#b98a00', 'stroke-linejoin': 'round' }],
    ['M8 5v4M8 10.6v.9', { fill: 'none', stroke: '#3a2a00', 'stroke-width': '1.8', 'stroke-linecap': 'round' }],
  ]) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    for (const [k, v] of Object.entries(attrs)) path.setAttribute(k, v);
    warn.append(path);
  }
  return el('div', { class: 'drift-strip' },
    warn,
    el('span', { class: 'drift-msg' }, onRestore
      ? 'The tabs in this collection’s window changed before it was closed'
      : 'The tabs in this collection’s window have changed'),
    el('button', { onclick: onDetails }, 'Details'),
    onUpdate && el('button', { class: 'primary', onclick: onUpdate }, 'Update'),
    onRestore && el('button', { onclick: onRestore }, 'Restore'));
}

// The drift strip for a collection, if its window's tabs have changed: undecided changes of a
// closed window (`closed`, from closedDrift()), or its open window's tabs differing from it
// (`live`, from the driftStatus message). `notify` shows a short message.
// An Update that would grow the collection suspiciously opens the review instead, which shows the
// warning and the full list of tabs.
export function collectionDrift(id, closed, live, notify) {
  const failed = (e) => notify(e.message);
  const checked = (count, review, update) => async () => {
    const col = await getCollection(id);
    if (col && suspiciousGrowth(col.pages.length, count)) {
      await review();
      notify('Check the tabs before updating');
      return;
    }
    await update();
    notify('Collection updated');
  };
  const pending = closed[id];
  if (pending) {
    return driftStrip({
      onDetails: () => openReview(pending.id).catch(failed),
      // No Update when the window had no pages left: a collection needs at least one.
      onUpdate: pending.pages.length
        ? () => checked(pending.pages.length, () => openReview(pending.id), () => updateFromPending(pending))().catch(failed)
        : null,
      onRestore: () => resolvePending(pending.id).then(() => notify('Collection restored'), failed),
    });
  }
  const w = live[id];
  if (!w?.changed) return null;
  return driftStrip({
    onDetails: () => send({ type: 'reviewWindow', windowId: w.windowId }).catch(failed),
    onUpdate: w.empty
      ? null
      : () => checked(
        w.count ?? 0,
        () => send({ type: 'reviewWindow', windowId: w.windowId }),
        () => send({ type: 'updateFromWindow', windowId: w.windowId }),
      )().catch(failed),
  });
}

// ---------- Unexpected growth ----------
// The tabs the API reports for a window can include tabs the user can't see: in Vivaldi, a window
// holds the tabs of every workspace shown in it. Saving many more tabs than the collection had is
// more likely to have picked those up than to be what the user wants, so it asks first.
export const GROWTH_MIN_ADDED = 10;

export function suspiciousGrowth(before, after) {
  return after - before > GROWTH_MIN_ADDED && after > 2 * before;
}

export function growthWarning(before, after) {
  return `This window has ${plural(after, 'tab')}, but the collection has ${plural(before, 'page')}. `
    + 'In browsers with workspaces, such as Vivaldi, a window also counts the tabs of its other '
    + 'workspaces, even the ones you can’t see. Check the list before updating.';
}

export const VIVALDI_NOTE = 'In Vivaldi, a window includes the tabs of all its workspaces. Check the '
  + 'list for tabs from other workspaces. To keep collections apart, open each one in a window of its own.';

// Whether the browser is Vivaldi, as far as tabs tell: some versions add `vivExtData` to each tab.
export async function isVivaldi() {
  try { return hasVivaldiData(await api.tabs.query({})); } catch { return false; }
}

export async function send(msg) {
  const res = await api.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || 'Unknown error');
  return res.result;
}

// Focus an already-open manager tab, or open a new one.
export async function openManagerPage(path = 'collections.html') {
  const target = api.runtime.getURL(path);
  const tabs = await api.tabs.query({});
  const existing = tabs.find((t) => t.url === target);
  if (existing) {
    await api.tabs.update(existing.id, { active: true });
    await api.windows.update(existing.windowId, { focused: true });
  } else {
    await api.tabs.create({ url: target });
  }
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------- Vivaldi workspaces ----------
// Vivaldi has no official workspaces API. Some versions attach a `vivExtData` field
// (JSON) to each tab that includes the tab's workspaceId. Workspace names are not exposed.

export function vivaldiData(tab) {
  const raw = tab?.vivExtData;
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export const hasVivaldiData = (tabs) => tabs.some((t) => t && 'vivExtData' in t);

// workspaceId is sometimes reported as a float, so round it. 'none' = tabs outside any workspace.
export function workspaceKey(data) {
  const id = data?.workspaceId;
  return id == null || id === '' || Number.isNaN(Number(id)) ? 'none' : String(Math.round(Number(id)));
}

const tabPage = (t) => ({ url: t.url || t.pendingUrl || '', title: t.title || '' });

// Group tabs (from all windows) by Vivaldi workspace. Returns null when not detectable.
export function groupByWorkspace(tabs) {
  if (!hasVivaldiData(tabs)) return null;
  const groups = new Map();
  const sorted = [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  for (const t of sorted) {
    const d = vivaldiData(t) || {};
    if (d.panelId) continue; // web panels in the sidebar
    const page = tabPage(t);
    if (isIgnorableUrl(page.url)) continue;
    const key = workspaceKey(d);
    if (!groups.has(key)) groups.set(key, { key, pages: [] });
    groups.get(key).pages.push(page);
  }
  return [...groups.values()].sort((a, b) =>
    a.key === 'none' ? 1 : b.key === 'none' ? -1 : Number(a.key) - Number(b.key));
}

export async function getVivaldiWorkspaces() {
  return groupByWorkspace(await api.tabs.query({}));
}

// Workspace ids are creation timestamps (ms) in current Vivaldi versions.
export function workspaceCreated(key) {
  const n = Number(key);
  return n > 1e12 && n < 1e13 ? new Date(n) : null;
}

export function suggestName(pages) {
  const hosts = [];
  for (const p of pages) {
    try {
      const h = new URL(p.url).hostname.replace(/^www\./, '');
      if (h && !hosts.includes(h)) hosts.push(h);
    } catch { /* skip */ }
  }
  if (!hosts.length) return 'Workspace';
  return hosts.slice(0, 2).join(', ') + (hosts.length > 2 ? ` +${hosts.length - 2}` : '');
}
