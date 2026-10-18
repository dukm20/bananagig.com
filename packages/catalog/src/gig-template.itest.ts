// Integration tests of GigTemplateService (CAT-002) over a real, freshly migrated PostgreSQL database (migrations 0015 and 0016 with their guard triggers and seeds).
//
// Written by an author who did not write the service. Everything is asserted against the rows the database holds (templates, versions, fields, options, requirements, audit,
// outbox, availability), never against the service's own return value alone. The public market gate is a fake the test controls (the real one lives in the API composition root
// and asks the geography registry); the cache is an in-memory ConfigCache fake that can also fail, hang and lose a bump. The hierarchy (categories, service types and their
// market availability) is built with CatalogService, the content entries of the templates by plain SQL (the catalogue package does not depend on the content package; the
// column list is the one migration 0016 uses for its own seed). Codes are unique per test (`devtest_...`), so the tests do not depend on each other, and the database is
// private to this file.
//
// Defence in depth: the guard triggers make some states impossible (an ACTIVE version under a RETIRED template, an ACTIVE service type under an INACTIVE category). The public
// query still filters on them, so those states are CRAFTED by disabling the user triggers as the table owner, in a committed statement, and are always restored. A filter
// only the triggers enforce would pass every other test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryConfigCache } from '@bananagig/configuration';
import { CATALOG_STATUSES, GIG_TEMPLATE_EVENTS, isCatalogTransitionAllowed, type CatalogStatus } from '@bananagig/contracts';
import { createDatabase } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, createTestPool, deferred, rejection, sleep, type Deferred, type IsolatedDatabase } from '@bananagig/testing';
import { CatalogError, CatalogService, GigTemplateService, mapDbError, type MarketGate, type PublicMarket } from './index';

// every log call of the code under test is captured here (and nothing is printed)
const logSink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.lines.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});

type Pool = ReturnType<typeof createTestPool>;
type Row = Record<string, unknown>;
const ACTOR = 'admin:alice';
const REASON = 'integration test';
const COPY_BODY = 'SECRET-COPY-BODY';

// ---------------------------------------------------------------- environment
let iso: IsolatedDatabase;
let pool: Pool;
const statements: string[] = [];
const gateState = { markets: new Map<string, PublicMarket>(), asked: [] as string[] };
const gate: MarketGate = {
  publicMarket: async (c) => {
    gateState.asked.push(c);
    return gateState.markets.get(c) ?? null;
  },
};

/** An in-memory cache that can be told to fail, hang, lose the generation bump, or hold the next write (to order a slow reader against a commit). */
class TestCache extends MemoryConfigCache {
  mode: 'ok' | 'throw' | 'hang' | 'lose-bump' = 'ok';
  holdNextSet: Deferred | undefined;
  readonly incrs: string[] = [];
  readonly sets: { key: string; ttl: number | undefined }[] = [];
  readonly gets: string[] = [];
  private broken(): Promise<never> | undefined {
    if (this.mode === 'throw') return Promise.reject(new Error('cache is down'));
    if (this.mode === 'hang') return new Promise<never>(() => undefined);
    return undefined;
  }
  override async get(key: string): Promise<string | null> {
    this.gets.push(key);
    await this.broken();
    return super.get(key);
  }
  override async set(key: string, value: string, ttl?: number): Promise<void> {
    this.sets.push({ key, ttl });
    await this.broken();
    const hold = this.holdNextSet;
    if (hold) {
      this.holdNextSet = undefined;
      await hold.promise;
    }
    await super.set(key, value);
  }
  override async incr(key: string): Promise<void> {
    this.incrs.push(key);
    await this.broken();
    if (this.mode === 'lose-bump') return;
    await super.incr(key);
  }
  gen(): number {
    return Number(this.data.get('bg:test:cat:gen') ?? 0);
  }
}
let cache: TestCache;
let gt: GigTemplateService; // with the cache
let bare: GigTemplateService; // without a cache: the truth-table tests do not depend on cache correctness
let strict: GigTemplateService; // allowTestKeys off
let cat: CatalogService; // the hierarchy, over the same cache and so over the same generation counter

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { overrides: { poolMax: 40, connectionTimeoutMs: 30_000 }, onQuery: (e) => statements.push(e.sql) } });
  pool = createTestPool(iso.url, 10);
  cache = new TestCache();
  const deps = { database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cacheDeadlineMs: 150 };
  gt = new GigTemplateService({ ...deps, cache });
  bare = new GigTemplateService(deps);
  strict = new GigTemplateService({ ...deps, allowTestKeys: false });
  cat = new CatalogService({ ...deps, cache });
});
afterEach(async () => {
  for (const rollback of openRaw) await rollback().catch(() => undefined);
  openRaw.clear();
});
afterAll(async () => {
  await pool?.end();
  await iso?.drop();
});

const q = async <T = Row>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
const one = async <T = Row>(text: string, params: unknown[] = []): Promise<T> => (await q<T>(text, params))[0]!;

// ---------------------------------------------------------------- builders
let seq = 0;
const code = (prefix: string): string => `devtest_${prefix}${++seq}`;
const orders = new Map<string, number>();
/** The next free display order of a market for a kind (gaps of 10, as the data model suggests). */
const nextOrder = (market: string, kind: 'c' | 's' | 't'): number => {
  const k = `${market}/${kind}`;
  const v = (orders.get(k) ?? 0) + 10;
  orders.set(k, v);
  return v;
};

/** Content entries (and, by `mode`, their copy) by plain SQL, as the content registry would hold them: published = a PUBLISHED platform version in force now in the default locale. */
async function putContent(keys: string[], mode: 'published' | 'draft' | 'entry' = 'published'): Promise<void> {
  if (keys.length === 0) return;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'PLAIN_TEXT', 'CONTENT', 'gig template integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'gt-itest' FROM unnest($1::text[]) AS k
     ON CONFLICT (key) DO NOTHING`,
    [keys],
  );
  if (mode === 'entry') return;
  await q(
    `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
     SELECT e.entry_id, 'en-US', 'PLATFORM', NULL, 1, $2 || e.key, 'DRAFT', 'NONE', now(), 'gt itest', 'gt-itest' FROM content.entries e
      WHERE e.key = ANY($1) AND NOT EXISTS (SELECT 1 FROM content.versions v WHERE v.entry_id = e.entry_id)`,
    [keys, COPY_BODY],
  );
  if (mode === 'draft') return;
  await q(
    `UPDATE content.versions v SET status = 'APPROVED', updated_at = now() FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = ANY($1) AND v.status = 'DRAFT'`,
    [keys],
  );
  await q(
    `UPDATE content.versions v SET status = 'PUBLISHED', updated_at = now() FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = ANY($1) AND v.status = 'APPROVED'`,
    [keys],
  );
}

const stem = (c: string): string => `catalog.gig_template.${c}`;
const nameKey = (c: string): string => `${stem(c)}.name`;
const descKey = (c: string): string => `${stem(c)}.description`;
const instrKey = (c: string): string => `${stem(c)}.instructions`;
interface FieldIn {
  fieldKey: string;
  options?: { optionCode: string; isDefault?: boolean }[];
  withHelp?: boolean;
  withDefaultText?: boolean;
  [k: string]: unknown;
}
/** The content keys a definition references, derived HERE (not by the code under test). */
function keysOfFields(c: string, fields: FieldIn[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    out.push(`${stem(c)}.field.${f.fieldKey}.label`);
    if (f.withHelp) out.push(`${stem(c)}.field.${f.fieldKey}.help`);
    if (f.withDefaultText) out.push(`${stem(c)}.field.${f.fieldKey}.default`);
    for (const o of f.options ?? []) out.push(`${stem(c)}.field.${f.fieldKey}.option.${o.optionCode}.label`);
  }
  return out;
}

async function mkCategory(): Promise<string> {
  const c = code('c');
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     VALUES ($1, 'UI_LABEL', 'CONTENT', 'catalog integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'gt-itest')`,
    [`catalog.category.${c}.name`],
  );
  await cat.createCategory({ code: c, reason: REASON }, ACTOR);
  return c;
}
async function mkServiceType(categoryCode: string): Promise<string> {
  const c = code('s');
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     VALUES ($1, 'UI_LABEL', 'CONTENT', 'catalog integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'gt-itest')`,
    [`catalog.service_type.${c}.name`],
  );
  await cat.createServiceType({ code: c, categoryCode, reason: REASON }, ACTOR);
  return c;
}
/** A market row of ANY status (PLANNED, like the seeded la-oc); public (the fake gate says so) only on request. */
async function mkMarket(publicMarket = false): Promise<string> {
  const c = `devtest-m${++seq}`;
  await q(
    `WITH m AS (
       INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT $1, 'Test market', country_id, 'PLANNED', default_locale, currency_code, default_time_zone_id, now() FROM geography.markets WHERE code = 'la-oc'
       RETURNING market_id, country_id, default_locale)
     INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, default_locale FROM m`,
    [c],
  );
  if (publicMarket) gateState.markets.set(c, { code: c, defaultLocale: 'en-US' });
  return c;
}
const setCat = (c: string, status: CatalogStatus) => cat.setCategoryStatus(c, { status, reason: REASON }, ACTOR);
const setSt = (c: string, status: CatalogStatus) => cat.setServiceTypeStatus(c, { status, reason: REASON }, ACTOR);
const catAvail = (market: string, c: string, enabled: boolean, displayOrder?: number) =>
  cat.setMarketCategoryAvailability(market, c, { enabled, ...(displayOrder === undefined ? {} : { displayOrder }), reason: REASON }, ACTOR);
const stAvail = (market: string, c: string, enabled: boolean, displayOrder?: number) =>
  cat.setMarketServiceTypeAvailability(market, c, { enabled, ...(displayOrder === undefined ? {} : { displayOrder }), reason: REASON }, ACTOR);

interface Env {
  market: string;
  category: string;
  st: string;
}
/** A public market with an ACTIVE category and an ACTIVE service type, both enabled in it: the chain above a template, ready. */
async function mkEnv(o: { publicMarket?: boolean } = {}): Promise<Env> {
  const market = await mkMarket(o.publicMarket ?? true);
  const category = await mkCategory();
  const st = await mkServiceType(category);
  await setCat(category, 'ACTIVE');
  await catAvail(market, category, true, nextOrder(market, 'c'));
  await stAvail(market, st, true, nextOrder(market, 's'));
  await setSt(st, 'ACTIVE');
  return { market, category, st };
}
/** A service type with its own ACTIVE category, not enabled in any market (the chain above a template in the management tests). */
async function mkServiceTypeActive(): Promise<{ category: string; st: string }> {
  const category = await mkCategory();
  const st = await mkServiceType(category);
  await setCat(category, 'ACTIVE');
  await setSt(st, 'ACTIVE');
  return { category, st };
}

interface TplOpts {
  code?: string;
  description?: boolean;
  instructions?: boolean;
  /** Publish the copy of the template itself (default true). */
  publishedCopy?: boolean;
  activate?: boolean;
  via?: GigTemplateService;
}
async function mkTemplate(st: string, o: TplOpts = {}): Promise<string> {
  const c = o.code ?? code('t');
  const keys = [nameKey(c), ...(o.description ? [descKey(c)] : []), ...(o.instructions ? [instrKey(c)] : [])];
  await putContent(keys, o.publishedCopy === false ? 'entry' : 'published');
  const svc = o.via ?? gt;
  await svc.createGigTemplate(
    {
      code: c,
      serviceTypeCode: st,
      reason: REASON,
      ...(o.description ? { withDescription: true } : {}),
      ...(o.instructions ? { withInstructions: true } : {}),
    },
    ACTOR,
  );
  if (o.activate) await svc.setGigTemplateStatus(c, { status: 'ACTIVE', reason: REASON }, ACTOR);
  return c;
}

/** The standard definition: 6 fields of 5 types, an enum with options, a fixed long text and a fixed false boolean, duration, 2 pricing and 2 area models, 2 requirements. */
const stdFields = (): FieldIn[] => [
  { fieldKey: 'scope_notes', fieldType: 'TEXT', section: 'SCOPE', behavior: 'PROVIDER_REQUIRED', withHelp: true, minLength: 10, maxLength: 500 },
  {
    fieldKey: 'finish',
    fieldType: 'ENUM',
    section: 'INCLUSIONS',
    behavior: 'PROVIDER_CONFIGURABLE',
    options: [{ optionCode: 'wax', isDefault: true }, { optionCode: 'sealant' }, { optionCode: 'ceramic' }],
  },
  { fieldKey: 'vehicles', fieldType: 'INTEGER', behavior: 'PROVIDER_REQUIRED', minNumber: 1, maxNumber: 4, defaultNumber: 1 },
  { fieldKey: 'photos', fieldType: 'MEDIA', behavior: 'PROVIDER_CONFIGURABLE', minItems: 0, maxItems: 8 },
  { fieldKey: 'intro', fieldType: 'LONG_TEXT', section: 'PREPARATION', behavior: 'PLATFORM_FIXED', withDefaultText: true, customerVisible: false },
  { fieldKey: 'is_mobile', fieldType: 'BOOLEAN', behavior: 'PLATFORM_FIXED', defaultBoolean: false },
];
const stdRequirements = () => [{ requirementType: 'SKILL', referenceCode: 'wax_application' }, { requirementType: 'LICENSE' }];
const def = (expectedRevision: number, over: Record<string, unknown> = {}) => ({
  expectedRevision,
  duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
  pricingModels: ['FIXED', 'BUNDLE_ELIGIBLE'],
  areaModes: ['RADIUS', 'POSTAL_CODES'],
  fields: stdFields(),
  requirements: stdRequirements(),
  reason: REASON,
  ...over,
});
/** The copy of every key the definition references, published (the publication needs it). */
const copyFor = (c: string, fields: FieldIn[] = stdFields()) => putContent(keysOfFields(c, fields));

const createDraft = (c: string, copyFromVersion?: number, via: GigTemplateService = gt) =>
  via.createGigTemplateVersion(c, { ...(copyFromVersion === undefined ? {} : { copyFromVersion }), reason: REASON }, ACTOR);
const replaceDraft = (c: string, n: number, body: Record<string, unknown>, via: GigTemplateService = gt) => via.replaceGigTemplateDraft(c, n, body, ACTOR);
const publish = (c: string, n: number, expectedRevision: number, via: GigTemplateService = gt) =>
  via.publishGigTemplateVersion(c, n, { expectedRevision, reason: REASON }, ACTOR);
const discard = (c: string, n: number, via: GigTemplateService = gt) => via.retireGigTemplateVersion(c, n, { status: 'RETIRED', reason: REASON }, ACTOR);
const setTpl = (c: string, status: CatalogStatus, via: GigTemplateService = gt) => via.setGigTemplateStatus(c, { status, reason: REASON }, ACTOR);
const tplAvail = (market: string, c: string, enabled: boolean, displayOrder?: number | 'auto', via: GigTemplateService = gt) =>
  via.setMarketGigTemplateAvailability(
    market,
    c,
    { enabled, ...(displayOrder === undefined ? {} : { displayOrder: displayOrder === 'auto' ? nextOrder(market, 't') : displayOrder }), reason: REASON },
    ACTOR,
  );
/** A template with copy for the standard definition and a draft v1 holding it (revision 2 after the replace). */
async function mkDraftTemplate(st: string, o: TplOpts = {}): Promise<{ code: string; revision: number }> {
  const c = await mkTemplate(st, o);
  await copyFor(c);
  await createDraft(c);
  const v = await replaceDraft(c, 1, def(1));
  return { code: c, revision: v.revision! };
}
/** An ACTIVE template with a PUBLISHED version 1. */
async function mkPublished(st: string, o: TplOpts = {}): Promise<string> {
  const { code: c, revision } = await mkDraftTemplate(st, { activate: true, ...o });
  await publish(c, 1, revision);
  return c;
}
/** A template that is PUBLIC in the env: published v1, ACTIVE, enabled in the market. */
async function mkPublic(env: Env, o: TplOpts = {}): Promise<string> {
  const c = await mkPublished(env.st, o);
  await tplAvail(env.market, c, true, 'auto');
  return c;
}

// ---------------------------------------------------------------- observation
const err = async (p: Promise<unknown>): Promise<CatalogError | undefined> => (await rejection(p)) as CatalogError | undefined;
const expectError = async (p: Promise<unknown>, codeWanted: string, reasonWanted?: string): Promise<CatalogError> => {
  const e = await err(p);
  expect(e, `expected ${codeWanted}`).toBeInstanceOf(CatalogError);
  expect(e!.code).toBe(codeWanted);
  if (reasonWanted !== undefined) expect(e!.details.reason).toBe(reasonWanted);
  return e!;
};
const counting = async <T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[]; gate: string[] }> => {
  const s0 = statements.length;
  const g0 = gateState.asked.length;
  const result = await fn();
  return { result, sql: statements.slice(s0), gate: gateState.asked.slice(g0) };
};
const keys = (o: object): string[] => Object.keys(o).sort();

interface AuditRow {
  action: string;
  actor: string;
  changes: Record<string, unknown> | null;
  reason: string;
  correlation_id: string;
  version_number: number | null;
  market_code: string | null;
}
const tplAudit = (c: string) =>
  q<AuditRow>(
    `SELECT a.action, a.actor, a.changes, a.reason, a.correlation_id, v.version_number, m.code AS market_code
       FROM catalog.audit_events a JOIN catalog.gig_templates t ON t.gig_template_id = a.gig_template_id
       LEFT JOIN catalog.gig_template_versions v ON v.gig_template_version_id = a.gig_template_version_id
       LEFT JOIN geography.markets m ON m.market_id = a.market_id
      WHERE t.code = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [c],
  );
const auditActions = async (c: string) => (await tplAudit(c)).map((a) => a.action);
interface OutboxRow {
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: Record<string, unknown>;
  correlation_id: string;
  causation_id: string | null;
  published_at: Date | null;
}
const OUTBOX_COLS = 'event_type, event_version, aggregate_type, aggregate_id, actor_type, actor_id, payload_json, correlation_id, causation_id, published_at';
const tplEvents = (c: string, type?: string) =>
  q<OutboxRow>(
    `SELECT ${OUTBOX_COLS} FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.gig-template-%' AND payload_json->>'gigTemplateCode' = $1
        AND ($2::text IS NULL OR event_type = $2) ORDER BY created_at, event_type`,
    [c, type ?? null],
  );
const counts = async () => ({
  audit: (await one<{ n: number }>('SELECT count(*)::int AS n FROM catalog.audit_events')).n,
  events: (await one<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%'")).n,
});
/** Every catalogue row (taxonomy and Gig Templates) and the catalogue's events, as one string: equal before and after means nothing was written. */
const worldHash = async (): Promise<string> =>
  (
    await one<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY category_id), '[]') FROM catalog.categories t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY service_type_id), '[]') FROM catalog.service_types t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY market_id, category_id), '[]') FROM catalog.market_categories t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY market_id, service_type_id), '[]') FROM catalog.market_service_types t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY gig_template_id), '[]') FROM catalog.gig_templates t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY gig_template_version_id), '[]') FROM catalog.gig_template_versions t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY gig_template_field_id), '[]') FROM catalog.gig_template_fields t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY gig_template_field_id, option_code), '[]') FROM catalog.gig_template_field_options t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY gig_template_requirement_id), '[]') FROM catalog.gig_template_requirements t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY market_id, gig_template_id), '[]') FROM catalog.market_gig_templates t)::text,
      (SELECT count(*) FROM catalog.audit_events)::text,
      (SELECT count(*) FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%')::text)) AS h`)
  ).h;

const templateRow = (c: string) => one<Row>('SELECT * FROM catalog.gig_templates WHERE code = $1', [c]);
const versionRows = (c: string) =>
  q<Row>('SELECT v.* FROM catalog.gig_template_versions v JOIN catalog.gig_templates t USING (gig_template_id) WHERE t.code = $1 ORDER BY v.version_number', [
    c,
  ]);
const versionRow = (c: string, n: number) =>
  one<Row>('SELECT v.* FROM catalog.gig_template_versions v JOIN catalog.gig_templates t USING (gig_template_id) WHERE t.code = $1 AND v.version_number = $2', [
    c,
    n,
  ]);
const fieldRows = (c: string, n: number) =>
  q<Row>(
    `SELECT f.* FROM catalog.gig_template_fields f JOIN catalog.gig_template_versions v USING (gig_template_version_id) JOIN catalog.gig_templates t USING (gig_template_id)
      WHERE t.code = $1 AND v.version_number = $2 ORDER BY f.display_order`,
    [c, n],
  );
const optionRows = (c: string, n: number) =>
  q<Row>(
    `SELECT f.field_key, o.* FROM catalog.gig_template_field_options o JOIN catalog.gig_template_fields f USING (gig_template_field_id)
       JOIN catalog.gig_template_versions v USING (gig_template_version_id) JOIN catalog.gig_templates t USING (gig_template_id)
      WHERE t.code = $1 AND v.version_number = $2 ORDER BY f.display_order, o.display_order`,
    [c, n],
  );
const reqRows = (c: string, n: number) =>
  q<Row>(
    `SELECT r.requirement_type, r.reference_code FROM catalog.gig_template_requirements r JOIN catalog.gig_template_versions v USING (gig_template_version_id)
       JOIN catalog.gig_templates t USING (gig_template_id) WHERE t.code = $1 AND v.version_number = $2 ORDER BY r.requirement_type COLLATE "C", r.reference_code COLLATE "C" NULLS FIRST`,
    [c, n],
  );
const mgtRow = (market: string, c: string) =>
  q<{ enabled: boolean; display_order: number }>(
    `SELECT x.enabled, x.display_order FROM catalog.market_gig_templates x JOIN geography.markets m ON m.market_id = x.market_id JOIN catalog.gig_templates t ON t.gig_template_id = x.gig_template_id
      WHERE m.code = $1 AND t.code = $2`,
    [market, c],
  );
const vStatuses = async (c: string) => (await versionRows(c)).map((v) => [v.version_number, v.status]);
/** The structure of a version, as one comparable value (rows without surrogate ids and timestamps). */
const structureOf = async (c: string, n: number) => ({
  version: await one<Row>(
    `SELECT min_duration_minutes, max_duration_minutes, suggested_duration_minutes, pricing_fixed, pricing_fixed_with_variants, pricing_bundle_eligible, pricing_drop_eligible, pricing_add_ons,
            area_radius, area_postal_codes, area_polygon FROM catalog.gig_template_versions v JOIN catalog.gig_templates t USING (gig_template_id) WHERE t.code = $1 AND v.version_number = $2`,
    [c, n],
  ),
  fields: (await fieldRows(c, n)).map(({ gig_template_field_id: _a, gig_template_version_id: _b, ...rest }) => rest),
  options: (await optionRows(c, n)).map(({ gig_template_field_id: _a, ...rest }) => rest),
  requirements: await reqRows(c, n),
});

