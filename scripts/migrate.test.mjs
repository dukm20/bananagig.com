import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

describe('migration files', () => {
  it('are numbered, ordered, and non-empty', () => {
    const files = readdirSync('db/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((f, i) => {
      expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(Number(f.slice(0, 4))).toBe(i + 1);
      expect(readFileSync(`db/migrations/${f}`, 'utf8').trim().length).toBeGreaterThan(0);
    });
  });
});
