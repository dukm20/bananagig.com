import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['apps/**/*.itest.ts', 'packages/**/*.itest.ts'], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false },
});