async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND state = 'active'`, [
      iso.name,
    ]);
    if (r.n > 0) return;
    await sleep(20);
  }
  throw new Error('no session ever blocked on a lock');
}
/** Raw sessions that are still open: a failing test must not leave one holding locks (it would hang the teardown). */
const openRaw = new Set<() => Promise<void>>();
async function rawTx() {
  const c = await pool.connect();
  await c.query('BEGIN');
  let done = false;
  const finish = async (how: 'COMMIT' | 'ROLLBACK') => {
    if (done) return;
    done = true;
    try {
      await c.query(how);
    } finally {
      c.release();
    }
  };
  openRaw.add(() => finish('ROLLBACK'));
  return { query: (text: string, params: unknown[] = []) => c.query(text, params), commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') };
}
/** Runs `fn` with the user triggers of the given tables disabled (crafted states), always restoring them. */
async function withoutTriggers<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
  for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
}
/** Installs a trigger that fails matching inserts with SQLSTATE XX000 while `fn` runs. */
async function failing(table: string, when: string, fn: () => Promise<unknown>): Promise<unknown> {
  await q(
    `CREATE FUNCTION public.gt_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END $$`,
  );
  await q(`CREATE TRIGGER trg_gt_test_fail BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.gt_test_fail()`);
  try {
    return await rejection(fn());
  } finally {
    await q(`DROP TRIGGER trg_gt_test_fail ON ${table}`);
    await q('DROP FUNCTION public.gt_test_fail()');
  }
}

// ====================================================================== 1. seed
describe('the seeded Gig Templates', () => {
  it('migration 0016 seeds 2 DRAFT templates without a version, 2 audit rows by system:migration, their published copy, no availability and no event', async () => {
    const list = (await bare.listGigTemplates()).filter((t) => ['full_detail', 'standard_clean'].includes(t.code));
    expect(list.map((t) => [t.code, t.serviceTypeCode, t.categoryCode, t.status, t.activeVersion, t.versions])).toEqual([
      ['full_detail', 'car_detailing', 'auto_services', 'DRAFT', null, undefined],
      ['standard_clean', 'regular_cleaning', 'home_cleaning', 'DRAFT', null, undefined],
    ]);
    const detail = await bare.getGigTemplate('full_detail');
    expect(detail).toMatchObject({
      nameContentKey: 'catalog.gig_template.full_detail.name',
      descriptionContentKey: 'catalog.gig_template.full_detail.description',
      instructionsContentKey: 'catalog.gig_template.full_detail.instructions',
      versions: [],
      activeVersion: null,
    });
    expect((await versionRows('full_detail')).length + (await versionRows('standard_clean')).length).toBe(0);
    const audit = await q<{ actor: string; action: string; changes: unknown }>(
      "SELECT actor, action, changes FROM catalog.audit_events WHERE gig_template_id IS NOT NULL AND actor = 'system:migration'",
    );
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => [a.action, a.changes])).toEqual([
      ['GIG_TEMPLATE_CREATED', { status: [null, 'DRAFT'] }],
      ['GIG_TEMPLATE_CREATED', { status: [null, 'DRAFT'] }],
    ]);
    const published = await q<{ ok: boolean }>(
      `SELECT catalog.content_is_published(k) AS ok FROM unnest(ARRAY['full_detail', 'standard_clean']) AS c, unnest(ARRAY['name', 'description', 'instructions']) AS p, LATERAL (SELECT 'catalog.gig_template.' || c || '.' || p AS k) x`,
    );
    expect(published).toHaveLength(6);
    expect(published.every((r) => r.ok)).toBe(true);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM catalog.market_gig_templates')).n).toBe(0);
    expect(
      (await one<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.gig-template-%'")).n,
    ).toBe(0);
  });

  it('nothing seeded is public, and a seeded DRAFT template cannot be activated while its service type is still a DRAFT', async () => {
    const m = await mkMarket(true);
    expect(await bare.listGigTemplatesForMarket(m)).toMatchObject({ templates: [] });
    const world = await worldHash();
    await expectError(setTpl('full_detail', 'ACTIVE'), 'INVALID_STATE', 'SERVICE_TYPE_NOT_ACTIVE');
    expect(await worldHash()).toBe(world);
  });
});

// ====================================================================== 2. templates: create and update
describe('createGigTemplate and updateGigTemplate', () => {
  it('creates a DRAFT with the derived content keys: one GIG_TEMPLATE_CREATED row with the exact diff, actor, reason and correlation id; no event; no cache bump', async () => {
    const { category, st } = await mkServiceTypeActive();
    const c = code('t');
    await putContent([nameKey(c), descKey(c), instrKey(c)]);
    const before = await counts();
    const incrs = cache.incrs.length;
    const reason = '  Launch plan — Q3 ✓ "quoted"  ';
    const view = await runWithCorrelation('corr-gt-create-1', () =>
      gt.createGigTemplate({ code: c, serviceTypeCode: st, withDescription: true, withInstructions: true, reason }, 'admin:bob'),
    );
    expect(view).toMatchObject({
      code: c,
      serviceTypeCode: st,
      categoryCode: category,
      status: 'DRAFT',
      nameContentKey: nameKey(c),
      descriptionContentKey: descKey(c),
      instructionsContentKey: instrKey(c),
      displayOrder: null,
      activeVersion: null,
      versions: [],
    });
    expect(keys(view)).toEqual(
      [
        'activeVersion',
        'categoryCode',
        'code',
        'createdAt',
        'descriptionContentKey',
        'displayOrder',
        'gigTemplateId',
        'instructionsContentKey',
        'nameContentKey',
        'serviceTypeCode',
        'status',
        'updatedAt',
        'versions',
      ].sort(),
    );
    const row = await templateRow(c);
    expect(row).toMatchObject({
      code: c,
      status: 'DRAFT',
      name_content_key: nameKey(c),
      description_content_key: descKey(c),
      instructions_content_key: instrKey(c),
    });
    expect(row.gig_template_id).toBe(view.gigTemplateId);
    expect(row.service_type_id).toBe((await one<Row>('SELECT service_type_id FROM catalog.service_types WHERE code = $1', [st])).service_type_id);
    expect(await tplAudit(c)).toEqual([
      {
        action: 'GIG_TEMPLATE_CREATED',
        actor: 'admin:bob',
        changes: { status: [null, 'DRAFT'], serviceTypeCode: [null, st], withDescription: [null, true], withInstructions: [null, true] },
        reason,
        correlation_id: 'corr-gt-create-1',
        version_number: null,
        market_code: null,
      },
    ]);
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events]).toEqual([1, 0]);
    expect(cache.incrs.length).toBe(incrs);
  });

  it('without the optional links the keys are null and the diff says so; without a caller correlation id a fresh one is used', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const row = await templateRow(c);
    expect([row.description_content_key, row.instructions_content_key]).toEqual([null, null]);
    const [a] = await tplAudit(c);
    expect(a!.changes).toEqual({ status: [null, 'DRAFT'], serviceTypeCode: [null, st], withDescription: [null, false], withInstructions: [null, false] });
    expect(a!.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    const view = await bare.getGigTemplate(c);
    expect([view.descriptionContentKey, view.instructionsContentKey]).toEqual([null, null]);
  });

  it('a template can be created under a DRAFT, ACTIVE or INACTIVE service type, not under a RETIRED one (SERVICE_TYPE_RETIRED); an unknown service type is SERVICE_TYPE_NOT_FOUND; nothing is left behind', async () => {
    const category = await mkCategory();
    const draft = await mkServiceType(category);
    const active = await mkServiceType(category);
    const inactive = await mkServiceType(category);
    const retired = await mkServiceType(category);
    await setCat(category, 'ACTIVE');
    await setSt(active, 'ACTIVE');
    await setSt(inactive, 'ACTIVE');
    await setSt(inactive, 'INACTIVE');
    await setSt(retired, 'RETIRED');
    for (const st of [draft, active, inactive]) expect((await bare.getGigTemplate(await mkTemplate(st))).serviceTypeCode).toBe(st);
    const c = code('t');
    await putContent([nameKey(c)]);
    const world = await worldHash();
    await expectError(gt.createGigTemplate({ code: c, serviceTypeCode: retired, reason: REASON }, ACTOR), 'INVALID_STATE', 'SERVICE_TYPE_RETIRED');
    await expectError(gt.createGigTemplate({ code: c, serviceTypeCode: 'devtest_nothing', reason: REASON }, ACTOR), 'SERVICE_TYPE_NOT_FOUND');
    await expectError(gt.createGigTemplate({ code: c, serviceTypeCode: category, reason: REASON }, ACTOR), 'SERVICE_TYPE_NOT_FOUND'); // a category code is not a service type
    expect(await worldHash()).toBe(world);
    await expectError(bare.getGigTemplate(c), 'GIG_TEMPLATE_NOT_FOUND');
  });

  it('the name, description and instructions copy must exist as content entries: NAME_CONTENT_MISSING, DESCRIPTION_CONTENT_MISSING, INSTRUCTIONS_CONTENT_MISSING; no driver text; nothing written', async () => {
    const { st } = await mkServiceTypeActive();
    const world = await worldHash();
    const c = code('t');
    const e0 = await expectError(gt.createGigTemplate({ code: c, serviceTypeCode: st, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'NAME_CONTENT_MISSING');
    expect(JSON.stringify([e0.message, e0.details])).not.toMatch(/catalog\.|content\.|fk_|_content_key/);
    await putContent([nameKey(c)], 'entry');
    await expectError(
      gt.createGigTemplate({ code: c, serviceTypeCode: st, withDescription: true, reason: REASON }, ACTOR),
      'VALIDATION_FAILED',
      'DESCRIPTION_CONTENT_MISSING',
    );
    await expectError(
      gt.createGigTemplate({ code: c, serviceTypeCode: st, withInstructions: true, reason: REASON }, ACTOR),
      'VALIDATION_FAILED',
      'INSTRUCTIONS_CONTENT_MISSING',
    );
    expect(await worldHash()).toBe(world);
    // the entry need not be PUBLISHED to create the template: that is checked at publication
    expect((await gt.createGigTemplate({ code: c, serviceTypeCode: st, reason: REASON }, ACTOR)).status).toBe('DRAFT');
  });

  it('a duplicate code is CONFLICT CODE_TAKEN (also across service types and for a RETIRED template: codes are never reused) and writes nothing', async () => {
    const a = await mkServiceTypeActive();
    const b = await mkServiceTypeActive();
    const c = await mkTemplate(a.st);
    const world = await worldHash();
    await expectError(gt.createGigTemplate({ code: c, serviceTypeCode: a.st, reason: REASON }, ACTOR), 'CONFLICT', 'CODE_TAKEN');
    await expectError(gt.createGigTemplate({ code: c, serviceTypeCode: b.st, reason: REASON }, ACTOR), 'CONFLICT', 'CODE_TAKEN');
    await expectError(gt.createGigTemplate({ code: 'full_detail', serviceTypeCode: a.st, reason: REASON }, ACTOR), 'CONFLICT', 'CODE_TAKEN');
    expect(await worldHash()).toBe(world);
    await setTpl(c, 'RETIRED');
    await expectError(gt.createGigTemplate({ code: c, serviceTypeCode: a.st, reason: REASON }, ACTOR), 'CONFLICT', 'CODE_TAKEN');
  });

  it('a test-only code is refused without allowTestKeys (nothing written); an ordinary code is created, and the strict service still manages a devtest_ row that exists', async () => {
    const { st } = await mkServiceTypeActive();
    const t = code('t');
    await putContent([nameKey(t)]);
    const world = await worldHash();
    const e = await expectError(strict.createGigTemplate({ code: t, serviceTypeCode: st, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'TEST_KEY_NOT_ALLOWED');
    expect(e.details.field).toBe('code');
    expect(await worldHash()).toBe(world);
    await putContent([nameKey('window_tint')]);
    expect((await strict.createGigTemplate({ code: 'window_tint', serviceTypeCode: st, reason: REASON }, ACTOR)).code).toBe('window_tint');
    expect((await strict.getGigTemplate(await mkTemplate(st))).status).toBe('DRAFT');
  });

  it('updateGigTemplate links and unlinks the description and instructions: one GIG_TEMPLATE_UPDATED row per change with exactly the fields that changed, created_at kept and updated_at moved, no event', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    await putContent([descKey(c), instrKey(c)]);
    const t0 = await templateRow(c);
    await sleep(5);
    const before = await counts();
    await gt.updateGigTemplate(c, { withDescription: true, reason: 'link description' }, 'admin:dave');
    await gt.updateGigTemplate(c, { withInstructions: true, reason: 'link instructions' }, 'admin:dave');
    await gt.updateGigTemplate(c, { withDescription: false, withInstructions: false, reason: 'unlink both' }, 'admin:dave');
    await gt.updateGigTemplate(c, { withDescription: true, withInstructions: true, reason: 'link both' }, 'admin:dave');
    expect((await tplAudit(c)).slice(1).map((a) => [a.action, a.changes, a.reason, a.actor])).toEqual([
      ['GIG_TEMPLATE_UPDATED', { withDescription: [false, true] }, 'link description', 'admin:dave'],
      ['GIG_TEMPLATE_UPDATED', { withInstructions: [false, true] }, 'link instructions', 'admin:dave'],
      ['GIG_TEMPLATE_UPDATED', { withDescription: [true, false], withInstructions: [true, false] }, 'unlink both', 'admin:dave'],
      ['GIG_TEMPLATE_UPDATED', { withDescription: [false, true], withInstructions: [false, true] }, 'link both', 'admin:dave'],
    ]);
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events]).toEqual([4, 0]);
    const t1 = await templateRow(c);
    expect(t1.created_at).toEqual(t0.created_at);
    expect((t1.updated_at as Date).getTime()).toBeGreaterThan((t0.updated_at as Date).getTime());
    expect([t1.description_content_key, t1.instructions_content_key]).toEqual([descKey(c), instrKey(c)]);
    // the code, the service type and the status never move through an update
    expect([t1.code, t1.service_type_id, t1.status]).toEqual([t0.code, t0.service_type_id, 'DRAFT']);
  });

  it('updating to what is already stored writes nothing (no audit row, no updated_at move, no bump); linking an entry that does not exist is refused and changes nothing', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st, { description: true });
    const world = await worldHash();
    const incrs = cache.incrs.length;
    await gt.updateGigTemplate(c, { withDescription: true, reason: REASON }, ACTOR);
    await gt.updateGigTemplate(c, { withInstructions: false, reason: REASON }, ACTOR);
    await gt.updateGigTemplate(c, { withDescription: true, withInstructions: false, reason: REASON }, ACTOR);
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
    await expectError(gt.updateGigTemplate(c, { withInstructions: true, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'INSTRUCTIONS_CONTENT_MISSING');
    expect(await worldHash()).toBe(world);
    await expectError(gt.updateGigTemplate('devtest_nothing', { withDescription: true, reason: REASON }, ACTOR), 'GIG_TEMPLATE_NOT_FOUND');
  });
});

// ====================================================================== 3. template status
describe('the status machine of a template through the service', () => {
  async function inState(target: CatalogStatus): Promise<{ code: string; st: string }> {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    if (target === 'ACTIVE') await setTpl(c, 'ACTIVE');
    if (target === 'INACTIVE') {
      await setTpl(c, 'ACTIVE');
      await setTpl(c, 'INACTIVE');
    }
    if (target === 'RETIRED') await setTpl(c, 'RETIRED');
    return { code: c, st };
  }

  it('all 12 (from, to) pairs behave exactly as the contract says; a refused pair is INVALID_STATE STATUS_TRANSITION and writes nothing', async () => {
    let allowed = 0;
    let refused = 0;
    for (const from of CATALOG_STATUSES) {
      for (const to of ['ACTIVE', 'INACTIVE', 'RETIRED'] as const) {
        const { code: c } = await inState(from);
        const world = await worldHash();
        const call = setTpl(c, to);
        if (from === to || isCatalogTransitionAllowed(from, to)) {
          expect((await call).status, `${from}->${to}`).toBe(to);
          expect((await templateRow(c)).status).toBe(to);
          allowed++;
        } else {
          await expectError(call, 'INVALID_STATE', 'STATUS_TRANSITION');
          expect(await worldHash(), `${from}->${to}`).toBe(world);
          refused++;
        }
      }
    }
    expect(allowed).toBe(9);
    expect(refused).toBe(3);
  }, 60_000);

  it('every real transition writes one STATUS_CHANGED audit row and exactly the documented event: activated on entering ACTIVE, deactivated on ACTIVE -> INACTIVE, retired on every retirement', async () => {
    const path: [CatalogStatus, string][] = [
      ['ACTIVE', GIG_TEMPLATE_EVENTS.activated],
      ['INACTIVE', GIG_TEMPLATE_EVENTS.deactivated],
      ['ACTIVE', GIG_TEMPLATE_EVENTS.activated],
      ['INACTIVE', GIG_TEMPLATE_EVENTS.deactivated],
      ['RETIRED', GIG_TEMPLATE_EVENTS.retired],
    ];
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const id = (await templateRow(c)).gig_template_id;
    let from: CatalogStatus = 'DRAFT';
    let n = 0;
    for (const [to, event] of path) {
      const before = await counts();
      const corr = `corr-${c}-${n++}`;
      const view = await runWithCorrelation(corr, () => gt.setGigTemplateStatus(c, { status: to, reason: `to ${to}` }, 'admin:carol'));
      expect(view.status).toBe(to);
      expect((await tplAudit(c)).at(-1)).toEqual({
        action: 'GIG_TEMPLATE_STATUS_CHANGED',
        actor: 'admin:carol',
        changes: { status: [from, to] },
        reason: `to ${to}`,
        correlation_id: corr,
        version_number: null,
        market_code: null,
      });
      const after = await counts();
      expect([after.audit - before.audit, after.events - before.events], `${from}->${to}`).toEqual([1, 1]);
      const ev = (await tplEvents(c, event)).at(-1)!;
      expect(ev).toEqual({
        event_type: event,
        event_version: 1,
        aggregate_type: 'catalog_gig_template',
        aggregate_id: id,
        actor_type: 'user',
        actor_id: 'admin:carol',
        payload_json: { gigTemplateCode: c, serviceTypeCode: st },
        correlation_id: corr,
        causation_id: null,
        published_at: null,
      });
      from = to;
    }
    expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.activated)).length).toBe(2);
    expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.deactivated)).length).toBe(2);
    expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.retired)).length).toBe(1);
    expect((await tplEvents(c)).length).toBe(5);
  });

  it('retiring from DRAFT or from INACTIVE also announces `retired` (once), and never `deactivated`', async () => {
    for (const from of ['DRAFT', 'INACTIVE'] as const) {
      const { code: c } = await inState(from);
      await setTpl(c, 'RETIRED');
      expect((await tplEvents(c)).map((e) => e.event_type).filter((t) => t === GIG_TEMPLATE_EVENTS.retired)).toHaveLength(1);
      expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.deactivated)).length).toBe(from === 'INACTIVE' ? 1 : 0);
      expect((await tplAudit(c)).at(-1)!.changes).toEqual({ status: [from, 'RETIRED'] });
    }
  });

  it('the same status again writes nothing: no audit row, no event, no updated_at move, no bump (also RETIRED again)', async () => {
    const { code: c } = await inState('ACTIVE');
    const r = (await inState('RETIRED')).code;
    const t0 = await templateRow(c);
    await sleep(5);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    for (let i = 0; i < 3; i++) {
      expect((await setTpl(c, 'ACTIVE')).status).toBe('ACTIVE');
      expect((await setTpl(r, 'RETIRED')).status).toBe('RETIRED');
    }
    expect(await worldHash()).toBe(world);
    expect((await templateRow(c)).updated_at).toEqual(t0.updated_at);
    expect(cache.incrs.length).toBe(incrs);
  });

  it('activation needs an ACTIVE service type (SERVICE_TYPE_NOT_ACTIVE for DRAFT and INACTIVE), but pausing and retiring do not; a service type paused later does not touch its templates', async () => {
    const category = await mkCategory();
    const draftSt = await mkServiceType(category);
    const pausedSt = await mkServiceType(category);
    const liveSt = await mkServiceType(category);
    await setCat(category, 'ACTIVE');
    for (const s of [pausedSt, liveSt]) await setSt(s, 'ACTIVE');
    await setSt(pausedSt, 'INACTIVE');
    const t1 = await mkTemplate(draftSt);
    const t2 = await mkTemplate(pausedSt);
    const world = await worldHash();
    await expectError(setTpl(t1, 'ACTIVE'), 'INVALID_STATE', 'SERVICE_TYPE_NOT_ACTIVE');
    await expectError(setTpl(t2, 'ACTIVE'), 'INVALID_STATE', 'SERVICE_TYPE_NOT_ACTIVE');
    expect(await worldHash()).toBe(world);
    expect((await setTpl(t1, 'RETIRED')).status).toBe('RETIRED');
    const live = await mkTemplate(liveSt, { activate: true });
    await setSt(liveSt, 'INACTIVE');
    expect((await bare.getGigTemplate(live)).status).toBe('ACTIVE'); // no cascade: the public view re-checks the service type
    expect((await setTpl(live, 'INACTIVE')).status).toBe('INACTIVE');
    await expectError(setTpl(live, 'ACTIVE'), 'INVALID_STATE', 'SERVICE_TYPE_NOT_ACTIVE');
    expect((await setTpl(live, 'RETIRED')).status).toBe('RETIRED');
  });

  it('unknown template is GIG_TEMPLATE_NOT_FOUND (long codes cut in the echo), and the status machine is checked against the stored status, not a stale one', async () => {
    const e = await expectError(setTpl('x'.repeat(500), 'ACTIVE'), 'GIG_TEMPLATE_NOT_FOUND');
    expect((e.details.code as string).length).toBe(64);
    await expectError(setTpl('devtest_nothing', 'RETIRED'), 'GIG_TEMPLATE_NOT_FOUND');
  });
});

describe('retiring a template', () => {
  it('discards an open DRAFT first (audited, with its reason and the because-marker), keeps the version row and its definition, and announces the retirement once', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c } = await mkDraftTemplate(st, { activate: true });
    const draftBefore = await structureOf(c, 1);
    const before = await counts();
    const corr = `corr-retire-${seq}`;
    await runWithCorrelation(corr, () => gt.setGigTemplateStatus(c, { status: 'RETIRED', reason: 'closing down' }, 'admin:erin'));
    const v = await versionRow(c, 1);
    expect(v.status).toBe('RETIRED');
    expect(v.closed_at).not.toBeNull();
    expect(v.published_at).toBeNull();
    expect(await structureOf(c, 1)).toEqual(draftBefore); // the rows of the discarded draft stay
    const trail = (await tplAudit(c)).slice(-2);
    expect(trail).toEqual([
      {
        action: 'GIG_TEMPLATE_VERSION_RETIRED',
        actor: 'admin:erin',
        changes: { status: ['DRAFT', 'RETIRED'], versionNumber: [1, 1], because: 'TEMPLATE_RETIRED' },
        reason: 'closing down',
        correlation_id: corr,
        version_number: 1,
        market_code: null,
      },
      {
        action: 'GIG_TEMPLATE_STATUS_CHANGED',
        actor: 'admin:erin',
        changes: { status: ['ACTIVE', 'RETIRED'] },
        reason: 'closing down',
        correlation_id: corr,
        version_number: null,
        market_code: null,
      },
    ]);
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events]).toEqual([2, 1]);
    expect((await tplEvents(c)).map((e) => e.event_type).slice(-1)).toEqual([GIG_TEMPLATE_EVENTS.retired]);
  });

  it('closes the ACTIVE version (RETIRED, published_at kept, closed_at set) and discards a newer draft: draft audit, status audit, active-version audit; history and every older version untouched', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    await publish(c, 2, 1); // v1 SUPERSEDED, v2 ACTIVE
    await createDraft(c, 2); // v3 DRAFT
    const v1 = await versionRow(c, 1);
    const v2 = await versionRow(c, 2);
    const structures = [await structureOf(c, 1), await structureOf(c, 2), await structureOf(c, 3)];
    await sleep(3);
    const corr = `corr-retire-${seq}`;
    await runWithCorrelation(corr, () => setTpl(c, 'RETIRED'));
    const after = await versionRows(c);
    expect(after.map((v) => [v.version_number, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'RETIRED'],
      [3, 'RETIRED'],
    ]);
    expect(after[0]!.closed_at).toEqual(v1.closed_at); // the superseded version is not touched
    expect(after[1]!.published_at).toEqual(v2.published_at);
    expect((after[1]!.closed_at as Date).getTime()).toBeGreaterThan((v2.published_at as Date).getTime());
    expect(after[2]!.published_at).toBeNull();
    expect(after[2]!.closed_at).not.toBeNull();
    expect([await structureOf(c, 1), await structureOf(c, 2), await structureOf(c, 3)]).toEqual(structures);
    const retiredAudit = (await tplAudit(c)).filter((a) => a.correlation_id === corr);
    expect(retiredAudit.map((a) => [a.action, a.version_number, a.changes])).toEqual([
      ['GIG_TEMPLATE_VERSION_RETIRED', 3, { status: ['DRAFT', 'RETIRED'], versionNumber: [3, 3], because: 'TEMPLATE_RETIRED' }],
      ['GIG_TEMPLATE_STATUS_CHANGED', null, { status: ['ACTIVE', 'RETIRED'] }],
      ['GIG_TEMPLATE_VERSION_RETIRED', 2, { status: ['ACTIVE', 'RETIRED'], versionNumber: [2, 2], because: 'TEMPLATE_RETIRED' }],
    ]);
    const events = (await tplEvents(c)).filter((e) => e.correlation_id === corr);
    expect(events.map((e) => e.event_type)).toEqual([GIG_TEMPLATE_EVENTS.retired]);
    // nothing of it is public and nothing can be built on it any more
    await expectError(createDraft(c), 'INVALID_STATE', 'GIG_TEMPLATE_RETIRED');
    await expectError(publish(c, 2, 1), 'INVALID_STATE', 'VERSION_NOT_DRAFT');
  });

  it('closes the ACTIVE version of a PAUSED template too; the versions stay readable with their structure', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await setTpl(c, 'INACTIVE');
    expect(await vStatuses(c)).toEqual([[1, 'ACTIVE']]); // a pause leaves the version ACTIVE
    await setTpl(c, 'RETIRED');
    expect(await vStatuses(c)).toEqual([[1, 'RETIRED']]);
    const v = await bare.getGigTemplateVersion(c, 1);
    expect([v.status, v.fields.length, v.requirements.length]).toEqual(['RETIRED', 6, 2]);
    expect((await bare.getGigTemplate(c)).activeVersion).toBeNull();
  });

  it('leaves the market rows of the template in place and cannot enable it again (ITEM_RETIRED), but can still switch it off', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    await setTpl(c, 'RETIRED');
    expect(await mgtRow(env.market, c)).toEqual([{ enabled: true, display_order: expect.any(Number) }]);
    expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.availabilityChanged)).toHaveLength(1); // only the enabling: retiring announces no availability change
    expect((await bare.listGigTemplatesForMarket(env.market)).templates).toEqual([]);
    expect((await tplAvail(env.market, c, false)).enabled).toBe(false);
    await expectError(tplAvail(env.market, c, true), 'INVALID_STATE', 'ITEM_RETIRED');
  });
});

describe('pausing and reactivating a template', () => {
  it('a paused template is not public although its version stays ACTIVE; reactivating shows the same version again; each change is audited, announced and bumps the generation', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const id = (await versionRow(c, 1)).gig_template_version_id;
    expect((await bare.getGigTemplateForMarket(env.market, c)).template.activeVersion!.gigTemplateVersionId).toBe(id);
    const g = cache.gen();
    await setTpl(c, 'INACTIVE');
    expect(cache.gen()).toBe(g + 1);
    expect((await versionRow(c, 1)).status).toBe('ACTIVE');
    await expectError(bare.getGigTemplateForMarket(env.market, c), 'GIG_TEMPLATE_NOT_FOUND');
    expect((await bare.listGigTemplatesForMarket(env.market)).templates).toEqual([]);
    await setTpl(c, 'ACTIVE');
    expect(cache.gen()).toBe(g + 2);
    expect((await bare.getGigTemplateForMarket(env.market, c)).template.activeVersion!.gigTemplateVersionId).toBe(id);
    expect((await versionRow(c, 1)).published_at).not.toBeNull();
    expect((await auditActions(c)).slice(-2)).toEqual(['GIG_TEMPLATE_STATUS_CHANGED', 'GIG_TEMPLATE_STATUS_CHANGED']);
  });
});

// ====================================================================== 4. versions: drafts
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** A field row as the definition that wrote it (numerics as numbers). */
const fieldSummary = (r: Row) => ({
  key: r.field_key,
  type: r.field_type,
  section: r.section,
  behavior: r.behavior,
  visible: r.customer_visible,
  order: r.display_order,
  label: r.label_content_key,
  help: r.help_content_key,
  default: r.default_content_key,
  len: [r.min_length, r.max_length],
  num: [num(r.min_number), num(r.max_number), num(r.default_number)],
  bool: r.default_boolean,
  items: [r.min_items, r.max_items],
});
/** Raw SQL that a guard or constraint must refuse, translated by the service's own mapping. */
const rawRefused = async (text: string, params: unknown[] = []): Promise<CatalogError> => {
  const e = await rejection(q(text, params));
  expect(e, `expected the database to refuse: ${text}`).toBeDefined();
  try {
    mapDbError(e);
  } catch (m) {
    return m as CatalogError;
  }
  throw new Error('mapDbError returned');
};
const MGMT_VERSION_KEYS = [
  'areaModes',
  'closedAt',
  'createdAt',
  'duration',
  'fieldCount',
  'fields',
  'gigTemplateVersionId',
  'pricingModels',
  'publishedAt',
  'requirements',
  'revision',
  'status',
  'versionNumber',
];

describe('createGigTemplateVersion', () => {
  it('creates version 1 as an empty DRAFT with the column defaults: a version audit row with the exact diff, no event, no cache bump, no child rows', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const before = await counts();
    const incrs = cache.incrs.length;
    const view = await runWithCorrelation('corr-draft-1', () => gt.createGigTemplateVersion(c, { reason: 'first draft' }, 'admin:fay'));
    expect(keys(view)).toEqual(MGMT_VERSION_KEYS);
    expect(view).toMatchObject({
      versionNumber: 1,
      status: 'DRAFT',
      revision: 1,
      fieldCount: 0,
      fields: [],
      requirements: [],
      duration: { minMinutes: null, maxMinutes: null, suggestedMinutes: null },
      pricingModels: ['FIXED'],
      areaModes: ['RADIUS'],
      publishedAt: null,
      closedAt: null,
    });
    expect(await versionRow(c, 1)).toMatchObject({
      status: 'DRAFT',
      revision: 1,
      published_at: null,
      closed_at: null,
      pricing_fixed: true,
      pricing_add_ons: false,
      area_radius: true,
    });
    expect([(await fieldRows(c, 1)).length, (await optionRows(c, 1)).length, (await reqRows(c, 1)).length]).toEqual([0, 0, 0]);
    expect(await tplAudit(c)).toHaveLength(2);
    expect((await tplAudit(c)).at(-1)).toEqual({
      action: 'GIG_TEMPLATE_VERSION_CREATED',
      actor: 'admin:fay',
      changes: { versionNumber: [null, 1], status: [null, 'DRAFT'], copiedFromVersion: [null, null] },
      reason: 'first draft',
      correlation_id: 'corr-draft-1',
      version_number: 1,
      market_code: null,
    });
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events]).toEqual([1, 0]);
    expect(cache.incrs.length).toBe(incrs);
    expect((await bare.getGigTemplate(c)).versions!.map((v) => [v.versionNumber, v.status, v.revision, v.fieldCount])).toEqual([[1, 'DRAFT', 1, 0]]);
  });

  it('only ONE draft per template: a second is CONFLICT DRAFT_EXISTS (not retryable) and writes nothing, also when it asks to copy; a discarded draft frees the slot and the next number is the highest plus one', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    await createDraft(c);
    const world = await worldHash();
    const e = await expectError(createDraft(c), 'CONFLICT', 'DRAFT_EXISTS');
    expect(e.details.retryable).toBeUndefined();
    await expectError(createDraft(c, 1), 'CONFLICT', 'DRAFT_EXISTS');
    expect(await worldHash()).toBe(world);
    await discard(c, 1);
    expect((await createDraft(c)).versionNumber).toBe(2); // the discarded number is not reused
    await discard(c, 2);
    expect((await createDraft(c, 1)).versionNumber).toBe(3); // a discarded draft can be copied
    expect(await vStatuses(c)).toEqual([
      [1, 'RETIRED'],
      [2, 'RETIRED'],
      [3, 'DRAFT'],
    ]);
  });

  it('refuses a RETIRED template (GIG_TEMPLATE_RETIRED) and an unknown one; works for a DRAFT, ACTIVE and INACTIVE template', async () => {
    const { st } = await mkServiceTypeActive();
    const draft = await mkTemplate(st);
    const active = await mkTemplate(st, { activate: true });
    const paused = await mkTemplate(st, { activate: true });
    await setTpl(paused, 'INACTIVE');
    const retired = await mkTemplate(st);
    await setTpl(retired, 'RETIRED');
    for (const c of [draft, active, paused]) expect((await createDraft(c)).status).toBe('DRAFT');
    const world = await worldHash();
    await expectError(createDraft(retired), 'INVALID_STATE', 'GIG_TEMPLATE_RETIRED');
    await expectError(createDraft(retired, 7), 'INVALID_STATE', 'GIG_TEMPLATE_RETIRED'); // the retirement is looked at before the copy source
    await expectError(createDraft('devtest_nothing'), 'GIG_TEMPLATE_NOT_FOUND');
    expect(await worldHash()).toBe(world);
  });

  it('copyFromVersion starts the draft from the structure of that version (any status), with revision 1 and its own rows; the source is untouched; the copy publishes as it is', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    const v1ids = (await fieldRows(c, 1)).map((f) => f.gig_template_field_id);
    const v1 = await structureOf(c, 1);
    const view = await runWithCorrelation('corr-copy', () => createDraft(c, 1));
    expect(view).toMatchObject({ versionNumber: 2, status: 'DRAFT', revision: 1, fieldCount: 6 });
    expect(await structureOf(c, 2)).toEqual(v1);
    expect(await structureOf(c, 1)).toEqual(v1);
    const v2ids = (await fieldRows(c, 2)).map((f) => f.gig_template_field_id);
    expect(v2ids.filter((id) => v1ids.includes(id))).toEqual([]); // separate rows
    expect((await fieldRows(c, 1)).map((f) => f.gig_template_field_id)).toEqual(v1ids);
    expect((await tplAudit(c)).at(-1)).toMatchObject({
      action: 'GIG_TEMPLATE_VERSION_CREATED',
      version_number: 2,
      changes: { versionNumber: [null, 2], status: [null, 'DRAFT'], copiedFromVersion: [null, 1] },
      correlation_id: 'corr-copy',
    });
    // the copied draft equals what the administrator would send: an identical replace is a no-op, and the draft can be published at once
    const world = await worldHash();
    await replaceDraft(c, 2, def(1));
    expect(await worldHash()).toBe(world);
    expect((await publish(c, 2, 1)).status).toBe('ACTIVE');
    // a SUPERSEDED version and a RETIRED one can be copied too
    expect(await vStatuses(c)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
    ]);
    expect(await structureOf(c, (await createDraft(c, 1)).versionNumber)).toEqual(v1);
    await discard(c, 3);
    expect(await structureOf(c, (await createDraft(c, 3)).versionNumber)).toEqual(v1);
  });

  it('copying a version that does not exist is GIG_TEMPLATE_VERSION_NOT_FOUND and leaves nothing behind', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    const world = await worldHash();
    await expectError(createDraft(c, 7), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    await expectError(createDraft(c, 2_147_483_647), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    expect(await worldHash()).toBe(world);
  });

  it('a copy source beyond the 32-bit integer range never reaches the driver: it is refused before the database (VALIDATION_FAILED on copyFromVersion)', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    const world = await worldHash();
    for (const big of [2_147_483_648, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      const e = await expectError(createDraft(c, big), 'VALIDATION_FAILED', 'INVALID_FIELD');
      expect(e.details.field).toBe('copyFromVersion');
    }
    expect(await worldHash()).toBe(world);
  });
});

describe('replaceGigTemplateDraft', () => {
  it('ADD_ONS (CAT-004) is the pricing_add_ons permission: stored, reported by the management and public views, audited as a pricing change, copied into the next draft, and false for every version that did not ask for it', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st, { activate: true });
    await tplAvail(env.market, c, true, 'auto');
    await copyFor(c);
    await createDraft(c);
    expect(await versionRow(c, 1)).toMatchObject({ pricing_add_ons: false });
    const view = await replaceDraft(c, 1, def(1, { pricingModels: ['FIXED', 'ADD_ONS'] }));
    expect(view.pricingModels).toEqual(['FIXED', 'ADD_ONS']);
    expect(await versionRow(c, 1)).toMatchObject({ pricing_fixed: true, pricing_bundle_eligible: false, pricing_add_ons: true });
    expect((await tplAudit(c)).at(-1)).toMatchObject({ changes: { pricingModels: [['FIXED'], ['FIXED', 'ADD_ONS']] } });
    // add-ons alone are not a base price
    await expectError(replaceDraft(c, 1, def(2, { pricingModels: ['ADD_ONS'] })), 'VALIDATION_FAILED');
    expect(await versionRow(c, 1)).toMatchObject({ revision: 2, pricing_add_ons: true });
    // an identical replace is a no-op; dropping the permission is a change
    const world = await worldHash();
    await replaceDraft(c, 1, def(2, { pricingModels: ['FIXED', 'ADD_ONS'] }));
    expect(await worldHash()).toBe(world);
    expect((await publish(c, 1, 2)).pricingModels).toEqual(['FIXED', 'ADD_ONS']);
    expect((await bare.getGigTemplate(c)).activeVersion!.pricingModels).toEqual(['FIXED', 'ADD_ONS']);
    expect((await bare.getGigTemplateForMarket(env.market, c)).template.activeVersion!.pricingModels).toEqual(['FIXED', 'ADD_ONS']);
    expect((await bare.listGigTemplatesForMarket(env.market)).templates.find((t) => t.code === c)!.activeVersion!.pricingModels).toEqual(['FIXED', 'ADD_ONS']);
    const byId = await bare.getGigTemplateVersionById((await versionRow(c, 1)).gig_template_version_id as string);
    expect(byId.version.pricingModels).toEqual(['FIXED', 'ADD_ONS']);
    // the next draft copies the permission; v1 stays as published
    expect((await createDraft(c, 1)).pricingModels).toEqual(['FIXED', 'ADD_ONS']);
    expect(await versionRow(c, 2)).toMatchObject({ pricing_add_ons: true });
    const v2 = await replaceDraft(c, 2, def(1, { pricingModels: ['FIXED'] }));
    expect(v2.pricingModels).toEqual(['FIXED']);
    expect(await versionRow(c, 2)).toMatchObject({ pricing_add_ons: false });
    expect(await versionRow(c, 1)).toMatchObject({ pricing_add_ons: true });
  });

  it('writes the whole definition: version columns, fields in order, options in order, requirements, the derived content keys; revision 2; ONE audit row with the diff in identifiers; no event, no bump', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    await copyFor(c);
    await createDraft(c);
    const before = await counts();
    const incrs = cache.incrs.length;
    const view = await runWithCorrelation('corr-replace-1', () => gt.replaceGigTemplateDraft(c, 1, def(1, { reason: 'the first definition' }), 'admin:gus'));
    expect(view).toMatchObject({ versionNumber: 1, status: 'DRAFT', revision: 2, fieldCount: 6 });
    expect(keys(view)).toEqual(MGMT_VERSION_KEYS);
    const row = await versionRow(c, 1);
    expect(row).toMatchObject({
      revision: 2,
      status: 'DRAFT',
      min_duration_minutes: 60,
      max_duration_minutes: 240,
      suggested_duration_minutes: 120,
      pricing_fixed: true,
      pricing_fixed_with_variants: false,
      pricing_bundle_eligible: true,
      pricing_drop_eligible: false,
      pricing_add_ons: false,
      area_radius: true,
      area_postal_codes: true,
      area_polygon: false,
    });
    const k = (f: string, p: string) => `${stem(c)}.field.${f}.${p}`;
    expect((await fieldRows(c, 1)).map(fieldSummary)).toEqual([
      {
        key: 'scope_notes',
        type: 'TEXT',
        section: 'SCOPE',
        behavior: 'PROVIDER_REQUIRED',
        visible: true,
        order: 1,
        label: k('scope_notes', 'label'),
        help: k('scope_notes', 'help'),
        default: null,
        len: [10, 500],
        num: [null, null, null],
        bool: null,
        items: [null, null],
      },
      {
        key: 'finish',
        type: 'ENUM',
        section: 'INCLUSIONS',
        behavior: 'PROVIDER_CONFIGURABLE',
        visible: true,
        order: 2,
        label: k('finish', 'label'),
        help: null,
        default: null,
        len: [null, null],
        num: [null, null, null],
        bool: null,
        items: [null, null],
      },
      {
        key: 'vehicles',
        type: 'INTEGER',
        section: 'DETAILS',
        behavior: 'PROVIDER_REQUIRED',
        visible: true,
        order: 3,
        label: k('vehicles', 'label'),
        help: null,
        default: null,
        len: [null, null],
        num: [1, 4, 1],
        bool: null,
        items: [null, null],
      },
      {
        key: 'photos',
        type: 'MEDIA',
        section: 'DETAILS',
        behavior: 'PROVIDER_CONFIGURABLE',
        visible: true,
        order: 4,
        label: k('photos', 'label'),
        help: null,
        default: null,
        len: [null, null],
        num: [null, null, null],
        bool: null,
        items: [0, 8],
      },
      {
        key: 'intro',
        type: 'LONG_TEXT',
        section: 'PREPARATION',
        behavior: 'PLATFORM_FIXED',
        visible: false,
        order: 5,
        label: k('intro', 'label'),
        help: null,
        default: k('intro', 'default'),
        len: [null, null],
        num: [null, null, null],
        bool: null,
        items: [null, null],
      },
      {
        key: 'is_mobile',
        type: 'BOOLEAN',
        section: 'DETAILS',
        behavior: 'PLATFORM_FIXED',
        visible: true,
        order: 6,
        label: k('is_mobile', 'label'),
        help: null,
        default: null,
        len: [null, null],
        num: [null, null, null],
        bool: false,
        items: [null, null],
      },
    ]);
    expect((await optionRows(c, 1)).map((o) => [o.field_key, o.option_code, o.label_content_key, o.is_default, o.display_order])).toEqual([
      ['finish', 'wax', k('finish', 'option.wax.label'), true, 1],
      ['finish', 'sealant', k('finish', 'option.sealant.label'), false, 2],
      ['finish', 'ceramic', k('finish', 'option.ceramic.label'), false, 3],
    ]);
    expect(await reqRows(c, 1)).toEqual([
      { requirement_type: 'LICENSE', reference_code: null },
      { requirement_type: 'SKILL', reference_code: 'wax_application' },
    ]);
    // the returned view is the stored definition (it was read back, not echoed)
    expect(view).toEqual(await bare.getGigTemplateVersion(c, 1));
    expect(view.fields.map((f) => [f.fieldKey, f.displayOrder, f.defaultBoolean, f.minItems, f.maxItems])).toEqual([
      ['scope_notes', 1, null, null, null],
      ['finish', 2, null, null, null],
      ['vehicles', 3, null, null, null],
      ['photos', 4, null, 0, 8],
      ['intro', 5, null, null, null],
      ['is_mobile', 6, false, null, null],
    ]);
    expect(view.requirements).toEqual([
      { requirementType: 'LICENSE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'wax_application' },
    ]);
    expect((await tplAudit(c)).at(-1)).toEqual({
      action: 'GIG_TEMPLATE_VERSION_CHANGED',
      actor: 'admin:gus',
      changes: {
        revision: [1, 2],
        duration: [
          { min: null, max: null, suggested: null },
          { min: 60, max: 240, suggested: 120 },
        ],
        pricingModels: [['FIXED'], ['FIXED', 'BUNDLE_ELIGIBLE']],
        areaModes: [['RADIUS'], ['RADIUS', 'POSTAL_CODES']],
        fields: { added: ['scope_notes', 'finish', 'vehicles', 'photos', 'intro', 'is_mobile'], removed: [], changed: [] },
        requirements: { added: ['LICENSE:', 'SKILL:wax_application'], removed: [] },
      },
      reason: 'the first definition',
      correlation_id: 'corr-replace-1',
      version_number: 1,
      market_code: null,
    });
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events]).toEqual([1, 0]);
    expect(cache.incrs.length, 'a draft edit is not public').toBe(incrs);
  });

  it('every one of the 11 field types is stored and read back exactly (numeric precision, zero and false values, a MEDIA that allows no photos)', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const fields: FieldIn[] = [
      { fieldKey: 'f_text', fieldType: 'TEXT', behavior: 'PROVIDER_REQUIRED', section: 'SCOPE', minLength: 5, maxLength: 200, withHelp: true },
      { fieldKey: 'f_long', fieldType: 'LONG_TEXT', behavior: 'PLATFORM_FIXED', section: 'INCLUSIONS', withDefaultText: true, customerVisible: false },
      { fieldKey: 'f_int', fieldType: 'INTEGER', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 0, maxNumber: 10, defaultNumber: 0 },
      { fieldKey: 'f_dec', fieldType: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 0.5, maxNumber: 9.9999, defaultNumber: 1.25 },
      { fieldKey: 'f_bool', fieldType: 'BOOLEAN', behavior: 'PLATFORM_FIXED', defaultBoolean: false, section: 'EXCLUSIONS' },
      { fieldKey: 'f_bool_on', fieldType: 'BOOLEAN', behavior: 'PROVIDER_CONFIGURABLE', defaultBoolean: true },
      { fieldKey: 'f_enum', fieldType: 'ENUM', behavior: 'PLATFORM_FIXED', options: [{ optionCode: 'opt_a', isDefault: true }, { optionCode: 'opt_b' }] },
      { fieldKey: 'f_dur', fieldType: 'DURATION', behavior: 'PROVIDER_REQUIRED', section: 'PREPARATION', minNumber: 30, maxNumber: 480, defaultNumber: 60 },
      { fieldKey: 'f_money', fieldType: 'MONEY', behavior: 'PROVIDER_REQUIRED' },
      { fieldKey: 'f_media', fieldType: 'MEDIA', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 8 },
      { fieldKey: 'f_nophoto', fieldType: 'MEDIA', behavior: 'PROVIDER_CONFIGURABLE', minItems: 0, maxItems: 0 },
      { fieldKey: 'f_equip', fieldType: 'EQUIPMENT_REFERENCE', behavior: 'PROVIDER_CONFIGURABLE', minItems: 0, maxItems: 3 },
      { fieldKey: 'f_skill', fieldType: 'SKILL_REFERENCE', behavior: 'PROVIDER_CONFIGURABLE', minItems: 1, maxItems: 5 },
    ];
    await copyFor(c, fields);
    await createDraft(c);
    const v = await replaceDraft(c, 1, def(1, { fields }));
    expect(v.fieldCount).toBe(13);
    const rows = (await fieldRows(c, 1)).map(fieldSummary);
    const byKey = Object.fromEntries(rows.map((r) => [r.key as string, r]));
    expect(byKey.f_int!.num).toEqual([0, 10, 0]);
    expect(byKey.f_dec!.num).toEqual([0.5, 9.9999, 1.25]);
    expect(byKey.f_bool!.bool).toBe(false);
    expect(byKey.f_bool_on!.bool).toBe(true);
    expect(byKey.f_nophoto!.items).toEqual([0, 0]);
    expect(byKey.f_money).toMatchObject({ len: [null, null], num: [null, null, null], bool: null, items: [null, null] });
    expect(byKey.f_long).toMatchObject({ visible: false, default: `${stem(c)}.field.f_long.default` });
    expect(byKey.f_text).toMatchObject({ help: `${stem(c)}.field.f_text.help`, default: null });
    const view = await bare.getGigTemplateVersion(c, 1);
    expect(view.fields.map((f) => f.fieldType)).toEqual(fields.map((f) => f.fieldType));
    expect(view.fields.find((f) => f.fieldKey === 'f_dec')).toMatchObject({ minNumber: 0.5, maxNumber: 9.9999, defaultNumber: 1.25 });
    expect(view.fields.find((f) => f.fieldKey === 'f_enum')!.options.map((o) => [o.optionCode, o.isDefault, o.displayOrder])).toEqual([
      ['opt_a', true, 1],
      ['opt_b', false, 2],
    ]);
    // a diff of what it just stored is empty: the stored definition is exactly the requested one
    const world = await worldHash();
    await replaceDraft(c, 1, def(2, { fields }));
    expect(await worldHash()).toBe(world);
  });

  it('an equal definition writes nothing: no revision bump, no audit row, no row touched, no cache bump; the models and requirements may be sent in any order', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    const rowIds = (await fieldRows(c, 1)).map((f) => f.gig_template_field_id);
    for (const body of [
      def(revision),
      def(revision, { reason: 'a different reason is not a different definition' }),
      def(revision, { pricingModels: ['BUNDLE_ELIGIBLE', 'FIXED'], areaModes: ['POSTAL_CODES', 'RADIUS'], requirements: [...stdRequirements()].reverse() }),
    ]) {
      const v = await replaceDraft(c, 1, body);
      expect(v.revision).toBe(revision);
    }
    expect(await worldHash()).toBe(world);
    expect((await fieldRows(c, 1)).map((f) => f.gig_template_field_id)).toEqual(rowIds);
    expect(cache.incrs.length).toBe(incrs);
    expect(await auditActions(c)).toEqual(['GIG_TEMPLATE_CREATED', 'GIG_TEMPLATE_VERSION_CREATED', 'GIG_TEMPLATE_VERSION_CHANGED']);
  });

  it('any real change bumps the revision by exactly one and audits only what changed: one field property, the field order, the duration, the models, a requirement, an option', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st);
    let rev = revision;
    const steps: [string, (b: Record<string, unknown>) => void, Record<string, unknown>][] = [
      ['a field property', (b) => ((b.fields as FieldIn[])[5]!.customerVisible = false), { fields: { added: [], removed: [], changed: ['is_mobile'] } }],
      [
        'the duration',
        (b) => (b.duration = { minMinutes: 60, maxMinutes: 300 }),
        {
          duration: [
            { min: 60, max: 240, suggested: 120 },
            { min: 60, max: 300, suggested: null },
          ],
        },
      ],
      [
        'the pricing models',
        (b) => (b.pricingModels = ['FIXED', 'FIXED_WITH_VARIANTS']),
        {
          pricingModels: [
            ['FIXED', 'BUNDLE_ELIGIBLE'],
            ['FIXED', 'FIXED_WITH_VARIANTS'],
          ],
        },
      ],
      ['the area modes', (b) => (b.areaModes = ['POLYGON']), { areaModes: [['RADIUS', 'POSTAL_CODES'], ['POLYGON']] }],
      [
        'a requirement',
        (b) => (b.requirements = [{ requirementType: 'LICENSE' }, { requirementType: 'INSURANCE' }]),
        { requirements: { added: ['INSURANCE:'], removed: ['SKILL:wax_application'] } },
      ],
      [
        'an option default',
        (b) => ((b.fields as FieldIn[])[1]!.options = [{ optionCode: 'wax' }, { optionCode: 'sealant', isDefault: true }, { optionCode: 'ceramic' }]),
        { fields: { added: [], removed: [], changed: ['finish'] } },
      ],
      [
        'a requirement that is only removed',
        (b) => (b.requirements = [{ requirementType: 'LICENSE' }]),
        { requirements: { added: [], removed: ['INSURANCE:'] } },
      ],
    ];
    const body = def(rev, { duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 } });
    for (const [label, mutate, expected] of steps) {
      mutate(body);
      body.expectedRevision = rev;
      const incrs = cache.incrs.length;
      const v = await replaceDraft(c, 1, body);
      expect(v.revision, label).toBe(rev + 1);
      expect((await versionRow(c, 1)).revision, label).toBe(rev + 1);
      expect((await tplAudit(c)).at(-1)!.changes, label).toEqual({ revision: [rev, rev + 1], ...expected });
      expect(cache.incrs.length, label).toBe(incrs);
      rev++;
    }
    expect((await structureOf(c, 1)).options.map((o) => [o.option_code, o.is_default])).toEqual([
      ['wax', false],
      ['sealant', true],
      ['ceramic', false],
    ]);
  });

  it('reordering the fields is a change: the display order follows the request, and the options keep theirs', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st);
    const reversed = [...stdFields()].reverse();
    const v = await replaceDraft(c, 1, def(revision, { fields: reversed }));
    expect(v.revision).toBe(revision + 1);
    expect((await fieldRows(c, 1)).map((f) => [f.field_key, f.display_order])).toEqual(reversed.map((f, i) => [f.fieldKey, i + 1]));
    expect(v.fields.map((f) => f.fieldKey)).toEqual(reversed.map((f) => f.fieldKey));
    expect((await optionRows(c, 1)).map((o) => o.option_code)).toEqual(['wax', 'sealant', 'ceramic']);
  });

  it('a definition without fields is a valid DRAFT (it removes the old rows); it cannot be published (GIG_TEMPLATE_HAS_NO_FIELDS)', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
    const v = await replaceDraft(c, 1, def(revision, { fields: [], requirements: [] }));
    expect([v.fieldCount, v.fields.length, v.requirements.length]).toEqual([0, 0, 0]);
    expect([(await fieldRows(c, 1)).length, (await optionRows(c, 1)).length, (await reqRows(c, 1)).length]).toEqual([0, 0, 0]);
    const world = await worldHash();
    await expectError(publish(c, 1, v.revision!), 'INVALID_STATE', 'GIG_TEMPLATE_HAS_NO_FIELDS');
    expect(await worldHash()).toBe(world);
  });

  it('a stale revision is CONFLICT STALE_DRAFT and writes nothing, whether lower or higher, and also for a definition that is identical to the stored one', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st);
    await replaceDraft(c, 1, def(revision, { areaModes: ['RADIUS'] })); // revision + 1
    const world = await worldHash();
    const incrs = cache.incrs.length;
    for (const stale of [revision, revision + 2, 1, 99]) {
      const e = await expectError(replaceDraft(c, 1, def(stale, { areaModes: ['POLYGON'] })), 'CONFLICT', 'STALE_DRAFT');
      expect(e.details.retryable).toBeUndefined();
    }
    await expectError(replaceDraft(c, 1, def(revision, { areaModes: ['RADIUS'] })), 'CONFLICT', 'STALE_DRAFT'); // identical, but stale: not an idempotent no-op
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
    expect((await replaceDraft(c, 1, def(revision + 1, { areaModes: ['RADIUS'] }))).revision).toBe(revision + 1); // the current revision with an equal definition: no-op
  });

  it('only a DRAFT can change: an ACTIVE, SUPERSEDED or RETIRED version is VERSION_NOT_DRAFT (before the revision is looked at); unknown version and template are typed not-found errors', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    await publish(c, 2, 1); // 1 SUPERSEDED, 2 ACTIVE
    await createDraft(c, 2);
    await discard(c, 3); // 3 RETIRED
    const world = await worldHash();
    for (const n of [1, 2, 3]) {
      await expectError(replaceDraft(c, n, def(1)), 'INVALID_STATE', 'VERSION_NOT_DRAFT');
      await expectError(replaceDraft(c, n, def(999)), 'INVALID_STATE', 'VERSION_NOT_DRAFT');
    }
    await expectError(replaceDraft(c, 4, def(1)), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    await expectError(replaceDraft('devtest_nothing', 1, def(1)), 'GIG_TEMPLATE_NOT_FOUND');
    expect(await worldHash()).toBe(world);
  });

  it('copy that does not exist yet is CONTENT_ENTRY_MISSING with the missing keys (in definition order, at most 20), and the old definition is intact: the failed replace is rolled back as a whole', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st);
    const world = await worldHash();
    const fields: FieldIn[] = [
      ...stdFields(),
      { fieldKey: 'new_one', fieldType: 'TEXT', behavior: 'PROVIDER_CONFIGURABLE', withHelp: true, withDefaultText: true },
      { fieldKey: 'new_enum', fieldType: 'ENUM', behavior: 'PROVIDER_CONFIGURABLE', options: [{ optionCode: 'x_one' }, { optionCode: 'x_two' }] },
    ];
    const e = await expectError(replaceDraft(c, 1, def(revision, { fields })), 'VALIDATION_FAILED', 'CONTENT_ENTRY_MISSING');
    expect(e.details.contentKeys).toEqual([
      `${stem(c)}.field.new_one.label`,
      `${stem(c)}.field.new_one.help`,
      `${stem(c)}.field.new_one.default`,
      `${stem(c)}.field.new_enum.label`,
      `${stem(c)}.field.new_enum.option.x_one.label`,
      `${stem(c)}.field.new_enum.option.x_two.label`,
    ]);
    expect(await worldHash()).toBe(world);
    expect((await versionRow(c, 1)).revision).toBe(revision);
    // more than 20: the first 20 are reported
    const many: FieldIn[] = Array.from({ length: 25 }, (_, i) => ({
      fieldKey: `bulk_${String(i).padStart(2, '0')}`,
      fieldType: 'TEXT',
      behavior: 'PROVIDER_CONFIGURABLE',
    }));
    const e2 = await expectError(replaceDraft(c, 1, def(revision, { fields: many })), 'VALIDATION_FAILED', 'CONTENT_ENTRY_MISSING');
    expect(e2.details.contentKeys).toEqual(many.slice(0, 20).map((f) => `${stem(c)}.field.${f.fieldKey}.label`));
    expect(await worldHash()).toBe(world);
    expect(JSON.stringify(e2.message)).not.toMatch(/catalog\.|content\./);
    // once the copy exists the very same request goes through
    await putContent(keysOfFields(c, fields));
    expect((await replaceDraft(c, 1, def(revision, { fields }))).fieldCount).toBe(8);
  });

  it('the copy only has to EXIST to be written into a draft (a DRAFT-only entry is accepted); it has to be PUBLISHED to publish', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st, { activate: true });
    const fields: FieldIn[] = [{ fieldKey: 'only_field', fieldType: 'TEXT', behavior: 'PROVIDER_REQUIRED' }];
    await putContent(keysOfFields(c, fields), 'draft');
    await createDraft(c);
    const v = await replaceDraft(c, 1, def(1, { fields, requirements: [] }));
    expect(v.fieldCount).toBe(1);
    await expectError(publish(c, 1, v.revision!), 'INVALID_STATE', 'CONTENT_NOT_PUBLISHED');
  });

  it('60 fields with a requirement list of 30 are written in one transaction and read back in order', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const fields: FieldIn[] = Array.from({ length: 60 }, (_, i) => ({
      fieldKey: `field_${String(i).padStart(2, '0')}`,
      fieldType: 'TEXT',
      behavior: 'PROVIDER_CONFIGURABLE',
    }));
    const requirements = Array.from({ length: 30 }, (_, i) => ({ requirementType: 'SKILL', referenceCode: `skill_${String(i).padStart(2, '0')}` }));
    await copyFor(c, fields);
    await createDraft(c);
    const v = await replaceDraft(c, 1, def(1, { fields, requirements }));
    expect([v.fieldCount, v.requirements.length]).toEqual([60, 30]);
    expect((await fieldRows(c, 1)).map((f) => [f.field_key, f.display_order])).toEqual(fields.map((f, i) => [f.fieldKey, i + 1]));
  });

  it('a number with more precision than the column keeps (float noise, 5e-14 off a 4-decimal value) is an equal definition: a repeat of the same request is an idempotent no-op', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const fields: FieldIn[] = [{ fieldKey: 'ratio', fieldType: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', defaultNumber: 1 + 5e-14 }];
    await copyFor(c, fields);
    await createDraft(c);
    const first = await replaceDraft(c, 1, def(1, { fields, requirements: [] }));
    expect((await fieldRows(c, 1)).map((f) => num(f.default_number))).toEqual([1]);
    const world = await worldHash();
    const second = await replaceDraft(c, 1, def(first.revision!, { fields, requirements: [] }));
    expect(second.revision, 'the same request again must not bump the revision').toBe(first.revision);
    expect(await worldHash()).toBe(world);
    // the same for the noise of a sum of floats on every numeric column
    const noisy: FieldIn[] = [
      {
        fieldKey: 'ratio',
        fieldType: 'DECIMAL',
        behavior: 'PROVIDER_CONFIGURABLE',
        minNumber: 0.1 + 0.2 - 0.2,
        maxNumber: 9.9999 + 1e-13,
        defaultNumber: 0.30000000000000004 - 0.2,
      },
    ];
    const third = await replaceDraft(c, 1, def(first.revision!, { fields: noisy, requirements: [] }));
    expect(third.revision).toBe(first.revision! + 1);
    expect((await fieldRows(c, 1)).map((f) => [num(f.min_number), num(f.max_number), num(f.default_number)])).toEqual([[0.1, 9.9999, 0.1]]);
    expect((await replaceDraft(c, 1, def(third.revision!, { fields: noisy, requirements: [] }))).revision).toBe(third.revision);
  });

  it('a replace in the middle of the write that fails (the audit row cannot be written) rolls the children, the columns and the revision back', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    const e = (await failing('catalog.audit_events', `NEW.action = 'GIG_TEMPLATE_VERSION_CHANGED'`, () =>
      replaceDraft(c, 1, def(revision, { fields: stdFields().slice(0, 2), duration: { minMinutes: 5 } })),
    )) as { code?: string };
    expect(e.code).toBe('XX000');
    expect(await worldHash()).toBe(world);
    expect((await versionRow(c, 1)).revision).toBe(revision);
    expect((await fieldRows(c, 1)).length).toBe(6);
    expect(cache.incrs.length).toBe(incrs);
    expect((await replaceDraft(c, 1, def(revision, { fields: stdFields().slice(0, 2) }))).fieldCount).toBe(2); // and the retry works
  });
});

describe('retireGigTemplateVersion (discarding a draft)', () => {
  it('a DRAFT becomes RETIRED (closed_at set, never published, its rows kept): one audit row, no event, no bump; a repeat is a no-op', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c } = await mkDraftTemplate(st, { activate: true });
    const structure = await structureOf(c, 1);
    const before = await counts();
    const incrs = cache.incrs.length;
    const view = await runWithCorrelation('corr-discard', () => gt.retireGigTemplateVersion(c, 1, { status: 'RETIRED', reason: 'not needed' }, 'admin:hal'));
    expect(view).toMatchObject({ versionNumber: 1, status: 'RETIRED', publishedAt: null, revision: 2 });
    expect(view.closedAt).not.toBeNull();
    const row = await versionRow(c, 1);
    expect([row.status, row.published_at]).toEqual(['RETIRED', null]);
    expect(row.closed_at).not.toBeNull();
    expect(await structureOf(c, 1)).toEqual(structure);
    expect((await tplAudit(c)).at(-1)).toEqual({
      action: 'GIG_TEMPLATE_VERSION_RETIRED',
      actor: 'admin:hal',
      changes: { status: ['DRAFT', 'RETIRED'], versionNumber: [1, 1] },
      reason: 'not needed',
      correlation_id: 'corr-discard',
      version_number: 1,
      market_code: null,
    });
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events]).toEqual([1, 0]);
    expect(cache.incrs.length).toBe(incrs);
    const world = await worldHash();
    expect((await discard(c, 1)).status).toBe('RETIRED');
    expect(await worldHash()).toBe(world);
    // a retired draft is frozen: no replace, no publication
    await expectError(replaceDraft(c, 1, def(2)), 'INVALID_STATE', 'VERSION_NOT_DRAFT');
    await expectError(publish(c, 1, 2), 'INVALID_STATE', 'VERSION_NOT_DRAFT');
  });

  it('a published version is never withdrawn on its own: ACTIVE and SUPERSEDED are ONLY_DRAFT_CAN_BE_DISCARDED; unknown version and template are typed errors; nothing is written', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    await publish(c, 2, 1);
    const world = await worldHash();
    for (const n of [1, 2]) await expectError(discard(c, n), 'INVALID_STATE', 'ONLY_DRAFT_CAN_BE_DISCARDED');
    await expectError(discard(c, 3), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    await expectError(discard('devtest_nothing', 1), 'GIG_TEMPLATE_NOT_FOUND');
    expect(await worldHash()).toBe(world);
    expect(await vStatuses(c)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
    ]);
  });
});

// ====================================================================== 5. publication
describe('publishGigTemplateVersion', () => {
  it('publishes the DRAFT: ACTIVE, published_at set, revision kept, one PUBLISHED audit row, ONE published event with identifiers only, one cache bump', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
    const tplId = (await templateRow(c)).gig_template_id as string;
    const draft = await versionRow(c, 1);
    const structure = await structureOf(c, 1);
    const before = await counts();
    const g = cache.gen();
    const incrs = cache.incrs.length;
    const t0 = Date.now();
    const view = await runWithCorrelation('corr-publish-1', () =>
      gt.publishGigTemplateVersion(c, 1, { expectedRevision: revision, reason: 'go live' }, 'admin:ivy'),
    );
    expect(view).toMatchObject({ versionNumber: 1, status: 'ACTIVE', revision, fieldCount: 6, closedAt: null });
    expect(view.publishedAt).not.toBeNull();
    const row = await versionRow(c, 1);
    expect(row).toMatchObject({ status: 'ACTIVE', revision, closed_at: null });
    expect((row.published_at as Date).getTime()).toBeGreaterThanOrEqual(t0 - 2000);
    expect(row.published_at).not.toBeNull();
    expect(row.gig_template_version_id).toBe(draft.gig_template_version_id);
    expect(await structureOf(c, 1)).toEqual(structure);
    expect((await tplAudit(c)).at(-1)).toEqual({
      action: 'GIG_TEMPLATE_VERSION_PUBLISHED',
      actor: 'admin:ivy',
      changes: { status: ['DRAFT', 'ACTIVE'], versionNumber: [1, 1], supersedesVersion: [null, null], fieldCount: [null, 6] },
      reason: 'go live',
      correlation_id: 'corr-publish-1',
      version_number: 1,
      market_code: null,
    });
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events]).toEqual([1, 1]);
    expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).toEqual([
      {
        event_type: GIG_TEMPLATE_EVENTS.published,
        event_version: 1,
        aggregate_type: 'catalog_gig_template',
        aggregate_id: tplId,
        actor_type: 'user',
        actor_id: 'admin:ivy',
        payload_json: { gigTemplateCode: c, serviceTypeCode: st, versionNumber: 1, gigTemplateVersionId: draft.gig_template_version_id },
        correlation_id: 'corr-publish-1',
        causation_id: null,
        published_at: null,
      },
    ]);
    expect(cache.incrs.length - incrs).toBe(1);
    expect(cache.gen()).toBe(g + 1);
    expect((await bare.getGigTemplate(c)).activeVersion!.gigTemplateVersionId).toBe(draft.gig_template_version_id);
  });

  it('a published version and EVERY row under it are frozen by the database, and each refusal is a typed error', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    const versionId = (await versionRow(c, 1)).gig_template_version_id as string;
    const world = await worldHash();
    const field = `(SELECT gig_template_field_id FROM catalog.gig_template_fields WHERE gig_template_version_id = $1 AND field_key = 'finish')`;
    const label = `${stem(c)}.field.scope_notes.label`;
    const cases: [string, string, unknown[], string][] = [
      ['duration', 'UPDATE catalog.gig_template_versions SET min_duration_minutes = 5 WHERE gig_template_version_id = $1', [versionId], 'VERSION_FROZEN'],
      ['revision', 'UPDATE catalog.gig_template_versions SET revision = revision + 1 WHERE gig_template_version_id = $1', [versionId], 'VERSION_FROZEN'],
      ['pricing', 'UPDATE catalog.gig_template_versions SET pricing_drop_eligible = true WHERE gig_template_version_id = $1', [versionId], 'VERSION_FROZEN'],
      ['area', 'UPDATE catalog.gig_template_versions SET area_polygon = true WHERE gig_template_version_id = $1', [versionId], 'VERSION_FROZEN'],
      [
        'published_at',
        "UPDATE catalog.gig_template_versions SET published_at = now() - interval '1 day' WHERE gig_template_version_id = $1",
        [versionId],
        'VERSION_FROZEN',
      ],
      ['field update', 'UPDATE catalog.gig_template_fields SET customer_visible = false WHERE gig_template_version_id = $1', [versionId], 'VERSION_NOT_DRAFT'],
      ['field delete', 'DELETE FROM catalog.gig_template_fields WHERE gig_template_version_id = $1', [versionId], 'VERSION_NOT_DRAFT'],
      [
        'field insert',
        `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key) VALUES ($1, 'late_one', 'BOOLEAN', 'PROVIDER_CONFIGURABLE', 99, $2)`,
        [versionId, label],
        'VERSION_NOT_DRAFT',
      ],
      [
        'option update',
        `UPDATE catalog.gig_template_field_options SET is_default = false WHERE gig_template_field_id = ${field}`,
        [versionId],
        'VERSION_NOT_DRAFT',
      ],
      ['option delete', `DELETE FROM catalog.gig_template_field_options WHERE gig_template_field_id = ${field}`, [versionId], 'VERSION_NOT_DRAFT'],
      [
        'option insert',
        `INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order) VALUES (${field}, 'late_opt', $2, 9)`,
        [versionId, label],
        'VERSION_NOT_DRAFT',
      ],
      [
        'requirement update',
        "UPDATE catalog.gig_template_requirements SET reference_code = 'other_one' WHERE gig_template_version_id = $1 AND requirement_type = 'SKILL'",
        [versionId],
        'VERSION_NOT_DRAFT',
      ],
      ['requirement delete', 'DELETE FROM catalog.gig_template_requirements WHERE gig_template_version_id = $1', [versionId], 'VERSION_NOT_DRAFT'],
      [
        'requirement insert',
        "INSERT INTO catalog.gig_template_requirements (gig_template_version_id, requirement_type) VALUES ($1, 'INSURANCE')",
        [versionId],
        'VERSION_NOT_DRAFT',
      ],
      ['version delete', 'DELETE FROM catalog.gig_template_versions WHERE gig_template_version_id = $1', [versionId], 'IMMUTABLE'],
      ['version number', 'UPDATE catalog.gig_template_versions SET version_number = 9 WHERE gig_template_version_id = $1', [versionId], 'IMMUTABLE'],
    ];
    for (const [label2, text, params, reason] of cases) {
      const e = await rawRefused(text, params);
      expect([e.code, e.details.reason], label2).toEqual(['INVALID_STATE', reason]);
    }
    expect(await worldHash()).toBe(world);
  });

  it('is idempotent: the same revision on the ACTIVE version changes nothing (no audit row, no event, no bump); another revision, or a SUPERSEDED version, is VERSION_NOT_DRAFT', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
    await publish(c, 1, revision);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    for (let i = 0; i < 3; i++) expect((await publish(c, 1, revision)).status).toBe('ACTIVE');
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
    expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).length).toBe(1);
    await expectError(publish(c, 1, revision + 1), 'INVALID_STATE', 'VERSION_NOT_DRAFT');
    await expectError(publish(c, 1, 1), 'INVALID_STATE', 'VERSION_NOT_DRAFT');
    await createDraft(c, 1);
    await publish(c, 2, 1);
    await expectError(publish(c, 1, revision), 'INVALID_STATE', 'VERSION_NOT_DRAFT'); // v1 is SUPERSEDED now: a replay is not a no-op any more
    expect((await publish(c, 2, 1)).status).toBe('ACTIVE'); // but the current ACTIVE version still is
  });

  it('supersedes the previous ACTIVE version: v1 SUPERSEDED with closed_at, history and v1 content intact, ONE event (for v2), ONE audit row naming the version it replaces, the public view switches', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const v1 = await versionRow(c, 1);
    const v1Structure = await structureOf(c, 1);
    await createDraft(c, 1);
    const v2Fields = stdFields().slice(0, 4);
    const r2 = (await replaceDraft(c, 2, def(1, { fields: v2Fields }))).revision!;
    await sleep(3);
    const before = await counts();
    const incrs = cache.incrs.length;
    const corr = `corr-supersede-${seq}`;
    const view = await runWithCorrelation(corr, () => publish(c, 2, r2));
    expect(view).toMatchObject({ versionNumber: 2, status: 'ACTIVE', fieldCount: 4 });
    const rows = await versionRows(c);
    expect(rows.map((v) => [v.version_number, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
    ]);
    expect(rows[0]!.published_at).toEqual(v1.published_at);
    expect(rows[0]!.closed_at).not.toBeNull();
    expect((rows[0]!.closed_at as Date).getTime()).toBeGreaterThan((v1.published_at as Date).getTime());
    expect(rows[0]!.revision).toBe(v1.revision);
    expect(rows[0]!.gig_template_version_id).toBe(v1.gig_template_version_id);
    expect(rows[1]!.closed_at).toBeNull();
    expect(await structureOf(c, 1)).toEqual(v1Structure); // the old version keeps all its rows
    expect((await fieldRows(c, 2)).map((f) => f.field_key)).toEqual(v2Fields.map((f) => f.fieldKey));
    expect((await tplAudit(c)).at(-1)).toMatchObject({
      action: 'GIG_TEMPLATE_VERSION_PUBLISHED',
      version_number: 2,
      correlation_id: corr,
      changes: { status: ['DRAFT', 'ACTIVE'], versionNumber: [2, 2], supersedesVersion: [null, 1], fieldCount: [null, 4] },
    });
    const after = await counts();
    expect([after.audit - before.audit, after.events - before.events], 'no audit row and no event for the automatic supersession').toEqual([1, 1]);
    expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).map((e) => e.payload_json.versionNumber)).toEqual([1, 2]);
    expect(cache.incrs.length - incrs).toBe(1);
    expect(
      (
        await one<{ n: number }>(
          "SELECT count(*)::int AS n FROM catalog.gig_template_versions v JOIN catalog.gig_templates t USING (gig_template_id) WHERE t.code = $1 AND v.status = 'ACTIVE'",
          [c],
        )
      ).n,
    ).toBe(1);
    // reads: the public view shows v2, the management view keeps every version newest first and v1 stays readable
    const pub = (await bare.getGigTemplateForMarket(env.market, c)).template.activeVersion!;
    expect([pub.versionNumber, pub.fields.length]).toEqual([2, 4]);
    expect((await bare.getGigTemplate(c)).versions!.map((v) => [v.versionNumber, v.status, v.fieldCount])).toEqual([
      [2, 'ACTIVE', 4],
      [1, 'SUPERSEDED', 6],
    ]);
    const old = await bare.getGigTemplateVersion(c, 1);
    expect([old.status, old.fields.length, old.requirements.length]).toEqual(['SUPERSEDED', 6, 2]);
    expect(old.closedAt).not.toBeNull();
  });

  it('numbers stay contiguous across discards and publications: 1 ACTIVE, 2 discarded, 3 published (1 SUPERSEDED), 4 discarded, 5 published; at most one ACTIVE and one DRAFT at any time', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    await discard(c, 2);
    await createDraft(c, 1);
    await publish(c, 3, 1);
    await createDraft(c, 3);
    await discard(c, 4);
    await createDraft(c, 3);
    await publish(c, 5, 1);
    expect(await vStatuses(c)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'RETIRED'],
      [3, 'SUPERSEDED'],
      [4, 'RETIRED'],
      [5, 'ACTIVE'],
    ]);
    expect((await bare.getGigTemplate(c)).versions!.map((v) => v.versionNumber)).toEqual([5, 4, 3, 2, 1]);
    // every version keeps its own rows
    for (const n of [1, 3, 5]) expect((await fieldRows(c, n)).length).toBe(6);
    expect((await bare.getGigTemplateVersion(c, 5)).revision).toBe(1);
  });

  it('refusals: a stale revision (STALE_DRAFT), a template that is not ACTIVE (GIG_TEMPLATE_NOT_ACTIVE for DRAFT and INACTIVE), a service type that is not ACTIVE (SERVICE_TYPE_NOT_ACTIVE), an unknown version or template; nothing is written', async () => {
    const { category, st } = await mkServiceTypeActive();
    const stale = await mkDraftTemplate(st, { activate: true });
    const draftTpl = await mkDraftTemplate(st);
    const paused = await mkDraftTemplate(st, { activate: true });
    await setTpl(paused.code, 'INACTIVE');
    const world = await worldHash();
    const incrs = cache.incrs.length;
    await expectError(publish(stale.code, 1, stale.revision - 1), 'CONFLICT', 'STALE_DRAFT');
    await expectError(publish(stale.code, 1, stale.revision + 1), 'CONFLICT', 'STALE_DRAFT');
    await expectError(publish(draftTpl.code, 1, draftTpl.revision), 'INVALID_STATE', 'GIG_TEMPLATE_NOT_ACTIVE');
    await expectError(publish(paused.code, 1, paused.revision), 'INVALID_STATE', 'GIG_TEMPLATE_NOT_ACTIVE');
    await expectError(publish(stale.code, 2, 1), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    await expectError(publish('devtest_nothing', 1, 1), 'GIG_TEMPLATE_NOT_FOUND');
    await setSt(st, 'INACTIVE'); // no cascade: the template stays ACTIVE under a paused service type
    const w2 = await worldHash();
    await expectError(publish(stale.code, 1, stale.revision), 'INVALID_STATE', 'SERVICE_TYPE_NOT_ACTIVE');
    expect(await worldHash()).toBe(w2);
    await setSt(st, 'ACTIVE');
    expect((await publish(stale.code, 1, stale.revision)).status).toBe('ACTIVE');
    expect(await worldHash()).not.toBe(world);
    expect(category).toBeTruthy();
    expect(cache.incrs.length - incrs).toBeGreaterThanOrEqual(1);
  });

  it('the checks run in a fixed order: version state, then the revision, then the template status, then the copy', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st); // DRAFT template: cannot publish yet
    const fields: FieldIn[] = [{ fieldKey: 'only_field', fieldType: 'TEXT', behavior: 'PROVIDER_REQUIRED' }];
    await putContent(keysOfFields(c, fields), 'draft'); // and the copy is not published either
    await createDraft(c);
    const rev = (await replaceDraft(c, 1, def(1, { fields, requirements: [] }))).revision!;
    await expectError(publish(c, 1, rev + 5), 'CONFLICT', 'STALE_DRAFT'); // stale beats "template not active"
    await expectError(publish(c, 1, rev), 'INVALID_STATE', 'GIG_TEMPLATE_NOT_ACTIVE'); // not active beats "copy not published"
    await setTpl(c, 'ACTIVE');
    await expectError(publish(c, 1, rev), 'INVALID_STATE', 'CONTENT_NOT_PUBLISHED');
    await discard(c, 1);
    await expectError(publish(c, 1, rev + 5), 'INVALID_STATE', 'VERSION_NOT_DRAFT'); // version state beats stale
  });

  it('a version with an ENUM field that has no option cannot be published (ENUM_FIELD_WITHOUT_OPTIONS); a PLATFORM_FIXED ENUM whose default option vanished cannot either (FIXED_ENUM_WITHOUT_DEFAULT)', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st, { activate: true });
    const bare1: FieldIn[] = [{ fieldKey: 'finish', fieldType: 'ENUM', behavior: 'PROVIDER_CONFIGURABLE' }];
    await copyFor(c, bare1);
    await createDraft(c);
    const r = (await replaceDraft(c, 1, def(1, { fields: bare1, requirements: [] }))).revision!;
    const world = await worldHash();
    await expectError(publish(c, 1, r), 'INVALID_STATE', 'ENUM_FIELD_WITHOUT_OPTIONS');
    expect(await worldHash()).toBe(world);
    const fixed: FieldIn[] = [
      { fieldKey: 'finish', fieldType: 'ENUM', behavior: 'PLATFORM_FIXED', options: [{ optionCode: 'wax', isDefault: true }, { optionCode: 'sealant' }] },
    ];
    await copyFor(c, fixed);
    const r2 = (await replaceDraft(c, 1, def(r, { fields: fixed, requirements: [] }))).revision!;
    // the contract guarantees a default option; the draft is then damaged behind the service's back (the database allows it while it is a DRAFT)
    await q(
      'UPDATE catalog.gig_template_field_options SET is_default = false WHERE option_code = $1 AND gig_template_field_id IN (SELECT f.gig_template_field_id FROM catalog.gig_template_fields f JOIN catalog.gig_template_versions v USING (gig_template_version_id) JOIN catalog.gig_templates t USING (gig_template_id) WHERE t.code = $2)',
      ['wax', c],
    );
    const w2 = await worldHash();
    await expectError(publish(c, 1, r2), 'INVALID_STATE', 'FIXED_ENUM_WITHOUT_DEFAULT');
    expect(await worldHash()).toBe(w2);
  });

  it('the database is the backstop of every publication rule: a raw status update is refused for unpublished copy, a paused template, a paused service type, a changed draft and a missing field', async () => {
    const { st } = await mkServiceTypeActive();
    const k = (c: string) => `${stem(c)}.field.scope_notes.help`;
    const mk = async (o: { spoil?: boolean; activate?: boolean } = {}) => {
      const c = await mkTemplate(st, { activate: o.activate ?? true });
      await putContent(keysOfFields(c, stdFields()).filter((x) => x !== k(c)));
      await putContent([k(c)], o.spoil ? 'draft' : 'published');
      await createDraft(c);
      await replaceDraft(c, 1, def(1));
      return c;
    };
    const publishRaw = (c: string, extra = '') =>
      rawRefused(
        `UPDATE catalog.gig_template_versions SET status = 'ACTIVE'${extra} WHERE gig_template_id = (SELECT gig_template_id FROM catalog.gig_templates WHERE code = $1) AND version_number = 1`,
        [c],
      );
    const spoiled = await mk({ spoil: true });
    expect((await publishRaw(spoiled)).details.reason).toBe('CONTENT_NOT_PUBLISHED');
    const paused = await mk();
    await setTpl(paused, 'INACTIVE');
    expect((await publishRaw(paused)).details.reason).toBe('GIG_TEMPLATE_NOT_ACTIVE');
    const changed = await mk();
    expect((await publishRaw(changed, ', min_duration_minutes = 1')).details.reason).toBe('VERSION_FROZEN');
    expect((await publishRaw(changed, ', revision = revision + 1')).details.reason).toBe('VERSION_FROZEN');
    const empty = await mkTemplate(st, { activate: true });
    await createDraft(empty);
    expect((await publishRaw(empty)).details.reason).toBe('GIG_TEMPLATE_HAS_NO_FIELDS');
    const other = await mkServiceTypeActive();
    const underPaused = await mkTemplate(other.st, { activate: true });
    await putContent(keysOfFields(underPaused, stdFields()));
    await createDraft(underPaused);
    await replaceDraft(underPaused, 1, def(1));
    await setSt(other.st, 'INACTIVE');
    expect((await publishRaw(underPaused)).details.reason).toBe('SERVICE_TYPE_NOT_ACTIVE');
    for (const c of [spoiled, paused, changed, empty, underPaused]) expect((await versionRow(c, 1)).status).toBe('DRAFT');
  });
});

describe('the copy of a template is checked at publication in the platform default locale, at platform scope, in force now', () => {
  /** A template with a complete draft whose copy is published, except ONE key, which is put in the given state. */
  async function spoiled(mode: string): Promise<{ c: string; key: string; revision: number }> {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st, { activate: true });
    const key = `${stem(c)}.field.scope_notes.help`;
    await putContent(keysOfFields(c, stdFields()).filter((x) => x !== key));
    if (mode === 'entry') await putContent([key], 'entry');
    else if (mode === 'draft') await putContent([key], 'draft');
    else {
      await putContent([key]);
      const version = `UPDATE content.versions v SET %SET% FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = $1`;
      const set = (clause: string) => withoutTriggers(['content.versions'], () => q(version.replace('%SET%', clause), [key]));
      if (mode === 'approved') await set("status = 'APPROVED'");
      if (mode === 'future') await set("effective_from = now() + interval '1 day'");
      if (mode === 'expired') await set("effective_from = now() - interval '2 days', effective_to = now() - interval '1 day'");
      if (mode === 'locale') {
        await q("INSERT INTO content.locales (locale, is_active) VALUES ('de-DE', true) ON CONFLICT DO NOTHING");
        await set("locale = 'de-DE'");
      }
      if (mode === 'market') await set("scope_type = 'MARKET', scope_ref = 'la-oc'");
      if (mode === 'cancelled') await set("status = 'CANCELLED'");
    }
    await createDraft(c);
    const revision = (await replaceDraft(c, 1, def(1))).revision!;
    return { c, key, revision };
  }

  it.each(['entry', 'draft', 'approved', 'future', 'expired', 'locale', 'market', 'cancelled'])(
    'copy in state "%s" is not published: CONTENT_NOT_PUBLISHED naming exactly that key, nothing written',
    async (mode) => {
      const { c, key, revision } = await spoiled(mode);
      const world = await worldHash();
      const incrs = cache.incrs.length;
      const e = await expectError(publish(c, 1, revision), 'INVALID_STATE', 'CONTENT_NOT_PUBLISHED');
      expect(e.details.contentKeys).toEqual([key]);
      expect(Object.keys(e.details).sort()).toEqual(['contentKeys', 'reason']);
      expect(JSON.stringify(e.message)).not.toMatch(/catalog\.|content\./);
      expect(await worldHash()).toBe(world);
      expect(cache.incrs.length).toBe(incrs);
      expect((await versionRow(c, 1)).status).toBe('DRAFT');
    },
  );

  it('every key is in the check: the template name, description and instructions and every label, help, default text and option label; they are listed in byte order, at most 20', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st, { activate: true, description: true, instructions: true, publishedCopy: false });
    await putContent([descKey(c), instrKey(c)], 'draft');
    await putContent(keysOfFields(c, stdFields()), 'draft');
    await createDraft(c);
    const revision = (await replaceDraft(c, 1, def(1))).revision!;
    const wanted = [nameKey(c), descKey(c), instrKey(c), ...keysOfFields(c, stdFields())].sort();
    expect(wanted).toHaveLength(14);
    const e = await expectError(publish(c, 1, revision), 'INVALID_STATE', 'CONTENT_NOT_PUBLISHED');
    expect(e.details.contentKeys).toEqual(wanted);
    // one by one: publishing each of them is needed
    for (const key of wanted.slice(0, -1)) {
      await putContent([key]);
      const e2 = await expectError(publish(c, 1, revision), 'INVALID_STATE', 'CONTENT_NOT_PUBLISHED');
      expect((e2.details.contentKeys as string[]).includes(key)).toBe(false);
    }
    await putContent([wanted.at(-1)!]);
    expect((await publish(c, 1, revision)).status).toBe('ACTIVE');
  });

  it('more than 20 unpublished keys: the first 20 in byte order are reported', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st, { activate: true });
    const fields: FieldIn[] = Array.from({ length: 30 }, (_, i) => ({
      fieldKey: `field_${String(i).padStart(2, '0')}`,
      fieldType: 'TEXT',
      behavior: 'PROVIDER_CONFIGURABLE',
    }));
    await putContent(keysOfFields(c, fields), 'draft');
    await createDraft(c);
    const revision = (await replaceDraft(c, 1, def(1, { fields, requirements: [] }))).revision!;
    const e = await expectError(publish(c, 1, revision), 'INVALID_STATE', 'CONTENT_NOT_PUBLISHED');
    expect(e.details.contentKeys).toEqual(keysOfFields(c, fields).sort().slice(0, 20));
  });

  it('copy that is published after the failed attempt lets the very same draft publish (the refusal is not sticky)', async () => {
    const { c, key, revision } = await spoiled('draft');
    await expectError(publish(c, 1, revision), 'INVALID_STATE', 'CONTENT_NOT_PUBLISHED');
    await q("UPDATE content.versions v SET status = 'APPROVED' FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = $1", [key]);
    await q("UPDATE content.versions v SET status = 'PUBLISHED' FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = $1", [key]);
    expect((await publish(c, 1, revision)).status).toBe('ACTIVE');
  });

  // catalog.content_is_published reads the same statuses as the content resolver (SCHEDULED, PUBLISHED, SUPERSEDED inside their window, active entry): copy that already
  // resolves for customers (a SCHEDULED version whose start has passed, activation job not run yet) counts as published.
  it('copy that the content registry already resolves (a SCHEDULED version whose start has passed, activation job not run yet) counts as published', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st, { activate: true });
    const key = `${stem(c)}.field.scope_notes.help`;
    await putContent(keysOfFields(c, stdFields()).filter((x) => x !== key));
    await putContent([key]);
    await withoutTriggers(['content.versions'], () =>
      q(
        "UPDATE content.versions v SET status = 'SCHEDULED', effective_from = now() - interval '1 hour' FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = $1",
        [key],
      ),
    );
    await createDraft(c);
    const revision = (await replaceDraft(c, 1, def(1))).revision!;
    expect((await publish(c, 1, revision)).status).toBe('ACTIVE');
  });
});

describe('the database guards behind the service map to typed errors', () => {
  it('every refusal of a raw statement is an INVALID_STATE with the rule as its reason (what a caller of the service would see if it ever got that far)', async () => {
    const { st } = await mkServiceTypeActive();
    const live = await mkPublished(st); // ACTIVE template, v1 ACTIVE
    const retired = await mkTemplate(st);
    await setTpl(retired, 'RETIRED');
    const withDraft = await mkTemplate(st, { activate: true });
    await createDraft(withDraft);
    const draftOnly = await mkDraftTemplate(st);
    const id = (c: string) => `(SELECT gig_template_id FROM catalog.gig_templates WHERE code = '${c}')`;
    const ver = (c: string, n: number) =>
      `(SELECT gig_template_version_id FROM catalog.gig_template_versions WHERE gig_template_id = ${id(c)} AND version_number = ${n})`;
    const env = await mkEnv();
    const cases: [string, string, string][] = [
      [
        'SUPERSEDED by hand',
        `UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED' WHERE gig_template_version_id = ${ver(live, 1)}`,
        'SUPERSEDED_IS_AUTOMATIC',
      ],
      [
        'DRAFT to SUPERSEDED',
        `UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED' WHERE gig_template_version_id = ${ver(withDraft, 1)}`,
        'STATUS_TRANSITION',
      ],
      ['back to DRAFT', `UPDATE catalog.gig_template_versions SET status = 'DRAFT' WHERE gig_template_version_id = ${ver(live, 1)}`, 'DRAFT_IS_INITIAL'],
      ['a second DRAFT', `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES (${id(withDraft)}, 2)`, 'DRAFT_EXISTS'],
      [
        'a gap in the numbers',
        `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES (${id(live)}, 5)`,
        'VERSION_NUMBER_SEQUENCE',
      ],
      [
        'a number that is taken',
        `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES (${id(live)}, 1)`,
        'VERSION_NUMBER_SEQUENCE',
      ],
      [
        'a version born ACTIVE',
        `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, published_at) VALUES (${id(live)}, 2, 'ACTIVE', now())`,
        'MUST_START_AS_DRAFT',
      ],
      [
        'a version for a RETIRED template',
        `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES (${id(retired)}, 1)`,
        'GIG_TEMPLATE_RETIRED',
      ],
      ['retiring with an open DRAFT', `UPDATE catalog.gig_templates SET status = 'RETIRED' WHERE code = '${withDraft}'`, 'GIG_TEMPLATE_HAS_OPEN_DRAFT'],
      [
        'a template born ACTIVE',
        `INSERT INTO catalog.gig_templates (service_type_id, code, status) SELECT service_type_id, 'devtest_born_active', 'ACTIVE' FROM catalog.service_types WHERE code = '${st}'`,
        'MUST_START_AS_DRAFT',
      ],
      ['a new code', `UPDATE catalog.gig_templates SET code = 'devtest_renamed' WHERE code = '${live}'`, 'IMMUTABLE'],
      [
        'another service type',
        `UPDATE catalog.gig_templates SET service_type_id = (SELECT service_type_id FROM catalog.service_types WHERE code <> '${st}' LIMIT 1) WHERE code = '${live}'`,
        'IMMUTABLE',
      ],
      ['deleting a template', `DELETE FROM catalog.gig_templates WHERE code = '${live}'`, 'IMMUTABLE'],
      ['a RETIRED template back to ACTIVE', `UPDATE catalog.gig_templates SET status = 'ACTIVE' WHERE code = '${retired}'`, 'STATUS_TRANSITION'],
      [
        'a field with a foreign label key',
        `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key)
         VALUES (${ver(draftOnly.code, 1)}, 'stray_one', 'BOOLEAN', 'PROVIDER_CONFIGURABLE', 50, '${stem(live)}.field.scope_notes.label')`,
        'CONTENT_KEY_MISMATCH',
      ],
      [
        'an option on a field that is not an ENUM',
        `INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order)
         SELECT gig_template_field_id, 'bad_opt', '${stem(draftOnly.code)}.field.vehicles.option.bad_opt.label', 1 FROM catalog.gig_template_fields WHERE gig_template_version_id = ${ver(draftOnly.code, 1)} AND field_key = 'vehicles'`,
        'OPTIONS_ONLY_FOR_ENUM',
      ],
      [
        'an option with a foreign label key',
        `INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order)
         SELECT gig_template_field_id, 'bad_opt', '${stem(live)}.field.finish.option.wax.label', 9 FROM catalog.gig_template_fields WHERE gig_template_version_id = ${ver(draftOnly.code, 1)} AND field_key = 'finish'`,
        'CONTENT_KEY_MISMATCH',
      ],
      [
        'enabling a RETIRED template in a market',
        `INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order) SELECT market_id, ${id(retired)}, true, 9000 FROM geography.markets WHERE code = '${env.market}'`,
        'ITEM_RETIRED',
      ],
      ['truncating the versions', 'TRUNCATE catalog.gig_template_versions CASCADE', 'IMMUTABLE'],
      ['truncating the audit trail', 'TRUNCATE catalog.audit_events', 'IMMUTABLE'],
    ];
    for (const [label, text, reason] of cases) {
      const e = await rawRefused(text);
      if (reason === 'DRAFT_EXISTS') expect([e.code, e.details.reason], label).toEqual(['CONFLICT', 'DRAFT_EXISTS']);
      else expect([e.code, e.details.reason], label).toEqual(['INVALID_STATE', reason]);
    }
  });
});

