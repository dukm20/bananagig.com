import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GIG_ERROR_CODES,
  GIG_ISSUE_REASONS,
  PROVIDER_GIG_MEDIA_POLICY_KEYS,
  PROVIDER_GIG_OPTIONS_POLICY_KEYS,
  ProviderGigMediaPolicy,
  ProviderGigOptionsPolicy,
  gigErrorKey,
  gigIssueKey,
} from '../../contracts/src/gig';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0021 (CAT-004, variants, add-ons and media) adds four tables to the `provider` schema: provider.gig_version_variants and provider.gig_version_add_ons (delta-priced
// alternatives and extras owned by a Gig VERSION), provider.media_assets (the account-owned BYTES of a photo with its own lifecycle) and provider.gig_version_media (the ATTACHMENT of an
// asset to a version and to a MEDIA field of the exact bound template version), three guard functions (SQLSTATE 23000, DETAIL provider_rule:<KEY>), one publication backstop, one extra column
// on catalog.gig_template_versions (pricing_add_ons, protected by the frozen-structure guard), the audit action list widened by eight actions, plus two seeds through the real workflows:
// fifteen policy parameters (configuration) and 72 managed copy entries (content). Nothing is seeded into the new tables.
// These tests drive the REAL tables with raw SQL on an isolated database: shape, seeds against the contract, every CHECK, every guard rule on the exact failing statement, the frozen
// children of a published version, the copy into the next draft, the publication backstop, the template permission column and its guard, and the interleavings that matter under real
// concurrency (lock waiters polled in pg_stat_activity, the catalogue's lock order against a catalogue transaction). The catalogue rows are created with session_replication_role = replica
// (the catalogue guards are covered by the CAT-001/002 model tests, except the one rule added here); every provider row is created with the guards ON.
let iso: IsolatedDatabase;
let pool: pg.Pool;
let racePool: pg.Pool;
let seq = 0;
let laOc: string;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  laOc = ((await pool.query("SELECT market_id FROM geography.markets WHERE code = 'la-oc'")).rows[0] as { market_id: string }).market_id;
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
/** A transaction with the user triggers and foreign-key triggers of every table off (the catalogue and geography fixtures; CHECK constraints still apply). */
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
async function holdThenRace(hold: (c: pg.PoolClient) => Promise<unknown>, race: Racer): Promise<PgFailure | undefined> {
  const tx = await openTx();
  let racer: Promise<unknown> = Promise.resolve();
  try {
    await hold(tx);
    racer = rejection(runRacer(racePool, race));
    await lockWaiters(1);
  } finally {
    await finish(tx, 'COMMIT');
  }
  return (await racer) as PgFailure | undefined;
}
const notDeadlock = (e: PgFailure | undefined) => expect(String(e?.code ?? ''), 'a deadlock or a serialization failure is a defect').not.toMatch(/^40/);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
async function makeProvider(stIds: string[]): Promise<string> {
  const account = await makeAccount();
  await inTx(async (c) => {
    const id = (
      (await c.query('INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1) RETURNING provider_registration_id', [account]))
        .rows[0] as { provider_registration_id: string }
    ).provider_registration_id;
    await c.query('UPDATE provider.registrations SET market_id = $2, revision = revision + 1 WHERE provider_registration_id = $1', [id, laOc]);
    for (const st of stIds)
      await c.query('INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id) VALUES ($1, $2)', [id, st]);
    await c.query("UPDATE provider.registrations SET status = 'COMPLETED' WHERE provider_registration_id = $1", [id]);
  });
  return account;
}

// ---------------------------------------------------------------- fixtures: the catalogue (guards OFF through replication role replica; CHECK constraints still apply)
interface MediaSpec {
  behavior?: 'PROVIDER_CONFIGURABLE' | 'PROVIDER_REQUIRED';
  min?: number | null;
  max?: number | null;
}
interface TplOpts {
  withVariants?: boolean;
  addOns?: boolean;
  /** one MEDIA field per entry */
  media?: MediaSpec[];
}
interface Tpl {
  tplId: string;
  tvId: string;
  stId: string;
  code: string;
  /** the MEDIA field ids in the order of `media` */
  media: string[];
  text: string;
}
let categoryId: string | undefined;
let fieldSeq = 0;
async function makeTpl(o: TplOpts = {}): Promise<Tpl> {
  categoryId ??= await replica(
    async (c) =>
      (
        (await c.query("INSERT INTO catalog.categories (code, status) VALUES ($1, 'ACTIVE') RETURNING category_id", [`om_${++seq}`])).rows[0] as {
          category_id: string;
        }
      ).category_id,
  );
  const code = `omt_${++seq}`;
  return replica(async (c) => {
    const st = (
      await c.query("INSERT INTO catalog.service_types (category_id, code, status) VALUES ($1, $2, 'ACTIVE') RETURNING service_type_id", [
        categoryId,
        `omst_${seq}`,
      ])
    ).rows[0] as { service_type_id: string };
    const tpl = (
      await c.query("INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, 'ACTIVE') RETURNING gig_template_id", [
        st.service_type_id,
        code,
      ])
    ).rows[0] as { gig_template_id: string };
    const tv = await addVersion(c, tpl.gig_template_id, 1, 'ACTIVE', o);
    const text = await addField(c, tv, code, { type: 'TEXT', order: 1 });
    const media: string[] = [];
    let order = 2;
    for (const m of o.media ?? []) media.push(await addField(c, tv, code, { type: 'MEDIA', order: order++, ...m }));
    return { tplId: tpl.gig_template_id, tvId: tv, stId: st.service_type_id, code, media, text };
  });
}
async function addVersion(c: Db, tplId: string, n: number, status: string, o: TplOpts = {}): Promise<string> {
  const r = await c.query(
    `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, pricing_fixed, pricing_fixed_with_variants, pricing_add_ons, published_at, closed_at)
     VALUES ($1, $2, $3, true, $4, $5, CASE WHEN $3 = 'DRAFT' THEN NULL ELSE now() END, CASE WHEN $3 IN ('SUPERSEDED', 'RETIRED') THEN now() END) RETURNING gig_template_version_id`,
    [tplId, n, status, o.withVariants ?? false, o.addOns ?? false],
  );
  return (r.rows[0] as { gig_template_version_id: string }).gig_template_version_id;
}
async function addField(c: Db, tvId: string, code: string, spec: { type: string; order: number } & MediaSpec): Promise<string> {
  const key = `om${++fieldSeq}`;
  const isMedia = spec.type === 'MEDIA';
  const r = await c.query(
    `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key, min_items, max_items)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING gig_template_field_id`,
    [
      tvId,
      key,
      spec.type,
      spec.behavior ?? 'PROVIDER_CONFIGURABLE',
      spec.order,
      `catalog.gig_template.${code}.field.${key}.label`,
      isMedia ? (spec.min ?? null) : null,
      isMedia ? (spec.max ?? null) : null,
    ],
  );
  return (r.rows[0] as { gig_template_field_id: string }).gig_template_field_id;
}

// ---------------------------------------------------------------- fixtures: Gigs, versions, children (guards ON)
interface G {
  account: string;
  t: Tpl;
  gigId: string;
  v1: string;
}
async function makeGig(o: TplOpts = {}): Promise<G> {
  const t = await makeTpl(o);
  const account = await makeProvider([t.stId]);
  return gigFor(account, t);
}
async function gigFor(account: string, t: Tpl): Promise<G> {
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
    return { account, t, gigId, v1 };
  });
}
const fillDraft = (id: string, from: Db = pool) =>
  from.query(
    "UPDATE provider.gig_versions SET title = 'Full detail', short_pitch = 'A careful clean', description = 'We clean the car inside and out.', revision = revision + 1 WHERE gig_version_id = $1",
    [id],
  );
async function publishFirst(g: G, from: Db = pool): Promise<void> {
  await from.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [g.v1]);
  await from.query("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [g.gigId]);
}
const versionStatus = async (id: string): Promise<string> =>
  (await q<{ status: string }>('SELECT status FROM provider.gig_versions WHERE gig_version_id = $1', [id]))[0]!.status;

let keySeq = 0;
const key = (): string => `opt_${(++keySeq).toString(16).padStart(12, '0')}`;
type Table = 'gig_version_variants' | 'gig_version_add_ons';
const addItem = (
  table: Table,
  versionId: string,
  o: { key?: string; name?: string; description?: string | null; price?: number | string; minutes?: number; order?: number } = {},
  from: Db = pool,
) =>
  from.query(
    `INSERT INTO provider.${table} (gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${table === 'gig_version_variants' ? 'variant_id' : 'add_on_id'} AS id`,
    [versionId, o.key ?? key(), o.name ?? 'Large', o.description === undefined ? null : o.description, o.price ?? 500, o.minutes ?? 15, o.order ?? 1],
  );
async function insertAsset(account: string, o: { ttlSeconds?: number; mime?: string; size?: number; id?: string } = {}, from: Db = pool): Promise<string> {
  const id = o.id ?? randomUUID();
  const r = await from.query(
    `INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING media_asset_id`,
    [id, account, `provider/gig-media/${id}`, o.mime ?? 'image/png', o.size ?? 120_000, o.ttlSeconds ?? 900],
  );
  return (r.rows[0] as { media_asset_id: string }).media_asset_id;
}
const makeReady = (id: string, from: Db = pool) =>
  from.query(
    "UPDATE provider.media_assets SET status = 'READY', sha256 = repeat('a', 64), width = 800, height = 600, scan_status = 'CLEAN', ready_at = now() WHERE media_asset_id = $1",
    [id],
  );
async function readyAsset(account: string): Promise<string> {
  const id = await insertAsset(account);
  await makeReady(id);
  return id;
}
const attach = (versionId: string, assetId: string, fieldId: string, o: { order?: number; alt?: string | null } = {}, from: Db = pool) =>
  from.query(
    `INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order, alt_text)
     VALUES ($1, $2, $3, $4, $5) RETURNING gig_version_media_id`,
    [versionId, assetId, fieldId, o.order ?? 1, o.alt === undefined ? null : o.alt],
  );
const attachId = async (
  versionId: string,
  assetId: string,
  fieldId: string,
  o: { order?: number; alt?: string | null } = {},
  from: Db = pool,
): Promise<string> => ((await attach(versionId, assetId, fieldId, o, from)).rows[0] as { gig_version_media_id: string }).gig_version_media_id;

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
const optionColumns = (id: string): ColumnShape[] => [
  [id, 'uuid', false, true],
  ['gig_version_id', 'uuid', false, false],
  ['item_key', 'text', false, false],
  ['name', 'text', false, false],
  ['description', 'text', true, false],
  ['price_delta_minor', 'bigint', false, false],
  ['duration_delta_minutes', 'integer', false, false],
  ['display_order', 'integer', false, false],
  ['created_at', TS, false, true],
];
const COLUMNS: Record<string, ColumnShape[]> = {
  gig_version_variants: optionColumns('variant_id'),
  gig_version_add_ons: optionColumns('add_on_id'),
  media_assets: [
    ['media_asset_id', 'uuid', false, true],
    ['account_id', 'uuid', false, false],
    ['status', 'text', false, true],
    ['object_key', 'text', false, false],
    ['mime_type', 'text', false, false],
    ['size_bytes', 'bigint', false, false],
    ['sha256', 'character', true, false],
    ['width', 'integer', true, false],
    ['height', 'integer', true, false],
    ['scan_status', 'text', false, true],
    ['upload_expires_at', TS, false, false],
    ['created_at', TS, false, true],
    ['ready_at', TS, true, false],
    ['updated_at', TS, false, true],
    ['objects_removed_at', TS, true, false], // 0022
    ['upload_key_removed_at', TS, true, false], // 0022
    ['purpose', 'text', false, true], // 0024
  ],
  gig_version_media: [
    ['gig_version_media_id', 'uuid', false, true],
    ['gig_version_id', 'uuid', false, false],
    ['media_asset_id', 'uuid', false, false],
    ['gig_template_field_id', 'uuid', false, false],
    ['display_order', 'integer', false, false],
    ['alt_text', 'text', true, false],
    ['created_at', TS, false, true],
    ['updated_at', TS, false, true],
  ],
};
const optionConstraints = (t: string): string[] => [
  `ck_${t}__description`,
  `ck_${t}__display_order`,
  `ck_${t}__duration_delta`,
  `ck_${t}__key`,
  `ck_${t}__name`,
  `ck_${t}__price_delta`,
  `fk_${t}__version_id`,
  `pk_${t}`,
  `uq_${t}__key`,
  `uq_${t}__order`,
];
const CONSTRAINTS: Record<string, string[]> = {
  gig_version_variants: optionConstraints('gig_version_variants'),
  gig_version_add_ons: optionConstraints('gig_version_add_ons'),
  media_assets: [
    'ck_media_assets__dimensions',
    'ck_media_assets__expiry',
    'ck_media_assets__infected',
    'ck_media_assets__lifecycle',
    'ck_media_assets__mime_type',
    'ck_media_assets__object_key',
    'ck_media_assets__object_key_derived', // 0022
    'ck_media_assets__objects_removed', // 0022
    'ck_media_assets__purpose', // 0024
    'ck_media_assets__scan_status',
    'ck_media_assets__sha256',
    'ck_media_assets__size',
    'ck_media_assets__status',
    'ck_media_assets__upload_key_removed', // 0022
    'fk_media_assets__account_id',
    'pk_media_assets',
    'uq_media_assets__object_key',
  ],
  gig_version_media: [
    'ck_gig_version_media__alt_text',
    'ck_gig_version_media__display_order',
    'fk_gig_version_media__asset_id',
    'fk_gig_version_media__field_id',
    'fk_gig_version_media__version_id',
    'pk_gig_version_media',
    'uq_gig_version_media__asset',
    'uq_gig_version_media__order',
  ],
};
const FK_TARGETS: Record<string, string> = {
  fk_gig_version_variants__version_id: 'provider.gig_versions',
  fk_gig_version_add_ons__version_id: 'provider.gig_versions',
  fk_media_assets__account_id: 'identity.accounts',
  fk_gig_version_media__version_id: 'provider.gig_versions',
  fk_gig_version_media__asset_id: 'provider.media_assets',
  fk_gig_version_media__field_id: 'catalog.gig_template_fields',
};
const INDEXES: Record<string, string[]> = {
  gig_version_variants: ['pk_gig_version_variants', 'uq_gig_version_variants__key', 'uq_gig_version_variants__order'],
  gig_version_add_ons: ['pk_gig_version_add_ons', 'uq_gig_version_add_ons__key', 'uq_gig_version_add_ons__order'],
  media_assets: [
    'idx_media_assets__account',
    'idx_media_assets__objects_to_remove',
    'idx_media_assets__pending_expiry',
    'idx_media_assets__upload_key_sweep',
    'pk_media_assets',
    'uq_media_assets__object_key',
  ],
  gig_version_media: [
    'idx_gig_version_media__asset',
    'idx_gig_version_media__field',
    'pk_gig_version_media',
    'uq_gig_version_media__asset',
    'uq_gig_version_media__order',
  ],
};
const TRIGGERS: Record<string, string[]> = {
  gig_version_variants: ['trg_gig_version_variants__guard', 'trg_gig_version_variants__no_truncate'],
  gig_version_add_ons: ['trg_gig_version_add_ons__guard', 'trg_gig_version_add_ons__no_truncate'],
  media_assets: ['trg_media_assets__guard', 'trg_media_assets__no_truncate'],
  gig_version_media: ['trg_gig_version_media__guard', 'trg_gig_version_media__no_truncate'],
};
const NEW_TABLES = Object.keys(COLUMNS);
const NEW_ACTIONS = [
  'GIG_VARIANTS_UPDATED',
  'GIG_ADD_ONS_UPDATED',
  'GIG_MEDIA_UPLOAD_AUTHORIZED',
  'GIG_MEDIA_UPLOAD_REFUSED',
  'GIG_MEDIA_ATTACHED',
  'GIG_MEDIA_DETACHED',
  'GIG_MEDIA_REORDERED',
  'GIG_MEDIA_UPDATED',
];
const OLD_ACTIONS = ['GIG_CREATED', 'GIG_DRAFT_CREATED', 'GIG_DRAFT_UPDATED', 'GIG_VERSION_PUBLISHED', 'GIG_VERSION_SUPERSEDED', 'GIG_RETIRED'];

