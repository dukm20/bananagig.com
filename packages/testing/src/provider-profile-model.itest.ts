import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROFILE_AUDIT_ACTIONS,
  PROFILE_ERROR_CODES,
  PROFILE_ISSUE_REASONS,
  PROFILE_VISIBILITIES,
  PROVIDER_PROFILE_POLICY_KEYS,
  ProviderProfilePolicy,
  profileBadgeKey,
  profileErrorKey,
  profileIssueKey,
  profileVisibilityKey,
} from '../../contracts/src/provider-profile';
import { TRUST_REQUIREMENT_TYPES } from '../../contracts/src/trust';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0024 (PRO-002, the provider public profile) adds two tables to the `provider` schema: provider.public_profiles (a PRESENTATION AGGREGATE: optional display name, optional bio,
// the profile photo by reference to a READY asset plus at most one pending upload, a two-state visibility and a revision; one row per provider account with its own opaque public id) and
// provider.profile_audit_events (immutable). It adds one immutable column to provider.media_assets (purpose: GIG_PHOTO | PROFILE_PHOTO), three functions (a profile guard, an asset helper and
// an audit guard), replaces two existing guards (the asset guard now freezes the purpose and counts profile references; the attachment guard refuses a PROFILE_PHOTO asset), and seeds seven
// policy parameters (configuration) and 78 managed copy entries (content) through the real workflows; migration 0025 (content only) adds seven more entries. Nothing is seeded into the new tables.
// These tests drive the REAL tables with raw SQL on an isolated database: shape, seeds against the contract, every CHECK, every guard rule on the exact failing statement, the revision and
// published_at rules, purpose separation in both directions, the reference-aware asset guard (delete and abandon) and the interleavings that matter under real concurrency (lock waiters
// polled in pg_stat_activity). Catalogue rows are created with session_replication_role = replica; every provider row is created with the guards ON unless a test says otherwise.
let iso: IsolatedDatabase;
let pool: pg.Pool;
let racePool: pg.Pool;
let seq = 0;
let laOc: string;
let sharedStId: string;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  laOc = ((await pool.query("SELECT market_id FROM geography.markets WHERE code = 'la-oc'")).rows[0] as { market_id: string }).market_id;
  sharedStId = (await makeTpl()).stId;
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await iso?.drop();
});

// ---------------------------------------------------------------- helpers
type Db = pg.Pool | pg.PoolClient;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = [], from: Db = pool): Promise<T[]> =>
  (await from.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = [], from: Db = pool) => from.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = [], from: Db = pool): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params, from))[0]!.n;
interface PgFailure {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}
const fail = async (p: Promise<unknown>): Promise<PgFailure> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  expect(e, 'the statement was expected to be rejected').toBeDefined();
  return e!;
};
/** The statement is refused by a guard with exactly this rule key (SQLSTATE 23000, DETAIL provider_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `provider_rule:${key}` });
};
/** The statement is refused by a named constraint with the SQLSTATE of its kind (check 23514, foreign key 23503, unique 23505). */
const expectConstraint = async (p: Promise<unknown>, constraint: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, constraint: e.constraint }).toEqual({
    code: constraint.startsWith('ck_') ? '23514' : constraint.startsWith('fk_') ? '23503' : '23505',
    constraint,
  });
};
const outcomeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  if (!e) return 'ACCEPTED';
  return e.detail?.startsWith('provider_rule:') ? e.detail.slice('provider_rule:'.length) : (e.constraint ?? e.code ?? 'ERROR');
};
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
/** A transaction with the user triggers and foreign-key triggers of every table off (the catalogue fixtures and the pure CHECK tests; CHECK constraints still apply). */
const replica = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
  inTx(async (c) => {
    await c.query('SET LOCAL session_replication_role = replica');
    return fn(c);
  });
const waitersOn = async (from: pg.Pool): Promise<number> =>
  (
    (
      await from.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
      )
    ).rows[0] as { n: number }
  ).n;
async function lockWaiters(atLeast: number, from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
type Racer = { text: string; params?: unknown[] } | ((c: pg.PoolClient) => Promise<unknown>);
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
/** The holder runs `hold` and stays open; the racer starts on another connection; the test waits until the racer is blocked on a lock; only then the holder commits. */
async function holdThenRace(
  hold: (c: pg.PoolClient) => Promise<unknown>,
  race: Racer,
  main: pg.Pool = pool,
  racing: pg.Pool = racePool,
): Promise<PgFailure | undefined> {
  const tx = await openTx(main);
  let racer: Promise<unknown> = Promise.resolve();
  try {
    await hold(tx);
    racer = rejection(runRacer(racing, race));
    await lockWaiters(1, main);
  } finally {
    await finish(tx, 'COMMIT');
  }
  return (await racer) as PgFailure | undefined;
}
const notDeadlock = (e: PgFailure | undefined) => expect(String(e?.code ?? ''), 'a deadlock or a serialization failure is a defect').not.toMatch(/^40/);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

// ---------------------------------------------------------------- fixtures: accounts and registrations (guards ON)
const historyRow = (c: Db, accountId: string, from: string | null, to: string) =>
  c.query(
    "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2::text, $3::text, NULL, 'test', 'test-correlation')",
    [accountId, from, to],
  );
async function makeAccount(): Promise<string> {
  return inTx(async (c) => {
    const id = ((await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0] as { account_id: string }).account_id;
    await historyRow(c, id, null, 'ACTIVE');
    return id;
  });
}
async function suspend(accountId: string): Promise<void> {
  await inTx(async (c) => {
    await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
    await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [accountId]);
    await historyRow(c, accountId, 'ACTIVE', 'SUSPENDED');
  });
}
/** A registration attempt for the account; COMPLETED only when asked (a complete one needs a market and a service type). */
async function register(account: string, end: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED', stIds: string[] = [sharedStId]): Promise<void> {
  await inTx(async (c) => {
    const id = (
      (await c.query('INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1) RETURNING provider_registration_id', [account]))
        .rows[0] as {
        provider_registration_id: string;
      }
    ).provider_registration_id;
    if (end === 'IN_PROGRESS') return;
    if (end === 'COMPLETED') {
      await c.query('UPDATE provider.registrations SET market_id = $2, revision = revision + 1 WHERE provider_registration_id = $1', [id, laOc]);
      for (const st of stIds)
        await c.query('INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id) VALUES ($1, $2)', [id, st]);
    }
    await c.query('UPDATE provider.registrations SET status = $2 WHERE provider_registration_id = $1', [id, end]);
  });
}
async function makeProvider(stIds: string[] = [sharedStId]): Promise<string> {
  const account = await makeAccount();
  await register(account, 'COMPLETED', stIds);
  return account;
}

// ---------------------------------------------------------------- fixtures: the catalogue (guards OFF through replication role replica; CHECK constraints still apply) and Gigs (guards ON)
let categoryId: string | undefined;
let fieldSeq = 0;
interface Tpl {
  tplId: string;
  tvId: string;
  stId: string;
  code: string;
  media: string;
}
async function makeTpl(): Promise<Tpl> {
  categoryId ??= await replica(
    async (c) =>
      (
        (await c.query("INSERT INTO catalog.categories (code, status) VALUES ($1, 'ACTIVE') RETURNING category_id", [`pp_${++seq}`])).rows[0] as {
          category_id: string;
        }
      ).category_id,
  );
  const code = `ppt_${++seq}`;
  return replica(async (c) => {
    const st = (
      await c.query("INSERT INTO catalog.service_types (category_id, code, status) VALUES ($1, $2, 'ACTIVE') RETURNING service_type_id", [
        categoryId,
        `ppst_${seq}`,
      ])
    ).rows[0] as { service_type_id: string };
    const tpl = (
      await c.query("INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, 'ACTIVE') RETURNING gig_template_id", [
        st.service_type_id,
        code,
      ])
    ).rows[0] as { gig_template_id: string };
    const tv = (
      await c.query(
        `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, pricing_fixed, published_at)
         VALUES ($1, 1, 'ACTIVE', true, now()) RETURNING gig_template_version_id`,
        [tpl.gig_template_id],
      )
    ).rows[0] as { gig_template_version_id: string };
    const key = `pp${++fieldSeq}`;
    await c.query(
      `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key)
       VALUES ($1, $2, 'TEXT', 'PROVIDER_CONFIGURABLE', 1, $3)`,
      [tv.gig_template_version_id, key, `catalog.gig_template.${code}.field.${key}.label`],
    );
    const mkey = `pp${++fieldSeq}`;
    const media = (
      await c.query(
        `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key, min_items, max_items)
         VALUES ($1, $2, 'MEDIA', 'PROVIDER_CONFIGURABLE', 2, $3, NULL, 5) RETURNING gig_template_field_id`,
        [tv.gig_template_version_id, mkey, `catalog.gig_template.${code}.field.${mkey}.label`],
      )
    ).rows[0] as { gig_template_field_id: string };
    return { tplId: tpl.gig_template_id, tvId: tv.gig_template_version_id, stId: st.service_type_id, code, media: media.gig_template_field_id };
  });
}
/** A provider with a Gig whose first version is a DRAFT. */
async function makeGig(): Promise<{ account: string; v1: string; media: string }> {
  const t = await makeTpl();
  const account = await makeProvider([t.stId]);
  return inTx(async (c) => {
    const gigId = (
      (await c.query('INSERT INTO provider.gigs (account_id, gig_template_id) VALUES ($1, $2) RETURNING gig_id', [account, t.tplId])).rows[0] as {
        gig_id: string;
      }
    ).gig_id;
    const v1 = (
      (
        await c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, 1, $2) RETURNING gig_version_id', [
          gigId,
          t.tvId,
        ])
      ).rows[0] as { gig_version_id: string }
    ).gig_version_id;
    return { account, v1, media: t.media };
  });
}

// ---------------------------------------------------------------- fixtures: assets and profiles (guards ON)
type Purpose = 'GIG_PHOTO' | 'PROFILE_PHOTO';
async function insertAsset(account: string, purpose: Purpose = 'PROFILE_PHOTO', from: Db = pool): Promise<string> {
  const id = randomUUID();
  await from.query(
    `INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at, purpose)
     VALUES ($1, $2, $3, 'image/png', 120000, now() + interval '900 seconds', $4)`,
    [id, account, `provider/gig-media/${id}`, purpose],
  );
  return id;
}
const makeReady = (id: string, from: Db = pool) =>
  from.query(
    "UPDATE provider.media_assets SET status = 'READY', sha256 = repeat('a', 64), width = 800, height = 600, scan_status = 'CLEAN', ready_at = now() WHERE media_asset_id = $1",
    [id],
  );
