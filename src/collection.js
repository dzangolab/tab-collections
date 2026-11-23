import {
  api, getCollection, putCollection, removeCollection, makeCollection, normalizeUrl, faviconUrl, faviconImg, buildExport, downloadJson,
  slug, el, icon, send, plural, closedDrift, collectionDrift,
} from './common.js';

const params = new URLSearchParams(location.search);
let id = params.get('id');
// No id: a new collection, stored only by its first save (which needs a page), so leaving the page
// without saving leaves nothing behind.
let isNew = !id;
const $ = (s) => document.getElementById(s);
const nameIn = $('name');
const descIn = $('description');
const pagesBody = $('pages');

let saved = null; // last saved version
let draft = null; // what the user is editing
let dirty = false;
let editing = false; // the name/description form is showing
let dragFrom = null; // index of the page being dragged

$('back').prepend(icon('back'));
$('editToggle').append(icon('edit'));
$('exportOne').append(icon('export'));
$('delete').append(icon('delete'));

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

function isValidUrl(u) {
  try { new URL(u); return true; } catch { return false; }
}

function setDirty(v) {
  dirty = v;
  document.body.classList.toggle('dirty', v);
  // A new collection keeps its Save button showing: nothing is stored until it is used.
  $('savebar').hidden = !v && !isNew;
  $('status').textContent = isNew ? 'Not saved yet' : 'Unsaved changes';
  $('revert').hidden = isNew;
  $('cancel').hidden = !isNew;
  if (!v) $('external').hidden = true;
}

// The page title and the description under it follow the draft.
function renderHead() {
  $('title').textContent = draft.name.trim() || 'Untitled collection';
  $('descText').textContent = draft.description;
  $('descText').hidden = editing || !draft.description.trim();
}

function setEditing(v) {
  editing = v;
  $('details').hidden = !v;
  $('editToggle').setAttribute('aria-pressed', String(v));
  renderHead();
}

// dd mmm yyyy hh:mm
function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())} ${d.toLocaleString('en', { month: 'short' })} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The drift strip, when this collection's window has changed.
async function renderDrift() {
  const [closed, live] = await Promise.all([closedDrift(), send({ type: 'driftStatus' }).catch(() => ({}))]);
  const strip = collectionDrift(id, closed, live, toast);
  $('drift').replaceChildren(...(strip ? [strip] : []));
}

function renderDates() {
  if (!saved) { $('dates').textContent = 'Not saved yet'; return; }
  const parts = [];
  if (saved.createdAt) parts.push(`Created at: ${formatDate(saved.createdAt)}`);
  if (saved.updatedAt) parts.push(`Last updated at: ${formatDate(saved.updatedAt)}`);
  $('dates').textContent = parts.join(' · ');
}

async function load() {
  saved = isNew ? null : await getCollection(id);
  if (!isNew && !saved) {
    $('editor').hidden = true;
    $('notFound').hidden = false;
    document.querySelectorAll('.toolbar button').forEach((b) => (b.disabled = true));
    return false;
  }
  draft = saved ? structuredClone(saved) : makeCollection({ name: 'New collection' });
  id = draft.id;
  $('editor').hidden = false;
  $('notFound').hidden = true;
  // Opening, exporting or deleting need a stored collection.
  for (const b of ['open', 'exportOne', 'delete']) $(b).hidden = isNew;
  nameIn.value = draft.name;
  descIn.value = draft.description;
  document.title = isNew ? 'New collection' : `${draft.name} — Collection`;
  renderHead();
  renderDates();
  if (saved) renderDrift();
  renderPages();
  setDirty(false);
  return true;
}

function renderPages() {
  const n = draft.pages.length;
  $('count').textContent = plural(n, 'web page');
  $('noPages').hidden = n > 0;
  // A collection always has at least one page.
  $('save').disabled = !n;
  $('save').title = n ? '' : 'Add a page first: a collection needs at least one';
  pagesBody.replaceChildren(
    ...draft.pages.map((p, i) => {
      const fav = faviconImg(p.url);
      if (isValidUrl(p.url)) fav.src = faviconUrl(p.url, 32);
      const urlIn = el('input', {
        type: 'text', value: p.url, 'aria-label': 'Page URL',
        class: isValidUrl(p.url) ? 'url-in' : 'url-in invalid',
        oninput: (e) => {
          p.url = e.target.value;
          e.target.classList.toggle('invalid', !isValidUrl(normalizeUrl(p.url)));
          setDirty(true);
        },
        onchange: (e) => {
          p.url = normalizeUrl(e.target.value);
          e.target.value = p.url;
          if (isValidUrl(p.url)) fav.src = faviconUrl(p.url, 32);
        },
      });
      const card = el('div', {
        class: 'page-card',
        ondragstart: (e) => {
          dragFrom = i;
          card.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
        },
        ondragend: () => {
          card.draggable = false;
          card.classList.remove('dragging');
          clearDropMarks();
          dragFrom = null;
        },
        ondragover: (e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          clearDropMarks();
          card.classList.add(dropsAfter(card, e) ? 'drop-after' : 'drop-before');
        },
        ondrop: (e) => {
          e.preventDefault();
          if (dragFrom === null) return;
          let to = i + (dropsAfter(card, e) ? 1 : 0);
          if (dragFrom < to) to -= 1;
          reorder(dragFrom, to);
        },
      },
      // The card is only draggable while the handle is held, so text in its fields stays selectable.
      el('button', {
        type: 'button',
        class: 'drag-handle',
        title: 'Drag to reorder',
        'aria-label': `Reorder “${p.title || p.url}”: drag it, or use the up and down arrow keys`,
        onmousedown: () => { card.draggable = true; },
        onmouseup: () => { card.draggable = false; },
        onkeydown: (e) => {
          const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
          if (!d || i + d < 0 || i + d >= n) return;
          e.preventDefault();
          reorder(i, i + d);
          pagesBody.children[i + d]?.querySelector('.drag-handle')?.focus();
        },
      }, icon('drag')),
      el('span', { class: 'fav-tile' }, fav),
      el('div', { class: 'page-fields' },
        el('input', {
          type: 'text', class: 'title-in', value: p.title, placeholder: 'Untitled', 'aria-label': 'Page title',
          oninput: (e) => { p.title = e.target.value; setDirty(true); },
        }),
        urlIn),
      el('button', {
        class: 'icon-btn ghost', title: 'Open in a new tab', 'aria-label': 'Open in a new tab',
        onclick: () => isValidUrl(p.url) && api.tabs.create({ url: p.url }),
      }, icon('external')),
      el('button', {
        class: 'icon-btn ghost', title: 'Remove page', 'aria-label': 'Remove page',
        onclick: () => { draft.pages.splice(i, 1); renderPages(); setDirty(true); },
      }, icon('delete')),
      );
      return card;
    }),
  );
}

