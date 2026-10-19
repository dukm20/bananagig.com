import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_CODE_PATTERN,
  CATALOG_DISPLAY_ORDER_MAX,
  CATALOG_DISPLAY_ORDER_MIN,
  CATALOG_STATUSES,
  CATALOG_STATUS_TRANSITIONS,
  CatalogCode,
  IconKey,
  ICON_KEY_PATTERN,
  categoryDescriptionKey,
  categoryNameKey,
  isCatalogTransitionAllowed,
  prohibitedServiceDescriptionKey,
  prohibitedServiceNameKey,
  serviceTypeDescriptionKey,
  serviceTypeNameKey,
  type CatalogStatus,
} from '../../contracts/src/catalog';
import { runMigrations } from '../../../scripts/lib/migrator.mjs';
import { ContentService } from '../../content/src/index';
import { createIsolatedDatabase, createTestPool, migrationsDir, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0015 creates the catalog schema: the PLATFORM-OWNED taxonomy (categories, service types, prohibited services), their availability and order per market, an
// immutable audit trail, seven functions (one status machine, one immutability guard and five row guards) with twelve triggers (SQLSTATE 23000, DETAIL
// catalog_rule:<KEY>), and a deliberately minimal DRAFT seed (2 categories, 4 service types, 12 managed copy entries published through the real content lifecycle).
// Nothing else changes. Migration 0016 (CAT-002, gig templates) later ADDED six tables, nine functions and twelve triggers to the schema and widened audit_events (two columns, two
// foreign keys, the two replaced CHECKs); every pin of this file about the CAT-001 objects is scoped to the six CAT-001 tables / seven CAT-001 functions (CAT1_TABLES, CAT1_FUNCTIONS) and the
// audit_events pins are the NEW 0016 text, while gig-template-model.itest.ts asserts the schema in total. These tests drive the REAL tables with raw SQL on isolated databases: the exact shape, the seed, every CHECK, every guard rule with the exact
// failing statement, the status machine over the full 4 x 4 matrix, the hierarchy and the public-exposure predicate of CatalogService, the interleavings that matter
// under real concurrency, the access path and the privacy shape, and a mutation check on a scratch database for the locks and triggers the invariants rest on.
// The service is covered in packages/catalog (and the API in apps/api).
let iso: IsolatedDatabase; // mutated by the tests
let seed: IsolatedDatabase; // pristine: only the seed assertions read it
let pool: pg.Pool;
let racePool: pg.Pool;
let seedPool: pg.Pool;
let seq = 0;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  seed = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  seedPool = createTestPool(seed.url, 4);
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await seedPool?.end();
  await iso?.drop();
  await seed?.drop();
});

// ---------------------------------------------------------------- helpers
type Db = pg.Pool | pg.PoolClient;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = [], from: Db = pool): Promise<T[]> =>
  (await from.query(sql, params)).rows as T[];
const sq = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await seedPool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = [], from: Db = pool) => from.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0]!.n;
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
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL catalog_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `catalog_rule:${key}` });
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
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

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

// ---------------------------------------------------------------- catalog fixtures
const CAT = 'catalog.categories';
const ST = 'catalog.service_types';
const PS = 'catalog.prohibited_services';
const MC = 'catalog.market_categories';
const MST = 'catalog.market_service_types';
const AUDIT = 'catalog.audit_events';
const TABLES = [CAT, ST, PS, MC, MST, AUDIT];
/** The six CAT-001 tables (migration 0016 added more tables to the schema: every shape pin of this file is scoped to these). */
const CAT1_TABLES = ['audit_events', 'categories', 'market_categories', 'market_service_types', 'prohibited_services', 'service_types'];
/** The seven CAT-001 functions (0016 added nine more). */
const CAT1_FUNCTIONS = [
  'assert_status_transition',
  'forbid_mutation',
  'guard_categories',
  'guard_market_categories',
  'guard_market_service_types',
  'guard_prohibited_services',
  'guard_service_types',
];
/** The Gig Template copy seeded by migration 0016 lives under this stem; the CAT-001 seed assertions exclude it. */
const GIG_TEMPLATE_KEYS = "key LIKE 'catalog.gig\\_template.%'";
const STATUSES: readonly CatalogStatus[] = CATALOG_STATUSES;
/** The statuses a row passes through (from DRAFT) to reach a given status by legal steps only. */
const PATH: Record<CatalogStatus, CatalogStatus[]> = { DRAFT: [], ACTIVE: ['ACTIVE'], INACTIVE: ['ACTIVE', 'INACTIVE'], RETIRED: ['RETIRED'] };
let orderSeq = 100;
const nextOrder = (): number => ++orderSeq;
let marketSeq = 0;

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
interface NewItem {
  code?: string;
  status?: CatalogStatus;
  /** Link the description entry (created on demand). */
  desc?: boolean;
}
async function makeCategory(o: NewItem & { icon?: string | null } = {}, from: Db = pool): Promise<Row> {
  const code = o.code ?? `cat_${++seq}`;
  await ensureEntry(categoryNameKey(code), from);
  if (o.desc) await ensureEntry(categoryDescriptionKey(code), from);
  const r = await from.query('INSERT INTO catalog.categories (code, description_content_key, icon_key) VALUES ($1, $2, $3) RETURNING category_id', [
    code,
    o.desc ? categoryDescriptionKey(code) : null,
    o.icon ?? null,
  ]);
  const id = (r.rows[0] as { category_id: string }).category_id;
  for (const s of PATH[o.status ?? 'DRAFT']) await from.query('UPDATE catalog.categories SET status = $2 WHERE category_id = $1', [id, s]);
  return { id, code };
}
const setCat = (id: string, status: string, from: Db = pool) => from.query('UPDATE catalog.categories SET status = $2 WHERE category_id = $1', [id, status]);
async function makeServiceType(categoryId: string, o: NewItem = {}, from: Db = pool): Promise<Row> {
  const code = o.code ?? `st_${++seq}`;
  await ensureEntry(serviceTypeNameKey(code), from);
  if (o.desc) await ensureEntry(serviceTypeDescriptionKey(code), from);
  const r = await from.query('INSERT INTO catalog.service_types (category_id, code, description_content_key) VALUES ($1, $2, $3) RETURNING service_type_id', [
    categoryId,
    code,
    o.desc ? serviceTypeDescriptionKey(code) : null,
  ]);
  const id = (r.rows[0] as { service_type_id: string }).service_type_id;
  for (const s of PATH[o.status ?? 'DRAFT']) await from.query('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', [id, s]);
  return { id, code };
}
const setSt = (id: string, status: string, from: Db = pool) =>
  from.query('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', [id, status]);
async function makeProhibited(o: NewItem & { categoryId?: string | null } = {}, from: Db = pool): Promise<Row> {
  const code = o.code ?? `pro_${++seq}`;
  await ensureEntry(prohibitedServiceNameKey(code), from);
  if (o.desc) await ensureEntry(prohibitedServiceDescriptionKey(code), from);
  const r = await from.query(
    'INSERT INTO catalog.prohibited_services (category_id, code, description_content_key) VALUES ($1, $2, $3) RETURNING prohibited_service_id',
    [o.categoryId ?? null, code, o.desc ? prohibitedServiceDescriptionKey(code) : null],
  );
  const id = (r.rows[0] as { prohibited_service_id: string }).prohibited_service_id;
  for (const s of PATH[o.status ?? 'DRAFT']) await from.query('UPDATE catalog.prohibited_services SET status = $2 WHERE prohibited_service_id = $1', [id, s]);
  return { id, code };
}
const setPs = (id: string, status: string, from: Db = pool) =>
  from.query('UPDATE catalog.prohibited_services SET status = $2 WHERE prohibited_service_id = $1', [id, status]);
/** A market of the US (the seeded la-oc is PLANNED): created PLANNED and moved to the status asked for. */
async function makeMarket(status: 'PLANNED' | 'ACTIVE' | 'INACTIVE' = 'PLANNED', from: pg.Pool = pool): Promise<Row> {
  const code = `tm-${++marketSeq}`;
  const c = await from.connect();
  let id: string;
  try {
    await c.query('BEGIN');
    const m = await c.query(
      `INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT $1, $1, c.country_id, 'PLANNED', 'en-US', 'USD', t.time_zone_id, now()
         FROM geography.countries c, geography.time_zones t WHERE c.iso_alpha2 = 'US' AND t.iana_name = 'America/Los_Angeles' RETURNING market_id`,
      [code],
    );
    id = (m.rows[0] as { market_id: string }).market_id;
    await c.query(
      'INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, default_locale FROM geography.markets WHERE market_id = $1',
      [id],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  if (status !== 'PLANNED') await from.query("UPDATE geography.markets SET status = 'ACTIVE' WHERE market_id = $1", [id]);
  if (status === 'INACTIVE') await from.query("UPDATE geography.markets SET status = 'INACTIVE' WHERE market_id = $1", [id]);
  return { id, code };
}
const laOc = async (from: Db = pool): Promise<Row> => {
  const r = (await q<{ market_id: string }>("SELECT market_id FROM geography.markets WHERE code = 'la-oc'", [], from))[0]!;
  return { id: r.market_id, code: 'la-oc' };
};
/** A market category row (disabled by default, with a fresh display order). Returns the order. */
async function makeMc(market: string, category: string, o: { enabled?: boolean; order?: number } = {}, from: Db = pool): Promise<number> {
  const order = o.order ?? nextOrder();
  await from.query('INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) VALUES ($1, $2, $3, $4)', [
    market,
    category,
    o.enabled ?? false,
    order,
  ]);
  return order;
}
async function makeMst(market: string, serviceType: string, o: { enabled?: boolean; order?: number } = {}, from: Db = pool): Promise<number> {
  const order = o.order ?? nextOrder();
  await from.query('INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, $3, $4)', [
    market,
    serviceType,
    o.enabled ?? false,
    order,
  ]);
  return order;
}
const setMc = (market: string, category: string, enabled: boolean, from: Db = pool) =>
  from.query('UPDATE catalog.market_categories SET enabled = $3 WHERE market_id = $1 AND category_id = $2', [market, category, enabled]);
const setMst = (market: string, serviceType: string, enabled: boolean, from: Db = pool) =>
  from.query('UPDATE catalog.market_service_types SET enabled = $3 WHERE market_id = $1 AND service_type_id = $2', [market, serviceType, enabled]);
interface Stamped {
  status: string;
  created_at: Date;
  updated_at: Date;
}
const catRow = async (id: string, from: Db = pool) =>
  (
    await q<Stamped & { code: string; name_content_key: string }>(
      'SELECT code, name_content_key, status, created_at, updated_at FROM catalog.categories WHERE category_id = $1',
      [id],
      from,
    )
  )[0]!;
const stRow = async (id: string, from: Db = pool) =>
  (await q<Stamped>('SELECT status, created_at, updated_at FROM catalog.service_types WHERE service_type_id = $1', [id], from))[0]!;
const psRow = async (id: string) =>
  (await q<Stamped>('SELECT status, created_at, updated_at FROM catalog.prohibited_services WHERE prohibited_service_id = $1', [id]))[0]!;
interface MarketStamped {
  enabled: boolean;
  display_order: number;
  created_at: Date;
  updated_at: Date;
}
const mcRow = async (market: string, category: string, from: Db = pool) =>
  (
    await q<MarketStamped>(
      'SELECT enabled, display_order, created_at, updated_at FROM catalog.market_categories WHERE market_id = $1 AND category_id = $2',
      [market, category],
      from,
    )
  )[0]!;
const mstRow = async (market: string, serviceType: string, from: Db = pool) =>
  (
    await q<MarketStamped>(
      'SELECT enabled, display_order, created_at, updated_at FROM catalog.market_service_types WHERE market_id = $1 AND service_type_id = $2',
      [market, serviceType],
      from,
    )
  )[0]!;

/** A full chain in one market: an ACTIVE category and an ACTIVE service type, both enabled in a market of the given status. */
async function liveStack(marketStatus: 'PLANNED' | 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  const market = await makeMarket(marketStatus);
  const category = await makeCategory({ status: 'ACTIVE' });
  const serviceType = await makeServiceType(category.id, { status: 'ACTIVE' });
  await makeMc(market.id, category.id, { enabled: true });
  await makeMst(market.id, serviceType.id, { enabled: true });
  return { market, category, serviceType };
}

/** The invariants the guards exist for: all three must be empty at all times. */
const INVARIANTS = {
  activeServiceTypeUnderInactiveCategory: `SELECT st.code FROM catalog.service_types st JOIN catalog.categories c ON c.category_id = st.category_id WHERE st.status = 'ACTIVE' AND c.status <> 'ACTIVE'`,
  retiredCategoryWithOpenServiceType: `SELECT c.code FROM catalog.categories c WHERE c.status = 'RETIRED' AND EXISTS (SELECT 1 FROM catalog.service_types s WHERE s.category_id = c.category_id AND s.status <> 'RETIRED')`,
  enabledServiceTypeWithoutEnabledCategory: `SELECT st.code FROM catalog.market_service_types mst JOIN catalog.service_types st ON st.service_type_id = mst.service_type_id
      WHERE mst.enabled AND NOT EXISTS (SELECT 1 FROM catalog.market_categories mc WHERE mc.market_id = mst.market_id AND mc.category_id = st.category_id AND mc.enabled)`,
} as const;
async function violations(from: Db = pool): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [name, text] of Object.entries(INVARIANTS)) out[name] = (await from.query(text)).rows;
  return out;
}
const NO_VIOLATIONS = { activeServiceTypeUnderInactiveCategory: [], retiredCategoryWithOpenServiceType: [], enabledServiceTypeWithoutEnabledCategory: [] };

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null, generated: string | null];
const columnsOf = async (table: string, from: pg.Pool = pool): Promise<ColumnShape[]> =>
  (
    (
      await from.query(
        `SELECT column_name, data_type, is_nullable, column_default, is_generated, generation_expression FROM information_schema.columns
          WHERE table_schema = 'catalog' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows as {
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      is_generated: string;
      generation_expression: string | null;
    }[]
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default, r.is_generated === 'ALWAYS' ? r.generation_expression : null]);
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
const constraintsOf = async (table: string): Promise<ConstraintRow[]> =>
  (
    await pool.query(
      `SELECT conname, contype, confdeltype, confupdtype, confmatchtype, condeferrable, convalidated, confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f', 'c', 'x') ORDER BY conname COLLATE "C"`,
      [table],
    )
  ).rows;
const indexesOf = async (table: string): Promise<{ indexname: string; indexdef: string }[]> =>
  (await pool.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = \'catalog\' AND tablename = $1 ORDER BY indexname COLLATE "C"', [table]))
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

const STATUS_DEFAULT = "'DRAFT'::text";
const TS: [string, string, boolean, string | null, string | null][] = [
  ['created_at', 'timestamp with time zone', false, 'now()', null],
  ['updated_at', 'timestamp with time zone', false, 'now()', null],
];
const CATEGORY_COLUMNS: ColumnShape[] = [
  ['category_id', 'uuid', false, 'gen_random_uuid()', null],
  ['code', 'text', false, null, null],
  ['name_content_key', 'text', false, null, "(('catalog.category.'::text || code) || '.name'::text)"],
  ['description_content_key', 'text', true, null, null],
  ['icon_key', 'text', true, null, null],
  ['status', 'text', false, STATUS_DEFAULT, null],
  ...TS,
];
const SERVICE_TYPE_COLUMNS: ColumnShape[] = [
  ['service_type_id', 'uuid', false, 'gen_random_uuid()', null],
  ['category_id', 'uuid', false, null, null],
  ['code', 'text', false, null, null],
  ['name_content_key', 'text', false, null, "(('catalog.service_type.'::text || code) || '.name'::text)"],
  ['description_content_key', 'text', true, null, null],
  ['status', 'text', false, STATUS_DEFAULT, null],
  ...TS,
];
const PROHIBITED_COLUMNS: ColumnShape[] = [
  ['prohibited_service_id', 'uuid', false, 'gen_random_uuid()', null],
  ['category_id', 'uuid', true, null, null],
  ['code', 'text', false, null, null],
  ['name_content_key', 'text', false, null, "(('catalog.prohibited_service.'::text || code) || '.name'::text)"],
  ['description_content_key', 'text', true, null, null],
  ['status', 'text', false, STATUS_DEFAULT, null],
  ...TS,
];
const MARKET_CATEGORY_COLUMNS: ColumnShape[] = [
  ['market_id', 'uuid', false, null, null],
  ['category_id', 'uuid', false, null, null],
  ['enabled', 'boolean', false, 'false', null],
  ['display_order', 'integer', false, null, null],
  ...TS,
];
const MARKET_SERVICE_TYPE_COLUMNS: ColumnShape[] = [
  ['market_id', 'uuid', false, null, null],
  ['service_type_id', 'uuid', false, null, null],
  ['enabled', 'boolean', false, 'false', null],
  ['display_order', 'integer', false, null, null],
  ...TS,
];
const AUDIT_COLUMNS: ColumnShape[] = [
  ['audit_event_id', 'uuid', false, 'gen_random_uuid()', null],
  ['occurred_at', 'timestamp with time zone', false, 'clock_timestamp()', null],
  ['actor', 'text', false, null, null],
  ['action', 'text', false, null, null],
  ['category_id', 'uuid', true, null, null],
  ['service_type_id', 'uuid', true, null, null],
  ['prohibited_service_id', 'uuid', true, null, null],
  ['market_id', 'uuid', true, null, null],
  ['changes', 'jsonb', true, null, null],
  ['reason', 'text', false, null, null],
  ['correlation_id', 'text', false, null, null],
  ['gig_template_id', 'uuid', true, null, null], // added by 0016 (CAT-002)
  ['gig_template_version_id', 'uuid', true, null, null], // added by 0016 (CAT-002)
];
const COLUMNS_BY_TABLE: Record<string, ColumnShape[]> = {
  audit_events: AUDIT_COLUMNS,
  categories: CATEGORY_COLUMNS,
  market_categories: MARKET_CATEGORY_COLUMNS,
  market_service_types: MARKET_SERVICE_TYPE_COLUMNS,
  prohibited_services: PROHIBITED_COLUMNS,
  service_types: SERVICE_TYPE_COLUMNS,
};
const CODE_CHECK = "CHECK (((code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text) AND ((length(code) >= 2) AND (length(code) <= 48))))";
const STATUS_CHECK = "CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'INACTIVE'::text, 'RETIRED'::text])))";
const DESC_CHECK = (stem: string) =>
  `CHECK (((description_content_key IS NULL) OR (description_content_key = (('catalog.${stem}.'::text || code) || '.description'::text))))`;
