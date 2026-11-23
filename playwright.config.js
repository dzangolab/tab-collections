// End-to-end tests: the built dist/chromium in Playwright's Chromium (see test/e2e/fixtures.js).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  retries: process.env.CI ? 1 : 0,
  testDir: 'test/e2e',
  timeout: 30_000,
  workers: 2,
});
