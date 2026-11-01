import { defineConfig } from 'vitest/config';

// Unit tests for the dashboard's pure parts (the live model, the stream parser) and for how it
// renders user text. They run in Node: components render to HTML with react-dom/server, no browser.
export default defineConfig({
  test: {
    name: 'web',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
