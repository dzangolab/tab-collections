// An in-memory stand-in for the parts of the WebExtension API the extension uses: storage.local,
// windows, tabs, runtime and action. Behaves like Chromium where it matters to the extension:
// - calls are async; events fire after the call that caused them, and are not awaited by it;
// - a closed window's tabs fire tabs.onRemoved with isWindowClosing, then windows.onRemoved;
// - windows.get / update / remove reject with "No window with id: N." once a window is gone.
// `flush()` waits until every event fired so far, and whatever its listeners started, has settled.

const ORIGIN = 'chrome-extension://test/';

function event(fake) {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    _clear: () => listeners.clear(),
    _count: () => listeners.size,
    // Fires asynchronously, like a browser event; listeners' promises are tracked for flush().
    _emit: (...args) => fake._track(Promise.resolve().then(() =>
      Promise.all([...listeners].map(async (fn) => fn(...args))))),
    // Calls the listeners directly and returns their results (for runtime.onMessage).
    _call: (...args) => [...listeners].map((fn) => fn(...args)),
  };
}

const noWindow = (id) => new Error(`No window with id: ${id}.`);
const noTab = (id) => new Error(`No tab with id: ${id}.`);

export function createFakeBrowser() {
  const fake = {
    // ---------- test controls ----------
    options: {
      onRemovedDelay: 0, // ms before windows.onRemoved fires after a window closes
      popupWindows: true, // false: windows.create({ type: 'popup' }) throws (Safari)
      failWindowCreate: false, // true: every windows.create throws
      loadTabs: false, // true: new tabs start loading (status 'loading', pendingUrl), see completeTab
      grantPermissions: true, // permissions.request's answer
    },
    alarms: new Map(), // name → alarm
    permissionRequests: [], // origins asked for, per permissions.request call
    store: {},
    windows: new Map(), // id → { id, type, focused, tabIds: [] }
    tabs: new Map(), // id → tab
    nextWindowId: 1,
    nextTabId: 1,
    currentWindowId: null,
    currentTabId: null, // tabs.getCurrent() result (the page under test), or null
    badge: null,
    pendingWork: new Set(),
    _track(p) {
      const tracked = p.catch((e) => { fake.errors.push(e); });
      fake.pendingWork.add(tracked);
      tracked.finally(() => fake.pendingWork.delete(tracked));
      return p;
    },
    errors: [],
  };

  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  function tabView(t) {
    const w = fake.windows.get(t.windowId);
    return clone({ ...t, index: w ? w.tabIds.indexOf(t.id) : -1 });
  }

  function makeTab(windowId, { url = 'chrome://newtab/', title = '', active = false, highlighted = false, vivExtData } = {}) {
    const id = fake.nextTabId++;
    const tab = { id, windowId, url, title: title || url, active, highlighted, status: 'complete' };
    if (vivExtData !== undefined) tab.vivExtData = vivExtData;
    if (fake.options.loadTabs && !url.startsWith('chrome://')) {
      Object.assign(tab, { url: '', pendingUrl: url, status: 'loading', title: '' });
    }
    fake.tabs.set(id, tab);
    return tab;
  }

  const ev = () => event(fake);
  const api = {
    storage: {
      local: {
        async get(keys) {
          const all = fake.store;
          if (keys == null) return clone(all);
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in all) out[k] = clone(all[k]);
          return out;
        },
        async set(items) {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: clone(fake.store[k]), newValue: clone(v) };
            fake.store[k] = clone(v);
          }
          api.storage.onChanged._emit(changes, 'local');
        },
      },
      onChanged: ev(),
    },

    windows: {
      async create({ url, type = 'normal', focused = true } = {}) {
        if (fake.options.failWindowCreate) throw new Error('Could not create window');
        if (type === 'popup' && !fake.options.popupWindows) throw new Error('Popup windows are not supported');
        const id = fake.nextWindowId++;
        const w = { id, type, focused, tabIds: [] };
        fake.windows.set(id, w);
        const urls = url == null ? ['chrome://newtab/'] : Array.isArray(url) ? url : [url];
        urls.forEach((u, i) => w.tabIds.push(makeTab(id, { url: u, active: i === 0, highlighted: i === 0 }).id));
        if (focused) fake.currentWindowId = id;
        api.windows.onCreated._emit({ id, type });
        for (const tid of w.tabIds) api.tabs.onCreated._emit(tabView(fake.tabs.get(tid)));
        return { id, type, focused, tabs: w.tabIds.map((t) => tabView(fake.tabs.get(t))) };
      },
      async get(id, { populate } = {}) {
        const w = fake.windows.get(Number(id));
        if (!w) throw noWindow(id);
        return { id: w.id, type: w.type, focused: w.focused, ...(populate && { tabs: w.tabIds.map((t) => tabView(fake.tabs.get(t))) }) };
      },
      async getCurrent(opts) { return api.windows.get(fake.currentWindowId, opts); },
      async update(id, info) {
        const w = fake.windows.get(Number(id));
        if (!w) throw noWindow(id);
        if (info.focused) fake.currentWindowId = w.id;
        return { id: w.id };
      },
      async remove(id) {
        const w = fake.windows.get(Number(id));
        if (!w) throw noWindow(id);
        fake.closeWindowNow(w.id);
      },
      onCreated: ev(),
      onRemoved: ev(),
    },

    tabs: {
      async query(q = {}) {
        let list = [...fake.tabs.values()];
        if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        if (q.active != null) list = list.filter((t) => t.active === q.active);
        return list.map(tabView);
      },
      async get(id) {
        const t = fake.tabs.get(id);
        if (!t) throw noTab(id);
        return tabView(t);
      },
      async getCurrent() {
        const t = fake.tabs.get(fake.currentTabId);
        return t ? tabView(t) : undefined;
      },
      async create({ url, windowId = fake.currentWindowId, active = true } = {}) {
        return fake.addTab(windowId, { url, active });
      },
      async update(id, info) {
        const t = fake.tabs.get(id);
        if (!t) throw noTab(id);
        if (info.url) fake.navigate(id, info.url);
        if (info.active) t.active = true;
        return tabView(t);
      },
      async remove(ids) {
        for (const id of [].concat(ids)) fake.removeTab(id);
      },
      onCreated: ev(),
      onUpdated: ev(),
      onRemoved: ev(),
      onMoved: ev(),
      onAttached: ev(),
      onDetached: ev(),
      onReplaced: ev(),
    },

    runtime: {
      getURL: (p = '') => ORIGIN + String(p).replace(/^\//, ''),
      // Routed to the runtime.onMessage listeners, like a message from a page to the background.
      sendMessage(msg) {
        return new Promise((resolve, reject) => {
          let answered = false;
          const sendResponse = (r) => { answered = true; resolve(r); };
          const results = api.runtime.onMessage._call(msg, { id: 'test' }, sendResponse);
          if (!results.some((r) => r === true) && !answered) {
            reject(new Error('Could not establish connection. Receiving end does not exist.'));
          }
        });
      },
      onMessage: ev(),
      onStartup: ev(),
      onInstalled: ev(),
    },

    alarms: {
      async create(name, info) { fake.alarms.set(name, { name, ...info }); },
      async get(name) { return fake.alarms.get(name); },
      async clear(name) { return fake.alarms.delete(name); },
      onAlarm: ev(),
    },

    permissions: {
      async request({ origins = [] } = {}) { fake.permissionRequests.push(origins); return fake.options.grantPermissions; },
      async contains() { return fake.options.grantPermissions; },
    },

    action: {
      async setBadgeText({ text }) { fake.badge = text; },
    },
  };
  fake.api = api;

  // ---------- helpers for tests: user actions ----------

  fake.addTab = (windowId, props = {}) => {
    const w = fake.windows.get(windowId);
    if (!w) throw noWindow(windowId);
    const t = makeTab(windowId, props);
    w.tabIds.splice(props.index ?? w.tabIds.length, 0, t.id);
    api.tabs.onCreated._emit(tabView(t));
    if (t.status === 'complete') api.tabs.onUpdated._emit(t.id, { status: 'complete' }, tabView(t));
    return tabView(t);
  };

  fake.navigate = (tabId, url, title = url) => {
    const t = fake.tabs.get(tabId);
    if (!t) throw noTab(tabId);
    Object.assign(t, { url, title, status: 'complete' });
    delete t.pendingUrl;
    api.tabs.onUpdated._emit(tabId, { url, title, status: 'complete' }, tabView(t));
  };

  // A loading tab (options.loadTabs) finishes loading, possibly at a redirected URL.
  fake.completeTab = (tabId, url) => {
    const t = fake.tabs.get(tabId);
    const finalUrl = url || t.pendingUrl;
    Object.assign(t, { url: finalUrl, title: finalUrl, status: 'complete' });
    delete t.pendingUrl;
    api.tabs.onUpdated._emit(tabId, { status: 'complete' }, tabView(t));
  };

  fake.removeTab = (tabId) => {
    const t = fake.tabs.get(tabId);
    if (!t) throw noTab(tabId);
    const w = fake.windows.get(t.windowId);
    fake.tabs.delete(tabId);
    w.tabIds = w.tabIds.filter((id) => id !== tabId);
    api.tabs.onRemoved._emit(tabId, { windowId: t.windowId, isWindowClosing: false });
    if (!w.tabIds.length) fake.closeWindowNow(w.id);
  };

  fake.moveTab = (tabId, toIndex) => {
    const t = fake.tabs.get(tabId);
    const w = fake.windows.get(t.windowId);
    const fromIndex = w.tabIds.indexOf(tabId);
    w.tabIds.splice(fromIndex, 1);
    w.tabIds.splice(toIndex, 0, tabId);
    api.tabs.onMoved._emit(tabId, { windowId: w.id, fromIndex, toIndex });
  };

  // Moves a tab to another window (detach + attach).
  fake.moveTabToWindow = (tabId, windowId) => {
    const t = fake.tabs.get(tabId);
    const from = fake.windows.get(t.windowId);
    const to = fake.windows.get(windowId);
    from.tabIds = from.tabIds.filter((id) => id !== tabId);
    api.tabs.onDetached._emit(tabId, { oldWindowId: from.id, oldPosition: 0 });
    t.windowId = windowId;
    to.tabIds.push(tabId);
    api.tabs.onAttached._emit(tabId, { newWindowId: to.id, newPosition: to.tabIds.length - 1 });
  };

  // Replaces a tab by another one (prerendering), keeping its place.
  fake.replaceTab = (tabId, url) => {
    const old = fake.tabs.get(tabId);
    const w = fake.windows.get(old.windowId);
    const t = makeTab(old.windowId, { url });
    w.tabIds[w.tabIds.indexOf(tabId)] = t.id;
    fake.tabs.delete(tabId);
    api.tabs.onReplaced._emit(t.id, tabId);
    return t.id;
  };

  // The user closes a window (or windows.remove): its tabs go first, then the window.
  fake.closeWindowNow = (windowId) => {
    const w = fake.windows.get(windowId);
    if (!w) throw noWindow(windowId);
    fake.windows.delete(windowId);
    for (const tid of w.tabIds) {
      fake.tabs.delete(tid);
      api.tabs.onRemoved._emit(tid, { windowId, isWindowClosing: true });
    }
    if (fake.currentWindowId === windowId) fake.currentWindowId = [...fake.windows.keys()].at(-1) ?? null;
    const fire = () => api.windows.onRemoved._emit(windowId);
    if (fake.options.onRemovedDelay) fake._track(new Promise((r) => setTimeout(r, fake.options.onRemovedDelay)).then(fire));
    else fire();
  };

  // The window disappears without windows.onRemoved reaching the extension (browser quit,
  // extension reloaded, an event lost while the worker was asleep).
  fake.vanishWindow = (windowId) => {
    const w = fake.windows.get(windowId);
    fake.windows.delete(windowId);
    for (const tid of w.tabIds) fake.tabs.delete(tid);
  };

  // A plain browser window, not opened by the extension.
  fake.openWindow = (pages = [], { focused = true } = {}) => {
    const id = fake.nextWindowId++;
    const w = { id, type: 'normal', focused, tabIds: [] };
    fake.windows.set(id, w);
    for (const p of pages) w.tabIds.push(makeTab(id, typeof p === 'string' ? { url: p } : p).id);
    if (focused) fake.currentWindowId = id;
    return id;
  };

  fake.windowUrls = (windowId) => fake.windows.get(windowId)?.tabIds.map((t) => fake.tabs.get(t).url || fake.tabs.get(t).pendingUrl);
  fake.fireAlarm = (name) => api.alarms.onAlarm._emit({ name });
  fake.windowIds = () => [...fake.windows.keys()];
  fake.findWindow = (pred) => [...fake.windows.values()].find((w) => pred(fake.windowUrls(w.id), w));
  fake.promptWindows = () => [...fake.windows.values()].filter((w) => fake.windowUrls(w.id).some((u) => u.startsWith(`${ORIGIN}prompt.html`)));

  // Waits for every event and listener started so far, including those they start in turn.
  fake.flush = async () => {
    for (let i = 0; i < 1000; i++) {
      await new Promise((r) => setImmediate(r));
      if (!fake.pendingWork.size) {
        await new Promise((r) => setImmediate(r));
        if (!fake.pendingWork.size) return;
      }
      await Promise.all([...fake.pendingWork]);
    }
    throw new Error('flush(): work never settled');
  };

  // Empties storage, windows and tabs. Listeners stay unless `listeners: true` (the background
  // registers its listeners once, when imported).
  fake.reset = ({ listeners = false } = {}) => {
    Object.assign(fake.options, { onRemovedDelay: 0, popupWindows: true, failWindowCreate: false, loadTabs: false, grantPermissions: true });
    fake.alarms.clear();
    fake.permissionRequests = [];
    fake.store = {};
    fake.windows.clear();
    fake.tabs.clear();
    fake.nextWindowId = 1;
    fake.nextTabId = 1;
    fake.currentWindowId = null;
    fake.currentTabId = null;
    fake.badge = null;
    fake.errors = [];
    if (listeners) {
      const clearAll = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') (v._clear ? v._clear() : clearAll(v)); };
      clearAll(api);
    }
  };

  return fake;
}

// The shared instance, installed as the browser API before any source module is imported.
export const fake = createFakeBrowser();
globalThis.chrome = fake.api;
