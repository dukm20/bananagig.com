// pnpm db:backup-test: development backup/restore validation (NOT a production DR certification).
//  1. build a scratch database from zero (migrations) and add sample data
//  2. pg_dump (custom format) inside the Postgres container
//  3. pg_restore into a clean, empty database
//  4. verify data, schema snapshot equality, checksum-clean migration rerun, and that a NEW migration still applies
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { HEADER_FIELDS, runMigrations } from './lib/migrator.mjs';
import { snapshotDatabase } from './lib/snapshot.mjs';

const container = process.env.POSTGRES_CONTAINER || 'bananagig-postgres-db';
const adminUrl = process.env.DATABASE_URL_HOST || process.env.DATABASE_URL || 'postgres://bananagig:bananagig_dev_only@127.0.0.1:5433/bananagig';
const user = new URL(adminUrl).username;
const suffix = `${process.pid}`;
const src = `bananagig_bk_src_${suffix}`;
const dst = `bananagig_bk_dst_${suffix}`;
const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations');
const urlFor = (db) => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
};
const docker = (...args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
};
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const tmp = mkdtempSync(path.join(tmpdir(), 'bg-bk-'));
try {
  for (const db of [src, dst]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${src}`);
  await admin.query(`CREATE DATABASE ${dst}`); // empty: no extensions, no tables

  await runMigrations({ url: urlFor(src), dir: migrationsDir });
  const s = new pg.Client({ connectionString: urlFor(src) });
  await s.connect();
  await s.query('CREATE TABLE backup_probe (id int PRIMARY KEY, location geography(Point, 4326) NOT NULL)');
  await s.query(
    'INSERT INTO backup_probe VALUES (1, ST_SetSRID(ST_MakePoint(-122.4, 37.8), 4326)::geography), (2, ST_SetSRID(ST_MakePoint(2.35, 48.85), 4326)::geography)',
  );
  await s.query(
    "INSERT INTO integration.outbox_events (aggregate_type, aggregate_id, event_type, event_version, actor_type, payload_json, correlation_id) VALUES ('infra','1','bananagig.infra.ping.v1',1,'system','{\"k\":1}','corr-backup-1'), ('infra','2','bananagig.infra.ping.v1',1,'system','{\"k\":2}','corr-backup-2')",
  );
  const srcCounts = (
    await s.query(
      'SELECT (SELECT count(*) FROM backup_probe) AS probe, (SELECT count(*) FROM integration.outbox_events) AS outbox, (SELECT count(*) FROM schema_migrations) AS migrations',
    )
  ).rows[0];
  await s.end();

  docker('exec', container, 'pg_dump', '-U', user, '-Fc', '-d', src, '-f', '/tmp/bg_backup.dump');
  const size = Number(docker('exec', container, 'sh', '-c', 'stat -c %s /tmp/bg_backup.dump').trim());
  check('pg_dump produced a backup', size > 1000, `${size} bytes`);
  docker('exec', container, 'pg_restore', '-U', user, '-d', dst, '--no-owner', '--exit-on-error', '/tmp/bg_backup.dump');
  check('pg_restore into a clean database succeeded', true);

  const d = new pg.Client({ connectionString: urlFor(dst) });
  await d.connect();
  const dstCounts = (
    await d.query(
      'SELECT (SELECT count(*) FROM backup_probe) AS probe, (SELECT count(*) FROM integration.outbox_events) AS outbox, (SELECT count(*) FROM schema_migrations) AS migrations',
    )
  ).rows[0];
  const postgis = (await d.query('SELECT PostGIS_Version() AS v')).rows[0].v;
  const dist = (
    await d.query(
      'SELECT round(ST_Distance((SELECT location FROM backup_probe WHERE id = 1), (SELECT location FROM backup_probe WHERE id = 2))::numeric / 1000) AS km',
    )
  ).rows[0].km;
  await d.end();
  check('row counts match (data, outbox, migration bookkeeping)', JSON.stringify(srcCounts) === JSON.stringify(dstCounts), JSON.stringify(dstCounts));
  check('PostGIS works on the restored database', /^3\./.test(postgis) && Number(dist) > 8000, `v${postgis.split(' ')[0]}, SF-Paris ${dist} km`);
  check('schema snapshot is identical after restore', (await snapshotDatabase(urlFor(src))) === (await snapshotDatabase(urlFor(dst))));

  const again = await runMigrations({ url: urlFor(dst), dir: migrationsDir });
  check(
    'migration rerun on the restored database is a clean no-op (checksums intact)',
    again.applied.length === 0 && again.skipped.length === Number(srcCounts.migrations),
  );

  // Compatibility: a newer migration (not yet applied) must still apply on top of the restored database.
  const next = path.join(tmp, 'migrations');
  cpSync(migrationsDir, next, { recursive: true });
  const nextVersion = String(Number(srcCounts.migrations) + 1).padStart(4, '0');
  writeFileSync(
    path.join(next, `${nextVersion}_restore_probe.sql`),
    `${HEADER_FIELDS.map((f) => `-- ${f}: backup test`).join('\n')}\nCREATE TABLE public.restore_probe (restore_probe_id uuid PRIMARY KEY DEFAULT gen_random_uuid());\n`,
  );
  const fwd = await runMigrations({ url: urlFor(dst), dir: next });
  check('a new migration applies on top of the restored database', fwd.applied.length === 1);
} catch (err) {
  console.error(err.message);
  results.push(false);
} finally {
  try {
    docker('exec', container, 'rm', '-f', '/tmp/bg_backup.dump');
  } catch {
    /* best effort */
  }
  for (const db of [src, dst]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(
  results.every(Boolean) && results.length
    ? '\nBACKUP/RESTORE TEST PASSED (development validation only; not production DR certification)'
    : '\nBACKUP/RESTORE TEST FAILED',
);
process.exit(results.every(Boolean) && results.length ? 0 : 1);
