// Storage backends for the sync file (ADR 0001, "Storage"). Each one has:
//   check()               → resolves if the server, credentials and repository/folder work
//   read()                → { text, version }; text null when the file doesn't exist yet
//   write(text, version)  → the new version; throws ConflictError if the file moved on since
//                            `version` (null: the file must not exist yet)
//
// A sync config (src/sync/engine.js) names the backend and its settings:
//   git hosts: { backend: 'github' | 'gitlab' | 'gitea', server, repo: 'owner/name', branch, path, token }
//   WebDAV:    { backend: 'webdav', url: the file's full URL, username, token: the (app) password }

import { base64ToUtf8, utf8ToBase64 } from './file.js';

export class ConflictError extends Error {}
export class AuthError extends Error {}
export class BackendError extends Error {}

export const BACKENDS = {
  gitea: { label: 'Gitea / Forgejo / Codeberg', defaultServer: 'https://codeberg.org' },
  github: { label: 'GitHub', defaultServer: 'https://github.com' },
  gitlab: { label: 'GitLab', defaultServer: 'https://gitlab.com' },
  webdav: { label: 'WebDAV (Nextcloud, ownCloud, Synology, Fastmail…)', defaultServer: '' },
};

const COMMIT_MESSAGE = 'Sync Tab Collections';
const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

export function apiBase(cfg) {
  const server = trimSlash(cfg.server);
  switch (cfg.backend) {
    case 'github': return /^https:\/\/(www\.)?github\.com$/i.test(server) ? 'https://api.github.com' : `${server}/api/v3`;
    case 'gitlab': return `${server}/api/v4`;
    case 'gitea': return `${server}/api/v1`;
    default: return null;
  }
}

// The origins the extension needs access to, as host permission patterns.
export function originsFor(cfg) {
  const url = cfg.backend === 'webdav' ? cfg.url : apiBase(cfg);
  return [`${new URL(url).origin}/*`];
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, cache: 'no-store', credentials: 'omit' });
  } catch (e) {
    throw new BackendError(`Can’t reach ${new URL(url).host}: ${e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`Access denied by ${new URL(url).host} (${res.status}). Check the token or password and its permissions.`);
  }
  return res;
}

async function failure(res, what) {
  let detail = '';
  try { const j = await res.clone().json(); detail = j.message || j.error || ''; } catch { /* not JSON */ }
  if (!detail) { try { detail = (await res.text()).slice(0, 200); } catch { /* none */ } }
  return new BackendError(`${what} failed (${res.status}${detail ? `: ${detail}` : ''})`);
}

const json = (res) => res.json();
const encodePath = (p) => String(p).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

// ---------- GitHub ----------

function github(cfg) {
  const base = apiBase(cfg);
  const repo = cfg.repo.split('/').map(encodeURIComponent).join('/');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const fileUrl = `${base}/repos/${repo}/contents/${encodePath(cfg.path)}`;
  return {
    async check() {
      const res = await request(`${base}/repos/${repo}`, { headers });
      if (res.status === 404) throw new BackendError(`Repository ${cfg.repo} not found, or the token can’t see it.`);
      if (!res.ok) throw await failure(res, 'Checking the repository');
    },
    async read() {
      const res = await request(`${fileUrl}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
      if (res.status === 404) return { text: null, version: null };
      if (!res.ok) throw await failure(res, 'Reading the sync file');
      const file = await json(res);
      let content = file.content;
      if (!content && file.size > 0) { // over 1 MB: the contents API leaves it out
        const blob = await request(`${base}/repos/${repo}/git/blobs/${file.sha}`, { headers });
        if (!blob.ok) throw await failure(blob, 'Reading the sync file');
        content = (await json(blob)).content;
      }
      return { text: base64ToUtf8(content || ''), version: file.sha };
    },
    async write(text, version) {
      const body = { message: COMMIT_MESSAGE, content: utf8ToBase64(text), branch: cfg.branch, ...(version && { sha: version }) };
      const res = await request(fileUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 409 || res.status === 422) throw new ConflictError('The sync file changed on the server.');
      if (!res.ok) throw await failure(res, 'Writing the sync file');
      return (await json(res)).content.sha;
    },
  };
}

// ---------- Gitea / Forgejo ----------

