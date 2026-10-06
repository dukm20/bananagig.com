// Deterministic schema snapshot of APPLICATION-OWNED objects.
// Default: creates a scratch database, applies db/migrations from zero, snapshots it, drops it.
//   node scripts/schema-snapshot.mjs            print to stdout
//   node scripts/schema-snapshot.mjs --write    write docs/data/SCHEMA_SNAPSHOT.sql
//   node scripts/schema-snapshot.mjs --check    exit 1 if docs/data/SCHEMA_SNAPSHOT.sql is stale
//   node scripts/schema-snapshot.mjs --database-url=<url>   snapshot an existing database instead
// Excluded: pg_catalog, information_schema, the pgboss schema, and every object owned by an extension (PostGIS).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { snapshotDatabase } from './lib/snapshot.mjs';
import { runMigrations } from './lib/migrator.mjs';
import { parseArgs } from './lib/governance.mjs';

export const SNAPSHOT_PATH = 'docs/data/SCHEMA_SNAPSHOT.sql';
const baseUrl = () => process.env.DATABASE_URL_HOST || process.env.DATABASE_URL || 'postgres://bananagig:bananagig_dev_only@127.0.0.1:5433/bananagig';
/** Applies db/migrations from zero into a throw-away database and snapshots it. */
export async function snapshotFromMigrations() {
  const base = new URL(baseUrl());
  const name = `bananagig_snapshot_${process.pid}`;
  const admin = new pg.Client({ connectionString: baseUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const scratch = new URL(base);
  scratch.pathname = `/${name}`;
  try {
    await runMigrations({ url: scratch.toString(), dir: path.join(process.cwd(), 'db', 'migrations') });
    return await snapshotDatabase(scratch.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { flag } = parseArgs(process.argv.slice(2));
  const url = flag('database-url');
  const snap = typeof url === 'string' ? await snapshotDatabase(url) : await snapshotFromMigrations();
  if (flag('write')) {
    writeFileSync(SNAPSHOT_PATH, snap);
    console.log(`wrote ${SNAPSHOT_PATH}`);
  } else if (flag('check')) {
    let cur = '';
    try {
      cur = readFileSync(SNAPSHOT_PATH, 'utf8');
    } catch {
      /* missing = stale */
    }
    if (cur !== snap) {
      console.error(`STALE: ${SNAPSHOT_PATH} does not match the schema produced by db/migrations. Run: pnpm schema:snapshot --write`);
      process.exit(1);
    }
    console.log('schema snapshot is current');
  } else process.stdout.write(snap);
}
