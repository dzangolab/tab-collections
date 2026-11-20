import {
  getPending, resolvePending, getCollection, putCollection, makeCollection, diffPages, el, plural,
} from './common.js';

const root = document.getElementById('root');
const id = new URLSearchParams(location.search).get('id');

async function closeSelf() {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
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
  const col = await getCollection(pending.collectionId);
  if (!col) {
    root.replaceChildren(
      el('h1', {}, `“${pending.collectionName}” no longer exists`),
      el('p', { class: 'muted' }, `The window you closed had ${plural(pending.pages.length, 'tab')}. Save them as a new collection?`),
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
      `The window you closed (${new Date(pending.closedAt).toLocaleTimeString()}) had different tabs from the saved collection.`),
    !!added.length && el('h2', {}, `${plural(added.length, 'page')} added`),
    !!added.length && el('ul', { class: 'changes' }, ...added.map((p) => pageLine(p, 'add', '+'))),
    !!removed.length && el('h2', {}, `${plural(removed.length, 'page')} removed`),
    !!removed.length && el('ul', { class: 'changes' }, ...removed.map((p) => pageLine(p, 'rem', '−'))),
    reordered && el('p', {}, 'The same pages are there, but in a different order.'),
    el('details', {},
      el('summary', {}, `Tabs in the closed window (${pending.pages.length})`),
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
    await resolvePending(id);
    closeSelf();
  }

  async function discard() {
    await resolvePending(id);
    closeSelf();
  }

  async function saveAsNew(name, description) {
    await putCollection(makeCollection({ name, description, pages: pending.pages }));
    await resolvePending(id);
    closeSelf();
  }
}

init();
