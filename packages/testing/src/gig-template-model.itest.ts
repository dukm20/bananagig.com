import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_STATUSES,
  CATALOG_STATUS_TRANSITIONS,
  categoryNameKey,
  isCatalogTransitionAllowed,
  serviceTypeNameKey,
  type CatalogStatus,
} from '../../contracts/src/catalog';
import {
  FIXED_CAPABLE_FIELD_TYPES,
  GIG_TEMPLATE_FIELD_BEHAVIORS,
  GIG_TEMPLATE_FIELD_TYPES,
  GIG_TEMPLATE_REQUIREMENT_TYPES,
  GIG_TEMPLATE_SECTIONS,
  GIG_TEMPLATE_VERSION_STATUSES,
  fieldIssues,
  gigTemplateDescriptionKey,
  gigTemplateFieldDefaultKey,
  gigTemplateFieldHelpKey,
  gigTemplateFieldLabelKey,
  gigTemplateInstructionsKey,
  gigTemplateNameKey,
  gigTemplateOptionLabelKey,
  isGigTemplateVersionTransitionAllowed,
  type GigTemplateVersionStatus,
} from '../../contracts/src/gig-template';
import { runMigrations } from '../../../scripts/lib/migrator.mjs';
import { ContentService } from '../../content/src/index';
import { createIsolatedDatabase, createTestPool, migrationsDir, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0016 (CAT-002) adds the PLATFORM-OWNED Gig Templates to the catalog schema: six tables (gig_templates = the identity, gig_template_versions = the frozen structure,
// gig_template_fields with typed metadata, gig_template_field_options, gig_template_requirements = hooks, market_gig_templates = availability), nine functions (two helpers, five row guards,
// the publication check and the content check) with twelve triggers (SQLSTATE 23000, DETAIL catalog_rule:<KEY>), two nullable columns, two foreign keys and the two replaced CHECKs on
// catalog.audit_events, and a seed of two DRAFT templates with six managed copy entries. These tests try to BREAK it with raw SQL on isolated databases: the exact shape, the seed, every CHECK with
// positive and negative cases, every guard rule on the exact failing statement, both status machines over the full 4 x 4 matrix, the hierarchy, the interleavings that matter under real
// concurrency (hold-then-race with lock polling and repeated simultaneous races), the access paths, the privacy shape, and a mutation check on a scratch database for the locks and triggers the
// invariants rest on. The service is covered in packages/catalog (and the API in apps/api).
let iso: IsolatedDatabase; // mutated by the tests
let seed: IsolatedDatabase; // pristine: only the shape and seed assertions read it
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
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL catalog_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `catalog_rule:${key}` });
};
/** Asserts the statement is refused by a named constraint with the SQLSTATE of its kind (check 23514, foreign key 23503, unique or primary key 23505). */
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
const rule = (key: string) => ({ code: '23000', detail: `catalog_rule:${key}` });
const asRule = (e: PgFailure | undefined): { code?: string; detail?: string } | undefined => (e ? { code: e.code, detail: e.detail } : undefined);

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

// ---------------------------------------------------------------- object names
const T = 'catalog.gig_templates';
const V = 'catalog.gig_template_versions';
const F = 'catalog.gig_template_fields';
const O = 'catalog.gig_template_field_options';
const R = 'catalog.gig_template_requirements';
const M = 'catalog.market_gig_templates';
const AUDIT = 'catalog.audit_events';
const NEW_TABLES = [T, V, F, O, R, M];
const NEW_TABLE_NAMES = [
  'gig_template_field_options',
  'gig_template_fields',
  'gig_template_requirements',
  'gig_template_versions',
  'gig_templates',
  'market_gig_templates',
];
const OLD_TABLE_NAMES = ['audit_events', 'categories', 'market_categories', 'market_service_types', 'prohibited_services', 'service_types'];
const STATUSES: readonly CatalogStatus[] = CATALOG_STATUSES;
const VSTATUSES: readonly GigTemplateVersionStatus[] = GIG_TEMPLATE_VERSION_STATUSES;
/** The statuses a row passes through (from DRAFT) to reach a given status by legal steps only. */
const PATH: Record<CatalogStatus, CatalogStatus[]> = { DRAFT: [], ACTIVE: ['ACTIVE'], INACTIVE: ['ACTIVE', 'INACTIVE'], RETIRED: ['RETIRED'] };
let orderSeq = 100;
const nextOrder = (): number => ++orderSeq;
let marketSeq = 0;

// ---------------------------------------------------------------- content fixtures
const SAFE_KEY = /^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/;
type ContentState = 'NONE' | 'DRAFT' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHED' | 'FUTURE' | 'SUPERSEDED' | 'EXPIRED' | 'SCHEDULED_STARTED' | 'SUPERSEDED_OPEN';
interface ContentOpts {
  /** What the managed copy of the key looks like: PUBLISHED (default, in force now), or one of the states that is NOT usable. */
  state?: ContentState;
  locale?: string;
  scope?: 'PLATFORM' | 'MARKET';
  /** false = the entry is deactivated after its version exists. */
  active?: boolean;
}
const sqlLit = (s: string): string => `'${s.replaceAll("'", "''")}'`;
/**
 * A content entry with this key and (default) ONE PUBLISHED en-US PLATFORM version in force since an hour, created through the real lifecycle (DRAFT -> APPROVED -> PUBLISHED).
 * `state` creates the not-usable variants: only a DRAFT / APPROVED, a SCHEDULED version starting tomorrow, a PUBLISHED one that starts in an hour (FUTURE), a SUPERSEDED one whose window ended, a PUBLISHED
 * window that ended an hour ago (EXPIRED: needs the content guard out of the way for one transaction), another locale, MARKET scope. The USABLE variants the content resolver also reads: a SCHEDULED version whose
 * start has passed (SCHEDULED_STARTED: the activation job has not run yet) and a SUPERSEDED one whose window is still open (SUPERSEDED_OPEN). Idempotent per key.
 */
const contentOverrides = new Map<string, ContentOpts>();
async function ensureContent(key: string, requested: ContentOpts = {}, from: Db = pool): Promise<void> {
  if (!SAFE_KEY.test(key)) throw new Error(`unsafe content key ${key}`);
  const o = { ...requested, ...(contentOverrides.get(key) ?? {}) }; // a test can force the copy of one derived key into a state the helpers would not create
  const state = o.state ?? 'PUBLISHED';
  const locale = o.locale ?? 'en-US';
  const scope = o.scope ?? 'PLATFORM';
  const exists = (await q<{ n: number }>('SELECT count(*)::int AS n FROM content.entries WHERE key = $1', [key], from))[0]!.n > 0;
  if (exists) return;
  if (locale !== 'en-US')
    await from.query(
      `INSERT INTO content.locales (locale, display_name, is_active) VALUES (${sqlLit(locale)}, ${sqlLit(`Test ${locale}`)}, true) ON CONFLICT (locale) DO NOTHING`,
    );
  const k = sqlLit(key);
  const where = `e.entry_id = v.entry_id AND e.key = ${k} AND v.locale = ${sqlLit(locale)} AND v.scope_type = '${scope}'`;
  const ref = scope === 'MARKET' ? "'la-oc'" : 'NULL';
  const entry = `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
    VALUES (${k}, 'UI_LABEL', 'CONTENT', 'test entry', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'test')`;
  const version = (status: string, extra = '') =>
    `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, approval_policy, effective_from, reason, created_by)
       SELECT entry_id, ${sqlLit(locale)}, '${scope}', ${ref}, 1, ${sqlLit(`text of ${key}`)}, 'NONE', now() - interval '1 hour', 'test', 'test' FROM content.entries WHERE key = ${k};
     ${status === 'DRAFT' ? '' : `UPDATE content.versions v SET status = 'APPROVED' FROM content.entries e WHERE ${where} AND v.status = 'DRAFT';`}
     ${extra}`;
  const set = (status: string, from_ = '') => `UPDATE content.versions v SET status = '${status}'${from_} FROM content.entries e WHERE ${where};`;
  let body: string;
  switch (state) {
    case 'NONE':
      body = entry;
      break;
    case 'DRAFT':
      body = `${entry}; ${version('DRAFT')}`;
      break;
    case 'APPROVED':
      body = `${entry}; ${version('APPROVED')}`;
      break;
    case 'SCHEDULED':
      body = `${entry}; ${version('APPROVED', set('SCHEDULED', ", effective_from = now() + interval '1 day'"))}`;
      break;
    case 'FUTURE':
      body = `${entry}; ${version('APPROVED', set('PUBLISHED', ", effective_from = now() + interval '1 hour'"))}`;
      break;
    case 'SUPERSEDED_OPEN':
      body = `${entry}; ${version('APPROVED', `${set('PUBLISHED')} ${set('SUPERSEDED')}`)}`;
      break;
    case 'SCHEDULED_STARTED':
      body = `${entry}; ${version('APPROVED', set('SCHEDULED'))}`;
      break;
    case 'SUPERSEDED':
      // a superseded version whose window has ended (what the content workflow leaves behind): it no longer resolves
      body = `${entry}; ALTER TABLE content.versions DISABLE TRIGGER USER;
        INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, body_sha256, status, approval_policy, effective_from, effective_to, reason, created_by)
          SELECT entry_id, ${sqlLit(locale)}, '${scope}', ${ref}, 1, 'superseded', 'x', 'SUPERSEDED', 'NONE', now() - interval '2 hours', now() - interval '1 hour', 'test', 'test' FROM content.entries WHERE key = ${k};
        ALTER TABLE content.versions ENABLE TRIGGER USER`;
      break;
    case 'EXPIRED':
      body = `${entry}; ALTER TABLE content.versions DISABLE TRIGGER USER;
        INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, body_sha256, status, approval_policy, effective_from, effective_to, reason, created_by)
          SELECT entry_id, ${sqlLit(locale)}, '${scope}', ${ref}, 1, 'expired', 'x', 'PUBLISHED', 'NONE', now() - interval '2 hours', now() - interval '1 hour', 'test', 'test' FROM content.entries WHERE key = ${k};
        ALTER TABLE content.versions ENABLE TRIGGER USER`;
      break;
    default:
      body = `${entry}; ${version('APPROVED', set('PUBLISHED'))}`;
  }
  await from.query(body); // one simple-query message: the statements run in ONE implicit transaction
  if (o.active === false) await from.query(`UPDATE content.entries SET is_active = false WHERE key = ${k}`);
}
/** A content entry without any version (the foreign keys only need the key to exist). */
const ensureEntry = (key: string, from: Db = pool) => ensureContent(key, { state: 'NONE' }, from);

// ---------------------------------------------------------------- catalogue fixtures
interface Row {
  id: string;
  code: string;
}
async function makeCategory(status: CatalogStatus = 'ACTIVE', from: Db = pool): Promise<Row> {
  const code = `cat_${++seq}`;
  await ensureEntry(categoryNameKey(code), from);
  const r = await from.query('INSERT INTO catalog.categories (code) VALUES ($1) RETURNING category_id', [code]);
  const id = (r.rows[0] as { category_id: string }).category_id;
  for (const s of PATH[status]) await from.query('UPDATE catalog.categories SET status = $2 WHERE category_id = $1', [id, s]);
  return { id, code };
}
async function makeServiceType(categoryId: string, status: CatalogStatus = 'ACTIVE', from: Db = pool): Promise<Row> {
  const code = `st_${++seq}`;
  await ensureEntry(serviceTypeNameKey(code), from);
  const r = await from.query('INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2) RETURNING service_type_id', [categoryId, code]);
  const id = (r.rows[0] as { service_type_id: string }).service_type_id;
  for (const s of PATH[status]) await from.query('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', [id, s]);
  return { id, code };
}
/** A service type (default ACTIVE) under an ACTIVE category of its own. */
async function makeSt(status: CatalogStatus = 'ACTIVE', from: Db = pool): Promise<Row & { categoryId: string }> {
  const cat = await makeCategory('ACTIVE', from);
  return { ...(await makeServiceType(cat.id, status, from)), categoryId: cat.id };
}
const setSt = (id: string, status: string, from: Db = pool) =>
  from.query('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', [id, status]);
const setCat = (id: string, status: string, from: Db = pool) => from.query('UPDATE catalog.categories SET status = $2 WHERE category_id = $1', [id, status]);
async function makeMarket(from: pg.Pool = pool): Promise<Row> {
  const code = `tg-${++marketSeq}`;
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    const m = await c.query(
      `INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT $1, $1, c.country_id, 'PLANNED', 'en-US', 'USD', t.time_zone_id, now()
         FROM geography.countries c, geography.time_zones t WHERE c.iso_alpha2 = 'US' AND t.iana_name = 'America/Los_Angeles' RETURNING market_id`,
      [code],
    );
    const id = (m.rows[0] as { market_id: string }).market_id;
    await c.query(
      'INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, default_locale FROM geography.markets WHERE market_id = $1',
      [id],
    );
    await c.query('COMMIT');
    return { id, code };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------- Gig Template fixtures
interface Tpl extends Row {
  stId: string;
  stCode: string;
}
interface NewTpl {
  /** The service type (default: a fresh ACTIVE one under a fresh ACTIVE category). */
  st?: Row;
  code?: string;
  status?: CatalogStatus;
  /** Link the description and instructions entries. */
  copy?: boolean;
  /** The name / description / instructions copy: PUBLISHED (default) or no version at all. */
  content?: 'PUBLISHED' | 'NONE';
}
async function makeTpl(o: NewTpl = {}, from: Db = pool): Promise<Tpl> {
  const st = o.st ?? (await makeSt('ACTIVE', from));
  const code = o.code ?? `gt_${++seq}`;
  const state = o.content === 'NONE' ? 'NONE' : 'PUBLISHED';
  await ensureContent(gigTemplateNameKey(code), { state }, from);
  if (o.copy) {
    await ensureContent(gigTemplateDescriptionKey(code), { state }, from);
    await ensureContent(gigTemplateInstructionsKey(code), { state }, from);
  }
  const r = await from.query(
    'INSERT INTO catalog.gig_templates (service_type_id, code, description_content_key, instructions_content_key) VALUES ($1, $2, $3, $4) RETURNING gig_template_id',
    [st.id, code, o.copy ? gigTemplateDescriptionKey(code) : null, o.copy ? gigTemplateInstructionsKey(code) : null],
  );
  const id = (r.rows[0] as { gig_template_id: string }).gig_template_id;
  for (const s of PATH[o.status ?? 'DRAFT']) await from.query('UPDATE catalog.gig_templates SET status = $2 WHERE gig_template_id = $1', [id, s]);
  return { id, code, stId: st.id, stCode: st.code };
}
const setTpl = (id: string, status: string, from: Db = pool) =>
  from.query('UPDATE catalog.gig_templates SET status = $2 WHERE gig_template_id = $1', [id, status]);
const tplRow = async (id: string, from: Db = pool) =>
  (
    await q<{ status: string; created_at: Date; updated_at: Date }>(
      'SELECT status, created_at, updated_at FROM catalog.gig_templates WHERE gig_template_id = $1',
      [id],
      from,
    )
  )[0]!;

interface Ver {
  id: string;
  n: number;
  code: string;
  tplId: string;
}
interface VersionCols {
  min_duration_minutes?: number | null;
  max_duration_minutes?: number | null;
  suggested_duration_minutes?: number | null;
  pricing_fixed?: boolean;
  pricing_fixed_with_variants?: boolean;
  pricing_bundle_eligible?: boolean;
  pricing_drop_eligible?: boolean;
  area_radius?: boolean;
  area_postal_codes?: boolean;
  area_polygon?: boolean;
}
/** A new DRAFT version with the next contiguous number (the template must have no open draft). */
async function makeVersion(t: { id: string; code: string }, cols: VersionCols = {}, from: Db = pool): Promise<Ver> {
  const names = Object.keys(cols);
  const r = await from.query(
    `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number${names.map((n) => `, ${n}`).join('')})
     VALUES ($1, (SELECT COALESCE(max(version_number), 0) + 1 FROM catalog.gig_template_versions WHERE gig_template_id = $1)${names.map((_, i) => `, $${i + 2}`).join('')})
     RETURNING gig_template_version_id, version_number`,
    [t.id, ...Object.values(cols)],
  );
  const row = r.rows[0] as { gig_template_version_id: string; version_number: number };
  return { id: row.gig_template_version_id, n: row.version_number, code: t.code, tplId: t.id };
}
const setVer = (id: string, status: string, from: Db = pool) =>
  from.query('UPDATE catalog.gig_template_versions SET status = $2 WHERE gig_template_version_id = $1', [id, status]);
const verRow = async (id: string, from: Db = pool) =>
  (
    await q<{ status: string; revision: number; created_at: Date; updated_at: Date; published_at: Date | null; closed_at: Date | null }>(
      'SELECT status, revision, created_at, updated_at, published_at, closed_at FROM catalog.gig_template_versions WHERE gig_template_version_id = $1',
      [id],
      from,
    )
  )[0]!;
interface FieldSpec {
  key?: string;
  type?: string;
  behavior?: string;
  section?: string;
  visible?: boolean;
  order?: number;
  /** Link the help entry / the default entry (derived keys). */
  help?: boolean;
  defaultText?: boolean;
  minLength?: number | null;
  maxLength?: number | null;
  minNumber?: number | string | null;
  maxNumber?: number | string | null;
  defaultNumber?: number | string | null;
  defaultBoolean?: boolean | null;
  minItems?: number | null;
  maxItems?: number | null;
  /** Overrides of the derived keys (also null); the entry of an override is NOT created. */
  labelKey?: string;
  helpKey?: string | null;
  defaultKey?: string | null;
  /** The copy of the derived keys: PUBLISHED (default), an entry without any version (NONE) or no entry at all (MISSING). */
  content?: 'PUBLISHED' | 'NONE' | 'MISSING';
}
interface FieldRef {
  id: string;
  key: string;
  versionId: string;
  code: string;
}
let fieldSeq = 0;
/** The statement that inserts one field (default: an optional TEXT field with its derived label), with its content created first. */
async function addField(v: { id: string; code: string }, s: FieldSpec = {}, from: Db = pool): Promise<FieldRef> {
  const key = s.key ?? `fld_${++fieldSeq}`;
  const state = s.content === 'NONE' ? 'NONE' : 'PUBLISHED';
  const label = s.labelKey ?? gigTemplateFieldLabelKey(v.code, key);
  const help = s.helpKey !== undefined ? s.helpKey : s.help ? gigTemplateFieldHelpKey(v.code, key) : null;
  const dflt = s.defaultKey !== undefined ? s.defaultKey : s.defaultText ? gigTemplateFieldDefaultKey(v.code, key) : null;
  const make = s.content !== 'MISSING';
  if (make && s.labelKey === undefined) await ensureContent(label, { state }, from);
  if (make && s.helpKey === undefined && help) await ensureContent(help, { state }, from);
  if (make && s.defaultKey === undefined && dflt) await ensureContent(dflt, { state }, from);
  const r = await from.query(
    `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, section, behavior, customer_visible, display_order, label_content_key, help_content_key,
        default_content_key, min_length, max_length, min_number, max_number, default_number, default_boolean, min_items, max_items)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::int, (SELECT COALESCE(max(display_order), 0) + 1 FROM catalog.gig_template_fields WHERE gig_template_version_id = $1)),
             $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING gig_template_field_id`,
    [
      v.id,
      key,
      s.type ?? 'TEXT',
      s.section ?? 'DETAILS',
      s.behavior ?? 'PROVIDER_CONFIGURABLE',
      s.visible ?? true,
      s.order ?? null,
      label,
      help,
      dflt,
      s.minLength ?? null,
      s.maxLength ?? null,
      s.minNumber ?? null,
      s.maxNumber ?? null,
      s.defaultNumber ?? null,
      s.defaultBoolean ?? null,
      s.minItems ?? null,
      s.maxItems ?? null,
    ],
  );
  return { id: (r.rows[0] as { gig_template_field_id: string }).gig_template_field_id, key, versionId: v.id, code: v.code };
}
interface OptionSpec {
  order?: number;
  isDefault?: boolean;
  labelKey?: string;
  content?: 'PUBLISHED' | 'NONE' | 'MISSING';
}
async function addOption(f: FieldRef, optionCode: string, s: OptionSpec = {}, from: Db = pool): Promise<void> {
  const label = s.labelKey ?? gigTemplateOptionLabelKey(f.code, f.key, optionCode);
  if (s.labelKey === undefined && s.content !== 'MISSING') await ensureContent(label, { state: s.content === 'NONE' ? 'NONE' : 'PUBLISHED' }, from);
  await from.query(
    `INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, is_default, display_order)
     VALUES ($1, $2, $3, $4, COALESCE($5::int, (SELECT COALESCE(max(display_order), 0) + 1 FROM catalog.gig_template_field_options WHERE gig_template_field_id = $1)))`,
    [f.id, optionCode, label, s.isDefault ?? false, s.order ?? null],
  );
}
const addReq = (versionId: string, type: string, ref: string | null = null, from: Db = pool) =>
  from.query('INSERT INTO catalog.gig_template_requirements (gig_template_version_id, requirement_type, reference_code) VALUES ($1, $2, $3)', [
    versionId,
    type,
    ref,
  ]);
/** A DRAFT version with one optional TEXT field: the smallest version that can be published (the template must be ACTIVE and its copy published). */
async function makeDraftWithField(t: { id: string; code: string }, cols: VersionCols = {}, from: Db = pool): Promise<Ver> {
  const v = await makeVersion(t, cols, from);
  await addField(v, {}, from);
  return v;
}
/** A published (ACTIVE) version of an ACTIVE template. */
async function makePublished(t: { id: string; code: string }, from: Db = pool): Promise<Ver> {
  const v = await makeDraftWithField(t, {}, from);
  await setVer(v.id, 'ACTIVE', from);
  return v;
}
/** An ACTIVE template under an ACTIVE service type with one ACTIVE version. */
async function makeLiveTemplate(from: Db = pool): Promise<{ t: Tpl; v: Ver }> {
  const t = await makeTpl({ status: 'ACTIVE' }, from);
  return { t, v: await makePublished(t, from) };
}
/** A version in a given status, by the legal path (ACTIVE: published; SUPERSEDED: published, then the next published; RETIRED: a discarded draft). The template must be ACTIVE. */
async function makeVersionIn(t: Tpl, status: GigTemplateVersionStatus, from: Db = pool): Promise<Ver> {
  if (status === 'DRAFT') return makeDraftWithField(t, {}, from);
  if (status === 'RETIRED') {
    const v = await makeDraftWithField(t, {}, from);
    await setVer(v.id, 'RETIRED', from);
    return v;
  }
  const v = await makePublished(t, from);
  if (status === 'SUPERSEDED') await makePublished(t, from);
  return v;
}
async function addMarketRow(market: string, template: string, o: { enabled?: boolean; order?: number } = {}, from: Db = pool): Promise<number> {
  const order = o.order ?? nextOrder();
  await from.query('INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order) VALUES ($1, $2, $3, $4)', [
    market,
    template,
    o.enabled ?? false,
    order,
  ]);
  return order;
}
const setMgt = (market: string, template: string, enabled: boolean, from: Db = pool) =>
  from.query('UPDATE catalog.market_gig_templates SET enabled = $3 WHERE market_id = $1 AND gig_template_id = $2', [market, template, enabled]);
const laOc = async (from: Db = pool): Promise<string> =>
  (await q<{ market_id: string }>("SELECT market_id FROM geography.markets WHERE code = 'la-oc'", [], from))[0]!.market_id;

/** The invariants the guards exist for: all must be empty at all times. */
const INVARIANTS = {
  activeVersionUnderRetiredTemplate: `SELECT t.code FROM catalog.gig_templates t JOIN catalog.gig_template_versions v ON v.gig_template_id = t.gig_template_id WHERE t.status = 'RETIRED' AND v.status = 'ACTIVE'`,
  openDraftUnderRetiredTemplate: `SELECT t.code FROM catalog.gig_templates t JOIN catalog.gig_template_versions v ON v.gig_template_id = t.gig_template_id WHERE t.status = 'RETIRED' AND v.status = 'DRAFT'`,
  moreThanOneActiveOrDraft: `SELECT t.code FROM catalog.gig_templates t WHERE (SELECT count(*) FROM catalog.gig_template_versions v WHERE v.gig_template_id = t.gig_template_id AND v.status = 'ACTIVE') > 1
      OR (SELECT count(*) FROM catalog.gig_template_versions v WHERE v.gig_template_id = t.gig_template_id AND v.status = 'DRAFT') > 1`,
  nonContiguousVersionNumbers: `SELECT gig_template_id FROM catalog.gig_template_versions GROUP BY gig_template_id HAVING max(version_number) <> count(*) OR min(version_number) <> 1`,
  supersededWithoutSuccessor: `SELECT v.gig_template_version_id FROM catalog.gig_template_versions v WHERE v.status = 'SUPERSEDED'
      AND NOT EXISTS (SELECT 1 FROM catalog.gig_template_versions s WHERE s.gig_template_id = v.gig_template_id AND s.version_number > v.version_number AND s.published_at IS NOT NULL)`,
  activeVersionIsNotTheLastPublished: `SELECT v.gig_template_version_id FROM catalog.gig_template_versions v WHERE v.status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM catalog.gig_template_versions s WHERE s.gig_template_id = v.gig_template_id AND s.published_at > v.published_at)`,
} as const;
async function violations(from: Db = pool): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [name, text] of Object.entries(INVARIANTS)) out[name] = (await from.query(text)).rows;
  return out;
}
const NO_VIOLATIONS = Object.fromEntries(Object.keys(INVARIANTS).map((k) => [k, []]));

describe('D6. the publication checks: GIG_TEMPLATE_HAS_NO_FIELDS, ENUM_FIELD_WITHOUT_OPTIONS, FIXED_ENUM_WITHOUT_DEFAULT, in this order', () => {
  const live = () => makeTpl({ status: 'ACTIVE' });

  it('GIG_TEMPLATE_HAS_NO_FIELDS: a version without any field cannot be published (also after its last field was deleted); one field is enough', async () => {
    const t = await live();
    const v = await makeVersion(t);
    await expectRule(setVer(v.id, 'ACTIVE'), 'GIG_TEMPLATE_HAS_NO_FIELDS');
    const f = await addField(v);
    await run('DELETE FROM catalog.gig_template_fields WHERE gig_template_field_id = $1', [f.id]);
    await expectRule(setVer(v.id, 'ACTIVE'), 'GIG_TEMPLATE_HAS_NO_FIELDS');
    await addField(v);
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });

  it('GIG_TEMPLATE_HAS_NO_FIELDS counts the fields of THIS version only: the fields of another version of the template or of another template do not count', async () => {
    const t = await live();
    const v1 = await makePublished(t);
    const v2 = await makeVersion(t); // a new draft: no fields yet
    await expectRule(setVer(v2.id, 'ACTIVE'), 'GIG_TEMPLATE_HAS_NO_FIELDS');
    expect((await verRow(v1.id)).status, 'the failed publication did not supersede the old version').toBe('ACTIVE');
    expect((await verRow(v2.id)).status).toBe('DRAFT');
    await makeDraftWithField(await live());
  });

  it('ENUM_FIELD_WITHOUT_OPTIONS: every ENUM field needs an option (one of two is not enough), a non-ENUM field needs none, and deleting the last option brings the rule back', async () => {
    const t = await live();
    const v = await makeVersion(t);
    await addField(v, { key: 'notes' });
    const e1 = await addField(v, { key: 'finish', type: 'ENUM' });
    const e2 = await addField(v, { key: 'size', type: 'ENUM' });
    await expectRule(setVer(v.id, 'ACTIVE'), 'ENUM_FIELD_WITHOUT_OPTIONS');
    await addOption(e1, 'wax');
    await expectRule(setVer(v.id, 'ACTIVE'), 'ENUM_FIELD_WITHOUT_OPTIONS');
    await addOption(e2, 'small');
    await run('DELETE FROM catalog.gig_template_field_options WHERE gig_template_field_id = $1', [e1.id]);
    await expectRule(setVer(v.id, 'ACTIVE'), 'ENUM_FIELD_WITHOUT_OPTIONS');
    await addOption(e1, 'wax');
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });

  it('FIXED_ENUM_WITHOUT_DEFAULT: a PLATFORM_FIXED ENUM needs a default OPTION; a configurable or required ENUM does not; moving the default keeps the rule satisfied', async () => {
    const t = await live();
    const v = await makeVersion(t);
    await addField(v, { key: 'free', type: 'ENUM', behavior: 'PROVIDER_CONFIGURABLE' }).then((f) => addOption(f, 'a_one'));
    await addField(v, { key: 'must', type: 'ENUM', behavior: 'PROVIDER_REQUIRED' }).then((f) => addOption(f, 'a_one'));
    const fixed = await addField(v, { key: 'locked', type: 'ENUM', behavior: 'PLATFORM_FIXED' });
    await addOption(fixed, 'wax');
    await addOption(fixed, 'sealant');
    await expectRule(setVer(v.id, 'ACTIVE'), 'FIXED_ENUM_WITHOUT_DEFAULT');
    await run("UPDATE catalog.gig_template_field_options SET is_default = true WHERE gig_template_field_id = $1 AND option_code = 'wax'", [fixed.id]);
    await run("UPDATE catalog.gig_template_field_options SET is_default = false WHERE gig_template_field_id = $1 AND option_code = 'wax'", [fixed.id]);
    await run("UPDATE catalog.gig_template_field_options SET is_default = true WHERE gig_template_field_id = $1 AND option_code = 'sealant'", [fixed.id]);
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });

  it('reports the checks in order: the template rule, then no fields, then an ENUM without options, then a fixed ENUM without default, then the copy', async () => {
    const t = await makeTpl({ status: 'INACTIVE' });
    const v = await makeVersion(t);
    await expectRule(setVer(v.id, 'ACTIVE'), 'GIG_TEMPLATE_NOT_ACTIVE'); // before everything below
    await setTpl(t.id, 'ACTIVE');
    await expectRule(setVer(v.id, 'ACTIVE'), 'GIG_TEMPLATE_HAS_NO_FIELDS');
    const unpublished = await addField(v, { key: 'unpub', type: 'ENUM', behavior: 'PLATFORM_FIXED', content: 'NONE' }); // its label has no version
    await expectRule(setVer(v.id, 'ACTIVE'), 'ENUM_FIELD_WITHOUT_OPTIONS');
    await addOption(unpublished, 'wax', { content: 'NONE' });
    await expectRule(setVer(v.id, 'ACTIVE'), 'FIXED_ENUM_WITHOUT_DEFAULT');
    await run('UPDATE catalog.gig_template_field_options SET is_default = true WHERE gig_template_field_id = $1', [unpublished.id]);
    await expectRule(setVer(v.id, 'ACTIVE'), 'CONTENT_NOT_PUBLISHED');
  });

  it('a refused publication is atomic: the draft stays a DRAFT, the previous ACTIVE version is NOT superseded, and published_at stays NULL', async () => {
    const t = await live();
    const v1 = await makePublished(t);
    const v2 = await makeVersion(t);
    await addField(v2, { content: 'NONE' });
    await expectRule(setVer(v2.id, 'ACTIVE'), 'CONTENT_NOT_PUBLISHED');
    expect([(await verRow(v1.id)).status, (await verRow(v2.id)).status, (await verRow(v2.id)).published_at]).toEqual(['ACTIVE', 'DRAFT', null]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('publishes a full-featured version: fields of every type and behaviour, a fixed ENUM with its default option, a hidden field, durations, models, requirements', async () => {
    const t = await makeTpl({ status: 'ACTIVE', copy: true });
    const v = await makeVersion(t, {
      min_duration_minutes: 60,
      max_duration_minutes: 480,
      suggested_duration_minutes: 180,
      pricing_fixed: true,
      pricing_fixed_with_variants: true,
      pricing_bundle_eligible: true,
      pricing_drop_eligible: true,
      area_radius: true,
      area_postal_codes: true,
      area_polygon: true,
    });
    await addField(v, { key: 'summary', type: 'TEXT', behavior: 'PROVIDER_REQUIRED', section: 'SCOPE', minLength: 10, maxLength: 200, help: true });
    await addField(v, { key: 'details', type: 'LONG_TEXT', behavior: 'PLATFORM_FIXED', section: 'INCLUSIONS', defaultText: true });
    await addField(v, { key: 'rooms', type: 'INTEGER', minNumber: 1, maxNumber: 10, defaultNumber: 2, section: 'DETAILS' });
    await addField(v, { key: 'hours', type: 'DECIMAL', minNumber: '0.5', maxNumber: '8', behavior: 'PROVIDER_REQUIRED' });
    await addField(v, { key: 'pets', type: 'BOOLEAN', behavior: 'PLATFORM_FIXED', defaultBoolean: false, section: 'EXCLUSIONS' });
    await addField(v, { key: 'prep_time', type: 'DURATION', minNumber: 15, maxNumber: 120, defaultNumber: 30, section: 'PREPARATION' });
    await addField(v, { key: 'tip', type: 'MONEY', visible: false });
    await addField(v, { key: 'photos', type: 'MEDIA', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 6 });
    await addField(v, { key: 'tools', type: 'EQUIPMENT_REFERENCE', minItems: 0, maxItems: 5 });
    await addField(v, { key: 'skills', type: 'SKILL_REFERENCE', behavior: 'PROVIDER_REQUIRED', minItems: 1 });
    const finish = await addField(v, { key: 'finish', type: 'ENUM', behavior: 'PLATFORM_FIXED', help: true });
    await addOption(finish, 'wax', { order: 10 });
    await addOption(finish, 'ceramic', { order: 20, isDefault: true });
    await addReq(v.id, 'SKILL', 'detailing');
    await addReq(v.id, 'INSURANCE');
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
    expect(await count(F, 'gig_template_version_id = $1', [v.id])).toBe(11);
  });
});

describe('D6b. the longest derived content key still fits the content registry', () => {
  it('publishes a template with the longest code (48), field key (32) and option code (32): the derived option label is 154 characters, below the 160 of content.entries', async () => {
    const code = `a${'c'.repeat(47)}`;
    const t = await makeTpl({ code, status: 'ACTIVE', copy: true });
    const v = await makeVersion(t);
    const f = await addField(v, { key: `f${'k'.repeat(31)}`, type: 'ENUM', help: true });
    await addOption(f, `o${'p'.repeat(31)}`, { isDefault: true });
    const longest = gigTemplateOptionLabelKey(code, f.key, `o${'p'.repeat(31)}`);
    expect(longest).toHaveLength(154);
    expect(await count('content.entries', 'key = $1', [longest])).toBe(1);
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });
});

// ---------------------------------------------------------------- CONTENT_NOT_PUBLISHED
type BadCopy = ContentOpts;
const BAD_COPIES: [string, BadCopy][] = [
  ['an entry with no version at all', { state: 'NONE' }],
  ['a version that is only a DRAFT', { state: 'DRAFT' }],
  ['a version that is only APPROVED', { state: 'APPROVED' }],
  ['a version that is SCHEDULED for tomorrow', { state: 'SCHEDULED' }],
  ['a PUBLISHED version that starts in an hour', { state: 'FUTURE' }],
  ['a version that was SUPERSEDED and whose window ended', { state: 'SUPERSEDED' }],
  ['an entry that was deactivated (the resolver treats it as unknown)', { active: false }],
  ['a PUBLISHED version whose window ended an hour ago', { state: 'EXPIRED' }],
  ['a PUBLISHED version in another locale only', { locale: 'es-US' }],
  ['a PUBLISHED version at MARKET scope only', { scope: 'MARKET' }],
];
const COPY_KINDS = ['name', 'description', 'instructions', 'field label', 'field help', 'field default text', 'option label'] as const;
type CopyKind = (typeof COPY_KINDS)[number];
/** A publishable draft that names all seven kinds of key; the copy of ONE key can be forced into a state that is not usable. */
async function copyFixture(kind?: CopyKind, bad?: BadCopy, from: Db = pool) {
  const code = `cn_${++seq}`;
  const keys: Record<CopyKind, string> = {
    name: gigTemplateNameKey(code),
    description: gigTemplateDescriptionKey(code),
    instructions: gigTemplateInstructionsKey(code),
    'field label': gigTemplateFieldLabelKey(code, 'fld_a'),
    'field help': gigTemplateFieldHelpKey(code, 'fld_a'),
    'field default text': gigTemplateFieldDefaultKey(code, 'fld_a'),
    'option label': gigTemplateOptionLabelKey(code, 'fld_e', 'opt_a'),
  };
  if (kind && bad) contentOverrides.set(keys[kind], bad);
  try {
    const t = await makeTpl({ code, status: 'ACTIVE', copy: true }, from);
    const v = await makeVersion(t, {}, from);
    await addField(v, { key: 'fld_a', help: true, defaultText: true }, from);
    const e = await addField(v, { key: 'fld_e', type: 'ENUM' }, from);
    await addOption(e, 'opt_a', { isDefault: true }, from);
    return { t, v, key: kind ? keys[kind] : undefined };
  } finally {
    if (kind) contentOverrides.delete(keys[kind]);
  }
}

describe('D7. CONTENT_NOT_PUBLISHED: every content key of the template, its fields and its options must be PUBLISHED, platform scope, default locale and in force now', () => {
  const build = (kind?: CopyKind, bad?: BadCopy) => copyFixture(kind, bad);

  it('publishes when every one of the seven kinds of key is PUBLISHED (the control of every case below)', async () => {
    const { v } = await build();
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });

  const CASES = COPY_KINDS.flatMap((kind) => BAD_COPIES.map(([what, bad]) => [kind, what, bad] as const));
  it('has a case for every kind of key and every unusable state (7 x 10)', () => {
    expect(CASES).toHaveLength(70);
  });
  it.each(CASES)('the %s with %s refuses the publication', async (kind, _what, bad) => {
    const { v, key } = await build(kind, bad);
    expect((await q<{ ok: boolean }>('SELECT catalog.content_is_published($1) AS ok', [key]))[0]!.ok, `content_is_published(${key})`).toBe(false);
    await expectRule(setVer(v.id, 'ACTIVE'), 'CONTENT_NOT_PUBLISHED');
    expect((await verRow(v.id)).status).toBe('DRAFT');
  });

  it('a key that is usable only AFTER a second version is published is refused until then, and accepted once a PUBLISHED platform en-US version is in force', async () => {
    const { v, key } = await build('field label', { state: 'DRAFT' });
    await expectRule(setVer(v.id, 'ACTIVE'), 'CONTENT_NOT_PUBLISHED');
    await run(
      `INSERT INTO content.versions (entry_id, locale, scope_type, version, body, approval_policy, effective_from, reason, created_by)
       SELECT entry_id, 'en-US', 'PLATFORM', 2, 'second', 'NONE', now() - interval '1 minute', 'test', 'test' FROM content.entries WHERE key = $1`,
      [key],
    );
    await expectRule(setVer(v.id, 'ACTIVE'), 'CONTENT_NOT_PUBLISHED'); // the new version is a DRAFT too
    await run("UPDATE content.versions SET status = 'APPROVED' WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1) AND version = 2", [key]);
    await run("UPDATE content.versions SET status = 'PUBLISHED' WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1) AND version = 2", [key]);
    await setVer(v.id, 'ACTIVE');
  });

  /** A second version 2.. of the key in en-US / PLATFORM, drafted, approved and published through the guard, in force since a minute. */
  const publishNextVersion = async (key: string) => {
    await run(
      `INSERT INTO content.versions (entry_id, locale, scope_type, version, body, approval_policy, effective_from, reason, created_by)
       SELECT e.entry_id, 'en-US', 'PLATFORM', COALESCE((SELECT max(v.version) FROM content.versions v WHERE v.entry_id = e.entry_id AND v.locale = 'en-US' AND v.scope_type = 'PLATFORM'), 0) + 1,
              'next', 'NONE', now() - interval '1 minute', 'test', 'test' FROM content.entries e WHERE e.key = $1`,
      [key],
    );
    await run("UPDATE content.versions SET status = 'APPROVED' WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1) AND status = 'DRAFT'", [
      key,
    ]);
    await run(
      "UPDATE content.versions SET status = 'PUBLISHED' WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1) AND status = 'APPROVED'",
      [key],
    );
  };
  it.each([
    ['an earlier version whose window ended', { state: 'EXPIRED' } as ContentOpts],
    ['a version in another locale', { locale: 'es-US' } as ContentOpts],
    ['a version at MARKET scope', { scope: 'MARKET' } as ContentOpts],
  ])('accepts a key with a PUBLISHED platform en-US version in force even when %s exists next to it', async (_what, bad) => {
    const { v, key } = await build('option label', bad);
    await expectRule(setVer(v.id, 'ACTIVE'), 'CONTENT_NOT_PUBLISHED');
    await publishNextVersion(key!);
    expect((await q<{ ok: boolean }>('SELECT catalog.content_is_published($1) AS ok', [key]))[0]!.ok).toBe(true);
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });

  it.each([
    ['a SCHEDULED version whose start has passed (the activation job has not run yet: the resolver already serves it)', 'SCHEDULED_STARTED' as ContentState],
    ['a SUPERSEDED version whose window is still open (the resolver reads the same statuses)', 'SUPERSEDED_OPEN' as ContentState],
  ])('accepts %s', async (_what, state) => {
    const { v, key } = await build('field label', { state });
    expect((await q<{ ok: boolean }>('SELECT catalog.content_is_published($1) AS ok', [key]))[0]!.ok).toBe(true);
    await setVer(v.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
    // the content resolver agrees: the copy renders
    const content = new ContentService({ database: iso.database, env: 'test' });
    const rendered = await content.resolveRendered([key!], { locale: 'en-US', context: {}, includeInternal: false });
    expect(rendered.items.has(key!), 'the resolver serves the copy the database accepted').toBe(true);
  });

  it('refuses NULL and an unknown key on its own: content_is_published(NULL) and an unknown key are false (a NULL key in a column is skipped by the publication check, an unknown key cannot exist: the foreign key)', async () => {
    expect((await q<{ ok: boolean | null }>('SELECT catalog.content_is_published(NULL) AS ok'))[0]!.ok).toBe(false);
    expect((await q<{ ok: boolean }>("SELECT catalog.content_is_published('catalog.gig_template.nothing.name') AS ok"))[0]!.ok).toBe(false);
  });

  it('checks the copy at the instant of the publication: a key whose version is published in the SAME transaction counts', async () => {
    const { v, key } = await build('field help', { state: 'APPROVED' });
    const c = await openTx();
    try {
      await c.query("UPDATE content.versions SET status = 'PUBLISHED' WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1)", [key]);
      await c.query("UPDATE catalog.gig_template_versions SET status = 'ACTIVE' WHERE gig_template_version_id = $1", [v.id]);
      await finish(c, 'COMMIT');
    } catch (e) {
      await finish(c, 'ROLLBACK');
      throw e;
    }
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });
});

// ====================================================================== F. RESTRICT and TRUNCATE: nothing the Gig Templates name can be removed or re-keyed underneath them
const ALL_TABLES = [
  AUDIT,
  'catalog.categories',
  'catalog.market_categories',
  'catalog.market_service_types',
  'catalog.prohibited_services',
  'catalog.service_types',
  ...NEW_TABLES,
];
describe('F. RESTRICT: every foreign key holds when the guards are bypassed, and TRUNCATE is refused for every table', () => {
  /** A template whose every content key has an entry but NO version (so that the foreign key of the template is the only thing that holds the entry). */
  async function bare() {
    const t = await makeTpl({ status: 'ACTIVE', copy: true, content: 'NONE' });
    const v = await makeVersion(t);
    const f = await addField(v, { key: 'fld_a', help: true, defaultText: true, content: 'NONE' });
    const e = await addField(v, { key: 'fld_e', type: 'ENUM', content: 'NONE' });
    await addOption(e, 'opt_a', { content: 'NONE' });
    await addReq(v.id, 'SKILL', 'some_ref');
    return { t, v, f, e };
  }
  it.each([
    ['the name of a template', (c: string) => gigTemplateNameKey(c), 'fk_gig_templates__name_content_key'],
    ['the description of a template', (c: string) => gigTemplateDescriptionKey(c), 'fk_gig_templates__description_content_key'],
    ['the instructions of a template', (c: string) => gigTemplateInstructionsKey(c), 'fk_gig_templates__instructions_content_key'],
    ['the label of a field', (c: string) => gigTemplateFieldLabelKey(c, 'fld_a'), 'fk_gig_template_fields__label_content_key'],
    ['the help of a field', (c: string) => gigTemplateFieldHelpKey(c, 'fld_a'), 'fk_gig_template_fields__help_content_key'],
    ['the default text of a field', (c: string) => gigTemplateFieldDefaultKey(c, 'fld_a'), 'fk_gig_template_fields__default_content_key'],
    ['the label of an option', (c: string) => gigTemplateOptionLabelKey(c, 'fld_e', 'opt_a'), 'fk_gig_template_field_options__label_content_key'],
  ] as const)(
    'keeps the content entry of %s: deleting it or changing its key is refused by the foreign key (content guard out of the way)',
    async (_n, key, fk) => {
      const { t } = await bare();
      const k = key(t.code);
      await expectConstraint(isolated(noTriggers('content.entries'), 'DELETE FROM content.entries WHERE key = $1', [k]), fk);
      await expectConstraint(isolated(noTriggers('content.entries'), "UPDATE content.entries SET key = key || '_moved' WHERE key = $1", [k]), fk);
      expect(await count('content.entries', 'key = $1', [k])).toBe(1);
    },
  );

  it('keeps a service type that a template or a template audit row names, a template that anything names, a version, a field and a market: deleting one is refused by the foreign key (the delete guards bypassed)', async () => {
    const { t, v, f, e } = await bare();
    const m = await makeMarket();
    await addMarketRow(m.id, t.id);
    await run("INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id) VALUES ('a', 'GIG_TEMPLATE_UPDATED', 'r', 'c', $1)", [
      t.id,
    ]);
    await run(
      "INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id, gig_template_version_id) VALUES ('a', 'GIG_TEMPLATE_VERSION_CREATED', 'r', 'c', $1, $2)",
      [t.id, v.id],
    );
    const del = (table: string, where: string, params: unknown[]) => isolated(noTriggers(table), `DELETE FROM ${table} WHERE ${where}`, params);
    await expectConstraint(del('catalog.service_types', 'service_type_id = $1', [t.stId]), 'fk_gig_templates__service_type_id'); // the first referencing key, by name order of the triggers
    await expectConstraint(del(T, 'gig_template_id = $1', [t.id]), 'fk_gig_template_versions__gig_template_id');
    await expectConstraint(del(V, 'gig_template_version_id = $1', [v.id]), 'fk_gig_template_fields__version_id');
    await expectConstraint(del(F, 'gig_template_field_id = $1', [e.id]), 'fk_gig_template_field_options__field_id');
    await expectConstraint(
      isolated(
        [...noTriggers('geography.markets', 'geography.market_locales'), `DELETE FROM geography.market_locales WHERE market_id = '${m.id}'`],
        'DELETE FROM geography.markets WHERE market_id = $1',
        [m.id],
      ),
      'fk_market_gig_templates__market_id',
    );
    // a template with only an audit row and a market row
    const lone = await makeTpl();
    await run("INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id) VALUES ('a', 'GIG_TEMPLATE_UPDATED', 'r', 'c', $1)", [
      lone.id,
    ]);
    await expectConstraint(del(T, 'gig_template_id = $1', [lone.id]), 'fk_audit_events__gig_template_id');
    const marketOnly = await makeTpl();
    await addMarketRow(m.id, marketOnly.id);
    await expectConstraint(del(T, 'gig_template_id = $1', [marketOnly.id]), 'fk_market_gig_templates__gig_template_id');
    void f;
  });

  it('keeps a version that only an audit row, a requirement or a field names; and the rows of an unreferenced template stay re-keyable only by the guards (the primary key is not updatable behind the guard)', async () => {
    const { v } = await bare();
    await run(
      "INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id, gig_template_version_id) SELECT 'a', 'GIG_TEMPLATE_VERSION_CHANGED', 'r', 'c', gig_template_id, gig_template_version_id FROM catalog.gig_template_versions WHERE gig_template_version_id = $1",
      [v.id],
    );
    await expectConstraint(
      isolated(noTriggers(V), 'UPDATE catalog.gig_template_versions SET gig_template_version_id = gen_random_uuid() WHERE gig_template_version_id = $1', [
        v.id,
      ]),
      'fk_gig_template_fields__version_id',
    );
    await expectConstraint(
      isolated(
        noTriggers(T),
        'UPDATE catalog.gig_templates SET gig_template_id = gen_random_uuid() WHERE gig_template_id = (SELECT gig_template_id FROM catalog.gig_template_versions WHERE gig_template_version_id = $1)',
        [v.id],
      ),
      'fk_gig_template_versions__gig_template_id',
    );
  });

  it('refuses a plain TRUNCATE of a referenced table (PostgreSQL itself, 0A000) and of an unreferenced one (ROW_IMMUTABLE), and the CASCADE and multi-table forms (ROW_IMMUTABLE); every row survives', async () => {
    await bare();
    const before = await Promise.all(ALL_TABLES.map((t) => count(t)));
    for (const t of [T, V, F]) await expect(pool.query(`TRUNCATE ${t}`)).rejects.toMatchObject({ code: '0A000' });
    for (const t of [O, R, M, AUDIT]) await expectRule(run(`TRUNCATE ${t}`), 'ROW_IMMUTABLE');
    for (const t of ALL_TABLES) await expectRule(run(`TRUNCATE ${t} CASCADE`), 'ROW_IMMUTABLE');
    // since 0018 provider.registration_service_types (outside the list) references service_types, so PostgreSQL itself refuses the plain list before any trigger runs;
    // with that table in the list the catalogue's own guard answers (the provider guard is asserted by provider-model.itest.ts)
    await expect(pool.query(`TRUNCATE ${ALL_TABLES.join(', ')}`)).rejects.toMatchObject({ code: '0A000' });
    await expectRule(run(`TRUNCATE ${ALL_TABLES.join(', ')}, provider.registration_service_types`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${NEW_TABLES.join(', ')} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`), 'ROW_IMMUTABLE');
    expect(await Promise.all(ALL_TABLES.map((t) => count(t)))).toEqual(before);
  });

  it('refuses a cascade that reaches the Gig Templates from another table (content.entries, geography.markets, catalog.service_types, catalog.categories), as a guard failure of a registry; every row survives', async () => {
    const before = await Promise.all(ALL_TABLES.map((t) => count(t)));
    for (const t of ['content.entries', 'geography.markets', 'catalog.service_types', 'catalog.categories']) {
      const e = await fail(run(`TRUNCATE ${t} CASCADE`));
      expect(e.code, t).toBe('23000');
      expect(e.detail, t).toMatch(/^[a-z]+_rule:[A-Z_]+$/); // some registry's guard answers (identity, content, geography or catalog)
    }
    expect(await Promise.all(ALL_TABLES.map((t) => count(t)))).toEqual(before);
  });
});

// ====================================================================== G. hierarchy semantics: CAT-001 is unchanged, the public exposure is NOT decided in the database
const PUBLIC_TEMPLATES_SQL = `SELECT t.gig_template_id, t.code, st.code AS service_type_code, c.code AS category_code, t.name_content_key, t.description_content_key, t.instructions_content_key,
               mgt.display_order, v.*
          FROM catalog.market_gig_templates mgt
          JOIN geography.markets m ON m.market_id = mgt.market_id
          JOIN catalog.gig_templates t ON t.gig_template_id = mgt.gig_template_id
          JOIN catalog.service_types st ON st.service_type_id = t.service_type_id
          JOIN catalog.categories c ON c.category_id = st.category_id
          JOIN catalog.market_service_types mst ON mst.market_id = mgt.market_id AND mst.service_type_id = st.service_type_id
          JOIN catalog.market_categories mc ON mc.market_id = mgt.market_id AND mc.category_id = st.category_id
          JOIN catalog.gig_template_versions v ON v.gig_template_id = t.gig_template_id AND v.status = 'ACTIVE'
         WHERE m.code = $1 AND mgt.enabled AND t.status = 'ACTIVE' AND st.status = 'ACTIVE' AND c.status = 'ACTIVE' AND mst.enabled AND mc.enabled
         ORDER BY mgt.display_order`;
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
interface Exposure {
  market: Row;
  cat: Row;
  st: Row;
  t: Tpl;
  v: Ver;
}
/** A template that is public in a fresh market: every link of the chain is on. */
async function exposure(order = 10): Promise<Exposure> {
  const market = await makeMarket();
  const cat = await makeCategory('ACTIVE');
  const st = await makeServiceType(cat.id, 'ACTIVE');
  await run('INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
    market.id,
    cat.id,
    nextOrder(),
  ]);
  await run('INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
    market.id,
    st.id,
    nextOrder(),
  ]);
  const t = await makeTpl({ st, status: 'ACTIVE' });
  const v = await makePublished(t);
  await addMarketRow(market.id, t.id, { enabled: true, order });
  return { market, cat, st, t, v };
}
/** What the public read sees after `mutate` ran in a transaction that is always rolled back. */
async function publicCodes(marketCode: string, mutate?: (c: pg.PoolClient) => Promise<void>): Promise<string[]> {
  const c = await openTx();
  try {
    await mutate?.(c);
    return (await c.query(PUBLIC_TEMPLATES_SQL, [marketCode])).rows.map((r: { code: string }) => r.code);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

describe('G1. the public exposure of a template is decided by the READ (the service), the database only keeps the writes consistent', () => {
  it('uses the very statement of GigTemplateService.loadPublicSnapshot (the copy in this file has not drifted from packages/catalog/src/gig-template-service.ts)', () => {
    const source = squash(readFileSync(path.join(import.meta.dirname, '..', '..', 'catalog', 'src', 'gig-template-service.ts'), 'utf8')).replaceAll(
      '${marketCode}',
      '$1',
    );
    expect(source).toContain(squash(PUBLIC_TEMPLATES_SQL));
  });

  it('is public when the whole chain is on: market row enabled, template ACTIVE, an ACTIVE version, service type ACTIVE and enabled under an enabled ACTIVE category', async () => {
    const x = await exposure();
    expect(await publicCodes(x.market.code)).toEqual([x.t.code]);
  });

  const BREAKS: [string, (x: Exposure) => (c: pg.PoolClient) => Promise<void>, allowedByTheDatabase: boolean][] = [
    ['the market row is switched off', (x) => async (c) => void (await setMgt(x.market.id, x.t.id, false, c)), true],
    ['the template is paused (INACTIVE)', (x) => async (c) => void (await setTpl(x.t.id, 'INACTIVE', c)), true],
    ['the template is RETIRED (its version is closed)', (x) => async (c) => void (await setTpl(x.t.id, 'RETIRED', c)), true],
    ['the ACTIVE version is withdrawn', (x) => async (c) => void (await setVer(x.v.id, 'RETIRED', c)), true],
    [
      'the service type is paused (INACTIVE): CAT-001 lets it leave ACTIVE under its templates',
      (x) => async (c) => void (await setSt(x.st.id, 'INACTIVE', c)),
      true,
    ],
    ['the service type is RETIRED: CAT-001 lets it, with ACTIVE templates under it', (x) => async (c) => void (await setSt(x.st.id, 'RETIRED', c)), true],
    [
      'the service type is switched off in the market',
      (x) => async (c) => void (await c.query('UPDATE catalog.market_service_types SET enabled = false WHERE market_id = $1', [x.market.id])),
      true,
    ],
    [
      'the category is switched off in the market (the CAT-001 guard needs the service type off first: bypassed here)',
      (x) => async (c) => {
        await c.query(`ALTER TABLE catalog.market_categories DISABLE TRIGGER USER`);
        await c.query('UPDATE catalog.market_categories SET enabled = false WHERE market_id = $1', [x.market.id]);
      },
      false,
    ],
    [
      'the category leaves ACTIVE (the CAT-001 guard needs its service types off first: bypassed here)',
      (x) => async (c) => {
        await c.query(`ALTER TABLE catalog.categories DISABLE TRIGGER USER`);
        await c.query("UPDATE catalog.categories SET status = 'INACTIVE' WHERE category_id = $1", [x.cat.id]);
      },
      false,
    ],
  ];
  it.each(BREAKS)('is NOT public when %s (a write the database %s)', async (_what, mutation, allowed) => {
    const x = await exposure();
    expect(await publicCodes(x.market.code, mutation(x))).toEqual([]);
    expect(typeof allowed).toBe('boolean');
    // the same market, untouched: still public (the rollback restored everything)
    expect(await publicCodes(x.market.code)).toEqual([x.t.code]);
  });

  it('is not public in a market without a row, in an unknown market, and the market STATUS is not part of the statement (the service asks the market gate)', async () => {
    const x = await exposure();
    expect(await publicCodes((await makeMarket()).code)).toEqual([]);
    expect(await publicCodes('no-such-market')).toEqual([]);
    await run("UPDATE geography.markets SET status = 'ACTIVE' WHERE market_id = $1", [x.market.id]);
    expect(await publicCodes(x.market.code)).toEqual([x.t.code]);
    await run("UPDATE geography.markets SET status = 'INACTIVE' WHERE market_id = $1", [x.market.id]);
    expect(await publicCodes(x.market.code)).toEqual([x.t.code]);
  });

  it('shows one row per template (the ACTIVE version only) and orders by the display order of the market, not by insertion, code or id', async () => {
    const x = await exposure(30);
    const mk = async (order: number, prefix: string) => {
      const t = await makeTpl({ st: x.st, status: 'ACTIVE', code: `${prefix}_${++seq}` });
      await makePublished(t);
      await makePublished(t); // a second version: the first is SUPERSEDED and must not show
      await addMarketRow(x.market.id, t.id, { enabled: true, order });
      return t;
    };
    const [late, early, middle] = [await mk(40, 'aaa'), await mk(5, 'zzz'), await mk(20, 'mmm')];
    expect(await publicCodes(x.market.code)).toEqual([early.code, middle.code, x.t.code, late.code]);
    const rows = (await q('SELECT v.version_number FROM catalog.gig_template_versions v WHERE v.gig_template_id = $1 AND v.status = $2', [
      early.id,
      'ACTIVE',
    ])) as { version_number: number }[];
    expect(rows.map((r) => r.version_number)).toEqual([2]);
  });

  it('keeps one market out of another: the same template can be listed in several markets with different orders and states', async () => {
    const x = await exposure(10);
    const other = await makeMarket();
    await run('INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) VALUES ($1, $2, true, 1)', [other.id, x.cat.id]);
    await run('INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, true, 1)', [other.id, x.st.id]);
    await addMarketRow(other.id, x.t.id, { enabled: false, order: 1 });
    expect(await publicCodes(other.code)).toEqual([]);
    await setMgt(other.id, x.t.id, true);
    expect(await publicCodes(other.code)).toEqual([x.t.code]);
    expect(await publicCodes(x.market.code)).toEqual([x.t.code]);
  });
});

describe('G2. the CAT-001 guards are UNCHANGED: a service type or a category leaves ACTIVE / is RETIRED while it has templates, the templates are not cascaded', () => {
  it('lets an ACTIVE service type with ACTIVE templates and ACTIVE versions be paused, re-activated and retired; the templates and versions keep their status (documented by this test)', async () => {
    const { t, v } = await makeLiveTemplate();
    const draft = await makeTpl({ st: { id: t.stId, code: t.stCode } });
    await setSt(t.stId, 'INACTIVE');
    await setSt(t.stId, 'ACTIVE');
    await setSt(t.stId, 'INACTIVE');
    await setSt(t.stId, 'RETIRED');
    expect([(await tplRow(t.id)).status, (await verRow(v.id)).status, (await tplRow(draft.id)).status]).toEqual(['ACTIVE', 'ACTIVE', 'DRAFT']);
    // under the RETIRED service type: no new template, no activation, no publication; cleaning up is allowed
    const code = `late_${++seq}`;
    await ensureEntry(gigTemplateNameKey(code));
    await expectRule(run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [t.stId, code]), 'SERVICE_TYPE_RETIRED');
    await expectRule(setTpl(draft.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    const nv = await makeDraftWithField(t); // a draft can still be BUILT for an ACTIVE template (preparing the next version)
    await expectRule(setVer(nv.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    await setVer(nv.id, 'RETIRED');
    await setTpl(draft.id, 'RETIRED');
    await setTpl(t.id, 'RETIRED');
    expect((await verRow(v.id)).status).toBe('RETIRED');
  });

  it('lets a category with no ACTIVE or open service type be retired although templates exist under its RETIRED service types (CATEGORY_HAS_OPEN_SERVICE_TYPES looks at service types only)', async () => {
    const st = await makeSt('DRAFT');
    const t = await makeTpl({ st });
    await setSt(st.id, 'RETIRED');
    await setCat(st.categoryId, 'RETIRED');
    expect((await tplRow(t.id)).status).toBe('DRAFT');
    // a retired category and service type still carry the template's history: the template can be retired too
    await setTpl(t.id, 'RETIRED');
  });

  it('keeps the CAT-001 rules that DO exist: a category cannot leave ACTIVE while an ACTIVE service type is under it, templates or not', async () => {
    const { t } = await makeLiveTemplate();
    const catId = (await q<{ category_id: string }>('SELECT category_id FROM catalog.service_types WHERE service_type_id = $1', [t.stId]))[0]!.category_id;
    await expectRule(setCat(catId, 'INACTIVE'), 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    await setSt(t.stId, 'INACTIVE');
    await setCat(catId, 'INACTIVE'); // now allowed, with an ACTIVE template and an ACTIVE version underneath
    expect((await tplRow(t.id)).status).toBe('ACTIVE');
  });

  it('does not let the availability of a service type depend on its templates: switching the service type off in a market with an enabled template row is a CAT-001 write that succeeds', async () => {
    const x = await exposure();
    await run('UPDATE catalog.market_service_types SET enabled = false WHERE market_id = $1', [x.market.id]);
    expect((await q<{ enabled: boolean }>('SELECT enabled FROM catalog.market_gig_templates WHERE market_id = $1', [x.market.id]))[0]!.enabled).toBe(true);
    expect(await publicCodes(x.market.code)).toEqual([]);
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
const exec = (c: Db, r: RaceSql) => c.query(r.text, r.params ?? []);
const verStatus = (id: string, status: string): RaceSql => ({
  text: 'UPDATE catalog.gig_template_versions SET status = $2 WHERE gig_template_version_id = $1',
  params: [id, status],
});
const tplStatus = (id: string, status: string): RaceSql => ({
  text: 'UPDATE catalog.gig_templates SET status = $2 WHERE gig_template_id = $1',
  params: [id, status],
});
const stStatus = (id: string, status: string): RaceSql => ({
  text: 'UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1',
  params: [id, status],
});
const insertVersion = (tplId: string, n: number): RaceSql => ({
  text: 'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, $2)',
  params: [tplId, n],
});
const insertMarketRow = (market: string, tpl: string, order: number, enabled = false): RaceSql => ({
  text: 'INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order) VALUES ($1, $2, $3, $4)',
  params: [market, tpl, enabled, order],
});
const statusesOf = async (tplId: string): Promise<[number, string][]> =>
  (
    await q<{ n: number; status: string }>('SELECT version_number AS n, status FROM catalog.gig_template_versions WHERE gig_template_id = $1 ORDER BY 1', [
      tplId,
    ])
  ).map((r) => [r.n, r.status]);

describe('H1. publication, retirement and the hierarchy above serialize (both orders, with real lock waiters)', () => {
  it('two publications of the SAME draft: the second waits for the first and then finds the version ACTIVE (a no-op); exactly one ACTIVE version, the old one SUPERSEDED once', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    await makePublished(t);
    const d = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => exec(tx, verStatus(d.id, 'ACTIVE')), verStatus(d.id, 'ACTIVE'));
    expect(e).toBeUndefined();
    expect(await statusesOf(t.id)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
    ]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
    await noLockWaiters();
  });

  it('a conditional publication (WHERE status = DRAFT) racing a publication waits and then changes nothing; and it succeeds when the holder rolls back', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const d = await makeDraftWithField(t);
    const cond: RaceSql = {
      text: "UPDATE catalog.gig_template_versions SET status = 'ACTIVE' WHERE gig_template_version_id = $1 AND status = 'DRAFT'",
      params: [d.id],
    };
    expect(await holdThenRace((tx) => exec(tx, verStatus(d.id, 'ACTIVE')), cond)).toBeUndefined();
    expect(await statusesOf(t.id)).toEqual([[1, 'ACTIVE']]);
    const t2 = await makeTpl({ status: 'ACTIVE' });
    const d2 = await makeDraftWithField(t2);
    expect(await holdThenRace((tx) => exec(tx, verStatus(d2.id, 'ACTIVE')), { ...cond, params: [d2.id] }, 'ROLLBACK')).toBeUndefined();
    expect(await statusesOf(t2.id)).toEqual([[1, 'ACTIVE']]); // the racer published it after the rollback
  });

  it('a publication holds the template retirement back (the share lock on the template row); the retirement then runs, closes the new ACTIVE version, and no ACTIVE version is left under the RETIRED template', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    await makePublished(t);
    const d = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => exec(tx, verStatus(d.id, 'ACTIVE')), tplStatus(t.id, 'RETIRED'));
    expect(e).toBeUndefined();
    expect(await statusesOf(t.id)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'RETIRED'],
    ]);
    expect((await tplRow(t.id)).status).toBe('RETIRED');
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('a template row locked by the service (SELECT ... FOR UPDATE, then INACTIVE) holds the publication back: it then sees the template INACTIVE (GIG_TEMPLATE_NOT_ACTIVE), the draft stays a DRAFT', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const d = await makeDraftWithField(t);
    const e = await holdThenRace(
      async (tx) => {
        await tx.query('SELECT 1 FROM catalog.gig_templates WHERE gig_template_id = $1 FOR UPDATE', [t.id]);
        await exec(tx, tplStatus(t.id, 'INACTIVE'));
      },
      verStatus(d.id, 'ACTIVE'),
    );
    expect(asRule(e)).toEqual(rule('GIG_TEMPLATE_NOT_ACTIVE'));
    expect(await statusesOf(t.id)).toEqual([[1, 'DRAFT']]);
  });

  it('a retirement of the template (after its draft was discarded in the same transaction) makes a new version wait and fail: GIG_TEMPLATE_RETIRED; an open version creation holds the retirement back: GIG_TEMPLATE_HAS_OPEN_DRAFT', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const d = await makeDraftWithField(t);
    const e1 = await holdThenRace(
      async (tx) => {
        await exec(tx, verStatus(d.id, 'RETIRED'));
        await exec(tx, tplStatus(t.id, 'RETIRED'));
      },
      insertVersion(t.id, 2),
    );
    expect(asRule(e1)).toEqual(rule('GIG_TEMPLATE_RETIRED'));
    expect(await statusesOf(t.id)).toEqual([[1, 'RETIRED']]);
    const t2 = await makeTpl({ status: 'ACTIVE' });
    const e2 = await holdThenRace((tx) => exec(tx, insertVersion(t2.id, 1)), tplStatus(t2.id, 'RETIRED'));
    expect(asRule(e2)).toEqual(rule('GIG_TEMPLATE_HAS_OPEN_DRAFT'));
    expect((await tplRow(t2.id)).status).toBe('ACTIVE');
    expect(await statusesOf(t2.id)).toEqual([[1, 'DRAFT']]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('a service type deactivation holds the publication back (the share lock on the service type): SERVICE_TYPE_NOT_ACTIVE, the old version stays ACTIVE', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    await makePublished(t);
    const d = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => exec(tx, stStatus(t.stId, 'INACTIVE')), verStatus(d.id, 'ACTIVE'));
    expect(asRule(e)).toEqual(rule('SERVICE_TYPE_NOT_ACTIVE'));
    expect(await statusesOf(t.id)).toEqual([
      [1, 'ACTIVE'],
      [2, 'DRAFT'],
    ]);
  });

  it('an open publication holds the service type deactivation back; the deactivation then succeeds (CAT-001 is unchanged) and the published version stays ACTIVE under the paused service type', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const d = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => exec(tx, verStatus(d.id, 'ACTIVE')), stStatus(t.stId, 'INACTIVE'));
    expect(e).toBeUndefined();
    expect(await statusesOf(t.id)).toEqual([[1, 'ACTIVE']]);
    expect((await q<{ status: string }>('SELECT status FROM catalog.service_types WHERE service_type_id = $1', [t.stId]))[0]!.status).toBe('INACTIVE');
  });

  it('a service type retirement holds a template activation back (SERVICE_TYPE_NOT_ACTIVE) and a template creation back (SERVICE_TYPE_RETIRED); an open activation or creation holds the retirement back and the retirement then succeeds', async () => {
    const a = await makeTpl();
    expect(asRule(await holdThenRace((tx) => exec(tx, stStatus(a.stId, 'RETIRED')), tplStatus(a.id, 'ACTIVE')))).toEqual(rule('SERVICE_TYPE_NOT_ACTIVE'));
    expect((await tplRow(a.id)).status).toBe('DRAFT');
    const st = await makeSt();
    const code = `race_${++seq}`;
    await ensureEntry(gigTemplateNameKey(code));
    expect(
      asRule(
        await holdThenRace((tx) => exec(tx, stStatus(st.id, 'RETIRED')), {
          text: 'INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)',
          params: [st.id, code],
        }),
      ),
    ).toEqual(rule('SERVICE_TYPE_RETIRED'));
    expect(await count(T, 'code = $1', [code])).toBe(0);
    // the other order
    const b = await makeTpl();
    expect(await holdThenRace((tx) => exec(tx, tplStatus(b.id, 'ACTIVE')), stStatus(b.stId, 'RETIRED'))).toBeUndefined();
    expect([
      (await tplRow(b.id)).status,
      (await q<{ status: string }>('SELECT status FROM catalog.service_types WHERE service_type_id = $1', [b.stId]))[0]!.status,
    ]).toEqual(['ACTIVE', 'RETIRED']);
    const st2 = await makeSt();
    const code2 = `race_${++seq}`;
    await ensureEntry(gigTemplateNameKey(code2));
    expect(
      await holdThenRace(
        (tx) => tx.query('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [st2.id, code2]),
        stStatus(st2.id, 'RETIRED'),
      ),
    ).toBeUndefined();
    expect(await count(T, 'code = $1', [code2])).toBe(1); // a DRAFT template under a RETIRED service type: the write-time rule cannot see a LATER retirement (documented)
  });

  it('lets the withdrawal of the ACTIVE version hold a newer publication back at the supersession: the publication then finds nothing to supersede, and ends with exactly one ACTIVE version', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v1 = await makePublished(t);
    const d = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => exec(tx, verStatus(v1.id, 'RETIRED')), verStatus(d.id, 'ACTIVE'));
    expect(e).toBeUndefined();
    expect(await statusesOf(t.id)).toEqual([
      [1, 'RETIRED'],
      [2, 'ACTIVE'],
    ]);
    // and the other order: an open publication holds the withdrawal back, which then finds the version SUPERSEDED
    const t2 = await makeTpl({ status: 'ACTIVE' });
    const w1 = await makePublished(t2);
    const d2 = await makeDraftWithField(t2);
    const e2 = await holdThenRace((tx) => exec(tx, verStatus(d2.id, 'ACTIVE')), verStatus(w1.id, 'RETIRED'));
    expect(asRule(e2)).toEqual(rule('STATUS_TRANSITION'));
    expect(await statusesOf(t2.id)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
    ]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H2. the child rows and the publication serialize (the child takes the version row FOR SHARE, the publisher updates it)', () => {
  it('an open field insert holds the publication back; the publication then sees the new field (its copy is not published): CONTENT_NOT_PUBLISHED, nothing goes live', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => addField(v, { key: 'late_field', content: 'NONE' }, tx), verStatus(v.id, 'ACTIVE'));
    expect(asRule(e)).toEqual(rule('CONTENT_NOT_PUBLISHED'));
    expect(await statusesOf(t.id)).toEqual([[1, 'DRAFT']]);
    expect(await count(F, 'gig_template_version_id = $1', [v.id])).toBe(2);
  });

  it('an open publication holds a field insert back; the insert then finds the version ACTIVE: VERSION_NOT_DRAFT, no row is added', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    await ensureContent(gigTemplateFieldLabelKey(v.code, 'late_field'));
    const e = await holdThenRace((tx) => exec(tx, verStatus(v.id, 'ACTIVE')), {
      text: "INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key) VALUES ($1, 'late_field', 'TEXT', 'PROVIDER_CONFIGURABLE', 50, $2)",
      params: [v.id, gigTemplateFieldLabelKey(v.code, 'late_field')],
    });
    expect(asRule(e)).toEqual(rule('VERSION_NOT_DRAFT'));
    expect(await count(F, 'gig_template_version_id = $1', [v.id])).toBe(1);
    expect(await statusesOf(t.id)).toEqual([[1, 'ACTIVE']]);
  });

  it('an open deletion of the last option holds the publication back, which then refuses the ENUM without options; an open publication holds an option insert and a requirement insert back (VERSION_NOT_DRAFT)', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeVersion(t);
    const en = await addField(v, { type: 'ENUM' });
    await addOption(en, 'only');
    const e = await holdThenRace(
      (tx) => tx.query('DELETE FROM catalog.gig_template_field_options WHERE gig_template_field_id = $1', [en.id]),
      verStatus(v.id, 'ACTIVE'),
    );
    expect(asRule(e)).toEqual(rule('ENUM_FIELD_WITHOUT_OPTIONS'));
    await addOption(en, 'only');
    await ensureContent(gigTemplateOptionLabelKey(v.code, en.key, 'second'));
    const racer: RaceSql = {
      text: "INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order) VALUES ($1, 'second', $2, 5)",
      params: [en.id, gigTemplateOptionLabelKey(v.code, en.key, 'second')],
    };
    expect(asRule(await holdThenRace((tx) => exec(tx, verStatus(v.id, 'ACTIVE')), racer))).toEqual(rule('VERSION_NOT_DRAFT'));
    // the same for a requirement and a field on a version whose publication is open
    const t2 = await makeTpl({ status: 'ACTIVE' });
    const v2 = await makeDraftWithField(t2);
    const req: RaceSql = {
      text: "INSERT INTO catalog.gig_template_requirements (gig_template_version_id, requirement_type) VALUES ($1, 'SKILL')",
      params: [v2.id],
    };
    expect(asRule(await holdThenRace((tx) => exec(tx, verStatus(v2.id, 'ACTIVE')), req))).toEqual(rule('VERSION_NOT_DRAFT'));
    expect(await count(R, 'gig_template_version_id = $1', [v2.id])).toBe(0);
  });

  it('an open requirement insert holds the publication back until it commits, and the published version then contains the requirement (the hook is part of the frozen structure)', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => addReq(v.id, 'SKILL', 'racer_ref', tx), verStatus(v.id, 'ACTIVE'));
    expect(e).toBeUndefined();
    expect(await count(R, 'gig_template_version_id = $1', [v.id])).toBe(1);
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });

  it('an open field edit holds a DISCARD of the version back; the discard then succeeds and the version keeps the field (history is never deleted)', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    const e = await holdThenRace((tx) => addField(v, { key: 'extra_field' }, tx), verStatus(v.id, 'RETIRED'));
    expect(e).toBeUndefined();
    expect(await count(F, 'gig_template_version_id = $1', [v.id])).toBe(2);
    expect((await verRow(v.id)).status).toBe('RETIRED');
  });
});

describe('H3. version numbers, the one-draft rule and the claims on a market position collide cleanly', () => {
  it('two creators of the same next version: the second waits for the first and fails on the unique key (the number, or the single draft); the loser leaves nothing behind', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    await makePublished(t);
    const e = await holdThenRace((tx) => exec(tx, insertVersion(t.id, 2)), insertVersion(t.id, 2));
    expect(e?.code).toBe('23505');
    expect(['uq_gig_template_versions__number', 'uq_gig_template_versions__draft']).toContain(e?.constraint);
    expect(await statusesOf(t.id)).toEqual([
      [1, 'ACTIVE'],
      [2, 'DRAFT'],
    ]);
  });

  it('lets the waiting creator succeed when the first one rolls back (the number is free again)', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    expect(await holdThenRace((tx) => exec(tx, insertVersion(t.id, 1)), insertVersion(t.id, 1), 'ROLLBACK')).toBeUndefined();
    expect(await statusesOf(t.id)).toEqual([[1, 'DRAFT']]);
  });

  it('answers a creator that skips ahead at once (VERSION_NUMBER_SEQUENCE, no wait) and a creator that follows a committed draft with the one-draft key', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    await makePublished(t);
    const tx = await openTx();
    try {
      await exec(tx, insertVersion(t.id, 2));
      await expectRule(racePool.query(insertVersion(t.id, 3).text, insertVersion(t.id, 3).params), 'VERSION_NUMBER_SEQUENCE'); // returns immediately: it does not wait
      expect(await waitersOn(pool)).toBe(0);
    } finally {
      await finish(tx, 'COMMIT');
    }
    await expectConstraint(run(insertVersion(t.id, 3).text, insertVersion(t.id, 3).params), 'uq_gig_template_versions__draft');
  });

  it('a creator of the next version waits for the open publication (or the open discard) of the current draft on the one-draft key and then succeeds; the discarded number is not reused', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    await makePublished(t);
    const d = await makeDraftWithField(t);
    expect(await holdThenRace((tx) => exec(tx, verStatus(d.id, 'ACTIVE')), insertVersion(t.id, 3))).toBeUndefined();
    expect(await statusesOf(t.id)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
      [3, 'DRAFT'],
    ]);
    const t2 = await makeTpl({ status: 'ACTIVE' });
    const d2 = await makeDraftWithField(t2);
    expect(await holdThenRace((tx) => exec(tx, verStatus(d2.id, 'RETIRED')), insertVersion(t2.id, 2))).toBeUndefined();
    expect(await statusesOf(t2.id)).toEqual([
      [1, 'RETIRED'],
      [2, 'DRAFT'],
    ]);
    // and when the holder rolls back the one-draft key refuses the creator
    const t3 = await makeTpl({ status: 'ACTIVE' });
    const d3 = await makeDraftWithField(t3);
    const e = await holdThenRace((tx) => exec(tx, verStatus(d3.id, 'ACTIVE')), insertVersion(t3.id, 2), 'ROLLBACK');
    expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'uq_gig_template_versions__draft' });
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('two first inserts of the same (market, template) availability: the second waits and fails on the primary key; it succeeds when the first rolls back', async () => {
    const [m, t] = [await makeMarket(), await makeTpl()];
    const e = await holdThenRace((tx) => exec(tx, insertMarketRow(m.id, t.id, 10)), insertMarketRow(m.id, t.id, 11));
    expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'pk_market_gig_templates' });
    expect(await count(M, 'market_id = $1', [m.id])).toBe(1);
    const t2 = await makeTpl();
    expect(await holdThenRace((tx) => exec(tx, insertMarketRow(m.id, t2.id, 20)), insertMarketRow(m.id, t2.id, 21), 'ROLLBACK')).toBeUndefined();
    expect(await count(M, 'market_id = $1', [m.id])).toBe(2);
  });

  it('claims a display order once: the second claim of a position waits and fails on the unique key of the market; the position is free again after a rollback', async () => {
    const m = await makeMarket();
    const [a, b, c] = [await makeTpl(), await makeTpl(), await makeTpl()];
    const e = await holdThenRace((tx) => exec(tx, insertMarketRow(m.id, a.id, 5)), insertMarketRow(m.id, b.id, 5));
    expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'uq_market_gig_templates__market_order' });
    expect(await holdThenRace((tx) => exec(tx, insertMarketRow(m.id, b.id, 6)), insertMarketRow(m.id, c.id, 6), 'ROLLBACK')).toBeUndefined();
    expect(await count(M, 'market_id = $1', [m.id])).toBe(2);
  });

  it('a template retirement holds an enabling back (ITEM_RETIRED), and an open enabling holds the retirement back, which then leaves the row enabled (the service excludes it by status)', async () => {
    const [m, t] = [await makeMarket(), await makeTpl({ status: 'ACTIVE' })];
    expect(asRule(await holdThenRace((tx) => exec(tx, tplStatus(t.id, 'RETIRED')), insertMarketRow(m.id, t.id, 1, true)))).toEqual(rule('ITEM_RETIRED'));
    expect(await count(M, 'gig_template_id = $1', [t.id])).toBe(0);
    const t2 = await makeTpl({ status: 'ACTIVE' });
    expect(await holdThenRace((tx) => exec(tx, insertMarketRow(m.id, t2.id, 2, true)), tplStatus(t2.id, 'RETIRED'))).toBeUndefined();
    expect((await q<{ enabled: boolean }>('SELECT enabled FROM catalog.market_gig_templates WHERE gig_template_id = $1', [t2.id]))[0]!.enabled).toBe(true);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H4. 25 fresh rounds each, the two statements started at the same instant: the invariants hold, nothing deadlocks', () => {
  const ROUNDS = 25;
  const both = (a: RaceSql, b: RaceSql) =>
    Promise.all([rejection(racePool.query(a.text, a.params ?? [])), rejection(racePool.query(b.text, b.params ?? []))]) as Promise<
      [PgFailure | undefined, PgFailure | undefined]
    >;
  const notDeadlock = (e: PgFailure | undefined) => expect(String(e?.code ?? ''), 'a deadlock or a serialization failure is a defect').not.toMatch(/^40/);
  const winners = (r: (PgFailure | undefined)[]): number => r.filter((x) => x === undefined).length;

  it('two publications of the same draft: both succeed (the second is a no-op), one ACTIVE version, the previous one SUPERSEDED exactly once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      await makePublished(t);
      const d = await makeDraftWithField(t);
      const r = await both(verStatus(d.id, 'ACTIVE'), verStatus(d.id, 'ACTIVE'));
      r.forEach(notDeadlock);
      expect(r, `round ${round}`).toEqual([undefined, undefined]);
      expect(await statusesOf(t.id), `round ${round}`).toEqual([
        [1, 'SUPERSEDED'],
        [2, 'ACTIVE'],
      ]);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('publication against template retirement: the publication always wins, the retirement either follows (closing the new version) or is refused because the draft was still open; never an ACTIVE version under a RETIRED template', async () => {
    const seen = { retired: 0, refused: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      await makePublished(t);
      const d = await makeDraftWithField(t);
      const r = await both(verStatus(d.id, 'ACTIVE'), tplStatus(t.id, 'RETIRED'));
      r.forEach(notDeadlock);
      expect(r[0], `round ${round}: the publication`).toBeUndefined();
      if (r[1] === undefined) {
        seen.retired++;
        expect(await statusesOf(t.id), `round ${round}`).toEqual([
          [1, 'SUPERSEDED'],
          [2, 'RETIRED'],
        ]);
        expect((await tplRow(t.id)).status).toBe('RETIRED');
      } else {
        seen.refused++;
        expect(asRule(r[1]), `round ${round}`).toEqual(rule('GIG_TEMPLATE_HAS_OPEN_DRAFT'));
        expect(await statusesOf(t.id), `round ${round}`).toEqual([
          [1, 'SUPERSEDED'],
          [2, 'ACTIVE'],
        ]);
      }
    }
    expect(seen.retired + seen.refused).toBe(ROUNDS);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('publication against service type deactivation: the deactivation always succeeds; the publication either went live first or was refused with SERVICE_TYPE_NOT_ACTIVE, leaving the old version ACTIVE', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      await makePublished(t);
      const d = await makeDraftWithField(t);
      const r = await both(verStatus(d.id, 'ACTIVE'), stStatus(t.stId, 'INACTIVE'));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}: the deactivation`).toBeUndefined();
      if (r[0] === undefined)
        expect(await statusesOf(t.id), `round ${round}`).toEqual([
          [1, 'SUPERSEDED'],
          [2, 'ACTIVE'],
        ]);
      else {
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('SERVICE_TYPE_NOT_ACTIVE'));
        expect(await statusesOf(t.id), `round ${round}`).toEqual([
          [1, 'ACTIVE'],
          [2, 'DRAFT'],
        ]);
      }
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('field insert against publication: exactly one wins; a version that went live never gains a field with unpublished copy', async () => {
    const outcomes = { published: 0, field: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      const v = await makeDraftWithField(t);
      const key = `race_field_${round}`;
      await ensureEntry(gigTemplateFieldLabelKey(v.code, key)); // an entry without a version: the copy is NOT published
      const insert: RaceSql = {
        text: "INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key) VALUES ($1, $2, 'TEXT', 'PROVIDER_CONFIGURABLE', 50, $3)",
        params: [v.id, key, gigTemplateFieldLabelKey(v.code, key)],
      };
      const r = await both(verStatus(v.id, 'ACTIVE'), insert);
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      const fields = await count(F, 'gig_template_version_id = $1', [v.id]);
      if (r[0] === undefined) {
        outcomes.published++;
        expect(asRule(r[1]), `round ${round}`).toEqual(rule('VERSION_NOT_DRAFT'));
        expect([(await verRow(v.id)).status, fields], `round ${round}: a live version with an unpublished field`).toEqual(['ACTIVE', 1]);
      } else {
        outcomes.field++;
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('CONTENT_NOT_PUBLISHED'));
        expect([(await verRow(v.id)).status, fields]).toEqual(['DRAFT', 2]);
      }
    }
    expect(outcomes.published + outcomes.field).toBe(ROUNDS);
  });

  it('two creators of the next version: exactly one wins, the loser gets a unique-key error, the numbers stay contiguous with a single draft', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      await makePublished(t);
      const r = await both(insertVersion(t.id, 2), insertVersion(t.id, 2));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      const loser = r.find((x) => x !== undefined)!;
      // the loser either waited on the unique key (23505) or started after the winner committed and was refused by the number rule
      expect(
        loser.code === '23505' || (loser.code === '23000' && loser.detail === 'catalog_rule:VERSION_NUMBER_SEQUENCE'),
        `round ${round}: ${loser.code} ${loser.detail}`,
      ).toBe(true);
      expect(await statusesOf(t.id), `round ${round}`).toEqual([
        [1, 'ACTIVE'],
        [2, 'DRAFT'],
      ]);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('a publication against the creation of the next version: both succeed (the creator waits on the one-draft key and then sees the draft published), never two drafts', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      await makePublished(t);
      const d = await makeDraftWithField(t);
      const r = await both(verStatus(d.id, 'ACTIVE'), insertVersion(t.id, 3));
      r.forEach(notDeadlock);
      // the creator may also run first and meet the one-draft key before the publication committed: it then waits for it, so it never fails with a rule
      expect(r[0], `round ${round}: the publication`).toBeUndefined();
      expect(
        r[1] === undefined || (r[1].code === '23505' && r[1].constraint === 'uq_gig_template_versions__draft'),
        `round ${round}: ${r[1]?.code} ${r[1]?.constraint}`,
      ).toBe(true);
      const st = await statusesOf(t.id);
      expect(st.slice(0, 2), `round ${round}`).toEqual([
        [1, 'SUPERSEDED'],
        [2, 'ACTIVE'],
      ]);
      expect(st.length === 3 ? st[2] : [3, 'DRAFT'], `round ${round}`).toEqual([3, 'DRAFT']);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('two first inserts of the same (market, template) availability and five claims of one display order: exactly one winner each', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [m, t] = [await makeMarket(), await makeTpl()];
      const r = await both(insertMarketRow(m.id, t.id, 1), insertMarketRow(m.id, t.id, 2));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      expect(r.find((x) => x !== undefined)!.constraint).toBe('pk_market_gig_templates');
    }
    for (let round = 0; round < 10; round++) {
      const m = await makeMarket();
      const ts = await Promise.all([1, 2, 3, 4, 5].map(() => makeTpl()));
      const r = (await Promise.all(ts.map((t) => rejection(racePool.query(insertMarketRow(m.id, t.id, 7).text, insertMarketRow(m.id, t.id, 7).params))))) as (
        PgFailure | undefined
      )[];
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      for (const e of r.filter((x) => x !== undefined)) expect(e!.constraint).toBe('uq_market_gig_templates__market_order');
      expect(await count(M, 'market_id = $1', [m.id])).toBe(1);
    }
  });

  it('withdrawal of the ACTIVE version against the publication of the next: one ACTIVE version at the end; the withdrawal is refused (STATUS_TRANSITION) only when the supersession got there first', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      const v1 = await makePublished(t);
      const d = await makeDraftWithField(t);
      const r = await both(verStatus(d.id, 'ACTIVE'), verStatus(v1.id, 'RETIRED'));
      r.forEach(notDeadlock);
      expect(r[0], `round ${round}: the publication`).toBeUndefined();
      const st = await statusesOf(t.id);
      if (r[1] === undefined)
        expect(st, `round ${round}`).toEqual([
          [1, 'RETIRED'],
          [2, 'ACTIVE'],
        ]);
      else {
        expect(asRule(r[1]), `round ${round}`).toEqual(rule('STATUS_TRANSITION'));
        expect(st, `round ${round}`).toEqual([
          [1, 'SUPERSEDED'],
          [2, 'ACTIVE'],
        ]);
      }
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('template retirement against the creation of a version: exactly one wins; never a draft under a RETIRED template', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl({ status: 'ACTIVE' });
      await makePublished(t);
      const r = await both(tplStatus(t.id, 'RETIRED'), insertVersion(t.id, 2));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      if (r[0] === undefined) {
        expect(asRule(r[1]), `round ${round}`).toEqual(rule('GIG_TEMPLATE_RETIRED'));
        expect(await statusesOf(t.id)).toEqual([[1, 'RETIRED']]);
      } else {
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('GIG_TEMPLATE_HAS_OPEN_DRAFT'));
        expect(await statusesOf(t.id)).toEqual([
          [1, 'ACTIVE'],
          [2, 'DRAFT'],
        ]);
      }
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('template activation against service type deactivation: the template is ACTIVE exactly when its activation succeeded; the deactivation always succeeds', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await makeTpl();
      const r = await both(tplStatus(t.id, 'ACTIVE'), stStatus(t.stId, 'INACTIVE'));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}`).toBeUndefined();
      expect((await tplRow(t.id)).status, `round ${round}`).toBe(r[0] === undefined ? 'ACTIVE' : 'DRAFT');
      if (r[0] !== undefined) expect(asRule(r[0])).toEqual(rule('SERVICE_TYPE_NOT_ACTIVE'));
    }
  });

  it('a reader never sees a template without an ACTIVE version, or with two, while versions are published one after the other (a statement sees the whole publication or none of it)', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    await makePublished(t);
    let writing = true;
    const anomalies: string[] = [];
    let reads = 0;
    const reader = async () => {
      while (writing) {
        const r = (
          await racePool.query(
            "SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active, count(*) FILTER (WHERE status = 'DRAFT')::int AS drafts FROM catalog.gig_template_versions WHERE gig_template_id = $1",
            [t.id],
          )
        ).rows[0] as {
          active: number;
          drafts: number;
        };
        reads++;
        if (r.active !== 1 || r.drafts > 1) anomalies.push(JSON.stringify(r));
      }
    };
    const readers = [reader(), reader(), reader()];
    for (let n = 0; n < 15; n++) await makePublished(t);
    writing = false;
    await Promise.all(readers);
    expect(anomalies).toEqual([]);
    expect(reads).toBeGreaterThan(30);
    expect(await statusesOf(t.id)).toHaveLength(16);
    expect((await statusesOf(t.id)).filter(([, s]) => s === 'ACTIVE')).toEqual([[16, 'ACTIVE']]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

// ====================================================================== I. the access paths of the template reads
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
describe('I. the access paths: every lookup of the template reads reaches its rows through the intended index, on tables with enough rows, and there is no other index', () => {
  const TEMPLATES = 120;
  let stIds: string[];
  let markets: Row[];
  let sample: { tplId: string; code: string; activeVersion: string; draftVersion: string; field: string; enumField: string };
  beforeAll(async () => {
    stIds = [];
    for (let i = 0; i < 6; i++) stIds.push((await makeSt()).id);
    markets = [await makeMarket(), await makeMarket(), await makeMarket()];
    const c = await pool.connect();
    try {
      // one transaction with the guards of the six tables out of the way: the statuses, versions and fields are written straight (the planner only needs the rows)
      await c.query('BEGIN');
      for (const t of NEW_TABLES) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      const entry = (keys: string) =>
        `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
         SELECT k, 'UI_LABEL', 'CONTENT', 'bulk', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'test' FROM (${keys}) AS x(k)`;
      await c.query(entry(`SELECT 'catalog.gig_template.ap_' || g || '.name' FROM generate_series(1, ${TEMPLATES}) g`));
      await c.query(
        entry(`SELECT 'catalog.gig_template.ap_' || g || '.field.f' || k || '.label' FROM generate_series(1, ${TEMPLATES}) g, generate_series(1, 10) k`),
      );
      await c.query(
        entry(
          `SELECT 'catalog.gig_template.ap_' || g || '.field.f' || k || '.option.o' || o || '.label' FROM generate_series(1, ${TEMPLATES}) g, generate_series(9, 10) k, generate_series(1, 3) o`,
        ),
      );
      await c.query(
        `INSERT INTO catalog.gig_templates (service_type_id, code, status)
         SELECT ($1::uuid[])[1 + g % 6], 'ap_' || g, CASE WHEN g % 10 = 0 THEN 'INACTIVE' ELSE 'ACTIVE' END FROM generate_series(1, ${TEMPLATES}) g`,
        [stIds],
      );
      await c.query(
        `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, published_at, closed_at)
         SELECT t.gig_template_id, n, CASE n WHEN 1 THEN 'SUPERSEDED' WHEN 2 THEN 'ACTIVE' ELSE 'DRAFT' END,
                CASE WHEN n < 3 THEN now() END, CASE WHEN n = 1 THEN now() END
           FROM catalog.gig_templates t CROSS JOIN generate_series(1, 3) n WHERE t.code LIKE 'ap\\_%'`,
      );
      await c.query(
        `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key)
         SELECT v.gig_template_version_id, 'f' || k, CASE WHEN k > 8 THEN 'ENUM' ELSE 'TEXT' END, 'PROVIDER_CONFIGURABLE', k, 'catalog.gig_template.' || t.code || '.field.f' || k || '.label'
           FROM catalog.gig_template_versions v JOIN catalog.gig_templates t USING (gig_template_id) CROSS JOIN generate_series(1, 10) k WHERE t.code LIKE 'ap\\_%'`,
      );
      await c.query(
        `INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order, is_default)
         SELECT f.gig_template_field_id, 'o' || o, 'catalog.gig_template.' || t.code || '.field.' || f.field_key || '.option.o' || o || '.label', o, o = 1
           FROM catalog.gig_template_fields f JOIN catalog.gig_template_versions v USING (gig_template_version_id) JOIN catalog.gig_templates t USING (gig_template_id)
           CROSS JOIN generate_series(1, 3) o WHERE f.field_type = 'ENUM' AND t.code LIKE 'ap\\_%'`,
      );
      await c.query(
        `INSERT INTO catalog.gig_template_requirements (gig_template_version_id, requirement_type, reference_code)
         SELECT v.gig_template_version_id, r.type, r.ref FROM catalog.gig_template_versions v JOIN catalog.gig_templates t USING (gig_template_id)
           CROSS JOIN (VALUES ('SKILL', 'a_skill'), ('INSURANCE', NULL)) AS r(type, ref) WHERE t.code LIKE 'ap\\_%'`,
      );
      for (const [i, m] of markets.entries())
        await c.query(
          `INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order)
           SELECT $1, t.gig_template_id, (substring(t.code from 4)::int) % 2 = 0, substring(t.code from 4)::int * 10 + $2 FROM catalog.gig_templates t WHERE t.code LIKE 'ap\\_%' AND substring(t.code from 4)::int <= 60`,
          [m.id, i],
        );
      for (const t of NEW_TABLES) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    for (const t of [
      ...NEW_TABLES,
      'catalog.service_types',
      'catalog.categories',
      'geography.markets',
      'catalog.market_service_types',
      'catalog.market_categories',
    ])
      await run(`ANALYZE ${t}`);
    const s = (
      await q<{ tpl: string; code: string; active: string; draft: string; field: string; enumf: string }>(
        `SELECT t.gig_template_id AS tpl, t.code, a.gig_template_version_id AS active, d.gig_template_version_id AS draft,
                (SELECT gig_template_field_id FROM catalog.gig_template_fields WHERE gig_template_version_id = a.gig_template_version_id AND field_key = 'f1') AS field,
                (SELECT gig_template_field_id FROM catalog.gig_template_fields WHERE gig_template_version_id = a.gig_template_version_id AND field_key = 'f9') AS enumf
           FROM catalog.gig_templates t JOIN catalog.gig_template_versions a ON a.gig_template_id = t.gig_template_id AND a.status = 'ACTIVE'
           JOIN catalog.gig_template_versions d ON d.gig_template_id = t.gig_template_id AND d.status = 'DRAFT' WHERE t.code = 'ap_7'`,
      )
    )[0]!;
    sample = { tplId: s.tpl, code: s.code, activeVersion: s.active, draftVersion: s.draft, field: s.field, enumField: s.enumf };
  }, 120_000);

  const SEQ_OFF = ['SET LOCAL enable_seqscan = off'];
  const usedIndexes = (plan: string): string[] =>
    [...new Set([...plan.matchAll(/(?:Scan using|Bitmap Index Scan on|Index Only Scan using) (\w+)/g)].map((m) => m[1]!))].sort();

  it('has enough rows to mean something (120 templates, 360 versions, 3600 fields, 2160 options, 720 requirements, 180 market rows) and the statistics are fresh', async () => {
    expect(await count(T, "code LIKE 'ap\\_%'")).toBe(120);
    expect(await count(V, 'gig_template_id = ANY(SELECT gig_template_id FROM catalog.gig_templates)')).toBeGreaterThanOrEqual(360);
    expect(await count(F)).toBeGreaterThanOrEqual(3600);
    expect(await count(O)).toBeGreaterThanOrEqual(2160);
    expect(await count(R)).toBeGreaterThanOrEqual(720);
    expect(await count(M)).toBeGreaterThanOrEqual(180);
  });

  it('finds a template by its code through the unique code key, and the templates of a service type through idx_gig_templates__service_type', async () => {
    expect(await planOf(`SELECT gig_template_id FROM ${T} WHERE code = $1`, [sample.code], SEQ_OFF)).toMatch(/Index Scan using uq_gig_templates__code on/);
    const byType = await planOf(`SELECT code FROM ${T} WHERE service_type_id = $1`, [stIds[0]], SEQ_OFF);
    expect(usedIndexes(byType)).toEqual(['idx_gig_templates__service_type']);
    expect(byType).not.toMatch(/Seq Scan/);
  });

  it('finds THE active version of a template through the partial unique index, and its draft through the other: the access path IS the rule', async () => {
    const active = await planOf(`SELECT * FROM ${V} WHERE gig_template_id = $1 AND status = 'ACTIVE'`, [sample.tplId], SEQ_OFF);
    expect(usedIndexes(active)).toEqual(['uq_gig_template_versions__active']);
    expect(await planOf(`SELECT * FROM ${V} WHERE gig_template_id = $1 AND status = 'DRAFT'`, [sample.tplId], SEQ_OFF)).toMatch(
      /uq_gig_template_versions__draft/,
    );
    const analyzed = await planOf(`SELECT * FROM ${V} WHERE gig_template_id = $1 AND status = 'ACTIVE'`, [sample.tplId], SEQ_OFF, true);
    expect(analyzed).toMatch(/actual rows=1 loops=1/);
  });

  it('reads the versions of a template newest first straight from the unique (template, number) key, backwards, with no sort step', async () => {
    const plan = await planOf(
      `SELECT * FROM ${V} WHERE gig_template_id = $1 ORDER BY version_number DESC`,
      [sample.tplId],
      [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off'],
    );
    expect(plan).toMatch(/Index Scan Backward using uq_gig_template_versions__number on/);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
  });

  it('reads the fields of a version in display order straight from the unique (version, order) key, with no sort step, naturally (3600 rows) and with the sequential scan off; and one field by its key through the other unique key', async () => {
    const text = `SELECT * FROM ${F} WHERE gig_template_version_id = $1 ORDER BY display_order`;
    // the planner's own choice for ten rows of 3600: a bitmap scan of one of the two keys and a sort of the ten, never a scan of the table
    const natural = await planOf(text, [sample.activeVersion], []);
    expect(natural).not.toMatch(/Seq Scan/);
    expect(usedIndexes(natural).every((i) => ['uq_gig_template_fields__order', 'uq_gig_template_fields__key'].includes(i))).toBe(true);
    const forced = await planOf(text, [sample.activeVersion], [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off']);
    expect(forced).toMatch(/Index Scan using uq_gig_template_fields__order on/);
    expect(forced).not.toMatch(/Sort|Seq Scan/);
    const many = await planOf(
      `SELECT * FROM ${F} WHERE gig_template_version_id = ANY($1::uuid[]) ORDER BY gig_template_version_id, display_order`,
      [[sample.activeVersion, sample.draftVersion]],
      SEQ_OFF,
    );
    expect(usedIndexes(many)).toEqual(['uq_gig_template_fields__order']);
    expect(await planOf(`SELECT * FROM ${F} WHERE gig_template_version_id = $1 AND field_key = $2`, [sample.activeVersion, 'f3'], SEQ_OFF)).toMatch(
      /Index Scan using uq_gig_template_fields__key on/,
    );
  });

  it('reads the options of a field in order from the unique (field, order) key, the requirements of a version from the leading column of the requirement key, and counts the fields of a version without a scan of the table', async () => {
    const options = await planOf(
      `SELECT * FROM ${O} WHERE gig_template_field_id = $1 ORDER BY display_order`,
      [sample.enumField],
      [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off'],
    );
    expect(options).toMatch(/Index Scan using uq_gig_template_field_options__order on/);
    expect(options).not.toMatch(/Sort|Seq Scan/);
    expect(usedIndexes(await planOf(`SELECT * FROM ${R} WHERE gig_template_version_id = $1`, [sample.activeVersion], SEQ_OFF))).toEqual([
      'uq_gig_template_requirements__requirement',
    ]);
    const count_ = await planOf(`SELECT count(*) FROM ${F} f WHERE f.gig_template_version_id = $1`, [sample.activeVersion], SEQ_OFF);
    expect(usedIndexes(count_).length).toBeGreaterThan(0);
    expect(count_).not.toMatch(/Seq Scan/);
  });

  it('reads the templates of ONE market in order straight from the unique key (market_id, display_order), with no sort step and no sequential scan: the key IS the access path', async () => {
    const text = `SELECT display_order FROM ${M} WHERE market_id = $1 AND enabled ORDER BY display_order`;
    const plan = await planOf(text, [markets[0]!.id], [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off']);
    expect(plan).toMatch(/Index Scan using uq_market_gig_templates__market_order on/);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
    expect(await planOf(text, [markets[0]!.id], [...SEQ_OFF, 'SET LOCAL enable_bitmapscan = off'], true)).toMatch(
      /Index Scan using uq_market_gig_templates__market_order .*actual rows=\d+ loops=1/,
    );
    expect(await planOf(`SELECT enabled FROM ${M} WHERE market_id = $1 AND gig_template_id = $2`, [markets[0]!.id, sample.tplId], SEQ_OFF)).not.toMatch(
      /Seq Scan/,
    );
  });

  it('has NO index beyond the documented eighteen on the six tables, and the foreign keys without an index (the content keys, the audit subjects, market_gig_templates.gig_template_id) are the documented ones', async () => {
    const idx = await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = ANY($1) ORDER BY 1", [
      NEW_TABLE_NAMES,
    ]);
    expect(idx).toHaveLength(18);
    const unindexedFks = await q<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'catalog'::regnamespace AND c.conrelid::regclass::text = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey) ORDER BY 1`,
      [[...NEW_TABLES, AUDIT]],
    );
    expect(unindexedFks.map((r) => r.conname).sort()).toEqual(
      [
        'fk_audit_events__gig_template_id',
        'fk_audit_events__gig_template_version',
        'fk_gig_template_fields__default_content_key',
        'fk_gig_template_fields__help_content_key',
        'fk_gig_template_fields__label_content_key',
        'fk_gig_template_field_options__label_content_key',
        'fk_gig_templates__description_content_key',
        'fk_gig_templates__instructions_content_key',
        'fk_gig_templates__name_content_key',
        'fk_market_gig_templates__gig_template_id',
        'fk_audit_events__category_id',
        'fk_audit_events__market_id',
        'fk_audit_events__prohibited_service_id',
        'fk_audit_events__service_type_id',
      ].sort(),
    );
  });

  it('reads the public snapshot of a market through the keys only, and the result does not depend on the plan (every combination of join methods and scan types returns the same rows)', async () => {
    const mk = markets[0]!;
    const baseline = (await q<{ code: string; display_order: number; gig_template_version_id: string }>(PUBLIC_TEMPLATES_SQL, [mk.code])).map(
      (r) => `${r.code}:${r.display_order}:${r.gig_template_version_id}`,
    );
    // no category / service type availability in this market: the public view is empty, which is also a result to hold constant
    const variants = [
      [],
      ['SET LOCAL enable_seqscan = off'],
      ['SET LOCAL enable_nestloop = off'],
      ['SET LOCAL enable_hashjoin = off'],
      ['SET LOCAL enable_mergejoin = off'],
      ['SET LOCAL enable_hashjoin = off', 'SET LOCAL enable_mergejoin = off'],
      ['SET LOCAL enable_nestloop = off', 'SET LOCAL enable_seqscan = off'],
      ['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off'],
    ];
    // make the market public for a few templates so that the result is not empty
    const c = await openTx();
    try {
      for (const stId of stIds) {
        const catId = (await q<{ category_id: string }>('SELECT category_id FROM catalog.service_types WHERE service_type_id = $1', [stId], c))[0]!.category_id;
        await c.query('INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
          mk.id,
          catId,
          nextOrder(),
        ]);
        await c.query('INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
          mk.id,
          stId,
          nextOrder(),
        ]);
      }
      const expected = (await c.query(PUBLIC_TEMPLATES_SQL, [mk.code])).rows.map(
        (r: { code: string; display_order: number; gig_template_version_id: string }) => `${r.code}:${r.display_order}:${r.gig_template_version_id}`,
      );
      expect(expected.length, 'the 30 enabled rows of the market, minus the 6 INACTIVE templates among them').toBe(24);
      expect(expected).toEqual([...expected].sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1])));
      for (const settings of variants) {
        await c.query('SAVEPOINT s');
        for (const s of settings) await c.query(s);
        expect(
          (await c.query(PUBLIC_TEMPLATES_SQL, [mk.code])).rows.map(
            (r: { code: string; display_order: number; gig_template_version_id: string }) => `${r.code}:${r.display_order}:${r.gig_template_version_id}`,
          ),
          settings.join(),
        ).toEqual(expected);
        await c.query('ROLLBACK TO s');
      }
      const plan = (await c.query(`EXPLAIN (COSTS OFF) ${PUBLIC_TEMPLATES_SQL}`, [mk.code])).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).not.toMatch(/Seq Scan on catalog\.gig_template_fields/);
      expect(usedIndexes(plan).filter((i) => /^(idx|uq|pk)_/.test(i) === false)).toEqual([]);
    } finally {
      await finish(c, 'ROLLBACK');
    }
    expect(baseline).toEqual([]);
  });
});

// ====================================================================== J. privacy and scope shape
describe('J. the Gig Templates cannot hold, and do not hold, anything about a person, a price, a chosen duration, a radius, an area, a photo or a capacity', () => {
  // whole words of a column name (split on underscores): a column named after any of them could hold something this checkpoint must not store
  const FORBIDDEN_WORDS = new Set(
    'price fee cost amount rate currency tax duration minutes hours radius distance capacity quantity seats slots stock lat lng lon geo point first last person user member owner customer provider account email phone address street city postal zip token secret password credential subject session cookie device ip birth ssn hash note comment payload body text label title'.split(
      ' ',
    ),
  );
  const forbidden = (column: string): boolean => column.split('_').some((w) => FORBIDDEN_WORDS.has(w));
  const NEW_COLUMNS = () =>
    sq<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name = ANY($1) ORDER BY 1, ordinal_position",
      [NEW_TABLE_NAMES],
    );

  it('has 62 columns in the six tables, and the only names that contain a forbidden word are the documented platform bounds and flags (never a provider value): three duration bounds, two area-mode flags, the visibility flag and the two content-key columns called label', async () => {
    const rows = await NEW_COLUMNS();
    expect(rows).toHaveLength(Object.values(GT_COLUMNS).reduce((a, c) => a + c.length, 0));
    expect(rows).toHaveLength(62);
    const flagged = rows.filter((r) => forbidden(r.column_name)).map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`);
    expect(flagged.sort()).toEqual(
      [
        'gig_template_versions.min_duration_minutes:integer',
        'gig_template_versions.max_duration_minutes:integer',
        'gig_template_versions.suggested_duration_minutes:integer',
        'gig_template_versions.area_radius:boolean',
        'gig_template_versions.area_postal_codes:boolean',
        'gig_template_fields.customer_visible:boolean',
        'gig_template_fields.label_content_key:text',
        'gig_template_field_options.label_content_key:text',
      ].sort(),
    );
  });

  it('applies its own forbidden-word filter by whole words (a check that is not vacuous: unit_price, capacity_max, chosen_duration and actual_radius would be caught; correlation_id, display_order and area_polygon would not)', () => {
    expect(
      ['unit_price', 'capacity_max', 'service_radius', 'email', 'first_name', 'chosen_duration', 'actual_radius', 'owner_account_id'].filter(forbidden),
    ).toHaveLength(8);
    expect(
      [
        'correlation_id',
        'name_content_key',
        'display_order',
        'prohibited_service_id',
        'changes',
        'reason',
        'area_polygon',
        'pricing_fixed',
        'min_items',
      ].filter(forbidden),
    ).toEqual([]);
  });

  it('uses only scalar types (uuid, text, integer, numeric, boolean, timestamptz): no jsonb document, array, bytea, float or inet; numeric appears on exactly the three bound columns of the fields; every money, price or area VALUE is absent', async () => {
    const rows = await NEW_COLUMNS();
    expect([...new Set(rows.map((r) => r.data_type))].sort()).toEqual(['boolean', 'integer', 'numeric', 'text', 'timestamp with time zone', 'uuid']);
    expect(rows.filter((r) => r.data_type === 'numeric').map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'gig_template_fields.min_number',
      'gig_template_fields.max_number',
      'gig_template_fields.default_number',
    ]);
    // the platform flags of the allowed pricing and area models are booleans, nothing else carries those words
    const provider = rows.filter((r) => /price|pricing|radius|postal|polygon|area|variant|bundle|drop|photo|pitch|capacity|booking|floor/.test(r.column_name));
    expect(provider.map((r) => `${r.column_name}:${r.data_type}`).sort()).toEqual(
      [
        'area_polygon:boolean',
        'area_postal_codes:boolean',
        'area_radius:boolean',
        'pricing_bundle_eligible:boolean',
        'pricing_drop_eligible:boolean',
        'pricing_fixed:boolean',
        'pricing_fixed_with_variants:boolean',
      ].sort(),
    );
  });

  it('constrains every text column of the new tables: a CHECK, a foreign key or the generation expression names it, so no column can hold free text', async () => {
    const rows = (await NEW_COLUMNS()).filter((r) => r.data_type === 'text');
    expect(rows.length).toBeGreaterThan(15);
    const unconstrained: string[] = [];
    for (const r of rows) {
      const hit = await sq<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_constraint c WHERE c.conrelid = ('catalog.' || $1)::regclass AND c.contype IN ('c', 'f') AND pg_get_constraintdef(c.oid) ~ ('\\m' || $2 || '\\M')`,
        [r.table_name, r.column_name],
      );
      if (hit[0]!.n === 0) unconstrained.push(`${r.table_name}.${r.column_name}`);
    }
    expect(unconstrained).toEqual([]);
  });

  it('keeps the audit trail of the Gig Templates free of text and personal data: the new subject columns are uuids, and the seeded diffs hold only {status: [null, DRAFT]}', async () => {
    const cols = await sq<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name = 'audit_events' AND column_name LIKE 'gig\\_template%'",
    );
    expect(cols).toEqual([
      { column_name: 'gig_template_id', data_type: 'uuid' },
      { column_name: 'gig_template_version_id', data_type: 'uuid' },
    ]);
    for (const r of await sq<{ changes: Record<string, unknown> }>(`SELECT changes FROM ${AUDIT} WHERE action LIKE 'GIG\\_TEMPLATE\\_%'`))
      expect(r.changes).toEqual({ status: [null, 'DRAFT'] });
  });

  it('writes nothing outside its own tables: the ten functions insert, delete and notify nothing, never touch the outbox or the audit trail, update only the version rows (the supersession and the retirement close), and read content only in content_is_published', async () => {
    const src = await sq<{ proname: string; prosrc: string }>(
      "SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'catalog'::regnamespace AND proname = ANY($1)",
      [NEW_FUNCTIONS.map((f) => f.proname)],
    );
    expect(src).toHaveLength(10);
    const updates: string[] = [];
    for (const f of src) {
      expect(f.prosrc, f.proname).not.toMatch(/INSERT\s+INTO|DELETE\s+FROM|pg_notify|NOTIFY|outbox|audit_events|TRUNCATE\s+[a-z]/i);
      expect(f.prosrc, f.proname).not.toMatch(/\bgeography\.|\bidentity\.|\bintegration\.|\bconfiguration\./);
      for (const m of f.prosrc.matchAll(/\bUPDATE\s+([\w.]+)/gi)) updates.push(`${f.proname}:${m[1]}`);
      if (f.proname !== 'content_is_published' && f.proname !== 'assert_version_publishable') expect(f.prosrc, f.proname).not.toMatch(/\bcontent\./);
    }
    expect(updates.sort()).toEqual(['guard_gig_template_versions:catalog.gig_template_versions', 'guard_gig_templates:catalog.gig_template_versions']);
    const publishable = src.find((f) => f.proname === 'assert_version_publishable')!.prosrc;
    expect(publishable).not.toMatch(/\bcontent\.(entries|versions|locales)\b/); // through content_is_published only
    const content = src.find((f) => f.proname === 'content_is_published')!.prosrc;
    expect([...content.matchAll(/\bcontent\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['entries', 'locales', 'versions']);
  });

  it("leaves the audit trail and the outbox exactly as they were when the tables are changed by raw SQL, publication included (the audit rows and events are the service's job, in its own transaction)", async () => {
    const snap = async () => ({
      audit: await count(AUDIT),
      outbox: await count('integration.outbox_events'),
      content: await count('content.audit_events'),
      geo: await count('geography.audit_events'),
    });
    const before = await snap();
    const { t } = await makeLiveTemplate();
    await makePublished(t);
    const m = await makeMarket();
    await addMarketRow(m.id, t.id, { enabled: true });
    await setTpl(t.id, 'INACTIVE');
    await setTpl(t.id, 'ACTIVE');
    await setTpl(t.id, 'RETIRED');
    const after = await snap();
    // makeTpl and the helpers create content entries (and the content lifecycle writes its OWN audit rows through the content guard, not through these tables)
    expect({ audit: after.audit, outbox: after.outbox, geo: after.geo }).toEqual({ audit: before.audit, outbox: before.outbox, geo: before.geo });
  });
});

// ====================================================================== K. mutation checks on a scratch database
// The guards are only worth what the tests that would notice their removal are worth. In ONE scratch database each guard is broken in turn (a share lock taken out, a trigger dropped, a
// constraint or an index dropped, a function body weakened), the behaviour the matching test above asserts is observed to be GONE, and the object is restored from its captured
// definition. At the end the scratch schema is compared with the pristine one, so a mutation that was not undone fails the test.
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
  const fnDef = async (name: string) =>
    (
      (await sp.query("SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace AND p.proname = $1", [name]))
        .rows[0] as { d: string }
    ).d;
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
  async function dropConstraint(name: string, table: string, during: () => Promise<void>, replacement?: string): Promise<void> {
    const def = await conDef(name);
    await sp.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
    if (replacement) await sp.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${replacement}`);
    try {
      await during();
    } finally {
      if (replacement) await sp.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
      await sp.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${def}`);
    }
  }
  async function dropIndex(name: string, during: () => Promise<void>): Promise<void> {
    const def = ((await sp.query("SELECT indexdef AS d FROM pg_indexes WHERE schemaname = 'catalog' AND indexname = $1", [name])).rows[0] as { d: string }).d;
    await sp.query(`DROP INDEX catalog.${name}`);
    try {
      await during();
    } finally {
      await sp.query(def);
    }
  }

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

  // ---- the probes: each returns what the matching tests above assert (every statement of a probe runs in a transaction that is rolled back)
  const live = (c: pg.PoolClient) => makeTpl({ status: 'ACTIVE' }, c);
  const draftOf = async (c: pg.PoolClient) => {
    const t = await live(c);
    return { t, v: await makeDraftWithField(t, {}, c) };
  };
  const probes = {
    templateStartsDraft: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const st = await makeSt('ACTIVE', c);
        const code = `mut_${++seq}`;
        await ensureContent(gigTemplateNameKey(code), {}, c);
        return outcomeOf(c.query("INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, 'ACTIVE')", [st.id, code]));
      }),
    templateUnderRetiredServiceType: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const st = await makeSt('RETIRED', c);
        const code = `mut_${++seq}`;
        await ensureContent(gigTemplateNameKey(code), {}, c);
        return outcomeOf(c.query('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [st.id, code]));
      }),
    templateServiceTypeMove: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await makeTpl({}, c);
        const other = await makeSt('ACTIVE', c);
        return outcomeOf(c.query('UPDATE catalog.gig_templates SET service_type_id = $2 WHERE gig_template_id = $1', [t.id, other.id]));
      }),
    templateReactivation: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await makeTpl({ status: 'RETIRED' }, c);
        return outcomeOf(setTpl(t.id, 'ACTIVE', c));
      }),
    templateDelete: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await makeTpl({}, c);
        return outcomeOf(c.query('DELETE FROM catalog.gig_templates WHERE gig_template_id = $1', [t.id]));
      }),
    templateNotActiveUnderServiceType: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await makeTpl({ st: await makeSt('DRAFT', c) }, c);
        return outcomeOf(setTpl(t.id, 'ACTIVE', c));
      }),
    retireWithOpenDraft: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        await makeVersion(t, {}, c);
        return outcomeOf(setTpl(t.id, 'RETIRED', c));
      }),
    retireClosesActiveVersion: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        await makePublished(t, c);
        await setTpl(t.id, 'RETIRED', c);
        return `${(await violations(c))['activeVersionUnderRetiredTemplate']!.length} ACTIVE under RETIRED`;
      }),
    versionStartsDraft: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        return outcomeOf(c.query('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, revision) VALUES ($1, 1, 2)', [t.id]));
      }),
    versionForRetiredTemplate: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await makeTpl({ status: 'RETIRED' }, c);
        return outcomeOf(c.query('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 1)', [t.id]));
      }),
    versionNumberGap: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        return outcomeOf(c.query('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 5)', [t.id]));
      }),
    versionIdentity: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makeVersion(t, {}, c);
        return outcomeOf(c.query('UPDATE catalog.gig_template_versions SET version_number = 9 WHERE gig_template_version_id = $1', [v.id]));
      }),
    versionDelete: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makeVersion(t, {}, c);
        return outcomeOf(c.query('DELETE FROM catalog.gig_template_versions WHERE gig_template_version_id = $1', [v.id]));
      }),
    frozenColumn: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makePublished(t, c);
        return outcomeOf(c.query('UPDATE catalog.gig_template_versions SET min_duration_minutes = 10 WHERE gig_template_version_id = $1', [v.id]));
      }),
    frozenClosedAt: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makeVersionIn(t, 'RETIRED', c);
        return outcomeOf(
          c.query("UPDATE catalog.gig_template_versions SET closed_at = closed_at + interval '1 day' WHERE gig_template_version_id = $1", [v.id]),
        );
      }),
    revisionShrink: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makeVersion(t, {}, c);
        await c.query('UPDATE catalog.gig_template_versions SET revision = 5 WHERE gig_template_version_id = $1', [v.id]);
        return outcomeOf(c.query('UPDATE catalog.gig_template_versions SET revision = 4 WHERE gig_template_version_id = $1', [v.id]));
      }),
    publishWithChange: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const { v } = await draftOf(c);
        return outcomeOf(
          c.query("UPDATE catalog.gig_template_versions SET status = 'ACTIVE', revision = revision + 1 WHERE gig_template_version_id = $1", [v.id]),
        );
      }),
    reviveRetiredVersion: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makeVersionIn(t, 'RETIRED', c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    activeToDraft: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makePublished(t, c);
        return outcomeOf(setVer(v.id, 'DRAFT', c));
      }),
    directSupersede: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makePublished(t, c);
        return outcomeOf(setVer(v.id, 'SUPERSEDED', c));
      }),
    supersession: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        await makePublished(t, c);
        const d = await makeDraftWithField(t, {}, c);
        return outcomeOf(setVer(d.id, 'ACTIVE', c));
      }),
    publishedAtStamp: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const { v } = await draftOf(c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    publishUnderPausedTemplate: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await makeTpl({}, c);
        const v = await makeDraftWithField(t, {}, c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    publishUnderPausedServiceType: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const { t, v } = await draftOf(c);
        await setSt(t.stId, 'INACTIVE', c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    publishNoFields: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    publishEnumNoOptions: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        await addField(v, { type: 'ENUM' }, c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    publishFixedEnumNoDefault: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        const f = await addField(v, { type: 'ENUM', behavior: 'PLATFORM_FIXED' }, c);
        await addOption(f, 'wax', {}, c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    publishUnpublishedCopy: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        await addField(v, { content: 'NONE' }, c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    fieldInPublishedVersion: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const v = await makePublished(t, c);
        return outcomeOf(addField(v, {}, c));
      }),
    fieldIdentity: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        const a = await makeVersion(t, {}, c);
        const f = await addField(a, {}, c);
        await setVer(a.id, 'RETIRED', c);
        const b = await makeVersion(t, {}, c);
        return outcomeOf(
          c.query('UPDATE catalog.gig_template_fields SET gig_template_version_id = $2 WHERE gig_template_field_id = $1', [f.id, b.id]).then(() => undefined),
        );
      }),
    fieldLabelMismatch: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        await ensureContent('catalog.gig_template.other.field.zz.label', {}, c);
        return outcomeOf(addField(v, { key: 'zz', labelKey: 'catalog.gig_template.other.field.zz.label' }, c));
      }),
    fieldHelpMismatch: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        await ensureContent('catalog.gig_template.other.field.zz.help', {}, c);
        return outcomeOf(addField(v, { key: 'zz', helpKey: 'catalog.gig_template.other.field.zz.help' }, c));
      }),
    fieldDefaultMismatch: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        await ensureContent('catalog.gig_template.other.field.zz.default', {}, c);
        return outcomeOf(addField(v, { key: 'zz', defaultKey: 'catalog.gig_template.other.field.zz.default' }, c));
      }),
    optionOnText: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        const f = await addField(v, {}, c);
        return outcomeOf(addOption(f, 'wax', {}, c));
      }),
    optionLabelMismatch: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        const f = await addField(v, { type: 'ENUM' }, c);
        await ensureContent('catalog.gig_template.other.field.zz.option.wax.label', {}, c);
        return outcomeOf(addOption(f, 'wax', { labelKey: 'catalog.gig_template.other.field.zz.option.wax.label' }, c));
      }),
    optionInPublishedVersion: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        const f = await addField(v, { type: 'ENUM' }, c);
        await addOption(f, 'wax', {}, c);
        await setVer(v.id, 'ACTIVE', c);
        return outcomeOf(addOption(f, 'sealant', {}, c));
      }),
    requirementInPublishedVersion: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makePublished(await live(c), c);
        return outcomeOf(addReq(v.id, 'SKILL', null, c));
      }),
    marketEnableRetired: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const [m, t] = [await makeMarket(p), await makeTpl({ status: 'RETIRED' }, c)];
        return outcomeOf(addMarketRow(m.id, t.id, { enabled: true }, c));
      }),
    marketDelete: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const [m, t] = [await makeMarket(p), await makeTpl({}, c)];
        await addMarketRow(m.id, t.id, {}, c);
        return outcomeOf(c.query('DELETE FROM catalog.market_gig_templates WHERE gig_template_id = $1', [t.id]));
      }),
    truncate: (table: string) => (p: pg.Pool) => rolledBack(p, (c) => outcomeOf(c.query(`TRUNCATE ${table}`))),
    twoDrafts: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        await makeVersion(t, {}, c);
        return outcomeOf(c.query('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 2)', [t.id]));
      }),
    twoActives: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const { t } = await (async () => ({ t: await live(c) }))();
        await makePublished(t, c);
        await c.query('ALTER TABLE catalog.gig_template_versions DISABLE TRIGGER USER');
        return outcomeOf(
          c.query("INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, published_at) VALUES ($1, 2, 'ACTIVE', now())", [t.id]),
        );
      }),
    twoDefaults: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        const f = await addField(v, { type: 'ENUM' }, c);
        await addOption(f, 'wax', { isDefault: true }, c);
        return outcomeOf(addOption(f, 'sealant', { isDefault: true }, c));
      }),
    twoNullRequirements: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        await addReq(v.id, 'SKILL', null, c);
        return outcomeOf(addReq(v.id, 'SKILL', null, c));
      }),
    lifecycleCheck: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        await c.query('ALTER TABLE catalog.gig_template_versions DISABLE TRIGGER USER');
        return outcomeOf(
          c.query("INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, published_at) VALUES ($1, 1, 'DRAFT', now())", [t.id]),
        );
      }),
    fixedWithoutDefault: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { type: 'TEXT', behavior: 'PLATFORM_FIXED' }, c));
      }),
    fixedMoney: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { type: 'MONEY', behavior: 'PLATFORM_FIXED' }, c));
      }),
    requiredMediaWithoutMinimum: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { type: 'MEDIA', behavior: 'PROVIDER_REQUIRED' }, c));
      }),
    foreignMetadata: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { type: 'BOOLEAN', minLength: 3 }, c));
      }),
    integerFraction: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { type: 'INTEGER', defaultNumber: '1.5' }, c));
      }),
    durationZero: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { type: 'DURATION', defaultNumber: 0 }, c));
      }),
    referenceZero: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { type: 'SKILL_REFERENCE', maxItems: 0 }, c));
      }),
    durationBounds: (p: pg.Pool) =>
      rolledBack(p, async (c) => outcomeOf(makeVersion(await live(c), { min_duration_minutes: 90, max_duration_minutes: 60 }, c))),
    pricingNone: (p: pg.Pool) => rolledBack(p, async (c) => outcomeOf(makeVersion(await live(c), { pricing_fixed: false }, c))),
    areaNone: (p: pg.Pool) => rolledBack(p, async (c) => outcomeOf(makeVersion(await live(c), { area_radius: false }, c))),
    auditSubject: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const t = await live(c);
        return outcomeOf(
          c.query(
            "INSERT INTO catalog.audit_events (actor, action, gig_template_id, service_type_id, reason, correlation_id) VALUES ('a', 'GIG_TEMPLATE_CREATED', $1, $2, 'r', 'c')",
            [t.id, t.stId],
          ),
        );
      }),
    auditAction: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const cat = await makeCategory('ACTIVE', c);
        return outcomeOf(
          c.query("INSERT INTO catalog.audit_events (actor, action, category_id, reason, correlation_id) VALUES ('a', 'CATEGORY_DELETED', $1, 'r', 'c')", [
            cat.id,
          ]),
        );
      }),
    nameWithoutEntry: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const st = await makeSt('ACTIVE', c);
        return outcomeOf(c.query('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [st.id, `noentry_${++seq}`]));
      }),
    labelWithoutEntry: (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        return outcomeOf(addField(v, { content: 'MISSING' }, c));
      }),
    unpublishedKey: (kind: CopyKind) => (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const { v } = await copyFixture(kind, { state: 'NONE' }, c);
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
    contentState: (bad: ContentOpts) => (p: pg.Pool) =>
      rolledBack(p, async (c) => {
        const v = await makeVersion(await live(c), {}, c);
        const key = `fld_${++fieldSeq}`;
        contentOverrides.set(gigTemplateFieldLabelKey(v.code, key), bad);
        try {
          await addField(v, { key }, c);
        } finally {
          contentOverrides.delete(gigTemplateFieldLabelKey(v.code, key));
        }
        return outcomeOf(setVer(v.id, 'ACTIVE', c));
      }),
  };

  const RULE = (k: string) => k;
  it('MUTATION: dropping trg_gig_templates__guard lets a template be created ACTIVE, moved to another service type, reactivated from RETIRED and deleted (caught by D2)', async () => {
    for (const [probe, good] of [
      [probes.templateStartsDraft, 'MUST_START_AS_DRAFT'],
      [probes.templateUnderRetiredServiceType, 'SERVICE_TYPE_RETIRED'],
      [probes.templateServiceTypeMove, 'IMMUTABLE_IDENTITY'],
      [probes.templateReactivation, 'STATUS_TRANSITION'],
      [probes.templateDelete, 'NOT_DELETABLE'],
      [probes.templateNotActiveUnderServiceType, 'SERVICE_TYPE_NOT_ACTIVE'],
      [probes.retireWithOpenDraft, 'GIG_TEMPLATE_HAS_OPEN_DRAFT'],
    ] as const)
      await expectMutation(`trg_gig_templates__guard / ${good}`, probe, RULE(good), 'ACCEPTED', (during) => dropTrigger('trg_gig_templates__guard', T, during));
  });

  it('MUTATION: dropping trg_gig_template_versions__guard lets a version start as anything, skip a number, change identity, be deleted, shrink its revision and be published without checks (caught by D3; the frozen / revived / superseded probes need the guard to build their state and are carried by the function mutants below)', async () => {
    for (const [probe, good, bad] of [
      [probes.versionStartsDraft, 'MUST_START_AS_DRAFT', 'ACCEPTED'],
      [probes.versionForRetiredTemplate, 'GIG_TEMPLATE_RETIRED', 'ACCEPTED'],
      [probes.versionNumberGap, 'VERSION_NUMBER_SEQUENCE', 'ACCEPTED'],
      [probes.versionIdentity, 'IMMUTABLE_IDENTITY', 'ACCEPTED'],
      [probes.versionDelete, 'NOT_DELETABLE', 'ACCEPTED'],
      [probes.revisionShrink, 'VERSION_FROZEN', 'ACCEPTED'],
      [probes.publishUnderPausedTemplate, 'GIG_TEMPLATE_NOT_ACTIVE', 'ck_gig_template_versions__lifecycle'],
      [probes.publishNoFields, 'GIG_TEMPLATE_HAS_NO_FIELDS', 'ck_gig_template_versions__lifecycle'],
    ] as const)
      await expectMutation(`trg_gig_template_versions__guard / ${good}`, probe, RULE(good), bad, (during) =>
        dropTrigger('trg_gig_template_versions__guard', V, during),
      );
  });

  it('MUTATION: dropping the guards of the children lets a published version change, an option sit on a text field, a label point elsewhere and a requirement be added late (caught by D4)', async () => {
    await expectMutation('fields guard / VERSION_NOT_DRAFT', probes.fieldInPublishedVersion, 'VERSION_NOT_DRAFT', 'ACCEPTED', (d) =>
      dropTrigger('trg_gig_template_fields__guard', F, d),
    );
    await expectMutation('fields guard / IMMUTABLE_IDENTITY', probes.fieldIdentity, 'IMMUTABLE_IDENTITY', 'ACCEPTED', (d) =>
      dropTrigger('trg_gig_template_fields__guard', F, d),
    );
    await expectMutation('fields guard / CONTENT_KEY_MISMATCH', probes.fieldLabelMismatch, 'CONTENT_KEY_MISMATCH', 'ACCEPTED', (d) =>
      dropTrigger('trg_gig_template_fields__guard', F, d),
    );
    await expectMutation('options guard / OPTIONS_ONLY_FOR_ENUM', probes.optionOnText, 'OPTIONS_ONLY_FOR_ENUM', 'ACCEPTED', (d) =>
      dropTrigger('trg_gig_template_field_options__guard', O, d),
    );
    await expectMutation('options guard / CONTENT_KEY_MISMATCH', probes.optionLabelMismatch, 'CONTENT_KEY_MISMATCH', 'ACCEPTED', (d) =>
      dropTrigger('trg_gig_template_field_options__guard', O, d),
    );
    await expectMutation('options guard / VERSION_NOT_DRAFT', probes.optionInPublishedVersion, 'VERSION_NOT_DRAFT', 'ACCEPTED', (d) =>
      dropTrigger('trg_gig_template_field_options__guard', O, d),
    );
    await expectMutation('requirements guard / VERSION_NOT_DRAFT', probes.requirementInPublishedVersion, 'VERSION_NOT_DRAFT', 'ACCEPTED', (d) =>
      dropTrigger('trg_gig_template_requirements__guard', R, d),
    );
    await expectMutation('market guard / ITEM_RETIRED', probes.marketEnableRetired, 'ITEM_RETIRED', 'ACCEPTED', (d) =>
      dropTrigger('trg_market_gig_templates__guard', M, d),
    );
    await expectMutation('market guard / NOT_DELETABLE', probes.marketDelete, 'NOT_DELETABLE', 'ACCEPTED', (d) =>
      dropTrigger('trg_market_gig_templates__guard', M, d),
    );
  });

  it('MUTATION: dropping a no_truncate trigger lets that table be emptied (caught by F), for the tables nothing references (a referenced table is protected by PostgreSQL itself)', async () => {
    for (const [table, trigger] of [
      [O, 'trg_gig_template_field_options__no_truncate'],
      [R, 'trg_gig_template_requirements__no_truncate'],
      [M, 'trg_market_gig_templates__no_truncate'],
    ] as const)
      await expectMutation(trigger, probes.truncate(table), 'ROW_IMMUTABLE', 'ACCEPTED', (d) => dropTrigger(trigger, table, d));
    // the referenced tables: the CASCADE form reaches the trigger of the table itself
    for (const [table, trigger] of [
      [T, 'trg_gig_templates__no_truncate'],
      [V, 'trg_gig_template_versions__no_truncate'],
      [F, 'trg_gig_template_fields__no_truncate'],
    ] as const) {
      const probe = (p: pg.Pool) =>
        rolledBack(p, (c) => outcomeOf(c.query(`TRUNCATE ${NEW_TABLES.filter((x) => x !== table).join(', ')}, ${table}`).then(() => c.query('SELECT 1'))));
      void probe;
      const cascade = (p: pg.Pool) => rolledBack(p, (c) => outcomeOf(c.query(`TRUNCATE ${table} CASCADE`)));
      const real = await cascade(pool);
      expect(real, trigger).toBe('ROW_IMMUTABLE');
      // with the trigger of THIS table gone the cascade is still stopped by the triggers of the tables it reaches: the mutation is visible only on the unreferenced leaf, so the test above carries it
      await dropTrigger(trigger, table, async () => {
        expect(await cascade(sp), `${trigger} is covered by the triggers of the tables the cascade reaches`).toBe('ROW_IMMUTABLE');
      });
    }
  });

  it('MUTATION: dropping a CHECK, a unique key or an index lets the rule it holds be broken (caught by C4, C5, C6, C7 and C9)', async () => {
    const cases: [string, (p: pg.Pool) => Promise<string>, string, string, string, string?][] = [
      ['uq_gig_template_versions__draft', probes.twoDrafts, 'uq_gig_template_versions__draft', 'ACCEPTED', 'index'],
      ['uq_gig_template_versions__active', probes.twoActives, 'uq_gig_template_versions__active', 'ACCEPTED', 'index'],
      ['uq_gig_template_field_options__default', probes.twoDefaults, 'uq_gig_template_field_options__default', 'ACCEPTED', 'index'],
      ['ck_gig_template_versions__lifecycle', probes.lifecycleCheck, 'ck_gig_template_versions__lifecycle', 'ACCEPTED', V],
      ['ck_gig_template_versions__duration', probes.durationBounds, 'ck_gig_template_versions__duration', 'ACCEPTED', V],
      ['ck_gig_template_versions__pricing', probes.pricingNone, 'ck_gig_template_versions__pricing', 'ACCEPTED', V],
      ['ck_gig_template_versions__area', probes.areaNone, 'ck_gig_template_versions__area', 'ACCEPTED', V],
      ['ck_gig_template_fields__fixed', probes.fixedWithoutDefault, 'ck_gig_template_fields__fixed', 'ACCEPTED', F],
      ['ck_gig_template_fields__fixed', probes.fixedMoney, 'ck_gig_template_fields__fixed', 'ACCEPTED', F],
      ['ck_gig_template_fields__media_required', probes.requiredMediaWithoutMinimum, 'ck_gig_template_fields__media_required', 'ACCEPTED', F],
      ['ck_gig_template_fields__items_meta', probes.foreignMetadata, 'ck_gig_template_fields__text_meta', 'ACCEPTED', F, 'ck_gig_template_fields__text_meta'],
      ['ck_gig_template_fields__number_shape', probes.integerFraction, 'ck_gig_template_fields__number_shape', 'ACCEPTED', F],
      ['ck_gig_template_fields__duration_positive', probes.durationZero, 'ck_gig_template_fields__duration_positive', 'ACCEPTED', F],
      ['ck_gig_template_fields__items', probes.referenceZero, 'ck_gig_template_fields__items', 'ACCEPTED', F],
      ['ck_audit_events__subject', probes.auditSubject, 'ck_audit_events__subject', 'ACCEPTED', AUDIT],
      ['ck_audit_events__action', probes.auditAction, 'ck_audit_events__action', 'ACCEPTED', AUDIT],
      ['fk_gig_templates__name_content_key', probes.nameWithoutEntry, 'fk_gig_templates__name_content_key', 'ACCEPTED', T],
      ['fk_gig_template_fields__label_content_key', probes.labelWithoutEntry, 'fk_gig_template_fields__label_content_key', 'ACCEPTED', F],
    ];
    for (const [name, probe, good, bad, where, other] of cases) {
      const target = other ?? name;
      if (where === 'index') await expectMutation(name, probe, good, bad, (d) => dropIndex(name, d));
      else await expectMutation(target, probe, good, bad, (d) => dropConstraint(target, where, d));
    }
  });

  it('MUTATION: making the requirement key distinguish NULLs lets the same requirement type be listed twice (caught by C7)', async () => {
    await expectMutation(
      'uq_gig_template_requirements__requirement',
      probes.twoNullRequirements,
      'uq_gig_template_requirements__requirement',
      'ACCEPTED',
      (d) => dropConstraint('uq_gig_template_requirements__requirement', R, d, 'UNIQUE (gig_template_version_id, requirement_type, reference_code)'),
    );
  });

  // ---- function bodies
  const fnMutant = (title: string, fn: string, mutate: (d: string) => string, probe: (p: pg.Pool) => Promise<string>, good: string, bad = 'ACCEPTED') =>
    it(`MUTATION: ${title} (caught by the test of ${good})`, async () => {
      await expectMutation(`${fn} / ${good}`, probe, good, bad, (d) => mutateFunction(fn, mutate, d));
    });
  const off =
    (needle: string, replacement = 'IF false THEN', nth = 1) =>
    (d: string) =>
      without(d, needle, replacement, nth);

  fnMutant(
    'letting RETIRED go back to ACTIVE in the version machine',
    'assert_version_transition',
    off("OR (p_old = 'ACTIVE' AND p_new IN ('SUPERSEDED', 'RETIRED'))", "OR (p_old IN ('ACTIVE', 'RETIRED') AND p_new IN ('ACTIVE', 'SUPERSEDED', 'RETIRED'))"),
    probes.reviveRetiredVersion,
    'STATUS_TRANSITION',
  );
  fnMutant(
    'dropping the DRAFT_IS_INITIAL answer of the version machine',
    'assert_version_transition',
    off("IF p_new = 'DRAFT' THEN", 'IF false THEN'),
    probes.activeToDraft,
    'DRAFT_IS_INITIAL',
    'STATUS_TRANSITION',
  );
  fnMutant(
    'removing the identity check of the template guard',
    'guard_gig_templates',
    (d) =>
      d.replace(
        'IF (NEW.gig_template_id, NEW.service_type_id, NEW.code) IS DISTINCT FROM',
        'IF false AND (NEW.gig_template_id, NEW.service_type_id, NEW.code) IS DISTINCT FROM',
      ),
    probes.templateServiceTypeMove,
    'IMMUTABLE_IDENTITY',
  );
  fnMutant(
    'removing the open-draft check of the template retirement',
    'guard_gig_templates',
    off("IF EXISTS (SELECT 1 FROM catalog.gig_template_versions WHERE gig_template_id = OLD.gig_template_id AND status = 'DRAFT') THEN", 'IF false THEN'),
    probes.retireWithOpenDraft,
    'GIG_TEMPLATE_HAS_OPEN_DRAFT',
  );
  fnMutant(
    'removing the closing of the ACTIVE version by the template retirement',
    'guard_gig_templates',
    off("UPDATE catalog.gig_template_versions SET status = 'RETIRED' WHERE gig_template_id = OLD.gig_template_id AND status = 'ACTIVE';", 'NULL;'),
    probes.retireClosesActiveVersion,
    '0 ACTIVE under RETIRED',
    '1 ACTIVE under RETIRED',
  );
  fnMutant(
    'removing the ACTIVE service type requirement of the template activation',
    'guard_gig_templates',
    off("IF st_status IS DISTINCT FROM 'ACTIVE' THEN", 'IF false THEN'),
    probes.templateNotActiveUnderServiceType,
    'SERVICE_TYPE_NOT_ACTIVE',
  );
  fnMutant(
    'removing the RETIRED service type check of the template creation',
    'guard_gig_templates',
    off("IF st_status = 'RETIRED' THEN", 'IF false THEN'),
    probes.templateUnderRetiredServiceType,
    'SERVICE_TYPE_RETIRED',
  );
  fnMutant(
    'removing the MUST_START_AS_DRAFT check of the template creation',
    'guard_gig_templates',
    off("IF NEW.status <> 'DRAFT' THEN", 'IF false THEN'),
    probes.templateStartsDraft,
    'MUST_START_AS_DRAFT',
  );
  fnMutant(
    'removing the frozen-structure check of a published version',
    'guard_gig_template_versions',
    (d) => d.replace("IF OLD.status <> 'DRAFT' AND (", 'IF false AND ('),
    probes.frozenColumn,
    'VERSION_FROZEN',
  );
  fnMutant(
    'removing the closed_at freeze of a closed version',
    'guard_gig_template_versions',
    off("IF OLD.status <> 'DRAFT' AND NEW.closed_at IS DISTINCT FROM OLD.closed_at AND OLD.closed_at IS NOT NULL THEN", 'IF false THEN'),
    probes.frozenClosedAt,
    'VERSION_FROZEN',
  );
  fnMutant(
    'removing the draft revision monotonicity',
    'guard_gig_template_versions',
    off("IF OLD.status = 'DRAFT' AND NEW.revision < OLD.revision THEN", 'IF false THEN'),
    probes.revisionShrink,
    'VERSION_FROZEN',
  );
  fnMutant(
    'removing the "draft cannot change while it is published" check',
    'guard_gig_template_versions',
    (d) =>
      d.replace(
        /IF \(NEW\.revision, NEW\.min_duration_minutes, NEW\.max_duration_minutes, NEW\.suggested_duration_minutes, NEW\.pricing_fixed, NEW\.pricing_fixed_with_variants,/,
        'IF false AND (NEW.revision, NEW.min_duration_minutes, NEW.max_duration_minutes, NEW.suggested_duration_minutes, NEW.pricing_fixed, NEW.pricing_fixed_with_variants,',
      ),
    probes.publishWithChange,
    'VERSION_FROZEN',
  );
  fnMutant(
    'removing the number sequence check',
    'guard_gig_template_versions',
    off('IF NEW.version_number <> v_max + 1 THEN', 'IF false THEN'),
    probes.versionNumberGap,
    'VERSION_NUMBER_SEQUENCE',
  );
  fnMutant(
    'removing the RETIRED template check of the version creation',
    'guard_gig_template_versions',
    off("IF t_status = 'RETIRED' THEN", 'IF false THEN'),
    probes.versionForRetiredTemplate,
    'GIG_TEMPLATE_RETIRED',
  );
  fnMutant(
    'removing the fresh-DRAFT check of the version creation',
    'guard_gig_template_versions',
    off("IF NEW.status <> 'DRAFT' OR NEW.revision <> 1 OR NEW.published_at IS NOT NULL OR NEW.closed_at IS NOT NULL THEN", 'IF false THEN'),
    probes.versionStartsDraft,
    'MUST_START_AS_DRAFT',
  );
  fnMutant(
    'removing the identity check of the version',
    'guard_gig_template_versions',
    (d) =>
      d.replace(
        'IF (NEW.gig_template_version_id, NEW.gig_template_id, NEW.version_number) IS DISTINCT FROM',
        'IF false AND (NEW.gig_template_version_id, NEW.gig_template_id, NEW.version_number) IS DISTINCT FROM',
      ),
    probes.versionIdentity,
    'IMMUTABLE_IDENTITY',
  );
  fnMutant(
    'removing the automatic-only supersession check (pg_trigger_depth)',
    'guard_gig_template_versions',
    off("IF NEW.status = 'SUPERSEDED' AND pg_trigger_depth() < 2 THEN", 'IF false THEN'),
    probes.directSupersede,
    'SUPERSEDED_IS_AUTOMATIC',
  );
  fnMutant(
    'removing the supersession of the previous ACTIVE version',
    'guard_gig_template_versions',
    off("UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED'", 'UPDATE catalog.gig_template_versions SET status = status'),
    probes.supersession,
    'ACCEPTED',
    'uq_gig_template_versions__active',
  );
  fnMutant(
    'removing the stamp of published_at',
    'guard_gig_template_versions',
    off('NEW.published_at := now();', 'NEW.published_at := NULL;'),
    probes.publishedAtStamp,
    'ACCEPTED',
    'ck_gig_template_versions__lifecycle',
  );
  fnMutant(
    'removing the ACTIVE template requirement of the publication',
    'guard_gig_template_versions',
    off("IF t_status IS DISTINCT FROM 'ACTIVE' THEN", 'IF false THEN'),
    probes.publishUnderPausedTemplate,
    'GIG_TEMPLATE_NOT_ACTIVE',
  );
  fnMutant(
    'removing the ACTIVE service type requirement of the publication',
    'guard_gig_template_versions',
    off("IF st_status IS DISTINCT FROM 'ACTIVE' THEN", 'IF false THEN'),
    probes.publishUnderPausedServiceType,
    'SERVICE_TYPE_NOT_ACTIVE',
  );
  fnMutant(
    'removing the call of the publication checks',
    'guard_gig_template_versions',
    off('PERFORM catalog.assert_version_publishable(OLD.gig_template_version_id);', 'NULL;'),
    probes.publishNoFields,
    'GIG_TEMPLATE_HAS_NO_FIELDS',
  );
  fnMutant(
    'removing the no-fields check of the publication',
    'assert_version_publishable',
    off('IF NOT EXISTS (SELECT 1 FROM catalog.gig_template_fields WHERE gig_template_version_id = p_version_id) THEN', 'IF false THEN'),
    probes.publishNoFields,
    'GIG_TEMPLATE_HAS_NO_FIELDS',
  );
  fnMutant(
    'removing the ENUM-without-options check of the publication',
    'assert_version_publishable',
    off(
      "IF EXISTS (SELECT 1 FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id AND f.field_type = 'ENUM'",
      "IF false AND EXISTS (SELECT 1 FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id AND f.field_type = 'ENUM'",
      1,
    ),
    probes.publishEnumNoOptions,
    'ENUM_FIELD_WITHOUT_OPTIONS',
  );
  fnMutant(
    'removing the fixed-ENUM-default check of the publication',
    'assert_version_publishable',
    off(
      "IF EXISTS (SELECT 1 FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id AND f.field_type = 'ENUM'",
      "IF false AND EXISTS (SELECT 1 FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id AND f.field_type = 'ENUM'",
      2,
    ),
    probes.publishFixedEnumNoDefault,
    'FIXED_ENUM_WITHOUT_DEFAULT',
  );
  fnMutant(
    'removing the copy check of the publication',
    'assert_version_publishable',
    off('AND NOT catalog.content_is_published(k)) THEN', 'AND false) THEN'),
    probes.publishUnpublishedCopy,
    'CONTENT_NOT_PUBLISHED',
  );
  for (const [kind, needle, replacement] of [
    ['name', 't.name_content_key AS k', 'NULL::text AS k'],
    ['description', 'UNION SELECT t.description_content_key', 'UNION SELECT NULL::text'],
    ['instructions', 'UNION SELECT t.instructions_content_key', 'UNION SELECT NULL::text'],
    ['field label', 'UNION SELECT f.label_content_key', 'UNION SELECT NULL::text'],
    ['field help', 'UNION SELECT f.help_content_key', 'UNION SELECT NULL::text'],
    ['field default text', 'UNION SELECT f.default_content_key', 'UNION SELECT NULL::text'],
    ['option label', 'UNION SELECT o.label_content_key', 'UNION SELECT NULL::text'],
  ] as [CopyKind, string, string][])
    fnMutant(
      `dropping the ${kind} from the copy check of the publication`,
      'assert_version_publishable',
      off(needle, replacement),
      probes.unpublishedKey(kind),
      'CONTENT_NOT_PUBLISHED',
    );
  fnMutant(
    'removing the VERSION_NOT_DRAFT check of the fields guard',
    'guard_gig_template_fields',
    off("IF v_status IS DISTINCT FROM 'DRAFT' THEN", 'IF false THEN'),
    probes.fieldInPublishedVersion,
    'VERSION_NOT_DRAFT',
  );
  fnMutant(
    'removing the label check of the fields guard',
    'guard_gig_template_fields',
    off('IF NEW.label_content_key <> stem', 'IF false AND NEW.label_content_key <> stem'),
    probes.fieldLabelMismatch,
    'CONTENT_KEY_MISMATCH',
  );
  fnMutant(
    'removing the help check of the fields guard',
    'guard_gig_template_fields',
    off("OR COALESCE(NEW.help_content_key, stem || '.help') <> stem || '.help'", 'OR false'),
    probes.fieldHelpMismatch,
    'CONTENT_KEY_MISMATCH',
  );
  fnMutant(
    'removing the default check of the fields guard',
    'guard_gig_template_fields',
    off("OR COALESCE(NEW.default_content_key, stem || '.default') <> stem || '.default' THEN", 'OR false THEN'),
    probes.fieldDefaultMismatch,
    'CONTENT_KEY_MISMATCH',
  );
  fnMutant(
    'removing the identity check of the fields guard',
    'guard_gig_template_fields',
    (d) =>
      d.replace(
        "IF TG_OP = 'UPDATE' AND (NEW.gig_template_field_id, NEW.gig_template_version_id) IS DISTINCT FROM",
        'IF false AND (NEW.gig_template_field_id, NEW.gig_template_version_id) IS DISTINCT FROM',
      ),
    probes.fieldIdentity,
    'IMMUTABLE_IDENTITY',
  );
  fnMutant(
    'removing the ENUM-only check of the options guard',
    'guard_gig_template_field_options',
    off("IF f_type <> 'ENUM' THEN", 'IF false THEN'),
    probes.optionOnText,
    'OPTIONS_ONLY_FOR_ENUM',
  );
  fnMutant(
    'removing the label check of the options guard',
    'guard_gig_template_field_options',
    off("IF NEW.label_content_key <> 'catalog.gig_template.'", "IF false AND NEW.label_content_key <> 'catalog.gig_template.'"),
    probes.optionLabelMismatch,
    'CONTENT_KEY_MISMATCH',
  );
  fnMutant(
    'removing the VERSION_NOT_DRAFT check of the options guard',
    'guard_gig_template_field_options',
    off("IF v_status IS DISTINCT FROM 'DRAFT' THEN", 'IF false THEN'),
    probes.optionInPublishedVersion,
    'VERSION_NOT_DRAFT',
  );
  fnMutant(
    'removing the VERSION_NOT_DRAFT check of the requirements guard',
    'guard_gig_template_requirements',
    off("IF v_status IS DISTINCT FROM 'DRAFT' THEN", 'IF false THEN'),
    probes.requirementInPublishedVersion,
    'VERSION_NOT_DRAFT',
  );
  fnMutant(
    'removing the RETIRED check of the market guard',
    'guard_market_gig_templates',
    off("IF t_status = 'RETIRED' THEN", 'IF false THEN'),
    probes.marketEnableRetired,
    'ITEM_RETIRED',
  );
  fnMutant(
    'removing the NOT_DELETABLE answer of the market guard',
    'guard_market_gig_templates',
    off("IF TG_OP = 'DELETE' THEN", 'IF false THEN'),
    probes.marketDelete,
    'NOT_DELETABLE',
  );

  // ---- the content check: each condition of catalog.content_is_published is needed (the state of the copy that only that condition refuses)
  const contentMutant = (title: string, needle: string, bad: ContentOpts) =>
    fnMutant(title, 'content_is_published', (d) => without(d, needle, ''), probes.contentState(bad), 'CONTENT_NOT_PUBLISHED');
  contentMutant('removing the published-status condition of content_is_published', "AND v.status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED')", {
    state: 'DRAFT',
  });
  contentMutant('removing the active-entry condition of content_is_published', 'AND e.is_active', { active: false });
  contentMutant('removing the PLATFORM scope condition of content_is_published', "AND v.scope_type = 'PLATFORM'", { scope: 'MARKET' });
  contentMutant(
    'removing the default-locale condition of content_is_published',
    'AND v.locale = (SELECT l.locale FROM content.locales l WHERE l.is_platform_default)',
    { locale: 'es-US' },
  );
  contentMutant('removing the effective_from condition of content_is_published', 'AND v.effective_from <= now()', { state: 'FUTURE' });
  contentMutant('removing the effective_to condition of content_is_published', 'AND (v.effective_to IS NULL OR v.effective_to > now())', { state: 'EXPIRED' });

  // ---- locks: a child takes its parent FOR SHARE; without it the two statements no longer serialize
  const lockMutant = (
    title: string,
    fn: string,
    needle: string,
    replacement: string,
    nth: number,
    scenario: (main: pg.Pool, race: pg.Pool) => Promise<{ blocked: boolean; failure: PgFailure | undefined; broken?: number }>,
    expectedRule: string,
    expectBroken?: boolean,
  ) =>
    it(`MUTATION: ${title}`, async () => {
      const real = await scenario(pool, racePool);
      expect(real.blocked, 'intact: the racer waits for the holder').toBe(true);
      expect(asRule(real.failure)).toEqual(rule(expectedRule));
      await mutateFunction(
        fn,
        (d) => without(d, needle, replacement, nth),
        async () => {
          const r = await scenario(sp, srace);
          expect(r.blocked, 'MUTATED: the racer no longer waits').toBe(false);
          expect(r.failure, 'MUTATED: the racer went through against the open change').toBeUndefined();
          if (expectBroken) expect(r.broken, 'MUTATED: an invariant is broken').toBeGreaterThan(0);
        },
      );
      await noLockWaiters(sp);
      await noLockWaiters(srace);
    });
  const SHARE_TPL_IN_VERSION = 'SELECT status INTO t_status FROM catalog.gig_templates WHERE gig_template_id = NEW.gig_template_id FOR SHARE;';
  const SHARE_TPL_ST_IN_VERSION =
    'SELECT status, service_type_id INTO t_status, t_service FROM catalog.gig_templates WHERE gig_template_id = NEW.gig_template_id FOR SHARE;';
  const SHARE_ST_IN_VERSION = 'SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = t_service FOR SHARE;';
  const SHARE_ST_IN_TEMPLATE = 'SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = NEW.service_type_id FOR SHARE;';
  const SHARE_VERSION = 'SELECT status INTO v_status FROM catalog.gig_template_versions WHERE gig_template_version_id = v_id FOR SHARE;';
  const noShare = (s: string) => s.replace(' FOR SHARE;', ';');

  lockMutant(
    'with FOR SHARE removed from the template read of the version CREATION, a version is no longer held back by a template retirement (caught by H1, H4)',
    'guard_gig_template_versions',
    SHARE_TPL_IN_VERSION,
    noShare(SHARE_TPL_IN_VERSION),
    1,
    async (main, race) => {
      const t = await makeTpl({ status: 'ACTIVE' }, main);
      const r = await holdAndObserve(main, race, (tx) => exec(tx, tplStatus(t.id, 'RETIRED')), insertVersion(t.id, 1));
      return { ...r, broken: (await violations(main))['openDraftUnderRetiredTemplate']!.length };
    },
    'GIG_TEMPLATE_RETIRED',
    true,
  );
  lockMutant(
    'with FOR SHARE removed from the template read of the PUBLICATION, a publication is no longer held back by the template being paused (caught by H1)',
    'guard_gig_template_versions',
    SHARE_TPL_ST_IN_VERSION,
    noShare(SHARE_TPL_ST_IN_VERSION),
    1,
    async (main, race) => {
      const t = await makeTpl({ status: 'ACTIVE' }, main);
      const d = await makeDraftWithField(t, {}, main);
      return holdAndObserve(main, race, async (tx) => exec(tx, tplStatus(t.id, 'INACTIVE')), verStatus(d.id, 'ACTIVE'));
    },
    'GIG_TEMPLATE_NOT_ACTIVE',
  );
  lockMutant(
    'with FOR SHARE removed from the service type read of the PUBLICATION, a publication is no longer held back by a service type deactivation (caught by H1, H4)',
    'guard_gig_template_versions',
    SHARE_ST_IN_VERSION,
    noShare(SHARE_ST_IN_VERSION),
    1,
    async (main, race) => {
      const t = await makeTpl({ status: 'ACTIVE' }, main);
      const d = await makeDraftWithField(t, {}, main);
      return holdAndObserve(main, race, (tx) => exec(tx, stStatus(t.stId, 'INACTIVE')), verStatus(d.id, 'ACTIVE'));
    },
    'SERVICE_TYPE_NOT_ACTIVE',
  );
  lockMutant(
    'with FOR SHARE removed from the service type read of the template CREATION, a template is no longer held back by a service type retirement (caught by H1)',
    'guard_gig_templates',
    SHARE_ST_IN_TEMPLATE,
    noShare(SHARE_ST_IN_TEMPLATE),
    1,
    async (main, race) => {
      const st = await makeSt('ACTIVE', main);
      const code = `lm_${++seq}`;
      await ensureContent(gigTemplateNameKey(code), {}, main);
      return holdAndObserve(main, race, (tx) => exec(tx, stStatus(st.id, 'RETIRED')), {
        text: 'INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)',
        params: [st.id, code],
      });
    },
    'SERVICE_TYPE_RETIRED',
  );
  lockMutant(
    'with FOR SHARE removed from the service type read of the template ACTIVATION, an activation is no longer held back by a service type retirement (caught by H1, H4)',
    'guard_gig_templates',
    SHARE_ST_IN_TEMPLATE,
    noShare(SHARE_ST_IN_TEMPLATE),
    2,
    async (main, race) => {
      const t = await makeTpl({}, main);
      return holdAndObserve(main, race, (tx) => exec(tx, stStatus(t.stId, 'RETIRED')), tplStatus(t.id, 'ACTIVE'));
    },
    'SERVICE_TYPE_NOT_ACTIVE',
  );
  lockMutant(
    'with FOR SHARE removed from the version read of the FIELDS guard, a field insert is no longer held back by a publication and lands in a published version (caught by H2, H4)',
    'guard_gig_template_fields',
    SHARE_VERSION,
    noShare(SHARE_VERSION),
    1,
    async (main, race) => {
      const t = await makeTpl({ status: 'ACTIVE' }, main);
      const v = await makeDraftWithField(t, {}, main);
      await ensureContent(gigTemplateFieldLabelKey(v.code, 'late_field'), {}, main);
      const r = await holdAndObserve(main, race, (tx) => exec(tx, verStatus(v.id, 'ACTIVE')), {
        text: "INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key) VALUES ($1, 'late_field', 'TEXT', 'PROVIDER_CONFIGURABLE', 50, $2)",
        params: [v.id, gigTemplateFieldLabelKey(v.code, 'late_field')],
      });
      return {
        ...r,
        broken: (
          await q<{ n: number }>(
            "SELECT count(*)::int AS n FROM catalog.gig_template_fields f JOIN catalog.gig_template_versions v USING (gig_template_version_id) WHERE v.status = 'ACTIVE' AND f.gig_template_version_id = $1 AND f.field_key = 'late_field'",
            [v.id],
            main,
          )
        )[0]!.n,
      };
    },
    'VERSION_NOT_DRAFT',
    true,
  );
  lockMutant(
    'with FOR SHARE removed from the version read of the OPTIONS guard, an option insert is no longer held back by a publication (caught by H2)',
    'guard_gig_template_field_options',
    SHARE_VERSION,
    noShare(SHARE_VERSION),
    1,
    async (main, race) => {
      const t = await makeTpl({ status: 'ACTIVE' }, main);
      const v = await makeVersion(t, {}, main);
      const f = await addField(v, { type: 'ENUM' }, main);
      await addOption(f, 'wax', {}, main);
      await ensureContent(gigTemplateOptionLabelKey(v.code, f.key, 'second'), {}, main);
      return holdAndObserve(main, race, (tx) => exec(tx, verStatus(v.id, 'ACTIVE')), {
        text: "INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order) VALUES ($1, 'second', $2, 5)",
        params: [f.id, gigTemplateOptionLabelKey(v.code, f.key, 'second')],
      });
    },
    'VERSION_NOT_DRAFT',
  );
  lockMutant(
    'with FOR SHARE removed from the version read of the REQUIREMENTS guard, a requirement insert is no longer held back by a publication (caught by H2)',
    'guard_gig_template_requirements',
    SHARE_VERSION,
    noShare(SHARE_VERSION),
    1,
    async (main, race) => {
      const t = await makeTpl({ status: 'ACTIVE' }, main);
      const v = await makeDraftWithField(t, {}, main);
      return holdAndObserve(main, race, (tx) => exec(tx, verStatus(v.id, 'ACTIVE')), {
        text: "INSERT INTO catalog.gig_template_requirements (gig_template_version_id, requirement_type) VALUES ($1, 'SKILL')",
        params: [v.id],
      });
    },
    'VERSION_NOT_DRAFT',
  );
  lockMutant(
    'with FOR SHARE removed from the template read of the MARKET guard, an enabling is no longer held back by a template retirement (caught by H3)',
    'guard_market_gig_templates',
    SHARE_TPL_IN_VERSION,
    noShare(SHARE_TPL_IN_VERSION),
    1,
    async (main, race) => {
      const [m, t] = [await makeMarket(main), await makeTpl({ status: 'ACTIVE' }, main)];
      const r = await holdAndObserve(main, race, (tx) => exec(tx, tplStatus(t.id, 'RETIRED')), insertMarketRow(m.id, t.id, 1, true));
      return r;
    },
    'ITEM_RETIRED',
  );

  it('restores everything: after all mutations the catalog functions, triggers, constraints and indexes of the scratch database equal those of the pristine database, and no lock waiter is left', async () => {
    expect(await catalogFingerprint(sp)).toEqual(await catalogFingerprint(seedPool));
    expect((await catalogFingerprint(sp)).length).toBeGreaterThan(150);
    await noLockWaiters(sp);
    await noLockWaiters(srace);
  });
});

// ====================================================================== L. at the end of the file, after every test above, the invariants hold and nothing is left locked
describe('L. final state of the mutated database', () => {
  it('has none of the invariant violations after all the statements, races and refusals above, and no lock waiter', async () => {
    expect(await violations()).toEqual(NO_VIOLATIONS);
    await noLockWaiters();
    await noLockWaiters(racePool);
  });

  it('still has the seeded rows exactly as migrated (nothing in the tests touched them) and every code is unique', async () => {
    expect(await q<{ code: string; status: string }>(`SELECT code, status FROM ${T} WHERE code IN ('full_detail', 'standard_clean') ORDER BY code`)).toEqual([
      { code: 'full_detail', status: 'DRAFT' },
      { code: 'standard_clean', status: 'DRAFT' },
    ]);
    expect(await count(AUDIT, "correlation_id = 'seed-0016'")).toBe(2);
    expect(await count(V, "gig_template_id IN (SELECT gig_template_id FROM catalog.gig_templates WHERE code IN ('full_detail', 'standard_clean'))")).toBe(0);
    expect((await q<{ n: number; d: number }>(`SELECT count(*)::int AS n, count(DISTINCT code)::int AS d FROM ${T}`))[0]).toSatisfy(
      (r: { n: number; d: number }) => r.n === r.d,
    );
    expect(await count('geography.markets', "code = 'la-oc' AND status = 'PLANNED'")).toBe(1);
  });
});

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null, generated: string | null];
const columnsOf = async (table: string, from: pg.Pool = seedPool): Promise<ColumnShape[]> =>
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
const constraintsOf = async (table: string, from: pg.Pool = seedPool): Promise<ConstraintRow[]> =>
  (
    await from.query(
      `SELECT conname, contype, confdeltype, confupdtype, confmatchtype, condeferrable, convalidated, confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f', 'c', 'x') ORDER BY conname COLLATE "C"`,
      [table],
    )
  ).rows;
const indexesOf = async (table: string, from: pg.Pool = seedPool): Promise<{ indexname: string; indexdef: string }[]> =>
  (await from.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = \'catalog\' AND tablename = $1 ORDER BY indexname COLLATE "C"', [table]))
    .rows;
const triggersOf = async (table: string, from: pg.Pool = seedPool) =>
  q<{ tgname: string; def: string; enabled: string }>(
    'SELECT t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled AS enabled FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"',
    [table],
    from,
  );
const commentOn = async (table: string, column?: string): Promise<string | null> =>
  (
    (
      await seedPool.query(
        column
          ? 'SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c'
          : "SELECT obj_description($1::regclass, 'pg_class') AS c",
        column ? [table, column] : [table],
      )
    ).rows[0] as { c: string | null }
  ).c;
const vocab = (def: string): string[] => [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const GT_COLUMNS: Record<string, ColumnShape[]> = {
  gig_templates: [
    ['gig_template_id', 'uuid', false, 'gen_random_uuid()', null],
    ['service_type_id', 'uuid', false, null, null],
    ['code', 'text', false, null, null],
    ['name_content_key', 'text', false, null, "(('catalog.gig_template.'::text || code) || '.name'::text)"],
    ['description_content_key', 'text', true, null, null],
    ['instructions_content_key', 'text', true, null, null],
    ['status', 'text', false, "'DRAFT'::text", null],
    ['created_at', 'timestamp with time zone', false, 'now()', null],
    ['updated_at', 'timestamp with time zone', false, 'now()', null],
  ],
  gig_template_versions: [
    ['gig_template_version_id', 'uuid', false, 'gen_random_uuid()', null],
    ['gig_template_id', 'uuid', false, null, null],
    ['version_number', 'integer', false, null, null],
    ['status', 'text', false, "'DRAFT'::text", null],
    ['revision', 'integer', false, '1', null],
    ['min_duration_minutes', 'integer', true, null, null],
    ['max_duration_minutes', 'integer', true, null, null],
    ['suggested_duration_minutes', 'integer', true, null, null],
    ['pricing_fixed', 'boolean', false, 'true', null],
    ['pricing_fixed_with_variants', 'boolean', false, 'false', null],
    ['pricing_bundle_eligible', 'boolean', false, 'false', null],
    ['pricing_drop_eligible', 'boolean', false, 'false', null],
    ['area_radius', 'boolean', false, 'true', null],
    ['area_postal_codes', 'boolean', false, 'false', null],
    ['area_polygon', 'boolean', false, 'false', null],
    ['created_at', 'timestamp with time zone', false, 'now()', null],
    ['updated_at', 'timestamp with time zone', false, 'now()', null],
    ['published_at', 'timestamp with time zone', true, null, null],
    ['closed_at', 'timestamp with time zone', true, null, null],
  ],
  gig_template_fields: [
    ['gig_template_field_id', 'uuid', false, 'gen_random_uuid()', null],
    ['gig_template_version_id', 'uuid', false, null, null],
    ['field_key', 'text', false, null, null],
    ['field_type', 'text', false, null, null],
    ['section', 'text', false, "'DETAILS'::text", null],
    ['behavior', 'text', false, null, null],
    ['customer_visible', 'boolean', false, 'true', null],
    ['display_order', 'integer', false, null, null],
    ['label_content_key', 'text', false, null, null],
    ['help_content_key', 'text', true, null, null],
    ['default_content_key', 'text', true, null, null],
    ['min_length', 'integer', true, null, null],
    ['max_length', 'integer', true, null, null],
    ['min_number', 'numeric', true, null, null],
    ['max_number', 'numeric', true, null, null],
    ['default_number', 'numeric', true, null, null],
    ['default_boolean', 'boolean', true, null, null],
    ['min_items', 'integer', true, null, null],
    ['max_items', 'integer', true, null, null],
  ],
  gig_template_field_options: [
    ['gig_template_field_id', 'uuid', false, null, null],
    ['option_code', 'text', false, null, null],
    ['label_content_key', 'text', false, null, null],
    ['is_default', 'boolean', false, 'false', null],
    ['display_order', 'integer', false, null, null],
  ],
  gig_template_requirements: [
    ['gig_template_requirement_id', 'uuid', false, 'gen_random_uuid()', null],
    ['gig_template_version_id', 'uuid', false, null, null],
    ['requirement_type', 'text', false, null, null],
    ['reference_code', 'text', true, null, null],
  ],
  market_gig_templates: [
    ['market_id', 'uuid', false, null, null],
    ['gig_template_id', 'uuid', false, null, null],
    ['enabled', 'boolean', false, 'false', null],
    ['display_order', 'integer', false, null, null],
    ['created_at', 'timestamp with time zone', false, 'now()', null],
    ['updated_at', 'timestamp with time zone', false, 'now()', null],
  ],
};
/** Every constraint of the six new tables by name with its exact definition text. */
const GT_CONSTRAINTS: Record<string, Record<string, string>> = {
  gig_templates: {
    ck_gig_templates__code: "CHECK (((code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text) AND ((length(code) >= 2) AND (length(code) <= 48))))",
    ck_gig_templates__description_content_key:
      "CHECK (((description_content_key IS NULL) OR (description_content_key = (('catalog.gig_template.'::text || code) || '.description'::text))))",
    ck_gig_templates__instructions_content_key:
      "CHECK (((instructions_content_key IS NULL) OR (instructions_content_key = (('catalog.gig_template.'::text || code) || '.instructions'::text))))",
    ck_gig_templates__status: "CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'INACTIVE'::text, 'RETIRED'::text])))",
    fk_gig_templates__description_content_key: 'FOREIGN KEY (description_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    fk_gig_templates__instructions_content_key: 'FOREIGN KEY (instructions_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    fk_gig_templates__name_content_key: 'FOREIGN KEY (name_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    fk_gig_templates__service_type_id: 'FOREIGN KEY (service_type_id) REFERENCES catalog.service_types(service_type_id) ON DELETE RESTRICT',
    pk_gig_templates: 'PRIMARY KEY (gig_template_id)',
    uq_gig_templates__code: 'UNIQUE (code)',
  },
  gig_template_versions: {
    ck_gig_template_versions__area: 'CHECK ((area_radius OR area_postal_codes OR area_polygon))',
    ck_gig_template_versions__duration:
      'CHECK ((((min_duration_minutes IS NULL) OR (min_duration_minutes >= 1)) AND ((max_duration_minutes IS NULL) OR (max_duration_minutes >= 1)) AND ((min_duration_minutes IS NULL) OR (max_duration_minutes IS NULL) OR (min_duration_minutes <= max_duration_minutes)) AND ((suggested_duration_minutes IS NULL) OR ((suggested_duration_minutes >= 1) AND ((min_duration_minutes IS NULL) OR (suggested_duration_minutes >= min_duration_minutes)) AND ((max_duration_minutes IS NULL) OR (suggested_duration_minutes <= max_duration_minutes))))))',
    ck_gig_template_versions__lifecycle:
      "CHECK ((((status = 'DRAFT'::text) AND (published_at IS NULL) AND (closed_at IS NULL)) OR ((status = 'ACTIVE'::text) AND (published_at IS NOT NULL) AND (closed_at IS NULL)) OR ((status = 'SUPERSEDED'::text) AND (published_at IS NOT NULL) AND (closed_at IS NOT NULL)) OR ((status = 'RETIRED'::text) AND (closed_at IS NOT NULL))))",
    ck_gig_template_versions__number: 'CHECK ((version_number >= 1))',
    ck_gig_template_versions__pricing: 'CHECK ((pricing_fixed OR pricing_fixed_with_variants))',
    ck_gig_template_versions__revision: 'CHECK ((revision >= 1))',
    ck_gig_template_versions__status: "CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'SUPERSEDED'::text, 'RETIRED'::text])))",
    fk_gig_template_versions__gig_template_id: 'FOREIGN KEY (gig_template_id) REFERENCES catalog.gig_templates(gig_template_id) ON DELETE RESTRICT',
    pk_gig_template_versions: 'PRIMARY KEY (gig_template_version_id)',
    uq_gig_template_versions__id_template: 'UNIQUE (gig_template_version_id, gig_template_id)', // 0017: the target of the composite audit foreign key
    uq_gig_template_versions__number: 'UNIQUE (gig_template_id, version_number)',
  },
  gig_template_fields: {
    ck_gig_template_fields__behavior: "CHECK ((behavior = ANY (ARRAY['PLATFORM_FIXED'::text, 'PROVIDER_CONFIGURABLE'::text, 'PROVIDER_REQUIRED'::text])))",
    ck_gig_template_fields__boolean_meta: "CHECK (((field_type = 'BOOLEAN'::text) OR (default_boolean IS NULL)))",
    ck_gig_template_fields__display_order: 'CHECK (((display_order >= 1) AND (display_order <= 999)))',
    ck_gig_template_fields__duration_positive:
      "CHECK (((field_type <> 'DURATION'::text) OR (((min_number IS NULL) OR (min_number >= (1)::numeric)) AND ((max_number IS NULL) OR (max_number >= (1)::numeric)) AND ((default_number IS NULL) OR (default_number >= (1)::numeric)))))",
    ck_gig_template_fields__fixed:
      "CHECK (((behavior <> 'PLATFORM_FIXED'::text) OR ((field_type = ANY (ARRAY['TEXT'::text, 'LONG_TEXT'::text, 'INTEGER'::text, 'DECIMAL'::text, 'BOOLEAN'::text, 'ENUM'::text, 'DURATION'::text])) AND\nCASE\n    WHEN (field_type = ANY (ARRAY['TEXT'::text, 'LONG_TEXT'::text])) THEN (default_content_key IS NOT NULL)\n    WHEN (field_type = ANY (ARRAY['INTEGER'::text, 'DECIMAL'::text, 'DURATION'::text])) THEN (default_number IS NOT NULL)\n    WHEN (field_type = 'BOOLEAN'::text) THEN (default_boolean IS NOT NULL)\n    ELSE true\nEND)))",
    ck_gig_template_fields__items:
      "CHECK ((((min_items IS NULL) OR (min_items >= 0)) AND ((max_items IS NULL) OR (max_items >= 0)) AND ((min_items IS NULL) OR (max_items IS NULL) OR (min_items <= max_items)) AND ((field_type <> ALL (ARRAY['EQUIPMENT_REFERENCE'::text, 'SKILL_REFERENCE'::text])) OR (max_items IS NULL) OR (max_items >= 1))))",
    ck_gig_template_fields__items_meta:
      "CHECK (((field_type = ANY (ARRAY['MEDIA'::text, 'EQUIPMENT_REFERENCE'::text, 'SKILL_REFERENCE'::text])) OR ((min_items IS NULL) AND (max_items IS NULL))))",
    ck_gig_template_fields__key: "CHECK (((field_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text) AND ((length(field_key) >= 2) AND (length(field_key) <= 32))))",
    ck_gig_template_fields__length:
      'CHECK ((((min_length IS NULL) OR (min_length >= 1)) AND ((max_length IS NULL) OR (max_length >= 1)) AND ((min_length IS NULL) OR (max_length IS NULL) OR (min_length <= max_length))))',
    ck_gig_template_fields__media_required:
      "CHECK (((NOT ((field_type = 'MEDIA'::text) AND (behavior = 'PROVIDER_REQUIRED'::text))) OR ((COALESCE(min_items, 0) >= 1) AND (max_items IS DISTINCT FROM 0))))",
    ck_gig_template_fields__number_meta:
      "CHECK (((field_type = ANY (ARRAY['INTEGER'::text, 'DECIMAL'::text, 'DURATION'::text])) OR ((min_number IS NULL) AND (max_number IS NULL) AND (default_number IS NULL))))",
    ck_gig_template_fields__number_order:
      'CHECK ((((min_number IS NULL) OR (max_number IS NULL) OR (min_number <= max_number)) AND ((default_number IS NULL) OR (min_number IS NULL) OR (default_number >= min_number)) AND ((default_number IS NULL) OR (max_number IS NULL) OR (default_number <= max_number))))',
    ck_gig_template_fields__number_shape:
      "CHECK (((field_type <> ALL (ARRAY['INTEGER'::text, 'DURATION'::text])) OR (((min_number IS NULL) OR (min_number = trunc(min_number))) AND ((max_number IS NULL) OR (max_number = trunc(max_number))) AND ((default_number IS NULL) OR (default_number = trunc(default_number))))))",
    ck_gig_template_fields__section:
      "CHECK ((section = ANY (ARRAY['SCOPE'::text, 'INCLUSIONS'::text, 'EXCLUSIONS'::text, 'PREPARATION'::text, 'DETAILS'::text])))",
    ck_gig_template_fields__text_meta:
      "CHECK (((field_type = ANY (ARRAY['TEXT'::text, 'LONG_TEXT'::text])) OR ((min_length IS NULL) AND (max_length IS NULL) AND (default_content_key IS NULL))))",
    ck_gig_template_fields__type:
      "CHECK ((field_type = ANY (ARRAY['TEXT'::text, 'LONG_TEXT'::text, 'INTEGER'::text, 'DECIMAL'::text, 'BOOLEAN'::text, 'ENUM'::text, 'DURATION'::text, 'MONEY'::text, 'MEDIA'::text, 'EQUIPMENT_REFERENCE'::text, 'SKILL_REFERENCE'::text])))",
    fk_gig_template_fields__default_content_key: 'FOREIGN KEY (default_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    fk_gig_template_fields__help_content_key: 'FOREIGN KEY (help_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    fk_gig_template_fields__label_content_key: 'FOREIGN KEY (label_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    fk_gig_template_fields__version_id:
      'FOREIGN KEY (gig_template_version_id) REFERENCES catalog.gig_template_versions(gig_template_version_id) ON DELETE RESTRICT',
    pk_gig_template_fields: 'PRIMARY KEY (gig_template_field_id)',
    uq_gig_template_fields__key: 'UNIQUE (gig_template_version_id, field_key)',
    uq_gig_template_fields__order: 'UNIQUE (gig_template_version_id, display_order)',
  },
  gig_template_field_options: {
    ck_gig_template_field_options__code:
      "CHECK (((option_code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text) AND ((length(option_code) >= 2) AND (length(option_code) <= 32))))",
    ck_gig_template_field_options__display_order: 'CHECK (((display_order >= 1) AND (display_order <= 99)))',
    fk_gig_template_field_options__field_id:
      'FOREIGN KEY (gig_template_field_id) REFERENCES catalog.gig_template_fields(gig_template_field_id) ON DELETE RESTRICT',
    fk_gig_template_field_options__label_content_key: 'FOREIGN KEY (label_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    pk_gig_template_field_options: 'PRIMARY KEY (gig_template_field_id, option_code)',
    uq_gig_template_field_options__order: 'UNIQUE (gig_template_field_id, display_order)',
  },
  gig_template_requirements: {
    ck_gig_template_requirements__reference:
      "CHECK (((reference_code IS NULL) OR ((reference_code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text) AND ((length(reference_code) >= 2) AND (length(reference_code) <= 48)))))",
    ck_gig_template_requirements__type:
      "CHECK ((requirement_type = ANY (ARRAY['SKILL'::text, 'EQUIPMENT'::text, 'LICENSE'::text, 'INSURANCE'::text, 'BACKGROUND_CHECK'::text])))",
    fk_gig_template_requirements__version_id:
      'FOREIGN KEY (gig_template_version_id) REFERENCES catalog.gig_template_versions(gig_template_version_id) ON DELETE RESTRICT',
    pk_gig_template_requirements: 'PRIMARY KEY (gig_template_requirement_id)',
    uq_gig_template_requirements__requirement: 'UNIQUE NULLS NOT DISTINCT (gig_template_version_id, requirement_type, reference_code)',
  },
  market_gig_templates: {
    ck_market_gig_templates__display_order: 'CHECK (((display_order >= 1) AND (display_order <= 9999)))',
    fk_market_gig_templates__gig_template_id: 'FOREIGN KEY (gig_template_id) REFERENCES catalog.gig_templates(gig_template_id) ON DELETE RESTRICT',
    fk_market_gig_templates__market_id: 'FOREIGN KEY (market_id) REFERENCES geography.markets(market_id) ON DELETE RESTRICT',
    pk_market_gig_templates: 'PRIMARY KEY (market_id, gig_template_id)',
    uq_market_gig_templates__market_order: 'UNIQUE (market_id, display_order)',
  },
};
const GT_INDEXES: Record<string, Record<string, string>> = {
  gig_templates: {
    idx_gig_templates__service_type: 'CREATE INDEX idx_gig_templates__service_type ON catalog.gig_templates USING btree (service_type_id)',
    pk_gig_templates: 'CREATE UNIQUE INDEX pk_gig_templates ON catalog.gig_templates USING btree (gig_template_id)',
    uq_gig_templates__code: 'CREATE UNIQUE INDEX uq_gig_templates__code ON catalog.gig_templates USING btree (code)',
  },
  gig_template_versions: {
    pk_gig_template_versions: 'CREATE UNIQUE INDEX pk_gig_template_versions ON catalog.gig_template_versions USING btree (gig_template_version_id)',
    uq_gig_template_versions__active:
      "CREATE UNIQUE INDEX uq_gig_template_versions__active ON catalog.gig_template_versions USING btree (gig_template_id) WHERE (status = 'ACTIVE'::text)",
    uq_gig_template_versions__draft:
      "CREATE UNIQUE INDEX uq_gig_template_versions__draft ON catalog.gig_template_versions USING btree (gig_template_id) WHERE (status = 'DRAFT'::text)",
    uq_gig_template_versions__id_template:
      'CREATE UNIQUE INDEX uq_gig_template_versions__id_template ON catalog.gig_template_versions USING btree (gig_template_version_id, gig_template_id)',
    uq_gig_template_versions__number:
      'CREATE UNIQUE INDEX uq_gig_template_versions__number ON catalog.gig_template_versions USING btree (gig_template_id, version_number)',
  },
  gig_template_fields: {
    pk_gig_template_fields: 'CREATE UNIQUE INDEX pk_gig_template_fields ON catalog.gig_template_fields USING btree (gig_template_field_id)',
    uq_gig_template_fields__key:
      'CREATE UNIQUE INDEX uq_gig_template_fields__key ON catalog.gig_template_fields USING btree (gig_template_version_id, field_key)',
    uq_gig_template_fields__order:
      'CREATE UNIQUE INDEX uq_gig_template_fields__order ON catalog.gig_template_fields USING btree (gig_template_version_id, display_order)',
  },
  gig_template_field_options: {
    pk_gig_template_field_options:
      'CREATE UNIQUE INDEX pk_gig_template_field_options ON catalog.gig_template_field_options USING btree (gig_template_field_id, option_code)',
    uq_gig_template_field_options__default:
      'CREATE UNIQUE INDEX uq_gig_template_field_options__default ON catalog.gig_template_field_options USING btree (gig_template_field_id) WHERE is_default',
    uq_gig_template_field_options__order:
      'CREATE UNIQUE INDEX uq_gig_template_field_options__order ON catalog.gig_template_field_options USING btree (gig_template_field_id, display_order)',
  },
  gig_template_requirements: {
    pk_gig_template_requirements:
      'CREATE UNIQUE INDEX pk_gig_template_requirements ON catalog.gig_template_requirements USING btree (gig_template_requirement_id)',
    uq_gig_template_requirements__requirement:
      'CREATE UNIQUE INDEX uq_gig_template_requirements__requirement ON catalog.gig_template_requirements USING btree (gig_template_version_id, requirement_type, reference_code) NULLS NOT DISTINCT',
  },
  market_gig_templates: {
    pk_market_gig_templates: 'CREATE UNIQUE INDEX pk_market_gig_templates ON catalog.market_gig_templates USING btree (market_id, gig_template_id)',
    uq_market_gig_templates__market_order:
      'CREATE UNIQUE INDEX uq_market_gig_templates__market_order ON catalog.market_gig_templates USING btree (market_id, display_order)',
  },
};
const GT_TRIGGERS: Record<string, Record<string, string>> = {
  gig_templates: {
    trg_gig_templates__guard:
      'CREATE TRIGGER trg_gig_templates__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.gig_templates FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_templates()',
    trg_gig_templates__no_truncate:
      'CREATE TRIGGER trg_gig_templates__no_truncate BEFORE TRUNCATE ON catalog.gig_templates FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  gig_template_versions: {
    trg_gig_template_versions__guard:
      'CREATE TRIGGER trg_gig_template_versions__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.gig_template_versions FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_versions()',
    trg_gig_template_versions__no_truncate:
      'CREATE TRIGGER trg_gig_template_versions__no_truncate BEFORE TRUNCATE ON catalog.gig_template_versions FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  gig_template_fields: {
    trg_gig_template_fields__guard:
      'CREATE TRIGGER trg_gig_template_fields__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.gig_template_fields FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_fields()',
    trg_gig_template_fields__no_truncate:
      'CREATE TRIGGER trg_gig_template_fields__no_truncate BEFORE TRUNCATE ON catalog.gig_template_fields FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  gig_template_field_options: {
    trg_gig_template_field_options__guard:
      'CREATE TRIGGER trg_gig_template_field_options__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.gig_template_field_options FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_field_options()',
    trg_gig_template_field_options__no_truncate:
      'CREATE TRIGGER trg_gig_template_field_options__no_truncate BEFORE TRUNCATE ON catalog.gig_template_field_options FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  gig_template_requirements: {
    trg_gig_template_requirements__guard:
      'CREATE TRIGGER trg_gig_template_requirements__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.gig_template_requirements FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_requirements()',
    trg_gig_template_requirements__no_truncate:
      'CREATE TRIGGER trg_gig_template_requirements__no_truncate BEFORE TRUNCATE ON catalog.gig_template_requirements FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
  market_gig_templates: {
    trg_market_gig_templates__guard:
      'CREATE TRIGGER trg_market_gig_templates__guard BEFORE INSERT OR DELETE OR UPDATE ON catalog.market_gig_templates FOR EACH ROW EXECUTE FUNCTION catalog.guard_market_gig_templates()',
    trg_market_gig_templates__no_truncate:
      'CREATE TRIGGER trg_market_gig_templates__no_truncate BEFORE TRUNCATE ON catalog.market_gig_templates FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation()',
  },
};

const GT_FK_TARGETS: Record<string, string> = {
  fk_gig_templates__service_type_id: 'catalog.service_types',
  fk_gig_templates__name_content_key: 'content.entries',
  fk_gig_templates__description_content_key: 'content.entries',
  fk_gig_templates__instructions_content_key: 'content.entries',
  fk_gig_template_versions__gig_template_id: 'catalog.gig_templates',
  fk_gig_template_fields__version_id: 'catalog.gig_template_versions',
  fk_gig_template_fields__label_content_key: 'content.entries',
  fk_gig_template_fields__help_content_key: 'content.entries',
  fk_gig_template_fields__default_content_key: 'content.entries',
  fk_gig_template_field_options__field_id: 'catalog.gig_template_fields',
  fk_gig_template_field_options__label_content_key: 'content.entries',
  fk_gig_template_requirements__version_id: 'catalog.gig_template_versions',
  fk_market_gig_templates__market_id: 'geography.markets',
  fk_market_gig_templates__gig_template_id: 'catalog.gig_templates',
};
const NEW_FUNCTIONS = [
  { proname: 'assert_version_publishable', args: 'p_version_id uuid', volatility: 'v', result: 'void', lang: 'plpgsql' },
  { proname: 'assert_version_transition', args: 'p_old text, p_new text', volatility: 'i', result: 'void', lang: 'plpgsql' },
  { proname: 'content_is_published', args: 'p_key text', volatility: 's', result: 'boolean', lang: 'sql' },
  {
    proname: 'gig_template_options_of_version',
    args: 'p_version_id uuid',
    volatility: 's',
    result: 'TABLE(label_content_key text, expected_key text)',
    lang: 'sql',
  },
  { proname: 'guard_gig_template_field_options', args: '', volatility: 'v', result: 'trigger', lang: 'plpgsql' },
  { proname: 'guard_gig_template_fields', args: '', volatility: 'v', result: 'trigger', lang: 'plpgsql' },
  { proname: 'guard_gig_template_requirements', args: '', volatility: 'v', result: 'trigger', lang: 'plpgsql' },
  { proname: 'guard_gig_template_versions', args: '', volatility: 'v', result: 'trigger', lang: 'plpgsql' },
  { proname: 'guard_gig_templates', args: '', volatility: 'v', result: 'trigger', lang: 'plpgsql' },
  { proname: 'guard_market_gig_templates', args: '', volatility: 'v', result: 'trigger', lang: 'plpgsql' },
];
/** Every catalog_rule key the migration can raise (the guard functions name them in their comments, the tests below drive each one). */
const NEW_RULE_KEYS = [
  'NOT_DELETABLE',
  'IMMUTABLE_IDENTITY',
  'MUST_START_AS_DRAFT',
  'STATUS_TRANSITION',
  'DRAFT_IS_INITIAL',
  'SERVICE_TYPE_RETIRED',
  'SERVICE_TYPE_NOT_ACTIVE',
  'GIG_TEMPLATE_RETIRED',
  'GIG_TEMPLATE_NOT_ACTIVE',
  'GIG_TEMPLATE_HAS_OPEN_DRAFT',
  'VERSION_NUMBER_SEQUENCE',
  'VERSION_FROZEN',
  'VERSION_NOT_DRAFT',
  'SUPERSEDED_IS_AUTOMATIC',
  'GIG_TEMPLATE_HAS_NO_FIELDS',
  'ENUM_FIELD_WITHOUT_OPTIONS',
  'FIXED_ENUM_WITHOUT_DEFAULT',
  'CONTENT_NOT_PUBLISHED',
  'CONTENT_KEY_MISMATCH',
  'OPTIONS_ONLY_FOR_ENUM',
  'FIELD_HAS_OPTIONS',
  'ITEM_RETIRED',
];

/** A fingerprint of every object of the database that does NOT belong to the catalog schema (compared before and after 0016). */
async function outsideCatalog(from: pg.Pool) {
  const rows = async (text: string) => (await from.query(text)).rows.map((r) => JSON.stringify(r));
  const other = "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'catalog', 'provider')";
  return {
    schemas: await rows(
      "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'catalog', 'provider') ORDER BY 1",
    ),
    relations: await rows(`SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${other} ORDER BY 1, 2`),
    columns: await rows(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression, ordinal_position FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'catalog', 'provider') ORDER BY table_schema, table_name, ordinal_position`,
    ),
    constraints: await rows(
      `SELECT n.nspname, t.relname, c.conname, c.contype, c.confdeltype, c.confupdtype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, c.conname COLLATE "C"`,
    ),
    indexes: await rows(
      `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'catalog', 'provider') ORDER BY schemaname, tablename, indexname COLLATE "C"`,
    ),
    triggers: await rows(
      `SELECT n.nspname, t.relname, g.tgname, g.tgenabled, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE NOT g.tgisinternal AND ${other} ORDER BY n.nspname, t.relname, g.tgname COLLATE "C"`,
    ),
    functions: await rows(
      `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src, p.provolatile, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'catalog', 'provider') AND p.prokind = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY n.nspname, p.proname, args`,
    ),
    comments: await rows(
      `SELECT n.nspname, t.relname, d.objsubid, d.description FROM pg_description d JOIN pg_class t ON t.oid = d.objoid AND d.classoid = 'pg_class'::regclass JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, d.objsubid`,
    ),
  };
}
/** The CAT-001 objects of the catalog schema (everything except the CAT-002 tables, functions and triggers), as stable text rows. */
async function oldCatalogObjects(from: pg.Pool) {
  const rows = async (text: string, params: unknown[] = []) => (await from.query(text, params)).rows.map((r) => JSON.stringify(r));
  const oldFns = [
    'assert_status_transition',
    'forbid_mutation',
    'guard_categories',
    'guard_market_categories',
    'guard_market_service_types',
    'guard_prohibited_services',
    'guard_service_types',
  ];
  const tables = OLD_TABLE_NAMES.filter((t) => t !== 'audit_events');
  return {
    functions: await rows(
      "SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src, p.provolatile, replace(obj_description(p.oid, 'pg_proc'), ' and Gig Template identities', '') AS comment FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace AND p.proname = ANY($1) ORDER BY 1",
      [oldFns],
    ),
    columns: await rows(
      "SELECT table_name, column_name, data_type, is_nullable, column_default, generation_expression, ordinal_position FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name = ANY($1) ORDER BY 1, ordinal_position",
      [tables],
    ),
    constraints: await rows(
      'SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.connamespace = \'catalog\'::regnamespace AND c.conrelid::regclass::text = ANY($1) ORDER BY tbl, c.conname COLLATE "C"',
      [tables.map((t) => `catalog.${t}`)],
    ),
    indexes: await rows(
      'SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = \'catalog\' AND tablename = ANY($1) ORDER BY tablename, indexname COLLATE "C"',
      [tables],
    ),
    triggers: await rows(
      'SELECT c.relname, g.tgname, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = \'catalog\'::regnamespace AND c.relname = ANY($1) AND NOT g.tgisinternal ORDER BY c.relname, g.tgname COLLATE "C"',
      [OLD_TABLE_NAMES],
    ),
    // the audit table: every column and constraint that existed in 0015 and was NOT replaced
    auditKept: await rows(
      `SELECT column_name, data_type, is_nullable, column_default, ordinal_position FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name = 'audit_events' AND ordinal_position <= 11 ORDER BY ordinal_position`,
    ),
    auditConstraintsKept: await rows(
      "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'catalog.audit_events'::regclass AND conname NOT IN ('ck_audit_events__action', 'ck_audit_events__subject') AND conname NOT LIKE 'fk_audit_events__gig_%' ORDER BY conname COLLATE \"C\"",
    ),
  };
}

describe('A. schema shape: six new tables, nine functions and twelve triggers added to the catalog schema, the audit table widened, nothing else changed', () => {
  it('has twelve tables and 30 indexes in the catalog schema (the six of 0015, the six of 0016 and the unique key of 0017); no sequence, view, materialized view, partition or composite type; everything is owned by the application role', async () => {
    const tables = await sq<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'catalog' AND table_type = 'BASE TABLE' ORDER BY 1",
    );
    expect(tables.map((r) => r.table_name)).toEqual([...OLD_TABLE_NAMES, ...NEW_TABLE_NAMES].sort(byName));
    expect(await sq("SELECT c.relkind, count(*)::int AS n FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace GROUP BY 1 ORDER BY 1")).toEqual([
      { relkind: 'i', n: 30 }, // 12 of 0015 + 18 of 0016/0017 (6 primary keys, 8 unique keys, idx_gig_templates__service_type, the 3 partial unique indexes)
      { relkind: 'r', n: 12 },
    ]);
    expect(
      await sq("SELECT t.typname FROM pg_type t WHERE t.typnamespace = 'catalog'::regnamespace AND t.typtype NOT IN ('c', 'b') AND t.typname NOT LIKE '\\_%'"),
    ).toEqual([]);
    expect(
      await sq("SELECT DISTINCT pg_get_userbyid(c.relowner) = current_user AS mine FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace"),
    ).toEqual([{ mine: true }]);
    expect(Object.values(GT_INDEXES).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(18);
  });

  it('grants nothing: every relation of the catalog schema has no ACL (owner only), the schema has none, and no function has an explicit ACL; no default privilege is set for the schema', async () => {
    expect(await sq("SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relacl IS NOT NULL")).toEqual([]);
    expect(await sq("SELECT nspname FROM pg_namespace WHERE nspname = 'catalog' AND nspacl IS NOT NULL")).toEqual([]);
    expect(await sq("SELECT proname FROM pg_proc WHERE pronamespace = 'catalog'::regnamespace AND proacl IS NOT NULL")).toEqual([]);
    expect(await sq("SELECT 1 FROM pg_default_acl WHERE defaclnamespace = 'catalog'::regnamespace")).toEqual([]);
    expect(await sq("SELECT 1 FROM information_schema.table_privileges WHERE table_schema = 'catalog' AND grantee = 'PUBLIC'")).toEqual([]);
  });

  it.each(Object.entries(GT_COLUMNS))(
    'has exactly the documented columns, types, nullability, defaults and generation expression on %s',
    async (table, expected) => {
      expect(await columnsOf(table)).toEqual(expected);
    },
  );

  it('widens audit_events by exactly two nullable uuid columns at the END (the eleven of 0015 keep their position), without a default', async () => {
    const cols = await columnsOf('audit_events');
    expect(cols).toHaveLength(13);
    expect(cols.slice(11)).toEqual([
      ['gig_template_id', 'uuid', true, null, null],
      ['gig_template_version_id', 'uuid', true, null, null],
    ]);
    expect(cols.slice(0, 11).map((c) => c[0])).toEqual([
      'audit_event_id',
      'occurred_at',
      'actor',
      'action',
      'category_id',
      'service_type_id',
      'prohibited_service_id',
      'market_id',
      'changes',
      'reason',
      'correlation_id',
    ]);
  });

  it('GENERATES exactly one new column (gig_templates.name_content_key, ALWAYS ... STORED) and no new identity column', async () => {
    expect(
      await sq(
        `SELECT c.relname, a.attname, a.attgenerated, a.attidentity FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped AND (a.attgenerated <> '' OR a.attidentity <> '') ORDER BY 1, 2`,
        [NEW_TABLE_NAMES],
      ),
    ).toEqual([{ relname: 'gig_templates', attname: 'name_content_key', attgenerated: 's', attidentity: '' }]);
  });

  it('refuses to write the generated name_content_key (428C9) by INSERT and by UPDATE, even with the same value, and accepts DEFAULT; the stored value follows the code', async () => {
    const t = await makeTpl();
    const code = `gt_${++seq}`;
    await ensureContent(gigTemplateNameKey(code));
    await ensureContent('catalog.gig_template.forced.name');
    const st = await makeSt();
    await expect(
      pool.query('INSERT INTO catalog.gig_templates (service_type_id, code, name_content_key) VALUES ($1, $2, $3)', [
        st.id,
        code,
        'catalog.gig_template.forced.name',
      ]),
    ).rejects.toMatchObject({
      code: '428C9',
    });
    await expect(
      pool.query('INSERT INTO catalog.gig_templates (service_type_id, code, name_content_key) VALUES ($1, $2, $3)', [st.id, code, gigTemplateNameKey(code)]),
    ).rejects.toMatchObject({
      code: '428C9',
    });
    await expect(
      pool.query('UPDATE catalog.gig_templates SET name_content_key = $2 WHERE gig_template_id = $1', [t.id, 'catalog.gig_template.forced.name']),
    ).rejects.toMatchObject({
      code: '428C9',
    });
    await expect(
      pool.query('UPDATE catalog.gig_templates SET name_content_key = $2 WHERE gig_template_id = $1', [t.id, gigTemplateNameKey(t.code)]),
    ).rejects.toMatchObject({ code: '428C9' });
    await run('UPDATE catalog.gig_templates SET name_content_key = DEFAULT WHERE gig_template_id = $1', [t.id]);
    expect(
      (await q<{ name_content_key: string }>('SELECT name_content_key FROM catalog.gig_templates WHERE gig_template_id = $1', [t.id]))[0]!.name_content_key,
    ).toBe(gigTemplateNameKey(t.code));
  });

  it.each(Object.entries(GT_CONSTRAINTS))(
    'defines every constraint of %s exactly as documented (names and definition text), and no other',
    async (table, defs) => {
      const rows = await constraintsOf(`catalog.${table}`);
      expect(rows.map((r) => r.conname)).toEqual(Object.keys(defs).sort(byName));
      expect(Object.fromEntries(rows.map((r) => [r.conname, r.def]))).toEqual(defs);
      expect(rows.every((r) => r.convalidated && !r.condeferrable)).toBe(true); // none deferrable, none NOT VALID
    },
  );

  it('has 106 primary key, unique, foreign key and check constraints in the catalog schema (CAT-001: 44 + the two audit foreign keys; CAT-002: 60) and no exclusion constraint', async () => {
    const n = await sq<{ contype: string; n: number }>(
      "SELECT c.contype, count(*)::int AS n FROM pg_constraint c WHERE c.connamespace = 'catalog'::regnamespace GROUP BY 1 ORDER BY 1",
    );
    expect(n).toEqual([
      { contype: 'c', n: 49 }, // 17 + 32
      { contype: 'f', n: 32 }, // 16 + 2 audit + 14
      { contype: 'p', n: 12 }, // 6 + 6
      { contype: 'u', n: 13 }, // 5 + 8
    ]);
    expect(Object.values(GT_CONSTRAINTS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(60); // 14 fk + 6 pk + 8 uq + 32 ck
  });

  it('declares every foreign key ON DELETE RESTRICT and ON UPDATE NO ACTION with MATCH SIMPLE and the documented target; nothing in the catalog cascades or sets null', async () => {
    const fks: ConstraintRow[] = [];
    for (const t of NEW_TABLE_NAMES) fks.push(...(await constraintsOf(`catalog.${t}`)).filter((r) => r.contype === 'f'));
    expect(Object.fromEntries(fks.map((r) => [r.conname, r.target]))).toEqual(GT_FK_TARGETS);
    expect(fks.map((r) => [r.confdeltype, r.confupdtype, r.confmatchtype])).toEqual(fks.map(() => ['r', 'a', 's']));
    expect(fks).toHaveLength(14);
    // and across the whole schema: no foreign key cascades, nulls or defaults
    expect(
      await sq(
        "SELECT conname FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace AND contype = 'f' AND (confdeltype <> 'r' OR confupdtype <> 'a' OR confmatchtype <> 's')",
      ),
    ).toEqual([]);
    // the two new audit foreign keys point at the new tables
    const audit = (await constraintsOf('catalog.audit_events')).filter((r) => /gig_template/.test(r.conname));
    expect(Object.fromEntries(audit.map((r) => [r.conname, r.target]))).toEqual({
      fk_audit_events__gig_template_id: 'catalog.gig_templates',
      fk_audit_events__gig_template_version: 'catalog.gig_template_versions', // 0017: composite (version id, template id)
    });
  });

  it.each(Object.entries(GT_INDEXES))('has exactly the documented indexes on %s and no other', async (table, defs) => {
    const idx = await indexesOf(table);
    expect(Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]))).toEqual(defs);
    expect(idx.map((r) => r.indexname)).toEqual(Object.keys(defs).sort(byName));
  });

  it('has exactly three partial indexes and one NULLS NOT DISTINCT index among the new ones, no expression or covering index, and none on status (but the two partial uniques), enabled, a content key or a timestamp', async () => {
    const all = await sq<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = ANY($1) ORDER BY 1",
      [NEW_TABLE_NAMES],
    );
    expect(all.filter((r) => / WHERE /.test(r.indexdef)).map((r) => r.indexname)).toEqual([
      'uq_gig_template_field_options__default',
      'uq_gig_template_versions__active',
      'uq_gig_template_versions__draft',
    ]);
    expect(all.filter((r) => /NULLS NOT DISTINCT/.test(r.indexdef)).map((r) => r.indexname)).toEqual(['uq_gig_template_requirements__requirement']);
    expect(all.filter((r) => /INCLUDE|lower\(|\|\|/.test(r.indexdef))).toEqual([]);
    // an index column list never names status, enabled, a timestamp or a content key (only the partial predicates do)
    for (const r of all) {
      const cols = r.indexdef
        .replace(/ WHERE .*/, '')
        .replace(/.*USING btree \(/, '')
        .replace(/\).*/, '')
        .split(', ');
      for (const c of cols)
        expect(
          ['status', 'enabled', 'created_at', 'updated_at', 'published_at', 'closed_at'].includes(c) || /content_key$/.test(c),
          `${r.indexname}: ${c}`,
        ).toBe(false);
    }
    expect(all.filter((r) => !/^(pk|uq|idx)_/.test(r.indexname))).toEqual([]);
    expect(all).toHaveLength(18);
  });

  it.each(Object.entries(GT_TRIGGERS))(
    'wires the triggers of %s exactly (name, timing, events, level, function), enabled, none deferrable or constraint triggers',
    async (table, defs) => {
      const t = await triggersOf(`catalog.${table}`);
      expect(Object.fromEntries(t.map((x) => [x.tgname, x.def]))).toEqual(defs);
      expect(t.every((x) => x.enabled === 'O')).toBe(true);
      expect(t.filter((x) => /CONSTRAINT TRIGGER|DEFERRABLE|AFTER|INSTEAD/.test(x.def))).toEqual([]);
    },
  );

  it('has exactly 24 triggers in the schema (12 of 0015 + 12 of 0016: a row guard and a TRUNCATE refusal per new table), every one BEFORE, and the audit trail keeps its two', async () => {
    const all = await sq<{ tgname: string; relname: string }>(
      "SELECT g.tgname, c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT g.tgisinternal ORDER BY 1",
    );
    expect(all).toHaveLength(24);
    expect(all.filter((r) => NEW_TABLE_NAMES.includes(r.relname))).toHaveLength(12);
    expect(Object.values(GT_TRIGGERS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(12);
    expect((await triggersOf('catalog.audit_events')).map((t) => t.tgname)).toEqual(['trg_audit_events__immutable', 'trg_audit_events__no_truncate']);
    // the migration adds no trigger to a table outside the schema
    expect(
      await sq(
        "SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace <> 'catalog'::regnamespace AND pg_get_triggerdef(g.oid) ~ 'catalog\\.'",
      ),
    ).toEqual([]);
  });

  it('defines the ten new functions as documented (language, volatility, result), not SECURITY DEFINER, without a custom search_path, with a comment each; the schema has seventeen functions', async () => {
    const rows = await sq<{ proname: string; args: string; volatility: string; result: string; lang: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.provolatile AS volatility, pg_get_function_result(p.oid) AS result, l.lanname AS lang
         FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.pronamespace = 'catalog'::regnamespace AND p.proname = ANY($1) ORDER BY 1`,
      [NEW_FUNCTIONS.map((f) => f.proname)],
    );
    expect(rows).toEqual(NEW_FUNCTIONS);
    expect((await sq<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'catalog'::regnamespace"))[0]!.n).toBe(17);
    expect(
      await sq(
        `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace AND (p.prosecdef OR p.proconfig IS NOT NULL OR obj_description(p.oid, 'pg_proc') IS NULL OR p.proleakproof OR p.proisstrict)`,
      ),
    ).toEqual([]);
    const comment = async (sig: string) => (await sq<{ c: string }>("SELECT obj_description($1::regprocedure, 'pg_proc') AS c", [`catalog.${sig}`]))[0]!.c;
    expect(await comment('guard_gig_templates()')).toMatch(
      /NOT_DELETABLE.*MUST_START_AS_DRAFT.*SERVICE_TYPE_RETIRED.*IMMUTABLE_IDENTITY.*DRAFT_IS_INITIAL.*STATUS_TRANSITION.*SERVICE_TYPE_NOT_ACTIVE.*GIG_TEMPLATE_HAS_OPEN_DRAFT/,
    );
    expect(await comment('guard_gig_template_versions()')).toMatch(
      /NOT_DELETABLE.*MUST_START_AS_DRAFT.*GIG_TEMPLATE_RETIRED.*VERSION_NUMBER_SEQUENCE.*IMMUTABLE_IDENTITY.*VERSION_FROZEN.*DRAFT_IS_INITIAL.*STATUS_TRANSITION.*GIG_TEMPLATE_NOT_ACTIVE.*SERVICE_TYPE_NOT_ACTIVE.*SUPERSEDED_IS_AUTOMATIC/,
    );
    expect(await comment('guard_gig_template_fields()')).toMatch(/IMMUTABLE_IDENTITY.*VERSION_NOT_DRAFT.*CONTENT_KEY_MISMATCH/);
    expect(await comment('guard_gig_template_field_options()')).toMatch(/IMMUTABLE_IDENTITY.*VERSION_NOT_DRAFT.*OPTIONS_ONLY_FOR_ENUM.*CONTENT_KEY_MISMATCH/);
    expect(await comment('guard_gig_template_requirements()')).toMatch(/IMMUTABLE_IDENTITY.*VERSION_NOT_DRAFT/);
    expect(await comment('guard_market_gig_templates()')).toMatch(/NOT_DELETABLE.*IMMUTABLE_IDENTITY.*ITEM_RETIRED/);
    expect(await comment('assert_version_publishable(uuid)')).toMatch(
      /GIG_TEMPLATE_HAS_NO_FIELDS.*ENUM_FIELD_WITHOUT_OPTIONS.*FIXED_ENUM_WITHOUT_DEFAULT.*CONTENT_NOT_PUBLISHED/,
    );
    expect(await comment('assert_version_transition(text, text)')).toMatch(/DRAFT_IS_INITIAL.*STATUS_TRANSITION/);
  });

  it('raises every rule key that the tests below drive, and no other key: the keys in the ten function sources equal the documented list', async () => {
    const src = await sq<{ prosrc: string }>("SELECT prosrc FROM pg_proc WHERE pronamespace = 'catalog'::regnamespace AND proname = ANY($1)", [
      NEW_FUNCTIONS.map((f) => f.proname),
    ]);
    const keys = new Set(src.flatMap((r) => [...r.prosrc.matchAll(/catalog_rule:([A-Z_]+)/g)].map((m) => m[1]!)));
    expect([...keys].sort()).toEqual([...NEW_RULE_KEYS].sort());
  });

  it('CHECKs the vocabularies to exactly the contract lists, so the database and the API cannot drift', async () => {
    const defs = async (t: string) => Object.fromEntries((await constraintsOf(`catalog.${t}`)).map((r) => [r.conname, r.def]));
    expect(vocab((await defs('gig_templates'))['ck_gig_templates__status']!)).toEqual([...CATALOG_STATUSES]);
    expect(vocab((await defs('gig_template_versions'))['ck_gig_template_versions__status']!)).toEqual([...GIG_TEMPLATE_VERSION_STATUSES]);
    const fd = await defs('gig_template_fields');
    expect(vocab(fd['ck_gig_template_fields__type']!)).toEqual([...GIG_TEMPLATE_FIELD_TYPES]);
    expect(vocab(fd['ck_gig_template_fields__section']!)).toEqual([...GIG_TEMPLATE_SECTIONS]);
    expect(vocab(fd['ck_gig_template_fields__behavior']!)).toEqual([...GIG_TEMPLATE_FIELD_BEHAVIORS]);
    expect(vocab(fd['ck_gig_template_fields__fixed']!).slice(0, 1)).toEqual(['PLATFORM_FIXED']);
    expect(vocab(fd['ck_gig_template_fields__fixed']!).slice(1, 1 + FIXED_CAPABLE_FIELD_TYPES.length)).toEqual([...FIXED_CAPABLE_FIELD_TYPES]);
    expect(vocab((await defs('gig_template_requirements'))['ck_gig_template_requirements__type']!)).toEqual([...GIG_TEMPLATE_REQUIREMENT_TYPES]);
    // the code / key patterns are the contract's
    for (const [t, c] of [
      ['gig_templates', 'ck_gig_templates__code'],
      ['gig_template_fields', 'ck_gig_template_fields__key'],
      ['gig_template_field_options', 'ck_gig_template_field_options__code'],
      ['gig_template_requirements', 'ck_gig_template_requirements__reference'],
    ] as const)
      expect((await defs(t))[c], c).toContain('^[a-z][a-z0-9]*(_[a-z0-9]+)*$');
  });

  it('documents the schema objects: every new table, every meaningful new column and the new audit columns carry a comment (and say that rows are never deleted)', async () => {
    for (const t of NEW_TABLES) expect(await commentOn(t), t).toBeTruthy();
    for (const t of [T, M]) expect(await commentOn(t), t).toMatch(/never deleted/);
    expect(await commentOn(V)).toMatch(/never deleted/);
    for (const [t, cols] of [
      [T, ['service_type_id', 'code', 'name_content_key', 'description_content_key', 'instructions_content_key', 'status']],
      [V, ['version_number', 'status', 'revision', 'min_duration_minutes', 'pricing_fixed', 'area_radius', 'published_at', 'closed_at']],
      [F, ['field_key', 'section', 'behavior', 'customer_visible', 'label_content_key', 'default_content_key', 'min_number', 'max_items']],
      [O, ['label_content_key']],
      [R, ['reference_code']],
      [M, ['display_order']],
      [AUDIT, ['gig_template_id', 'gig_template_version_id']],
    ] as const)
      for (const c of cols) expect(await commentOn(t, c), `${t}.${c}`).toBeTruthy();
  });

  it('did not alter any older object: every column, constraint, index, trigger, function, relation and comment outside the catalog schema equals the schema migrated to 0015, every CAT-001 catalog object is unchanged, and audit_events keeps its columns and untouched constraints', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bananagig-mig-0015-'));
    const before = await createIsolatedDatabase({ migrate: false });
    const beforePool = createTestPool(before.url, 3);
    try {
      for (const f of readdirSync(migrationsDir()).filter((n) => /^00(0[1-9]|1[0-5])_.*\.sql$/.test(n)))
        copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
      expect(readdirSync(dir)).toHaveLength(15);
      await runMigrations({ url: before.url, dir });
      const a = await outsideCatalog(beforePool);
      const b = await outsideCatalog(seedPool);
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
      const [oldBefore, oldAfter] = [await oldCatalogObjects(beforePool), await oldCatalogObjects(seedPool)];
      for (const k of Object.keys(oldBefore) as (keyof typeof oldBefore)[]) {
        expect(oldAfter[k], k).toEqual(oldBefore[k]);
        expect(oldBefore[k].length, `${k} is not vacuous`).toBeGreaterThan(5);
      }
      // 0017 (the only change to a CAT-001 object): the comments that CAT-002 made stale now name the Gig Template subjects and consumers
      const comments = await seedPool.query(
        `SELECT obj_description('catalog.assert_status_transition(text, text)'::regprocedure, 'pg_proc') AS fn, obj_description('catalog.audit_events'::regclass, 'pg_class') AS audit,
                obj_description('catalog'::regnamespace, 'pg_namespace') AS schema`,
      );
      expect(comments.rows[0].fn).toMatch(/Gig Template identities/);
      expect(comments.rows[0].audit).toMatch(/Gig Template version together with its template/);
      expect(comments.rows[0].schema).toMatch(/Gig Templates/);
      // data: 0016 adds exactly 6 content entries / versions (30 content audit rows), 2 templates and 2 audit rows, and nothing else
      const counts = async (from: pg.Pool) =>
        (
          await from.query(
            `SELECT (SELECT count(*)::int FROM identity.accounts) AS accounts, (SELECT count(*)::int FROM integration.outbox_events) AS outbox,
                    (SELECT count(*)::int FROM configuration.parameters WHERE key NOT LIKE 'provider.registration.%') AS parameters,
                    (SELECT count(*)::int FROM configuration.audit_events a WHERE NOT EXISTS (SELECT 1 FROM configuration.parameters p WHERE p.parameter_id = a.parameter_id AND p.key LIKE 'provider.registration.%')) AS config_audit,
                    (SELECT count(*)::int FROM geography.markets) AS markets, (SELECT count(*)::int FROM geography.audit_events) AS geo_audit,
                    (SELECT count(*)::int FROM identity.account_sections) AS sections, (SELECT count(*)::int FROM identity.roles) AS roles,
                    (SELECT count(*)::int FROM content.locales) AS locales,
                    (SELECT count(*)::int FROM content.entries WHERE key NOT LIKE 'catalog.%' AND key NOT LIKE 'provider.registration.%') AS other_entries,
                    (SELECT count(*)::int FROM catalog.categories) AS categories, (SELECT count(*)::int FROM catalog.service_types) AS service_types,
                    (SELECT count(*)::int FROM catalog.market_categories) AS market_categories, (SELECT count(*)::int FROM catalog.audit_events WHERE action NOT LIKE 'GIG\\_TEMPLATE\\_%') AS old_audit`,
          )
        ).rows[0];
      expect(await counts(seedPool)).toEqual(await counts(beforePool));
      const total = (from: pg.Pool) =>
        from
          .query(
            // the provider registration copy of 0018 (provider.registration.*, 56 entries) is a later migration: only what 0016 added may differ
            `SELECT (SELECT count(*)::int FROM content.entries WHERE key NOT LIKE 'provider.registration.%') AS entries,
                    (SELECT count(*)::int FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key NOT LIKE 'provider.registration.%') AS versions,
                    (SELECT count(*)::int FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key NOT LIKE 'provider.registration.%') AS audit`,
          )
          .then((r) => r.rows[0] as { entries: number; versions: number; audit: number });
      const [x, y] = [await total(beforePool), await total(seedPool)];
      expect({ entries: y.entries - x.entries, versions: y.versions - x.versions, audit: y.audit - x.audit }).toEqual({ entries: 6, versions: 6, audit: 30 });
    } finally {
      await beforePool.end();
      await before.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is referenced from outside the schema only by the provider registration selections (0018) and references only reference data: content.entries, geography.markets and the catalogue itself', async () => {
    // migration 0018 (PRO-001) adds the ONE foreign key into the catalogue: a selected service type of a provider registration (asserted in full by provider-model.itest.ts)
    expect(
      await sq(
        `SELECT conrelid::regclass::text AS from_table, conname FROM pg_constraint
          WHERE contype = 'f' AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'catalog'::regnamespace) AND connamespace <> 'catalog'::regnamespace`,
      ),
    ).toEqual([{ from_table: 'provider.registration_service_types', conname: 'fk_registration_service_types__service_type_id' }]);
    expect(
      (
        await sq<{ target: string }>(
          `SELECT DISTINCT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND connamespace = 'catalog'::regnamespace AND confrelid::regclass::text NOT LIKE 'catalog.%' ORDER BY 1`,
        )
      ).map((r) => r.target),
    ).toEqual(['content.entries', 'geography.markets']);
  });

  it('contains no ALTER, DROP, DELETE or UPDATE of an older object in the migration text (but the audit CHECK replacement), and creates only six tables, four indexes, nine functions and twelve triggers', () => {
    const text = readFileSync(path.join(migrationsDir(), '0016_gig_templates.sql'), 'utf8');
    const body = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.startsWith('COMMENT ON'))
      .join('\n');
    expect(body).not.toMatch(
      /\b(DELETE\s+FROM|GRANT\s|REVOKE\s|CREATE\s+(OR\s+REPLACE\s+)?VIEW|CREATE\s+SEQUENCE|CREATE\s+EXTENSION|CREATE\s+TYPE|CREATE\s+POLICY|CREATE\s+SCHEMA)/i,
    );
    expect(body.replace(/BEFORE TRUNCATE/gi, '')).not.toMatch(/\bTRUNCATE\b/i);
    // the only ALTERs touch audit_events (add the columns and keys, drop and re-add the two CHECKs); the only DROPs are those two CHECKs
    expect([...body.matchAll(/\bALTER\s+TABLE\s+([\w.]+)/gi)].map((m) => m[1])).toEqual([
      'catalog.audit_events',
      'catalog.audit_events',
      'catalog.audit_events',
    ]);
    expect([...body.matchAll(/\bDROP\s+(\w+)\s+([\w.]+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)).toEqual([
      'CONSTRAINT ck_audit_events__action',
      'CONSTRAINT ck_audit_events__subject',
    ]);
    expect(body).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|TRIGGER|INDEX|SCHEMA|COLUMN)\b/i);
    expect(
      [...body.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(SCHEMA|TABLE|FUNCTION|TRIGGER|INDEX)\s+([\w.]+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`),
    ).toEqual([
      'FUNCTION catalog.assert_version_transition',
      'FUNCTION catalog.content_is_published',
      'TABLE catalog.gig_templates',
      'INDEX idx_gig_templates__service_type',
      'TABLE catalog.gig_template_versions',
      'INDEX uq_gig_template_versions__active',
      'INDEX uq_gig_template_versions__draft',
      'TABLE catalog.gig_template_fields',
      'TABLE catalog.gig_template_field_options',
      'INDEX uq_gig_template_field_options__default',
      'TABLE catalog.gig_template_requirements',
      'TABLE catalog.market_gig_templates',
      'FUNCTION catalog.guard_gig_templates',
      'TRIGGER trg_gig_templates__guard',
      'TRIGGER trg_gig_templates__no_truncate',
      'FUNCTION catalog.assert_version_publishable',
      'FUNCTION catalog.guard_gig_template_versions',
      'TRIGGER trg_gig_template_versions__guard',
      'TRIGGER trg_gig_template_versions__no_truncate',
      'FUNCTION catalog.guard_gig_template_fields',
      'TRIGGER trg_gig_template_fields__guard',
      'TRIGGER trg_gig_template_fields__no_truncate',
      'FUNCTION catalog.guard_gig_template_field_options',
      'TRIGGER trg_gig_template_field_options__guard',
      'TRIGGER trg_gig_template_field_options__no_truncate',
      'FUNCTION catalog.guard_gig_template_requirements',
      'TRIGGER trg_gig_template_requirements__guard',
      'TRIGGER trg_gig_template_requirements__no_truncate',
      'FUNCTION catalog.guard_market_gig_templates',
      'TRIGGER trg_market_gig_templates__guard',
      'TRIGGER trg_market_gig_templates__no_truncate',
    ]);
    // the UPDATEs: the two nested version updates of the guards (supersede, retire with the template) and the content lifecycle of the managed copy
    expect([...body.matchAll(/^\s*UPDATE\s+([a-z_]+\.[a-z_]+)/gim)].map((m) => m[1])).toEqual([
      'catalog.gig_template_versions',
      'catalog.gig_template_versions',
      'content.versions',
      'content.versions',
    ]);
    expect([...body.matchAll(/\bINSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1])).toEqual([
      'content.entries',
      'content.audit_events',
      'content.versions',
      'content.audit_events',
      'content.audit_events',
      'content.audit_events',
      'content.audit_events',
      'catalog.gig_templates',
      'catalog.audit_events',
    ]);
  });
});

// ====================================================================== B. the seed (read from a pristine database)
const SEEDED_TEMPLATES: [code: string, serviceType: string, name: string, description: string, instructions: string][] = [
  [
    'full_detail',
    'car_detailing',
    'Full Detail',
    'A complete interior and exterior detail of one vehicle.',
    'Describe what your detail includes, the products you use and what the customer needs to prepare. Customers see what you list here, so be specific.',
  ],
  [
    'standard_clean',
    'regular_cleaning',
    'Standard Clean',
    'A routine clean of a home, room by room.',
    'List the rooms and tasks included, what you bring and what you need from the customer before you arrive.',
  ],
];
const SEEDED_KEYS: { key: string; type: 'UI_LABEL' | 'PLAIN_TEXT'; body: string }[] = SEEDED_TEMPLATES.flatMap(([code, , name, description, instructions]) => [
  { key: gigTemplateNameKey(code), type: 'UI_LABEL' as const, body: name },
  { key: gigTemplateDescriptionKey(code), type: 'PLAIN_TEXT' as const, body: description },
  { key: gigTemplateInstructionsKey(code), type: 'PLAIN_TEXT' as const, body: instructions },
]);

describe('B. the seed: two DRAFT templates without versions, six managed copy entries and two audit rows; nothing public, no market data, la-oc untouched', () => {
  it('seeds exactly the two templates, both DRAFT, each under the documented service type, with the generated name key and the derived description and instructions keys', async () => {
    const rows = await sq<{
      code: string;
      service_type: string;
      status: string;
      name_content_key: string;
      description_content_key: string | null;
      instructions_content_key: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT t.code, st.code AS service_type, t.status, t.name_content_key, t.description_content_key, t.instructions_content_key, t.created_at, t.updated_at
         FROM ${T} t JOIN catalog.service_types st ON st.service_type_id = t.service_type_id ORDER BY t.code COLLATE "C"`,
    );
    expect(rows.map((r) => ({ ...r, created_at: undefined, updated_at: undefined }))).toEqual(
      SEEDED_TEMPLATES.map(([code, serviceType]) => ({
        code,
        service_type: serviceType,
        status: 'DRAFT',
        name_content_key: `catalog.gig_template.${code}.name`,
        description_content_key: `catalog.gig_template.${code}.description`,
        instructions_content_key: `catalog.gig_template.${code}.instructions`,
        created_at: undefined,
        updated_at: undefined,
      })).sort((a, b) => byName(a.code, b.code)),
    );
    for (const r of rows) expect(r.created_at.getTime(), r.code).toBe(r.updated_at.getTime());
    expect(await count(T, 'true', [], seedPool)).toBe(2);
  });

  it('agrees with the contract helpers: the keys derived by the code are exactly the stored generated and linked keys', async () => {
    for (const [code] of SEEDED_TEMPLATES) {
      const r = (
        await sq<{ name_content_key: string; description_content_key: string; instructions_content_key: string }>(
          `SELECT name_content_key, description_content_key, instructions_content_key FROM ${T} WHERE code = $1`,
          [code],
        )
      )[0]!;
      expect(r).toEqual({
        name_content_key: gigTemplateNameKey(code),
        description_content_key: gigTemplateDescriptionKey(code),
        instructions_content_key: gigTemplateInstructionsKey(code),
      });
    }
  });

  it('seeds NO version, field, option, requirement or market availability row, and nothing is ACTIVE, INACTIVE or RETIRED anywhere in the catalogue: nothing is public until an administrator acts', async () => {
    for (const t of [V, F, O, R, M, 'catalog.market_categories', 'catalog.market_service_types', 'catalog.prohibited_services'])
      expect(await count(t, 'true', [], seedPool), t).toBe(0);
    expect(
      await sq(
        "SELECT status FROM catalog.categories WHERE status <> 'DRAFT' UNION ALL SELECT status FROM catalog.service_types WHERE status <> 'DRAFT' UNION ALL SELECT status FROM catalog.gig_templates WHERE status <> 'DRAFT'",
      ),
    ).toEqual([]);
  });

  it('leaves the seeded market la-oc exactly as it was (PLANNED, no availability row of the catalogue, no change), and registers no market', async () => {
    expect(await sq('SELECT code, status, created_at = updated_at AS untouched FROM geography.markets ORDER BY code')).toEqual([
      { code: 'la-oc', status: 'PLANNED', untouched: true },
    ]);
    expect(await count('geography.audit_events', 'true', [], seedPool)).toBe(5); // the audit trail of 0007 / 0008 only
  });

  it('writes exactly two audit rows by system:migration, GIG_TEMPLATE_CREATED, one per template, with the status diff [null, DRAFT] and no other subject; the six CAT-001 rows are untouched', async () => {
    const rows = await sq<{
      actor: string;
      action: string;
      gig_template_id: string;
      gig_template_version_id: string | null;
      category_id: string | null;
      service_type_id: string | null;
      prohibited_service_id: string | null;
      market_id: string | null;
      changes: unknown;
      reason: string;
      correlation_id: string;
    }>(
      `SELECT actor, action, gig_template_id, gig_template_version_id, category_id, service_type_id, prohibited_service_id, market_id, changes, reason, correlation_id FROM ${AUDIT} WHERE action LIKE 'GIG\\_TEMPLATE\\_%'`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        actor: 'system:migration',
        action: 'GIG_TEMPLATE_CREATED',
        gig_template_version_id: null,
        category_id: null,
        service_type_id: null,
        prohibited_service_id: null,
        market_id: null,
        reason: 'Initial Gig Templates (migration 0016)',
        correlation_id: 'seed-0016',
        changes: { status: [null, 'DRAFT'] },
      });
    }
    expect(
      await sq(
        `SELECT c.code FROM ${T} c WHERE (SELECT count(*) FROM ${AUDIT} a WHERE a.gig_template_id = c.gig_template_id AND a.action = 'GIG_TEMPLATE_CREATED') <> 1`,
      ),
    ).toEqual([]);
    expect(await count(AUDIT, "correlation_id = 'seed-0015'", [], seedPool)).toBe(6);
    expect(await count(AUDIT, 'true', [], seedPool)).toBe(8);
  });

  it('seeds exactly the six catalog.gig_template.* entries (name, description and instructions of each template) and no other entry under that stem', async () => {
    const keys = (await sq<{ key: string }>(`SELECT key FROM content.entries WHERE key LIKE 'catalog.gig\\_template.%' ORDER BY key COLLATE "C"`)).map(
      (r) => r.key,
    );
    expect(keys).toEqual(SEEDED_KEYS.map((k) => k.key).sort(byName));
    expect(keys).toHaveLength(6);
    // no entry exists for a field: no version is seeded
    expect(keys.filter((k) => k.includes('.field.'))).toEqual([]);
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
      reason: string;
      created_by: string;
      approval_policy: string;
    }>(
      `SELECT e.key, count(*) OVER (PARTITION BY e.entry_id)::int AS n, v.locale, v.scope_type, v.scope_ref, v.version, v.status, v.effective_to IS NULL AS open,
              v.effective_from <= now() AS started, identity.consent_version_state(v.version_id, e.entry_id, now()) AS inforce, e.is_active AS active, e.max_scope_type,
              e.content_type, e.sensitivity, e.owner_role, v.body, v.reason, v.created_by, v.approval_policy
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'catalog.gig\\_template.%'`,
    );
    expect(rows).toHaveLength(6);
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
        reason: 'Initial Gig Template copy (migration 0016)',
        created_by: 'system:migration',
        approval_policy: 'NONE',
      });
      expect(r.body, r.key).toBe(r.body.trim());
      expect(r.body.length, r.key).toBeGreaterThan(0);
    }
  });

  it('writes the content audit trail exactly like the real workflow: five rows per entry, in order, by system:migration under the correlation seed-0016', async () => {
    expect(
      await sq(
        `SELECT DISTINCT a.reason FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key LIKE 'catalog.gig\\_template.%'`,
      ),
    ).toEqual([{ reason: 'Initial Gig Template copy (migration 0016)' }]);
    const rows = await sq<{ action: string; actor: string; correlation_id: string; n: number }>(
      `SELECT a.action, a.actor, a.correlation_id, count(*)::int AS n FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key LIKE 'catalog.gig\\_template.%' GROUP BY 1, 2, 3 ORDER BY 1`,
    );
    expect(rows).toEqual(
      ['ENTRY_CREATED', 'VERSION_ACTIVATED', 'VERSION_APPROVED', 'VERSION_DRAFTED', 'VERSION_PUBLISHED'].map((action) => ({
        action,
        actor: 'system:migration',
        correlation_id: 'seed-0016',
        n: 6,
      })),
    );
    const order = await sq<{ key: string; actions: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key LIKE 'catalog.gig\\_template.%' GROUP BY e.key`,
    );
    expect(order).toHaveLength(6);
    for (const o of order) expect(o.actions, o.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
  });

  it('resolves every key that a seeded template names to a PUBLISHED, in-force en-US entry, and catalog.content_is_published agrees (and refuses an unknown key and NULL)', async () => {
    const rows = await sq<{ code: string; kind: string; key: string; ok: boolean; db: boolean }>(
      `SELECT t.code, t.kind, t.key,
              EXISTS (SELECT 1 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id
                       WHERE e.key = t.key AND v.status = 'PUBLISHED' AND v.locale = 'en-US' AND identity.consent_version_state(v.version_id, e.entry_id, now()) = 'IN_FORCE') AS ok,
              catalog.content_is_published(t.key) AS db
         FROM (SELECT code, 'name' AS kind, name_content_key AS key FROM ${T} UNION ALL SELECT code, 'description', description_content_key FROM ${T}
               UNION ALL SELECT code, 'instructions', instructions_content_key FROM ${T}) t ORDER BY 1, 2`,
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) expect({ ok: r.ok, db: r.db }, `${r.kind} ${r.code}: ${r.key}`).toEqual({ ok: true, db: true });
    expect((await sq<{ r: boolean | null }>("SELECT catalog.content_is_published('catalog.gig_template.nope.name') AS r"))[0]!.r).toBe(false);
    expect((await sq<{ r: boolean | null }>('SELECT catalog.content_is_published(NULL) AS r'))[0]!.r).toBe(false);
  });

  it('renders non-empty, exact text for every seeded key with the content registry itself, in en-US, with and without a market in the context, in the public view', async () => {
    const content = new ContentService({ database: seed.database, env: 'test' });
    for (const k of SEEDED_KEYS) {
      expect((await content.render(k.key, { locale: 'en-US' })).value, k.key).toBe(k.body);
      expect((await content.render(k.key, { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false })).value, k.key).toBe(k.body);
    }
    const batch = await content.resolveRendered(
      SEEDED_KEYS.map((k) => k.key),
      { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false },
    );
    expect(batch.missing.size).toBe(0);
    expect(batch.items.size).toBe(6);
  });

  it('emits no outbox event, and the seeded templates can be taken through the whole life by the guards (rolled back): the seeded copy is enough for a publication', async () => {
    expect(await count('integration.outbox_events', 'true', [], seedPool)).toBe(0);
    const c = await seedPool.connect();
    try {
      await c.query('BEGIN');
      const t = (
        await q<{ gig_template_id: string; code: string; service_type_id: string; category_id: string }>(
          `SELECT t.gig_template_id, t.code, t.service_type_id, st.category_id FROM ${T} t JOIN catalog.service_types st ON st.service_type_id = t.service_type_id WHERE t.code = 'full_detail'`,
          [],
          c,
        )
      )[0]!;
      await expectRule(
        c.query('SAVEPOINT s1').then(() => setTpl(t.gig_template_id, 'ACTIVE', c)),
        'SERVICE_TYPE_NOT_ACTIVE',
      ); // the service type is still DRAFT
      await c.query('ROLLBACK TO s1');
      await setCat(t.category_id, 'ACTIVE', c);
      await setSt(t.service_type_id, 'ACTIVE', c);
      await setTpl(t.gig_template_id, 'ACTIVE', c);
      const v = await makeDraftWithField({ id: t.gig_template_id, code: t.code }, {}, c);
      await setVer(v.id, 'ACTIVE', c); // name, description and instructions are published by the seed; the field label by the helper
      expect((await verRow(v.id, c)).status).toBe('ACTIVE');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(await count(V, 'true', [], seedPool)).toBe(0);
  });

  it('refuses to change or delete a seeded row except through the documented switches: the seeded rows are still intact afterwards', async () => {
    await expect(seedPool.query(`DELETE FROM ${T} WHERE code = 'full_detail'`)).rejects.toMatchObject({ code: '23000', detail: 'catalog_rule:NOT_DELETABLE' });
    await expect(seedPool.query(`DELETE FROM ${T}`)).rejects.toMatchObject({ code: '23000', detail: 'catalog_rule:NOT_DELETABLE' });
    await expect(seedPool.query(`UPDATE ${T} SET code = 'renamed_template' WHERE code = 'full_detail'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'catalog_rule:IMMUTABLE_IDENTITY',
    });
    await expect(seedPool.query(`UPDATE ${T} SET status = 'ACTIVE' WHERE code = 'full_detail'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'catalog_rule:SERVICE_TYPE_NOT_ACTIVE',
    });
    await expect(seedPool.query(`UPDATE ${T} SET status = 'INACTIVE' WHERE code = 'full_detail'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'catalog_rule:STATUS_TRANSITION',
    });
    await expect(seedPool.query(`TRUNCATE ${T}`)).rejects.toMatchObject({ code: '0A000' }); // referenced by the audit trail
    await expect(seedPool.query(`TRUNCATE ${AUDIT}`)).rejects.toMatchObject({ code: '23000', detail: 'catalog_rule:ROW_IMMUTABLE' });
    expect(await sq(`SELECT code, status FROM ${T} ORDER BY code`)).toEqual([
      { code: 'full_detail', status: 'DRAFT' },
      { code: 'standard_clean', status: 'DRAFT' },
    ]);
    expect(await count(AUDIT, 'true', [], seedPool)).toBe(8);
  });

  it('holds no value that looks like a person in the seeded rows or the copy: no address, number, UUID or URL', async () => {
    const rows = await sq<{ v: string }>(
      `SELECT v FROM (SELECT code AS v FROM ${T} UNION ALL SELECT name_content_key FROM ${T} UNION ALL SELECT description_content_key FROM ${T} UNION ALL SELECT instructions_content_key FROM ${T}) t`,
    );
    for (const { v } of rows) expect(v, v).not.toMatch(/[@\s]|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d/i);
    for (const k of SEEDED_KEYS) expect(k.body, k.key).not.toMatch(/@|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d/i);
  });
});

// ====================================================================== C. every CHECK, foreign key, unique key and NOT NULL, by constraint name
const GOOD_CODES = ['ab', 'a1', 'a_b', 'a_1', 'a1_2b', 'detail_full', 'car_detailing_2', `a${'b'.repeat(47)}`, 'z9', 'a_b_c_d', 'x0'];
const BAD_CODES: [label: string, value: string][] = [
  ['an empty code', ''],
  ['a 1-character code', 'a'],
  ['an upper-case code', 'Full_detail'],
  ['an upper-case letter inside', 'full_Detail'],
  ['a leading digit', '1abc'],
  ['a leading underscore', '_abc'],
  ['a trailing underscore', 'abc_'],
  ['a double underscore', 'ab__cd'],
  ['a hyphen', 'ab-cd'],
  ['a space', 'ab cd'],
  ['a dot (a content key separator)', 'ab.cd'],
  ['an accented letter', 'caf' + String.fromCodePoint(0xe9)],
  ['a new line at the end', 'abc\n'],
  ['a 49-character code', `a${'b'.repeat(48)}`],
  ['a slash', 'a/b'],
  ['an apostrophe', "a'b"],
];

describe('C1. the code, field key, option code and reference code formats: the database and the contract accept the same strings', () => {
  it('accepts every good code (2 to 48 characters, digits, single underscores) and gives each its generated name key', async () => {
    const st = await makeSt();
    for (const code of GOOD_CODES) {
      await ensureContent(gigTemplateNameKey(code));
      const r = await q<{ name_content_key: string }>('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2) RETURNING name_content_key', [
        st.id,
        code,
      ]);
      expect(r[0]!.name_content_key, code).toBe(gigTemplateNameKey(code));
    }
  });

  it.each(BAD_CODES)('refuses %s on ck_gig_templates__code (the guard lets it through: the CHECK is the rule)', async (_label, value) => {
    const st = await makeSt();
    await expectConstraint(run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [st.id, value]), 'ck_gig_templates__code');
  });

  it('refuses a code update on the CHECK (guard out of the way) and on IMMUTABLE_IDENTITY (guard in force)', async () => {
    const t = await makeTpl();
    await expectConstraint(
      isolated(noTriggers(T), 'UPDATE catalog.gig_templates SET code = $2 WHERE gig_template_id = $1', [t.id, 'Bad Code']),
      'ck_gig_templates__code',
    );
    await expectRule(run('UPDATE catalog.gig_templates SET code = $2 WHERE gig_template_id = $1', [t.id, 'other_code']), 'IMMUTABLE_IDENTITY');
  });

  /** The CHECK of the table evaluated on its own: a temporary table carries exactly the definition text of the constraint, so it is the database's expression that is under test. */
  async function acceptedBy(table: string, constraint: string, column: string, values: string[]): Promise<boolean[]> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const def = (
        await c.query('SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass', [constraint, table])
      ).rows[0] as { d: string };
      await c.query(`CREATE TEMP TABLE probe_${constraint} (${column} text)`);
      await c.query(`ALTER TABLE probe_${constraint} ADD CONSTRAINT ${constraint} ${def.d}`);
      const out: boolean[] = [];
      for (const v of values) {
        await c.query('SAVEPOINT s');
        try {
          await c.query(`INSERT INTO probe_${constraint} (${column}) VALUES ($1)`, [v]);
          out.push(true);
        } catch (e) {
          expect((e as { code?: string }).code).toBe('23514');
          out.push(false);
        }
        await c.query('ROLLBACK TO s');
      }
      return out;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }
  const corpus = (): string[] => {
    const out = new Set<string>([
      '',
      'a',
      'ab',
      'a_',
      '_a',
      'a__b',
      'a_b',
      'A',
      'aB',
      'a-b',
      'a b',
      'a.b',
      '1a',
      'a1',
      'a_1',
      'a1_',
      '0',
      'x'.repeat(31),
      'x'.repeat(32),
      'x'.repeat(33),
      'x'.repeat(47),
      'x'.repeat(48),
      'x'.repeat(49),
      'a\n',
      'aé',
    ]);
    const alphabet = ['a', 'b', 'z', '0', '_', 'A', '-', ' '];
    for (let n = 1; n <= 4; n++) {
      const walk = (prefix: string): void => {
        out.add(prefix);
        if (prefix.length < n) for (const ch of alphabet) walk(prefix + ch);
      };
      if (n === 4) walk('');
    }
    return [...out];
  };
  it.each([
    ['gig_templates', 'ck_gig_templates__code', 'code', 2, 48],
    ['gig_template_fields', 'ck_gig_template_fields__key', 'field_key', 2, 32],
    ['gig_template_field_options', 'ck_gig_template_field_options__code', 'option_code', 2, 32],
    ['gig_template_requirements', 'ck_gig_template_requirements__reference', 'reference_code', 2, 48],
  ] as const)(
    '%s: agrees with the contract pattern and length on a corpus of more than four thousand strings (differential test of %s)',
    async (table, constraint, column, min, max) => {
      const values = corpus();
      expect(values.length).toBeGreaterThan(4000);
      const got = await acceptedBy(`catalog.${table}`, constraint, column, values);
      const pattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
      const mismatches = values.filter((v, i) => got[i] !== (pattern.test(v) && v.length >= min && v.length <= max)).slice(0, 10);
      expect(mismatches).toEqual([]);
      expect(got.filter(Boolean).length).toBeGreaterThan(100);
    },
  );
});

describe('C2. the description and instructions keys are links, not a free choice: NULL or exactly the convention of the row', () => {
  const KEYS = [
    ['description_content_key', gigTemplateDescriptionKey, 'ck_gig_templates__description_content_key', 'fk_gig_templates__description_content_key'],
    ['instructions_content_key', gigTemplateInstructionsKey, 'ck_gig_templates__instructions_content_key', 'fk_gig_templates__instructions_content_key'],
  ] as const;
  for (const [column, derive, ck, fk] of KEYS)
    it(`${column}: accepts NULL and the exact convention, refuses every other key (even an existing entry), by CHECK; the right key without an entry by the foreign key`, async () => {
      const st = await makeSt();
      const a = `gt_${++seq}`;
      const b = `gt_${++seq}`;
      for (const code of [a, b]) {
        await ensureContent(gigTemplateNameKey(code));
        await ensureContent(derive(code));
      }
      const insert = (code: string, key: string | null) =>
        run(`INSERT INTO catalog.gig_templates (service_type_id, code, ${column}) VALUES ($1, $2, $3)`, [st.id, code, key]);
      const wrong = [
        derive(b), // the key of ANOTHER row
        gigTemplateNameKey(a), // an existing entry of the wrong kind
        gigTemplateFieldLabelKey(a, 'abc'),
        `${derive(a)}.x`,
        derive(a).toUpperCase(),
        '',
        `catalog.gig_template.${a}.${column === 'description_content_key' ? 'instructions' : 'description'}`,
      ];
      for (const key of wrong) await expectConstraint(insert(a, key), ck);
      await insert(a, null);
      const t = (await q<{ gig_template_id: string }>('SELECT gig_template_id FROM catalog.gig_templates WHERE code = $1', [a]))[0]!.gig_template_id;
      // link, unlink and relink the own key, at any status; a foreign key is refused by UPDATE too
      await run(`UPDATE catalog.gig_templates SET ${column} = $2 WHERE gig_template_id = $1`, [t, derive(a)]);
      await run(`UPDATE catalog.gig_templates SET ${column} = NULL WHERE gig_template_id = $1`, [t]);
      await run(`UPDATE catalog.gig_templates SET ${column} = $2 WHERE gig_template_id = $1`, [t, derive(a)]);
      await expectConstraint(run(`UPDATE catalog.gig_templates SET ${column} = $2 WHERE gig_template_id = $1`, [t, derive(b)]), ck);
      // the convention without its entry: the foreign key
      const c = `gt_${++seq}`;
      await ensureContent(gigTemplateNameKey(c));
      await expectConstraint(insert(c, derive(c)), fk);
    });

  it('allows the link to be edited at every status, RETIRED included (it is not identity)', async () => {
    const t = await makeTpl({ status: 'RETIRED', copy: true });
    await run('UPDATE catalog.gig_templates SET description_content_key = NULL, instructions_content_key = NULL WHERE gig_template_id = $1', [t.id]);
    await run('UPDATE catalog.gig_templates SET description_content_key = $2 WHERE gig_template_id = $1', [t.id, gigTemplateDescriptionKey(t.code)]);
    expect((await tplRow(t.id)).status).toBe('RETIRED');
  });

  it('refuses a template whose NAME entry does not exist, on the foreign key of the generated column (the other kinds of key are checked in the test above)', async () => {
    const st = await makeSt();
    await expectConstraint(
      run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [st.id, `nokey_${++seq}`]),
      'fk_gig_templates__name_content_key',
    );
    const code = `later_${++seq}`;
    await expectConstraint(
      run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [st.id, code]),
      'fk_gig_templates__name_content_key',
    );
    await ensureEntry(gigTemplateNameKey(code)); // creating the entry afterwards makes the same insert succeed
    await run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [st.id, code]);
  });
});

describe('C3. gig_templates: unique code, status list, service type foreign key, NOT NULL', () => {
  it('refuses a second template with the same code ACROSS service types, even a retired one: a code is never reused', async () => {
    const t = await makeTpl({ status: 'RETIRED' });
    const other = await makeSt();
    await expectConstraint(run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [other.id, t.code]), 'uq_gig_templates__code');
    await expectConstraint(run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [t.stId, t.code]), 'uq_gig_templates__code');
  });

  it('refuses an unknown service type on the foreign key (the guard finds no status and lets it through)', async () => {
    const code = `fk_${++seq}`;
    await ensureEntry(gigTemplateNameKey(code));
    await expectConstraint(
      run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES (gen_random_uuid(), $1)', [code]),
      'fk_gig_templates__service_type_id',
    );
  });

  it('refuses a status outside the vocabulary on the CHECK when the guard is out of the way; the guard answers first with MUST_START_AS_DRAFT / STATUS_TRANSITION', async () => {
    const t = await makeTpl();
    for (const bogus of ['active', 'ARCHIVED', '', 'ACTIVE ', 'RETIRED\n', 'SUPERSEDED'])
      await expectConstraint(
        isolated(noTriggers(T), 'UPDATE catalog.gig_templates SET status = $2 WHERE gig_template_id = $1', [t.id, bogus]),
        'ck_gig_templates__status',
      );
    for (const bogus of ['active', 'ARCHIVED', '', 'ACTIVE ', 'SUPERSEDED']) await expectRule(setTpl(t.id, bogus), 'STATUS_TRANSITION');
    const st = await makeSt();
    const code = `bogus_${++seq}`;
    await ensureEntry(gigTemplateNameKey(code));
    await expectRule(
      run("INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, 'ARCHIVED')", [st.id, code]),
      'MUST_START_AS_DRAFT',
    );
  });

  it('refuses NULL in every NOT NULL column by column name, with the guards out of the way (the guard may answer a NULL differently, the constraint is the rule)', async () => {
    const st = await makeSt();
    const code = `nn_${++seq}`;
    await ensureEntry(gigTemplateNameKey(code));
    const values: Record<string, unknown> = {
      gig_template_id: '00000000-0000-4000-8000-000000000001',
      service_type_id: st.id,
      code,
      status: 'DRAFT',
      created_at: new Date(),
      updated_at: new Date(),
    };
    for (const column of Object.keys(values)) {
      const cols = Object.keys(values);
      const params = cols.map((c) => (c === column ? null : values[c]));
      await expectNotNull(
        isolated(noTriggers(T), `INSERT INTO catalog.gig_templates (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, params),
        column,
      );
    }
  });

  it('defaults status to DRAFT, ids to a fresh UUID and both timestamps to the transaction instant, and accepts NULL in the two optional keys', async () => {
    const t = await makeTpl();
    const r = (
      await q<{ status: string; created_at: Date; updated_at: Date; description_content_key: string | null; instructions_content_key: string | null }>(
        'SELECT status, created_at, updated_at, description_content_key, instructions_content_key FROM catalog.gig_templates WHERE gig_template_id = $1',
        [t.id],
      )
    )[0]!;
    expect(r).toMatchObject({ status: 'DRAFT', description_content_key: null, instructions_content_key: null });
    expect(r.created_at.getTime()).toBe(r.updated_at.getTime());
    expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------- versions
describe('C4. gig_template_versions: duration bounds, pricing and area flags, lifecycle, status list, uniqueness', () => {
  /** A new draft with the columns, on a template of its own (one draft per template). */
  const tryDraft = async (cols: VersionCols): Promise<unknown> => {
    const tpl = await makeTpl({ status: 'ACTIVE' });
    return makeVersion(tpl, cols);
  };

  const OK_DURATIONS: [string, VersionCols][] = [
    ['no bound at all', {}],
    ['a minimum of 1', { min_duration_minutes: 1 }],
    ['a maximum of 1', { max_duration_minutes: 1 }],
    ['min = max = 60', { min_duration_minutes: 60, max_duration_minutes: 60 }],
    ['min 30, max 120, suggested 60', { min_duration_minutes: 30, max_duration_minutes: 120, suggested_duration_minutes: 60 }],
    ['a suggested duration alone', { suggested_duration_minutes: 45 }],
    ['suggested = min', { min_duration_minutes: 30, max_duration_minutes: 120, suggested_duration_minutes: 30 }],
    ['suggested = max', { min_duration_minutes: 30, max_duration_minutes: 120, suggested_duration_minutes: 120 }],
    ['suggested above a lone minimum', { min_duration_minutes: 30, suggested_duration_minutes: 500 }],
    ['suggested below a lone maximum', { max_duration_minutes: 120, suggested_duration_minutes: 1 }],
    ['a large value', { max_duration_minutes: 2_147_483_647 }],
  ];
  const BAD_DURATIONS: [string, VersionCols][] = [
    ['a minimum of 0', { min_duration_minutes: 0 }],
    ['a negative minimum', { min_duration_minutes: -5 }],
    ['a maximum of 0', { max_duration_minutes: 0 }],
    ['a negative maximum', { max_duration_minutes: -1 }],
    ['a suggested duration of 0', { suggested_duration_minutes: 0 }],
    ['a negative suggested duration', { suggested_duration_minutes: -10 }],
    ['min above max', { min_duration_minutes: 61, max_duration_minutes: 60 }],
    ['suggested below min', { min_duration_minutes: 30, max_duration_minutes: 120, suggested_duration_minutes: 29 }],
    ['suggested above max', { min_duration_minutes: 30, max_duration_minutes: 120, suggested_duration_minutes: 121 }],
    ['suggested below a lone minimum', { min_duration_minutes: 30, suggested_duration_minutes: 29 }],
    ['suggested above a lone maximum', { max_duration_minutes: 120, suggested_duration_minutes: 121 }],
    ['a zero minimum with a valid rest', { min_duration_minutes: 0, max_duration_minutes: 60, suggested_duration_minutes: 30 }],
  ];
  it.each(OK_DURATIONS)('accepts %s', async (_label, cols) => {
    await tryDraft(cols);
  });
  it.each(BAD_DURATIONS)('refuses %s on ck_gig_template_versions__duration', async (_label, cols) => {
    await expectConstraint(tryDraft(cols), 'ck_gig_template_versions__duration');
  });
  it('applies the same duration rule to an UPDATE of a draft, and refuses NULL-ing nothing (every bound can be cleared again)', async () => {
    const v = await makeVersion(await makeTpl({ status: 'ACTIVE' }), { min_duration_minutes: 30, max_duration_minutes: 120, suggested_duration_minutes: 60 });
    await expectConstraint(
      run('UPDATE catalog.gig_template_versions SET max_duration_minutes = 20 WHERE gig_template_version_id = $1', [v.id]),
      'ck_gig_template_versions__duration',
    );
    await expectConstraint(
      run('UPDATE catalog.gig_template_versions SET suggested_duration_minutes = 0 WHERE gig_template_version_id = $1', [v.id]),
      'ck_gig_template_versions__duration',
    );
    await run(
      'UPDATE catalog.gig_template_versions SET min_duration_minutes = NULL, max_duration_minutes = NULL, suggested_duration_minutes = NULL WHERE gig_template_version_id = $1',
      [v.id],
    );
  });

  const OK_PRICING: [boolean, boolean, boolean, boolean][] = [
    [true, false, false, false],
    [false, true, false, false],
    [true, true, false, false],
    [true, false, true, true],
    [false, true, true, true],
  ];
  it.each(OK_PRICING)('pricing fixed=%s fixed_with_variants=%s bundle=%s drop=%s is accepted', async (fixed, variants, bundle, drop) => {
    await tryDraft({ pricing_fixed: fixed, pricing_fixed_with_variants: variants, pricing_bundle_eligible: bundle, pricing_drop_eligible: drop });
  });
  it.each([
    [false, false, false, false],
    [false, false, true, true],
    [false, false, true, false],
    [false, false, false, true],
  ] as const)(
    'pricing fixed=%s fixed_with_variants=%s bundle=%s drop=%s is refused: at least one of fixed / fixed_with_variants',
    async (fixed, variants, bundle, drop) => {
      await expectConstraint(
        tryDraft({ pricing_fixed: fixed, pricing_fixed_with_variants: variants, pricing_bundle_eligible: bundle, pricing_drop_eligible: drop }),
        'ck_gig_template_versions__pricing',
      );
    },
  );
  it.each([
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, true],
    [true, false, true],
  ] as const)('area radius=%s postal_codes=%s polygon=%s is accepted', async (radius, postal, polygon) => {
    await tryDraft({ area_radius: radius, area_postal_codes: postal, area_polygon: polygon });
  });
  it('refuses the empty area set on ck_gig_template_versions__area', async () => {
    await expectConstraint(tryDraft({ area_radius: false, area_postal_codes: false, area_polygon: false }), 'ck_gig_template_versions__area');
  });
  it('defaults to FIXED pricing, RADIUS area, no bundle / drop, revision 1, DRAFT and no timestamps of the lifecycle', async () => {
    const v = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    expect(
      (
        await q(
          'SELECT status, revision, pricing_fixed, pricing_fixed_with_variants, pricing_bundle_eligible, pricing_drop_eligible, area_radius, area_postal_codes, area_polygon, min_duration_minutes, max_duration_minutes, suggested_duration_minutes, published_at, closed_at FROM catalog.gig_template_versions WHERE gig_template_version_id = $1',
          [v.id],
        )
      )[0],
    ).toEqual({
      status: 'DRAFT',
      revision: 1,
      pricing_fixed: true,
      pricing_fixed_with_variants: false,
      pricing_bundle_eligible: false,
      pricing_drop_eligible: false,
      area_radius: true,
      area_postal_codes: false,
      area_polygon: false,
      min_duration_minutes: null,
      max_duration_minutes: null,
      suggested_duration_minutes: null,
      published_at: null,
      closed_at: null,
    });
  });

  // the lifecycle CHECK with the guard out of the way: every combination of status, published_at and closed_at
  const LIFECYCLE: [status: string, published: boolean, closed: boolean, ok: boolean][] = [
    ['DRAFT', false, false, true],
    ['DRAFT', true, false, false],
    ['DRAFT', false, true, false],
    ['DRAFT', true, true, false],
    ['ACTIVE', true, false, true],
    ['ACTIVE', false, false, false],
    ['ACTIVE', true, true, false],
    ['ACTIVE', false, true, false],
    ['SUPERSEDED', true, true, true],
    ['SUPERSEDED', true, false, false],
    ['SUPERSEDED', false, true, false],
    ['SUPERSEDED', false, false, false],
    ['RETIRED', false, true, true], // a discarded draft was never published
    ['RETIRED', true, true, true], // a withdrawn version was
    ['RETIRED', false, false, false],
    ['RETIRED', true, false, false],
  ];
  it.each(LIFECYCLE)('lifecycle status=%s published_at=%s closed_at=%s is %s', async (status, published, closed, ok) => {
    const tpl = await makeTpl({ status: 'ACTIVE' });
    const attempt = isolated(
      noTriggers(V),
      `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, published_at, closed_at) VALUES ($1, 1, $2, ${published ? 'now()' : 'NULL'}, ${closed ? 'now()' : 'NULL'})`,
      [tpl.id, status],
    );
    if (ok) await attempt;
    else await expectConstraint(attempt, 'ck_gig_template_versions__lifecycle');
  });

  it('refuses a status outside the vocabulary, a number below 1 and a revision below 1 on their CHECKs when the guard is out of the way', async () => {
    const tpl = await makeTpl({ status: 'ACTIVE' });
    // a status outside the vocabulary also breaks the lifecycle CHECK, which sorts (and is reported) first; the status CHECK is the second line and pinned by definition above
    for (const bogus of ['active', 'IN_REVIEW', '', 'INACTIVE'])
      expect(['ck_gig_template_versions__lifecycle', 'ck_gig_template_versions__status']).toContain(
        (
          await fail(
            isolated(noTriggers(V), 'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status) VALUES ($1, 1, $2)', [tpl.id, bogus]),
          )
        ).constraint,
      );
    for (const n of [0, -1])
      await expectConstraint(
        isolated(noTriggers(V), 'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, $2)', [tpl.id, n]),
        'ck_gig_template_versions__number',
      );
    for (const r of [0, -3])
      await expectConstraint(
        isolated(noTriggers(V), 'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, revision) VALUES ($1, 1, $2)', [tpl.id, r]),
        'ck_gig_template_versions__revision',
      );
    // with the guard in force the same inserts are answered by the rules
    await expectRule(
      run("INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status) VALUES ($1, 1, 'IN_REVIEW')", [tpl.id]),
      'MUST_START_AS_DRAFT',
    );
    await expectRule(run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 0)', [tpl.id]), 'VERSION_NUMBER_SEQUENCE');
    await expectRule(
      run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, revision) VALUES ($1, 1, 0)', [tpl.id]),
      'MUST_START_AS_DRAFT',
    );
  });

  it('keeps the numbers unique per template (the guard answers first, the key is the second line) and the same number in two templates is fine', async () => {
    const a = await makeTpl({ status: 'ACTIVE' });
    const b = await makeTpl({ status: 'ACTIVE' });
    await makeVersion(a);
    await makeVersion(b);
    await expectRule(run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 1)', [a.id]), 'VERSION_NUMBER_SEQUENCE');
    await expectConstraint(
      isolated(noTriggers(V), 'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 1)', [a.id]),
      'uq_gig_template_versions__number',
    );
  });

  it('allows ONE draft per template: a second draft is refused by the partial unique index even with a correct number; after the first is discarded the next draft is fine', async () => {
    const tpl = await makeTpl({ status: 'ACTIVE' });
    const v1 = await makeVersion(tpl);
    await expectConstraint(makeVersion(tpl), 'uq_gig_template_versions__draft');
    await setVer(v1.id, 'RETIRED');
    const v2 = await makeVersion(tpl);
    expect(v2.n).toBe(2);
    // another template is independent
    await makeVersion(await makeTpl({ status: 'ACTIVE' }));
  });

  it('allows ONE active version per template: the partial unique index refuses a second ACTIVE row when the guard is out of the way', async () => {
    const { t: tpl } = await makeLiveTemplate();
    await expectConstraint(
      isolated(
        noTriggers(V),
        "INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, published_at) VALUES ($1, 2, 'ACTIVE', now())",
        [tpl.id],
      ),
      'uq_gig_template_versions__active',
    );
    // SUPERSEDED / RETIRED rows are not limited
    await isolated(
      noTriggers(V),
      "INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, published_at, closed_at) VALUES ($1, 2, 'SUPERSEDED', now(), now()), ($1, 3, 'SUPERSEDED', now(), now()), ($1, 4, 'RETIRED', NULL, now())",
      [tpl.id],
    );
  });

  it('refuses an unknown template on the foreign key (the guard finds nothing, the number rule sees a first version)', async () => {
    await expectConstraint(
      run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES (gen_random_uuid(), 1)'),
      'fk_gig_template_versions__gig_template_id',
    );
  });

  it('refuses NULL in every NOT NULL column by column name, with the guards out of the way', async () => {
    const tpl = await makeTpl({ status: 'ACTIVE' });
    const values: Record<string, unknown> = {
      gig_template_version_id: '00000000-0000-4000-8000-000000000002',
      gig_template_id: tpl.id,
      version_number: 1,
      status: 'DRAFT',
      revision: 1,
      pricing_fixed: true,
      pricing_fixed_with_variants: false,
      pricing_bundle_eligible: false,
      pricing_drop_eligible: false,
      area_radius: true,
      area_postal_codes: false,
      area_polygon: false,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const cols = Object.keys(values);
    for (const column of cols)
      await expectNotNull(
        isolated(
          noTriggers(V),
          `INSERT INTO catalog.gig_template_versions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => (c === column ? null : values[c])),
        ),
        column,
      );
    expect(cols).toHaveLength(14); // of the 19 columns, the five optional ones (three durations, published_at, closed_at) accept NULL
  });
});

// ---------------------------------------------------------------- fields
describe('C5. gig_template_fields: vocabularies, key, order, the per-type metadata matrix, bounds, PLATFORM_FIXED and required media', () => {
  let v: Ver;
  beforeAll(async () => {
    v = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
  });
  const field = (s: FieldSpec) => addField(v, s);
  const ok = async (s: FieldSpec) => {
    const f = await field(s);
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
  };

  it.each([
    ['field_type', { type: 'FLOAT' }, 'ck_gig_template_fields__type'],
    ['field_type (case)', { type: 'text' }, 'ck_gig_template_fields__type'],
    ['section', { section: 'EXTRAS' }, 'ck_gig_template_fields__section'],
    ['section (empty)', { section: '' }, 'ck_gig_template_fields__section'],
    ['behavior', { behavior: 'OPTIONAL' }, 'ck_gig_template_fields__behavior'],
    ['behavior (case)', { behavior: 'provider_required' }, 'ck_gig_template_fields__behavior'],
  ] as [string, FieldSpec, string][])('refuses a %s outside the vocabulary', async (_n, spec, ck) => {
    await expectConstraint(field(spec), ck);
  });
  it('accepts every type, every section and every behaviour of the vocabulary (with the metadata the combination needs)', async () => {
    for (const section of GIG_TEMPLATE_SECTIONS) await ok({ section });
    for (const behavior of ['PROVIDER_CONFIGURABLE', 'PROVIDER_REQUIRED']) await ok({ behavior });
    for (const type of GIG_TEMPLATE_FIELD_TYPES) await ok({ type });
    await ok({ behavior: 'PLATFORM_FIXED', defaultText: true });
  });

  const GOOD_KEYS = ['ab', 'a1', 'finish', 'a_b', `a${'b'.repeat(31)}`, 'x0'];
  it.each(GOOD_KEYS)('accepts the field key %s', async (key) => {
    await ok({ key });
  });
  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['upper case', 'Finish'],
    ['33 characters', `a${'b'.repeat(32)}`],
    ['a hyphen', 'a-b'],
    ['a double underscore', 'a__b'],
    ['a trailing underscore', 'ab_'],
    ['a leading digit', '1ab'],
    ['a dot', 'a.b'],
  ])('refuses the field key (%s) on ck_gig_template_fields__key', async (_n, key) => {
    // the derived content key of a bad field key is not a valid content key: the guard compares text only, the CHECK is the rule
    await expectConstraint(addField(v, { key, labelKey: `catalog.gig_template.${v.code}.field.${key}.label` }), 'ck_gig_template_fields__key');
  });

  it.each([
    [1, true],
    [999, true],
    [500, true],
    [0, false],
    [1000, false],
    [-1, false],
  ])('display_order %i is %s (1..999)', async (order, accepted) => {
    const own = await makeVersion(await makeTpl({ status: 'ACTIVE' })); // a version of its own: the shared one keeps counting up
    const attempt = addField(own, { order });
    if (accepted) await attempt;
    else await expectConstraint(attempt, 'ck_gig_template_fields__display_order');
  });

  it('keeps the key and the order unique per VERSION: the same key or order in the same version is refused, in another version it is fine', async () => {
    const tpl = await makeTpl({ status: 'ACTIVE' });
    const a = await makeVersion(tpl);
    const f1 = await addField(a, { key: 'dupe_key', order: 7 });
    await expectConstraint(addField(a, { key: 'dupe_key', order: 8 }), 'uq_gig_template_fields__key');
    await expectConstraint(addField(a, { key: 'other_key', order: 7 }), 'uq_gig_template_fields__order');
    // an UPDATE onto an existing key / order too
    const f2 = await addField(a, { key: 'second_key', order: 9 });
    await expectRule(
      run('UPDATE catalog.gig_template_fields SET field_key = $2 WHERE gig_template_field_id = $1', [f2.id, f1.key]),
      'CONTENT_KEY_MISMATCH', // the label key no longer matches the new key: the guard answers before the unique key
    );
    await expectConstraint(
      run('UPDATE catalog.gig_template_fields SET field_key = $2, label_content_key = $3 WHERE gig_template_field_id = $1', [
        f2.id,
        f1.key,
        gigTemplateFieldLabelKey(a.code, f1.key),
      ]),
      'uq_gig_template_fields__key',
    );
    await expectConstraint(
      run('UPDATE catalog.gig_template_fields SET display_order = 7 WHERE gig_template_field_id = $1', [f2.id]),
      'uq_gig_template_fields__order',
    );
    await setVer(a.id, 'RETIRED');
    const b = await makeVersion(tpl);
    await addField(b, { key: 'dupe_key', order: 7 });
  });

  it('refuses an unknown version with VERSION_NOT_DRAFT (the guard reads no status; the foreign key never gets the chance): the rule is the answer', async () => {
    await expectRule(
      run(
        `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key)
         VALUES (gen_random_uuid(), 'abc', 'TEXT', 'PROVIDER_CONFIGURABLE', 1, 'catalog.gig_template.x.field.abc.label')`,
      ),
      'VERSION_NOT_DRAFT',
    );
  });

  it('refuses a content key that follows the derivation but has no entry, on the foreign key of the label, the help and the default (the entry of the others exists)', async () => {
    await expectConstraint(field({ content: 'MISSING' }), 'fk_gig_template_fields__label_content_key');
    const key = `fk_${++fieldSeq}`;
    await ensureContent(gigTemplateFieldLabelKey(v.code, key));
    await expectConstraint(addField(v, { key, helpKey: gigTemplateFieldHelpKey(v.code, key) }), 'fk_gig_template_fields__help_content_key');
    await expectConstraint(addField(v, { key, defaultKey: gigTemplateFieldDefaultKey(v.code, key) }), 'fk_gig_template_fields__default_content_key');
  });

  // ---- the per-type metadata matrix: a column that does not belong to the type must be NULL
  const COLUMNS: [column: string, spec: FieldSpec, constraint: string][] = [
    ['min_length', { minLength: 1 }, 'ck_gig_template_fields__text_meta'],
    ['max_length', { maxLength: 10 }, 'ck_gig_template_fields__text_meta'],
    ['default_content_key', { defaultText: true }, 'ck_gig_template_fields__text_meta'],
    ['min_number', { minNumber: 1 }, 'ck_gig_template_fields__number_meta'],
    ['max_number', { maxNumber: 10 }, 'ck_gig_template_fields__number_meta'],
    ['default_number', { defaultNumber: 5 }, 'ck_gig_template_fields__number_meta'],
    ['default_boolean', { defaultBoolean: true }, 'ck_gig_template_fields__boolean_meta'],
    ['min_items', { minItems: 1 }, 'ck_gig_template_fields__items_meta'],
    ['max_items', { maxItems: 3 }, 'ck_gig_template_fields__items_meta'],
  ];
  const BELONGS: Record<string, string[]> = {
    TEXT: ['min_length', 'max_length', 'default_content_key'],
    LONG_TEXT: ['min_length', 'max_length', 'default_content_key'],
    INTEGER: ['min_number', 'max_number', 'default_number'],
    DECIMAL: ['min_number', 'max_number', 'default_number'],
    DURATION: ['min_number', 'max_number', 'default_number'],
    BOOLEAN: ['default_boolean'],
    ENUM: [],
    MONEY: [],
    MEDIA: ['min_items', 'max_items'],
    EQUIPMENT_REFERENCE: ['min_items', 'max_items'],
    SKILL_REFERENCE: ['min_items', 'max_items'],
  };
  const MATRIX = GIG_TEMPLATE_FIELD_TYPES.flatMap((type) =>
    COLUMNS.map(([column, spec, ck]) => [type, column, spec, ck, BELONGS[type]!.includes(column)] as const),
  );
  it('has a matrix row for every type and every metadata column (11 x 9)', () => {
    expect(MATRIX).toHaveLength(99);
    expect(Object.keys(BELONGS).sort()).toEqual([...GIG_TEMPLATE_FIELD_TYPES].sort());
  });
  it.each(MATRIX)('%s . %s (belongs to the type: %s)', async (type, column, spec, ck, belongs) => {
    const attempt = field({ ...spec, type });
    if (belongs) await attempt;
    else await expectConstraint(attempt, ck);
  });
  it.each(GIG_TEMPLATE_FIELD_TYPES)('%s accepts ALL the columns of its own kind together and none else; every type accepts a help text', async (type) => {
    const all = BELONGS[type]!;
    const spec: FieldSpec = { type, help: true };
    if (all.includes('min_length')) Object.assign(spec, { minLength: 1, maxLength: 10, defaultText: true });
    if (all.includes('min_number')) Object.assign(spec, { minNumber: 1, maxNumber: 10, defaultNumber: 5 });
    if (all.includes('default_boolean')) Object.assign(spec, { defaultBoolean: false });
    if (all.includes('min_items')) Object.assign(spec, { minItems: 1, maxItems: 3 });
    await ok(spec);
  });

  // ---- bounds
  const bounds: [string, FieldSpec, string | null][] = [
    ['TEXT min_length 0', { type: 'TEXT', minLength: 0 }, 'ck_gig_template_fields__length'],
    ['TEXT max_length 0', { type: 'TEXT', maxLength: 0 }, 'ck_gig_template_fields__length'],
    ['TEXT negative min_length', { type: 'TEXT', minLength: -1 }, 'ck_gig_template_fields__length'],
    ['LONG_TEXT min above max', { type: 'LONG_TEXT', minLength: 11, maxLength: 10 }, 'ck_gig_template_fields__length'],
    ['LONG_TEXT min = max', { type: 'LONG_TEXT', minLength: 10, maxLength: 10 }, null],
    ['TEXT min 1 alone', { type: 'TEXT', minLength: 1 }, null],
    ['TEXT max alone (large)', { type: 'TEXT', maxLength: 2_000_000 }, null],
    ['INTEGER min above max', { type: 'INTEGER', minNumber: 10, maxNumber: 9 }, 'ck_gig_template_fields__number_order'],
    ['INTEGER default below min', { type: 'INTEGER', minNumber: 5, defaultNumber: 4 }, 'ck_gig_template_fields__number_order'],
    ['INTEGER default above max', { type: 'INTEGER', maxNumber: 5, defaultNumber: 6 }, 'ck_gig_template_fields__number_order'],
    ['INTEGER default alone', { type: 'INTEGER', defaultNumber: -7 }, null],
    ['INTEGER negative bounds are fine', { type: 'INTEGER', minNumber: -10, maxNumber: -1, defaultNumber: -5 }, null],
    ['INTEGER min = max = default', { type: 'INTEGER', minNumber: 3, maxNumber: 3, defaultNumber: 3 }, null],
    ['INTEGER zero is a value', { type: 'INTEGER', minNumber: 0, defaultNumber: 0 }, null],
    ['INTEGER 1.5 is not whole (min)', { type: 'INTEGER', minNumber: '1.5' }, 'ck_gig_template_fields__number_shape'],
    ['INTEGER 1.5 is not whole (max)', { type: 'INTEGER', maxNumber: '1.5' }, 'ck_gig_template_fields__number_shape'],
    ['INTEGER 1.5 is not whole (default)', { type: 'INTEGER', defaultNumber: '1.5' }, 'ck_gig_template_fields__number_shape'],
    ['INTEGER 0.0001 is not whole', { type: 'INTEGER', defaultNumber: '0.0001' }, 'ck_gig_template_fields__number_shape'],
    ['INTEGER 2.0000 is whole', { type: 'INTEGER', defaultNumber: '2.0000' }, null],
    ['DECIMAL 1.5 is fine', { type: 'DECIMAL', minNumber: '0.5', maxNumber: '1.5', defaultNumber: '1.25' }, null],
    ['DECIMAL 4 decimals', { type: 'DECIMAL', defaultNumber: '0.0001' }, null],
    ['DECIMAL negative', { type: 'DECIMAL', minNumber: '-1.5' }, null],
    ['DECIMAL default above max', { type: 'DECIMAL', maxNumber: '1.5', defaultNumber: '1.5001' }, 'ck_gig_template_fields__number_order'],
    ['DECIMAL min above max by one step', { type: 'DECIMAL', minNumber: '1.0001', maxNumber: '1.0000' }, 'ck_gig_template_fields__number_order'],
    ['DECIMAL largest value of numeric(18,4)', { type: 'DECIMAL', maxNumber: '99999999999999.9999' }, null],
    ['DURATION 0', { type: 'DURATION', defaultNumber: 0 }, 'ck_gig_template_fields__duration_positive'],
    ['DURATION negative min', { type: 'DURATION', minNumber: -5 }, 'ck_gig_template_fields__duration_positive'],
    ['DURATION 0 max', { type: 'DURATION', maxNumber: 0 }, 'ck_gig_template_fields__duration_positive'],
    ['DURATION 0.5 (not whole, not positive minutes)', { type: 'DURATION', defaultNumber: '0.5' }, 'ck_gig_template_fields__duration_positive'],
    ['DURATION 90.5 is not whole', { type: 'DURATION', defaultNumber: '90.5' }, 'ck_gig_template_fields__number_shape'],
    ['DURATION 1 minute', { type: 'DURATION', minNumber: 1, maxNumber: 480, defaultNumber: 60 }, null],
    ['MEDIA min_items -1', { type: 'MEDIA', minItems: -1 }, 'ck_gig_template_fields__items'],
    ['MEDIA max_items -1', { type: 'MEDIA', maxItems: -1 }, 'ck_gig_template_fields__items'],
    ['MEDIA min above max', { type: 'MEDIA', minItems: 3, maxItems: 2 }, 'ck_gig_template_fields__items'],
    ['MEDIA max 0 means no photos', { type: 'MEDIA', maxItems: 0 }, null],
    ['MEDIA min 0 max 0', { type: 'MEDIA', minItems: 0, maxItems: 0 }, null],
    ['MEDIA min = max', { type: 'MEDIA', minItems: 2, maxItems: 2 }, null],
    ['EQUIPMENT_REFERENCE max 0', { type: 'EQUIPMENT_REFERENCE', maxItems: 0 }, 'ck_gig_template_fields__items'],
    ['SKILL_REFERENCE max 0', { type: 'SKILL_REFERENCE', maxItems: 0 }, 'ck_gig_template_fields__items'],
    ['SKILL_REFERENCE min 0 max 1', { type: 'SKILL_REFERENCE', minItems: 0, maxItems: 1 }, null],
    ['SKILL_REFERENCE min alone', { type: 'SKILL_REFERENCE', minItems: 5 }, null],
    ['EQUIPMENT_REFERENCE max alone', { type: 'EQUIPMENT_REFERENCE', maxItems: 4 }, null],
    ['EQUIPMENT_REFERENCE min above max', { type: 'EQUIPMENT_REFERENCE', minItems: 5, maxItems: 4 }, 'ck_gig_template_fields__items'],
  ];
  it.each(bounds)('%s', async (_n, spec, ck) => {
    const attempt = field(spec);
    if (ck === null) await attempt;
    else await expectConstraint(attempt, ck);
  });
  it('refuses a number beyond numeric(18,4) with a numeric overflow (22003), and rounds a fifth decimal instead of refusing it', async () => {
    expect(await fail(field({ type: 'DECIMAL', maxNumber: '100000000000000' }))).toMatchObject({ code: '22003' });
    const f = await field({ type: 'DECIMAL', defaultNumber: '1.23456' });
    expect(
      (await q<{ default_number: string }>('SELECT default_number::text FROM catalog.gig_template_fields WHERE gig_template_field_id = $1', [f.id]))[0]!
        .default_number,
    ).toBe('1.2346');
  });

  // ---- PLATFORM_FIXED: only a type with a default can be fixed, and then the default is mandatory
  const FIXED_WITH: [string, FieldSpec][] = [
    ['TEXT', { type: 'TEXT', defaultText: true }],
    ['LONG_TEXT', { type: 'LONG_TEXT', defaultText: true }],
    ['INTEGER', { type: 'INTEGER', defaultNumber: 5 }],
    ['INTEGER 0', { type: 'INTEGER', defaultNumber: 0 }],
    ['DECIMAL', { type: 'DECIMAL', defaultNumber: '2.5' }],
    ['DURATION', { type: 'DURATION', defaultNumber: 60 }],
    ['BOOLEAN true', { type: 'BOOLEAN', defaultBoolean: true }],
    ['BOOLEAN false (a value, not a missing one)', { type: 'BOOLEAN', defaultBoolean: false }],
    ['ENUM (the default OPTION is checked at publication)', { type: 'ENUM' }],
  ];
  it.each(FIXED_WITH)('PLATFORM_FIXED %s with its default is accepted', async (_n, spec) => {
    await ok({ ...spec, behavior: 'PLATFORM_FIXED' });
  });
  const FIXED_WITHOUT: [string, FieldSpec][] = [
    ['TEXT', { type: 'TEXT' }],
    ['LONG_TEXT', { type: 'LONG_TEXT', minLength: 1 }],
    ['INTEGER', { type: 'INTEGER', minNumber: 1 }],
    ['DECIMAL', { type: 'DECIMAL' }],
    ['DURATION', { type: 'DURATION', minNumber: 1, maxNumber: 60 }],
    ['BOOLEAN', { type: 'BOOLEAN' }],
  ];
  it.each(FIXED_WITHOUT)('PLATFORM_FIXED %s WITHOUT its default is refused on ck_gig_template_fields__fixed', async (_n, spec) => {
    await expectConstraint(field({ ...spec, behavior: 'PLATFORM_FIXED' }), 'ck_gig_template_fields__fixed');
  });
  it.each([
    ['MONEY', { type: 'MONEY' }],
    ['MEDIA', { type: 'MEDIA', minItems: 1, maxItems: 3 }],
    ['MEDIA without metadata', { type: 'MEDIA' }],
    ['EQUIPMENT_REFERENCE', { type: 'EQUIPMENT_REFERENCE', maxItems: 2 }],
    ['SKILL_REFERENCE', { type: 'SKILL_REFERENCE' }],
  ] as [string, FieldSpec][])("PLATFORM_FIXED %s is refused whatever the metadata: such a field is always the provider's", async (_n, spec) => {
    await expectConstraint(field({ ...spec, behavior: 'PLATFORM_FIXED' }), 'ck_gig_template_fields__fixed');
  });
  it('lets a provider-behaviour field of every fixed-capable type go without any default', async () => {
    for (const type of FIXED_CAPABLE_FIELD_TYPES) for (const behavior of ['PROVIDER_CONFIGURABLE', 'PROVIDER_REQUIRED']) await ok({ type, behavior });
  });

  // ---- required media
  it.each([
    ['REQUIRED with min 1 and max 5', { minItems: 1, maxItems: 5 }, null],
    ['REQUIRED with min 1 and no max', { minItems: 1 }, null],
    ['REQUIRED with min 3 max 3', { minItems: 3, maxItems: 3 }, null],
    ['REQUIRED without any metadata', {}, 'ck_gig_template_fields__media_required'],
    ['REQUIRED with min 0', { minItems: 0, maxItems: 5 }, 'ck_gig_template_fields__media_required'],
    ['REQUIRED with a max only', { maxItems: 5 }, 'ck_gig_template_fields__media_required'],
    ['REQUIRED with max 0 (no photos can never be required)', { maxItems: 0 }, 'ck_gig_template_fields__media_required'],
    ['REQUIRED with min 0 and max 0', { minItems: 0, maxItems: 0 }, 'ck_gig_template_fields__media_required'],
    ['REQUIRED with min 1 and max 0', { minItems: 1, maxItems: 0 }, 'ck_gig_template_fields__items'], // alphabetically the first violated CHECK
  ] as [string, FieldSpec, string | null][])('MEDIA %s', async (_n, spec, ck) => {
    const attempt = field({ ...spec, type: 'MEDIA', behavior: 'PROVIDER_REQUIRED' });
    if (ck === null) await attempt;
    else await expectConstraint(attempt, ck);
  });
  it('lets optional media be anything the item rules allow, "no photos" included; a required reference field needs no minimum', async () => {
    await ok({ type: 'MEDIA', behavior: 'PROVIDER_CONFIGURABLE' });
    await ok({ type: 'MEDIA', behavior: 'PROVIDER_CONFIGURABLE', minItems: 0, maxItems: 0 });
    await ok({ type: 'SKILL_REFERENCE', behavior: 'PROVIDER_REQUIRED' });
    await ok({ type: 'EQUIPMENT_REFERENCE', behavior: 'PROVIDER_REQUIRED', minItems: 0 });
  });

  it('refuses NULL in every NOT NULL column by column name, with the guards out of the way (and accepts NULL in help, default and the metadata)', async () => {
    const tpl = await makeTpl({ status: 'ACTIVE' });
    const ver = await makeVersion(tpl);
    const key = 'nn_field';
    await ensureEntry(gigTemplateFieldLabelKey(ver.code, key));
    const values: Record<string, unknown> = {
      gig_template_field_id: '00000000-0000-4000-8000-000000000003',
      gig_template_version_id: ver.id,
      field_key: key,
      field_type: 'TEXT',
      section: 'DETAILS',
      behavior: 'PROVIDER_CONFIGURABLE',
      customer_visible: true,
      display_order: 1,
      label_content_key: gigTemplateFieldLabelKey(ver.code, key),
    };
    const cols = Object.keys(values);
    for (const column of cols)
      await expectNotNull(
        isolated(
          noTriggers(F),
          `INSERT INTO catalog.gig_template_fields (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => (c === column ? null : values[c])),
        ),
        column,
      );
    await isolated(
      noTriggers(F),
      `INSERT INTO catalog.gig_template_fields (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => values[c]),
    );
    expect(cols).toHaveLength(9);
  });

  it('defaults section to DETAILS, customer_visible to true and every metadata column to NULL', async () => {
    const f = await addField(v, { key: `dflt_${++fieldSeq}` });
    expect(
      (
        await q(
          'SELECT section, customer_visible, help_content_key, default_content_key, min_length, max_length, min_number, max_number, default_number, default_boolean, min_items, max_items FROM catalog.gig_template_fields WHERE gig_template_field_id = $1',
          [f.id],
        )
      )[0],
    ).toEqual({
      section: 'DETAILS',
      customer_visible: true,
      help_content_key: null,
      default_content_key: null,
      min_length: null,
      max_length: null,
      min_number: null,
      max_number: null,
      default_number: null,
      default_boolean: null,
      min_items: null,
      max_items: null,
    });
  });
});

describe('C5b. the database and the contract agree on the field rules (a differential test of fieldIssues against the CHECK matrix)', () => {
  it('accepts exactly what the contract accepts over the whole product of type, behaviour and metadata presence (the checks that need the options are the publication rules, below)', async () => {
    const v = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    const mismatches: string[] = [];
    let accepted = 0;
    let checked = 0;
    const numbers: (number | undefined)[] = [undefined, 0, 1, 5, 10, 11];
    const items: (number | undefined)[] = [undefined, 0, 1, 3];
    /** Inserts the row with the derived label key and NO entry for it: a statement whose CHECKs and guard accept it is stopped by the foreign key of the label, and only by that one. */
    const probe = async (type: string, behavior: string, spec: FieldSpec): Promise<boolean> => {
      const key = 'probe_field';
      const e = await rejection(
        pool.query(
          `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key, default_content_key, min_length, max_length, min_number, max_number, default_number, default_boolean, min_items, max_items)
           VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            v.id,
            key,
            type,
            behavior,
            gigTemplateFieldLabelKey(v.code, key),
            spec.defaultText ? gigTemplateFieldDefaultKey(v.code, key) : null,
            spec.minLength ?? null,
            spec.maxLength ?? null,
            spec.minNumber ?? null,
            spec.maxNumber ?? null,
            spec.defaultNumber ?? null,
            spec.defaultBoolean ?? null,
            spec.minItems ?? null,
            spec.maxItems ?? null,
          ],
        ),
      );
      return (e as PgFailure | undefined)?.constraint === 'fk_gig_template_fields__label_content_key';
    };
    for (const fieldType of GIG_TEMPLATE_FIELD_TYPES)
      for (const behavior of GIG_TEMPLATE_FIELD_BEHAVIORS) {
        // ENUM PLATFORM_FIXED needs a default option (a publication rule in the database, a field rule in the contract): not comparable here
        if (fieldType === 'ENUM' && behavior === 'PLATFORM_FIXED') continue;
        const isText = fieldType === 'TEXT' || fieldType === 'LONG_TEXT';
        const isNumeric = fieldType === 'INTEGER' || fieldType === 'DECIMAL' || fieldType === 'DURATION';
        const isItems = fieldType === 'MEDIA' || fieldType === 'EQUIPMENT_REFERENCE' || fieldType === 'SKILL_REFERENCE';
        const specs: FieldSpec[] = [];
        if (isText)
          for (const lo of [undefined, 1, 5])
            for (const hi of [undefined, 1, 10]) for (const dt of [false, true]) specs.push({ minLength: lo, maxLength: hi, defaultText: dt });
        if (isNumeric)
          for (const lo of numbers) for (const hi of numbers) for (const df of numbers) specs.push({ minNumber: lo, maxNumber: hi, defaultNumber: df });
        if (fieldType === 'BOOLEAN') for (const b of [undefined, true, false]) specs.push({ defaultBoolean: b });
        if (isItems) for (const lo of items) for (const hi of items) specs.push({ minItems: lo, maxItems: hi });
        if (specs.length === 0) specs.push({});
        // one column of a foreign kind, to prove the refusal of the matrix against the contract
        specs.push({ minLength: 1 }, { defaultBoolean: true }, { minNumber: 1 }, { maxItems: 1 }, { defaultText: true });
        for (const spec of specs) {
          const contract = fieldIssues({
            key: 'probe_field',
            fieldType,
            behavior,
            section: 'DETAILS',
            customerVisible: true,
            withHelp: false,
            withDefaultText: spec.defaultText ?? false,
            minLength: spec.minLength ?? undefined,
            maxLength: spec.maxLength ?? undefined,
            minNumber: (spec.minNumber as number | undefined) ?? undefined,
            maxNumber: (spec.maxNumber as number | undefined) ?? undefined,
            defaultNumber: (spec.defaultNumber as number | undefined) ?? undefined,
            defaultBoolean: spec.defaultBoolean ?? undefined,
            minItems: spec.minItems ?? undefined,
            maxItems: spec.maxItems ?? undefined,
            options: [],
          } as never);
          const dbOk = await probe(fieldType, behavior, spec);
          checked++;
          if (dbOk) accepted++;
          if (dbOk !== (contract.length === 0))
            mismatches.push(
              `${fieldType}/${behavior}/${JSON.stringify(spec)}: database ${dbOk ? 'accepts' : 'refuses'}, contract ${contract.length === 0 ? 'accepts' : JSON.stringify(contract.map((i) => i.path))}`,
            );
        }
      }
    expect(mismatches.slice(0, 15)).toEqual([]);
    expect(checked).toBeGreaterThan(1500);
    expect(accepted).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------- options
describe('C6. gig_template_field_options: code, order, one default per field, content label', () => {
  let v: Ver;
  let enumField: (key?: string) => Promise<FieldRef>;
  beforeAll(async () => {
    v = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    enumField = (key) => addField(v, { type: 'ENUM', key });
  });

  it.each(['ab', 'a1', 'wax', 'ceramic_coat', `a${'b'.repeat(31)}`, 'x0'])('accepts the option code %s', async (code) => {
    await addOption(await enumField(), code);
  });
  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['upper case', 'Wax'],
    ['33 characters', `a${'b'.repeat(32)}`],
    ['a hyphen', 'a-b'],
    ['a double underscore', 'a__b'],
    ['a dot', 'a.b'],
    ['a leading digit', '1ab'],
  ])('refuses the option code (%s) on ck_gig_template_field_options__code', async (_n, code) => {
    const f = await enumField();
    await expectConstraint(
      addOption(f, code, { labelKey: `catalog.gig_template.${f.code}.field.${f.key}.option.${code}.label` }),
      'ck_gig_template_field_options__code',
    );
  });

  it.each([
    [1, true],
    [99, true],
    [50, true],
    [0, false],
    [100, false],
    [-1, false],
  ])('option display_order %i is %s (1..99)', async (order, accepted) => {
    const f = await enumField();
    const attempt = addOption(f, 'opt', { order });
    if (accepted) await attempt;
    else await expectConstraint(attempt, 'ck_gig_template_field_options__display_order');
  });

  it('keeps the code (the primary key) and the order unique per FIELD, and lets two fields share both', async () => {
    const f = await enumField();
    const g = await enumField();
    await addOption(f, 'wax', { order: 1 });
    await expectConstraint(addOption(f, 'wax', { order: 2 }), 'pk_gig_template_field_options');
    await expectConstraint(addOption(f, 'sealant', { order: 1 }), 'uq_gig_template_field_options__order');
    await addOption(g, 'wax', { order: 1 });
    await addOption(g, 'sealant', { order: 2 });
    // an UPDATE onto an existing order
    await expectConstraint(
      run('UPDATE catalog.gig_template_field_options SET display_order = 1 WHERE gig_template_field_id = $1 AND option_code = $2', [g.id, 'sealant']),
      'uq_gig_template_field_options__order',
    );
  });

  it('allows ONE default option per field: a second default is refused, a default can be moved (unset, then set), and any number of non-defaults is fine', async () => {
    const f = await enumField();
    await addOption(f, 'wax', { isDefault: true });
    await expectConstraint(addOption(f, 'sealant', { isDefault: true }), 'uq_gig_template_field_options__default');
    await addOption(f, 'sealant');
    await addOption(f, 'ceramic');
    await expectConstraint(
      run('UPDATE catalog.gig_template_field_options SET is_default = true WHERE gig_template_field_id = $1 AND option_code = $2', [f.id, 'sealant']),
      'uq_gig_template_field_options__default',
    );
    await run('UPDATE catalog.gig_template_field_options SET is_default = false WHERE gig_template_field_id = $1 AND option_code = $2', [f.id, 'wax']);
    await run('UPDATE catalog.gig_template_field_options SET is_default = true WHERE gig_template_field_id = $1 AND option_code = $2', [f.id, 'sealant']);
    // two fields each have their own default
    const g = await enumField();
    await addOption(g, 'wax', { isDefault: true });
    expect(await count(O, 'gig_template_field_id = ANY($1) AND is_default', [[f.id, g.id]])).toBe(2);
  });

  it('refuses a label key that follows the derivation but has no entry, on the foreign key; and an unknown field with VERSION_NOT_DRAFT (the guard finds no version)', async () => {
    const f = await enumField();
    await expectConstraint(addOption(f, 'nolabel', { content: 'MISSING' }), 'fk_gig_template_field_options__label_content_key');
    await expectRule(
      run(
        `INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order)
         VALUES (gen_random_uuid(), 'wax', 'catalog.gig_template.x.field.y.option.wax.label', 1)`,
      ),
      'VERSION_NOT_DRAFT',
    );
  });

  it('refuses NULL in every NOT NULL column by column name, with the guards out of the way', async () => {
    const f = await enumField();
    const values: Record<string, unknown> = {
      gig_template_field_id: f.id,
      option_code: 'nn_opt',
      label_content_key: gigTemplateOptionLabelKey(f.code, f.key, 'nn_opt'),
      is_default: false,
      display_order: 1,
    };
    const cols = Object.keys(values);
    for (const column of cols)
      await expectNotNull(
        isolated(
          noTriggers(O),
          `INSERT INTO catalog.gig_template_field_options (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => (c === column ? null : values[c])),
        ),
        column,
      );
  });
});

// ---------------------------------------------------------------- requirements
describe('C7. gig_template_requirements: type, opaque reference code, uniqueness with NULLS NOT DISTINCT', () => {
  let v: Ver;
  beforeAll(async () => {
    v = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
  });
  it.each(GIG_TEMPLATE_REQUIREMENT_TYPES)('accepts the requirement type %s without and with a reference code (one row each)', async (type) => {
    const own = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    await addReq(own.id, type);
    await addReq(own.id, type, 'some_reference');
  });
  it.each(['skill', 'CERT', '', 'INSURANCE ', 'BACKGROUND'])('refuses the requirement type %j', async (type) => {
    await expectConstraint(addReq(v.id, type), 'ck_gig_template_requirements__type');
  });
  it.each(['ab', 'detailing_pro', `a${'b'.repeat(47)}`, 'x0'])('accepts the reference code %s', async (ref) => {
    await addReq((await makeVersion(await makeTpl({ status: 'ACTIVE' }))).id, 'SKILL', ref);
  });
  it.each(['', 'a', 'Detailing', 'a-b', 'a__b', 'a.b', `a${'b'.repeat(48)}`, '1ab', 'ab_'])('refuses the reference code %j', async (ref) => {
    await expectConstraint(addReq(v.id, 'SKILL', ref), 'ck_gig_template_requirements__reference');
  });
  it('keeps (version, type, reference) unique and treats two NULL references as EQUAL (NULLS NOT DISTINCT): the type in general can be required once', async () => {
    const own = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    await addReq(own.id, 'SKILL');
    await expectConstraint(addReq(own.id, 'SKILL'), 'uq_gig_template_requirements__requirement');
    await addReq(own.id, 'SKILL', 'a_skill');
    await expectConstraint(addReq(own.id, 'SKILL', 'a_skill'), 'uq_gig_template_requirements__requirement');
    await addReq(own.id, 'SKILL', 'b_skill');
    await addReq(own.id, 'EQUIPMENT'); // another type with a NULL reference
    await addReq(own.id, 'EQUIPMENT', 'a_skill'); // another type with the same reference
    // another version of another template may repeat every row
    const other = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    await addReq(other.id, 'SKILL');
    await addReq(other.id, 'SKILL', 'a_skill');
  });
  it('validates nothing about the reference code beyond its shape: it is opaque (the catalogue arrives with TRUST-001)', async () => {
    await addReq((await makeVersion(await makeTpl({ status: 'ACTIVE' }))).id, 'LICENSE', 'no_such_catalogue_entry');
  });
  it('refuses an unknown version with VERSION_NOT_DRAFT, and NULL in every NOT NULL column by column name', async () => {
    await expectRule(addReq('00000000-0000-4000-8000-0000000000aa', 'SKILL'), 'VERSION_NOT_DRAFT');
    const cols = ['gig_template_requirement_id', 'gig_template_version_id', 'requirement_type'];
    const values: Record<string, unknown> = {
      gig_template_requirement_id: '00000000-0000-4000-8000-000000000004',
      gig_template_version_id: v.id,
      requirement_type: 'SKILL',
    };
    for (const column of cols)
      await expectNotNull(
        isolated(
          noTriggers(R),
          `INSERT INTO catalog.gig_template_requirements (${cols.join(', ')}) VALUES ($1, $2, $3)`,
          cols.map((c) => (c === column ? null : values[c])),
        ),
        column,
      );
  });
});

// ---------------------------------------------------------------- market availability
describe('C8. market_gig_templates: display order bounds and uniqueness, primary key, foreign keys, defaults', () => {
  it.each([
    [1, true],
    [9999, true],
    [0, false],
    [10000, false],
    [-1, false],
  ])('display_order %i is %s (1..9999)', async (order, accepted) => {
    const [m, t] = [await makeMarket(), await makeTpl()];
    const attempt = addMarketRow(m.id, t.id, { order });
    if (accepted) await attempt;
    else await expectConstraint(attempt, 'ck_market_gig_templates__display_order');
  });
  it('accepts the same position in two DIFFERENT markets and the same position in the tables of the categories and of the templates of one market', async () => {
    const [m1, m2] = [await makeMarket(), await makeMarket()];
    const t = await makeTpl();
    await addMarketRow(m1.id, t.id, { order: 5 });
    await addMarketRow(m2.id, t.id, { order: 5 });
    const cat = await makeCategory('ACTIVE');
    await run('INSERT INTO catalog.market_categories (market_id, category_id, display_order) VALUES ($1, $2, 5)', [m1.id, cat.id]);
  });
  it('refuses two templates at the same position of a market, enabled or not (a disabled row keeps its position)', async () => {
    const m = await makeMarket();
    const [a, b, c] = [await makeTpl(), await makeTpl(), await makeTpl()];
    await addMarketRow(m.id, a.id, { order: 10, enabled: true });
    await expectConstraint(addMarketRow(m.id, b.id, { order: 10, enabled: false }), 'uq_market_gig_templates__market_order');
    await addMarketRow(m.id, b.id, { order: 20, enabled: false });
    await expectConstraint(addMarketRow(m.id, c.id, { order: 20, enabled: true }), 'uq_market_gig_templates__market_order');
    await expectConstraint(
      run('UPDATE catalog.market_gig_templates SET display_order = 10 WHERE market_id = $1 AND gig_template_id = $2', [m.id, b.id]),
      'uq_market_gig_templates__market_order',
    );
  });
  it('refuses a second row for the same market and template on the primary key', async () => {
    const [m, t] = [await makeMarket(), await makeTpl()];
    await addMarketRow(m.id, t.id, { order: 1 });
    await expectConstraint(addMarketRow(m.id, t.id, { order: 2 }), 'pk_market_gig_templates');
  });
  it('refuses an unknown market or template on the foreign keys (a DISABLED row reaches the key: the guard looks only at rows being enabled)', async () => {
    const [m, t] = [await makeMarket(), await makeTpl()];
    await expectConstraint(
      run('INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, display_order) VALUES (gen_random_uuid(), $1, 1)', [t.id]),
      'fk_market_gig_templates__market_id',
    );
    await expectConstraint(
      run('INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, display_order) VALUES ($1, gen_random_uuid(), 2)', [m.id]),
      'fk_market_gig_templates__gig_template_id',
    );
  });
  it('refuses NULL in every NOT NULL column by column name, with the guards out of the way', async () => {
    const [m, t] = [await makeMarket(), await makeTpl()];
    const values: Record<string, unknown> = {
      market_id: m.id,
      gig_template_id: t.id,
      enabled: false,
      display_order: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const cols = Object.keys(values);
    for (const column of cols)
      await expectNotNull(
        isolated(
          noTriggers(M),
          `INSERT INTO catalog.market_gig_templates (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => (c === column ? null : values[c])),
        ),
        column,
      );
  });
  it('defaults enabled to false and both timestamps to the transaction instant; the stamp of updated_at is the transaction instant even when the client sends another', async () => {
    const [m, t] = [await makeMarket(), await makeTpl()];
    await run('INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, display_order) VALUES ($1, $2, 3)', [m.id, t.id]);
    const r = (
      await q<{ enabled: boolean; created_at: Date; updated_at: Date }>(
        'SELECT enabled, created_at, updated_at FROM catalog.market_gig_templates WHERE market_id = $1',
        [m.id],
      )
    )[0]!;
    expect(r.enabled).toBe(false);
    expect(r.created_at.getTime()).toBe(r.updated_at.getTime());
  });
  it('prepares availability before launch: a row for a DRAFT / INACTIVE template, in a PLANNED market and in the seeded la-oc, none of it public (the database holds no rule about the market status)', async () => {
    const la = await laOc();
    const t = await makeTpl({ status: 'INACTIVE' });
    await addMarketRow(la, t.id, { order: nextOrder(), enabled: true });
    await addMarketRow((await makeMarket()).id, (await makeTpl()).id, { enabled: true });
    await setMgt(la, t.id, false); // leave la-oc as it was in spirit; the row stays (never deleted)
  });
});

// ---------------------------------------------------------------- audit_events
type Subject = 'category_id' | 'service_type_id' | 'prohibited_service_id' | 'market_id' | 'gig_template_id' | 'gig_template_version_id';
const SUBJECTS: Subject[] = ['category_id', 'service_type_id', 'prohibited_service_id', 'market_id', 'gig_template_id', 'gig_template_version_id'];
/** The documented subject of each action: the exact sets of subject columns that must be set (all others NULL). */
const ACTION_SUBJECTS: Record<string, Subject[][]> = {
  CATEGORY_CREATED: [['category_id']],
  CATEGORY_UPDATED: [['category_id']],
  CATEGORY_STATUS_CHANGED: [['category_id']],
  SERVICE_TYPE_CREATED: [['service_type_id']],
  SERVICE_TYPE_UPDATED: [['service_type_id']],
  SERVICE_TYPE_STATUS_CHANGED: [['service_type_id']],
  PROHIBITED_SERVICE_CREATED: [['prohibited_service_id']],
  PROHIBITED_SERVICE_STATUS_CHANGED: [['prohibited_service_id']],
  MARKET_CATALOG_AVAILABILITY_CHANGED: [
    ['market_id', 'category_id'],
    ['market_id', 'service_type_id'],
  ],
  GIG_TEMPLATE_CREATED: [['gig_template_id']],
  GIG_TEMPLATE_UPDATED: [['gig_template_id']],
  GIG_TEMPLATE_STATUS_CHANGED: [['gig_template_id']],
  GIG_TEMPLATE_VERSION_CREATED: [['gig_template_id', 'gig_template_version_id']],
  GIG_TEMPLATE_VERSION_CHANGED: [['gig_template_id', 'gig_template_version_id']],
  GIG_TEMPLATE_VERSION_PUBLISHED: [['gig_template_id', 'gig_template_version_id']],
  GIG_TEMPLATE_VERSION_RETIRED: [['gig_template_id', 'gig_template_version_id']],
  MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED: [['market_id', 'gig_template_id']],
};
describe('C9. audit_events: the action vocabulary and the one-kind-of-subject CHECK, for every old and new action over every combination of subject columns', () => {
  let ids: Record<Subject, string>;
  beforeAll(async () => {
    const cat = await makeCategory('DRAFT');
    const st = await makeServiceType(cat.id, 'DRAFT');
    const ps = (await q<{ prohibited_service_id: string }>('SELECT prohibited_service_id FROM catalog.prohibited_services LIMIT 1'))[0]?.prohibited_service_id;
    let psId = ps;
    if (!psId) {
      const code = `ps_${++seq}`;
      await ensureEntry(`catalog.prohibited_service.${code}.name`);
      psId = (
        await q<{ prohibited_service_id: string }>('INSERT INTO catalog.prohibited_services (code) VALUES ($1) RETURNING prohibited_service_id', [code])
      )[0]!.prohibited_service_id;
    }
    const t = await makeTpl({ status: 'ACTIVE' });
    const ver = await makeVersion(t);
    ids = {
      category_id: cat.id,
      service_type_id: st.id,
      prohibited_service_id: psId,
      market_id: await laOc(),
      gig_template_id: t.id,
      gig_template_version_id: ver.id,
    };
  });
  const insert = (c: Db, action: string, set: Subject[]) => {
    const params: unknown[] = [action];
    const values = SUBJECTS.map((s) => (set.includes(s) ? (params.push(ids[s]), `$${params.length}`) : 'NULL'));
    return c.query(
      `INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, ${SUBJECTS.join(', ')}) VALUES ('test', $1, 'reason', 'c-1', ${values.join(', ')})`,
      params,
    );
  };

  it('has 17 actions: nine of CAT-001 and eight of CAT-002', () => {
    expect(Object.keys(ACTION_SUBJECTS)).toHaveLength(17);
  });

  it('accepts every action with each of its documented subject sets, and refuses every one of the 64 combinations of subject columns that is not (17 x 64 = 1088 statements)', async () => {
    const c = await pool.connect();
    const wrong: string[] = [];
    let accepted = 0;
    try {
      await c.query('BEGIN');
      for (const [action, sets] of Object.entries(ACTION_SUBJECTS))
        for (let mask = 0; mask < 64; mask++) {
          const set = SUBJECTS.filter((_, i) => (mask >> i) & 1);
          const expected = sets.some((s) => s.length === set.length && s.every((x) => set.includes(x)));
          await c.query('SAVEPOINT s');
          const e = (await rejection(insert(c, action, set))) as PgFailure | undefined;
          await c.query('ROLLBACK TO s');
          if (e === undefined) accepted++;
          const got = e === undefined ? 'ok' : e.constraint;
          if (got !== (expected ? 'ok' : 'ck_audit_events__subject')) wrong.push(`${action} {${set.join(',')}}: ${got}`);
        }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(wrong).toEqual([]);
    expect(accepted).toBe(Object.values(ACTION_SUBJECTS).reduce((a, s) => a + s.length, 0)); // 18: one set each, two for the market availability of the taxonomy
  });

  it('refuses an action outside the vocabulary on ck_audit_events__action, with a valid subject for the closest real action and with none (the action CHECK is reported first)', async () => {
    for (const action of [
      'GIG_TEMPLATE_DELETED',
      'GIG_TEMPLATE_VERSION_DELETED',
      'gig_template_created',
      'GIG_TEMPLATE_',
      'MARKET_GIG_TEMPLATE_CHANGED',
      'MARKET_GIG_TEMPLATE_AVAILABILITY',
      'GIG_TEMPLATE_CREATED ',
      '',
      'CATEGORY_DELETED',
      'SERVICE_TYPE_',
      'GIG_TEMPLATE_FIELD_CHANGED',
    ])
      for (const set of [[], ['gig_template_id'] as Subject[], ['gig_template_id', 'gig_template_version_id'] as Subject[], ['category_id'] as Subject[]])
        await expectConstraint(insert(pool, action, set), 'ck_audit_events__action');
  });

  it('keeps the action prefixes apart: GIG_TEMPLATE_* does not satisfy the SERVICE_TYPE_* or CATEGORY_* branch, and an underscore of a LIKE is a literal underscore', async () => {
    await expectConstraint(insert(pool, 'GIG_TEMPLATE_CREATED', ['service_type_id']), 'ck_audit_events__subject');
    await expectConstraint(insert(pool, 'SERVICE_TYPE_CREATED', ['gig_template_id']), 'ck_audit_events__subject');
    await expectConstraint(insert(pool, 'GIG_TEMPLATE_VERSION_CREATED', ['gig_template_id']), 'ck_audit_events__subject'); // the version is mandatory
    await expectConstraint(insert(pool, 'GIG_TEMPLATE_CREATED', ['gig_template_id', 'gig_template_version_id']), 'ck_audit_events__subject'); // and forbidden for the template
  });

  it('keeps the six rows of 0015 valid under the replaced CHECKs, and accepts the two seeded rows of 0016 (re-validated by evaluating both CHECKs over every row)', async () => {
    expect(
      await sq(
        `SELECT audit_event_id FROM catalog.audit_events a WHERE NOT (
           (action LIKE 'CATEGORY\\_%' AND category_id IS NOT NULL AND service_type_id IS NULL) OR (action LIKE 'SERVICE\\_TYPE\\_%' AND service_type_id IS NOT NULL AND category_id IS NULL)
           OR (action = 'GIG_TEMPLATE_CREATED' AND gig_template_id IS NOT NULL AND gig_template_version_id IS NULL))`,
      ),
    ).toEqual([]);
    expect(
      (
        await sq<{ n: number }>(
          "SELECT count(*)::int AS n FROM catalog.audit_events WHERE action IN ('CATEGORY_CREATED', 'SERVICE_TYPE_CREATED', 'GIG_TEMPLATE_CREATED')",
        )
      )[0]!.n,
    ).toBe(8);
    expect(
      (
        await sq<{ convalidated: boolean }>(
          "SELECT convalidated FROM pg_constraint WHERE conname IN ('ck_audit_events__action', 'ck_audit_events__subject') AND conrelid = 'catalog.audit_events'::regclass",
        )
      ).every((r) => r.convalidated),
    ).toBe(true);
  });

  it('refuses an unknown template or version on the new foreign keys, and a version that belongs to ANOTHER template (0017: the composite foreign key proves the pair belongs together)', async () => {
    await expectConstraint(
      run(
        "INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id) VALUES ('t', 'GIG_TEMPLATE_CREATED', 'r', 'c', gen_random_uuid())",
      ),
      'fk_audit_events__gig_template_id',
    );
    await expectConstraint(
      run(
        "INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id, gig_template_version_id) VALUES ('t', 'GIG_TEMPLATE_VERSION_CREATED', 'r', 'c', $1, gen_random_uuid())",
        [ids.gig_template_id],
      ),
      'fk_audit_events__gig_template_version',
    );
    const other = await makeTpl({ status: 'ACTIVE' });
    await expectConstraint(
      run(
        "INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id, gig_template_version_id) VALUES ('t', 'GIG_TEMPLATE_VERSION_CREATED', 'r', 'c', $1, $2)",
        [other.id, ids.gig_template_version_id],
      ),
      'fk_audit_events__gig_template_version',
    ); // the version belongs to another template
    await run(
      "INSERT INTO catalog.audit_events (actor, action, reason, correlation_id, gig_template_id, gig_template_version_id) VALUES ('t', 'GIG_TEMPLATE_VERSION_CREATED', 'r', 'c', $1, $2)",
      [ids.gig_template_id, ids.gig_template_version_id],
    ); // its own template is accepted
  });

  it('is still append-only for the new actions: UPDATE, DELETE (one row, all rows) and TRUNCATE (alone, together with another table, CASCADE) are refused as ROW_IMMUTABLE and no row is lost or changed', async () => {
    await insert(pool, 'GIG_TEMPLATE_UPDATED', ['gig_template_id']);
    const before = await count(AUDIT);
    await expectRule(run("UPDATE catalog.audit_events SET reason = 'changed' WHERE action = 'GIG_TEMPLATE_UPDATED'"), 'ROW_IMMUTABLE');
    await expectRule(run("UPDATE catalog.audit_events SET gig_template_id = NULL WHERE action = 'GIG_TEMPLATE_UPDATED'"), 'ROW_IMMUTABLE');
    await expectRule(run("DELETE FROM catalog.audit_events WHERE action = 'GIG_TEMPLATE_UPDATED'"), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM catalog.audit_events'), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE catalog.audit_events'), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE catalog.audit_events CASCADE'), 'ROW_IMMUTABLE');
    expect(await count(AUDIT)).toBe(before);
  });
});

// ====================================================================== D. the guard rules: the exact failing statement of every rule key
type Outcome = 'OK' | 'DRAFT_IS_INITIAL' | 'STATUS_TRANSITION';
/** The template machine is the CAT-001 machine: DRAFT -> ACTIVE | RETIRED, ACTIVE <-> INACTIVE, ACTIVE | INACTIVE -> RETIRED, RETIRED terminal, DRAFT never written back. */
const TEMPLATE_MATRIX: Record<CatalogStatus, Record<CatalogStatus, Outcome>> = {
  DRAFT: { DRAFT: 'OK', ACTIVE: 'OK', INACTIVE: 'STATUS_TRANSITION', RETIRED: 'OK' },
  ACTIVE: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'OK', INACTIVE: 'OK', RETIRED: 'OK' },
  INACTIVE: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'OK', INACTIVE: 'OK', RETIRED: 'OK' },
  RETIRED: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'STATUS_TRANSITION', INACTIVE: 'STATUS_TRANSITION', RETIRED: 'OK' },
};
/** The version machine: DRAFT -> ACTIVE | RETIRED, ACTIVE -> SUPERSEDED | RETIRED, SUPERSEDED and RETIRED terminal, DRAFT never written back (a same-status write is a no-op). */
const VERSION_MATRIX: Record<GigTemplateVersionStatus, Record<GigTemplateVersionStatus, Outcome>> = {
  DRAFT: { DRAFT: 'OK', ACTIVE: 'OK', SUPERSEDED: 'STATUS_TRANSITION', RETIRED: 'OK' },
  ACTIVE: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'OK', SUPERSEDED: 'OK', RETIRED: 'OK' },
  SUPERSEDED: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'STATUS_TRANSITION', SUPERSEDED: 'OK', RETIRED: 'STATUS_TRANSITION' },
  RETIRED: { DRAFT: 'DRAFT_IS_INITIAL', ACTIVE: 'STATUS_TRANSITION', SUPERSEDED: 'STATUS_TRANSITION', RETIRED: 'OK' },
};
const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as [CatalogStatus, CatalogStatus]));
const VPAIRS = VSTATUSES.flatMap((from) => VSTATUSES.map((to) => [from, to] as [GigTemplateVersionStatus, GigTemplateVersionStatus]));

describe('D0. the two status machines: the 4 x 4 matrices of the database equal the contract, pair by pair', () => {
  it('has the contract transitions exactly for both machines and the literal matrices of this file agree with them', () => {
    expect(CATALOG_STATUS_TRANSITIONS).toEqual({ DRAFT: ['ACTIVE', 'RETIRED'], ACTIVE: ['INACTIVE', 'RETIRED'], INACTIVE: ['ACTIVE', 'RETIRED'], RETIRED: [] });
    for (const [from, to] of PAIRS) {
      expect(TEMPLATE_MATRIX[from][to] === 'OK', `template ${from} -> ${to}`).toBe(from === to || isCatalogTransitionAllowed(from, to));
      if (from !== to && to === 'DRAFT') expect(TEMPLATE_MATRIX[from][to]).toBe('DRAFT_IS_INITIAL');
    }
    for (const [from, to] of VPAIRS) {
      expect(VERSION_MATRIX[from][to] === 'OK', `version ${from} -> ${to}`).toBe(from === to || isGigTemplateVersionTransitionAllowed(from, to));
      if (from !== to && to === 'DRAFT') expect(VERSION_MATRIX[from][to]).toBe('DRAFT_IS_INITIAL');
    }
    expect(PAIRS).toHaveLength(16);
    expect(VPAIRS).toHaveLength(16);
    expect(VSTATUSES).toEqual(['DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED']);
    // the version machine is NOT the catalogue machine: INACTIVE does not exist and SUPERSEDED is terminal
    expect(isGigTemplateVersionTransitionAllowed('ACTIVE', 'SUPERSEDED')).toBe(true);
    expect(isCatalogTransitionAllowed('ACTIVE', 'INACTIVE')).toBe(true);
  });

  it.each(VPAIRS)('catalog.assert_version_transition(%s, %s) gives the documented answer', async (from, to) => {
    const attempt = pool.query('SELECT catalog.assert_version_transition($1, $2)', [from, to]);
    if (VERSION_MATRIX[from][to] === 'OK') await attempt;
    else await expectRule(attempt, VERSION_MATRIX[from][to]);
  });

  it('KNOWN GAP (reported, same as catalog.assert_status_transition): called directly with a NULL status the function does not raise for DRAFT / ACTIVE / NULL on the left (three-valued logic); unreachable through the tables, whose status column is NOT NULL', async () => {
    for (const [a, b] of [
      [null, 'ACTIVE'],
      ['ACTIVE', null],
      ['DRAFT', null],
      [null, null],
    ] as const)
      await pool.query('SELECT catalog.assert_version_transition($1, $2)', [a, b]);
    // SUPERSEDED and RETIRED have no edge at all, so every term is false and the NULL does not rescue them
    await expectRule(pool.query('SELECT catalog.assert_version_transition($1, $2)', ['RETIRED', null]), 'STATUS_TRANSITION');
    await expectRule(pool.query('SELECT catalog.assert_version_transition($1, $2)', ['SUPERSEDED', null]), 'STATUS_TRANSITION');
    await expectRule(pool.query('SELECT catalog.assert_version_transition($1, $2)', [null, 'FOO']), 'STATUS_TRANSITION');
  });

  it('judges an unknown status as STATUS_TRANSITION in both positions and never raises another key; an unknown status equal on both sides is the no-op branch; the machine is a closed whitelist', async () => {
    for (const [a, b] of [
      ['FOO', 'ACTIVE'],
      ['ACTIVE', 'FOO'],
      ['active', 'RETIRED'],
      ['', 'ACTIVE'],
      ['DRAFT', 'SUPERSEDED'],
      ['ACTIVE ', 'RETIRED'],
      ['INACTIVE', 'ACTIVE'], // a catalogue status is not a version status
    ] as const)
      await expectRule(pool.query('SELECT catalog.assert_version_transition($1, $2)', [a, b]), 'STATUS_TRANSITION');
    await pool.query("SELECT catalog.assert_version_transition('FOO', 'FOO')");
  });
});

describe('D1a. gig_templates: the status machine of the table, every pair of the matrix', () => {
  it.each(PAIRS)('%s -> %s', async (from, to) => {
    const t = await makeTpl({ status: from });
    expect((await tplRow(t.id)).status).toBe(from);
    const attempt = setTpl(t.id, to);
    const outcome = TEMPLATE_MATRIX[from][to];
    if (outcome === 'OK') {
      await attempt;
      expect((await tplRow(t.id)).status).toBe(to);
    } else {
      await expectRule(attempt, outcome);
      expect((await tplRow(t.id)).status, 'a refused change leaves the row alone').toBe(from);
    }
  });

  it('walks the whole life DRAFT -> ACTIVE -> INACTIVE -> ACTIVE -> INACTIVE -> RETIRED and then refuses every other status, RETIRED included only as a no-op', async () => {
    const t = await makeTpl();
    for (const s of ['ACTIVE', 'INACTIVE', 'ACTIVE', 'INACTIVE', 'RETIRED']) {
      await setTpl(t.id, s);
      expect((await tplRow(t.id)).status).toBe(s);
    }
    for (const s of ['DRAFT', 'ACTIVE', 'INACTIVE']) await expect(setTpl(t.id, s)).rejects.toMatchObject({ code: '23000' });
    await setTpl(t.id, 'RETIRED');
  });
});

describe('D1b. gig_template_versions: the status machine of the table, every pair of the matrix (a direct ACTIVE -> SUPERSEDED is answered by SUPERSEDED_IS_AUTOMATIC)', () => {
  it.each(VPAIRS)('%s -> %s', async (from, to) => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeVersionIn(t, from);
    expect((await verRow(v.id)).status).toBe(from);
    // a target ACTIVE needs a publishable draft: the row under test IS that draft (DRAFT -> ACTIVE); every other source is terminal or already ACTIVE
    const attempt = setVer(v.id, to);
    const outcome: Outcome | 'SUPERSEDED_IS_AUTOMATIC' = from === 'ACTIVE' && to === 'SUPERSEDED' ? 'SUPERSEDED_IS_AUTOMATIC' : VERSION_MATRIX[from][to];
    if (outcome === 'OK') {
      await attempt;
      expect((await verRow(v.id)).status).toBe(to);
    } else {
      await expectRule(attempt, outcome);
      expect((await verRow(v.id)).status, 'a refused change leaves the row alone').toBe(from);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('walks DRAFT -> ACTIVE -> RETIRED (a withdrawal) and DRAFT -> RETIRED (a discard), and then refuses everything but the no-op', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    await setVer(v.id, 'ACTIVE');
    await setVer(v.id, 'RETIRED');
    for (const s of ['DRAFT', 'ACTIVE', 'SUPERSEDED']) await expect(setVer(v.id, s)).rejects.toMatchObject({ code: '23000' });
    await setVer(v.id, 'RETIRED');
    const d = await makeDraftWithField(t);
    await setVer(d.id, 'RETIRED');
    expect((await verRow(d.id)).published_at).toBeNull();
  });

  it('refuses a status outside the vocabulary as STATUS_TRANSITION (the trigger answers before the CHECK, which stays as a second line)', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    for (const bogus of ['active', 'IN_REVIEW', '', 'INACTIVE', 'ACTIVE ']) await expectRule(setVer(v.id, bogus), 'STATUS_TRANSITION');
    expect((await verRow(v.id)).status).toBe('DRAFT');
  });
});

describe('D2. guard_gig_templates: NOT_DELETABLE, MUST_START_AS_DRAFT, SERVICE_TYPE_RETIRED, IMMUTABLE_IDENTITY, SERVICE_TYPE_NOT_ACTIVE, GIG_TEMPLATE_HAS_OPEN_DRAFT', () => {
  it('NOT_DELETABLE: refuses to delete a lone template, one with versions, a seeded one, a RETIRED one and every template at once; nothing is deleted', async () => {
    const lone = await makeTpl();
    const { t: live } = await makeLiveTemplate();
    const retired = await makeTpl({ status: 'RETIRED' });
    const before = await count(T);
    for (const id of [lone.id, live.id, retired.id])
      await expectRule(run('DELETE FROM catalog.gig_templates WHERE gig_template_id = $1', [id]), 'NOT_DELETABLE');
    await expectRule(run("DELETE FROM catalog.gig_templates WHERE code = 'full_detail'"), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.gig_templates'), 'NOT_DELETABLE');
    expect(await count(T)).toBe(before);
  });

  it('MUST_START_AS_DRAFT: refuses to create a template in any other status or outside the vocabulary, and accepts an explicit DRAFT', async () => {
    const st = await makeSt();
    for (const status of ['ACTIVE', 'INACTIVE', 'RETIRED', 'active', '', 'SUPERSEDED']) {
      const code = `msd_${++seq}`;
      await ensureEntry(gigTemplateNameKey(code));
      await expectRule(
        run('INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, $3)', [st.id, code, status]),
        'MUST_START_AS_DRAFT',
      );
      expect(await count(T, 'code = $1', [code])).toBe(0);
    }
    const ok = `msd_${++seq}`;
    await ensureEntry(gigTemplateNameKey(ok));
    await run("INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, 'DRAFT')", [st.id, ok]);
  });

  it('SERVICE_TYPE_RETIRED: refuses to create a template under a RETIRED service type, and accepts a DRAFT, an ACTIVE and an INACTIVE one; MUST_START_AS_DRAFT is reported first', async () => {
    for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE'] as CatalogStatus[]) await makeTpl({ st: await makeSt(status) });
    const retired = await makeSt('RETIRED');
    const code = `str_${++seq}`;
    await ensureEntry(gigTemplateNameKey(code));
    await expectRule(run('INSERT INTO catalog.gig_templates (service_type_id, code) VALUES ($1, $2)', [retired.id, code]), 'SERVICE_TYPE_RETIRED');
    await expectRule(
      run("INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, 'ACTIVE')", [retired.id, code]),
      'MUST_START_AS_DRAFT',
    );
    expect(await count(T, 'code = $1', [code])).toBe(0);
  });

  it('IMMUTABLE_IDENTITY: refuses to change the code, the id or the SERVICE TYPE (a move is a new template), also together with a status change, and accepts the same values', async () => {
    const t = await makeTpl();
    const other = await makeSt();
    await expectRule(run("UPDATE catalog.gig_templates SET code = 'other_code' WHERE gig_template_id = $1", [t.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.gig_templates SET code = upper(code) WHERE gig_template_id = $1', [t.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.gig_templates SET gig_template_id = gen_random_uuid() WHERE gig_template_id = $1', [t.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE catalog.gig_templates SET service_type_id = $2 WHERE gig_template_id = $1', [t.id, other.id]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run("UPDATE catalog.gig_templates SET service_type_id = $2, status = 'ACTIVE' WHERE gig_template_id = $1", [t.id, other.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(run("UPDATE catalog.gig_templates SET code = 'x_y', status = 'INACTIVE' WHERE gig_template_id = $1", [t.id]), 'IMMUTABLE_IDENTITY'); // before the transition rule
    await run('UPDATE catalog.gig_templates SET code = code, service_type_id = service_type_id, gig_template_id = gig_template_id WHERE gig_template_id = $1', [
      t.id,
    ]);
    expect((await q<{ code: string }>('SELECT code FROM catalog.gig_templates WHERE gig_template_id = $1', [t.id]))[0]!.code).toBe(t.code);
    // identity stays immutable at every status
    const retired = await makeTpl({ status: 'RETIRED' });
    await expectRule(run("UPDATE catalog.gig_templates SET code = 'zz_zz' WHERE gig_template_id = $1", [retired.id]), 'IMMUTABLE_IDENTITY');
  });

  it('SERVICE_TYPE_NOT_ACTIVE: a template enters ACTIVE only under an ACTIVE service type (DRAFT, INACTIVE and RETIRED ones refuse it), and the transition rule is reported first', async () => {
    // a DRAFT service type
    const d = await makeTpl({ st: await makeSt('DRAFT') });
    await expectRule(setTpl(d.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    await setSt(d.stId, 'ACTIVE');
    await setTpl(d.id, 'ACTIVE');
    // an INACTIVE one: DRAFT -> ACTIVE and INACTIVE -> ACTIVE are both refused, ACTIVE templates stay as they are
    const i = await makeTpl({ status: 'ACTIVE' });
    const paused = await makeTpl({ st: { id: i.stId, code: i.stCode }, status: 'INACTIVE' });
    const fresh = await makeTpl({ st: { id: i.stId, code: i.stCode } });
    await setSt(i.stId, 'INACTIVE');
    await expectRule(setTpl(paused.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    await expectRule(setTpl(fresh.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    expect((await tplRow(i.id)).status).toBe('ACTIVE'); // not a cascade
    await setSt(i.stId, 'ACTIVE');
    await setTpl(paused.id, 'ACTIVE');
    // a RETIRED one
    const r = await makeTpl();
    await setSt(r.stId, 'ACTIVE');
    await setSt(r.stId, 'RETIRED');
    await expectRule(setTpl(r.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    await expectRule(setTpl(r.id, 'INACTIVE'), 'STATUS_TRANSITION'); // DRAFT -> INACTIVE: the transition rule first
    await setTpl(r.id, 'RETIRED'); // cleaning up under a RETIRED service type is allowed
  });

  it('SERVICE_TYPE_NOT_ACTIVE checks only the ENTRY into ACTIVE: an ACTIVE template under a paused service type can be edited, paused and retired; RETIRED -> ACTIVE is the transition rule', async () => {
    const t = await makeTpl({ status: 'ACTIVE', copy: true });
    await setSt(t.stId, 'INACTIVE');
    await run('UPDATE catalog.gig_templates SET description_content_key = NULL WHERE gig_template_id = $1', [t.id]);
    await setTpl(t.id, 'ACTIVE');
    await setTpl(t.id, 'INACTIVE');
    await setTpl(t.id, 'RETIRED');
    await setSt(t.stId, 'ACTIVE');
    await expectRule(setTpl(t.id, 'ACTIVE'), 'STATUS_TRANSITION');
  });

  it.each([
    ['a DRAFT template', 'DRAFT'],
    ['an ACTIVE template', 'ACTIVE'],
    ['an INACTIVE template', 'INACTIVE'],
  ] as [string, CatalogStatus][])(
    'GIG_TEMPLATE_HAS_OPEN_DRAFT: %s cannot be retired while it has a DRAFT version; discarding the draft unblocks it',
    async (_n, status) => {
      const t = await makeTpl({ status });
      const v = await makeVersion(t);
      await expectRule(setTpl(t.id, 'RETIRED'), 'GIG_TEMPLATE_HAS_OPEN_DRAFT');
      expect((await tplRow(t.id)).status).toBe(status);
      expect((await verRow(v.id)).status).toBe('DRAFT');
      await setVer(v.id, 'RETIRED');
      await setTpl(t.id, 'RETIRED');
      expect((await tplRow(t.id)).status).toBe('RETIRED');
    },
  );

  it('GIG_TEMPLATE_HAS_OPEN_DRAFT: only a DRAFT version blocks (an ACTIVE, SUPERSEDED or RETIRED one does not), only the retirement is checked, and a bulk retirement is atomic', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const open = await makeVersion(t);
    await setTpl(t.id, 'INACTIVE'); // pausing and re-activating with a draft is fine
    await setTpl(t.id, 'ACTIVE');
    await run('UPDATE catalog.gig_templates SET description_content_key = NULL WHERE gig_template_id = $1', [t.id]);
    const free = await makeTpl({ status: 'ACTIVE' });
    await expectRule(
      run('UPDATE catalog.gig_templates SET status = $3 WHERE gig_template_id IN ($1, $2)', [t.id, free.id, 'RETIRED']),
      'GIG_TEMPLATE_HAS_OPEN_DRAFT',
    );
    expect([(await tplRow(t.id)).status, (await tplRow(free.id)).status], 'atomic: the free template was NOT retired either').toEqual(['ACTIVE', 'ACTIVE']);
    await setVer(open.id, 'RETIRED');
    await run('UPDATE catalog.gig_templates SET status = $3 WHERE gig_template_id IN ($1, $2)', [t.id, free.id, 'RETIRED']);
    // a template whose versions are all closed retires without a word
    const closed = await makeTpl({ status: 'ACTIVE' });
    await makeVersionIn(closed, 'SUPERSEDED');
    await setTpl(closed.id, 'RETIRED');
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('retiring closes the ACTIVE version through the nested trigger (RETIRED, closed_at = the retirement, published_at kept), leaves SUPERSEDED and RETIRED versions alone, and no ACTIVE version ever sits under a RETIRED template', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v1 = await makePublished(t);
    const v2 = await makePublished(t); // supersedes v1
    const v3 = await makeDraftWithField(t);
    await setVer(v3.id, 'RETIRED'); // a discarded draft
    const [r1, r2, r3] = [await verRow(v1.id), await verRow(v2.id), await verRow(v3.id)];
    expect([r1.status, r2.status, r3.status]).toEqual(['SUPERSEDED', 'ACTIVE', 'RETIRED']);
    await sleep(3);
    await setTpl(t.id, 'RETIRED');
    const [a1, a2, a3] = [await verRow(v1.id), await verRow(v2.id), await verRow(v3.id)];
    expect([a1.status, a2.status, a3.status]).toEqual(['SUPERSEDED', 'RETIRED', 'RETIRED']);
    expect(a2.published_at!.getTime()).toBe(r2.published_at!.getTime());
    expect(a2.closed_at!.getTime()).toBeGreaterThan(r2.published_at!.getTime());
    expect(a2.closed_at!.getTime()).toBe((await tplRow(t.id)).updated_at.getTime()); // one transaction instant
    expect(a2.updated_at.getTime()).toBe(a2.closed_at!.getTime());
    expect([a1.closed_at!.getTime(), a3.closed_at!.getTime(), a1.updated_at.getTime()]).toEqual([
      r1.closed_at!.getTime(),
      r3.closed_at!.getTime(),
      r1.updated_at.getTime(),
    ]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('pausing a template (ACTIVE -> INACTIVE) does NOT touch its ACTIVE version: the pause is a read-time rule of the service, not a cascade', async () => {
    const { t, v } = await makeLiveTemplate();
    await setTpl(t.id, 'INACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
    await setTpl(t.id, 'ACTIVE');
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });

  it('KNOWN GAP (reported): the copy of the description and instructions is checked only when a VERSION is published; linking either key afterwards, on an ACTIVE template with an ACTIVE version, is accepted although the entry has no published version', async () => {
    const { t } = await makeLiveTemplate();
    const key = gigTemplateDescriptionKey(t.code);
    await ensureContent(key, { state: 'NONE' });
    expect((await q<{ ok: boolean }>('SELECT catalog.content_is_published($1) AS ok', [key]))[0]!.ok).toBe(false);
    await run('UPDATE catalog.gig_templates SET description_content_key = $2 WHERE gig_template_id = $1', [t.id, key]);
    expect((await tplRow(t.id)).status).toBe('ACTIVE');
  });

  it('allows the changes no rule covers: the description and instructions links can be edited at any status, including RETIRED', async () => {
    const t = await makeTpl({ status: 'RETIRED', copy: true });
    await run('UPDATE catalog.gig_templates SET instructions_content_key = NULL WHERE gig_template_id = $1', [t.id]);
    await run('UPDATE catalog.gig_templates SET instructions_content_key = $2 WHERE gig_template_id = $1', [t.id, gigTemplateInstructionsKey(t.code)]);
  });
});

describe('D3. guard_gig_template_versions: NOT_DELETABLE, MUST_START_AS_DRAFT, GIG_TEMPLATE_RETIRED, VERSION_NUMBER_SEQUENCE, IMMUTABLE_IDENTITY', () => {
  it('NOT_DELETABLE: refuses to delete a DRAFT, an ACTIVE, a SUPERSEDED and a RETIRED version, one with fields, and every version at once; nothing is deleted', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const superseded = await makeVersionIn(t, 'SUPERSEDED');
    const retired = await makeVersionIn(t, 'RETIRED');
    const draft = await makeVersionIn(t, 'DRAFT');
    const active = (
      await q<{ id: string }>("SELECT gig_template_version_id AS id FROM catalog.gig_template_versions WHERE gig_template_id = $1 AND status = 'ACTIVE'", [
        t.id,
      ])
    )[0]!;
    const before = await count(V);
    for (const id of [superseded.id, retired.id, draft.id, active.id])
      await expectRule(run('DELETE FROM catalog.gig_template_versions WHERE gig_template_version_id = $1', [id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.gig_template_versions WHERE gig_template_id = $1', [t.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.gig_template_versions'), 'NOT_DELETABLE');
    expect(await count(V)).toBe(before);
  });

  it('MUST_START_AS_DRAFT: refuses a version created in any other status, with a revision other than 1, or with published_at / closed_at set', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    for (const status of ['ACTIVE', 'SUPERSEDED', 'RETIRED', 'active', ''])
      await expectRule(
        run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status) VALUES ($1, 1, $2)', [t.id, status]),
        'MUST_START_AS_DRAFT',
      );
    await expectRule(
      run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, revision) VALUES ($1, 1, 2)', [t.id]),
      'MUST_START_AS_DRAFT',
    );
    await expectRule(
      run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, published_at) VALUES ($1, 1, now())', [t.id]),
      'MUST_START_AS_DRAFT',
    );
    await expectRule(
      run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, closed_at) VALUES ($1, 1, now())', [t.id]),
      'MUST_START_AS_DRAFT',
    );
    expect(await count(V, 'gig_template_id = $1', [t.id])).toBe(0);
    await run("INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, revision) VALUES ($1, 1, 'DRAFT', 1)", [t.id]);
  });

  it('GIG_TEMPLATE_RETIRED: refuses a version for a RETIRED template (also with a wrong number: the rule comes before the sequence), and accepts one for a DRAFT, an ACTIVE and an INACTIVE template', async () => {
    for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE'] as CatalogStatus[]) await makeVersion(await makeTpl({ status }));
    const retired = await makeTpl({ status: 'RETIRED' });
    await expectRule(run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 1)', [retired.id]), 'GIG_TEMPLATE_RETIRED');
    await expectRule(run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 7)', [retired.id]), 'GIG_TEMPLATE_RETIRED');
    await expectRule(
      run("INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status) VALUES ($1, 1, 'ACTIVE')", [retired.id]),
      'MUST_START_AS_DRAFT',
    );
    // a template that was retired with history cannot grow
    const withHistory = await makeTpl({ status: 'ACTIVE' });
    await makeVersionIn(withHistory, 'SUPERSEDED');
    await setTpl(withHistory.id, 'RETIRED');
    await expectRule(
      run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 3)', [withHistory.id]),
      'GIG_TEMPLATE_RETIRED',
    );
  });

  it('VERSION_NUMBER_SEQUENCE: the first version is 1, then every number is the highest plus one: no gap (3 after 1), no reuse (1 or 2 after 2), no zero, no negative; a discarded number is not reused', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const ins = (n: number) => run('INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, $2)', [t.id, n]);
    for (const n of [0, 2, 3, -1, 100]) await expectRule(ins(n), 'VERSION_NUMBER_SEQUENCE');
    await ins(1);
    for (const n of [0, 1, 3, 4, -1]) await expectRule(ins(n), 'VERSION_NUMBER_SEQUENCE');
    await setVer(
      (await q<{ id: string }>('SELECT gig_template_version_id AS id FROM catalog.gig_template_versions WHERE gig_template_id = $1', [t.id]))[0]!.id,
      'RETIRED',
    );
    await expectRule(ins(1), 'VERSION_NUMBER_SEQUENCE'); // the discarded number stays used
    await ins(2);
    expect(
      (await q<{ n: number }>('SELECT version_number AS n FROM catalog.gig_template_versions WHERE gig_template_id = $1 ORDER BY 1', [t.id])).map((r) => r.n),
    ).toEqual([1, 2]);
    // another template starts at 1 again
    await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('IMMUTABLE_IDENTITY: refuses to change the id, the template or the NUMBER of a version at every status, also together with a status change, and accepts the same values', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const other = await makeTpl({ status: 'ACTIVE' });
    for (const status of ['DRAFT', 'ACTIVE', 'RETIRED'] as GigTemplateVersionStatus[]) {
      const v = await makeVersionIn(t, status);
      await expectRule(
        run('UPDATE catalog.gig_template_versions SET gig_template_version_id = gen_random_uuid() WHERE gig_template_version_id = $1', [v.id]),
        'IMMUTABLE_IDENTITY',
      );
      await expectRule(
        run('UPDATE catalog.gig_template_versions SET gig_template_id = $2 WHERE gig_template_version_id = $1', [v.id, other.id]),
        'IMMUTABLE_IDENTITY',
      );
      await expectRule(
        run('UPDATE catalog.gig_template_versions SET version_number = version_number + 10 WHERE gig_template_version_id = $1', [v.id]),
        'IMMUTABLE_IDENTITY',
      );
      await expectRule(
        run("UPDATE catalog.gig_template_versions SET version_number = 99, status = 'RETIRED' WHERE gig_template_version_id = $1", [v.id]),
        'IMMUTABLE_IDENTITY',
      );
      await run(
        'UPDATE catalog.gig_template_versions SET version_number = version_number, gig_template_id = gig_template_id WHERE gig_template_version_id = $1',
        [v.id],
      );
      if (status === 'DRAFT') await setVer(v.id, 'RETIRED');
    }
  });

  it('allows a DRAFT to be edited freely and its revision to grow (or stay), but never to shrink: VERSION_FROZEN; the revision is the draft concurrency token', async () => {
    const v = await makeVersion(await makeTpl({ status: 'ACTIVE' }));
    await run(
      'UPDATE catalog.gig_template_versions SET revision = 2, min_duration_minutes = 30, max_duration_minutes = 120, suggested_duration_minutes = 60, pricing_fixed_with_variants = true, pricing_bundle_eligible = true, pricing_drop_eligible = true, area_postal_codes = true, area_polygon = true WHERE gig_template_version_id = $1',
      [v.id],
    );
    await run('UPDATE catalog.gig_template_versions SET revision = 2 WHERE gig_template_version_id = $1', [v.id]);
    await run('UPDATE catalog.gig_template_versions SET revision = 50 WHERE gig_template_version_id = $1', [v.id]);
    await expectRule(run('UPDATE catalog.gig_template_versions SET revision = 49 WHERE gig_template_version_id = $1', [v.id]), 'VERSION_FROZEN');
    await expectRule(run('UPDATE catalog.gig_template_versions SET revision = 1 WHERE gig_template_version_id = $1', [v.id]), 'VERSION_FROZEN');
    expect((await verRow(v.id)).revision).toBe(50);
    // client-sent published_at / closed_at / created_at on a DRAFT are overwritten, not stored
    await run(
      "UPDATE catalog.gig_template_versions SET published_at = '2001-01-01', closed_at = '2001-01-02', created_at = '2000-01-01' WHERE gig_template_version_id = $1",
      [v.id],
    );
    const r = await verRow(v.id);
    expect([r.published_at, r.closed_at]).toEqual([null, null]);
    expect(r.created_at.getFullYear()).toBeGreaterThan(2020);
  });
});

// every structural column of a version that has left DRAFT, with an UPDATE that would change it
const FROZEN_COLUMNS: [column: string, set: string][] = [
  ['revision', 'revision = revision + 1'],
  ['min_duration_minutes', 'min_duration_minutes = 10'],
  ['max_duration_minutes', 'max_duration_minutes = 100'],
  ['suggested_duration_minutes', 'suggested_duration_minutes = 50'],
  ['pricing_fixed', 'pricing_fixed = NOT pricing_fixed'],
  ['pricing_fixed_with_variants', 'pricing_fixed_with_variants = NOT pricing_fixed_with_variants'],
  ['pricing_bundle_eligible', 'pricing_bundle_eligible = NOT pricing_bundle_eligible'],
  ['pricing_drop_eligible', 'pricing_drop_eligible = NOT pricing_drop_eligible'],
  ['area_radius', 'area_radius = NOT area_radius'],
  ['area_postal_codes', 'area_postal_codes = NOT area_postal_codes'],
  ['area_polygon', 'area_polygon = NOT area_polygon'],
  ['created_at', "created_at = created_at - interval '1 day'"],
  ['published_at', "published_at = COALESCE(published_at, now()) + interval '1 day'"],
];
describe('D3b. VERSION_FROZEN: every structural column of a version that left DRAFT is frozen; only the status and the closing timestamp move', () => {
  const NON_DRAFT: GigTemplateVersionStatus[] = ['ACTIVE', 'SUPERSEDED', 'RETIRED'];
  const CASES = NON_DRAFT.flatMap((status) => FROZEN_COLUMNS.map(([column, set]) => [status, column, set] as const));
  it('has a case for every structural column (13) of every non-draft status (3)', () => {
    expect(CASES).toHaveLength(39);
  });
  it.each(CASES)('a %s version refuses a change of %s (%s)', async (status, _column, set) => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeVersionIn(t, status);
    const before = await q('SELECT * FROM catalog.gig_template_versions WHERE gig_template_version_id = $1', [v.id]);
    await expectRule(run(`UPDATE catalog.gig_template_versions SET ${set} WHERE gig_template_version_id = $1`, [v.id]), 'VERSION_FROZEN');
    expect(await q('SELECT * FROM catalog.gig_template_versions WHERE gig_template_version_id = $1', [v.id])).toEqual(before);
  });

  it('refuses a rewrite of closed_at on a SUPERSEDED and a RETIRED version (VERSION_FROZEN), ignores one on an ACTIVE version (the guard keeps it NULL), and ignores updated_at everywhere', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    for (const status of ['SUPERSEDED', 'RETIRED'] as GigTemplateVersionStatus[]) {
      const v = await makeVersionIn(t, status);
      await expectRule(
        run("UPDATE catalog.gig_template_versions SET closed_at = closed_at + interval '1 day' WHERE gig_template_version_id = $1", [v.id]),
        'VERSION_FROZEN',
      );
      await expectRule(run('UPDATE catalog.gig_template_versions SET closed_at = NULL WHERE gig_template_version_id = $1', [v.id]), 'VERSION_FROZEN');
    }
    const { v } = await makeLiveTemplate();
    await run("UPDATE catalog.gig_template_versions SET closed_at = now(), updated_at = '2000-01-01' WHERE gig_template_version_id = $1", [v.id]);
    const r = await verRow(v.id);
    expect(r.closed_at).toBeNull();
    expect(r.updated_at.getFullYear()).toBeGreaterThan(2020);
    expect(r.status).toBe('ACTIVE');
  });

  it('lets a frozen version be touched without a change (an UPDATE that sets the same values), and its status leave only by the machine', async () => {
    const { v } = await makeLiveTemplate();
    const before = await verRow(v.id);
    await sleep(3);
    await run(
      'UPDATE catalog.gig_template_versions SET revision = revision, pricing_fixed = pricing_fixed, min_duration_minutes = min_duration_minutes WHERE gig_template_version_id = $1',
      [v.id],
    );
    const after = await verRow(v.id);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect([after.status, after.revision, after.published_at, after.created_at]).toEqual([
      before.status,
      before.revision,
      before.published_at,
      before.created_at,
    ]);
    await setVer(v.id, 'RETIRED');
    expect((await verRow(v.id)).closed_at).not.toBeNull();
  });

  it.each(FROZEN_COLUMNS.filter(([c]) => !['created_at', 'published_at'].includes(c)))(
    'a draft cannot change %s in the statement that publishes it (VERSION_FROZEN), and the draft stays a DRAFT',
    async (_column, set) => {
      const t = await makeTpl({ status: 'ACTIVE' });
      const v = await makeDraftWithField(t);
      await expectRule(run(`UPDATE catalog.gig_template_versions SET status = 'ACTIVE', ${set} WHERE gig_template_version_id = $1`, [v.id]), 'VERSION_FROZEN');
      expect((await verRow(v.id)).status).toBe('DRAFT');
    },
  );

  it('a discard cannot invent a publication: a client-sent published_at or closed_at on DRAFT -> RETIRED is overwritten (published_at stays NULL, closed_at is the instant of the discard), and a withdrawal keeps the published_at of the version', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const d = await makeDraftWithField(t);
    await run(
      "UPDATE catalog.gig_template_versions SET status = 'RETIRED', published_at = '2001-01-01', closed_at = '2001-01-02' WHERE gig_template_version_id = $1",
      [d.id],
    );
    const r = await verRow(d.id);
    expect([r.status, r.published_at]).toEqual(['RETIRED', null]);
    expect(r.closed_at!.getFullYear()).toBeGreaterThan(2020);
    const v = await makePublished(t);
    const live = await verRow(v.id);
    await run("UPDATE catalog.gig_template_versions SET status = 'RETIRED' WHERE gig_template_version_id = $1", [v.id]);
    const w = await verRow(v.id);
    expect(w.published_at!.getTime()).toBe(live.published_at!.getTime());
    expect(w.closed_at!.getTime()).toBeGreaterThan(live.published_at!.getTime() - 1);
  });

  it('lets a draft be DISCARDED together with a change (it is not a publication), and keeps what was written', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    await run("UPDATE catalog.gig_template_versions SET status = 'RETIRED', revision = 9, min_duration_minutes = 5 WHERE gig_template_version_id = $1", [v.id]);
    expect(await q('SELECT status, revision, min_duration_minutes FROM catalog.gig_template_versions WHERE gig_template_version_id = $1', [v.id])).toEqual([
      { status: 'RETIRED', revision: 9, min_duration_minutes: 5 },
    ]);
  });
});

describe('D3c. publication: GIG_TEMPLATE_NOT_ACTIVE, SERVICE_TYPE_NOT_ACTIVE, the stamps, the automatic supersession and SUPERSEDED_IS_AUTOMATIC', () => {
  it.each([
    ['DRAFT', 'DRAFT'],
    ['INACTIVE', 'INACTIVE'],
  ] as [string, CatalogStatus][])(
    'GIG_TEMPLATE_NOT_ACTIVE: a draft of a %s template cannot be published; after the template is ACTIVE it can',
    async (_n, status) => {
      const t = await makeTpl({ status });
      const v = await makeDraftWithField(t);
      await expectRule(setVer(v.id, 'ACTIVE'), 'GIG_TEMPLATE_NOT_ACTIVE');
      expect((await verRow(v.id)).status).toBe('DRAFT');
      await setTpl(t.id, 'ACTIVE');
      await setVer(v.id, 'ACTIVE');
      expect((await verRow(v.id)).status).toBe('ACTIVE');
    },
  );

  it('SERVICE_TYPE_NOT_ACTIVE: a draft of an ACTIVE template cannot be published while its service type is INACTIVE or RETIRED (CAT-001 lets the service type leave ACTIVE under its templates); the template rule is reported first', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    await setSt(t.stId, 'INACTIVE');
    await expectRule(setVer(v.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    await setSt(t.stId, 'RETIRED');
    await expectRule(setVer(v.id, 'ACTIVE'), 'SERVICE_TYPE_NOT_ACTIVE');
    expect((await verRow(v.id)).status).toBe('DRAFT');
    // a paused template under a retired service type: the template rule wins
    await setTpl(t.id, 'INACTIVE');
    await expectRule(setVer(v.id, 'ACTIVE'), 'GIG_TEMPLATE_NOT_ACTIVE');
    // the draft can still be discarded
    await setVer(v.id, 'RETIRED');
  });

  it('stamps published_at with the transaction instant whatever the client sends, leaves closed_at NULL, bumps updated_at and keeps the revision', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeDraftWithField(t);
    await run('UPDATE catalog.gig_template_versions SET revision = 3 WHERE gig_template_version_id = $1', [v.id]);
    await sleep(3);
    await run(
      "UPDATE catalog.gig_template_versions SET status = 'ACTIVE', published_at = '2001-01-01', closed_at = '2001-01-02' WHERE gig_template_version_id = $1",
      [v.id],
    );
    const r = await verRow(v.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.revision).toBe(3);
    expect(r.closed_at).toBeNull();
    expect(r.published_at!.getFullYear()).toBeGreaterThan(2020);
    expect(r.published_at!.getTime()).toBe(r.updated_at.getTime());
  });

  it('supersedes the previous ACTIVE version IN THE SAME STATEMENT: inside the publishing transaction the old one is already SUPERSEDED (closed at the publication instant), and an older SUPERSEDED version is untouched', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v1 = await makePublished(t);
    const v2 = await makePublished(t);
    const v3 = await makeDraftWithField(t);
    const v2before = await verRow(v2.id);
    const v1before = await verRow(v1.id);
    const c = await openTx();
    try {
      await c.query("UPDATE catalog.gig_template_versions SET status = 'ACTIVE' WHERE gig_template_version_id = $1", [v3.id]);
      const inside = await q<{ n: number; status: string; closed_at: Date | null; published_at: Date }>(
        'SELECT version_number AS n, status, closed_at, published_at FROM catalog.gig_template_versions WHERE gig_template_id = $1 ORDER BY 1',
        [t.id],
        c,
      );
      expect(inside.map((r) => [r.n, r.status])).toEqual([
        [1, 'SUPERSEDED'],
        [2, 'SUPERSEDED'],
        [3, 'ACTIVE'],
      ]);
      expect(inside[1]!.closed_at!.getTime()).toBe(inside[2]!.published_at.getTime());
      // another session still sees the old state until the commit: exactly one ACTIVE version, never zero and never two
      expect(
        (await q<{ n: number }>("SELECT version_number AS n FROM catalog.gig_template_versions WHERE gig_template_id = $1 AND status = 'ACTIVE'", [t.id])).map(
          (r) => r.n,
        ),
      ).toEqual([2]);
    } finally {
      await finish(c, 'COMMIT');
    }
    expect((await verRow(v1.id)).closed_at!.getTime(), 'an older SUPERSEDED version is untouched').toBe(v1before.closed_at!.getTime());
    expect((await verRow(v2.id)).published_at!.getTime()).toBe(v2before.published_at!.getTime());
    expect(
      (await q<{ n: number }>("SELECT version_number AS n FROM catalog.gig_template_versions WHERE gig_template_id = $1 AND status = 'ACTIVE'", [t.id])).map(
        (r) => r.n,
      ),
    ).toEqual([3]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });

  it('keeps an older, RETIRED (withdrawn or discarded) version out of the supersession, and publishes a first version without touching anything else', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v1 = await makePublished(t);
    await setVer(v1.id, 'RETIRED'); // withdrawn
    const v2 = await makePublished(t);
    expect([(await verRow(v1.id)).status, (await verRow(v2.id)).status]).toEqual(['RETIRED', 'ACTIVE']);
    const other = await makeTpl({ status: 'ACTIVE' });
    const ov = await makePublished(other);
    expect((await verRow(ov.id)).status).toBe('ACTIVE');
    expect((await verRow(v2.id)).status, 'a publication in another template never supersedes this one').toBe('ACTIVE');
  });

  it('SUPERSEDED_IS_AUTOMATIC: a direct ACTIVE -> SUPERSEDED (one row, a bulk update, a DO block) is refused, and only the publication of a newer version sets it', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v1 = await makePublished(t);
    await expectRule(setVer(v1.id, 'SUPERSEDED'), 'SUPERSEDED_IS_AUTOMATIC');
    await expectRule(run("UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED' WHERE gig_template_id = $1", [t.id]), 'SUPERSEDED_IS_AUTOMATIC');
    await expectRule(
      run("DO $$ BEGIN UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED' WHERE gig_template_version_id = '" + v1.id + "'; END $$"),
      'SUPERSEDED_IS_AUTOMATIC',
    );
    expect((await verRow(v1.id)).status).toBe('ACTIVE');
    await makePublished(t);
    expect((await verRow(v1.id)).status).toBe('SUPERSEDED');
    // from the other statuses the transition rule answers first
    const d = await makeDraftWithField(t);
    await expectRule(setVer(d.id, 'SUPERSEDED'), 'STATUS_TRANSITION');
  });

  it('KNOWN LIMITATION (reported): "automatic" means pg_trigger_depth() >= 2, not "set by the publication": ANY trigger that updates a version reaches it, so a user-defined trigger (owner-level privilege) can supersede a version with no successor', async () => {
    const { v } = await makeLiveTemplate();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE TEMP TABLE bypass (n int)`);
      await c.query(
        `CREATE FUNCTION pg_temp.bypass_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED' WHERE gig_template_version_id = '${v.id}'; RETURN NEW; END $f$`,
      );
      await c.query('CREATE TRIGGER bypass_trg BEFORE INSERT ON bypass FOR EACH ROW EXECUTE FUNCTION pg_temp.bypass_fn()');
      await c.query('INSERT INTO bypass VALUES (1)');
      expect((await q<{ status: string }>('SELECT status FROM catalog.gig_template_versions WHERE gig_template_version_id = $1', [v.id], c))[0]!.status).toBe(
        'SUPERSEDED',
      );
      expect((await c.query(INVARIANTS.supersededWithoutSuccessor)).rows.length).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect((await verRow(v.id)).status).toBe('ACTIVE');
  });
});

describe('D4. the child guards: IMMUTABLE_IDENTITY, VERSION_NOT_DRAFT, CONTENT_KEY_MISMATCH, OPTIONS_ONLY_FOR_ENUM', () => {
  const NON_DRAFT: GigTemplateVersionStatus[] = ['ACTIVE', 'SUPERSEDED', 'RETIRED'];

  /** A DRAFT version with an ENUM field (two options), a TEXT field and a requirement: the rows the tests change. */
  async function fullDraft() {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeVersion(t);
    const text = await addField(v, { key: 'notes' });
    const en = await addField(v, { key: 'finish', type: 'ENUM' });
    await addOption(en, 'wax', { isDefault: true });
    await addOption(en, 'sealant');
    await addReq(v.id, 'SKILL', 'detailing_pro');
    return { t, v, text, en };
  }
  /** The same rows in a version of the given status (built as a draft, then moved by the machine). */
  async function fullIn(status: GigTemplateVersionStatus) {
    const d = await fullDraft();
    if (status === 'DRAFT') return d;
    if (status === 'RETIRED') {
      await setVer(d.v.id, 'RETIRED');
      return d;
    }
    await setVer(d.v.id, 'ACTIVE');
    if (status === 'SUPERSEDED') await makePublished(d.t);
    return d;
  }

  it.each(NON_DRAFT)(
    'VERSION_NOT_DRAFT: a %s version refuses every insert, update and delete of its fields, options and requirements; nothing changes',
    async (status) => {
      const { v, t, text, en } = await fullIn(status);
      const counts = async () => [
        await count(F, 'gig_template_version_id = $1', [v.id]),
        await count(O, 'gig_template_field_id = $1', [en.id]),
        await count(R, 'gig_template_version_id = $1', [v.id]),
      ];
      const before = await counts();
      const snapshot = async () =>
        q(
          'SELECT f.*, o.option_code, o.display_order AS option_order FROM catalog.gig_template_fields f LEFT JOIN catalog.gig_template_field_options o USING (gig_template_field_id) WHERE f.gig_template_version_id = $1 ORDER BY 1, o.option_code',
          [v.id],
        );
      const rows = await snapshot();
      // fields
      await expectRule(addField(v, { key: 'extra' }), 'VERSION_NOT_DRAFT');
      await expectRule(run("UPDATE catalog.gig_template_fields SET section = 'SCOPE' WHERE gig_template_field_id = $1", [text.id]), 'VERSION_NOT_DRAFT');
      await expectRule(
        run('UPDATE catalog.gig_template_fields SET customer_visible = NOT customer_visible WHERE gig_template_version_id = $1', [v.id]),
        'VERSION_NOT_DRAFT',
      );
      await expectRule(run('DELETE FROM catalog.gig_template_fields WHERE gig_template_field_id = $1', [text.id]), 'VERSION_NOT_DRAFT');
      await expectRule(run('DELETE FROM catalog.gig_template_fields WHERE gig_template_version_id = $1', [v.id]), 'VERSION_NOT_DRAFT');
      // options
      await expectRule(addOption(en, 'ceramic'), 'VERSION_NOT_DRAFT');
      await expectRule(run('UPDATE catalog.gig_template_field_options SET display_order = 9 WHERE gig_template_field_id = $1', [en.id]), 'VERSION_NOT_DRAFT');
      await expectRule(
        run("UPDATE catalog.gig_template_field_options SET is_default = NOT is_default WHERE gig_template_field_id = $1 AND option_code = 'wax'", [en.id]),
        'VERSION_NOT_DRAFT',
      );
      await expectRule(run('DELETE FROM catalog.gig_template_field_options WHERE gig_template_field_id = $1', [en.id]), 'VERSION_NOT_DRAFT');
      // requirements
      await expectRule(addReq(v.id, 'INSURANCE'), 'VERSION_NOT_DRAFT');
      await expectRule(
        run("UPDATE catalog.gig_template_requirements SET reference_code = 'other_ref' WHERE gig_template_version_id = $1", [v.id]),
        'VERSION_NOT_DRAFT',
      );
      await expectRule(run('DELETE FROM catalog.gig_template_requirements WHERE gig_template_version_id = $1', [v.id]), 'VERSION_NOT_DRAFT');
      expect(await counts()).toEqual(before);
      expect(await snapshot()).toEqual(rows);
      void t;
    },
  );

  it('a DRAFT accepts insert, update and delete of all three kinds of child (a field with options is deleted after its options: the options are a foreign key RESTRICT)', async () => {
    const { v, text, en } = await fullDraft();
    await run("UPDATE catalog.gig_template_fields SET section = 'SCOPE', customer_visible = false WHERE gig_template_field_id = $1", [text.id]);
    await run('UPDATE catalog.gig_template_field_options SET display_order = 9 WHERE gig_template_field_id = $1 AND option_code = $2', [en.id, 'sealant']);
    await run('UPDATE catalog.gig_template_requirements SET reference_code = $2 WHERE gig_template_version_id = $1', [v.id, 'other_ref']);
    await addReq(v.id, 'INSURANCE');
    await run('DELETE FROM catalog.gig_template_requirements WHERE gig_template_version_id = $1', [v.id]);
    await expectConstraint(run('DELETE FROM catalog.gig_template_fields WHERE gig_template_field_id = $1', [en.id]), 'fk_gig_template_field_options__field_id');
    await run('DELETE FROM catalog.gig_template_field_options WHERE gig_template_field_id = $1', [en.id]);
    await run('DELETE FROM catalog.gig_template_fields WHERE gig_template_version_id = $1', [v.id]);
    expect(await count(F, 'gig_template_version_id = $1', [v.id])).toBe(0);
  });

  it('IMMUTABLE_IDENTITY: refuses to change the id or the VERSION of a field, the FIELD of an option and the id or the version of a requirement, in a DRAFT too', async () => {
    const a = await fullDraft();
    const b = await fullDraft();
    await expectRule(
      run('UPDATE catalog.gig_template_fields SET gig_template_field_id = gen_random_uuid() WHERE gig_template_field_id = $1', [a.text.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.gig_template_fields SET gig_template_version_id = $2 WHERE gig_template_field_id = $1', [a.text.id, b.v.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.gig_template_field_options SET gig_template_field_id = $2 WHERE gig_template_field_id = $1', [a.en.id, b.en.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.gig_template_requirements SET gig_template_requirement_id = gen_random_uuid() WHERE gig_template_version_id = $1', [a.v.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.gig_template_requirements SET gig_template_version_id = $2 WHERE gig_template_version_id = $1', [a.v.id, b.v.id]),
      'IMMUTABLE_IDENTITY',
    );
    // the same values are accepted
    await run(
      'UPDATE catalog.gig_template_fields SET gig_template_field_id = gig_template_field_id, gig_template_version_id = gig_template_version_id WHERE gig_template_field_id = $1',
      [a.text.id],
    );
    await run('UPDATE catalog.gig_template_field_options SET gig_template_field_id = gig_template_field_id WHERE gig_template_field_id = $1', [a.en.id]);
    await run('UPDATE catalog.gig_template_requirements SET gig_template_requirement_id = gig_template_requirement_id WHERE gig_template_version_id = $1', [
      a.v.id,
    ]);
  });

  it('IMMUTABLE_IDENTITY is reported before VERSION_NOT_DRAFT: a field of a published version moved to another version is an identity violation, not a frozen one', async () => {
    const a = await fullIn('ACTIVE');
    const b = await fullDraft();
    await expectRule(
      run('UPDATE catalog.gig_template_fields SET gig_template_version_id = $2 WHERE gig_template_field_id = $1', [a.text.id, b.v.id]),
      'IMMUTABLE_IDENTITY',
    );
  });

  // ---- CONTENT_KEY_MISMATCH
  const wrongKeys = (code: string, key: string, suffix: string): [string, string][] => [
    ['the key of another field', `catalog.gig_template.${code}.field.other_field.${suffix}`],
    ['the key of another template', `catalog.gig_template.other_tpl.field.${key}.${suffix}`],
    ['another suffix', `catalog.gig_template.${code}.field.${key}.${suffix === 'label' ? 'help' : 'label'}`],
    ['a suffix with a trailing part', `catalog.gig_template.${code}.field.${key}.${suffix}.x`],
    ['the template key without the field part', `catalog.gig_template.${code}.${suffix}`],
    ['upper case', `catalog.gig_template.${code}.field.${key}.${suffix}`.toUpperCase()],
    ['a catalogue key of another kind', 'catalog.category.auto_services.name'],
  ];
  it.each(['label', 'help', 'default'])(
    'CONTENT_KEY_MISMATCH: the %s content key of a field must be the derivation from the template code and the field key; every other key (existing entries included) is refused, on INSERT and on UPDATE',
    async (kind) => {
      const { v, text } = await fullDraft();
      const column = `${kind}_content_key`;
      for (const [what, key] of wrongKeys(v.code, 'zzz_field', kind)) {
        const spec: FieldSpec = { key: 'zzz_field', content: 'PUBLISHED' };
        if (kind === 'label') spec.labelKey = key;
        if (kind === 'help') spec.helpKey = key;
        if (kind === 'default') spec.defaultKey = key;
        await expectRule(addField(v, spec), 'CONTENT_KEY_MISMATCH');
        void what;
      }
      for (const [, key] of wrongKeys(v.code, text.key, kind)) {
        await expectRule(run(`UPDATE catalog.gig_template_fields SET ${column} = $2 WHERE gig_template_field_id = $1`, [text.id, key]), 'CONTENT_KEY_MISMATCH');
      }
    },
  );

  it('CONTENT_KEY_MISMATCH: the derived help and default keys are accepted (and NULL is), the label can never be NULL, and a field key rename needs the label renamed in the same statement', async () => {
    const { v, text } = await fullDraft();
    await ensureContent(gigTemplateFieldHelpKey(v.code, text.key));
    await ensureContent(gigTemplateFieldDefaultKey(v.code, text.key));
    await run('UPDATE catalog.gig_template_fields SET help_content_key = $2, default_content_key = $3 WHERE gig_template_field_id = $1', [
      text.id,
      gigTemplateFieldHelpKey(v.code, text.key),
      gigTemplateFieldDefaultKey(v.code, text.key),
    ]);
    await run('UPDATE catalog.gig_template_fields SET help_content_key = NULL, default_content_key = NULL WHERE gig_template_field_id = $1', [text.id]);
    await expectNotNull(
      run('UPDATE catalog.gig_template_fields SET label_content_key = NULL WHERE gig_template_field_id = $1', [text.id]),
      'label_content_key',
    );
    await expectRule(
      run("UPDATE catalog.gig_template_fields SET field_key = 'renamed_key' WHERE gig_template_field_id = $1", [text.id]),
      'CONTENT_KEY_MISMATCH',
    );
    await ensureContent(gigTemplateFieldLabelKey(v.code, 'renamed_key'));
    await run("UPDATE catalog.gig_template_fields SET field_key = 'renamed_key', label_content_key = $2 WHERE gig_template_field_id = $1", [
      text.id,
      gigTemplateFieldLabelKey(v.code, 'renamed_key'),
    ]);
  });

  it('CONTENT_KEY_MISMATCH: the label key of an option is derived from the template code, the field key AND the option code; a field key rename while options exist is refused (0017, FIELD_HAS_OPTIONS), so they cannot be left behind', async () => {
    const { v, en } = await fullDraft();
    for (const [what, key] of [
      ['another option', gigTemplateOptionLabelKey(v.code, en.key, 'ceramic')],
      ['another field', gigTemplateOptionLabelKey(v.code, 'other_field', 'newopt')],
      ['another template', gigTemplateOptionLabelKey('other_tpl', en.key, 'newopt')],
      ['the field label', gigTemplateFieldLabelKey(v.code, en.key)],
      ['no .label suffix', `catalog.gig_template.${v.code}.field.${en.key}.option.newopt`],
      ['upper case', gigTemplateOptionLabelKey(v.code, en.key, 'newopt').toUpperCase()],
    ] as [string, string][]) {
      await expectRule(addOption(en, 'newopt', { labelKey: key }), 'CONTENT_KEY_MISMATCH');
      void what;
    }
    await ensureContent(gigTemplateOptionLabelKey(v.code, en.key, 'ceramic'));
    await expectRule(
      run('UPDATE catalog.gig_template_field_options SET label_content_key = $3 WHERE gig_template_field_id = $1 AND option_code = $2', [
        en.id,
        'wax',
        gigTemplateOptionLabelKey(v.code, en.key, 'ceramic'),
      ]),
      'CONTENT_KEY_MISMATCH',
    );
    await expectRule(
      run("UPDATE catalog.gig_template_field_options SET option_code = 'ceramic' WHERE gig_template_field_id = $1 AND option_code = 'wax'", [en.id]),
      'CONTENT_KEY_MISMATCH',
    ); // the code moved, the label did not
    await run(
      "UPDATE catalog.gig_template_field_options SET option_code = 'ceramic', label_content_key = $2 WHERE gig_template_field_id = $1 AND option_code = 'wax'",
      [en.id, gigTemplateOptionLabelKey(v.code, en.key, 'ceramic')],
    );
    // the field key cannot be renamed under its options: they would keep labels derived from the old key
    await ensureContent(gigTemplateFieldLabelKey(v.code, 'moved_finish'));
    await expectRule(
      run("UPDATE catalog.gig_template_fields SET field_key = 'moved_finish', label_content_key = $2 WHERE gig_template_field_id = $1", [
        en.id,
        gigTemplateFieldLabelKey(v.code, 'moved_finish'),
      ]),
      'FIELD_HAS_OPTIONS',
    );
    expect((await q<{ field_key: string }>('SELECT field_key FROM catalog.gig_template_fields WHERE gig_template_field_id = $1', [en.id]))[0]!.field_key).toBe(
      en.key,
    );
    expect(
      (
        await q<{ label_content_key: string }>(
          'SELECT label_content_key FROM catalog.gig_template_field_options WHERE gig_template_field_id = $1 AND option_code = $2',
          [en.id, 'sealant'],
        )
      )[0]!.label_content_key,
    ).toBe(gigTemplateOptionLabelKey(v.code, en.key, 'sealant'));
  });

  it.each(GIG_TEMPLATE_FIELD_TYPES.filter((t) => t !== 'ENUM'))(
    'OPTIONS_ONLY_FOR_ENUM: a %s field refuses an option, and the rule is reported before the label check',
    async (type) => {
      const t = await makeTpl({ status: 'ACTIVE' });
      const v = await makeVersion(t);
      const f = await addField(v, { type });
      await expectRule(addOption(f, 'wax'), 'OPTIONS_ONLY_FOR_ENUM');
      await ensureEntry('catalog.gig_template.not.a.derived.key');
      await expectRule(addOption(f, 'wax', { labelKey: 'catalog.gig_template.not.a.derived.key' }), 'OPTIONS_ONLY_FOR_ENUM');
      expect(await count(O, 'gig_template_field_id = $1', [f.id])).toBe(0);
    },
  );

  it('FIELD_HAS_OPTIONS (0017): the TYPE and the KEY of a field that has options cannot change, so a frozen version never carries options under a non-ENUM field; the rest of the field stays editable', async () => {
    const { v, en } = await fullDraft();
    await expectRule(run("UPDATE catalog.gig_template_fields SET field_type = 'TEXT' WHERE gig_template_field_id = $1", [en.id]), 'FIELD_HAS_OPTIONS');
    expect(await count(O, 'gig_template_field_id = $1', [en.id])).toBe(2);
    await run('UPDATE catalog.gig_template_fields SET customer_visible = false WHERE gig_template_field_id = $1', [en.id]); // other columns are free
    expect(
      (await q<{ field_type: string }>('SELECT field_type FROM catalog.gig_template_fields WHERE gig_template_field_id = $1', [en.id]))[0]!.field_type,
    ).toBe('ENUM');
    // once the options are gone the type can change (and the field then takes none)
    await run('DELETE FROM catalog.gig_template_field_options WHERE gig_template_field_id = $1', [en.id]);
    await run("UPDATE catalog.gig_template_fields SET field_type = 'TEXT' WHERE gig_template_field_id = $1", [en.id]);
    void v;
  });

  it('the publication backstops the option rules even when the field guard was out of the way: options under a non-ENUM field (OPTIONS_ONLY_FOR_ENUM) and an option label that does not follow the derivation (CONTENT_KEY_MISMATCH) refuse the publication', async () => {
    for (const [rule, craft] of [
      ['OPTIONS_ONLY_FOR_ENUM', (id: string) => `UPDATE catalog.gig_template_fields SET field_type = 'TEXT' WHERE gig_template_field_id = '${id}'`],
      [
        'CONTENT_KEY_MISMATCH',
        (id: string) =>
          `UPDATE catalog.gig_template_field_options SET label_content_key = (SELECT label_content_key FROM catalog.gig_template_fields WHERE gig_template_field_id = '${id}') WHERE gig_template_field_id = '${id}' AND option_code = 'wax'`,
      ],
    ] as const) {
      const { v, en } = await fullDraft();
      // crafted as the table owner with the user triggers off for one transaction, which is the only way to reach the state
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('ALTER TABLE catalog.gig_template_fields DISABLE TRIGGER USER');
        await c.query('ALTER TABLE catalog.gig_template_field_options DISABLE TRIGGER USER');
        await c.query(craft(en.id));
        await c.query('ALTER TABLE catalog.gig_template_fields ENABLE TRIGGER USER');
        await c.query('ALTER TABLE catalog.gig_template_field_options ENABLE TRIGGER USER');
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
      await expectRule(setVer(v.id, 'ACTIVE'), rule);
      expect((await verRow(v.id)).status).toBe('DRAFT');
    }
  });

  it('field rows keep their own CHECKs when updated: the metadata matrix applies to UPDATE (a TEXT field cannot be given a boolean default), and a type change must satisfy it', async () => {
    const { text, en } = await fullDraft();
    await expectConstraint(
      run('UPDATE catalog.gig_template_fields SET default_boolean = true WHERE gig_template_field_id = $1', [text.id]),
      'ck_gig_template_fields__boolean_meta',
    );
    await expectConstraint(
      run("UPDATE catalog.gig_template_fields SET field_type = 'MONEY', min_length = 1 WHERE gig_template_field_id = $1", [text.id]),
      'ck_gig_template_fields__text_meta',
    );
    await expectConstraint(
      run("UPDATE catalog.gig_template_fields SET behavior = 'PLATFORM_FIXED' WHERE gig_template_field_id = $1", [text.id]),
      'ck_gig_template_fields__fixed',
    );
    await run("UPDATE catalog.gig_template_fields SET behavior = 'PLATFORM_FIXED' WHERE gig_template_field_id = $1", [en.id]); // an ENUM needs no column: the default option is checked at publication
  });

  it('the parent of a child row is read FOR SHARE: a version row locked by a draft edit holds back a field insert only while the lock is open (no row is left locked afterwards)', async () => {
    const { v } = await fullDraft();
    const tx = await openTx();
    try {
      await tx.query('UPDATE catalog.gig_template_versions SET revision = revision + 1 WHERE gig_template_version_id = $1', [v.id]);
      const racing = rejection(addField(v, { key: `blocked_${++fieldSeq}` }, racePool));
      await lockWaiters(1);
      await finish(tx, 'COMMIT');
      expect(await racing).toBeUndefined();
    } catch (e) {
      await finish(tx, 'ROLLBACK').catch(() => undefined);
      throw e;
    }
    await noLockWaiters();
  });
});

describe('D5. guard_market_gig_templates: NOT_DELETABLE, IMMUTABLE_IDENTITY, ITEM_RETIRED', () => {
  it('NOT_DELETABLE: refuses to delete a disabled row, an enabled row and every row at once', async () => {
    const m = await makeMarket();
    const [a, b] = [await makeTpl(), await makeTpl()];
    await addMarketRow(m.id, a.id, { enabled: false });
    await addMarketRow(m.id, b.id, { enabled: true });
    const before = await count(M);
    await expectRule(run('DELETE FROM catalog.market_gig_templates WHERE market_id = $1 AND gig_template_id = $2', [m.id, a.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.market_gig_templates WHERE market_id = $1 AND gig_template_id = $2', [m.id, b.id]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM catalog.market_gig_templates'), 'NOT_DELETABLE');
    expect(await count(M)).toBe(before);
  });

  it('IMMUTABLE_IDENTITY: refuses to move a row to another market or another template, disabled or enabled, and reports it before the retired rule', async () => {
    const [m1, m2] = [await makeMarket(), await makeMarket()];
    const [a, b] = [await makeTpl(), await makeTpl()];
    const retired = await makeTpl({ status: 'RETIRED' });
    await addMarketRow(m1.id, a.id, { enabled: false });
    await expectRule(
      run('UPDATE catalog.market_gig_templates SET market_id = $3 WHERE market_id = $1 AND gig_template_id = $2', [m1.id, a.id, m2.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.market_gig_templates SET gig_template_id = $3 WHERE market_id = $1 AND gig_template_id = $2', [m1.id, a.id, b.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run('UPDATE catalog.market_gig_templates SET gig_template_id = $3, enabled = true WHERE market_id = $1 AND gig_template_id = $2', [
        m1.id,
        a.id,
        retired.id,
      ]),
      'IMMUTABLE_IDENTITY',
    );
    await run('UPDATE catalog.market_gig_templates SET market_id = market_id, gig_template_id = gig_template_id WHERE market_id = $1', [m1.id]);
  });

  it('ITEM_RETIRED: a RETIRED template cannot be enabled by INSERT or by UPDATE, but a DISABLED row can be prepared for it, and nothing blocks a DRAFT, ACTIVE or INACTIVE template', async () => {
    const m = await makeMarket();
    for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE'] as CatalogStatus[]) await addMarketRow(m.id, (await makeTpl({ status })).id, { enabled: true });
    const retired = await makeTpl({ status: 'RETIRED' });
    await expectRule(addMarketRow(m.id, retired.id, { enabled: true }), 'ITEM_RETIRED');
    expect(await count(M, 'gig_template_id = $1', [retired.id])).toBe(0);
    await addMarketRow(m.id, retired.id, { enabled: false });
    await expectRule(setMgt(m.id, retired.id, true), 'ITEM_RETIRED');
    expect((await q<{ enabled: boolean }>('SELECT enabled FROM catalog.market_gig_templates WHERE gig_template_id = $1', [retired.id]))[0]!.enabled).toBe(
      false,
    );
    await setMgt(m.id, retired.id, false); // false -> false is not an enabling
  });

  it('ITEM_RETIRED only guards the moment of ENABLING: retiring a template that is already enabled leaves the row enabled (the service excludes it by status), it can be switched off, and never back on', async () => {
    const m = await makeMarket();
    const t = await makeTpl({ status: 'ACTIVE' });
    await addMarketRow(m.id, t.id, { enabled: true });
    await setTpl(t.id, 'RETIRED');
    expect((await q<{ enabled: boolean }>('SELECT enabled FROM catalog.market_gig_templates WHERE gig_template_id = $1', [t.id]))[0]!.enabled).toBe(true);
    await run('UPDATE catalog.market_gig_templates SET display_order = display_order + 1000 WHERE gig_template_id = $1', [t.id]); // true -> true: allowed
    await setMgt(m.id, t.id, false);
    await expectRule(setMgt(m.id, t.id, true), 'ITEM_RETIRED');
  });

  it('prepares availability for a template of ANY status and a market of ANY status (PLANNED including the seeded la-oc, ACTIVE, INACTIVE): the database holds no rule about either', async () => {
    const la = await laOc();
    const [a, b] = [await makeMarket(), await makeMarket()];
    await run("UPDATE geography.markets SET status = 'ACTIVE' WHERE market_id = $1", [b.id]);
    await run("UPDATE geography.markets SET status = 'INACTIVE' WHERE market_id = $1", [b.id]);
    for (const market of [la, a.id, b.id])
      for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE'] as CatalogStatus[]) await addMarketRow(market, (await makeTpl({ status })).id, { enabled: true });
  });

  it('maintains updated_at itself and keeps created_at: a client-sent date is ignored on every write', async () => {
    const m = await makeMarket();
    const t = await makeTpl();
    await addMarketRow(m.id, t.id, { order: 77 });
    const first = (
      await q<{ created_at: Date; updated_at: Date }>('SELECT created_at, updated_at FROM catalog.market_gig_templates WHERE gig_template_id = $1', [t.id])
    )[0]!;
    await sleep(3);
    await run("UPDATE catalog.market_gig_templates SET enabled = true, created_at = '2000-01-01', updated_at = '2000-01-02' WHERE gig_template_id = $1", [
      t.id,
    ]);
    const second = (
      await q<{ created_at: Date; updated_at: Date }>('SELECT created_at, updated_at FROM catalog.market_gig_templates WHERE gig_template_id = $1', [t.id])
    )[0]!;
    expect(second.created_at.getTime()).toBe(first.created_at.getTime());
    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
    await run(
      "INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, display_order, created_at, updated_at) VALUES ($1, $2, 78, '2000-01-01', '2000-01-02')",
      [m.id, (await makeTpl()).id],
    );
    const ins = (
      await q<{ created_at: Date; updated_at: Date }>(
        'SELECT created_at, updated_at FROM catalog.market_gig_templates WHERE display_order = 78 AND market_id = $1',
        [m.id],
      )
    )[0]!;
    expect(ins.updated_at.getFullYear(), 'updated_at is stamped with the instant of the insert').toBeGreaterThan(2020);
    expect(
      ins.created_at.toISOString().slice(0, 10),
      'created_at of a market row is taken from the client on INSERT (as in CAT-001): a plain default, not a guard rule',
    ).toBe('2000-01-01');
  });
});

describe('E. updated_at is maintained by the guards, created_at is kept, on gig_templates and gig_template_versions', () => {
  it('sets updated_at on every UPDATE of a template whatever the client sends (an old date, a future date, NULL, nothing) and keeps created_at', async () => {
    const t = await makeTpl();
    const first = await tplRow(t.id);
    for (const value of ["'2000-01-01'", "'2999-01-01'", 'NULL', 'DEFAULT']) {
      await sleep(3);
      const prev = await tplRow(t.id);
      await run(`UPDATE catalog.gig_templates SET updated_at = ${value}, description_content_key = description_content_key WHERE gig_template_id = $1`, [t.id]);
      const now = await tplRow(t.id);
      expect(now.updated_at.getTime(), value).toBeGreaterThan(prev.updated_at.getTime());
      expect(now.created_at.getTime()).toBe(first.created_at.getTime());
      expect(now.updated_at.getFullYear()).toBeLessThan(2100);
    }
  });

  it('ignores an UPDATE of created_at on a template and a version (an old value, a future value, NULL) while updated_at still moves', async () => {
    const t = await makeTpl({ status: 'ACTIVE' });
    const v = await makeVersion(t);
    const [tFirst, vFirst] = [await tplRow(t.id), await verRow(v.id)];
    await sleep(3);
    await run("UPDATE catalog.gig_templates SET created_at = '2000-01-01' WHERE gig_template_id = $1", [t.id]);
    await run('UPDATE catalog.gig_templates SET created_at = NULL WHERE gig_template_id = $1', [t.id]);
    await run("UPDATE catalog.gig_template_versions SET created_at = '2999-01-01' WHERE gig_template_version_id = $1", [v.id]);
    await run('UPDATE catalog.gig_template_versions SET created_at = NULL WHERE gig_template_version_id = $1', [v.id]);
    const [tNow, vNow] = [await tplRow(t.id), await verRow(v.id)];
    expect([tNow.created_at.getTime(), vNow.created_at.getTime()]).toEqual([tFirst.created_at.getTime(), vFirst.created_at.getTime()]);
    expect(tNow.updated_at.getTime()).toBeGreaterThan(tFirst.updated_at.getTime());
    expect(vNow.updated_at.getTime()).toBeGreaterThan(vFirst.updated_at.getTime());
  });

  it('uses one instant per transaction (now()) for every row a statement writes: a template and the version its retirement closes share the instant', async () => {
    const { t, v } = await makeLiveTemplate();
    await setTpl(t.id, 'RETIRED');
    expect((await verRow(v.id)).updated_at.getTime()).toBe((await tplRow(t.id)).updated_at.getTime());
  });
});
