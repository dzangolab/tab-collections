// The Sync panel on the Collections page: the setup form, or, once set up, where it syncs, the
// mode, the status, Sync and Disconnect.

import { api, el, send, syncButton, syncStatusText } from './common.js';
import { BACKENDS, originsFor } from './sync/backends.js';
import { normalizeConfig } from './sync/engine.js';

const TOKEN_HELP = {
  github: 'A fine-grained personal access token with access to only this repository, and the “Contents: read and write” permission.',
  gitlab: 'A project access token with the “api” scope and at least the Developer role.',
  gitea: 'An access token with the “repository: read and write” permission.',
  webdav: 'Your password, or better an app password if your server offers them (Nextcloud: Settings → Security).',
};

function field(label, input, help) {
  return el('div', { class: 'field' }, el('label', {}, label, input), help && el('p', { class: 'muted small help' }, help));
}

export function renderSyncPanel(panel, status, notify) {
  panel.replaceChildren(status?.configured ? connected(status, notify) : setupForm(notify));
}

function connected(st, notify) {
  const mode = el('select', {
    'aria-label': 'Sync mode',
    onchange: (e) => send({ type: 'syncMode', mode: e.target.value }).then(() => notify('Sync mode saved'), (err) => notify(err.message)),
  },
  el('option', { value: 'auto', selected: st.mode === 'auto' }, 'Automatic: sync every change'),
  el('option', { value: 'manual', selected: st.mode === 'manual' }, 'Manual: sync when I click Sync'));
  return el('div', { class: 'sync-connected' },
    el('p', {}, 'Syncing with ', el('strong', {}, st.label), ': ', el('code', {}, st.where),
      st.encrypted ? el('span', { class: 'tag' }, 'Encrypted') : el('span', { class: 'tag muted' }, 'Not encrypted')),
    el('p', { class: 'muted small', id: 'syncPanelStatus' }, syncStatusText(st)),
    el('div', { class: 'row wrap' },
      mode,
      syncButton(notify, { class: 'primary' }),
      el('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Stop syncing on this device? Its collections stay here, and the sync file stays on the server.')) return;
          try { await send({ type: 'syncDisconnect' }); notify('Sync turned off on this device'); } catch (e) { notify(e.message); }
        },
      }, 'Disconnect')));
}

function setupForm(notify) {
  const backend = el('select', { name: 'backend' },
    ...Object.entries(BACKENDS).map(([k, b]) => el('option', { value: k, selected: k === 'github' }, b.label)));
  const server = el('input', { type: 'url', name: 'server', placeholder: 'https://github.com' });
  const repo = el('input', { type: 'text', name: 'repo', placeholder: 'owner/tab-collections', autocomplete: 'off' });
  const branch = el('input', { type: 'text', name: 'branch', placeholder: 'main' });
  const path = el('input', { type: 'text', name: 'path', placeholder: 'tab-collections.json' });
  const url = el('input', { type: 'url', name: 'url', placeholder: 'https://cloud.example/remote.php/dav/files/me/tab-collections.json' });
  const username = el('input', { type: 'text', name: 'username', autocomplete: 'username' });
  const token = el('input', { type: 'password', name: 'token', autocomplete: 'off' });
  const tokenHelp = el('p', { class: 'muted small help' });
  const encrypt = el('input', { type: 'checkbox', name: 'encrypt' });
  const passphrase = el('input', { type: 'password', name: 'passphrase', autocomplete: 'new-password' });
  const passphrase2 = el('input', { type: 'password', name: 'passphrase2', autocomplete: 'new-password' });
  const mode = el('select', { name: 'mode' },
    el('option', { value: 'auto' }, 'Automatic: sync every change'),
    el('option', { value: 'manual' }, 'Manual: sync when I click Sync'));
  const connect = el('button', { type: 'submit', class: 'primary' }, 'Connect');

  const git = el('div', { class: 'grid' },
    field('Server', server),
    field('Repository', repo, 'Create a private repository for this first. It can be empty.'),
    field('Branch', branch),
    field('File', path));
  const dav = el('div', { class: 'grid' },
    field('File address', url, 'The full address of the sync file. Its folder must exist; the file is created on the first sync.'),
    field('Username', username));
  const secret = el('div', { class: 'grid', hidden: true },
    field('Passphrase', passphrase, 'Every device that syncs with this file needs the same passphrase. If you lose it, the synced copy can’t be read.'),
    field('Passphrase again', passphrase2));
  const tokenLabel = el('span', {}, 'Access token');

  const update = () => {
    const b = backend.value;
    git.hidden = b === 'webdav';
    dav.hidden = b !== 'webdav';
    server.placeholder = BACKENDS[b].defaultServer;
    tokenLabel.textContent = b === 'webdav' ? 'Password' : 'Access token';
    tokenHelp.textContent = TOKEN_HELP[b];
    secret.hidden = !encrypt.checked;
  };
  backend.addEventListener('change', update);
  encrypt.addEventListener('change', update);
  update();

  const form = el('form', { class: 'sync-form' },
    el('p', { class: 'muted small' }, 'Sync your collections with other browsers and devices through a repository or a WebDAV server you own. Nobody else, including us, gets your data.'),
    field('Where', backend),
    git, dav,
    el('div', { class: 'field' }, el('label', {}, tokenLabel, token), tokenHelp),
    el('div', { class: 'field' }, el('label', { class: 'check' }, encrypt, 'Encrypt the sync file with a passphrase')),
    secret,
    field('Mode', mode, 'Checks for changes from other devices at browser start and every 5 minutes, in both modes.'),
    el('div', { class: 'row' }, connect));

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
      await send({ type: 'syncSetup', config: cfg });
      notify('Sync is set up');
    }).catch((err) => notify(err.message)).finally(() => { connect.disabled = false; });
  });
  return form;
}