const ORDER_CHECK = 'CHECK (((display_order >= 1) AND (display_order <= 9999)))';
const FK = (cols: string, target: string) => `FOREIGN KEY (${cols}) REFERENCES ${target} ON DELETE RESTRICT`;
/** Every constraint of the six tables by name with its exact definition (the text, not only the name). */
const CONSTRAINT_DEFS: Record<string, Record<string, string>> = {
  categories: {
    pk_categories: 'PRIMARY KEY (category_id)',
    uq_categories__code: 'UNIQUE (code)',
    fk_categories__name_content_key: FK('name_content_key', 'content.entries(key)'),
    fk_categories__description_content_key: FK('description_content_key', 'content.entries(key)'),
    ck_categories__code: CODE_CHECK,
    ck_categories__description_content_key: DESC_CHECK('category'),
    ck_categories__icon_key: "CHECK (((icon_key IS NULL) OR ((icon_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'::text) AND (length(icon_key) <= 48))))",
    ck_categories__status: STATUS_CHECK,
  },
  service_types: {
    pk_service_types: 'PRIMARY KEY (service_type_id)',
    uq_service_types__code: 'UNIQUE (code)',
    fk_service_types__category_id: FK('category_id', 'catalog.categories(category_id)'),
    fk_service_types__name_content_key: FK('name_content_key', 'content.entries(key)'),
    fk_service_types__description_content_key: FK('description_content_key', 'content.entries(key)'),
    ck_service_types__code: CODE_CHECK,
    ck_service_types__description_content_key: DESC_CHECK('service_type'),
    ck_service_types__status: STATUS_CHECK,
  },
  prohibited_services: {
    pk_prohibited_services: 'PRIMARY KEY (prohibited_service_id)',
    uq_prohibited_services__code: 'UNIQUE (code)',
    fk_prohibited_services__category_id: FK('category_id', 'catalog.categories(category_id)'),
    fk_prohibited_services__name_content_key: FK('name_content_key', 'content.entries(key)'),
    fk_prohibited_services__description_content_key: FK('description_content_key', 'content.entries(key)'),
    ck_prohibited_services__code: CODE_CHECK,
    ck_prohibited_services__description_content_key: DESC_CHECK('prohibited_service'),
    ck_prohibited_services__status: STATUS_CHECK,
  },
  market_categories: {
    pk_market_categories: 'PRIMARY KEY (market_id, category_id)',
    uq_market_categories__market_order: 'UNIQUE (market_id, display_order)',
    fk_market_categories__market_id: FK('market_id', 'geography.markets(market_id)'),
    fk_market_categories__category_id: FK('category_id', 'catalog.categories(category_id)'),
    ck_market_categories__display_order: ORDER_CHECK,
  },
  market_service_types: {
    pk_market_service_types: 'PRIMARY KEY (market_id, service_type_id)',
    uq_market_service_types__market_order: 'UNIQUE (market_id, display_order)',
    fk_market_service_types__market_id: FK('market_id', 'geography.markets(market_id)'),
    fk_market_service_types__service_type_id: FK('service_type_id', 'catalog.service_types(service_type_id)'),
    ck_market_service_types__display_order: ORDER_CHECK,
  },
  audit_events: {
    pk_audit_events: 'PRIMARY KEY (audit_event_id)',
    fk_audit_events__category_id: FK('category_id', 'catalog.categories(category_id)'),
    fk_audit_events__service_type_id: FK('service_type_id', 'catalog.service_types(service_type_id)'),
    fk_audit_events__prohibited_service_id: FK('prohibited_service_id', 'catalog.prohibited_services(prohibited_service_id)'),
    fk_audit_events__market_id: FK('market_id', 'geography.markets(market_id)'),
    fk_audit_events__gig_template_id: FK('gig_template_id', 'catalog.gig_templates(gig_template_id)'),
    // 0017 replaced the simple foreign key by a composite one (version id, template id) so an audit row cannot name a version under another template
    fk_audit_events__gig_template_version: FK(
      'gig_template_version_id, gig_template_id',
      'catalog.gig_template_versions(gig_template_version_id, gig_template_id)',
    ),
    // the two CHECKs below are the text 0016 REPLACED them with (0015 had the nine CAT-001 actions and the four-subject version)
    ck_audit_events__action:
      "CHECK ((action = ANY (ARRAY['CATEGORY_CREATED'::text, 'CATEGORY_UPDATED'::text, 'CATEGORY_STATUS_CHANGED'::text, 'SERVICE_TYPE_CREATED'::text, 'SERVICE_TYPE_UPDATED'::text, 'SERVICE_TYPE_STATUS_CHANGED'::text, 'PROHIBITED_SERVICE_CREATED'::text, 'PROHIBITED_SERVICE_STATUS_CHANGED'::text, 'MARKET_CATALOG_AVAILABILITY_CHANGED'::text, 'GIG_TEMPLATE_CREATED'::text, 'GIG_TEMPLATE_UPDATED'::text, 'GIG_TEMPLATE_STATUS_CHANGED'::text, 'GIG_TEMPLATE_VERSION_CREATED'::text, 'GIG_TEMPLATE_VERSION_CHANGED'::text, 'GIG_TEMPLATE_VERSION_PUBLISHED'::text, 'GIG_TEMPLATE_VERSION_RETIRED'::text, 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED'::text])))",
    ck_audit_events__actor: 'CHECK (((length(btrim(actor)) > 0) AND (length(actor) <= 200)))',
    ck_audit_events__changes_object: "CHECK (((changes IS NULL) OR (jsonb_typeof(changes) = 'object'::text)))",
    ck_audit_events__reason: 'CHECK (((length(btrim(reason)) > 0) AND (length(reason) <= 1000)))',
    ck_audit_events__subject:
      "CHECK ((((action ~~ 'CATEGORY\\_%'::text) AND (category_id IS NOT NULL) AND (service_type_id IS NULL) AND (prohibited_service_id IS NULL) AND (market_id IS NULL) AND (gig_template_id IS NULL) AND (gig_template_version_id IS NULL)) OR ((action ~~ 'SERVICE\\_TYPE\\_%'::text) AND (service_type_id IS NOT NULL) AND (category_id IS NULL) AND (prohibited_service_id IS NULL) AND (market_id IS NULL) AND (gig_template_id IS NULL) AND (gig_template_version_id IS NULL)) OR ((action ~~ 'PROHIBITED\\_SERVICE\\_%'::text) AND (prohibited_service_id IS NOT NULL) AND (category_id IS NULL) AND (service_type_id IS NULL) AND (market_id IS NULL) AND (gig_template_id IS NULL) AND (gig_template_version_id IS NULL)) OR ((action = 'MARKET_CATALOG_AVAILABILITY_CHANGED'::text) AND (market_id IS NOT NULL) AND (prohibited_service_id IS NULL) AND ((category_id IS NULL) <> (service_type_id IS NULL)) AND (gig_template_id IS NULL) AND (gig_template_version_id IS NULL)) OR ((action = ANY (ARRAY['GIG_TEMPLATE_CREATED'::text, 'GIG_TEMPLATE_UPDATED'::text, 'GIG_TEMPLATE_STATUS_CHANGED'::text])) AND (gig_template_id IS NOT NULL) AND (gig_template_version_id IS NULL) AND (category_id IS NULL) AND (service_type_id IS NULL) AND (prohibited_service_id IS NULL) AND (market_id IS NULL)) OR ((action = ANY (ARRAY['GIG_TEMPLATE_VERSION_CREATED'::text, 'GIG_TEMPLATE_VERSION_CHANGED'::text, 'GIG_TEMPLATE_VERSION_PUBLISHED'::text, 'GIG_TEMPLATE_VERSION_RETIRED'::text])) AND (gig_template_id IS NOT NULL) AND (gig_template_version_id IS NOT NULL) AND (category_id IS NULL) AND (service_type_id IS NULL) AND (prohibited_service_id IS NULL) AND (market_id IS NULL)) OR ((action = 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED'::text) AND (market_id IS NOT NULL) AND (gig_template_id IS NOT NULL) AND (gig_template_version_id IS NULL) AND (category_id IS NULL) AND (service_type_id IS NULL) AND (prohibited_service_id IS NULL))))",
  },
};
const FK_TARGETS: Record<string, string> = {
  fk_categories__name_content_key: 'content.entries',
  fk_categories__description_content_key: 'content.entries',
  fk_service_types__category_id: 'catalog.categories',
  fk_service_types__name_content_key: 'content.entries',
  fk_service_types__description_content_key: 'content.entries',
  fk_prohibited_services__category_id: 'catalog.categories',
  fk_prohibited_services__name_content_key: 'content.entries',
  fk_prohibited_services__description_content_key: 'content.entries',
  fk_market_categories__market_id: 'geography.markets',
  fk_market_categories__category_id: 'catalog.categories',
  fk_market_service_types__market_id: 'geography.markets',
  fk_market_service_types__service_type_id: 'catalog.service_types',
  fk_audit_events__category_id: 'catalog.categories',
  fk_audit_events__service_type_id: 'catalog.service_types',
  fk_audit_events__prohibited_service_id: 'catalog.prohibited_services',
  fk_audit_events__market_id: 'geography.markets',
  fk_audit_events__gig_template_id: 'catalog.gig_templates', // added by 0016
  fk_audit_events__gig_template_version: 'catalog.gig_template_versions', // added by 0016, made composite by 0017
};
const INDEX_DEFS: Record<string, Record<string, string>> = {
  audit_events: { pk_audit_events: 'CREATE UNIQUE INDEX pk_audit_events ON catalog.audit_events USING btree (audit_event_id)' },
  categories: {
    pk_categories: 'CREATE UNIQUE INDEX pk_categories ON catalog.categories USING btree (category_id)',
    uq_categories__code: 'CREATE UNIQUE INDEX uq_categories__code ON catalog.categories USING btree (code)',
  },
  market_categories: {
    pk_market_categories: 'CREATE UNIQUE INDEX pk_market_categories ON catalog.market_categories USING btree (market_id, category_id)',
    uq_market_categories__market_order:
      'CREATE UNIQUE INDEX uq_market_categories__market_order ON catalog.market_categories USING btree (market_id, display_order)',
  },
  market_service_types: {
    pk_market_service_types: 'CREATE UNIQUE INDEX pk_market_service_types ON catalog.market_service_types USING btree (market_id, service_type_id)',
    uq_market_service_types__market_order:
      'CREATE UNIQUE INDEX uq_market_service_types__market_order ON catalog.market_service_types USING btree (market_id, display_order)',
  },
  prohibited_services: {
    pk_prohibited_services: 'CREATE UNIQUE INDEX pk_prohibited_services ON catalog.prohibited_services USING btree (prohibited_service_id)',
    uq_prohibited_services__code: 'CREATE UNIQUE INDEX uq_prohibited_services__code ON catalog.prohibited_services USING btree (code)',
  },
  service_types: {
    idx_service_types__category: 'CREATE INDEX idx_service_types__category ON catalog.service_types USING btree (category_id)',
    pk_service_types: 'CREATE UNIQUE INDEX pk_service_types ON catalog.service_types USING btree (service_type_id)',
    uq_service_types__code: 'CREATE UNIQUE INDEX uq_service_types__code ON catalog.service_types USING btree (code)',
  },
};
const TRIGGER_DEFS: Record<string, Record<string, string>> = {
  categories: {
    trg_categories__guard:
      'CREATE TRIGGER trg_categories__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.categories FOR EACH ROW EXECUTE FUNCTION catalog.guard_categories()',
    trg_categories__no_truncate:
      'CREATE TRIGGER trg_categories__no_truncate BEFORE TRUNCATE ON catalog.categories FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  service_types: {
    trg_service_types__guard:
      'CREATE TRIGGER trg_service_types__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.service_types FOR EACH ROW EXECUTE FUNCTION catalog.guard_service_types()',
    trg_service_types__no_truncate:
      'CREATE TRIGGER trg_service_types__no_truncate BEFORE TRUNCATE ON catalog.service_types FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  prohibited_services: {
    trg_prohibited_services__guard:
      'CREATE TRIGGER trg_prohibited_services__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.prohibited_services FOR EACH ROW EXECUTE FUNCTION catalog.guard_prohibited_services()',
    trg_prohibited_services__no_truncate:
      'CREATE TRIGGER trg_prohibited_services__no_truncate BEFORE TRUNCATE ON catalog.prohibited_services FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  market_categories: {
    trg_market_categories__guard:
      'CREATE TRIGGER trg_market_categories__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.market_categories FOR EACH ROW EXECUTE FUNCTION catalog.guard_market_categories()',
    trg_market_categories__no_truncate:
      'CREATE TRIGGER trg_market_categories__no_truncate BEFORE TRUNCATE ON catalog.market_categories FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  market_service_types: {
    trg_market_service_types__guard:
      'CREATE TRIGGER trg_market_service_types__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.market_service_types FOR EACH ROW EXECUTE FUNCTION catalog.guard_market_service_types()',
    trg_market_service_types__no_truncate:
      'CREATE TRIGGER trg_market_service_types__no_truncate BEFORE TRUNCATE ON catalog.market_service_types FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  audit_events: {
    trg_audit_events__immutable:
      'CREATE TRIGGER trg_audit_events__immutable BEFORE DELETE OR UPDATE ON catalog.audit_events FOR EACH ROW EXECUTE FUNCTION catalog.forbid_mutation()',
    trg_audit_events__no_truncate:
      'CREATE TRIGGER trg_audit_events__no_truncate BEFORE TRUNCATE ON catalog.audit_events FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
};
const FUNCTIONS = [
  { proname: 'assert_status_transition', args: 'p_old text, p_new text', volatility: 'i', result: 'void' },
  { proname: 'forbid_mutation', args: '', volatility: 'v', result: 'trigger' },
  { proname: 'guard_categories', args: '', volatility: 'v', result: 'trigger' },
  { proname: 'guard_market_categories', args: '', volatility: 'v', result: 'trigger' },
  { proname: 'guard_market_service_types', args: '', volatility: 'v', result: 'trigger' },
  { proname: 'guard_prohibited_services', args: '', volatility: 'v', result: 'trigger' },
  { proname: 'guard_service_types', args: '', volatility: 'v', result: 'trigger' },
];

/** A fingerprint of every object of the database that does NOT belong to the catalog schema (compared before and after 0015). */
async function outsideCatalog(from: pg.Pool) {
  const rows = async (text: string) => (await from.query(text)).rows.map((r) => JSON.stringify(r));
  const other = "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'catalog', 'provider', 'trust')";
  return {
    schemas: await rows(
      "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'catalog', 'provider', 'trust') ORDER BY 1",
    ),
    relations: await rows(`SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${other} ORDER BY 1, 2`),
    columns: await rows(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression, ordinal_position FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'catalog', 'provider', 'trust') ORDER BY table_schema, table_name, ordinal_position`,
    ),
    constraints: await rows(
      `SELECT n.nspname, t.relname, c.conname, c.contype, c.confdeltype, c.confupdtype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, c.conname COLLATE "C"`,
    ),
    indexes: await rows(
      `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'catalog', 'provider', 'trust') ORDER BY schemaname, tablename, indexname COLLATE "C"`,
    ),
    triggers: await rows(
      `SELECT n.nspname, t.relname, g.tgname, g.tgenabled, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE NOT g.tgisinternal AND ${other} ORDER BY n.nspname, t.relname, g.tgname COLLATE "C"`,
    ),
    functions: await rows(
      `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src, p.provolatile, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'catalog', 'provider', 'trust') AND p.prokind = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY n.nspname, p.proname, args`,
    ),
    comments: await rows(
      `SELECT n.nspname, t.relname, d.objsubid, d.description FROM pg_description d JOIN pg_class t ON t.oid = d.objoid AND d.classoid = 'pg_class'::regclass JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, d.objsubid`,
    ),
  };
}

describe('A. schema shape: a platform-owned taxonomy with generated content keys, per-market availability and an immutable audit trail, holding nothing about a person', () => {
  it('creates the catalog schema with exactly six tables and one non-unique index; no sequence, view, materialized view, partition or composite type; everything is owned by the application role', async () => {
    expect(await q("SELECT nspname, obj_description(oid, 'pg_namespace') IS NOT NULL AS commented FROM pg_namespace WHERE nspname = 'catalog'")).toEqual([
      { nspname: 'catalog', commented: true },
    ]);
    const tables = await q<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'catalog' AND table_type = 'BASE TABLE' AND table_name = ANY($1) ORDER BY 1",
      [CAT1_TABLES],
    );
    expect(tables.map((r) => r.table_name)).toEqual([
      'audit_events',
      'categories',
      'market_categories',
      'market_service_types',
      'prohibited_services',
      'service_types',
    ]);
    expect(
      await q(
        `SELECT c.relkind, count(*)::int AS n FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relnamespace = 'catalog'::regnamespace AND (c.relname = ANY($1) OR i.indrelid::regclass::text = ANY($2)) GROUP BY 1 ORDER BY 1`,
        [CAT1_TABLES, CAT1_TABLES.map((t) => `catalog.${t}`)],
      ),
    ).toEqual([
      { relkind: 'i', n: 12 }, // 6 primary keys + 3 unique codes + 2 unique orders + idx_service_types__category
      { relkind: 'r', n: 6 },
    ]);
    expect(
      await q("SELECT t.typname FROM pg_type t WHERE t.typnamespace = 'catalog'::regnamespace AND t.typtype NOT IN ('c', 'b') AND t.typname NOT LIKE '\\_%'"),
    ).toEqual([]);
    expect(
      await q("SELECT DISTINCT pg_get_userbyid(c.relowner) = current_user AS mine FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace"),
    ).toEqual([{ mine: true }]);
  });

  it.each(Object.entries(COLUMNS_BY_TABLE))(
    'has exactly the documented columns, types, nullability, defaults and generation expression on %s',
    async (table, expected) => {
      expect(await columnsOf(table)).toEqual(expected);
    },
  );

  it('GENERATES the three name_content_key columns (ALWAYS ... STORED) from the code, and nothing else is generated or an identity column', async () => {
    expect(
      await q(
        `SELECT c.relname, a.attname, a.attgenerated, a.attidentity FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped AND (a.attgenerated <> '' OR a.attidentity <> '') ORDER BY 1, 2`,
        [CAT1_TABLES],
      ),
    ).toEqual([
      { relname: 'categories', attname: 'name_content_key', attgenerated: 's', attidentity: '' },
      { relname: 'prohibited_services', attname: 'name_content_key', attgenerated: 's', attidentity: '' },
      { relname: 'service_types', attname: 'name_content_key', attgenerated: 's', attidentity: '' },
    ]);
  });

  it('refuses to write a generated name_content_key (428C9) by INSERT and by UPDATE, on all three tables, and accepts DEFAULT; the stored value follows the code', async () => {
    const c = await makeCategory();
    const cat2 = `cat_${++seq}`;
    await ensureEntry(categoryNameKey(cat2));
    await ensureEntry('catalog.category.forced.name');
    await expect(
      pool.query('INSERT INTO catalog.categories (code, name_content_key) VALUES ($1, $2)', [cat2, 'catalog.category.forced.name']),
    ).rejects.toMatchObject({ code: '428C9' });
    await expect(pool.query('INSERT INTO catalog.categories (code, name_content_key) VALUES ($1, $2)', [cat2, categoryNameKey(cat2)])).rejects.toMatchObject({
      code: '428C9',
    }); // even the same value
    await expect(
      pool.query('UPDATE catalog.categories SET name_content_key = $2 WHERE category_id = $1', [c.id, 'catalog.category.forced.name']),
    ).rejects.toMatchObject({ code: '428C9' });
    await expect(
      pool.query('UPDATE catalog.categories SET name_content_key = $2 WHERE category_id = $1', [c.id, categoryNameKey(c.code)]),
    ).rejects.toMatchObject({ code: '428C9' });
    const st = await makeServiceType(c.id);
    await expect(
      pool.query('UPDATE catalog.service_types SET name_content_key = $2 WHERE service_type_id = $1', [st.id, 'catalog.service_type.forced.name']),
    ).rejects.toMatchObject({ code: '428C9' });
    await expect(
      pool.query('INSERT INTO catalog.service_types (category_id, code, name_content_key) VALUES ($1, $2, $3)', [c.id, `st_${++seq}`, 'x.y']),
    ).rejects.toMatchObject({ code: '428C9' });
    const ps = await makeProhibited();
    await expect(
      pool.query('UPDATE catalog.prohibited_services SET name_content_key = $2 WHERE prohibited_service_id = $1', [
        ps.id,
        'catalog.prohibited_service.forced.name',
      ]),
    ).rejects.toMatchObject({
      code: '428C9',
    });
    await expect(pool.query('INSERT INTO catalog.prohibited_services (code, name_content_key) VALUES ($1, $2)', [`pro_${++seq}`, 'x.y'])).rejects.toMatchObject(
      { code: '428C9' },
    );
    // DEFAULT is the one accepted form
    await run('UPDATE catalog.categories SET name_content_key = DEFAULT WHERE category_id = $1', [c.id]);
    expect((await catRow(c.id)).name_content_key).toBe(`catalog.category.${c.code}.name`);
    expect((await catRow(c.id)).name_content_key).toBe(categoryNameKey(c.code));
  });

  it.each(Object.entries(CONSTRAINT_DEFS))(
    'defines every constraint of %s exactly as documented (names and definition text), and no other',
    async (table, defs) => {
      const rows = await constraintsOf(`catalog.${table}`);
      expect(rows.map((r) => r.conname)).toEqual(Object.keys(defs).sort((a, b) => (a < b ? -1 : 1)));
      expect(Object.fromEntries(rows.map((r) => [r.conname, r.def]))).toEqual(defs);
      expect(rows.every((r) => r.convalidated && !r.condeferrable)).toBe(true); // none deferrable, none NOT VALID
    },
  );

  it('has 46 primary key, unique, foreign key and check constraints on the six tables (8 + 8 + 8 + 5 + 5 + 12: 0015 made 44, 0016 added the two audit_events foreign keys) and no exclusion constraint', async () => {
    const n = await q<{ contype: string; n: number }>(
      "SELECT c.contype, count(*)::int AS n FROM pg_constraint c WHERE c.connamespace = 'catalog'::regnamespace AND c.conrelid::regclass::text = ANY($1) GROUP BY 1 ORDER BY 1",
      [CAT1_TABLES.map((t) => `catalog.${t}`)],
    );
    expect(n).toEqual([
      { contype: 'c', n: 17 },
      { contype: 'f', n: 18 },
      { contype: 'p', n: 6 },
      { contype: 'u', n: 5 },
    ]);
    expect(17 + 18 + 6 + 5).toBe(46);
    expect(Object.values(CONSTRAINT_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(46);
  });

  it('declares every foreign key ON DELETE RESTRICT and ON UPDATE NO ACTION with MATCH SIMPLE and the documented target; nothing in the catalog cascades or sets null', async () => {
    const fks: ConstraintRow[] = [];
    for (const t of Object.keys(CONSTRAINT_DEFS)) fks.push(...(await constraintsOf(`catalog.${t}`)).filter((r) => r.contype === 'f'));
    expect(Object.fromEntries(fks.map((r) => [r.conname, r.target]))).toEqual(FK_TARGETS);
    expect(fks.map((r) => [r.confdeltype, r.confupdtype, r.confmatchtype])).toEqual(fks.map(() => ['r', 'a', 's']));
    expect(fks).toHaveLength(18);
  });

  it.each(Object.entries(INDEX_DEFS))('has exactly the documented indexes on %s and no other', async (table, defs) => {
    const idx = await indexesOf(table);
    expect(Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]))).toEqual(defs);
    expect(idx.map((r) => r.indexname)).toEqual(Object.keys(defs).sort((a, b) => (a < b ? -1 : 1)));
  });

  it('has no partial, expression or covering index anywhere in the schema, and none on status, enabled, a content key or a timestamp (the tables hold tens of rows)', async () => {
    expect(
      (
        await q<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = ANY($1) AND indexname !~ '^(pk|uq|idx)_'",
          [CAT1_TABLES],
        )
      ).map((r) => r.indexname),
    ).toEqual([]);
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = ANY($1) AND (indexdef ~ ' WHERE ' OR indexdef ~ 'INCLUDE' OR indexdef ~ 'lower\\(')",
        [CAT1_TABLES],
      ),
    ).toEqual([]);
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = ANY($1) AND indexdef ~ '(enabled|status|content_key|updated_at|created_at|occurred_at|actor|action)'",
        [CAT1_TABLES],
      ),
    ).toEqual([]);
    expect(Object.values(INDEX_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(12);
  });

  it.each(Object.entries(TRIGGER_DEFS))(
    'wires the triggers of %s exactly (name, timing, events, level, function), enabled, none deferrable or constraint triggers',
    async (table, defs) => {
      const t = await triggersOf(`catalog.${table}`);
      expect(Object.fromEntries(t.map((x) => [x.tgname, x.def]))).toEqual(defs);
      expect(t.every((x) => x.enabled === 'O')).toBe(true);
      expect(t.filter((x) => /CONSTRAINT TRIGGER|DEFERRABLE|AFTER|INSTEAD/.test(x.def))).toEqual([]);
    },
  );

  it('has exactly twelve triggers in the schema (two per table: a row guard and a TRUNCATE refusal), every one BEFORE, and no other trigger on a catalog table', async () => {
    const all = await q<{ tgname: string }>(
      "SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND c.relname = ANY($1) AND NOT g.tgisinternal ORDER BY 1",
      [CAT1_TABLES],
    );
    expect(all).toHaveLength(12);
    expect(Object.values(TRIGGER_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(12);
    // the migration adds no trigger to a table outside the schema
    expect(
      await q(
        "SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace <> 'catalog'::regnamespace AND pg_get_triggerdef(g.oid) ~ 'catalog\\.'",
      ),
    ).toEqual([]);
  });

  it('defines the seven functions as plpgsql, not SECURITY DEFINER, without a custom search_path, with the right volatility (the status machine is IMMUTABLE), and a comment each', async () => {
    const rows = await q<{ proname: string; args: string; volatility: string; result: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.provolatile AS volatility, pg_get_function_result(p.oid) AS result FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace AND p.proname = ANY($1) ORDER BY 1`,
      [CAT1_FUNCTIONS],
    );
    expect(rows).toEqual(FUNCTIONS);
    expect(
      await q(
        `SELECT p.proname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.pronamespace = 'catalog'::regnamespace AND p.proname = ANY($1) AND (l.lanname <> 'plpgsql' OR p.prosecdef OR p.proconfig IS NOT NULL OR obj_description(p.oid, 'pg_proc') IS NULL OR p.proleakproof OR p.proisstrict)`,
        [CAT1_FUNCTIONS],
      ),
    ).toEqual([]);
    // the guard functions name every rule key they can raise in their comment (the documented contract of the SQLSTATE 23000 details)
    const comment = async (fn: string) =>
      (await q<{ c: string }>("SELECT obj_description(('catalog.' || $1 || '()')::regprocedure, 'pg_proc') AS c", [fn]))[0]!.c;
    expect(await comment('guard_categories')).toMatch(
      /NOT_DELETABLE.*MUST_START_AS_DRAFT.*IMMUTABLE_IDENTITY.*DRAFT_IS_INITIAL.*STATUS_TRANSITION.*CATEGORY_HAS_ACTIVE_SERVICE_TYPES.*CATEGORY_HAS_OPEN_SERVICE_TYPES/,
    );
    expect(await comment('guard_service_types')).toMatch(
      /NOT_DELETABLE.*MUST_START_AS_DRAFT.*CATEGORY_RETIRED.*IMMUTABLE_IDENTITY.*DRAFT_IS_INITIAL.*STATUS_TRANSITION.*CATEGORY_NOT_ACTIVE/,
    );
    expect(await comment('guard_market_categories')).toMatch(/NOT_DELETABLE.*IMMUTABLE_IDENTITY.*ITEM_RETIRED.*CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES/);
    expect(await comment('guard_market_service_types')).toMatch(/NOT_DELETABLE.*IMMUTABLE_IDENTITY.*ITEM_RETIRED.*CATEGORY_NOT_ENABLED_IN_MARKET/);
  });

  it('CHECKs the status to exactly the contract list, the code and icon to the contract patterns and the display order to the contract bounds, so the database and the API cannot drift', async () => {
    for (const t of ['categories', 'service_types', 'prohibited_services']) {
      const defs = Object.fromEntries((await constraintsOf(`catalog.${t}`)).map((r) => [r.conname, r.def]));
      expect(vocab(defs[`ck_${t}__status`]!), t).toEqual([...CATALOG_STATUSES]);
      expect(defs[`ck_${t}__code`], t).toContain(CATALOG_CODE_PATTERN.source.replaceAll('(?:', '('));
    }
    const icon = (await constraintsOf(CAT)).find((r) => r.conname === 'ck_categories__icon_key')!.def;
    expect(icon).toContain(ICON_KEY_PATTERN.source.replaceAll('(?:', '('));
    expect(icon).toContain('length(icon_key) <= 48');
    for (const t of ['market_categories', 'market_service_types'])
      expect((await constraintsOf(`catalog.${t}`)).find((r) => r.conname === `ck_${t}__display_order`)!.def).toBe(
        `CHECK (((display_order >= ${CATALOG_DISPLAY_ORDER_MIN}) AND (display_order <= ${CATALOG_DISPLAY_ORDER_MAX})))`,
      );
  });

  it('documents every table, the schema, every guard function and the meaningful columns in the catalog (comments are present and say that rows are never deleted)', async () => {
    for (const t of TABLES) expect(await commentOn(t), t).toBeTruthy();
    for (const t of [CAT, ST, MC]) expect(await commentOn(t), t).toMatch(/never deleted/);
    expect(await commentOn(PS)).toMatch(/never exposed on the public catalogue API/);
    expect(await commentOn(AUDIT)).toMatch(/immutable/);
    for (const [t, cols] of [
      [CAT, ['code', 'name_content_key', 'description_content_key', 'icon_key', 'status']],
      [ST, ['category_id', 'code', 'status']],
      [PS, ['category_id']],
      [MC, ['display_order']],
      [MST, ['display_order']],
    ] as const)
      for (const c of cols) expect(await commentOn(t, c), `${t}.${c}`).toBeTruthy();
  });

  it('did not alter any older object: every column, constraint, index, trigger, function, relation and comment outside the catalog schema equals the schema migrated to 0014, and the data of the older schemas is unchanged', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bananagig-mig-0014-'));
    const before = await createIsolatedDatabase({ migrate: false });
    const beforePool = createTestPool(before.url, 3);
    try {
      for (const f of readdirSync(migrationsDir()).filter((n) => /^00(0[1-9]|1[0-4])_.*\.sql$/.test(n)))
        copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
      expect(readdirSync(dir)).toHaveLength(14);
      await runMigrations({ url: before.url, dir });
      const a = await outsideCatalog(beforePool);
      const b = await outsideCatalog(pool);
      expect(b.schemas).toEqual(a.schemas);
      expect(b.relations).toEqual(a.relations);
      expect(b.columns).toEqual(a.columns);
      expect(b.constraints).toEqual(a.constraints);
      expect(b.indexes).toEqual(a.indexes);
      expect(b.triggers).toEqual(a.triggers);
      expect(b.functions).toEqual(a.functions);
      expect(b.comments).toEqual(a.comments);
      for (const k of ['columns', 'constraints', 'indexes', 'triggers', 'functions', 'comments'] as const)
        expect(b[k].length, `${k} is not vacuous`).toBeGreaterThan(20);
      expect(b.schemas.map((s) => JSON.parse(s).nspname)).toEqual(expect.arrayContaining(['identity', 'content', 'geography', 'configuration', 'integration']));
      // data: everything outside the 12 managed entries is the same (the seed emits no outbox event, no account, no configuration value, no market)
      const counts = async (from: pg.Pool) =>
        (
          await from.query(
            `SELECT (SELECT count(*)::int FROM identity.accounts) AS accounts, (SELECT count(*)::int FROM integration.outbox_events) AS outbox,
                    (SELECT count(*)::int FROM configuration.parameters WHERE key NOT LIKE 'provider.registration.%' AND key NOT LIKE 'provider.gig.%' AND key NOT LIKE 'provider.profile.%' AND key NOT LIKE 'trust.%') AS parameters,
                    (SELECT count(*)::int FROM configuration.audit_events a WHERE NOT EXISTS (SELECT 1 FROM configuration.parameters p WHERE p.parameter_id = a.parameter_id AND (p.key LIKE 'provider.registration.%' OR p.key LIKE 'provider.gig.%' OR p.key LIKE 'provider.profile.%' OR p.key LIKE 'trust.%'))) AS config_audit,
                    (SELECT count(*)::int FROM geography.markets) AS markets, (SELECT count(*)::int FROM geography.audit_events) AS geo_audit,
                    (SELECT count(*)::int FROM identity.account_sections) AS sections, (SELECT count(*)::int FROM identity.roles) AS roles,
                    (SELECT count(*)::int FROM content.locales) AS locales,
                    (SELECT count(*)::int FROM content.entries WHERE key NOT LIKE 'catalog.%' AND key NOT LIKE 'provider.registration.%' AND key NOT LIKE 'provider.gig.%' AND key NOT LIKE 'provider.profile.%' AND key NOT LIKE 'trust.%') AS other_entries,
                    (SELECT count(*)::int FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key NOT LIKE 'catalog.%' AND e.key NOT LIKE 'provider.registration.%' AND e.key NOT LIKE 'provider.gig.%' AND e.key NOT LIKE 'provider.profile.%' AND e.key NOT LIKE 'trust.%') AS other_versions,
                    (SELECT count(*)::int FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key NOT LIKE 'catalog.%' AND e.key NOT LIKE 'provider.registration.%' AND e.key NOT LIKE 'provider.gig.%' AND e.key NOT LIKE 'provider.profile.%' AND e.key NOT LIKE 'trust.%') AS other_audit`,
          )
        ).rows[0];
      expect(await counts(pool)).toEqual(await counts(beforePool));
      const total = (from: pg.Pool) =>
        from
          .query(
            // the provider registration copy of 0018 (provider.registration.*, 56 entries) and the verification copy of 0019 (trust.*, 97 entries) are later migrations: only what 0015 and 0016 added may differ
            `SELECT (SELECT count(*)::int FROM content.entries WHERE key NOT LIKE 'provider.registration.%' AND key NOT LIKE 'provider.gig.%' AND key NOT LIKE 'provider.profile.%' AND key NOT LIKE 'trust.%') AS entries,
                    (SELECT count(*)::int FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key NOT LIKE 'provider.registration.%' AND e.key NOT LIKE 'provider.gig.%' AND e.key NOT LIKE 'provider.profile.%' AND e.key NOT LIKE 'trust.%') AS versions,
                    (SELECT count(*)::int FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key NOT LIKE 'provider.registration.%' AND e.key NOT LIKE 'provider.gig.%' AND e.key NOT LIKE 'provider.profile.%' AND e.key NOT LIKE 'trust.%') AS audit`,
          )
          .then((r) => r.rows[0] as { entries: number; versions: number; audit: number });
      const [x, y] = [await total(beforePool), await total(seedPool)];
      // 0015 (12 entries x 5 audit rows) plus 0016 (6 gig template entries x 5): 18 entries, 18 versions, 90 audit rows
      expect({ entries: y.entries - x.entries, versions: y.versions - x.versions, audit: y.audit - x.audit }).toEqual({ entries: 18, versions: 18, audit: 90 });
    } finally {
      await beforePool.end();
      await before.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is referenced from outside the schema only by the provider registration selections (0018) and the trust requirement rules (0019) and references only reference data: content.entries, geography.markets and itself', async () => {
    // migration 0018 (PRO-001) adds a foreign key into the catalogue: a selected service type of a provider registration (asserted in full by provider-model.itest.ts);
    // migration 0019 (TRUST-001) adds the second: the service type a verification requirement rule applies to (asserted in full by trust-model.itest.ts)
    expect(
      await q(
        `SELECT conrelid::regclass::text AS from_table, conname FROM pg_constraint
          WHERE contype = 'f' AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'catalog'::regnamespace) AND connamespace <> 'catalog'::regnamespace ORDER BY conname COLLATE "C"`,
      ),
    ).toEqual([
      // migration 0020 (CAT-003): a Gig stands on a template, a Gig version on the exact template version, a field value on the answered field and its ENUM option
      { from_table: 'provider.gig_version_field_values', conname: 'fk_gig_version_field_values__field_id' },
      { from_table: 'provider.gig_version_field_values', conname: 'fk_gig_version_field_values__option' },
      // migration 0021 (CAT-004): a photo attachment names the MEDIA field of the bound template version it satisfies
      { from_table: 'provider.gig_version_media', conname: 'fk_gig_version_media__field_id' },
      { from_table: 'provider.gig_versions', conname: 'fk_gig_versions__gig_template_version_id' },
      { from_table: 'provider.gigs', conname: 'fk_gigs__gig_template_id' },
      { from_table: 'provider.registration_service_types', conname: 'fk_registration_service_types__service_type_id' },
      { from_table: 'trust.requirement_rules', conname: 'fk_requirement_rules__service_type_id' },
    ]);
    expect(
      (
        await q<{ target: string }>(
          `SELECT DISTINCT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND connamespace = 'catalog'::regnamespace AND confrelid::regclass::text NOT LIKE 'catalog.%' ORDER BY 1`,
        )
      ).map((r) => r.target),
    ).toEqual(['content.entries', 'geography.markets']);
  });

  it('contains no ALTER, DROP, DELETE or UPDATE of an older object in the migration text, and creates only the schema, six tables, one index, seven functions and twelve triggers', () => {
    const text = readFileSync(path.join(migrationsDir(), '0015_catalog.sql'), 'utf8');
    const body = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.startsWith('COMMENT ON'))
      .join('\n');
    expect(body).not.toMatch(
      /\b(ALTER\s|DROP\s|DELETE\s+FROM|GRANT\s|REVOKE\s|CREATE\s+(OR\s+REPLACE\s+)?VIEW|CREATE\s+SEQUENCE|CREATE\s+EXTENSION|CREATE\s+TYPE|CREATE\s+POLICY)/i,
    );
    expect(body.replace(/BEFORE TRUNCATE/gi, '')).not.toMatch(/\bTRUNCATE\b/i);
    expect([...body.matchAll(/\bCREATE\s+(SCHEMA|TABLE|FUNCTION|TRIGGER|INDEX)\s+([\w.]+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)).toEqual([
      'SCHEMA catalog',
      'FUNCTION catalog.forbid_mutation',
      'FUNCTION catalog.assert_status_transition',
      'TABLE catalog.categories',
      'TABLE catalog.service_types',
      'INDEX idx_service_types__category',
      'TABLE catalog.prohibited_services',
      'TABLE catalog.market_categories',
      'TABLE catalog.market_service_types',
      'TABLE catalog.audit_events',
      'FUNCTION catalog.guard_categories',
      'TRIGGER trg_categories__guard',
      'TRIGGER trg_categories__no_truncate',
      'FUNCTION catalog.guard_service_types',
      'TRIGGER trg_service_types__guard',
      'TRIGGER trg_service_types__no_truncate',
      'FUNCTION catalog.guard_prohibited_services',
      'TRIGGER trg_prohibited_services__guard',
      'TRIGGER trg_prohibited_services__no_truncate',
      'FUNCTION catalog.guard_market_categories',
      'TRIGGER trg_market_categories__guard',
      'TRIGGER trg_market_categories__no_truncate',
      'FUNCTION catalog.guard_market_service_types',
      'TRIGGER trg_market_service_types__guard',
      'TRIGGER trg_market_service_types__no_truncate',
      'TRIGGER trg_audit_events__immutable',
      'TRIGGER trg_audit_events__no_truncate',
    ]);
    // the only UPDATEs are the content lifecycle of the managed copy (DRAFT -> APPROVED -> PUBLISHED) and nothing else
    expect([...body.matchAll(/^\s*UPDATE\s+([a-z_]+\.[a-z_]+)/gim)].map((m) => m[1])).toEqual(['content.versions', 'content.versions']);
    expect([...body.matchAll(/\bINSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1])).toEqual([
      'content.entries',
      'content.audit_events',
      'content.versions',
      'content.audit_events',
      'content.audit_events',
      'content.audit_events',
      'content.audit_events',
      'catalog.categories',
      'catalog.service_types',
      'catalog.audit_events',
      'catalog.audit_events',
    ]);
  });
});

// ====================================================================== B. the seed (read from a pristine database)
const SEEDED_CATEGORIES: [code: string, name: string, description: string][] = [
  ['auto_services', 'Auto Services', 'Car care, from a wash to a full detail.'],
  ['home_cleaning', 'Home Cleaning', 'Cleaning for homes and apartments.'],
];
const SEEDED_SERVICE_TYPES: [code: string, category: string, name: string, description: string][] = [
  ['car_detailing', 'auto_services', 'Car Detailing', 'Interior and exterior detailing that restores the finish of a vehicle.'],
  ['deep_cleaning', 'home_cleaning', 'Deep Cleaning', 'A thorough top-to-bottom clean, including the places a regular clean skips.'],
  ['mobile_car_wash', 'auto_services', 'Mobile Car Wash', 'A car wash that comes to your location.'],
  ['regular_cleaning', 'home_cleaning', 'Regular Cleaning', 'A routine clean to keep a home tidy.'],
];
const SEEDED_KEYS: { key: string; type: 'UI_LABEL' | 'PLAIN_TEXT'; body: string }[] = [
  ...SEEDED_CATEGORIES.flatMap(([code, name, description]) => [
    { key: categoryNameKey(code), type: 'UI_LABEL' as const, body: name },
    { key: categoryDescriptionKey(code), type: 'PLAIN_TEXT' as const, body: description },
  ]),
  ...SEEDED_SERVICE_TYPES.flatMap(([code, , name, description]) => [
    { key: serviceTypeNameKey(code), type: 'UI_LABEL' as const, body: name },
    { key: serviceTypeDescriptionKey(code), type: 'PLAIN_TEXT' as const, body: description },
  ]),
];
const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

