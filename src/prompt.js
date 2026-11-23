import {
  api, diffPages, el, getCollection, getPending, getSettings, growthWarning, isVivaldi, makeCollection, plural,
  putCollection, resolvePending, send, suspiciousGrowth, VIVALDI_NOTE,
} from './common.js';

const root = document.getElementById('root');
const id = new URLSearchParams(location.search).get('id');

async function closeSelf() {
  const tab = await api.tabs.getCurrent();
  if (tab) api.tabs.remove(tab.id);
  else window.close();
}

// The prompt closes itself when the user switches to another window, or after 5 minutes. A closed
// window's changes then stay undecided, shown on the Collections and Collection pages. Not while
// a choice is being saved; that closes the prompt itself.
const AUTO_CLOSE_MS = 5 * 60_000;
let busy = false;
let hadFocus = document.hasFocus();
window.addEventListener('focus', () => { hadFocus = true; });
window.addEventListener('blur', () => { if (hadFocus && !busy) closeSelf(); });
setTimeout(() => { if (!busy) closeSelf(); }, AUTO_CLOSE_MS);

// Handled elsewhere (on a page, or by reopening the collection)? Nothing left to ask.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pending && !busy && !changes.pending.newValue?.[id]) closeSelf();
});

function pageLine(p, cls, sign) {
  return el('li', { class: cls, title: p.url },
    el('span', { class: 'tag' }, sign), p.title || p.url, p.title && el('span', { class: 'u' }, p.url));
}

async function init() {
  const pending = (await getPending())[id];
  if (!pending) {
    root.replaceChildren(el('h2', {}, 'Nothing to review'),
      el('p', { class: 'muted' }, 'This change was already handled.'),
      el('button', { onclick: closeSelf }, 'Close'));
    return;
  }
  // `live`: the window is still open (the user asked from the toolbar popup).
  const theWindowHad = pending.live ? 'The open window has' : 'The window you closed had';
  // No pages left in the window: nothing to update the collection with, nor to save as a new
  // one, since a collection needs at least one page.
  const noPages = !pending.pages.length;
  const col = await getCollection(pending.collectionId);
  if (!col) {
    root.replaceChildren(
      el('h2', {}, `“${pending.collectionName}” no longer exists`),
      el('p', { class: 'muted' }, noPages
        ? `${theWindowHad} no pages to save.`
        : `${theWindowHad} ${plural(pending.pages.length, 'tab')}. Save them as a new collection?`),
      el('div', { class: 'buttons' },
        !noPages && el('button', { class: 'primary', onclick: () => saveAsNew(pending.collectionName, '') }, 'Save as new collection'),
        el('button', { class: noPages && 'primary', onclick: discard }, 'Discard')),
    );
    return;
  }

  // Compare against the URLs the saved pages actually resolved to (after redirects) when opened.
  const before = col.pages.map((p, i) => ({ ...p, url: pending.baseline?.[i] || p.url }));
  const { added, removed, reordered } = diffPages(before, pending.pages);
  // Many more tabs than the collection had: probably tabs the user can't see (Vivaldi workspaces).
  const suspicious = suspiciousGrowth(col.pages.length, pending.pages.length);
  const vivaldi = await isVivaldi();
  // The setting decides which button is focused and highlighted; the other gets the plain style.
  // Restore only for a closed window: the extension never closes tabs of an open one. Never
  // Update by default when the growth is suspicious.
  const updateByDefault = !suspicious && (pending.live || (await getSettings()).closeDefault === 'update');
  const updateButton = !noPages && el('button', { class: updateByDefault && 'primary', onclick: () => update(col) }, 'Update');
  const keepButton = !pending.live && el('button', { class: (!updateByDefault || noPages) && 'primary', onclick: discard }, 'Restore');
  // An open window without pages: nothing to choose; the collection stays as saved.
  const closeButton = noPages && pending.live && el('button', { class: 'primary', onclick: closeSelf }, 'Close');
  document.title = `Update “${col.name}” collection`;
  root.replaceChildren(...[
    el('h2', {}, `Update “${col.name}” collection`),
    el('p', {}, noPages
      ? `${theWindowHad} no pages left. A collection needs at least one page, so “${col.name}” can’t be updated with it.`
      : `The contents of the “${col.name}” window have changed. Do you want to update the collection?`),
    suspicious && el('p', { class: 'warning', role: 'alert' }, growthWarning(col.pages.length, pending.pages.length)),
    !suspicious && vivaldi && !noPages && el('p', { class: 'note' }, VIVALDI_NOTE),
    !!added.length && el('h2', {}, `${plural(added.length, 'page')} added`),
    !!added.length && el('ul', { class: 'changes' }, ...added.map((p) => pageLine(p, 'add', '+'))),
    !!removed.length && el('h2', {}, `${plural(removed.length, 'page')} removed`),
    !!removed.length && el('ul', { class: 'changes' }, ...removed.map((p) => pageLine(p, 'rem', '−'))),
    reordered && el('p', {}, 'The same pages are there, but in a different order.'),
    el('details', {},
      el('summary', {}, `Tabs in the ${pending.live ? 'open' : 'closed'} window (${pending.pages.length})`),
      el('ul', { class: 'changes' }, ...pending.pages.map((p) => pageLine(p, '', '•')))),
    el('div', { class: 'buttons' }, updateButton, keepButton, closeButton),
    !noPages && el('h2', {}, 'Save as a new collection'),
    !noPages && el('form', {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        saveAsNew(e.target.elements.name.value.trim() || `${col.name} (copy)`, col.description);
      },
    },
    el('input', { type: 'text', name: 'name', placeholder: `${col.name} (copy)` }),
    el('button', { type: 'submit', class: 'primary' }, 'Save')),
  ].filter(Boolean));
  // Nothing to focus for an open window whose growth is suspicious: the user should read first.
  ((updateByDefault && updateButton) || keepButton || closeButton)?.focus?.();

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
