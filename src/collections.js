import {
  api, getCollections, saveCollections, getVivaldiWorkspaces, workspaceCreated, suggestName, putCollection, removeCollection, makeCollection, getAll,
  buildExport, parseImport, downloadJson, el, icon, send, plural, getSettings, saveSetting,
  closedDrift, collectionDrift,
} from './common.js';

const cards = document.getElementById('cards');
const empty = document.getElementById('empty');
const filter = document.getElementById('filter');
const toastEl = document.getElementById('toast');

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// The window this page is in, to mark the collection it holds as "This window".
const thisWindow = api.tabs.getCurrent().then((t) => t?.windowId).catch(() => null);

async function render() {
  const [cols, sessions, windowId, closed, live] = await Promise.all([
    getCollections(), getAll('sessions', {}), thisWindow, closedDrift(),
    send({ type: 'driftStatus' }).catch(() => ({})),
  ]);
  const currentId = sessions[windowId]?.collectionId;
  const q = filter.value.trim().toLowerCase();
  const all = Object.values(cols).sort((a, b) => a.name.localeCompare(b.name));
  const list = q ? all.filter((c) => (c.name + ' ' + c.description).toLowerCase().includes(q)) : all;

  cards.replaceChildren(...list.map((c) => {
    const open = c.id in live; // pruned of windows that are already gone
    const current = c.id === currentId;
    const strip = collectionDrift(c.id, closed, live, toast);
    return el('article', { class: ['card', current && 'current', strip && 'drifted'].filter(Boolean).join(' ') },
      el('div', { class: 'card-top' },
        el('a', { class: 'card-name', href: `collection.html?id=${encodeURIComponent(c.id)}` }, c.name),
        current && el('span', { class: 'badge-current' }, 'This window'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'card-pages' }, icon('pages'), plural(c.pages.length, 'page')),
        el('span', { class: 'card-state' }, open ? 'Open' : 'Closed'),
        el('label', { class: 'toggle', title: open ? 'Close the window' : 'Open in a window' },
          el('input', {
            type: 'checkbox',
            role: 'switch',
            checked: open,
            'aria-label': `“${c.name}” window`,
            onchange: (e) => toggleWindow(c.id, e.target),
          }),
          el('span')),
      ),
      c.description && el('p', { class: 'card-desc' }, c.description),
      el('div', { class: 'card-bottom' },
        el('button', {
          class: 'icon-btn ghost danger',
          'aria-label': `Delete “${c.name}”`,
          title: 'Delete',
          onclick: async () => {
            if (confirm(`Delete the collection “${c.name}”? This cannot be undone.`)) {
              await removeCollection(c.id);
              toast('Collection deleted');
            }
          },
        }, icon('delete'))),
      strip,
    );
  }));
  empty.hidden = all.length > 0;
  document.getElementById('noMatch').hidden = !(all.length && !list.length);
}

// The toggle opens the collection's window, or closes it.
async function toggleWindow(id, input) {
  try {
    await send({ type: input.checked ? 'open' : 'closeCollection', id });
  } catch (e) {
    input.checked = !input.checked;
    toast(e.message);
  }
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

// ---------- Settings ----------

const closeDefault = document.getElementById('closeDefault');
getSettings().then((s) => { closeDefault.value = s.closeDefault; });
closeDefault.addEventListener('change', async () => {
  await saveSetting('closeDefault', closeDefault.value);
  toast('Setting saved');
});

detectVivaldi();
filter.addEventListener('input', render);
api.storage.onChanged.addListener((changes, area) => { if (area === 'local') render(); });
render();
