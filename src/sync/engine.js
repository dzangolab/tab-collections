// Sync engine (ADR 0001, "When it syncs"), run by the background script.
//
// storage.local:
//   syncConfig: { backend, server, repo, branch, path, url, username, token, passphrase, mode: 'auto' | 'manual' }
//               this device's settings and credentials; never synced. `passphrase` set: encrypted.
//   syncState:  { base, version, synced, conflicts, lastSyncAt, lastError, remoteChanged }
//     base:      the snapshot in the sync file as of the last sync (the merge base)
//     version:   the sync file's version then (sha, commit id or ETag)
//     synced:    what the last sync left in local storage; local data that differs has unsynced changes
//     conflicts: { [id]: { theirs } } collections changed on both sides, waiting for the user
//
// Automatic mode pushes local changes a few seconds after the edit, and merges remote changes at
// every check. Manual mode leaves local changes on the device until Sync is clicked, and only
// announces remote changes. Checks: at browser start, every few minutes, and on Sync.

import { api, getAll, getCollections, newId, saveCollections } from '../common.js';
import { BACKENDS, ConflictError, makeBackend } from './backends.js';
import { readSyncFile, writeSyncFile } from './file.js';
import { emptySnapshot, merge } from './merge.js';

export const CHECK_ALARM = 'sync-check';
export const CHECK_PERIOD_MINUTES = 5;
export const PUSH_DELAY_MS = 5_000; // edits within this time go in one sync (one commit)
const MAX_ATTEMPTS = 5;

const STORE = api.storage.local;
export const getSyncConfig = () => getAll('syncConfig', null);
const getState = () => getAll('syncState', null);
const saveState = async (state) => { await STORE.set({ syncState: state }); await updateBadge(state); };

async function readLocal() {
  return { collections: await getCollections(), tombstones: await getAll('tombstones', {}) };
}

// Snapshots compared regardless of key order.
function canonical(snap) {
  const sorted = (o) => Object.keys(o || {}).sort().map((k) => [k, o[k]]);
  return JSON.stringify([sorted(snap?.collections), sorted(snap?.tombstones)]);
}
const sameSnapshot = (a, b) => canonical(a) === canonical(b);

// ---------- Running a sync ----------

let queue = Promise.resolve();
// One sync at a time; a request made during a sync runs after it.
function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function syncOnce({ checkOnly = false } = {}) {
  const cfg = await getSyncConfig();
  if (!cfg) return null;
  const backend = makeBackend(cfg);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = (await getState()) || {};
    const { text, version } = await backend.read();

    if (checkOnly) {
      const changed = version !== (state.version ?? null);
      if (changed !== !!state.remoteChanged) await saveState({ ...state, remoteChanged: changed });
      return getState();
    }

    const { snapshot: remote, salt } = await readSyncFile(text, cfg.passphrase);
    const local = await readLocal();
    const m = merge(state.base || emptySnapshot(), local, remote, { pinned: Object.keys(state.conflicts || {}) });

    if (!sameSnapshot(m.local, local)) {
      if (!sameSnapshot(await readLocal(), local)) continue; // edited meanwhile: merge again
      await STORE.set({ collections: m.local.collections, tombstones: m.local.tombstones });
    }

    let newVersion = version;
    const empty = !Object.keys(m.shared.collections).length && !Object.keys(m.shared.tombstones).length;
    if (text == null ? !empty : !sameSnapshot(m.shared, remote)) {
      try {
        newVersion = await backend.write(await writeSyncFile(m.shared, cfg.passphrase, salt), version);
      } catch (e) {
        if (e instanceof ConflictError) continue; // another device wrote first: re-read, merge again
        throw e;
      }
    }

    await saveState({
      base: m.shared,
      version: newVersion,
      synced: m.local,
      conflicts: m.conflicts,
      lastSyncAt: Date.now(),
      lastError: null,
      remoteChanged: false,
    });
    return getState();
  }
  throw new Error('The sync file kept changing during the sync. Try again.');
}

// Syncs now (or only checks for remote changes), recording any error in the sync state.
export function syncNow(opts) {
  clearTimeout(pushTimer);
  return serialized(async () => {
    try {
      return await syncOnce(opts);
    } catch (e) {
      const state = await getState();
      if (state && (await getSyncConfig())) await saveState({ ...state, lastError: String(e?.message || e), lastErrorAt: Date.now() });
      throw e;
    }
  });
}

// A check from an alarm or browser start: a full sync in Automatic mode, an announcement in Manual.
export async function scheduledCheck() {
  const cfg = await getSyncConfig();
  if (!cfg) return;
  await syncNow({ checkOnly: cfg.mode === 'manual' }).catch((e) => console.warn('[sync]', e));
}

// ---------- Local changes ----------

let pushTimer = null;

export async function hasUnsyncedChanges() {
  const state = await getState();
  return !!state && !sameSnapshot(await readLocal(), state.synced || emptySnapshot());
}

// Called when the collections change in storage. The sync's own writes leave nothing unsynced,
// so they don't start another sync.
export async function onLocalChange() {
  const cfg = await getSyncConfig();
  if (!cfg || cfg.mode === 'manual' || !(await hasUnsyncedChanges())) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { syncNow().catch((e) => console.warn('[sync]', e)); }, PUSH_DELAY_MS);
}

// ---------- Setup ----------