// ====================================================================== 6. market availability
describe('market availability', () => {
  it('a new row needs displayOrder (VALIDATION_FAILED DISPLAY_ORDER_REQUIRED) and leaves nothing behind; an existing row keeps its order when none is given', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    const world = await worldHash();
    const e = await expectError(tplAvail(env.market, c, true), 'VALIDATION_FAILED', 'DISPLAY_ORDER_REQUIRED');
    expect(e.details.field).toBe('displayOrder');
    await expectError(tplAvail(env.market, c, false), 'VALIDATION_FAILED', 'DISPLAY_ORDER_REQUIRED');
    expect(await worldHash()).toBe(world);
    await tplAvail(env.market, c, true, 40);
    expect((await tplAvail(env.market, c, false)).displayOrder).toBe(40);
    expect((await tplAvail(env.market, c, true)).displayOrder).toBe(40);
    expect(await mgtRow(env.market, c)).toEqual([{ enabled: true, display_order: 40 }]);
  });

  it('the result has exactly its documented key set', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    const r = await tplAvail(env.market, c, true, 10);
    expect(r).toEqual({ marketCode: env.market, code: c, enabled: true, displayOrder: 10 });
    expect(keys(r)).toEqual(['code', 'displayOrder', 'enabled', 'marketCode']);
  });

  it('first insert and later changes are audited as exact enabled/displayOrder diffs with the market and the template, and announced with an identifier-only event', async () => {
    const env = await mkEnv();
    const marketId = (await one<{ market_id: string }>('SELECT market_id FROM geography.markets WHERE code = $1', [env.market])).market_id;
    const c = await mkTemplate(env.st);
    const corr = `corr-av-${seq}`;
    expect(await runWithCorrelation(corr, () => tplAvail(env.market, c, true, 10))).toEqual({
      marketCode: env.market,
      code: c,
      enabled: true,
      displayOrder: 10,
    });
    await tplAvail(env.market, c, true, 15); // order only
    await tplAvail(env.market, c, false); // enabled only
    const trail = (await tplAudit(c)).filter((a) => a.action === 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED');
    expect(trail.map((a) => [a.actor, a.reason, a.changes, a.market_code, a.version_number])).toEqual([
      [ACTOR, REASON, { enabled: [null, true], displayOrder: [null, 10] }, env.market, null],
      [ACTOR, REASON, { enabled: [true, true], displayOrder: [10, 15] }, env.market, null],
      [ACTOR, REASON, { enabled: [true, false], displayOrder: [15, 15] }, env.market, null],
    ]);
    expect(trail[0]!.correlation_id).toBe(corr);
    const evs = await tplEvents(c, GIG_TEMPLATE_EVENTS.availabilityChanged);
    expect(evs).toHaveLength(3);
    for (const ev of evs) {
      expect(ev).toMatchObject({
        event_version: 1,
        aggregate_type: 'catalog_market_availability',
        aggregate_id: marketId,
        actor_type: 'user',
        actor_id: ACTOR,
        causation_id: null,
        published_at: null,
      });
      expect(keys(ev.payload_json)).toEqual(['enabled', 'gigTemplateCode', 'marketCode']);
    }
    expect(evs.map((e) => e.payload_json)).toEqual([
      { marketCode: env.market, gigTemplateCode: c, enabled: true },
      { marketCode: env.market, gigTemplateCode: c, enabled: true },
      { marketCode: env.market, gigTemplateCode: c, enabled: false },
    ]);
    expect(evs[0]!.correlation_id).toBe(corr);
  });

  it('the same availability again (with or without the order) writes nothing: no audit row, no event, no updated_at move, no bump', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    await tplAvail(env.market, c, true, 10);
    await tplAvail(env.market, c, false, 20);
    const t0 = await one<Row>('SELECT x.updated_at FROM catalog.market_gig_templates x JOIN geography.markets m USING (market_id) WHERE m.code = $1', [
      env.market,
    ]);
    await sleep(5);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    for (const [enabled, order] of [
      [false, 20],
      [false, undefined],
    ] as const)
      expect(await tplAvail(env.market, c, enabled, order)).toEqual({ marketCode: env.market, code: c, enabled: false, displayOrder: 20 });
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
    expect(
      (await one<Row>('SELECT x.updated_at FROM catalog.market_gig_templates x JOIN geography.markets m USING (market_id) WHERE m.code = $1', [env.market]))
        .updated_at,
    ).toEqual(t0.updated_at);
    expect((await tplAudit(c)).filter((a) => a.action === 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED')).toHaveLength(2);
  });

  it('a duplicate display order in the same market is CONFLICT DISPLAY_ORDER_TAKEN (also for a disabled row and on update), nothing is written, another market may reuse the number', async () => {
    const env = await mkEnv();
    const m2 = await mkMarket(true);
    const a = await mkTemplate(env.st);
    const b = await mkTemplate(env.st);
    const d = await mkTemplate(env.st);
    await tplAvail(env.market, a, true, 10);
    await tplAvail(env.market, d, false, 20); // a disabled row still owns its position
    const world = await worldHash();
    for (const order of [10, 20]) {
      const e = await expectError(tplAvail(env.market, b, true, order), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
      expect(e.details.retryable).toBeUndefined();
      await expectError(tplAvail(env.market, b, false, order), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
    }
    expect(await worldHash()).toBe(world);
    await tplAvail(m2, b, true, 10);
    await tplAvail(env.market, b, true, 30);
    await expectError(tplAvail(env.market, b, true, 10), 'CONFLICT', 'DISPLAY_ORDER_TAKEN'); // an existing row cannot take a number that is taken either
    expect((await mgtRow(env.market, b))[0]!.display_order).toBe(30);
    const edge = await mkTemplate(env.st);
    await tplAvail(env.market, edge, false, 1);
    const edge2 = await mkTemplate(env.st);
    await tplAvail(env.market, edge2, false, 9999);
    for (const bad of [0, 10000]) await expectError(tplAvail(env.market, await mkTemplate(env.st), false, bad), 'VALIDATION_FAILED', 'INVALID_FIELD');
  });

  it('swapping two orders directly is refused (the unique key is not deferrable), the three-step swap through a free number works and is audited step by step', async () => {
    const env = await mkEnv();
    const a = await mkTemplate(env.st);
    const b = await mkTemplate(env.st);
    await tplAvail(env.market, a, true, 10);
    await tplAvail(env.market, b, true, 20);
    await expectError(tplAvail(env.market, a, true, 20), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
    await tplAvail(env.market, a, true, 99);
    await tplAvail(env.market, b, true, 10);
    await tplAvail(env.market, a, true, 20);
    expect((await mgtRow(env.market, a))[0]!.display_order).toBe(20);
    expect((await mgtRow(env.market, b))[0]!.display_order).toBe(10);
    expect((await tplAudit(a)).filter((x) => x.market_code).map((x) => (x.changes as { displayOrder: unknown }).displayOrder)).toEqual([
      [null, 10],
      [10, 99],
      [99, 20],
    ]);
  });

  it('a market of ANY status can be prepared (PLANNED, the seeded la-oc, not public), and the template need not be ACTIVE: DRAFT and INACTIVE templates can be prepared, and stay invisible', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const dto = await tplAvail('la-oc', c, true, 5000 + seq);
    expect(dto.marketCode).toBe('la-oc');
    expect((await bare.getGigTemplate(c, { marketCode: 'la-oc' })).enabled).toBe(true);
    await expectError(bare.getMarketGigTemplates('la-oc'), 'MARKET_NOT_FOUND');
    const env = await mkEnv();
    const draft = await mkTemplate(env.st);
    const paused = await mkPublished(env.st);
    await setTpl(paused, 'INACTIVE');
    await tplAvail(env.market, draft, true, 'auto');
    await tplAvail(env.market, paused, true, 'auto');
    expect((await bare.listGigTemplatesForMarket(env.market)).templates).toEqual([]);
    await setTpl(draft, 'ACTIVE'); // still without a version
    await setTpl(paused, 'ACTIVE');
    expect((await bare.listGigTemplatesForMarket(env.market)).templates.map((t) => t.code)).toEqual([paused]);
  });

  it('a RETIRED template can never be enabled (ITEM_RETIRED) - not inserted enabled, not switched on - but a row can be prepared disabled and an enabled one switched off', async () => {
    const env = await mkEnv();
    const a = await mkTemplate(env.st);
    const b = await mkTemplate(env.st);
    const c = await mkTemplate(env.st);
    await tplAvail(env.market, a, true, 'auto');
    await tplAvail(env.market, b, false, 'auto');
    for (const t of [a, b, c]) await setTpl(t, 'RETIRED');
    const d = await retiredTemplate(env.st);
    expect((await tplAvail(env.market, a, false)).enabled).toBe(false);
    expect((await tplAvail(env.market, c, false, 'auto')).enabled).toBe(false); // prepared disabled
    const world = await worldHash();
    await expectError(tplAvail(env.market, a, true), 'INVALID_STATE', 'ITEM_RETIRED');
    await expectError(tplAvail(env.market, b, true), 'INVALID_STATE', 'ITEM_RETIRED');
    await expectError(tplAvail(env.market, d, true, 'auto'), 'INVALID_STATE', 'ITEM_RETIRED');
    expect(await worldHash()).toBe(world);
    expect((await mgtRow(env.market, a))[0]!.enabled).toBe(false);
  });

  it('unknown market, malformed market and unknown template are typed errors, the market is checked first, and nothing is written', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    const world = await worldHash();
    await expectError(tplAvail('devtest-missing', c, true, 10), 'MARKET_NOT_FOUND');
    await expectError(tplAvail('DEVTEST-M1', c, true, 10), 'MARKET_NOT_FOUND');
    await expectError(tplAvail('', c, true, 10), 'MARKET_NOT_FOUND');
    await expectError(tplAvail('devtest-missing', 'devtest_nothing', true, 10), 'MARKET_NOT_FOUND');
    await expectError(tplAvail(env.market, 'devtest_nothing', true, 10), 'GIG_TEMPLATE_NOT_FOUND');
    await expectError(tplAvail(env.market, env.st, true, 10), 'GIG_TEMPLATE_NOT_FOUND'); // a service type code is not a template
    expect(await worldHash()).toBe(world);
  });

  it('availability needs no version and no service type chain: a template can be enabled in a market whose category is not enabled; it simply is not public', async () => {
    const market = await mkMarket(true);
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await tplAvail(market, c, true, 10);
    expect((await bare.listGigTemplatesForMarket(market)).templates).toEqual([]);
  });
});

async function retiredTemplate(st: string): Promise<string> {
  const c = await mkTemplate(st);
  await setTpl(c, 'RETIRED');
  return c;
}

// ====================================================================== 7. public visibility
interface Ctx {
  env: Env;
  c: string;
}
const listed = async (x: Ctx): Promise<boolean> => (await bare.listGigTemplatesForMarket(x.env.market)).templates.some((t) => t.code === x.c);
const single = async (x: Ctx): Promise<boolean> => {
  const e = await err(bare.getGigTemplateForMarket(x.env.market, x.c));
  if (e) expect(e.code).toBe('GIG_TEMPLATE_NOT_FOUND');
  return !e;
};

describe('public visibility', () => {
  it('a market that is not public is MARKET_NOT_FOUND for EVERY public read, whatever it holds, and the same error for unknown, planned and malformed markets', async () => {
    const planned = await mkMarket(false);
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await tplAvail(planned, c, true, 10);
    const reads: [string, (m: string) => Promise<unknown>][] = [
      ['getMarketGigTemplates', (m) => bare.getMarketGigTemplates(m)],
      ['listGigTemplatesForMarket', (m) => bare.listGigTemplatesForMarket(m)],
      ['listGigTemplatesForMarket by service type', (m) => bare.listGigTemplatesForMarket(m, { serviceTypeCode: st })],
      ['getGigTemplateForMarket', (m) => bare.getGigTemplateForMarket(m, c)],
    ];
    const world = await worldHash();
    for (const m of [planned, 'la-oc', 'devtest-nowhere', 'LA-OC', '', "x'; DROP TABLE catalog.gig_templates;--"]) {
      for (const [name, read] of reads) {
        const e = await expectError(read(m), 'MARKET_NOT_FOUND');
        expect(e.message, name).toBe('the market is not available');
        expect(JSON.stringify(e.details)).not.toMatch(/PLANNED|status/);
      }
    }
    expect(await worldHash()).toBe(world);
    gateState.markets.set(planned, { code: planned, defaultLocale: 'en-US' });
    expect((await bare.getMarketGigTemplates(planned)).templates).toEqual([]); // the chain above the template is not enabled there
    gateState.markets.delete(planned);
  });

  it('exposes a template iff: market public, service type ACTIVE and enabled under an ACTIVE enabled category, template ACTIVE and enabled, an ACTIVE version: every conjunct on its own (crafted states included)', async () => {
    const fresh = async (): Promise<Ctx> => {
      const env = await mkEnv();
      const c = await mkPublic(env);
      return { env, c };
    };
    const tplId = (x: Ctx) => `(SELECT gig_template_id FROM catalog.gig_templates WHERE code = '${x.c}')`;
    const crafted = (tables: string[], apply: (x: Ctx) => string, restore: (x: Ctx) => string) => async (x: Ctx, during: () => Promise<void>) => {
      await withoutTriggers(tables, async () => {
        await q(apply(x));
        try {
          await during();
        } finally {
          await q(restore(x));
        }
      });
    };
    const deleted = (table: string, where: (x: Ctx) => string, cols: string) => async (x: Ctx, during: () => Promise<void>) => {
      await withoutTriggers([table], async () => {
        const saved = await one<Row>(`SELECT * FROM ${table} WHERE ${where(x)}`);
        await q(`DELETE FROM ${table} WHERE ${where(x)}`);
        try {
          await during();
        } finally {
          await q(
            `INSERT INTO ${table} (${cols}) VALUES (${cols
              .split(',')
              .map((_, i) => `$${i + 1}`)
              .join(', ')})`,
            cols.split(',').map((k) => saved[k.trim()]),
          );
        }
      });
    };
    const flips: [string, (x: Ctx, during: () => Promise<void>) => Promise<void>][] = [
      [
        'the template is paused',
        async (x, during) => {
          await setTpl(x.c, 'INACTIVE');
          try {
            await during();
          } finally {
            await setTpl(x.c, 'ACTIVE');
          }
        },
      ],
      [
        'the template is RETIRED although its version is still ACTIVE (crafted)',
        crafted(
          ['catalog.gig_templates'],
          (x) => `UPDATE catalog.gig_templates SET status = 'RETIRED' WHERE code = '${x.c}'`,
          (x) => `UPDATE catalog.gig_templates SET status = 'ACTIVE' WHERE code = '${x.c}'`,
        ),
      ],
      [
        'the template is a DRAFT although its version is ACTIVE (crafted)',
        crafted(
          ['catalog.gig_templates'],
          (x) => `UPDATE catalog.gig_templates SET status = 'DRAFT' WHERE code = '${x.c}'`,
          (x) => `UPDATE catalog.gig_templates SET status = 'ACTIVE' WHERE code = '${x.c}'`,
        ),
      ],
      [
        'the version is not ACTIVE (crafted: RETIRED under an ACTIVE template)',
        crafted(
          ['catalog.gig_template_versions'],
          (x) => `UPDATE catalog.gig_template_versions SET status = 'RETIRED', closed_at = now() WHERE gig_template_id = ${tplId(x)}`,
          (x) => `UPDATE catalog.gig_template_versions SET status = 'ACTIVE', closed_at = NULL WHERE gig_template_id = ${tplId(x)}`,
        ),
      ],
      [
        'the service type is paused',
        async (x, during) => {
          await setSt(x.env.st, 'INACTIVE');
          try {
            await during();
          } finally {
            await setSt(x.env.st, 'ACTIVE');
          }
        },
      ],
      [
        'the service type is a DRAFT (crafted)',
        crafted(
          ['catalog.service_types'],
          (x) => `UPDATE catalog.service_types SET status = 'DRAFT' WHERE code = '${x.env.st}'`,
          (x) => `UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = '${x.env.st}'`,
        ),
      ],
      [
        'the service type is RETIRED (crafted)',
        crafted(
          ['catalog.service_types'],
          (x) => `UPDATE catalog.service_types SET status = 'RETIRED' WHERE code = '${x.env.st}'`,
          (x) => `UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = '${x.env.st}'`,
        ),
      ],
      [
        'the category is paused (crafted)',
        crafted(
          ['catalog.categories'],
          (x) => `UPDATE catalog.categories SET status = 'INACTIVE' WHERE code = '${x.env.category}'`,
          (x) => `UPDATE catalog.categories SET status = 'ACTIVE' WHERE code = '${x.env.category}'`,
        ),
      ],
      [
        'the category is RETIRED (crafted)',
        crafted(
          ['catalog.categories'],
          (x) => `UPDATE catalog.categories SET status = 'RETIRED' WHERE code = '${x.env.category}'`,
          (x) => `UPDATE catalog.categories SET status = 'ACTIVE' WHERE code = '${x.env.category}'`,
        ),
      ],
      [
        'the service type is switched off in the market',
        async (x, during) => {
          await stAvail(x.env.market, x.env.st, false);
          try {
            await during();
          } finally {
            await stAvail(x.env.market, x.env.st, true);
          }
        },
      ],
      [
        'the service type has no row in the market (crafted)',
        deleted(
          'catalog.market_service_types',
          (x) => `service_type_id = (SELECT service_type_id FROM catalog.service_types WHERE code = '${x.env.st}')`,
          'market_id, service_type_id, enabled, display_order',
        ),
      ],
      [
        'the category is switched off in the market, its service type still on (crafted)',
        crafted(
          ['catalog.market_categories'],
          (x) =>
            `UPDATE catalog.market_categories SET enabled = false WHERE category_id = (SELECT category_id FROM catalog.categories WHERE code = '${x.env.category}')`,
          (x) =>
            `UPDATE catalog.market_categories SET enabled = true WHERE category_id = (SELECT category_id FROM catalog.categories WHERE code = '${x.env.category}')`,
        ),
      ],
      [
        'the category has no row in the market (crafted)',
        deleted(
          'catalog.market_categories',
          (x) => `category_id = (SELECT category_id FROM catalog.categories WHERE code = '${x.env.category}')`,
          'market_id, category_id, enabled, display_order',
        ),
      ],
      [
        'the template is switched off in the market',
        async (x, during) => {
          await tplAvail(x.env.market, x.c, false);
          try {
            await during();
          } finally {
            await tplAvail(x.env.market, x.c, true);
          }
        },
      ],
      [
        'the template has no row in the market (crafted)',
        deleted('catalog.market_gig_templates', (x) => `gig_template_id = ${tplId(x)}`, 'market_id, gig_template_id, enabled, display_order'),
      ],
    ];
    expect(flips.length).toBe(15);
    for (const [name, flip] of flips) {
      const x = await fresh();
      expect(await listed(x), `${name}: visible before`).toBe(true);
      expect(await single(x)).toBe(true);
      let seen = 0;
      await flip(x, async () => {
        seen++;
        expect(await listed(x), `${name}: hidden during`).toBe(false);
        expect(await single(x), `${name}: single read hidden during`).toBe(false);
        expect((await bare.getMarketGigTemplates(x.env.market)).templates).toEqual([]);
      });
      expect(seen).toBe(1);
      expect(await listed(x), `${name}: visible after`).toBe(true);
      expect(await single(x)).toBe(true);
    }
  }, 120_000);

  it('a template with no ACTIVE version (none yet, only a DRAFT, only a discarded draft) is not public; the first publication makes it public', async () => {
    const env = await mkEnv();
    const none = await mkTemplate(env.st, { activate: true });
    const draftOnly = await mkTemplate(env.st, { activate: true });
    await createDraft(draftOnly);
    const discarded = await mkTemplate(env.st, { activate: true });
    await createDraft(discarded);
    await discard(discarded, 1);
    for (const c of [none, draftOnly, discarded]) await tplAvail(env.market, c, true, 'auto');
    expect((await bare.listGigTemplatesForMarket(env.market)).templates).toEqual([]);
    for (const c of [none, draftOnly, discarded]) await expectError(bare.getGigTemplateForMarket(env.market, c), 'GIG_TEMPLATE_NOT_FOUND');
    await copyFor(draftOnly);
    const rev = (await replaceDraft(draftOnly, 1, def(1))).revision!;
    await publish(draftOnly, 1, rev);
    expect((await bare.listGigTemplatesForMarket(env.market)).templates.map((t) => t.code)).toEqual([draftOnly]);
  });

  it('the full truth table over the reachable states: template ACTIVE/paused x availability row absent/off/on x published version or draft only, in the order of the market', async () => {
    const env = await mkEnv();
    interface Model {
      code: string;
      ts: 'ACTIVE' | 'INACTIVE';
      row: 'absent' | 'false' | 'true';
      ver: boolean;
      order: number | null;
    }
    const model: Model[] = [];
    let i = 0;
    for (const ver of [true, false])
      for (const ts of ['ACTIVE', 'INACTIVE'] as const)
        for (const row of ['absent', 'false', 'true'] as const) {
          const c = ver ? await mkPublished(env.st) : await mkTemplate(env.st, { activate: true });
          if (!ver) await createDraft(c);
          if (ts === 'INACTIVE') await setTpl(c, 'INACTIVE');
          const order = row === 'absent' ? null : 500 - 10 * i++; // the order of the market is not the order of creation, nor of the code
          if (order !== null) await tplAvail(env.market, c, row === 'true', order);
          model.push({ code: c, ts, row, ver, order });
        }
    expect(model).toHaveLength(12);
    const visible = model.filter((m) => m.ts === 'ACTIVE' && m.row === 'true' && m.ver).sort((a, b) => a.order! - b.order!);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(model.length);
    const list = (await bare.listGigTemplatesForMarket(env.market)).templates;
    expect(list.map((t) => [t.code, t.displayOrder])).toEqual(visible.map((m) => [m.code, m.order]));
    for (const m of model) expect(await single({ env, c: m.code }), `${m.ts}/${m.row}/${m.ver}`).toBe(visible.includes(m));
    // the management view of the same market shows every one of them with the truth
    const mgmt = await bare.listGigTemplates({ marketCode: env.market, serviceTypeCode: env.st });
    expect(mgmt).toHaveLength(12);
    for (const m of model) {
      const v = mgmt.find((t) => t.code === m.code)!;
      expect([v.status, v.enabled, v.displayOrder, v.activeVersion !== null]).toEqual([m.ts, m.row === 'true', m.order, m.ver]);
    }
    expect(mgmt.map((t) => t.displayOrder)).toEqual([
      ...model
        .map((m) => m.order)
        .filter((o) => o !== null)
        .sort((a, b) => a! - b!),
      null,
      null,
      null,
      null,
    ]);
  }, 60_000);

  it('order follows the MARKET: the same templates sit at different positions in two markets; a template enabled in one market is not public in the other', async () => {
    const env = await mkEnv();
    const m2 = await mkMarket(true);
    await catAvail(m2, env.category, true, 10);
    await stAvail(m2, env.st, true, 10);
    const a = await mkPublished(env.st);
    const b = await mkPublished(env.st);
    const c = await mkPublished(env.st);
    const onlyHere = await mkPublished(env.st);
    for (const [x, o] of [
      [a, 20],
      [b, 30],
      [c, 10],
      [onlyHere, 40],
    ] as const)
      await tplAvail(env.market, x, true, o);
    for (const [x, o] of [
      [a, 30],
      [b, 10],
      [c, 20],
    ] as const)
      await tplAvail(m2, x, true, o);
    expect((await bare.listGigTemplatesForMarket(env.market)).templates.map((t) => [t.code, t.displayOrder])).toEqual([
      [c, 10],
      [a, 20],
      [b, 30],
      [onlyHere, 40],
    ]);
    expect((await bare.listGigTemplatesForMarket(m2)).templates.map((t) => [t.code, t.displayOrder])).toEqual([
      [b, 10],
      [c, 20],
      [a, 30],
    ]);
    expect((await bare.getGigTemplateForMarket(env.market, a)).template.displayOrder).toBe(20);
    expect((await bare.getGigTemplateForMarket(m2, a)).template.displayOrder).toBe(30);
    await expectError(bare.getGigTemplateForMarket(m2, onlyHere), 'GIG_TEMPLATE_NOT_FOUND');
    await tplAvail(env.market, a, true, 5);
    expect((await bare.listGigTemplatesForMarket(env.market)).templates.map((t) => t.code)).toEqual([a, c, b, onlyHere]);
    expect((await bare.listGigTemplatesForMarket(m2)).templates.map((t) => t.code)).toEqual([b, c, a]);
  });

  it('a service type filter lists only that service type in the market order; an unknown, malformed or hidden service type lists nothing (no error, no leak)', async () => {
    const env = await mkEnv();
    const st2 = await mkServiceType(env.category);
    await stAvail(env.market, st2, true, nextOrder(env.market, 's'));
    await setSt(st2, 'ACTIVE');
    const hiddenSt = await mkServiceType(env.category); // not enabled in the market
    await setSt(hiddenSt, 'ACTIVE');
    const a = await mkPublished(env.st);
    const b = await mkPublished(st2);
    const a2 = await mkPublished(env.st);
    const h = await mkPublished(hiddenSt);
    for (const x of [a, b, a2, h]) await tplAvail(env.market, x, true, 'auto');
    expect((await bare.listGigTemplatesForMarket(env.market)).templates.map((t) => t.code)).toEqual([a, b, a2]);
    expect((await bare.listGigTemplatesForMarket(env.market, { serviceTypeCode: env.st })).templates.map((t) => t.code)).toEqual([a, a2]);
    expect((await bare.listGigTemplatesForMarket(env.market, { serviceTypeCode: st2 })).templates.map((t) => t.code)).toEqual([b]);
    for (const s of [hiddenSt, 'devtest_nothing', 'Bad Code', env.category])
      expect((await bare.listGigTemplatesForMarket(env.market, { serviceTypeCode: s })).templates).toEqual([]);
  });

  it('the not-found answers for a hidden template do not reveal why (same message and the same details shape for paused, off, no version, no row, retired, unknown)', async () => {
    const env = await mkEnv();
    const paused = await mkPublic(env);
    await setTpl(paused, 'INACTIVE');
    const off = await mkPublic(env);
    await tplAvail(env.market, off, false);
    const noVersion = await mkTemplate(env.st, { activate: true });
    await tplAvail(env.market, noVersion, true, 'auto');
    const noRow = await mkPublished(env.st);
    const retired = await mkPublic(env);
    await setTpl(retired, 'RETIRED');
    const errors: CatalogError[] = [];
    for (const x of [paused, off, noVersion, noRow, retired, 'devtest_unknown'])
      errors.push(await expectError(bare.getGigTemplateForMarket(env.market, x), 'GIG_TEMPLATE_NOT_FOUND'));
    expect(new Set(errors.map((e) => e.message)).size).toBe(1);
    expect(new Set(errors.map((e) => JSON.stringify(Object.keys(e.details)))).size).toBe(1);
  });

  it('every public view has exactly the public key set, the content KEYS and no management or provider data; the structure is complete and in order', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env, { description: true, instructions: true });
    const { market, template: t } = await bare.getGigTemplateForMarket(env.market, c);
    expect(market).toEqual({ code: env.market, defaultLocale: 'en-US' });
    expect(keys(t)).toEqual([
      'activeVersion',
      'categoryCode',
      'code',
      'descriptionContentKey',
      'displayOrder',
      'gigTemplateId',
      'instructionsContentKey',
      'nameContentKey',
      'serviceTypeCode',
    ]);
    expect(t).toMatchObject({
      code: c,
      serviceTypeCode: env.st,
      categoryCode: env.category,
      nameContentKey: nameKey(c),
      descriptionContentKey: descKey(c),
      instructionsContentKey: instrKey(c),
    });
    const v = t.activeVersion!;
    expect(keys(v)).toEqual(['areaModes', 'duration', 'fieldCount', 'fields', 'gigTemplateVersionId', 'pricingModels', 'requirements', 'versionNumber']);
    expect(v).toMatchObject({
      versionNumber: 1,
      fieldCount: 6,
      duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
      pricingModels: ['FIXED', 'BUNDLE_ELIGIBLE'],
      areaModes: ['RADIUS', 'POSTAL_CODES'],
    });
    expect(v.requirements).toEqual([
      { requirementType: 'LICENSE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'wax_application' },
    ]);
    expect(v.fields.map((f) => f.fieldKey)).toEqual(stdFields().map((f) => f.fieldKey));
    for (const f of v.fields)
      expect(keys(f)).toEqual([
        'behavior',
        'customerVisible',
        'defaultBoolean',
        'defaultContentKey',
        'defaultNumber',
        'displayOrder',
        'fieldKey',
        'fieldType',
        'helpContentKey',
        'labelContentKey',
        'maxItems',
        'maxLength',
        'maxNumber',
        'minItems',
        'minLength',
        'minNumber',
        'options',
        'section',
      ]);
    const finish = v.fields.find((f) => f.fieldKey === 'finish')!;
    expect(finish.options).toEqual([
      { optionCode: 'wax', labelContentKey: `${stem(c)}.field.finish.option.wax.label`, isDefault: true, displayOrder: 1 },
      { optionCode: 'sealant', labelContentKey: `${stem(c)}.field.finish.option.sealant.label`, isDefault: false, displayOrder: 2 },
      { optionCode: 'ceramic', labelContentKey: `${stem(c)}.field.finish.option.ceramic.label`, isDefault: false, displayOrder: 3 },
    ]);
    expect(v.fields.find((f) => f.fieldKey === 'is_mobile')).toMatchObject({ defaultBoolean: false, behavior: 'PLATFORM_FIXED' });
    expect(v.fields.find((f) => f.fieldKey === 'intro')).toMatchObject({ customerVisible: false, defaultContentKey: `${stem(c)}.field.intro.default` });
    expect(v.fields.find((f) => f.fieldKey === 'photos')).toMatchObject({ minItems: 0, maxItems: 8 });
    // nothing a provider owns, no text, no management data
    const text = JSON.stringify(t);
    expect(text).not.toMatch(
      /"(price|floorPrice|radius|capacity|providerId|status|revision|enabled|publishedAt|closedAt|createdAt|updatedAt|versions|name|label|help)"/,
    );
    expect(text).not.toContain(COPY_BODY);
    expect(keys(await bare.getMarketGigTemplates(env.market))).toEqual(['market', 'source', 'templates']);
    expect(keys(await bare.getGigTemplateForMarket(env.market, c))).toEqual(['market', 'template']);
    expect(keys(await bare.listGigTemplatesForMarket(env.market))).toEqual(['market', 'templates']);
  });

  it('requirements are listed by type then reference (none first) whatever the order they were written in', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st, { activate: true });
    await copyFor(c);
    await createDraft(c);
    const reqs = [
      { requirementType: 'SKILL', referenceCode: 'wax_application' },
      { requirementType: 'LICENSE' },
      { requirementType: 'SKILL' },
      { requirementType: 'BACKGROUND_CHECK' },
      { requirementType: 'INSURANCE', referenceCode: 'liability_cover' },
      { requirementType: 'SKILL', referenceCode: 'buffing' },
      { requirementType: 'EQUIPMENT' },
    ];
    const rev = (await replaceDraft(c, 1, def(1, { requirements: reqs }))).revision!;
    await publish(c, 1, rev);
    await tplAvail(env.market, c, true, 'auto');
    const expected = [
      ['BACKGROUND_CHECK', null],
      ['EQUIPMENT', null],
      ['INSURANCE', 'liability_cover'],
      ['LICENSE', null],
      ['SKILL', null],
      ['SKILL', 'buffing'],
      ['SKILL', 'wax_application'],
    ];
    const toPairs = (r: { requirementType: string; referenceCode: string | null }[]) => r.map((x) => [x.requirementType, x.referenceCode]);
    expect(toPairs((await bare.getGigTemplateForMarket(env.market, c)).template.activeVersion!.requirements)).toEqual(expected);
    expect(toPairs((await bare.getGigTemplateVersion(c, 1)).requirements)).toEqual(expected);
  });
});

