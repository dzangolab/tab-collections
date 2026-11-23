// Store screenshots (test/screenshots/store.spec.js), run with `npm run screenshots`. Separate from
// the end-to-end tests: it needs the network (for favicons) and writes files.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: 'list',
  testDir: 'test/screenshots',
  workers: 1,
});
