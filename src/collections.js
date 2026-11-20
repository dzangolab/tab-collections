import {
  api, getCollections, saveCollections, putCollection, removeCollection, makeCollection, getAll, getPending,
  buildExport, parseImport, downloadJson, el, send, plural, openReview,
} from './common.js';

const rows = document.getElementById('rows');
const empty = document.getElementById('empty');
const filter = document.getElementById('filter');
const pendingBox = document.getElementById('pending');
const toastEl = document.getElementById('toast');

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

async function render() {
  const [cols, sessions, pending] = await Promise.all([getCollections(), getAll('sessions', {}), getPending()]);
  const openIds = new Set(Object.values(sessions).map((s) => s.collectionId));
  const q = filter.value.trim().toLowerCase();
  const all = Object.values(cols).sort((a, b) => a.name.localeCompare(b.name));
  const list = q ? all.filter((c) => (c.name + ' ' + c.description).toLowerCase().includes(q)) : all;

  rows.replaceChildren(
    ...list.map((c) =>
      el('tr', { class: 'clickable', onclick: () => (location.href = `collection.html?id=${encodeURIComponent(c.id)}`) },
        el('td', { class: 'name' }, c.name, openIds.has(c.id) && el('span', { class: 'pill' }, 'Open')),
        el('td', { class: 'desc', title: c.description }, c.description || '—'),
        el('td', { class: 'num' }, c.pages.length),
        el('td', { class: 'actions' },
          el('button', {
            class: 'primary',
            onclick: async (e) => {
              e.stopPropagation();
              try { await send({ type: 'open', id: c.id }); } catch (err) { toast(err.message); }
            },
          }, openIds.has(c.id) ? 'Show' : 'Open'),
          el('button', {
            class: 'danger',
            onclick: async (e) => {
              e.stopPropagation();
              if (confirm(`Delete the collection “${c.name}”? This cannot be undone.`)) {
                await removeCollection(c.id);
                toast('Collection deleted');
              }
            },
          }, 'Delete'),
        ),
      ),
    ),
  );
  empty.hidden = all.length > 0;
  if (all.length && !list.length) {
    rows.append(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No collections match the filter.')));
  }

  const pend = Object.values(pending).filter((p) => cols[p.collectionId]);
  pendingBox.replaceChildren(
    pend.length
      ? el('div', { class: 'banner' },
          el('strong', {}, `${plural(pend.length, 'closed window')} with changed tabs to review`),
          el('ul', {},
            ...pend.map((p) =>
              el('li', {},
                `“${cols[p.collectionId].name}” — closed ${new Date(p.closedAt).toLocaleString()} `,
                el('a', { href: '#', onclick: (e) => { e.preventDefault(); openReview(p.id); } }, 'Review'),
              ),
            ),
          ),
        )
      : '',
  );
}

document.getElementById('new').addEventListener('click', async () => {
  const col = await putCollection(makeCollection({ name: 'New collection' }));
  location.href = `collection.html?id=${encodeURIComponent(col.id)}&new=1`;
});

document.getElementById('export').addEventListener('click', async () => {
  const cols = Object.values(await getCollections());
  if (!cols.length) return toast('Nothing to export yet');
  const date = new Date().toISOString().slice(0, 10);
  downloadJson(`tab-collections-${date}.json`, buildExport(cols));
});

const fileInput = document.getElementById('importFile');
document.getElementById('import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const incoming = parseImport(await file.text());
    const existing = await getCollections();
    const overwrite = incoming.filter((c) => existing[c.id]);
    const msg =
      `Import ${plural(incoming.length, 'collection')} from “${file.name}”?` +
      (overwrite.length
        ? `\n\n${plural(overwrite.length, 'collection')} already exist and will be replaced:\n` +
          overwrite.map((c) => `• ${existing[c.id].name}`).join('\n')
        : '');
    if (!confirm(msg)) return;
    for (const c of incoming) existing[c.id] = c;
    await saveCollections(existing);
    toast(`Imported ${plural(incoming.length, 'collection')}`);
  } catch (e) {
    alert(`Import failed: ${e.message}`);
  }
});

filter.addEventListener('input', render);
api.storage.onChanged.addListener((changes, area) => { if (area === 'local') render(); });
render();
