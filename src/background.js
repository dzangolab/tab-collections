// Background service worker: opens collections as windows, tracks the tabs in
// those windows, and asks the user what to do when a changed window is closed.

import {
  api, getAll, getCollection, putCollection, newId, cleanPages, sameUrlList, isIgnorableUrl, openReview,
} from './common.js';

const SETTLE_WINDOW_MS = 60_000; // redirects within this time after opening are not "changes"

// ---------- Serialized read-modify-write on storage ----------

function serialized(key) {
  let queue = Promise.resolve();
  return (fn) => {
    const run = queue.then(async () => {
      const data = await getAll(key, {});
      const before = JSON.stringify(data);
      const result = await fn(data);
      if (JSON.stringify(data) !== before) await api.storage.local.set({ [key]: data });
      return result;
    });
    queue = run.catch((e) => console.error(`[${key}]`, e));
    return run;
  };
}
const withSessions = serialized('sessions');
const withPending = serialized('pending');

const tabToPage = (t) => ({ url: t.url || t.pendingUrl || '', title: t.title || '' });
const sortTabs = (tabs) => tabs.sort((a, b) => a.index - b.index);

// ---------- Opening collections ----------

async function openCollection(id) {
  const col = await getCollection(id);
  if (!col) throw new Error('Collection not found');

  // Already open? Just focus that window.
  const sessions = await getAll('sessions', {});
  for (const [w, s] of Object.entries(sessions)) {
    if (s.collectionId !== id) continue;
    try {
      await api.windows.update(Number(w), { focused: true });
      return { focused: true, windowId: Number(w) };
    } catch {
      await withSessions((ss) => { delete ss[w]; });
    }
  }

  const urls = col.pages.map((p) => p.url).filter(Boolean);
  const win = await api.windows.create(urls.length ? { url: urls, focused: true } : { focused: true });

  await withSessions(async (ss) => {
    const tabs = sortTabs(await api.tabs.query({ windowId: win.id }));
    const baseline = urls.slice();
    const initial = {};
    tabs.forEach((t, i) => {
      if (i >= urls.length) return;
      const loaded = t.status === 'complete' && t.url && t.url !== 'about:blank' && !t.pendingUrl;
      if (loaded) baseline[i] = t.url;
      else initial[t.id] = i;
    });
    ss[win.id] = { collectionId: id, baseline, initial, openedAt: Date.now(), tabs: tabs.map(tabToPage) };
  });
  return { opened: true, windowId: win.id };
}

// Start tracking an existing window as a collection (used by "Save this window", and after saving
// an open window's tabs). `baseline` is the list of URLs that counts as unchanged; it defaults to
// the window's current tabs.
async function adoptWindow(windowId, collectionId, baseline = null) {
  await withSessions(async (ss) => {
    for (const [w, s] of Object.entries(ss)) if (s.collectionId === collectionId) delete ss[w];
    const tabs = sortTabs(await api.tabs.query({ windowId }));
    ss[windowId] = {
      collectionId,
      baseline: baseline || tabs.map((t) => t.url || t.pendingUrl || ''),
      initial: {},
      openedAt: Date.now(),
      tabs: tabs.map(tabToPage),
    };
  });
}

// ---------- Tracking tab changes ----------

function refresh(windowId, settle) {
  if (windowId == null || windowId < 0) return;
  return withSessions(async (ss) => {
    const s = ss[windowId];
    if (!s) return;
    try { await api.windows.get(windowId); } catch { return; } // window is closing
    const tabs = await api.tabs.query({ windowId });
    if (!tabs.length) return;
    s.tabs = sortTabs(tabs).map(tabToPage);

    if (s.initial && Object.keys(s.initial).length) {
      if (Date.now() - s.openedAt > SETTLE_WINDOW_MS) {
        s.initial = {};
      } else if (settle && settle.tabId in s.initial) {
        if (settle.url) s.baseline[s.initial[settle.tabId]] = settle.url;
        delete s.initial[settle.tabId];
      }
    }
  });
}

api.tabs.onCreated.addListener((t) => refresh(t.windowId));
api.tabs.onUpdated.addListener((tabId, ci, tab) => {
  if (ci.url || ci.title || ci.status === 'complete') {
    refresh(tab.windowId, ci.status === 'complete' ? { tabId, url: tab.url } : null);
  }
});
api.tabs.onRemoved.addListener((tabId, info) => { if (!info.isWindowClosing) refresh(info.windowId); });
api.tabs.onMoved?.addListener((tabId, info) => refresh(info.windowId));
api.tabs.onAttached?.addListener((tabId, info) => refresh(info.newWindowId));
api.tabs.onDetached?.addListener((tabId, info) => refresh(info.oldWindowId));
api.tabs.onReplaced?.addListener(async (addedId) => {
  try { refresh((await api.tabs.get(addedId)).windowId); } catch { /* gone */ }
});

