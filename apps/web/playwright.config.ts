// Browser tests of the dashboard's critical flows (ARCH §21.1), against a local stack that
// e2e/stack.ts builds and seeds: a throwaway PostgreSQL, the API, the worker and the dashboard.
// Run: `pnpm e2e` (the first time, `pnpm --filter @sentryops/web exec playwright install chromium`).
import { defineConfig, devices } from '@playwright/test';

import { CONTROL_PORT, WEB_PORT } from './e2e/constants.ts';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  // The dashboard compiles each page the first time it is asked for, in development mode.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // One company, one guard, one shift: the specs share them, in order.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalTeardown: './e2e/teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/stack.ts',
    url: `http://127.0.0.1:${CONTROL_PORT}/ready`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
