// Forward-only SQL migration runner. Applies db/migrations/*.sql in filename order.
// Tracks a SHA-256 checksum per applied file and refuses to run if an applied migration was edited.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const dir = process.env.MIGRATIONS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
// --check: verify checksums of applied migrations and report pending ones without applying anything.
const checkOnly = process.argv.includes('--check');
let pending = 0;
const url = process.env.DATABASE_URL_HOST || process.env.DATABASE_URL || 'postgres://bananagig:bananagig_dev_only@127.0.0.1:5433/bananagig';
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(7265001)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Map((await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(f)) {
      if (applied.get(f) !== checksum) throw new Error(`Applied migration ${f} was modified. Never edit applied migrations; add a new one.`);
      console.log(`skip   ${f}`);
      continue;
    }
    if (checkOnly) {
      pending++;
      console.log(`pending ${f}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [f, checksum]);
      await client.query('COMMIT');
      console.log(`apply  ${f}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
} finally {
  await client.end();
}
if (checkOnly && pending) {
  console.log(`${pending} pending migration(s) not yet applied to this database`);
}