// ====================================================================== 8. management reads
describe('management reads', () => {
  it('every status is listed (ordered by code, in byte order) with the full management key set; the list carries the ACTIVE version but not the version history', async () => {
    const { st, category } = await mkServiceTypeActive();
    const n = ++seq;
    const draft = await mkTemplate(st, { code: `devtest_k_a${n}`, description: true });
    const live = await mkPublished(st, { code: `devtest_ka${n}` }); // '_' sorts before 'a' in byte order, not in an en_US collation
    const paused = await mkPublished(st, { code: `devtest_kb${n}` });
    await setTpl(paused, 'INACTIVE');
    const retired = await mkPublished(st, { code: `devtest_kc${n}` });
    await setTpl(retired, 'RETIRED');
    const list = await bare.listGigTemplates({ serviceTypeCode: st });
    expect(list.map((t) => [t.code, t.status])).toEqual([
      [draft, 'DRAFT'],
      [live, 'ACTIVE'],
      [paused, 'INACTIVE'],
      [retired, 'RETIRED'],
    ]);
    const v = list[0]!;
    expect(keys(v)).toEqual([
      'activeVersion',
      'categoryCode',
      'code',
      'createdAt',
      'descriptionContentKey',
      'displayOrder',
      'gigTemplateId',
      'instructionsContentKey',
      'nameContentKey',
      'serviceTypeCode',
      'status',
      'updatedAt',
    ]);
    expect(v).toMatchObject({
      categoryCode: category,
      serviceTypeCode: st,
      descriptionContentKey: descKey(draft),
      instructionsContentKey: null,
      displayOrder: null,
      activeVersion: null,
    });
    expect(new Date(v.createdAt!).toISOString()).toBe(v.createdAt);
    expect(list[1]!.activeVersion).toMatchObject({ versionNumber: 1, status: 'ACTIVE', revision: 2, fieldCount: 6 });
    expect(list[1]!.activeVersion!.fields).toHaveLength(6);
    expect(list[2]!.activeVersion!.status).toBe('ACTIVE'); // paused: the version is still ACTIVE
    expect(list[3]!.activeVersion).toBeNull(); // retired: closed
    expect(list.every((t) => !('versions' in t) && !('enabled' in t))).toBe(true);
    // the global list across service types holds them all, and a filter for another service type none of them
    const all = (await bare.listGigTemplates()).map((t) => t.code);
    for (const c of [draft, live, paused, retired]) expect(all).toContain(c);
    expect(all).toEqual([...all].sort());
    expect(await bare.listGigTemplates({ serviceTypeCode: 'devtest_nothing' })).toEqual([]);
    expect(await bare.listGigTemplates({ serviceTypeCode: category })).toEqual([]);
  });

  it('with a market: availability and order of every template of the service type, any market status; a template without a row is enabled:false with no order and comes last (by code)', async () => {
    const market = await mkMarket(false); // not public
    const { st } = await mkServiceTypeActive();
    const a = await mkTemplate(st);
    const b = await mkTemplate(st);
    const c = await mkTemplate(st);
    const d = await mkTemplate(st);
    await tplAvail(market, a, true, 900);
    await tplAvail(market, b, false, 800);
    await tplAvail(market, c, true, 700);
    const list = await bare.listGigTemplates({ marketCode: market, serviceTypeCode: st });
    expect(list.map((t) => [t.code, t.enabled, t.displayOrder])).toEqual([
      [c, true, 700],
      [b, false, 800],
      [a, true, 900],
      [d, false, null],
    ]);
    expect(keys(list[0]!)).toEqual([
      'activeVersion',
      'categoryCode',
      'code',
      'createdAt',
      'descriptionContentKey',
      'displayOrder',
      'enabled',
      'gigTemplateId',
      'instructionsContentKey',
      'nameContentKey',
      'serviceTypeCode',
      'status',
      'updatedAt',
    ]);
    expect(await bare.getGigTemplate(b, { marketCode: market })).toMatchObject({ enabled: false, displayOrder: 800 });
    expect(await bare.getGigTemplate(d, { marketCode: market })).toMatchObject({ enabled: false, displayOrder: null });
    expect(await bare.getGigTemplate(a)).not.toHaveProperty('enabled');
    await expectError(bare.getMarketGigTemplates(market), 'MARKET_NOT_FOUND'); // the same market is not public
  });

  it('the detail read lists EVERY version newest first with status, revision, field count and timestamps, and the ACTIVE version with its full structure', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    await publish(c, 2, 1);
    await createDraft(c, 2);
    await createDraft(c, 1).catch(() => undefined); // refused: a draft exists
    const d = await bare.getGigTemplate(c);
    expect(d.versions!.map((v) => [v.versionNumber, v.status, v.revision, v.fieldCount, v.publishedAt !== null, v.closedAt !== null])).toEqual([
      [3, 'DRAFT', 1, 6, false, false],
      [2, 'ACTIVE', 1, 6, true, false],
      [1, 'SUPERSEDED', 2, 6, true, true],
    ]);
    for (const v of d.versions!) {
      expect(keys(v)).toEqual([
        'areaModes',
        'closedAt',
        'createdAt',
        'duration',
        'fieldCount',
        'gigTemplateVersionId',
        'pricingModels',
        'publishedAt',
        'revision',
        'status',
        'versionNumber',
      ]);
      expect(new Date(v.createdAt!).toISOString()).toBe(v.createdAt);
    }
    expect(d.activeVersion).toMatchObject({ versionNumber: 2, status: 'ACTIVE' });
    expect(d.activeVersion!.fields).toHaveLength(6);
    expect(keys(d.activeVersion!)).toEqual(MGMT_VERSION_KEYS);
    expect(d.versions![0]!.gigTemplateVersionId).toBe((await versionRow(c, 3)).gig_template_version_id);
    // a template with no version has an empty history
    expect((await bare.getGigTemplate(await mkTemplate(st))).versions).toEqual([]);
  });

  it('a version can be read in every status with its whole structure, revision and timestamps', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    await publish(c, 2, 1); // 1 SUPERSEDED, 2 ACTIVE
    await createDraft(c, 2);
    await replaceDraft(c, 3, def(1, { fields: stdFields().slice(0, 3) })); // 3 DRAFT, revision 2
    await createDraft(c, 1).catch(() => undefined);
    await discard(c, 3);
    await createDraft(c, 2); // 4 DRAFT
    const structure = await structureOf(c, 1);
    const read = async (n: number) => bare.getGigTemplateVersion(c, n);
    expect((await read(1)).status).toBe('SUPERSEDED');
    expect((await read(2)).status).toBe('ACTIVE');
    expect((await read(3)).status).toBe('RETIRED');
    expect((await read(4)).status).toBe('DRAFT');
    for (const n of [1, 2, 4]) expect((await read(n)).fields.map((f) => f.fieldKey)).toEqual(stdFields().map((f) => f.fieldKey));
    expect((await read(3)).fields.map((f) => f.fieldKey)).toEqual(
      stdFields()
        .slice(0, 3)
        .map((f) => f.fieldKey),
    );
    expect((await read(3)).revision).toBe(2);
    expect((await read(1)).closedAt).not.toBeNull();
    expect((await read(4)).publishedAt).toBeNull();
    expect(await structureOf(c, 1)).toEqual(structure);
    expect((await read(1)).fields.find((f) => f.fieldKey === 'finish')!.options.map((o) => o.optionCode)).toEqual(['wax', 'sealant', 'ceramic']);
    await expectError(read(5), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    await expectError(bare.getGigTemplateVersion('devtest_nothing', 1), 'GIG_TEMPLATE_NOT_FOUND');
    for (const bad of [0, -1, 1.5, NaN, 2 ** 31, '1' as unknown as number])
      await expectError(bare.getGigTemplateVersion(c, bad), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
  });

  it('management reads need no public market and no version: unknown market, malformed market and unknown template are typed errors', async () => {
    for (const m of ['devtest-missing', 'LA-OC', '', 'a'.repeat(61), "x'--"]) {
      await expectError(bare.listGigTemplates({ marketCode: m }), 'MARKET_NOT_FOUND');
      await expectError(bare.getGigTemplate('full_detail', { marketCode: m }), 'MARKET_NOT_FOUND');
    }
    await expectError(bare.getGigTemplate('devtest_nothing'), 'GIG_TEMPLATE_NOT_FOUND');
    await expectError(bare.getGigTemplate('car_detailing'), 'GIG_TEMPLATE_NOT_FOUND'); // a service type code is not a template
    expect((await bare.getGigTemplate('full_detail', { marketCode: 'la-oc' })).enabled).toBe(false);
  });

  it('codes that look like SQL, traversal or unicode never reach SQL unparameterized: they are plain not-found answers (long ones cut in the echo) and nothing is written', async () => {
    const world = await worldHash();
    const nasty = [
      "x'; DROP TABLE catalog.gig_templates; --",
      "' OR '1'='1",
      '../../etc/passwd',
      '%00',
      'Ünïcödé_kód',
      '𝕏𝕐𝕫',
      'a'.repeat(100_000),
      '',
      ' ',
      '\n',
      'full_detail ',
      'FULL_DETAIL',
      '{{7*7}}',
    ];
    for (const c of nasty) {
      const e = await expectError(bare.getGigTemplate(c), 'GIG_TEMPLATE_NOT_FOUND');
      expect(String(e.details.code).length).toBeLessThanOrEqual(64);
      await expectError(bare.getGigTemplateVersion(c, 1), 'GIG_TEMPLATE_NOT_FOUND');
      await expectError(setTpl(c, 'ACTIVE'), 'GIG_TEMPLATE_NOT_FOUND');
      await expectError(createDraft(c), 'GIG_TEMPLATE_NOT_FOUND');
      await expectError(publish(c, 1, 1), 'GIG_TEMPLATE_NOT_FOUND');
      await expectError(discard(c, 1), 'GIG_TEMPLATE_NOT_FOUND');
      await expectError(gt.updateGigTemplate(c, { withDescription: true, reason: REASON }, ACTOR), 'GIG_TEMPLATE_NOT_FOUND');
    }
    const nul = String.fromCharCode(97, 0, 98);
    for (const call of [
      () => bare.getGigTemplate(nul),
      () => bare.getGigTemplateVersion(nul, 1),
      () => setTpl(nul, 'ACTIVE'),
      () => createDraft(nul),
      () => gt.updateGigTemplate(nul, { withDescription: true, reason: REASON }, ACTOR),
      () => tplAvail('la-oc', nul, true, 1),
    ]) {
      const e = await expectError(call(), 'VALIDATION_FAILED', 'FORBIDDEN_CHARACTER');
      expect(JSON.stringify(e.details)).not.toContain('invalid byte');
    }
    expect(await worldHash()).toBe(world);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'catalog'")).n).toBe(12);
  });
});

