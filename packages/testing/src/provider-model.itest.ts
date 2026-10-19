import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categoryNameKey, serviceTypeNameKey, type CatalogStatus } from '../../contracts/src/catalog';
import { GEO_STATUSES } from '../../contracts/src/geography';
import {
  FUTURE_STEPS,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_STATUSES,
  PROVIDER_ERROR_CODES,
  PROVIDER_POLICY_KEYS,
  PROVIDER_REGISTRATION_STATUSES,
  PROVIDER_ROLE_STATES,
  PROVIDER_SERVICE_TYPES_CEILING,
  ProviderRegistrationPolicy,
  isProviderRegistrationTransitionAllowed,
  providerErrorKey,
  providerRegistrationStatusKey,
  providerRoleStateKey,
  providerStepLabelKey,
  providerStepStatusKey,
  type ProviderRegistrationStatus,
} from '../../contracts/src/provider';
import { runMigrations } from '../../../scripts/lib/migrator.mjs';
import { ConfigurationService } from '../../configuration/src/index';
import { ContentService } from '../../content/src/index';
import { createIsolatedDatabase, createTestPool, migrationsDir, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0018 (PRO-001, provider registration) creates the `provider` schema: one row per registration ATTEMPT of an existing account (the provider is NOT a second account), the
// service types the attempt intends to offer, an immutable audit trail, three trigger functions (SQLSTATE 23000, DETAIL provider_rule:<KEY>) with six triggers, and two seeds
// through the real workflows: five registration policy parameters (configuration) and 56 managed copy entries (content). No registration is seeded and no older object changes.
// These tests drive the REAL tables with raw SQL on isolated databases: the exact shape, the seed (resolved through ConfigurationService and ContentService and compared with the
// contract), every CHECK, every guard rule on the exact failing statement, the status matrix against the contract, the live-attempt rule, RESTRICT and TRUNCATE, the interleavings
// that matter under real concurrency (lock waiters polled in pg_stat_activity, then repeated simultaneous races), the access paths and the privacy shape. The service is covered in
// packages/provider and the API in apps/api.
//
// Mutation runs (done by hand on private copies, never in place): PROVIDER_MODEL_MIGRATIONS_DIR names a directory whose 0018_provider_registration.sql replaces the real one in every
// database this file creates. Unset, the real migration is used.
// Since 0020 (CAT-003) the same schema also holds the four Gig tables, their functions, triggers and indexes (all named with `gig`); they are asserted in gig-model.itest.ts. Every
// schema-wide count or list below is scoped to the PRO-001 objects (relation, index, trigger, constraint and function names without `gig`).
// Since 0021 (CAT-004) it also holds provider.gig_version_variants, provider.gig_version_add_ons, provider.gig_version_media and provider.media_assets (asserted in gig-options-media-model.itest.ts); the first three are
// named with `gig`, media_assets is excluded by name explicitly, so every filter below reads `!~ '(gig|media_assets|profile)'`.
// Since 0024 (PRO-002) it also holds provider.public_profiles and provider.profile_audit_events with their functions, triggers and indexes (asserted in provider-profile-model.itest.ts); every object name holds `profile`, so the same filters exclude them.
const GIG_TABLES = [
  'provider.gigs',
  'provider.gig_versions',
  'provider.gig_version_field_values',
  'provider.gig_audit_events',
  'provider.gig_version_variants',
  'provider.gig_version_add_ons',
  'provider.gig_version_media',
  'provider.media_assets',
  'provider.public_profiles',
  'provider.profile_audit_events',
];
const MUTANT_DIR = process.env.PROVIDER_MODEL_MIGRATIONS_DIR;
const MIGRATION_18 = '0018_provider_registration.sql';
const migration18 = (): string => readFileSync(path.join(MUTANT_DIR ?? migrationsDir(), MIGRATION_18), 'utf8');

/** A database migrated through migration `through` (all migrations when it is Infinity); 0018 is read from the mutant directory when one is named. */
async function migratedDatabase(through: number): Promise<IsolatedDatabase> {
  const dir = mkdtempSync(path.join(tmpdir(), `bananagig-mig-${Number.isFinite(through) ? through : 'head'}-`));
  const db = await createIsolatedDatabase({ migrate: false });
  try {
    for (const f of readdirSync(migrationsDir()).filter((n) => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= through))
      copyFileSync(path.join(f === MIGRATION_18 ? (MUTANT_DIR ?? migrationsDir()) : migrationsDir(), f), path.join(dir, f));
    await runMigrations({ url: db.url, dir });
    return db;
  } catch (e) {
    await db.drop();
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let iso: IsolatedDatabase; // mutated by the tests
let seed: IsolatedDatabase; // pristine, migrated through 0018: the seed assertions and the comparison with 0017 read it
let base: IsolatedDatabase; // pristine, migrated through 0017
let pool: pg.Pool;
let racePool: pg.Pool;
let seedPool: pg.Pool;
let basePool: pg.Pool;
let seq = 0;
let laOc: string; // the seeded market la-oc (the database holds no rule about the market status)
let categoryId: string; // one ACTIVE category the test service types live under
beforeAll(async () => {
  const made = await Promise.allSettled([migratedDatabase(Infinity), migratedDatabase(18), migratedDatabase(17)]);
  if (made.some((m) => m.status === 'rejected')) {
    for (const m of made) if (m.status === 'fulfilled') await m.value.drop();
    throw (made.find((m) => m.status === 'rejected') as PromiseRejectedResult).reason;
  }
  [iso, seed, base] = made.map((m) => (m as PromiseFulfilledResult<IsolatedDatabase>).value) as [IsolatedDatabase, IsolatedDatabase, IsolatedDatabase];
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  seedPool = createTestPool(seed.url, 4);
  basePool = createTestPool(base.url, 3);
  laOc = ((await pool.query("SELECT market_id FROM geography.markets WHERE code = 'la-oc'")).rows[0] as { market_id: string }).market_id;
  await ensureEntry(categoryNameKey('provider_tests'));
  categoryId = ((await pool.query("INSERT INTO catalog.categories (code) VALUES ('provider_tests') RETURNING category_id")).rows[0] as { category_id: string })
    .category_id;
  await pool.query('UPDATE catalog.categories SET status = $2 WHERE category_id = $1', [categoryId, 'ACTIVE']);
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await seedPool?.end();
  await basePool?.end();
  await iso?.drop();
  await seed?.drop();
  await base?.drop();
});

// ---------------------------------------------------------------- helpers
type Db = pg.Pool | pg.PoolClient;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = [], from: Db = pool): Promise<T[]> =>
  (await from.query(sql, params)).rows as T[];
const sq = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await seedPool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = [], from: Db = pool) => from.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = [], from: Db = pool): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params, from))[0]!.n;
interface PgFailure {
  code?: string;
  constraint?: string;
  detail?: string;
  column?: string;
  message: string;
}
/** The failure of a statement (the test fails when the statement succeeds). */
const fail = async (p: Promise<unknown>): Promise<PgFailure> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  expect(e, 'the statement was expected to be rejected').toBeDefined();
  return e!;
};
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL provider_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `provider_rule:${key}` });
};
/** Asserts the statement is refused by a named constraint with the SQLSTATE of its kind (check 23514, foreign key 23503, unique 23505). */
const expectConstraint = async (p: Promise<unknown>, constraint: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, constraint: e.constraint }).toEqual({
    code: constraint.startsWith('ck_') ? '23514' : constraint.startsWith('fk_') ? '23503' : '23505',
    constraint,
  });
};
const expectNotNull = async (p: Promise<unknown>, column: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, column: e.column }).toEqual({ code: '23502', column });
};
const asRule = (e: PgFailure | undefined): { code?: string; detail?: string } | undefined => (e ? { code: e.code, detail: e.detail } : undefined);
const rule = (key: string) => ({ code: '23000', detail: `provider_rule:${key}` });
const outcomeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  if (!e) return 'ACCEPTED';
  return e.detail?.startsWith('provider_rule:') ? e.detail.slice('provider_rule:'.length) : (e.constraint ?? e.code ?? 'ERROR');
};

