import {
  api, getCollections, saveCollections, getVivaldiWorkspaces, workspaceCreated, suggestName, removeCollection, makeCollection, hasPages, getAll,
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
  const windowsOf = (id) => Object.entries(sessions).filter(([, s]) => s.collectionId === id).map(([w]) => Number(w));
  const currentId = sessions[windowId]?.collectionId;
  const q = filter.value.trim().toLowerCase();
  const all = Object.values(cols).sort((a, b) => a.name.localeCompare(b.name));
  const list = q ? all.filter((c) => (c.name + ' ' + c.description).toLowerCase().includes(q)) : all;

  cards.replaceChildren(...list.map((c) => {
    const open = windowsOf(c.id).length > 0;
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
            onchange: (e) => toggleWindow(c.id, e.target, windowsOf(c.id)),
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
async function toggleWindow(id, input, windowIds) {
  try {
    if (input.checked) await send({ type: 'open', id });
    else await Promise.all(windowIds.map((w) => api.windows.remove(w)));
  } catch (e) {
    input.checked = !input.checked;
    toast(e.message);
  }
}

// Nothing is stored yet: the Collection page creates the collection on its first save, once it
// has a page, so leaving it without saving leaves no empty collection behind.
document.getElementById('new').addEventListener('click', () => {
  location.href = 'collection.html?new=1';
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
    const { collections: incoming, skipped } = parseImport(await file.text());
    if (!incoming.length) {
      return alert(skipped
        ? `Nothing to import: the ${plural(skipped, 'collection')} in “${file.name}” ${skipped === 1 ? 'has' : 'have'} no pages.`
        : 'No collections found in this file.');
    }
    const existing = await getCollections();
    const overwrite = incoming.filter((c) => existing[c.id]);
    const msg =
      `Import ${plural(incoming.length, 'collection')} from “${file.name}”?` +
      (skipped ? `\n\n${plural(skipped, 'collection')} without pages will be skipped.` : '') +
      (overwrite.length
        ? `\n\n${plural(overwrite.length, 'collection')} already exist and will be replaced:\n` +
          overwrite.map((c) => `• ${existing[c.id].name}`).join('\n')
        : '');
    if (!confirm(msg)) return;
    for (const c of incoming) existing[c.id] = c;
    await saveCollections(existing);
    toast(`Imported ${plural(incoming.length, 'collection')}` + (skipped ? `, skipped ${skipped} without pages` : ''));
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
  const date = new Date().toLocaleDateString();
  const made = chosen.map((r) => makeCollection({
    name: r.name.value,
    description: `Created from a Vivaldi workspace on ${date}.`,
    pages: r.ws.pages,
  }));
  // A workspace whose tabs have no usable URL would make an empty collection: skip it.
  const kept = made.filter(hasPages);
  const skipped = made.length - kept.length;
  const skippedMsg = skipped ? `skipped ${skipped} without pages` : '';
  if (!kept.length) return toast(`Nothing created: ${skippedMsg}`);
  const all = await getCollections();
  for (const col of kept) all[col.id] = col;
  try {
    await saveCollections(all);
  } catch (e) {
    return toast(e.message);
  }
  toast(`Created ${plural(kept.length, 'collection')}` + (skipped ? `, ${skippedMsg}` : ''));
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
