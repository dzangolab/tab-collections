// The Sync panel on the Collections page: the setup form, or, once set up, where it syncs, the
// mode, the status, Sync, Edit settings and Disconnect. Edit settings shows the setup form filled
// in with the current settings.

import { api, el, getAll, icon, send, syncButton, syncStatusText } from './common.js';
import { BACKENDS, originsFor } from './sync/backends.js';
import { normalizeConfig, OWNER, REPO_TEMPLATE } from './sync/engine.js';

const TOKEN_HELP = {
  github: 'A fine-grained personal access token with access to only this repository, and the “Contents: read and write” permission.',
  gitlab: 'A project access token with the “api” scope and at least the Developer role.',
  gitea: 'An access token with the “repository: read and write” permission.',
  webdav: 'Your password, or better an app password if your server offers them (Nextcloud: Settings → Security).',
};

function field(label, input, help) {
  return el('div', { class: 'field' }, el('label', {}, label, input), help && el('p', { class: 'muted small help' }, help));
}

// A password input with an eye button that shows the value in clear text, and hides it again.
// `name()`: what the input holds, for the button's label.
export function revealable(input, name) {
  const button = el('button', { type: 'button', class: 'icon-btn ghost reveal', 'aria-pressed': 'false' });
  const show = (on) => {
    input.type = on ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', `${on ? 'Hide' : 'Show'} the ${name().toLowerCase()}`);
    button.title = on ? 'Hide' : 'Show';
    button.replaceChildren(icon(on ? 'eyeOff' : 'eye'));
  };
  button.addEventListener('click', () => show(input.type === 'password'));
  show(false);
  return el('span', { class: 'secret-input' }, input, button);
}

// While the user edits the settings (`panel.dataset.editing`), re-renders (after each sync, for
// example) leave the form alone.
export function renderSyncPanel(panel, status, notify) {
  if (!status?.configured) delete panel.dataset.editing;
  else if (panel.dataset.editing) return;
  panel.replaceChildren(status?.configured ? connected(panel, status, notify) : setupForm(notify));
}

async function refresh(panel, notify) {
  renderSyncPanel(panel, await send({ type: 'syncStatus' }).catch(() => ({ configured: false })), notify);
}

async function edit(panel, notify) {
  const current = await getAll('syncConfig', null);
  if (!current) return refresh(panel, notify);
  panel.dataset.editing = 'true';
  const done = () => { delete panel.dataset.editing; refresh(panel, notify); };
  panel.replaceChildren(setupForm(notify, { current, done }));
  panel.querySelector('input:not([type=hidden])')?.focus();
}

function connected(panel, st, notify) {
  const mode = el('select', {
    'aria-label': 'Sync mode',
    onchange: (e) => send({ type: 'syncMode', mode: e.target.value }).then(() => notify('Sync mode saved'), (err) => notify(err.message)),
  },
  el('option', { value: 'auto', selected: st.mode === 'auto' }, 'Automatic: sync every change'),
  el('option', { value: 'manual', selected: st.mode === 'manual' }, 'Manual: sync when I click Sync'));
  return el('div', { class: 'sync-connected' },
    el('p', {}, 'Syncing with ', el('strong', {}, st.label), ': ', el('code', {}, st.where),
      st.encrypted ? el('span', { class: 'pill' }, 'Encrypted') : el('span', { class: 'pill muted' }, 'Not encrypted')),
    el('p', { class: 'muted small', id: 'syncPanelStatus' }, syncStatusText(st)),
    el('div', { class: 'row wrap' },
      mode,
      syncButton(notify, { class: 'primary' }),
      el('button', { onclick: () => edit(panel, notify) }, 'Edit settings'),
      el('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Stop syncing on this device? Its collections stay here, and the sync file stays on the server.')) return;
          try { await send({ type: 'syncDisconnect' }); notify('Sync turned off on this device'); } catch (e) { notify(e.message); }
        },
      }, 'Disconnect')));
}

