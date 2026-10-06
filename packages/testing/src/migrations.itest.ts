import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { HEADER_FIELDS, loadMigrations, MIGRATION_LOCK_KEY, runMigrations } from '../../../scripts/lib/migrator.mjs';
import { snapshotDatabase } from '../../../scripts/lib/snapshot.mjs';
import { createIsolatedDatabase, migrationsDir, rejection } from './index';

const scratchDirs: string[] = [];
const tmpMigrations = (copyReal = true): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-mig-'));
  scratchDirs.push(dir);
  if (copyReal) cpSync(migrationsDir(), dir, { recursive: true });
  return dir;
};
const HEADER = HEADER_FIELDS.map((f) => `-- ${f}: test`).join('\n');
afterAll(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('migrations from zero', () => {
  it('apply in order, record version/filename/checksum/duration, and rerun as a no-op', async () => {
    const iso = await createIsolatedDatabase({ migrate: false });
    try {
      const first = await runMigrations({ url: iso.url, dir: migrationsDir() });
      const expected = readdirSync(migrationsDir())
        .filter((f) => f.endsWith('.sql'))
        .sort();
      expect(first.applied).toEqual(expected);
      const rows = await iso.database.query<{ version: number; filename: string; checksum: string; duration_ms: number | null }>(
        'SELECT version, filename, checksum, duration_ms FROM schema_migrations ORDER BY version',
      );
      expect(rows.map((r) => r.filename)).toEqual(expected);
      expect(rows.map((r) => r.version)).toEqual(expected.map((_, i) => i + 1));
      expect(rows[0]!.duration_ms).toBeNull(); // 0001 was recorded before duration tracking existed
      for (const r of rows.slice(1)) expect(r.duration_ms).toBeGreaterThanOrEqual(0);
      expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);
      const again = await runMigrations({ url: iso.url, dir: migrationsDir() });
      expect(again.applied).toEqual([]);
      expect(again.skipped).toEqual(expected);
      expect(Number((await iso.database.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations'))[0]!.n)).toBe(expected.length);
    } finally {
      await iso.drop();
    }
  });

  it('keeps PostGIS available and the bookkeeping table constrained', async () => {
    const iso = await createIsolatedDatabase();
    try {
      const v = await iso.database.query<{ v: string }>('SELECT PostGIS_Version() AS v');
      expect(v[0]!.v).toMatch(/^3\./);
      const cons = (await iso.database.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid = 'public.schema_migrations'::regclass"))
        .map((r) => r.conname)
        .sort();
      expect(cons).toEqual([
        'ck_schema_migrations__duration_ms_nonnegative',
        'ck_schema_migrations__filename_matches_version',
        'ck_schema_migrations__version_positive',
        'pk_schema_migrations',
        'uq_schema_migrations__filename',
      ]);
      const bad = (await rejection(iso.database.query("INSERT INTO schema_migrations (version, filename, checksum) VALUES (99, '0001_wrong.sql', 'x')"))) as {
        code?: string;
      };
      expect(bad.code).toBe('23514'); // check_violation: filename must start with the zero-padded version
    } finally {
      await iso.drop();
    }
  });
});

describe('migration immutability and validation', () => {
  it('rejects a modified applied migration', async () => {
    const iso = await createIsolatedDatabase({ migrate: false });
    try {
      const dir = tmpMigrations();
      await runMigrations({ url: iso.url, dir });
      const f = path.join(dir, '0002_database_foundation.sql');
      writeFileSync(f, `${readFileSync(f, 'utf8')}\n-- sneaky edit\n`);
      const err = (await rejection(runMigrations({ url: iso.url, dir }))) as Error;
      expect(err.message).toContain('Applied migration 0002_database_foundation.sql was modified');
    } finally {
      await iso.drop();
    }
  });
  it('rejects a deleted or renamed applied migration', async () => {
    const iso = await createIsolatedDatabase({ migrate: false });
    try {
      const dir = tmpMigrations();
      await runMigrations({ url: iso.url, dir });
      rmSync(path.join(dir, '0003_integration_outbox.sql'));
      const err = (await rejection(runMigrations({ url: iso.url, dir }))) as Error;
      expect(err.message).toContain('applied migration 0003_integration_outbox.sql has no file');
    } finally {
      await iso.drop();
    }
  });
  it('rejects duplicate versions, gaps, bad names, missing headers and unmarked destructive statements', () => {
    const dup = tmpMigrations();
    writeFileSync(path.join(dup, '0003_other.sql'), `${HEADER}\nSELECT 1;\n`);
    expect(loadMigrations(dup).errors.join('\n')).toContain('duplicate migration version 0003');

    const gap = tmpMigrations();
    writeFileSync(path.join(gap, '0009_gap.sql'), `${HEADER}\nSELECT 1;\n`);
    expect(loadMigrations(gap).errors.join('\n')).toContain('contiguous');

    const name = tmpMigrations();
    writeFileSync(path.join(name, '4_bad-name.sql'), 'SELECT 1;');
    expect(loadMigrations(name).errors.join('\n')).toContain('invalid migration file name');

    const header = tmpMigrations();
    writeFileSync(path.join(header, '0004_nohdr.sql'), 'SELECT 1;\n');
    expect(loadMigrations(header).errors.join('\n')).toContain('missing header comment "-- rollback strategy: <text>"');

    const destructive = tmpMigrations();
    writeFileSync(path.join(destructive, '0004_drop.sql'), `${HEADER}\nDROP TABLE something;\n`);
    expect(loadMigrations(destructive).errors.join('\n')).toContain('destructive statement');
    writeFileSync(
      path.join(destructive, '0004_drop.sql'),
      `${HEADER}\n-- destructive: contract phase of expand/migrate/contract, data verified in INF-999\nDROP TABLE something;\n`,
    );
    expect(loadMigrations(destructive).errors).toEqual([]);
  });
  it('the real migrations pass validation', () => {
    expect(loadMigrations(migrationsDir()).errors).toEqual([]);
  });
});

describe('migration safety', () => {
  it('a failing migration rolls back completely and is not recorded', async () => {
    const iso = await createIsolatedDatabase({ migrate: false });
    try {
      const dir = tmpMigrations(false);
      writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE a (id int);\n');
      writeFileSync(path.join(dir, '0002_boom.sql'), `${HEADER}\nCREATE TABLE b (id int);\nSELECT 1/0;\n`);
      const err = (await rejection(runMigrations({ url: iso.url, dir }))) as Error;
      expect(err.message).toContain('0002_boom.sql failed and was rolled back');
      const tables = (
        await iso.database.query<{ t: string }>(
          "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('a','b')",
        )
      ).map((r) => r.t);
      expect(tables).toEqual(['a']); // 0001 committed, 0002 left nothing behind
      const recorded = (await iso.database.query<{ filename: string }>('SELECT filename FROM schema_migrations')).map((r) => r.filename);
      expect(recorded).toEqual(['0001_ok.sql']);
    } finally {
      await iso.drop();
    }
  });
  it('concurrent runners are serialized: every migration is applied exactly once', async () => {
    const iso = await createIsolatedDatabase({ migrate: false });
    try {
      const [a, b] = await Promise.all([runMigrations({ url: iso.url, dir: migrationsDir() }), runMigrations({ url: iso.url, dir: migrationsDir() })]);
      const total = readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).length;
      expect(a.applied.length + b.applied.length).toBe(total);
      expect(new Set([...a.applied, ...b.applied]).size).toBe(total);
      expect(Number((await iso.database.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations'))[0]!.n)).toBe(total);
    } finally {
      await iso.drop();
    }
  });
  it('a runner gives up with a clear error when another runner holds the lock', async () => {
    const iso = await createIsolatedDatabase({ migrate: false });
    const holder = new pg.Client({ connectionString: iso.url });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const started = Date.now();
      const err = (await rejection(runMigrations({ url: iso.url, dir: migrationsDir(), lockTimeoutMs: 400 }))) as Error;
      expect(err.message).toContain('another migration runner is active');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await holder.end();
      await iso.drop();
    }
  });
  it('check mode reports pending migrations without applying them', async () => {
    const iso = await createIsolatedDatabase({ migrate: false });
    try {
      const r = await runMigrations({ url: iso.url, dir: migrationsDir(), mode: 'check' });
      expect(r.applied).toEqual([]);
      expect(r.pending.length).toBeGreaterThan(0);
      expect(Number((await iso.database.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations'))[0]!.n)).toBe(0);
    } finally {
      await iso.drop();
    }
  });
});

describe('schema snapshot', () => {
  it('is deterministic across databases and matches the committed snapshot', async () => {
    const [a, b] = [await createIsolatedDatabase(), await createIsolatedDatabase()];
    try {
      const [sa, sb] = [await snapshotDatabase(a.url), await snapshotDatabase(b.url)];
      expect(sa).toBe(sb);
      expect(sa).toBe(readFileSync(path.join(migrationsDir(), '..', '..', 'docs', 'data', 'SCHEMA_SNAPSHOT.sql'), 'utf8'));
      expect(sa).not.toMatch(/CREATE TABLE public.spatial_ref_sys/); // extension-owned
      expect(sa).not.toMatch(/CREATE TABLE pgboss/); // infrastructure-owned
    } finally {
      await a.drop();
      await b.drop();
    }
  });
});
