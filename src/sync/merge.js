// Three-way merge of collections, as in git (ADR 0001, "Merge"). Pure: no storage, no network.
//
// A snapshot is { collections: { [id]: collection }, tombstones: { [id]: deletedAt } }. The base
// is the snapshot this device last synced; local is this device's; remote is the sync file's.
//
// - Changed on one side only: that side's version is taken.
// - Changed on both sides, in different parts: both changes are kept.
// - Pages merge one by one, matched by URL: an addition on either side is kept, a removal on
//   either side is removed.
// - Changed on both sides in the same part (name, description, or the same page's title): a
//   conflict. The shared result keeps the remote version, this device keeps its own, and the user
//   decides later (Keep mine / Keep theirs / Keep both).
// - Deleted on one side and edited on the other: the edit wins, so no edit is lost.

export const emptySnapshot = () => ({ collections: {}, tombstones: {} });

// What a collection holds, without its timestamps.
function content(c) {
  return {
    name: c.name,
    description: c.description || '',
    pages: (c.pages || []).map((p) => ({ url: p.url, title: p.title || '' })),
  };
}

export function sameCollection(a, b) {
  if (!a || !b) return a === b;
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}

// Pages keyed by URL and occurrence, so a URL listed twice is two pages.
function keyed(pages) {
  const seen = new Map();
  return (pages || []).map((p) => {
    const n = seen.get(p.url) || 0;
    seen.set(p.url, n + 1);
    return { key: `${n} ${p.url}`, page: { url: p.url, title: p.title || '' } };
  });
}

// Whether `side` lists the pages it shares with `base` in a different order.
function reordered(baseKeys, sideKeys) {
  const inBase = new Set(baseKeys);
  const inSide = new Set(sideKeys);
  const a = baseKeys.filter((k) => inSide.has(k));
  const b = sideKeys.filter((k) => inBase.has(k));
  return a.some((k, i) => k !== b[i]);
}

// Returns { pages, conflict }.
export function mergePages(base, local, remote) {
  const B = keyed(base); const L = keyed(local); const R = keyed(remote);
  const bm = new Map(B.map((x) => [x.key, x.page]));
  const lm = new Map(L.map((x) => [x.key, x.page]));
  const rm = new Map(R.map((x) => [x.key, x.page]));
  let conflict = false;

  const kept = new Map(); // key → page
  for (const key of new Set([...lm.keys(), ...rm.keys()])) {
    const b = bm.get(key); const l = lm.get(key); const r = rm.get(key);
    if (b ? !(l && r) : !(l || r)) continue; // removed on either side, or never there
    let title;
    if (!l || !r) title = (l || r).title;
    else if (l.title === r.title) title = l.title;
    else if (!b) title = l.title; // added on both sides with different titles: keep ours
    else if (l.title === b.title) title = r.title;
    else if (r.title === b.title) title = l.title;
    else { conflict = true; title = l.title; }
    kept.set(key, { url: (l || r).url, title });
  }

  // Order: the side that reordered its pages wins (ours if both did), and the other side's
  // additions go in after the page they followed there.
  const bKeys = B.map((x) => x.key); const lKeys = L.map((x) => x.key); const rKeys = R.map((x) => x.key);
  const useRemote = reordered(bKeys, rKeys) && !reordered(bKeys, lKeys);
  const [main, other] = useRemote ? [rKeys, lKeys] : [lKeys, rKeys];
  const order = main.filter((k) => kept.has(k));
  other.forEach((k, i) => {
    if (!kept.has(k) || order.includes(k)) return;
    // After the page it followed; else before the page it preceded; else at the end.
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      const pos = order.indexOf(other[j]);
      if (pos >= 0) at = pos + 1;
    }
    for (let j = i + 1; j < other.length && at < 0; j++) {
      const pos = order.indexOf(other[j]);
      if (pos >= 0) at = pos;
    }
    order.splice(at < 0 ? order.length : at, 0, k);
  });
  return { pages: order.map((k) => kept.get(k)), conflict };
}

// Returns { col, conflict } for a collection present on both sides. `base` may be null (added on
// both sides with the same id, e.g. the same file imported on two devices).
export function mergeCollection(base, local, remote) {
  if (sameCollection(local, remote)) {
    return { col: { ...local, updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0) }, conflict: false };
  }
  const b = base ? content(base) : { name: undefined, description: undefined, pages: [] };
  const l = content(local); const r = content(remote);
  let conflict = false;
  const out = {};
  for (const f of ['name', 'description']) {
    if (l[f] === r[f] || r[f] === b[f]) out[f] = l[f];
    else if (l[f] === b[f]) out[f] = r[f];
    else { conflict = true; out[f] = l[f]; }
  }
  const pages = mergePages(b.pages, l.pages, r.pages);
  // A collection needs at least one page: removing every page on the two sides is a conflict too.
  if (pages.conflict || !pages.pages.length) conflict = true;
  return {
    col: {
      ...local,
      ...out,
      pages: pages.pages,
      createdAt: Math.min(...[local.createdAt, remote.createdAt].filter(Boolean)) || local.createdAt,
      updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    },
    conflict,
  };
}

// Merges the three snapshots. `pinned`: ids with an unresolved conflict, which stay as they are
// remotely and locally until the user decides.
// Returns {
//   shared: the snapshot to write to the sync file, which becomes the new base;
//   local: what this device's storage should hold (shared, except conflicts keep this device's version);
//   conflicts: { [id]: { theirs: collection | null } } (null: deleted on the other side).
// }
export function merge(base, local, remote, { pinned = [] } = {}) {
  const shared = emptySnapshot();
  const mine = emptySnapshot();
  const conflicts = {};
  const pin = new Set(pinned);
  const ids = new Set([
    ...Object.keys(base.collections), ...Object.keys(base.tombstones),
    ...Object.keys(local.collections), ...Object.keys(local.tombstones),
    ...Object.keys(remote.collections), ...Object.keys(remote.tombstones),
  ]);

  const set = (snap, id, col, deletedAt) => {
    if (col) snap.collections[id] = col;
    else if (deletedAt) snap.tombstones[id] = deletedAt;
  };

  for (const id of ids) {
    const bc = base.collections[id];
    const lc = local.collections[id]; const lt = local.tombstones[id];
    const rc = remote.collections[id]; const rt = remote.tombstones[id];
    const deletedAt = Math.max(lt || 0, rt || 0, base.tombstones[id] || 0) || null;

    if (pin.has(id)) {
      set(shared, id, rc, rt || deletedAt);
      set(mine, id, lc, lt || deletedAt);
      conflicts[id] = { theirs: rc || null };
      continue;
    }

    let result = null;
    if (lc && rc) {
      const m = mergeCollection(bc || null, lc, rc);
      if (m.conflict) {
        set(shared, id, rc);
        set(mine, id, lc);
        conflicts[id] = { theirs: rc };
        continue;
      }
      result = m.col;
    } else if (lc) {
      // Deleted remotely: deleted here too, unless edited here since the last sync.
      result = rt && bc && sameCollection(lc, bc) ? null : lc;
    } else if (rc) {
      result = lt && bc && sameCollection(rc, bc) ? null : rc;
    }
    set(shared, id, result, deletedAt);
    set(mine, id, result, deletedAt);
  }
  return { shared, local: mine, conflicts };
}
