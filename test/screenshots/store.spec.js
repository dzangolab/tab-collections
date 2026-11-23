// Screenshots (1280×800, saved to store/screenshots/) and promo tiles (440×280 and 1400×560, saved
// to store/promo/) for the Chrome Web Store listing.
// Run with `npm run screenshots`. Uses demo collections, never real data. The demo sites are
// visited once first, so the browser has their favicons (without a network, pages show the globe).
import { test, expect } from '../e2e/fixtures.js';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../store/screenshots');
const PROMO = path.resolve(OUT, '../promo');
const SIZE = { width: 1280, height: 800 };
const MIN = 60_000;

const page_ = (url, title) => ({ url, title });
const DEMO = [
  {
    id: 'atlas', name: 'Project Atlas', description: 'Everything for the Atlas redesign: code, tickets and designs',
    pages: [
      page_('https://github.com/', 'GitHub'),
      page_('https://linear.app/', 'Linear – Plan and build products'),
      page_('https://www.figma.com/', 'Figma: The Collaborative Interface Design Tool'),
      page_('https://vercel.com/', 'Vercel: Build and deploy the best web experiences'),
      page_('https://www.notion.so/', 'Notion – The all-in-one workspace'),
    ],
  },
  {
    id: 'rust', name: 'Learning Rust', description: 'The book, exercises and the playground',
    pages: [
      page_('https://doc.rust-lang.org/book/', 'The Rust Programming Language'),
      page_('https://play.rust-lang.org/', 'Rust Playground'),
      page_('https://exercism.org/tracks/rust', 'Rust on Exercism'),
      page_('https://crates.io/', 'crates.io: Rust Package Registry'),
      page_('https://github.com/rust-lang/rustlings', 'rust-lang/rustlings: Small exercises to get you used to reading and writing Rust code'),
      page_('https://www.youtube.com/', 'YouTube'),
    ],
  },
  {
    id: 'lisbon', name: 'Trip to Lisbon', description: 'Flights, places to stay and things to see in May',
    pages: [
      page_('https://www.lonelyplanet.com/portugal/lisbon', 'Lisbon travel guide – Lonely Planet'),
      page_('https://www.airbnb.com/', 'Airbnb | Vacation rentals, cabins, beach houses, & more'),
      page_('https://www.tripadvisor.com/', 'Tripadvisor'),
      page_('https://en.wikipedia.org/wiki/Lisbon', 'Lisbon – Wikipedia'),
      page_('https://www.google.com/maps', 'Google Maps'),
      page_('https://www.timeout.com/lisbon', 'Time Out Lisbon'),
      page_('https://www.cp.pt/', 'CP – Comboios de Portugal'),
    ],
  },
  {
    id: 'reading', name: 'Morning reading', description: 'News and blogs, opened every morning',
    pages: [
      page_('https://news.ycombinator.com/', 'Hacker News'),
      page_('https://www.theverge.com/', 'The Verge'),
      page_('https://arstechnica.com/', 'Ars Technica'),
      page_('https://www.bbc.com/news', 'BBC News'),
    ],
  },
  {
    id: 'kitchen', name: 'Kitchen renovation', description: '',
    pages: [
      page_('https://www.ikea.com/', 'IKEA'),
      page_('https://www.pinterest.com/', 'Pinterest'),
      page_('https://www.houzz.com/', 'Houzz'),
    ],
  },
  {
    id: 'recipes', name: 'Recipes to try', description: 'Weekend cooking',
    pages: [
      page_('https://www.seriouseats.com/', 'Serious Eats'),
      page_('https://www.bbcgoodfood.com/', 'BBC Good Food'),
    ],
  },
];
const READING_NOW = [ // the "Morning reading" window when it was closed: one page swapped, one added
  page_('https://news.ycombinator.com/', 'Hacker News'),
  page_('https://www.theverge.com/', 'The Verge'),
  page_('https://www.bbc.com/news', 'BBC News'),
  page_('https://www.economist.com/', 'The Economist'),
  page_('https://lwn.net/', 'LWN.net'),
];

test.describe.configure({ timeout: 4 * MIN });