const dropsAfter = (card, e) => {
  const r = card.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};

function clearDropMarks() {
  pagesBody.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
}

function reorder(from, to) {
  if (from === to) return;
  const [p] = draft.pages.splice(from, 1);
  draft.pages.splice(to, 0, p);
  renderPages();
  setDirty(true);
}

nameIn.addEventListener('input', () => { draft.name = nameIn.value; renderHead(); setDirty(true); });
descIn.addEventListener('input', () => { draft.description = descIn.value; renderHead(); setDirty(true); });
$('editToggle').addEventListener('click', () => {
  setEditing(!editing);
  if (editing) nameIn.focus();
});

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = normalizeUrl($('addUrl').value);
  if (!isValidUrl(url)) return toast('That doesn’t look like a valid URL');
  draft.pages.push({ url, title: $('addTitle').value.trim() });
  $('addUrl').value = '';
  $('addTitle').value = '';
  renderPages();
  setDirty(true);
  $('addUrl').focus();
});

async function save() {
  const pages = draft.pages.map((p) => ({ url: normalizeUrl(p.url), title: p.title.trim() })).filter((p) => p.url);
  if (!pages.length) return toast('Add a page first: a collection needs at least one'), false;
  draft.pages = pages;
  const bad = draft.pages.find((p) => !isValidUrl(p.url));
  if (bad) return toast(`Invalid URL: ${bad.url}`), false;
  draft.name = draft.name.trim() || 'Untitled collection';
  // Not dirty before the write, so the storage change it causes reloads the page.
  setDirty(false);
  try {
    await putCollection(draft);
  } catch (e) {
    setDirty(true);
    return toast(e.message), false;
  }
  if (isNew) {
    // Stored now: from here on, this is the page of an existing collection.
    isNew = false;
    history.replaceState(null, '', `collection.html?id=${encodeURIComponent(id)}`);
    await load();
    toast('Collection created');
    return true;
  }
  toast('Saved');
  return true;
}

$('save').addEventListener('click', save);
$('revert').addEventListener('click', load);
// Leaves a new collection without creating it, asking first when something was entered.
$('cancel').addEventListener('click', () => {
  if (dirty && !confirm('Discard this new collection?')) return;
  setDirty(false);
  location.href = 'collections.html';
});
$('reload').addEventListener('click', (e) => { e.preventDefault(); load(); });

$('open').addEventListener('click', async () => {
  if (dirty) {
    if (!confirm('Save your changes before opening?')) return;
    if (!(await save())) return;
  }
  try { await send({ type: 'open', id }); } catch (e) { toast(e.message); }
});

$('delete').addEventListener('click', async () => {
  if (!confirm(`Delete the collection “${saved.name}”? This cannot be undone.`)) return;
  setDirty(false);
  await removeCollection(id);
  location.href = 'collections.html';
});

$('exportOne').addEventListener('click', () => {
  // With unsaved changes, the saved version, named after itself.
  const col = dirty ? saved : draft;
  downloadJson(`${slug(col.name)}.collection.json`, buildExport([col]));
  if (dirty) toast('Exported the last saved version');
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty) save(); }
});
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

api.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (saved && (changes.pending || changes.sessions)) renderDrift();
  // A new collection isn't stored yet: its absence from storage doesn't mean it was deleted.
  if (!changes.collections || isNew) return;
  const fresh = changes.collections.newValue?.[id];
  if (!fresh) { if (!dirty) load(); return; }
  if (saved && JSON.stringify(fresh) === JSON.stringify(saved)) return;
  if (dirty) $('external').hidden = false;
  else load();
});

load().then((found) => {
  if (found && params.get('new')) { setEditing(true); nameIn.select(); nameIn.focus(); }
});
