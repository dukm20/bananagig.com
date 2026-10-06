// pnpm migrate [--check]
// Applies db/migrations/*.sql (forward-only). --check verifies checksums and lists pending migrations without applying.
// Connection: DATABASE_URL_HOST, then DATABASE_URL, then the local dev default. See docs/data/MIGRATION_POLICY.md.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './lib/migrator.mjs';

const dir = process.env.MIGRATIONS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const url = process.env.DATABASE_URL_HOST || process.env.DATABASE_URL || 'postgres://bananagig:bananagig_dev_only@127.0.0.1:5433/bananagig';
const check = process.argv.includes('--check');
try {
  const r = await runMigrations({
    url,
    dir,
    mode: check ? 'check' : 'apply',
    lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS || 60_000),
    log: console.log,
  });
  if (check && r.pending.length) console.log(`${r.pending.length} pending migration(s) not yet applied to this database`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
