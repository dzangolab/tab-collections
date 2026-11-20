import {
  api, getCollections, getAll, getPending, makeCollection, putCollection, cleanPages, el, send, openManagerPage, plural,
  vivaldiData, hasVivaldiData, workspaceKey, suggestName,
} from './common.js';

const $ = (s) => document.getElementById(s);

async function init() {
  const [cols, sessions, pending, win] = await Promise.all([
    getCollections(), getAll('sessions', {}), getPending(), api.windows.getCurrent({ populate: true }),
  ]);
  const list = Object.values(cols).sort((a, b) => a.name.localeCompare(b.name));
  const openIds = new Set(Object.values(sessions).map((s) => s.collectionId));

  $('list').replaceChildren(
    ...(list.length
      ? list.map((c) =>
          el('button', {
            class: 'item',
            title: c.description || c.name,
            onclick: async () => {
              try { await send({ type: 'open', id: c.id }); window.close(); } catch (e) { alert(e.message); }
            },
          },
          el('span', { class: 'nm' }, c.name),
          openIds.has(c.id) && el('span', { class: 'pill' }, 'Open'),
          el('span', { class: 'n' }, c.pages.length)))
      : [el('div', { class: 'muted small', style: 'padding: 8px 12px' }, 'No collections yet.')]),
  );

  const nPending = Object.keys(pending).length;
  $('pending').replaceChildren(
    nPending
      ? el('div', { class: 'banner' }, `${plural(nPending, 'change')} to review. `,
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); openManagerPage().then(() => window.close()); } }, 'Review'))
      : '',
  );

  // What "Save" captures: selected tabs > current Vivaldi workspace > whole window.
  const current = sessions[win.id];
  const ordered = win.tabs.sort((a, b) => a.index - b.index);
  const toPages = (tabs) => cleanPages(tabs.map((t) => ({ url: t.url || t.pendingUrl || '', title: t.title || '' })));
  const highlighted = ordered.filter((t) => t.highlighted);
  let mode = 'window';
  let pages = toPages(ordered);
  if (highlighted.length > 1) {
    mode = 'selected';
    pages = toPages(highlighted);
  } else if (hasVivaldiData(ordered)) {
    mode = 'workspace';
    const key = workspaceKey(vivaldiData(ordered.find((t) => t.active)));
    pages = toPages(ordered.filter((t) => {
      const d = vivaldiData(t) || {};
      return !d.panelId && workspaceKey(d) === key;
    }));
  }

  if (current && cols[current.collectionId]) {
    // A window opened from a collection: update that collection, or save the tabs as a new one.
    $('current').hidden = true;
    $('saveForm').hidden = true;
    await showCollectionWindow(win.id);
  } else {
    const what = { window: "this window's", selected: 'the selected', workspace: "this workspace's" }[mode];
    $('current').textContent = `Save ${what} ${plural(pages.length, 'tab')} as a new collection:`;
    if (mode !== 'window') $('saveName').placeholder = suggestName(pages);
    if (!pages.length) $('saveForm').querySelector('button').disabled = true;
  }

  $('saveForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fallback = mode === 'window' ? `Window saved ${new Date().toLocaleDateString()}` : suggestName(pages);
    const col = makeCollection({ name: $('saveName').value || fallback, pages });
    if (mode === 'window') {
      // The whole window becomes this collection's window, so closing it triggers the update check.
      await send({ type: 'saveAndAdopt', windowId: win.id, collection: col });
    } else {
      await putCollection(col);
    }
    await api.tabs.create({ url: api.runtime.getURL(`collection.html?id=${encodeURIComponent(col.id)}`), windowId: win.id });
    window.close();
  });
}

async function showCollectionWindow(windowId) {
  const status = await send({ type: 'windowStatus', windowId });
  if (!status) return;
  $('collectionSection').hidden = false;
  $('collectionMsg').textContent = status.changed
    ? `The contents of the “${status.name}” window have changed. Do you want to update the collection?`
    : `This window is the collection “${status.name}”.`;
  $('updateCollection').hidden = !status.changed;
  $('saveAsName').placeholder = `${status.name} (copy)`;

  const save = async (newName) => {
    try {
      await send({ type: 'saveWindow', windowId, newName });
      window.close();
    } catch (e) {
      $('collectionMsg').textContent = e.message;
    }
  };
  $('updateCollection').addEventListener('click', () => save(null));
  $('saveAsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    save($('saveAsName').value.trim());
  });
}

$('manage').addEventListener('click', (e) => { e.preventDefault(); openManagerPage().then(() => window.close()); });
init();