/** Opens a transaction on a connection of its own (the caller commits or rolls back and releases). */
async function openTx(from: pg.Pool = pool): Promise<pg.PoolClient> {
  const c = await from.connect();
  await c.query('BEGIN');
  return c;
}
const finish = async (c: pg.PoolClient, how: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<void> => {
  try {
    await c.query(how);
  } finally {
    c.release();
  }
};
async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>, from: pg.Pool = pool): Promise<T> {
  const c = await openTx(from);
  try {
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
/** Runs the prep statements and then `text` in a transaction that is ALWAYS rolled back (the prep may disable the user triggers of a table for this transaction). */
async function isolated(prep: string[], text: string, params: unknown[] = [], from: pg.Pool = pool): Promise<void> {
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    for (const p of prep) await c.query(p);
    await c.query(text, params);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const noTriggers = (...tables: string[]): string[] => tables.map((t) => `ALTER TABLE ${t} DISABLE TRIGGER USER`);
/**
 * Disables the user triggers of every table outside the provider schema (so that only the provider guards can answer), for the rolled-back transaction that follows.
 * Since 0019 the trust schema references accounts, markets and service types as well, so a CASCADE from those roots reaches the trust tables: its guards are switched off too.
 */
const NO_FOREIGN_TRIGGERS = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname IN ('identity', 'geography', 'catalog', 'content', 'configuration', 'integration', 'trust') LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER USER', r.nspname, r.relname);
  END LOOP; END $$`;

/** How many sessions of the database of this pool are blocked on a lock right now. */
const waitersOn = async (from: pg.Pool): Promise<number> =>
  (
    (
      await from.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
      )
    ).rows[0] as { n: number }
  ).n;
/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number, from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
async function noLockWaiters(from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) === 0) return;
    await sleep(20);
  }
  throw new Error('sessions are still blocked on a lock');
}

// ---------------------------------------------------------------- fixtures
const REG = 'provider.registrations';
const SEL = 'provider.registration_service_types';
const AUDIT = 'provider.audit_events';
const TABLES = [AUDIT, SEL, REG];
const PATH: Record<CatalogStatus, CatalogStatus[]> = { DRAFT: [], ACTIVE: ['ACTIVE'], INACTIVE: ['ACTIVE', 'INACTIVE'], RETIRED: ['RETIRED'] };
type AccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSURE_REQUESTED' | 'CLOSED';

const historyRow = (c: Db, accountId: string, from: string | null, to: string) =>
  c.query(
    "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2::text, $3::text, NULL, 'test', 'test-correlation')",
    [accountId, from, to],
  );
/** An account in its creation state (PENDING or ACTIVE) with the creation history row, in one transaction (the deferred trigger demands both). */
async function makeAccount(status: 'PENDING' | 'ACTIVE' = 'ACTIVE'): Promise<string> {
  return inTx(async (c) => {
    const r = await c.query('INSERT INTO identity.accounts (status) VALUES ($1) RETURNING account_id', [status]);
    const id = (r.rows[0] as { account_id: string }).account_id;
    await historyRow(c, id, null, status);
    return id;
  });
}
/** Moves an account to another status together with its history row (the service does the same in one transaction). */
async function setStatus(accountId: string, to: AccountStatus): Promise<void> {
  await inTx(async (c) => {
    const from = ((await c.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0] as { status: string }).status;
    await c.query(
      "UPDATE identity.accounts SET status = $2::text, closed_at = CASE WHEN $2::text = 'CLOSED' THEN now() END, updated_at = now() WHERE account_id = $1",
      [accountId, to],
    );
    await historyRow(c, accountId, from, to);
  });
}
/** An account in the given status, reached along a legal path (no role is held, so it can be closed). */
async function accountIn(status: AccountStatus): Promise<string> {
  if (status === 'PENDING') return makeAccount('PENDING');
  const id = await makeAccount('ACTIVE');
  if (status === 'SUSPENDED' || status === 'CLOSURE_REQUESTED') await setStatus(id, status);
  if (status === 'CLOSED') {
    await setStatus(id, 'SUSPENDED');
    await setStatus(id, 'CLOSED');
  }
  return id;
}
/** The statements of an account suspension in one transaction body (lock, update, history). */
async function suspendOn(c: Db, accountId: string): Promise<void> {
  await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
  await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [accountId]);
  await historyRow(c, accountId, 'ACTIVE', 'SUSPENDED');
}

/** A content entry with this key (no version: the catalog tables only need the key to exist). */
async function ensureEntry(key: string, from: Db = pool): Promise<void> {
  await from.query(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     VALUES ($1, 'UI_LABEL', 'CONTENT', 'test entry', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'test') ON CONFLICT (key) DO NOTHING`,
    [key],
  );
}
interface Row {
  id: string;
  code: string;
}
/** A service type under the ACTIVE test category, moved along legal steps to the status asked for (default ACTIVE, the only status a selection accepts). */
async function makeServiceType(status: CatalogStatus = 'ACTIVE', from: Db = pool): Promise<Row> {
  const code = `pst_${++seq}`;
  await ensureEntry(serviceTypeNameKey(code), from);
  const id = (
    (await from.query('INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2) RETURNING service_type_id', [categoryId, code])).rows[0] as {
      service_type_id: string;
    }
  ).service_type_id;
  for (const s of PATH[status]) await from.query('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', [id, s]);
  return { id, code };
}
const setSt = (id: string, status: string, from: Db = pool) =>
  from.query('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', [id, status]);

interface Reg {
  provider_registration_id: string;
  account_id: string;
  attempt_number: number;
  status: string;
  market_id: string | null;
  revision: number;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
const regRow = async (id: string, from: Db = pool): Promise<Reg> => (await q<Reg>(`SELECT * FROM ${REG} WHERE provider_registration_id = $1`, [id], from))[0]!;
/** Inserts the next attempt of an account (the guard accepts only the highest attempt plus one). */
async function start(account: string, from: Db = pool): Promise<string> {
  const r = await from.query(
    `INSERT INTO ${REG} (account_id, attempt_number) SELECT $1::uuid, COALESCE(max(attempt_number), 0) + 1 FROM ${REG} WHERE account_id = $1 RETURNING provider_registration_id`,
    [account],
  );
  return (r.rows[0] as { provider_registration_id: string }).provider_registration_id;
}
const setMarket = (id: string, market: string = laOc, from: Db = pool) =>
  from.query(`UPDATE ${REG} SET market_id = $2, revision = revision + 1 WHERE provider_registration_id = $1`, [id, market]);
const completeReg = (id: string, from: Db = pool) => from.query(`UPDATE ${REG} SET status = 'COMPLETED' WHERE provider_registration_id = $1`, [id]);
const cancelReg = (id: string, from: Db = pool) => from.query(`UPDATE ${REG} SET status = 'CANCELLED' WHERE provider_registration_id = $1`, [id]);
const pick = (id: string, serviceTypeId: string, from: Db = pool) =>
  from.query(`INSERT INTO ${SEL} (provider_registration_id, service_type_id) VALUES ($1, $2)`, [id, serviceTypeId]);
const unpick = (id: string, serviceTypeId: string, from: Db = pool) =>
  from.query(`DELETE FROM ${SEL} WHERE provider_registration_id = $1 AND service_type_id = $2`, [id, serviceTypeId]);
type Kind = 'IN_PROGRESS' | 'MARKET' | 'COMPLETED' | 'CANCELLED';
/** A registration of a fresh ACTIVE account in the given state: IN_PROGRESS without a market, MARKET (IN_PROGRESS with the market chosen), COMPLETED or CANCELLED. */
async function make(kind: Kind = 'IN_PROGRESS'): Promise<{ account: string; id: string }> {
  const account = await makeAccount();
  const id = await start(account);
  if (kind === 'MARKET' || kind === 'COMPLETED') await setMarket(id);
  if (kind === 'COMPLETED') await completeReg(id);
  if (kind === 'CANCELLED') await cancelReg(id);
  return { account, id };
}
const STATUS_KIND: Record<ProviderRegistrationStatus, Kind> = { IN_PROGRESS: 'MARKET', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' };
const audit = (
  id: string,
  action = 'PROVIDER_REGISTRATION_STARTED',
  o: { actor?: string; changes?: unknown; reason?: string | null; correlation?: string } = {},
  from: Db = pool,
) =>
  from.query(`INSERT INTO ${AUDIT} (actor, action, provider_registration_id, changes, reason, correlation_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`, [
    o.actor ?? 'account:test',
    action,
    id,
    o.changes === undefined ? null : JSON.stringify(o.changes),
    o.reason ?? null,
    o.correlation ?? 'test-correlation',
  ]);

/** Invariants of the registration data that must hold whatever the interleaving: none of these may ever have a row. */
async function violations(from: Db = pool): Promise<Record<string, unknown[]>> {
  const rows = async (text: string) => (await from.query(text)).rows;
  return {
    moreThanOneLiveAttempt: await rows(`SELECT account_id FROM ${REG} WHERE status <> 'CANCELLED' GROUP BY 1 HAVING count(*) > 1`),
    attemptsNotContiguous: await rows(`SELECT account_id FROM ${REG} GROUP BY 1 HAVING min(attempt_number) <> 1 OR max(attempt_number) <> count(*)`),
    lifecycleBroken: await rows(
      `SELECT provider_registration_id FROM ${REG}
        WHERE NOT ((status = 'IN_PROGRESS' AND completed_at IS NULL AND cancelled_at IS NULL)
                OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND market_id IS NOT NULL)
                OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND completed_at IS NULL))`,
    ),
    selectionWithoutRegistration: await rows(
      `SELECT s.provider_registration_id FROM ${SEL} s LEFT JOIN ${REG} r USING (provider_registration_id) WHERE r.provider_registration_id IS NULL`,
    ),
  };
}
const NO_VIOLATIONS = { moreThanOneLiveAttempt: [], attemptsNotContiguous: [], lifecycleBroken: [], selectionWithoutRegistration: [] };

/**
 * The holder transaction runs `hold` and stays OPEN; the racer statement is started on another connection WITHOUT being awaited; the test polls pg_stat_activity until
 * the racer is blocked on a lock; only then the holder commits (or rolls back). Returns the racer's failure (undefined when it succeeded). No sleep synchronizes anything.
 */
interface RaceSql {
  text: string;
  params?: unknown[];
}
type Racer = RaceSql | ((c: pg.PoolClient) => Promise<unknown>);
const runRacer = async (from: pg.Pool, r: Racer): Promise<unknown> => {
  if (typeof r !== 'function') return from.query(r.text, r.params ?? []);
  const c = await openTx(from);
  try {
    await r(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};
async function holdThenRace(hold: (c: pg.PoolClient) => Promise<unknown>, race: Racer, how: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<PgFailure | undefined> {
  const tx = await openTx();
  let racer: Promise<unknown> = Promise.resolve();
  try {
    await hold(tx);
    racer = rejection(runRacer(racePool, race));
    await lockWaiters(1);
  } finally {
    await finish(tx, how);
  }
  return (await racer) as PgFailure | undefined;
}
/** Fires both at once on separate pooled connections and returns their failures (undefined = succeeded). */
const both = (a: Racer, b: Racer) =>
  Promise.all([rejection(runRacer(racePool, a)), rejection(runRacer(racePool, b))]) as Promise<[PgFailure | undefined, PgFailure | undefined]>;
const winners = (r: (PgFailure | undefined)[]): number => r.filter((x) => x === undefined).length;
const notDeadlock = (e: PgFailure | undefined) => expect(String(e?.code ?? ''), 'a deadlock or a serialization failure is a defect').not.toMatch(/^40/);
const sqlOf = (text: string, ...params: unknown[]): RaceSql => ({ text, params });

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null];
const columnsOf = async (table: string, from: pg.Pool = pool): Promise<ColumnShape[]> =>
  (
    (
      await from.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'provider' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows as { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default]);
interface ConstraintRow {
  conname: string;
  contype: string;
  confdeltype: string;
  confupdtype: string;
  confmatchtype: string;
  condeferrable: boolean;
  convalidated: boolean;
  target: string | null;
  def: string;
}
const constraintsOf = async (table: string, from: pg.Pool = pool): Promise<ConstraintRow[]> =>
  (
    await from.query(
      `SELECT conname, contype, confdeltype, confupdtype, confmatchtype, condeferrable, convalidated, confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f', 'c', 'x', 't') ORDER BY conname COLLATE "C"`,
      [table],
    )
  ).rows;
const indexesOf = async (table: string): Promise<{ indexname: string; indexdef: string }[]> =>
  (await pool.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = \'provider\' AND tablename = $1 ORDER BY indexname COLLATE "C"', [table]))
    .rows;
const triggersOf = async (table: string) =>
  q<{ tgname: string; def: string; enabled: string }>(
    'SELECT t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled AS enabled FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"',
    [table],
  );
const commentOn = async (table: string, column?: string): Promise<string | null> =>
  (
    (
      await pool.query(
        column
          ? 'SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c'
          : "SELECT obj_description($1::regclass, 'pg_class') AS c",
        column ? [table, column] : [table],
      )
    ).rows[0] as { c: string | null }
  ).c;
const vocab = (def: string): string[] => [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const TS_DEFAULT_NOW = 'timestamp with time zone';
const COLUMNS_BY_TABLE: Record<string, ColumnShape[]> = {
  registrations: [
    ['provider_registration_id', 'uuid', false, 'gen_random_uuid()'],
    ['account_id', 'uuid', false, null],
    ['attempt_number', 'integer', false, null],
    ['status', 'text', false, "'IN_PROGRESS'::text"],
    ['market_id', 'uuid', true, null],
    ['revision', 'integer', false, '1'],
    ['completed_at', TS_DEFAULT_NOW, true, null],
    ['cancelled_at', TS_DEFAULT_NOW, true, null],
    ['created_at', TS_DEFAULT_NOW, false, 'now()'],
    ['updated_at', TS_DEFAULT_NOW, false, 'now()'],
  ],
  registration_service_types: [
    ['provider_registration_id', 'uuid', false, null],
    ['service_type_id', 'uuid', false, null],
    ['created_at', TS_DEFAULT_NOW, false, 'now()'],
  ],
  audit_events: [
    ['audit_event_id', 'uuid', false, 'gen_random_uuid()'],
    ['occurred_at', TS_DEFAULT_NOW, false, 'clock_timestamp()'],
    ['actor', 'text', false, null],
    ['action', 'text', false, null],
    ['provider_registration_id', 'uuid', false, null],
    ['changes', 'jsonb', true, null],
    ['reason', 'text', true, null],
    ['correlation_id', 'text', false, null],
  ],
};
const AUDIT_ACTIONS = [
  'PROVIDER_REGISTRATION_STARTED',
  'PROVIDER_MARKET_SELECTED',
  'PROVIDER_SERVICES_UPDATED',
  'PROVIDER_REGISTRATION_COMPLETED',
  'PROVIDER_REGISTRATION_CANCELLED',
];
const CONSTRAINT_DEFS: Record<string, Record<string, string>> = {
  registrations: {
    ck_registrations__attempt: 'CHECK ((attempt_number >= 1))',
    ck_registrations__lifecycle:
      "CHECK ((((status = 'IN_PROGRESS'::text) AND (completed_at IS NULL) AND (cancelled_at IS NULL)) OR ((status = 'COMPLETED'::text) AND (completed_at IS NOT NULL) AND (cancelled_at IS NULL) AND (market_id IS NOT NULL)) OR ((status = 'CANCELLED'::text) AND (cancelled_at IS NOT NULL) AND (completed_at IS NULL))))",
    ck_registrations__revision: 'CHECK ((revision >= 1))',
    ck_registrations__status: "CHECK ((status = ANY (ARRAY['IN_PROGRESS'::text, 'COMPLETED'::text, 'CANCELLED'::text])))",
    fk_registrations__account_id: 'FOREIGN KEY (account_id) REFERENCES identity.accounts(account_id) ON DELETE RESTRICT',
    fk_registrations__market_id: 'FOREIGN KEY (market_id) REFERENCES geography.markets(market_id) ON DELETE RESTRICT',
    pk_registrations: 'PRIMARY KEY (provider_registration_id)',
    uq_registrations__attempt: 'UNIQUE (account_id, attempt_number)',
  },
  registration_service_types: {
    fk_registration_service_types__registration_id:
      'FOREIGN KEY (provider_registration_id) REFERENCES provider.registrations(provider_registration_id) ON DELETE RESTRICT',
    fk_registration_service_types__service_type_id: 'FOREIGN KEY (service_type_id) REFERENCES catalog.service_types(service_type_id) ON DELETE RESTRICT',
    pk_registration_service_types: 'PRIMARY KEY (provider_registration_id, service_type_id)',
  },
  audit_events: {
    ck_audit_events__action: `CHECK ((action = ANY (ARRAY[${AUDIT_ACTIONS.map((a) => `'${a}'::text`).join(', ')}])))`,
    ck_audit_events__actor: 'CHECK (((length(btrim(actor)) > 0) AND (length(actor) <= 200)))',
    ck_audit_events__changes_object: "CHECK (((changes IS NULL) OR (jsonb_typeof(changes) = 'object'::text)))",
    ck_audit_events__reason: 'CHECK (((reason IS NULL) OR ((length(btrim(reason)) > 0) AND (length(reason) <= 1000))))',
    fk_audit_events__registration_id: 'FOREIGN KEY (provider_registration_id) REFERENCES provider.registrations(provider_registration_id) ON DELETE RESTRICT',
    pk_audit_events: 'PRIMARY KEY (audit_event_id)',
  },
};
const FK_TARGETS: Record<string, string> = {
  fk_audit_events__registration_id: 'provider.registrations',
  fk_registration_service_types__registration_id: 'provider.registrations',
  fk_registration_service_types__service_type_id: 'catalog.service_types',
  fk_registrations__account_id: 'identity.accounts',
  fk_registrations__market_id: 'geography.markets',
};
const INDEX_DEFS: Record<string, Record<string, string>> = {
  registrations: {
    pk_registrations: 'CREATE UNIQUE INDEX pk_registrations ON provider.registrations USING btree (provider_registration_id)',
    uq_registrations__attempt: 'CREATE UNIQUE INDEX uq_registrations__attempt ON provider.registrations USING btree (account_id, attempt_number)',
    uq_registrations__live: "CREATE UNIQUE INDEX uq_registrations__live ON provider.registrations USING btree (account_id) WHERE (status <> 'CANCELLED'::text)",
  },
  registration_service_types: {
    pk_registration_service_types:
      'CREATE UNIQUE INDEX pk_registration_service_types ON provider.registration_service_types USING btree (provider_registration_id, service_type_id)',
  },
  audit_events: { pk_audit_events: 'CREATE UNIQUE INDEX pk_audit_events ON provider.audit_events USING btree (audit_event_id)' },
};
const TRIGGER_DEFS: Record<string, Record<string, string>> = {
  registrations: {
    trg_registrations__guard:
      'CREATE TRIGGER trg_registrations__guard BEFORE INSERT OR DELETE OR UPDATE ON provider.registrations FOR EACH ROW EXECUTE FUNCTION provider.guard_registrations()',
    trg_registrations__no_truncate:
      'CREATE TRIGGER trg_registrations__no_truncate BEFORE TRUNCATE ON provider.registrations FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation()',
  },
  registration_service_types: {
    trg_registration_service_types__guard:
      'CREATE TRIGGER trg_registration_service_types__guard BEFORE INSERT OR DELETE OR UPDATE ON provider.registration_service_types FOR EACH ROW EXECUTE FUNCTION provider.guard_registration_service_types()',
    trg_registration_service_types__no_truncate:
      'CREATE TRIGGER trg_registration_service_types__no_truncate BEFORE TRUNCATE ON provider.registration_service_types FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation()',
  },
  audit_events: {
    trg_audit_events__immutable:
      'CREATE TRIGGER trg_audit_events__immutable BEFORE DELETE OR UPDATE ON provider.audit_events FOR EACH ROW EXECUTE FUNCTION provider.forbid_mutation()',
    trg_audit_events__no_truncate:
      'CREATE TRIGGER trg_audit_events__no_truncate BEFORE TRUNCATE ON provider.audit_events FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation()',
  },
};
/** The rule keys each function can raise (the documented contract of the SQLSTATE 23000 details). */
const RULES_BY_FUNCTION: Record<string, string[]> = {
  forbid_mutation: ['ROW_IMMUTABLE'],
  guard_registration_service_types: ['IMMUTABLE_IDENTITY', 'REGISTRATION_NOT_IN_PROGRESS', 'SERVICE_TYPE_NOT_ACTIVE', 'SERVICE_TYPE_RETIRED'],
  guard_registrations: [
    'ACCOUNT_NOT_ACTIVE',
    'IMMUTABLE_IDENTITY',
    'MUST_START_IN_PROGRESS',
    'NOT_DELETABLE',
    'REGISTRATION_ATTEMPT_SEQUENCE',
    'REGISTRATION_FROZEN',
    'REVISION_ONLY_GROWS',
    'STATUS_TRANSITION',
  ],
};
const FUNCTIONS = [
  { proname: 'forbid_mutation', args: '', volatility: 'v', result: 'trigger' },
  { proname: 'guard_registration_service_types', args: '', volatility: 'v', result: 'trigger' },
  { proname: 'guard_registrations', args: '', volatility: 'v', result: 'trigger' },
];

/** A fingerprint of every object of the database that does NOT belong to the provider schema (compared between 0017 and 0018). */
async function outsideProvider(from: pg.Pool) {
  const rows = async (text: string) => (await from.query(text)).rows.map((r) => JSON.stringify(r));
  const other = "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'provider')";
  return {
    schemas: await rows("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'provider') ORDER BY 1"),
    relations: await rows(`SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${other} ORDER BY 1, 2`),
    columns: await rows(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression, ordinal_position FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'provider') ORDER BY table_schema, table_name, ordinal_position`,
    ),
    constraints: await rows(
      `SELECT n.nspname, t.relname, c.conname, c.contype, c.confdeltype, c.confupdtype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, c.conname COLLATE "C"`,
    ),
    indexes: await rows(
      `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'provider') ORDER BY schemaname, tablename, indexname COLLATE "C"`,
    ),
    triggers: await rows(
      `SELECT n.nspname, t.relname, g.tgname, g.tgenabled, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE NOT g.tgisinternal AND ${other} ORDER BY n.nspname, t.relname, g.tgname COLLATE "C"`,
    ),
    functions: await rows(
      `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src, p.provolatile, p.prosecdef, obj_description(p.oid, 'pg_proc') AS comment FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'provider') AND p.prokind = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY n.nspname, p.proname, args`,
    ),
    comments: await rows(
      `SELECT n.nspname, t.relname, d.objsubid, d.description FROM pg_description d JOIN pg_class t ON t.oid = d.objoid AND d.classoid = 'pg_class'::regclass JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, d.objsubid`,
    ),
    schemaComments: await rows(
      "SELECT nspname, obj_description(oid, 'pg_namespace') AS comment, nspacl::text AS acl FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'provider') ORDER BY 1",
    ),
    acls: await rows(
      `SELECT n.nspname, c.relname, c.relacl::text AS acl, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${other} AND c.relkind IN ('r', 'v', 'S') ORDER BY 1, 2`,
    ),
  };
}
/** Row counts of every ordinary table outside the provider schema. */
async function rowCounts(from: pg.Pool): Promise<Record<string, number>> {
  const r = await from.query(
    `SELECT n.nspname || '.' || c.relname AS t,
            (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::int AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'provider') AND n.nspname NOT LIKE 'pg_%' ORDER BY 1`,
  );
  return Object.fromEntries((r.rows as { t: string; n: number }[]).map((x) => [x.t, x.n]));
}
/** What migration 0018 ADDS to the rows of the older tables: five configuration parameters (6 audit rows each) and 56 content entries (5 audit rows each). */
const EXPECTED_ROW_DELTAS: Record<string, number> = {
  'configuration.audit_events': 30,
  'configuration.change_approvals': 5,
  'configuration.change_requests': 5,
  'configuration.parameter_scopes': 5,
  'configuration.parameter_values': 5,
  'configuration.parameters': 5,
  'configuration.value_versions': 5,
  'content.audit_events': 280,
  'content.entries': 56,
  'content.versions': 56,
};

describe('A. schema shape: three tables, three functions and six triggers in a new schema, an immutable audit trail, holding nothing about a person', () => {
  it('creates the provider schema with exactly three tables and five indexes; no sequence, view, materialized view, partition, composite type, policy, rule, inheritance or ACL; everything is owned by the role that owns the catalogue', async () => {
    expect(
      await q(
        "SELECT nspname, obj_description(oid, 'pg_namespace') IS NOT NULL AS commented, nspacl IS NULL AS no_acl FROM pg_namespace WHERE nspname = 'provider'",
      ),
    ).toEqual([{ nspname: 'provider', commented: true, no_acl: true }]);
    expect(
      (
        await q<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'provider' AND table_type = 'BASE TABLE' AND table_name !~ '(gig|media_assets|profile)' ORDER BY 1",
        )
      ).map((r) => r.table_name),
    ).toEqual(['audit_events', 'registration_service_types', 'registrations']);
    // every relation of the schema: three ordinary tables and five indexes (3 primary keys + 2 unique keys on registrations, one of them partial); nothing else
    expect(
      await q(
        "SELECT relkind, count(*)::int AS n FROM pg_class WHERE relnamespace = 'provider'::regnamespace AND relname !~ '(gig|media_assets|profile)' GROUP BY 1 ORDER BY 1",
      ),
    ).toEqual([
      { relkind: 'i', n: 5 },
      { relkind: 'r', n: 3 },
    ]);
    expect(
      await q("SELECT t.typname FROM pg_type t WHERE t.typnamespace = 'provider'::regnamespace AND t.typtype NOT IN ('c') AND t.typname NOT LIKE '\\_%'"),
    ).toEqual([]);
    expect(
      await q(
        "SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'provider'::regnamespace AND c.relkind IN ('r', 'i') AND (c.relacl IS NOT NULL OR c.relrowsecurity OR c.relispartition OR c.relhasrules OR c.relhassubclass)",
      ),
    ).toEqual([]);
    expect(
      await q("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'provider'::regnamespace)"),
    ).toEqual([{ n: 0 }]);
    expect(
      await q("SELECT count(*)::int AS n FROM pg_inherits WHERE inhrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'provider'::regnamespace)"),
    ).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclnamespace = 'provider'::regnamespace")).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'provider'::regnamespace AND proacl IS NOT NULL")).toEqual([{ n: 0 }]);
    // the owner is the role that owns the catalogue schema (the application role), not a superuser-only object
    expect(
      await q(
        `SELECT DISTINCT pg_get_userbyid(c.relowner) = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'catalog.categories'::regclass) AS same_owner
           FROM pg_class c WHERE c.relnamespace = 'provider'::regnamespace`,
      ),
    ).toEqual([{ same_owner: true }]);
    expect(
      await q("SELECT DISTINCT pg_get_userbyid(c.relowner) = current_user AS mine FROM pg_class c WHERE c.relnamespace = 'provider'::regnamespace"),
    ).toEqual([{ mine: true }]);
    expect(await q("SELECT pg_get_userbyid(nspowner) = current_user AS mine FROM pg_namespace WHERE nspname = 'provider'")).toEqual([{ mine: true }]);
    expect(await q("SELECT DISTINCT pg_get_userbyid(proowner) = current_user AS mine FROM pg_proc WHERE pronamespace = 'provider'::regnamespace")).toEqual([
      { mine: true },
    ]);
  });

  it.each(Object.entries(COLUMNS_BY_TABLE))('has exactly the documented columns, types, nullability and defaults on %s', async (table, expected) => {
    expect(await columnsOf(table)).toEqual(expected);
  });

  it('has no generated column and no identity column (identifiers come from gen_random_uuid(), attempt numbers from the guard)', async () => {
    expect(
      await q(
        `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'provider'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND (a.attgenerated <> '' OR a.attidentity <> '')`,
      ),
    ).toEqual([]);
  });

  it.each(Object.entries(CONSTRAINT_DEFS))(
    'defines every constraint of %s exactly as documented (names and definition text), and no other',
    async (table, defs) => {
      const rows = await constraintsOf(`provider.${table}`);
      expect(rows.map((r) => r.conname)).toEqual(Object.keys(defs).sort(byName));
      expect(Object.fromEntries(rows.map((r) => [r.conname, r.def]))).toEqual(defs);
      expect(rows.every((r) => r.convalidated && !r.condeferrable)).toBe(true); // none deferrable, none NOT VALID
    },
  );

  it('has 17 primary key, unique, foreign key and check constraints (3 + 1 + 5 + 8) and no exclusion constraint, and no table has a NOT NULL beyond the columns documented', async () => {
    const n = await q<{ contype: string; n: number }>(
      "SELECT c.contype, count(*)::int AS n FROM pg_constraint c WHERE c.connamespace = 'provider'::regnamespace AND c.conrelid::regclass::text !~ '(gig|media_assets|profile)' GROUP BY 1 ORDER BY 1",
    );
    expect(n).toEqual([
      { contype: 'c', n: 8 },
      { contype: 'f', n: 5 },
      { contype: 'p', n: 3 },
      { contype: 'u', n: 1 },
    ]);
    expect(Object.values(CONSTRAINT_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(17);
    expect(Object.fromEntries(Object.entries(COLUMNS_BY_TABLE).map(([t, cols]) => [t, cols.filter((c) => !c[2]).map((c) => c[0])]))).toEqual({
      registrations: ['provider_registration_id', 'account_id', 'attempt_number', 'status', 'revision', 'created_at', 'updated_at'],
      registration_service_types: ['provider_registration_id', 'service_type_id', 'created_at'],
      audit_events: ['audit_event_id', 'occurred_at', 'actor', 'action', 'provider_registration_id', 'correlation_id'],
    });
  });

  it('declares every foreign key ON DELETE RESTRICT and ON UPDATE NO ACTION with MATCH SIMPLE and the documented target; nothing in the provider schema cascades or sets null', async () => {
    const fks: ConstraintRow[] = [];
    for (const t of Object.keys(CONSTRAINT_DEFS)) fks.push(...(await constraintsOf(`provider.${t}`)).filter((r) => r.contype === 'f'));
    expect(Object.fromEntries(fks.map((r) => [r.conname, r.target]))).toEqual(FK_TARGETS);
    expect(fks.map((r) => [r.confdeltype, r.confupdtype, r.confmatchtype])).toEqual(fks.map(() => ['r', 'a', 's']));
    expect(fks).toHaveLength(5);
  });

  it.each(Object.entries(INDEX_DEFS))('has exactly the documented indexes on %s and no other', async (table, defs) => {
    const idx = await indexesOf(table);
    expect(Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]))).toEqual(defs);
    expect(idx.map((r) => r.indexname)).toEqual(Object.keys(defs).sort(byName));
  });

  it('has exactly five indexes in the schema, one of them partial, none on market_id, service_type_id, the audit registration, a status alone or a timestamp (the documented deliberate omissions)', async () => {
    expect(Object.values(INDEX_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(5);
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'provider' AND indexdef ~ ' WHERE ' AND indexname !~ '(gig|media_assets|profile)' ORDER BY 1",
      ),
    ).toEqual([{ indexname: 'uq_registrations__live' }]);
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'provider' AND (indexdef ~ 'INCLUDE' OR indexdef ~ '(market_id|created_at|updated_at|completed_at|cancelled_at|occurred_at|actor|action|revision|changes)') AND indexname !~ '(gig|media_assets|profile)'",
      ),
    ).toEqual([]);
    // the foreign key columns WITHOUT a supporting index are exactly the three the migration documents (never-deleted targets, no filtered query on the referencing column)
    expect(
      (
        await q<{ tbl: string; conname: string }>(
          `SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint c
          WHERE contype = 'f' AND connamespace = 'provider'::regnamespace AND conname !~ '(gig|media_assets|profile)'
            AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`,
        )
      )
        .map((r) => r.conname)
        .sort(byName),
    ).toEqual(['fk_audit_events__registration_id', 'fk_registration_service_types__service_type_id', 'fk_registrations__market_id']);
  });

  it.each(Object.entries(TRIGGER_DEFS))(
    'wires the triggers of %s exactly (name, timing, events, level, function), enabled, none deferrable or constraint triggers',
    async (table, defs) => {
      const t = await triggersOf(`provider.${table}`);
      expect(Object.fromEntries(t.map((x) => [x.tgname, x.def]))).toEqual(defs);
      expect(t.every((x) => x.enabled === 'O')).toBe(true);
      expect(t.filter((x) => /CONSTRAINT TRIGGER|DEFERRABLE|AFTER|INSTEAD/.test(x.def))).toEqual([]);
    },
  );

  it('has exactly six triggers in the schema (two per table: a row guard and a TRUNCATE refusal), every one BEFORE, and no trigger of the provider schema on a table outside it', async () => {
    expect(
      (
        await q<{ tgname: string }>(
          "SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = 'provider'::regnamespace AND c.relname !~ '(gig|media_assets|profile)' AND NOT g.tgisinternal ORDER BY 1",
        )
      ).length,
    ).toBe(6);
    expect(Object.values(TRIGGER_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(6);
    expect(
      await q(
        "SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace <> 'provider'::regnamespace AND pg_get_triggerdef(g.oid) ~ 'provider\\.'",
      ),
    ).toEqual([]);
  });

  it('defines the three functions as plpgsql trigger functions, VOLATILE, not SECURITY DEFINER, without a custom search_path, not leakproof or strict, with a comment each', async () => {
    const rows = await q<{ proname: string; args: string; volatility: string; result: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.provolatile AS volatility, pg_get_function_result(p.oid) AS result FROM pg_proc p WHERE p.pronamespace = 'provider'::regnamespace AND p.proname !~ '(gig|media_assets|profile)' ORDER BY 1`,
    );
    expect(rows).toEqual(FUNCTIONS);
    expect(
      await q(
        `SELECT p.proname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.pronamespace = 'provider'::regnamespace AND (l.lanname <> 'plpgsql' OR p.prosecdef OR p.proconfig IS NOT NULL OR obj_description(p.oid, 'pg_proc') IS NULL OR p.proleakproof OR p.proisstrict)`,
      ),
    ).toEqual([]);
  });

  it.each(Object.entries(RULES_BY_FUNCTION))(
    '%s raises exactly the documented rule keys (SQLSTATE 23000), and names every one of them in its comment',
    async (fn, keys) => {
      const r = (
        await q<{ prosrc: string; c: string }>(
          "SELECT prosrc, obj_description(oid, 'pg_proc') AS c FROM pg_proc WHERE pronamespace = 'provider'::regnamespace AND proname = $1",
          [fn],
        )
      )[0]!;
      const raised = [...new Set([...r.prosrc.matchAll(/provider_rule:([A-Z_]+)/g)].map((m) => m[1]!))].sort(byName);
      expect(raised).toEqual(keys);
      // the comment of a guard names the rule keys; forbid_mutation names the one key it raises
      for (const k of keys) expect(r.c, `${fn}: ${k}`).toContain(k);
      // every raise carries SQLSTATE integrity_constraint_violation (23000) and a DETAIL: no bare RAISE EXCEPTION
      const raises = r.prosrc.match(/RAISE EXCEPTION/g) ?? [];
      expect(raises.length).toBeGreaterThanOrEqual(keys.length);
      expect(r.prosrc.match(/ERRCODE = 'integrity_constraint_violation'/g)?.length).toBe(raises.length);
      expect(r.prosrc.match(/DETAIL = 'provider_rule:[A-Z_]+'/g)?.length).toBe(raises.length);
    },
  );

  it('CHECKs the registration status to exactly the contract list, so the database and the API cannot drift, and the audit actions to the five the service writes', async () => {
    const defs = Object.fromEntries((await constraintsOf(REG)).map((r) => [r.conname, r.def]));
    expect(vocab(defs['ck_registrations__status']!)).toEqual([...PROVIDER_REGISTRATION_STATUSES]);
    const audit = Object.fromEntries((await constraintsOf(AUDIT)).map((r) => [r.conname, r.def]));
    expect(vocab(audit['ck_audit_events__action']!)).toEqual(AUDIT_ACTIONS);
    // the default of the status column is the initial state, the one the guard demands of an INSERT
    expect((await columnsOf('registrations')).find((c) => c[0] === 'status')![3]).toBe(`'${PROVIDER_REGISTRATION_STATUSES[0]}'::text`);
  });

  it('documents the schema, every table, every guard function and the meaningful columns in the catalog (comments say what is never done: deleted, truncated, updated, stored)', async () => {
    for (const t of TABLES) expect(await commentOn(t), t).toBeTruthy();
    expect(await commentOn(REG)).toMatch(/Never deleted or truncated/);
    expect(await commentOn(REG)).toMatch(/no personal data/);
    expect(await commentOn(SEL)).toMatch(/an UPDATE is refused/);
    expect(await commentOn(AUDIT)).toMatch(/Rows are immutable and never truncated/);
    for (const c of ['account_id', 'attempt_number', 'status', 'market_id', 'revision']) expect(await commentOn(REG, c), `registrations.${c}`).toBeTruthy();
    expect(await commentOn(REG, 'status')).toMatch(/There is no SUBMITTED state/);
    expect(await commentOn(REG, 'revision')).toMatch(/Frozen once the registration leaves IN_PROGRESS/);
    expect((await q<{ c: string }>("SELECT obj_description('provider'::regnamespace, 'pg_namespace') AS c"))[0]!.c).toMatch(
      /provider is the same account as the customer/,
    );
  });

  it('did not alter any older object: every column, constraint, index, trigger, function, relation, comment, ACL and owner outside the provider schema equals the schema migrated to 0017', async () => {
    const [a, b] = [await outsideProvider(basePool), await outsideProvider(seedPool)];
    for (const k of Object.keys(a) as (keyof typeof a)[]) {
      expect(b[k], k).toEqual(a[k]);
      expect(b[k].length, `${k} is not vacuous`).toBeGreaterThan(5);
    }
    expect(b.schemas.map((s) => JSON.parse(s).nspname)).toEqual(
      expect.arrayContaining(['identity', 'content', 'geography', 'configuration', 'integration', 'catalog']),
    );
    expect(b.schemas.map((s) => JSON.parse(s).nspname)).not.toContain('provider');
    // and the only schema the migration adds is provider
    const schemas = async (from: pg.Pool) =>
      (await from.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1")).rows.map(
        (r) => r.nspname,
      );
    const older = await schemas(basePool);
    expect((await schemas(seedPool)).filter((s) => !older.includes(s))).toEqual(['provider']);
  });

  it('changes the rows of the older tables by exactly five configuration parameters and 56 content entries (with their versions, change requests, approvals and audit rows) and nothing else: no account, outbox event, market, role or locale', async () => {
    const [x, y] = [await rowCounts(basePool), await rowCounts(seedPool)];
    expect(Object.keys(y)).toEqual(Object.keys(x)); // the same tables
    const ledger = y['public.schema_migrations']! - x['public.schema_migrations']!;
    expect(ledger).toBe(1); // the migration ledger records 0018 itself
    delete y['public.schema_migrations'];
    delete x['public.schema_migrations'];
    const delta = Object.fromEntries(
      Object.keys(y)
        .map((t) => [t, y[t]! - x[t]!])
        .filter(([, d]) => d !== 0),
    );
    expect(delta).toEqual(EXPECTED_ROW_DELTAS);
    expect(Object.keys(x).length).toBeGreaterThan(40);
    // the older rows themselves are the same: the keys of the older entries and parameters are identical
    const keys = async (from: pg.Pool) =>
      (
        await from.query(
          "SELECT 'content' AS k, key FROM content.entries WHERE key NOT LIKE 'provider.registration.%' UNION ALL SELECT 'configuration', key FROM configuration.parameters WHERE key NOT LIKE 'provider.registration.%' ORDER BY 1, 2",
        )
      ).rows;
    expect(await keys(seedPool)).toEqual(await keys(basePool));
    // the provider tables themselves start empty: no registration is seeded
    for (const t of TABLES) expect(await count(t, 'true', [], seedPool), t).toBe(0);
    // the seed emitted no outbox event (the seeds run before any consumer exists) and no account audit
    expect(await count('integration.outbox_events', 'true', [], seedPool)).toBe(await count('integration.outbox_events', 'true', [], basePool));
  });

  it('is referenced by nothing outside the schema and references only identity.accounts, geography.markets, catalog.service_types and itself', async () => {
    expect(
      await q(
        `SELECT conrelid::regclass::text AS from_table, conname FROM pg_constraint
          WHERE contype = 'f' AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'provider'::regnamespace) AND connamespace <> 'provider'::regnamespace`,
      ),
    ).toEqual([]);
    expect(
      (
        await q<{ target: string }>(
          `SELECT DISTINCT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND connamespace = 'provider'::regnamespace AND conrelid::regclass::text !~ '(gig|media_assets|profile)' AND confrelid::regclass::text NOT LIKE 'provider.%' ORDER BY 1`,
        )
      ).map((r) => r.target),
    ).toEqual(['catalog.service_types', 'geography.markets', 'identity.accounts']);
    // no view, function or trigger outside the schema names a provider table (nothing else depends on it yet)
    expect(
      await q(
        "SELECT count(*)::int AS n FROM pg_depend d JOIN pg_class c ON c.oid = d.refobjid WHERE c.relnamespace = 'provider'::regnamespace AND d.classid = 'pg_rewrite'::regclass",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it('contains no ALTER, DROP, DELETE, GRANT or REVOKE in the migration text and touches no older object but through the two seed workflows', () => {
    const body = migration18()
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.startsWith('COMMENT ON'))
      .join('\n');
    expect(body).not.toMatch(
      /\b(ALTER\s|DROP\s|DELETE\s+FROM|GRANT\s|REVOKE\s|CREATE\s+(OR\s+REPLACE\s+)?VIEW|CREATE\s+SEQUENCE|CREATE\s+EXTENSION|CREATE\s+TYPE|CREATE\s+POLICY|CREATE\s+RULE)/i,
    );
    expect(body.replace(/BEFORE TRUNCATE/gi, '')).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\b(pg_notify|NOTIFY|outbox_events|SECURITY\s+DEFINER|search_path)\b/i);
    expect(
      [...body.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(SCHEMA|TABLE|FUNCTION|TRIGGER|INDEX)\s+([\w.]+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`),
    ).toEqual([
      'SCHEMA provider',
      'FUNCTION provider.forbid_mutation',
      'TABLE provider.registrations',
      'INDEX uq_registrations__live',
      'TABLE provider.registration_service_types',
      'TABLE provider.audit_events',
      'FUNCTION provider.guard_registrations',
      'TRIGGER trg_registrations__guard',
      'TRIGGER trg_registrations__no_truncate',
      'FUNCTION provider.guard_registration_service_types',
      'TRIGGER trg_registration_service_types__guard',
      'TRIGGER trg_registration_service_types__no_truncate',
      'TRIGGER trg_audit_events__immutable',
      'TRIGGER trg_audit_events__no_truncate',
    ]);
    // the only UPDATEs are the workflow steps of the seeds (configuration change request states, content version states); the seeds INSERT only into configuration and content
    const tally = (xs: (string | undefined)[]) => xs.reduce<Record<string, number>>((a, k) => ({ ...a, [k!]: (a[k!] ?? 0) + 1 }), {});
    expect(tally([...body.matchAll(/^\s*UPDATE\s+([a-z_]+\.[a-z_]+)/gim)].map((m) => m[1]))).toEqual({
      'configuration.change_requests': 3,
      'content.versions': 2,
    });
    expect(tally([...body.matchAll(/\bINSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1]))).toEqual({
      'configuration.parameters': 1,
      'configuration.parameter_scopes': 1,
      'configuration.audit_events': 6,
      'configuration.change_requests': 1,
      'configuration.change_approvals': 1,
      'configuration.parameter_values': 1,
      'configuration.value_versions': 1,
      'content.entries': 1,
      'content.audit_events': 5,
      'content.versions': 1,
    });
  });
});

// ====================================================================== B. the seed: five policy parameters and the copy of the minimal flow, through the real workflows
const SEED_CONTENT: [key: string, type: 'UI_LABEL' | 'PLAIN_TEXT', body: string][] = [
  ['provider.registration.step.account.label', 'UI_LABEL', 'Your account'],
  ['provider.registration.step.contact.label', 'UI_LABEL', 'Verified email and phone'],
  ['provider.registration.step.legal.label', 'UI_LABEL', 'Agreements'],
  ['provider.registration.step.market.label', 'UI_LABEL', 'Where you work'],
  ['provider.registration.step.services.label', 'UI_LABEL', 'What you offer'],
  ['provider.registration.step.verification.label', 'UI_LABEL', 'Verification'],
  ['provider.registration.step.subscription.label', 'UI_LABEL', 'Subscription'],
  ['provider.registration.step.profile.label', 'UI_LABEL', 'Public profile'],
  ['provider.registration.step.gigs.label', 'UI_LABEL', 'Your services'],
  ['provider.registration.step_status.not_started', 'UI_LABEL', 'Not started'],
  ['provider.registration.step_status.in_progress', 'UI_LABEL', 'In progress'],
  ['provider.registration.step_status.complete', 'UI_LABEL', 'Complete'],
  ['provider.registration.step_status.blocked', 'UI_LABEL', 'Needs attention'],
  ['provider.registration.step_status.not_available', 'UI_LABEL', 'Not available yet'],
  ['provider.registration.step_status.not_required', 'UI_LABEL', 'Not required'],
  ['provider.registration.status.in_progress', 'UI_LABEL', 'Registration in progress'],
  ['provider.registration.status.completed', 'UI_LABEL', 'Registration complete'],
  ['provider.registration.status.cancelled', 'UI_LABEL', 'Registration cancelled'],
  ['provider.registration.role.none', 'UI_LABEL', 'Not a provider yet'],
  ['provider.registration.role.pending', 'UI_LABEL', 'Provider role requested'],
  ['provider.registration.role.active', 'UI_LABEL', 'Provider role active'],
  ['provider.registration.role.inactive', 'UI_LABEL', 'Provider role inactive'],
  ['provider.registration.error.registration_not_found', 'PLAIN_TEXT', 'You have not started provider registration.'],
  ['provider.registration.error.registration_not_in_progress', 'PLAIN_TEXT', 'This registration can no longer be changed.'],
  ['provider.registration.error.role_inactive', 'PLAIN_TEXT', 'Your provider role is inactive. Contact support to restore it.'],
  ['provider.registration.error.account_not_active', 'PLAIN_TEXT', 'Your account is not active.'],
  ['provider.registration.error.prerequisite_not_met', 'PLAIN_TEXT', 'Verify your email and phone before you continue.'],
  ['provider.registration.error.market_not_eligible', 'PLAIN_TEXT', 'Provider registration is not open in that market.'],
  ['provider.registration.error.market_required', 'PLAIN_TEXT', 'Choose where you work first.'],
  ['provider.registration.error.service_type_not_eligible', 'PLAIN_TEXT', 'One of the selected services is not available in your market.'],
  ['provider.registration.error.service_count_out_of_range', 'PLAIN_TEXT', 'Choose a number of services within the allowed range.'],
  ['provider.registration.error.registration_incomplete', 'PLAIN_TEXT', 'Some steps are still open.'],
  ['provider.registration.error.stale_registration', 'PLAIN_TEXT', 'This page is out of date. Reload it and try again.'],
  ['provider.registration.error.validation_failed', 'PLAIN_TEXT', 'Check the highlighted fields.'],
  ['provider.registration.error.conflict', 'PLAIN_TEXT', 'Another change happened at the same time. Try again.'],
  ['provider.registration.error.unavailable', 'PLAIN_TEXT', 'Provider registration is temporarily unavailable.'],
  ['provider.registration.page.title', 'UI_LABEL', 'Become a provider'],
  [
    'provider.registration.page.intro',
    'PLAIN_TEXT',
    'Use your existing account to offer services on BananaGig. Your email, phone and agreements are reused, nothing is entered twice.',
  ],
  ['provider.registration.page.start_action', 'UI_LABEL', 'Start provider registration'],
  ['provider.registration.page.market_heading', 'UI_LABEL', 'Where you work'],
  ['provider.registration.page.market_label', 'UI_LABEL', 'Market'],
  ['provider.registration.page.market_help', 'PLAIN_TEXT', 'Choose the market where you plan to offer services.'],
  ['provider.registration.page.services_heading', 'UI_LABEL', 'What you offer'],
  ['provider.registration.page.services_help', 'PLAIN_TEXT', 'Choose the services you plan to offer. You can build your offers later.'],
  ['provider.registration.page.save_action', 'UI_LABEL', 'Save'],
  ['provider.registration.page.submit_action', 'UI_LABEL', 'Complete registration'],
  ['provider.registration.page.cancel_action', 'UI_LABEL', 'Cancel registration'],
  ['provider.registration.page.restart_action', 'UI_LABEL', 'Start again'],
  ['provider.registration.page.progress_heading', 'UI_LABEL', 'Your progress'],
  ['provider.registration.page.empty_markets', 'PLAIN_TEXT', 'No market is open for provider registration yet.'],
  ['provider.registration.page.empty_services', 'PLAIN_TEXT', 'No services are available in this market yet.'],
  [
    'provider.registration.page.completed_notice',
    'PLAIN_TEXT',
    'Your registration is complete. Verification, subscription and your offers come next; you are not live yet.',
  ],
  ['provider.registration.page.cancelled_notice', 'PLAIN_TEXT', 'Your registration was cancelled. Your account and your customer role are unchanged.'],
  ['provider.registration.page.golive_note', 'PLAIN_TEXT', 'You are not live yet. Going live needs steps that are not available yet.'],
  ['provider.registration.page.contact_hint', 'PLAIN_TEXT', 'Verify your email and phone in your account first.'],
  ['provider.registration.page.legal_hint', 'PLAIN_TEXT', 'Accept the required agreements in your account first.'],
];
/** Every managed content key the contract can name (the helpers of packages/contracts/src/provider.ts), for every member of its vocabulary. */
const CONTRACT_KEYS = [
  ...ONBOARDING_STEPS.map(providerStepLabelKey),
  ...ONBOARDING_STEP_STATUSES.map(providerStepStatusKey),
  ...PROVIDER_REGISTRATION_STATUSES.map(providerRegistrationStatusKey),
  ...PROVIDER_ROLE_STATES.map(providerRoleStateKey),
  ...PROVIDER_ERROR_CODES.map(providerErrorKey),
];
const PAGE_PREFIX = 'provider.registration.page.';
interface PolicySeed {
  key: string;
  type: 'BOOLEAN' | 'JSON' | 'INTEGER';
  unit: string | null;
  rules: unknown;
  value: unknown;
}
const POLICY_SEEDS: PolicySeed[] = [
  { key: PROVIDER_POLICY_KEYS.requireVerifiedEmail, type: 'BOOLEAN', unit: null, rules: {}, value: true },
  { key: PROVIDER_POLICY_KEYS.requireVerifiedPhone, type: 'BOOLEAN', unit: null, rules: {}, value: true },
  {
    key: PROVIDER_POLICY_KEYS.marketStatusesAllowed,
    type: 'JSON',
    unit: null,
    rules: { schema: { type: 'array', items: { type: 'string', enum: ['PLANNED', 'ACTIVE', 'INACTIVE'] }, uniqueItems: true, minItems: 1, maxItems: 3 } },
    value: ['ACTIVE'],
  },
  { key: PROVIDER_POLICY_KEYS.minServiceTypes, type: 'INTEGER', unit: 'service types', rules: { min: 0, max: 50 }, value: 1 },
  { key: PROVIDER_POLICY_KEYS.maxServiceTypes, type: 'INTEGER', unit: 'service types', rules: { min: 1, max: 50 }, value: 10 },
];
const POLICY_KEYS = POLICY_SEEDS.map((p) => p.key);

describe('B1. seeded configuration: the five registration policy parameters, resolved through the real ConfigurationService', () => {
  it('resolves to true, true, ["ACTIVE"], 1 and 10 at PLATFORM scope, version 1, typed as the seed says, and the values satisfy the contract policy schema', async () => {
    const cfg = new ConfigurationService({ database: seed.database, env: 'test' });
    const { values } = await cfg.resolveMany(POLICY_KEYS);
    expect([...values.keys()].sort(byName)).toEqual([...POLICY_KEYS].sort(byName));
    for (const p of POLICY_SEEDS) {
      const r = values.get(p.key)!;
      expect({ key: r.key, value: r.value, dataType: r.dataType, sourceScope: r.sourceScope, scopeRef: r.scopeRef, version: r.version }, p.key).toEqual({
        key: p.key,
        value: p.value,
        dataType: p.type,
        sourceScope: 'PLATFORM',
        scopeRef: null,
        version: 1,
      });
      expect(r.criticality, p.key).toBe('STANDARD');
      expect(r.sensitivity, p.key).toBe('INTERNAL');
      expect(r.effectiveTo, p.key).toBeNull();
      expect(r.effectiveFrom.getTime(), p.key).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(await cfg.value<boolean>(PROVIDER_POLICY_KEYS.requireVerifiedEmail)).toBe(true);
    expect(await cfg.value<boolean>(PROVIDER_POLICY_KEYS.requireVerifiedPhone)).toBe(true);
    expect(await cfg.value<string[]>(PROVIDER_POLICY_KEYS.marketStatusesAllowed)).toEqual(['ACTIVE']);
    expect(await cfg.value<number>(PROVIDER_POLICY_KEYS.minServiceTypes)).toBe(1);
    expect(await cfg.value<number>(PROVIDER_POLICY_KEYS.maxServiceTypes)).toBe(10);
    // the contract and the seed agree: the resolved set is a valid ProviderRegistrationPolicy
    expect(
      ProviderRegistrationPolicy.parse({
        requireVerifiedEmail: values.get(PROVIDER_POLICY_KEYS.requireVerifiedEmail)!.value,
        requireVerifiedPhone: values.get(PROVIDER_POLICY_KEYS.requireVerifiedPhone)!.value,
        marketStatusesAllowed: values.get(PROVIDER_POLICY_KEYS.marketStatusesAllowed)!.value,
        minServiceTypes: values.get(PROVIDER_POLICY_KEYS.minServiceTypes)!.value,
        maxServiceTypes: values.get(PROVIDER_POLICY_KEYS.maxServiceTypes)!.value,
      }),
    ).toEqual({ requireVerifiedEmail: true, requireVerifiedPhone: true, marketStatusesAllowed: ['ACTIVE'], minServiceTypes: 1, maxServiceTypes: 10 });
    // a context that names a market, a provider or a plan still resolves the PLATFORM value (nothing is overridden)
    const inMarket = await cfg.resolveMany(POLICY_KEYS, { market: 'la-oc' });
    expect([...inMarket.values.values()].map((r) => [r.key, r.value, r.sourceScope]).sort()).toEqual(
      POLICY_SEEDS.map((p) => [p.key, p.value, 'PLATFORM']).sort(),
    );
  });

  it('defines each parameter with the documented type, unit, validation rules, owner, sensitivity, approval policy and criticality, required and active, created by the migration', async () => {
    const rows = await sq<Record<string, unknown>>(
      `SELECT key, data_type, unit, validation_rules, owner_role, sensitivity, approval_policy, criticality, is_required, is_active, created_by, length(btrim(description)) > 20 AS described
         FROM configuration.parameters WHERE key LIKE 'provider.registration.%' ORDER BY key COLLATE "C"`,
    );
    expect(rows).toEqual(
      [...POLICY_SEEDS]
        .sort((a, b) => byName(a.key, b.key))
        .map((p) => ({
          key: p.key,
          data_type: p.type,
          unit: p.unit,
          validation_rules: p.rules,
          owner_role: 'platform',
          sensitivity: 'INTERNAL',
          approval_policy: 'SECOND_APPROVER',
          criticality: 'STANDARD',
          is_required: true,
          is_active: true,
          created_by: 'system:migration',
          described: true,
        })),
    );
    expect(await count('configuration.parameters', "key LIKE 'provider.registration.%'", [], seedPool)).toBe(5);
  });

  it('allows each parameter at PLATFORM scope only (no override level), with exactly one PLATFORM value holder and one version each', async () => {
    expect(
      await sq(
        `SELECT p.key, array_agg(s.scope_type ORDER BY s.scope_type) AS scopes FROM configuration.parameters p JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id
          WHERE p.key LIKE 'provider.registration.%' GROUP BY p.key ORDER BY p.key COLLATE "C"`,
      ),
    ).toEqual([...POLICY_KEYS].sort(byName).map((key) => ({ key, scopes: ['PLATFORM'] })));
    expect(
      await sq(
        `SELECT p.key, h.scope_type, h.scope_ref, v.version, v.value, v.effective_to IS NULL AS open_ended, v.created_by, v.reason LIKE 'Initial value (migration 0018): %' AS reason_ok
           FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
           JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id
          WHERE p.key LIKE 'provider.registration.%' ORDER BY p.key COLLATE "C"`,
      ),
    ).toEqual(
      [...POLICY_SEEDS]
        .sort((a, b) => byName(a.key, b.key))
        .map((p) => ({
          key: p.key,
          scope_type: 'PLATFORM',
          scope_ref: null,
          version: 1,
          value: p.value,
          open_ended: true,
          created_by: 'system:migration',
          reason_ok: true,
        })),
    );
  });

  it('went through the real change lifecycle: a request drafted, submitted, approved by a DIFFERENT actor and activated, with the six audit rows of the workflow in order, all under the correlation seed-0018', async () => {
    expect(
      await sq(
        `SELECT p.key, cr.state, cr.scope_type, cr.scope_ref, cr.requested_by, cr.approval_policy, cr.value_version_id IS NOT NULL AS has_version,
                (SELECT count(*)::int FROM configuration.change_approvals a WHERE a.change_request_id = cr.change_request_id) AS approvals,
                (SELECT string_agg(a.approver || ':' || a.decision, ',') FROM configuration.change_approvals a WHERE a.change_request_id = cr.change_request_id) AS approval
           FROM configuration.parameters p JOIN configuration.change_requests cr ON cr.parameter_id = p.parameter_id WHERE p.key LIKE 'provider.registration.%' ORDER BY p.key COLLATE "C"`,
      ),
    ).toEqual(
      [...POLICY_KEYS].sort(byName).map((key) => ({
        key,
        state: 'ACTIVE',
        scope_type: 'PLATFORM',
        scope_ref: null,
        requested_by: 'system:migration',
        approval_policy: 'SECOND_APPROVER',
        has_version: true,
        approvals: 1,
        approval: 'system:migration-review:APPROVE',
      })),
    );
    const audit = await sq<{ key: string; actions: string[]; actors: string[]; correlations: string[] }>(
      `SELECT p.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions, array_agg(DISTINCT a.actor ORDER BY a.actor) AS actors, array_agg(DISTINCT a.correlation_id) AS correlations
         FROM configuration.parameters p JOIN configuration.audit_events a ON a.parameter_id = p.parameter_id WHERE p.key LIKE 'provider.registration.%' GROUP BY p.key ORDER BY p.key COLLATE "C"`,
    );
    expect(audit).toHaveLength(5);
    for (const a of audit) {
      expect(a.actions, a.key).toEqual(['PARAMETER_CREATED', 'CHANGE_DRAFTED', 'CHANGE_SUBMITTED', 'CHANGE_APPROVED', 'CHANGE_PUBLISHED', 'CHANGE_ACTIVATED']);
      expect(a.actors, a.key).toEqual(['system:migration', 'system:migration-review']);
      expect(a.correlations, a.key).toEqual(['seed-0018']);
    }
  });

  it('keeps each seeded number inside its own validation rules and inside the contract ceilings (so the parameter definitions and the contract cannot drift)', async () => {
    const rules = Object.fromEntries(POLICY_SEEDS.map((p) => [p.key, p.rules as Record<string, unknown>]));
    const min = rules[PROVIDER_POLICY_KEYS.minServiceTypes] as { min: number; max: number };
    const max = rules[PROVIDER_POLICY_KEYS.maxServiceTypes] as { min: number; max: number };
    expect(min.max).toBe(PROVIDER_SERVICE_TYPES_CEILING);
    expect(max.max).toBe(PROVIDER_SERVICE_TYPES_CEILING);
    expect(1).toBeGreaterThanOrEqual(min.min);
    expect(1).toBeLessThanOrEqual(min.max);
    expect(10).toBeGreaterThanOrEqual(max.min);
    expect(10).toBeLessThanOrEqual(max.max);
    expect(1).toBeLessThanOrEqual(10); // min <= max, the contract's own refinement
    const schema = (rules[PROVIDER_POLICY_KEYS.marketStatusesAllowed] as { schema: { items: { enum: string[] }; maxItems: number } }).schema;
    expect(schema.items.enum).toEqual([...GEO_STATUSES]);
    expect(schema.maxItems).toBe(GEO_STATUSES.length);
    // the stored rules are the ones the seed documents (read from the database, not from this file)
    const stored = await sq<{ validation_rules: unknown }>('SELECT validation_rules FROM configuration.parameters WHERE key = $1', [
      PROVIDER_POLICY_KEYS.minServiceTypes,
    ]);
    expect(stored[0]!.validation_rules).toEqual({ min: 0, max: PROVIDER_SERVICE_TYPES_CEILING });
  });
});

describe('B2. seeded content: 56 PUBLISHED entries of managed copy for the minimal flow, resolved through the real ContentService', () => {
  const ALL_KEYS = SEED_CONTENT.map((r) => r[0]);

  it('seeds exactly the keys the contract helpers name (every step, step status, registration status, role state and error code) plus the 20 page keys, and no other provider.registration.* entry', async () => {
    const pageKeys = ALL_KEYS.filter((k) => k.startsWith(PAGE_PREFIX));
    expect(pageKeys).toHaveLength(20);
    expect(CONTRACT_KEYS).toHaveLength(
      ONBOARDING_STEPS.length +
        ONBOARDING_STEP_STATUSES.length +
        PROVIDER_REGISTRATION_STATUSES.length +
        PROVIDER_ROLE_STATES.length +
        PROVIDER_ERROR_CODES.length,
    );
    expect(CONTRACT_KEYS).toHaveLength(36);
    expect(new Set(CONTRACT_KEYS).size).toBe(36);
    expect(ALL_KEYS).toHaveLength(56);
    expect(new Set(ALL_KEYS).size).toBe(56);
    const stored = (await sq<{ key: string }>('SELECT key FROM content.entries WHERE key LIKE \'provider.registration.%\' ORDER BY key COLLATE "C"')).map(
      (r) => r.key,
    );
    expect(stored).toEqual([...CONTRACT_KEYS, ...pageKeys].sort(byName));
    expect(stored).toHaveLength(56);
    // and the future steps named by the contract are labelled too (a step the evaluator reports as NOT_AVAILABLE still needs a label)
    for (const s of FUTURE_STEPS) expect(stored).toContain(providerStepLabelKey(s));
    // the keys follow the contract's own naming (lower-case member of the vocabulary), one helper at a time
    expect(providerStepLabelKey('GIGS')).toBe('provider.registration.step.gigs.label');
    expect(providerStepStatusKey('NOT_AVAILABLE')).toBe('provider.registration.step_status.not_available');
    expect(providerRegistrationStatusKey('IN_PROGRESS')).toBe('provider.registration.status.in_progress');
    expect(providerRoleStateKey('NONE')).toBe('provider.registration.role.none');
    expect(providerErrorKey('STALE_REGISTRATION')).toBe('provider.registration.error.stale_registration');
  });

  it('defines every entry as PUBLIC, STANDARD, CONTENT-owned, approval NONE, fallback CHAIN, up to MARKET scope, created by the migration; UI_LABEL for labels and headings, PLAIN_TEXT for sentences; never LEGAL', async () => {
    const rows = await sq<Record<string, unknown>>(
      `SELECT key, content_type, owner_role, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by, length(btrim(description)) > 10 AS described
         FROM content.entries WHERE key LIKE 'provider.registration.%' ORDER BY key COLLATE "C"`,
    );
    expect(rows).toHaveLength(56);
    const types = new Map(SEED_CONTENT.map((r) => [r[0], r[1]]));
    for (const r of rows) {
      expect(r, String(r.key)).toMatchObject({
        owner_role: 'CONTENT',
        sensitivity: 'PUBLIC',
        criticality: 'STANDARD',
        approval_policy: 'NONE',
        fallback_policy: 'CHAIN',
        max_scope_type: 'MARKET',
        created_by: 'system:migration',
        described: true,
      });
      expect(r.content_type, String(r.key)).toBe(types.get(r.key as string));
      expect(r.content_type).not.toBe('LEGAL');
    }
    expect(rows.filter((r) => r.content_type === 'UI_LABEL')).toHaveLength(SEED_CONTENT.filter((r) => r[1] === 'UI_LABEL').length);
    // every error message is a sentence (PLAIN_TEXT); every label of a step, status or role is a label
    for (const k of [...PROVIDER_ERROR_CODES.map(providerErrorKey)]) expect(types.get(k), k).toBe('PLAIN_TEXT');
    for (const k of [...ONBOARDING_STEPS.map(providerStepLabelKey), ...ONBOARDING_STEP_STATUSES.map(providerStepStatusKey)])
      expect(types.get(k), k).toBe('UI_LABEL');
  });

  it('gives each entry exactly one version: en-US, PLATFORM scope, version 1, PUBLISHED, in force, with the exact English copy of the seed', async () => {
    const rows = await sq<{
      key: string;
      locale: string;
      scope_type: string;
      scope_ref: string | null;
      version: number;
      status: string;
      approval_policy: string;
      body: string;
      in_force: string;
      created_by: string;
    }>(
      `SELECT e.key, v.locale, v.scope_type, v.scope_ref, v.version, v.status, v.approval_policy, v.body, v.created_by,
              identity.consent_version_state(v.version_id, e.entry_id, now()) AS in_force
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'provider.registration.%' ORDER BY e.key COLLATE "C"`,
    );
    expect(rows).toHaveLength(56);
    const bodies = new Map(SEED_CONTENT.map((r) => [r[0], r[2]]));
    for (const r of rows) {
      expect(
        { locale: r.locale, scope: r.scope_type, ref: r.scope_ref, version: r.version, status: r.status, approval: r.approval_policy, by: r.created_by },
        r.key,
      ).toEqual({
        locale: 'en-US',
        scope: 'PLATFORM',
        ref: null,
        version: 1,
        status: 'PUBLISHED',
        approval: 'NONE',
        by: 'system:migration',
      });
      expect(r.in_force, r.key).toBe('IN_FORCE');
      expect(r.body, r.key).toBe(bodies.get(r.key));
    }
  });

  it('went through the real content lifecycle: five audit rows per entry (created, drafted, approved, published, activated) under the correlation seed-0018', async () => {
    const rows = await sq<{ key: string; actions: string[]; correlations: string[]; actors: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions, array_agg(DISTINCT a.correlation_id) AS correlations, array_agg(DISTINCT a.actor) AS actors
         FROM content.entries e JOIN content.audit_events a ON a.entry_id = e.entry_id WHERE e.key LIKE 'provider.registration.%' GROUP BY e.key ORDER BY e.key COLLATE "C"`,
    );
    expect(rows).toHaveLength(56);
    for (const r of rows) {
      expect(r.actions, r.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
      expect(r.correlations, r.key).toEqual(['seed-0018']);
      expect(r.actors, r.key).toEqual(['system:migration']);
    }
  });

  it('renders non-empty, exact en-US text for every one of the 56 keys with the content registry itself, with and without a market, in the public view', async () => {
    const content = new ContentService({ database: seed.database, env: 'test' });
    for (const [key, , body] of SEED_CONTENT) {
      expect((await content.render(key, { locale: 'en-US' })).value, key).toBe(body);
      expect((await content.render(key, { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false })).value, key).toBe(body);
    }
    const batch = await content.resolveRendered(ALL_KEYS, { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false });
    expect(batch.missing.size).toBe(0);
    expect(batch.items.size).toBe(56);
    // every key the contract can name resolves (the contract helpers and the seed cannot drift)
    const contract = await content.resolveRendered(CONTRACT_KEYS, { locale: 'en-US', includeInternal: false });
    expect(contract.missing.size).toBe(0);
    expect(contract.items.size).toBe(36);
  });

  it('holds no variable, markup, address, number, URL, identifier or legal wording in any copy, and no error message leaks an internal (a code, a constraint, a table)', async () => {
    for (const [key, , body] of SEED_CONTENT) {
      expect(body, key).not.toMatch(/[{}<>@]|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d/i);
      expect(body.trim(), key).toBe(body);
      expect(body.length, key).toBeGreaterThan(2);
      expect(body.length, key).toBeLessThan(200);
      expect(body, key).not.toMatch(/\b(constraint|SQL|exception|stack|undefined|null|provider_rule|uuid|table)\b/i);
    }
    expect(ALL_KEYS.filter((k) => /terms|privacy|price|fee|commission|legal_text|licen[cs]e/i.test(k))).toEqual([]);
    for (const [key, type, body] of SEED_CONTENT) if (type === 'UI_LABEL') expect(body.length, key).toBeLessThan(50);
  });

  it('is referenced by the sources: every provider.registration.* key literal the contract, the provider package, the API and the web app name exists as seeded copy or as a seeded parameter', async () => {
    const root = path.join(import.meta.dirname, '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name === 'dist' || name.startsWith('.')) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.(test|itest)\.tsx?$/.test(name)) files.push(p);
      }
    };
    for (const d of ['apps', 'packages']) walk(path.join(root, d));
    const known = new Set([...ALL_KEYS, ...POLICY_KEYS]);
    const prefixes = new Set([
      'provider.registration.page',
      'provider.registration.error',
      'provider.registration.step',
      'provider.registration.step_status',
      'provider.registration.status',
      'provider.registration.role',
    ]);
    const unknown: string[] = [];
    let found = 0;
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/provider\.registration\.[a-z_]+(?:\.[a-z_]+)*/g)) {
        found++;
        if (!known.has(m[0]) && !prefixes.has(m[0])) unknown.push(`${path.relative(root, f)}: ${m[0]}`);
      }
    }
    expect(found, 'the scan is not vacuous').toBeGreaterThan(5);
    expect(unknown).toEqual([]);
  });
});

// ====================================================================== C. every CHECK, NOT NULL and the vocabularies (the guard triggers are disabled for the rolled-back statement, so the constraint alone answers)
async function rolledBack<T>(fn: (c: pg.PoolClient) => Promise<T>, from: pg.Pool = pool): Promise<T> {
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
interface RawReg {
  status?: string;
  attempt?: number | null;
  revision?: number | null;
  market?: string | null;
  completed?: boolean;
  cancelled?: boolean;
}
const rawReg = (account: string | null, o: RawReg = {}): [string, unknown[]] => [
  `INSERT INTO ${REG} (account_id, attempt_number, status, market_id, revision, completed_at, cancelled_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [
    account,
    o.attempt === undefined ? 1 : o.attempt,
    o.status === undefined ? 'IN_PROGRESS' : o.status,
    o.market ?? null,
    o.revision === undefined ? 1 : o.revision,
    o.completed ? new Date() : null,
    o.cancelled ? new Date() : null,
  ],
];
const insertRaw = (account: string | null, o: RawReg = {}) => isolated(noTriggers(REG), ...rawReg(account, o));

describe('C1. registrations: the status list, attempt >= 1, revision >= 1, the lifecycle in every combination, NOT NULL', () => {
  let acct: string;
  beforeAll(async () => {
    acct = await makeAccount();
  });

  it('accepts exactly the three statuses of the contract (with a consistent lifecycle) and rejects anything else, whatever the case or blank', async () => {
    for (const s of PROVIDER_REGISTRATION_STATUSES)
      await insertRaw(acct, { status: s, completed: s === 'COMPLETED', cancelled: s === 'CANCELLED', market: s === 'COMPLETED' ? laOc : null });
    for (const bad of ['BOGUS', 'SUBMITTED', 'in_progress', 'Completed', '', ' IN_PROGRESS', 'IN_PROGRESS ', 'CANCELED'])
      expect(['ck_registrations__lifecycle', 'ck_registrations__status'], JSON.stringify(bad)).toContain(await outcomeOf(insertRaw(acct, { status: bad })));
  });

  it('refuses an attempt number below 1 and a revision below 1 by their own constraints, and accepts 1 and large values', async () => {
    for (const n of [0, -1, -2147483648]) await expectConstraint(insertRaw(acct, { attempt: n }), 'ck_registrations__attempt');
    for (const n of [0, -1, -2147483648]) await expectConstraint(insertRaw(acct, { revision: n }), 'ck_registrations__revision');
    for (const n of [1, 2, 99, 2147483647]) {
      await insertRaw(acct, { attempt: n });
      await insertRaw(acct, { revision: n });
    }
  });

  it('enforces the lifecycle in all 24 combinations of status x completed_at x cancelled_at x market: exactly IN_PROGRESS with neither timestamp (market free), COMPLETED with completed_at, a market and no cancelled_at, CANCELLED with cancelled_at and no completed_at (market free)', async () => {
    const allowed = (status: string, completed: boolean, cancelled: boolean, market: boolean): boolean =>
      status === 'IN_PROGRESS'
        ? !completed && !cancelled
        : status === 'COMPLETED'
          ? completed && !cancelled && market
          : status === 'CANCELLED'
            ? cancelled && !completed
            : false;
    const observed: { status: string; completed: boolean; cancelled: boolean; market: boolean; outcome: string }[] = [];
    for (const status of PROVIDER_REGISTRATION_STATUSES)
      for (const completed of [false, true])
        for (const cancelled of [false, true])
          for (const market of [false, true])
            observed.push({
              status,
              completed,
              cancelled,
              market,
              outcome: await outcomeOf(insertRaw(acct, { status, completed, cancelled, market: market ? laOc : null })),
            });
    expect(observed).toHaveLength(24);
    expect(observed).toEqual(
      observed.map((o) => ({ ...o, outcome: allowed(o.status, o.completed, o.cancelled, o.market) ? 'ACCEPTED' : 'ck_registrations__lifecycle' })),
    );
    expect(observed.filter((o) => o.outcome === 'ACCEPTED')).toHaveLength(5);
  });

  it('refuses a NULL in every NOT NULL column by name (the guards are off, so the column answers)', async () => {
    const cols: [string, string, unknown[]][] = [
      ['provider_registration_id', 'NULL, $1, 1', [acct]],
      ['account_id', 'gen_random_uuid(), NULL, 1', []],
      ['attempt_number', 'gen_random_uuid(), $1, NULL', [acct]],
    ];
    for (const [col, values, params] of cols)
      await expectNotNull(
        isolated(noTriggers(REG), `INSERT INTO ${REG} (provider_registration_id, account_id, attempt_number) VALUES (${values})`, params),
        col,
      );
    await expectNotNull(insertRaw(acct, { status: null as unknown as string }), 'status');
    await expectNotNull(insertRaw(acct, { revision: null }), 'revision');
    for (const col of ['created_at', 'updated_at'])
      await expectNotNull(isolated(noTriggers(REG), `INSERT INTO ${REG} (account_id, attempt_number, ${col}) VALUES ($1, 1, NULL)`, [acct]), col);
    // with the guards ON, a NULL attempt number reaches the NOT NULL constraint (the guard cannot compare it) and a NULL account is not an ACTIVE account
    await expectNotNull(run(...rawReg(acct, { attempt: null })), 'attempt_number');
    await expectRule(run(...rawReg(null)), 'ACCOUNT_NOT_ACTIVE');
  });
});

describe('C2. audit_events: the action list, one object of changes, a non-blank bounded reason and actor, NOT NULL, the foreign key', () => {
  let reg: string;
  beforeAll(async () => {
    reg = (await make()).id;
  });
  const ins = (o: {
    action?: string;
    actor?: string | null;
    changes?: string | null;
    reason?: string | null;
    correlation?: string | null;
    regId?: string | null;
  }) =>
    isolated([], `INSERT INTO ${AUDIT} (actor, action, provider_registration_id, changes, reason, correlation_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`, [
      o.actor === undefined ? 'account:test' : o.actor,
      o.action ?? 'PROVIDER_REGISTRATION_STARTED',
      o.regId === undefined ? reg : o.regId,
      o.changes === undefined ? null : o.changes,
      o.reason === undefined ? null : o.reason,
      o.correlation === undefined ? 'c-1' : o.correlation,
    ]);

  it('accepts exactly the five actions the service writes and refuses any other, including the near misses', async () => {
    for (const a of AUDIT_ACTIONS) await ins({ action: a });
    for (const bad of [
      'PROVIDER_REGISTRATION_SUBMITTED',
      'PROVIDER_ROLE_GRANTED',
      'provider_registration_started',
      '',
      ' PROVIDER_REGISTRATION_STARTED',
      'PROVIDER_REGISTRATION_STARTED ',
      'MARKET_SELECTED',
    ])
      await expectConstraint(ins({ action: bad }), 'ck_audit_events__action');
  });

  it('accepts NULL or a JSON OBJECT as the diff and refuses an array, a scalar, a string and a JSON null', async () => {
    for (const ok of [null, '{}', '{"a":1}', '{"serviceTypeCodes":["x","y"],"count":2}', '{"market":["la-oc",null]}']) await ins({ changes: ok });
    for (const bad of ['[]', '[1]', '"x"', '1', 'true', 'null']) await expectConstraint(ins({ changes: bad }), 'ck_audit_events__changes_object');
  });

  it('accepts a missing reason or one of 1 to 1000 characters and refuses an empty or blank reason and one of 1001 characters (characters, not bytes)', async () => {
    for (const ok of [null, 'x', ' x ', 'a'.repeat(1000), 'é'.repeat(1000), String.fromCodePoint(0x1f600).repeat(1000)]) await ins({ reason: ok });
    for (const bad of ['', ' ', '   ', 'a'.repeat(1001), String.fromCodePoint(0x1f600).repeat(1001)])
      await expectConstraint(ins({ reason: bad }), 'ck_audit_events__reason');
  });

  it('refuses a blank actor and one over 200 characters, accepts the account and system forms', async () => {
    for (const ok of ['account:00000000-0000-0000-0000-000000000000', 'system:migration', 'a', 'a'.repeat(200)]) await ins({ actor: ok });
    for (const bad of ['', ' ', '    ', 'a'.repeat(201)]) await expectConstraint(ins({ actor: bad }), 'ck_audit_events__actor');
  });

  it('refuses a NULL actor, action, registration or correlation id by column name, and a registration that does not exist by the foreign key', async () => {
    await expectNotNull(ins({ actor: null }), 'actor');
    await expectNotNull(ins({ regId: null }), 'provider_registration_id');
    await expectNotNull(ins({ correlation: null }), 'correlation_id');
    await expectNotNull(
      isolated([], `INSERT INTO ${AUDIT} (actor, action, provider_registration_id, correlation_id) VALUES ('a', NULL, $1, 'c')`, [reg]),
      'action',
    );
    await expectNotNull(
      isolated(
        [],
        `INSERT INTO ${AUDIT} (audit_event_id, actor, action, provider_registration_id, correlation_id) VALUES (NULL, 'a', 'PROVIDER_REGISTRATION_STARTED', $1, 'c')`,
        [reg],
      ),
      'audit_event_id',
    );
    await expectNotNull(
      isolated(
        [],
        `INSERT INTO ${AUDIT} (occurred_at, actor, action, provider_registration_id, correlation_id) VALUES (NULL, 'a', 'PROVIDER_REGISTRATION_STARTED', $1, 'c')`,
        [reg],
      ),
      'occurred_at',
    );
    await expectConstraint(ins({ regId: '00000000-0000-4000-8000-000000000000' }), 'fk_audit_events__registration_id');
  });

  it('writes the identity of the event itself: a fresh id and a time that advances inside one transaction (clock_timestamp), and takes an audit row for a registration in ANY status (the event follows the status change)', async () => {
    const c = await make('COMPLETED');
    const t = await make('CANCELLED');
    for (const id of [c.id, t.id]) await audit(id, 'PROVIDER_REGISTRATION_COMPLETED');
    expect(await count(AUDIT, 'provider_registration_id = ANY($1)', [[c.id, t.id]])).toBe(2);
    const times = await inTx(async (x) => {
      await audit(reg, 'PROVIDER_MARKET_SELECTED', {}, x);
      await sleep(5);
      await audit(reg, 'PROVIDER_MARKET_SELECTED', {}, x);
      return (await x.query(`SELECT occurred_at FROM ${AUDIT} WHERE provider_registration_id = $1 ORDER BY occurred_at DESC LIMIT 2`, [reg])).rows as {
        occurred_at: Date;
      }[];
    });
    expect(times[0]!.occurred_at.getTime()).toBeGreaterThan(times[1]!.occurred_at.getTime());
  });
});

// ====================================================================== D. the guards, each on its exact failing statement
describe('D1. NOT_DELETABLE: a registration is cancelled, never deleted', () => {
  it.each(['IN_PROGRESS', 'MARKET', 'COMPLETED', 'CANCELLED'] as Kind[])(
    'refuses DELETE of a %s registration, one row and all rows, and leaves it untouched',
    async (kind) => {
      const { id } = await make(kind);
      const before = await regRow(id);
      await expectRule(run(`DELETE FROM ${REG} WHERE provider_registration_id = $1`, [id]), 'NOT_DELETABLE');
      await expectRule(run(`DELETE FROM ${REG}`), 'NOT_DELETABLE');
      await expectRule(run(`DELETE FROM ${REG} WHERE true`), 'NOT_DELETABLE');
      expect(await regRow(id)).toEqual(before);
    },
  );
  it('lets a DELETE that matches no row through (nothing is deleted, nothing to refuse)', async () => {
    await run(`DELETE FROM ${REG} WHERE provider_registration_id = gen_random_uuid()`);
  });
});

describe('D2. IMMUTABLE_IDENTITY: the id, the account, the attempt number and the creation time never change', () => {
  const changes: [string, (other: string) => string][] = [
    ['the id', () => 'provider_registration_id = gen_random_uuid()'],
    ['the account', () => 'account_id = $2'],
    ['the attempt number', () => 'attempt_number = attempt_number + 1'],
    ['the creation time', () => "created_at = created_at - interval '1 day'"],
    ['the creation time (forwards)', () => "created_at = created_at + interval '1 second'"],
    ['everything at once', () => "provider_registration_id = gen_random_uuid(), account_id = $2, attempt_number = 9, created_at = now() - interval '1 year'"],
  ];
  it.each(changes)('refuses to change %s of an IN_PROGRESS registration', async (_label, set) => {
    const { id } = await make('MARKET');
    const other = await makeAccount();
    const before = await regRow(id);
    await expectRule(
      run(`UPDATE ${REG} SET ${set(other)} WHERE provider_registration_id = $1`, [id, other].slice(0, set(other).includes('$2') ? 2 : 1)),
      'IMMUTABLE_IDENTITY',
    );
    expect(await regRow(id)).toEqual(before);
  });
  it.each(['COMPLETED', 'CANCELLED'] as Kind[])(
    'answers IMMUTABLE_IDENTITY (not REGISTRATION_FROZEN) when a %s registration has its identity changed: the identity rule is judged first',
    async (kind) => {
      const { id } = await make(kind);
      const other = await makeAccount();
      await expectRule(run(`UPDATE ${REG} SET account_id = $2 WHERE provider_registration_id = $1`, [id, other]), 'IMMUTABLE_IDENTITY');
      await expectRule(run(`UPDATE ${REG} SET attempt_number = 7 WHERE provider_registration_id = $1`, [id]), 'IMMUTABLE_IDENTITY');
      await expectRule(
        run(`UPDATE ${REG} SET created_at = now() + interval '1 day', revision = revision + 1 WHERE provider_registration_id = $1`, [id]),
        'IMMUTABLE_IDENTITY',
      );
    },
  );
  it('accepts an UPDATE that sets the identity columns to their own values (no change), and leaves the identity alone when other columns change', async () => {
    const { id } = await make('MARKET');
    const before = await regRow(id);
    await run(
      `UPDATE ${REG} SET provider_registration_id = provider_registration_id, account_id = account_id, attempt_number = attempt_number, created_at = created_at WHERE provider_registration_id = $1`,
      [id],
    );
    await run(`UPDATE ${REG} SET revision = revision + 5 WHERE provider_registration_id = $1`, [id]);
    const after = await regRow(id);
    expect([after.provider_registration_id, after.account_id, after.attempt_number, after.created_at]).toEqual([
      before.provider_registration_id,
      before.account_id,
      before.attempt_number,
      before.created_at,
    ]);
  });
});

describe('D3. MUST_START_IN_PROGRESS: a registration is born IN_PROGRESS at revision 1 with neither timestamp', () => {
  const insertWith = (account: string, set: Partial<{ status: string; revision: number; completed_at: string; cancelled_at: string }>) => {
    const cols = ['account_id', 'attempt_number', ...Object.keys(set)];
    const vals = ['$1', '1', ...Object.values(set).map((v) => (typeof v === 'number' ? String(v) : `'${v}'`))];
    return run(`INSERT INTO ${REG} (${cols.join(', ')}) VALUES (${vals.join(', ')})`, [account]);
  };
  const bad: [string, Parameters<typeof insertWith>[1]][] = [
    ['COMPLETED', { status: 'COMPLETED' }],
    ['CANCELLED', { status: 'CANCELLED' }],
    ['an unknown status', { status: 'BOGUS' }],
    ['SUBMITTED', { status: 'SUBMITTED' }],
    ['revision 2', { revision: 2 }],
    ['revision 0 (the rule, before the CHECK)', { revision: 0 }],
    ['revision 1000', { revision: 1000 }],
    ['a completed_at', { completed_at: '2030-01-01T00:00:00Z' }],
    ['a cancelled_at', { cancelled_at: '2030-01-01T00:00:00Z' }],
    ['COMPLETED with its timestamp', { status: 'COMPLETED', completed_at: '2030-01-01T00:00:00Z' }],
    ['CANCELLED with its timestamp', { status: 'CANCELLED', cancelled_at: '2030-01-01T00:00:00Z' }],
  ];
  it.each(bad)('refuses to insert %s', async (_label, set) => {
    const account = await makeAccount();
    await expectRule(insertWith(account, set), 'MUST_START_IN_PROGRESS');
    expect(await count(REG, 'account_id = $1', [account])).toBe(0);
  });
  it('judges the start state BEFORE the account and the attempt number (a bad start for a non-ACTIVE account and a wrong attempt still answers MUST_START_IN_PROGRESS)', async () => {
    const suspended = await accountIn('SUSPENDED');
    await expectRule(run(`INSERT INTO ${REG} (account_id, attempt_number, status) VALUES ($1, 7, 'COMPLETED')`, [suspended]), 'MUST_START_IN_PROGRESS');
  });
  it('accepts an insert that names the initial state explicitly (status IN_PROGRESS, revision 1, NULL timestamps) and by default', async () => {
    const a = await makeAccount();
    await run(`INSERT INTO ${REG} (account_id, attempt_number, status, revision, completed_at, cancelled_at) VALUES ($1, 1, 'IN_PROGRESS', 1, NULL, NULL)`, [
      a,
    ]);
    const b = await makeAccount();
    const id = await start(b);
    expect(await regRow(id)).toMatchObject({ status: 'IN_PROGRESS', revision: 1, attempt_number: 1, market_id: null, completed_at: null, cancelled_at: null });
  });
});

describe('D4. REGISTRATION_ATTEMPT_SEQUENCE: the next attempt is the highest plus one, for that account', () => {
  const insertAttempt = (account: string, n: number) => run(`INSERT INTO ${REG} (account_id, attempt_number) VALUES ($1, $2)`, [account, n]);
  it('refuses a first attempt other than 1 (a gap, 0 and a negative number) and accepts 1', async () => {
    const a = await makeAccount();
    for (const n of [2, 3, 100, 0, -1]) await expectRule(insertAttempt(a, n), 'REGISTRATION_ATTEMPT_SEQUENCE');
    expect(await count(REG, 'account_id = $1', [a])).toBe(0);
    await insertAttempt(a, 1);
  });
  it('refuses a gap (3 after 1), a repeat (1 after 1) and a step back, in the guard (before the unique key could), and accepts 2', async () => {
    const a = await makeAccount();
    const first = await start(a);
    await cancelReg(first);
    for (const n of [3, 4, 1, 0]) await expectRule(insertAttempt(a, n), 'REGISTRATION_ATTEMPT_SEQUENCE');
    await insertAttempt(a, 2);
    expect((await q<{ n: number }>(`SELECT attempt_number AS n FROM ${REG} WHERE account_id = $1 ORDER BY 1`, [a])).map((r) => r.n)).toEqual([1, 2]);
  });
  it('answers the rule (not the unique key) for a repeat of an attempt that is still live', async () => {
    const a = await makeAccount();
    await start(a);
    await expectRule(insertAttempt(a, 1), 'REGISTRATION_ATTEMPT_SEQUENCE');
  });
  it('counts the attempts of ONE account: another account starts at 1 whatever the first one holds, and keeps its own sequence across cancelled attempts', async () => {
    const [a, b] = [await makeAccount(), await makeAccount()];
    const a1 = await start(a);
    await cancelReg(a1);
    const a2 = await start(a);
    await cancelReg(a2);
    const a3 = await start(a);
    const b1 = await start(b);
    expect([
      (await regRow(a1)).attempt_number,
      (await regRow(a2)).attempt_number,
      (await regRow(a3)).attempt_number,
      (await regRow(b1)).attempt_number,
    ]).toEqual([1, 2, 3, 1]);
    await expectRule(insertAttempt(b, 3), 'REGISTRATION_ATTEMPT_SEQUENCE');
    await expectRule(insertAttempt(a, 3), 'REGISTRATION_ATTEMPT_SEQUENCE');
    await expectRule(insertAttempt(a, 5), 'REGISTRATION_ATTEMPT_SEQUENCE');
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('D5. ACCOUNT_NOT_ACTIVE: only an ACTIVE account starts or completes a registration (the account row is read FOR SHARE)', () => {
  it.each(['PENDING', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED'] as AccountStatus[])('refuses to start a registration for a %s account', async (status) => {
    const a = await accountIn(status);
    await expectRule(run(`INSERT INTO ${REG} (account_id, attempt_number) VALUES ($1, 1)`, [a]), 'ACCOUNT_NOT_ACTIVE');
    // judged before the attempt number: a wrong attempt for a non-ACTIVE account still answers the account rule
    await expectRule(run(`INSERT INTO ${REG} (account_id, attempt_number) VALUES ($1, 9)`, [a]), 'ACCOUNT_NOT_ACTIVE');
    expect(await count(REG, 'account_id = $1', [a])).toBe(0);
  });
  it('refuses an account that does not exist as not ACTIVE (the guard answers before the foreign key could), and accepts an ACTIVE account', async () => {
    await expectRule(run(`INSERT INTO ${REG} (account_id, attempt_number) VALUES (gen_random_uuid(), 1)`), 'ACCOUNT_NOT_ACTIVE');
    await start(await makeAccount('ACTIVE'));
  });
  it.each(['SUSPENDED', 'CLOSURE_REQUESTED'] as AccountStatus[])(
    'refuses to COMPLETE a registration once the account is %s, leaves it IN_PROGRESS, and completes after the account is ACTIVE again',
    async (status) => {
      const { account, id } = await make('MARKET');
      await setStatus(account, status);
      await expectRule(completeReg(id), 'ACCOUNT_NOT_ACTIVE');
      expect(await regRow(id)).toMatchObject({ status: 'IN_PROGRESS', completed_at: null });
      await setStatus(account, 'ACTIVE');
      await completeReg(id);
      expect(await regRow(id)).toMatchObject({ status: 'COMPLETED' });
    },
  );
  it('lets a SUSPENDED account CANCEL its registration and change the draft (only the completion needs an ACTIVE account: the service gates the rest)', async () => {
    const { account, id } = await make('MARKET');
    await setStatus(account, 'SUSPENDED');
    await run(`UPDATE ${REG} SET revision = revision + 1 WHERE provider_registration_id = $1`, [id]);
    await cancelReg(id);
    expect(await regRow(id)).toMatchObject({ status: 'CANCELLED', revision: 3 });
  });
  it('does not look at the account when a registration is CANCELLED and a new attempt of a SUSPENDED account is still refused', async () => {
    const { account, id } = await make('MARKET');
    await cancelReg(id);
    await setStatus(account, 'SUSPENDED');
    await expectRule(run(`INSERT INTO ${REG} (account_id, attempt_number) VALUES ($1, 2)`, [account]), 'ACCOUNT_NOT_ACTIVE');
  });
});

describe('D6. STATUS_TRANSITION and the 3 x 3 matrix against the contract', () => {
  it('refuses a status that is not COMPLETED or CANCELLED as the target of a change (an unknown, a near miss, a lower-case one, NULL-like text) before the CHECK could, and the row stays', async () => {
    const { id } = await make('MARKET');
    for (const bad of ['BOGUS', 'SUBMITTED', 'in_progress', 'completed', '', 'CANCELED', 'Cancelled'])
      await expectRule(run(`UPDATE ${REG} SET status = $2 WHERE provider_registration_id = $1`, [id, bad]), 'STATUS_TRANSITION');
    expect(await regRow(id)).toMatchObject({ status: 'IN_PROGRESS', revision: 2 });
  });

  const PAIRS = PROVIDER_REGISTRATION_STATUSES.flatMap((from) =>
    PROVIDER_REGISTRATION_STATUSES.map((to) => [from, to] as [ProviderRegistrationStatus, ProviderRegistrationStatus]),
  );
  it.each(PAIRS)(
    "%s -> %s: the outcome is the contract's (allowed transitions succeed; a terminal registration is frozen; a same-state UPDATE of IN_PROGRESS is a draft change, not a transition)",
    async (from, to) => {
      const { id } = await make(STATUS_KIND[from]);
      const outcome = await outcomeOf(run(`UPDATE ${REG} SET status = $2 WHERE provider_registration_id = $1`, [id, to]));
      if (from === 'IN_PROGRESS') {
        expect(outcome).toBe('ACCEPTED');
        if (from !== to) expect(isProviderRegistrationTransitionAllowed(from, to)).toBe(true);
      } else {
        expect(outcome).toBe('REGISTRATION_FROZEN');
        expect(isProviderRegistrationTransitionAllowed(from, to)).toBe(false);
      }
      const after = await regRow(id);
      expect(after.status).toBe(outcome === 'ACCEPTED' ? to : from);
    },
  );

  it('agrees with isProviderRegistrationTransitionAllowed on every pair of distinct statuses: success exactly when the contract allows it', async () => {
    const seen: string[] = [];
    for (const from of PROVIDER_REGISTRATION_STATUSES)
      for (const to of PROVIDER_REGISTRATION_STATUSES) {
        if (from === to) continue;
        const { id } = await make(STATUS_KIND[from]);
        const ok = (await outcomeOf(run(`UPDATE ${REG} SET status = $2 WHERE provider_registration_id = $1`, [id, to]))) === 'ACCEPTED';
        expect(ok, `${from} -> ${to}`).toBe(isProviderRegistrationTransitionAllowed(from, to));
        seen.push(`${from}>${to}:${ok}`);
      }
    expect(seen.sort()).toEqual([
      'CANCELLED>COMPLETED:false',
      'CANCELLED>IN_PROGRESS:false',
      'COMPLETED>CANCELLED:false',
      'COMPLETED>IN_PROGRESS:false',
      'IN_PROGRESS>CANCELLED:true',
      'IN_PROGRESS>COMPLETED:true',
    ]);
  });

  it('stamps the terminal timestamps itself: COMPLETED sets completed_at (and no cancelled_at), CANCELLED sets cancelled_at (and no completed_at), both at the transaction time, and the registration is never reopened', async () => {
    const done = await make('MARKET');
    const gone = await make('MARKET');
    const [c, x] = await inTx(async (t) => {
      await completeReg(done.id, t);
      await cancelReg(gone.id, t);
      const r = await t.query(
        `SELECT provider_registration_id AS id, completed_at = now() AS c_now, cancelled_at = now() AS x_now, completed_at IS NULL AS c_null, cancelled_at IS NULL AS x_null, updated_at = now() AS u_now, status
           FROM ${REG} WHERE provider_registration_id = ANY($1)`,
        [[done.id, gone.id]],
      );
      const by = Object.fromEntries((r.rows as { id: string }[]).map((row) => [row.id, row]));
      return [by[done.id], by[gone.id]];
    });
    expect(c).toMatchObject({ status: 'COMPLETED', c_now: true, x_null: true, u_now: true });
    expect(x).toMatchObject({ status: 'CANCELLED', x_now: true, c_null: true, u_now: true });
  });

  it('ignores a timestamp the caller writes: a completion keeps its own completed_at (never the supplied one) and clears a supplied cancelled_at, a cancellation does the mirror image, and a plain draft change clears both', async () => {
    const done = await make('MARKET');
    await run(`UPDATE ${REG} SET status = 'COMPLETED', completed_at = '2001-01-01', cancelled_at = '2001-01-01' WHERE provider_registration_id = $1`, [
      done.id,
    ]);
    const gone = await make('MARKET');
    await run(`UPDATE ${REG} SET status = 'CANCELLED', completed_at = '2001-01-01', cancelled_at = '2001-01-01' WHERE provider_registration_id = $1`, [
      gone.id,
    ]);
    const draft = await make('MARKET');
    await run(`UPDATE ${REG} SET revision = revision + 1, completed_at = '2001-01-01', cancelled_at = '2001-01-01' WHERE provider_registration_id = $1`, [
      draft.id,
    ]);
    const [d, g, w] = [await regRow(done.id), await regRow(gone.id), await regRow(draft.id)];
    expect(d.completed_at!.getFullYear()).toBeGreaterThan(2020);
    expect(d.cancelled_at).toBeNull();
    expect(g.cancelled_at!.getFullYear()).toBeGreaterThan(2020);
    expect(g.completed_at).toBeNull();
    expect([w.completed_at, w.cancelled_at, w.status]).toEqual([null, null, 'IN_PROGRESS']);
  });

  it('refuses to complete a registration that has no market (the lifecycle CHECK: a COMPLETED registration names its market) and leaves it IN_PROGRESS', async () => {
    const { id } = await make('IN_PROGRESS');
    await expectConstraint(completeReg(id), 'ck_registrations__lifecycle');
    expect(await regRow(id)).toMatchObject({ status: 'IN_PROGRESS', market_id: null });
    await cancelReg(id); // a registration without a market can still be cancelled
    expect(await regRow(id)).toMatchObject({ status: 'CANCELLED', market_id: null });
  });
});

describe('D7. REGISTRATION_FROZEN: a COMPLETED or CANCELLED registration never changes again, and a transition changes nothing else', () => {
  const statements: [string, string][] = [
    ['a no-op revision', 'revision = revision'],
    ['a revision bump', 'revision = revision + 1'],
    ['a no-op market', 'market_id = market_id'],
    ['clearing the market', 'market_id = NULL'],
    ['a no-op updated_at', 'updated_at = now()'],
    ['clearing completed_at', 'completed_at = NULL'],
    ['setting cancelled_at', 'cancelled_at = now()'],
    ['reopening to IN_PROGRESS', "status = 'IN_PROGRESS'"],
    ['the same status', 'status = status'],
    ['the other terminal status', "status = CASE WHEN status = 'COMPLETED' THEN 'CANCELLED' ELSE 'COMPLETED' END"],
  ];
  const cases = (['COMPLETED', 'CANCELLED'] as Kind[]).flatMap((kind) => statements.map(([label, set]) => [kind, label, set] as [Kind, string, string]));
  it.each(cases)('refuses on a %s registration: %s', async (kind, _label, set) => {
    const { id } = await make(kind);
    const before = await regRow(id);
    await expectRule(run(`UPDATE ${REG} SET ${set} WHERE provider_registration_id = $1`, [id]), 'REGISTRATION_FROZEN');
    expect(await regRow(id)).toEqual(before);
  });
  it('lets an UPDATE that matches no row through, on any table state', async () => {
    await run(`UPDATE ${REG} SET revision = revision WHERE false`);
    await run(`UPDATE ${REG} SET revision = revision WHERE provider_registration_id = gen_random_uuid()`);
  });
  it('refuses a transition that also changes the market or the revision (a transition changes nothing else), and the registration stays IN_PROGRESS and unchanged', async () => {
    const noMarket = await make('IN_PROGRESS');
    const withMarket = await make('MARKET');
    const before = [await regRow(noMarket.id), await regRow(withMarket.id)];
    await expectRule(
      run(`UPDATE ${REG} SET status = 'COMPLETED', market_id = $2 WHERE provider_registration_id = $1`, [noMarket.id, laOc]),
      'REGISTRATION_FROZEN',
    );
    await expectRule(
      run(`UPDATE ${REG} SET status = 'CANCELLED', market_id = $2 WHERE provider_registration_id = $1`, [noMarket.id, laOc]),
      'REGISTRATION_FROZEN',
    );
    await expectRule(
      run(`UPDATE ${REG} SET status = 'COMPLETED', revision = revision + 1 WHERE provider_registration_id = $1`, [withMarket.id]),
      'REGISTRATION_FROZEN',
    );
    await expectRule(
      run(`UPDATE ${REG} SET status = 'CANCELLED', revision = revision + 1 WHERE provider_registration_id = $1`, [withMarket.id]),
      'REGISTRATION_FROZEN',
    );
    await expectRule(
      run(`UPDATE ${REG} SET status = 'CANCELLED', market_id = NULL WHERE provider_registration_id = $1`, [withMarket.id]),
      'REGISTRATION_FROZEN',
    );
    await expectRule(
      run(`UPDATE ${REG} SET status = 'COMPLETED', revision = revision - 1 WHERE provider_registration_id = $1`, [withMarket.id]),
      'REGISTRATION_FROZEN',
    );
    expect([await regRow(noMarket.id), await regRow(withMarket.id)]).toEqual(before);
  });
  it('accepts a transition that restates the market and the revision it already has', async () => {
    const { id } = await make('MARKET');
    await run(`UPDATE ${REG} SET status = 'COMPLETED', market_id = market_id, revision = revision WHERE provider_registration_id = $1`, [id]);
    expect(await regRow(id)).toMatchObject({ status: 'COMPLETED', market_id: laOc, revision: 2 });
    const other = await make('MARKET');
    await run(`UPDATE ${REG} SET status = 'CANCELLED', market_id = $2, revision = 2 WHERE provider_registration_id = $1`, [other.id, laOc]);
    expect(await regRow(other.id)).toMatchObject({ status: 'CANCELLED', market_id: laOc, revision: 2 });
  });
});

describe('D8. REVISION_ONLY_GROWS: the revision of a draft never goes down', () => {
  it('accepts the same revision, +1 and a jump, and refuses a lower one (to 0 and below 1 the rule answers before the CHECK)', async () => {
    const { id } = await make('MARKET'); // revision 2
    await run(`UPDATE ${REG} SET revision = 2 WHERE provider_registration_id = $1`, [id]);
    await run(`UPDATE ${REG} SET revision = 3 WHERE provider_registration_id = $1`, [id]);
    await run(`UPDATE ${REG} SET revision = 50 WHERE provider_registration_id = $1`, [id]);
    for (const n of [49, 3, 2, 1, 0, -1, -2147483648])
      await expectRule(run(`UPDATE ${REG} SET revision = $2 WHERE provider_registration_id = $1`, [id, n]), 'REVISION_ONLY_GROWS');
    await expectRule(run(`UPDATE ${REG} SET revision = revision - 1 WHERE provider_registration_id = $1`, [id]), 'REVISION_ONLY_GROWS');
    expect((await regRow(id)).revision).toBe(50);
    await run(`UPDATE ${REG} SET revision = 2147483647 WHERE provider_registration_id = $1`, [id]);
    // integer overflow is a numeric error (22003) in the executor, before any trigger: the statement is refused and the revision is unchanged
    expect(await outcomeOf(run(`UPDATE ${REG} SET revision = revision + 1 WHERE provider_registration_id = $1`, [id]))).toBe('22003');
    expect((await regRow(id)).revision).toBe(2147483647);
  });
  it('moves updated_at forward (never back) on every accepted change of a draft, and never touches created_at', async () => {
    const { id } = await make('MARKET');
    const before = await regRow(id);
    await sleep(15);
    await run(`UPDATE ${REG} SET revision = revision + 1 WHERE provider_registration_id = $1`, [id]);
    const after = await regRow(id);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.created_at).toEqual(before.created_at);
    await run(`UPDATE ${REG} SET updated_at = '2001-01-01' WHERE provider_registration_id = $1`, [id]); // a caller-written updated_at is overwritten
    expect((await regRow(id)).updated_at.getFullYear()).toBeGreaterThan(2020);
  });
});

describe('D9. the selections: REGISTRATION_NOT_IN_PROGRESS, IMMUTABLE_IDENTITY, SERVICE_TYPE_RETIRED, SERVICE_TYPE_NOT_ACTIVE', () => {
  it('lets a selection be made, listed and removed while the registration is IN_PROGRESS (with or without a market), once per service type', async () => {
    for (const kind of ['IN_PROGRESS', 'MARKET'] as Kind[]) {
      const { id } = await make(kind);
      const [a, b] = [await makeServiceType(), await makeServiceType()];
      await pick(id, a.id);
      await pick(id, b.id);
      expect(
        (await q<{ service_type_id: string }>(`SELECT service_type_id FROM ${SEL} WHERE provider_registration_id = $1`, [id]))
          .map((r) => r.service_type_id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      await expectConstraint(pick(id, a.id), 'pk_registration_service_types'); // the same service type twice
      await unpick(id, a.id);
      expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(1);
      await unpick(id, a.id); // removing what is not there is not an error
      await pick(id, a.id); // and it can be selected again
      expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(2);
    }
  });

  it('holds no limit on the NUMBER of selections (the maximum is configuration, checked by the service): twelve service types are accepted by the database', async () => {
    const { id } = await make('MARKET');
    for (let i = 0; i < 12; i++) await pick(id, (await makeServiceType()).id);
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(12);
  });

  it.each(['COMPLETED', 'CANCELLED'] as Kind[])(
    'freezes the selections of a %s registration: neither an insert nor a delete is accepted, and the rows stay as they were',
    async (kind) => {
      const { id } = await make('MARKET');
      const [kept, extra] = [await makeServiceType(), await makeServiceType()];
      await pick(id, kept.id);
      if (kind === 'COMPLETED') await completeReg(id);
      else await cancelReg(id);
      await expectRule(pick(id, extra.id), 'REGISTRATION_NOT_IN_PROGRESS');
      await expectRule(unpick(id, kept.id), 'REGISTRATION_NOT_IN_PROGRESS');
      await expectRule(run(`DELETE FROM ${SEL} WHERE provider_registration_id = $1`, [id]), 'REGISTRATION_NOT_IN_PROGRESS');
      await expectRule(run(`DELETE FROM ${SEL}`), 'REGISTRATION_NOT_IN_PROGRESS');
      expect(
        (await q<{ service_type_id: string }>(`SELECT service_type_id FROM ${SEL} WHERE provider_registration_id = $1`, [id])).map((r) => r.service_type_id),
      ).toEqual([kept.id]);
      await run(`DELETE FROM ${SEL} WHERE false`); // a DELETE that matches nothing is not a change
      await run(`DELETE FROM ${SEL} WHERE provider_registration_id = gen_random_uuid()`);
    },
  );

  it('judges the registration BEFORE the service type: a selection of a RETIRED service type on a finished registration answers REGISTRATION_NOT_IN_PROGRESS', async () => {
    const { id } = await make('MARKET');
    await cancelReg(id);
    const retired = await makeServiceType('RETIRED');
    const draft = await makeServiceType('DRAFT');
    await expectRule(pick(id, retired.id), 'REGISTRATION_NOT_IN_PROGRESS');
    await expectRule(pick(id, draft.id), 'REGISTRATION_NOT_IN_PROGRESS');
  });

  it('answers REGISTRATION_NOT_IN_PROGRESS for a registration that does not exist (the guard answers before the foreign key could)', async () => {
    const st = await makeServiceType();
    await expectRule(
      run(`INSERT INTO ${SEL} (provider_registration_id, service_type_id) VALUES (gen_random_uuid(), $1)`, [st.id]),
      'REGISTRATION_NOT_IN_PROGRESS',
    );
    await expectRule(run(`INSERT INTO ${SEL} (provider_registration_id, service_type_id) VALUES (NULL, $1)`, [st.id]), 'REGISTRATION_NOT_IN_PROGRESS');
  });

  const STATUS_OUTCOME: [CatalogStatus, string][] = [
    ['ACTIVE', 'ACCEPTED'],
    ['DRAFT', 'SERVICE_TYPE_NOT_ACTIVE'],
    ['INACTIVE', 'SERVICE_TYPE_NOT_ACTIVE'],
    ['RETIRED', 'SERVICE_TYPE_RETIRED'],
  ];
  it.each(STATUS_OUTCOME)('a %s service type: %s', async (status, outcome) => {
    const { id } = await make('MARKET');
    const st = await makeServiceType(status);
    expect(await outcomeOf(pick(id, st.id))).toBe(outcome);
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(outcome === 'ACCEPTED' ? 1 : 0);
  });

  it('answers SERVICE_TYPE_NOT_ACTIVE for a service type that does not exist (the guard answers before the foreign key could)', async () => {
    const { id } = await make('MARKET');
    await expectRule(run(`INSERT INTO ${SEL} (provider_registration_id, service_type_id) VALUES ($1, gen_random_uuid())`, [id]), 'SERVICE_TYPE_NOT_ACTIVE');
  });

  it('only judges a service type when it is NEWLY selected: one retired or deactivated later stays selected (explainable through the foreign key), can still be removed, and cannot be selected again until ACTIVE', async () => {
    const { id } = await make('MARKET');
    const [gone, paused] = [await makeServiceType(), await makeServiceType()];
    await pick(id, gone.id);
    await pick(id, paused.id);
    await setSt(gone.id, 'RETIRED');
    await setSt(paused.id, 'INACTIVE');
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(2);
    // the draft can still change around them: a revision bump and the removal of a retired or deactivated selection
    await run(`UPDATE ${REG} SET revision = revision + 1 WHERE provider_registration_id = $1`, [id]);
    await unpick(id, gone.id);
    await expectRule(pick(id, gone.id), 'SERVICE_TYPE_RETIRED');
    await expectRule(pick(id, paused.id), 'SERVICE_TYPE_NOT_ACTIVE'); // judged by the guard before the primary key could report the duplicate
    await unpick(id, paused.id);
    await expectRule(pick(id, paused.id), 'SERVICE_TYPE_NOT_ACTIVE');
    await setSt(paused.id, 'ACTIVE'); // reactivated: selectable again
    await pick(id, paused.id);
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(1);
  });

  it('supports the replace the service performs: delete and insert in ONE transaction, atomically (a refused insert rolls the delete back)', async () => {
    const { id } = await make('MARKET');
    const [a, b, bad] = [await makeServiceType(), await makeServiceType(), await makeServiceType('DRAFT')];
    await pick(id, a.id);
    await inTx(async (t) => {
      await unpick(id, a.id, t);
      await pick(id, b.id, t);
      await run(`UPDATE ${REG} SET revision = revision + 1 WHERE provider_registration_id = $1`, [id], t);
    });
    expect(
      (await q<{ service_type_id: string }>(`SELECT service_type_id FROM ${SEL} WHERE provider_registration_id = $1`, [id])).map((r) => r.service_type_id),
    ).toEqual([b.id]);
    await expectRule(
      inTx(async (t) => {
        await unpick(id, b.id, t);
        await pick(id, bad.id, t);
      }),
      'SERVICE_TYPE_NOT_ACTIVE',
    );
    expect(
      (await q<{ service_type_id: string }>(`SELECT service_type_id FROM ${SEL} WHERE provider_registration_id = $1`, [id])).map((r) => r.service_type_id),
    ).toEqual([b.id]);
  });

  it('refuses every UPDATE of a selection (a selection is replaced, never updated), even one that changes nothing, on an IN_PROGRESS registration and on a finished one; an UPDATE that matches no row passes', async () => {
    const live = await make('MARKET');
    const done = await make('MARKET');
    const [x, y] = [await makeServiceType(), await makeServiceType()];
    await pick(live.id, x.id);
    await pick(done.id, y.id);
    await completeReg(done.id);
    for (const [reg, st] of [
      [live.id, x.id],
      [done.id, y.id],
    ] as const) {
      const before = (await q(`SELECT * FROM ${SEL} WHERE provider_registration_id = $1`, [reg]))[0];
      for (const set of [
        'created_at = created_at',
        "created_at = now() + interval '1 day'",
        'service_type_id = service_type_id',
        'provider_registration_id = provider_registration_id',
      ])
        await expectRule(run(`UPDATE ${SEL} SET ${set} WHERE provider_registration_id = $1 AND service_type_id = $2`, [reg, st]), 'IMMUTABLE_IDENTITY');
      await expectRule(
        run(`UPDATE ${SEL} SET service_type_id = $3 WHERE provider_registration_id = $1 AND service_type_id = $2`, [reg, st, x.id === st ? y.id : x.id]),
        'IMMUTABLE_IDENTITY',
      );
      expect((await q(`SELECT * FROM ${SEL} WHERE provider_registration_id = $1`, [reg]))[0]).toEqual(before);
    }
    await run(`UPDATE ${SEL} SET created_at = created_at WHERE false`);
  });
});

describe('D10. audit_events: ROW_IMMUTABLE for UPDATE and DELETE', () => {
  let reg: string;
  beforeAll(async () => {
    reg = (await make('MARKET')).id;
    await audit(reg, 'PROVIDER_REGISTRATION_STARTED', { changes: { attempt: 1 } });
    await audit(reg, 'PROVIDER_MARKET_SELECTED', { changes: { market: [null, 'la-oc'] }, reason: 'chosen' });
  });
  it.each([
    ['actor', "actor = 'someone'"],
    ['action', "action = 'PROVIDER_REGISTRATION_CANCELLED'"],
    ['changes', "changes = '{}'::jsonb"],
    ['reason', "reason = 'edited'"],
    ['correlation_id', "correlation_id = 'other'"],
    ['occurred_at', 'occurred_at = now()'],
    ['no column at all', 'actor = actor'],
    ['every column', "actor = 'x', action = 'PROVIDER_MARKET_SELECTED', changes = NULL, reason = NULL, correlation_id = 'y', occurred_at = now()"],
  ])('refuses to update %s', async (_label, set) => {
    const before = await q(`SELECT * FROM ${AUDIT} ORDER BY audit_event_id`);
    await expectRule(run(`UPDATE ${AUDIT} SET ${set}`), 'ROW_IMMUTABLE');
    await expectRule(run(`UPDATE ${AUDIT} SET ${set} WHERE provider_registration_id = $1`, [reg]), 'ROW_IMMUTABLE');
    expect(await q(`SELECT * FROM ${AUDIT} ORDER BY audit_event_id`)).toEqual(before);
  });
  it('refuses to delete one event or all, and lets a statement that matches nothing through', async () => {
    const n = await count(AUDIT);
    await expectRule(run(`DELETE FROM ${AUDIT} WHERE provider_registration_id = $1`, [reg]), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${AUDIT}`), 'ROW_IMMUTABLE');
    expect(await count(AUDIT)).toBe(n);
    await run(`DELETE FROM ${AUDIT} WHERE false`);
    await run(`UPDATE ${AUDIT} SET actor = 'x' WHERE false`);
  });
  it('appends: an insert is accepted at any time, so the trail only grows', async () => {
    const n = await count(AUDIT);
    await audit(reg, 'PROVIDER_SERVICES_UPDATED', { changes: { count: 2 } });
    expect(await count(AUDIT)).toBe(n + 1);
  });
});