describe('A. shape of the schema', () => {
  it.each(Object.entries(COLUMNS))('has exactly the documented columns, types, nullability and defaults on %s', async (table, expected) => {
    expect(await columnsOf(table)).toEqual(expected);
  });

  it.each(Object.entries(CONSTRAINTS))(
    'has exactly the documented constraints on %s (by name), all validated; only the attachment order is deferrable',
    async (table, names) => {
      const rows = await q<{ conname: string; convalidated: boolean; condeferrable: boolean; condeferred: boolean }>(
        "SELECT conname, convalidated, condeferrable, condeferred FROM pg_constraint WHERE conrelid = $1::regclass AND contype <> 't'",
        [`provider.${table}`],
      );
      expect(rows.map((r) => r.conname).sort(byName)).toEqual([...names].sort(byName));
      expect(rows.every((r) => r.convalidated)).toBe(true);
      expect(rows.filter((r) => r.condeferrable).map((r) => r.conname)).toEqual(table === 'gig_version_media' ? ['uq_gig_version_media__order'] : []);
      expect(rows.some((r) => r.condeferred)).toBe(false); // INITIALLY IMMEDIATE
    },
  );

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

  it('defines the three partial sweep indexes of the assets and every other index of the new tables exactly', async () => {
    const defs = Object.fromEntries(
      (
        await q<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'provider' AND tablename = ANY ($1) AND indexname !~ '^(pk|uq)_'",
          [NEW_TABLES],
        )
      ).map((r) => [r.indexname, r.indexdef]),
    );
    expect(defs).toEqual({
      idx_media_assets__account: 'CREATE INDEX idx_media_assets__account ON provider.media_assets USING btree (account_id)',
      idx_media_assets__objects_to_remove:
        "CREATE INDEX idx_media_assets__objects_to_remove ON provider.media_assets USING btree (updated_at) WHERE ((status = ANY (ARRAY['ABANDONED'::text, 'DELETED'::text])) AND (objects_removed_at IS NULL))",
      idx_media_assets__upload_key_sweep:
        "CREATE INDEX idx_media_assets__upload_key_sweep ON provider.media_assets USING btree (upload_expires_at) WHERE ((status = 'READY'::text) AND (upload_key_removed_at IS NULL))",
      idx_media_assets__pending_expiry:
        "CREATE INDEX idx_media_assets__pending_expiry ON provider.media_assets USING btree (upload_expires_at) WHERE (status = 'UPLOAD_PENDING'::text)",
      idx_gig_version_media__asset: 'CREATE INDEX idx_gig_version_media__asset ON provider.gig_version_media USING btree (media_asset_id)',
      idx_gig_version_media__field: 'CREATE INDEX idx_gig_version_media__field ON provider.gig_version_media USING btree (gig_template_field_id)',
    });
  });

  it('supports every foreign key of the new tables with an index whose leading column is the referencing column', async () => {
    const rows = await q<{ conname: string }>(
      `SELECT conname FROM pg_constraint c WHERE contype = 'f' AND conrelid = ANY ($1::text[]::regclass[])
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`,
      [NEW_TABLES.map((t) => `provider.${t}`)],
    );
    expect(rows).toEqual([]);
  });

  it.each(Object.entries(TRIGGERS))('wires the triggers of %s exactly (by name), all enabled, and no constraint trigger', async (table, names) => {
    const rows = await q<{ tgname: string; tgenabled: string; tgconstraint: string }>(
      'SELECT tgname, tgenabled, tgconstraint::text FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal',
      [`provider.${table}`],
    );
    expect(rows.map((r) => r.tgname).sort(byName)).toEqual([...names].sort(byName));
    expect(rows.every((r) => r.tgenabled === 'O' && r.tgconstraint === '0')).toBe(true);
  });

  it('keeps the new functions in the provider schema, as trigger or void functions, commented, VOLATILE, not SECURITY DEFINER, without a search_path', async () => {
    const fns = await q<{ proname: string; result: string; volatility: string; secdef: boolean; config: string[] | null; comment: string | null; src: string }>(
      `SELECT p.proname, pg_get_function_result(p.oid) AS result, p.provolatile AS volatility, p.prosecdef AS secdef, p.proconfig AS config, obj_description(p.oid, 'pg_proc') AS comment, p.prosrc AS src
         FROM pg_proc p WHERE pronamespace = 'provider'::regnamespace AND proname IN ('guard_gig_version_options', 'guard_media_assets', 'guard_gig_version_media', 'check_gig_version_children')`,
    );
    expect(fns.map((f) => [f.proname, f.result]).sort()).toEqual([
      ['check_gig_version_children', 'void'],
      ['guard_gig_version_media', 'trigger'],
      ['guard_gig_version_options', 'trigger'],
      ['guard_media_assets', 'trigger'],
    ]);
    for (const f of fns) {
      expect({ v: f.volatility, s: f.secdef, c: f.config }).toEqual({ v: 'v', s: false, c: null });
      expect((f.comment ?? '').length, f.proname).toBeGreaterThan(200);
      // LRN-0055: PL/pgSQL ends an IF condition at the first THEN, so a CASE never sits inside an IF condition
      expect(f.src, f.proname).not.toMatch(/\bIF\b[^;]*\bCASE\b/);
      // every failure is a guard failure: SQLSTATE 23000 and a provider_rule DETAIL
      const raises = f.src.match(/RAISE EXCEPTION/g) ?? [];
      expect(f.src.match(/ERRCODE = 'integrity_constraint_violation'/g)?.length, f.proname).toBe(raises.length);
      expect(f.src.match(/DETAIL = 'provider_rule:[A-Z_]+'/g)?.length, f.proname).toBe(raises.length);
    }
  });

  it('documents the rule keys of every new guard exactly (the keys are the contract with the service)', async () => {
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
    expect(await keysOf('guard_gig_version_options')).toEqual(['ADD_ONS_NOT_PERMITTED', 'NO_UPDATE', 'VARIANTS_NOT_PERMITTED', 'VERSION_FROZEN']);
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
    expect(await keysOf('guard_gig_version_media')).toEqual([
      'ASSET_NOT_USABLE',
      'ASSET_OWNER',
      'ASSET_PURPOSE', // 0024
      'FIELD_NOT_IN_TEMPLATE_VERSION',
      'FIELD_TYPE_MISMATCH',
      'IMMUTABLE_IDENTITY',
      'MEDIA_FIELD_FULL',
      'MEDIA_PROHIBITED',
      'VERSION_FROZEN',
    ]);
    expect(await keysOf('check_gig_version_children')).toEqual([
      'ADD_ONS_NOT_PERMITTED',
      'MEDIA_FIELD_FULL',
      'MEDIA_NOT_READY',
      'MEDIA_REQUIRED',
      'VARIANTS_NOT_PERMITTED',
    ]);
  });

  it('wires the version guard to the publication backstop and keeps the final lock order of 0020 (gig FOR SHARE first, catalogue template, service type, template version after, children last)', async () => {
    const src = (
      await q<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE pronamespace = 'provider'::regnamespace AND proname = 'guard_gig_versions'")
    )[0]!.src;
    expect(src).toContain('provider.check_gig_version_children(NEW.gig_version_id, NEW.gig_template_version_id)');
    const at = (s: string): number => src.indexOf(s);
    expect(at('FROM provider.gigs WHERE gig_id = NEW.gig_id FOR SHARE')).toBeGreaterThan(-1);
    expect(at('FROM catalog.gig_templates WHERE gig_template_id = g_template FOR SHARE')).toBeGreaterThan(
      at('FROM provider.gigs WHERE gig_id = NEW.gig_id FOR SHARE'),
    );
    expect(at('FROM catalog.service_types WHERE service_type_id = t_service FOR SHARE')).toBeGreaterThan(
      at('FROM catalog.gig_templates WHERE gig_template_id = g_template FOR SHARE'),
    );
    expect(at('FROM catalog.gig_template_versions WHERE gig_template_version_id = NEW.gig_template_version_id FOR SHARE')).toBeGreaterThan(
      at('FROM catalog.service_types WHERE service_type_id = t_service FOR SHARE'),
    );
    expect(at('provider.check_gig_version_children')).toBeGreaterThan(at('provider.check_gig_version_content(NEW.gig_id'));
  });

  it('takes NO lock on a catalogue row in any new guard (the structure of a bound template version is frozen, so the catalogue lock order cannot be inverted)', async () => {
    for (const fn of ['guard_gig_version_options', 'guard_gig_version_media', 'check_gig_version_children', 'guard_media_assets']) {
      const src = (await q<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE pronamespace = 'provider'::regnamespace AND proname = $1", [fn]))[0]!.src;
      const catalogReads = src.match(/FROM catalog\.[a-z_]+[^;]*;/g) ?? [];
      expect(catalogReads.length > 0 || fn === 'guard_media_assets', fn).toBe(true);
      for (const read of catalogReads) expect(read, fn).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE)/);
    }
  });

  it('comments every new table (200+ characters) and the columns that carry a rule', async () => {
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
      gig_version_variants: ['item_key', 'name', 'description', 'price_delta_minor', 'duration_delta_minutes', 'display_order'],
      gig_version_add_ons: ['item_key', 'name', 'description', 'price_delta_minor', 'duration_delta_minutes', 'display_order'],
      media_assets: [
        'account_id',
        'status',
        'object_key',
        'mime_type',
        'size_bytes',
        'sha256',
        'width',
        'height',
        'scan_status',
        'upload_expires_at',
        'ready_at',
      ],
      gig_version_media: ['media_asset_id', 'gig_template_field_id', 'display_order', 'alt_text'],
    };
    for (const [t, cols] of Object.entries(expected)) for (const c of cols) expect((await commented(t, c))?.length ?? 0, `${t}.${c}`).toBeGreaterThan(40);
  });

  it('stores no currency, no JSON, no float and no updated_at on a variant or an add-on (one pricing rule: non-negative integer deltas on the base)', async () => {
    for (const t of ['gig_version_variants', 'gig_version_add_ons']) {
      const cols = await q<{ column_name: string; data_type: string }>(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = $1",
        [t],
      );
      expect(cols.filter((c) => /currency|updated_at|json|amount|price$/.test(c.column_name))).toEqual([]);
      expect(cols.filter((c) => ['jsonb', 'json', 'real', 'double precision', 'numeric'].includes(c.data_type))).toEqual([]);
    }
  });

  it('adds pricing_add_ons to the template version as boolean NOT NULL DEFAULT false (every existing version stays false), commented', async () => {
    expect(
      await q(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name = 'gig_template_versions' AND column_name = 'pricing_add_ons'",
      ),
    ).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);
    expect(
      (
        await q<{ c: string }>(
          "SELECT col_description('catalog.gig_template_versions'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'catalog.gig_template_versions'::regclass AND attname = 'pricing_add_ons')) AS c",
        )
      )[0]!.c,
    ).toMatch(/add-ons/);
    expect(await count('catalog.gig_template_versions', 'pricing_add_ons')).toBe(0);
  });

  it('widens the audit action list to exactly the six old and the eight new actions and keeps the audit table immutable', async () => {
    const def = (await q<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ck_gig_audit_events__action'"))[0]!.d;
    const listed = [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);
    expect([...listed].sort(byName)).toEqual([...OLD_ACTIONS, ...NEW_ACTIONS].sort(byName));
    expect(listed).toHaveLength(14);
    expect(
      (await q<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgrelid = 'provider.gig_audit_events'::regclass AND NOT tgisinternal ORDER BY 1")).map(
        (r) => r.tgname,
      ),
    ).toEqual(['trg_gig_audit_events__guard', 'trg_gig_audit_events__immutable', 'trg_gig_audit_events__no_truncate']);
  });
});

