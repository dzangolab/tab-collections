import {
  getCollections, getAll, getPending, makeCollection, cleanPages, el, send, openManagerPage, plural,
} from './common.js';

const $ = (s) => document.getElementById(s);

async function init() {
  const [cols, sessions, pending, win] = await Promise.all([
    getCollections(), getAll('sessions', {}), getPending(), chrome.windows.getCurrent({ populate: true }),
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

  const current = sessions[win.id];
  const pages = cleanPages(win.tabs.sort((a, b) => a.index - b.index).map((t) => ({ url: t.url || t.pendingUrl || '', title: t.title || '' })));
  if (current && cols[current.collectionId]) {
    $('current').textContent = `This window is the collection “${cols[current.collectionId].name}”.`;
    $('saveForm').hidden = true;
  } else {
    $('current').textContent = `Save this window's ${plural(pages.length, 'tab')} as a new collection:`;
    if (!pages.length) $('saveForm').querySelector('button').disabled = true;
  }

  $('saveForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const col = makeCollection({ name: $('saveName').value || `Window saved ${new Date().toLocaleDateString()}`, pages });
    await send({ type: 'saveAndAdopt', windowId: win.id, collection: col });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`collection.html?id=${encodeURIComponent(col.id)}`), windowId: win.id });
    window.close();
  });
}

$('manage').addEventListener('click', (e) => { e.preventDefault(); openManagerPage().then(() => window.close()); });
init();
