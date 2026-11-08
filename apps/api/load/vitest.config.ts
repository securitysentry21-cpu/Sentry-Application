import { defineConfig } from 'vitest/config';

// The load and simulator harness (ARCH §19.2, §21.2). Run on request: `pnpm load`. It is not part of
// `pnpm test` or `pnpm verify`, because it takes minutes and measures this computer.
export default defineConfig({
  test: {
    name: 'load',
    root: import.meta.dirname,
    include: ['*.load.ts'],
    globalSetup: ['../../../packages/db/test-support/global-setup.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    teardownTimeout: 120_000,
    fileParallelism: false,
  },
});