// ====================================================================== 9. statements issued
describe('statements issued by the reads', () => {
  const FRAME = 'start transaction isolation level repeatable read read only';
  async function publicWith(env: Env, fieldCount: number): Promise<string> {
    const c = await mkTemplate(env.st, { activate: true });
    const fields: FieldIn[] = Array.from({ length: fieldCount }, (_, i) => ({
      fieldKey: `field_${String(i).padStart(2, '0')}`,
      fieldType: i % 3 === 0 ? 'ENUM' : 'TEXT',
      behavior: 'PROVIDER_CONFIGURABLE',
      ...(i % 3 === 0 ? { options: [{ optionCode: 'opt_a' }, { optionCode: 'opt_b' }] } : {}),
    }));
    await copyFor(c, fields);
    await createDraft(c);
    const rev = (await replaceDraft(c, 1, def(1, { fields }))).revision!;
    await publish(c, 1, rev);
    await tplAvail(env.market, c, true, 'auto');
    return c;
  }

  it('a public read is the market gate once plus one snapshot transaction (frame, templates, fields, options, requirements, commit) on a miss and nothing on a hit, for every public read', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const miss = await counting(() => gt.getMarketGigTemplates(env.market));
    expect(miss.result.source).toBe('db');
    expect(miss.gate).toEqual([env.market]);
    expect(miss.sql).toHaveLength(6);
    expect(miss.sql[0]).toBe(FRAME);
    expect(miss.sql[1]).toMatch(/^\s*SELECT t\.gig_template_id[\s\S]*FROM catalog\.market_gig_templates mgt/);
    expect(miss.sql[2]).toMatch(/FROM catalog\.gig_template_fields f/);
    expect(miss.sql[3]).toMatch(/FROM catalog\.gig_template_field_options o/);
    expect(miss.sql[4]).toMatch(/FROM catalog\.gig_template_requirements q/);
    expect(miss.sql[5]).toBe('commit');
    expect(miss.sql.join('\n')).not.toMatch(/\b(insert|update|delete)\b|\bfor\s+(update|share|no key update|key share)\b/i);
    const hit = await counting(() => gt.getMarketGigTemplates(env.market));
    expect(hit.result.source).toBe('cache');
    expect(hit.sql).toEqual([]);
    expect(hit.gate).toEqual([env.market]);
    const reads: (() => Promise<unknown>)[] = [
      () => gt.listGigTemplatesForMarket(env.market),
      () => gt.listGigTemplatesForMarket(env.market, { serviceTypeCode: env.st }),
      () => gt.getGigTemplateForMarket(env.market, c),
    ];
    for (const read of reads) {
      const r = await counting(read);
      expect(r.sql).toEqual([]);
      expect(r.gate).toEqual([env.market]);
    }
  });

  it('a market with nothing public costs a frame, one select and a commit (no structure statements)', async () => {
    const market = await mkMarket(true);
    const r = await counting(() => bare.getMarketGigTemplates(market));
    expect(r.result.templates).toEqual([]);
    expect(r.sql).toHaveLength(3);
    expect([r.sql[0], r.sql[2]]).toEqual([FRAME, 'commit']);
  });

  it('the statement count does not grow with the number of templates or fields (2 templates of 3 fields or 12 templates of 30 fields: the same six statements)', async () => {
    const env = await mkEnv();
    for (let i = 0; i < 2; i++) await publicWith(env, 3);
    const small = await counting(() => bare.getMarketGigTemplates(env.market));
    expect(small.result.templates).toHaveLength(2);
    for (let i = 0; i < 10; i++) await publicWith(env, 30);
    const large = await counting(() => bare.getMarketGigTemplates(env.market));
    expect(large.result.templates).toHaveLength(12);
    expect(large.result.templates.map((t) => t.activeVersion!.fields.length)).toEqual([3, 3, ...Array(10).fill(30)]);
    expect(small.sql).toHaveLength(6);
    expect(large.sql.map((x) => x.replace(/\s+/g, ' '))).toEqual(small.sql.map((x) => x.replace(/\s+/g, ' ')));
    expect(large.gate).toEqual([env.market]);
    const cached = await counting(() => gt.getMarketGigTemplates(env.market));
    const hit = await counting(() => gt.getMarketGigTemplates(env.market));
    expect(cached.sql).toHaveLength(6);
    expect(hit.sql).toEqual([]);
  }, 90_000);

  it('the miss reads in ONE snapshot: a read-only REPEATABLE READ transaction (so templates, fields, options and requirements always agree)', async () => {
    const market = await mkMarket(true);
    const sink: string[] = [];
    const probe = createDatabase(iso.url, { role: 'tests', onQuery: (e) => sink.push(e.sql) });
    try {
      const own = new GigTemplateService({ database: probe, markets: gate, env: 'test', allowTestKeys: true });
      await own.getMarketGigTemplates(market);
      expect(sink[0]).toBe(FRAME);
      expect(sink.at(-1)).toBe('commit');
    } finally {
      await probe.close();
    }
  });

  it('the management reads send exactly: one read-only REPEATABLE READ transaction around the market lookup (with a market), the templates, the versions, and the structure of the ACTIVE versions (3) only when there is one (start and commit/rollback are two more statements); never cached; independent of how many templates', async () => {
    const market = await mkMarket(false);
    const { st } = await mkServiceTypeActive();
    const draftOnly = await mkTemplate(st);
    const none = (await mkServiceTypeActive()).st;
    expect((await counting(() => gt.listGigTemplates({ serviceTypeCode: none }))).sql).toHaveLength(3); // nothing found: one statement inside the transaction
    expect((await counting(() => gt.listGigTemplates({ serviceTypeCode: st }))).sql).toHaveLength(4); // templates + versions, no ACTIVE version
    expect((await counting(() => gt.listGigTemplates({ serviceTypeCode: st, marketCode: market }))).sql).toHaveLength(5);
    expect((await counting(() => gt.getGigTemplate(draftOnly))).sql).toHaveLength(4);
    expect((await counting(() => gt.getGigTemplate(draftOnly, { marketCode: market }))).sql).toHaveLength(5);
    const a = await counting(() => gt.listGigTemplates({ serviceTypeCode: st }));
    const b = await counting(() => gt.listGigTemplates({ serviceTypeCode: st }));
    expect([a.sql.length, b.sql.length]).toEqual([4, 4]); // never cached
    for (let i = 0; i < 3; i++) await mkPublished(st);
    const live = await counting(() => gt.listGigTemplates({ serviceTypeCode: st }));
    expect(live.sql).toHaveLength(7);
    for (let i = 0; i < 20; i++) await mkPublished(st);
    expect((await counting(() => gt.listGigTemplates({ serviceTypeCode: st }))).sql).toHaveLength(7);
    expect(live.gate).toEqual([]);
    const c = (await bare.listGigTemplates({ serviceTypeCode: st })).find((t) => t.activeVersion)!.code;
    expect((await counting(() => gt.getGigTemplate(c))).sql).toHaveLength(7);
    expect((await counting(() => gt.getGigTemplateVersion(c, 1))).sql).toHaveLength(6);
    expect((await counting(() => gt.getGigTemplateVersion(draftOnly, 1).catch(() => undefined))).sql).toHaveLength(4); // version lookup, then the template lookup, then the rollback
    expect((await counting(() => gt.getGigTemplate('devtest_nothing').catch(() => undefined))).sql).toHaveLength(3);
  }, 90_000);

  it("a management read runs in ONE read-only REPEATABLE READ transaction (a version is never shown with the rows of a later revision); inside a caller's transaction it joins that transaction instead of failing", async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    const reads: (() => Promise<unknown>)[] = [
      () => gt.getGigTemplate(c),
      () => gt.getGigTemplateVersion(c, 1),
      () => gt.listGigTemplates({ serviceTypeCode: st }),
    ];
    for (const read of reads) {
      const standalone = await counting(read);
      expect(standalone.sql[0], standalone.sql.join(' | ')).toMatch(/isolation level repeatable read read only/i);
      expect(standalone.sql[standalone.sql.length - 1]).toMatch(/^commit/i);
      const nested = await counting(() => iso.database.transaction(async () => read()));
      expect(
        nested.sql.filter((x) => /repeatable read/i.test(x)),
        "no second, stricter transaction inside the caller's",
      ).toEqual([]);
      expect(nested.result).toBeDefined();
    }
  });

  it('30 parallel public reads on a cold cache all return the same templates and every later read is a hit', async () => {
    const env = await mkEnv();
    for (let i = 0; i < 3; i++) await mkPublic(env);
    const expected = (await bare.getMarketGigTemplates(env.market)).templates.map((t) => t.code);
    expect(expected).toHaveLength(3);
    const results = await Promise.all(Array.from({ length: 30 }, () => gt.listGigTemplatesForMarket(env.market)));
    for (const r of results) expect(r.templates.map((t) => t.code)).toEqual(expected);
    expect((await counting(() => gt.listGigTemplatesForMarket(env.market))).sql).toEqual([]);
  });
});

