import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    env: {
      DATABASE_URL:
        process.env['DATABASE_URL'] ??
        'postgres://sitetrack:sitetrack@localhost:5432/sitetrack',
    },
    // Each test file runs in its own worker with an isolated module graph
    isolate: true,
    fileParallelism: false,
    // Sequential within a file
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['dist/**', 'node_modules/**'],
    },
  },
});
