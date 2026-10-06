import { defineConfig } from 'vitest/config';

// Integration tests: real Postgres + NATS (pnpm dev:deps). Each test FILE creates its own isolated, migrated database,
// so database state is never shared. Files still run serially because they share one NATS server and pg-boss queue names.
export default defineConfig({
  test: {
    include: ['apps/**/*.itest.ts', 'packages/**/*.itest.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    globalSetup: ['./vitest.integration.setup.ts'],
  },
});
