import { defineConfig } from 'vitest/config';

// Tests of the repository's own checks (scripts/): the dependency audit's decision.
export default defineConfig({
  test: {
    name: 'scripts',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