async function readyAsset(account: string, purpose: Purpose = 'PROFILE_PHOTO'): Promise<string> {
  const id = await insertAsset(account, purpose);
  await makeReady(id);
  return id;
}
const abandon = (id: string, from: Db = pool) => from.query("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [id]);
const markDeleted = (id: string, from: Db = pool) => from.query("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [id]);
const assetStatus = async (id: string): Promise<string> =>
  (await q<{ status: string }>('SELECT status FROM provider.media_assets WHERE media_asset_id = $1', [id]))[0]!.status;

interface Profile {
  id: string;
  account: string;
}
async function makeProfile(account?: string): Promise<Profile> {
  const a = account ?? (await makeProvider());
  const r = await q<{ public_profile_id: string }>('INSERT INTO provider.public_profiles (account_id) VALUES ($1) RETURNING public_profile_id', [a]);
  return { id: r[0]!.public_profile_id, account: a };
}
interface Row {
  public_profile_id: string;
  account_id: string;
  display_name: string | null;
  bio: string | null;
  photo_asset_id: string | null;
  pending_photo_asset_id: string | null;
  visibility_status: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
}
const row = async (id: string, from: Db = pool): Promise<Row> =>
  (await q<Row>('SELECT * FROM provider.public_profiles WHERE public_profile_id = $1', [id], from))[0]!;
const upd = (id: string, set: string, params: unknown[] = [], from: Db = pool) =>
  from.query(`UPDATE provider.public_profiles SET ${set} WHERE public_profile_id = $1`, [id, ...params]);
/** Raises the revision by one and applies `set` (the shape every effective change takes). */
const bump = (id: string, set: string, params: unknown[] = [], from: Db = pool) => upd(id, `${set}, revision = revision + 1`, params, from);

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, hasDefault: boolean];
const columnsOf = async (table: string): Promise<ColumnShape[]> =>
  (
    await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = $1 ORDER BY ordinal_position",
      [table],
    )
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default !== null]);
const TS = 'timestamp with time zone';
const COLUMNS: Record<string, ColumnShape[]> = {
  public_profiles: [
    ['public_profile_id', 'uuid', false, true],
    ['account_id', 'uuid', false, false],
    ['display_name', 'text', true, false],
    ['bio', 'text', true, false],
    ['photo_asset_id', 'uuid', true, false],
    ['pending_photo_asset_id', 'uuid', true, false],
    ['visibility_status', 'text', false, true],
    ['revision', 'integer', false, true],
    ['created_at', TS, false, true],
    ['updated_at', TS, false, true],
    ['published_at', TS, true, false],
  ],
  profile_audit_events: [
    ['audit_event_id', 'uuid', false, true],
    ['occurred_at', TS, false, true],
    ['actor', 'text', false, false],
    ['account_id', 'uuid', false, false],
    ['public_profile_id', 'uuid', false, false],
    ['action', 'text', false, false],
    ['changes', 'jsonb', true, false],
    ['correlation_id', 'text', false, false],
  ],
};
const CONSTRAINTS: Record<string, string[]> = {
  public_profiles: [
    'ck_public_profiles__bio',
    'ck_public_profiles__display_name',
    'ck_public_profiles__lifecycle',
    'ck_public_profiles__photo_distinct',
    'ck_public_profiles__revision',
    'ck_public_profiles__visibility',
    'fk_public_profiles__account_id',
    'fk_public_profiles__pending_photo_asset_id',
    'fk_public_profiles__photo_asset_id',
    'pk_public_profiles',
    'uq_public_profiles__account',
  ],
  profile_audit_events: [
    'ck_profile_audit_events__action',
    'ck_profile_audit_events__actor',
    'ck_profile_audit_events__changes_object',
    'fk_profile_audit_events__account_id',
    'fk_profile_audit_events__public_profile_id',
    'pk_profile_audit_events',
  ],
};
const FK_TARGETS: Record<string, string> = {
  fk_public_profiles__account_id: 'identity.accounts',
  fk_public_profiles__photo_asset_id: 'provider.media_assets',
  fk_public_profiles__pending_photo_asset_id: 'provider.media_assets',
  fk_profile_audit_events__account_id: 'identity.accounts',
  fk_profile_audit_events__public_profile_id: 'provider.public_profiles',
};
const INDEXES: Record<string, string[]> = {
  public_profiles: ['idx_public_profiles__pending_photo_asset', 'idx_public_profiles__photo_asset', 'pk_public_profiles', 'uq_public_profiles__account'],
  profile_audit_events: ['idx_profile_audit_events__profile', 'pk_profile_audit_events'],
};
const TRIGGERS: Record<string, string[]> = {
  public_profiles: ['trg_public_profiles__guard', 'trg_public_profiles__no_truncate'],
  profile_audit_events: ['trg_profile_audit_events__guard', 'trg_profile_audit_events__immutable', 'trg_profile_audit_events__no_truncate'],
};
const NEW_TABLES = Object.keys(COLUMNS);

