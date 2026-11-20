import {
  api, getPending, resolvePending, getCollection, putCollection, makeCollection, diffPages, el, plural, send,
} from './common.js';

const root = document.getElementById('root');
const id = new URLSearchParams(location.search).get('id');

async function closeSelf() {
  const tab = await api.tabs.getCurrent();
  if (tab) api.tabs.remove(tab.id);
  else window.close();
}

function pageLine(p, cls, sign) {
  return el('li', { class: cls, title: p.url },
    el('span', { class: 'tag' }, sign), p.title || p.url, p.title && el('span', { class: 'u' }, p.url));
}

async function init() {
  const pending = (await getPending())[id];
  if (!pending) {
    root.replaceChildren(el('h1', {}, 'Nothing to review'),
      el('p', { class: 'muted' }, 'This change was already handled.'),
      el('button', { onclick: closeSelf }, 'Close'));
    return;
  }
  // `live`: the user asked to save the changes of a window that is still open.
  const theWindowHad = pending.live ? 'The open window has' : 'The window you closed had';
  const col = await getCollection(pending.collectionId);
  if (!col) {
    root.replaceChildren(
      el('h1', {}, `“${pending.collectionName}” no longer exists`),
      el('p', { class: 'muted' }, `${theWindowHad} ${plural(pending.pages.length, 'tab')}. Save them as a new collection?`),
      el('div', { class: 'buttons' },
        el('button', { class: 'primary', onclick: () => saveAsNew(pending.collectionName, '') }, 'Save as new collection'),
        el('button', { onclick: discard }, 'Discard')),
    );
    return;
  }

  // Compare against the URLs the saved pages actually resolved to (after redirects) when opened.
  const before = col.pages.map((p, i) => ({ ...p, url: pending.baseline?.[i] || p.url }));
  const { added, removed, reordered } = diffPages(before, pending.pages);
  document.title = `Update “${col.name}”?`;
  root.replaceChildren(...[
    el('h1', {}, `Update “${col.name}”?`),
    el('p', { class: 'muted' },
      pending.live
        ? 'The open window has different tabs from the saved collection.'
        : `The window you closed (${new Date(pending.closedAt).toLocaleTimeString()}) had different tabs from the saved collection.`),
    !!added.length && el('h2', {}, `${plural(added.length, 'page')} added`),
    !!added.length && el('ul', { class: 'changes' }, ...added.map((p) => pageLine(p, 'add', '+'))),
    !!removed.length && el('h2', {}, `${plural(removed.length, 'page')} removed`),
    !!removed.length && el('ul', { class: 'changes' }, ...removed.map((p) => pageLine(p, 'rem', '−'))),
    reordered && el('p', {}, 'The same pages are there, but in a different order.'),
    el('details', {},
      el('summary', {}, `Tabs in the ${pending.live ? 'open' : 'closed'} window (${pending.pages.length})`),
      el('ul', { class: 'changes' }, ...pending.pages.map((p) => pageLine(p, '', '•')))),
    el('div', { class: 'buttons' },
      el('button', { class: 'primary', onclick: () => update(col) }, 'Update collection'),
      el('button', { onclick: discard }, 'Keep unchanged'),
      el('button', { onclick: () => saveAsNew(`${col.name} (copy)`, col.description) }, 'Save as new collection'),
    ),
  ].filter(Boolean));

  async function update(c) {
    c.pages = pending.pages.map((p) => ({ url: p.url, title: p.title }));
    await putCollection(c);
    await track(c.id);
    await resolvePending(id);
    closeSelf();
  }

  async function discard() {
    await resolvePending(id);
    closeSelf();
  }

  async function saveAsNew(name, description) {
    const c = makeCollection({ name, description, pages: pending.pages });
    await putCollection(c);
    await track(c.id);
    await resolvePending(id);
    closeSelf();
  }

  // An open window keeps being tracked, now as the collection just saved, so closing it later only
  // asks again about changes made after this save.
  async function track(collectionId) {
    if (!pending.live) return;
    try { await api.windows.get(pending.windowId); } catch { return; } // closed in the meantime
    await send({ type: 'adopt', windowId: pending.windowId, collectionId, baseline: pending.pages.map((p) => p.url) });
  }
}

init();
