import { defineConfig } from 'vitest/config';

// Unit tests for the guard app's platform-independent core (src/core). They run in Node: no React
// Native, no Expo modules. The outbox tests use Node's built-in SQLite, so the same SQL that runs on
// the phone (expo-sqlite) runs here.
export default defineConfig({
  test: {
    name: 'mobile',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