const FIELDS = {
  github: ['server', 'repo', 'branch', 'path', 'token'],
  gitlab: ['server', 'repo', 'branch', 'path', 'token'],
  gitea: ['server', 'repo', 'branch', 'path', 'token'],
  webdav: ['url', 'username', 'token'],
};

// The setup form's repository value until the user puts their own user or organisation in.
export const OWNER = '<owner>';
export const REPO_TEMPLATE = `${OWNER}/tab-collections`;

export function normalizeConfig(input) {
  const backend = input?.backend;
  if (!FIELDS[backend]) throw new Error('Choose where to sync.');
  const cfg = { backend, mode: input.mode === 'manual' ? 'manual' : 'auto', passphrase: input.passphrase || '' };
  for (const f of FIELDS[backend]) cfg[f] = String(input[f] ?? '').trim();
  if (backend !== 'webdav') {
    cfg.server = cfg.server.replace(/\/+$/, '') || BACKENDS[backend].defaultServer;
    cfg.branch ||= 'main';
    cfg.path = cfg.path.replace(/^\/+/, '') || 'tab-collections.json';
    if (cfg.repo.includes(OWNER)) throw new Error(`Replace ${OWNER} with your user or organisation name.`);
    if (!/^[^/\s]+(\/[^/\s]+)+$/.test(cfg.repo)) throw new Error('Enter the repository as owner/name.');
  }
  const address = backend === 'webdav' ? cfg.url : cfg.server;
  let parsed;
  try { parsed = new URL(address); } catch { throw new Error('Enter the server address, starting with https://'); }
  if (parsed.protocol !== 'https:') throw new Error('The server address must start with https://');
  if (!cfg.token) throw new Error(backend === 'webdav' ? 'Enter the password.' : 'Enter the access token.');
  return cfg;
}

// Checks the settings, reads the sync file with them (so a wrong passphrase is caught here), then
// saves them and runs the first sync: the collections on both sides are united.
export async function setupSync(input) {
  const cfg = normalizeConfig(input);
  const backend = makeBackend(cfg);
  await backend.check();
  const { text } = await backend.read();
  await readSyncFile(text, cfg.passphrase);
  await STORE.set({ syncConfig: cfg, syncState: { base: emptySnapshot(), version: null, synced: emptySnapshot(), conflicts: {} } });
  await ensureAlarm();
  return syncNow();
}

export async function setSyncMode(mode) {
  const cfg = await getSyncConfig();
  if (!cfg) throw new Error('Sync isn’t set up');
  await STORE.set({ syncConfig: { ...cfg, mode: mode === 'manual' ? 'manual' : 'auto' } });
  if (mode !== 'manual') await onLocalChange();
}

// Stops syncing on this device. Its collections stay; the sync file isn't touched.
export async function disconnectSync() {
  clearTimeout(pushTimer);
  await STORE.set({ syncConfig: null, syncState: null });
  await api.alarms?.clear(CHECK_ALARM);
  await updateBadge(null);
}

export async function ensureAlarm() {
  if (!api.alarms || !(await getSyncConfig())) return;
  if (!(await api.alarms.get(CHECK_ALARM))) api.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
}

// ---------- Conflicts ----------

// `choice`: 'mine' keeps this device's version (synced next), 'theirs' takes the other device's,
// 'both' keeps theirs and saves this device's as a copy.
export async function resolveConflict(id, choice) {
  const state = await getState();
  const conflict = state?.conflicts?.[id];
  if (!conflict) return;
  const all = await getCollections();
  const mine = all[id];
  if (choice === 'theirs' || choice === 'both') {
    if (choice === 'both' && mine) {
      const copyId = newId();
      all[copyId] = { ...mine, id: copyId, name: `${mine.name} (copy)`, updatedAt: Date.now() };
    }
    if (conflict.theirs) all[id] = conflict.theirs;
    else delete all[id];
  } else if (choice !== 'mine') {
    throw new Error(`Unknown choice: ${choice}`);
  }
  const conflicts = { ...state.conflicts };
  delete conflicts[id];
  await saveState({ ...state, conflicts });
  await saveCollections(all);
  // Keep mine changes nothing locally, but the collection now differs from the sync file.
  await onLocalChange();
}

// ---------- Status ----------

export async function syncStatus() {
  const cfg = await getSyncConfig();
  if (!cfg) return { configured: false };
  const state = (await getState()) || {};
  return {
    configured: true,
    backend: cfg.backend,
    label: BACKENDS[cfg.backend]?.label || cfg.backend,
    where: cfg.backend === 'webdav' ? cfg.url : `${cfg.server.replace(/^https:\/\//, '')}/${cfg.repo} · ${cfg.path}`,
    encrypted: !!cfg.passphrase,
    mode: cfg.mode,
    lastSyncAt: state.lastSyncAt || null,
    lastError: state.lastError || null,
    remoteChanged: !!state.remoteChanged,
    unsynced: await hasUnsyncedChanges(),
    conflicts: state.conflicts || {},
  };
}

export async function refreshBadge() { await updateBadge(await getState()); }

// A dot on the toolbar icon when the sync file has changes to pull (Manual mode), or a conflict
// waits for the user.
async function updateBadge(state) {
  const show = !!state && (state.remoteChanged || Object.keys(state.conflicts || {}).length > 0);
  try { await api.action.setBadgeText({ text: show ? '•' : '' }); } catch { /* no badge support */ }
}