describe('A. shape of the schema', () => {
  it.each(Object.entries(COLUMNS))('has exactly the documented columns, types, nullability and defaults on %s', async (table, expected) => {
    expect(await columnsOf(table)).toEqual(expected);
  });

  it('adds purpose to the assets as text NOT NULL DEFAULT GIG_PHOTO, last, commented, and every existing-style asset defaults to a Gig photo', async () => {
    const cols = await columnsOf('media_assets');
    expect(cols[cols.length - 1]).toEqual(['purpose', 'text', false, true]);
    expect(
      (
        await q<{ column_default: string }>(
          "SELECT column_default FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = 'media_assets' AND column_name = 'purpose'",
        )
      )[0]!.column_default,
    ).toBe("'GIG_PHOTO'::text");
    const account = await makeAccount();
    const id = randomUUID();
    await run(
      "INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, 'image/png', 1000, now() + interval '900 seconds')",
      [id, account, `provider/gig-media/${id}`],
    );
    expect((await q<{ purpose: string }>('SELECT purpose FROM provider.media_assets WHERE media_asset_id = $1', [id]))[0]!.purpose).toBe('GIG_PHOTO');
    expect(
      (
        await q<{ c: string }>(
          "SELECT col_description('provider.media_assets'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'provider.media_assets'::regclass AND attname = 'purpose')) AS c",
        )
      )[0]!.c,
    ).toMatch(/PROFILE_PHOTO/);
  });

  it.each(Object.entries(CONSTRAINTS))('has exactly the documented constraints on %s (by name), all validated, none deferrable', async (table, names) => {
    const rows = await q<{ conname: string; convalidated: boolean; condeferrable: boolean }>(
      "SELECT conname, convalidated, condeferrable FROM pg_constraint WHERE conrelid = $1::regclass AND contype <> 't'",
      [`provider.${table}`],
    );
    expect(rows.map((r) => r.conname).sort(byName)).toEqual([...names].sort(byName));
    expect(rows.every((r) => r.convalidated && !r.condeferrable)).toBe(true);
  });

  it('adds exactly one constraint to the assets (the purpose list)', async () => {
    const def = (await q<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ck_media_assets__purpose'"))[0]!.d;
    expect([...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]).sort()).toEqual(['GIG_PHOTO', 'PROFILE_PHOTO']);
  });

  it('declares every foreign key ON DELETE RESTRICT, ON UPDATE NO ACTION, MATCH SIMPLE, with the documented target', async () => {
    const fks = await q<{ conname: string; target: string; confdeltype: string; confupdtype: string; confmatchtype: string }>(
      `SELECT conname, confrelid::regclass::text AS target, confdeltype, confupdtype, confmatchtype FROM pg_constraint
        WHERE contype = 'f' AND conrelid = ANY ($1::text[]::regclass[])`,
      [NEW_TABLES.map((t) => `provider.${t}`)],
    );
    expect(Object.fromEntries(fks.map((r) => [r.conname, r.target]))).toEqual(FK_TARGETS);
    expect(fks.map((r) => [r.confdeltype, r.confupdtype, r.confmatchtype])).toEqual(fks.map(() => ['r', 'a', 's']));
  });

  it.each(Object.entries(INDEXES))('has exactly the documented indexes on %s and no other', async (table, names) => {
    const rows = await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'provider' AND tablename = $1", [table]);
    expect(rows.map((r) => r.indexname).sort(byName)).toEqual([...names].sort(byName));
  });

  it('defines the secondary indexes exactly (two partial photo-reference indexes and the audit history) and creates NO speculative visibility index', async () => {
    const defs = Object.fromEntries(
      (
        await q<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'provider' AND tablename = ANY ($1) AND indexname !~ '^(pk|uq)_'",
          [NEW_TABLES],
        )
      ).map((r) => [r.indexname, r.indexdef]),
    );
    expect(defs).toEqual({
      idx_public_profiles__photo_asset:
        'CREATE INDEX idx_public_profiles__photo_asset ON provider.public_profiles USING btree (photo_asset_id) WHERE (photo_asset_id IS NOT NULL)',
      idx_public_profiles__pending_photo_asset:
        'CREATE INDEX idx_public_profiles__pending_photo_asset ON provider.public_profiles USING btree (pending_photo_asset_id) WHERE (pending_photo_asset_id IS NOT NULL)',
      idx_profile_audit_events__profile:
        'CREATE INDEX idx_profile_audit_events__profile ON provider.profile_audit_events USING btree (public_profile_id, occurred_at)',
    });
    const unique = await q<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'provider' AND indexname = 'uq_public_profiles__account'");
    expect(unique[0]!.indexdef).toContain('UNIQUE INDEX uq_public_profiles__account ON provider.public_profiles USING btree (account_id)');
  });

  it('supports every foreign key of the new tables with an index whose leading column is the referencing column, except the documented audit account key', async () => {
    const rows = await q<{ conname: string }>(
      `SELECT conname FROM pg_constraint c WHERE contype = 'f' AND conrelid = ANY ($1::text[]::regclass[])
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`,
      [NEW_TABLES.map((t) => `provider.${t}`)],
    );
    expect(rows.map((r) => r.conname)).toEqual(['fk_profile_audit_events__account_id']);
  });

  it.each(Object.entries(TRIGGERS))('wires the triggers of %s exactly (by name), all enabled, and no constraint trigger', async (table, names) => {
    const rows = await q<{ tgname: string; tgenabled: string; tgconstraint: string }>(
      'SELECT tgname, tgenabled, tgconstraint::text FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal',
      [`provider.${table}`],
    );
    expect(rows.map((r) => r.tgname).sort(byName)).toEqual([...names].sort(byName));
    expect(rows.every((r) => r.tgenabled === 'O' && r.tgconstraint === '0')).toBe(true);
  });

  const FUNCTIONS = ['guard_public_profiles', 'assert_profile_photo_asset', 'guard_profile_audit_events', 'guard_media_assets', 'guard_gig_version_media'];
  it('keeps the profile functions in the provider schema, as trigger or void functions, commented, VOLATILE, not SECURITY DEFINER, without a search_path, and failing only with SQLSTATE 23000 and a provider_rule', async () => {
    const fns = await q<{ proname: string; result: string; volatility: string; secdef: boolean; config: string[] | null; comment: string | null; src: string }>(
      `SELECT p.proname, pg_get_function_result(p.oid) AS result, p.provolatile AS volatility, p.prosecdef AS secdef, p.proconfig AS config, obj_description(p.oid, 'pg_proc') AS comment, p.prosrc AS src
         FROM pg_proc p WHERE pronamespace = 'provider'::regnamespace AND proname = ANY ($1)`,
      [FUNCTIONS],
    );
    expect(fns.map((f) => [f.proname, f.result]).sort()).toEqual([
      ['assert_profile_photo_asset', 'void'],
      ['guard_gig_version_media', 'trigger'],
      ['guard_media_assets', 'trigger'],
      ['guard_profile_audit_events', 'trigger'],
      ['guard_public_profiles', 'trigger'],
    ]);
    for (const f of fns) {
      expect({ v: f.volatility, s: f.secdef, c: f.config }).toEqual({ v: 'v', s: false, c: null });
      expect((f.comment ?? '').length, f.proname).toBeGreaterThan(200);
      // LRN-0055: PL/pgSQL ends an IF condition at the first THEN, so a CASE never sits inside an IF condition
      expect(f.src, f.proname).not.toMatch(/\bIF\b[^;]*\bCASE\b/);
      const raises = f.src.match(/RAISE EXCEPTION/g) ?? [];
      expect(f.src.match(/ERRCODE = 'integrity_constraint_violation'/g)?.length, f.proname).toBe(raises.length);
      expect(f.src.match(/DETAIL = 'provider_rule:[A-Z_]+'/g)?.length, f.proname).toBe(raises.length);
    }
  });

  it('documents the rule keys of every changed or new guard exactly (the keys are the contract with the service)', async () => {
    const keysOf = async (fn: string): Promise<string[]> =>
      [
        ...new Set(
          [
            ...(
              await q<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE pronamespace = 'provider'::regnamespace AND proname = $1", [fn])
            )[0]!.src.matchAll(/provider_rule:([A-Z_]+)/g),
          ].map((m) => m[1]!),
        ),
      ].sort(byName);
    expect(await keysOf('guard_public_profiles')).toEqual([
      'ACCOUNT_NOT_ACTIVE',
      'IMMUTABLE_IDENTITY',
      'MUST_START_PRIVATE',
      'NO_DELETE',
      'PROVIDER_NOT_ELIGIBLE',
      'REVISION',
    ]);
    expect(await keysOf('assert_profile_photo_asset')).toEqual(['ASSET_NOT_USABLE', 'ASSET_OWNER', 'ASSET_PURPOSE']);
    expect(await keysOf('guard_profile_audit_events')).toEqual(['AUDIT_MISMATCH']);
    // the asset guard keeps every key of 0022 and adds none (a profile reference is an ASSET_REFERENCED)
    expect(await keysOf('guard_media_assets')).toEqual([
      'ACCOUNT_NOT_ACTIVE',
      'ASSET_FROZEN',
      'ASSET_REFERENCED',
      'BYTES_IMMUTABLE',
      'IMMUTABLE_IDENTITY',
      'MARKER_ONE_WAY',
      'MUST_START_PENDING',
      'NO_DELETE',
      'STATUS_TRANSITION',
    ]);
  });

  it('takes the locks in the order account, profile, asset: the profile guard reads the asset FOR SHARE last, the asset guard reads the references WITHOUT a lock, and no new guard touches the catalogue', async () => {
    const src = async (fn: string): Promise<string> =>
      (await q<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE pronamespace = 'provider'::regnamespace AND proname = $1", [fn]))[0]!.src;
    const profile = await src('guard_public_profiles');
    expect(profile.indexOf('FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE')).toBeGreaterThan(-1);
    expect(profile.indexOf('provider.assert_profile_photo_asset')).toBeGreaterThan(profile.indexOf('FROM identity.accounts'));
    const helper = await src('assert_profile_photo_asset');
    expect(helper).toContain('FROM provider.media_assets WHERE media_asset_id = p_asset_id FOR SHARE');
    const assets = await src('guard_media_assets');
    for (const m of assets.match(/FROM provider\.public_profiles[^)]*\)/g) ?? []) expect(m).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE)/);
    expect(assets.match(/FROM provider\.public_profiles/g)?.length).toBe(4); // photo and pending, for DELETED and for ABANDONED
    for (const fn of ['guard_public_profiles', 'assert_profile_photo_asset', 'guard_profile_audit_events', 'guard_media_assets']) {
      expect(await src(fn), fn).not.toMatch(/FROM catalog\./);
    }
  });

  it('comments both tables (200+ characters) and the columns that carry a rule', async () => {
    for (const t of NEW_TABLES) {
      expect((await q<{ c: string | null }>("SELECT obj_description($1::regclass, 'pg_class') AS c", [`provider.${t}`]))[0]!.c).toMatch(/^.{200,}/s);
    }
    const commented = async (table: string, column: string): Promise<string | null> =>
      (
        await q<{ c: string | null }>(
          'SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c',
          [`provider.${table}`, column],
        )
      )[0]!.c;
    const expected: Record<string, string[]> = {
      public_profiles: [
        'public_profile_id',
        'account_id',
        'display_name',
        'bio',
        'photo_asset_id',
        'pending_photo_asset_id',
        'visibility_status',
        'revision',
        'published_at',
      ],
      profile_audit_events: ['changes'],
    };
    for (const [t, cols] of Object.entries(expected)) for (const c of cols) expect((await commented(t, c))?.length ?? 0, `${t}.${c}`).toBeGreaterThan(40);
  });

  it('stores only provider-authored presentation on the profile: no JSON, no float, no verified flag, no badge, no Gig, no price, no rating, no name copy, no location, no URL or key', async () => {
    const cols = await q<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = 'public_profiles'",
    );
    expect(
      cols.filter((c) =>
        /verif|badge|trust|gig|price|amount|rating|review|first_name|last_name|legal|market|area|lat|lng|geo|url|key|hash|sha|address|email|phone/.test(
          c.column_name,
        ),
      ),
    ).toEqual([]);
    expect(cols.filter((c) => ['jsonb', 'json', 'real', 'double precision', 'numeric', 'ARRAY'].includes(c.data_type))).toEqual([]);
  });

  it('keeps the audit trail immutable and its action list exactly the four actions of the contract', async () => {
    const def = (await q<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ck_profile_audit_events__action'"))[0]!.d;
    const listed = [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);
    expect([...listed].sort(byName)).toEqual([...PROFILE_AUDIT_ACTIONS].sort(byName));
    expect(listed).toHaveLength(4);
  });
});