// ====================================================================== 10. cache
describe('the cache', () => {
  const lastGen = () => cache.gen();
  const key = (market: string, g: number = lastGen()) => `bg:test:cat:v1:gt:market:${market}:${g}`;
  async function publicFixture() {
    const env = await mkEnv();
    const c = await mkPublic(env);
    return { env, c };
  }
  const fresh = async (market: string) => (await gt.getMarketGigTemplates(market)).source;
  const primed = async (market: string) => {
    await gt.getMarketGigTemplates(market);
    expect((await gt.getMarketGigTemplates(market)).source).toBe('cache');
  };

  it('a miss stores the snapshot under the Gig Template key and the current generation with the default TTL; the second read is a hit; another market has its own entry; the snapshot holds content KEYS and structure only', async () => {
    const { env, c } = await publicFixture();
    const other = await mkMarket(true);
    const g = lastGen();
    cache.sets.length = 0;
    expect((await gt.getMarketGigTemplates(env.market)).source).toBe('db');
    expect(cache.sets).toEqual([{ key: key(env.market, g), ttl: 300 }]);
    expect((await gt.getMarketGigTemplates(env.market)).source).toBe('cache');
    expect((await gt.getMarketGigTemplates(other)).source).toBe('db');
    expect(cache.data.has(key(other, g))).toBe(true);
    const stored = cache.data.get(key(env.market, g))!;
    const parsed = JSON.parse(stored) as { v: { templates: Row[] } };
    expect(keys(parsed.v)).toEqual(['templates']);
    expect(keys(parsed.v.templates[0]!)).toEqual([
      'activeVersion',
      'categoryCode',
      'code',
      'descriptionContentKey',
      'displayOrder',
      'gigTemplateId',
      'instructionsContentKey',
      'nameContentKey',
      'serviceTypeCode',
    ]);
    expect(parsed.v.templates[0]!.code).toBe(c);
    expect(stored).not.toMatch(/"(name|label|help|description|text|status|revision|enabled|publishedAt)"/);
    expect(stored).not.toContain(COPY_BODY);
    // the taxonomy has its own entry in the same key space
    await cat.getMarketCatalog(env.market);
    expect(cache.data.has(`bg:test:cat:v1:market:${env.market}:${g}`)).toBe(true);
  });

  it('a cache hit returns exactly what the database returns: the JSON round trip loses nothing (nulls, zeros, false values, order of fields, options and requirements)', async () => {
    const env = await mkEnv();
    await mkPublic(env, { description: true, instructions: true });
    await mkPublic(env);
    const fromDb = await gt.getMarketGigTemplates(env.market);
    expect(fromDb.source).toBe('db');
    const fromCache = await gt.getMarketGigTemplates(env.market);
    expect(fromCache.source).toBe('cache');
    expect(fromCache.templates).toStrictEqual(fromDb.templates);
    expect(fromCache.templates).toStrictEqual((await bare.getMarketGigTemplates(env.market)).templates);
    expect(fromCache.templates).toHaveLength(2);
    expect((await gt.getGigTemplateForMarket(env.market, fromDb.templates[0]!.code)).template).toStrictEqual(fromDb.templates[0]);
  });

  it('a custom cacheTtlSeconds is passed to the cache', async () => {
    const own = new TestCache();
    const s2 = new GigTemplateService({ database: iso.database, markets: gate, env: 'test', cache: own, cacheTtlSeconds: 42 });
    const market = await mkMarket(true);
    await s2.getMarketGigTemplates(market);
    expect(own.sets.map((x) => x.ttl)).toEqual([42]);
  });

  it('EVERY change of what is public bumps the generation exactly once and the next public read shows the new truth (the taxonomy changes share the same counter)', async () => {
    const { env, c } = await publicFixture();
    type Snap = Awaited<ReturnType<typeof bare.getMarketGigTemplates>>;
    const mine = (r: Snap) => r.templates.find((t) => t.code === c);
    const steps: { name: string; prep?: () => Promise<unknown>; run: () => Promise<unknown>; check: (r: Snap) => void }[] = [
      {
        name: 'updateGigTemplate (description link)',
        prep: () => putContent([descKey(c)]),
        run: () => gt.updateGigTemplate(c, { withDescription: true, reason: REASON }, ACTOR),
        check: (r) => expect(mine(r)!.descriptionContentKey).toBe(descKey(c)),
      },
      { name: 'setGigTemplateStatus INACTIVE', run: () => setTpl(c, 'INACTIVE'), check: (r) => expect(mine(r)).toBeUndefined() },
      { name: 'setGigTemplateStatus ACTIVE', run: () => setTpl(c, 'ACTIVE'), check: (r) => expect(mine(r)).toBeDefined() },
      { name: 'availability: order only', run: () => tplAvail(env.market, c, true, 777), check: (r) => expect(mine(r)!.displayOrder).toBe(777) },
      { name: 'availability: off', run: () => tplAvail(env.market, c, false), check: (r) => expect(mine(r)).toBeUndefined() },
      { name: 'availability: on', run: () => tplAvail(env.market, c, true), check: (r) => expect(mine(r)).toBeDefined() },
      {
        name: 'publish of version 2 (supersedes version 1)',
        prep: async () => {
          await createDraft(c, 1);
          await replaceDraft(c, 2, def(1, { fields: stdFields().slice(0, 4) }));
        },
        run: () => publish(c, 2, 2),
        check: (r) => expect([mine(r)!.activeVersion!.versionNumber, mine(r)!.activeVersion!.fields.length]).toEqual([2, 4]),
      },
      { name: 'taxonomy: service type paused', run: () => setSt(env.st, 'INACTIVE'), check: (r) => expect(mine(r)).toBeUndefined() },
      { name: 'taxonomy: service type active again', run: () => setSt(env.st, 'ACTIVE'), check: (r) => expect(mine(r)).toBeDefined() },
      {
        name: 'taxonomy: service type switched off in the market',
        run: () => stAvail(env.market, env.st, false),
        check: (r) => expect(mine(r)).toBeUndefined(),
      },
      { name: 'taxonomy: service type switched on in the market', run: () => stAvail(env.market, env.st, true), check: (r) => expect(mine(r)).toBeDefined() },
      {
        name: 'taxonomy: category switched off in the market (cascades to its service types)',
        run: () => catAvail(env.market, env.category, false),
        check: (r) => expect(mine(r)).toBeUndefined(),
      },
      {
        name: 'taxonomy: category switched on again (the service type stays off)',
        run: () => catAvail(env.market, env.category, true),
        check: (r) => expect(mine(r)).toBeUndefined(),
      },
      { name: 'taxonomy: service type switched on again', run: () => stAvail(env.market, env.st, true), check: (r) => expect(mine(r)).toBeDefined() },
      { name: 'setGigTemplateStatus RETIRED', run: () => setTpl(c, 'RETIRED'), check: (r) => expect(mine(r)).toBeUndefined() },
    ];
    for (const step of steps) {
      await step.prep?.();
      await primed(env.market);
      const g = lastGen();
      const incrs = cache.incrs.length;
      await step.run();
      expect(cache.incrs.length - incrs, `${step.name}: one bump per committed change`).toBe(1);
      expect(lastGen(), step.name).toBe(g + 1);
      expect(await fresh(env.market), `${step.name}: the next read is a miss`).toBe('db');
      const r = await gt.getMarketGigTemplates(env.market);
      step.check(r);
      expect(r.templates, step.name).toEqual((await bare.getMarketGigTemplates(env.market)).templates);
    }
  }, 90_000);

  it('draft edits and no-ops never bump and never change the answer: creating a template, a draft, replacing it (changed or equal), discarding it, repeating a publication, a status, an availability or an update', async () => {
    const { env, c } = await publicFixture();
    const before = (await bare.getMarketGigTemplates(env.market)).templates;
    await primed(env.market);
    const g = lastGen();
    const incrs = cache.incrs.length;
    const fresh2 = await mkTemplate(env.st); // create
    await createDraft(fresh2);
    await copyFor(fresh2);
    await replaceDraft(fresh2, 1, def(1)); // changed
    await replaceDraft(fresh2, 1, def(2)); // equal
    await replaceDraft(fresh2, 1, def(2, { fields: stdFields().slice(0, 2) })); // changed again
    await discard(fresh2, 1);
    await createDraft(c, 1); // a draft next to the ACTIVE version of a PUBLIC template
    await replaceDraft(c, 2, def(1, { fields: stdFields().slice(0, 1) }));
    await publish(c, 1, 2); // repeat of the publication of the ACTIVE version
    await setTpl(c, 'ACTIVE');
    await tplAvail(env.market, c, true);
    await gt.updateGigTemplate(c, { withDescription: false, reason: REASON }, ACTOR);
    expect(cache.incrs.length).toBe(incrs);
    expect(lastGen()).toBe(g);
    expect((await gt.getMarketGigTemplates(env.market)).source).toBe('cache');
    expect((await bare.getMarketGigTemplates(env.market)).templates).toEqual(before);
  });

  it('a refused or failed change never bumps (stale draft, guard refusals, validation, not-found, missing copy, a database failure after the audit row)', async () => {
    const { env, c } = await publicFixture();
    const draftTpl = await mkDraftTemplate(env.st, { activate: true });
    await primed(env.market);
    const g = lastGen();
    const incrs = cache.incrs.length;
    const world = await worldHash();
    await expectError(publish(draftTpl.code, 1, draftTpl.revision + 1), 'CONFLICT', 'STALE_DRAFT');
    await expectError(replaceDraft(draftTpl.code, 1, def(draftTpl.revision + 1)), 'CONFLICT', 'STALE_DRAFT');
    await expectError(setTpl(c, 'DRAFT' as CatalogStatus), 'VALIDATION_FAILED');
    await expectError(setTpl('devtest_nothing', 'ACTIVE'), 'GIG_TEMPLATE_NOT_FOUND');
    await expectError(tplAvail(env.market, draftTpl.code, true), 'VALIDATION_FAILED', 'DISPLAY_ORDER_REQUIRED');
    await expectError(createDraft(c, 9), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    await expectError(discard(c, 1), 'INVALID_STATE', 'ONLY_DRAFT_CAN_BE_DISCARDED');
    await expectError(gt.updateGigTemplate(c, { withInstructions: true, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'INSTRUCTIONS_CONTENT_MISSING');
    const e = (await failing('integration.outbox_events', `NEW.event_type = '${GIG_TEMPLATE_EVENTS.published}'`, () =>
      publish(draftTpl.code, 1, draftTpl.revision),
    )) as { code?: string };
    expect(e.code).toBe('XX000');
    expect(cache.incrs.length).toBe(incrs);
    expect(lastGen()).toBe(g);
    expect(await worldHash()).toBe(world);
    expect((await gt.getMarketGigTemplates(env.market)).source).toBe('cache');
  });

  it('a cache that throws or hangs never changes a result, a mutation or an error (reads fall back to the database; changes, including a publication, still commit)', async () => {
    for (const mode of ['throw', 'hang'] as const) {
      const { env, c } = await publicFixture();
      const bad = new TestCache();
      bad.mode = mode;
      const own = new GigTemplateService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: bad, cacheDeadlineMs: 40 });
      const truth = (await bare.getMarketGigTemplates(env.market)).templates;
      expect((await own.getMarketGigTemplates(env.market)).templates, mode).toEqual(truth);
      expect((await own.getMarketGigTemplates(env.market)).source).toBe('db');
      await own.setMarketGigTemplateAvailability(env.market, c, { enabled: true, displayOrder: 31, reason: REASON }, ACTOR);
      expect((await mgtRow(env.market, c))[0]!.display_order).toBe(31);
      await expectError(own.setGigTemplateStatus(c, { status: 'DRAFT' as CatalogStatus, reason: REASON }, ACTOR), 'VALIDATION_FAILED');
      await expectError(own.retireGigTemplateVersion(c, 1, { status: 'RETIRED', reason: REASON }, ACTOR), 'INVALID_STATE', 'ONLY_DRAFT_CAN_BE_DISCARDED');
      expect((await own.getMarketGigTemplates(env.market)).templates[0]!.displayOrder).toBe(31);
      await expectError(own.getMarketGigTemplates('devtest-nowhere'), 'MARKET_NOT_FOUND');
      // a publication with a dead cache commits and returns
      await createDraft(c, 1, own);
      const v = await replaceDraft(c, 2, def(1, { fields: stdFields().slice(0, 3) }), own);
      expect((await publish(c, 2, v.revision!, own)).status).toBe('ACTIVE');
      expect((await versionRow(c, 2)).status).toBe('ACTIVE');
      expect((await own.getMarketGigTemplates(env.market)).templates[0]!.activeVersion!.fields).toHaveLength(3);
      expect(bad.data.size).toBe(0);
    }
  });

  it('a stale generation can never serve old data: a reader that loaded BEFORE a commit and writes AFTER the bump only fills a dead key', async () => {
    const { env, c } = await publicFixture();
    const own = new TestCache();
    const reader = new GigTemplateService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: own, cacheDeadlineMs: 5000 });
    const hold = deferred();
    own.holdNextSet = hold;
    const slow = reader.getMarketGigTemplates(env.market); // loads the OLD state and then waits to store it
    for (let i = 0; i < 200 && own.sets.length === 0; i++) await sleep(10);
    expect(own.sets).toHaveLength(1);
    const oldGen = own.gen();
    await reader.setMarketGigTemplateAvailability(env.market, c, { enabled: true, displayOrder: 77, reason: REASON }, ACTOR); // commit + bump
    expect(own.gen()).toBe(oldGen + 1);
    hold.resolve();
    const stale = await slow;
    expect(stale.templates[0]!.displayOrder).not.toBe(77); // what it loaded before the commit
    expect(own.sets[0]!.key.endsWith(`:${oldGen}`)).toBe(true);
    const next = await reader.getMarketGigTemplates(env.market);
    expect(next.source).toBe('db');
    expect(next.templates[0]!.displayOrder).toBe(77);
    expect((await reader.getMarketGigTemplates(env.market)).source).toBe('cache');
  });

  it('a LOST bump is the documented gap: the stale entry is served until the next successful bump (bounded by the TTL), then fresh data again', async () => {
    const { env, c } = await publicFixture();
    const own = new TestCache();
    const s2 = new GigTemplateService({
      database: iso.database,
      markets: gate,
      env: 'test',
      allowTestKeys: true,
      cache: own,
      cacheDeadlineMs: 100,
      cacheTtlSeconds: 7,
    });
    await s2.getMarketGigTemplates(env.market);
    own.mode = 'lose-bump';
    await s2.setMarketGigTemplateAvailability(env.market, c, { enabled: true, displayOrder: 55, reason: REASON }, ACTOR);
    own.mode = 'ok';
    expect((await s2.getMarketGigTemplates(env.market)).source).toBe('cache'); // stale by design
    expect(own.sets.every((x) => x.ttl === 7)).toBe(true);
    await s2.setMarketGigTemplateAvailability(env.market, c, { enabled: true, displayOrder: 56, reason: REASON }, ACTOR);
    expect((await s2.getMarketGigTemplates(env.market)).templates[0]!.displayOrder).toBe(56);
  });

  it('the market gate is consulted on EVERY read, hit or miss: a market that stops being public stops being readable at once even though its snapshot is cached; a market that is not public is never given an entry', async () => {
    const { env } = await publicFixture();
    await primed(env.market);
    gateState.markets.delete(env.market);
    try {
      await expectError(gt.getMarketGigTemplates(env.market), 'MARKET_NOT_FOUND');
      await expectError(gt.listGigTemplatesForMarket(env.market), 'MARKET_NOT_FOUND');
      await expectError(gt.getGigTemplateForMarket(env.market, 'full_detail'), 'MARKET_NOT_FOUND');
    } finally {
      gateState.markets.set(env.market, { code: env.market, defaultLocale: 'en-US' });
    }
    expect((await gt.getMarketGigTemplates(env.market)).source).toBe('cache');
    const planned = await mkMarket(false);
    cache.sets.length = 0;
    cache.gets.length = 0;
    await expectError(gt.getMarketGigTemplates(planned), 'MARKET_NOT_FOUND');
    await expectError(gt.getMarketGigTemplates('LA-OC'), 'MARKET_NOT_FOUND');
    expect(cache.sets).toEqual([]);
    expect(cache.gets).toEqual([]);
  });

  it('a malformed, poisoned or unparseable entry is a miss (the database answers, the entry is overwritten); a cache entry of the right shape for another market is not served', async () => {
    const { env } = await publicFixture();
    const truth = (await bare.getMarketGigTemplates(env.market)).templates;
    await primed(env.market);
    const k = key(env.market);
    for (const bad of [
      '{nope',
      'null',
      '"x"',
      '[]',
      '',
      JSON.stringify({}),
      JSON.stringify({ v: 'x' }),
      JSON.stringify({ v: null }),
      JSON.stringify({ v: { templates: 'x' } }),
      JSON.stringify({ v: { templates: [{ code: 'x' }] } }),
      JSON.stringify({ v: { templates: truth.map((t) => ({ ...t, displayOrder: 1.5 })) } }),
      JSON.stringify({ v: { templates: truth.map((t) => ({ ...t, activeVersion: { ...t.activeVersion, pricingModels: ['FREE'] } })) } }),
    ]) {
      cache.data.set(k, bad);
      const r = await gt.getMarketGigTemplates(env.market);
      expect(r.source, bad).toBe('db');
      expect(r.templates).toEqual(truth);
    }
    expect((await gt.getMarketGigTemplates(env.market)).source).toBe('cache');
  });
});

