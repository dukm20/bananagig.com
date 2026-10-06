// Test helpers shared across workspaces. Never imported by production code.
import pg from 'pg';
import { createDatabase, type Database } from '@bananagig/database';

/** Derives the test database URL from DATABASE_URL by swapping the database name. */
export function testDatabaseUrl(base = process.env.DATABASE_URL ?? 'postgres://bananagig:bananagig_dev_only@localhost:5433/bananagig'): string {
  const u = new URL(base);
  u.pathname = '/bananagig_test';
  return u.toString();
}

/** Creates the dedicated test database if missing. Requires a reachable dev Postgres. */
export async function ensureTestDatabase(): Promise<string> {
  const target = testDatabaseUrl();
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://bananagig:bananagig_dev_only@localhost:5433/bananagig' });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'bananagig_test'");
    if (!rowCount) await admin.query('CREATE DATABASE bananagig_test');
  } finally {
    await admin.end();
  }
  return target;
}

export async function withTestDatabase<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = createDatabase(await ensureTestDatabase());
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Resolves true when `url` answers 2xx within the timeout; used to skip integration tests when deps are down. */
export async function reachable(url: string, ms = 1500): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}
