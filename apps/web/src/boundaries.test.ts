import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Same style as the browser-storage scan in auth.test.ts: the web app talks to the API only (also enforced by lint and `pnpm deps:check`).
const FORBIDDEN = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@bananagig\/(database|platform|configuration|content)(?:\/[^'"]*)?['"]/;

describe('workspace boundaries', () => {
  it('no source file under apps/web/src imports the database, platform, configuration or content packages', () => {
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const full = path.join(dir, n);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(n) && n !== 'boundaries.test.ts') {
          scanned++;
          if (FORBIDDEN.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(import.meta.dirname, full));
        }
      }
    };
    walk(import.meta.dirname);
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
  it('the scanner pattern catches every import form', () => {
    for (const bad of [
      `import { x } from '@bananagig/database';`,
      `import x from "@bananagig/platform/sub";`,
      `const m = await import('@bananagig/configuration');`,
      `const m = require('@bananagig/content');`,
      `import '@bananagig/content';`,
    ])
      expect(FORBIDDEN.test(bad)).toBe(true);
    for (const ok of [`import { x } from '@bananagig/contracts';`, `import { y } from '@bananagig/config';`, `// @bananagig/database in a comment`])
      expect(FORBIDDEN.test(ok)).toBe(false);
  });
  it('package.json does not depend on the forbidden packages', () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /^@bananagig\/(database|platform|configuration|content)$/.test(d))).toEqual([]);
  });
});
