// In-memory stand-ins for the sync servers (GitHub, GitLab, Gitea/Forgejo, WebDAV), answering
// `fetch` as their APIs do for the calls src/sync/backends.js makes. One file per server.
//   const remote = fakeRemote('github'); globalThis.fetch = remote.fetch;
//   remote.text / remote.version: the file now (text null: no file)
//   remote.requests: [{ method, url, headers, body }]
//   remote.status: answer every request with this HTTP status instead (e.g. 401), when set
//   remote.offline: fetch rejects, like a network error

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n'); // GitHub wraps lines
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const reply = (status, body, headers = {}) => new Response(
  status === 204 || body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } },
);

export function fakeRemote(backend) {
  let n = 0;
  const remote = {
    backend,
    text: null,
    version: null,
    requests: [],
    status: null,
    offline: false,
    repoExists: true,
    // Puts a file there, as another device would.
    put(text) { remote.text = text; remote.version = `v${++n}`; },
    async fetch(url, init = {}) {
      const req = { method: init.method || 'GET', url: String(url), headers: init.headers || {}, body: init.body };
      remote.requests.push(req);
      if (remote.offline) throw new TypeError('Failed to fetch');
      if (remote.status) return reply(remote.status, { message: 'forced' });
      return handlers[backend](req, new URL(req.url));
    },
  };

  const isFile = (u) => /\/(contents|repository\/files)\//.test(u.pathname);
  const handlers = {
    github(req, u) {
      if (!isFile(u)) return remote.repoExists ? reply(200, { full_name: 'o/r' }) : reply(404, { message: 'Not Found' });
      if (req.method === 'GET') return remote.text == null ? reply(404, { message: 'Not Found' }) : reply(200, { sha: remote.version, size: remote.text.length, content: b64(remote.text) });
      const body = JSON.parse(req.body);
      if (remote.text != null && !body.sha) return reply(422, { message: '"sha" wasn\'t supplied.' });
      if (body.sha && body.sha !== remote.version) return reply(409, { message: 'does not match' });
      remote.put(unb64(body.content));
      return reply(remote.text != null ? 200 : 201, { content: { sha: remote.version } });
    },
    gitea(req, u) {
      if (!isFile(u)) return remote.repoExists ? reply(200, { full_name: 'o/r' }) : reply(404, { message: 'Not Found' });
      if (req.method === 'GET') return remote.text == null ? reply(404, { message: 'Not Found' }) : reply(200, { sha: remote.version, content: b64(remote.text) });
      const body = JSON.parse(req.body);
      if (req.method === 'POST' && remote.text != null) return reply(422, { message: 'repository file already exists' });
      if (req.method === 'PUT' && body.sha !== remote.version) return reply(409, { message: 'sha does not match' });
      remote.put(unb64(body.content));
      return reply(201, { content: { sha: remote.version } });
    },
    gitlab(req, u) {
      if (!isFile(u)) return remote.repoExists ? reply(200, { id: 1 }) : reply(404, { message: '404 Project Not Found' });
      if (req.method === 'GET') return remote.text == null ? reply(404, { message: '404 File Not Found' }) : reply(200, { last_commit_id: remote.version, content: b64(remote.text) });
      const body = JSON.parse(req.body);
      if (req.method === 'POST' && remote.text != null) return reply(400, { message: 'A file with this name already exists' });
      if (req.method === 'PUT' && body.last_commit_id !== remote.version) {
        return reply(400, { message: 'You are attempting to update a file that has changed since you started editing it.' });
      }
      remote.put(body.content);
      return reply(200, { file_path: 'x', branch: body.branch });
    },
    webdav(req, u) {
      if (req.method === 'PROPFIND') return remote.repoExists ? reply(207, '<multistatus/>', { 'Content-Type': 'application/xml' }) : reply(404, null);
      const etag = () => ({ ETag: `"${remote.version}"` });
      if (req.method === 'GET' || req.method === 'HEAD') {
        return remote.text == null ? reply(404, null) : reply(200, req.method === 'GET' ? remote.text : null, etag());
      }
      const h = req.headers;
      if (h['If-None-Match'] === '*' && remote.text != null) return reply(412, null);
      if (h['If-Match'] && h['If-Match'] !== `"${remote.version}"`) return reply(412, null);
      remote.put(req.body);
      return reply(201, null, etag());
    },
  };
  return remote;
}

export const configFor = (backend, over = {}) => (backend === 'webdav'
  ? { backend, url: 'https://dav.example/files/me/tab-collections.json', username: 'me', token: 'pw', ...over }
  : { backend, server: { github: 'https://github.com', gitlab: 'https://gitlab.example', gitea: 'https://codeberg.org' }[backend], repo: 'o/r', branch: 'main', path: 'tab-collections.json', token: 't0k', ...over });