// ====================================================================== 11. atomicity
describe('atomicity: the change, its audit row and its event commit together or not at all', () => {
  it('when the event of a publication cannot be written the new version stays a DRAFT, the previous ACTIVE version is NOT superseded, and the audit row and the cache are as they were', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    const world = await worldHash();
    const g = cache.gen();
    const incrs = cache.incrs.length;
    const e = (await failing('integration.outbox_events', `NEW.event_type = '${GIG_TEMPLATE_EVENTS.published}'`, () => publish(c, 2, 1))) as { code?: string };
    expect(e.code).toBe('XX000');
    expect(await vStatuses(c)).toEqual([
      [1, 'ACTIVE'],
      [2, 'DRAFT'],
    ]);
    expect(await worldHash()).toBe(world);
    expect([cache.gen(), cache.incrs.length]).toEqual([g, incrs]);
    expect((await publish(c, 2, 1)).status).toBe('ACTIVE'); // and the retry works once the failure is gone
    expect(await vStatuses(c)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
    ]);
    expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).map((x) => x.payload_json.versionNumber)).toEqual([1, 2]);
  });

  it('when the audit row cannot be written no event and no change remains, for every mutation', async () => {
    const env = await mkEnv();
    const { st } = env;
    const live = await mkPublished(st);
    const draft = await mkDraftTemplate(st, { activate: true });
    const fresh = await mkTemplate(st);
    const withDraft = await mkTemplate(st);
    await createDraft(withDraft);
    const withDesc = await mkTemplate(st);
    await putContent([descKey(withDesc)]);
    const code2 = code('t');
    await putContent([nameKey(code2)]);
    const world = await worldHash();
    const g = cache.gen();
    const cases: [string, string, () => Promise<unknown>][] = [
      ['create template', `NEW.action = 'GIG_TEMPLATE_CREATED'`, () => gt.createGigTemplate({ code: code2, serviceTypeCode: st, reason: REASON }, ACTOR)],
      ['update template', `NEW.action = 'GIG_TEMPLATE_UPDATED'`, () => gt.updateGigTemplate(withDesc, { withDescription: true, reason: REASON }, ACTOR)],
      ['template status', `NEW.action = 'GIG_TEMPLATE_STATUS_CHANGED'`, () => setTpl(fresh, 'ACTIVE')],
      ['create version', `NEW.action = 'GIG_TEMPLATE_VERSION_CREATED'`, () => createDraft(fresh)],
      ['copy version', `NEW.action = 'GIG_TEMPLATE_VERSION_CREATED'`, () => createDraft(live, 1)],
      [
        'replace draft',
        `NEW.action = 'GIG_TEMPLATE_VERSION_CHANGED'`,
        () => replaceDraft(draft.code, 1, def(draft.revision, { fields: stdFields().slice(0, 2) })),
      ],
      ['publish', `NEW.action = 'GIG_TEMPLATE_VERSION_PUBLISHED'`, () => publish(draft.code, 1, draft.revision)],
      ['discard', `NEW.action = 'GIG_TEMPLATE_VERSION_RETIRED'`, () => discard(withDraft, 1)],
      ['retire template', `NEW.action = 'GIG_TEMPLATE_VERSION_RETIRED'`, () => setTpl(live, 'RETIRED')],
      ['availability', `NEW.action = 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED'`, () => tplAvail(env.market, live, true, 10)],
    ];
    for (const [label, when, call] of cases) {
      const e = (await failing('catalog.audit_events', when, call)) as { code?: string };
      expect(e.code, label).toBe('XX000');
      expect(await worldHash(), label).toBe(world);
    }
    expect(cache.gen()).toBe(g);
    await expectError(bare.getGigTemplate(code2), 'GIG_TEMPLATE_NOT_FOUND');
    expect(await vStatuses(live)).toEqual([[1, 'ACTIVE']]);
    expect(await mgtRow(env.market, live)).toEqual([]);
  });

  it('when an event cannot be written no audit row and no change remains (activation, retirement, availability)', async () => {
    const env = await mkEnv();
    const live = await mkPublished(env.st);
    const fresh = await mkTemplate(env.st);
    const world = await worldHash();
    const cases: [string, string, () => Promise<unknown>][] = [
      ['activation', GIG_TEMPLATE_EVENTS.activated, () => setTpl(fresh, 'ACTIVE')],
      ['pause', GIG_TEMPLATE_EVENTS.deactivated, () => setTpl(live, 'INACTIVE')],
      ['retirement', GIG_TEMPLATE_EVENTS.retired, () => setTpl(live, 'RETIRED')],
      ['availability', GIG_TEMPLATE_EVENTS.availabilityChanged, () => tplAvail(env.market, live, true, 10)],
    ];
    for (const [label, type, call] of cases) {
      const e = (await failing('integration.outbox_events', `NEW.event_type = '${type}'`, call)) as { code?: string };
      expect(e.code, label).toBe('XX000');
      expect(await worldHash(), label).toBe(world);
    }
  });

  it('a failure in the MIDDLE of a retirement (the audit row of the ACTIVE version, written last) rolls back the discarded draft, the template status and the closing of the version', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    await createDraft(c, 1);
    const activeId = (await versionRow(c, 1)).gig_template_version_id as string;
    const world = await worldHash();
    const g = cache.gen();
    const e = (await failing('catalog.audit_events', `NEW.gig_template_version_id = '${activeId}'`, () => setTpl(c, 'RETIRED'))) as { code?: string };
    expect(e.code).toBe('XX000');
    expect(await worldHash()).toBe(world);
    expect(await vStatuses(c)).toEqual([
      [1, 'ACTIVE'],
      [2, 'DRAFT'],
    ]);
    expect((await templateRow(c)).status).toBe('ACTIVE');
    expect(cache.gen()).toBe(g);
    expect((await setTpl(c, 'RETIRED')).status).toBe('RETIRED');
  });

  it("a transaction that is rolled back AFTER the service did its work inside it leaves no row, no audit and no event (the service joins the caller's transaction)", async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
    const world = await worldHash();
    const abort = new Error('outer abort');
    const e = await rejection(
      iso.database.transaction(async () => {
        await publish(c, 1, revision);
        await setTpl(c, 'RETIRED');
        expect((await bare.getGigTemplate(c)).status).toBe('RETIRED'); // visible inside
        throw abort;
      }),
    );
    expect(e).toBe(abort);
    expect(await worldHash()).toBe(world);
    expect(await vStatuses(c)).toEqual([[1, 'DRAFT']]);
    expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).toEqual([]);
  });
});

// ====================================================================== 12. retry on a lost race (availability only)
describe('retryOnRace: an availability change that lost a race is repeated once, and nothing else is', () => {
  /** Installs a trigger that fails the first `n` matching inserts (counted with a sequence, which is not rolled back) with the given SQLSTATE. */
  async function flaky<T>(
    o: { table: string; when: string; n: number; sqlstate: string },
    fn: () => Promise<T>,
  ): Promise<{ result: PromiseSettledResult<T>; calls: number }> {
    await q('CREATE SEQUENCE public.gt_test_seq');
    await q(`CREATE FUNCTION public.gt_test_flaky() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('public.gt_test_seq') <= TG_ARGV[0]::int THEN RAISE EXCEPTION 'injected failure' USING ERRCODE = TG_ARGV[1]; END IF; RETURN NEW; END $$`);
    await q(
      `CREATE TRIGGER trg_gt_test_flaky BEFORE INSERT ON ${o.table} FOR EACH ROW WHEN (${o.when}) EXECUTE FUNCTION public.gt_test_flaky('${o.n}', '${o.sqlstate}')`,
    );
    try {
      const [result] = await Promise.allSettled([fn()]);
      const last = await one<{ last_value: string; is_called: boolean }>('SELECT last_value, is_called FROM public.gt_test_seq');
      return { result, calls: last.is_called ? Number(last.last_value) : 0 };
    } finally {
      await q(`DROP TRIGGER trg_gt_test_flaky ON ${o.table}`);
      await q('DROP FUNCTION public.gt_test_flaky()');
      await q('DROP SEQUENCE public.gt_test_seq');
    }
  }
  const AVAIL_AUDIT = { table: 'catalog.audit_events', when: `NEW.action = 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED'` };
  const txStarts = (from: number) => statements.slice(from).filter((x) => /^start transaction/i.test(x)).length;

  for (const sqlstate of ['40P01', '40001']) {
    it(`a ${sqlstate} on the first attempt is retried once and succeeds: ONE audit row, ONE event, ONE cache bump, the change applied`, async () => {
      const env = await mkEnv();
      const c = await mkTemplate(env.st);
      const order = nextOrder(env.market, 't');
      const incrs = cache.incrs.length;
      const { result, calls } = await flaky({ ...AVAIL_AUDIT, n: 1, sqlstate }, () => tplAvail(env.market, c, true, order));
      expect(result.status, result.status === 'rejected' ? String((result.reason as Error).message) : '').toBe('fulfilled');
      expect((result as PromiseFulfilledResult<unknown>).value).toEqual({ marketCode: env.market, code: c, enabled: true, displayOrder: order });
      expect(calls, 'the transaction ran twice: the failed attempt and the retry').toBe(2);
      expect((await tplAudit(c)).filter((a) => a.market_code)).toHaveLength(1);
      expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.availabilityChanged)).toHaveLength(1);
      expect(cache.incrs.length - incrs).toBe(1);
      expect(await mgtRow(env.market, c)).toEqual([{ enabled: true, display_order: order }]);
    });
  }

  it('a second loss surfaces as the retryable CONFLICT CONCURRENT_UPDATE: exactly two attempts, nothing written, no bump', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    const from = statements.length;
    const { result, calls } = await flaky({ ...AVAIL_AUDIT, n: 2, sqlstate: '40P01' }, () => tplAvail(env.market, c, true, 10));
    expect(result.status).toBe('rejected');
    const e = (result as PromiseRejectedResult).reason as CatalogError;
    expect([e.code, e.details.reason, e.details.retryable]).toEqual(['CONFLICT', 'CONCURRENT_UPDATE', true]);
    expect(calls, 'exactly one retry, never a third attempt').toBe(2);
    expect(txStarts(from)).toBe(2);
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
  });

  it('an error that is not a lost race is NOT retried: a raw failure, a guard refusal, a taken display order and a missing display order each run the transaction once', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    const other = await mkTemplate(env.st);
    const retired = await mkTemplate(env.st);
    await setTpl(retired, 'RETIRED');
    await tplAvail(env.market, c, true, 10);
    let from = statements.length;
    const raw = await flaky({ ...AVAIL_AUDIT, n: 1, sqlstate: 'XX000' }, () => tplAvail(env.market, c, false));
    expect(raw.result.status).toBe('rejected');
    expect(((raw.result as PromiseRejectedResult).reason as { code?: string }).code).toBe('XX000');
    expect(raw.calls).toBe(1);
    expect(txStarts(from)).toBe(1);
    for (const [label, call, wanted] of [
      ['guard', () => tplAvail(env.market, retired, true, 20), ['INVALID_STATE', 'ITEM_RETIRED']] as const,
      ['order taken', () => tplAvail(env.market, other, true, 10), ['CONFLICT', 'DISPLAY_ORDER_TAKEN']] as const,
      ['order missing', () => tplAvail(env.market, other, true), ['VALIDATION_FAILED', 'DISPLAY_ORDER_REQUIRED']] as const,
    ]) {
      from = statements.length;
      const e = await expectError(call(), wanted[0], wanted[1]);
      expect(e.details.retryable, label).toBeUndefined();
      expect(txStarts(from), label).toBe(1);
    }
  });

  it('no other mutation is retried: a 40001 during a publication, a status change, a replace or a version creation surfaces at once as the retryable CONFLICT after ONE attempt, and nothing is written', async () => {
    const { st } = await mkServiceTypeActive();
    const draft = await mkDraftTemplate(st, { activate: true });
    const other = await mkTemplate(st);
    const live = await mkPublished(st);
    const world = await worldHash();
    const cases: [string, string, () => Promise<unknown>][] = [
      ['publish', 'GIG_TEMPLATE_VERSION_PUBLISHED', () => publish(draft.code, 1, draft.revision)],
      ['status', 'GIG_TEMPLATE_STATUS_CHANGED', () => setTpl(other, 'ACTIVE')],
      ['replace', 'GIG_TEMPLATE_VERSION_CHANGED', () => replaceDraft(draft.code, 1, def(draft.revision, { fields: stdFields().slice(0, 2) }))],
      ['create version', 'GIG_TEMPLATE_VERSION_CREATED', () => createDraft(live, 1)],
      [
        'create template',
        'GIG_TEMPLATE_CREATED',
        async () => gt.createGigTemplate({ code: await newCodeWithCopy(), serviceTypeCode: st, reason: REASON }, ACTOR),
      ],
    ];
    for (const [label, action, call] of cases) {
      const from = statements.length;
      const { result, calls } = await flaky({ table: 'catalog.audit_events', when: `NEW.action = '${action}'`, n: 1, sqlstate: '40001' }, call);
      expect(result.status, label).toBe('rejected');
      const e = (result as PromiseRejectedResult).reason as CatalogError;
      expect([e.code, e.details.reason, e.details.retryable], label).toEqual(['CONFLICT', 'CONCURRENT_UPDATE', true]);
      expect(calls, label).toBe(1);
      expect(txStarts(from), label).toBe(1);
    }
    expect(await worldHash()).toBe(world);
  });

  it('deterministic: a lost race on the INSERT of a new availability row is retried once: the same request is a no-op (nothing audited, announced or bumped), a different one is applied on top of the winner', async () => {
    const env = await mkEnv();
    const insert =
      'INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order) SELECT m.market_id, t.gig_template_id, $4, $3 FROM geography.markets m, catalog.gig_templates t WHERE m.code = $1 AND t.code = $2';
    // (a) the other session inserts exactly what this request asks for
    const same = await mkTemplate(env.st);
    const order = nextOrder(env.market, 't');
    let t = await rawTx();
    await t.query(insert, [env.market, same, order, true]);
    const incrs = cache.incrs.length;
    let pending = tplAvail(env.market, same, true, order);
    await waitUntilBlocked();
    await t.commit();
    expect(await pending).toEqual({ marketCode: env.market, code: same, enabled: true, displayOrder: order });
    expect(await mgtRow(env.market, same)).toEqual([{ enabled: true, display_order: order }]);
    expect(
      (await tplAudit(same)).filter((a) => a.market_code),
      'the foreign insert is not audited and the retried no-op writes nothing',
    ).toHaveLength(0);
    expect(await tplEvents(same, GIG_TEMPLATE_EVENTS.availabilityChanged)).toEqual([]);
    expect(cache.incrs.length, 'a retried no-op does not bump').toBe(incrs);
    // (b) the other session inserts the row DISABLED; this request wants it enabled: it is applied on top
    const other = await mkTemplate(env.st);
    const order2 = nextOrder(env.market, 't');
    t = await rawTx();
    await t.query(insert, [env.market, other, order2, false]);
    pending = tplAvail(env.market, other, true, order2);
    await waitUntilBlocked();
    await t.commit();
    expect(await pending).toEqual({ marketCode: env.market, code: other, enabled: true, displayOrder: order2 });
    expect(await mgtRow(env.market, other)).toEqual([{ enabled: true, display_order: order2 }]);
    expect((await tplAudit(other)).filter((a) => a.market_code).map((a) => a.changes)).toEqual([{ enabled: [false, true], displayOrder: [order2, order2] }]);
    expect(await tplEvents(other, GIG_TEMPLATE_EVENTS.availabilityChanged)).toHaveLength(1);
    expect(cache.incrs.length, 'the applied retry bumps exactly once').toBe(incrs + 1);
  });
});
async function newCodeWithCopy(): Promise<string> {
  const c = code('t');
  await putContent([nameKey(c)]);
  return c;
}

