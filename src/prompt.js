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

// The user decides there and then: switching to another window closes the prompt, which counts
// as "Keep unchanged". Not while a choice is being saved; that closes the prompt itself.
let busy = false;
let hadFocus = document.hasFocus();
window.addEventListener('focus', () => { hadFocus = true; });
window.addEventListener('blur', () => { if (hadFocus && !busy) closeSelf(); });

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
  // `live`: the window is still open (the user asked from the toolbar popup).
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
    el('p', {}, `The contents of the “${col.name}” window have changed. Do you want to update the collection?`),
    !!added.length && el('h2', {}, `${plural(added.length, 'page')} added`),
    !!added.length && el('ul', { class: 'changes' }, ...added.map((p) => pageLine(p, 'add', '+'))),
    !!removed.length && el('h2', {}, `${plural(removed.length, 'page')} removed`),
    !!removed.length && el('ul', { class: 'changes' }, ...removed.map((p) => pageLine(p, 'rem', '−'))),
    reordered && el('p', {}, 'The same pages are there, but in a different order.'),
    el('details', {},
      el('summary', {}, `Tabs in the ${pending.live ? 'open' : 'closed'} window (${pending.pages.length})`),
      el('ul', { class: 'changes' }, ...pending.pages.map((p) => pageLine(p, '', '•')))),
    el('div', { class: 'buttons' },
      el('button', { class: 'primary', onclick: () => update(col) }, 'Update'),
      el('button', { onclick: discard }, 'Keep unchanged'),
    ),
    el('h2', {}, 'Save as a new collection'),
    el('form', {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        saveAsNew(e.target.elements.name.value.trim() || `${col.name} (copy)`, col.description);
      },
    },
    el('input', { type: 'text', name: 'name', placeholder: `${col.name} (copy)` }),
    el('button', { type: 'submit', class: 'primary' }, 'Save')),
  ].filter(Boolean));

  async function update(c) {
    busy = true;
    c.pages = pending.pages.map((p) => ({ url: p.url, title: p.title }));
    await putCollection(c);
    await track(c.id);
    await resolvePending(id);
    closeSelf();
  }

  async function discard() {
    busy = true;
    await resolvePending(id);
    closeSelf();
  }

  async function saveAsNew(name, description) {
    busy = true;
    const c = makeCollection({ name, description, pages: pending.pages });
    await putCollection(c);
    await track(c.id);
    await resolvePending(id);
    closeSelf();
  }

  // A window that is still open stays tracked, now as the collection just saved, so closing it
  // later only asks about changes made after this save.
  async function track(collectionId) {
    if (!pending.live) return;
    try { await api.windows.get(pending.windowId); } catch { return; } // closed in the meantime
    await send({ type: 'adopt', windowId: pending.windowId, collectionId, baseline: pending.pages.map((p) => p.url) });
  }
}

init();