test('store screenshots', async ({ context, ext, worker }) => {
  await mkdir(OUT, { recursive: true });

  // Favicons: visit each site once, so the browser's favicon cache has them.
  const urls = [...new Set([...DEMO.flatMap((c) => c.pages), ...READING_NOW].map((p) => p.url))];
  const visitor = await context.newPage();
  for (const url of urls) await visitor.goto(url, { waitUntil: 'load', timeout: 15_000 }).catch(() => {});
  await visitor.close();

  const now = Date.now();
  const collections = Object.fromEntries(DEMO.map((c, i) => [c.id, { ...c, createdAt: now - (30 - i) * 86_400_000, updatedAt: now - i * 3_600_000 }]));
  const snapshot = { collections, tombstones: {} };
  await ext.set({
    collections,
    tombstones: {},
    pending: {
      p1: { id: 'p1', collectionId: 'reading', collectionName: 'Morning reading', pages: READING_NOW, closedAt: now - 10 * MIN, baseline: null, live: false, windowId: null },
    },
    // Sync set up and up to date, so the status says so. No alarm is scheduled, so nothing syncs.
    syncConfig: { backend: 'github', server: 'https://github.com', repo: 'me/tab-collections', branch: 'main', path: 'tab-collections.json', token: 'github_pat_demo_not_a_real_token_0000000000', passphrase: 'demo passphrase, not real', mode: 'auto' },
    syncState: { base: snapshot, version: 'demo', synced: snapshot, conflicts: {}, lastSyncAt: now - 2 * MIN, lastError: null, remoteChanged: false },
  });

  const shoot = async (page, name) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.screenshot({ path: path.join(OUT, name) });
  };

  // 1. The Collections page.
  const list = await ext.open('collections.html');
  await list.setViewportSize(SIZE);
  await expect(list.locator('#syncStatus')).toHaveText('Synced 2 min ago');
  await expect(list.locator('.drift-strip')).toHaveCount(1);
  await shoot(list, '1-collections.png');

  // 2. A Collection page.
  const one = await ext.open('collection.html?id=lisbon');
  await one.setViewportSize(SIZE);
  await expect(one.locator('#name')).toHaveValue('Trip to Lisbon');
  await shoot(one, '2-collection.png');

  // 3. The "Update collection?" prompt for the changed window.
  const prompt = await ext.open('prompt.html?id=p1');
  await prompt.setViewportSize(SIZE);
  await expect(prompt.locator('h2').first()).toHaveText('Update “Morning reading” collection');
  await prompt.screenshot({ path: path.join(OUT, '3-prompt.png') }); // at once: the prompt closes itself on blur

  // 4. The toolbar popup, shown beside a caption. It's opened as the first tab of a window with a
  // few pages, so it offers to save them, and zoomed 1.25× so it stays sharp at 400 px wide.
  const opened = context.waitForEvent('page', (p) => p.url().startsWith(ext.url('popup.html')));
  await worker.evaluate((urls) => chrome.windows.create({ url: urls }),
    [ext.url('popup.html'), 'https://doc.rust-lang.org/book/', 'https://play.rust-lang.org/', 'https://crates.io/']);
  const popup = await opened;
  await popup.setViewportSize({ width: 400, height: 800 });
  await popup.waitForLoadState();
  await popup.evaluate(() => { document.body.style.zoom = '1.25'; });
  await expect(popup.locator('#list .item')).toHaveCount(DEMO.length);
  await expect(popup.locator('#current')).toContainText('3 tabs');
  const popupPng = await popup.locator('.wrap').screenshot();
  const icon = await readFile(path.resolve(OUT, '../../src/icons/icon128.png'));
  const stage = await context.newPage();
  await stage.setViewportSize(SIZE);
  await stage.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;justify-content:center;gap:96px;
    background:linear-gradient(135deg,#eef3fd,#dfe8fb);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1c1e">
    <div style="max-width:440px">
      <img src="data:image/png;base64,${icon.toString('base64')}" width="64" height="64" alt="">
      <h1 style="font-size:40px;line-height:1.15;margin:20px 0 16px">Every collection, one click away</h1>
      <p style="font-size:20px;line-height:1.5;color:#4a4a52;margin:0">Open a collection as its own window, or save the tabs you have open as a new one, right from the toolbar.</p>
    </div>
    <img src="data:image/png;base64,${popupPng.toString('base64')}" alt="" style="width:400px;border-radius:12px;box-shadow:0 24px 60px rgba(30,50,90,.25),0 2px 8px rgba(30,50,90,.12);background:#fff">
  </body></html>`);
  await stage.screenshot({ path: path.join(OUT, '4-popup.png') });

  // 5. The Sync panel.
  const sync = await ext.open('collections.html');
  await sync.setViewportSize(SIZE);
  // Edit settings open (it shows where to sync, the token, encryption and the mode), scrolled to
  // the Sync heading.
  await expect(sync.locator('#syncPanel')).toContainText('Syncing with GitHub');
  await sync.locator('#syncPanel').getByRole('button', { name: 'Edit settings' }).click();
  await expect(sync.locator('#syncPanel')).toContainText('Edit sync settings');
  await sync.evaluate(() => {
    const heading = document.querySelector('#syncPanel').previousElementSibling;
    window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 24);
  });
  await sync.locator(':focus').evaluate((el) => el.blur()).catch(() => {});
  await shoot(sync, '5-sync.png');

  // Promo tiles, in the extension's blue: the small tile (440×280) and the marquee (1400×560).
  await mkdir(PROMO, { recursive: true });
  const listPng = await readFile(path.join(OUT, '1-collections.png'));
  const img = (png) => `data:image/png;base64,${png.toString('base64')}`;
  const tile = async (name, size, body) => {
    const p = await context.newPage();
    await p.setViewportSize(size);
    await p.setContent(`<!doctype html><html><body style="margin:0;width:${size.width}px;height:${size.height}px;overflow:hidden;
      background:radial-gradient(circle at 20% 15%,#4d87ec 0,#2f6fde 45%,#1d4fae 100%);color:#fff;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${body}</body></html>`);
    await p.screenshot({ path: path.join(PROMO, name) });
  };
  const logo = (px) => `<img src="${img(icon)}" width="${px}" height="${px}" alt=""
    style="border-radius:${px * 0.22}px;box-shadow:0 0 0 ${Math.round(px / 24)}px rgba(255,255,255,.9),0 8px 24px rgba(0,0,0,.25)">`;

  await tile('small-440x280.png', { width: 440, height: 280 }, `
    <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center">
      ${logo(84)}
      <div>
        <div style="font-size:34px;font-weight:700;letter-spacing:-.01em">Tab Collections</div>
        <div style="font-size:18px;opacity:.9;margin-top:6px">Your tabs, grouped and saved</div>
      </div>
    </div>`);

  await tile('marquee-1400x560.png', { width: 1400, height: 560 }, `
    <div style="position:absolute;left:96px;top:0;bottom:0;width:520px;display:flex;flex-direction:column;justify-content:center">
      ${logo(88)}
      <div style="font-size:60px;font-weight:700;letter-spacing:-.02em;margin-top:32px">Tab Collections</div>
      <div style="font-size:26px;line-height:1.4;opacity:.92;margin-top:14px">Save groups of tabs as collections, open each one as its own window, and sync them through storage you own.</div>
    </div>
    <img src="${img(listPng)}" alt="" style="position:absolute;left:700px;top:70px;width:780px;border-radius:14px;
      box-shadow:0 30px 70px rgba(0,0,0,.35)">
    <img src="${img(popupPng)}" alt="" style="position:absolute;left:640px;top:150px;width:300px;border-radius:12px;background:#fff;
      box-shadow:0 30px 70px rgba(0,0,0,.4),0 2px 8px rgba(0,0,0,.2)">`);

  // The store icon, as Google's guidelines want it: 128×128, the artwork 96×96 in the middle, with
  // 16 px of transparent space around it. The toolbar keeps the full-size src/icons/icon128.png.
  const storeIcon = await context.newPage();
  await storeIcon.setViewportSize({ width: 128, height: 128 });
  await storeIcon.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <img src="${img(icon)}" width="96" height="96" alt="" style="display:block;margin:16px"></body></html>`);
  await storeIcon.screenshot({ path: path.resolve(OUT, '../icon-128.png'), omitBackground: true });
});
