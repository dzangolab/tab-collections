// Playwright fixtures: a Chromium with the built extension loaded, its service worker (to seed
// storage and drive windows through the chrome.* API), and a local web site for the pages.
import { test as base, chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/chromium');

export const test = base.extend({
  // site('a') → http://127.0.0.1:<port>/a, a page titled "a".
  site: async ({}, use) => {
    const server = createServer((req, res) => {
      const name = decodeURIComponent(req.url.slice(1)) || 'home';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>${name}</title><h1>${name}</h1>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const root = `http://127.0.0.1:${server.address().port}/`;
    await use((name) => root + name);
    server.close();
  },

  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // the new headless mode, which runs extensions
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(context);
    await context.close();
  },

  worker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },

  ext: async ({ context, worker }, use) => {
    const origin = worker.url().split('/').slice(0, 3).join('/'); // URL#origin is "null" for chrome-extension:
    const ext = {
      url: (p) => `${origin}/${p}`,
      // An extension page in a new tab.
      open: async (p) => {
        const page = await context.newPage();
        await page.goto(`${origin}/${p}`);
        return page;
      },
      get: (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key),
      set: (data) => worker.evaluate((d) => chrome.storage.local.set(d), data),
      windows: () => worker.evaluate(async () => (await chrome.windows.getAll({ populate: true }))
        .map((w) => ({ id: w.id, urls: w.tabs.map((t) => t.pendingUrl || t.url) }))),
      closeWindow: (id) => worker.evaluate((w) => chrome.windows.remove(w), id),
      addTab: (windowId, url) => worker.evaluate(async ([w, u]) => (await chrome.tabs.create({ windowId: w, url: u })).id, [windowId, url]),
      // A collection stored directly, with pages at these URLs.
      seedCollection: async (name, urls) => {
        const col = { id: `c-${name}`, name, description: '', pages: urls.map((url) => ({ url, title: '' })), createdAt: 1, updatedAt: 1 };
        await worker.evaluate(async (c) => {
          const { collections = {} } = await chrome.storage.local.get('collections');
          collections[c.id] = c;
          await chrome.storage.local.set({ collections });
        }, col);
        return col;
      },
    };
    // The id of the window holding exactly these URLs, once there is one.
    ext.windowWith = async (urls) => {
      let found;
      await expect.poll(async () => {
        found = (await ext.windows()).find((w) => JSON.stringify(w.urls) === JSON.stringify(urls));
        return !!found;
      }).toBe(true);
      return found.id;
    };
    // Once the worker has recorded this URL among the window's tabs.
    ext.tracked = (windowId, url) => expect.poll(async () => ((await ext.get('sessions'))?.[windowId]?.tabs ?? [])
      .some((t) => t.url === url)).toBe(true);
    ext.promptWindows = async () => (await ext.windows()).filter((w) => w.urls.some((u) => u.startsWith(ext.url('prompt.html'))));
    // The prompt page, once it opens.
    ext.prompt = async () => {
      const find = () => context.pages().find((p) => p.url().startsWith(ext.url('prompt.html')));
      await expect.poll(() => !!find()).toBe(true);
      const page = find();
      await page.waitForLoadState();
      return page;
    };
    await use(ext);
  },
});

export { expect };
