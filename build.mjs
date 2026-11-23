// Builds browser-specific packages from src/ into dist/<target>/ (and dist/*.zip).
//   node build.mjs            -> all targets
//   node build.mjs firefox    -> one target (chromium | firefox | safari)
//
// The background script is bundled into one classic (non-module) file, because
// Safari doesn't support module service workers and Firefox uses event pages.

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };

const base = {
  manifest_version: 3,
  name: 'Tab Collections',
  version: pkg.version,
  description: 'Group web sites into collections and open each collection as its own window.',
  permissions: ['alarms', 'storage', 'tabs', 'unlimitedStorage'],
  // Sync: access to the one server the user sets up, asked for at setup (permissions.request).
  optional_host_permissions: ['https://*/*'],
  action: { default_title: 'Tab Collections', default_popup: 'popup.html', default_icon: icons },
  icons,
  options_ui: { page: 'collections.html', open_in_tab: true },
};

const targets = {
  chromium: {
    ...base,
    permissions: [...base.permissions, 'favicon'], // Chromium-only favicon cache
    background: { service_worker: 'background.js' },
  },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] }, // Firefox MV3 uses event pages, not service workers
    browser_specific_settings: {
      gecko: {
        id: 'tab-collections@local',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] }, // collects nothing
      },
    },
  },
  safari: {
    ...base,
    permissions: ['alarms', 'storage', 'tabs'],
    background: { service_worker: 'background.js' },
  },
};

const wanted = process.argv.slice(2);
const list = wanted.length ? wanted : Object.keys(targets);

for (const name of list) {
  const manifest = targets[name];
  if (!manifest) throw new Error(`Unknown target "${name}". Use: ${Object.keys(targets).join(', ')}`);
  const out = path.join(DIST, name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await cp(SRC, out, { recursive: true, filter: (f) => !f.endsWith('background.js') });
  await build({
    entryPoints: [path.join(SRC, 'background.js')],
    bundle: true,
    format: 'iife',
    target: ['chrome110', 'firefox140', 'safari16'],
    outfile: path.join(out, 'background.js'),
    logLevel: 'warning',
  });
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const zip = path.join(DIST, `tab-collections-${name}-${pkg.version}.zip`);
  await rm(zip, { force: true });
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
  } catch {
    console.warn('  (zip not available — skipped archive)');
  }
  console.log(`✓ ${name.padEnd(9)} → dist/${name}/`);
}
