// End-to-end flows in Chromium (X1–X13 in docs/testing-plan.md, except X11). Run `npm run build` first
// (`npm run test:e2e` does).
import { expect, test } from './fixtures.js';

const card = (page, name) => page.locator('.card', { has: page.locator('.card-name', { hasText: name }) });
const cardToggle = (page, name) => card(page, name).locator('input[role=switch]');
const urls = (col) => col.pages.map((p) => p.url);

test('X1 create a collection on the Collection page', async ({ ext, site }) => {
  const page = await ext.open('collection.html?new=1');
  await page.fill('#name', 'Made by hand');
  for (const n of ['a', 'b', 'c']) {
    await page.fill('#addUrl', site(n));
    await page.click('#addForm button[type=submit]');
  }
  await page.click('#save');
  await expect(page.locator('#toast')).toHaveText('Collection created');
  const list = await ext.open('collections.html');
  await expect(card(list, 'Made by hand').locator('.card-pages')).toHaveText('3 pages');
});

test('X2, X3 the toggle opens exactly the saved pages; closing unchanged asks nothing', async ({ ext, site }) => {
  const col = await ext.seedCollection('Three', [site('a'), site('b'), site('c')]);
  const list = await ext.open('collections.html');
  await cardToggle(list, 'Three').check();
  const w = await ext.windowWith(urls(col));
  await expect(cardToggle(list, 'Three')).toBeChecked();
  await expect(card(list, 'Three').locator('.card-state')).toHaveText('Open');

  await ext.closeWindow(w);
  await expect(cardToggle(list, 'Three')).not.toBeChecked();
  await list.waitForTimeout(500);
  expect(await ext.promptWindows()).toHaveLength(0);
  expect(await ext.get('pending') ?? {}).toEqual({});
});

for (const choice of ['Update', 'Restore']) {
  test(`X4, X5 a changed window asks on close: ${choice}`, async ({ ext, site }) => {
    const col = await ext.seedCollection('Three', [site('a'), site('b'), site('c')]);
    const list = await ext.open('collections.html');
    await cardToggle(list, 'Three').check();
    const w = await ext.windowWith(urls(col));
    await ext.addTab(w, site('d'));
    await ext.tracked(w, site('d'));
    await ext.closeWindow(w);

    const prompt = await ext.prompt();
    await expect(prompt.locator('h2').nth(1)).toHaveText('1 page added');
    await prompt.getByRole('button', { name: choice, exact: true }).click();
    await expect.poll(async () => Object.keys(await ext.get('pending') ?? {}).length).toBe(0);
    const stored = (await ext.get('collections'))[col.id];
    expect(stored.pages.map((p) => p.url)).toEqual(choice === 'Update' ? [...urls(col), site('d')] : urls(col));
  });
}

test('X6 a prompt closed unanswered leaves the drift on the Collections page', async ({ ext, site }) => {
  const col = await ext.seedCollection('Three', [site('a'), site('b'), site('c')]);
  const list = await ext.open('collections.html');
  await cardToggle(list, 'Three').check();
  const w = await ext.windowWith(urls(col));
  await ext.addTab(w, site('d'));
  await ext.tracked(w, site('d'));
  await ext.closeWindow(w);
  const prompt = await ext.prompt();
  await prompt.close();

  const strip = card(list, 'Three').locator('.drift-strip');
  await expect(strip.getByRole('button')).toHaveText(['Details', 'Update', 'Restore']);
  await strip.getByRole('button', { name: 'Update' }).click();
  await expect(list.locator('#toast')).toHaveText('Collection updated');
  await expect(card(list, 'Three').locator('.card-pages')).toHaveText('4 pages');
  await expect(strip).toHaveCount(0);
});

test('X7 regression: an 89-page drift does not open; the 3 saved pages do', async ({ ext, site }) => {
  const col = await ext.seedCollection('Three', [site('a'), site('b'), site('c')]);
  const pages = Array.from({ length: 89 }, (_, i) => ({ url: site(`unrelated-${i}`), title: '' }));
  await ext.set({ pending: { p1: { id: 'p1', collectionId: col.id, collectionName: 'Three', pages, live: false, windowId: 999, closedAt: 1, baseline: null } } });
  const list = await ext.open('collections.html');
  await cardToggle(list, 'Three').check();
  await ext.windowWith(urls(col));
  await list.waitForTimeout(500);
  const tabs = (await ext.windows()).flatMap((x) => x.urls);
  expect(tabs.filter((u) => u.includes('unrelated-'))).toHaveLength(0);
  await expect(card(list, 'Three').locator('.drift-strip')).toHaveCount(1);
});