describe('E. at most one live attempt per account: IN_PROGRESS and COMPLETED block a second row, CANCELLED does not, accounts are independent', () => {
  const insertAttempt = (account: string, n: number) => run(`INSERT INTO ${REG} (account_id, attempt_number) VALUES ($1, $2)`, [account, n]);
  it('blocks a second attempt while one is IN_PROGRESS, by the partial unique key (the attempt number itself is the correct next one)', async () => {
    const a = await makeAccount();
    await start(a);
    await expectConstraint(insertAttempt(a, 2), 'uq_registrations__live');
    expect(await count(REG, 'account_id = $1', [a])).toBe(1);
  });
  it('blocks a second attempt after the first is COMPLETED', async () => {
    const { account } = await make('COMPLETED');
    await expectConstraint(insertAttempt(account, 2), 'uq_registrations__live');
    expect(await count(REG, 'account_id = $1', [account])).toBe(1);
  });
  it('allows the next attempt after a CANCELLED one, any number of times, and blocks again while the new one is live; the attempts read 1, 2, 3 and 4 without gaps', async () => {
    const a = await makeAccount();
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) {
      ids.push(await start(a));
      await expectConstraint(insertAttempt(a, n + 1), 'uq_registrations__live');
      await cancelReg(ids[n - 1]!);
    }
    ids.push(await start(a));
    await completeReg(ids[3]!).catch(() => undefined); // no market: refused by the lifecycle CHECK, so it stays IN_PROGRESS
    expect(await q<{ attempt_number: number; status: string }>(`SELECT attempt_number, status FROM ${REG} WHERE account_id = $1 ORDER BY 1`, [a])).toEqual([
      { attempt_number: 1, status: 'CANCELLED' },
      { attempt_number: 2, status: 'CANCELLED' },
      { attempt_number: 3, status: 'CANCELLED' },
      { attempt_number: 4, status: 'IN_PROGRESS' },
    ]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('keeps two accounts independent: each has its own live attempt and its own attempt numbers', async () => {
    const [a, b] = [await makeAccount(), await makeAccount()];
    const [ra, rb] = [await start(a), await start(b)];
    expect([(await regRow(ra)).attempt_number, (await regRow(rb)).attempt_number]).toEqual([1, 1]);
    await cancelReg(ra);
    await expectConstraint(insertAttempt(b, 2), 'uq_registrations__live'); // b is still live
    await start(a); // a restarts regardless of b
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('is the PARTIAL key and the attempt key that decide, with the guards off: two CANCELLED rows of one account coexist, a live row beside a cancelled one coexists, two live rows (IN_PROGRESS or COMPLETED) do not, and one attempt number twice does not', async () => {
    const a = await makeAccount();
    const raw = (n: number, status: string, market = false) =>
      rawReg(a, { attempt: n, status, completed: status === 'COMPLETED', cancelled: status === 'CANCELLED', market: market ? laOc : null });
    const two = async (s1: string, s2: string, n2 = 2) =>
      rolledBack(async (c) => {
        await c.query(`ALTER TABLE ${REG} DISABLE TRIGGER USER`);
        await c.query(...raw(1, s1, s1 === 'COMPLETED'));
        await c.query(...raw(n2, s2, s2 === 'COMPLETED'));
      });
    expect(await outcomeOf(two('CANCELLED', 'CANCELLED'))).toBe('ACCEPTED');
    expect(await outcomeOf(two('CANCELLED', 'IN_PROGRESS'))).toBe('ACCEPTED');
    expect(await outcomeOf(two('IN_PROGRESS', 'CANCELLED'))).toBe('ACCEPTED');
    expect(await outcomeOf(two('COMPLETED', 'CANCELLED'))).toBe('ACCEPTED');
    expect(await outcomeOf(two('IN_PROGRESS', 'IN_PROGRESS'))).toBe('uq_registrations__live');
    expect(await outcomeOf(two('COMPLETED', 'IN_PROGRESS'))).toBe('uq_registrations__live');
    expect(await outcomeOf(two('IN_PROGRESS', 'COMPLETED'))).toBe('uq_registrations__live');
    expect(await outcomeOf(two('COMPLETED', 'COMPLETED'))).toBe('uq_registrations__live');
    expect(await outcomeOf(two('CANCELLED', 'CANCELLED', 1))).toBe('uq_registrations__attempt');
  });
});

describe('F. RESTRICT: every foreign key holds when the guards are bypassed, and TRUNCATE is refused for every table', () => {
  let live: { account: string; id: string };
  let withSelection: { account: string; id: string };
  let st: Row;
  beforeAll(async () => {
    live = await make('MARKET');
    await audit(live.id);
    withSelection = await make('MARKET');
    st = await makeServiceType();
    await pick(withSelection.id, st.id);
  });
  const MARKET_INSERT = `INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT 'zz-restrict', 'zz-restrict', c.country_id, 'PLANNED', 'en-US', 'USD', t.time_zone_id, now()
         FROM geography.countries c, geography.time_zones t WHERE c.iso_alpha2 = 'US' AND t.iana_name = 'America/Los_Angeles' RETURNING market_id`;

  it('holds the account: an account with a registration cannot be deleted even with every guard off (fk_registrations__account_id)', async () => {
    await expectConstraint(
      rolledBack(async (c) => {
        await c.query(NO_FOREIGN_TRIGGERS);
        await c.query(`ALTER TABLE ${REG} DISABLE TRIGGER USER`);
        const id = ((await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0] as { account_id: string })
          .account_id;
        await c.query(...rawReg(id));
        await c.query('DELETE FROM identity.accounts WHERE account_id = $1', [id]);
      }),
      'fk_registrations__account_id',
    );
  });
  it('holds the market: a market named by a registration cannot be deleted (fk_registrations__market_id), and a registration cannot name a market that does not exist, with the guards ON', async () => {
    await expectConstraint(
      rolledBack(async (c) => {
        await c.query(NO_FOREIGN_TRIGGERS);
        await c.query(`ALTER TABLE ${REG} DISABLE TRIGGER USER`);
        const market = ((await c.query(MARKET_INSERT)).rows[0] as { market_id: string }).market_id;
        const account = ((await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0] as { account_id: string })
          .account_id;
        await c.query(...rawReg(account, { market }));
        await c.query('DELETE FROM geography.markets WHERE market_id = $1', [market]);
      }),
      'fk_registrations__market_id',
    );
    const account = await makeAccount();
    await expectConstraint(
      run(`INSERT INTO ${REG} (account_id, attempt_number, market_id) VALUES ($1, 1, gen_random_uuid())`, [account]),
      'fk_registrations__market_id',
    );
    const { id } = await make();
    await expectConstraint(run(`UPDATE ${REG} SET market_id = gen_random_uuid() WHERE provider_registration_id = $1`, [id]), 'fk_registrations__market_id');
  });
  it('holds the service type: a service type named by a selection cannot be deleted (fk_registration_service_types__service_type_id)', async () => {
    await expectConstraint(
      rolledBack(async (c) => {
        await c.query(NO_FOREIGN_TRIGGERS);
        await c.query('DELETE FROM catalog.service_types WHERE service_type_id = $1', [st.id]);
      }),
      'fk_registration_service_types__service_type_id',
    );
  });
  it('holds the registration: a registration with a selection or an audit event cannot be deleted even with its own guard off', async () => {
    await expectConstraint(
      rolledBack(async (c) => {
        await c.query(`ALTER TABLE ${REG} DISABLE TRIGGER USER`);
        await c.query(`DELETE FROM ${REG} WHERE provider_registration_id = $1`, [withSelection.id]);
      }),
      'fk_registration_service_types__registration_id',
    );
    await expectConstraint(
      rolledBack(async (c) => {
        await c.query(`ALTER TABLE ${REG} DISABLE TRIGGER USER`);
        await c.query(`DELETE FROM ${REG} WHERE provider_registration_id = $1`, [live.id]);
      }),
      'fk_audit_events__registration_id',
    );
  });

  /** The roots a CASCADE can start from, and the provider tables each one reaches (a service type is referenced by the selections only). */
  const ROOTS: [string, string[]][] = [
    ['identity.accounts', [REG, SEL, AUDIT]],
    ['geography.markets', [REG, SEL, AUDIT]],
    ['catalog.service_types', [SEL]],
  ];
  it('refuses a plain TRUNCATE of the referenced table (PostgreSQL itself, 0A000) and of the two unreferenced ones (ROW_IMMUTABLE), and every CASCADE and multi-table form (ROW_IMMUTABLE); every row survives', async () => {
    const before = await Promise.all(TABLES.map((t) => count(t)));
    expect(before.every((n) => n > 0)).toBe(true);
    await expect(pool.query(`TRUNCATE ${REG}`)).rejects.toMatchObject({ code: '0A000' });
    await expectRule(run(`TRUNCATE ${SEL}`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${AUDIT}`), 'ROW_IMMUTABLE');
    for (const t of TABLES) await expectRule(run(`TRUNCATE ${t} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${TABLES.join(', ')}`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${REG}, ${SEL}, ${AUDIT} CONTINUE IDENTITY`), 'ROW_IMMUTABLE');
    expect(await Promise.all(TABLES.map((t) => count(t)))).toEqual(before);
  });
  it.each(ROOTS)(
    'refuses a TRUNCATE of %s CASCADE that reaches the provider tables, as a provider guard failure (the guards of every other schema are switched off in that transaction, so only the provider can answer); with the provider guards off the same statement would go through',
    async (root, reached) => {
      const before = await Promise.all(TABLES.map((t) => count(t)));
      await expectRule(
        rolledBack(async (c) => {
          await c.query(NO_FOREIGN_TRIGGERS);
          await c.query(`TRUNCATE ${root} CASCADE`);
        }),
        'ROW_IMMUTABLE',
      );
      await rolledBack(async (c) => {
        await c.query(NO_FOREIGN_TRIGGERS);
        for (const s of noTriggers(...TABLES, ...GIG_TABLES)) await c.query(s); // since 0020 the cascade also reaches the Gig tables
        await c.query(`TRUNCATE ${root} CASCADE`); // not refused by anything else: the provider triggers were the only thing in the way
        for (const t of reached) expect(await count(t, 'true', [], c), `${t} was truncated`).toBe(0);
      });
      await expect(pool.query(`TRUNCATE ${root}`)).rejects.toMatchObject({ code: '0A000' });
      expect(await Promise.all(TABLES.map((t) => count(t)))).toEqual(before);
    },
  );
  it('is not enough to disable ONE provider trigger: with the registrations guard off the selections and the audit trail still refuse a TRUNCATE CASCADE from the account', async () => {
    for (const keep of [SEL, AUDIT]) {
      await expectRule(
        rolledBack(async (c) => {
          await c.query(NO_FOREIGN_TRIGGERS);
          for (const s of noTriggers(...TABLES.filter((t) => t !== keep))) await c.query(s);
          await c.query('TRUNCATE identity.accounts CASCADE');
        }),
        'ROW_IMMUTABLE',
      );
    }
  });
});

// ====================================================================== H. concurrency: real lock waiters first, then repeated simultaneous races
const insertFirst = (account: string): RaceSql => sqlOf(`INSERT INTO ${REG} (account_id, attempt_number) VALUES ($1, 1)`, account);
const pickSql = (reg: string, st: string): RaceSql => sqlOf(`INSERT INTO ${SEL} (provider_registration_id, service_type_id) VALUES ($1, $2)`, reg, st);
const completeSql = (reg: string): RaceSql => sqlOf(`UPDATE ${REG} SET status = 'COMPLETED' WHERE provider_registration_id = $1`, reg);
const cancelSql = (reg: string): RaceSql => sqlOf(`UPDATE ${REG} SET status = 'CANCELLED' WHERE provider_registration_id = $1`, reg);
const bumpSql = (reg: string): RaceSql => sqlOf(`UPDATE ${REG} SET revision = revision + 1 WHERE provider_registration_id = $1`, reg);
const setSt1 = (st: string, status: string): RaceSql => sqlOf('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', st, status);
const exec = (c: Db, r: RaceSql) => c.query(r.text, r.params ?? []);
const suspend = (account: string) => (c: pg.PoolClient) => suspendOn(c, account);
const accountStatus = async (account: string): Promise<string> =>
  (await q<{ status: string }>('SELECT status FROM identity.accounts WHERE account_id = $1', [account]))[0]!.status;

describe('H1. two first attempts of one account serialize on the unique keys (real lock waiter, then 30 simultaneous rounds)', () => {
  it('holds the second insert back while the first is open, then refuses it with a unique violation (no partial row); a rolled-back first lets the second through', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => exec(tx, insertFirst(a)), insertFirst(a));
    expect(e?.code).toBe('23505');
    expect(['uq_registrations__attempt', 'uq_registrations__live']).toContain(e?.constraint);
    expect(await count(REG, 'account_id = $1', [a])).toBe(1);
    const b = await makeAccount();
    const e2 = await holdThenRace((tx) => exec(tx, insertFirst(b)), insertFirst(b), 'ROLLBACK');
    expect(e2).toBeUndefined();
    expect(await count(REG, 'account_id = $1', [b])).toBe(1);
    await noLockWaiters();
  });
  it('holds the RESTART of a cancelled account back the same way: two simultaneous second attempts, one winner, and the loser is told by the live key', async () => {
    const a = await makeAccount();
    await cancelReg(await start(a));
    const second = sqlOf(`INSERT INTO ${REG} (account_id, attempt_number) VALUES ($1, 2)`, a);
    const e = await holdThenRace((tx) => exec(tx, second), second);
    expect(e?.code).toBe('23505');
    expect(['uq_registrations__attempt', 'uq_registrations__live']).toContain(e?.constraint);
    expect(
      (await q<{ attempt_number: number }>(`SELECT attempt_number FROM ${REG} WHERE account_id = $1 ORDER BY 1`, [a])).map((r) => r.attempt_number),
    ).toEqual([1, 2]);
  });
  it('30 rounds of two simultaneous first attempts: exactly one wins, the other gets a unique violation, never a deadlock, never two rows', async () => {
    for (let round = 0; round < 30; round++) {
      const a = await makeAccount();
      const r = await both(insertFirst(a), insertFirst(a));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      // the loser either met the winner's uncommitted row (a unique violation) or started after its commit (the guard sees attempt 1 taken: the next is 2)
      const loser = r.find((x) => x !== undefined)!;
      const kind = loser.code === '23505' ? `unique:${loser.constraint}` : `${loser.code}:${loser.detail}`;
      expect(
        ['unique:uq_registrations__attempt', 'unique:uq_registrations__live', '23000:provider_rule:REGISTRATION_ATTEMPT_SEQUENCE'],
        `round ${round}`,
      ).toContain(kind);
      expect(await count(REG, 'account_id = $1', [a])).toBe(1);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('30 rounds of two simultaneous restarts of a cancelled account: exactly one new attempt, numbered 2', async () => {
    for (let round = 0; round < 30; round++) {
      const a = await makeAccount();
      await cancelReg(await start(a));
      const next = sqlOf(
        `INSERT INTO ${REG} (account_id, attempt_number) SELECT $1::uuid, COALESCE(max(attempt_number), 0) + 1 FROM ${REG} WHERE account_id = $1`,
        a,
      );
      const r = await both(next, next);
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      expect(
        (await q<{ attempt_number: number }>(`SELECT attempt_number FROM ${REG} WHERE account_id = $1 ORDER BY 1`, [a])).map((x) => x.attempt_number),
      ).toEqual([1, 2]);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H2. starting or completing a registration against a suspension of the account (the account row is read FOR SHARE)', () => {
  it('holds the INSERT back while a suspension is open, then refuses it: ACCOUNT_NOT_ACTIVE, no row', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => suspendOn(tx, a), insertFirst(a));
    expect(asRule(e)).toEqual(rule('ACCOUNT_NOT_ACTIVE'));
    expect(await count(REG, 'account_id = $1', [a])).toBe(0);
    expect(await accountStatus(a)).toBe('SUSPENDED');
  });
  it('holds the suspension back while an INSERT is open (it needs the account row exclusively); the suspension then succeeds and the registration exists', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => exec(tx, insertFirst(a)), suspend(a));
    expect(e).toBeUndefined();
    expect(await count(REG, 'account_id = $1', [a])).toBe(1);
    expect(await accountStatus(a)).toBe('SUSPENDED');
    await expectRule(
      completeReg((await q<{ id: string }>(`SELECT provider_registration_id AS id FROM ${REG} WHERE account_id = $1`, [a]))[0]!.id),
      'ACCOUNT_NOT_ACTIVE',
    );
  });
  it('lets the INSERT through when the suspension is rolled back (the wait is only for the open transaction, nothing stays locked)', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => suspendOn(tx, a), insertFirst(a), 'ROLLBACK');
    expect(e).toBeUndefined();
    expect(await count(REG, 'account_id = $1', [a])).toBe(1);
    expect(await accountStatus(a)).toBe('ACTIVE');
    await noLockWaiters();
  });
  it('holds a COMPLETION back while a suspension is open, then refuses it (ACCOUNT_NOT_ACTIVE); the registration stays IN_PROGRESS', async () => {
    const { account, id } = await make('MARKET');
    const e = await holdThenRace((tx) => suspendOn(tx, account), completeSql(id));
    expect(asRule(e)).toEqual(rule('ACCOUNT_NOT_ACTIVE'));
    expect(await regRow(id)).toMatchObject({ status: 'IN_PROGRESS', completed_at: null });
  });
  it('holds a suspension back while a COMPLETION is open; both then succeed (a completed registration of a later-suspended account is valid history)', async () => {
    const { account, id } = await make('MARKET');
    const e = await holdThenRace((tx) => exec(tx, completeSql(id)), suspend(account));
    expect(e).toBeUndefined();
    expect(await regRow(id)).toMatchObject({ status: 'COMPLETED' });
    expect(await accountStatus(account)).toBe('SUSPENDED');
  });
  it('25 rounds of an INSERT against a suspension at the same instant: the suspension always wins its row, the INSERT either lands first or is refused ACCOUNT_NOT_ACTIVE; never a deadlock, and the rows agree with the outcome', async () => {
    const outcomes = { inserted: 0, refused: 0 };
    for (let round = 0; round < 25; round++) {
      const a = await makeAccount();
      const r = await both(insertFirst(a), suspend(a));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}: the suspension`).toBeUndefined();
      expect(await accountStatus(a)).toBe('SUSPENDED');
      if (r[0] === undefined) {
        outcomes.inserted++;
        expect(await count(REG, 'account_id = $1', [a])).toBe(1);
      } else {
        outcomes.refused++;
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('ACCOUNT_NOT_ACTIVE'));
        expect(await count(REG, 'account_id = $1', [a])).toBe(0);
      }
    }
    expect(outcomes.inserted + outcomes.refused).toBe(25);
  });
  it('25 rounds of a COMPLETION against a suspension at the same instant: the registration is COMPLETED only if the completion went first; never a deadlock', async () => {
    for (let round = 0; round < 25; round++) {
      const { account, id } = await make('MARKET');
      const r = await both(completeSql(id), suspend(account));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}: the suspension`).toBeUndefined();
      if (r[0] === undefined) expect((await regRow(id)).status).toBe('COMPLETED');
      else {
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('ACCOUNT_NOT_ACTIVE'));
        expect((await regRow(id)).status).toBe('IN_PROGRESS');
      }
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H3. a selection against the retirement or deactivation of its service type (the service type row is read FOR SHARE)', () => {
  it('holds the selection back while a retirement is open, then refuses it: SERVICE_TYPE_RETIRED, no row', async () => {
    const { id } = await make('MARKET');
    const st = await makeServiceType();
    const e = await holdThenRace((tx) => exec(tx, setSt1(st.id, 'RETIRED')), pickSql(id, st.id));
    expect(asRule(e)).toEqual(rule('SERVICE_TYPE_RETIRED'));
    expect(await count(SEL, 'service_type_id = $1', [st.id])).toBe(0);
  });
  it('holds the selection back while a deactivation is open, then refuses it: SERVICE_TYPE_NOT_ACTIVE', async () => {
    const { id } = await make('MARKET');
    const st = await makeServiceType();
    const e = await holdThenRace((tx) => exec(tx, setSt1(st.id, 'INACTIVE')), pickSql(id, st.id));
    expect(asRule(e)).toEqual(rule('SERVICE_TYPE_NOT_ACTIVE'));
    expect(await count(SEL, 'service_type_id = $1', [st.id])).toBe(0);
  });
  it('holds the retirement back while a selection is open (a real lock waiter); the retirement then succeeds and the selection stays (history), as it does for a deactivation', async () => {
    for (const to of ['RETIRED', 'INACTIVE']) {
      const { id } = await make('MARKET');
      const st = await makeServiceType();
      const e = await holdThenRace((tx) => exec(tx, pickSql(id, st.id)), setSt1(st.id, to));
      expect(e, to).toBeUndefined();
      expect(await count(SEL, 'service_type_id = $1', [st.id])).toBe(1);
      expect((await q<{ status: string }>('SELECT status FROM catalog.service_types WHERE service_type_id = $1', [st.id]))[0]!.status).toBe(to);
    }
  });
  it('lets the selection through when the retirement is rolled back', async () => {
    const { id } = await make('MARKET');
    const st = await makeServiceType();
    const e = await holdThenRace((tx) => exec(tx, setSt1(st.id, 'RETIRED')), pickSql(id, st.id), 'ROLLBACK');
    expect(e).toBeUndefined();
    expect(await count(SEL, 'service_type_id = $1', [st.id])).toBe(1);
    await noLockWaiters();
  });
  it('25 rounds of a selection against a retirement at the same instant: the retirement always succeeds, the selection either lands first or is refused SERVICE_TYPE_RETIRED, never a deadlock, and the rows agree', async () => {
    const outcomes = { selected: 0, refused: 0 };
    for (let round = 0; round < 25; round++) {
      const { id } = await make('MARKET');
      const st = await makeServiceType();
      const r = await both(pickSql(id, st.id), setSt1(st.id, 'RETIRED'));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}: the retirement`).toBeUndefined();
      if (r[0] === undefined) {
        outcomes.selected++;
        expect(await count(SEL, 'service_type_id = $1', [st.id])).toBe(1);
      } else {
        outcomes.refused++;
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('SERVICE_TYPE_RETIRED'));
        expect(await count(SEL, 'service_type_id = $1', [st.id])).toBe(0);
      }
    }
    expect(outcomes.selected + outcomes.refused).toBe(25);
  });
});

describe('H4. a selection against the completion or cancellation of its registration (the registration row is read FOR SHARE)', () => {
  it.each([
    ['completion', completeSql],
    ['cancellation', cancelSql],
  ] as const)('holds a selection back while a %s is open, then refuses it: REGISTRATION_NOT_IN_PROGRESS, no row', async (_label, finishSql) => {
    const { id } = await make('MARKET');
    const st = await makeServiceType();
    const e = await holdThenRace((tx) => exec(tx, finishSql(id)), pickSql(id, st.id));
    expect(asRule(e)).toEqual(rule('REGISTRATION_NOT_IN_PROGRESS'));
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(0);
  });
  it.each([
    ['completion', completeSql, 'COMPLETED'],
    ['cancellation', cancelSql, 'CANCELLED'],
  ] as const)(
    'holds a %s back while a selection is open (a real lock waiter); the %s then succeeds and keeps the selection',
    async (_label, finishSql, status) => {
      const { id } = await make('MARKET');
      const st = await makeServiceType();
      const e = await holdThenRace((tx) => exec(tx, pickSql(id, st.id)), finishSql(id));
      expect(e).toBeUndefined();
      expect((await regRow(id)).status).toBe(status);
      expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(1);
    },
  );
  it('holds a completion back while the removal of a selection is open; the completion then sees the final set', async () => {
    const { id } = await make('MARKET');
    const st = await makeServiceType();
    await pick(id, st.id);
    const e = await holdThenRace((tx) => unpick(id, st.id, tx), completeSql(id));
    expect(e).toBeUndefined();
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(0);
    expect((await regRow(id)).status).toBe('COMPLETED');
  });
  it('lets two selections of one registration proceed together (the share locks do not conflict): no waiter, both rows land', async () => {
    const { id } = await make('MARKET');
    const [a, b] = [await makeServiceType(), await makeServiceType()];
    const tx = await openTx();
    try {
      await exec(tx, pickSql(id, a.id));
      await exec(racePool, pickSql(id, b.id)); // returns without waiting for the open transaction
      expect(await waitersOn(pool)).toBe(0);
    } finally {
      await finish(tx);
    }
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(2);
  });
  it('20 rounds each of a selection against a completion and against a cancellation at the same instant: the finish always succeeds, the selection lands first or is refused REGISTRATION_NOT_IN_PROGRESS, never a deadlock', async () => {
    for (const [finishSql, status] of [
      [completeSql, 'COMPLETED'],
      [cancelSql, 'CANCELLED'],
    ] as const)
      for (let round = 0; round < 20; round++) {
        const { id } = await make('MARKET');
        const st = await makeServiceType();
        const r = await both(pickSql(id, st.id), finishSql(id));
        r.forEach(notDeadlock);
        expect(r[1], `${status} round ${round}`).toBeUndefined();
        expect((await regRow(id)).status).toBe(status);
        if (r[0] === undefined) expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(1);
        else {
          expect(asRule(r[0]), `${status} round ${round}`).toEqual(rule('REGISTRATION_NOT_IN_PROGRESS'));
          expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(0);
        }
      }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H5. a completion against a cancellation of the same registration', () => {
  it('holds the cancellation back while a completion is open, then refuses it: REGISTRATION_FROZEN, the registration stays COMPLETED', async () => {
    const { id } = await make('MARKET');
    const e = await holdThenRace((tx) => exec(tx, completeSql(id)), cancelSql(id));
    expect(asRule(e)).toEqual(rule('REGISTRATION_FROZEN'));
    expect(await regRow(id)).toMatchObject({ status: 'COMPLETED', cancelled_at: null });
  });
  it('holds the completion back while a cancellation is open, then refuses it: REGISTRATION_FROZEN, the registration stays CANCELLED', async () => {
    const { id } = await make('MARKET');
    const e = await holdThenRace((tx) => exec(tx, cancelSql(id)), completeSql(id));
    expect(asRule(e)).toEqual(rule('REGISTRATION_FROZEN'));
    expect(await regRow(id)).toMatchObject({ status: 'CANCELLED', completed_at: null });
  });
  it('lets the second through when the first is rolled back', async () => {
    const { id } = await make('MARKET');
    const e = await holdThenRace((tx) => exec(tx, completeSql(id)), cancelSql(id), 'ROLLBACK');
    expect(e).toBeUndefined();
    expect((await regRow(id)).status).toBe('CANCELLED');
  });
  it("30 rounds at the same instant: exactly one wins, the loser is told REGISTRATION_FROZEN, the final state is the winner's, never a deadlock, never both timestamps", async () => {
    const outcomes = { completed: 0, cancelled: 0 };
    for (let round = 0; round < 30; round++) {
      const { id } = await make('MARKET');
      const r = await both(completeSql(id), cancelSql(id));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      const row = await regRow(id);
      if (r[0] === undefined) {
        outcomes.completed++;
        expect(asRule(r[1])).toEqual(rule('REGISTRATION_FROZEN'));
        expect([row.status, row.cancelled_at]).toEqual(['COMPLETED', null]);
      } else {
        outcomes.cancelled++;
        expect(asRule(r[0])).toEqual(rule('REGISTRATION_FROZEN'));
        expect([row.status, row.completed_at]).toEqual(['CANCELLED', null]);
      }
    }
    expect(outcomes.completed + outcomes.cancelled).toBe(30);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('30 rounds of two simultaneous completions (a double click): one transition, the second is refused REGISTRATION_FROZEN, completed_at is set once', async () => {
    for (let round = 0; round < 30; round++) {
      const { id } = await make('MARKET');
      const r = await both(completeSql(id), completeSql(id));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      expect(asRule(r.find((x) => x !== undefined))).toEqual(rule('REGISTRATION_FROZEN'));
      expect((await regRow(id)).status).toBe('COMPLETED');
    }
  });
});

describe('H6. two writers of the draft revision', () => {
  it('serializes two increments: the second waits, then adds to the committed value (no lost update): 1 -> 3', async () => {
    const { id } = await make('IN_PROGRESS');
    const e = await holdThenRace((tx) => exec(tx, bumpSql(id)), bumpSql(id));
    expect(e).toBeUndefined();
    expect((await regRow(id)).revision).toBe(3);
  });
  it('refuses a LOWER revision written after a higher one committed: REVISION_ONLY_GROWS, the higher stays; a higher one after a lower is accepted', async () => {
    const { id } = await make('IN_PROGRESS');
    const set = (n: number): RaceSql => sqlOf(`UPDATE ${REG} SET revision = $2 WHERE provider_registration_id = $1`, id, n);
    const e = await holdThenRace((tx) => exec(tx, set(5)), set(3));
    expect(asRule(e)).toEqual(rule('REVISION_ONLY_GROWS'));
    expect((await regRow(id)).revision).toBe(5);
    const e2 = await holdThenRace((tx) => exec(tx, set(6)), set(9));
    expect(e2).toBeUndefined();
    expect((await regRow(id)).revision).toBe(9);
  });
  it('lets exactly one of two compare-and-set updates (WHERE revision = the one read) win, and the loser matches no row; 30 rounds at the same instant', async () => {
    const cas = (id: string): RaceSql => sqlOf(`UPDATE ${REG} SET revision = revision + 1 WHERE provider_registration_id = $1 AND revision = 1`, id);
    for (let round = 0; round < 30; round++) {
      const { id } = await make('IN_PROGRESS');
      const [x, y] = await Promise.all([racePool.query(cas(id).text, cas(id).params), racePool.query(cas(id).text, cas(id).params)]);
      expect([x.rowCount, y.rowCount].sort(), `round ${round}`).toEqual([0, 1]);
      expect((await regRow(id)).revision).toBe(2);
    }
  });
  it('30 rounds of two simultaneous increments: always 1 -> 3, never a deadlock', async () => {
    for (let round = 0; round < 30; round++) {
      const { id } = await make('IN_PROGRESS');
      const r = await both(bumpSql(id), bumpSql(id));
      r.forEach(notDeadlock);
      expect(r, `round ${round}`).toEqual([undefined, undefined]);
      expect((await regRow(id)).revision).toBe(3);
    }
  });
  it('30 rounds of an increment against a completion: both succeed in either order when the increment goes first; when the completion goes first the increment is refused REGISTRATION_FROZEN and the revision is the one the completion froze', async () => {
    for (let round = 0; round < 30; round++) {
      const { id } = await make('MARKET');
      const r = await both(bumpSql(id), completeSql(id));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}: the completion`).toBeUndefined();
      const row = await regRow(id);
      expect(row.status).toBe('COMPLETED');
      if (r[0] === undefined) expect(row.revision).toBe(3);
      else {
        expect(asRule(r[0])).toEqual(rule('REGISTRATION_FROZEN'));
        expect(row.revision).toBe(2);
      }
    }
  });
});