// The setup form. With `current` (Edit settings): filled in with those settings, Save and Cancel
// instead of Connect, and `done` called when it's saved or cancelled.
function setupForm(notify, { current = null, done = null } = {}) {
  const cur = current || {};
  const chosen = cur.backend || 'github';
  const backend = el('select', { name: 'backend' },
    ...Object.entries(BACKENDS).map(([k, b]) => el('option', { value: k, selected: k === chosen }, b.label)));
  // Filled in with the usual values; `<owner>` has to be replaced (normalizeConfig checks).
  const server = el('input', { type: 'url', name: 'server', value: cur.server || BACKENDS[chosen].defaultServer || BACKENDS.github.defaultServer });
  // Clicking or tabbing into the repository selects `<owner>`, ready to be typed over. On click,
  // after the mouse-up, which would otherwise put the cursor where the user clicked.
  const selectOwner = (e) => {
    const i = e.target.value.indexOf(OWNER);
    if (i >= 0 && e.target.selectionStart === e.target.selectionEnd) e.target.setSelectionRange(i, i + OWNER.length);
  };
  const repo = el('input', {
    type: 'text', name: 'repo', value: cur.repo || REPO_TEMPLATE, autocomplete: 'off',
    onclick: selectOwner,
    onfocus: (e) => setTimeout(() => selectOwner(e)),
  });
  const branch = el('input', { type: 'text', name: 'branch', value: cur.branch || 'main' });
  const path = el('input', { type: 'text', name: 'path', value: cur.path || 'tab-collections.json' });
  const url = el('input', { type: 'url', name: 'url', value: cur.url || '', placeholder: 'https://cloud.example/remote.php/dav/files/me/tab-collections.json' });
  const username = el('input', { type: 'text', name: 'username', value: cur.username || '', autocomplete: 'username' });
  const token = el('input', { type: 'password', name: 'token', value: cur.token || '', autocomplete: 'off' });
  const tokenHelp = el('p', { class: 'muted small help' });
  const encrypt = el('input', { type: 'checkbox', name: 'encrypt', checked: !!cur.passphrase });
  const passphrase = el('input', { type: 'password', name: 'passphrase', value: cur.passphrase || '', autocomplete: 'new-password' });
  const passphrase2 = el('input', { type: 'password', name: 'passphrase2', value: cur.passphrase || '', autocomplete: 'new-password' });
  const mode = el('select', { name: 'mode' },
    el('option', { value: 'auto', selected: cur.mode !== 'manual' }, 'Automatic: sync every change'),
    el('option', { value: 'manual', selected: cur.mode === 'manual' }, 'Manual: sync when I click Sync'));
  const connect = el('button', { type: 'submit', class: 'primary' }, current ? 'Save' : 'Connect');
  const cancel = current && el('button', { type: 'button', onclick: done }, 'Cancel');

  const git = el('div', { class: 'grid' },
    field('Server', server),
    field('Repository', repo, 'Create a private repository for this first. It can be empty.'),
    field('Branch', branch),
    field('File', path));
  const dav = el('div', { class: 'grid' },
    field('File address', url, 'The full address of the sync file. Its folder must exist; the file is created on the first sync.'),
    field('Username', username));
  const secret = el('div', { class: 'grid', hidden: true },
    field('Passphrase', revealable(passphrase, () => 'passphrase'), 'Every device that syncs with this file needs the same passphrase. If you lose it, the synced copy can’t be read.'
      + (current ? ' Changing it re-encrypts the sync file: then enter the new one on your other devices too.' : '')),
    field('Passphrase again', revealable(passphrase2, () => 'passphrase')));
  const tokenLabel = el('span', {}, 'Access token');

  // Switching backend swaps the server for the new backend's, unless the user typed their own.
  const defaults = new Set(Object.values(BACKENDS).map((b) => b.defaultServer));
  const update = () => {
    const b = backend.value;
    git.hidden = b === 'webdav';
    dav.hidden = b !== 'webdav';
    if (b !== 'webdav' && defaults.has(server.value.trim())) server.value = BACKENDS[b].defaultServer;
    tokenLabel.textContent = b === 'webdav' ? 'Password' : 'Access token';
    tokenHelp.textContent = TOKEN_HELP[b];
    secret.hidden = !encrypt.checked;
  };
  backend.addEventListener('change', update);
  encrypt.addEventListener('change', update);
  update();

  const form = el('form', { class: 'sync-form' },
    current
      ? el('h3', { class: 'sync-edit-title' }, 'Edit sync settings')
      : el('p', { class: 'muted small' }, 'Sync your collections with other browsers and devices through a repository or a WebDAV server you own. Nobody else, including us, gets your data.'),
    field('Where', backend),
    git, dav,
    el('div', { class: 'field' }, el('label', {}, tokenLabel, revealable(token, () => tokenLabel.textContent)), tokenHelp),
    el('div', { class: 'field' }, el('label', { class: 'check' }, encrypt, 'Encrypt the sync file with a passphrase')),
    secret,
    field('Mode', mode, 'Checks for changes from other devices at browser start and every 5 minutes, in both modes.'),
    el('div', { class: 'row' }, connect, cancel));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let cfg;
    try {
      if (encrypt.checked && !passphrase.value) throw new Error('Enter a passphrase, or turn encryption off.');
      if (encrypt.checked && passphrase.value !== passphrase2.value) throw new Error('The two passphrases differ.');
      cfg = normalizeConfig({
        backend: backend.value, server: server.value, repo: repo.value, branch: branch.value, path: path.value,
        url: url.value, username: username.value, token: token.value, mode: mode.value,
        passphrase: encrypt.checked ? passphrase.value : '',
      });
    } catch (err) {
      notify(err.message);
      return;
    }
    // Asked here, during the click: browsers only allow permission requests from a user action.
    const asked = api.permissions?.request ? api.permissions.request({ origins: originsFor(cfg) }) : Promise.resolve(true);
    connect.disabled = true;
    asked.then(async (granted) => {
      if (!granted) throw new Error('Sync needs access to that server.');
      await send({ type: current ? 'syncUpdate' : 'syncSetup', config: cfg });
      notify(current ? 'Sync settings saved' : 'Sync is set up');
      done?.();
    }).catch((err) => notify(err.message)).finally(() => { connect.disabled = false; });
  });
  return form;
}
