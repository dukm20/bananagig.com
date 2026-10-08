import { defineConfig } from 'vitest/config';

// The template and markup tests validate maximum-size bodies (200,000 characters, several markup renders, catastrophic-backtracking guards). That takes about
// 0.6 s on a developer machine and more than Vitest's default 5 s on a loaded 2-CPU CI runner, where Turborepo runs the packages' tests in parallel (CI run
// 37718747872 failed `template.test.ts:391` with "Test timed out in 5000ms"; CI run #5 failed the same file on a wall-clock assertion, CI-003). The timeout
// is only the harness ceiling: what the tests assert is deterministic (render counts, rejection reasons), never elapsed time.
export default defineConfig({ test: { testTimeout: 30_000 } });