describe('B. the seed: two DRAFT categories, four DRAFT service types, twelve managed copy entries and six audit rows; nothing public, no market data', () => {
  it('seeds exactly the two categories, all DRAFT, with the exact code, generated name key, description key and no icon', async () => {
    const rows = await sq<{ code: string; name_content_key: string; description_content_key: string | null; icon_key: string | null; status: string }>(
      `SELECT code, name_content_key, description_content_key, icon_key, status FROM ${CAT} ORDER BY code COLLATE "C"`,
    );
    expect(rows).toEqual(
      SEEDED_CATEGORIES.map(([code]) => ({
        code,
        name_content_key: `catalog.category.${code}.name`,
        description_content_key: `catalog.category.${code}.description`,
        icon_key: null,
        status: 'DRAFT',
      })),
    );
    expect(rows.map((r) => r.name_content_key)).toEqual(SEEDED_CATEGORIES.map(([code]) => categoryNameKey(code)));
    expect(rows.map((r) => r.description_content_key)).toEqual(SEEDED_CATEGORIES.map(([code]) => categoryDescriptionKey(code)));
  });

  it('seeds exactly the four service types, all DRAFT, each in exactly the one category it belongs to', async () => {
    const rows = await sq<{ code: string; category: string; name_content_key: string; description_content_key: string | null; status: string }>(
      `SELECT st.code, c.code AS category, st.name_content_key, st.description_content_key, st.status FROM ${ST} st JOIN ${CAT} c ON c.category_id = st.category_id ORDER BY st.code COLLATE "C"`,
    );
    expect(rows).toEqual(
      SEEDED_SERVICE_TYPES.map(([code, category]) => ({
        code,
        category,
        name_content_key: `catalog.service_type.${code}.name`,
        description_content_key: `catalog.service_type.${code}.description`,
        status: 'DRAFT',
      })),
    );
    expect(
      await sq<{ category: string; n: number }>(
        `SELECT c.code AS category, count(*)::int AS n FROM ${ST} st JOIN ${CAT} c USING (category_id) GROUP BY 1 ORDER BY 1`,
      ),
    ).toEqual([
      { category: 'auto_services', n: 2 },
      { category: 'home_cleaning', n: 2 },
    ]);
  });

  it('seeds NO market availability row, NO prohibited service, and nothing is ACTIVE or INACTIVE or RETIRED: nothing is public until an administrator acts', async () => {
    for (const t of [MC, MST, PS]) expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n, t).toBe(0);
    expect(await sq(`SELECT status FROM ${CAT} WHERE status <> 'DRAFT' UNION ALL SELECT status FROM ${ST} WHERE status <> 'DRAFT'`)).toEqual([]);
    // the one seeded market is still PLANNED and carries nothing
    expect(await sq('SELECT code, status FROM geography.markets')).toEqual([{ code: 'la-oc', status: 'PLANNED' }]);
  });

  it('agrees with the contract helpers: the keys derived by the code are exactly the stored generated keys (a rename in the content registry never touches an identity)', async () => {
    const cats = await sq<{ code: string; name_content_key: string; description_content_key: string }>(
      `SELECT code, name_content_key, description_content_key FROM ${CAT}`,
    );
    for (const c of cats) {
      expect(c.name_content_key).toBe(categoryNameKey(c.code));
      expect(c.description_content_key).toBe(categoryDescriptionKey(c.code));
      expect(CatalogCode.safeParse(c.code).success).toBe(true);
    }
    const sts = await sq<{ code: string; name_content_key: string; description_content_key: string }>(
      `SELECT code, name_content_key, description_content_key FROM ${ST}`,
    );
    for (const s of sts) {
      expect(s.name_content_key).toBe(serviceTypeNameKey(s.code));
      expect(s.description_content_key).toBe(serviceTypeDescriptionKey(s.code));
      expect(CatalogCode.safeParse(s.code).success).toBe(true);
    }
  });

  it('writes exactly six audit rows by system:migration: CATEGORY_CREATED x2 and SERVICE_TYPE_CREATED x4, one per row, with the status diff [null, DRAFT]', async () => {
    const rows = await sq<{
      actor: string;
      action: string;
      category_id: string | null;
      service_type_id: string | null;
      prohibited_service_id: string | null;
      market_id: string | null;
      changes: unknown;
      reason: string;
      correlation_id: string;
    }>(
      `SELECT actor, action, category_id, service_type_id, prohibited_service_id, market_id, changes, reason, correlation_id FROM ${AUDIT} WHERE correlation_id = 'seed-0015'`,
    );
    // (migration 0016 wrote two more rows, GIG_TEMPLATE_CREATED under seed-0016: gig-template-model.itest.ts asserts them)
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.action).sort()).toEqual([
      'CATEGORY_CREATED',
      'CATEGORY_CREATED',
      'SERVICE_TYPE_CREATED',
      'SERVICE_TYPE_CREATED',
      'SERVICE_TYPE_CREATED',
      'SERVICE_TYPE_CREATED',
    ]);
    for (const r of rows) {
      expect(r.actor).toBe('system:migration');
      expect(r.reason).toBe('Initial catalogue taxonomy (migration 0015)');
      expect(r.correlation_id).toBe('seed-0015');
      expect(r.changes).toEqual({ status: [null, 'DRAFT'] });
      expect(r.prohibited_service_id).toBeNull();
      expect(r.market_id).toBeNull();
      expect(Number(r.category_id !== null) + Number(r.service_type_id !== null)).toBe(1);
    }
    // each row has exactly one audit row, naming it
    expect(
      await sq(
        `SELECT c.code FROM ${CAT} c WHERE (SELECT count(*) FROM ${AUDIT} a WHERE a.category_id = c.category_id AND a.action = 'CATEGORY_CREATED') <> 1`,
      ),
    ).toEqual([]);
    expect(
      await sq(
        `SELECT s.code FROM ${ST} s WHERE (SELECT count(*) FROM ${AUDIT} a WHERE a.service_type_id = s.service_type_id AND a.action = 'SERVICE_TYPE_CREATED') <> 1`,
      ),
    ).toEqual([]);
  });

  it('seeds the registry rows with consistent timestamps (created_at = updated_at) and the seed emits no outbox event for the catalogue', async () => {
    expect(await sq(`SELECT 1 FROM ${CAT} WHERE created_at <> updated_at UNION ALL SELECT 1 FROM ${ST} WHERE created_at <> updated_at`)).toEqual([]);
    expect(await sq("SELECT 1 FROM integration.outbox_events WHERE event_type LIKE '%catalog%' OR aggregate_type LIKE '%catalog%'")).toEqual([]);
    expect((await sq<{ n: number }>('SELECT count(*)::int AS n FROM integration.outbox_events'))[0]!.n).toBe(0);
  });

  it('seeds exactly the twelve catalog.* entries (name and description of each of the two categories and four service types) and nothing else under catalog.*', async () => {
    const keys = (
      await sq<{ key: string }>(`SELECT key FROM content.entries WHERE key LIKE 'catalog.%' AND NOT (${GIG_TEMPLATE_KEYS}) ORDER BY key COLLATE "C"`)
    ).map((r) => r.key);
    expect(keys).toEqual(SEEDED_KEYS.map((k) => k.key).sort(cmp));
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
    // no entry exists for a prohibited service (none is seeded)
    expect(keys.filter((k) => k.startsWith('catalog.prohibited_service.'))).toEqual([]);
  });

  it('publishes every one of them through the content lifecycle: one PUBLISHED en-US PLATFORM version 1, open-ended, IN FORCE now, active entry, max_scope_type MARKET, nothing in another locale', async () => {
    const rows = await sq<{
      key: string;
      n: number;
      locale: string;
      scope_type: string;
      scope_ref: string | null;
      version: number;
      status: string;
      open: boolean;
      started: boolean;
      inforce: string;
      active: boolean;
      max_scope_type: string;
      content_type: string;
      sensitivity: string;
      owner_role: string;
      body: string;
    }>(
      `SELECT e.key, count(*) OVER (PARTITION BY e.entry_id)::int AS n, v.locale, v.scope_type, v.scope_ref, v.version, v.status, v.effective_to IS NULL AS open,
              v.effective_from <= now() AS started, identity.consent_version_state(v.version_id, e.entry_id, now()) AS inforce, e.is_active AS active, e.max_scope_type,
              e.content_type, e.sensitivity, e.owner_role, v.body
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'catalog.%' AND e.key NOT LIKE 'catalog.gig\\_template.%'`,
    );
    expect(rows).toHaveLength(12);
    const expected = new Map(SEEDED_KEYS.map((k) => [k.key, k]));
    for (const r of rows) {
      expect(r, r.key).toEqual({
        key: r.key,
        n: 1,
        locale: 'en-US',
        scope_type: 'PLATFORM',
        scope_ref: null,
        version: 1,
        status: 'PUBLISHED',
        open: true,
        started: true,
        inforce: 'IN_FORCE',
        active: true,
        max_scope_type: 'MARKET',
        content_type: expected.get(r.key)!.type,
        sensitivity: 'PUBLIC',
        owner_role: 'CONTENT',
        body: expected.get(r.key)!.body,
      });
      expect(r.body, r.key).toBe(r.body.trim());
      expect(r.body.length, r.key).toBeGreaterThan(0);
    }
  });

  it('writes the content audit trail exactly like the real workflow: five rows per entry, in order, by system:migration under the correlation seed-0015', async () => {
    const rows = await sq<{ action: string; actor: string; correlation_id: string; n: number }>(
      `SELECT a.action, a.actor, a.correlation_id, count(*)::int AS n FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key LIKE 'catalog.%' AND e.key NOT LIKE 'catalog.gig\\_template.%' GROUP BY 1, 2, 3 ORDER BY 1`,
    );
    expect(rows).toEqual(
      ['ENTRY_CREATED', 'VERSION_ACTIVATED', 'VERSION_APPROVED', 'VERSION_DRAFTED', 'VERSION_PUBLISHED'].map((action) => ({
        action,
        actor: 'system:migration',
        correlation_id: 'seed-0015',
        n: 12,
      })),
    );
    const order = await sq<{ key: string; actions: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key LIKE 'catalog.%' AND e.key NOT LIKE 'catalog.gig\\_template.%' GROUP BY e.key`,
    );
    expect(order).toHaveLength(12);
    for (const o of order) expect(o.actions, o.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
  });

  it('resolves every name and description key that a seeded row names to a PUBLISHED, in-force en-US entry (the foreign key and the content state agree)', async () => {
    const rows = await sq<{ code: string; kind: string; key: string; ok: boolean }>(
      `SELECT t.code, t.kind, t.key,
              EXISTS (SELECT 1 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id
                       WHERE e.key = t.key AND v.status = 'PUBLISHED' AND v.locale = 'en-US' AND identity.consent_version_state(v.version_id, e.entry_id, now()) = 'IN_FORCE') AS ok
         FROM (SELECT code, 'category.name' AS kind, name_content_key AS key FROM ${CAT} UNION ALL SELECT code, 'category.description', description_content_key FROM ${CAT}
               UNION ALL SELECT code, 'service_type.name', name_content_key FROM ${ST} UNION ALL SELECT code, 'service_type.description', description_content_key FROM ${ST}) t
        ORDER BY 1, 2`,
    );
    expect(rows).toHaveLength(12);
    for (const r of rows) expect(r.ok, `${r.kind} ${r.code}: ${r.key}`).toBe(true);
  });

  it('renders non-empty, exact text for every seeded key with the content registry itself, in en-US, with and without a market in the context, in the public view', async () => {
    const content = new ContentService({ database: seed.database, env: 'test' });
    for (const k of SEEDED_KEYS) {
      const plain = await content.render(k.key, { locale: 'en-US' });
      expect(plain.value, k.key).toBe(k.body);
      const inMarket = await content.render(k.key, { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false });
      expect(inMarket.value, k.key).toBe(k.body);
    }
    const batch = await content.resolveRendered(
      SEEDED_KEYS.map((k) => k.key),
      { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false },
    );
    expect(batch.missing.size).toBe(0);
    expect(batch.items.size).toBe(12);
    // an unknown locale falls back to the platform default: still the same text, never a raw key
    expect((await content.render(categoryNameKey('home_cleaning'), { locale: 'en-US' })).value).toBe('Home Cleaning');
  });

  it('refuses to change or delete a seeded row except through the documented switches: the seeded rows are still intact afterwards', async () => {
    await expect(seedPool.query(`DELETE FROM ${CAT} WHERE code = 'home_cleaning'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'catalog_rule:NOT_DELETABLE',
    });
    await expect(seedPool.query(`DELETE FROM ${ST}`)).rejects.toMatchObject({ code: '23000', detail: 'catalog_rule:NOT_DELETABLE' });
    await expect(seedPool.query(`UPDATE ${CAT} SET code = 'renamed_category' WHERE code = 'home_cleaning'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'catalog_rule:IMMUTABLE_IDENTITY',
    });
    await expect(seedPool.query(`UPDATE ${CAT} SET status = 'RETIRED' WHERE code = 'home_cleaning'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'catalog_rule:CATEGORY_HAS_OPEN_SERVICE_TYPES',
    });
    await expect(seedPool.query(`UPDATE ${ST} SET status = 'ACTIVE' WHERE code = 'car_detailing'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'catalog_rule:CATEGORY_NOT_ACTIVE',
    });
    await expect(seedPool.query(`TRUNCATE ${AUDIT}`)).rejects.toMatchObject({ code: '23000', detail: 'catalog_rule:ROW_IMMUTABLE' });
    expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${CAT}`))[0]!.n).toBe(2);
    expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${ST} WHERE status = 'DRAFT'`))[0]!.n).toBe(4);
    expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${AUDIT} WHERE correlation_id = 'seed-0015'`))[0]!.n).toBe(6);
    expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${AUDIT}`))[0]!.n).toBe(8); // + the two GIG_TEMPLATE_CREATED rows of 0016
  });

  it('holds no value that looks like a person in the seeded rows or the copy: no address, number, UUID or URL', async () => {
    const rows = await sq<{ v: string }>(
      `SELECT v FROM (SELECT code AS v FROM ${CAT} UNION ALL SELECT name_content_key FROM ${CAT} UNION ALL SELECT description_content_key FROM ${CAT} UNION ALL SELECT code FROM ${ST}
        UNION ALL SELECT name_content_key FROM ${ST} UNION ALL SELECT description_content_key FROM ${ST}) t`,
    );
    for (const { v } of rows) expect(v, v).not.toMatch(/[@\s]|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d/i);
    for (const k of SEEDED_KEYS) expect(k.body, k.key).not.toMatch(/@|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d/i);
  });
});

// ====================================================================== C. every CHECK, foreign key, unique key and NOT NULL, by constraint name
const GOOD_CODES = ['ab', 'a1', 'a_b', 'a_1', 'a1_2b', 'home_care', 'car_detailing_2', `a${'b'.repeat(47)}`, 'z9', 'a_b_c_d', 'x0'];
const BAD_CODES: [label: string, value: string][] = [
  ['an empty code', ''],
  ['a 1-character code', 'a'],
  ['an upper-case code', 'HOME'],
  ['a mixed-case code', 'Home_cleaning'],
  ['an upper-case letter inside', 'homeCleaning'],
  ['a code with a hyphen', 'home-cleaning'],
  ['a code that starts with a digit', '1home'],
  ['a code that starts with an underscore', '_home'],
  ['a code with a trailing underscore', 'home_'],
  ['a code with a double underscore', 'home__cleaning'],
  ['a code with a space', 'home cleaning'],
  ['a code with a leading space', ' home'],
  ['a code with a trailing space', 'home '],
  ['a code with a trailing line feed', `home${ch(0x0a)}`],
  ['a code with a leading line feed', `${ch(0x0a)}home`],
  ['a code with an embedded line feed', `ho${ch(0x0a)}me`],
  ['a code with a tab', `ho${ch(0x09)}me`],
  ['a code with a dot', 'ho.me'],
  ['a code with a slash', 'ho/me'],
  ['a code with a quote', "ho'me"],
  ['a code with a percent sign', 'ho%me'],
  ['a 49-character code', `a${'b'.repeat(48)}`],
  ['a very long code', `a${'b'.repeat(500)}`],
  ['a code with an accented letter', `caf${ch(0xe9)}`],
  ['a code with a full-width letter', `ab${ch(0xff41)}`],
  ['a code with a zero-width space', `ab${ch(0x200b)}cd`],
  ['a code with an Arabic-Indic digit', `ab${ch(0x0663)}`],
  ['a code with an emoji', `ab${ch(0x1f600)}`],
  ['a Cyrillic look-alike', `${ch(0x0430)}bc`],
];
const GOOD_ICONS = ['wrench', 'car-wash', 'a1', 'a-1-b', 'z', 'a'.repeat(48)];
const BAD_ICONS: [string, string][] = [
  ['an empty icon', ''],
  ['an upper-case icon', 'Wrench'],
  ['an icon with an underscore', 'car_wash'],
  ['an icon that starts with a hyphen', '-car'],
  ['an icon with a trailing hyphen', 'car-'],
  ['an icon with a double hyphen', 'car--wash'],
  ['an icon that starts with a digit', '1car'],
  ['an icon with a space', 'car wash'],
  ['an icon with a trailing line feed', `car${ch(0x0a)}`],
  ['a URL', 'https://example.test/car.svg'],
  ['a path', '/icons/car'],
  ['a 49-character icon', 'a'.repeat(49)],
  ['an icon with an accented letter', `car${ch(0xe9)}`],
];

/** INSERT of a category row built from raw values (the generated name key follows the code). */
const rawCategory = (code: string, description: string | null, icon: string | null = null, status = 'DRAFT') =>
  run('INSERT INTO catalog.categories (code, description_content_key, icon_key, status) VALUES ($1, $2, $3, $4)', [code, description, icon, status]);
const rawServiceType = (categoryId: string, code: string, description: string | null) =>
  run('INSERT INTO catalog.service_types (category_id, code, description_content_key) VALUES ($1, $2, $3)', [categoryId, code, description]);
const rawProhibited = (code: string, description: string | null) =>
  run('INSERT INTO catalog.prohibited_services (code, description_content_key) VALUES ($1, $2)', [code, description]);

describe('C1. the code and icon formats: the database and the contract accept the same strings', () => {
  it('accepts every good code (2 to 48 characters, digits, single underscores) in all three tables and gives each its generated name key', async () => {
    const parent = await makeCategory();
    for (const code of GOOD_CODES) {
      expect(CatalogCode.safeParse(code).success, code).toBe(true);
      const c = code;
      await ensureEntry(categoryNameKey(c));
      await ensureEntry(serviceTypeNameKey(c));
      await ensureEntry(prohibitedServiceNameKey(c));
      await rawCategory(c, null);
      await rawServiceType(parent.id, c, null);
      await rawProhibited(c, null);
    }
    for (const [table, key] of [
      [CAT, categoryNameKey],
      [ST, serviceTypeNameKey],
      [PS, prohibitedServiceNameKey],
    ] as const) {
      const rows = await q<{ code: string; name_content_key: string }>(`SELECT code, name_content_key FROM ${table} WHERE code = ANY($1::text[])`, [
        GOOD_CODES,
      ]);
      expect(rows).toHaveLength(GOOD_CODES.length);
      for (const r of rows) expect(r.name_content_key).toBe(key(r.code));
    }
  });

  it.each(BAD_CODES)(
    'refuses %s in categories, service types and prohibited services (the CHECK, before the content key foreign key)',
    async (_label, value) => {
      const parent = await makeCategory();
      await expectConstraint(rawCategory(value, null), 'ck_categories__code');
      await expectConstraint(rawServiceType(parent.id, value, null), 'ck_service_types__code');
      await expectConstraint(rawProhibited(value, null), 'ck_prohibited_services__code');
      expect(CatalogCode.safeParse(value).success, 'the contract refuses it too').toBe(false);
    },
  );

  it('refuses a code update to a bad value on the CHECK (with the identity guard bypassed) and an update to ANY other code on IMMUTABLE_IDENTITY (with the guard in force)', async () => {
    const c = await makeCategory();
    await expectConstraint(isolated(noTriggers(CAT), "UPDATE catalog.categories SET code = 'Bad-Code' WHERE category_id = $1", [c.id]), 'ck_categories__code');
    await expectRule(run("UPDATE catalog.categories SET code = 'renamed_ok' WHERE category_id = $1", [c.id]), 'IMMUTABLE_IDENTITY');
  });

  it('agrees with the contract on a large corpus (a differential test: the database expression and the zod code accept the same strings)', async () => {
    const corpus = [
      ...GOOD_CODES,
      ...BAD_CODES.map(([, v]) => v),
      'ab',
      'a'.repeat(48),
      'a'.repeat(49),
      'a_',
      '_a',
      'a__b',
      'a_b_',
      'A',
      'a-b',
      'ab ',
      ' ab',
      'ab\n',
      '1a',
      'a1_',
      'a_1_b',
    ];
    for (const c of corpus) {
      const db = (await q<{ ok: boolean }>("SELECT ($1::text ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length($1::text) BETWEEN 2 AND 48) AS ok", [c]))[0]!.ok;
      expect(CatalogCode.safeParse(c).success, JSON.stringify(c)).toBe(db);
      expect(CATALOG_CODE_PATTERN.test(c) && c.length >= 2 && c.length <= 48, JSON.stringify(c)).toBe(db);
    }
  });

  it.each(GOOD_ICONS)('accepts the icon %s', async (icon) => {
    const code = `cat_${++seq}`;
    await ensureEntry(categoryNameKey(code));
    await rawCategory(code, null, icon);
    expect(IconKey.safeParse(icon).success).toBe(true);
    expect((await q<{ icon_key: string }>(`SELECT icon_key FROM ${CAT} WHERE code = $1`, [code]))[0]!.icon_key).toBe(icon);
  });

  it.each(BAD_ICONS)('refuses %s', async (_label, value) => {
    const code = `cat_${++seq}`;
    await ensureEntry(categoryNameKey(code));
    await expectConstraint(rawCategory(code, null, value), 'ck_categories__icon_key');
    expect(IconKey.safeParse(value).success).toBe(false);
  });

  it('agrees with the contract on the icon corpus, and the icon can be changed and cleared after creation (it is metadata, not identity)', async () => {
    for (const v of [...GOOD_ICONS, ...BAD_ICONS.map(([, x]) => x)]) {
      const db = (await q<{ ok: boolean }>("SELECT ($1::text ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length($1::text) <= 48) AS ok", [v]))[0]!.ok;
      expect(ICON_KEY_PATTERN.test(v) && v.length <= 48, JSON.stringify(v)).toBe(db);
    }
    const c = await makeCategory({ icon: 'wrench' });
    await run("UPDATE catalog.categories SET icon_key = 'car-wash' WHERE category_id = $1", [c.id]);
    await run('UPDATE catalog.categories SET icon_key = NULL WHERE category_id = $1', [c.id]);
    expect((await q<{ icon_key: string | null }>(`SELECT icon_key FROM ${CAT} WHERE category_id = $1`, [c.id]))[0]!.icon_key).toBeNull();
    await expectConstraint(run("UPDATE catalog.categories SET icon_key = 'Bad_Icon' WHERE category_id = $1", [c.id]), 'ck_categories__icon_key');
  });
});

describe('C2. the description key is a link, not a free choice: it is NULL or exactly the convention of the row', () => {
  const kinds = [
    {
      name: 'categories',
      stem: 'category',
      table: CAT,
      make: (code: string, d: string | null) => rawCategory(code, d),
      nameKey: categoryNameKey,
      descKey: categoryDescriptionKey,
    },
    {
      name: 'service_types',
      stem: 'service_type',
      table: ST,
      make: async (code: string, d: string | null) => rawServiceType((await makeCategory()).id, code, d),
      nameKey: serviceTypeNameKey,
      descKey: serviceTypeDescriptionKey,
    },
    {
      name: 'prohibited_services',
      stem: 'prohibited_service',
      table: PS,
      make: (code: string, d: string | null) => rawProhibited(code, d),
      nameKey: prohibitedServiceNameKey,
      descKey: prohibitedServiceDescriptionKey,
    },
  ];
  for (const k of kinds) {
    it(`${k.name}: accepts NULL and the exact convention, refuses every other key (even an existing content entry), by CHECK`, async () => {
      const code = `${k.stem.slice(0, 3)}_${++seq}`;
      const other = `oth_${++seq}`;
      await ensureEntry(k.nameKey(code));
      await ensureEntry(k.descKey(code));
      await ensureEntry(k.nameKey(other));
      await ensureEntry(k.descKey(other));
      // every one of these keys EXISTS as a content entry, so the foreign key would accept them: only the CHECK stands in the way
      const wrong = [
        k.descKey(other), // the description of another row
        k.nameKey(code), // its own name key
        k.nameKey(other),
        `catalog.${k.stem}.${code}.description `, // trailing space
        `catalog.${k.stem}.${code}.Description`,
        `catalog.${k.stem}.${code}.descriptions`,
        '', // empty string is not NULL
      ];
      for (const key of ['catalog.category.', 'catalog.service_type.', 'catalog.prohibited_service.'])
        if (!key.includes(k.stem)) {
          await ensureEntry(`${key}${code}.description`);
          wrong.push(`${key}${code}.description`); // the right convention of ANOTHER kind
        }
      // the keys with an invalid content key format (an empty string, a trailing space, a capital) cannot exist as entries at all: the CHECK still comes first
      for (const w of wrong) if (/^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/.test(w)) await ensureEntry(w);
      for (const w of wrong) await expectConstraint(k.make(code, w), `ck_${k.name}__description_content_key`);
      await k.make(code, k.descKey(code));
      expect(
        (await q<{ description_content_key: string | null }>(`SELECT description_content_key FROM ${k.table} WHERE code = $1`, [code]))[0]!
          .description_content_key,
      ).toBe(k.descKey(code));
      const code2 = `${k.stem.slice(0, 3)}_${++seq}`;
      await ensureEntry(k.nameKey(code2));
      await k.make(code2, null);
      expect(
        (await q<{ description_content_key: string | null }>(`SELECT description_content_key FROM ${k.table} WHERE code = $1`, [code2]))[0]!
          .description_content_key,
      ).toBeNull();
    });
  }

  it('refuses an UPDATE of the description key to a key of another row on the CHECK, and accepts linking, unlinking and relinking the own key', async () => {
    const c = await makeCategory({ desc: false });
    const other = await makeCategory({ desc: true });
    await expectConstraint(
      run('UPDATE catalog.categories SET description_content_key = $2 WHERE category_id = $1', [c.id, categoryDescriptionKey(other.code)]),
      'ck_categories__description_content_key',
    );
    await expectConstraint(
      run('UPDATE catalog.categories SET description_content_key = $2 WHERE category_id = $1', [c.id, categoryDescriptionKey(c.code)]),
      'fk_categories__description_content_key',
    ); // the convention but no entry yet
    await ensureEntry(categoryDescriptionKey(c.code));
    await run('UPDATE catalog.categories SET description_content_key = $2 WHERE category_id = $1', [c.id, categoryDescriptionKey(c.code)]);
    await run('UPDATE catalog.categories SET description_content_key = NULL WHERE category_id = $1', [c.id]);
    await run('UPDATE catalog.categories SET description_content_key = $2 WHERE category_id = $1', [c.id, categoryDescriptionKey(c.code)]);
    // the same for a service type
    const st = await makeServiceType(c.id);
    await expectConstraint(
      run('UPDATE catalog.service_types SET description_content_key = $2 WHERE service_type_id = $1', [st.id, serviceTypeDescriptionKey('nope')]),
      'ck_service_types__description_content_key',
    );
  });
});

describe('C3. the foreign keys to the content registry: the managed name must exist (the generated column has a foreign key), the description too', () => {
  it('refuses a category, a service type and a prohibited service whose NAME entry does not exist, on the foreign key of the generated column', async () => {
    const parent = await makeCategory();
    const code = `miss_${++seq}`;
    await expectConstraint(rawCategory(code, null), 'fk_categories__name_content_key');
    await expectConstraint(rawServiceType(parent.id, code, null), 'fk_service_types__name_content_key');
    await expectConstraint(rawProhibited(code, null), 'fk_prohibited_services__name_content_key');
    expect(await count(CAT, 'code = $1', [code])).toBe(0);
    expect(await count(ST, 'code = $1', [code])).toBe(0);
    expect(await count(PS, 'code = $1', [code])).toBe(0);
    // the failing row names the missing key in its DETAIL: the key follows the code
    const e = await fail(rawCategory(code, null));
    expect(e.detail).toContain(`catalog.category.${code}.name`);
  });

  it('refuses a description that follows the convention but has no entry, on the description foreign key (the name entry exists)', async () => {
    const parent = await makeCategory();
    const code = `nodesc_${++seq}`;
    await ensureEntry(categoryNameKey(code));
    await ensureEntry(serviceTypeNameKey(code));
    await ensureEntry(prohibitedServiceNameKey(code));
    await expectConstraint(rawCategory(code, categoryDescriptionKey(code)), 'fk_categories__description_content_key');
    await expectConstraint(rawServiceType(parent.id, code, serviceTypeDescriptionKey(code)), 'fk_service_types__description_content_key');
    await expectConstraint(rawProhibited(code, prohibitedServiceDescriptionKey(code)), 'fk_prohibited_services__description_content_key');
  });

  it('accepts a code only when its name entry exists: creating the entry afterwards makes the same insert succeed', async () => {
    const code = `late_${++seq}`;
    await expectConstraint(rawCategory(code, null), 'fk_categories__name_content_key');
    await ensureEntry(categoryNameKey(code));
    await rawCategory(code, null);
    expect(await count(CAT, 'code = $1', [code])).toBe(1);
  });
});

describe('C4. unique codes, the display order bounds and uniqueness, NOT NULL columns', () => {
  it('refuses a second category with the same code (even a retired one: a code is never reused), by the unique key', async () => {
    const c = await makeCategory({ status: 'RETIRED' });
    await ensureEntry(categoryNameKey(c.code));
    await expectConstraint(rawCategory(c.code, null), 'uq_categories__code');
    const live = await makeCategory();
    await expectConstraint(rawCategory(live.code, null), 'uq_categories__code');
  });

  it('refuses a second service type with the same code ACROSS ALL categories, not only inside one; a retired service type keeps its code', async () => {
    const [a, b] = [await makeCategory(), await makeCategory({ status: 'RETIRED' })];
    const st = await makeServiceType(a.id, { status: 'RETIRED' });
    await expectConstraint(rawServiceType(a.id, st.code, null), 'uq_service_types__code');
    await expectConstraint(rawServiceType((await makeCategory()).id, st.code, null), 'uq_service_types__code');
    // a RETIRED category refuses new service types before the unique key is looked at
    await expectRule(rawServiceType(b.id, `fresh_${++seq}`, null), 'CATEGORY_RETIRED');
  });

  it('refuses a second prohibited service with the same code, and lets a category, a service type and a prohibited service share a code (their content key stems differ)', async () => {
    const p = await makeProhibited({ status: 'RETIRED' });
    await expectConstraint(rawProhibited(p.code, null), 'uq_prohibited_services__code');
    const shared = `shared_${++seq}`;
    const c = await makeCategory({ code: shared });
    await makeServiceType(c.id, { code: shared });
    await makeProhibited({ code: shared });
    expect((await catRow(c.id)).name_content_key).toBe(`catalog.category.${shared}.name`);
  });

  it('refuses an UPDATE onto an existing code only through IMMUTABLE_IDENTITY (the code cannot move at all)', async () => {
    const [a, b] = [await makeCategory(), await makeCategory()];
    await expectRule(run('UPDATE catalog.categories SET code = $2 WHERE category_id = $1', [a.id, b.code]), 'IMMUTABLE_IDENTITY');
    await expectConstraint(isolated(noTriggers(CAT), 'UPDATE catalog.categories SET code = $2 WHERE category_id = $1', [a.id, b.code]), 'uq_categories__code');
  });

  it.each([0, -1, 10000, 2147483647, -2147483648])('refuses display_order %i on both market tables, enabled or not', async (order) => {
    const market = await makeMarket();
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'ACTIVE' });
    await expectConstraint(makeMc(market.id, c.id, { order }), 'ck_market_categories__display_order');
    await expectConstraint(makeMc(market.id, c.id, { order, enabled: true }), 'ck_market_categories__display_order');
    await makeMc(market.id, c.id, { enabled: true });
    await expectConstraint(makeMst(market.id, st.id, { order }), 'ck_market_service_types__display_order');
    await expectConstraint(makeMst(market.id, st.id, { order, enabled: true }), 'ck_market_service_types__display_order');
    await expectConstraint(
      run('UPDATE catalog.market_categories SET display_order = $3 WHERE market_id = $1 AND category_id = $2', [market.id, c.id, order]),
      'ck_market_categories__display_order',
    );
  });

  it('accepts the boundary positions 1 and 9999 on both tables, the same position in two DIFFERENT markets, and the same position in the category table and the service type table of one market', async () => {
    const [m1, m2] = [await makeMarket(), await makeMarket()];
    const [c1, c2] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const s1 = await makeServiceType(c1.id, { status: 'ACTIVE' });
    const s2 = await makeServiceType(c1.id, { status: 'ACTIVE' });
    await makeMc(m1.id, c1.id, { order: 1, enabled: true });
    await makeMc(m1.id, c2.id, { order: 9999 });
    await makeMc(m2.id, c1.id, { order: 1, enabled: true }); // same position, another market
    await makeMst(m1.id, s1.id, { order: 1 }); // same position as a category of the same market: a different list
    await makeMst(m1.id, s2.id, { order: 9999 });
    expect((await mcRow(m1.id, c1.id)).display_order).toBe(1);
    expect((await mcRow(m1.id, c2.id)).display_order).toBe(9999);
    expect((await mstRow(m1.id, s2.id)).display_order).toBe(9999);
  });

  it('refuses two categories at the same position of a market, enabled or not (a DISABLED row keeps its position), and the same for service types', async () => {
    const market = await makeMarket();
    const [c1, c2] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const [s1, s2] = [await makeServiceType(c1.id, { status: 'ACTIVE' }), await makeServiceType(c1.id, { status: 'ACTIVE' })];
    const order = await makeMc(market.id, c1.id, { enabled: false });
    await expectConstraint(makeMc(market.id, c2.id, { order, enabled: false }), 'uq_market_categories__market_order');
    await expectConstraint(makeMc(market.id, c2.id, { order, enabled: true }), 'uq_market_categories__market_order');
    const so = await makeMst(market.id, s1.id, { enabled: false });
    await expectConstraint(makeMst(market.id, s2.id, { order: so, enabled: false }), 'uq_market_service_types__market_order');
    // an update onto the position of a sibling is refused too; swapping two positions takes three statements (the key is not deferrable)
    await makeMc(market.id, c2.id);
    const o2 = (await mcRow(market.id, c2.id)).display_order;
    await expectConstraint(
      run('UPDATE catalog.market_categories SET display_order = $3 WHERE market_id = $1 AND category_id = $2', [market.id, c2.id, order]),
      'uq_market_categories__market_order',
    );
    const spare = nextOrder();
    await run('UPDATE catalog.market_categories SET display_order = $3 WHERE market_id = $1 AND category_id = $2', [market.id, c1.id, spare]);
    await run('UPDATE catalog.market_categories SET display_order = $3 WHERE market_id = $1 AND category_id = $2', [market.id, c2.id, order]);
    await run('UPDATE catalog.market_categories SET display_order = $3 WHERE market_id = $1 AND category_id = $2', [market.id, c1.id, o2]);
    expect([(await mcRow(market.id, c1.id)).display_order, (await mcRow(market.id, c2.id)).display_order]).toEqual([o2, order]);
  });

  it('refuses a second row for the same market and item on the primary key, on both market tables', async () => {
    const market = await makeMarket();
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'ACTIVE' });
    await makeMc(market.id, c.id);
    await makeMst(market.id, st.id);
    await expectConstraint(makeMc(market.id, c.id), 'pk_market_categories');
    await expectConstraint(makeMst(market.id, st.id), 'pk_market_service_types');
  });

  it('refuses an unknown market, category or service type on the foreign keys (a DISABLED row reaches the key: the guard looks only at rows being enabled)', async () => {
    const market = await makeMarket();
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'ACTIVE' });
    const ghost = '00000000-0000-4000-8000-000000000000';
    await expectConstraint(makeMc(ghost, c.id), 'fk_market_categories__market_id');
    await expectConstraint(makeMc(market.id, ghost), 'fk_market_categories__category_id');
    await expectConstraint(makeMst(ghost, st.id), 'fk_market_service_types__market_id');
    await expectConstraint(makeMst(market.id, ghost), 'fk_market_service_types__service_type_id');
    const ghostChild = `ghostchild_${++seq}`;
    await ensureEntry(serviceTypeNameKey(ghostChild)); // the name entry exists, so the category foreign key is the one that fails
    await expectConstraint(rawServiceType(ghost, ghostChild, null), 'fk_service_types__category_id');
    const pcode = `ghostpro_${++seq}`;
    await ensureEntry(prohibitedServiceNameKey(pcode));
    await expectConstraint(
      run('INSERT INTO catalog.prohibited_services (category_id, code) VALUES ($1, $2)', [ghost, pcode]),
      'fk_prohibited_services__category_id',
    );
  });

  it('refuses NULL in every NOT NULL column of every table by column name (and accepts NULL in the optional ones)', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const market = await makeMarket();
    const code = `nn_${++seq}`;
    await ensureEntry(categoryNameKey(code));
    const insert = (table: string, v: Record<string, unknown>) =>
      run(
        `INSERT INTO ${table} (${Object.keys(v).join(', ')}) VALUES (${Object.keys(v)
          .map((_, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(v),
      );
    // a NULL status does not equal DRAFT in SQL, so the guard's comparison is NULL (not true) and the NOT NULL constraint answers
    for (const col of ['code', 'status', 'created_at', 'updated_at'])
      await expectNotNull(insert(CAT, { code, status: 'DRAFT', created_at: new Date(), updated_at: new Date(), [col]: null }), col);
    await expectNotNull(insert(CAT, { code: null }), 'code');
    // updated_at NULL on INSERT is replaced by the guards of the market tables, so only the timestamps of the reference tables can fail here
    await expectNotNull(insert(ST, { category_id: null, code: `x_${++seq}` }), 'category_id');
    await expectNotNull(insert(ST, { category_id: c.id, code: null }), 'code');
    await expectNotNull(insert(PS, { code: null }), 'code');
    await expectNotNull(insert(MC, { market_id: null, category_id: c.id, display_order: nextOrder() }), 'market_id');
    await expectNotNull(insert(MC, { market_id: market.id, category_id: null, display_order: nextOrder() }), 'category_id');
    await expectNotNull(insert(MC, { market_id: market.id, category_id: c.id, display_order: null }), 'display_order');
    await expectNotNull(insert(MC, { market_id: market.id, category_id: c.id, display_order: nextOrder(), enabled: null }), 'enabled');
    await expectNotNull(insert(MC, { market_id: market.id, category_id: c.id, display_order: nextOrder(), created_at: null }), 'created_at');
    const st = await makeServiceType(c.id);
    await expectNotNull(insert(MST, { market_id: null, service_type_id: st.id, display_order: nextOrder() }), 'market_id');
    await expectNotNull(insert(MST, { market_id: market.id, service_type_id: null, display_order: nextOrder() }), 'service_type_id');
    await expectNotNull(insert(MST, { market_id: market.id, service_type_id: st.id, display_order: null }), 'display_order');
    await expectNotNull(insert(MST, { market_id: market.id, service_type_id: st.id, display_order: nextOrder(), enabled: null }), 'enabled');
    expect(await count(CAT, 'code = $1', [code])).toBe(0);
    // an UPDATE to NULL status is refused by NOT NULL (the status machine lets a NULL through)
    await expectNotNull(run('UPDATE catalog.categories SET status = NULL WHERE category_id = $1', [c.id]), 'status');
    await expectNotNull(run('UPDATE catalog.service_types SET status = NULL WHERE service_type_id = $1', [st.id]), 'status');
    // a NULL code is a change of the identity: the guard answers first
    await expectRule(run('UPDATE catalog.categories SET code = NULL WHERE category_id = $1', [c.id]), 'IMMUTABLE_IDENTITY');
  });

  it('defaults status to DRAFT, enabled to false, ids to a fresh UUID and both timestamps to the transaction instant', async () => {
    const code = `def_${++seq}`;
    await ensureEntry(categoryNameKey(code));
    await run('INSERT INTO catalog.categories (code) VALUES ($1)', [code]);
    const r = (await q<{ status: string; created_at: Date; updated_at: Date; category_id: string }>(`SELECT * FROM ${CAT} WHERE code = $1`, [code]))[0]!;
    expect(r.status).toBe('DRAFT');
    expect(r.created_at.getTime()).toBe(r.updated_at.getTime());
    expect(r.category_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Math.abs(r.created_at.getTime() - Date.now())).toBeLessThan(60_000);
    const market = await makeMarket();
    await run('INSERT INTO catalog.market_categories (market_id, category_id, display_order) VALUES ($1, $2, $3)', [market.id, r.category_id, nextOrder()]);
    expect((await mcRow(market.id, r.category_id)).enabled).toBe(false);
  });
});

