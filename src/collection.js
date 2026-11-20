import {
  api, getCollection, putCollection, removeCollection, normalizeUrl, faviconUrl, faviconImg, buildExport, downloadJson,
  slug, el, send, plural,
} from './common.js';

const params = new URLSearchParams(location.search);
const id = params.get('id');
const $ = (s) => document.getElementById(s);
const nameIn = $('name');
const descIn = $('description');
const pagesBody = $('pages');

let saved = null; // last saved version
let draft = null; // what the user is editing
let dirty = false;

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
  $('save').disabled = !v;
  $('revert').disabled = !v;
  $('status').textContent = v ? 'Unsaved changes' : 'All changes saved';
  if (!v) $('external').hidden = true;
}

async function load() {
  saved = await getCollection(id);
  if (!saved) {
    $('editor').hidden = true;
    $('notFound').hidden = false;
    document.querySelectorAll('.topbar button').forEach((b) => (b.disabled = true));
    return;
  }
  draft = structuredClone(saved);
  $('editor').hidden = false;
  nameIn.value = draft.name;
  descIn.value = draft.description;
  document.title = `${draft.name} — Collection`;
  renderPages();
  setDirty(false);
  if (params.get('new')) { nameIn.select(); nameIn.focus(); }
}

function renderPages() {
  const n = draft.pages.length;
  $('count').textContent = `(${plural(n, 'page')})`;
  $('noPages').hidden = n > 0;
  pagesBody.replaceChildren(
    ...draft.pages.map((p, i) => {
      const fav = faviconImg(p.url);
      const urlIn = el('input', {
        type: 'text', value: p.url,
        class: isValidUrl(p.url) ? '' : 'invalid',
        oninput: (e) => {
          p.url = e.target.value;
          e.target.classList.toggle('invalid', !isValidUrl(normalizeUrl(p.url)));
          setDirty(true);
        },
        onchange: (e) => {
          p.url = normalizeUrl(e.target.value);
          e.target.value = p.url;
          if (isValidUrl(p.url)) fav.src = faviconUrl(p.url);
        },
      });
      return el('tr', {},
        el('td', { class: 'idx' }, i + 1),
        el('td', { class: 'fav' }, fav),
        el('td', { class: 'title' },
          el('input', { type: 'text', value: p.title, placeholder: 'Untitled', oninput: (e) => { p.title = e.target.value; setDirty(true); } })),
        el('td', {}, urlIn),
        el('td', { class: 'actions' },
          el('button', { class: 'icon', title: 'Open in a new tab', onclick: () => isValidUrl(p.url) && api.tabs.create({ url: p.url }) }, '↗'),
          el('button', { class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          el('button', { class: 'icon', title: 'Move down', disabled: i === n - 1, onclick: () => move(i, 1) }, '↓'),
          el('button', { class: 'icon danger', title: 'Remove', onclick: () => { draft.pages.splice(i, 1); renderPages(); setDirty(true); } }, '✕'),
        ),
      );
    }),
  );
}

function move(i, d) {
  const [p] = draft.pages.splice(i, 1);
  draft.pages.splice(i + d, 0, p);
  renderPages();
  setDirty(true);
}

nameIn.addEventListener('input', () => { draft.name = nameIn.value; setDirty(true); });
descIn.addEventListener('input', () => { draft.description = descIn.value; setDirty(true); });

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
  draft.pages = draft.pages.map((p) => ({ url: normalizeUrl(p.url), title: p.title.trim() })).filter((p) => p.url);
  const bad = draft.pages.find((p) => !isValidUrl(p.url));
  if (bad) return toast(`Invalid URL: ${bad.url}`), false;
  draft.name = draft.name.trim() || 'Untitled collection';
  setDirty(false);
  await putCollection(draft);
  toast('Saved');
  return true;
}

$('save').addEventListener('click', save);
$('revert').addEventListener('click', load);
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
  downloadJson(`${slug(draft.name)}.collection.json`, buildExport([dirty ? saved : draft]));
  if (dirty) toast('Exported the last saved version');
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty) save(); }
});
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

api.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.collections) return;
  const fresh = changes.collections.newValue?.[id];
  if (!fresh) { if (!dirty) load(); return; }
  if (saved && JSON.stringify(fresh) === JSON.stringify(saved)) return;
  if (dirty) $('external').hidden = false;
  else load();
});

load();