// ====================================================================== 13. concurrency
describe('concurrency through the service (real transactions)', () => {
  // open the service's connections up front: on a cold pool the callers start one after the other and a race can quietly become a sequence
  beforeAll(async () => {
    await Promise.all(Array.from({ length: 30 }, () => iso.database.query('SELECT pg_sleep(0.1)')));
  });
  const blockedCount = async () =>
    (
      await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND state = 'active'`, [
        iso.name,
      ])
    ).n;
  const waitBlocked = async (n: number): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if ((await blockedCount()) >= n) return;
      await sleep(20);
    }
    throw new Error(`fewer than ${n} sessions blocked on a lock`);
  };

  it('20 simultaneous activations of one template: every caller sees ACTIVE, ONE status change, ONE audit row, ONE event, ONE cache bump', async () => {
    const { st } = await mkServiceTypeActive();
    for (let round = 0; round < 3; round++) {
      const c = await mkTemplate(st);
      const incrs = cache.incrs.length;
      const results = await Promise.all(Array.from({ length: 20 }, () => setTpl(c, 'ACTIVE')));
      expect(results.every((r) => r.status === 'ACTIVE')).toBe(true);
      expect(await auditActions(c)).toEqual(['GIG_TEMPLATE_CREATED', 'GIG_TEMPLATE_STATUS_CHANGED']);
      expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.activated)).toHaveLength(1);
      expect(cache.incrs.length - incrs).toBe(1);
    }
  });

  it('20 simultaneous publications of the same draft: every caller sees it ACTIVE, ONE audit row, ONE event, ONE cache bump, ONE active version', async () => {
    const { st } = await mkServiceTypeActive();
    for (let round = 0; round < 3; round++) {
      const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
      const incrs = cache.incrs.length;
      const results = await Promise.all(Array.from({ length: 20 }, () => err(publish(c, 1, revision))));
      expect(results.filter(Boolean)).toEqual([]);
      expect((await tplAudit(c)).filter((a) => a.action === 'GIG_TEMPLATE_VERSION_PUBLISHED')).toHaveLength(1);
      expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).toHaveLength(1);
      expect(cache.incrs.length - incrs).toBe(1);
      expect(await vStatuses(c)).toEqual([[1, 'ACTIVE']]);
    }
  });

  it('simultaneous publications of two different drafts of one template (v2 and, after a discard, v3 are not possible together): the single draft slot means one publication per draft, in order', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkPublished(st);
    for (let n = 2; n <= 4; n++) {
      await createDraft(c, 1);
      const results = await Promise.all([publish(c, n, 1), publish(c, n, 1), publish(c, n, 1)]);
      expect(results.every((r) => r.status === 'ACTIVE' && r.versionNumber === n)).toBe(true);
    }
    expect(await vStatuses(c)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'SUPERSEDED'],
      [3, 'SUPERSEDED'],
      [4, 'ACTIVE'],
    ]);
    expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).map((e) => e.payload_json.versionNumber)).toEqual([1, 2, 3, 4]);
  });

  it('publishing against retiring the template, 12 rounds: both orders are legal and consistent (published then closed, or discarded then refused); never an ACTIVE version under a RETIRED template', async () => {
    const seen = new Set<string>();
    const { st } = await mkServiceTypeActive();
    for (let round = 0; round < 12; round++) {
      const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
      const [p, r] = await Promise.all([err(publish(c, 1, revision)), err(setTpl(c, 'RETIRED'))]);
      expect(r, 'retiring never fails').toBeUndefined();
      expect((await templateRow(c)).status).toBe('RETIRED');
      expect((await versionRow(c, 1)).status).toBe('RETIRED');
      expect((await versionRows(c)).filter((v) => v.status === 'ACTIVE')).toEqual([]);
      const published = (await tplAudit(c)).some((a) => a.action === 'GIG_TEMPLATE_VERSION_PUBLISHED');
      if (p) {
        expect([p.code, p.details.reason]).toEqual(['INVALID_STATE', 'VERSION_NOT_DRAFT']);
        expect(published).toBe(false);
        seen.add('retired-first');
      } else {
        expect(published).toBe(true);
        expect((await versionRow(c, 1)).published_at).not.toBeNull();
        seen.add('published-first');
      }
      expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.published)).length).toBe(published ? 1 : 0);
      expect((await tplEvents(c, GIG_TEMPLATE_EVENTS.retired)).length).toBe(1);
      const retiredAudits = (await tplAudit(c)).filter((a) => a.action === 'GIG_TEMPLATE_VERSION_RETIRED');
      expect(retiredAudits.map((a) => (a.changes as { status: string[] }).status)).toEqual([[published ? 'ACTIVE' : 'DRAFT', 'RETIRED']]);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('publishing against replacing the same draft, 12 rounds: exactly one wins; what was published is exactly the definition that was stored when it was; the loser gets the typed refusal', async () => {
    const { st } = await mkServiceTypeActive();
    const outcomes = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
      const smaller = stdFields().slice(0, 3);
      const before = await structureOf(c, 1);
      const [p, r] = await Promise.all([err(publish(c, 1, revision)), err(replaceDraft(c, 1, def(revision, { fields: smaller })))]);
      expect([p, r].filter(Boolean), 'exactly one of the two is refused').toHaveLength(1);
      const row = await versionRow(c, 1);
      if (p) {
        expect([p.code, p.details.reason]).toEqual(['CONFLICT', 'STALE_DRAFT']); // the replace came first
        expect(row.status).toBe('DRAFT');
        expect((await fieldRows(c, 1)).length).toBe(3);
        outcomes.add('replace-first');
      } else {
        expect([r!.code, r!.details.reason]).toEqual(['INVALID_STATE', 'VERSION_NOT_DRAFT']); // the publication came first
        expect(row.status).toBe('ACTIVE');
        expect(await structureOf(c, 1)).toEqual(before); // the published definition is the one that was reviewed
        outcomes.add('publish-first');
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it('publishing against discarding the same draft, 12 rounds: exactly one wins and the other gets the typed refusal', async () => {
    const { st } = await mkServiceTypeActive();
    for (let round = 0; round < 12; round++) {
      const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
      const [p, d] = await Promise.all([err(publish(c, 1, revision)), err(discard(c, 1))]);
      expect([p, d].filter(Boolean)).toHaveLength(1);
      if (p) {
        expect([p.code, p.details.reason]).toEqual(['INVALID_STATE', 'VERSION_NOT_DRAFT']);
        expect((await versionRow(c, 1)).status).toBe('RETIRED');
      } else {
        expect([d!.code, d!.details.reason]).toEqual(['INVALID_STATE', 'ONLY_DRAFT_CAN_BE_DISCARDED']);
        expect((await versionRow(c, 1)).status).toBe('ACTIVE');
      }
    }
  });

  it('10 creators of the next version at once: exactly one DRAFT is created, every other caller gets DRAFT_EXISTS (also when they copy), and the numbers have no gap', async () => {
    const { st } = await mkServiceTypeActive();
    for (const copy of [false, true]) {
      const c = await mkPublished(st);
      const r = await Promise.all(Array.from({ length: 10 }, () => err(createDraft(c, copy ? 1 : undefined))));
      expect(r.filter((e) => !e)).toHaveLength(1);
      for (const e of r.filter(Boolean)) expect([e!.code, e!.details.reason]).toEqual(['CONFLICT', 'DRAFT_EXISTS']);
      expect(await vStatuses(c)).toEqual([
        [1, 'ACTIVE'],
        [2, 'DRAFT'],
      ]);
      expect((await tplAudit(c)).filter((a) => a.action === 'GIG_TEMPLATE_VERSION_CREATED')).toHaveLength(2);
    }
  });

  it('10 creators of the same template code at once: one wins, every other gets CODE_TAKEN, one row and one audit row', async () => {
    const { st } = await mkServiceTypeActive();
    const c = code('t');
    await putContent([nameKey(c)]);
    const r = await Promise.all(Array.from({ length: 10 }, () => err(gt.createGigTemplate({ code: c, serviceTypeCode: st, reason: REASON }, ACTOR))));
    expect(r.filter((e) => !e)).toHaveLength(1);
    for (const e of r.filter(Boolean)) expect([e!.code, e!.details.reason]).toEqual(['CONFLICT', 'CODE_TAKEN']);
    expect(await tplAudit(c)).toHaveLength(1);
    expect((await q('SELECT 1 FROM catalog.gig_templates WHERE code = $1', [c])).length).toBe(1);
  });

  it("two administrators replace the same draft at once with different definitions: one wins, the other gets STALE_DRAFT, the revision grew by exactly one and the stored definition is the winner's; identical simultaneous requests behave the same", async () => {
    const { st } = await mkServiceTypeActive();
    for (let round = 0; round < 4; round++) {
      const { code: c, revision } = await mkDraftTemplate(st);
      const bodies = [
        def(revision, { fields: stdFields().slice(0, 2) }),
        def(revision, { fields: stdFields().slice(0, 4) }),
        def(revision, { fields: stdFields().slice(0, 5) }),
      ];
      const r = await Promise.all(bodies.map((b) => err(replaceDraft(c, 1, b))));
      expect(r.filter((e) => !e)).toHaveLength(1);
      for (const e of r.filter(Boolean)) expect([e!.code, e!.details.reason]).toEqual(['CONFLICT', 'STALE_DRAFT']);
      expect((await versionRow(c, 1)).revision).toBe(revision + 1);
      const winner = r.findIndex((e) => !e);
      expect((await fieldRows(c, 1)).length).toBe([2, 4, 5][winner]);
      expect((await tplAudit(c)).filter((a) => a.action === 'GIG_TEMPLATE_VERSION_CHANGED')).toHaveLength(2); // the first definition and the winner
    }
    // the same request sent twice at the same time: the second one finds the revision moved
    const { code: c, revision } = await mkDraftTemplate(st);
    const body = def(revision, { fields: stdFields().slice(0, 2) });
    const twin = await Promise.all([err(replaceDraft(c, 1, body)), err(replaceDraft(c, 1, body))]);
    expect(twin.filter((e) => !e)).toHaveLength(1);
    expect(twin.find(Boolean)!.details.reason).toBe('STALE_DRAFT');
  });

  it('simultaneous mixed status changes of one template leave a consistent chain: every audit row continues the previous one, the last matches the row, events match the transitions', async () => {
    const { st } = await mkServiceTypeActive();
    for (let round = 0; round < 3; round++) {
      const c = await mkTemplate(st);
      const wanted: CatalogStatus[] = [
        'ACTIVE',
        'INACTIVE',
        'RETIRED',
        'ACTIVE',
        'INACTIVE',
        'ACTIVE',
        'RETIRED',
        'INACTIVE',
        'ACTIVE',
        'ACTIVE',
        'INACTIVE',
        'RETIRED',
      ];
      const outcomes = await Promise.all(wanted.map((status) => err(setTpl(c, status))));
      for (const e of outcomes) if (e) expect(['INVALID_STATE', 'CONFLICT']).toContain(e.code);
      const chain = (await tplAudit(c)).slice(1).map((a) => a.changes!.status as [string, string]);
      let at = 'DRAFT';
      for (const [from, to] of chain) {
        expect(from).toBe(at);
        expect(isCatalogTransitionAllowed(from as CatalogStatus, to as CatalogStatus)).toBe(true);
        at = to;
      }
      expect((await templateRow(c)).status).toBe(at);
      expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.activated)).toHaveLength(chain.filter(([, to]) => to === 'ACTIVE').length);
      expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.deactivated)).toHaveLength(chain.filter(([from, to]) => from === 'ACTIVE' && to === 'INACTIVE').length);
      expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.retired)).toHaveLength(chain.filter(([, to]) => to === 'RETIRED').length);
    }
  });

  it('activating a template against pausing its service type, 12 rounds: either order is legal; a template is never newly activated under a service type that was already paused', async () => {
    for (let round = 0; round < 12; round++) {
      const { st } = await mkServiceTypeActive();
      const c = await mkTemplate(st);
      const [a, b] = await Promise.all([err(setTpl(c, 'ACTIVE')), err(setSt(st, 'INACTIVE'))]);
      expect(b, 'pausing a service type never fails').toBeUndefined();
      if (a) expect([a.code, a.details.reason]).toEqual(['INVALID_STATE', 'SERVICE_TYPE_NOT_ACTIVE']);
      expect((await templateRow(c)).status).toBe(a ? 'DRAFT' : 'ACTIVE');
    }
  });

  it('enabling a template in a market against retiring it, 12 rounds: either the row is enabled and the template then retired, or the enabling was refused ITEM_RETIRED and no enabled row exists', async () => {
    const env = await mkEnv();
    for (let round = 0; round < 12; round++) {
      const c = await mkTemplate(env.st);
      const [e, r] = await Promise.all([err(tplAvail(env.market, c, true, 'auto')), err(setTpl(c, 'RETIRED'))]);
      expect(r).toBeUndefined();
      if (e) {
        expect([e.code, e.details.reason]).toEqual(['INVALID_STATE', 'ITEM_RETIRED']);
        expect(await mgtRow(env.market, c)).toEqual([]);
      } else expect((await mgtRow(env.market, c))[0]!.enabled).toBe(true);
    }
  });

  it('10 identical availability requests for a NEW pair converge: every caller succeeds with the same result, and exactly one row, one audit row and one event exist, only the winner bumps', async () => {
    for (let round = 0; round < 3; round++) {
      const env = await mkEnv();
      const c = await mkTemplate(env.st);
      const incrs = cache.incrs.length;
      const r = await Promise.all(
        Array.from({ length: 10 }, () =>
          tplAvail(env.market, c, true, 10).then(
            (d) => d,
            (e: unknown) => e as Error,
          ),
        ),
      );
      for (const d of r)
        expect(d, d instanceof Error ? String((d as CatalogError).details?.reason) : '').toEqual({
          marketCode: env.market,
          code: c,
          enabled: true,
          displayOrder: 10,
        });
      expect((await mgtRow(env.market, c)).length).toBe(1);
      expect((await tplAudit(c)).filter((a) => a.market_code)).toHaveLength(1);
      expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.availabilityChanged)).toHaveLength(1);
      expect(cache.incrs.length - incrs, 'only the winner bumps').toBe(1);
    }
  });

  it('simultaneous changes of an EXISTING availability row serialize on it: the audit rows form a chain old -> new, the last one is the stored state, one event per change', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    await tplAvail(env.market, c, true, 10);
    const plan = [
      [false, 11],
      [true, 12],
      [false, 13],
      [true, 14],
      [true, 15],
      [false, 16],
      [true, 17],
      [false, 18],
    ] as const;
    const out = await Promise.all(plan.map(([enabled, order]) => err(tplAvail(env.market, c, enabled, order))));
    expect(out.filter(Boolean)).toEqual([]);
    const chain = (await tplAudit(c))
      .filter((a) => a.market_code)
      .map((a) => a.changes as { enabled: [boolean | null, boolean]; displayOrder: [number | null, number] });
    expect(chain).toHaveLength(1 + plan.length);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.enabled[0], `row ${i}`).toBe(chain[i - 1]!.enabled[1]);
      expect(chain[i]!.displayOrder[0], `row ${i}`).toBe(chain[i - 1]!.displayOrder[1]);
    }
    const last = chain.at(-1)!;
    expect(await mgtRow(env.market, c)).toEqual([{ enabled: last.enabled[1], display_order: last.displayOrder[1] }]);
    expect(await tplEvents(c, GIG_TEMPLATE_EVENTS.availabilityChanged)).toHaveLength(chain.length);
  });

  it('two templates moved onto the same order at once: one wins, the other gets DISPLAY_ORDER_TAKEN, and the orders stay unique', async () => {
    for (let round = 0; round < 5; round++) {
      const env = await mkEnv();
      const a = await mkTemplate(env.st);
      const b = await mkTemplate(env.st);
      await tplAvail(env.market, a, true, 10);
      await tplAvail(env.market, b, true, 20);
      const [ra, rb] = await Promise.all([err(tplAvail(env.market, a, true, 40)), err(tplAvail(env.market, b, true, 40))]);
      expect([ra, rb].filter(Boolean)).toHaveLength(1);
      expect((ra ?? rb)!.details.reason).toBe('DISPLAY_ORDER_TAKEN');
      const orders = (
        await q<{ display_order: number }>(
          'SELECT display_order FROM catalog.market_gig_templates x JOIN geography.markets m USING (market_id) WHERE m.code = $1',
          [env.market],
        )
      ).map((x) => x.display_order);
      expect(new Set(orders).size).toBe(2);
      expect(orders.filter((o) => o === 40)).toHaveLength(1);
    }
  });

  it('deterministic: a session holding the template row makes a status change wait and then proceed; the writes happen after it releases', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const t = await rawTx();
    await t.query('SELECT gig_template_id FROM catalog.gig_templates WHERE code = $1 FOR UPDATE', [c]);
    const pending = setTpl(c, 'ACTIVE');
    await waitBlocked(1);
    expect((await templateRow(c)).status).toBe('DRAFT'); // nothing happened while it waits
    await t.rollback();
    expect((await pending).status).toBe('ACTIVE');
  });

  it('deterministic: with the template locked, a publication that queued first wins over a replace queued after it, and the loser gets VERSION_NOT_DRAFT; in the other order the replace wins and the publication is STALE_DRAFT', async () => {
    const { st } = await mkServiceTypeActive();
    for (const publishFirst of [true, false]) {
      const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
      const t = await rawTx();
      await t.query('SELECT gig_template_id FROM catalog.gig_templates WHERE code = $1 FOR UPDATE', [c]);
      const doPublish = () => err(publish(c, 1, revision));
      const doReplace = () => err(replaceDraft(c, 1, def(revision, { fields: stdFields().slice(0, 3) })));
      const first = publishFirst ? doPublish() : doReplace();
      await waitBlocked(1);
      const second = publishFirst ? doReplace() : doPublish();
      await waitBlocked(2);
      await t.rollback();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBeUndefined();
      expect([b!.code, b!.details.reason]).toEqual(publishFirst ? ['INVALID_STATE', 'VERSION_NOT_DRAFT'] : ['CONFLICT', 'STALE_DRAFT']);
      expect((await versionRow(c, 1)).status).toBe(publishFirst ? 'ACTIVE' : 'DRAFT');
    }
  });

  it('deterministic: a session that holds the VERSION row (not the template) and changes its revision makes a replace and a publication wait and then fail with STALE_DRAFT instead of overwriting the unseen change', async () => {
    const { st } = await mkServiceTypeActive();
    for (const op of ['replace', 'publish'] as const) {
      const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
      const t = await rawTx();
      await t.query(
        `UPDATE catalog.gig_template_versions SET revision = revision + 1, max_duration_minutes = 999
          WHERE gig_template_id = (SELECT gig_template_id FROM catalog.gig_templates WHERE code = $1)`,
        [c],
      );
      const pending = err(op === 'replace' ? replaceDraft(c, 1, def(revision, { fields: stdFields().slice(0, 2) })) : publish(c, 1, revision));
      await waitBlocked(1);
      expect((await versionRow(c, 1)).revision).toBe(revision); // nothing committed yet
      await t.commit();
      const e = (await pending)!;
      expect([e.code, e.details.reason], op).toEqual(['CONFLICT', 'STALE_DRAFT']);
      expect(await versionRow(c, 1), op).toMatchObject({ status: 'DRAFT', revision: revision + 1, max_duration_minutes: 999 });
      expect((await fieldRows(c, 1)).length, op).toBe(6);
    }
  });

  it('a row lock held longer than the lock timeout is a retryable CONFLICT (CONCURRENT_UPDATE), writes nothing, bumps nothing, and the same request succeeds once the lock is gone', async () => {
    const { st } = await mkServiceTypeActive();
    const { code: c, revision } = await mkDraftTemplate(st, { activate: true });
    const t = await rawTx();
    await t.query('SELECT gig_template_id FROM catalog.gig_templates WHERE code = $1 FOR UPDATE', [c]);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    const e = await expectError(publish(c, 1, revision), 'CONFLICT', 'CONCURRENT_UPDATE'); // the tests' pool policy waits 3 s for a lock
    expect(e.details.retryable).toBe(true);
    expect(JSON.stringify([e.message, e.details])).not.toMatch(/lock|relation|catalog\./i);
    await t.rollback();
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
    expect((await publish(c, 1, revision)).status).toBe('ACTIVE');
  }, 20_000);

  it('a genuine deadlock between the service and another session is a retryable CONFLICT for the victim and nothing half-written (or the other session is the victim and the service succeeds)', async () => {
    const env = await mkEnv();
    const c = await mkTemplate(env.st);
    await tplAvail(env.market, c, true, 'auto');
    const world = await worldHash();
    const t = await rawTx();
    // the raw session takes the availability row FIRST; the service takes the template (FOR SHARE) and then waits for that row;
    // the raw session then wants the template row itself: a cycle that only PostgreSQL's deadlock detector can break
    await t.query('SELECT 1 FROM catalog.market_gig_templates x JOIN geography.markets m USING (market_id) WHERE m.code = $1 FOR UPDATE OF x', [env.market]);
    const pending = err(tplAvail(env.market, c, false));
    await waitUntilBlocked();
    const other = t.query('UPDATE catalog.gig_templates SET description_content_key = NULL WHERE code = $1', [c]).then(
      () => undefined,
      (e: unknown) => e as { code?: string },
    );
    const [service, raw] = await Promise.all([pending, other]);
    await t.rollback();
    expect([service, raw].filter(Boolean), 'the detector aborts exactly one of the two').toHaveLength(1);
    if (service) {
      expect([service.code, service.details.reason, service.details.retryable]).toEqual(['CONFLICT', 'CONCURRENT_UPDATE', true]);
      expect(JSON.stringify([service.message, service.details])).not.toMatch(/deadlock|process|relation|catalog\./i);
      expect(await worldHash()).toBe(world);
      expect((await tplAvail(env.market, c, false)).enabled).toBe(false);
    } else expect(raw?.code).toBe('40P01');
  }, 20_000);

  it('20 parallel mutations of different templates all succeed independently', async () => {
    const env = await mkEnv();
    const cs = await Promise.all(Array.from({ length: 20 }, () => mkTemplate(env.st)));
    const out = await Promise.all(cs.map((c, i) => err(setTpl(c, 'ACTIVE').then(() => tplAvail(env.market, c, true, (i + 1) * 10)))));
    expect(out.filter(Boolean)).toEqual([]);
    expect((await bare.listGigTemplates({ marketCode: env.market, serviceTypeCode: env.st })).map((t) => t.code)).toEqual(cs);
  });
});

// ====================================================================== 14. a dead database
describe('a database that cannot answer', () => {
  it('is NOT "not found": the typed UNAVAILABLE propagates from every operation, the gate still answers first, and the log never carries the connection credentials', async () => {
    const dead = createDatabase('postgres://nobody:pw-secret-scan-0@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 800 } }); // secret-scan:allow
    try {
      const down = new GigTemplateService({ database: dead, markets: gate, env: 'test', allowTestKeys: true });
      await expectError(down.getGigTemplate('full_detail'), 'UNAVAILABLE');
      await expectError(down.listGigTemplates(), 'UNAVAILABLE');
      await expectError(down.getGigTemplateVersion('full_detail', 1), 'UNAVAILABLE');
      await expectError(down.setGigTemplateStatus('full_detail', { status: 'ACTIVE', reason: REASON }, ACTOR), 'UNAVAILABLE');
      await expectError(down.createGigTemplateVersion('full_detail', { reason: REASON }, ACTOR), 'UNAVAILABLE');
      await expectError(down.publishGigTemplateVersion('full_detail', 1, { expectedRevision: 1, reason: REASON }, ACTOR), 'UNAVAILABLE');
      await expectError(down.createGigTemplate({ code: 'devtest_down', serviceTypeCode: 'car_detailing', reason: REASON }, ACTOR), 'UNAVAILABLE');
      const e = await expectError(
        down.setMarketGigTemplateAvailability('la-oc', 'full_detail', { enabled: true, displayOrder: 1, reason: REASON }, ACTOR),
        'UNAVAILABLE',
      );
      expect(e.message).toBe('the catalogue database is unavailable');
      await expectError(down.getMarketGigTemplates('devtest-anything'), 'MARKET_NOT_FOUND'); // the gate answers before the database is asked
      const market = await mkMarket(true);
      await expectError(down.getMarketGigTemplates(market), 'UNAVAILABLE'); // cold cache, dead database
      const lines = logSink.lines.filter((l) => l.includes('catalog database unavailable'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain('pw-secret-scan-0');
        expect(line).not.toContain('nobody');
        expect(line).not.toMatch(/postgres:\/\//);
      }
    } finally {
      await dead.close();
    }
  });

  it('a dead database with a warm cache still serves the public Gig Templates (the cache is a real fast path, but the gate still decides)', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const own = new TestCache();
    const live = new GigTemplateService({ database: iso.database, markets: gate, env: 'test', cache: own });
    await live.getMarketGigTemplates(env.market);
    const dead = createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 500 } }); // secret-scan:allow
    try {
      const down = new GigTemplateService({ database: dead, markets: gate, env: 'test', cache: own });
      const r = await down.getMarketGigTemplates(env.market);
      expect(r.source).toBe('cache');
      expect(r.templates.map((x) => x.code)).toEqual([c]);
      gateState.markets.delete(env.market);
      try {
        await expectError(down.getMarketGigTemplates(env.market), 'MARKET_NOT_FOUND');
      } finally {
        gateState.markets.set(env.market, { code: env.market, defaultLocale: 'en-US' });
      }
    } finally {
      await dead.close();
    }
  });
});

// ====================================================================== 15. documented behaviour
describe("documented behaviour (not necessarily desired): the service inside a caller's transaction", () => {
  it('bumps the generation BEFORE the outer commit: a reader in between caches the old data under the new generation until the next bump', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const own = new TestCache();
    const writer = new GigTemplateService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: own, cacheDeadlineMs: 150 });
    // a second Database object is outside the caller's transaction (the transaction context belongs to the Database instance)
    const other = createDatabase(iso.url, { role: 'tests' });
    try {
      const reader = new GigTemplateService({ database: other, markets: gate, env: 'test', allowTestKeys: true, cache: own, cacheDeadlineMs: 150 });
      await writer.getMarketGigTemplates(env.market);
      const g = own.gen();
      await iso.database.transaction(async () => {
        await writer.setGigTemplateStatus(c, { status: 'INACTIVE', reason: REASON }, ACTOR);
        expect(own.gen(), 'bumped although nothing is committed').toBe(g + 1);
        expect((await templateRow(c)).status).toBe('ACTIVE'); // another connection still sees the old row
        const inBetween = await reader.getMarketGigTemplates(env.market); // misses under the new generation and loads the OLD state
        expect(inBetween.source).toBe('db');
        expect(inBetween.templates.map((x) => x.code)).toEqual([c]);
      });
      expect((await templateRow(c)).status).toBe('INACTIVE');
      const stale = await writer.getMarketGigTemplates(env.market);
      expect(stale.source).toBe('cache');
      expect(
        stale.templates.map((x) => x.code),
        'documented: stale until the next bump or the TTL',
      ).toEqual([c]);
      expect((await bare.getMarketGigTemplates(env.market)).templates).toEqual([]);
      await writer.updateGigTemplate(c, { withDescription: false, reason: REASON }, ACTOR); // no change: no bump
      expect((await writer.getMarketGigTemplates(env.market)).source).toBe('cache');
      await writer.setMarketGigTemplateAvailability(env.market, c, { enabled: false, reason: REASON }, ACTOR); // any later committed change bumps again
      expect((await writer.getMarketGigTemplates(env.market)).templates).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('linking the description or instructions AFTER publication is not checked against the published copy (the publication checks it, a later link only needs the entry to exist): the public view then names a key with no published text', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    await putContent([descKey(c), instrKey(c)], 'draft');
    await gt.updateGigTemplate(c, { withDescription: true, withInstructions: true, reason: REASON }, ACTOR);
    const t = (await bare.getGigTemplateForMarket(env.market, c)).template;
    expect([t.descriptionContentKey, t.instructionsContentKey]).toEqual([descKey(c), instrKey(c)]);
    const published = await q<{ ok: boolean }>('SELECT catalog.content_is_published(k) AS ok FROM unnest($1::text[]) AS k', [[descKey(c), instrKey(c)]]);
    expect(published.map((p) => p.ok)).toEqual([false, false]);
  });

  it('a transaction that is rolled back around the service still leaves the generation bumped (a harmless extra miss) but changes nothing else', async () => {
    const { st } = await mkServiceTypeActive();
    const c = await mkTemplate(st);
    const own = new TestCache();
    const writer = new GigTemplateService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: own });
    const world = await worldHash();
    await rejection(
      iso.database.transaction(async () => {
        await writer.setGigTemplateStatus(c, { status: 'ACTIVE', reason: REASON }, ACTOR);
        throw new Error('abort');
      }),
    );
    expect(own.gen()).toBe(1);
    expect(await worldHash()).toBe(world);
  });
});

// ====================================================================== 16. shape and privacy
describe('exact-version reads for the provider Gig (CAT-003)', () => {
  it('getGigTemplateVersionById returns the exact version with the template, service type and category facts, the field identities and the requirements, whatever the status', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const v1 = await versionRow(c, 1);
    const view = await bare.getGigTemplateVersionById(v1.gig_template_version_id as string);
    expect(view).toMatchObject({
      code: c,
      templateStatus: 'ACTIVE',
      serviceTypeCode: env.st,
      serviceTypeStatus: 'ACTIVE',
      categoryCode: env.category,
      nameContentKey: nameKey(c),
      descriptionContentKey: null,
      instructionsContentKey: null,
    });
    expect(view.gigTemplateId).toBe((await templateRow(c)).gig_template_id);
    expect(view.version).toMatchObject({
      gigTemplateVersionId: v1.gig_template_version_id,
      versionNumber: 1,
      status: 'ACTIVE',
      duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
      pricingModels: ['FIXED', 'BUNDLE_ELIGIBLE'],
    });
    expect(view.fields.map((f) => f.fieldKey)).toEqual(['scope_notes', 'finish', 'vehicles', 'photos', 'intro', 'is_mobile']);
    const stored = await fieldRows(c, 1);
    for (const f of view.fields) expect(f.gigTemplateFieldId).toBe(stored.find((r) => r.field_key === f.fieldKey)!.gig_template_field_id);
    const finish = view.fields.find((f) => f.fieldKey === 'finish')!;
    expect(finish.options.map((o) => [o.optionCode, o.isDefault])).toEqual([
      ['wax', true],
      ['sealant', false],
      ['ceramic', false],
    ]);
    expect(view.fields.find((f) => f.fieldKey === 'vehicles')).toMatchObject({
      minNumber: 1,
      maxNumber: 4,
      behavior: 'PROVIDER_REQUIRED',
      fieldType: 'INTEGER',
    });
    expect(view.requirements).toEqual([
      { requirementType: 'LICENSE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'wax_application' },
    ]);
    // a superseded version is still returned, with its own status, and the newer one is a different version
    await createDraft(c, 1);
    const v2 = await publish(c, 2, (await versionRow(c, 2)).revision as number);
    expect((await bare.getGigTemplateVersionById(v1.gig_template_version_id as string)).version.status).toBe('SUPERSEDED');
    expect((await bare.getGigTemplateVersionById(v2.gigTemplateVersionId)).version).toMatchObject({ versionNumber: 2, status: 'ACTIVE' });
    // a retired template reports the identity status and the retired version
    await setTpl(c, 'RETIRED');
    const retired = await bare.getGigTemplateVersionById(v2.gigTemplateVersionId);
    expect(retired.templateStatus).toBe('RETIRED');
    expect(retired.version.status).toBe('RETIRED');
    // an INACTIVE service type is reported as such
    await setSt(env.st, 'INACTIVE');
    expect((await bare.getGigTemplateVersionById(v2.gigTemplateVersionId)).serviceTypeStatus).toBe('INACTIVE');
    await setSt(env.st, 'ACTIVE');
  });

  it('getGigTemplateVersionById is GIG_TEMPLATE_VERSION_NOT_FOUND for an unknown or malformed id, without touching the database for a malformed one', async () => {
    await expectError(bare.getGigTemplateVersionById('00000000-0000-4000-8000-000000000000'), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    const before = statements.length;
    for (const bad of ['', 'x', "1' OR '1'='1", '00000000-0000-4000-8000-00000000000g', undefined as unknown as string, 7 as unknown as string])
      await expectError(bare.getGigTemplateVersionById(bad), 'GIG_TEMPLATE_VERSION_NOT_FOUND');
    expect(statements.length).toBe(before);
  });

  it('the read is one consistent snapshot: frame, version, fields, options, requirements, field ids, commit; it only reads', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const id = (await versionRow(c, 1)).gig_template_version_id as string;
    const r = await counting(() => bare.getGigTemplateVersionById(id));
    expect(r.sql[0]).toBe('start transaction isolation level repeatable read read only');
    expect(r.sql.at(-1)).toBe('commit');
    expect(r.sql).toHaveLength(7);
    expect(r.sql.join('\n')).not.toMatch(/\b(insert|update|delete)\b|\bfor\s+(update|share|no key update|key share)\b/i);
    expect(r.gate).toEqual([]);
  });

  it('getGigTemplateStructure returns the ACTIVE version, else the newest version that is not a draft, else not found', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    expect((await bare.getGigTemplateStructure(c)).version).toMatchObject({ versionNumber: 1, status: 'ACTIVE' });
    // a draft v2 is never returned
    await createDraft(c, 1);
    expect((await bare.getGigTemplateStructure(c)).version.versionNumber).toBe(1);
    await publish(c, 2, (await versionRow(c, 2)).revision as number);
    expect((await bare.getGigTemplateStructure(c)).version).toMatchObject({ versionNumber: 2, status: 'ACTIVE' });
    // retired: the newest non-draft version (RETIRED) is returned so a caller can say why
    await setTpl(c, 'RETIRED');
    const r = await bare.getGigTemplateStructure(c);
    expect(r).toMatchObject({ templateStatus: 'RETIRED', version: { versionNumber: 2, status: 'RETIRED' } });
    // a template that never published a version, and an unknown code, are not found
    const empty = await mkTemplate(env.st);
    await expectError(bare.getGigTemplateStructure(empty), 'GIG_TEMPLATE_NOT_FOUND');
    await expectError(bare.getGigTemplateStructure('devtest_nope'), 'GIG_TEMPLATE_NOT_FOUND');
  });

  it('isGigTemplateEnabledInMarket reflects the availability row only and is false for an unknown market, template or malformed id', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const id = (await templateRow(c)).gig_template_id as string;
    expect(await bare.isGigTemplateEnabledInMarket(env.market, id)).toBe(true);
    await tplAvail(env.market, c, false);
    expect(await bare.isGigTemplateEnabledInMarket(env.market, id)).toBe(false);
    await tplAvail(env.market, c, true);
    expect(await bare.isGigTemplateEnabledInMarket(env.market, id)).toBe(true);
    const other = await mkMarket();
    expect(await bare.isGigTemplateEnabledInMarket(other, id)).toBe(false);
    expect(await bare.isGigTemplateEnabledInMarket('nope', id)).toBe(false);
    expect(await bare.isGigTemplateEnabledInMarket(env.market, 'not-a-uuid')).toBe(false);
    expect(await bare.isGigTemplateEnabledInMarket(env.market, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('the new reads write nothing', async () => {
    const env = await mkEnv();
    const c = await mkPublic(env);
    const id = (await versionRow(c, 1)).gig_template_version_id as string;
    const before = await worldHash();
    await bare.getGigTemplateVersionById(id);
    await bare.getGigTemplateStructure(c);
    await bare.isGigTemplateEnabledInMarket(env.market, (await templateRow(c)).gig_template_id as string);
    expect(await worldHash()).toBe(before);
  });
});

describe('shape and privacy', () => {
  it('nothing provider-specific exists in the schema: the Gig Template tables hold exactly these columns (no price, floor price, chosen duration, radius, area, pitch, photo, capacity, variant, add-on, provider)', async () => {
    const cols = await q<{ table_name: string; columns: string[] }>(
      `SELECT table_name, array_agg(column_name::text COLLATE "C" ORDER BY column_name COLLATE "C") AS columns FROM information_schema.columns
        WHERE table_schema = 'catalog' AND table_name LIKE '%gig_template%' GROUP BY table_name ORDER BY table_name`,
    );
    const sorted = (l: string[]) => [...l].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(Object.fromEntries(cols.map((c) => [c.table_name, c.columns]))).toEqual({
      gig_template_field_options: sorted(['gig_template_field_id', 'option_code', 'label_content_key', 'is_default', 'display_order']),
      gig_template_fields: sorted([
        'gig_template_field_id',
        'gig_template_version_id',
        'field_key',
        'field_type',
        'section',
        'behavior',
        'customer_visible',
        'display_order',
        'label_content_key',
        'help_content_key',
        'default_content_key',
        'min_length',
        'max_length',
        'min_number',
        'max_number',
        'default_number',
        'default_boolean',
        'min_items',
        'max_items',
      ]),
      gig_template_requirements: sorted(['gig_template_requirement_id', 'gig_template_version_id', 'requirement_type', 'reference_code']),
      gig_template_versions: sorted([
        'gig_template_version_id',
        'gig_template_id',
        'version_number',
        'status',
        'revision',
        'min_duration_minutes',
        'max_duration_minutes',
        'suggested_duration_minutes',
        'pricing_fixed',
        'pricing_fixed_with_variants',
        'pricing_bundle_eligible',
        'pricing_drop_eligible',
        'pricing_add_ons',
        'area_radius',
        'area_postal_codes',
        'area_polygon',
        'created_at',
        'updated_at',
        'published_at',
        'closed_at',
      ]),
      gig_templates: sorted([
        'gig_template_id',
        'service_type_id',
        'code',
        'name_content_key',
        'description_content_key',
        'instructions_content_key',
        'status',
        'created_at',
        'updated_at',
      ]),
      market_gig_templates: sorted(['market_id', 'gig_template_id', 'enabled', 'display_order', 'created_at', 'updated_at']),
    });
    const audit = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name = 'audit_events' AND column_name LIKE 'gig_template%'`,
    );
    expect(audit.map((a) => a.column_name).sort()).toEqual(['gig_template_id', 'gig_template_version_id']);
  });

  it('every Gig Template audit row has exactly one subject shape, an actor, a reason and a correlation id, and the whole suite exercised every action', async () => {
    const rows = await q<Row>(
      'SELECT action, actor, reason, correlation_id, gig_template_id, gig_template_version_id, market_id, category_id, service_type_id, prohibited_service_id, changes FROM catalog.audit_events WHERE gig_template_id IS NOT NULL',
    );
    expect(rows.length).toBeGreaterThan(200);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      'GIG_TEMPLATE_CREATED',
      'GIG_TEMPLATE_UPDATED',
      'GIG_TEMPLATE_STATUS_CHANGED',
      'GIG_TEMPLATE_VERSION_CREATED',
      'GIG_TEMPLATE_VERSION_CHANGED',
      'GIG_TEMPLATE_VERSION_PUBLISHED',
      'GIG_TEMPLATE_VERSION_RETIRED',
      'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED',
    ])
      expect(actions.has(a), a).toBe(true);
    for (const r of rows) {
      const versioned = String(r.action).startsWith('GIG_TEMPLATE_VERSION_');
      expect(r.gig_template_version_id !== null, String(r.action)).toBe(versioned);
      expect(r.market_id !== null, String(r.action)).toBe(r.action === 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED');
      expect([r.category_id, r.service_type_id, r.prohibited_service_id]).toEqual([null, null, null]);
      expect(String(r.actor).length).toBeGreaterThan(0);
      expect(String(r.reason).length).toBeGreaterThan(0);
      expect(String(r.correlation_id).length).toBeGreaterThan(0);
    }
  });

  it("what the audit rows and events hold is identifiers, keys, counts and the admin's own reason: no copy text, no content key, no locale, no token", async () => {
    const audit = await q<{ action: string; changes: unknown }>(
      'SELECT action, changes FROM catalog.audit_events WHERE gig_template_id IS NOT NULL AND changes IS NOT NULL',
    );
    const trail = audit.map((a) => JSON.stringify(a.changes)).join('\n');
    expect(trail.length).toBeGreaterThan(1000);
    expect(trail).not.toContain(COPY_BODY);
    expect(trail).not.toMatch(/catalog\.gig_template\.|en-US|catalog integration test copy|gig template integration test copy/);
    // the diffs of a definition name fields by key and requirements by identity, nothing else
    for (const a of audit.filter((x) => x.action === 'GIG_TEMPLATE_VERSION_CHANGED')) {
      const ch = a.changes as Record<string, unknown>;
      expect(Object.keys(ch).every((k) => ['revision', 'duration', 'pricingModels', 'areaModes', 'fields', 'requirements'].includes(k))).toBe(true);
      if (ch.fields)
        for (const list of Object.values(ch.fields as Record<string, string[]>)) for (const k of list) expect(k).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
    const events = await q<OutboxRow>(`SELECT ${OUTBOX_COLS} FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.gig-template-%'`);
    expect(events.length).toBeGreaterThan(100);
    const keySets: Record<string, string[]> = {
      [GIG_TEMPLATE_EVENTS.activated]: ['gigTemplateCode', 'serviceTypeCode'],
      [GIG_TEMPLATE_EVENTS.deactivated]: ['gigTemplateCode', 'serviceTypeCode'],
      [GIG_TEMPLATE_EVENTS.retired]: ['gigTemplateCode', 'serviceTypeCode'],
      [GIG_TEMPLATE_EVENTS.published]: ['gigTemplateCode', 'gigTemplateVersionId', 'serviceTypeCode', 'versionNumber'],
      [GIG_TEMPLATE_EVENTS.availabilityChanged]: ['enabled', 'gigTemplateCode', 'marketCode'],
    };
    const idOrCode = /^([a-z][a-z0-9]*(_[a-z0-9]+)*|[a-z][a-z0-9]*(-[a-z0-9]+)*|[0-9a-f-]{36})$/;
    for (const ev of events) {
      expect(Object.keys(keySets), ev.event_type).toContain(ev.event_type);
      expect(keys(ev.payload_json), ev.event_type).toEqual(keySets[ev.event_type]);
      for (const v of Object.values(ev.payload_json)) if (typeof v === 'string') expect(v).toMatch(idOrCode);
      expect(ev).toMatchObject({ event_version: 1, actor_type: 'user', causation_id: null, published_at: null });
      expect(JSON.stringify(ev.payload_json)).not.toContain(COPY_BODY);
    }
    // the types seen are exactly the five documented ones
    expect(new Set(events.map((e) => e.event_type))).toEqual(new Set(Object.keys(keySets)));
  });

  it('no name, reason, actor or copy text was ever written to the log by the whole run (only outage lines may exist, and they carry no catalogue data)', async () => {
    const text = logSink.lines.join('\n');
    expect(text).not.toContain(ACTOR);
    expect(text).not.toContain(REASON);
    expect(text).not.toContain(COPY_BODY);
    expect(text).not.toMatch(/Full Detail|Standard Clean/);
    expect(text).not.toMatch(/devtest_t\d|devtest_s\d|devtest_c\d/);
    for (const line of logSink.lines) expect(JSON.parse(line).message).toBe('catalog database unavailable');
  });
});