// ---------- Window closed: compare and ask ----------

api.windows.onRemoved.addListener(async (windowId) => {
  const s = await withSessions((ss) => {
    const found = ss[windowId];
    if (found) delete ss[windowId];
    return found;
  });
  if (s) await reviewSession(s, { windowId });
});

// Opens the "Update collection?" prompt when a session's tabs differ from its collection.
// `live` means the window is still open: the user asked from the toolbar popup.
async function reviewSession(s, { live = false, windowId = null } = {}) {
  const col = await getCollection(s.collectionId);
  if (!col) return; // collection was deleted while open

  const nowPages = cleanPages(s.tabs || []);
  if (!hasChanged(s, col, nowPages)) return;

  const id = newId();
  await withPending((p) => {
    // A newer prompt for the same window replaces an unanswered earlier one.
    if (windowId != null) {
      for (const [k, v] of Object.entries(p)) if (v.windowId === windowId) delete p[k];
    }
    p[id] = {
      id, collectionId: col.id, collectionName: col.name, pages: nowPages, closedAt: Date.now(),
      baseline: (s.baseline || []).length === col.pages.length ? s.baseline : null,
      live, windowId,
    };
  });
  try { await openReview(id); } catch (e) { console.warn('Could not open review window', e); }
}

// Whether a window's tabs differ from both the URLs it opened with and the saved collection.
function hasChanged(s, col, nowPages) {
  const nowUrls = nowPages.map((p) => p.url);
  const baseUrls = (s.baseline || []).filter((u) => !isIgnorableUrl(u));
  const colUrls = col.pages.map((p) => p.url).filter((u) => !isIgnorableUrl(u));
  return !sameUrlList(nowUrls, baseUrls) && !sameUrlList(nowUrls, colUrls);
}

// ---------- Collection windows that are still open ----------

// The collection a window was opened from, its current tabs, and whether they changed.
async function windowState(windowId) {
  await refresh(windowId);
  const s = (await getAll('sessions', {}))[windowId];
  const col = s && await getCollection(s.collectionId);
  if (!col) return null;
  const pages = cleanPages(s.tabs || []);
  return { col, pages, changed: hasChanged(s, col, pages) };
}

// The toolbar popup's button: the same prompt as closing the window, while it stays open.
async function reviewWindow(windowId) {
  await refresh(windowId);
  const s = (await getAll('sessions', {}))[windowId];
  if (!s) throw new Error('This window is not a collection');
  await reviewSession(s, { live: true, windowId });
}

// After a browser restart, window ids are reused, so every tracked window is gone.
api.runtime.onStartup.addListener(async () => {
  const old = await withSessions((ss) => {
    const vals = Object.values(ss);
    for (const k of Object.keys(ss)) delete ss[k];
    return vals;
  });
  for (const s of old) await reviewSession(s);
  updateBadge();
});

// After install / update / reload, drop sessions whose windows no longer exist.
api.runtime.onInstalled.addListener(async () => {
  const stale = await withSessions(async (ss) => {
    const out = [];
    for (const [w, s] of Object.entries(ss)) {
      try { await api.windows.get(Number(w)); } catch { out.push(s); delete ss[w]; }
    }
    return out;
  });
  for (const s of stale) await reviewSession(s);
  updateBadge();
});

// ---------- Badge shows unresolved reviews ----------

async function updateBadge() {
  const n = Object.keys(await getAll('pending', {})).length;
  await api.action.setBadgeText({ text: n ? String(n) : '' });
  if (n) await api.action.setBadgeBackgroundColor({ color: '#d97706' });
}
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pending) updateBadge();
});

// ---------- Messages from pages ----------

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'open': return openCollection(msg.id);
      case 'adopt': return adoptWindow(msg.windowId, msg.collectionId, msg.baseline);
      case 'saveAndAdopt': {
        await putCollection(msg.collection);
        await adoptWindow(msg.windowId, msg.collection.id);
        return msg.collection.id;
      }
      case 'reviewWindow': return reviewWindow(msg.windowId);
      case 'windowStatus': {
        const state = await windowState(msg.windowId);
        return state && { changed: state.changed, name: state.col.name };
      }
      default: throw new Error(`Unknown message: ${msg?.type}`);
    }
  })().then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});