describe('H7. a mixed storm: six different writers at the same instant on one registration, no deadlock and no invalid state', () => {
  it('25 rounds of two selections, a retirement, a revision bump, a completion and a cancellation: exactly one of completion and cancellation wins, no 40xxx error, the invariants hold, nothing stays locked', async () => {
    for (let round = 0; round < 25; round++) {
      const { id } = await make('MARKET');
      const [s1, s2] = [await makeServiceType(), await makeServiceType()];
      const r = (await Promise.all([
        rejection(runRacer(racePool, pickSql(id, s1.id))),
        rejection(runRacer(racePool, pickSql(id, s2.id))),
        rejection(runRacer(racePool, setSt1(s2.id, 'RETIRED'))),
        rejection(runRacer(racePool, bumpSql(id))),
        rejection(runRacer(racePool, completeSql(id))),
        rejection(runRacer(racePool, cancelSql(id))),
      ])) as (PgFailure | undefined)[];
      r.forEach(notDeadlock);
      expect(winners([r[4], r[5]]), `round ${round}: completion and cancellation`).toBe(1);
      expect((await regRow(id)).status).toBe(r[4] === undefined ? 'COMPLETED' : 'CANCELLED');
      if (r[0]) expect(asRule(r[0]), `round ${round}`).toEqual(rule('REGISTRATION_NOT_IN_PROGRESS'));
      if (r[1]) expect([rule('REGISTRATION_NOT_IN_PROGRESS'), rule('SERVICE_TYPE_RETIRED')], `round ${round}`).toContainEqual(asRule(r[1]));
      if (r[2]) expect.fail('the retirement of an ACTIVE service type must succeed');
      if (r[3]) expect(asRule(r[3]), `round ${round}`).toEqual(rule('REGISTRATION_FROZEN'));
      // a selection that landed is a selection that exists
      expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(r.slice(0, 2).filter((e) => e === undefined).length);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
    await noLockWaiters();
    await noLockWaiters(racePool);
  });
  it('follows the documented lock order without a deadlock: transactions that lock the ACCOUNT first, then the registration, then add a selection, run against raw writers of every kind, 20 rounds', async () => {
    for (let round = 0; round < 20; round++) {
      const { account, id } = await make('MARKET');
      const st = await makeServiceType();
      const service: Racer = async (c) => {
        await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [account]);
        await c.query(bumpSql(id).text, bumpSql(id).params);
        await c.query(pickSql(id, st.id).text, pickSql(id, st.id).params);
        await c.query(completeSql(id).text, completeSql(id).params);
      };
      const r = (await Promise.all([
        rejection(runRacer(racePool, service)),
        rejection(runRacer(racePool, suspend(account))),
        rejection(runRacer(racePool, setSt1(st.id, 'RETIRED'))),
        rejection(runRacer(racePool, cancelSql(id))),
      ])) as (PgFailure | undefined)[];
      r.forEach(notDeadlock);
      expect((await regRow(id)).status).toMatch(/^(COMPLETED|CANCELLED)$/);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
    await noLockWaiters(racePool);
  });
  it('shows WHY the account is locked first: a completion that took the registration row before the account (a raw writer) deadlocks with a transaction that holds the account and then updates the same registration, and the database resolves it by aborting exactly one of them (40P01)', async () => {
    const { account, id } = await make('MARKET');
    const tx = await openTx();
    let completion: Promise<unknown> = Promise.resolve();
    let bump: Promise<unknown> = Promise.resolve();
    try {
      await tx.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [account]);
      completion = rejection(racePool.query(completeSql(id).text, completeSql(id).params)); // takes the registration row, then waits for the account FOR SHARE
      await lockWaiters(1);
      bump = rejection(tx.query(bumpSql(id).text, bumpSql(id).params)); // wants the registration row the completion holds: a cycle
      await Promise.race([completion, bump]); // the first of the two to end is the victim chosen by the deadlock detector
    } finally {
      await finish(tx, 'ROLLBACK'); // releases the account, so whichever side survived can end
    }
    const outcome = (await Promise.all([completion, bump])) as (PgFailure | undefined)[];
    expect(
      outcome.filter((e) => e?.code === '40P01'),
      'exactly one side is the deadlock victim',
    ).toHaveLength(1);
    expect(
      outcome.filter((e) => e === undefined),
      'and the other side proceeds',
    ).toHaveLength(1);
    await noLockWaiters();
  });
});