test('X8 regression: a stale session shows closed, and the toggle works', async ({ ext, site }) => {
  const col = await ext.seedCollection('Three', [site('a'), site('b'), site('c')]);
  await ext.set({ sessions: { 987654: { collectionId: col.id, baseline: urls(col), initial: {}, openedAt: 1, tabs: [] } } });
  const list = await ext.open('collections.html');
  await expect(cardToggle(list, 'Three')).not.toBeChecked();
  await expect(card(list, 'Three').locator('.card-state')).toHaveText('Closed');
  await cardToggle(list, 'Three').check();
  await ext.windowWith(urls(col));
  await expect(list.locator('#toast')).not.toHaveClass(/show/);
});

test('X9 the popup saves a window as a collection and tracks it', async ({ ext, site, worker, context }) => {
  const popupUrl = ext.url('popup.html');
  const w = await worker.evaluate(async (u) => (await chrome.windows.create({ url: u, focused: true })).id, [site('a'), site('b'), popupUrl]);
  await expect.poll(() => context.pages().some((p) => p.url() === popupUrl)).toBe(true);
  const popup = context.pages().find((p) => p.url() === popupUrl);
  await expect(popup.locator('#current')).toHaveText("Save this window's 2 tabs as a new collection:");
  await popup.fill('#saveName', 'From popup');
  await popup.click('#saveForm button[type=submit]');
  await expect.poll(async () => Object.values(await ext.get('collections') ?? {}).map((c) => c.name)).toEqual(['From popup']);
  const [col] = Object.values(await ext.get('collections'));
  expect(urls(col)).toEqual([site('a'), site('b')]);
  expect((await ext.get('sessions'))[w].collectionId).toBe(col.id);
});

test('X10 export, then import into an empty profile, keeps the collections', async ({ ext, site }) => {
  await ext.seedCollection('One', [site('a')]);
  await ext.seedCollection('Two', [site('b'), site('c')]);
  const list = await ext.open('collections.html');
  const [download] = await Promise.all([list.waitForEvent('download'), list.click('#export')]);
  const exported = JSON.parse(Buffer.concat(await (await download.createReadStream()).toArray()).toString());
  expect(exported.collections.map((c) => c.name).sort()).toEqual(['One', 'Two']);

  await ext.set({ collections: {} });
  exported.collections.push({ name: 'Empty', pages: [] });
  list.on('dialog', (d) => d.accept());
  await list.setInputFiles('#importFile', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(list.locator('#toast')).toHaveText('Imported 2 collections, skipped 1 without pages');
  await expect(list.locator('.card')).toHaveCount(2);
});

// X11 (reloading the extension) is manual: Playwright gets no working service worker back after
// chrome.runtime.reload(). B41 covers what onInstalled does then.

test('X12 a 50-page window closes promptly with one prompt', async ({ ext, site }) => {
  const pages = Array.from({ length: 50 }, (_, i) => site(`p${i}`));
  await ext.seedCollection('Fifty', pages);
  const list = await ext.open('collections.html');
  await cardToggle(list, 'Fifty').check();
  const w = await ext.windowWith(pages);
  await ext.addTab(w, site('extra'));
  await ext.tracked(w, site('extra'));
  const started = Date.now();
  await ext.closeWindow(w);
  await ext.prompt();
  expect(Date.now() - started).toBeLessThan(2000);
  await expect(cardToggle(list, 'Fifty')).not.toBeChecked();
  expect(await ext.promptWindows()).toHaveLength(1);
  expect(Object.values(await ext.get('pending'))).toHaveLength(1);
});

test('X13 the Sync panel loads in a real browser, with GitHub preselected, and checks its settings', async ({ ext }) => {
  const page = await ext.open('collections.html');
  const panel = page.locator('#syncPanel');
  await expect(panel.locator('select[name=backend]')).toHaveValue('github');
  await expect(page.locator('#sync')).toBeHidden();
  await panel.locator('[name=repo]').fill('no-slash');
  await panel.locator('[name=token]').fill('secret');
  await panel.locator('button[type=submit]').click();
  await expect(page.locator('#toast')).toHaveText('Enter the repository as owner/name.');
});
