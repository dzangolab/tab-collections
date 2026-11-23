// Background service worker: opens collections as windows, tracks the tabs in
// those windows, and asks the user what to do when a changed window is closed.

import {
  api, getAll, getCollection, putCollection, newId, cleanPages, sameUrlList, isIgnorableUrl, openReview,
} from './common.js';
import {
  CHECK_ALARM, disconnectSync, ensureAlarm, onLocalChange, refreshBadge, resolveConflict, scheduledCheck, setSyncMode,
  setupSync, syncNow, syncStatus,
} from './sync/engine.js';

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

  // Always the saved pages: undecided changes from when the window was last closed weren't
  // confirmed by anyone (a window that closed without a prompt may have held any number of
  // unrelated tabs), so they stay listed for the user to update or restore, and never open here.
  const urls = col.pages.map((p) => p.url).filter(Boolean);
  // Only empty collections stored before they were forbidden: nothing to open.
  if (!urls.length) throw new Error('This collection has no pages. Add one first.');
  const win = await api.windows.create({ url: urls, focused: true });

  await withSessions(async (ss) => {
    if (await windowGone(win.id)) return; // closed before we got here: nothing to track
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

async function windowGone(windowId) {
  try { await api.windows.get(Number(windowId)); return false; } catch { return true; }
}

// Forgets the windows that have closed, and returns the remaining sessions. Usually
// `windows.onRemoved` just hasn't run yet; it will then find no session, so this handles the
// window as it would, prompt included. `prompt: false` for windows that closed while the
// extension wasn't running (reloaded): their changes stay undecided, like a browser quit.
async function pruneSessions({ prompt = true } = {}) {
  const stale = await withSessions(async (ss) => {
    const out = [];
    for (const [w, s] of Object.entries(ss)) if (await windowGone(w)) { out.push([Number(w), s]); delete ss[w]; }
    return out;
  });
  for (const [windowId, s] of stale) await reviewSession(s, prompt ? { windowId } : { prompt: false });
  return getAll('sessions', {});
}

// Closes a collection's windows. A window that is already gone counts as closed.
async function closeCollection(id) {
  const sessions = await getAll('sessions', {});
  const windowIds = Object.entries(sessions).filter(([, s]) => s.collectionId === id).map(([w]) => Number(w));
  await Promise.all(windowIds.map(async (w) => {
    try {
      await api.windows.remove(w);
    } catch (e) {
      if (!(await windowGone(w))) throw e;
    }
  }));
  await pruneSessions();
}

// Removes the pending changes `match` selects, and closes their prompts if open.
async function dropPending(match) {
  const prompts = await withPending((p) => {
    const out = [];
    for (const [k, v] of Object.entries(p)) if (match(v)) { out.push(v.promptWindowId); delete p[k]; }
    return out;
  });
  for (const w of prompts) if (w != null) api.windows.remove(w).catch(() => {});
}

// Start tracking an existing window as a collection (used by "Save this window", and after saving
// an open window's tabs). `baseline` is the list of URLs that counts as unchanged; it defaults to
// the window's current tabs.
async function adoptWindow(windowId, collectionId, baseline = null) {
  await withSessions(async (ss) => {
    for (const [w, s] of Object.entries(ss)) if (s.collectionId === collectionId) delete ss[w];
    if (await windowGone(windowId)) return;
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
  // The session first, so the window stops showing as open even if what follows fails.
  const s = await withSessions((ss) => {
    const found = ss[windowId];
    if (found) delete ss[windowId];
    return found;
  });

  // A prompt closed without an answer leaves the changes of a closed window undecided; those of a
  // window that is still open are worked out again from its tabs, so forget them.
  await withPending((p) => {
    for (const [k, v] of Object.entries(p)) {
      if (v.promptWindowId !== windowId) continue;
      if (v.live) delete p[k];
      else v.promptWindowId = null;
    }
  });

  if (s) await reviewSession(s, { windowId });
});

// Records a session's changes when its tabs differ from its collection, and opens the prompt.
// `live`: the window is still open (the user asked from the popup or a page); its changes are kept
// only while the prompt is open. Otherwise the window has closed: its changes stay undecided until
// the user updates or restores the collection. `prompt: false` records them without a prompt.
async function reviewSession(s, { live = false, windowId = null, prompt = true } = {}) {
  const col = await getCollection(s.collectionId);
  if (!col) return; // collection was deleted while open

  const nowPages = cleanPages(s.tabs || []);
  if (!nowPages.length) return; // an empty window (or one closed before its tabs were read) isn't a change
  if (!hasChanged(s, col, nowPages)) return;

  const id = newId();
  // Newer changes replace earlier ones: from the same window, and for a closed window, any earlier
  // undecided changes of the same collection.
  await dropPending((v) => (windowId != null && v.windowId === windowId) || (!live && !v.live && v.collectionId === col.id));
  await withPending((p) => {
    p[id] = {
      id, collectionId: col.id, collectionName: col.name, pages: nowPages, closedAt: Date.now(),
      baseline: (s.baseline || []).length === col.pages.length ? s.baseline : null,
      live, windowId,
    };
  });
  if (!prompt) return;

  let win;
  try { win = await openReview(id); } catch (e) { console.warn('Could not open review window', e); }
  await withPending((p) => {
    if (!p[id]) return;
    if (win?.id != null) p[id].promptWindowId = win.id;
    else if (live) delete p[id]; // no prompt to answer
  });
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

// For the popup's list: each open collection's window, and whether its tabs have drifted.
async function driftStatus() {
  const out = {};
  for (const w of Object.keys(await pruneSessions())) {
    const state = await windowState(Number(w));
    if (state) {
      out[state.col.id] = { windowId: Number(w), changed: state.changed, count: state.pages.length, empty: !state.pages.length };
    }
  }
  return out;
}

// Update a collection from the tabs of its open window, which then counts as unchanged.
async function updateFromWindow(windowId) {
  const state = await windowState(windowId);
  if (!state) throw new Error('This window is not a collection');
  const pages = state.pages.map((p) => ({ url: p.url, title: p.title }));
  await putCollection({ ...state.col, pages });
  await adoptWindow(windowId, state.col.id, pages.map((p) => p.url));
  await dropPending((v) => v.live && v.windowId === windowId);
}

// The toolbar popup's button: the same prompt as closing the window, while it stays open.
async function reviewWindow(windowId) {
  await refresh(windowId);
  const s = (await getAll('sessions', {}))[windowId];
  if (!s) throw new Error('This window is not a collection');
  await reviewSession(s, { live: true, windowId });
}

// Windows that closed without a prompt (browser quit, extension reloaded) keep their changes as
// undecided, without a prompt.

// After a browser restart, window ids are reused, so every tracked window is gone, and so is
// every prompt.
api.runtime.onStartup.addListener(async () => {
  const old = await withSessions((ss) => {
    const vals = Object.values(ss);
    for (const k of Object.keys(ss)) delete ss[k];
    return vals;
  });
  await dropPending((v) => v.live);
  await withPending((p) => { for (const v of Object.values(p)) v.promptWindowId = null; });
  for (const s of old) await reviewSession(s, { prompt: false });
});

// After install / update / reload, drop sessions and prompts whose windows no longer exist.
api.runtime.onInstalled.addListener(async () => {
  await pruneSessions({ prompt: false });
  await withPending(async (p) => {
    for (const [k, v] of Object.entries(p)) {
      const promptGone = v.promptWindowId == null || await windowGone(v.promptWindowId);
      if (v.live && promptGone) delete p[k];
      else if (promptGone) v.promptWindowId = null;
    }
  });
  await api.action.setBadgeText({ text: '' }); // clear the count earlier versions showed
  await refreshBadge();
  await ensureAlarm();
});

// ---------- Sync ----------

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.collections || changes.tombstones)) onLocalChange().catch((e) => console.warn('[sync]', e));
});
api.alarms?.onAlarm.addListener((alarm) => { if (alarm.name === CHECK_ALARM) return scheduledCheck(); });
api.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await scheduledCheck();
});

// ---------- Messages from pages ----------

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'open': return openCollection(msg.id);
      case 'closeCollection': return closeCollection(msg.id);
      case 'adopt': return adoptWindow(msg.windowId, msg.collectionId, msg.baseline);
      case 'saveAndAdopt': {
        await putCollection(msg.collection);
        await adoptWindow(msg.windowId, msg.collection.id);
        return msg.collection.id;
      }
      case 'driftStatus': return driftStatus();
      case 'reviewWindow': return reviewWindow(msg.windowId);
      case 'updateFromWindow': return updateFromWindow(msg.windowId);
      case 'windowStatus': {
        const state = await windowState(msg.windowId);
        return state && { changed: state.changed, name: state.col.name };
      }
      case 'syncDisconnect': return disconnectSync();
      case 'syncMode': return setSyncMode(msg.mode);
      case 'syncNow': return syncNow();
      case 'syncResolve': return resolveConflict(msg.id, msg.choice);
      case 'syncSetup': return setupSync(msg.config);
      case 'syncStatus': return syncStatus();
      default: throw new Error(`Unknown message: ${msg?.type}`);
    }
  })().then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});
