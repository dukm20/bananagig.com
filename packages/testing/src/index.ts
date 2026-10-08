// Test helpers shared across workspaces. Never imported by production code.
// Every integration test file gets its OWN freshly migrated database (created from zero, dropped afterwards), so tests
// never depend on developer data and are safe to run in parallel with each other.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { createDatabase, type Database, type DatabaseOptions } from '@bananagig/database';
import { runMigrations } from '../../../scripts/lib/migrator.mjs';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', '..', 'db', 'migrations');
export const TEST_DB_PREFIX = 'bananagig_t_';

export const adminUrl = (): string =>
  process.env.DATABASE_URL_HOST || process.env.DATABASE_URL || 'postgres://bananagig:bananagig_dev_only@127.0.0.1:5433/bananagig';

export const urlForDatabase = (name: string, base = adminUrl()): string => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};

export interface IsolatedDatabase {
  name: string;
  url: string;
  database: Database;
  /** Closes the pool and drops the database. Safe to call twice. */
  drop(): Promise<void>;
}

/** Creates `bananagig_t_<random>`, applies all migrations from zero, returns a pool using the `tests` policy. */
export async function createIsolatedDatabase(opts: { migrate?: boolean; database?: DatabaseOptions } = {}): Promise<IsolatedDatabase> {
  const name = `${TEST_DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = urlForDatabase(name);
  let database: Database | undefined;
  let dropped = false;
  const drop = async (): Promise<void> => {
    if (dropped) return;
    dropped = true;
    await database?.close().catch(() => undefined);
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    try {
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await a.end();
    }
  };
  try {
    if (opts.migrate !== false) await runMigrations({ url, dir: MIGRATIONS_DIR });
    database = createDatabase(url, { role: 'tests', ...opts.database });
  } catch (err) {
    await drop();
    throw err;
  }
  return { name, url, database, drop };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes databases left behind by crashed test runs (no active sessions, and not created by a process that is still running). Called from the integration global setup. */
export async function dropStaleTestDatabases(): Promise<string[]> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const dropped: string[] = [];
  try {
    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = pg_database.datname)`,
      [`${TEST_DB_PREFIX}%`],
    );
    for (const r of rows) {
      // a database created by a process that is still running belongs to a concurrent test run (it may not have connected yet): leave it alone
      const pid = Number(/^bananagig_t_(\d+)_/.exec(r.datname)?.[1]);
      if (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid)) continue;
      await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
      dropped.push(r.datname);
    }
  } finally {
    await admin.end();
  }
  return dropped;
}

export * from './helpers';
export * from './mailpit';
export const migrationsDir = (): string => MIGRATIONS_DIR;
