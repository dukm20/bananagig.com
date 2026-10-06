// Forward-only SQL migration library (see docs/data/MIGRATION_POLICY.md).
//  - files:  db/migrations/NNNN_snake_case.sql, applied in version order, one transaction per file
//  - safety: SHA-256 checksum of every applied file, duplicate/gap detection, header + destructive-statement rules,
//            advisory lock with timeout (one runner at a time), statement/lock timeouts, fail fast, nothing half-applied
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const MIGRATION_LOCK_KEY = 7265001; // registered in docs/data/DATABASE_CONVENTIONS.md (advisory lock registry)
export const HEADER_FIELDS = ['checkpoint', 'purpose', 'rollback strategy', 'backfill', 'risk'];
const HEADER_FROM_VERSION = 2; // 0001 predates the header rule and must never be edited
const DESTRUCTIVE =
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|CONSTRAINT|TYPE)|TRUNCATE|ALTER\s+TABLE\s+\S+\s+ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE|DELETE\s+FROM)\b/i;

/** Parse and validate migration files. Returns { files, errors }. Pure: no database access. */
export function loadMigrations(dir) {
  const errors = [];
  let names = [];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    return { files: [], errors: [`migrations directory not found: ${dir}`] };
  }
  const files = [];
  const seen = new Map();
  for (const filename of names) {
    const m = filename.match(/^(\d{4})_([a-z0-9_]+)\.sql$/);
    if (!m) {
      errors.push(`invalid migration file name (expected NNNN_snake_case.sql): ${filename}`);
      continue;
    }
    const version = Number(m[1]);
    if (seen.has(version)) errors.push(`duplicate migration version ${m[1]}: ${seen.get(version)} and ${filename}`);
    seen.set(version, filename);
    const sql = readFileSync(path.join(dir, filename), 'utf8');
    files.push({ version, filename, sql, checksum: createHash('sha256').update(sql).digest('hex') });
    if (version >= HEADER_FROM_VERSION) {
      const head = sql
        .split('\n')
        .filter((l) => l.startsWith('--'))
        .join('\n')
        .toLowerCase();
      for (const f of HEADER_FIELDS)
        if (!new RegExp(`^--\\s*${f}:\\s*\\S`, 'm').test(head)) errors.push(`${filename}: missing header comment "-- ${f}: <text>"`);
      const body = sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n');
      if (DESTRUCTIVE.test(body) && !/^--\s*destructive:\s*\S/im.test(sql)) {
        errors.push(
          `${filename}: destructive statement (DROP/TRUNCATE/DELETE/column type change) requires a "-- destructive: <justification and expand/migrate/contract reference>" header`,
        );
      }
    }
  }
  files.sort((a, b) => a.version - b.version);
  files.forEach((f, i) => {
    if (f.version !== i + 1 && !errors.some((e) => e.includes('duplicate')))
      errors.push(`migration versions must be contiguous from 0001: expected ${String(i + 1).padStart(4, '0')}, found ${f.filename}`);
  });
  return { files, errors };
}

async function tryLock(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_KEY]);
    if (rows[0].ok) return;
    if (Date.now() > deadline) throw new Error(`could not acquire the migration lock within ${timeoutMs}ms: another migration runner is active`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const hasColumn = async (client, col) =>
  (
    await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = $1", [
      col,
    ])
  ).rowCount > 0;

/**
 * Applies pending migrations (or only verifies, with mode 'check').
 * Returns { applied: string[], skipped: string[], pending: string[] }.
 */
export async function runMigrations({ url, dir, mode = 'apply', lockTimeoutMs = 60_000, statementTimeoutMs = 600_000, log = () => {} }) {
  const { files, errors } = loadMigrations(dir);
  if (errors.length) throw new Error(`invalid migrations:\n  - ${errors.join('\n  - ')}`);
  const client = new pg.Client({ connectionString: url, application_name: 'bananagig-migrator' });
  await client.connect();
  const result = { applied: [], skipped: [], pending: [] };
  try {
    await tryLock(client, lockTimeoutMs); // session lock: released on disconnect even if we crash
    await client.query(`SET statement_timeout = ${Number(statementTimeoutMs)}`);
    await client.query("SET lock_timeout = '30s'"); // DDL must not queue forever behind other locks
    // Bootstrap in the original (0001-era) shape; migration 0002 upgrades it. Idempotent.
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map((await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]));
    const known = new Set(files.map((f) => f.filename));
    for (const name of applied.keys())
      if (!known.has(name))
        throw new Error(`applied migration ${name} has no file in ${dir} (removed or renamed). Never delete or rename an applied migration.`);
    for (const f of files) {
      if (applied.has(f.filename)) {
        if (applied.get(f.filename) !== f.checksum)
          throw new Error(`Applied migration ${f.filename} was modified. Never edit applied migrations; add a new one.`);
        result.skipped.push(f.filename);
        log(`skip   ${f.filename}`);
        continue;
      }
      if (mode === 'check') {
        result.pending.push(f.filename);
        log(`pending ${f.filename}`);
        continue;
      }
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        const ms = Date.now() - started;
        // Record version/duration once migration 0002 has introduced those columns.
        if (await hasColumn(client, 'version')) {
          await client.query('INSERT INTO schema_migrations (version, filename, checksum, duration_ms) VALUES ($1, $2, $3, $4)', [
            f.version,
            f.filename,
            f.checksum,
            ms,
          ]);
        } else {
          await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [f.filename, f.checksum]);
        }
        await client.query('COMMIT');
        result.applied.push(f.filename);
        log(`apply  ${f.filename} (${ms}ms)`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f.filename} failed and was rolled back: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }
  return result;
}
