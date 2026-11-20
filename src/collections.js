import {
  api, getCollections, saveCollections, getVivaldiWorkspaces, workspaceCreated, suggestName, putCollection, removeCollection, makeCollection, getAll, getPending,
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

// ---------- Vivaldi workspaces → collections ----------
const wsDialog = document.getElementById('wsDialog');
const wsList = document.getElementById('wsList');
const vivaldiBtn = document.getElementById('vivaldi');
let wsRows = [];

async function detectVivaldi() {
  try { vivaldiBtn.hidden = !(await getVivaldiWorkspaces()); } catch { vivaldiBtn.hidden = true; }
}

vivaldiBtn.addEventListener('click', async () => {
  const workspaces = await getVivaldiWorkspaces();
  if (!workspaces?.length) return toast('No workspace tabs found');
  let n = 0;
  wsRows = workspaces.map((ws) => {
    const created = workspaceCreated(ws.key);
    const check = el('input', { type: 'checkbox', checked: ws.key !== 'none' });
    const name = el('input', { type: 'text', value: suggestName(ws.pages), required: true });
    const label = ws.key === 'none' ? 'Tabs not in any workspace' : `Workspace ${++n}`;
    const row = el('div', { class: 'ws' },
      check, name, el('span', { class: 'count' }, plural(ws.pages.length, 'tab')),
      el('div', { class: 'meta', title: ws.pages.map((p) => p.url).join('\n') },
        label, created ? ` · created ${created.toLocaleDateString()}` : '', ' · ',
        ws.pages.slice(0, 3).map((p) => p.title || p.url).join(' · ')));
    return { ws, check, name, row };
  });
  wsList.replaceChildren(...wsRows.map((r) => r.row));
  wsDialog.showModal();
});

wsDialog.addEventListener('close', async () => {
  if (wsDialog.returnValue !== 'create') return;
  const chosen = wsRows.filter((r) => r.check.checked);
  if (!chosen.length) return;
  const all = await getCollections();
  const date = new Date().toLocaleDateString();
  for (const r of chosen) {
    const col = makeCollection({
      name: r.name.value,
      description: `Created from a Vivaldi workspace on ${date}.`,
      pages: r.ws.pages,
    });
    all[col.id] = col;
  }
  await saveCollections(all);
  toast(`Created ${plural(chosen.length, 'collection')}`);
});

detectVivaldi();
filter.addEventListener('input', render);
api.storage.onChanged.addListener((changes, area) => { if (area === 'local') render(); });
render();