// ====================================================================== I. the access paths
async function planOf(text: string, params: unknown[], settings: string[], analyze = false): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of settings) await c.query(s);
    return (await c.query(`EXPLAIN (${analyze ? 'ANALYZE, TIMING OFF, SUMMARY OFF, ' : ''}COSTS OFF) ${text}`, params)).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
describe('I. the access path: the current registration, the latest attempt and the selections of a registration read their keys, and no index is missing or extra', () => {
  let sample: { account: string; live: string; history: string; id: string };
  beforeAll(async () => {
    // 300 accounts with up to three attempts each, a third of them live and IN_PROGRESS with ten selections
    const types: Row[] = [];
    for (let i = 0; i < 10; i++) types.push(await makeServiceType());
    const accounts = await inTx(async (c) => {
      const r = await c.query(
        `WITH a AS (INSERT INTO identity.accounts (status) SELECT 'ACTIVE' FROM generate_series(1, 300) RETURNING account_id),
              h AS (INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) SELECT account_id, NULL, 'ACTIVE', NULL, 'test', 'c' FROM a)
         SELECT array_agg(account_id) AS ids FROM a`,
      );
      return (r.rows[0] as { ids: string[] }).ids;
    });
    const phase = async (n: number, ids: string[]) => run(`INSERT INTO ${REG} (account_id, attempt_number) SELECT x, ${n} FROM unnest($1::uuid[]) AS x`, [ids]);
    await phase(1, accounts);
    await run(`UPDATE ${REG} SET status = 'CANCELLED' WHERE account_id = ANY($1)`, [accounts]);
    await phase(2, accounts);
    await run(`UPDATE ${REG} SET status = 'CANCELLED' WHERE account_id = ANY($1) AND attempt_number = 2`, [accounts]);
    await phase(3, accounts);
    const third = accounts.length / 3;
    const [stay, cancelled, done] = [accounts.slice(0, third), accounts.slice(third, 2 * third), accounts.slice(2 * third)];
    await run(`UPDATE ${REG} SET status = 'CANCELLED' WHERE account_id = ANY($1) AND attempt_number = 3`, [cancelled]);
    await run(`UPDATE ${REG} SET market_id = $2, revision = revision + 1 WHERE account_id = ANY($1) AND attempt_number = 3`, [done, laOc]);
    await run(`UPDATE ${REG} SET status = 'COMPLETED' WHERE account_id = ANY($1) AND attempt_number = 3`, [done]);
    for (const t of types)
      await run(
        `INSERT INTO ${SEL} (provider_registration_id, service_type_id) SELECT provider_registration_id, $2 FROM ${REG} WHERE account_id = ANY($1) AND attempt_number = 3`,
        [stay, t.id],
      );
    for (const t of [REG, SEL, AUDIT]) await run(`ANALYZE ${t}`);
    const id = (await q<{ id: string }>(`SELECT provider_registration_id AS id FROM ${REG} WHERE account_id = $1 AND attempt_number = 3`, [stay[0]]))[0]!.id;
    sample = { account: stay[0]!, live: id, history: (cancelled[0] ?? stay[0])!, id };
    expect(await count(REG, 'account_id = ANY($1)', [accounts])).toBe(900);
    expect(await count(SEL, 'provider_registration_id = $1', [id])).toBe(10);
  });
  const SEQ_OFF = ['SET LOCAL enable_seqscan = off'];
  const usedIndexes = (plan: string): string[] =>
    [...new Set([...plan.matchAll(/(?:Scan(?: Backward)? using|Bitmap Index Scan on) (\w+)/g)].map((m) => m[1]!))].sort();
  const ALLOWED = new Set(['pk_registrations', 'uq_registrations__attempt', 'uq_registrations__live', 'pk_registration_service_types', 'pk_audit_events']);

  it('reads the CURRENT registration of an account (account_id and status <> CANCELLED) through the partial unique key alone: one index probe, no filter, no sort', async () => {
    const sql = `SELECT provider_registration_id, status, revision FROM ${REG} WHERE account_id = $1 AND status <> 'CANCELLED'`;
    const plan = await planOf(sql, [sample.account], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['uq_registrations__live']);
    expect(plan).toMatch(/Index Scan using uq_registrations__live on registrations/);
    expect(plan).not.toMatch(/Filter:|Sort|Seq Scan/);
    const analyzed = await planOf(sql, [sample.account], SEQ_OFF, true);
    expect(analyzed).toMatch(/actual rows=1 loops=1/);
    expect(await q(sql, [sample.account])).toHaveLength(1);
    expect(await q(sql, [sample.history])).toHaveLength(0); // an account whose last attempt is cancelled has no current registration
  });

  it('reads the LATEST attempt of an account (ORDER BY attempt_number DESC LIMIT 1) backwards from the attempt key, with no sort step', async () => {
    const sql = `SELECT provider_registration_id, attempt_number, status FROM ${REG} WHERE account_id = $1 ORDER BY attempt_number DESC LIMIT 1`;
    const plan = await planOf(sql, [sample.history], SEQ_OFF);
    expect(plan).toMatch(/Index Scan Backward using uq_registrations__attempt on registrations/);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
    expect(await q(sql, [sample.history])).toEqual([expect.objectContaining({ attempt_number: 3 })]);
  });

  it('reads the highest attempt number of an account (the question the start guard asks) from the attempt key, and the selections of ONE registration from the primary key of the selections', async () => {
    const maxPlan = await planOf(`SELECT COALESCE(max(attempt_number), 0) FROM ${REG} WHERE account_id = $1`, [sample.account], SEQ_OFF);
    expect(usedIndexes(maxPlan)).toEqual(['uq_registrations__attempt']);
    expect(maxPlan).not.toMatch(/Seq Scan/);
    const selPlan = await planOf(`SELECT service_type_id FROM ${SEL} WHERE provider_registration_id = $1`, [sample.id], SEQ_OFF);
    expect(usedIndexes(selPlan)).toEqual(['pk_registration_service_types']);
    expect(selPlan).not.toMatch(/Seq Scan|Sort/);
    const analyzed = await planOf(`SELECT service_type_id FROM ${SEL} WHERE provider_registration_id = $1`, [sample.id], SEQ_OFF, true);
    expect(analyzed).toMatch(/actual rows=10 loops=1/);
    const onePlan = await planOf(`SELECT 1 FROM ${SEL} WHERE provider_registration_id = $1 AND service_type_id = $2`, [sample.id, laOc], SEQ_OFF);
    expect(usedIndexes(onePlan)).toEqual(['pk_registration_service_types']);
  });

  it('reads one registration by its id from the primary key and by (account, attempt) from the attempt key', async () => {
    expect(usedIndexes(await planOf(`SELECT * FROM ${REG} WHERE provider_registration_id = $1 FOR SHARE`, [sample.id], SEQ_OFF))).toEqual(['pk_registrations']);
    expect(usedIndexes(await planOf(`SELECT * FROM ${REG} WHERE account_id = $1 AND attempt_number = $2`, [sample.account, 2], SEQ_OFF))).toEqual([
      'uq_registrations__attempt',
    ]);
  });

  it('uses no index outside the five of the schema in any of these plans, and returns the same rows whatever the plan (sequential scans allowed or not)', async () => {
    const statements: [string, unknown[]][] = [
      [`SELECT * FROM ${REG} WHERE account_id = $1 AND status <> 'CANCELLED'`, [sample.account]],
      [`SELECT * FROM ${REG} WHERE account_id = $1 ORDER BY attempt_number DESC LIMIT 1`, [sample.account]],
      [`SELECT service_type_id FROM ${SEL} WHERE provider_registration_id = $1 ORDER BY 1`, [sample.id]],
    ];
    for (const [sql, params] of statements) {
      const plan = await planOf(sql, params, SEQ_OFF);
      for (const idx of usedIndexes(plan)) expect(ALLOWED.has(idx), `${idx} in ${sql}`).toBe(true);
      const withScan = await q(sql, params);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL enable_indexscan = off');
        await c.query('SET LOCAL enable_bitmapscan = off');
        await c.query('SET LOCAL enable_indexonlyscan = off');
        expect((await c.query(sql, params)).rows, sql).toEqual(withScan);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
  });
});

// ====================================================================== J. no personal data, no duplicated state
describe('J. the provider tables cannot hold, and do not hold, anything about a person, a contact, a price, a document, a role status, a verification or a subscription', () => {
  // whole words of a column name (split on underscores)
  const FORBIDDEN_WORDS = new Set(
    'email mail phone mobile tel name first last address street city postal zip token secret password credential document doc legal terms consent text body title label description price fee cost amount rate currency tax duration minutes hours radius distance capacity quantity subscription plan payment credit invoice verified verification identity birth ssn hash note comment payload person user member owner customer role roles permission session cookie device ip lat lng lon geo point country locale language profile gig gigs'.split(
      ' ',
    ),
  );
  const forbidden = (column: string): boolean => column.split('_').some((w) => FORBIDDEN_WORDS.has(w));
  const ALLOWED_WORDS = new Set(
    'provider registration id account attempt number status market revision completed cancelled created updated at service type occurred actor action changes reason correlation audit event'.split(
      ' ',
    ),
  );

  it('has no column named after a person, a contact, an address, a token, a document, a legal text, a price, a role, a verification or a subscription: every word of every column name belongs to the registration vocabulary', async () => {
    const rows = await q<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'provider' AND table_name !~ '(gig|media_assets|profile)' ORDER BY 1, ordinal_position",
    );
    expect(rows).toHaveLength(Object.values(COLUMNS_BY_TABLE).reduce((a, c) => a + c.length, 0));
    expect(rows).toHaveLength(21);
    expect(rows.filter((r) => forbidden(r.column_name)).map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
    expect(
      rows.flatMap((r) =>
        r.column_name
          .split('_')
          .filter((w) => !ALLOWED_WORDS.has(w))
          .map((w) => `${r.table_name}.${r.column_name}:${w}`),
      ),
    ).toEqual([]);
    // the account is referenced by id only: the one column that names an account is the uuid foreign key
    expect(rows.filter((r) => r.column_name.split('_').includes('account')).map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`)).toEqual([
      'registrations.account_id:uuid',
    ]);
    // the only free-text columns are the status, the actor, the action, the reason and the correlation id; jsonb is the audit diff and nothing else
    expect(
      rows
        .filter((r) => r.data_type === 'text')
        .map((r) => `${r.table_name}.${r.column_name}`)
        .sort(),
    ).toEqual(['audit_events.action', 'audit_events.actor', 'audit_events.correlation_id', 'audit_events.reason', 'registrations.status']);
    expect([...new Set(rows.map((r) => r.data_type))].sort()).toEqual(['integer', 'jsonb', 'text', 'timestamp with time zone', 'uuid']);
    expect(rows.filter((r) => r.data_type === 'jsonb').map((r) => `${r.table_name}.${r.column_name}`)).toEqual(['audit_events.changes']);
    expect(rows.filter((r) => r.data_type === 'integer').map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'registrations.attempt_number',
      'registrations.revision',
    ]);
  });

  it('applies its own forbidden-word filter by whole words (a check that is not vacuous: first_name, contact_email, verified_at and role_status would be caught; correlation_id and provider_registration_id would not)', () => {
    expect(
      ['first_name', 'contact_email', 'verified_at', 'role_status', 'phone_number', 'legal_text', 'plan_id', 'document_id', 'unit_price'].filter(forbidden),
    ).toHaveLength(9);
    expect(['correlation_id', 'provider_registration_id', 'attempt_number', 'service_type_id', 'cancelled_at', 'changes', 'reason'].filter(forbidden)).toEqual(
      [],
    );
  });

  it("stores no duplicate of state owned elsewhere: no column repeats the account status, the role membership, the contact state, the consent state, a market code, a service type code or a name (only ids and the registration's own lifecycle)", async () => {
    const cols = (
      await q<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'provider' AND table_name !~ '(gig|media_assets|profile)'",
      )
    ).map((r) => r.column_name);
    for (const dup of [
      'account_status',
      'role_status',
      'email_verified',
      'phone_verified',
      'consent_status',
      'market_code',
      'service_type_code',
      'code',
      'name',
      'locale',
      'currency',
      'verified_at',
    ])
      expect(cols, dup).not.toContain(dup);
    expect(cols.filter((c) => /code$/.test(c))).toEqual([]);
  });

  it('writes nothing outside its own tables and reads only what it protects: the guards SELECT from identity.accounts, catalog.service_types and provider.registrations (the first two FOR SHARE), and never INSERT, UPDATE, DELETE, notify, touch the outbox or the audit trail', async () => {
    const src = Object.fromEntries(
      (
        await q<{ proname: string; prosrc: string }>(
          "SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'provider'::regnamespace AND proname !~ '(gig|media_assets|profile)'",
        )
      ).map((r) => [r.proname, r.prosrc]),
    );
    expect(Object.keys(src).sort()).toEqual(['forbid_mutation', 'guard_registration_service_types', 'guard_registrations']);
    for (const [fn, text] of Object.entries(src)) {
      expect(text, fn).not.toMatch(
        /INSERT\s+INTO|UPDATE\s+[a-z]|DELETE\s+FROM|pg_notify|NOTIFY|outbox|audit_events|TRUNCATE\s+[a-z]|EXECUTE\s|dblink|set_config/i,
      );
      expect([...text.matchAll(/\bFROM\s+([\w.]+)/gi)].map((m) => m[1]).sort(), fn).toEqual(
        {
          forbid_mutation: [],
          guard_registrations: ['identity.accounts', 'identity.accounts', 'provider.registrations'],
          guard_registration_service_types: ['catalog.service_types', 'provider.registrations'],
        }[fn]!.sort(),
      );
      // no business value in the code: the only numbers are 0 and 1 (the first attempt and revision, the zero of an empty history)
      expect(
        [...text.matchAll(/(?<![\w'.])\d+(?![\w'])/g)].map((m) => m[0]).filter((n) => n !== '0' && n !== '1'),
        fn,
      ).toEqual([]);
    }
    expect(src.guard_registrations!.match(/FROM identity\.accounts WHERE account_id = NEW\.account_id FOR SHARE/g)).toHaveLength(2);
    expect(src.guard_registration_service_types!).toMatch(/FROM provider\.registrations WHERE provider_registration_id = r_id FOR SHARE/);
    expect(src.guard_registration_service_types!).toMatch(/FROM catalog\.service_types WHERE service_type_id = NEW\.service_type_id FOR SHARE/);
  });

  it("leaves the audit trail and the outbox exactly as they were when the tables are changed by raw SQL (the audit rows and events are the service's job, in its own transaction)", async () => {
    const snap = async () => ({
      audit: await count(AUDIT),
      outbox: await count('integration.outbox_events'),
      accountAudit: await count('identity.account_audit_events'),
    });
    const before = await snap();
    const { id } = await make('MARKET');
    await pick(id, (await makeServiceType()).id);
    await completeReg(id);
    expect(await snap()).toEqual(before);
  });

  it('holds no registration, selection or audit row in a freshly migrated database (no registration is seeded) and no account or role is created by the migration', async () => {
    for (const t of TABLES) expect(await count(t, 'true', [], seedPool), t).toBe(0);
    expect(await count('identity.accounts', 'true', [], seedPool)).toBe(await count('identity.accounts', 'true', [], basePool));
    expect(await count('identity.account_roles', 'true', [], seedPool)).toBe(await count('identity.account_roles', 'true', [], basePool));
  });
});

describe('Z. final state of the mutated database', () => {
  it('holds every invariant after all of the above, leaves no session waiting on a lock and no transaction open', async () => {
    expect(await violations()).toEqual(NO_VIOLATIONS);
    await noLockWaiters();
    await noLockWaiters(racePool);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()",
      ),
    ).toEqual([{ n: 0 }]);
    // the same guards still answer on the database all of this ran against
    const { id } = await make('CANCELLED');
    await expectRule(bumpSqlRun(id), 'REGISTRATION_FROZEN');
  });
});
const bumpSqlRun = (id: string) => run(bumpSql(id).text, bumpSql(id).params);