// ====================================================================== B. seeds
const OPTIONS_SEED = [
  [PROVIDER_GIG_OPTIONS_POLICY_KEYS.variantMaxCount, 10, 0, 100],
  [PROVIDER_GIG_OPTIONS_POLICY_KEYS.addOnMaxCount, 20, 0, 100],
  [PROVIDER_GIG_OPTIONS_POLICY_KEYS.nameMaxLength, 80, 1, 200],
  [PROVIDER_GIG_OPTIONS_POLICY_KEYS.descriptionMaxLength, 500, 1, 2000],
] as const;
const MEDIA_SEED = [
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.maxFileSizeBytes, 10_485_760, 1, 26_214_400],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.maxItems, 50, 0, 200],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.uploadTtlSeconds, 900, 30, 3600],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.minEdgePixels, 200, 1, 30_000],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.maxEdgePixels, 12_000, 1, 30_000],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.maxPixels, 50_000_000, 1, 400_000_000],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.downloadTtlSeconds, 60, 5, 600],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.orphanGraceSeconds, 86_400, 60, 2_592_000],
  [PROVIDER_GIG_MEDIA_POLICY_KEYS.altTextMaxLength, 200, 1, 500],
] as const;
const NEW_UI_KEYS = [
  ...[
    'variants.heading',
    'variants.intro',
    'add_ons.heading',
    'add_ons.intro',
    'empty',
    'not_permitted',
    'name',
    'description',
    'price_delta',
    'duration_delta',
    'add',
    'remove',
    'move_up',
    'move_down',
    'save',
    'limit_note',
    'delta_note',
  ].map((k) => `provider.gig.options.${k}`),
  ...[
    'heading',
    'intro',
    'rule_required',
    'rule_optional',
    'rule_prohibited',
    'no_field',
    'count',
    'status_uploading',
    'status_ready',
    'upload',
    'file',
    'alt_text',
    'alt_hint',
    'save_alt',
    'remove',
    'move_up',
    'move_down',
    'finish',
    'preview',
    'types_note',
    'size_note',
    'unavailable',
  ].map((k) => `provider.gig.media.${k}`),
  ...['variants', 'add_ons', 'photos', 'photos_missing'].map((k) => `provider.gig.menu.${k}`),
  ...['variants_saved', 'add_ons_saved', 'photo_added', 'photo_removed', 'photo_order_saved', 'photo_saved'].map((k) => `provider.gig.notice.${k}`),
];
const NEW_REASONS = GIG_ISSUE_REASONS.slice(24);
const NEW_CODES = GIG_ERROR_CODES.slice(15);
const SEED_0021 = "e.entry_id IN (SELECT entry_id FROM content.audit_events WHERE correlation_id = 'seed-0021' AND action = 'ENTRY_CREATED')";

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
      value: unknown;
      state: string;
      scope_type: string;
    }>(
      `SELECT p.key, p.data_type, p.validation_rules, p.approval_policy, p.criticality, p.sensitivity, p.is_required, vv.value, cr.state, pv.scope_type
         FROM configuration.parameters p
         JOIN configuration.parameter_values pv ON pv.parameter_id = p.parameter_id
         JOIN configuration.value_versions vv ON vv.parameter_value_id = pv.parameter_value_id
         JOIN configuration.change_requests cr ON cr.value_version_id = vv.version_id
        WHERE p.key LIKE 'provider.gig.%' ORDER BY p.key COLLATE "C"`,
    );

  it('seeds fifteen typed PLATFORM parameters (four option and eleven media) with the documented bounds, the active value and a SECOND_APPROVER STANDARD policy; together with the five of 0020 there are twenty provider.gig.* keys', async () => {
    const rows = await paramRows();
    expect(rows).toHaveLength(20);
    const seeded = [...OPTIONS_SEED, ...MEDIA_SEED];
    expect(seeded).toHaveLength(13); // the integers; the MIME list and the clean-scan flag are checked below
    for (const [k, value, min, max] of seeded) {
      expect(rows.find((x) => x.key === k)!).toMatchObject({
        data_type: 'INTEGER',
        validation_rules: { min, max },
        approval_policy: 'SECOND_APPROVER',
        criticality: 'STANDARD',
        sensitivity: 'INTERNAL',
        is_required: true,
        state: 'ACTIVE',
        scope_type: 'PLATFORM',
        value,
      });
    }
    expect(rows.find((x) => x.key === PROVIDER_GIG_MEDIA_POLICY_KEYS.requireCleanScan)).toMatchObject({ data_type: 'BOOLEAN', value: true, state: 'ACTIVE' });
    const mime = rows.find((x) => x.key === PROVIDER_GIG_MEDIA_POLICY_KEYS.allowedMimeTypes)!;
    expect(mime).toMatchObject({ data_type: 'JSON', value: ['image/jpeg', 'image/png', 'image/webp'], state: 'ACTIVE' });
    expect(mime.validation_rules.schema).toEqual({
      type: 'array',
      items: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
      uniqueItems: true,
      minItems: 1,
      maxItems: 3,
    });
  });

  it('seeds values that parse as the contract policies (the contract clamps them to the same structural ceilings as the database CHECKs)', async () => {
    const v = Object.fromEntries((await paramRows()).map((r) => [r.key, r.value]));
    expect(
      ProviderGigOptionsPolicy.parse({
        variantMaxCount: v[PROVIDER_GIG_OPTIONS_POLICY_KEYS.variantMaxCount],
        addOnMaxCount: v[PROVIDER_GIG_OPTIONS_POLICY_KEYS.addOnMaxCount],
        nameMaxLength: v[PROVIDER_GIG_OPTIONS_POLICY_KEYS.nameMaxLength],
        descriptionMaxLength: v[PROVIDER_GIG_OPTIONS_POLICY_KEYS.descriptionMaxLength],
      }),
    ).toEqual({ variantMaxCount: 10, addOnMaxCount: 20, nameMaxLength: 80, descriptionMaxLength: 500 });
    const media = ProviderGigMediaPolicy.parse({
      maxFileSizeBytes: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.maxFileSizeBytes],
      maxItems: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.maxItems],
      allowedMimeTypes: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.allowedMimeTypes],
      uploadTtlSeconds: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.uploadTtlSeconds],
      requireCleanScan: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.requireCleanScan],
      minEdgePixels: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.minEdgePixels],
      maxEdgePixels: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.maxEdgePixels],
      maxPixels: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.maxPixels],
      downloadTtlSeconds: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.downloadTtlSeconds],
      orphanGraceSeconds: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.orphanGraceSeconds],
      altTextMaxLength: v[PROVIDER_GIG_MEDIA_POLICY_KEYS.altTextMaxLength],
    });
    expect(media).toMatchObject({
      maxFileSizeBytes: 10_485_760,
      maxItems: 50,
      requireCleanScan: true,
      minEdgePixels: 200,
      maxEdgePixels: 12_000,
      maxPixels: 50_000_000,
    });
    expect(Object.keys(PROVIDER_GIG_OPTIONS_POLICY_KEYS)).toHaveLength(4);
    expect(Object.keys(PROVIDER_GIG_MEDIA_POLICY_KEYS)).toHaveLength(11);
  });

  it('keeps the PRD values where the PRD has them (10 MB and 50 photos) and fails closed on scanning (clean scan required)', async () => {
    const v = Object.fromEntries((await paramRows()).map((r) => [r.key, r.value]));
    expect(v[PROVIDER_GIG_MEDIA_POLICY_KEYS.maxFileSizeBytes]).toBe(10 * 1024 * 1024);
    expect(v[PROVIDER_GIG_MEDIA_POLICY_KEYS.maxItems]).toBe(50);
    expect(v[PROVIDER_GIG_MEDIA_POLICY_KEYS.requireCleanScan]).toBe(true);
    expect(v[PROVIDER_GIG_MEDIA_POLICY_KEYS.allowedMimeTypes]).not.toContain('image/svg+xml');
    expect(v[PROVIDER_GIG_MEDIA_POLICY_KEYS.allowedMimeTypes]).not.toContain('image/heic');
  });

  it('wrote the configuration audit trail of every seeded parameter exactly as the workflow does (created, drafted, submitted, approved, published, activated)', async () => {
    const rows = await q<{ key: string; actions: string[] }>(
      `SELECT p.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions FROM configuration.parameters p JOIN configuration.audit_events a ON a.parameter_id = p.parameter_id
        WHERE p.key LIKE 'provider.gig.%' AND a.correlation_id = 'seed-0021' GROUP BY 1`,
    );
    expect(rows).toHaveLength(15);
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

  it('seeds one content entry per NEW issue reason (19), per NEW error code (4) and per UI key of section 8 (49): 72 entries, and nothing else under that correlation', async () => {
    expect([NEW_REASONS.length, NEW_CODES.length, NEW_UI_KEYS.length]).toEqual([19, 4, 49]);
    expect(new Set(NEW_UI_KEYS).size).toBe(49);
    const keys = (await q<{ key: string }>(`SELECT key FROM content.entries e WHERE ${SEED_0021}`)).map((r) => r.key);
    expect([...keys].sort(byName)).toEqual([...NEW_REASONS.map(gigIssueKey), ...NEW_CODES.map(gigErrorKey), ...NEW_UI_KEYS].sort(byName));
    expect(keys).toHaveLength(72);
  });

  it('has a published entry for EVERY issue reason and EVERY error code of the contract (0020 and 0021 together) and the 61 + 49 UI keys exist', async () => {
    const present = new Set((await q<{ key: string }>("SELECT key FROM content.entries WHERE key LIKE 'provider.gig.%'")).map((r) => r.key));
    for (const r of GIG_ISSUE_REASONS) expect(present.has(gigIssueKey(r)), r).toBe(true);
    for (const c of GIG_ERROR_CODES) expect(present.has(gigErrorKey(c)), c).toBe(true);
    for (const k of NEW_UI_KEYS) expect(present.has(k), k).toBe(true);
    expect(present.size).toBe(107 + 72 + 13); // 0020, 0021 and the thirteen refusal reasons of 0023
  });

  it('publishes every seeded entry as an active en-US PLATFORM version, as plain platform copy with no variables, no legal type and no personal data', async () => {
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
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${SEED_0021} AND v.status <> 'SUPERSEDED'`,
    );
    // 0023 corrected provider.gig.options.variants.intro with a version 2: the SUPERSEDED version 1 is history (asserted in the 0023 test below)
    expect(rows).toHaveLength(72);
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
      expect(r.body.trim().length).toBeGreaterThan(1);
      expect(r.body).not.toMatch(r.key === 'provider.gig.options.variants.intro' ? /[{}<>]|@|\$\{/ : /[{}<>]|@|\$\{|\b\d+\b/); // no variables, no markup, no numbers (limits are rendered next to the words; the corrected variants intro names the difference 0)
    }
  });

  const REFUSED_REASONS = [
    'MIME_NOT_ALLOWED',
    'FILE_TOO_LARGE',
    'SIZE_MISMATCH',
    'CONTENT_TYPE_MISMATCH',
    'SIGNATURE_MISMATCH',
    'HASH_MISMATCH',
    'OBJECT_MISSING',
    'OBJECT_CHANGED',
    'IMAGE_INVALID',
    'IMAGE_TOO_SMALL',
    'IMAGE_TOO_LARGE',
    'SCAN_INFECTED',
    'UPLOAD_EXPIRED',
  ];
  const SEED_0023 = "e.entry_id IN (SELECT entry_id FROM content.audit_events WHERE correlation_id = 'seed-0023' AND action = 'ENTRY_CREATED')";

  it('0023 seeds one calm plain-text entry per refusal reason under provider.gig.media.refused.<reason lower> (13 keys, no numbers, no variables), published as en-US PLATFORM copy', async () => {
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
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${SEED_0023}`,
    );
    expect(rows.map((r) => r.key).sort(byName)).toEqual(REFUSED_REASONS.map((r) => `provider.gig.media.refused.${r.toLowerCase()}`).sort(byName));
    for (const r of rows) {
      expect({ type: r.content_type, status: r.status, locale: r.locale, scope: r.scope_type, active: r.is_active, n: r.n }).toEqual({
        type: 'PLAIN_TEXT',
        status: 'PUBLISHED',
        locale: 'en-US',
        scope: 'PLATFORM',
        active: true,
        n: 1,
      });
      expect(r.body.length, r.key).toBeGreaterThan(20);
      expect(r.body, r.key).not.toMatch(/[{}<>]|@|\$\{|\d/);
      expect(r.body, r.key).toMatch(/[.]$/);
    }
    expect(rows.find((r) => r.key === 'provider.gig.media.refused.object_missing')!.body).toBe(
      'We did not receive your file. Try uploading it again, or remove this photo.',
    );
  });

  it('0023 corrected provider.gig.options.variants.intro with a version 2 through the content lifecycle: version 1 is SUPERSEDED history with its period closed where version 2 starts, and no current body claims the base is the cheapest', async () => {
    const versions = await q<{ version: number; status: string; body: string; effective_from: Date; effective_to: Date | null }>(
      "SELECT v.version, v.status, v.body, v.effective_from, v.effective_to FROM content.entries e JOIN content.versions v USING (entry_id) WHERE e.key = 'provider.gig.options.variants.intro' ORDER BY v.version",
    );
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'PUBLISHED'],
    ]);
    expect(versions[0]!.body).toMatch(/cheapest/); // history is never rewritten
    expect(versions[1]!.body).toBe(
      'Variants are alternatives the customer chooses between. The price of a variant is your Gig price plus the difference you set; leave the difference at 0 for the option that costs the base price.',
    );
    expect(versions[0]!.effective_to!.getTime()).toBe(versions[1]!.effective_from.getTime());
    expect(versions[1]!.effective_to).toBeNull();
    const audit = await q<{ action: string; n: number }>(
      "SELECT action, count(*)::int AS n FROM content.audit_events a JOIN content.entries e USING (entry_id) WHERE a.correlation_id = 'seed-0023' AND e.key = 'provider.gig.options.variants.intro' GROUP BY 1 ORDER BY 1",
    );
    expect(audit).toEqual([
      { action: 'VERSION_ACTIVATED', n: 1 },
      { action: 'VERSION_APPROVED', n: 1 },
      { action: 'VERSION_DRAFTED', n: 1 },
      { action: 'VERSION_PUBLISHED', n: 1 },
      { action: 'VERSION_SUPERSEDED', n: 1 },
    ]);
    // the claim-review: no CURRENT provider.gig.* body asserts that something is the cheapest or the lowest
    const claims = await q<{ key: string }>(
      "SELECT e.key FROM content.entries e JOIN content.versions v USING (entry_id) WHERE e.key LIKE 'provider.gig.%' AND v.status = 'PUBLISHED' AND v.body ~* '(cheapest|lowest|cheaper)'",
    );
    expect(claims).toEqual([]);
  });

  it('seeds nothing into the new tables (a freshly migrated database has all four empty)', async () => {
    const fresh = await createIsolatedDatabase();
    const c = createTestPool(fresh.url, 2);
    try {
      for (const t of NEW_TABLES) expect(await count(`provider.${t}`, 'true', [], c)).toBe(0);
    } finally {
      await c.end();
      await fresh.drop();
    }
  }, 120_000);
});