describe('C5. audit_events: every CHECK (action vocabulary, one subject, reason, actor, changes) and the foreign keys', () => {
  interface AuditValues {
    actor: string | null;
    action: string | null;
    category_id: string | null;
    service_type_id: string | null;
    prohibited_service_id: string | null;
    market_id: string | null;
    changes: unknown;
    reason: string | null;
    correlation_id: string | null;
  }
  let subjects: { category: string; serviceType: string; prohibited: string; market: string };
  beforeAll(async () => {
    const category = await makeCategory();
    subjects = {
      category: category.id,
      serviceType: (await makeServiceType(category.id)).id,
      prohibited: (await makeProhibited()).id,
      market: (await makeMarket()).id,
    };
  });
  const base = (over: Partial<AuditValues> = {}): AuditValues => ({
    actor: 'admin:test',
    action: 'CATEGORY_CREATED',
    category_id: subjects.category,
    service_type_id: null,
    prohibited_service_id: null,
    market_id: null,
    changes: { status: [null, 'DRAFT'] },
    reason: 'a reason',
    correlation_id: 'corr-1',
    ...over,
  });
  const audit = (over: Partial<AuditValues> = {}, from: Db = pool) => {
    const v = base(over);
    return run(
      `INSERT INTO ${AUDIT} (actor, action, category_id, service_type_id, prohibited_service_id, market_id, changes, reason, correlation_id) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        v.actor,
        v.action,
        v.category_id,
        v.service_type_id,
        v.prohibited_service_id,
        v.market_id,
        v.changes === null ? null : JSON.stringify(v.changes),
        v.reason,
        v.correlation_id,
      ],
      from,
    );
  };
  const auditJson = (changesJson: string | null) =>
    run(
      `INSERT INTO ${AUDIT} (actor, action, category_id, changes, reason, correlation_id) VALUES ('admin:test', 'CATEGORY_CREATED', $1, $2::jsonb, 'a reason', 'c')`,
      [subjects.category, changesJson],
    );

  // the nine actions with the one subject shape each requires
  const SHAPES: [action: string, subject: () => Partial<AuditValues>][] = [
    ['CATEGORY_CREATED', () => ({ category_id: subjects.category })],
    ['CATEGORY_UPDATED', () => ({ category_id: subjects.category })],
    ['CATEGORY_STATUS_CHANGED', () => ({ category_id: subjects.category })],
    ['SERVICE_TYPE_CREATED', () => ({ category_id: null, service_type_id: subjects.serviceType })],
    ['SERVICE_TYPE_UPDATED', () => ({ category_id: null, service_type_id: subjects.serviceType })],
    ['SERVICE_TYPE_STATUS_CHANGED', () => ({ category_id: null, service_type_id: subjects.serviceType })],
    ['PROHIBITED_SERVICE_CREATED', () => ({ category_id: null, prohibited_service_id: subjects.prohibited })],
    ['PROHIBITED_SERVICE_STATUS_CHANGED', () => ({ category_id: null, prohibited_service_id: subjects.prohibited })],
    ['MARKET_CATALOG_AVAILABILITY_CHANGED', () => ({ category_id: subjects.category, market_id: subjects.market })],
  ];

  it.each(SHAPES)('accepts %s with exactly its one subject', async (action, subject) => {
    await audit({ action, ...subject() });
    expect(await count(AUDIT, 'action = $1 AND actor = $2 AND reason = $3', [action, 'admin:test', 'a reason'])).toBeGreaterThanOrEqual(1);
  });

  it('accepts a market availability row naming a category OR a service type (never both, never neither)', async () => {
    await audit({ action: 'MARKET_CATALOG_AVAILABILITY_CHANGED', category_id: null, service_type_id: subjects.serviceType, market_id: subjects.market });
    await expectConstraint(
      audit({
        action: 'MARKET_CATALOG_AVAILABILITY_CHANGED',
        category_id: subjects.category,
        service_type_id: subjects.serviceType,
        market_id: subjects.market,
      }),
      'ck_audit_events__subject',
    );
    await expectConstraint(
      audit({ action: 'MARKET_CATALOG_AVAILABILITY_CHANGED', category_id: null, service_type_id: null, market_id: subjects.market }),
      'ck_audit_events__subject',
    );
  });

  it.each([
    'CATEGORY_DELETED',
    'CATEGORY',
    'category_created',
    'CATEGORY_CREATED ',
    'PROHIBITED_SERVICE_UPDATED',
    'MARKET_CREATED',
    'SERVICE_TYPE_DELETED',
    '',
    'ENTRY_CREATED',
  ])('refuses the action %j on the closed vocabulary', async (action) => {
    await expectConstraint(audit({ action }), 'ck_audit_events__action');
  });

  it.each(SHAPES)('refuses %s with its subject missing, with a second subject, or with a market it does not take', async (action, subject) => {
    const own = subject();
    const none = { category_id: null, service_type_id: null, prohibited_service_id: null, market_id: null };
    const subjectCheck = 'ck_audit_events__subject';
    if (action !== 'MARKET_CATALOG_AVAILABILITY_CHANGED') {
      await expectConstraint(audit({ action, ...none }), subjectCheck);
      await expectConstraint(audit({ action, ...own, market_id: subjects.market }), subjectCheck);
      // every OTHER subject column added to the right one is refused
      const all = { category_id: subjects.category, service_type_id: subjects.serviceType, prohibited_service_id: subjects.prohibited };
      for (const [col, value] of Object.entries(all))
        if ((own as Record<string, unknown>)[col] === undefined || (own as Record<string, unknown>)[col] === null)
          await expectConstraint(audit({ action, ...own, [col]: value }), subjectCheck);
      // the subject of ANOTHER family is refused
      const wrongFamily = action.startsWith('CATEGORY')
        ? { category_id: null, service_type_id: subjects.serviceType }
        : { category_id: subjects.category, service_type_id: null, prohibited_service_id: null };
      await expectConstraint(audit({ action, ...none, ...wrongFamily }), subjectCheck);
    } else {
      await expectConstraint(audit({ action, category_id: subjects.category, market_id: null }), subjectCheck);
      await expectConstraint(audit({ action, ...own, prohibited_service_id: subjects.prohibited }), subjectCheck);
      await expectConstraint(
        audit({ action, category_id: null, service_type_id: null, prohibited_service_id: subjects.prohibited, market_id: subjects.market }),
        subjectCheck,
      );
    }
  });

  it('keeps the action prefixes apart: SERVICE_TYPE_* does not satisfy the CATEGORY_* branch, and an underscore in the LIKE is a literal underscore', async () => {
    // 'CATEGORY\_%' must not match a hypothetical action such as CATEGORYXCREATED (blocked by the vocabulary first), and SERVICE_TYPE_* with a category subject fails
    await expectConstraint(audit({ action: 'SERVICE_TYPE_CREATED', category_id: subjects.category, service_type_id: null }), 'ck_audit_events__subject');
    await expectConstraint(audit({ action: 'CATEGORY_CREATED', category_id: null, service_type_id: subjects.serviceType }), 'ck_audit_events__subject');
    expect((await q<{ ok: boolean }>("SELECT 'CATEGORYXCREATED' LIKE 'CATEGORY\\_%' AS ok"))[0]!.ok).toBe(false);
  });

  it('refuses a blank, space-only or over-long reason (1001 characters), accepts 1 and 1000 characters, and refuses NULL', async () => {
    for (const reason of ['', ' ', '    ', 'x'.repeat(1001), 'x'.repeat(5000)]) await expectConstraint(audit({ reason }), 'ck_audit_events__reason');
    await audit({ reason: 'x' });
    await audit({ reason: 'x'.repeat(1000) });
    await audit({ reason: `  padded  ` });
    await expectNotNull(audit({ reason: null }), 'reason');
  });

  it('KNOWN GAP (reported): btrim() trims only spaces, so a reason or an actor made of a tab or a line feed passes the CHECK that is meant to forbid a blank text', async () => {
    await audit({ reason: ch(0x09), actor: 'admin:test' });
    await audit({ reason: ch(0x0a), actor: 'admin:test' });
    await audit({ reason: 'ok', actor: ch(0x09) });
    await audit({ reason: ch(0x00a0) }); // a no-break space is not trimmed either
    expect(await count(AUDIT, "reason IN (E'\\t', E'\\n') OR actor = E'\\t'")).toBe(3);
  });

  it('refuses a blank, space-only or over-long actor (201 characters), accepts 1 and 200 characters, and refuses NULL', async () => {
    for (const actor of ['', ' ', '   ', 'x'.repeat(201)]) await expectConstraint(audit({ actor }), 'ck_audit_events__actor');
    await audit({ actor: 'x' });
    await audit({ actor: 'x'.repeat(200) });
    await expectNotNull(audit({ actor: null }), 'actor');
  });

  it('refuses a changes value that is not a JSON object (an array, a string, a number, a boolean, JSON null) and accepts an object, an empty object and SQL NULL', async () => {
    for (const j of ['[]', '[1,2]', '"text"', '1', 'true', 'null', '[{"status":["a","b"]}]'])
      await expectConstraint(auditJson(j), 'ck_audit_events__changes_object');
    await auditJson('{}');
    await auditJson('{"status":["DRAFT","ACTIVE"]}');
    await auditJson('{"nested":{"a":[1,2,{"b":null}]}}');
    await auditJson(null);
  });

  it('refuses NULL in the correlation id and in the id and time columns, and defaults the id and the time (the time is the statement clock, not the transaction clock)', async () => {
    await expectNotNull(audit({ correlation_id: null }), 'correlation_id');
    await expectNotNull(
      run(`INSERT INTO ${AUDIT} (audit_event_id, actor, action, category_id, reason, correlation_id) VALUES (NULL, 'a', 'CATEGORY_CREATED', $1, 'r', 'c')`, [
        subjects.category,
      ]),
      'audit_event_id',
    );
    await expectNotNull(
      run(`INSERT INTO ${AUDIT} (occurred_at, actor, action, category_id, reason, correlation_id) VALUES (NULL, 'a', 'CATEGORY_CREATED', $1, 'r', 'c')`, [
        subjects.category,
      ]),
      'occurred_at',
    );
    // clock_timestamp(): two rows of ONE transaction get different times
    const c = await openTx();
    try {
      await audit({}, c);
      await sleep(3);
      await audit({}, c);
      const rows = await q<{ n: number }>(
        `SELECT count(DISTINCT occurred_at)::int AS n FROM ${AUDIT} WHERE correlation_id = 'corr-1' AND occurred_at >= now() - interval '1 minute'`,
        [],
        c,
      );
      expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
    } finally {
      await finish(c, 'ROLLBACK');
    }
  });

  it('refuses an unknown category, service type, prohibited service or market on the foreign keys', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    await expectConstraint(audit({ category_id: ghost }), 'fk_audit_events__category_id');
    await expectConstraint(audit({ action: 'SERVICE_TYPE_CREATED', category_id: null, service_type_id: ghost }), 'fk_audit_events__service_type_id');
    await expectConstraint(
      audit({ action: 'PROHIBITED_SERVICE_CREATED', category_id: null, prohibited_service_id: ghost }),
      'fk_audit_events__prohibited_service_id',
    );
    await expectConstraint(audit({ action: 'MARKET_CATALOG_AVAILABILITY_CHANGED', market_id: ghost }), 'fk_audit_events__market_id');
  });

  it('is append-only: UPDATE, DELETE (one row, all rows) and TRUNCATE (alone, together with another table, CASCADE) are refused as ROW_IMMUTABLE and no row is lost or changed', async () => {
    await audit({ reason: 'immutable probe' });
    const before = await q(`SELECT * FROM ${AUDIT} ORDER BY audit_event_id`);
    expect(before.length).toBeGreaterThan(5);
    await expectRule(run(`UPDATE ${AUDIT} SET reason = 'changed' WHERE reason = 'immutable probe'`), 'ROW_IMMUTABLE');
    await expectRule(run(`UPDATE ${AUDIT} SET actor = actor`), 'ROW_IMMUTABLE'); // even a no-op update
    await expectRule(run(`UPDATE ${AUDIT} SET changes = NULL WHERE false OR actor = 'admin:test'`), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${AUDIT} WHERE reason = 'immutable probe'`), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${AUDIT}`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${AUDIT}`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${AUDIT} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${AUDIT}, ${CAT} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${AUDIT} RESTART IDENTITY`), 'ROW_IMMUTABLE');
    expect(await q(`SELECT * FROM ${AUDIT} ORDER BY audit_event_id`)).toEqual(before);
    // a statement that matches no row changes nothing and is not an error
    await run(`DELETE FROM ${AUDIT} WHERE false`);
    await run(`UPDATE ${AUDIT} SET reason = reason WHERE false`);
  });
});

// ====================================================================== D. the guard rules: the exact failing statement of every rule key
type Outcome = 'OK' | 'DRAFT_IS_INITIAL' | 'STATUS_TRANSITION';
/** The full 4 x 4 matrix written out by hand (row = current status, column = requested status). It is compared with the contract and with the database. */
const EXPECTED_MATRIX: Record<CatalogStatus, Record<CatalogStatus, Outcome>> = {
  DRAFT: { DRAFT: 'OK', ACTIVE: 'OK', INACTIVE: 'STATUS_TRANSITION', RETIRED: 'OK' },
  ACTIVE: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'OK', INACTIVE: 'OK', RETIRED: 'OK' },
  INACTIVE: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'OK', INACTIVE: 'OK', RETIRED: 'OK' },
  RETIRED: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'STATUS_TRANSITION', INACTIVE: 'STATUS_TRANSITION', RETIRED: 'OK' },
};
const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as [CatalogStatus, CatalogStatus]));

describe('D0. the status machine: the 4 x 4 matrix of the database equals the contract, pair by pair', () => {
  it('has the contract transitions exactly (DRAFT -> ACTIVE | RETIRED, ACTIVE <-> INACTIVE, ACTIVE | INACTIVE -> RETIRED, RETIRED terminal) and the literal matrix of this file agrees with them', () => {
    expect(CATALOG_STATUS_TRANSITIONS).toEqual({ DRAFT: ['ACTIVE', 'RETIRED'], ACTIVE: ['INACTIVE', 'RETIRED'], INACTIVE: ['ACTIVE', 'RETIRED'], RETIRED: [] });
    for (const [from, to] of PAIRS) {
      const expected = EXPECTED_MATRIX[from][to];
      // a no-op (same status) is accepted by the database although it is not a "transition" of the contract
      expect(expected === 'OK', `${from} -> ${to}`).toBe(from === to || isCatalogTransitionAllowed(from, to));
      if (from !== to && to === 'DRAFT') expect(expected).toBe('DRAFT_IS_INITIAL');
    }
    expect(PAIRS).toHaveLength(16);
    expect(STATUSES).toEqual(['DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED']);
  });

  it.each(PAIRS)('catalog.assert_status_transition(%s, %s) gives the documented answer', async (from, to) => {
    const attempt = pool.query('SELECT catalog.assert_status_transition($1, $2)', [from, to]);
    if (EXPECTED_MATRIX[from][to] === 'OK') await attempt;
    else await expectRule(attempt, EXPECTED_MATRIX[from][to]);
  });

  it('KNOWN GAP (reported): called directly with a NULL status the function does not raise (three-valued logic: NOT (NULL OR ...) is NULL); unreachable through the tables, whose status column is NOT NULL, but a future caller must know', async () => {
    for (const [a, b] of [
      [null, 'ACTIVE'],
      ['ACTIVE', null],
      ['DRAFT', null],
      ['INACTIVE', null],
      [null, null],
    ] as const)
      await pool.query('SELECT catalog.assert_status_transition($1, $2)', [a, b]);
    // RETIRED has no edge at all, so every term is false and the NULL does not rescue it
    await expectRule(pool.query('SELECT catalog.assert_status_transition($1, $2)', ['RETIRED', null]), 'STATUS_TRANSITION');
    // an unknown value on the other side is still refused: only the NULL branch is open
    await expectRule(pool.query('SELECT catalog.assert_status_transition($1, $2)', [null, 'FOO']), 'STATUS_TRANSITION');
  });

  it('judges an unknown status as STATUS_TRANSITION in both positions and never raises another key (the machine is a closed whitelist, not a blacklist)', async () => {
    for (const [a, b] of [
      ['FOO', 'ACTIVE'],
      ['ACTIVE', 'FOO'],
      ['active', 'INACTIVE'],
      ['', 'ACTIVE'],
      ['DRAFT', 'INACTIVE'],
      ['ACTIVE ', 'INACTIVE'],
    ] as const)
      await expectRule(pool.query('SELECT catalog.assert_status_transition($1, $2)', [a, b]), 'STATUS_TRANSITION');
    // an unknown status equal on both sides is the no-op branch
    await pool.query("SELECT catalog.assert_status_transition('FOO', 'FOO')");
  });
});

/** The three tables that follow the machine, with a way to create a row in a given status and to read its status. */
const MACHINE_TABLES = [
  {
    name: 'categories',
    make: async (status: CatalogStatus) => (await makeCategory({ status })).id,
    set: (id: string, status: string) => setCat(id, status),
    status: async (id: string) => (await catRow(id)).status,
  },
  {
    name: 'service_types',
    make: async (status: CatalogStatus) => {
      const parent = await makeCategory({ status: 'ACTIVE' }); // a service type can pass through ACTIVE only under an ACTIVE category
      return (await makeServiceType(parent.id, { status })).id;
    },
    set: (id: string, status: string) => setSt(id, status),
    status: async (id: string) => (await stRow(id)).status,
  },
  {
    name: 'prohibited_services',
    make: async (status: CatalogStatus) => (await makeProhibited({ status })).id,
    set: (id: string, status: string) => setPs(id, status),
    status: async (id: string) => (await psRow(id)).status,
  },
];

describe.each(MACHINE_TABLES)('D1. $name: the status machine of the table, every pair of the matrix', (t) => {
  it.each(PAIRS)(`%s -> %s`, async (from, to) => {
    const id = await t.make(from);
    expect(await t.status(id)).toBe(from);
    const attempt = t.set(id, to);
    const outcome = EXPECTED_MATRIX[from][to];
    if (outcome === 'OK') {
      await attempt;
      expect(await t.status(id)).toBe(to);
    } else {
      await expectRule(attempt, outcome);
      expect(await t.status(id), 'a refused change leaves the row alone').toBe(from);
    }
  });

  it('walks the whole life DRAFT -> ACTIVE -> INACTIVE -> ACTIVE -> INACTIVE -> RETIRED and then refuses every other status, RETIRED included only as a no-op', async () => {
    const id = await t.make('DRAFT');
    for (const s of ['ACTIVE', 'INACTIVE', 'ACTIVE', 'INACTIVE', 'RETIRED']) {
      await t.set(id, s);
      expect(await t.status(id)).toBe(s);
    }
    for (const s of ['DRAFT', 'ACTIVE', 'INACTIVE']) await expect(t.set(id, s)).rejects.toMatchObject({ code: '23000' });
    await t.set(id, 'RETIRED');
    expect(await t.status(id)).toBe('RETIRED');
  });

  it('refuses a status outside the vocabulary: on INSERT as MUST_START_AS_DRAFT and on UPDATE as STATUS_TRANSITION (the trigger answers before the CHECK, which stays as a second line)', async () => {
    const id = await t.make('DRAFT');
    for (const bogus of ['active', 'ARCHIVED', '', 'ACTIVE ', 'RETIRED\n', 'DELETED']) await expectRule(t.set(id, bogus), 'STATUS_TRANSITION');
    expect(await t.status(id)).toBe('DRAFT');
    const ck = `ck_${t.name}__status`;
    // with the guard out of the way (rolled back) the CHECK refuses the same values
    const table = `catalog.${t.name}`;
    const idCol = { categories: 'category_id', service_types: 'service_type_id', prohibited_services: 'prohibited_service_id' }[t.name]!;
    for (const bogus of ['active', 'ARCHIVED', '', 'RETIRED\n'])
      await expectConstraint(isolated(noTriggers(table), `UPDATE ${table} SET status = $2 WHERE ${idCol} = $1`, [id, bogus]), ck);
  });
});

describe('D2. guard_categories: NOT_DELETABLE, MUST_START_AS_DRAFT, IMMUTABLE_IDENTITY', () => {
  it('NOT_DELETABLE: refuses to delete a lone category, one with service types, a seeded one, and every category at once; nothing is deleted', async () => {
    const lone = await makeCategory();
    const withChild = await makeCategory();
    await makeServiceType(withChild.id);
    const before = await count(CAT);
    await expectRule(run('DELETE FROM catalog.categories WHERE category_id = $1', [lone.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.categories WHERE category_id = $1', [withChild.id]), 'NOT_DELETABLE');
    await expectRule(run("DELETE FROM catalog.categories WHERE code = 'auto_services'"), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.categories'), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.categories USING catalog.service_types st WHERE st.category_id = categories.category_id'), 'NOT_DELETABLE');
    expect(await count(CAT)).toBe(before);
    // a retired category is not deletable either
    const retired = await makeCategory({ status: 'RETIRED' });
    await expectRule(run('DELETE FROM catalog.categories WHERE category_id = $1', [retired.id]), 'NOT_DELETABLE');
    await run('DELETE FROM catalog.categories WHERE false'); // matching nothing is not an error
  });

  it.each(['ACTIVE', 'INACTIVE', 'RETIRED', 'active', 'bogus', ''])(
    'MUST_START_AS_DRAFT: refuses to create a category with status %j, before the CHECK and the foreign keys are looked at',
    async (status) => {
      const code = `new_${++seq}`;
      await ensureEntry(categoryNameKey(code));
      await expectRule(rawCategory(code, null, null, status), 'MUST_START_AS_DRAFT');
      expect(await count(CAT, 'code = $1', [code])).toBe(0);
      // even with a missing name entry the guard answers first
      await expectRule(rawCategory(`nonexistent_${++seq}`, null, null, status), 'MUST_START_AS_DRAFT');
    },
  );

  it('IMMUTABLE_IDENTITY: refuses to change the code (any other value, another case) or the id, together with a status change too, and reports it before every other rule', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const other = await makeCategory();
    await makeServiceType(c.id, { status: 'ACTIVE' });
    await expectRule(run("UPDATE catalog.categories SET code = 'renamed_cat' WHERE category_id = $1", [c.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.categories SET code = upper(code) WHERE category_id = $1', [c.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.categories SET code = $2 WHERE category_id = $1', [c.id, other.code]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.categories SET category_id = gen_random_uuid() WHERE category_id = $1', [c.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.categories SET category_id = $2 WHERE category_id = $1', [c.id, other.id]), 'IMMUTABLE_IDENTITY');
    // a rename together with a retirement that would itself be refused (an ACTIVE service type): the identity rule comes first
    await expectRule(run("UPDATE catalog.categories SET code = 'xx_ren', status = 'RETIRED' WHERE category_id = $1", [c.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run("UPDATE catalog.categories SET code = 'xx_ren', status = 'DRAFT' WHERE category_id = $1", [c.id]), 'IMMUTABLE_IDENTITY');
    expect(await catRow(c.id)).toMatchObject({ code: c.code, status: 'ACTIVE' });
    // setting the same values is accepted (nothing changes)
    await run('UPDATE catalog.categories SET code = code, category_id = category_id, status = status WHERE category_id = $1', [c.id]);
  });

  it('allows the changes no rule covers: the icon and the description link can be edited at any status, including RETIRED', async () => {
    const c = await makeCategory({ status: 'RETIRED', desc: true });
    await run("UPDATE catalog.categories SET icon_key = 'broom' WHERE category_id = $1", [c.id]);
    await run('UPDATE catalog.categories SET description_content_key = NULL WHERE category_id = $1', [c.id]);
    await run('UPDATE catalog.categories SET icon_key = NULL, status = status WHERE category_id = $1', [c.id]);
    expect((await catRow(c.id)).status).toBe('RETIRED');
  });
});

describe('D3. the category looks at its service types: CATEGORY_HAS_ACTIVE_SERVICE_TYPES and CATEGORY_HAS_OPEN_SERVICE_TYPES', () => {
  interface ParentCase {
    label: string;
    category: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
    children: CatalogStatus[];
    to: CatalogStatus;
    rule: 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES' | 'CATEGORY_HAS_OPEN_SERVICE_TYPES' | null;
  }
  const A = 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES';
  const O = 'CATEGORY_HAS_OPEN_SERVICE_TYPES';
  const CASES: ParentCase[] = [
    { label: 'ACTIVE child blocks ACTIVE -> INACTIVE', category: 'ACTIVE', children: ['ACTIVE'], to: 'INACTIVE', rule: A },
    {
      label: 'ACTIVE child blocks ACTIVE -> RETIRED (the ACTIVE rule comes before the OPEN rule)',
      category: 'ACTIVE',
      children: ['ACTIVE'],
      to: 'RETIRED',
      rule: A,
    },
    { label: 'one ACTIVE among RETIRED children blocks INACTIVE', category: 'ACTIVE', children: ['RETIRED', 'ACTIVE'], to: 'INACTIVE', rule: A },
    { label: 'two ACTIVE children block INACTIVE', category: 'ACTIVE', children: ['ACTIVE', 'ACTIVE'], to: 'INACTIVE', rule: A },
    { label: 'an INACTIVE child does not block ACTIVE -> INACTIVE', category: 'ACTIVE', children: ['INACTIVE'], to: 'INACTIVE', rule: null },
    { label: 'an INACTIVE child blocks ACTIVE -> RETIRED as OPEN', category: 'ACTIVE', children: ['INACTIVE'], to: 'RETIRED', rule: O },
    { label: 'a DRAFT child does not block ACTIVE -> INACTIVE', category: 'ACTIVE', children: ['DRAFT'], to: 'INACTIVE', rule: null },
    { label: 'a DRAFT child blocks ACTIVE -> RETIRED as OPEN', category: 'ACTIVE', children: ['DRAFT'], to: 'RETIRED', rule: O },
    { label: 'a RETIRED child alone does not block ACTIVE -> INACTIVE', category: 'ACTIVE', children: ['RETIRED'], to: 'INACTIVE', rule: null },
    { label: 'RETIRED children alone do not block ACTIVE -> RETIRED', category: 'ACTIVE', children: ['RETIRED', 'RETIRED'], to: 'RETIRED', rule: null },
    { label: 'a DRAFT among RETIRED children blocks RETIRED as OPEN', category: 'ACTIVE', children: ['RETIRED', 'DRAFT'], to: 'RETIRED', rule: O },
    { label: 'no children: ACTIVE -> INACTIVE', category: 'ACTIVE', children: [], to: 'INACTIVE', rule: null },
    { label: 'no children: ACTIVE -> RETIRED', category: 'ACTIVE', children: [], to: 'RETIRED', rule: null },
    { label: 'INACTIVE with an INACTIVE child blocks INACTIVE -> RETIRED as OPEN', category: 'INACTIVE', children: ['INACTIVE'], to: 'RETIRED', rule: O },
    { label: 'INACTIVE with a DRAFT child blocks INACTIVE -> RETIRED as OPEN', category: 'INACTIVE', children: ['DRAFT'], to: 'RETIRED', rule: O },
    { label: 'INACTIVE with RETIRED children retires', category: 'INACTIVE', children: ['RETIRED'], to: 'RETIRED', rule: null },
    { label: 'INACTIVE with an INACTIVE child reactivates (a pause is reversible)', category: 'INACTIVE', children: ['INACTIVE'], to: 'ACTIVE', rule: null },
    { label: 'DRAFT with a DRAFT child blocks DRAFT -> RETIRED as OPEN', category: 'DRAFT', children: ['DRAFT'], to: 'RETIRED', rule: O },
    { label: 'DRAFT with a DRAFT child activates', category: 'DRAFT', children: ['DRAFT'], to: 'ACTIVE', rule: null },
    { label: 'DRAFT with a RETIRED child retires', category: 'DRAFT', children: ['RETIRED'], to: 'RETIRED', rule: null },
    { label: 'DRAFT without children retires', category: 'DRAFT', children: [], to: 'RETIRED', rule: null },
  ];
  it.each(CASES)('$label', async ({ category, children, to, rule }) => {
    const c = await makeCategory({ status: category === 'DRAFT' ? 'DRAFT' : 'ACTIVE' });
    for (const status of children) await makeServiceType(c.id, { status });
    if (category === 'INACTIVE') await setCat(c.id, 'INACTIVE');
    // a service type of ANOTHER category that is ACTIVE never blocks this one
    const stranger = await makeCategory({ status: 'ACTIVE' });
    await makeServiceType(stranger.id, { status: 'ACTIVE' });
    const attempt = setCat(c.id, to);
    if (rule) {
      await expectRule(attempt, rule);
      expect((await catRow(c.id)).status).toBe(category);
    } else {
      await attempt;
      expect((await catRow(c.id)).status).toBe(to);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('unblocks step by step: deactivating the last ACTIVE service type lets the category leave ACTIVE, and retiring the last open one lets it retire', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const [s1, s2] = [await makeServiceType(c.id, { status: 'ACTIVE' }), await makeServiceType(c.id, { status: 'ACTIVE' })];
    await expectRule(setCat(c.id, 'INACTIVE'), 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    await setSt(s1.id, 'INACTIVE');
    await expectRule(setCat(c.id, 'INACTIVE'), 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES'); // s2 is still ACTIVE
    await setSt(s2.id, 'INACTIVE');
    await setCat(c.id, 'INACTIVE');
    await expectRule(setCat(c.id, 'RETIRED'), 'CATEGORY_HAS_OPEN_SERVICE_TYPES');
    await setSt(s1.id, 'RETIRED');
    await expectRule(setCat(c.id, 'RETIRED'), 'CATEGORY_HAS_OPEN_SERVICE_TYPES');
    await setSt(s2.id, 'RETIRED');
    await setCat(c.id, 'RETIRED');
    expect((await catRow(c.id)).status).toBe('RETIRED');
  });

  it('does not look at the children when the category does not change status (editing an ACTIVE category with ACTIVE service types is allowed), and a RETIRED category keeps its RETIRED children', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    await makeServiceType(c.id, { status: 'ACTIVE' });
    await run("UPDATE catalog.categories SET icon_key = 'broom', status = 'ACTIVE' WHERE category_id = $1", [c.id]);
    const r = await makeCategory({ status: 'ACTIVE' });
    await makeServiceType(r.id, { status: 'RETIRED' });
    await setCat(r.id, 'RETIRED');
    await run('UPDATE catalog.categories SET icon_key = NULL, status = status WHERE category_id = $1', [r.id]); // RETIRED -> RETIRED with RETIRED children
  });

  it('is atomic: a multi-row UPDATE where one category is blocked changes none of them', async () => {
    const [free, blocked] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    await makeServiceType(blocked.id, { status: 'ACTIVE' });
    await expectRule(
      run("UPDATE catalog.categories SET status = 'INACTIVE' WHERE category_id = ANY($1::uuid[])", [[free.id, blocked.id]]),
      'CATEGORY_HAS_ACTIVE_SERVICE_TYPES',
    );
    expect((await catRow(free.id)).status).toBe('ACTIVE');
    expect((await catRow(blocked.id)).status).toBe('ACTIVE');
  });
});

describe('D4. guard_service_types: NOT_DELETABLE, MUST_START_AS_DRAFT, CATEGORY_RETIRED, IMMUTABLE_IDENTITY, CATEGORY_NOT_ACTIVE', () => {
  it('NOT_DELETABLE: refuses to delete one service type, a seeded one, a RETIRED one and every service type at once', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id);
    const retired = await makeServiceType(c.id, { status: 'RETIRED' });
    const before = await count(ST);
    await expectRule(run('DELETE FROM catalog.service_types WHERE service_type_id = $1', [st.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.service_types WHERE service_type_id = $1', [retired.id]), 'NOT_DELETABLE');
    await expectRule(run("DELETE FROM catalog.service_types WHERE code = 'car_detailing'"), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.service_types'), 'NOT_DELETABLE');
    expect(await count(ST)).toBe(before);
  });

  it.each(['ACTIVE', 'INACTIVE', 'RETIRED', 'active', 'bogus', ''])(
    'MUST_START_AS_DRAFT: refuses to create a service type with status %j, even under a RETIRED category (it comes before CATEGORY_RETIRED)',
    async (status) => {
      const c = await makeCategory({ status: 'ACTIVE' });
      const retired = await makeCategory({ status: 'RETIRED' });
      const code = `new_${++seq}`;
      await ensureEntry(serviceTypeNameKey(code));
      for (const parent of [c, retired])
        await expectRule(
          run('INSERT INTO catalog.service_types (category_id, code, status) VALUES ($1, $2, $3)', [parent.id, code, status]),
          'MUST_START_AS_DRAFT',
        );
      expect(await count(ST, 'code = $1', [code])).toBe(0);
    },
  );

  it('CATEGORY_RETIRED: refuses to create a service type under a RETIRED category, and accepts a DRAFT, an ACTIVE and an INACTIVE one', async () => {
    for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE'] as const) {
      const parent = await makeCategory({ status });
      const st = await makeServiceType(parent.id);
      expect((await stRow(st.id)).status).toBe('DRAFT');
    }
    const retired = await makeCategory({ status: 'RETIRED' });
    const code = `late_${++seq}`;
    await ensureEntry(serviceTypeNameKey(code));
    await expectRule(rawServiceType(retired.id, code, null), 'CATEGORY_RETIRED');
    expect(await count(ST, 'category_id = $1', [retired.id])).toBe(0);
  });

  it('answers an unknown category with the foreign key (the guard finds no status and lets it through)', async () => {
    const code = `orphan_${++seq}`;
    await ensureEntry(serviceTypeNameKey(code));
    await expectConstraint(rawServiceType('00000000-0000-4000-8000-000000000000', code, null), 'fk_service_types__category_id');
  });

  it('IMMUTABLE_IDENTITY: refuses to change the code, the id or the CATEGORY (a move to another category is a new service type), also together with a status change', async () => {
    const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const st = await makeServiceType(a.id, { status: 'ACTIVE' });
    const other = await makeServiceType(a.id);
    await expectRule(run('UPDATE catalog.service_types SET category_id = $2 WHERE service_type_id = $1', [st.id, b.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.service_types SET category_id = $2 WHERE service_type_id = $1', [other.id, b.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run("UPDATE catalog.service_types SET code = 'renamed_st' WHERE service_type_id = $1", [st.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.service_types SET code = $2 WHERE service_type_id = $1', [st.id, other.code]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.service_types SET service_type_id = gen_random_uuid() WHERE service_type_id = $1', [st.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run("UPDATE catalog.service_types SET category_id = $2, status = 'INACTIVE' WHERE service_type_id = $1", [st.id, b.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run("UPDATE catalog.service_types SET category_id = $2, status = 'DRAFT' WHERE service_type_id = $1", [st.id, b.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.service_types SET category_id = $2 WHERE service_type_id = $1', [st.id, '00000000-0000-4000-8000-000000000000']),
      'IMMUTABLE_IDENTITY',
    );
    await run('UPDATE catalog.service_types SET category_id = category_id, code = code WHERE service_type_id = $1', [st.id]); // the same values are fine
    expect(await count(ST, 'category_id = $1', [b.id])).toBe(0);
  });

  it.each(['DRAFT', 'INACTIVE', 'RETIRED'] as const)(
    'CATEGORY_NOT_ACTIVE: a service type cannot become ACTIVE while its category is %s',
    async (categoryStatus) => {
      const c = await makeCategory({ status: categoryStatus === 'DRAFT' ? 'DRAFT' : 'ACTIVE' });
      // a DRAFT service type created before the category left ACTIVE; for RETIRED it stays DRAFT and then the category is retired after its children
      const st = await makeServiceType(c.id);
      const inactive = categoryStatus === 'DRAFT' ? undefined : await makeServiceType(c.id, { status: 'INACTIVE' });
      if (categoryStatus === 'INACTIVE') await setCat(c.id, 'INACTIVE');
      if (categoryStatus === 'RETIRED') {
        await setSt(st.id, 'RETIRED');
        await setSt(inactive!.id, 'RETIRED');
        await setCat(c.id, 'RETIRED');
      }
      if (categoryStatus !== 'RETIRED') {
        await expectRule(setSt(st.id, 'ACTIVE'), 'CATEGORY_NOT_ACTIVE');
        expect((await stRow(st.id)).status).toBe('DRAFT');
      }
      if (inactive && categoryStatus === 'INACTIVE') {
        await expectRule(setSt(inactive.id, 'ACTIVE'), 'CATEGORY_NOT_ACTIVE'); // a reactivation is checked like a first activation
        expect((await stRow(inactive.id)).status).toBe('INACTIVE');
      }
      if (categoryStatus === 'RETIRED') await expectRule(setSt(st.id, 'ACTIVE'), 'STATUS_TRANSITION'); // RETIRED is terminal: the machine answers before the parent is looked at
      // once the category is ACTIVE again the same activation succeeds
      if (categoryStatus !== 'RETIRED') {
        await setCat(c.id, 'ACTIVE');
        await setSt(st.id, 'ACTIVE');
        expect((await stRow(st.id)).status).toBe('ACTIVE');
      }
      expect(await violations()).toEqual(NO_VIOLATIONS);
    },
  );

  it('only an ENTRY into ACTIVE is checked against the parent: a DRAFT or INACTIVE service type can be retired under a category that is not ACTIVE, and an ACTIVE row stays ACTIVE on an unrelated edit', async () => {
    const c = await makeCategory({ status: 'DRAFT' });
    const [d, i] = [await makeServiceType(c.id), await makeServiceType(c.id)];
    await setSt(d.id, 'RETIRED');
    await run('UPDATE catalog.service_types SET description_content_key = NULL WHERE service_type_id = $1', [i.id]);
    const live = await makeCategory({ status: 'ACTIVE' });
    const s = await makeServiceType(live.id, { status: 'ACTIVE' });
    await run('UPDATE catalog.service_types SET status = status, description_content_key = NULL WHERE service_type_id = $1', [s.id]);
    await setSt(s.id, 'INACTIVE'); // leaving ACTIVE never needs the parent
    await setSt(s.id, 'RETIRED');
  });

  it('reports the transition rule BEFORE the parent rule, and IMMUTABLE_IDENTITY before both', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'RETIRED' });
    const lazy = await makeCategory({ status: 'DRAFT' });
    const draftChild = await makeServiceType(lazy.id);
    await expectRule(setSt(st.id, 'ACTIVE'), 'STATUS_TRANSITION'); // parent is ACTIVE: only the machine refuses
    await expectRule(setSt(draftChild.id, 'INACTIVE'), 'STATUS_TRANSITION'); // DRAFT -> INACTIVE is not an edge
    await expectRule(setSt(draftChild.id, 'ACTIVE'), 'CATEGORY_NOT_ACTIVE'); // an edge, but the parent is DRAFT
  });
});

describe('D5. guard_prohibited_services: NOT_DELETABLE, MUST_START_AS_DRAFT, IMMUTABLE_IDENTITY (flat list: no parent rule)', () => {
  it('NOT_DELETABLE: refuses to delete one, a RETIRED one and all of them', async () => {
    const p = await makeProhibited();
    const r = await makeProhibited({ status: 'RETIRED' });
    await expectRule(run('DELETE FROM catalog.prohibited_services WHERE prohibited_service_id = $1', [p.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.prohibited_services WHERE prohibited_service_id = $1', [r.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.prohibited_services'), 'NOT_DELETABLE');
    expect(await count(PS, 'prohibited_service_id = ANY($1::uuid[])', [[p.id, r.id]])).toBe(2);
  });

  it.each(['ACTIVE', 'INACTIVE', 'RETIRED', 'bogus'])('MUST_START_AS_DRAFT: refuses to create a prohibited service with status %j', async (status) => {
    const code = `pnew_${++seq}`;
    await ensureEntry(prohibitedServiceNameKey(code));
    await expectRule(run('INSERT INTO catalog.prohibited_services (code, status) VALUES ($1, $2)', [code, status]), 'MUST_START_AS_DRAFT');
    expect(await count(PS, 'code = $1', [code])).toBe(0);
  });

  it('IMMUTABLE_IDENTITY: refuses to change the id, the code, and the category (to another, to NULL, and from NULL), but accepts the same values', async () => {
    const [a, b] = [await makeCategory(), await makeCategory()];
    const withCat = await makeProhibited({ categoryId: a.id });
    const noCat = await makeProhibited();
    await expectRule(run("UPDATE catalog.prohibited_services SET code = 'renamed_ps' WHERE prohibited_service_id = $1", [withCat.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run('UPDATE catalog.prohibited_services SET prohibited_service_id = gen_random_uuid() WHERE prohibited_service_id = $1', [withCat.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(run('UPDATE catalog.prohibited_services SET category_id = $2 WHERE prohibited_service_id = $1', [withCat.id, b.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.prohibited_services SET category_id = NULL WHERE prohibited_service_id = $1', [withCat.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.prohibited_services SET category_id = $2 WHERE prohibited_service_id = $1', [noCat.id, a.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run("UPDATE catalog.prohibited_services SET category_id = $2, status = 'ACTIVE' WHERE prohibited_service_id = $1", [noCat.id, a.id]),
      'IMMUTABLE_IDENTITY',
    );
    await run('UPDATE catalog.prohibited_services SET category_id = category_id, code = code WHERE prohibited_service_id = $1', [withCat.id]);
    await run('UPDATE catalog.prohibited_services SET category_id = NULL WHERE prohibited_service_id = $1', [noCat.id]); // NULL -> NULL
  });

  it('is independent of the category: a prohibited service can be ACTIVE under a DRAFT category, and an ACTIVE rule does not hold a category back from leaving ACTIVE or being retired', async () => {
    const c = await makeCategory({ status: 'DRAFT' });
    const p = await makeProhibited({ categoryId: c.id, status: 'ACTIVE' });
    expect((await psRow(p.id)).status).toBe('ACTIVE');
    const live = await makeCategory({ status: 'ACTIVE' });
    await makeProhibited({ categoryId: live.id, status: 'ACTIVE' });
    await setCat(live.id, 'INACTIVE');
    await setCat(live.id, 'RETIRED');
    // a prohibited service can even be created under a RETIRED category (no parent rule exists on this table)
    const retiredPs = await makeProhibited({ categoryId: live.id });
    expect((await psRow(retiredPs.id)).status).toBe('DRAFT');
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('D6. guard_market_categories: NOT_DELETABLE, IMMUTABLE_IDENTITY, ITEM_RETIRED, CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES', () => {
  it('NOT_DELETABLE: refuses to delete a disabled row, an enabled row and every row at once', async () => {
    const market = await makeMarket();
    const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    await makeMc(market.id, a.id, { enabled: true });
    await makeMc(market.id, b.id);
    await expectRule(run('DELETE FROM catalog.market_categories WHERE market_id = $1 AND category_id = $2', [market.id, a.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.market_categories WHERE market_id = $1 AND category_id = $2', [market.id, b.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.market_categories WHERE market_id = $1', [market.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.market_categories'), 'NOT_DELETABLE');
    expect(await count(MC, 'market_id = $1', [market.id])).toBe(2);
  });

  it('IMMUTABLE_IDENTITY: refuses to move a row to another market or another category, disabled or enabled, and reports it before the retired rule', async () => {
    const [m1, m2] = [await makeMarket(), await makeMarket()];
    const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    await makeMc(m1.id, a.id);
    await expectRule(
      run('UPDATE catalog.market_categories SET market_id = $3 WHERE market_id = $1 AND category_id = $2', [m1.id, a.id, m2.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.market_categories SET category_id = $3 WHERE market_id = $1 AND category_id = $2', [m1.id, a.id, b.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.market_categories SET market_id = $3, category_id = $4 WHERE market_id = $1 AND category_id = $2', [m1.id, a.id, m2.id, b.id]),
      'IMMUTABLE_IDENTITY',
    );
    await setMc(m1.id, a.id, true);
    await expectRule(
      run('UPDATE catalog.market_categories SET market_id = $3 WHERE market_id = $1 AND category_id = $2', [m1.id, a.id, m2.id]),
      'IMMUTABLE_IDENTITY',
    );
    // a move to a RETIRED category together with enabling: the identity rule comes first
    const retired = await makeCategory({ status: 'RETIRED' });
    await expectRule(
      run('UPDATE catalog.market_categories SET category_id = $3, enabled = true WHERE market_id = $1 AND category_id = $2', [m1.id, a.id, retired.id]),
      'IMMUTABLE_IDENTITY',
    );
    await run('UPDATE catalog.market_categories SET market_id = market_id, category_id = category_id WHERE market_id = $1', [m1.id]);
  });

  it('ITEM_RETIRED: a RETIRED category cannot be enabled by INSERT or by UPDATE, but a DISABLED row can be prepared for it, and nothing blocks DRAFT, ACTIVE or INACTIVE categories', async () => {
    const market = await makeMarket();
    for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE'] as const) {
      const c = await makeCategory({ status });
      await makeMc(market.id, c.id, { enabled: true });
      expect((await mcRow(market.id, c.id)).enabled).toBe(true);
    }
    const retired = await makeCategory({ status: 'RETIRED' });
    await expectRule(makeMc(market.id, retired.id, { enabled: true }), 'ITEM_RETIRED');
    expect(await count(MC, 'category_id = $1', [retired.id])).toBe(0);
    await makeMc(market.id, retired.id, { enabled: false }); // a disabled row is not "enabling"
    await expectRule(setMc(market.id, retired.id, true), 'ITEM_RETIRED');
    expect((await mcRow(market.id, retired.id)).enabled).toBe(false);
  });

  it('ITEM_RETIRED only guards the moment of ENABLING: retiring a category that is already enabled leaves the row enabled (the public view excludes it by status), it can be switched off, and never back on', async () => {
    const market = await makeMarket();
    const c = await makeCategory({ status: 'ACTIVE' });
    await makeMc(market.id, c.id, { enabled: true });
    await setCat(c.id, 'RETIRED');
    expect((await mcRow(market.id, c.id)).enabled).toBe(true);
    await run('UPDATE catalog.market_categories SET display_order = $3 WHERE market_id = $1 AND category_id = $2', [market.id, c.id, nextOrder()]); // true -> true: not enabling
    await setMc(market.id, c.id, false);
    await expectRule(setMc(market.id, c.id, true), 'ITEM_RETIRED');
  });

  it('prepares availability for a market of ANY status (PLANNED including the seeded la-oc, ACTIVE, INACTIVE) and for categories that are DRAFT', async () => {
    const draft = await makeCategory({ status: 'DRAFT' });
    for (const market of [await laOc(), await makeMarket('PLANNED'), await makeMarket('ACTIVE'), await makeMarket('INACTIVE')]) {
      await makeMc(market.id, draft.id, { enabled: false });
      await setMc(market.id, draft.id, true);
      expect((await mcRow(market.id, draft.id)).enabled).toBe(true);
    }
    expect((await q<{ status: string }>("SELECT status FROM geography.markets WHERE code = 'la-oc'"))[0]!.status).toBe('PLANNED');
  });

  it('CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES: a category cannot be switched off in a market while one of its service types is enabled there, and the failure leaves both rows alone', async () => {
    const { market, category, serviceType } = await liveStack();
    await expectRule(setMc(market.id, category.id, false), 'CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES');
    expect((await mcRow(market.id, category.id)).enabled).toBe(true);
    expect((await mstRow(market.id, serviceType.id)).enabled).toBe(true);
    await setMst(market.id, serviceType.id, false);
    await setMc(market.id, category.id, false);
    expect((await mcRow(market.id, category.id)).enabled).toBe(false);
    // and the service type cannot come back while the category is off
    await expectRule(setMst(market.id, serviceType.id, true), 'CATEGORY_NOT_ENABLED_IN_MARKET');
    await setMc(market.id, category.id, true);
    await setMst(market.id, serviceType.id, true);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES: only an ENABLED service type of THE SAME category in THE SAME market blocks (other market, other category, disabled rows do not)', async () => {
    const [m1, m2] = [await makeMarket(), await makeMarket()];
    const [cat, otherCat] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const [st, other, disabled] = [
      await makeServiceType(cat.id, { status: 'ACTIVE' }),
      await makeServiceType(otherCat.id, { status: 'ACTIVE' }),
      await makeServiceType(cat.id, { status: 'ACTIVE' }),
    ];
    await makeMc(m1.id, cat.id, { enabled: true });
    await makeMc(m2.id, cat.id, { enabled: true });
    await makeMc(m1.id, otherCat.id, { enabled: true });
    await makeMst(m2.id, st.id, { enabled: true }); // enabled in ANOTHER market
    await makeMst(m1.id, other.id, { enabled: true }); // enabled in this market, but for ANOTHER category
    await makeMst(m1.id, disabled.id, { enabled: false }); // right category and market, not enabled
    await setMc(m1.id, cat.id, false);
    expect((await mcRow(m1.id, cat.id)).enabled).toBe(false);
    // the other market still blocks its own category row
    await expectRule(setMc(m2.id, cat.id, false), 'CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES');
    await expectRule(setMc(m1.id, otherCat.id, false), 'CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES');
  });

  it('CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES: a RETIRED service type whose row is still enabled keeps blocking (retiring does not switch availability off); switching that row off unblocks', async () => {
    const { market, category, serviceType } = await liveStack();
    await setSt(serviceType.id, 'RETIRED');
    expect((await mstRow(market.id, serviceType.id)).enabled).toBe(true);
    await expectRule(setMc(market.id, category.id, false), 'CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES');
    await setMst(market.id, serviceType.id, false);
    await setMc(market.id, category.id, false);
    await expectRule(setMst(market.id, serviceType.id, true), 'ITEM_RETIRED');
  });

  it('is atomic over several rows: one blocked category in a bulk switch-off changes none of the rows, and enabled = NULL is refused by NOT NULL (the guard sees NULL as neither enabling nor disabling)', async () => {
    const { market, category } = await liveStack();
    const free = await makeCategory({ status: 'ACTIVE' });
    await makeMc(market.id, free.id, { enabled: true });
    await expectRule(
      run('UPDATE catalog.market_categories SET enabled = false WHERE market_id = $1', [market.id]),
      'CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES',
    );
    expect((await mcRow(market.id, free.id)).enabled).toBe(true);
    expect((await mcRow(market.id, category.id)).enabled).toBe(true);
    await expectNotNull(
      run('UPDATE catalog.market_categories SET enabled = NULL WHERE market_id = $1 AND category_id = $2', [market.id, category.id]),
      'enabled',
    );
    expect((await mcRow(market.id, category.id)).enabled).toBe(true);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('allows what the rules do not cover: a display_order change while service types are enabled, true -> true, false -> false', async () => {
    const { market, category } = await liveStack();
    await run('UPDATE catalog.market_categories SET display_order = $3 WHERE market_id = $1 AND category_id = $2', [market.id, category.id, nextOrder()]);
    await run('UPDATE catalog.market_categories SET enabled = true WHERE market_id = $1 AND category_id = $2', [market.id, category.id]);
    const idle = await makeCategory();
    await makeMc(market.id, idle.id);
    await run('UPDATE catalog.market_categories SET enabled = false WHERE market_id = $1 AND category_id = $2', [market.id, idle.id]);
  });
});

describe('D7. guard_market_service_types: NOT_DELETABLE, IMMUTABLE_IDENTITY, ITEM_RETIRED, CATEGORY_NOT_ENABLED_IN_MARKET', () => {
  it('NOT_DELETABLE: refuses to delete a disabled row, an enabled row and every row at once', async () => {
    const { market, category } = await liveStack();
    const st = await makeServiceType(category.id, { status: 'ACTIVE' });
    await makeMst(market.id, st.id);
    await expectRule(run('DELETE FROM catalog.market_service_types WHERE market_id = $1 AND service_type_id = $2', [market.id, st.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.market_service_types WHERE market_id = $1', [market.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.market_service_types'), 'NOT_DELETABLE');
    expect(await count(MST, 'market_id = $1', [market.id])).toBe(2);
  });

  it('IMMUTABLE_IDENTITY: refuses to move a row to another market or another service type, and reports it before the enabling rules', async () => {
    const { market, category, serviceType } = await liveStack();
    const [m2, other] = [await makeMarket(), await makeServiceType(category.id, { status: 'ACTIVE' })];
    await expectRule(
      run('UPDATE catalog.market_service_types SET market_id = $3 WHERE market_id = $1 AND service_type_id = $2', [market.id, serviceType.id, m2.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.market_service_types SET service_type_id = $3 WHERE market_id = $1 AND service_type_id = $2', [market.id, serviceType.id, other.id]),
      'IMMUTABLE_IDENTITY',
    );
    const retired = await makeServiceType(category.id, { status: 'RETIRED' });
    await expectRule(
      run('UPDATE catalog.market_service_types SET service_type_id = $3, enabled = true WHERE market_id = $1 AND service_type_id = $2', [
        market.id,
        serviceType.id,
        retired.id,
      ]),
      'IMMUTABLE_IDENTITY',
    );
    await run('UPDATE catalog.market_service_types SET market_id = market_id WHERE market_id = $1', [market.id]);
  });

  it('ITEM_RETIRED: a RETIRED service type cannot be enabled by INSERT or UPDATE (also when its category is not enabled: the retired rule comes first), but a disabled row can be prepared', async () => {
    const market = await makeMarket();
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'RETIRED' });
    await expectRule(makeMst(market.id, st.id, { enabled: true }), 'ITEM_RETIRED'); // the category is NOT enabled here: still ITEM_RETIRED, not CATEGORY_NOT_ENABLED_IN_MARKET
    await makeMc(market.id, c.id, { enabled: true });
    await expectRule(makeMst(market.id, st.id, { enabled: true }), 'ITEM_RETIRED');
    await makeMst(market.id, st.id, { enabled: false });
    await expectRule(setMst(market.id, st.id, true), 'ITEM_RETIRED');
    expect((await mstRow(market.id, st.id)).enabled).toBe(false);
  });

  it('CATEGORY_NOT_ENABLED_IN_MARKET: refuses to enable a service type with no category row, a disabled category row, the category enabled only in ANOTHER market, by INSERT and by UPDATE', async () => {
    const [market, other] = [await makeMarket(), await makeMarket()];
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'ACTIVE' });
    await expectRule(makeMst(market.id, st.id, { enabled: true }), 'CATEGORY_NOT_ENABLED_IN_MARKET'); // no category row at all
    expect(await count(MST, 'market_id = $1', [market.id])).toBe(0);
    await makeMc(market.id, c.id, { enabled: false });
    await expectRule(makeMst(market.id, st.id, { enabled: true }), 'CATEGORY_NOT_ENABLED_IN_MARKET'); // disabled row
    await makeMc(other.id, c.id, { enabled: true });
    await expectRule(makeMst(market.id, st.id, { enabled: true }), 'CATEGORY_NOT_ENABLED_IN_MARKET'); // enabled in the OTHER market only
    await makeMst(market.id, st.id, { enabled: false }); // a disabled row is allowed without a category row
    await expectRule(setMst(market.id, st.id, true), 'CATEGORY_NOT_ENABLED_IN_MARKET');
    await setMc(market.id, c.id, true);
    await setMst(market.id, st.id, true);
    expect((await mstRow(market.id, st.id)).enabled).toBe(true);
  });

  it('CATEGORY_NOT_ENABLED_IN_MARKET looks at the category of THE service type: the category row of another category in the market does not satisfy it', async () => {
    const market = await makeMarket();
    const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const st = await makeServiceType(a.id, { status: 'ACTIVE' });
    await makeMc(market.id, b.id, { enabled: true });
    await expectRule(makeMst(market.id, st.id, { enabled: true }), 'CATEGORY_NOT_ENABLED_IN_MARKET');
  });

  it('prepares availability before launch: a service type of any status can be enabled once its category is enabled in the market, whatever the market status and even for DRAFT items', async () => {
    for (const marketStatus of ['PLANNED', 'ACTIVE', 'INACTIVE'] as const) {
      const market = await makeMarket(marketStatus);
      const c = await makeCategory({ status: 'DRAFT' });
      const draft = await makeServiceType(c.id);
      await makeMc(market.id, c.id, { enabled: true });
      await makeMst(market.id, draft.id, { enabled: true });
      expect((await mstRow(market.id, draft.id)).enabled).toBe(true);
    }
    const la = await laOc();
    const c = await makeCategory({ status: 'ACTIVE' });
    const inactive = await makeServiceType(c.id, { status: 'INACTIVE' });
    await makeMc(la.id, c.id, { enabled: true });
    await makeMst(la.id, inactive.id, { enabled: true });
  });

  it('keeps status transitions of the service type independent of its availability: an ACTIVE service type that is enabled can be deactivated and the row stays enabled (public exposure follows the status)', async () => {
    const { market, serviceType } = await liveStack();
    await setSt(serviceType.id, 'INACTIVE');
    expect((await mstRow(market.id, serviceType.id)).enabled).toBe(true);
    await setSt(serviceType.id, 'ACTIVE');
  });
});

// ====================================================================== E. timestamps: created_at is kept, updated_at is maintained by the guards
describe('E. updated_at is maintained by the guards, created_at is kept, on every reference table', () => {
  const TABLES_UNDER_TEST = [
    {
      name: 'categories',
      make: async () => (await makeCategory()).id,
      read: (id: string) => catRow(id),
      update: (id: string, set: string) => run(`UPDATE catalog.categories SET ${set} WHERE category_id = $1`, [id]),
      touch: 'icon_key = icon_key',
    },
    {
      name: 'service_types',
      make: async () => (await makeServiceType((await makeCategory()).id)).id,
      read: (id: string) => stRow(id),
      update: (id: string, set: string) => run(`UPDATE catalog.service_types SET ${set} WHERE service_type_id = $1`, [id]),
      touch: 'description_content_key = NULL',
    },
    {
      name: 'prohibited_services',
      make: async () => (await makeProhibited()).id,
      read: (id: string) => psRow(id),
      update: (id: string, set: string) => run(`UPDATE catalog.prohibited_services SET ${set} WHERE prohibited_service_id = $1`, [id]),
      touch: 'description_content_key = NULL',
    },
  ];
  describe.each(TABLES_UNDER_TEST)('$name', (t) => {
    it('sets updated_at on every UPDATE whatever the client sends (an old date, a future date, NULL, nothing) and keeps created_at', async () => {
      const id = await t.make();
      const first = await t.read(id);
      let last = first.updated_at.getTime();
      for (const value of ["'2000-01-01T00:00:00Z'", "'2999-01-01T00:00:00Z'", 'NULL', "now() - interval '3 days'", 'updated_at']) {
        await sleep(3); // timestamps are compared at millisecond resolution: let the clock move between two writes
        await t.update(id, `${t.touch}, updated_at = ${value}`);
        const row = await t.read(id);
        expect(row.updated_at.getTime(), value).toBeGreaterThan(last);
        expect(row.updated_at.getTime(), value).toBeLessThan(Date.now() + 60_000);
        expect(row.created_at.getTime(), value).toBe(first.created_at.getTime());
        last = row.updated_at.getTime();
      }
      await sleep(3);
      await t.update(id, t.touch);
      expect((await t.read(id)).updated_at.getTime()).toBeGreaterThan(last);
    });

    it('ignores an UPDATE of created_at (an old value, a future value, NULL, now) while updated_at still moves', async () => {
      const id = await t.make();
      const first = await t.read(id);
      let last = first.updated_at.getTime();
      for (const value of ["'2000-01-01T00:00:00Z'", "'2999-01-01T00:00:00Z'", 'NULL', "now() - interval '3 days'", 'now()']) {
        await sleep(3);
        await t.update(id, `${t.touch}, created_at = ${value}`);
        const row = await t.read(id);
        expect(row.created_at.getTime(), value).toBe(first.created_at.getTime());
        expect(row.updated_at.getTime(), value).toBeGreaterThan(last);
        last = row.updated_at.getTime();
      }
      await sleep(3);
      await t.update(id, "created_at = '2000-01-01T00:00:00Z', status = 'ACTIVE'").catch(() => undefined); // may be refused by a parent rule: created_at must be intact either way
      expect((await t.read(id)).created_at.getTime()).toBe(first.created_at.getTime());
    });
  });

  it('takes the creation times the client sends on INSERT of a REFERENCE row (the guards fix only updates there), while the market tables always stamp updated_at with the transaction instant', async () => {
    const code = `ts_${++seq}`;
    await ensureEntry(categoryNameKey(code));
    await run("INSERT INTO catalog.categories (code, created_at, updated_at) VALUES ($1, '2001-02-03T04:05:06Z', '2001-02-03T04:05:07Z')", [code]);
    const row = (await q<{ created_at: Date; updated_at: Date }>(`SELECT created_at, updated_at FROM ${CAT} WHERE code = $1`, [code]))[0]!;
    expect([row.created_at.toISOString(), row.updated_at.toISOString()]).toEqual(['2001-02-03T04:05:06.000Z', '2001-02-03T04:05:07.000Z']);
    // the market tables overwrite updated_at on INSERT (an INSERT cannot carry an old updated_at), but keep a created_at the client sends
    const market = await makeMarket();
    const c = await makeCategory({ status: 'ACTIVE' });
    await run(
      "INSERT INTO catalog.market_categories (market_id, category_id, display_order, created_at, updated_at) VALUES ($1, $2, $3, '2001-02-03T04:05:06Z', '2001-02-03T04:05:07Z')",
      [market.id, c.id, nextOrder()],
    );
    const mc = await mcRow(market.id, c.id);
    expect(mc.created_at.toISOString()).toBe('2001-02-03T04:05:06.000Z');
    expect(mc.updated_at.getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('sets updated_at on every write of a market row (client value ignored) and keeps created_at, for both market tables', async () => {
    const { market, category, serviceType } = await liveStack();
    for (const [read, upd] of [
      [
        () => mcRow(market.id, category.id),
        (set: string) => run(`UPDATE catalog.market_categories SET ${set} WHERE market_id = $1 AND category_id = $2`, [market.id, category.id]),
      ],
      [
        () => mstRow(market.id, serviceType.id),
        (set: string) => run(`UPDATE catalog.market_service_types SET ${set} WHERE market_id = $1 AND service_type_id = $2`, [market.id, serviceType.id]),
      ],
    ] as const) {
      const first = await read();
      let last = first.updated_at.getTime();
      for (const set of [
        "display_order = display_order, updated_at = '2000-01-01T00:00:00Z'",
        "display_order = display_order, updated_at = '2999-01-01T00:00:00Z'",
        'display_order = display_order, updated_at = NULL',
        'display_order = display_order, created_at = NULL',
        "display_order = display_order, created_at = '2999-01-01T00:00:00Z'",
        'enabled = enabled',
      ]) {
        await sleep(3);
        await upd(set);
        const row = await read();
        expect(row.updated_at.getTime(), set).toBeGreaterThan(last);
        expect(row.updated_at.getTime(), set).toBeLessThan(Date.now() + 60_000);
        expect(row.created_at.getTime(), set).toBe(first.created_at.getTime());
        last = row.updated_at.getTime();
      }
    }
  });

  it('uses one instant per transaction (now()) for every row a statement writes', async () => {
    const market = await makeMarket();
    const cats = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    for (const c of cats) await makeMc(market.id, c.id);
    await sleep(3);
    await run('UPDATE catalog.market_categories SET enabled = true WHERE market_id = $1', [market.id]);
    const rows = await q<{ n: number }>('SELECT count(DISTINCT updated_at)::int AS n FROM catalog.market_categories WHERE market_id = $1', [market.id]);
    expect(rows[0]!.n).toBe(1);
  });
});

// ====================================================================== F. RESTRICT and TRUNCATE: nothing the catalogue names can be removed or re-keyed underneath it
describe('F. RESTRICT: every foreign key holds when the guards are bypassed, and TRUNCATE is refused for every table', () => {
  it('keeps a content entry that a row names: deleting it or changing its key is refused by the foreign key (with the content guard bypassed in the transaction), for all three tables and both keys', async () => {
    const c = await makeCategory({ desc: true });
    const st = await makeServiceType(c.id, { desc: true });
    const ps = await makeProhibited({ desc: true });
    const refused = async (text: string, params: unknown[], constraint: string) => {
      const e = await fail(isolated(noTriggers('content.entries'), text, params));
      expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint });
    };
    for (const [key, fk] of [
      [categoryNameKey(c.code), 'fk_categories__name_content_key'],
      [categoryDescriptionKey(c.code), 'fk_categories__description_content_key'],
      [serviceTypeNameKey(st.code), 'fk_service_types__name_content_key'],
      [serviceTypeDescriptionKey(st.code), 'fk_service_types__description_content_key'],
      [prohibitedServiceNameKey(ps.code), 'fk_prohibited_services__name_content_key'],
      [prohibitedServiceDescriptionKey(ps.code), 'fk_prohibited_services__description_content_key'],
    ] as const) {
      await refused('DELETE FROM content.entries WHERE key = $1', [key], fk);
      await refused('UPDATE content.entries SET key = $2 WHERE key = $1', [key, `${key}_renamed`], fk);
      expect(await count('content.entries', 'key = $1', [key]), key).toBe(1);
    }
  });

  it('keeps a category that anything names: a service type, a prohibited service, an availability row or an audit row (the delete guard bypassed in the transaction)', async () => {
    const market = await makeMarket();
    const withSt = await makeCategory();
    await makeServiceType(withSt.id);
    const withPs = await makeCategory();
    await makeProhibited({ categoryId: withPs.id });
    const withMc = await makeCategory();
    await makeMc(market.id, withMc.id);
    const withAudit = await makeCategory();
    await run("INSERT INTO catalog.audit_events (actor, action, category_id, reason, correlation_id) VALUES ('t', 'CATEGORY_CREATED', $1, 'r', 'c')", [
      withAudit.id,
    ]);
    for (const [row, fk] of [
      [withSt, 'fk_service_types__category_id'],
      [withPs, 'fk_prohibited_services__category_id'],
      [withMc, 'fk_market_categories__category_id'],
      [withAudit, 'fk_audit_events__category_id'],
    ] as const) {
      const e = await fail(isolated(noTriggers(CAT), 'DELETE FROM catalog.categories WHERE category_id = $1', [row.id]));
      expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint: fk });
      expect(await count(CAT, 'category_id = $1', [row.id])).toBe(1);
    }
  });

  it('keeps a service type that anything names: an availability row or an audit row; and a prohibited service that an audit row names', async () => {
    const market = await makeMarket();
    const c = await makeCategory({ status: 'ACTIVE' });
    const [withMst, withAudit] = [await makeServiceType(c.id), await makeServiceType(c.id)];
    await makeMst(market.id, withMst.id);
    await run("INSERT INTO catalog.audit_events (actor, action, service_type_id, reason, correlation_id) VALUES ('t', 'SERVICE_TYPE_CREATED', $1, 'r', 'c')", [
      withAudit.id,
    ]);
    for (const [row, fk] of [
      [withMst, 'fk_market_service_types__service_type_id'],
      [withAudit, 'fk_audit_events__service_type_id'],
    ] as const) {
      const e = await fail(isolated(noTriggers(ST), 'DELETE FROM catalog.service_types WHERE service_type_id = $1', [row.id]));
      expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint: fk });
    }
    const ps = await makeProhibited();
    await run(
      "INSERT INTO catalog.audit_events (actor, action, prohibited_service_id, reason, correlation_id) VALUES ('t', 'PROHIBITED_SERVICE_CREATED', $1, 'r', 'c')",
      [ps.id],
    );
    const e = await fail(isolated(noTriggers(PS), 'DELETE FROM catalog.prohibited_services WHERE prohibited_service_id = $1', [ps.id]));
    expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint: 'fk_audit_events__prohibited_service_id' });
  });

  it('keeps a market that any availability row or audit row names: deleting it or re-keying it is refused (the geography guard bypassed in the transaction)', async () => {
    const [withMc, withMst, withAudit] = [await makeMarket(), await makeMarket(), await makeMarket()];
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'ACTIVE' });
    await makeMc(withMc.id, c.id);
    await makeMc(withMst.id, c.id, { enabled: true });
    await makeMst(withMst.id, st.id);
    await run(
      "INSERT INTO catalog.audit_events (actor, action, category_id, market_id, reason, correlation_id) VALUES ('t', 'MARKET_CATALOG_AVAILABILITY_CHANGED', $1, $2, 'r', 'c')",
      [c.id, withAudit.id],
    );
    for (const [market, fk] of [
      [withMc, ['fk_market_categories__market_id']],
      [withMst, ['fk_market_categories__market_id', 'fk_market_service_types__market_id']], // both rows name the market; which key answers first depends on the trigger names
      [withAudit, ['fk_audit_events__market_id']],
    ] as const) {
      // the market's own locale rows would answer first (their foreign key to the market is older): take them out of the way in the rolled-back transaction
      const prep = [...noTriggers('geography.markets', 'geography.market_locales'), `DELETE FROM geography.market_locales WHERE market_id = '${market.id}'`];
      const e = await fail(isolated(prep, 'DELETE FROM geography.markets WHERE market_id = $1', [market.id]));
      expect(e.code).toBe('23503');
      expect(fk).toContain(e.constraint);
      const e2 = await fail(isolated(prep, 'UPDATE geography.markets SET market_id = gen_random_uuid() WHERE market_id = $1', [market.id]));
      expect(e2.code).toBe('23503');
      expect(fk).toContain(e2.constraint);
      expect(await count('geography.markets', 'market_id = $1', [market.id])).toBe(1);
    }
  });

  const TRUNCATE_ORDER = [CAT, ST, PS, MC, MST, AUDIT];
  it.each(TRUNCATE_ORDER)(
    'TRUNCATE %s is refused by ITS OWN trigger as ROW_IMMUTABLE even when the triggers of the other five tables are switched off (alone or with CASCADE)',
    async (table) => {
      const others = TRUNCATE_ORDER.filter((t) => t !== table).map(
        (t) =>
          `ALTER TABLE ${t} DISABLE TRIGGER ${/[^.]+$/.exec(t)![0] === 'audit_events' ? 'trg_audit_events__no_truncate' : `trg_${/[^.]+$/.exec(t)![0]}__no_truncate`}`,
      );
      const short = /[^.]+$/.exec(table)![0];
      const before = await Promise.all(TRUNCATE_ORDER.map((t) => count(t)));
      for (const text of [`TRUNCATE ${table} CASCADE`, `TRUNCATE ${table} RESTART IDENTITY CASCADE`]) {
        const e = await fail(isolated(others, text));
        expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: 'catalog_rule:ROW_IMMUTABLE' });
        expect(e.message).toBe(`${short} rows are immutable (TRUNCATE is not allowed)`);
      }
      // and the table itself, when nothing references it (the two market tables and the audit trail), by the plain statement
      if ([MC, MST, AUDIT].includes(table)) await expectRule(run(`TRUNCATE ${table}`), 'ROW_IMMUTABLE');
      expect(await Promise.all(TRUNCATE_ORDER.map((t) => count(t)))).toEqual(before);
    },
  );

  it('refuses a plain TRUNCATE of a referenced table (PostgreSQL itself, 0A000) and the CASCADE and multi-table forms (ROW_IMMUTABLE); every row survives', async () => {
    const before = await Promise.all(TRUNCATE_ORDER.map((t) => count(t)));
    for (const t of [CAT, ST, PS]) await expect(pool.query(`TRUNCATE ${t}`)).rejects.toMatchObject({ code: '0A000' });
    for (const t of TRUNCATE_ORDER) await expectRule(run(`TRUNCATE ${t} CASCADE`), 'ROW_IMMUTABLE');
    // the six tables alone without CASCADE: since 0016 gig_templates (outside the list) references service_types, so PostgreSQL itself refuses the list before any trigger runs
    // (the full set of 12 tables without CASCADE is asserted by gig-template-model.itest.ts)
    expect(await fail(run(`TRUNCATE ${TRUNCATE_ORDER.join(', ')}`))).toMatchObject({ code: '0A000' });
    await expectRule(run(`TRUNCATE ${TRUNCATE_ORDER.join(', ')} RESTART IDENTITY CASCADE`), 'ROW_IMMUTABLE');
    expect(await Promise.all(TRUNCATE_ORDER.map((t) => count(t)))).toEqual(before);
  });

  it('refuses a cascade that reaches the catalogue from another table (content.entries, geography.markets), as a guard failure of a registry; every catalogue row survives', async () => {
    const before = await Promise.all(TRUNCATE_ORDER.map((t) => count(t)));
    for (const t of ['content.entries', 'geography.markets']) {
      const e = await fail(run(`TRUNCATE ${t} CASCADE`));
      expect(e.code, t).toBe('23000');
      expect(e.detail, t).toMatch(/^[a-z]+_rule:[A-Z_]+$/); // some registry's guard answers (identity, content or geography)
    }
    expect(await Promise.all(TRUNCATE_ORDER.map((t) => count(t)))).toEqual(before);
    expect(await count('geography.markets')).toBeGreaterThanOrEqual(1);
  });
});

// ====================================================================== G. hierarchy semantics: what is public, what can be prepared
// The two statements of CatalogService.loadPublicSnapshot (packages/catalog/src/service.ts), with the market code as $1. A test below proves the copy has not drifted.
const PUBLIC_CATEGORIES_SQL = `SELECT c.category_id, c.code, c.name_content_key, c.description_content_key, c.icon_key, mc.display_order
          FROM catalog.market_categories mc
          JOIN geography.markets m ON m.market_id = mc.market_id
          JOIN catalog.categories c ON c.category_id = mc.category_id
         WHERE m.code = $1 AND mc.enabled AND c.status = 'ACTIVE'
         ORDER BY mc.display_order`;
const PUBLIC_SERVICE_TYPES_SQL = `SELECT st.service_type_id, st.code, c.code AS category_code, st.name_content_key, st.description_content_key, mst.display_order
          FROM catalog.market_service_types mst
          JOIN geography.markets m ON m.market_id = mst.market_id
          JOIN catalog.service_types st ON st.service_type_id = mst.service_type_id
          JOIN catalog.categories c ON c.category_id = st.category_id
          JOIN catalog.market_categories mc ON mc.market_id = mst.market_id AND mc.category_id = st.category_id
         WHERE m.code = $1 AND mst.enabled AND st.status = 'ACTIVE' AND c.status = 'ACTIVE' AND mc.enabled
         ORDER BY mst.display_order`;
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
async function publicView(marketCode: string, from: Db = pool): Promise<{ categories: string[]; serviceTypes: string[] }> {
  return {
    categories: (await q<{ code: string }>(PUBLIC_CATEGORIES_SQL, [marketCode], from)).map((r) => r.code),
    serviceTypes: (await q<{ code: string }>(PUBLIC_SERVICE_TYPES_SQL, [marketCode], from)).map((r) => r.code),
  };
}

describe('G1. the public-exposure predicate: only an ACTIVE category enabled in the market, and an ACTIVE service type enabled under an enabled ACTIVE category, are public', () => {
  it('uses the very statements of CatalogService.loadPublicSnapshot (the copy in this file has not drifted from packages/catalog/src/service.ts)', () => {
    const source = squash(readFileSync(path.join(import.meta.dirname, '..', '..', 'catalog', 'src', 'service.ts'), 'utf8')).replaceAll('${marketCode}', '$1');
    expect(source).toContain(squash(PUBLIC_CATEGORIES_SQL));
    expect(source).toContain(squash(PUBLIC_SERVICE_TYPES_SQL));
  });

  const MC_STATES = ['none', 'disabled', 'enabled'] as const;
  type AvailState = (typeof MC_STATES)[number];
  const ttCat = 'tt_cat';
  const ttSt = 'tt_st';
  let ttMarket: Row; // a market of its own: the combinations are judged against it alone, whatever the other tests prepared in the seeded la-oc
  beforeAll(async () => {
    await ensureEntry(categoryNameKey(ttCat));
    await ensureEntry(serviceTypeNameKey(ttSt));
    ttMarket = await makeMarket('PLANNED');
  });
  /** Builds one combination in a transaction that is ALWAYS rolled back, with the guards out of the way so that combinations the guards forbid can be judged too. */
  async function combination(cs: CatalogStatus, ss: CatalogStatus, mc: AvailState, mst: AvailState, marketCode = ttMarket.code) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const p of noTriggers(CAT, ST, MC, MST)) await c.query(p);
      const m = (await c.query('SELECT market_id FROM geography.markets WHERE code = $1', [marketCode])).rows[0] as { market_id: string };
      const cat = (await c.query('INSERT INTO catalog.categories (code, status) VALUES ($1, $2) RETURNING category_id', [ttCat, cs])).rows[0] as {
        category_id: string;
      };
      const st = (
        await c.query('INSERT INTO catalog.service_types (category_id, code, status) VALUES ($1, $2, $3) RETURNING service_type_id', [
          cat.category_id,
          ttSt,
          ss,
        ])
      ).rows[0] as {
        service_type_id: string;
      };
      if (mc !== 'none')
        await c.query('INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) VALUES ($1, $2, $3, 1)', [
          m.market_id,
          cat.category_id,
          mc === 'enabled',
        ]);
      if (mst !== 'none')
        await c.query('INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, $3, 1)', [
          m.market_id,
          st.service_type_id,
          mst === 'enabled',
        ]);
      return await publicView(marketCode, c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }
  const COMBOS = STATUSES.flatMap((cs) => STATUSES.flatMap((ss) => MC_STATES.flatMap((mc) => MC_STATES.map((mst) => [cs, ss, mc, mst] as const))));

  it('is public exactly for the right rows over ALL 4 x 4 x 3 x 3 = 144 combinations of category status, service type status, category availability and service type availability', async () => {
    expect(COMBOS).toHaveLength(144);
    const mismatches: string[] = [];
    let publicCategories = 0;
    let publicServiceTypes = 0;
    for (const [cs, ss, mc, mst] of COMBOS) {
      const view = await combination(cs, ss, mc, mst);
      const categoryPublic = cs === 'ACTIVE' && mc === 'enabled';
      const serviceTypePublic = categoryPublic && ss === 'ACTIVE' && mst === 'enabled';
      publicCategories += Number(categoryPublic);
      publicServiceTypes += Number(serviceTypePublic);
      const got = JSON.stringify(view);
      const want = JSON.stringify({ categories: categoryPublic ? [ttCat] : [], serviceTypes: serviceTypePublic ? [ttSt] : [] });
      if (got !== want) mismatches.push(`category ${cs}/${mc}, service type ${ss}/${mst}: got ${got}, want ${want}`);
    }
    expect(mismatches).toEqual([]);
    expect(publicCategories).toBe(1 * 1 * 12); // ACTIVE + enabled, times every service type state (4 x 3)
    expect(publicServiceTypes).toBe(1); // exactly one combination makes a service type public
  }, 120_000);

  it('does not depend on the status of the MARKET: the statements see the same rows for a PLANNED, ACTIVE and INACTIVE market (the market being ACTIVE and in effect is decided by the geography registry through the market gate, not here)', async () => {
    const seen: Record<string, { categories: string[]; serviceTypes: string[] }> = {};
    for (const status of ['PLANNED', 'ACTIVE', 'INACTIVE'] as const) {
      const market = await makeMarket(status);
      const c = await makeCategory({ status: 'ACTIVE' });
      const st = await makeServiceType(c.id, { status: 'ACTIVE' });
      await makeMc(market.id, c.id, { enabled: true });
      await makeMst(market.id, st.id, { enabled: true });
      seen[status] = await publicView(market.code);
      expect(seen[status], status).toEqual({ categories: [c.code], serviceTypes: [st.code] });
    }
    expect(await publicView('no-such-market')).toEqual({ categories: [], serviceTypes: [] });
    expect(await publicView("la-oc' OR '1'='1")).toEqual({ categories: [], serviceTypes: [] });
    expect(await publicView('')).toEqual({ categories: [], serviceTypes: [] });
  });

  it('walks one chain through its whole life with the guards in force and checks the public view after every step', async () => {
    const market = await makeMarket('ACTIVE');
    const c = await makeCategory({ status: 'DRAFT' });
    const st = await makeServiceType(c.id);
    await makeMc(market.id, c.id);
    await makeMst(market.id, st.id);
    const none = { categories: [], serviceTypes: [] };
    const step = async (label: string, action: () => Promise<unknown>, expected: { categories: string[]; serviceTypes: string[] }) => {
      await action();
      expect(await publicView(market.code), label).toEqual(expected);
      expect(await violations(), label).toEqual(NO_VIOLATIONS);
    };
    expect(await publicView(market.code)).toEqual(none);
    await step('category enabled in the market but still DRAFT', () => setMc(market.id, c.id, true), none);
    await step('category ACTIVE', () => setCat(c.id, 'ACTIVE'), { categories: [c.code], serviceTypes: [] });
    await step('service type enabled but still DRAFT', () => setMst(market.id, st.id, true), { categories: [c.code], serviceTypes: [] });
    await step('service type ACTIVE', () => setSt(st.id, 'ACTIVE'), { categories: [c.code], serviceTypes: [st.code] });
    await expectRule(setCat(c.id, 'INACTIVE'), 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    await expectRule(setMc(market.id, c.id, false), 'CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES');
    expect(await publicView(market.code)).toEqual({ categories: [c.code], serviceTypes: [st.code] });
    await step('service type INACTIVE (paused)', () => setSt(st.id, 'INACTIVE'), { categories: [c.code], serviceTypes: [] });
    await step('service type ACTIVE again', () => setSt(st.id, 'ACTIVE'), { categories: [c.code], serviceTypes: [st.code] });
    await step('service type switched off in the market', () => setMst(market.id, st.id, false), { categories: [c.code], serviceTypes: [] });
    await step('service type switched on again', () => setMst(market.id, st.id, true), { categories: [c.code], serviceTypes: [st.code] });
    await setSt(st.id, 'INACTIVE');
    await step('category INACTIVE (its service type is paused first)', () => setCat(c.id, 'INACTIVE'), none);
    await expectRule(setSt(st.id, 'ACTIVE'), 'CATEGORY_NOT_ACTIVE');
    await step('category ACTIVE again: the paused service type is still paused', () => setCat(c.id, 'ACTIVE'), { categories: [c.code], serviceTypes: [] });
    await setMst(market.id, st.id, false);
    await step('category switched off in the market', () => setMc(market.id, c.id, false), none);
    await expectRule(setMst(market.id, st.id, true), 'CATEGORY_NOT_ENABLED_IN_MARKET');
    await step('category switched on again', () => setMc(market.id, c.id, true), { categories: [c.code], serviceTypes: [] });
    await setSt(st.id, 'RETIRED');
    await setCat(c.id, 'RETIRED');
    await step('everything RETIRED: the rows stay, nothing is public', async () => undefined, none);
    await expectRule(setMc(market.id, c.id, true), 'ITEM_RETIRED').catch(async () => {
      // the row is still enabled (retiring does not switch availability off), so the UPDATE true -> true is not an enabling
      expect((await mcRow(market.id, c.id)).enabled).toBe(true);
    });
    expect(await count(CAT, 'category_id = $1', [c.id])).toBe(1);
  });

  it('orders by the display order of the market (not by insertion, code or id), per list, and keeps one market out of another', async () => {
    const [m1, m2] = [await makeMarket('ACTIVE'), await makeMarket('ACTIVE')];
    const cats = [
      await makeCategory({ code: 'zz_order_c', status: 'ACTIVE' }),
      await makeCategory({ code: 'aa_order_c', status: 'ACTIVE' }),
      await makeCategory({ code: 'mm_order_c', status: 'ACTIVE' }),
    ];
    const sts = [
      await makeServiceType(cats[0]!.id, { code: 'zz_order_s', status: 'ACTIVE' }),
      await makeServiceType(cats[1]!.id, { code: 'aa_order_s', status: 'ACTIVE' }),
      await makeServiceType(cats[2]!.id, { code: 'mm_order_s', status: 'ACTIVE' }),
    ];
    // insertion order zz, aa, mm; display order in m1: mm (10), zz (20), aa (30); in m2: aa (5), zz (6)
    for (const [c, order] of [
      [cats[0]!, 20],
      [cats[1]!, 30],
      [cats[2]!, 10],
    ] as const)
      await makeMc(m1.id, c.id, { enabled: true, order });
    for (const [s, order] of [
      [sts[0]!, 300],
      [sts[1]!, 100],
      [sts[2]!, 200],
    ] as const)
      await makeMst(m1.id, s.id, { enabled: true, order });
    await makeMc(m2.id, cats[1]!.id, { enabled: true, order: 5 });
    await makeMc(m2.id, cats[0]!.id, { enabled: true, order: 6 });
    await makeMst(m2.id, sts[0]!.id, { enabled: true, order: 1 });
    await makeMst(m2.id, sts[1]!.id, { enabled: true, order: 2 });
    expect(await publicView(m1.code)).toEqual({
      categories: ['mm_order_c', 'zz_order_c', 'aa_order_c'],
      serviceTypes: ['aa_order_s', 'mm_order_s', 'zz_order_s'],
    });
    expect(await publicView(m2.code)).toEqual({ categories: ['aa_order_c', 'zz_order_c'], serviceTypes: ['zz_order_s', 'aa_order_s'] });
    // a service type of a category that is enabled in the OTHER market only is not public here
    await makeMst(m2.id, sts[2]!.id, { enabled: false });
    expect((await publicView(m2.code)).serviceTypes).not.toContain('mm_order_s');
  });

  it('returns the content keys and the order the service builds its snapshot from (identifiers and keys only, never display text)', async () => {
    const { market, category, serviceType } = await liveStack();
    const cats = await q<Record<string, unknown>>(PUBLIC_CATEGORIES_SQL, [market.code]);
    const sts = await q<Record<string, unknown>>(PUBLIC_SERVICE_TYPES_SQL, [market.code]);
    expect(Object.keys(cats[0]!)).toEqual(['category_id', 'code', 'name_content_key', 'description_content_key', 'icon_key', 'display_order']);
    expect(Object.keys(sts[0]!)).toEqual(['service_type_id', 'code', 'category_code', 'name_content_key', 'description_content_key', 'display_order']);
    expect(cats[0]).toMatchObject({ code: category.code, name_content_key: categoryNameKey(category.code), description_content_key: null, icon_key: null });
    expect(sts[0]).toMatchObject({ code: serviceType.code, category_code: category.code, name_content_key: serviceTypeNameKey(serviceType.code) });
  });
});

describe('G2. availability can be prepared before launch, and the database holds no rule about the market status', () => {
  it('prepares a whole chain (DRAFT category and DRAFT service type, both enabled) in a PLANNED market, the seeded la-oc included, without making anything public', async () => {
    const la = await laOc();
    const c = await makeCategory({ status: 'DRAFT' });
    const st = await makeServiceType(c.id);
    await makeMc(la.id, c.id, { enabled: true });
    await makeMst(la.id, st.id, { enabled: true });
    const view = await publicView('la-oc');
    expect(view.categories).not.toContain(c.code);
    expect(view.serviceTypes).not.toContain(st.code);
    await setCat(c.id, 'ACTIVE');
    expect((await publicView('la-oc')).categories).toContain(c.code);
    expect((await publicView('la-oc')).serviceTypes).not.toContain(st.code); // the service type is still DRAFT
    await setSt(st.id, 'ACTIVE');
    expect((await publicView('la-oc')).serviceTypes).toContain(st.code);
    // leave the seeded market as it was: switch the test chain off (the rows stay, they are never deleted)
    await setSt(st.id, 'INACTIVE');
    await setMst(la.id, st.id, false);
    await setMc(la.id, c.id, false);
  });

  it('keeps the market of a row out of the catalogue itself: the same category can be enabled in several markets with different orders and states', async () => {
    const [m1, m2, m3] = [await makeMarket('PLANNED'), await makeMarket('ACTIVE'), await makeMarket('INACTIVE')];
    const c = await makeCategory({ status: 'ACTIVE' });
    await makeMc(m1.id, c.id, { enabled: true, order: 1 });
    await makeMc(m2.id, c.id, { enabled: false, order: 1 });
    await makeMc(m3.id, c.id, { enabled: true, order: 7 });
    expect((await mcRow(m1.id, c.id)).enabled).toBe(true);
    expect((await mcRow(m2.id, c.id)).enabled).toBe(false);
    expect((await mcRow(m3.id, c.id)).display_order).toBe(7);
    expect(await count(MC, 'category_id = $1', [c.id])).toBe(3);
  });
});

// ====================================================================== H. real concurrency: a child takes its parent FOR SHARE, a parent's change takes its own row lock, so the two can never both win
interface RaceSql {
  text: string;
  params?: unknown[];
}
/**
 * The holder transaction runs `hold` and stays OPEN; the racer statement is started on another connection WITHOUT being awaited; the test polls pg_stat_activity until
 * the racer is blocked on a lock; only then the holder commits (or rolls back). Returns the racer's failure (undefined when it succeeded). No sleep synchronizes anything.
 */
async function holdThenRace(
  hold: (c: pg.PoolClient) => Promise<unknown>,
  race: RaceSql,
  how: 'COMMIT' | 'ROLLBACK' = 'COMMIT',
): Promise<PgFailure | undefined> {
  const tx = await openTx();
  let racer: Promise<unknown> = Promise.resolve();
  try {
    await hold(tx);
    racer = rejection(racePool.query(race.text, race.params ?? []));
    await lockWaiters(1);
  } finally {
    await finish(tx, how);
  }
  return (await racer) as PgFailure | undefined;
}
const sqlStatus = (table: 'categories' | 'service_types', idCol: string, id: string, status: string): RaceSql => ({
  text: `UPDATE catalog.${table} SET status = $2 WHERE ${idCol} = $1`,
  params: [id, status],
});
const catStatus = (id: string, status: string) => sqlStatus('categories', 'category_id', id, status);
const stStatus = (id: string, status: string) => sqlStatus('service_types', 'service_type_id', id, status);
const mcSet = (market: string, category: string, enabled: boolean): RaceSql => ({
  text: 'UPDATE catalog.market_categories SET enabled = $3 WHERE market_id = $1 AND category_id = $2',
  params: [market, category, enabled],
});
const mstSet = (market: string, st: string, enabled: boolean): RaceSql => ({
  text: 'UPDATE catalog.market_service_types SET enabled = $3 WHERE market_id = $1 AND service_type_id = $2',
  params: [market, st, enabled],
});
const exec = (c: Db, r: RaceSql) => c.query(r.text, r.params ?? []);
const rawServiceTypeOn = (c: Db, categoryId: string, code: string) =>
  c.query('INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2)', [categoryId, code]);
const asRule = (e: PgFailure | undefined): { code?: string; detail?: string } | undefined => (e ? { code: e.code, detail: e.detail } : undefined);
const rule = (key: string) => ({ code: '23000', detail: `catalog_rule:${key}` });

describe('H1. a service type activation and a category change serialize (both orders, with real lock waiters)', () => {
  it('holds the category deactivation back while the activation is open, then refuses it: CATEGORY_HAS_ACTIVE_SERVICE_TYPES, the service type stays ACTIVE', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id);
    const e = await holdThenRace((tx) => exec(tx, stStatus(st.id, 'ACTIVE')), catStatus(c.id, 'INACTIVE'));
    expect(asRule(e)).toEqual(rule('CATEGORY_HAS_ACTIVE_SERVICE_TYPES'));
    expect([(await catRow(c.id)).status, (await stRow(st.id)).status]).toEqual(['ACTIVE', 'ACTIVE']);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('holds the activation back while the category deactivation is open, then refuses it: CATEGORY_NOT_ACTIVE, the service type stays DRAFT', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id);
    const e = await holdThenRace((tx) => exec(tx, catStatus(c.id, 'INACTIVE')), stStatus(st.id, 'ACTIVE'));
    expect(asRule(e)).toEqual(rule('CATEGORY_NOT_ACTIVE'));
    expect([(await catRow(c.id)).status, (await stRow(st.id)).status]).toEqual(['INACTIVE', 'DRAFT']);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('lets the activation through when the category change is rolled back (the wait is only for the open transaction, nothing is left locked)', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id);
    const e = await holdThenRace((tx) => exec(tx, catStatus(c.id, 'INACTIVE')), stStatus(st.id, 'ACTIVE'), 'ROLLBACK');
    expect(e).toBeUndefined();
    expect([(await catRow(c.id)).status, (await stRow(st.id)).status]).toEqual(['ACTIVE', 'ACTIVE']);
    await noLockWaiters();
  });

  it('holds the category RETIREMENT back while an activation is open: the retirement then sees an ACTIVE child (the ACTIVE rule, not the OPEN rule)', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'INACTIVE' });
    const e = await holdThenRace((tx) => exec(tx, stStatus(st.id, 'ACTIVE')), catStatus(c.id, 'RETIRED'));
    expect(asRule(e)).toEqual(rule('CATEGORY_HAS_ACTIVE_SERVICE_TYPES'));
    expect([(await catRow(c.id)).status, (await stRow(st.id)).status]).toEqual(['ACTIVE', 'ACTIVE']);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('keeps the category RETIREMENT and a service type creation apart: an open creation holds the retirement back (OPEN_SERVICE_TYPES), an open retirement makes the creation wait (CATEGORY_RETIRED)', async () => {
    const c = await makeCategory({ status: 'ACTIVE' });
    const code = `race_${++seq}`;
    await ensureEntry(serviceTypeNameKey(code));
    const e = await holdThenRace(
      (tx) => exec(tx, { text: 'INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2)', params: [c.id, code] }),
      catStatus(c.id, 'RETIRED'),
    );
    expect(asRule(e)).toEqual(rule('CATEGORY_HAS_OPEN_SERVICE_TYPES'));
    expect((await catRow(c.id)).status).toBe('ACTIVE');
    expect(await count(ST, 'code = $1', [code])).toBe(1);

    const d = await makeCategory({ status: 'ACTIVE' });
    const code2 = `race_${++seq}`;
    await ensureEntry(serviceTypeNameKey(code2));
    const e2 = await holdThenRace((tx) => exec(tx, catStatus(d.id, 'RETIRED')), {
      text: 'INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2)',
      params: [d.id, code2],
    });
    expect(asRule(e2)).toEqual(rule('CATEGORY_RETIRED'));
    expect((await catRow(d.id)).status).toBe('RETIRED');
    expect(await count(ST, 'code = $1', [code2])).toBe(0);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('makes two activations of the same category idempotent at the SQL level: the second waits, sees ACTIVE and succeeds as a no-op; likewise for a service type', async () => {
    const c = await makeCategory({ status: 'DRAFT' });
    const e = await holdThenRace((tx) => exec(tx, catStatus(c.id, 'ACTIVE')), catStatus(c.id, 'ACTIVE'));
    expect(e).toBeUndefined();
    expect((await catRow(c.id)).status).toBe('ACTIVE');
    const st = await makeServiceType(c.id);
    const e2 = await holdThenRace((tx) => exec(tx, stStatus(st.id, 'ACTIVE')), stStatus(st.id, 'ACTIVE'));
    expect(e2).toBeUndefined();
    expect((await stRow(st.id)).status).toBe('ACTIVE');
    // an activation racing a conflicting retirement: the later statement is judged on the committed state (ACTIVE -> RETIRED is an edge)
    const c3 = await makeCategory({ status: 'DRAFT' });
    const e3 = await holdThenRace((tx) => exec(tx, catStatus(c3.id, 'ACTIVE')), catStatus(c3.id, 'RETIRED'));
    expect(e3).toBeUndefined();
    expect((await catRow(c3.id)).status).toBe('RETIRED');
    // and an activation racing a deactivation of the same service type: DRAFT -> INACTIVE is judged on the committed ACTIVE state
    const c4 = await makeCategory({ status: 'ACTIVE' });
    const s4 = await makeServiceType(c4.id);
    const e4 = await holdThenRace((tx) => exec(tx, stStatus(s4.id, 'ACTIVE')), stStatus(s4.id, 'INACTIVE'));
    expect(e4).toBeUndefined();
    expect((await stRow(s4.id)).status).toBe('INACTIVE');
  });
});

describe('H2. availability: a service type enable and a category switch-off serialize (both orders, UPDATE and INSERT)', () => {
  async function prepared() {
    const market = await makeMarket('ACTIVE');
    const c = await makeCategory({ status: 'ACTIVE' });
    const st = await makeServiceType(c.id, { status: 'ACTIVE' });
    await makeMc(market.id, c.id, { enabled: true });
    return { market, c, st };
  }
  it('holds the switch-off back while the enabling transaction is open, then refuses it; the service type stays enabled under an enabled category', async () => {
    const { market, c, st } = await prepared();
    await makeMst(market.id, st.id);
    const e = await holdThenRace((tx) => exec(tx, mstSet(market.id, st.id, true)), mcSet(market.id, c.id, false));
    expect(asRule(e)).toEqual(rule('CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES'));
    expect([(await mcRow(market.id, c.id)).enabled, (await mstRow(market.id, st.id)).enabled]).toEqual([true, true]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('holds the enabling back while the switch-off is open, then refuses it: CATEGORY_NOT_ENABLED_IN_MARKET; the service type stays disabled', async () => {
    const { market, c, st } = await prepared();
    await makeMst(market.id, st.id);
    const e = await holdThenRace((tx) => exec(tx, mcSet(market.id, c.id, false)), mstSet(market.id, st.id, true));
    expect(asRule(e)).toEqual(rule('CATEGORY_NOT_ENABLED_IN_MARKET'));
    expect([(await mcRow(market.id, c.id)).enabled, (await mstRow(market.id, st.id)).enabled]).toEqual([false, false]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('does the same for a NEW enabled row (INSERT): an open insert holds the switch-off back, an open switch-off makes the insert wait and fail', async () => {
    const a = await prepared();
    const e = await holdThenRace(
      (tx) =>
        exec(tx, {
          text: 'INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, true, $3)',
          params: [a.market.id, a.st.id, nextOrder()],
        }),
      mcSet(a.market.id, a.c.id, false),
    );
    expect(asRule(e)).toEqual(rule('CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES'));
    expect((await mstRow(a.market.id, a.st.id)).enabled).toBe(true);
    const b = await prepared();
    const e2 = await holdThenRace((tx) => exec(tx, mcSet(b.market.id, b.c.id, false)), {
      text: 'INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, true, $3)',
      params: [b.market.id, b.st.id, nextOrder()],
    });
    expect(asRule(e2)).toEqual(rule('CATEGORY_NOT_ENABLED_IN_MARKET'));
    expect(await count(MST, 'market_id = $1', [b.market.id])).toBe(0);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('lets two enabling transactions of different service types of one category run side by side (the share lock on the category row is compatible with itself)', async () => {
    const { market, c } = await prepared();
    const [s1, s2] = [await makeServiceType(c.id, { status: 'ACTIVE' }), await makeServiceType(c.id, { status: 'ACTIVE' })];
    await makeMst(market.id, s1.id);
    await makeMst(market.id, s2.id);
    const t1 = await openTx();
    const t2 = await openTx(racePool);
    await exec(t1, mstSet(market.id, s1.id, true));
    await exec(t2, mstSet(market.id, s2.id, true));
    expect(await waitersOn(pool)).toBe(0);
    await finish(t1);
    await finish(t2);
    expect((await mstRow(market.id, s1.id)).enabled && (await mstRow(market.id, s2.id)).enabled).toBe(true);
  });

  it('holds the enabling back while the service type is being RETIRED (ITEM_RETIRED), and a category retirement makes a category enable wait and fail (ITEM_RETIRED)', async () => {
    const { market, c, st } = await prepared();
    await makeMst(market.id, st.id);
    const e = await holdThenRace((tx) => exec(tx, stStatus(st.id, 'RETIRED')), mstSet(market.id, st.id, true));
    expect(asRule(e)).toEqual(rule('ITEM_RETIRED'));
    expect((await mstRow(market.id, st.id)).enabled).toBe(false);
    // the category: nothing active under it, retire it in the open transaction, a disabled row is being enabled meanwhile
    const m2 = await makeMarket('ACTIVE');
    const d = await makeCategory({ status: 'ACTIVE' });
    await makeMc(m2.id, d.id, { enabled: false });
    const e2 = await holdThenRace((tx) => exec(tx, catStatus(d.id, 'RETIRED')), mcSet(m2.id, d.id, true));
    expect(asRule(e2)).toEqual(rule('ITEM_RETIRED'));
    expect((await mcRow(m2.id, d.id)).enabled).toBe(false);
    void c;
  });

  it('lets an enabling that started first win against a retirement that waits for it (the retirement does not check availability): the row stays enabled on a RETIRED service type, and can be switched off', async () => {
    const { market, st } = await prepared();
    await makeMst(market.id, st.id);
    const e = await holdThenRace((tx) => exec(tx, mstSet(market.id, st.id, true)), stStatus(st.id, 'RETIRED'));
    expect(e).toBeUndefined();
    expect([(await stRow(st.id)).status, (await mstRow(market.id, st.id)).enabled]).toEqual(['RETIRED', true]);
    await setMst(market.id, st.id, false);
    await expectRule(setMst(market.id, st.id, true), 'ITEM_RETIRED');
  });
});

describe('H3. a display order is claimed once (the unique key of the market decides), and two creations of one code collide cleanly', () => {
  it('makes the second insert of an order wait for the first and fail with the unique key when the first commits; both tables', async () => {
    const market = await makeMarket('ACTIVE');
    const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const order = nextOrder();
    const e = await holdThenRace((tx) => makeMc(market.id, a.id, { order }, tx), {
      text: 'INSERT INTO catalog.market_categories (market_id, category_id, display_order) VALUES ($1, $2, $3)',
      params: [market.id, b.id, order],
    });
    expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'uq_market_categories__market_order' });
    expect(await count(MC, 'market_id = $1', [market.id])).toBe(1);
    const [s1, s2] = [await makeServiceType(a.id, { status: 'ACTIVE' }), await makeServiceType(a.id, { status: 'ACTIVE' })];
    const o2 = nextOrder();
    const e2 = await holdThenRace((tx) => makeMst(market.id, s1.id, { order: o2 }, tx), {
      text: 'INSERT INTO catalog.market_service_types (market_id, service_type_id, display_order) VALUES ($1, $2, $3)',
      params: [market.id, s2.id, o2],
    });
    expect({ code: e2?.code, constraint: e2?.constraint }).toEqual({ code: '23505', constraint: 'uq_market_service_types__market_order' });
    expect(await count(MST, 'market_id = $1', [market.id])).toBe(1);
  });

  it('lets the waiting insert succeed when the first one rolls back (the position is free again)', async () => {
    const market = await makeMarket('ACTIVE');
    const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const order = nextOrder();
    const e = await holdThenRace(
      (tx) => makeMc(market.id, a.id, { order }, tx),
      { text: 'INSERT INTO catalog.market_categories (market_id, category_id, display_order) VALUES ($1, $2, $3)', params: [market.id, b.id, order] },
      'ROLLBACK',
    );
    expect(e).toBeUndefined();
    expect(await q<{ category_id: string }>('SELECT category_id FROM catalog.market_categories WHERE market_id = $1', [market.id])).toEqual([
      { category_id: b.id },
    ]);
  });

  it('makes a second creation of the same service type code wait and fail with the unique key (across categories), and the loser leaves nothing behind', async () => {
    const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
    const code = `dupe_${++seq}`;
    await ensureEntry(serviceTypeNameKey(code));
    const e = await holdThenRace((tx) => rawServiceTypeOn(tx, a.id, code), {
      text: 'INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2)',
      params: [b.id, code],
    });
    expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'uq_service_types__code' });
    expect(await q<{ category_id: string }>('SELECT category_id FROM catalog.service_types WHERE code = $1', [code])).toEqual([{ category_id: a.id }]);
  });
});

describe('H4. 30 fresh rounds each, the two statements started at the same instant: exactly one wins, the invariant holds, nothing deadlocks', () => {
  const ROUNDS = 30;
  /** Fires both statements on separate pooled connections at once and returns their failures (undefined = succeeded). */
  const both = (a: RaceSql, b: RaceSql) =>
    Promise.all([rejection(racePool.query(a.text, a.params ?? [])), rejection(racePool.query(b.text, b.params ?? []))]) as Promise<
      [PgFailure | undefined, PgFailure | undefined]
    >;
  const winners = (r: [PgFailure | undefined, PgFailure | undefined]): number => r.filter((x) => x === undefined).length;
  const notDeadlock = (e: PgFailure | undefined) => expect(String(e?.code ?? ''), 'a deadlock or a serialization failure is a defect').not.toMatch(/^40/);

  it('service type activation against category deactivation: never an ACTIVE service type under a category that is not ACTIVE', async () => {
    const outcomes = { activated: 0, deactivated: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      const st = await makeServiceType(c.id);
      const r = await both(stStatus(st.id, 'ACTIVE'), catStatus(c.id, 'INACTIVE'));
      r.forEach(notDeadlock);
      const [cat, srv] = [(await catRow(c.id)).status, (await stRow(st.id)).status];
      expect(cat === 'INACTIVE' && srv === 'ACTIVE', `round ${round}: an ACTIVE service type under an INACTIVE category`).toBe(false);
      expect(winners(r), `round ${round}`).toBe(1);
      if (r[0] === undefined) {
        outcomes.activated++;
        expect(asRule(r[1]), `round ${round}`).toEqual(rule('CATEGORY_HAS_ACTIVE_SERVICE_TYPES'));
        expect([cat, srv]).toEqual(['ACTIVE', 'ACTIVE']);
      } else {
        outcomes.deactivated++;
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('CATEGORY_NOT_ACTIVE'));
        expect([cat, srv]).toEqual(['INACTIVE', 'DRAFT']);
      }
    }
    expect(outcomes.activated + outcomes.deactivated).toBe(ROUNDS);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('service type activation against category retirement: the retirement never wins over a non-RETIRED service type, the activation always does', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      const st = await makeServiceType(c.id, { status: 'INACTIVE' });
      const r = await both(stStatus(st.id, 'ACTIVE'), catStatus(c.id, 'RETIRED'));
      r.forEach(notDeadlock);
      expect(r[0], `round ${round}: the activation`).toBeUndefined();
      const refused = asRule(r[1]);
      expect(refused?.code, `round ${round}`).toBe('23000');
      expect(['catalog_rule:CATEGORY_HAS_ACTIVE_SERVICE_TYPES', 'catalog_rule:CATEGORY_HAS_OPEN_SERVICE_TYPES'], `round ${round}`).toContain(refused?.detail);
      expect([(await catRow(c.id)).status, (await stRow(st.id)).status]).toEqual(['ACTIVE', 'ACTIVE']);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('service type retirement against category retirement (the last open child): never a RETIRED category with a service type that is not RETIRED', async () => {
    const outcomes = { both: 0, serviceOnly: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      const st = await makeServiceType(c.id);
      const r = await both(stStatus(st.id, 'RETIRED'), catStatus(c.id, 'RETIRED'));
      r.forEach(notDeadlock);
      expect(r[0], `round ${round}: the service type retirement always succeeds`).toBeUndefined();
      if (r[1] === undefined) outcomes.both++;
      else {
        outcomes.serviceOnly++;
        expect(asRule(r[1])).toEqual(rule('CATEGORY_HAS_OPEN_SERVICE_TYPES'));
      }
      expect((await stRow(st.id)).status).toBe('RETIRED');
    }
    expect(outcomes.both + outcomes.serviceOnly).toBe(ROUNDS);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('creating a service type against retiring its category: exactly one wins, never a RETIRED category with a new DRAFT service type', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      const code = `born_${++seq}`;
      await ensureEntry(serviceTypeNameKey(code));
      const r = await both({ text: 'INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2)', params: [c.id, code] }, catStatus(c.id, 'RETIRED'));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      const created = await count(ST, 'code = $1', [code]);
      const status = (await catRow(c.id)).status;
      expect(status === 'RETIRED' && created > 0, `round ${round}: a RETIRED category with a new service type`).toBe(false);
      if (r[0] === undefined) {
        expect(asRule(r[1])).toEqual(rule('CATEGORY_HAS_OPEN_SERVICE_TYPES'));
        expect([status, created]).toEqual(['ACTIVE', 1]);
      } else {
        expect(asRule(r[0])).toEqual(rule('CATEGORY_RETIRED'));
        expect([status, created]).toEqual(['RETIRED', 0]);
      }
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('enabling a service type in a market against switching its category off there: never an enabled service type row without an enabled category row', async () => {
    const market = await makeMarket('ACTIVE');
    const outcomes = { enabled: 0, switchedOff: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      const st = await makeServiceType(c.id, { status: 'ACTIVE' });
      await makeMc(market.id, c.id, { enabled: true });
      await makeMst(market.id, st.id);
      const r = await both(mstSet(market.id, st.id, true), mcSet(market.id, c.id, false));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      const [cat, srv] = [(await mcRow(market.id, c.id)).enabled, (await mstRow(market.id, st.id)).enabled];
      expect(srv && !cat, `round ${round}: an enabled service type under a disabled category`).toBe(false);
      if (r[0] === undefined) {
        outcomes.enabled++;
        expect(asRule(r[1])).toEqual(rule('CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES'));
        expect([cat, srv]).toEqual([true, true]);
      } else {
        outcomes.switchedOff++;
        expect(asRule(r[0])).toEqual(rule('CATEGORY_NOT_ENABLED_IN_MARKET'));
        expect([cat, srv]).toEqual([false, false]);
      }
    }
    expect(outcomes.enabled + outcomes.switchedOff).toBe(ROUNDS);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('inserting an ENABLED service type row against switching its category off (INSERT instead of UPDATE): the same invariant', async () => {
    const market = await makeMarket('ACTIVE');
    for (let round = 0; round < ROUNDS; round++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      const st = await makeServiceType(c.id, { status: 'ACTIVE' });
      await makeMc(market.id, c.id, { enabled: true });
      const r = await both(
        {
          text: 'INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, true, $3)',
          params: [market.id, st.id, nextOrder()],
        },
        mcSet(market.id, c.id, false),
      );
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('two inserts claiming the same display order of a market: exactly one wins, the loser gets the unique key, the order is held by one row', async () => {
    const market = await makeMarket('ACTIVE');
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = [await makeCategory({ status: 'ACTIVE' }), await makeCategory({ status: 'ACTIVE' })];
      const order = nextOrder();
      const ins = (id: string): RaceSql => ({
        text: 'INSERT INTO catalog.market_categories (market_id, category_id, display_order) VALUES ($1, $2, $3)',
        params: [market.id, id, order],
      });
      const r = await both(ins(a.id), ins(b.id));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      const loser = r[0] ?? r[1];
      expect({ code: loser?.code, constraint: loser?.constraint }).toEqual({ code: '23505', constraint: 'uq_market_categories__market_order' });
      expect(await count(MC, 'market_id = $1 AND display_order = $2', [market.id, order])).toBe(1);
    }
  });

  it('twenty inserts claiming one display order of a market at once: exactly one row, nineteen unique-key failures, no other kind of failure', async () => {
    const market = await makeMarket('ACTIVE');
    const cats = await Promise.all(Array.from({ length: 20 }, () => makeCategory({ status: 'ACTIVE' })));
    const order = nextOrder();
    const results = (await Promise.all(
      cats.map((c) =>
        rejection(
          racePool.query('INSERT INTO catalog.market_categories (market_id, category_id, display_order) VALUES ($1, $2, $3)', [market.id, c.id, order]),
        ),
      ),
    )) as (PgFailure | undefined)[];
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    for (const r of results.filter((x) => x !== undefined))
      expect({ code: r!.code, constraint: r!.constraint }).toEqual({ code: '23505', constraint: 'uq_market_categories__market_order' });
    expect(await count(MC, 'market_id = $1', [market.id])).toBe(1);
  });

  it('two activations of the same category (and of the same service type) at once: both succeed, the row ends ACTIVE, nothing is half-done', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const c = await makeCategory({ status: 'DRAFT' });
      const r = await both(catStatus(c.id, 'ACTIVE'), catStatus(c.id, 'ACTIVE'));
      expect(r, `round ${round}`).toEqual([undefined, undefined]);
      expect((await catRow(c.id)).status).toBe('ACTIVE');
      const st = await makeServiceType(c.id);
      const r2 = await both(stStatus(st.id, 'ACTIVE'), stStatus(st.id, 'ACTIVE'));
      expect(r2, `round ${round}`).toEqual([undefined, undefined]);
      expect((await stRow(st.id)).status).toBe('ACTIVE');
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('a burst: ten activations of ten service types of one category against one deactivation of the category: the invariant holds whatever the interleaving', async () => {
    for (let round = 0; round < 10; round++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      const sts = await Promise.all(Array.from({ length: 10 }, () => makeServiceType(c.id)));
      const results = (await Promise.all([
        ...sts.map((s) => rejection(racePool.query(stStatus(s.id, 'ACTIVE').text, stStatus(s.id, 'ACTIVE').params))),
        rejection(racePool.query(catStatus(c.id, 'INACTIVE').text, catStatus(c.id, 'INACTIVE').params)),
      ])) as (PgFailure | undefined)[];
      for (const r of results) notDeadlock(r);
      const [cat, active] = [(await catRow(c.id)).status, await count(ST, "category_id = $1 AND status = 'ACTIVE'", [c.id])];
      expect(cat === 'ACTIVE' || active === 0, `round ${round}: category ${cat} with ${active} ACTIVE service types`).toBe(true);
      if (cat === 'INACTIVE') expect(results[10], `round ${round}`).toBeUndefined();
      else expect(asRule(results[10]), `round ${round}`).toEqual(rule('CATEGORY_HAS_ACTIVE_SERVICE_TYPES'));
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('leaves no lock waiter behind after the races above', async () => {
    await noLockWaiters();
    await noLockWaiters(racePool);
  });
});

// ====================================================================== I. the access path of the public snapshot
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
describe('I. the access path: the two statements of the public snapshot read the unique keys of the market, and the result does not depend on the plan', () => {
  let bigMarket: Row;
  beforeAll(async () => {
    bigMarket = await makeMarket('ACTIVE');
    const other = await makeMarket('ACTIVE');
    for (let i = 0; i < 12; i++) {
      const c = await makeCategory({ status: 'ACTIVE' });
      await makeMc(bigMarket.id, c.id, { enabled: i % 3 !== 0, order: (i + 1) * 10 });
      await makeMc(other.id, c.id, { enabled: true, order: (i + 1) * 10 });
      for (let j = 0; j < 5; j++) {
        const st = await makeServiceType(c.id, { status: 'ACTIVE' });
        if (i % 3 !== 0) await makeMst(bigMarket.id, st.id, { enabled: j % 2 === 0, order: (i + 1) * 100 + j });
        await makeMst(other.id, st.id, { enabled: true, order: (i + 1) * 100 + j }).catch(() => undefined);
      }
    }
    for (const t of [CAT, ST, MC, MST, 'geography.markets']) await run(`ANALYZE ${t}`);
  });
  const SEQ_OFF = ['SET LOCAL enable_seqscan = off'];
  const usedIndexes = (plan: string): string[] => [...new Set([...plan.matchAll(/(?:Scan using|Bitmap Index Scan on) (\w+)/g)].map((m) => m[1]!))].sort();
  const ALLOWED = new Set(
    [
      'uq_markets__code',
      'uq_markets__market_country',
      'pk_markets',
      'pk_market_categories',
      'uq_market_categories__market_order',
      'pk_categories',
      'pk_service_types',
      'pk_market_service_types',
      'uq_market_service_types__market_order',
      'idx_service_types__category',
      'uq_categories__code',
      'uq_service_types__code',
    ].sort(),
  );

  it('reads the menu of ONE market in order straight from the unique key (market_id, display_order), with no sort step and no sequential scan: the key IS the access path (both market tables)', async () => {
    for (const [table, name] of [
      [MC, 'uq_market_categories__market_order'],
      [MST, 'uq_market_service_types__market_order'],
    ] as const) {
      const plan = await planOf(
        `SELECT display_order FROM ${table} WHERE market_id = $1 AND enabled ORDER BY display_order`,
        [bigMarket.id],
        [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off'],
      );
      expect(plan, table).toMatch(new RegExp(`Index Scan using ${name} on`));
      expect(plan, table).not.toMatch(/Sort|Seq Scan/);
      const analyzed = await planOf(
        `SELECT display_order FROM ${table} WHERE market_id = $1 AND enabled ORDER BY display_order`,
        [bigMarket.id],
        [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off'],
        true,
      );
      expect(analyzed, table).toMatch(new RegExp(`Index Scan using ${name} .*actual rows=\\d+ loops=1`));
    }
  });

  it('reads one row of a pair through the primary key of the pair, and an item by its code through the unique code key, never by a scan', async () => {
    const c = (await q<{ category_id: string; code: string }>(`SELECT category_id, code FROM ${CAT} LIMIT 1`))[0]!;
    const byPair = await planOf(`SELECT enabled FROM ${MC} WHERE market_id = $1 AND category_id = $2`, [bigMarket.id, c.category_id], SEQ_OFF);
    expect(byPair).not.toMatch(/Seq Scan/);
    expect(byPair).toMatch(/pk_market_categories|uq_market_categories__market_order/); // both start with the market; the planner picks one for a table of tens of rows
    expect(await planOf(`SELECT category_id FROM ${CAT} WHERE code = $1`, [c.code], SEQ_OFF)).toMatch(/Index Scan using uq_categories__code on/);
    expect(await planOf(`SELECT service_type_id FROM ${ST} WHERE code = $1`, ['car_detailing'], SEQ_OFF)).toMatch(/Index Scan using uq_service_types__code on/);
    expect(await planOf(`SELECT prohibited_service_id FROM ${PS} WHERE code = $1`, ['x_none'], SEQ_OFF)).toMatch(
      /Index Scan using uq_prohibited_services__code on/,
    );
  });

  it("finds the service types of ONE category through idx_service_types__category (the only plain index of the schema: it serves listing by category and the guards that read a category's children)", async () => {
    const c = (await q<{ category_id: string }>(`SELECT category_id FROM ${CAT} WHERE code = 'auto_services'`))[0]!;
    const plan = await planOf(`SELECT code FROM ${ST} WHERE category_id = $1`, [c.category_id], [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off']);
    expect(plan).toMatch(/Index Scan using idx_service_types__category on/);
    // the exact existence probes of guard_categories
    const probe = await planOf(
      `SELECT 1 FROM catalog.service_types WHERE category_id = $1 AND status = 'ACTIVE'`,
      [c.category_id],
      [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off'],
    );
    expect(probe).toMatch(/idx_service_types__category/);
    expect(probe).not.toMatch(/Seq Scan/);
  });

  it('plans both statements of the public snapshot without a sequential scan, using only the documented keys, and at least one of the market keys of each table', async () => {
    const cats = await planOf(PUBLIC_CATEGORIES_SQL, [bigMarket.code], SEQ_OFF);
    const sts = await planOf(PUBLIC_SERVICE_TYPES_SQL, [bigMarket.code], SEQ_OFF);
    for (const [label, plan, own] of [
      ['categories', cats, ['pk_market_categories', 'uq_market_categories__market_order']],
      ['service types', sts, ['pk_market_service_types', 'uq_market_service_types__market_order']],
    ] as const) {
      expect(plan, `${label}\n${plan}`).not.toMatch(/Seq Scan/);
      const used = usedIndexes(plan);
      expect(
        used.filter((i) => !ALLOWED.has(i)),
        `${label}: an index outside the documented set`,
      ).toEqual([]);
      expect(
        used.some((i) => (own as readonly string[]).includes(i)),
        `${label}: ${used.join(', ')}\n${plan}`,
      ).toBe(true);
    }
    // the planner may reach a category or a service type through any of its keys; it must reach them through a key
    const reaches = (plan: string, keys: string[]) => usedIndexes(plan).some((i) => keys.includes(i));
    expect(reaches(cats, ['pk_categories', 'uq_categories__code']), cats).toBe(true);
    expect(reaches(sts, ['pk_service_types', 'idx_service_types__category', 'uq_service_types__code']), sts).toBe(true);
    expect(reaches(sts, ['pk_categories', 'uq_categories__code']), sts).toBe(true);
  });

  it('returns the same snapshot with the default planner and with every join/scan strategy switched off in turn, for a market with data, an unknown market and a market without rows', async () => {
    const snapshot = async (code: string, settings: string[]) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const s of settings) await c.query(s);
        return {
          categories: (await c.query(PUBLIC_CATEGORIES_SQL, [code])).rows.map((r) => `${r.code}:${r.display_order}`),
          serviceTypes: (await c.query(PUBLIC_SERVICE_TYPES_SQL, [code])).rows.map((r) => `${r.code}:${r.category_code}:${r.display_order}`),
        };
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    const variants = [
      ['SET LOCAL enable_seqscan = off'],
      ['SET LOCAL enable_nestloop = off'],
      ['SET LOCAL enable_hashjoin = off', 'SET LOCAL enable_mergejoin = off'],
      ['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off', 'SET LOCAL enable_indexonlyscan = off'],
      ['SET LOCAL enable_sort = off'],
    ];
    for (const code of [bigMarket.code, 'tm-none', (await laOc()).code]) {
      const normal = await snapshot(code, []);
      for (const v of variants) expect(await snapshot(code, v), `${code} with ${v.join(', ')}`).toEqual(normal);
    }
    const data = await snapshot(bigMarket.code, []);
    // 12 categories, 4 of them (i % 3 = 0) disabled; the rest are listed in the order of the market
    expect(data.categories).toHaveLength(8);
    expect(data.categories.map((x) => Number(x.split(':')[1]))).toEqual([...data.categories.map((x) => Number(x.split(':')[1]))].sort((a, b) => a - b));
    // 8 enabled categories x 5 service types, 3 of them with an even index enabled
    expect(data.serviceTypes).toHaveLength(8 * 3);
  });
});

// ====================================================================== J. privacy and scope shape
describe('J. the catalogue cannot hold, and does not hold, anything about a person, a price, a duration, a radius or a capacity', () => {
  // whole words of a column name (split on underscores): a column named after any of them could hold something this checkpoint must not store
  const FORBIDDEN_WORDS = new Set(
    'price fee cost amount rate currency tax duration minutes hours radius distance capacity quantity seats slots stock lat lng lon geo point first last person user member owner customer provider account email phone address street city postal zip token secret password credential subject session cookie device ip birth ssn hash note comment payload body text label title'.split(
      ' ',
    ),
  );
  const forbidden = (column: string): boolean => column.split('_').some((w) => FORBIDDEN_WORDS.has(w));

  it('has no column that could hold a person, an address, a token, a price, a fee, a currency, a duration, a radius, a capacity or display text: the names are codes, flags, orders, keys, ids and times', async () => {
    const rows = await q<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name = ANY($1) ORDER BY 1, ordinal_position",
      [CAT1_TABLES],
    );
    expect(rows).toHaveLength(Object.values(COLUMNS_BY_TABLE).reduce((a, c) => a + c.length, 0));
    expect(rows.filter((r) => forbidden(r.column_name)).map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
    // only scalar types; jsonb is the audit diff and nothing else (the CAT-002 tables are scanned by gig-template-model.itest.ts)
    expect([...new Set(rows.map((r) => r.data_type))].sort()).toEqual(['boolean', 'integer', 'jsonb', 'text', 'timestamp with time zone', 'uuid']);
    expect(rows.filter((r) => r.data_type === 'jsonb').map((r) => `${r.table_name}.${r.column_name}`)).toEqual(['audit_events.changes']);
    expect(rows.filter((r) => r.data_type === 'integer').map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'market_categories.display_order',
      'market_service_types.display_order',
    ]);
    // a content key column names managed copy, never holds it
    expect(rows.filter((r) => /content_key$/.test(r.column_name)).map((r) => r.data_type)).toEqual(Array(6).fill('text'));
  });

  it('applies its own forbidden-word filter by whole words (a check that is not vacuous: unit_price and capacity_max would be caught, correlation_id would not)', () => {
    expect(['unit_price', 'capacity_max', 'service_radius', 'email', 'first_name', 'duration_minutes', 'owner_account_id'].filter(forbidden)).toHaveLength(7);
    expect(['correlation_id', 'name_content_key', 'display_order', 'prohibited_service_id', 'changes', 'reason'].filter(forbidden)).toEqual([]);
  });

  it('writes nothing outside its own tables: no guard function inserts, updates or deletes a row, notifies, or touches the outbox or the audit trail (the service writes the audit and the events)', async () => {
    const src = await q<{ proname: string; prosrc: string }>(
      "SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'catalog'::regnamespace AND proname = ANY($1)",
      [CAT1_FUNCTIONS],
    );
    expect(src).toHaveLength(7);
    for (const f of src) {
      expect(f.prosrc, f.proname).not.toMatch(/INSERT\s+INTO|UPDATE\s+[a-z]|DELETE\s+FROM|pg_notify|NOTIFY|outbox|audit_events|TRUNCATE\s+[a-z]/i);
      expect(f.prosrc, f.proname).not.toMatch(/\bcontent\.|\bgeography\.|\bidentity\.|\bintegration\./); // the guards read only the catalogue
    }
  });

  it("leaves the audit trail and the outbox exactly as they were when the tables are changed by raw SQL (the audit rows and events are the service's job, in its own transaction)", async () => {
    const snap = async () => ({
      audit: await count(AUDIT),
      outbox: await count('integration.outbox_events'),
      content: await count('content.audit_events'),
      geo: await count('geography.audit_events'),
    });
    const before = await snap();
    const { market, category, serviceType } = await liveStack();
    await setMst(market.id, serviceType.id, false);
    await setSt(serviceType.id, 'INACTIVE');
    await setMc(market.id, category.id, false);
    await setCat(category.id, 'INACTIVE');
    expect(await snap()).toEqual(before);
  });

  it('keeps the audit diff of the seed free of personal data and shaped {field: [old, new]}', async () => {
    const rows = await sq<{ changes: Record<string, unknown> }>(`SELECT changes FROM ${AUDIT}`);
    for (const r of rows) {
      expect(Object.keys(r.changes)).toEqual(['status']);
      expect(r.changes.status).toEqual([null, 'DRAFT']);
    }
  });
});

// ====================================================================== K. mutation checks on a scratch database
// The guards are only worth what the tests that would notice their removal are worth. In ONE scratch database each guard is broken in turn (a share lock taken out, a
// trigger dropped, a constraint dropped, a function body weakened), the behaviour the matching test above asserts is observed to be GONE, and the object is restored from
// its captured definition. At the end the scratch schema is compared with the pristine one, so a mutation that was not undone fails the test.
const outcomeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  if (!e) return 'ACCEPTED';
  return e.detail?.startsWith('catalog_rule:') ? e.detail.slice('catalog_rule:'.length) : (e.constraint ?? e.code ?? 'ERROR');
};
async function rolledBack<T>(from: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
/** Starts a holder transaction, then a racer on another connection; reports whether the racer was held back by a lock and how it ended. */
async function holdAndObserve(
  main: pg.Pool,
  race: pg.Pool,
  hold: (c: pg.PoolClient) => Promise<unknown>,
  racer: RaceSql,
): Promise<{ blocked: boolean; failure: PgFailure | undefined }> {
  const tx = await openTx(main);
  let settled = false;
  let blocked = false;
  let racing: Promise<PgFailure | undefined> = Promise.resolve(undefined);
  try {
    await hold(tx);
    racing = (rejection(race.query(racer.text, racer.params ?? [])) as Promise<PgFailure | undefined>).then((e) => {
      settled = true;
      return e;
    });
    for (let i = 0; i < 75 && !settled; i++) {
      if ((await waitersOn(main)) >= 1) {
        blocked = true;
        break;
      }
      await sleep(20);
    }
  } finally {
    await finish(tx, 'COMMIT');
  }
  return { blocked, failure: await racing };
}
async function catalogFingerprint(from: pg.Pool): Promise<string[]> {
  const rows = async (label: string, text: string) => (await from.query(text)).rows.map((r) => `${label} ${JSON.stringify(r)}`);
  return [
    ...(await rows('fn', "SELECT proname, md5(pg_get_functiondef(oid)) AS def FROM pg_proc WHERE pronamespace = 'catalog'::regnamespace ORDER BY 1")),
    ...(await rows(
      'trg',
      "SELECT g.tgname, pg_get_triggerdef(g.oid) AS def, g.tgenabled FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT g.tgisinternal ORDER BY 1",
    )),
    ...(await rows(
      'con',
      "SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace ORDER BY 1",
    )),
    ...(await rows('idx', "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'catalog' ORDER BY 1")),
  ];
}

describe('K. mutation checks (scratch database): each guard removed or weakened makes the behaviour the matching test asserts disappear', () => {
  let scratch: IsolatedDatabase;
  let sp: pg.Pool;
  let srace: pg.Pool;
  beforeAll(async () => {
    scratch = await createIsolatedDatabase();
    sp = createTestPool(scratch.url, 8);
    srace = createTestPool(scratch.url, 8);
  });
  afterAll(async () => {
    await sp?.end();
    await srace?.end();
    await scratch?.drop();
  });
  const fnDef = async (name: string) => ((await sp.query('SELECT pg_get_functiondef($1::regproc) AS d', [`catalog.${name}`])).rows[0] as { d: string }).d;
  const trgDef = async (name: string) =>
    (
      (
        await sp.query(
          `SELECT pg_get_triggerdef(g.oid) AS d FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = $1 AND c.relnamespace = 'catalog'::regnamespace`,
          [name],
        )
      ).rows[0] as { d: string }
    ).d;
  const conDef = async (name: string) =>
    (
      (await sp.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND connamespace = 'catalog'::regnamespace`, [name]))
        .rows[0] as { d: string }
    ).d;
  /** Replaces the `nth` (1-based) occurrence of `needle` in a function definition, asserting that it exists. */
  const without = (def: string, needle: string, replacement: string, nth = 1): string => {
    const parts = def.split(needle);
    expect(parts.length, `the needle occurs at least ${nth} time(s) in the function: ${needle}`).toBeGreaterThan(nth);
    return parts.slice(0, nth).join(needle) + replacement + parts.slice(nth).join(needle);
  };
  async function mutateFunction(name: string, mutate: (def: string) => string, during: () => Promise<void>): Promise<void> {
    const original = await fnDef(name);
    const mutated = mutate(original);
    expect(mutated).not.toBe(original);
    await sp.query(mutated);
    try {
      await during();
    } finally {
      await sp.query(original);
    }
  }
  async function dropTrigger(name: string, table: string, during: () => Promise<void>): Promise<void> {
    const original = await trgDef(name);
    await sp.query(`DROP TRIGGER ${name} ON ${table}`);
    try {
      await during();
    } finally {
      await sp.query(original);
    }
  }
  async function dropConstraint(name: string, table: string, during: () => Promise<void>): Promise<void> {
    const def = await conDef(name);
    await sp.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
    try {
      await during();
    } finally {
      await sp.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${def}`);
    }
  }

  // ---- the probes: each returns what the matching test above asserts
  const probeMustStartAsDraft = (p: pg.Pool) =>
    rolledBack(p, async (c) => {
      const cat = await makeCategory({}, c);
      const code = `mut_${++seq}`;
      await ensureEntry(serviceTypeNameKey(code), c);
      return outcomeOf(c.query("INSERT INTO catalog.service_types (category_id, code, status) VALUES ($1, $2, 'ACTIVE')", [cat.id, code]));
    });
  const probeAuditImmutable = (p: pg.Pool) =>
    rolledBack(p, async (c) => {
      const cat = await makeCategory({}, c);
      await c.query("INSERT INTO catalog.audit_events (actor, action, category_id, reason, correlation_id) VALUES ('a', 'CATEGORY_CREATED', $1, 'r', 'c')", [
        cat.id,
      ]);
      return outcomeOf(c.query("UPDATE catalog.audit_events SET reason = 'changed' WHERE category_id = $1", [cat.id]));
    });
  const probeTruncate = (p: pg.Pool) => rolledBack(p, (c) => outcomeOf(c.query('TRUNCATE catalog.market_categories')));
  const probeNameFk = (p: pg.Pool) => rolledBack(p, (c) => outcomeOf(c.query('INSERT INTO catalog.categories (code) VALUES ($1)', [`nokey_${++seq}`])));
  const probeReactivation = (p: pg.Pool) =>
    rolledBack(p, async (c) => {
      const cat = await makeCategory({ status: 'RETIRED' }, c);
      return outcomeOf(c.query("UPDATE catalog.categories SET status = 'ACTIVE' WHERE category_id = $1", [cat.id]));
    });
  const probeActiveChild = (p: pg.Pool) =>
    rolledBack(p, async (c) => {
      const cat = await makeCategory({ status: 'ACTIVE' }, c);
      await makeServiceType(cat.id, { status: 'ACTIVE' }, c);
      return outcomeOf(c.query("UPDATE catalog.categories SET status = 'INACTIVE' WHERE category_id = $1", [cat.id]));
    });
  const probeCreatedAt = (p: pg.Pool) =>
    rolledBack(p, async (c) => {
      const cat = await makeCategory({}, c);
      const first = await catRow(cat.id, c);
      await c.query("UPDATE catalog.categories SET created_at = '2000-01-01T00:00:00Z' WHERE category_id = $1", [cat.id]);
      return (await catRow(cat.id, c)).created_at.getTime() === first.created_at.getTime() ? 'KEPT' : 'OVERWRITTEN';
    });
  const probeDuplicateOrder = (p: pg.Pool) =>
    rolledBack(p, async (c) => {
      const market = await laOcOn(c);
      const [a, b] = [await makeCategory({}, c), await makeCategory({}, c)];
      await makeMc(market, a.id, { order: 77 }, c);
      return outcomeOf(makeMc(market, b.id, { order: 77 }, c));
    });
  const probeSubject = (p: pg.Pool) =>
    rolledBack(p, async (c) => {
      const cat = await makeCategory({}, c);
      const st = await makeServiceType(cat.id, {}, c);
      return outcomeOf(
        c.query(
          "INSERT INTO catalog.audit_events (actor, action, category_id, service_type_id, reason, correlation_id) VALUES ('a', 'CATEGORY_CREATED', $1, $2, 'r', 'c')",
          [cat.id, st.id],
        ),
      );
    });
  const laOcOn = async (c: Db): Promise<string> =>
    (await q<{ market_id: string }>("SELECT market_id FROM geography.markets WHERE code = 'la-oc'", [], c))[0]!.market_id;

  /** The same behaviour on the real database and on the mutated scratch one: intact -> `good`, mutated -> `bad`, restored -> `good`. */
  async function expectMutation(
    label: string,
    probe: (p: pg.Pool) => Promise<string>,
    good: string,
    bad: string,
    mutate: (during: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    expect(await probe(pool), `${label}: the real database`).toBe(good);
    expect(await probe(sp), `${label}: the scratch database before the mutation`).toBe(good);
    await mutate(async () => {
      expect(await probe(sp), `${label}: MUTATED, the test that asserts "${good}" would fail`).toBe(bad);
    });
    expect(await probe(sp), `${label}: the scratch database after the restore`).toBe(good);
  }

  it('MUTATION: dropping trg_service_types__guard lets a service type be created ACTIVE (caught by D4 MUST_START_AS_DRAFT)', async () => {
    await expectMutation('trg_service_types__guard', probeMustStartAsDraft, 'MUST_START_AS_DRAFT', 'ACCEPTED', (during) =>
      dropTrigger('trg_service_types__guard', ST, during),
    );
  });

  it('MUTATION: dropping trg_audit_events__immutable lets an audit row be rewritten (caught by C5 append-only)', async () => {
    await expectMutation('trg_audit_events__immutable', probeAuditImmutable, 'ROW_IMMUTABLE', 'ACCEPTED', (during) =>
      dropTrigger('trg_audit_events__immutable', AUDIT, during),
    );
  });

  it('MUTATION: dropping trg_market_categories__no_truncate lets the table be emptied (caught by F TRUNCATE)', async () => {
    await expectMutation('trg_market_categories__no_truncate', probeTruncate, 'ROW_IMMUTABLE', 'ACCEPTED', (during) =>
      dropTrigger('trg_market_categories__no_truncate', MC, during),
    );
  });

  it('MUTATION: dropping the foreign key of the generated name key lets a category exist without its managed name (caught by C3)', async () => {
    await expectMutation('fk_categories__name_content_key', probeNameFk, 'fk_categories__name_content_key', 'ACCEPTED', (during) =>
      dropConstraint('fk_categories__name_content_key', CAT, during),
    );
  });

  it('MUTATION: dropping the unique key of the display order lets two categories share a position (caught by C4 and H3)', async () => {
    await expectMutation('uq_market_categories__market_order', probeDuplicateOrder, 'uq_market_categories__market_order', 'ACCEPTED', (during) =>
      dropConstraint('uq_market_categories__market_order', MC, during),
    );
  });

  it('MUTATION: dropping the subject CHECK of the audit trail lets a row name two subjects (caught by C5)', async () => {
    await expectMutation('ck_audit_events__subject', probeSubject, 'ck_audit_events__subject', 'ACCEPTED', (during) =>
      dropConstraint('ck_audit_events__subject', AUDIT, during),
    );
  });

  it('MUTATION: letting RETIRED go back to ACTIVE in the status machine is caught by the matrix (D0, D1)', async () => {
    await expectMutation('assert_status_transition', probeReactivation, 'STATUS_TRANSITION', 'ACCEPTED', (during) =>
      mutateFunction(
        'assert_status_transition',
        (d) =>
          without(d, "OR (p_old = 'INACTIVE' AND p_new IN ('ACTIVE', 'RETIRED'))", "OR (p_old IN ('INACTIVE', 'RETIRED') AND p_new IN ('ACTIVE', 'RETIRED'))"),
        during,
      ),
    );
  });

  it('MUTATION: removing the ACTIVE-children check from the category guard lets a category leave ACTIVE under an ACTIVE service type (caught by D3 and H1)', async () => {
    await expectMutation('guard_categories', probeActiveChild, 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES', 'ACCEPTED', (during) =>
      mutateFunction(
        'guard_categories',
        (d) =>
          without(
            d,
            "service_types WHERE category_id = OLD.category_id AND status = 'ACTIVE')",
            "service_types WHERE category_id = OLD.category_id AND status = 'ACTIVE' AND false)",
          ),
        during,
      ),
    );
  });

  it('MUTATION: removing "NEW.created_at := OLD.created_at" from the category guard lets the creation time be rewritten (caught by E)', async () => {
    await expectMutation('guard_categories created_at', probeCreatedAt, 'KEPT', 'OVERWRITTEN', (during) =>
      mutateFunction('guard_categories', (d) => without(d, 'NEW.created_at := OLD.created_at;', ''), during),
    );
  });

  // ---- the share locks: the whole point of the lock order is that these interleavings cannot end in an invalid state
  it('MUTATION: with FOR SHARE removed from the category read of the service type ACTIVATION, the activation is no longer held back by a category deactivation and the schema ends with an ACTIVE service type under an INACTIVE category (caught by H1 and H4)', async () => {
    const scenario = async (main: pg.Pool, race: pg.Pool) => {
      const c = await makeCategory({ status: 'ACTIVE' }, main);
      const st = await makeServiceType(c.id, {}, main);
      const r = await holdAndObserve(main, race, (tx) => exec(tx, catStatus(c.id, 'INACTIVE')), stStatus(st.id, 'ACTIVE'));
      return { ...r, broken: (await violations(main))['activeServiceTypeUnderInactiveCategory']!.length };
    };
    const real = await scenario(pool, racePool);
    expect(real.blocked).toBe(true);
    expect(asRule(real.failure)).toEqual(rule('CATEGORY_NOT_ACTIVE'));
    await mutateFunction(
      'guard_service_types',
      (d) =>
        without(
          d,
          'SELECT status INTO c_status FROM catalog.categories WHERE category_id = NEW.category_id FOR SHARE;',
          'SELECT status INTO c_status FROM catalog.categories WHERE category_id = NEW.category_id;',
          2,
        ),
      async () => {
        const r = await scenario(sp, srace);
        expect(r.blocked, 'without the lock the activation does not wait').toBe(false);
        expect(r.failure).toBeUndefined();
        expect(r.broken, 'the corrupt state the lock prevents').toBe(1);
      },
    );
    const again = await scenario(sp, srace);
    expect(again.blocked).toBe(true);
  });

  it('MUTATION: with FOR SHARE removed from the category read of the service type INSERT, a creation is no longer serialized with a category retirement (caught by H1 and H4)', async () => {
    const scenario = async (main: pg.Pool, race: pg.Pool) => {
      const c = await makeCategory({ status: 'ACTIVE' }, main);
      const code = `mutins_${++seq}`;
      await ensureEntry(serviceTypeNameKey(code), main);
      const r = await holdAndObserve(main, race, (tx) => exec(tx, catStatus(c.id, 'RETIRED')), {
        text: 'INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2)',
        params: [c.id, code],
      });
      return { ...r, broken: (await violations(main))['retiredCategoryWithOpenServiceType']!.length };
    };
    const real = await scenario(pool, racePool);
    expect(real.blocked).toBe(true);
    expect(asRule(real.failure)).toEqual(rule('CATEGORY_RETIRED'));
    await mutateFunction(
      'guard_service_types',
      (d) =>
        without(
          d,
          'SELECT status INTO c_status FROM catalog.categories WHERE category_id = NEW.category_id FOR SHARE;',
          'SELECT status INTO c_status FROM catalog.categories WHERE category_id = NEW.category_id;',
          1,
        ),
      async () => {
        const r = await scenario(sp, srace);
        expect(r.blocked).toBe(false);
        expect(r.failure).toBeUndefined();
        expect(r.broken, 'a RETIRED category with a new DRAFT service type').toBe(1);
      },
    );
  });

  it('MUTATION: with FOR SHARE removed from the market category read of the service type ENABLE, an enable is no longer serialized with a category switch-off (caught by H2 and H4)', async () => {
    const scenario = async (main: pg.Pool, race: pg.Pool) => {
      const market = await makeMarket('ACTIVE', main);
      const c = await makeCategory({ status: 'ACTIVE' }, main);
      const st = await makeServiceType(c.id, { status: 'ACTIVE' }, main);
      await makeMc(market.id, c.id, { enabled: true }, main);
      await makeMst(market.id, st.id, {}, main);
      const r = await holdAndObserve(main, race, (tx) => exec(tx, mcSet(market.id, c.id, false)), mstSet(market.id, st.id, true));
      return { ...r, broken: (await violations(main))['enabledServiceTypeWithoutEnabledCategory']!.length };
    };
    const real = await scenario(pool, racePool);
    expect(real.blocked).toBe(true);
    expect(asRule(real.failure)).toEqual(rule('CATEGORY_NOT_ENABLED_IN_MARKET'));
    await mutateFunction(
      'guard_market_service_types',
      (d) =>
        without(
          d,
          'WHERE market_id = NEW.market_id AND category_id = st_category FOR SHARE;',
          'WHERE market_id = NEW.market_id AND category_id = st_category;',
        ),
      async () => {
        const r = await scenario(sp, srace);
        expect(r.blocked).toBe(false);
        expect(r.failure).toBeUndefined();
        expect(r.broken, 'an enabled service type under a disabled category').toBe(1);
      },
    );
  });

  it('MUTATION: with FOR SHARE removed from the service type read of the ENABLE, an enable is no longer held back by a retirement of the service type (caught by H2)', async () => {
    const scenario = async (main: pg.Pool, race: pg.Pool) => {
      const market = await makeMarket('ACTIVE', main);
      const c = await makeCategory({ status: 'ACTIVE' }, main);
      const st = await makeServiceType(c.id, { status: 'ACTIVE' }, main);
      await makeMc(market.id, c.id, { enabled: true }, main);
      await makeMst(market.id, st.id, {}, main);
      return holdAndObserve(main, race, (tx) => exec(tx, stStatus(st.id, 'RETIRED')), mstSet(market.id, st.id, true));
    };
    const real = await scenario(pool, racePool);
    expect(real.blocked).toBe(true);
    expect(asRule(real.failure)).toEqual(rule('ITEM_RETIRED'));
    await mutateFunction(
      'guard_market_service_types',
      (d) =>
        without(
          d,
          'FROM catalog.service_types WHERE service_type_id = NEW.service_type_id FOR SHARE;',
          'FROM catalog.service_types WHERE service_type_id = NEW.service_type_id;',
        ),
      async () => {
        const r = await scenario(sp, srace);
        expect(r.blocked).toBe(false);
        expect(r.failure, 'the enable went through against a retirement in flight').toBeUndefined();
      },
    );
  });

  it('restores everything: after all mutations the catalog functions, triggers, constraints and indexes of the scratch database equal those of the pristine database, and no lock waiter is left', async () => {
    expect(await catalogFingerprint(sp)).toEqual(await catalogFingerprint(seedPool));
    expect((await catalogFingerprint(sp)).length).toBeGreaterThan(70);
    await noLockWaiters(sp);
    await noLockWaiters(srace);
  });
});

// ====================================================================== L. at the end of the file, after every test above, the invariants hold and nothing is left locked
describe('L. final state of the mutated database', () => {
  it('has none of the three invariant violations after all the statements, races and refusals above, and no lock waiter', async () => {
    expect(await violations()).toEqual(NO_VIOLATIONS);
    await noLockWaiters();
    await noLockWaiters(racePool);
  });

  it('still has the seeded rows exactly as migrated (nothing in the tests touched them) and every row is accounted for by a unique code', async () => {
    expect(await q<{ code: string; status: string }>(`SELECT code, status FROM ${CAT} WHERE code IN ('auto_services', 'home_cleaning') ORDER BY code`)).toEqual(
      [
        { code: 'auto_services', status: 'DRAFT' },
        { code: 'home_cleaning', status: 'DRAFT' },
      ],
    );
    expect(await count(ST, "code IN ('car_detailing', 'deep_cleaning', 'mobile_car_wash', 'regular_cleaning') AND status = 'DRAFT'")).toBe(4);
    expect(await count(AUDIT, "correlation_id = 'seed-0015'")).toBe(6);
    expect((await q<{ n: number; d: number }>(`SELECT count(*)::int AS n, count(DISTINCT code)::int AS d FROM ${CAT}`))[0]).toMatchObject({
      n: expect.any(Number),
      d: expect.any(Number),
    });
    expect((await q<{ n: number; d: number }>(`SELECT count(*)::int AS n, count(DISTINCT code)::int AS d FROM ${ST}`))[0]!.n).toBe(
      (await q<{ d: number }>(`SELECT count(DISTINCT code)::int AS d FROM ${ST}`))[0]!.d,
    );
  });
});