// ====================================================================== B. seeds
const POLICY_SEED = [
  [PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength, 'INTEGER', 60, { min: 1, max: 100 }, 'STANDARD'],
  [PROVIDER_PROFILE_POLICY_KEYS.bioMaxLength, 'INTEGER', 1000, { min: 1, max: 5000 }, 'STANDARD'],
  [PROVIDER_PROFILE_POLICY_KEYS.bioRequired, 'BOOLEAN', false, {}, 'STANDARD'],
  [PROVIDER_PROFILE_POLICY_KEYS.photoRequired, 'BOOLEAN', false, {}, 'STANDARD'],
  [PROVIDER_PROFILE_POLICY_KEYS.photoMaxFileSizeBytes, 'INTEGER', 2_097_152, { min: 1, max: 26_214_400 }, 'STANDARD'],
  [PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes, 'JSON', ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE'], undefined, 'CRITICAL'],
  [PROVIDER_PROFILE_POLICY_KEYS.publicRequiresMarketplaceEligibility, 'BOOLEAN', false, {}, 'CRITICAL'],
] as const;
/** Section 6 of the checkpoint specification: the UI keys of the minimal profile pages. */
const SPEC_UI_KEYS = [
  'page.title',
  'page.intro',
  'name.label',
  'name.hint',
  'name.fallback_note',
  'bio.label',
  'bio.hint',
  'photo.heading',
  'photo.hint',
  'photo.upload',
  'photo.remove',
  'photo.none',
  'visibility.heading',
  'visibility.private_note',
  'visibility.public_note',
  'visibility.make_public',
  'visibility.make_private',
  'visibility.not_live_note',
  'readiness.heading',
  'readiness.name',
  'readiness.bio',
  'readiness.photo',
  'readiness.gig',
  'readiness.trust',
  'readiness.complete',
  'preview.heading',
  'preview.note',
  'preview.back',
  'public.gigs_heading',
  'public.no_gigs',
  'public.badges_heading',
  'public.about_heading',
  'public.price_from',
  'public.duration',
  'public.options',
  'public.photos',
  'save',
  'notice.created',
  'notice.saved',
  'notice.published',
  'notice.unpublished',
  'notice.photo_added',
  'notice.photo_removed',
].map((k) => `provider.profile.${k}`);
const EMPTY_STATE_KEYS = ['public.no_badges', 'public.no_bio', 'public.not_found'].map((k) => `provider.profile.${k}`);
const SEED_0024 = "e.entry_id IN (SELECT entry_id FROM content.audit_events WHERE correlation_id = 'seed-0024' AND action = 'ENTRY_CREATED')";

describe('B. seeds (configuration and content, through the real workflows)', () => {
  const paramRows = () =>
    q<{
      key: string;
      data_type: string;
      validation_rules: { min?: number; max?: number; schema?: unknown };
      approval_policy: string;
      criticality: string;
      sensitivity: string;
      is_required: boolean;
      owner_role: string;
      value: unknown;
      state: string;
      scope_type: string;
    }>(
      `SELECT p.key, p.data_type, p.validation_rules, p.approval_policy, p.criticality, p.sensitivity, p.is_required, p.owner_role, vv.value, cr.state, pv.scope_type
         FROM configuration.parameters p
         JOIN configuration.parameter_values pv ON pv.parameter_id = p.parameter_id
         JOIN configuration.value_versions vv ON vv.parameter_value_id = pv.parameter_value_id
         JOIN configuration.change_requests cr ON cr.value_version_id = vv.version_id
        WHERE p.key LIKE 'provider.profile.%' ORDER BY p.key COLLATE "C"`,
    );

  it('seeds exactly the seven parameters of the contract as typed PLATFORM parameters with the documented bounds, the active value and a SECOND_APPROVER policy; the two that decide public exposure are CRITICAL', async () => {
    const rows = await paramRows();
    expect(rows.map((r) => r.key).sort(byName)).toEqual(Object.values(PROVIDER_PROFILE_POLICY_KEYS).sort(byName));
    expect(rows).toHaveLength(7);
    for (const [k, type, value, rules, criticality] of POLICY_SEED) {
      expect(
        rows.find((x) => x.key === k)!,
        k,
      ).toMatchObject({
        data_type: type,
        approval_policy: 'SECOND_APPROVER',
        criticality,
        sensitivity: 'INTERNAL',
        is_required: true,
        owner_role: 'platform',
        state: 'ACTIVE',
        scope_type: 'PLATFORM',
        value,
        ...(rules ? { validation_rules: rules } : {}),
      });
    }
    expect(
      rows
        .filter((r) => r.criticality === 'CRITICAL')
        .map((r) => r.key)
        .sort(byName),
    ).toEqual([PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes, PROVIDER_PROFILE_POLICY_KEYS.publicRequiresMarketplaceEligibility].sort(byName));
    expect(rows.find((x) => x.key === PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes)!.validation_rules.schema).toEqual({
      type: 'array',
      items: { type: 'string', enum: [...TRUST_REQUIREMENT_TYPES] },
      uniqueItems: true,
      minItems: 0,
      maxItems: 7,
    });
  });

  it('seeds values that parse as the contract policy, with the assumptions of the header: no required bio or photo, 2 MiB photos, three badge types, the eligibility gate off', async () => {
    const v = Object.fromEntries((await paramRows()).map((r) => [r.key, r.value]));
    expect(
      ProviderProfilePolicy.parse({
        displayNameMaxLength: v[PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength],
        bioMaxLength: v[PROVIDER_PROFILE_POLICY_KEYS.bioMaxLength],
        bioRequired: v[PROVIDER_PROFILE_POLICY_KEYS.bioRequired],
        photoRequired: v[PROVIDER_PROFILE_POLICY_KEYS.photoRequired],
        photoMaxFileSizeBytes: v[PROVIDER_PROFILE_POLICY_KEYS.photoMaxFileSizeBytes],
        publicBadgeTypes: v[PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes],
        publicRequiresMarketplaceEligibility: v[PROVIDER_PROFILE_POLICY_KEYS.publicRequiresMarketplaceEligibility],
      }),
    ).toEqual({
      displayNameMaxLength: 60,
      bioMaxLength: 1000,
      bioRequired: false,
      photoRequired: false,
      photoMaxFileSizeBytes: 2 * 1024 * 1024,
      publicBadgeTypes: ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE'],
      publicRequiresMarketplaceEligibility: false,
    });
    // the configured limits sit inside the structural CHECK ceilings of the table
    expect(v[PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength] as number).toBeLessThanOrEqual(100);
    expect(v[PROVIDER_PROFILE_POLICY_KEYS.bioMaxLength] as number).toBeLessThanOrEqual(5000);
    expect(v[PROVIDER_PROFILE_POLICY_KEYS.photoMaxFileSizeBytes] as number).toBeLessThan(10 * 1024 * 1024); // lower than the Gig photo limit
  });

  it('wrote the configuration audit trail of every seeded parameter exactly as the workflow does (created, drafted, submitted, approved, published, activated)', async () => {
    const rows = await q<{ key: string; actions: string[] }>(
      `SELECT p.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions FROM configuration.parameters p JOIN configuration.audit_events a ON a.parameter_id = p.parameter_id
        WHERE p.key LIKE 'provider.profile.%' AND a.correlation_id = 'seed-0024' GROUP BY 1`,
    );
    expect(rows).toHaveLength(7);
    for (const r of rows)
      expect([...new Set(r.actions)].sort()).toEqual([
        'CHANGE_ACTIVATED',
        'CHANGE_APPROVED',
        'CHANGE_DRAFTED',
        'CHANGE_PUBLISHED',
        'CHANGE_SUBMITTED',
        'PARAMETER_CREATED',
      ]);
  });

  it('seeds one content entry per visibility (2), error code (12), issue reason (11), requirement-type badge (7), UI key of the specification (43) and empty state (3): 78 entries, and nothing else under that correlation', async () => {
    expect([
      PROFILE_VISIBILITIES.length,
      PROFILE_ERROR_CODES.length,
      PROFILE_ISSUE_REASONS.length,
      TRUST_REQUIREMENT_TYPES.length,
      SPEC_UI_KEYS.length,
      EMPTY_STATE_KEYS.length,
    ]).toEqual([2, 12, 11, 7, 43, 3]);
    const expected = [
      ...PROFILE_VISIBILITIES.map(profileVisibilityKey),
      ...PROFILE_ERROR_CODES.map(profileErrorKey),
      ...PROFILE_ISSUE_REASONS.map(profileIssueKey),
      ...TRUST_REQUIREMENT_TYPES.map(profileBadgeKey),
      ...SPEC_UI_KEYS,
      ...EMPTY_STATE_KEYS,
    ];
    expect(new Set(expected).size).toBe(78);
    const keys = (await q<{ key: string }>(`SELECT key FROM content.entries e WHERE ${SEED_0024}`)).map((r) => r.key);
    expect([...keys].sort(byName)).toEqual([...expected].sort(byName));
  });

  it('has copy for ALL seven requirement types (a configuration change of the badge list never lacks a label) and none for a type that does not exist', async () => {
    const present = new Set((await q<{ key: string }>("SELECT key FROM content.entries WHERE key LIKE 'provider.profile.badge.%'")).map((r) => r.key));
    for (const t of TRUST_REQUIREMENT_TYPES) expect(present.has(profileBadgeKey(t)), t).toBe(true);
    expect(present.size).toBe(7);
  });

  it('does not duplicate the photo refusal reasons: the existing provider.gig.media.refused.* copy (0023) is reused, and no profile refusal key exists', async () => {
    expect(await count('content.entries', "key LIKE 'provider.gig.media.refused.%'")).toBe(13);
    expect(await count('content.entries', "key LIKE 'provider.profile.%.refused.%'")).toBe(0);
  });

  it('publishes every seeded entry as an active en-US PLATFORM version through the real lifecycle, as plain platform copy with no variables, no markup, no numbers and no legal type', async () => {
    const rows = await q<{
      key: string;
      content_type: string;
      is_active: boolean;
      locale: string;
      scope_type: string;
      status: string;
      body: string;
      n: number;
      owner_role: string;
    }>(
      `SELECT e.key, e.content_type, e.is_active, e.owner_role, v.locale, v.scope_type, v.status, v.body, count(*) OVER (PARTITION BY e.key)::int AS n
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${SEED_0024}`,
    );
    expect(rows).toHaveLength(78);
    for (const r of rows) {
      expect({ active: r.is_active, locale: r.locale, scope: r.scope_type, status: r.status, n: r.n, owner: r.owner_role }).toEqual({
        active: true,
        locale: 'en-US',
        scope: 'PLATFORM',
        status: 'PUBLISHED',
        n: 1,
        owner: 'CONTENT',
      });
      expect(['UI_LABEL', 'PLAIN_TEXT']).toContain(r.content_type);
      expect(r.body.trim().length, r.key).toBeGreaterThan(1);
      expect(r.body, r.key).not.toMatch(/[{}<>]|@|\$\{|\d/);
    }
    // the content lifecycle audit of one entry
    const audit = await q<{ action: string }>(
      "SELECT a.action FROM content.audit_events a JOIN content.entries e USING (entry_id) WHERE e.key = 'provider.profile.page.title' AND a.correlation_id = 'seed-0024' ORDER BY a.occurred_at, a.audit_event_id",
    );
    expect(audit.map((a) => a.action)).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
  });

  it('says what the platform did and no more: the one statement the spec fixes is verbatim, no body claims cheapest or guaranteed, and the base price is labelled as the base', async () => {
    const body = async (k: string): Promise<string> =>
      (
        await q<{ body: string }>("SELECT v.body FROM content.entries e JOIN content.versions v USING (entry_id) WHERE e.key = $1 AND v.status = 'PUBLISHED'", [
          k,
        ])
      )[0]!.body;
    expect(await body('provider.profile.visibility.not_live_note')).toBe('A public profile does not make you live or bookable.');
    expect(await body('provider.profile.public.price_from')).toBe('Base price');
    const claims = await q<{ key: string }>(
      `SELECT e.key FROM content.entries e JOIN content.versions v USING (entry_id) WHERE ${SEED_0024} AND v.body ~* '(cheapest|lowest|cheaper|guarantee|certified|verified|best|safe)'`,
    );
    expect(claims).toEqual([]);
  });

  const SEED_0025 = "e.entry_id IN (SELECT entry_id FROM content.audit_events WHERE correlation_id = 'seed-0025' AND action = 'ENTRY_CREATED')";
  const COPY_0025: [string, string, string][] = [
    ['provider.profile.public.not_bookable_note', 'PLAIN_TEXT', 'Booking is not open yet. The prices shown are base prices and can change.'],
    ['provider.profile.visibility.view_public', 'UI_LABEL', 'View your public page'],
    ['provider.profile.visibility.also_shown_note', 'PLAIN_TEXT', 'Your published Gigs and verification badges also appear on your public profile.'],
    ['provider.profile.readiness.required_heading', 'UI_LABEL', 'Needed to make your profile public'],
    ['provider.profile.readiness.shown_heading', 'UI_LABEL', 'Shown on your profile when you have them'],
    [
      'provider.profile.visibility.save_first_note',
      'PLAIN_TEXT',
      'Save your name and bio before you upload a photo or change who can see your profile. Unsaved text is not kept.',
    ],
    ['provider.profile.error.page_unavailable_registration', 'PLAIN_TEXT', 'Finish your provider registration before you set up a public profile.'],
  ];

  it('0025 (content only) adds exactly the seven reviewed entries with their exact en-US PLATFORM bodies through the real lifecycle, and nothing else under that correlation', async () => {
    const rows = await q<{
      key: string;
      content_type: string;
      body: string;
      status: string;
      locale: string;
      scope_type: string;
      is_active: boolean;
      n: number;
    }>(
      `SELECT e.key, e.content_type, v.body, v.status, v.locale, v.scope_type, e.is_active, count(*) OVER (PARTITION BY e.key)::int AS n
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${SEED_0025}`,
    );
    expect(rows.map((r) => [r.key, r.content_type, r.body]).sort()).toEqual([...COPY_0025].sort());
    for (const r of rows) {
      expect({ status: r.status, locale: r.locale, scope: r.scope_type, active: r.is_active, n: r.n }).toEqual({
        status: 'PUBLISHED',
        locale: 'en-US',
        scope: 'PLATFORM',
        active: true,
        n: 1,
      });
      expect(r.body, r.key).not.toMatch(/[{}<>]|@|\$\{|\d|cheapest|lowest|guarantee/i);
    }
    const audit = await q<{ action: string }>(
      "SELECT a.action FROM content.audit_events a JOIN content.entries e USING (entry_id) WHERE e.key = 'provider.profile.visibility.view_public' AND a.correlation_id = 'seed-0025' ORDER BY a.occurred_at, a.audit_event_id",
    );
    expect(audit.map((a) => a.action)).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
  });

  it('keeps all 78 entries of 0024 untouched (one PUBLISHED version each, correlation seed-0024) next to the seven of 0025: 85 provider.profile.* entries in all', async () => {
    expect(await count('content.entries e', SEED_0024)).toBe(78);
    expect(await count('content.versions v JOIN content.entries e ON e.entry_id = v.entry_id', `v.status = 'PUBLISHED' AND ${SEED_0024}`)).toBe(78);
    expect(await count('content.versions v JOIN content.entries e ON e.entry_id = v.entry_id', `v.status <> 'PUBLISHED' AND ${SEED_0024}`)).toBe(0);
    expect(await count('content.entries', "key LIKE 'provider.profile.%'")).toBe(85);
    expect(COPY_0025.every(([k]) => k.startsWith('provider.profile.'))).toBe(true);
  });

  it('seeds nothing into the new tables (a freshly migrated database has both empty) and no asset has a profile purpose', async () => {
    const fresh = await createIsolatedDatabase();
    const c = createTestPool(fresh.url, 2);
    try {
      for (const t of NEW_TABLES) expect(await count(`provider.${t}`, 'true', [], c)).toBe(0);
      expect(await count('provider.media_assets', "purpose = 'PROFILE_PHOTO'", [], c)).toBe(0);
    } finally {
      await c.end();
      await fresh.drop();
    }
  }, 120_000);
});

// ====================================================================== C. provider.public_profiles
describe('C. provider.public_profiles: creation and eligibility', () => {
  it('creates a PRIVATE profile at revision 1 with a random public id, no text, no photo and no publication time, for an ACTIVE provider with a COMPLETED registration', async () => {
    const p = await makeProfile();
    const r = await row(p.id);
    expect(r).toMatchObject({
      account_id: p.account,
      display_name: null,
      bio: null,
      photo_asset_id: null,
      pending_photo_asset_id: null,
      visibility_status: 'PRIVATE',
      revision: 1,
      published_at: null,
    });
    expect(p.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // gen_random_uuid(): version 4
    expect(p.id).not.toBe(p.account);
    const second = await makeProfile();
    expect(second.id).not.toBe(p.id);
  });

  it('starts only PRIVATE at revision 1 with no publication time (MUST_START_PRIVATE)', async () => {
    const a = await makeProvider();
    for (const [set, label] of [
      ['visibility_status, published_at', "'PUBLIC', now()"],
      ['revision', '2'],
      ['published_at', 'now()'],
    ] as const)
      await expectRule(run(`INSERT INTO provider.public_profiles (account_id, ${set}) VALUES ($1, ${label})`, [a]), 'MUST_START_PRIVATE');
    expect(await count('provider.public_profiles', 'account_id = $1', [a])).toBe(0);
  });

  it('creates a profile only for an ACTIVE account (ACCOUNT_NOT_ACTIVE) with a COMPLETED registration (PROVIDER_NOT_ELIGIBLE): none, in progress and cancelled are not enough', async () => {
    const suspended = await makeProvider();
    await suspend(suspended);
    await expectRule(run('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [suspended]), 'ACCOUNT_NOT_ACTIVE');
    const none = await makeAccount();
    await expectRule(run('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [none]), 'PROVIDER_NOT_ELIGIBLE');
    const inProgress = await makeAccount();
    await register(inProgress, 'IN_PROGRESS');
    await expectRule(run('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [inProgress]), 'PROVIDER_NOT_ELIGIBLE');
    const cancelled = await makeAccount();
    await register(cancelled, 'CANCELLED');
    await expectRule(run('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [cancelled]), 'PROVIDER_NOT_ELIGIBLE');
    for (const a of [suspended, none, inProgress, cancelled]) expect(await count('provider.public_profiles', 'account_id = $1', [a])).toBe(0);
  });

  it('refuses a missing account as a foreign key failure', async () => {
    await expectConstraint(run('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [randomUUID()]), 'fk_public_profiles__account_id');
  });

  it('allows exactly one profile per account (uq_public_profiles__account), also under ten simultaneous creates', async () => {
    const a = await makeProvider();
    await run('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [a]);
    await expectConstraint(run('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [a]), 'uq_public_profiles__account');
    const b = await makeProvider();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => outcomeOf(racePool.query('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [b]))),
    );
    expect(outcomes.filter((o) => o === 'ACCEPTED')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== 'ACCEPTED' && o !== 'uq_public_profiles__account')).toEqual([]);
    expect(await count('provider.public_profiles', 'account_id = $1', [b])).toBe(1);
  });

  it('accepts a profile created WITH a name and a bio (the guards do not require them to be empty)', async () => {
    const a = await makeProvider();
    await run("INSERT INTO provider.public_profiles (account_id, display_name, bio) VALUES ($1, 'Jane Cleaning', 'I clean cars.')", [a]);
    expect(await count('provider.public_profiles', "account_id = $1 AND display_name = 'Jane Cleaning'", [a])).toBe(1);
  });
});

describe('C. provider.public_profiles: the provider text CHECKs', () => {
  // the guards are off (replication role replica) so the account and registration are irrelevant; only the CHECK constraints speak
  const insertRaw = (set: string, value: unknown) =>
    replica((c) => c.query(`INSERT INTO provider.public_profiles (account_id, ${set}) VALUES (gen_random_uuid(), $1)`, [value]));
  const name = (v: unknown) => insertRaw('display_name', v);
  const bio = (v: unknown) => insertRaw('bio', v);

  it('accepts NULL, the boundary lengths by code point (100 and 5000, multi-byte) and ordinary multilingual text', async () => {
    await name(null);
    await bio(null);
    await name('é'.repeat(100));
    await name('界'.repeat(100));
    await name('Maria-José O’Neil');
    await name('Jane Cleaning & Co');
    await name(`Sparkle ${cp(0x1f697)}`);
    await bio('x'.repeat(5000));
    await bio('界'.repeat(5000));
    await bio('First line.\nSecond line.\n\nA tab\tinside.');
    await bio(`Emoji family ${cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)} joined by ZWJ`); // the zero-width joiner is NOT refused
  });

  it('refuses a display name that is blank, padded, over 100 code points, multi-line, decomposed (not NFC) or holds a control, bidirectional-override or invisible character', async () => {
    for (const bad of ['', '   ', ' Jane', 'Jane ', '\tJane', 'é'.repeat(101), '界'.repeat(101), 'Jane\nCleaning', 'Jane\tCleaning', 'Jane\rCleaning'])
      await expectConstraint(name(bad), 'ck_public_profiles__display_name');
    for (const codePoint of [
      0x01, 0x1f, 0x7f, 0x9f, 0xad, 0x61c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0x206f, 0x3164, 0x2800, 0xfeff,
      0xfffb,
    ]) {
      await expectConstraint(name(`Jane${cp(codePoint)}Cleaning`), 'ck_public_profiles__display_name');
    }
    await expectConstraint(name(`Jane e${cp(0x301)}`), 'ck_public_profiles__display_name'); // e + combining acute: NFD
  });

  it('refuses a bio that is blank, padded, over 5000 code points or decomposed, or holds a control (other than line feed and tab), bidirectional-override or invisible character', async () => {
    for (const bad of ['', '  \n  ', ' leading', 'trailing\n', 'x'.repeat(5001), '界'.repeat(5001), 'carriage\rreturn'])
      await expectConstraint(bio(bad), 'ck_public_profiles__bio');
    for (const codePoint of [
      0x01, 0x08, 0x0b, 0x0c, 0x0d, 0x1f, 0x7f, 0x85, 0x9f, 0xad, 0x61c, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x206f, 0x3164, 0x2800, 0xfeff, 0xfffb,
    ]) {
      await expectConstraint(bio(`Line${cp(codePoint)}text`), 'ck_public_profiles__bio');
    }
    await expectConstraint(bio(`caf${'e'}${cp(0x301)}`), 'ck_public_profiles__bio');
  });

  it('keeps every value the service normaliser accepts acceptable here (the CHECK is a strict subset of the service rules): ZWNJ and ZWJ, line feeds, tabs, U+2028 in a bio', async () => {
    await bio(`a${cp(0x200c)}b`);
    await bio(`a${cp(0x200d)}b`);
    await bio(`a${cp(0x2028)}b`); // the service does not refuse a line separator in multi-line text
    await name(`a${cp(0x200c)}b`);
  });

  it('refuses a status outside PRIVATE | PUBLIC, a revision below one, equal photo pointers and a lifecycle that disagrees with the visibility (reached with the guards off)', async () => {
    const id = randomUUID();
    const raw = (set: string, values: string) =>
      replica((c) => c.query(`INSERT INTO provider.public_profiles (public_profile_id, account_id, ${set}) VALUES ($1, gen_random_uuid(), ${values})`, [id]));
    await expectConstraint(raw('visibility_status', "'HIDDEN'"), 'ck_public_profiles__visibility'); // no publication time, so the lifecycle CHECK passes and the list CHECK speaks
    await expectConstraint(raw('visibility_status', "'SUSPENDED'"), 'ck_public_profiles__visibility');
    await expectConstraint(raw('revision', '0'), 'ck_public_profiles__revision');
    await expectConstraint(raw('revision', '-3'), 'ck_public_profiles__revision');
    await expectConstraint(raw('visibility_status', "'PUBLIC'"), 'ck_public_profiles__lifecycle');
    await expectConstraint(raw('published_at', 'now()'), 'ck_public_profiles__lifecycle');
    const asset = randomUUID();
    await expectConstraint(raw('photo_asset_id, pending_photo_asset_id', `'${asset}', '${asset}'`), 'ck_public_profiles__photo_distinct');
    await raw('visibility_status, published_at', "'PUBLIC', now()");
  });
});

describe('C. provider.public_profiles: identity, deletion and truncation', () => {
  it('keeps the public id, the owner and the creation time immutable (IMMUTABLE_IDENTITY)', async () => {
    const p = await makeProfile();
    const other = await makeProvider();
    await expectRule(upd(p.id, 'public_profile_id = gen_random_uuid()'), 'IMMUTABLE_IDENTITY');
    await expectRule(upd(p.id, 'account_id = $2', [other]), 'IMMUTABLE_IDENTITY');
    await expectRule(upd(p.id, "created_at = now() - interval '1 day'"), 'IMMUTABLE_IDENTITY');
    expect(await row(p.id)).toMatchObject({ public_profile_id: p.id, account_id: p.account });
  });

  it('never deletes a profile (NO_DELETE) and refuses TRUNCATE (plain and CASCADE) with ROW_IMMUTABLE, keeping every row', async () => {
    const p = await makeProfile();
    await expectRule(run('DELETE FROM provider.public_profiles WHERE public_profile_id = $1', [p.id]), 'NO_DELETE');
    const before = await count('provider.public_profiles');
    // a plain TRUNCATE is refused by PostgreSQL itself because the audit table references the profiles; with CASCADE the guard answers
    expect((await fail(run('TRUNCATE provider.public_profiles'))).code).toBe('0A000');
    await expectRule(run('TRUNCATE provider.public_profiles CASCADE'), 'ROW_IMMUTABLE');
    expect(await count('provider.public_profiles')).toBe(before);
  });
});

describe('C. provider.public_profiles: revision, visibility and published_at', () => {
  it('raises the revision by exactly one with a change of the name, the bio, the photo or the visibility (REVISION), and refuses a jump, no raise and a decrease', async () => {
    const p = await makeProfile();
    await expectRule(upd(p.id, "display_name = 'Jane'"), 'REVISION'); // no raise
    await expectRule(upd(p.id, "display_name = 'Jane', revision = revision + 2"), 'REVISION');
    await expectRule(upd(p.id, "bio = 'Hello', revision = revision - 1"), 'REVISION');
    await expectRule(upd(p.id, "visibility_status = 'PUBLIC'"), 'REVISION');
    expect((await row(p.id)).revision).toBe(1);
    await bump(p.id, "display_name = 'Jane'");
    await bump(p.id, "bio = 'Hello'");
    await bump(p.id, 'display_name = NULL');
    expect((await row(p.id)).revision).toBe(4);
    const asset = await readyAsset(p.account);
    await expectRule(upd(p.id, 'photo_asset_id = $2', [asset]), 'REVISION');
    await bump(p.id, 'photo_asset_id = $2', [asset]);
    expect((await row(p.id)).revision).toBe(5);
  });

  it('keeps the revision on an update that changes nothing, and refuses a raise without a change', async () => {
    const p = await makeProfile();
    await bump(p.id, "display_name = 'Jane'");
    const before = await row(p.id);
    await upd(p.id, "display_name = 'Jane'"); // same value, same revision: a no-op
    const after = await row(p.id);
    expect(after.revision).toBe(before.revision);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    await expectRule(upd(p.id, "display_name = 'Jane', revision = revision + 1"), 'REVISION');
  });

  it('lets a change of ONLY the pending upload pointer keep the revision or raise it by one, never more or less', async () => {
    const p = await makeProfile();
    await bump(p.id, "display_name = 'Jane'");
    const a1 = await insertAsset(p.account);
    const rev = (await row(p.id)).revision;
    await upd(p.id, 'pending_photo_asset_id = $2', [a1]); // keeps the revision
    expect((await row(p.id)).revision).toBe(rev);
    await upd(p.id, 'pending_photo_asset_id = NULL, revision = revision + 1'); // clears and raises
    expect((await row(p.id)).revision).toBe(rev + 1);
    const a2 = await insertAsset(p.account);
    await expectRule(upd(p.id, 'pending_photo_asset_id = $2, revision = revision + 2', [a2]), 'REVISION');
    await expectRule(upd(p.id, 'pending_photo_asset_id = $2, revision = revision - 1', [a2]), 'REVISION');
    await upd(p.id, 'pending_photo_asset_id = $2, revision = revision + 1', [a2]);
    expect((await row(p.id)).revision).toBe(rev + 2);
  });

  it('maintains published_at: set at PRIVATE -> PUBLIC, kept while PUBLIC, cleared at PUBLIC -> PRIVATE, and never accepted from a caller; updated_at moves only with a change', async () => {
    const p = await makeProfile();
    const created = await row(p.id);
    await sleep(15);
    await bump(p.id, "visibility_status = 'PUBLIC', published_at = '2001-01-01'");
    const pub = await row(p.id);
    expect(pub.visibility_status).toBe('PUBLIC');
    expect(pub.published_at!.getFullYear()).toBeGreaterThan(2020); // the caller's value was ignored
    expect(pub.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
    await sleep(15);
    await bump(p.id, "display_name = 'Jane', published_at = '2002-02-02'");
    const kept = await row(p.id);
    expect(kept.published_at!.getTime()).toBe(pub.published_at!.getTime()); // a name change keeps the time of publication
    await bump(p.id, "visibility_status = 'PRIVATE', published_at = now()");
    const priv = await row(p.id);
    expect(priv).toMatchObject({ visibility_status: 'PRIVATE', published_at: null });
    await sleep(15);
    await bump(p.id, "visibility_status = 'PUBLIC'");
    const again = await row(p.id);
    expect(again.published_at!.getTime()).toBeGreaterThan(pub.published_at!.getTime()); // the latest PRIVATE -> PUBLIC change
    expect(priv.revision).toBe(4);
    expect(again.revision).toBe(5);
  });

  it('does not require anything for PUBLIC in the database (name, bio and photo prerequisites are configuration the service enforces) and has no suspended or hidden state', async () => {
    const p = await makeProfile();
    await bump(p.id, "visibility_status = 'PUBLIC'"); // an empty profile can be PUBLIC at the table level
    await expectConstraint(bump(p.id, "visibility_status = 'SUSPENDED'"), 'ck_public_profiles__visibility');
    await expectConstraint(bump(p.id, "visibility_status = 'HIDDEN'"), 'ck_public_profiles__visibility');
  });
});

describe('C. provider.public_profiles: the photo pointers', () => {
  it('accepts a READY PROFILE_PHOTO of the same account as the photo and an UPLOAD_PENDING one as the pending upload, and clears both', async () => {
    const p = await makeProfile();
    const ready = await readyAsset(p.account);
    const pending = await insertAsset(p.account);
    await bump(p.id, 'photo_asset_id = $2, pending_photo_asset_id = $3', [ready, pending]);
    expect(await row(p.id)).toMatchObject({ photo_asset_id: ready, pending_photo_asset_id: pending });
    await bump(p.id, 'photo_asset_id = NULL, pending_photo_asset_id = NULL');
    expect(await row(p.id)).toMatchObject({ photo_asset_id: null, pending_photo_asset_id: null });
  });

  it('refuses an asset of ANOTHER account (ASSET_OWNER) for both pointers', async () => {
    const p = await makeProfile();
    const other = await makeProvider();
    await expectRule(bump(p.id, 'photo_asset_id = $2', [await readyAsset(other)]), 'ASSET_OWNER');
    await expectRule(upd(p.id, 'pending_photo_asset_id = $2', [await insertAsset(other)]), 'ASSET_OWNER');
    expect(await row(p.id)).toMatchObject({ photo_asset_id: null, pending_photo_asset_id: null, revision: 1 });
  });

  it('refuses a GIG_PHOTO asset (ASSET_PURPOSE) for both pointers, even one of the same account', async () => {
    const p = await makeProfile();
    await expectRule(bump(p.id, 'photo_asset_id = $2', [await readyAsset(p.account, 'GIG_PHOTO')]), 'ASSET_PURPOSE');
    await expectRule(upd(p.id, 'pending_photo_asset_id = $2', [await insertAsset(p.account, 'GIG_PHOTO')]), 'ASSET_PURPOSE');
  });

  it('needs the photo READY and the pending upload UPLOAD_PENDING (ASSET_NOT_USABLE): not the other way round, not abandoned, not deleted', async () => {
    const p = await makeProfile();
    await expectRule(bump(p.id, 'photo_asset_id = $2', [await insertAsset(p.account)]), 'ASSET_NOT_USABLE'); // pending as the photo
    await expectRule(upd(p.id, 'pending_photo_asset_id = $2', [await readyAsset(p.account)]), 'ASSET_NOT_USABLE'); // READY as the pending upload
    const gone = await insertAsset(p.account);
    await abandon(gone);
    await expectRule(upd(p.id, 'pending_photo_asset_id = $2', [gone]), 'ASSET_NOT_USABLE');
    const del = await readyAsset(p.account);
    await markDeleted(del);
    await expectRule(bump(p.id, 'photo_asset_id = $2', [del]), 'ASSET_NOT_USABLE');
  });

  it('refuses a missing asset as a foreign key failure and the same asset in both pointers as the CHECK', async () => {
    const p = await makeProfile();
    await expectConstraint(bump(p.id, 'photo_asset_id = $2', [randomUUID()]), 'fk_public_profiles__photo_asset_id');
    await expectConstraint(upd(p.id, 'pending_photo_asset_id = $2', [randomUUID()]), 'fk_public_profiles__pending_photo_asset_id');
  });

  it('checks the asset when the pointer is set at INSERT as well', async () => {
    const a = await makeProvider();
    const asset = await insertAsset(a);
    await expectRule(run('INSERT INTO provider.public_profiles (account_id, photo_asset_id) VALUES ($1, $2)', [a, asset]), 'ASSET_NOT_USABLE');
    await run('INSERT INTO provider.public_profiles (account_id, pending_photo_asset_id) VALUES ($1, $2)', [a, asset]);
  });

  it('replaces the photo: the new READY asset becomes the photo and the old one, no longer referenced, can be deleted (an orphan the sweep removes)', async () => {
    const p = await makeProfile();
    const first = await readyAsset(p.account);
    await bump(p.id, 'photo_asset_id = $2', [first]);
    const second = await readyAsset(p.account);
    await expectRule(markDeleted(first), 'ASSET_REFERENCED'); // still the photo
    await bump(p.id, 'photo_asset_id = $2', [second]);
    await markDeleted(first);
    expect(await assetStatus(first)).toBe('DELETED');
    expect(await assetStatus(second)).toBe('READY');
  });

  it('finalizes an upload in one statement: the pending upload becomes READY and the pointers move (pending -> photo) with the revision raised once', async () => {
    const p = await makeProfile();
    const asset = await insertAsset(p.account);
    await upd(p.id, 'pending_photo_asset_id = $2, revision = revision + 1', [asset]);
    await makeReady(asset); // the asset is READY while the profile still points at it as pending
    await bump(p.id, 'photo_asset_id = $2, pending_photo_asset_id = NULL', [asset]);
    expect(await row(p.id)).toMatchObject({ photo_asset_id: asset, pending_photo_asset_id: null, revision: 3 });
  });
});

// ====================================================================== D. the asset: purpose and the reference-aware guard
describe('D. provider.media_assets: purpose and profile references', () => {
  it('accepts the two purposes and refuses any other with the CHECK', async () => {
    const a = await makeProvider();
    await insertAsset(a, 'GIG_PHOTO');
    await insertAsset(a, 'PROFILE_PHOTO');
    const id = randomUUID();
    await expectConstraint(
      run(
        "INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at, purpose) VALUES ($1, $2, $3, 'image/png', 1000, now() + interval '900 seconds', 'AVATAR')",
        [id, a, `provider/gig-media/${id}`],
      ),
      'ck_media_assets__purpose',
    );
  });

  it('keeps the purpose immutable in every status (IMMUTABLE_IDENTITY)', async () => {
    const a = await makeProvider();
    const pending = await insertAsset(a, 'PROFILE_PHOTO');
    await expectRule(run("UPDATE provider.media_assets SET purpose = 'GIG_PHOTO' WHERE media_asset_id = $1", [pending]), 'IMMUTABLE_IDENTITY');
    const ready = await readyAsset(a, 'GIG_PHOTO');
    await expectRule(run("UPDATE provider.media_assets SET purpose = 'PROFILE_PHOTO' WHERE media_asset_id = $1", [ready]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run("UPDATE provider.media_assets SET status = 'DELETED', purpose = 'PROFILE_PHOTO' WHERE media_asset_id = $1", [ready]),
      'IMMUTABLE_IDENTITY',
    );
    const dead = await insertAsset(a);
    await abandon(dead);
    await expectRule(run("UPDATE provider.media_assets SET purpose = 'GIG_PHOTO' WHERE media_asset_id = $1", [dead]), 'IMMUTABLE_IDENTITY');
  });

  it('refuses a PROFILE_PHOTO asset as a Gig photo (ASSET_PURPOSE) and accepts a GIG_PHOTO asset of the same account', async () => {
    const g = await makeGig();
    const profilePhoto = await readyAsset(g.account, 'PROFILE_PHOTO');
    const gigPhoto = await readyAsset(g.account, 'GIG_PHOTO');
    const attach = (asset: string) =>
      run('INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, 1)', [
        g.v1,
        asset,
        g.media,
      ]);
    await expectRule(attach(profilePhoto), 'ASSET_PURPOSE');
    await attach(gigPhoto);
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(1);
  });

  it('refuses the OWNER check before the purpose check for another account, and keeps the other attachment rules (an abandoned GIG_PHOTO is not usable)', async () => {
    const g = await makeGig();
    const foreign = await makeProvider();
    const attach = (asset: string) =>
      run('INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, 1)', [
        g.v1,
        asset,
        g.media,
      ]);
    await expectRule(attach(await readyAsset(foreign, 'PROFILE_PHOTO')), 'ASSET_OWNER');
    const dead = await insertAsset(g.account, 'GIG_PHOTO');
    await abandon(dead);
    await expectRule(attach(dead), 'ASSET_NOT_USABLE');
  });

  it('refuses to DELETE a READY asset while the profile photo points at it, and to ABANDON a pending one while the pending pointer does (ASSET_REFERENCED), until the pointer is cleared', async () => {
    const p = await makeProfile();
    const photo = await readyAsset(p.account);
    const pending = await insertAsset(p.account);
    await bump(p.id, 'photo_asset_id = $2, pending_photo_asset_id = $3', [photo, pending]);
    await expectRule(markDeleted(photo), 'ASSET_REFERENCED');
    await expectRule(abandon(pending), 'ASSET_REFERENCED');
    expect([await assetStatus(photo), await assetStatus(pending)]).toEqual(['READY', 'UPLOAD_PENDING']);
    await upd(p.id, 'pending_photo_asset_id = NULL, revision = revision + 1');
    await abandon(pending); // the service clears the pointer first, then abandons
    expect(await assetStatus(pending)).toBe('ABANDONED');
    await bump(p.id, 'photo_asset_id = NULL');
    await markDeleted(photo);
    expect(await assetStatus(photo)).toBe('DELETED');
  });

  it('still lets an asset that nothing references be abandoned and deleted, and keeps the removal markers one-way and settable on a terminal asset', async () => {
    const a = await makeProvider();
    const pending = await insertAsset(a);
    await abandon(pending);
    await run('UPDATE provider.media_assets SET objects_removed_at = now() WHERE media_asset_id = $1', [pending]);
    const ready = await readyAsset(a);
    await markDeleted(ready);
    await run('UPDATE provider.media_assets SET objects_removed_at = now(), upload_key_removed_at = now() WHERE media_asset_id = $1', [ready]);
    await expectRule(run('UPDATE provider.media_assets SET objects_removed_at = NULL WHERE media_asset_id = $1', [ready]), 'MARKER_ONE_WAY');
  });

  it('keeps a Gig attachment reference and a profile reference independent: an asset attached to a Gig version is not a profile photo and a profile photo is not a Gig attachment', async () => {
    const g = await makeGig();
    const profile = await makeProfile(g.account);
    const gigPhoto = await readyAsset(g.account, 'GIG_PHOTO');
    await run('INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, 1)', [
      g.v1,
      gigPhoto,
      g.media,
    ]);
    await expectRule(bump(profile.id, 'photo_asset_id = $2', [gigPhoto]), 'ASSET_PURPOSE');
    await expectRule(markDeleted(gigPhoto), 'ASSET_REFERENCED'); // the 0022 attachment rule is intact
    const profilePhoto = await readyAsset(g.account, 'PROFILE_PHOTO');
    await bump(profile.id, 'photo_asset_id = $2', [profilePhoto]);
    await expectRule(markDeleted(profilePhoto), 'ASSET_REFERENCED');
  });
});

// ====================================================================== E. provider.profile_audit_events
describe('E. provider.profile_audit_events', () => {
  const audit = (
    p: Profile,
    action: string,
    changes: unknown = { fields: ['bio'], revision: 2 },
    actor = `account:${p.account}`,
    account = p.account,
    from: Db = pool,
  ) =>
    from.query(
      'INSERT INTO provider.profile_audit_events (actor, account_id, public_profile_id, action, changes, correlation_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [actor, account, p.id, action, changes === null ? null : JSON.stringify(changes), 'test-correlation'],
    );

  it('accepts every one of the four actions with a small identifiers-only JSON object (or none) and refuses anything else with the CHECK', async () => {
    const p = await makeProfile();
    for (const a of PROFILE_AUDIT_ACTIONS) await audit(p, a);
    await audit(p, 'PROVIDER_PUBLIC_PROFILE_CREATED', null);
    expect(await count('provider.profile_audit_events', 'public_profile_id = $1', [p.id])).toBe(5);
    for (const bad of ['PROVIDER_PROFILE_DELETED', 'PROVIDER_PUBLIC_PROFILE_VIEWED', 'GIG_CREATED', 'provider_public_profile_created', ''])
      await expectConstraint(audit(p, bad), 'ck_profile_audit_events__action');
  });

  it('bounds the changes: an object only (never an array or a scalar) of at most 2000 characters, and a non-blank actor of at most 200', async () => {
    const p = await makeProfile();
    for (const bad of [[1, 2], 'text', 7, true])
      await expectConstraint(audit(p, 'PROVIDER_PUBLIC_PROFILE_UPDATED', bad), 'ck_profile_audit_events__changes_object');
    await expectConstraint(audit(p, 'PROVIDER_PUBLIC_PROFILE_UPDATED', { note: 'x'.repeat(2000) }), 'ck_profile_audit_events__changes_object');
    await audit(p, 'PROVIDER_PUBLIC_PROFILE_UPDATED', { note: 'x'.repeat(1900) });
    for (const bad of ['', '   ', 'a'.repeat(201)])
      await expectConstraint(audit(p, 'PROVIDER_PUBLIC_PROFILE_UPDATED', {}, bad), 'ck_profile_audit_events__actor');
  });

  it('refuses a row whose account does not own the profile (AUDIT_MISMATCH), and a missing profile as a foreign key failure', async () => {
    const p = await makeProfile();
    const other = await makeProvider();
    await expectRule(audit(p, 'PROVIDER_PUBLIC_PROFILE_UPDATED', {}, 'system:test', other), 'AUDIT_MISMATCH');
    await expectConstraint(audit({ id: randomUUID(), account: p.account }, 'PROVIDER_PUBLIC_PROFILE_UPDATED'), 'fk_profile_audit_events__public_profile_id');
  });

  it('stays immutable: UPDATE, DELETE and TRUNCATE of the trail are refused (ROW_IMMUTABLE) and keep the rows', async () => {
    const p = await makeProfile();
    await audit(p, 'PROVIDER_PROFILE_VISIBILITY_CHANGED');
    await expectRule(run("UPDATE provider.profile_audit_events SET actor = 'x' WHERE public_profile_id = $1", [p.id]), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM provider.profile_audit_events WHERE public_profile_id = $1', [p.id]), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE provider.profile_audit_events'), 'ROW_IMMUTABLE');
    expect(await count('provider.profile_audit_events', 'public_profile_id = $1', [p.id])).toBe(1);
  });
});

// ====================================================================== F. concurrency (lock order account, profile, asset)
describe('F. concurrency', () => {
  it('serializes a pending-pointer change with the abandon of the asset: the abandon waits and finds the reference (ASSET_REFERENCED)', async () => {
    const p = await makeProfile();
    const asset = await insertAsset(p.account);
    const failure = await holdThenRace((c) => upd(p.id, 'pending_photo_asset_id = $2', [asset], c), {
      text: "UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1",
      params: [asset],
    });
    notDeadlock(failure);
    expect({ code: failure?.code, detail: failure?.detail }).toEqual({ code: '23000', detail: 'provider_rule:ASSET_REFERENCED' });
    expect(await assetStatus(asset)).toBe('UPLOAD_PENDING');
    expect((await row(p.id)).pending_photo_asset_id).toBe(asset);
  });

  it('serializes the abandon of the asset with a pending-pointer change: the pointer change waits and finds the asset no longer usable (ASSET_NOT_USABLE)', async () => {
    const p = await makeProfile();
    const asset = await insertAsset(p.account);
    const failure = await holdThenRace((c) => abandon(asset, c), {
      text: 'UPDATE provider.public_profiles SET pending_photo_asset_id = $2 WHERE public_profile_id = $1',
      params: [p.id, asset],
    });
    notDeadlock(failure);
    expect({ code: failure?.code, detail: failure?.detail }).toEqual({ code: '23000', detail: 'provider_rule:ASSET_NOT_USABLE' });
    expect(await assetStatus(asset)).toBe('ABANDONED');
    expect((await row(p.id)).pending_photo_asset_id).toBeNull();
  });

  it('serializes a photo-pointer change with the deletion of the asset (the sweep waits and finds the reference) and the reverse (the pointer finds the asset deleted)', async () => {
    const p = await makeProfile();
    const asset = await readyAsset(p.account);
    const failure = await holdThenRace((c) => bump(p.id, 'photo_asset_id = $2', [asset], c), {
      text: "UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1",
      params: [asset],
    });
    notDeadlock(failure);
    expect(failure?.detail).toBe('provider_rule:ASSET_REFERENCED');
    expect(await assetStatus(asset)).toBe('READY');
    const q2 = await makeProfile();
    const asset2 = await readyAsset(q2.account);
    const failure2 = await holdThenRace((c) => markDeleted(asset2, c), {
      text: 'UPDATE provider.public_profiles SET photo_asset_id = $2, revision = revision + 1 WHERE public_profile_id = $1',
      params: [q2.id, asset2],
    });
    notDeadlock(failure2);
    expect(failure2?.detail).toBe('provider_rule:ASSET_NOT_USABLE');
    expect((await row(q2.id)).photo_asset_id).toBeNull();
  });

  it('never deadlocks and never ends with a referenced asset abandoned, across 40 interleavings of a pointer change and an abandon under the account, profile, asset order', async () => {
    const results: string[] = [];
    for (let i = 0; i < 40; i++) {
      const p = await makeProfile();
      const asset = await insertAsset(p.account);
      const [a, b] = await Promise.all([
        rejection(
          runRacer(racePool, async (c) => {
            await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [p.account]);
            await c.query('UPDATE provider.public_profiles SET pending_photo_asset_id = $2 WHERE public_profile_id = $1', [p.id, asset]);
          }),
        ),
        rejection(runRacer(racePool, { text: "UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", params: [asset] })),
      ]);
      notDeadlock(a as PgFailure | undefined);
      notDeadlock(b as PgFailure | undefined);
      const r = await row(p.id);
      const status = await assetStatus(asset);
      // exactly one winner: the pointer is set and the asset is pending, or the asset is abandoned and the pointer is not set
      expect(
        r.pending_photo_asset_id === asset && status === 'UPLOAD_PENDING'
          ? 'POINTER'
          : r.pending_photo_asset_id === null && status === 'ABANDONED'
            ? 'ABANDONED'
            : 'BROKEN',
      ).not.toBe('BROKEN');
      results.push(r.pending_photo_asset_id === asset ? 'POINTER' : 'ABANDONED');
    }
    expect(results.length).toBe(40);
  });

  /**
   * Two sessions both read revision 1. The first writes revision 2 and stays open; the second then writes WITHOUT a revision predicate (as a careless caller would), from the value it
   * read. It blocks on the row lock, and when the first commits the guard sees OLD.revision = 2: the second statement is a stale write and must be refused (REVISION).
   */
  async function staleWriter(main: pg.Pool, racing: pg.Pool, id: string, secondRevision: number): Promise<PgFailure | undefined> {
    return holdThenRace(
      (c) => c.query("UPDATE provider.public_profiles SET bio = 'first writer', revision = 2 WHERE public_profile_id = $1", [id]),
      { text: "UPDATE provider.public_profiles SET bio = 'second writer', revision = $2 WHERE public_profile_id = $1", params: [id, secondRevision] },
      main,
      racing,
    );
  }

  it('refuses the stale second writer of one profile (no revision predicate): it waits for the row lock and the guard then finds OLD.revision = 2 (REVISION), for both a repeated +1 and a missing +1', async () => {
    for (const secondRevision of [2, 1]) {
      const p = await makeProfile();
      const failure = await staleWriter(pool, racePool, p.id, secondRevision);
      notDeadlock(failure);
      expect({ code: failure?.code, detail: failure?.detail }, `second writes revision ${secondRevision}`).toEqual({
        code: '23000',
        detail: 'provider_rule:REVISION',
      });
      const r = await row(p.id);
      expect({ bio: r.bio, revision: r.revision }).toEqual({ bio: 'first writer', revision: 2 });
    }
  });

  it('accepts the second writer once it has re-read the committed revision (revision 3), so the refusal above is the guard and not a blanket failure', async () => {
    const p = await makeProfile();
    await bump(p.id, "bio = 'first writer'");
    await run("UPDATE provider.public_profiles SET bio = 'second writer', revision = 3 WHERE public_profile_id = $1", [p.id]);
    expect(await row(p.id)).toMatchObject({ bio: 'second writer', revision: 3 });
  });

  it('would LOSE an update without the guard: in a private database whose profile guard is replaced by a no-op the very same race ends with no refusal and the first writer silently overwritten', async () => {
    const priv = await createIsolatedDatabase();
    const main = createTestPool(priv.url, 4);
    const racing = createTestPool(priv.url, 4);
    try {
      const id = randomUUID();
      const setup = await main.connect();
      try {
        await setup.query('BEGIN');
        await setup.query('SET LOCAL session_replication_role = replica'); // no account, registration or guard is needed to create the row
        await setup.query('INSERT INTO provider.public_profiles (public_profile_id, account_id) VALUES ($1, gen_random_uuid())', [id]);
        await setup.query('COMMIT');
      } finally {
        setup.release();
      }
      await main.query(
        "CREATE OR REPLACE FUNCTION provider.guard_public_profiles() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END; $$",
      );
      const failure = await staleWriter(main, racing, id, 2);
      expect(failure, 'with a no-op guard the stale write is accepted').toBeUndefined();
      const r = (await main.query('SELECT bio, revision FROM provider.public_profiles WHERE public_profile_id = $1', [id])).rows[0] as {
        bio: string;
        revision: number;
      };
      expect(r).toEqual({ bio: 'second writer', revision: 2 }); // the first writer's change is gone and the revision did not move: the lost update the guard prevents
    } finally {
      await main.end();
      await racing.end();
      await priv.drop();
    }
  }, 120_000);
});

// ====================================================================== G. query plans
describe('G. an index can serve each documented predicate (enable_seqscan = off on a near-empty table: usability, not the planner choice at volume)', () => {
  const plan = async (sql: string): Promise<string> => {
    const c = await pool.connect();
    try {
      await c.query('SET enable_seqscan = off');
      return (await c.query(`EXPLAIN ${sql}`)).rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
    } finally {
      c.release();
    }
  };
  const id = '00000000-0000-0000-0000-000000000001';

  it('can serve the lookup by the public id with the primary key and by the owner with the unique account index', async () => {
    expect(await plan(`SELECT * FROM provider.public_profiles WHERE public_profile_id = '${id}'`)).toMatch(/pk_public_profiles/);
    expect(await plan(`SELECT * FROM provider.public_profiles WHERE account_id = '${id}'`)).toMatch(/uq_public_profiles__account/);
  });

  it('can serve the reference lookups of the asset guard and the sweeps with the two partial pointer indexes', async () => {
    expect(await plan(`SELECT 1 FROM provider.public_profiles WHERE photo_asset_id = '${id}'`)).toMatch(/idx_public_profiles__photo_asset/);
    expect(await plan(`SELECT 1 FROM provider.public_profiles WHERE pending_photo_asset_id = '${id}'`)).toMatch(/idx_public_profiles__pending_photo_asset/);
  });

  it('can serve the history of one profile in time order with the audit index', async () => {
    expect(await plan(`SELECT * FROM provider.profile_audit_events WHERE public_profile_id = '${id}' ORDER BY occurred_at`)).toMatch(
      /idx_profile_audit_events__profile/,
    );
  });
});