function gitea(cfg) {
  const base = apiBase(cfg);
  const repo = cfg.repo.split('/').map(encodeURIComponent).join('/');
  const headers = { Accept: 'application/json', Authorization: `token ${cfg.token}` };
  const fileUrl = `${base}/repos/${repo}/contents/${encodePath(cfg.path)}`;
  return {
    async check() {
      const res = await request(`${base}/repos/${repo}`, { headers });
      if (res.status === 404) throw new BackendError(`Repository ${cfg.repo} not found, or the token can’t see it.`);
      if (!res.ok) throw await failure(res, 'Checking the repository');
    },
    async read() {
      const res = await request(`${fileUrl}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
      if (res.status === 404) return { text: null, version: null };
      if (!res.ok) throw await failure(res, 'Reading the sync file');
      const file = await json(res);
      return { text: base64ToUtf8(file.content || ''), version: file.sha };
    },
    async write(text, version) {
      const body = { message: COMMIT_MESSAGE, content: utf8ToBase64(text), branch: cfg.branch, ...(version && { sha: version }) };
      const res = await request(fileUrl, {
        method: version ? 'PUT' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.status === 409 || res.status === 422) throw new ConflictError('The sync file changed on the server.');
      if (!res.ok) throw await failure(res, 'Writing the sync file');
      return (await json(res)).content.sha;
    },
  };
}

// ---------- GitLab ----------

function gitlab(cfg) {
  const base = apiBase(cfg);
  const project = `${base}/projects/${encodeURIComponent(cfg.repo)}`;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${cfg.token}` };
  const fileUrl = `${project}/repository/files/${encodeURIComponent(String(cfg.path).replace(/^\/+/, ''))}`;
  const backend = {
    async check() {
      const res = await request(project, { headers });
      if (res.status === 404) throw new BackendError(`Project ${cfg.repo} not found, or the token can’t see it.`);
      if (!res.ok) throw await failure(res, 'Checking the project');
    },
    async read() {
      const res = await request(`${fileUrl}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
      if (res.status === 404) return { text: null, version: null };
      if (!res.ok) throw await failure(res, 'Reading the sync file');
      const file = await json(res);
      // The last commit that touched the file: GitLab refuses an update based on an older one.
      return { text: base64ToUtf8(file.content || ''), version: file.last_commit_id };
    },
    async write(text, version) {
      const body = {
        branch: cfg.branch, content: text, commit_message: COMMIT_MESSAGE, ...(version && { last_commit_id: version }),
      };
      const res = await request(fileUrl, {
        method: version ? 'PUT' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.status === 400 || res.status === 409) {
        const msg = await res.clone().json().then((j) => j.message || '', () => '');
        if (/changed|already exists|does not exist/i.test(String(msg)) || res.status === 409) {
          throw new ConflictError('The sync file changed on the server.');
        }
      }
      if (!res.ok) throw await failure(res, 'Writing the sync file');
      // The response doesn't give the new commit: read it back. If someone else wrote in between,
      // their commit id makes the next sync merge again, which is harmless.
      return (await backend.read()).version;
    },
  };
  return backend;
}

// ---------- WebDAV ----------

function webdav(cfg) {
  const url = cfg.url;
  const headers = { Authorization: `Basic ${btoa(unescape(encodeURIComponent(`${cfg.username}:${cfg.token}`)))}` };
  const etag = (res) => res.headers.get('ETag');
  return {
    async check() {
      // The folder must exist; the file may not yet.
      const folder = url.replace(/[^/]*$/, '');
      const res = await request(folder, { method: 'PROPFIND', headers: { ...headers, Depth: '0' } });
      if (res.status === 404) throw new BackendError(`The folder ${folder} doesn’t exist on the server. Create it first.`);
      if (!res.ok && res.status !== 207) throw await failure(res, 'Checking the folder');
    },
    async read() {
      const res = await request(url, { headers });
      if (res.status === 404) return { text: null, version: null };
      if (!res.ok) throw await failure(res, 'Reading the sync file');
      return { text: await res.text(), version: etag(res) };
    },
    async write(text, version) {
      const cond = version ? { 'If-Match': version } : { 'If-None-Match': '*' };
      const res = await request(url, { method: 'PUT', headers: { ...headers, ...cond, 'Content-Type': 'application/json' }, body: text });
      if (res.status === 412) throw new ConflictError('The sync file changed on the server.');
      if (!res.ok) throw await failure(res, 'Writing the sync file');
      if (etag(res)) return etag(res);
      const head = await request(url, { method: 'HEAD', headers });
      return head.ok ? etag(head) : null;
    },
  };
}

export function makeBackend(cfg) {
  switch (cfg.backend) {
    case 'github': return github(cfg);
    case 'gitlab': return gitlab(cfg);
    case 'gitea': return gitea(cfg);
    case 'webdav': return webdav(cfg);
    default: throw new BackendError(`Unknown sync backend: ${cfg.backend}`);
  }
}