// ====================================================================== C. variants and add-ons
describe.each(['gig_version_variants', 'gig_version_add_ons'] as const)('C. provider.%s', (table) => {
  const opts: TplOpts = table === 'gig_version_variants' ? { withVariants: true } : { addOns: true };
  const other: TplOpts = table === 'gig_version_variants' ? { addOns: true } : { withVariants: true };
  const prefix = table;
  const notPermitted = table === 'gig_version_variants' ? 'VARIANTS_NOT_PERMITTED' : 'ADD_ONS_NOT_PERMITTED';

  it('accepts a row on a DRAFT whose bound template version grants the permission and defaults nothing the contract does not', async () => {
    const g = await makeGig(opts);
    const id = ((await addItem(table, g.v1, { name: 'Standard', description: 'The usual', price: 0, minutes: 0 })).rows[0] as { id: string }).id;
    const row = (
      await q<Record<string, unknown>>(`SELECT * FROM provider.${table} WHERE ${table === 'gig_version_variants' ? 'variant_id' : 'add_on_id'} = $1`, [id])
    )[0]!;
    expect(row).toMatchObject({
      gig_version_id: g.v1,
      name: 'Standard',
      description: 'The usual',
      price_delta_minor: '0',
      duration_delta_minutes: 0,
      display_order: 1,
    });
  });

  it('refuses a row when the bound template version does not grant the permission, and a permission for the OTHER kind is not enough', async () => {
    const none = await makeGig();
    await expectRule(addItem(table, none.v1), notPermitted);
    const wrong = await makeGig(other);
    await expectRule(addItem(table, wrong.v1), notPermitted);
    expect(await count(`provider.${table}`, 'gig_version_id = ANY ($1)', [[none.v1, wrong.v1]])).toBe(0);
  });

  it('is an explicit permission: FIXED_WITH_VARIANTS never grants add-ons and pricing_add_ons never grants variants', async () => {
    const both = await makeGig({ withVariants: true, addOns: true });
    await addItem('gig_version_variants', both.v1, { key: 'opt_one' });
    await addItem('gig_version_add_ons', both.v1, { key: 'opt_one' });
    expect(await count('provider.gig_version_variants', 'gig_version_id = $1', [both.v1])).toBe(1);
    expect(await count('provider.gig_version_add_ons', 'gig_version_id = $1', [both.v1])).toBe(1);
  });

  it.each([
    ['a key that starts with a digit', { key: '1abc' }, `ck_${prefix}__key`],
    ['an upper-case key', { key: 'Opt_abc' }, `ck_${prefix}__key`],
    ['a key with a hyphen', { key: 'opt-abc' }, `ck_${prefix}__key`],
    ['a one-character key', { key: 'a' }, `ck_${prefix}__key`],
    ['a 41-character key', { key: `a${'b'.repeat(40)}` }, `ck_${prefix}__key`],
    ['a blank name', { name: '   ' }, `ck_${prefix}__name`],
    ['an empty name', { name: '' }, `ck_${prefix}__name`],
    ['a 201-character name', { name: 'n'.repeat(201) }, `ck_${prefix}__name`],
    ['a blank description', { description: '  ' }, `ck_${prefix}__description`],
    ['a 2001-character description', { description: 'd'.repeat(2001) }, `ck_${prefix}__description`],
    ['a negative price delta', { price: -1 }, `ck_${prefix}__price_delta`],
    ['a price delta above 10^12', { price: '1000000000001' }, `ck_${prefix}__price_delta`],
    ['a negative duration delta', { minutes: -1 }, `ck_${prefix}__duration_delta`],
    ['a duration delta above 100000', { minutes: 100_001 }, `ck_${prefix}__duration_delta`],
    ['display order 0', { order: 0 }, `ck_${prefix}__display_order`],
  ] as const)('refuses %s with the named CHECK', async (_what, o, constraint) => {
    const g = await makeGig(opts);
    await expectConstraint(addItem(table, g.v1, o), constraint);
  });

  it('accepts the exact boundaries: key of 2 and 40 characters, name of 200, description of 2000, delta 0 and 10^12, duration 0 and 100000, multi-byte names by code point', async () => {
    const g = await makeGig(opts);
    await addItem(table, g.v1, { key: 'ab', order: 1, price: 0, minutes: 0 });
    await addItem(table, g.v1, { key: `a${'b'.repeat(39)}`, order: 2, price: '1000000000000', minutes: 100_000 });
    await addItem(table, g.v1, { order: 3, name: 'n'.repeat(200), description: 'd'.repeat(2000) });
    await addItem(table, g.v1, { order: 4, name: '\u{1F600}'.repeat(200) }); // 200 code points, 800 bytes
    expect(await count(`provider.${table}`, 'gig_version_id = $1', [g.v1])).toBe(4);
  });

  it('keeps the key and the order unique per version, lets two versions (and two Gigs) reuse the same key and order, and does NOT make names unique', async () => {
    const g = await makeGig(opts);
    await addItem(table, g.v1, { key: 'opt_a', order: 1, name: 'Same' });
    await expectConstraint(addItem(table, g.v1, { key: 'opt_a', order: 2 }), `uq_${prefix}__key`);
    await expectConstraint(addItem(table, g.v1, { key: 'opt_b', order: 1 }), `uq_${prefix}__order`);
    await addItem(table, g.v1, { key: 'opt_b', order: 2, name: 'Same' }); // the service refuses duplicate names (locale-aware), the database does not
    const h = await makeGig(opts);
    await addItem(table, h.v1, { key: 'opt_a', order: 1 });
    expect(await count(`provider.${table}`, "item_key = 'opt_a'")).toBeGreaterThanOrEqual(2);
  });

  it('replaces a whole set in one transaction while the version is a DRAFT (delete all, insert the new ones) and refuses EVERY UPDATE (NO_UPDATE)', async () => {
    const g = await makeGig(opts);
    await addItem(table, g.v1, { key: 'opt_a', order: 1 });
    await addItem(table, g.v1, { key: 'opt_b', order: 2 });
    const idCol = table === 'gig_version_variants' ? 'variant_id' : 'add_on_id';
    for (const set of [
      "name = 'Renamed'",
      'price_delta_minor = 900',
      'duration_delta_minutes = 5',
      'display_order = 7',
      "description = 'x'",
      "item_key = 'opt_z'",
      `${idCol} = gen_random_uuid()`,
      "created_at = created_at + interval '1 day'",
      'name = name', // even a no-op write is refused: the set is replaced, never edited
    ])
      await expectRule(run(`UPDATE provider.${table} SET ${set} WHERE gig_version_id = $1 AND item_key = 'opt_a'`, [g.v1]), 'NO_UPDATE');
    const other = await makeGig(opts);
    await expectRule(run(`UPDATE provider.${table} SET gig_version_id = $2 WHERE gig_version_id = $1`, [g.v1, other.v1]), 'NO_UPDATE');
    expect(await count(`provider.${table}`, "gig_version_id = $1 AND name = 'Large'", [g.v1])).toBe(2);
    await inTx(async (c) => {
      await c.query(`DELETE FROM provider.${table} WHERE gig_version_id = $1`, [g.v1]);
      await addItem(table, g.v1, { key: 'opt_a', order: 1, name: 'First' }, c);
      await addItem(table, g.v1, { key: 'opt_c', order: 2, name: 'Third' }, c);
    });
    expect(
      (await q<{ item_key: string }>(`SELECT item_key FROM provider.${table} WHERE gig_version_id = $1 ORDER BY display_order`, [g.v1])).map((r) => r.item_key),
    ).toEqual(['opt_a', 'opt_c']);
  });

  it('refuses a row for a version that does not exist as a foreign key failure', async () => {
    await expectConstraint(addItem(table, randomUUID()), `fk_${prefix}__version_id`);
  });

  it('freezes the rows of a PUBLISHED, SUPERSEDED and RETIRED version for insert, update and delete (VERSION_FROZEN)', async () => {
    const g = await makeGig(opts);
    await addItem(table, g.v1, { key: 'opt_a', order: 1 });
    await inTx(async (c) => {
      await fillDraft(g.v1, c);
      await publishFirst(g, c);
    });
    const frozen = async (version: string) => {
      await expectRule(addItem(table, version, { key: 'opt_new', order: 9 }), 'VERSION_FROZEN');
      await expectRule(run(`UPDATE provider.${table} SET name = 'Changed' WHERE gig_version_id = $1`, [version]), 'NO_UPDATE'); // refused outright, frozen or not
      await expectRule(run(`DELETE FROM provider.${table} WHERE gig_version_id = $1`, [version]), 'VERSION_FROZEN');
      expect(await count(`provider.${table}`, "gig_version_id = $1 AND name = 'Large'", [version])).toBe(1);
    };
    expect(await versionStatus(g.v1)).toBe('PUBLISHED');
    await frozen(g.v1);
    // version 2: the next draft receives COPIES (same keys, same order), v1 is untouched; then v2 supersedes v1
    const v2 = await inTx(async (c) => {
      const id = (
        (
          await c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, 2, $2) RETURNING gig_version_id', [
            g.gigId,
            g.t.tvId,
          ])
        ).rows[0] as { gig_version_id: string }
      ).gig_version_id;
      await c.query(
        `INSERT INTO provider.${table} (gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order)
         SELECT $2, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order FROM provider.${table} WHERE gig_version_id = $1`,
        [g.v1, id],
      );
      return id;
    });
    expect(await count(`provider.${table}`, 'gig_version_id = $1', [v2])).toBe(1);
    await expectRule(run(`UPDATE provider.${table} SET name = 'Edited in v2' WHERE gig_version_id = $1`, [v2]), 'NO_UPDATE'); // a draft is edited by delete and insert
    await inTx(async (c) => {
      await c.query(`DELETE FROM provider.${table} WHERE gig_version_id = $1`, [v2]);
      await addItem(table, v2, { key: 'opt_a', name: 'Edited in v2', price: 1 }, c);
    });
    expect(
      (await q<{ name: string; price_delta_minor: string }>(`SELECT name, price_delta_minor FROM provider.${table} WHERE gig_version_id = $1`, [g.v1]))[0],
    ).toEqual({ name: 'Large', price_delta_minor: '500' });
    await inTx(async (c) => {
      await fillDraft(v2, c);
      await c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_version_id = $1", [g.v1]);
      await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [v2]);
    });
    expect(await versionStatus(g.v1)).toBe('SUPERSEDED');
    await frozen(g.v1);
    await expectRule(addItem(table, v2, { key: 'opt_late', order: 5 }), 'VERSION_FROZEN');
    // a retired Gig: its draft (version 3) is retired with it and the children are frozen too
    const v3 = await inTx(async (c) => {
      const id = (
        (
          await c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, 3, $2) RETURNING gig_version_id', [
            g.gigId,
            g.t.tvId,
          ])
        ).rows[0] as { gig_version_id: string }
      ).gig_version_id;
      await addItem(table, id, { key: 'opt_a', order: 1 }, c);
      return id;
    });
    await inTx(async (c) => {
      await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]);
      await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1 AND status IN ('DRAFT', 'PUBLISHED')", [g.gigId]);
    });
    expect(await versionStatus(v3)).toBe('RETIRED');
    await expectRule(addItem(table, v3, { key: 'opt_x', order: 4 }), 'VERSION_FROZEN');
    await expectRule(run(`DELETE FROM provider.${table} WHERE gig_version_id = $1`, [v3]), 'VERSION_FROZEN');
  });

  it('refuses TRUNCATE (plain and CASCADE) with ROW_IMMUTABLE and keeps every row', async () => {
    const g = await makeGig(opts);
    await addItem(table, g.v1);
    const before = await count(`provider.${table}`);
    await expectRule(run(`TRUNCATE provider.${table}`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE provider.${table} CASCADE`), 'ROW_IMMUTABLE');
    expect(await count(`provider.${table}`)).toBe(before);
  });

  it('refuses publication of a draft whose children exist while the template permission is gone (backstop), and publishes once they are removed', async () => {
    const g = await makeGig(opts);
    await addItem(table, g.v1);
    await fillDraft(g.v1);
    // the permission is frozen on a bound version, so the state is crafted with the catalogue guards off
    const flag = table === 'gig_version_variants' ? 'pricing_fixed_with_variants' : 'pricing_add_ons';
    await replica((c) => c.query(`UPDATE catalog.gig_template_versions SET ${flag} = false WHERE gig_template_version_id = $1`, [g.t.tvId]));
    await expectRule(run("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [g.v1]), notPermitted);
    expect(await versionStatus(g.v1)).toBe('DRAFT');
    await run(`DELETE FROM provider.${table} WHERE gig_version_id = $1`, [g.v1]);
    await inTx((c) => publishFirst(g, c));
    expect(await versionStatus(g.v1)).toBe('PUBLISHED');
  });

  it('does not take a lock on the catalogue and so does not deadlock against a catalogue transaction that locks template then version (50 interleavings)', async () => {
    const g = await makeGig(opts);
    const t = g.t;
    const catalogue = async (c: pg.PoolClient) => {
      await c.query('SELECT 1 FROM catalog.gig_templates WHERE gig_template_id = $1 FOR UPDATE', [t.tplId]);
      await sleep(2);
      await c.query('SELECT 1 FROM catalog.gig_template_versions WHERE gig_template_version_id = $1 FOR UPDATE', [t.tvId]);
    };
    for (let i = 0; i < 50; i++) {
      const [a, b] = (await Promise.all([
        rejection(runRacer(racePool, catalogue)),
        rejection(runRacer(racePool, async (c) => addItem(table, g.v1, { key: `opt_${i}_x`, order: 100 + i }, c))),
      ])) as (PgFailure | undefined)[];
      notDeadlock(a);
      notDeadlock(b);
      expect(b).toBeUndefined();
    }
  }, 60_000);
});

// ====================================================================== D. provider.media_assets
describe('D. provider.media_assets', () => {
  it('creates an UPLOAD_PENDING asset for an ACTIVE account with PENDING scan status and no facts', async () => {
    const account = await makeAccount();
    const id = await insertAsset(account);
    expect((await q<Record<string, unknown>>('SELECT * FROM provider.media_assets WHERE media_asset_id = $1', [id]))[0]).toMatchObject({
      account_id: account,
      status: 'UPLOAD_PENDING',
      mime_type: 'image/png',
      size_bytes: '120000',
      sha256: null,
      width: null,
      height: null,
      scan_status: 'PENDING',
      ready_at: null,
    });
  });

  it('starts only as UPLOAD_PENDING (MUST_START_PENDING) and only for an ACTIVE account (ACCOUNT_NOT_ACTIVE)', async () => {
    const account = await makeAccount();
    for (const status of ['READY', 'ABANDONED', 'DELETED'])
      await expectRule(
        run(
          `INSERT INTO provider.media_assets (account_id, status, object_key, mime_type, size_bytes, sha256, width, height, scan_status, upload_expires_at, ready_at)
           VALUES ($1, $2, $3, 'image/png', 10, repeat('a', 64), 10, 10, 'CLEAN', now() + interval '1 hour', now())`,
          [account, status, `provider/gig-media/${randomUUID()}`],
        ),
        'MUST_START_PENDING',
      );
    await suspend(account);
    await expectRule(insertAsset(account), 'ACCOUNT_NOT_ACTIVE');
    await expectConstraint(insertAsset(randomUUID()), 'fk_media_assets__account_id');
  });

  const rawInsert = async (over: Record<string, string>, account: string, replicaRole = false): Promise<void> => {
    const id = randomUUID();
    const vals: Record<string, string> = {
      media_asset_id: `'${id}'`,
      account_id: '$1',
      status: "'UPLOAD_PENDING'",
      object_key: `'provider/gig-media/${id}'`,
      mime_type: "'image/png'",
      size_bytes: '10',
      scan_status: "'PENDING'",
      upload_expires_at: "now() + interval '1 hour'",
      ...over,
    };
    const cols = Object.keys(vals);
    const text = `INSERT INTO provider.media_assets (${cols.join(', ')}) VALUES (${cols.map((c) => vals[c]).join(', ')})`;
    if (replicaRole) await replica((c) => c.query(text, [account]));
    else await run(text, [account]);
  };
  it.each([
    ['an SVG type', { mime_type: "'image/svg+xml'" }, 'ck_media_assets__mime_type'],
    ['an HEIC type', { mime_type: "'image/heic'" }, 'ck_media_assets__mime_type'],
    // the list is exactly the three verifiable types: nothing near them is accepted (mutation-testing additions)
    ['a GIF type', { mime_type: "'image/gif'" }, 'ck_media_assets__mime_type'],
    ['the non-standard image/jpg', { mime_type: "'image/jpg'" }, 'ck_media_assets__mime_type'],
    ['an upper-case type', { mime_type: "'IMAGE/PNG'" }, 'ck_media_assets__mime_type'],
    ['a PDF', { mime_type: "'application/pdf'" }, 'ck_media_assets__mime_type'],
    ['an empty type', { mime_type: "''" }, 'ck_media_assets__mime_type'],
    ['a zero size', { size_bytes: '0' }, 'ck_media_assets__size'],
    ['a size above 25 MiB', { size_bytes: '26214401' }, 'ck_media_assets__size'],
    // the lifecycle CHECK (alphabetically before ck_media_assets__scan_status) answers first for a verdict outside the list; the plain list CHECK is its backstop
    ['a scan status outside the four', { scan_status: "'MAYBE'" }, 'ck_media_assets__lifecycle'],
    ['an empty object key', { object_key: "''" }, 'ck_media_assets__object_key'],
    ['an object key above 500 characters', { object_key: `'${'k'.repeat(501)}'` }, 'ck_media_assets__object_key'],
  ])('refuses %s with the named CHECK', async (_what, over, constraint) => {
    await expectConstraint(rawInsert(over, await makeAccount()), constraint);
  });

  it('refuses a status outside the four with a CHECK (reached with the guards off: the guard would answer first; the lifecycle CHECK names it before the plain list CHECK)', async () => {
    await expectConstraint(rawInsert({ status: "'BOGUS'" }, await makeAccount(), true), 'ck_media_assets__lifecycle');
  });

  const readySet = (o: Partial<Record<'sha256' | 'width' | 'height', string>> = {}): string => {
    const v = { sha256: "repeat('a', 64)", width: '10', height: '10', ...o };
    return `status = 'READY', sha256 = ${v.sha256}, width = ${v.width}, height = ${v.height}, scan_status = 'CLEAN', ready_at = now()`;
  };
  it.each([
    ['a short hash', readySet({ sha256: "repeat('a', 63)" }), 'ck_media_assets__sha256'],
    ['an upper-case hash', readySet({ sha256: "repeat('A', 64)" }), 'ck_media_assets__sha256'],
    ['a non-hex hash', readySet({ sha256: "repeat('g', 64)" }), 'ck_media_assets__sha256'],
    ['a width without a height', readySet({ height: 'NULL' }), 'ck_media_assets__dimensions'],
    ['a zero width', readySet({ width: '0' }), 'ck_media_assets__dimensions'],
    ['a width above 30000', readySet({ width: '30001' }), 'ck_media_assets__dimensions'],
    ['a height above 30000', readySet({ height: '30001' }), 'ck_media_assets__dimensions'],
  ])('refuses %s on the READY transition with the named CHECK', async (_what, set, constraint) => {
    const id = await insertAsset(await makeAccount());
    await expectConstraint(run(`UPDATE provider.media_assets SET ${set} WHERE media_asset_id = $1`, [id]), constraint);
  });

  it('refuses an expiry that is not after the creation time, a duplicate id and an object key that is not derived from the asset id', async () => {
    const account = await makeAccount();
    await expectConstraint(insertAsset(account, { ttlSeconds: 0 }), 'ck_media_assets__expiry');
    await expectConstraint(insertAsset(account, { ttlSeconds: -5 }), 'ck_media_assets__expiry');
    const id = await insertAsset(account);
    await expectConstraint(insertAsset(account, { id }), 'pk_media_assets');
    // the key is always provider/gig-media/<asset id> (0022): another asset's key, a prefix change or a suffix is refused
    const other = randomUUID();
    for (const key of [
      `provider/gig-media/${other}`,
      `provider/gig-media/${id}.upload`,
      `other/gig-media/${id}`,
      'provider/gig-media/',
      `Provider/gig-media/${id}`,
    ]) {
      await expectConstraint(
        run(
          "INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, 'image/png', 10, now() + interval '1 hour')",
          [randomUUID(), account, key],
        ),
        'ck_media_assets__object_key_derived',
      );
    }
    // the unique constraint on the key is now a backstop of the primary key; a copy of an existing key is refused whichever constraint fires first
    const e = await fail(
      run(
        "INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, 'image/png', 10, now() + interval '1 hour')",
        [randomUUID(), account, `provider/gig-media/${id}`],
      ),
    );
    expect(['ck_media_assets__object_key_derived', 'uq_media_assets__object_key']).toContain(e.constraint);
  });

  it('enforces the lifecycle CHECK: a pending asset has no facts, a READY one has all of them and a CLEAN or ERROR verdict, INFECTED only with ABANDONED', async () => {
    const account = await makeAccount();
    const pending = await insertAsset(account);
    await expectConstraint(run("UPDATE provider.media_assets SET sha256 = repeat('a', 64) WHERE media_asset_id = $1", [pending]), 'ck_media_assets__lifecycle');
    await expectConstraint(run("UPDATE provider.media_assets SET scan_status = 'CLEAN' WHERE media_asset_id = $1", [pending]), 'ck_media_assets__lifecycle');
    await expectConstraint(run("UPDATE provider.media_assets SET scan_status = 'INFECTED' WHERE media_asset_id = $1", [pending]), 'ck_media_assets__infected');
    await run("UPDATE provider.media_assets SET scan_status = 'ERROR' WHERE media_asset_id = $1", [pending]); // a scanner error keeps the asset pending, repeatable
    await run("UPDATE provider.media_assets SET scan_status = 'PENDING' WHERE media_asset_id = $1", [pending]);
    for (const [set, constraint] of [
      ["status = 'READY'", 'ck_media_assets__lifecycle'], // no facts
      ["status = 'READY', sha256 = repeat('a', 64), width = 1, height = 1, scan_status = 'CLEAN'", 'ck_media_assets__lifecycle'], // no ready_at
      ["status = 'READY', sha256 = repeat('a', 64), width = 1, height = 1, ready_at = now()", 'ck_media_assets__lifecycle'], // scan PENDING
      ["status = 'READY', sha256 = repeat('a', 64), width = 1, height = 1, ready_at = now(), scan_status = 'INFECTED'", 'ck_media_assets__infected'],
      ["status = 'READY', sha256 = repeat('a', 64), width = 1, ready_at = now(), scan_status = 'CLEAN'", 'ck_media_assets__dimensions'], // no height
      ["status = 'READY', width = 1, height = 1, ready_at = now(), scan_status = 'CLEAN'", 'ck_media_assets__lifecycle'], // no hash
    ] as const)
      await expectConstraint(run(`UPDATE provider.media_assets SET ${set} WHERE media_asset_id = $1`, [pending]), constraint);
    await makeReady(pending);
    expect(
      (await q<{ status: string; scan_status: string }>('SELECT status, scan_status FROM provider.media_assets WHERE media_asset_id = $1', [pending]))[0],
    ).toEqual({ status: 'READY', scan_status: 'CLEAN' });
    // a READY asset may carry the scanner's ERROR verdict (only when the configuration does not require a clean scan; the service decides)
    const errored = await insertAsset(account);
    await run(
      "UPDATE provider.media_assets SET status = 'READY', sha256 = repeat('b', 64), width = 5, height = 5, scan_status = 'ERROR', ready_at = now() WHERE media_asset_id = $1",
      [errored],
    );
    // an abandoned asset has no ready_at and may be INFECTED
    const bad = await insertAsset(account);
    await run("UPDATE provider.media_assets SET status = 'ABANDONED', scan_status = 'INFECTED' WHERE media_asset_id = $1", [bad]);
    await expectConstraint(
      run("UPDATE provider.media_assets SET status = 'ABANDONED', ready_at = now() WHERE media_asset_id = $1", [await insertAsset(account)]),
      'ck_media_assets__lifecycle',
    );
  });

  it('allows exactly UPLOAD_PENDING -> READY | ABANDONED and READY -> DELETED; ABANDONED and DELETED are terminal and frozen (every cell of the matrix)', async () => {
    const account = await makeAccount();
    const states = ['UPLOAD_PENDING', 'READY', 'ABANDONED', 'DELETED'] as const;
    const allowed = new Set(['UPLOAD_PENDING>READY', 'UPLOAD_PENDING>ABANDONED', 'READY>DELETED']);
    const make = async (status: string): Promise<string> => {
      const id = await insertAsset(account);
      if (status === 'UPLOAD_PENDING') return id;
      if (status === 'ABANDONED') {
        await run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [id]);
        return id;
      }
      await makeReady(id);
      if (status === 'DELETED') await run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [id]);
      return id;
    };
    const targetSet = (to: string): string =>
      to === 'READY'
        ? "status = 'READY', sha256 = repeat('c', 64), width = 3, height = 3, scan_status = 'CLEAN', ready_at = now()"
        : to === 'UPLOAD_PENDING'
          ? "status = 'UPLOAD_PENDING'"
          : `status = '${to}'`;
    for (const from of states) {
      for (const to of states) {
        if (from === to) continue;
        const id = await make(from);
        const outcome = await outcomeOf(run(`UPDATE provider.media_assets SET ${targetSet(to)} WHERE media_asset_id = $1`, [id]));
        if (allowed.has(`${from}>${to}`)) expect(outcome, `${from}>${to}`).toBe('ACCEPTED');
        else if (from === 'ABANDONED' || from === 'DELETED') expect(outcome, `${from}>${to}`).toBe('ASSET_FROZEN');
        else expect(outcome, `${from}>${to}`).toBe('STATUS_TRANSITION');
      }
    }
  });

  it('keeps the identity of an asset immutable: id, owner, key, type, size, authorization window and creation time', async () => {
    const account = await makeAccount();
    const other = await makeAccount();
    const id = await insertAsset(account);
    for (const set of [
      'media_asset_id = gen_random_uuid()',
      `account_id = '${other}'`,
      "object_key = 'provider/gig-media/other'",
      "mime_type = 'image/jpeg'",
      'size_bytes = size_bytes + 1',
      "upload_expires_at = upload_expires_at + interval '1 hour'",
      "created_at = created_at - interval '1 day'",
    ])
      await expectRule(run(`UPDATE provider.media_assets SET ${set} WHERE media_asset_id = $1`, [id]), 'IMMUTABLE_IDENTITY');
    await makeReady(id);
    for (const set of ["object_key = 'provider/gig-media/other'", 'size_bytes = 1', `account_id = '${other}'`])
      await expectRule(run(`UPDATE provider.media_assets SET ${set} WHERE media_asset_id = $1`, [id]), 'IMMUTABLE_IDENTITY');
  });

  it('keeps the bytes facts of a READY asset immutable (hash, dimensions, scan verdict, ready time), also in the statement that deletes it', async () => {
    const account = await makeAccount();
    const id = await readyAsset(account);
    for (const set of [
      "sha256 = repeat('b', 64)",
      'width = 801',
      'height = 601',
      "scan_status = 'ERROR'",
      "ready_at = ready_at + interval '1 hour'",
      "sha256 = repeat('b', 64), status = 'DELETED'",
      "scan_status = 'ERROR', status = 'DELETED'",
    ])
      await expectRule(run(`UPDATE provider.media_assets SET ${set} WHERE media_asset_id = $1`, [id]), 'BYTES_IMMUTABLE');
    await run('UPDATE provider.media_assets SET updated_at = now() WHERE media_asset_id = $1', [id]); // a no-op touch stays legal
    expect((await q<{ status: string }>('SELECT status FROM provider.media_assets WHERE media_asset_id = $1', [id]))[0]!.status).toBe('READY');
  });

  it('never deletes an asset (NO_DELETE) and refuses TRUNCATE (PostgreSQL itself because the attachments reference it, ROW_IMMUTABLE with CASCADE)', async () => {
    const account = await makeAccount();
    const id = await insertAsset(account);
    await expectRule(run('DELETE FROM provider.media_assets WHERE media_asset_id = $1', [id]), 'NO_DELETE');
    await expectRule(run('DELETE FROM provider.media_assets'), 'NO_DELETE');
    expect((await fail(run('TRUNCATE provider.media_assets'))).code).toBe('0A000');
    await expectRule(run('TRUNCATE provider.media_assets CASCADE'), 'ROW_IMMUTABLE');
    expect(await count('provider.media_assets', 'media_asset_id = $1', [id])).toBe(1);
  });

  it('refuses ABANDONED and DELETED while an attachment references the asset, and allows them once it is gone', async () => {
    const g = await makeGig({ media: [{ max: 5 }] });
    const pendingAsset = await insertAsset(g.account);
    const att = await attachId(g.v1, pendingAsset, g.t.media[0]!);
    await expectRule(run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [pendingAsset]), 'ASSET_REFERENCED');
    await run('DELETE FROM provider.gig_version_media WHERE gig_version_media_id = $1', [att]);
    await run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [pendingAsset]);

    const ready = await readyAsset(g.account);
    await attach(g.v1, ready, g.t.media[0]!);
    await expectRule(run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [ready]), 'ASSET_REFERENCED');
    await run('DELETE FROM provider.gig_version_media WHERE media_asset_id = $1', [ready]);
    await run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [ready]);
  });

  it('never lets the bytes of an asset referenced by a PUBLISHED, SUPERSEDED or RETIRED version be deleted (reference-aware, any version status)', async () => {
    const g = await makeGig({ media: [{ behavior: 'PROVIDER_REQUIRED', min: 1, max: 5 }] });
    const asset = await readyAsset(g.account);
    await attach(g.v1, asset, g.t.media[0]!);
    await inTx(async (c) => {
      await fillDraft(g.v1, c);
      await publishFirst(g, c);
    });
    await expectRule(run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [asset]), 'ASSET_REFERENCED');
    const v2 = await inTx(async (c) => {
      const id = (
        (
          await c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, 2, $2) RETURNING gig_version_id', [
            g.gigId,
            g.t.tvId,
          ])
        ).rows[0] as { gig_version_id: string }
      ).gig_version_id;
      await attach(id, asset, g.t.media[0]!, {}, c); // the same READY asset is re-attached, no binary copy
      await fillDraft(id, c);
      await c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_version_id = $1", [g.v1]);
      await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [id]);
      return id;
    });
    expect(await count('provider.gig_version_media', 'media_asset_id = $1', [asset])).toBe(2);
    expect(await versionStatus(g.v1)).toBe('SUPERSEDED');
    await expectRule(run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [asset]), 'ASSET_REFERENCED');
    await inTx(async (c) => {
      await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]);
      await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1 AND status = 'PUBLISHED'", [g.gigId]);
    });
    expect(await versionStatus(v2)).toBe('RETIRED');
    await expectRule(run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [asset]), 'ASSET_REFERENCED');
  });

  it('records the removal of the objects with a one-way marker: settable on ABANDONED and DELETED rows (otherwise frozen), never on a pending or READY row, never cleared or moved', async () => {
    const account = await makeAccount();
    const pending = await insertAsset(account);
    const ready = await readyAsset(account);
    await expectConstraint(
      run('UPDATE provider.media_assets SET objects_removed_at = now() WHERE media_asset_id = $1', [pending]),
      'ck_media_assets__objects_removed',
    );
    await expectConstraint(
      run('UPDATE provider.media_assets SET objects_removed_at = now() WHERE media_asset_id = $1', [ready]),
      'ck_media_assets__objects_removed',
    );
    await run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [pending]);
    await run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [ready]);
    for (const id of [pending, ready]) {
      // the frozen row accepts the marker and nothing else with it
      await expectRule(
        run("UPDATE provider.media_assets SET objects_removed_at = now(), scan_status = 'ERROR' WHERE media_asset_id = $1", [id]),
        'ASSET_FROZEN',
      );
      await expectRule(
        run(`UPDATE provider.media_assets SET status = '${id === pending ? 'DELETED' : 'ABANDONED'}', objects_removed_at = now() WHERE media_asset_id = $1`, [
          id,
        ]),
        'ASSET_FROZEN',
      );
      await run("UPDATE provider.media_assets SET objects_removed_at = '2026-01-01T00:00:00Z' WHERE media_asset_id = $1", [id]);
      expect(await count('provider.media_assets', "media_asset_id = $1 AND objects_removed_at = '2026-01-01T00:00:00Z'", [id])).toBe(1);
      await expectRule(run('UPDATE provider.media_assets SET objects_removed_at = NULL WHERE media_asset_id = $1', [id]), 'MARKER_ONE_WAY');
      await expectRule(run('UPDATE provider.media_assets SET objects_removed_at = now() WHERE media_asset_id = $1', [id]), 'MARKER_ONE_WAY');
      await run('UPDATE provider.media_assets SET objects_removed_at = objects_removed_at WHERE media_asset_id = $1', [id]); // a no-op write of the same value is not a move
      await run('UPDATE provider.media_assets SET upload_key_removed_at = now() WHERE media_asset_id = $1', [id]);
      await expectRule(run("UPDATE provider.media_assets SET status = 'READY' WHERE media_asset_id = $1", [id]), 'ASSET_FROZEN');
    }
  });

  it('records the removal of the upload object with a one-way marker: settable on READY (bytes facts untouched) and terminal rows, never on a pending asset, never cleared or moved', async () => {
    const account = await makeAccount();
    const pending = await insertAsset(account);
    const ready = await readyAsset(account);
    await expectConstraint(
      run('UPDATE provider.media_assets SET upload_key_removed_at = now() WHERE media_asset_id = $1', [pending]),
      'ck_media_assets__upload_key_removed',
    );
    await run("UPDATE provider.media_assets SET upload_key_removed_at = '2026-02-02T00:00:00Z' WHERE media_asset_id = $1", [ready]);
    const row = (
      await q<{ status: string; sha256: string; width: number; scan_status: string }>(
        'SELECT status, sha256, width, scan_status FROM provider.media_assets WHERE media_asset_id = $1',
        [ready],
      )
    )[0]!;
    expect(row).toEqual({ status: 'READY', sha256: 'a'.repeat(64), width: 800, scan_status: 'CLEAN' });
    await expectRule(run('UPDATE provider.media_assets SET upload_key_removed_at = NULL WHERE media_asset_id = $1', [ready]), 'MARKER_ONE_WAY');
    await expectRule(run('UPDATE provider.media_assets SET upload_key_removed_at = now() WHERE media_asset_id = $1', [ready]), 'MARKER_ONE_WAY');
    await expectRule(
      run("UPDATE provider.media_assets SET sha256 = repeat('b', 64), upload_key_removed_at = upload_key_removed_at WHERE media_asset_id = $1", [ready]),
      'BYTES_IMMUTABLE',
    );
    // the marker survives the READY -> DELETED transition and cannot be cleared there either
    await expectRule(
      run("UPDATE provider.media_assets SET status = 'DELETED', upload_key_removed_at = NULL WHERE media_asset_id = $1", [ready]),
      'MARKER_ONE_WAY',
    );
    await run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [ready]);
    expect(await count('provider.media_assets', 'media_asset_id = $1 AND upload_key_removed_at IS NOT NULL', [ready])).toBe(1);
    // a pending asset cannot carry the marker into READY either
    const p2 = await insertAsset(account);
    await expectConstraint(
      run('UPDATE provider.media_assets SET upload_key_removed_at = now() WHERE media_asset_id = $1', [p2]),
      'ck_media_assets__upload_key_removed',
    );
  });

  it('lets an unfinished upload be ABANDONED when every attachment that references it belongs to a RETIRED version (the Gig was retired with the draft), keeps the attachment as history, and still refuses it for any other version status', async () => {
    const g = await makeGig({ media: [{ max: 5 }] });
    const stuck = await insertAsset(g.account);
    const attached = await attachId(g.v1, stuck, g.t.media[0]!);
    // a DRAFT version holds it
    await expectRule(run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [stuck]), 'ASSET_REFERENCED');
    await inTx(async (c) => {
      await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]);
      await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1 AND status IN ('DRAFT', 'PUBLISHED')", [g.gigId]);
    });
    expect(await versionStatus(g.v1)).toBe('RETIRED');
    await run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [stuck]);
    expect((await q<{ status: string }>('SELECT status FROM provider.media_assets WHERE media_asset_id = $1', [stuck]))[0]!.status).toBe('ABANDONED');
    expect(await count('provider.gig_version_media', 'gig_version_media_id = $1', [attached])).toBe(1); // history stays
    await expectRule(run("UPDATE provider.media_assets SET objects_removed_at = now(), status = 'DELETED' WHERE media_asset_id = $1", [stuck]), 'ASSET_FROZEN');

    // the same asset also referenced by a second, OPEN version of another Gig of the owner is NOT abandonable
    const h = await gigFor(g.account, g.t);
    const shared = await insertAsset(g.account);
    await attach(h.v1, shared, g.t.media[0]!);
    const old = await gigFor(g.account, g.t);
    await attach(old.v1, shared, g.t.media[0]!);
    await inTx(async (c) => {
      await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [old.gigId]);
      await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1", [old.gigId]);
    });
    await expectRule(run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [shared]), 'ASSET_REFERENCED');

    // DELETED stays blocked by an attachment of ANY version, including a RETIRED one
    const kept = await readyAsset(g.account);
    const r = await gigFor(g.account, g.t);
    await attach(r.v1, kept, g.t.media[0]!);
    await inTx(async (c) => {
      await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [r.gigId]);
      await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1", [r.gigId]);
    });
    await expectRule(run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [kept]), 'ASSET_REFERENCED');
  });

  it('serves the sweeps with the partial indexes (pending expiry, objects to remove, upload key) and the per-account lookup; the dropped ready_at index is gone', async () => {
    const plan = async (sql: string): Promise<string> => {
      const c = await pool.connect();
      try {
        await c.query('SET enable_seqscan = off');
        return (await c.query(`EXPLAIN ${sql}`)).rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
      } finally {
        c.release();
      }
    };
    expect(
      await plan(
        "SELECT media_asset_id FROM provider.media_assets WHERE status = 'UPLOAD_PENDING' AND upload_expires_at < now() ORDER BY upload_expires_at LIMIT 100",
      ),
    ).toMatch(/idx_media_assets__pending_expiry/);
    expect(
      await plan("SELECT media_asset_id FROM provider.media_assets WHERE status = 'ABANDONED' AND objects_removed_at IS NULL ORDER BY updated_at LIMIT 100"),
    ).toMatch(/idx_media_assets__objects_to_remove/);
    expect(
      await plan(
        "SELECT media_asset_id FROM provider.media_assets WHERE status = 'READY' AND upload_key_removed_at IS NULL AND upload_expires_at < now() ORDER BY upload_expires_at LIMIT 100",
      ),
    ).toMatch(/idx_media_assets__upload_key_sweep/);
    expect(
      await plan("SELECT media_asset_id FROM provider.media_assets WHERE account_id = '00000000-0000-0000-0000-000000000001' AND status = 'ABANDONED'"),
    ).toMatch(/idx_media_assets__account\b/);
    expect(await plan("SELECT 1 FROM provider.gig_version_media WHERE media_asset_id = '00000000-0000-0000-0000-000000000001'")).toMatch(
      /idx_gig_version_media__asset/,
    );
  });
});

// ====================================================================== E. provider.gig_version_media (attachments)
describe('E. provider.gig_version_media', () => {
  it('attaches a READY or UPLOAD_PENDING asset of the Gig account to a MEDIA field of the bound template version and keeps its facts', async () => {
    const g = await makeGig({ media: [{ max: 3 }] });
    const ready = await readyAsset(g.account);
    const pending = await insertAsset(g.account);
    const a = await attachId(g.v1, ready, g.t.media[0]!, { order: 1, alt: 'A shiny car' });
    await attach(g.v1, pending, g.t.media[0]!, { order: 2 });
    expect((await q<Record<string, unknown>>('SELECT * FROM provider.gig_version_media WHERE gig_version_media_id = $1', [a]))[0]).toMatchObject({
      gig_version_id: g.v1,
      media_asset_id: ready,
      gig_template_field_id: g.t.media[0],
      display_order: 1,
      alt_text: 'A shiny car',
    });
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(2);
  });

  it('refuses a field of another template version (FIELD_NOT_IN_TEMPLATE_VERSION) and a field that is not MEDIA (FIELD_TYPE_MISMATCH)', async () => {
    const g = await makeGig({ media: [{ max: 3 }] });
    const foreign = await makeTpl({ media: [{ max: 3 }] });
    const asset = await readyAsset(g.account);
    await expectRule(attach(g.v1, asset, foreign.media[0]!), 'FIELD_NOT_IN_TEMPLATE_VERSION');
    await expectRule(attach(g.v1, asset, g.t.text), 'FIELD_TYPE_MISMATCH');
    await expectConstraint(attach(g.v1, asset, randomUUID()), 'fk_gig_version_media__field_id');
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(0);
  });

  it('refuses a photo for a template version with no MEDIA field and a field with max_items = 0 (MEDIA_PROHIBITED); max_items NULL is unbounded by the template', async () => {
    const g = await makeGig({ media: [{ max: 0 }, { max: null }] });
    const a1 = await readyAsset(g.account);
    await expectRule(attach(g.v1, a1, g.t.media[0]!), 'MEDIA_PROHIBITED');
    for (let i = 1; i <= 6; i++) await attach(g.v1, await readyAsset(g.account), g.t.media[1]!, { order: i });
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(6);
    const none = await makeGig();
    await expectRule(attach(none.v1, await readyAsset(none.account), g.t.media[1]!), 'FIELD_NOT_IN_TEMPLATE_VERSION');
  });

  it('caps each field at its max_items (MEDIA_FIELD_FULL) counting pending attachments, independently per field', async () => {
    const g = await makeGig({ media: [{ max: 2 }, { max: 1 }] });
    await attach(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 1 });
    await attach(g.v1, await insertAsset(g.account), g.t.media[0]!, { order: 2 }); // pending counts
    await expectRule(attach(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 3 }), 'MEDIA_FIELD_FULL');
    await attach(g.v1, await readyAsset(g.account), g.t.media[1]!, { order: 3 }); // the other field has its own cap
    await expectRule(attach(g.v1, await readyAsset(g.account), g.t.media[1]!, { order: 4 }), 'MEDIA_FIELD_FULL');
    // a removal frees a slot
    await run('DELETE FROM provider.gig_version_media WHERE gig_version_id = $1 AND display_order = 2', [g.v1]);
    await attach(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 2 });
  });

  it('refuses an asset of ANOTHER account (ASSET_OWNER) and an abandoned or deleted asset (ASSET_NOT_USABLE); a missing asset is a foreign key failure', async () => {
    const g = await makeGig({ media: [{ max: 5 }] });
    const stranger = await makeAccount();
    await expectRule(attach(g.v1, await readyAsset(stranger), g.t.media[0]!), 'ASSET_OWNER');
    await expectRule(attach(g.v1, await insertAsset(stranger), g.t.media[0]!), 'ASSET_OWNER');
    const abandoned = await insertAsset(g.account);
    await run("UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1", [abandoned]);
    await expectRule(attach(g.v1, abandoned, g.t.media[0]!), 'ASSET_NOT_USABLE');
    const deleted = await readyAsset(g.account);
    await run("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [deleted]);
    await expectRule(attach(g.v1, deleted, g.t.media[0]!), 'ASSET_NOT_USABLE');
    await expectConstraint(attach(g.v1, randomUUID(), g.t.media[0]!), 'fk_gig_version_media__asset_id');
    await expectConstraint(attach(randomUUID(), await readyAsset(g.account), g.t.media[0]!), 'fk_gig_version_media__version_id');
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(0);
  });

  it.each([
    ['display order 0', { order: 0 }, 'ck_gig_version_media__display_order'],
    ['a blank alt text', { alt: '   ' }, 'ck_gig_version_media__alt_text'],
    ['an empty alt text', { alt: '' }, 'ck_gig_version_media__alt_text'],
    ['a 501-character alt text', { alt: 'a'.repeat(501) }, 'ck_gig_version_media__alt_text'],
  ] as const)('refuses %s with the named CHECK, and accepts the boundary of 500 code points', async (_what, o, constraint) => {
    const g = await makeGig({ media: [{ max: 5 }] });
    await expectConstraint(attach(g.v1, await readyAsset(g.account), g.t.media[0]!, o), constraint);
    await attach(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 1, alt: '\u{1F600}'.repeat(500) });
  });

  it('keeps one attachment per asset and one per order in a version, but the same asset in several versions and several Gigs of the owner', async () => {
    const g = await makeGig({ media: [{ max: 5 }] });
    const asset = await readyAsset(g.account);
    await attach(g.v1, asset, g.t.media[0]!, { order: 1 });
    await expectConstraint(attach(g.v1, asset, g.t.media[0]!, { order: 2 }), 'uq_gig_version_media__asset');
    await expectConstraint(attach(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 1 }), 'uq_gig_version_media__order');
    const second = await gigFor(g.account, g.t);
    await attach(second.v1, asset, g.t.media[0]!, { order: 1 });
    expect(await count('provider.gig_version_media', 'media_asset_id = $1', [asset])).toBe(2);
  });

  it('updates only the alt text and the order of a draft attachment; the identity is immutable (id, version, asset, field, creation time)', async () => {
    const g = await makeGig({ media: [{ max: 5 }, { max: 5 }] });
    const asset = await readyAsset(g.account);
    const a = await attachId(g.v1, asset, g.t.media[0]!, { order: 1, alt: 'before' });
    await run("UPDATE provider.gig_version_media SET alt_text = 'after', display_order = 4 WHERE gig_version_media_id = $1", [a]);
    expect(
      (
        await q<{ alt_text: string; display_order: number }>('SELECT alt_text, display_order FROM provider.gig_version_media WHERE gig_version_media_id = $1', [
          a,
        ])
      )[0],
    ).toEqual({ alt_text: 'after', display_order: 4 });
    for (const [set, params] of [
      ['gig_version_media_id = gen_random_uuid()', []],
      ['media_asset_id = $2', [await readyAsset(g.account)]],
      ['gig_template_field_id = $2', [g.t.media[1]]],
      ['gig_version_id = $2', [(await makeGig({ media: [{ max: 5 }] })).v1]],
      ["created_at = created_at + interval '1 day'", []],
    ] as const)
      await expectRule(run(`UPDATE provider.gig_version_media SET ${set} WHERE gig_version_media_id = $1`, [a, ...params]), 'IMMUTABLE_IDENTITY');
  });

  it('lets a whole-order change swap positions in one statement, row by row only with the deferrable constraint deferred', async () => {
    const g = await makeGig({ media: [{ max: 5 }] });
    const a = await attachId(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 1 });
    const b = await attachId(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 2 });
    const orderOf = async (): Promise<number[]> =>
      (
        await q<{ display_order: number }>(
          'SELECT display_order FROM provider.gig_version_media WHERE gig_version_media_id = ANY ($1) ORDER BY gig_version_media_id = $2 DESC',
          [[a, b], a],
        )
      ).map((r) => r.display_order);
    await run('UPDATE provider.gig_version_media SET display_order = 3 - display_order WHERE gig_version_id = $1', [g.v1]);
    expect(await orderOf()).toEqual([2, 1]);
    await expectConstraint(run('UPDATE provider.gig_version_media SET display_order = 1 WHERE gig_version_media_id = $1', [a]), 'uq_gig_version_media__order');
    await inTx(async (c) => {
      await c.query('SET CONSTRAINTS provider.uq_gig_version_media__order DEFERRED');
      await c.query('UPDATE provider.gig_version_media SET display_order = 1 WHERE gig_version_media_id = $1', [a]);
      await c.query('UPDATE provider.gig_version_media SET display_order = 2 WHERE gig_version_media_id = $1', [b]);
    });
    expect(await orderOf()).toEqual([1, 2]);
    // deferred, a genuine duplicate is still refused at commit
    const e = await fail(
      inTx(async (c) => {
        await c.query('SET CONSTRAINTS provider.uq_gig_version_media__order DEFERRED');
        await c.query('UPDATE provider.gig_version_media SET display_order = 1 WHERE gig_version_media_id = $1', [b]);
      }),
    );
    expect(e.constraint).toBe('uq_gig_version_media__order');
  });

  it('freezes the attachments of a PUBLISHED, SUPERSEDED and RETIRED version for insert, update and delete (VERSION_FROZEN); a READY asset is re-attached to the next draft and v1 is untouched', async () => {
    const g = await makeGig({ media: [{ behavior: 'PROVIDER_REQUIRED', min: 1, max: 3 }] });
    const asset = await readyAsset(g.account);
    await attach(g.v1, asset, g.t.media[0]!, { order: 1, alt: 'v1 alt' });
    await inTx(async (c) => {
      await fillDraft(g.v1, c);
      await publishFirst(g, c);
    });
    const frozen = async (version: string) => {
      await expectRule(attach(version, await readyAsset(g.account), g.t.media[0]!, { order: 9 }), 'VERSION_FROZEN');
      await expectRule(run("UPDATE provider.gig_version_media SET alt_text = 'x' WHERE gig_version_id = $1", [version]), 'VERSION_FROZEN');
      await expectRule(run('UPDATE provider.gig_version_media SET display_order = 7 WHERE gig_version_id = $1', [version]), 'VERSION_FROZEN');
      await expectRule(run('DELETE FROM provider.gig_version_media WHERE gig_version_id = $1', [version]), 'VERSION_FROZEN');
    };
    await frozen(g.v1);
    const v2 = await inTx(async (c) => {
      const id = (
        (
          await c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, 2, $2) RETURNING gig_version_id', [
            g.gigId,
            g.t.tvId,
          ])
        ).rows[0] as { gig_version_id: string }
      ).gig_version_id;
      await c.query(
        `INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order, alt_text)
         SELECT $2, media_asset_id, gig_template_field_id, display_order, alt_text FROM provider.gig_version_media WHERE gig_version_id = $1`,
        [g.v1, id],
      );
      return id;
    });
    await run("UPDATE provider.gig_version_media SET alt_text = 'v2 alt' WHERE gig_version_id = $1", [v2]);
    expect((await q<{ alt_text: string }>('SELECT alt_text FROM provider.gig_version_media WHERE gig_version_id = $1', [g.v1]))[0]!.alt_text).toBe('v1 alt');
    await inTx(async (c) => {
      await fillDraft(v2, c);
      await c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_version_id = $1", [g.v1]);
      await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [v2]);
    });
    await frozen(g.v1);
    await frozen(v2);
  });

  it('refuses TRUNCATE (plain and CASCADE) with ROW_IMMUTABLE; an attachment can be deleted on a draft only', async () => {
    const g = await makeGig({ media: [{ max: 3 }] });
    const a = await attachId(g.v1, await readyAsset(g.account), g.t.media[0]!);
    await expectRule(run('TRUNCATE provider.gig_version_media'), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE provider.gig_version_media CASCADE'), 'ROW_IMMUTABLE');
    await run('DELETE FROM provider.gig_version_media WHERE gig_version_media_id = $1', [a]);
    expect(await count('provider.gig_version_media', 'gig_version_media_id = $1', [a])).toBe(0);
  });

  it('serializes concurrent attachments of one version: the second waits for the first and then finds the field full (MEDIA_FIELD_FULL)', async () => {
    const g = await makeGig({ media: [{ max: 1 }] });
    const a1 = await readyAsset(g.account);
    const a2 = await readyAsset(g.account);
    const e = await holdThenRace((c) => attach(g.v1, a1, g.t.media[0]!, { order: 1 }, c), {
      text: 'INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, 2)',
      params: [g.v1, a2, g.t.media[0]],
    });
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:MEDIA_FIELD_FULL' });
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(1);
  });

  it('simultaneous attachments never exceed the maximum (ten racers, three slots)', async () => {
    const g = await makeGig({ media: [{ max: 3 }] });
    const assets = await Promise.all(Array.from({ length: 10 }, () => readyAsset(g.account)));
    const results = await Promise.all(
      assets.map((a, i) =>
        rejection(
          racePool.query(
            'INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, $4)',
            [g.v1, a, g.t.media[0], i + 1],
          ),
        ),
      ),
    );
    (results as (PgFailure | undefined)[]).forEach(notDeadlock);
    expect(results.filter((r) => r === undefined)).toHaveLength(3);
    expect((results as PgFailure[]).filter(Boolean).every((r) => r.detail === 'provider_rule:MEDIA_FIELD_FULL')).toBe(true);
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(3);
  });

  it('serializes an attach with the deletion of the asset: the sweep waits and finds the reference (ASSET_REFERENCED)', async () => {
    const g = await makeGig({ media: [{ max: 3 }] });
    const asset = await readyAsset(g.account);
    const e = await holdThenRace((c) => attach(g.v1, asset, g.t.media[0]!, {}, c), {
      text: "UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1",
      params: [asset],
    });
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:ASSET_REFERENCED' });
    expect((await q<{ status: string }>('SELECT status FROM provider.media_assets WHERE media_asset_id = $1', [asset]))[0]!.status).toBe('READY');
  });

  it('serializes a deletion with an attach: the attach waits and finds the asset no longer usable (ASSET_NOT_USABLE)', async () => {
    const g = await makeGig({ media: [{ max: 3 }] });
    const asset = await readyAsset(g.account);
    const e = await holdThenRace((c) => c.query("UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1", [asset]), {
      text: 'INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, 1)',
      params: [g.v1, asset, g.t.media[0]],
    });
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:ASSET_NOT_USABLE' });
    expect(await count('provider.gig_version_media', 'media_asset_id = $1', [asset])).toBe(0);
  });

  it('does not deadlock against a catalogue transaction that locks template then version (50 interleavings of attach, detach and publish)', async () => {
    const g = await makeGig({ media: [{ behavior: 'PROVIDER_REQUIRED', min: 1, max: 60 }] });
    const t = g.t;
    const catalogue = async (c: pg.PoolClient) => {
      await c.query('SELECT 1 FROM catalog.gig_templates WHERE gig_template_id = $1 FOR UPDATE', [t.tplId]);
      await sleep(2);
      await c.query('SELECT 1 FROM catalog.gig_template_versions WHERE gig_template_version_id = $1 FOR UPDATE', [t.tvId]);
    };
    for (let i = 0; i < 50; i++) {
      const asset = await readyAsset(g.account);
      const [a, b] = (await Promise.all([
        rejection(runRacer(racePool, catalogue)),
        rejection(runRacer(racePool, async (c) => attach(g.v1, asset, t.media[0]!, { order: i + 1 }, c))),
      ])) as (PgFailure | undefined)[];
      notDeadlock(a);
      notDeadlock(b);
      expect(b).toBeUndefined();
    }
    // the publication takes the catalogue locks in the catalogue's order, so it does not deadlock either
    await fillDraft(g.v1);
    const [a, b] = (await Promise.all([rejection(runRacer(racePool, catalogue)), rejection(runRacer(racePool, (c) => publishFirst(g, c)))])) as (
      PgFailure | undefined
    )[];
    notDeadlock(a);
    notDeadlock(b);
    expect(b).toBeUndefined();
    expect(await versionStatus(g.v1)).toBe('PUBLISHED');
  }, 120_000);
});

// ====================================================================== F. publication backstop
describe('F. the publication backstop (provider.check_gig_version_children)', () => {
  const publishOnly = (id: string) => run("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [id]);

  it('refuses a version with a photo that is not READY (MEDIA_NOT_READY) and publishes it once it is', async () => {
    const g = await makeGig({ media: [{ behavior: 'PROVIDER_REQUIRED', min: 1, max: 3 }] });
    await fillDraft(g.v1);
    const asset = await insertAsset(g.account);
    await attach(g.v1, asset, g.t.media[0]!);
    await expectRule(publishOnly(g.v1), 'MEDIA_NOT_READY');
    await makeReady(asset);
    await inTx((c) => publishFirst(g, c));
    expect(await versionStatus(g.v1)).toBe('PUBLISHED');
  });

  it('refuses a version whose required MEDIA field has fewer photos than its minimum (MEDIA_REQUIRED), per field, and counts pending ones as not enough only through MEDIA_NOT_READY', async () => {
    const g = await makeGig({
      media: [
        { behavior: 'PROVIDER_REQUIRED', min: 2, max: 3 },
        { behavior: 'PROVIDER_REQUIRED', min: 1, max: 1 },
        { behavior: 'PROVIDER_CONFIGURABLE', max: 3 },
      ],
    });
    await fillDraft(g.v1);
    await expectRule(publishOnly(g.v1), 'MEDIA_REQUIRED'); // nothing attached
    await attach(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 1 });
    await attach(g.v1, await readyAsset(g.account), g.t.media[1]!, { order: 2 });
    await expectRule(publishOnly(g.v1), 'MEDIA_REQUIRED'); // field 0 needs two
    await attach(g.v1, await readyAsset(g.account), g.t.media[0]!, { order: 3 });
    await inTx((c) => publishFirst(g, c)); // the optional third field needs nothing
    expect(await versionStatus(g.v1)).toBe('PUBLISHED');
  });

  it('publishes a version with no MEDIA field and no photo, and with an optional MEDIA field and no photo (zero is valid)', async () => {
    const none = await makeGig();
    await fillDraft(none.v1);
    await inTx((c) => publishFirst(none, c));
    const optional = await makeGig({ media: [{ max: 3 }] });
    await fillDraft(optional.v1);
    await inTx((c) => publishFirst(optional, c));
    expect(await versionStatus(none.v1)).toBe('PUBLISHED');
    expect(await versionStatus(optional.v1)).toBe('PUBLISHED');
  });

  it('serializes a publication with an in-flight detach: the publication waits for the version lock and then finds the minimum unmet (MEDIA_REQUIRED)', async () => {
    const g = await makeGig({ media: [{ behavior: 'PROVIDER_REQUIRED', min: 1, max: 3 }] });
    await fillDraft(g.v1);
    await attach(g.v1, await readyAsset(g.account), g.t.media[0]!);
    const e = await holdThenRace((c) => c.query('DELETE FROM provider.gig_version_media WHERE gig_version_id = $1', [g.v1]), {
      text: "UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1",
      params: [g.v1],
    });
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:MEDIA_REQUIRED' });
    expect(await versionStatus(g.v1)).toBe('DRAFT');
  });

  it('serializes an attach with an in-flight publication: the attach waits and then finds the version frozen (VERSION_FROZEN)', async () => {
    const g = await makeGig({ media: [{ max: 3 }] });
    await fillDraft(g.v1);
    const asset = await readyAsset(g.account);
    const e = await holdThenRace((c) => publishFirst(g, c), {
      text: 'INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, 1)',
      params: [g.v1, asset, g.t.media[0]],
    });
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:VERSION_FROZEN' });
    expect(await count('provider.gig_version_media', 'gig_version_id = $1', [g.v1])).toBe(0);
  });

  it('keeps every CAT-003 publication rule: the children check runs after the content rules and does not change what a version without children does', async () => {
    const g = await makeGig({ withVariants: true, addOns: true, media: [{ max: 2 }] });
    await fillDraft(g.v1);
    await addItem('gig_version_variants', g.v1, { key: 'opt_v', order: 1 });
    await addItem('gig_version_add_ons', g.v1, { key: 'opt_a', order: 1 });
    await attach(g.v1, await readyAsset(g.account), g.t.media[0]!);
    await inTx((c) => publishFirst(g, c));
    const row = (
      await q<{ revision: number; published_at: Date | null }>('SELECT revision, published_at FROM provider.gig_versions WHERE gig_version_id = $1', [g.v1])
    )[0]!;
    expect(row.published_at).not.toBeNull();
    // the statement that publishes still cannot change anything else
    const h = await makeGig({ media: [{ max: 2 }] });
    await fillDraft(h.v1);
    await expectRule(run("UPDATE provider.gig_versions SET status = 'PUBLISHED', title = 'Other' WHERE gig_version_id = $1", [h.v1]), 'VERSION_FROZEN');
  });
});

// ====================================================================== G. the template permission column
describe('G. catalog.gig_template_versions.pricing_add_ons and the frozen-structure guard', () => {
  const flip = (id: string) => run('UPDATE catalog.gig_template_versions SET pricing_add_ons = NOT pricing_add_ons WHERE gig_template_version_id = $1', [id]);

  it('is changeable while the version is a DRAFT (guards ON)', async () => {
    const t = await makeTpl();
    const draft = await replica((c) => addVersion(c, t.tplId, 2, 'DRAFT'));
    await flip(draft);
    expect(await count('catalog.gig_template_versions', 'gig_template_version_id = $1 AND pricing_add_ons', [draft])).toBe(1);
    await flip(draft);
    expect(await count('catalog.gig_template_versions', 'gig_template_version_id = $1 AND pricing_add_ons', [draft])).toBe(0);
  });

  it('cannot change on an ACTIVE, SUPERSEDED or RETIRED version (VERSION_FROZEN)', async () => {
    const t = await makeTpl();
    for (const status of ['ACTIVE', 'SUPERSEDED', 'RETIRED']) {
      const id = status === 'ACTIVE' ? t.tvId : await replica((c) => addVersion(c, t.tplId, 2 + ['SUPERSEDED', 'RETIRED'].indexOf(status), status));
      const e = await fail(flip(id));
      expect({ code: e.code, detail: e.detail }, status).toEqual({ code: '23000', detail: 'catalog_rule:VERSION_FROZEN' });
    }
    expect(await count('catalog.gig_template_versions', 'gig_template_version_id = $1 AND NOT pricing_add_ons', [t.tvId])).toBe(1);
  });

  it('cannot change in the statement that publishes a draft (VERSION_FROZEN), and the other frozen columns are still frozen', async () => {
    const t = await makeTpl();
    await replica((c) =>
      c.query("UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED', closed_at = now() WHERE gig_template_version_id = $1", [t.tvId]),
    );
    const draft = await replica((c) => addVersion(c, t.tplId, 2, 'DRAFT'));
    const e = await fail(run("UPDATE catalog.gig_template_versions SET status = 'ACTIVE', pricing_add_ons = true WHERE gig_template_version_id = $1", [draft]));
    expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: 'catalog_rule:VERSION_FROZEN' });
    const f = await fail(
      run('UPDATE catalog.gig_template_versions SET pricing_fixed_with_variants = NOT pricing_fixed_with_variants WHERE gig_template_version_id = $1', [
        t.tvId,
      ]),
    );
    expect(f.detail).toBe('catalog_rule:VERSION_FROZEN');
  });

  it('is part of the guard text exactly four times (two frozen tuples and two publication tuples, new and old), next to pricing_drop_eligible', async () => {
    const src = (
      await q<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE pronamespace = 'catalog'::regnamespace AND proname = 'guard_gig_template_versions'")
    )[0]!.src;
    expect(src.match(/NEW\.pricing_add_ons/g)).toHaveLength(2);
    expect(src.match(/OLD\.pricing_add_ons/g)).toHaveLength(2);
    expect(src.match(/pricing_drop_eligible, (NEW|OLD)\.pricing_add_ons/g)).toHaveLength(4);
  });
});

// ====================================================================== H. audit actions
describe('H. the audit action list', () => {
  const insertAudit = (g: G, action: string) =>
    run(
      'INSERT INTO provider.gig_audit_events (actor, account_id, gig_id, gig_version_id, action, changes, correlation_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)',
      [`account:${g.account}`, g.account, g.gigId, g.v1, action, JSON.stringify({ count: 2 }), 'test-correlation'],
    );

  it('accepts every one of the fourteen actions and refuses anything else with the CHECK', async () => {
    const g = await makeGig();
    for (const a of [...OLD_ACTIONS, ...NEW_ACTIONS]) await insertAudit(g, a);
    expect(await count('provider.gig_audit_events', 'gig_id = $1', [g.gigId])).toBe(14);
    for (const bad of ['GIG_MEDIA_DELETED', 'GIG_VARIANT_UPDATED', 'gig_media_attached', ''])
      await expectConstraint(insertAudit(g, bad), 'ck_gig_audit_events__action');
  });

  it('stays immutable: UPDATE, DELETE and TRUNCATE of the trail are refused for the new actions as for the old', async () => {
    const g = await makeGig();
    await insertAudit(g, 'GIG_MEDIA_ATTACHED');
    await expectRule(run("UPDATE provider.gig_audit_events SET actor = 'x' WHERE gig_id = $1", [g.gigId]), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM provider.gig_audit_events WHERE gig_id = $1', [g.gigId]), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE provider.gig_audit_events'), 'ROW_IMMUTABLE');
    expect(await count('provider.gig_audit_events', 'gig_id = $1', [g.gigId])).toBe(1);
  });
});
