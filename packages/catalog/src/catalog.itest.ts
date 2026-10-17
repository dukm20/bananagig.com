// Integration tests of CatalogService (CAT-001) over a real, freshly migrated PostgreSQL database (migration 0015 with its guard triggers and its DRAFT seed).
//
// Written by an author who did not write the service. Everything is asserted against the rows the database holds (audit, outbox, availability), never against the
// service's own return value alone. The public market gate is a fake the test controls (the real one lives in the API composition root and asks the geography registry);
// the cache is an in-memory ConfigCache fake that can also fail, hang and lose a bump. Content entries are created by plain SQL (the catalogue package does not depend on
// the content package; the column list is the one migration 0015 uses for its own seed). Codes are unique per test (`devtest_...`), so the tests do not depend on each
// other, and the database is private to this file.
//
// Defence in depth: the guard triggers make some states impossible (an ACTIVE service type under an INACTIVE category). The snapshot query still filters on them, so those
// states are CRAFTED by disabling the user triggers as the table owner, in a committed statement, and are always restored. A filter only the triggers enforce would pass
// every other test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryConfigCache } from '@bananagig/configuration';
import { CATALOG_EVENTS, CATALOG_STATUSES, CATALOG_STATUS_TRANSITIONS, isCatalogTransitionAllowed, type CatalogStatus } from '@bananagig/contracts';
import { createDatabase, sql } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, createTestPool, deferred, rejection, sleep, type Deferred, type IsolatedDatabase } from '@bananagig/testing';
import { CatalogError, CatalogService, createCatalogScopeReferenceValidator, type MarketGate, type PublicMarket } from './index';

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
let svc: CatalogService; // with the cache
let bare: CatalogService; // without a cache: the truth-table tests do not depend on cache correctness
let strict: CatalogService; // allowTestKeys off

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { overrides: { poolMax: 40, connectionTimeoutMs: 30_000 }, onQuery: (e) => statements.push(e.sql) } });
  pool = createTestPool(iso.url, 10);
  cache = new TestCache();
  const deps = { database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cacheDeadlineMs: 150 };
  svc = new CatalogService({ ...deps, cache });
  bare = new CatalogService(deps);
  strict = new CatalogService({ ...deps, allowTestKeys: false });
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
const nextOrder = (market: string, kind: 'c' | 's'): number => {
  const k = `${market}/${kind}`;
  const v = (orders.get(k) ?? 0) + 10;
  orders.set(k, v);
  return v;
};

async function addContent(
  kind: 'category' | 'service_type' | 'prohibited_service',
  c: string,
  opts: { name?: boolean; description?: boolean } = {},
): Promise<void> {
  const stem = `catalog.${kind}.${c}`;
  const keys: string[] = [];
  const types: string[] = [];
  if (opts.name !== false) {
    keys.push(`${stem}.name`);
    types.push('UI_LABEL');
  }
  if (opts.description) {
    keys.push(`${stem}.description`);
    types.push('PLAIN_TEXT');
  }
  if (keys.length === 0) return;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT u.k, u.t, 'CONTENT', 'catalog integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'catalog-itest' FROM unnest($1::text[], $2::text[]) AS u (k, t)
     ON CONFLICT (key) DO NOTHING`,
    [keys, types],
  );
}
async function mkCategory(o: { code?: string; withDescription?: boolean; iconKey?: string | null; via?: CatalogService } = {}): Promise<string> {
  const c = o.code ?? code('c');
  await addContent('category', c, { description: o.withDescription });
  await (o.via ?? svc).createCategory(
    {
      code: c,
      reason: REASON,
      ...(o.withDescription !== undefined ? { withDescription: o.withDescription } : {}),
      ...(o.iconKey !== undefined ? { iconKey: o.iconKey } : {}),
    },
    ACTOR,
  );
  return c;
}
async function mkServiceType(categoryCode: string, o: { code?: string; withDescription?: boolean; via?: CatalogService } = {}): Promise<string> {
  const c = o.code ?? code('s');
  await addContent('service_type', c, { description: o.withDescription });
  await (o.via ?? svc).createServiceType(
    { code: c, categoryCode, reason: REASON, ...(o.withDescription !== undefined ? { withDescription: o.withDescription } : {}) },
    ACTOR,
  );
  return c;
}
async function mkProhibited(o: { code?: string; categoryCode?: string | null; withDescription?: boolean } = {}): Promise<string> {
  const c = o.code ?? code('p');
  await addContent('prohibited_service', c, { description: o.withDescription });
  await svc.createProhibitedService(
    {
      code: c,
      reason: REASON,
      ...(o.categoryCode !== undefined ? { categoryCode: o.categoryCode } : {}),
      ...(o.withDescription !== undefined ? { withDescription: o.withDescription } : {}),
    },
    ACTOR,
  );
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
const setCat = (c: string, status: CatalogStatus, via: CatalogService = svc) => via.setCategoryStatus(c, { status, reason: REASON }, ACTOR);
const setSt = (c: string, status: CatalogStatus, via: CatalogService = svc) => via.setServiceTypeStatus(c, { status, reason: REASON }, ACTOR);
const catAvail = (market: string, c: string, enabled: boolean, displayOrder?: number | 'auto', via: CatalogService = svc) =>
  via.setMarketCategoryAvailability(
    market,
    c,
    { enabled, ...(displayOrder === undefined ? {} : { displayOrder: displayOrder === 'auto' ? nextOrder(market, 'c') : displayOrder }), reason: REASON },
    ACTOR,
  );
const stAvail = (market: string, c: string, enabled: boolean, displayOrder?: number | 'auto', via: CatalogService = svc) =>
  via.setMarketServiceTypeAvailability(
    market,
    c,
    { enabled, ...(displayOrder === undefined ? {} : { displayOrder: displayOrder === 'auto' ? nextOrder(market, 's') : displayOrder }), reason: REASON },
    ACTOR,
  );

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
  changes: Record<string, unknown[]> | null;
  reason: string;
  correlation_id: string;
}
const AUDIT_COLS = 'a.action, a.actor, a.changes, a.reason, a.correlation_id';
const categoryAudit = (c: string) =>
  q<AuditRow>(
    `SELECT ${AUDIT_COLS} FROM catalog.audit_events a JOIN catalog.categories x ON x.category_id = a.category_id WHERE x.code = $1 AND a.action LIKE 'CATEGORY\\_%' ORDER BY a.occurred_at, a.audit_event_id`,
    [c],
  );
const serviceTypeAudit = (c: string) =>
  q<AuditRow>(
    `SELECT ${AUDIT_COLS} FROM catalog.audit_events a JOIN catalog.service_types x ON x.service_type_id = a.service_type_id WHERE x.code = $1 AND a.action LIKE 'SERVICE\\_TYPE\\_%' ORDER BY a.occurred_at, a.audit_event_id`,
    [c],
  );
const prohibitedAudit = (c: string) =>
  q<AuditRow>(
    `SELECT ${AUDIT_COLS} FROM catalog.audit_events a JOIN catalog.prohibited_services x ON x.prohibited_service_id = a.prohibited_service_id WHERE x.code = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [c],
  );
const availabilityAudit = (market: string, kind: 'CATEGORY' | 'SERVICE_TYPE', c: string) =>
  q<AuditRow & { has_category: boolean; has_service_type: boolean }>(
    kind === 'CATEGORY'
      ? `SELECT ${AUDIT_COLS}, a.category_id IS NOT NULL AS has_category, a.service_type_id IS NOT NULL AS has_service_type FROM catalog.audit_events a
           JOIN geography.markets m ON m.market_id = a.market_id JOIN catalog.categories x ON x.category_id = a.category_id WHERE m.code = $1 AND x.code = $2 ORDER BY a.occurred_at, a.audit_event_id`
      : `SELECT ${AUDIT_COLS}, a.category_id IS NOT NULL AS has_category, a.service_type_id IS NOT NULL AS has_service_type FROM catalog.audit_events a
           JOIN geography.markets m ON m.market_id = a.market_id JOIN catalog.service_types x ON x.service_type_id = a.service_type_id WHERE m.code = $1 AND x.code = $2 ORDER BY a.occurred_at, a.audit_event_id`,
    [market, c],
  );
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
const eventsWhere = (type: string, payload: Record<string, unknown>) =>
  q<OutboxRow>(
    `SELECT ${OUTBOX_COLS} FROM integration.outbox_events WHERE event_type = $1 AND payload_json @> $2::jsonb ORDER BY created_at, payload_json->>'code'`,
    [type, JSON.stringify(payload)],
  );
const catalogEvents = () =>
  q<OutboxRow>(`SELECT ${OUTBOX_COLS} FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%' ORDER BY created_at`);
const counts = async () => ({
  audit: (await one<{ n: number }>('SELECT count(*)::int AS n FROM catalog.audit_events')).n,
  events: (await one<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%'")).n,
});
/** Every catalogue row and the catalogue's events, as one string: equal before and after means nothing was written. */
const worldHash = async (): Promise<string> =>
  (
    await one<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY category_id), '[]') FROM catalog.categories t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY service_type_id), '[]') FROM catalog.service_types t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY prohibited_service_id), '[]') FROM catalog.prohibited_services t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY market_id, category_id), '[]') FROM catalog.market_categories t)::text,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY market_id, service_type_id), '[]') FROM catalog.market_service_types t)::text,
      (SELECT count(*) FROM catalog.audit_events)::text,
      (SELECT count(*) FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%')::text)) AS h`)
  ).h;
const dbStatus = async (table: 'categories' | 'service_types' | 'prohibited_services', c: string) =>
  (await one<{ status: string }>(`SELECT status FROM catalog.${table} WHERE code = $1`, [c])).status;
const mcRow = (market: string, c: string) =>
  q<{ enabled: boolean; display_order: number }>(
    `SELECT mc.enabled, mc.display_order FROM catalog.market_categories mc JOIN geography.markets m ON m.market_id = mc.market_id JOIN catalog.categories x ON x.category_id = mc.category_id WHERE m.code = $1 AND x.code = $2`,
    [market, c],
  );
const mstRow = (market: string, c: string) =>
  q<{ enabled: boolean; display_order: number }>(
    `SELECT mc.enabled, mc.display_order FROM catalog.market_service_types mc JOIN geography.markets m ON m.market_id = mc.market_id JOIN catalog.service_types x ON x.service_type_id = mc.service_type_id WHERE m.code = $1 AND x.code = $2`,
    [market, c],
  );

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
/** A raw session with an open transaction (to hold a lock exactly where a test needs it). */
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

// ====================================================================== 1. seed
describe('the seeded taxonomy', () => {
  it('migration 0015 seeds 2 DRAFT categories, 4 DRAFT service types, 6 audit rows by system:migration, no availability and no prohibited services', async () => {
    const cats = await bare.listCategories();
    expect(cats.map((c) => [c.code, c.status])).toEqual([
      ['auto_services', 'DRAFT'],
      ['home_cleaning', 'DRAFT'],
    ]);
    const sts = await bare.listServiceTypes();
    expect(sts.map((s) => [s.code, s.categoryCode, s.status]).sort()).toEqual(
      [
        ['car_detailing', 'auto_services', 'DRAFT'],
        ['deep_cleaning', 'home_cleaning', 'DRAFT'],
        ['mobile_car_wash', 'auto_services', 'DRAFT'],
        ['regular_cleaning', 'home_cleaning', 'DRAFT'],
      ].sort(),
    );
    expect(await bare.listProhibitedServices()).toEqual([]);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM catalog.market_categories')).n).toBe(0);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM catalog.market_service_types')).n).toBe(0);
    const audit = await q<{ actor: string; action: string; reason: string }>(
      "SELECT actor, action, reason FROM catalog.audit_events WHERE actor = 'system:migration' AND action NOT LIKE 'GIG\\_TEMPLATE\\_%' ORDER BY action, audit_event_id",
    );
    expect(audit).toHaveLength(6);
    expect(new Set(audit.map((a) => a.actor))).toEqual(new Set(['system:migration']));
    expect(audit.filter((a) => a.action === 'CATEGORY_CREATED')).toHaveLength(2);
    expect(audit.filter((a) => a.action === 'SERVICE_TYPE_CREATED')).toHaveLength(4);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%'")).n).toBe(0);
  });

  it('nothing seeded is public: a public market shows an empty catalogue, and the seeded names exist as managed content', async () => {
    const m = await mkMarket(true);
    expect(await bare.getMarketCatalog(m)).toMatchObject({ categories: [], serviceTypes: [] });
    const names = await q<{ key: string }>("SELECT key FROM content.entries WHERE key LIKE 'catalog.%' ORDER BY key");
    // 12 taxonomy entries (0015) + 6 Gig Template entries (0016)
    expect(names.filter((n) => !n.key.includes('devtest_') && !n.key.startsWith('catalog.gig_template.'))).toHaveLength(12);
    expect(names.filter((n) => n.key.startsWith('catalog.gig_template.'))).toHaveLength(6);
    const view = await bare.getCategory('auto_services');
    expect(view.nameContentKey).toBe('catalog.category.auto_services.name');
    expect(view.descriptionContentKey).toBe('catalog.category.auto_services.description');
  });
});

// ====================================================================== 2. public visibility truth table
describe('public visibility', () => {
  it('a market that is not public is MARKET_NOT_FOUND for EVERY public read, whatever it holds, and the same error for unknown and planned markets', async () => {
    const planned = await mkMarket(false); // exists, has data, but the gate says no
    const c = await mkCategory();
    await setCat(c, 'ACTIVE');
    await catAvail(planned, c, true, 10);
    const reads: [string, (m: string) => Promise<unknown>][] = [
      ['getMarketCatalog', (m) => bare.getMarketCatalog(m)],
      ['listCategoriesForMarket', (m) => bare.listCategoriesForMarket(m)],
      ['listServiceTypesForMarket', (m) => bare.listServiceTypesForMarket(m)],
      ['listServiceTypesForMarket by category', (m) => bare.listServiceTypesForMarket(m, { categoryCode: c })],
      ['getCategoryForMarket', (m) => bare.getCategoryForMarket(m, c)],
      ['getServiceTypeForMarket', (m) => bare.getServiceTypeForMarket(m, c)],
    ];
    const world = await worldHash();
    for (const m of [planned, 'la-oc', 'devtest-nowhere', 'LA-OC', '', "x'; DROP TABLE catalog.categories;--"]) {
      for (const [name, read] of reads) {
        const e = await expectError(read(m), 'MARKET_NOT_FOUND');
        expect(e.message, name).toBe('the market is not available');
        expect(JSON.stringify(e.details)).not.toMatch(/PLANNED|status/);
      }
    }
    expect(await worldHash()).toBe(world);
    // the catalogue of the same market becomes readable the moment the gate says so
    gateState.markets.set(planned, { code: planned, defaultLocale: 'en-US' });
    expect((await bare.getMarketCatalog(planned)).categories.map((x) => x.code)).toEqual([c]);
    gateState.markets.delete(planned);
    await expectError(bare.getMarketCatalog(planned), 'MARKET_NOT_FOUND');
  });

  it('the full truth table: a category is public iff ACTIVE and enabled; a service type iff ACTIVE and enabled under an ACTIVE enabled category (every reachable combination)', async () => {
    const market = await mkMarket(true);
    const FLAGS = ['absent', 'false', 'true'] as const;
    type Flag = (typeof FLAGS)[number];
    interface ModelSt {
      code: string;
      ss: CatalogStatus;
      sf: Flag;
      order: number | null;
    }
    interface ModelCat {
      code: string;
      cs: CatalogStatus;
      cf: Flag;
      order: number | null;
      sts: ModelSt[];
    }
    const allowedSt = (cs: CatalogStatus): CatalogStatus[] =>
      cs === 'ACTIVE'
        ? ['DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED']
        : cs === 'INACTIVE'
          ? ['DRAFT', 'INACTIVE', 'RETIRED']
          : cs === 'DRAFT'
            ? ['DRAFT', 'RETIRED']
            : ['RETIRED'];
    const model: ModelCat[] = [];
    for (const cs of CATALOG_STATUSES) {
      for (const cf of FLAGS) {
        const cat: ModelCat = { code: await mkCategory(), cs, cf, order: null, sts: [] };
        if (cf !== 'absent') {
          cat.order = nextOrder(market, 'c');
          await catAvail(market, cat.code, cf === 'true', cat.order);
        }
        for (const ss of allowedSt(cs))
          for (const sf of FLAGS) {
            if (sf === 'true' && cf !== 'true') continue; // the guard: a service type is enabled only under an enabled category
            const st: ModelSt = { code: await mkServiceType(cat.code), ss, sf, order: null };
            if (sf !== 'absent') {
              st.order = nextOrder(market, 's');
              await stAvail(market, st.code, sf === 'true', st.order);
            }
            cat.sts.push(st);
          }
        if (cs === 'ACTIVE' || cs === 'INACTIVE') await setCat(cat.code, 'ACTIVE');
        for (const st of cat.sts) {
          if (st.ss === 'ACTIVE') await setSt(st.code, 'ACTIVE');
          if (st.ss === 'INACTIVE') {
            await setSt(st.code, 'ACTIVE');
            await setSt(st.code, 'INACTIVE');
          }
          if (st.ss === 'RETIRED') await setSt(st.code, 'RETIRED');
        }
        if (cs === 'INACTIVE') await setCat(cat.code, 'INACTIVE');
        if (cs === 'RETIRED') await setCat(cat.code, 'RETIRED');
        model.push(cat);
      }
    }
    expect(model.length).toBe(12);
    const stCount = model.reduce((n, c) => n + c.sts.length, 0);
    expect(stCount).toBeGreaterThan(40);
    // the model must equal the database (the combinations were really reached)
    for (const cat of model) {
      expect(await dbStatus('categories', cat.code)).toBe(cat.cs);
      for (const st of cat.sts) expect(await dbStatus('service_types', st.code)).toBe(st.ss);
    }
    // the oracle, independent of the service's SQL
    const visibleCats = model.filter((c) => c.cs === 'ACTIVE' && c.cf === 'true').sort((a, b) => a.order! - b.order!);
    const visibleSts = model
      .filter((c) => c.cs === 'ACTIVE' && c.cf === 'true')
      .flatMap((c) => c.sts.filter((s) => s.ss === 'ACTIVE' && s.sf === 'true'))
      .sort((a, b) => a.order! - b.order!);
    expect(visibleCats.length).toBeGreaterThan(0);
    expect(visibleSts.length).toBeGreaterThan(0);
    expect(visibleCats.length).toBeLessThan(model.length);
    expect(visibleSts.length).toBeLessThan(stCount);
    const catalog = await bare.getMarketCatalog(market);
    expect(catalog.categories.map((c) => [c.code, c.displayOrder])).toEqual(visibleCats.map((c) => [c.code, c.order]));
    expect(catalog.serviceTypes.map((s) => [s.code, s.displayOrder])).toEqual(visibleSts.map((s) => [s.code, s.order]));
    // the single reads agree with the list, for every item of the model (visible ones succeed, all others are not found)
    for (const cat of model) {
      const visible = visibleCats.includes(cat);
      if (visible) expect((await bare.getCategoryForMarket(market, cat.code)).category.code).toBe(cat.code);
      else await expectError(bare.getCategoryForMarket(market, cat.code), 'CATEGORY_NOT_FOUND');
      for (const st of cat.sts) {
        if (visibleSts.includes(st)) expect((await bare.getServiceTypeForMarket(market, st.code)).serviceType.categoryCode).toBe(cat.code);
        else await expectError(bare.getServiceTypeForMarket(market, st.code), 'SERVICE_TYPE_NOT_FOUND');
      }
    }
    // the same list through the category filter, and through listCategoriesForMarket
    for (const cat of model)
      expect((await bare.listServiceTypesForMarket(market, { categoryCode: cat.code })).serviceTypes.map((s) => s.code)).toEqual(
        visibleSts.filter((s) => cat.sts.includes(s)).map((s) => s.code),
      );
    expect((await bare.listCategoriesForMarket(market)).categories.map((c) => c.code)).toEqual(visibleCats.map((c) => c.code));
    expect((await bare.listServiceTypesForMarket(market)).serviceTypes.map((s) => s.code)).toEqual(visibleSts.map((s) => s.code));
    // the management view of the same market lists EVERYTHING with its true status and flag
    const mgmt = await bare.listCategories({ marketCode: market });
    for (const cat of model) {
      const view = mgmt.find((c) => c.code === cat.code)!;
      expect(view.status).toBe(cat.cs);
      if (cat.cf === 'absent') {
        expect(view).not.toHaveProperty('enabled');
        expect(view.displayOrder).toBeNull();
      } else {
        expect(view.enabled).toBe(cat.cf === 'true');
        expect(view.displayOrder).toBe(cat.order);
      }
    }
  }, 180_000);

  it('hides a service type whose CATEGORY is not ACTIVE or not enabled in the market, even when the guards were bypassed (the snapshot filters on both itself)', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    await catAvail(market, c, true, 10);
    await stAvail(market, s, true, 10);
    await setSt(s, 'ACTIVE');
    expect((await bare.getMarketCatalog(market)).serviceTypes.map((x) => x.code)).toEqual([s]);
    // crafted 1: the category is INACTIVE while its service type stays ACTIVE and enabled
    await withoutTriggers(['catalog.categories'], async () => {
      await q("UPDATE catalog.categories SET status = 'INACTIVE' WHERE code = $1", [c]);
      try {
        const snap = await bare.getMarketCatalog(market);
        expect(snap.categories).toEqual([]);
        expect(snap.serviceTypes, 'a service type under an INACTIVE category must not be public').toEqual([]);
      } finally {
        await q("UPDATE catalog.categories SET status = 'ACTIVE' WHERE code = $1", [c]);
      }
    });
    expect((await bare.getMarketCatalog(market)).serviceTypes.map((x) => x.code)).toEqual([s]);
    // crafted 2: the category is switched off in the market while its service type stays enabled
    await withoutTriggers(['catalog.market_categories'], async () => {
      await q('UPDATE catalog.market_categories SET enabled = false WHERE category_id = (SELECT category_id FROM catalog.categories WHERE code = $1)', [c]);
      try {
        const snap = await bare.getMarketCatalog(market);
        expect(snap.categories).toEqual([]);
        expect(snap.serviceTypes, 'a service type under a category that is not enabled in the market must not be public').toEqual([]);
      } finally {
        await q('UPDATE catalog.market_categories SET enabled = true WHERE category_id = (SELECT category_id FROM catalog.categories WHERE code = $1)', [c]);
      }
    });
    // crafted 3: the category has no availability row at all in the market
    await withoutTriggers(['catalog.market_categories'], async () => {
      const saved = await one<{ category_id: string; market_id: string; display_order: number }>(
        'SELECT category_id, market_id, display_order FROM catalog.market_categories WHERE category_id = (SELECT category_id FROM catalog.categories WHERE code = $1)',
        [c],
      );
      await q('DELETE FROM catalog.market_categories WHERE category_id = $1 AND market_id = $2', [saved.category_id, saved.market_id]);
      try {
        expect((await bare.getMarketCatalog(market)).serviceTypes).toEqual([]);
      } finally {
        await q('INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
          saved.market_id,
          saved.category_id,
          saved.display_order,
        ]);
      }
    });
    expect((await bare.getMarketCatalog(market)).serviceTypes.map((x) => x.code)).toEqual([s]);
  });

  it('every public view has exactly the public key set; the market is the one the gate returned', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory({ withDescription: true, iconKey: 'sparkles' });
    const s = await mkServiceType(c, { withDescription: true });
    await setCat(c, 'ACTIVE');
    await catAvail(market, c, true, 10);
    await stAvail(market, s, true, 10);
    await setSt(s, 'ACTIVE');
    const { market: m, categories, serviceTypes } = await bare.getMarketCatalog(market);
    expect(m).toEqual({ code: market, defaultLocale: 'en-US' });
    expect(keys(categories[0]!)).toEqual(['categoryId', 'code', 'descriptionContentKey', 'displayOrder', 'iconKey', 'nameContentKey']);
    expect(keys(serviceTypes[0]!)).toEqual(['categoryCode', 'code', 'descriptionContentKey', 'displayOrder', 'nameContentKey', 'serviceTypeId']);
    expect(categories[0]).toMatchObject({
      code: c,
      nameContentKey: `catalog.category.${c}.name`,
      descriptionContentKey: `catalog.category.${c}.description`,
      iconKey: 'sparkles',
      displayOrder: 10,
    });
    expect(serviceTypes[0]).toMatchObject({
      code: s,
      categoryCode: c,
      nameContentKey: `catalog.service_type.${s}.name`,
      descriptionContentKey: `catalog.service_type.${s}.description`,
      displayOrder: 10,
    });
    expect(categories[0]!.categoryId).toMatch(/^[0-9a-f-]{36}$/);
    const one1 = await bare.getCategoryForMarket(market, c);
    expect(keys(one1.category)).toEqual(keys(categories[0]!));
    expect(Object.keys(one1).sort()).toEqual(['category', 'market']);
    expect(Object.keys(await bare.getServiceTypeForMarket(market, s)).sort()).toEqual(['market', 'serviceType']);
    expect(Object.keys(await bare.listCategoriesForMarket(market)).sort()).toEqual(['categories', 'market']);
    expect(Object.keys(await bare.listServiceTypesForMarket(market)).sort()).toEqual(['market', 'serviceTypes']);
    expect(keys(await bare.getMarketCatalog(market))).toEqual(['categories', 'market', 'serviceTypes', 'source']);
  });

  it('order follows the MARKET: the same category sits at different positions in two markets, and each market is ordered by its own display_order, not by code', async () => {
    const m1 = await mkMarket(true);
    const m2 = await mkMarket(true);
    const a = await mkCategory({ code: code('ca') });
    const b = await mkCategory({ code: code('cb') });
    const c = await mkCategory({ code: code('cc') });
    for (const x of [a, b, c]) await setCat(x, 'ACTIVE');
    // M1 order: c, a, b   (code order would be a, b, c)
    await catAvail(m1, a, true, 20);
    await catAvail(m1, b, true, 30);
    await catAvail(m1, c, true, 10);
    // M2 order: b, c, a, with the SAME numbers reused by other categories than in M1
    await catAvail(m2, a, true, 30);
    await catAvail(m2, b, true, 10);
    await catAvail(m2, c, true, 20);
    expect((await bare.listCategoriesForMarket(m1)).categories.map((x) => [x.code, x.displayOrder])).toEqual([
      [c, 10],
      [a, 20],
      [b, 30],
    ]);
    expect((await bare.listCategoriesForMarket(m2)).categories.map((x) => [x.code, x.displayOrder])).toEqual([
      [b, 10],
      [c, 20],
      [a, 30],
    ]);
    expect((await bare.getCategoryForMarket(m1, a)).category.displayOrder).toBe(20);
    expect((await bare.getCategoryForMarket(m2, a)).category.displayOrder).toBe(30);
    // service types: three under one category, ordered per market independently of their codes
    const s1 = await mkServiceType(a);
    const s2 = await mkServiceType(a);
    const s3 = await mkServiceType(a);
    for (const s of [s1, s2, s3]) await setSt(s, 'ACTIVE');
    await stAvail(m1, s1, true, 30);
    await stAvail(m1, s2, true, 10);
    await stAvail(m1, s3, true, 20);
    await stAvail(m2, s1, true, 10);
    await stAvail(m2, s3, true, 20);
    expect((await bare.listServiceTypesForMarket(m1)).serviceTypes.map((x) => x.code)).toEqual([s2, s3, s1]);
    expect((await bare.listServiceTypesForMarket(m2)).serviceTypes.map((x) => x.code)).toEqual([s1, s3]);
    // a change of order in M1 leaves M2 alone
    await catAvail(m1, a, true, 5);
    expect((await bare.listCategoriesForMarket(m1)).categories.map((x) => x.code)).toEqual([a, c, b]);
    expect((await bare.listCategoriesForMarket(m2)).categories.map((x) => x.code)).toEqual([b, c, a]);
  });

  it('a category filter on the service types lists only that category in the market order; an unknown or hidden category lists nothing (no error, no leak)', async () => {
    const market = await mkMarket(true);
    const a = await mkCategory();
    const b = await mkCategory();
    const hidden = await mkCategory(); // DRAFT
    for (const x of [a, b]) await setCat(x, 'ACTIVE');
    for (const x of [a, b, hidden]) await catAvail(market, x, true, 'auto');
    const sa1 = await mkServiceType(a);
    const sb1 = await mkServiceType(b);
    const sa2 = await mkServiceType(a);
    const sh = await mkServiceType(hidden);
    for (const s of [sa1, sb1, sa2]) await setSt(s, 'ACTIVE');
    await stAvail(market, sa1, true, 'auto'); // order 10
    await stAvail(market, sb1, true, 'auto'); // 20
    await stAvail(market, sa2, true, 'auto'); // 30
    await stAvail(market, sh, true, 'auto');
    expect((await bare.listServiceTypesForMarket(market)).serviceTypes.map((x) => x.code)).toEqual([sa1, sb1, sa2]);
    expect((await bare.listServiceTypesForMarket(market, { categoryCode: a })).serviceTypes.map((x) => x.code)).toEqual([sa1, sa2]);
    expect((await bare.listServiceTypesForMarket(market, { categoryCode: b })).serviceTypes.map((x) => x.code)).toEqual([sb1]);
    for (const cc of [hidden, 'devtest_nothing', 'Bad Code'])
      expect((await bare.listServiceTypesForMarket(market, { categoryCode: cc })).serviceTypes).toEqual([]);
  });

  it('the not-found answers for a hidden item do not reveal why (same message and the same details shape for DRAFT, INACTIVE, RETIRED, disabled and absent)', async () => {
    const market = await mkMarket(true);
    const draft = await mkCategory();
    const inactive = await mkCategory();
    const retired = await mkCategory();
    const disabled = await mkCategory();
    const absent = await mkCategory();
    await setCat(inactive, 'ACTIVE');
    await setCat(inactive, 'INACTIVE');
    await setCat(retired, 'RETIRED');
    await setCat(disabled, 'ACTIVE');
    for (const x of [draft, inactive, disabled]) await catAvail(market, x, x !== disabled, 'auto');
    const errors: CatalogError[] = [];
    for (const x of [draft, inactive, retired, disabled, absent, 'devtest_unknown'])
      errors.push(await expectError(bare.getCategoryForMarket(market, x), 'CATEGORY_NOT_FOUND'));
    expect(new Set(errors.map((e) => e.message)).size).toBe(1);
    expect(new Set(errors.map((e) => JSON.stringify(Object.keys(e.details)))).size).toBe(1);
  });
});

// ====================================================================== 3. management reads
describe('management reads', () => {
  it('every status is listed globally (ordered by code, no market fields) with the full management key set', async () => {
    const draft = await mkCategory({ withDescription: true, iconKey: 'a-b' });
    const active = await mkCategory();
    const inactive = await mkCategory();
    const retired = await mkCategory();
    await setCat(active, 'ACTIVE');
    await setCat(inactive, 'ACTIVE');
    await setCat(inactive, 'INACTIVE');
    await setCat(retired, 'RETIRED');
    const all = await bare.listCategories();
    const mine = [draft, active, inactive, retired];
    expect(all.filter((c) => mine.includes(c.code)).map((c) => [c.code, c.status])).toEqual(
      [draft, active, inactive, retired].sort().map((c) => [c, { [draft]: 'DRAFT', [active]: 'ACTIVE', [inactive]: 'INACTIVE', [retired]: 'RETIRED' }[c]]),
    );
    const v = all.find((c) => c.code === draft)!;
    expect(keys(v)).toEqual(['categoryId', 'code', 'createdAt', 'descriptionContentKey', 'displayOrder', 'iconKey', 'nameContentKey', 'status', 'updatedAt']);
    expect(v.displayOrder).toBeNull();
    expect(v.iconKey).toBe('a-b');
    expect(new Date(v.createdAt!).toISOString()).toBe(v.createdAt);
    const one1 = await bare.getCategory(retired);
    expect(one1.status).toBe('RETIRED');
    expect(keys(one1)).toEqual(keys(v));
  });

  it('with a market: availability and order of every category, disabled rows listed with enabled:false, rows without availability last (by code) with no enabled key; a PLANNED market can be inspected', async () => {
    const planned = 'la-oc';
    expect(gateState.markets.has(planned)).toBe(false);
    const a = await mkCategory();
    const b = await mkCategory();
    const c = await mkCategory();
    const d = await mkCategory();
    await catAvail(planned, a, true, 900 + (seq % 90));
    await catAvail(planned, b, false, 800 + (seq % 90));
    await catAvail(planned, c, true, 700 + (seq % 90));
    const list = (await bare.listCategories({ marketCode: planned })).filter((x) => [a, b, c, d].includes(x.code));
    expect(list.map((x) => x.code)).toEqual([c, b, a, d]); // by display order, then the unconfigured by code
    expect(list.map((x) => x.enabled)).toEqual([true, false, true, undefined]);
    expect(list[3]).not.toHaveProperty('enabled');
    expect(list[3]!.displayOrder).toBeNull();
    expect(list[0]!.displayOrder).toBe(700 + (seq % 90));
    expect(keys(list[0]!)).toEqual([
      'categoryId',
      'code',
      'createdAt',
      'descriptionContentKey',
      'displayOrder',
      'enabled',
      'iconKey',
      'nameContentKey',
      'status',
      'updatedAt',
    ]);
    expect((await bare.getCategory(b, { marketCode: planned })).enabled).toBe(false);
    expect(await bare.getCategory(d, { marketCode: planned })).not.toHaveProperty('enabled');
    // the same market is not public
    await expectError(bare.getMarketCatalog(planned), 'MARKET_NOT_FOUND');
  });

  it('service types: global list, by category, with a market (order, enabled:false rows, rows without availability last), and the single read', async () => {
    const market = await mkMarket(false);
    const c1 = await mkCategory();
    const c2 = await mkCategory();
    await catAvail(market, c1, true, 'auto');
    const sa = await mkServiceType(c1);
    const sb = await mkServiceType(c1);
    const sc = await mkServiceType(c1);
    const sx = await mkServiceType(c2);
    await stAvail(market, sa, true, 30);
    await stAvail(market, sb, false, 20);
    const global = (await bare.listServiceTypes()).filter((s) => [sa, sb, sc, sx].includes(s.code));
    const byCategoryThenCode = (rows: { code: string; cat: string }[]) =>
      rows.sort((p, r) => (p.cat < r.cat ? -1 : p.cat > r.cat ? 1 : p.code < r.code ? -1 : p.code > r.code ? 1 : 0)).map((r) => r.code);
    const cat = { [sa]: c1, [sb]: c1, [sc]: c1, [sx]: c2 } as Record<string, string>;
    expect(global.map((s) => s.code)).toEqual(byCategoryThenCode([sa, sb, sc, sx].map((code0) => ({ code: code0, cat: cat[code0]! }))));
    expect(global.every((s) => s.displayOrder === null && !('enabled' in s))).toBe(true);
    const withMarket = (await bare.listServiceTypes({ marketCode: market })).filter((s) => [sa, sb, sc, sx].includes(s.code));
    const unconfigured = byCategoryThenCode([sc, sx].map((code0) => ({ code: code0, cat: cat[code0]! })));
    expect(withMarket.map((s) => s.code)).toEqual([sb, sa, ...unconfigured]);
    expect(withMarket.map((s) => s.enabled)).toEqual([false, true, undefined, undefined]);
    expect(withMarket.map((s) => s.displayOrder)).toEqual([20, 30, null, null]);
    const filtered = await bare.listServiceTypes({ marketCode: market, categoryCode: c1 });
    expect(filtered.map((s) => s.code)).toEqual([sb, sa, sc]);
    expect((await bare.listServiceTypes({ categoryCode: c2 })).map((s) => s.code)).toEqual([sx]);
    expect(await bare.listServiceTypes({ categoryCode: 'devtest_nothing' })).toEqual([]);
    const v = await bare.getServiceType(sa, { marketCode: market });
    expect(keys(v)).toEqual([
      'categoryCode',
      'code',
      'createdAt',
      'descriptionContentKey',
      'displayOrder',
      'enabled',
      'nameContentKey',
      'serviceTypeId',
      'status',
      'updatedAt',
    ]);
    expect(v).toMatchObject({ code: sa, categoryCode: c1, status: 'DRAFT', enabled: true, displayOrder: 30 });
    expect(keys(await bare.getServiceType(sa))).toEqual([
      'categoryCode',
      'code',
      'createdAt',
      'descriptionContentKey',
      'displayOrder',
      'nameContentKey',
      'serviceTypeId',
      'status',
      'updatedAt',
    ]);
  });

  it('an unknown market or a malformed market code is MARKET_NOT_FOUND on the management reads; unknown codes are typed not-found errors', async () => {
    for (const m of ['devtest-missing', 'LA-OC', '', 'a'.repeat(61), "x'--"]) {
      await expectError(bare.listCategories({ marketCode: m }), 'MARKET_NOT_FOUND');
      await expectError(bare.getCategory('home_cleaning', { marketCode: m }), 'MARKET_NOT_FOUND');
      await expectError(bare.listServiceTypes({ marketCode: m }), 'MARKET_NOT_FOUND');
      await expectError(bare.getServiceType('deep_cleaning', { marketCode: m }), 'MARKET_NOT_FOUND');
    }
    await expectError(bare.getCategory('devtest_nothing'), 'CATEGORY_NOT_FOUND');
    await expectError(bare.getServiceType('devtest_nothing'), 'SERVICE_TYPE_NOT_FOUND');
    await expectError(bare.getProhibitedService('devtest_nothing'), 'PROHIBITED_SERVICE_NOT_FOUND');
    await expectError(bare.getCategory('car_detailing'), 'CATEGORY_NOT_FOUND'); // a service type code is not a category
    await expectError(bare.getServiceType('auto_services'), 'SERVICE_TYPE_NOT_FOUND');
  });

  it('codes that look like SQL, traversal or unicode never reach SQL unparameterized: they are plain not-found answers (long ones cut in the echo) and nothing is written', async () => {
    const world = await worldHash();
    const nasty = [
      "x'; DROP TABLE catalog.categories; --",
      "' OR '1'='1",
      '../../etc/passwd',
      '%00',
      'Ünïcödé_kód',
      '𝕏𝕐𝕫',
      'a'.repeat(100_000),
      '',
      ' ',
      '\n',
      'home_cleaning ',
      'HOME_CLEANING',
      '${jndi:ldap://x}',
      '{{7*7}}',
    ];
    for (const c of nasty) {
      const e1 = await expectError(bare.getCategory(c), 'CATEGORY_NOT_FOUND');
      expect(String(e1.details.code).length).toBeLessThanOrEqual(64);
      await expectError(bare.getServiceType(c), 'SERVICE_TYPE_NOT_FOUND');
      await expectError(bare.getProhibitedService(c), 'PROHIBITED_SERVICE_NOT_FOUND');
      await expectError(bare.setCategoryStatus(c, { status: 'ACTIVE', reason: REASON }, ACTOR), 'CATEGORY_NOT_FOUND');
      await expectError(bare.updateCategory(c, { iconKey: 'x1', reason: REASON }, ACTOR), 'CATEGORY_NOT_FOUND');
      await expectError(bare.setServiceTypeStatus(c, { status: 'ACTIVE', reason: REASON }, ACTOR), 'SERVICE_TYPE_NOT_FOUND');
      await expectError(bare.updateServiceType(c, { withDescription: true, reason: REASON }, ACTOR), 'SERVICE_TYPE_NOT_FOUND');
      await expectError(bare.setProhibitedServiceStatus(c, { status: 'ACTIVE', reason: REASON }, ACTOR), 'PROHIBITED_SERVICE_NOT_FOUND');
      await expectError(bare.createServiceType({ code: 'devtest_zzz', categoryCode: c, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'INVALID_FIELD');
    }
    // a NUL byte cannot be stored: it is a validation answer, never a raw driver error
    for (const call of [
      () => bare.getCategory('a\u0000b'),
      () => bare.getServiceType('a\u0000b'),
      () => bare.getProhibitedService('a\u0000b'),
      () => bare.setCategoryStatus('a\u0000b', { status: 'ACTIVE', reason: REASON }, ACTOR),
      () => bare.updateServiceType('a\u0000b', { withDescription: true, reason: REASON }, ACTOR),
      () => bare.setMarketCategoryAvailability('la-oc', 'a\u0000b', { enabled: true, displayOrder: 1, reason: REASON }, ACTOR),
    ]) {
      const e = await expectError(call(), 'VALIDATION_FAILED', 'FORBIDDEN_CHARACTER');
      expect(JSON.stringify(e.details)).not.toContain('invalid byte');
    }
    expect(await worldHash()).toBe(world);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'catalog'")).n).toBe(12); // 6 taxonomy tables (0015) + 6 Gig Template tables (0016)
  });
});

// ====================================================================== 4. statements issued
describe('statements issued by the public reads', () => {
  it('a public read is the market gate once plus two statements on a miss and none on a hit, for every public read', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    await catAvail(market, c, true, 10);
    await stAvail(market, s, true, 10);
    await setSt(s, 'ACTIVE');
    const miss = await counting(() => svc.getMarketCatalog(market));
    expect(miss.result.source).toBe('db');
    expect(miss.gate).toEqual([market]);
    // pinned: a miss is exactly the transaction frame plus TWO selects, categories then service types, nothing else (no write, no lock clause)
    expect(miss.sql).toHaveLength(4);
    expect(miss.sql[0]).toBe('start transaction isolation level repeatable read read only');
    expect(miss.sql[1]).toMatch(/^\s*SELECT c\.category_id[\s\S]*FROM catalog\.market_categories/);
    expect(miss.sql[2]).toMatch(/^\s*SELECT st\.service_type_id[\s\S]*FROM catalog\.market_service_types/);
    expect(miss.sql[3]).toBe('commit');
    expect(miss.sql.join('\n')).not.toMatch(/\b(insert|update|delete)\b|\bfor\s+(update|share|no key update|key share)\b/i);
    const hit = await counting(() => svc.getMarketCatalog(market));
    expect(hit.result.source).toBe('cache');
    expect(hit.sql).toEqual([]);
    expect(hit.gate).toEqual([market]);
    const reads: (() => Promise<unknown>)[] = [
      () => svc.listCategoriesForMarket(market),
      () => svc.listServiceTypesForMarket(market),
      () => svc.listServiceTypesForMarket(market, { categoryCode: c }),
      () => svc.getCategoryForMarket(market, c),
      () => svc.getServiceTypeForMarket(market, s),
    ];
    for (const read of reads) {
      const r = await counting(read);
      expect(r.sql).toEqual([]);
      expect(r.gate).toEqual([market]);
    }
  });

  it('the statement count does not grow with the number of categories and service types (4 or 40)', async () => {
    const market = await mkMarket(true);
    const build = async (n: number, from: number) => {
      for (let i = from; i < n; i++) {
        const c = await mkCategory();
        const s = await mkServiceType(c);
        await setCat(c, 'ACTIVE');
        await catAvail(market, c, true, 'auto');
        await stAvail(market, s, true, 'auto');
        await setSt(s, 'ACTIVE');
      }
    };
    await build(4, 0);
    const small = await counting(() => bare.getMarketCatalog(market));
    expect(small.result.categories).toHaveLength(4);
    await build(40, 4);
    const large = await counting(() => bare.getMarketCatalog(market));
    expect(large.result.categories).toHaveLength(40);
    expect(large.result.serviceTypes).toHaveLength(40);
    expect(large.sql.length).toBe(small.sql.length);
    expect(large.sql.map((x) => x.replace(/\s+/g, ' '))).toEqual(small.sql.map((x) => x.replace(/\s+/g, ' ')));
    expect(large.gate).toEqual([market]);
    // and the same through the cache: still nothing on a hit
    const cached = await counting(() => svc.getMarketCatalog(market));
    const hit = await counting(() => svc.getMarketCatalog(market));
    expect(cached.sql.length).toBe(small.sql.length);
    expect(hit.sql).toEqual([]);
  }, 120_000);

  it('the miss reads in ONE snapshot: a read-only REPEATABLE READ transaction (so categories and service types always agree)', async () => {
    const market = await mkMarket(true);
    const sink: string[] = [];
    const probe = createDatabase(iso.url, { role: 'tests', onQuery: (e) => sink.push(e.sql) });
    try {
      const own = new CatalogService({ database: probe, markets: gate, env: 'test', allowTestKeys: true });
      await own.getMarketCatalog(market);
      expect(sink.join('\n').toLowerCase()).toMatch(/start transaction isolation level repeatable read read only|begin/);
      expect(
        sink.some((x) => /isolation level repeatable read/i.test(x)),
        sink.join('\n'),
      ).toBe(true);
      expect(sink.some((x) => /read only/i.test(x))).toBe(true);
    } finally {
      await probe.close();
    }
  });

  it('the management reads send the market lookup plus one read, and are never cached (a second call hits the database again)', async () => {
    const market = await mkMarket(false);
    const a = await counting(() => svc.listCategories({ marketCode: market }));
    const b = await counting(() => svc.listCategories({ marketCode: market }));
    expect(a.sql.length).toBe(2);
    expect(b.sql.length).toBe(2);
    expect(a.gate).toEqual([]);
    expect((await counting(() => svc.listCategories())).sql.length).toBe(1);
    expect((await counting(() => svc.getCategory('home_cleaning'))).sql.length).toBe(1);
    expect((await counting(() => svc.getCategory('home_cleaning', { marketCode: market }))).sql.length).toBe(2);
    expect((await counting(() => svc.listServiceTypes())).sql.length).toBe(1);
    expect((await counting(() => svc.getServiceType('deep_cleaning'))).sql.length).toBe(1);
    expect((await counting(() => svc.listProhibitedServices())).sql.length).toBe(1);
  });

  it('30 parallel public reads on a cold cache all return the same catalogue and every later read is a hit', async () => {
    const market = await mkMarket(true);
    for (let i = 0; i < 3; i++) {
      const c = await mkCategory();
      await setCat(c, 'ACTIVE');
      await catAvail(market, c, true, 'auto');
    }
    const expected = (await bare.getMarketCatalog(market)).categories.map((c) => c.code);
    expect(expected).toHaveLength(3);
    const results = await Promise.all(Array.from({ length: 30 }, () => svc.listCategoriesForMarket(market)));
    for (const r of results) expect(r.categories.map((c) => c.code)).toEqual(expected);
    const after = await counting(() => svc.listCategoriesForMarket(market));
    expect(after.sql).toEqual([]);
  });
});

// ====================================================================== 5. cache
describe('the cache', () => {
  const lastGen = () => cache.gen();
  async function publicFixture() {
    const market = await mkMarket(true);
    const c = await mkCategory({ iconKey: 'one' });
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    await catAvail(market, c, true, 10);
    await stAvail(market, s, true, 10);
    await setSt(s, 'ACTIVE');
    return { market, c, s };
  }
  const fresh = async (market: string) => (await svc.getMarketCatalog(market)).source;
  const primed = async (market: string) => {
    await svc.getMarketCatalog(market);
    expect((await svc.getMarketCatalog(market)).source).toBe('cache');
  };

  it('a miss stores the snapshot under the generation key with the default TTL; the second read is a hit; another market has its own entry', async () => {
    const { market } = await publicFixture();
    const other = await mkMarket(true);
    const g = lastGen();
    cache.sets.length = 0;
    expect((await svc.getMarketCatalog(market)).source).toBe('db');
    expect(cache.sets).toEqual([{ key: `bg:test:cat:v1:market:${market}:${g}`, ttl: 300 }]);
    expect((await svc.getMarketCatalog(market)).source).toBe('cache');
    expect((await svc.getMarketCatalog(other)).source).toBe('db');
    expect(cache.data.has(`bg:test:cat:v1:market:${other}:${g}`)).toBe(true);
    // the snapshot holds content KEYS and codes only, never text
    const stored = JSON.parse(cache.data.get(`bg:test:cat:v1:market:${market}:${g}`)!) as { v: { categories: Row[] } };
    expect(JSON.stringify(stored)).not.toMatch(/"name"|"description"|"text"/);
    expect(keys(stored.v.categories[0]!)).toEqual(['categoryId', 'code', 'descriptionContentKey', 'displayOrder', 'iconKey', 'nameContentKey']);
  });

  it('a custom cacheTtlSeconds is passed to the cache', async () => {
    const own = new TestCache();
    const s2 = new CatalogService({ database: iso.database, markets: gate, env: 'test', cache: own, cacheTtlSeconds: 42 });
    const market = await mkMarket(true);
    await s2.getMarketCatalog(market);
    expect(own.sets.map((x) => x.ttl)).toEqual([42]);
  });

  it('EVERY kind of change bumps the generation exactly once and the next public read shows the new truth', async () => {
    const { market, c, s } = await publicFixture();
    const c2 = await mkCategory();
    await setCat(c2, 'ACTIVE');
    type Catalog = Awaited<ReturnType<typeof bare.getMarketCatalog>>;
    const steps: [string, () => Promise<unknown>, (cat: Catalog) => void][] = [
      [
        'updateCategory (metadata)',
        () => svc.updateCategory(c, { iconKey: 'two', reason: REASON }, ACTOR),
        (r) => expect(r.categories[0]!.iconKey).toBe('two'),
      ],
      [
        'updateCategory (clear icon)',
        () => svc.updateCategory(c, { iconKey: null, reason: REASON }, ACTOR),
        (r) => expect(r.categories[0]!.iconKey).toBeNull(),
      ],
      [
        'updateServiceType (description link)',
        async () => {
          await addContent('service_type', s, { name: false, description: true });
          return svc.updateServiceType(s, { withDescription: true, reason: REASON }, ACTOR);
        },
        (r) => expect(r.serviceTypes[0]!.descriptionContentKey).toBe(`catalog.service_type.${s}.description`),
      ],
      ['setServiceTypeStatus INACTIVE', () => setSt(s, 'INACTIVE'), (r) => expect(r.serviceTypes).toEqual([])],
      ['setServiceTypeStatus ACTIVE', () => setSt(s, 'ACTIVE'), (r) => expect(r.serviceTypes.map((x) => x.code)).toEqual([s])],
      ['availability: service type order only', () => stAvail(market, s, true, 20), (r) => expect(r.serviceTypes[0]!.displayOrder).toBe(20)],
      ['availability: service type off', () => stAvail(market, s, false), (r) => expect(r.serviceTypes).toEqual([])],
      ['availability: service type on', () => stAvail(market, s, true), (r) => expect(r.serviceTypes.map((x) => x.code)).toEqual([s])],
      ['availability: category order only', () => catAvail(market, c, true, 30), (r) => expect(r.categories[0]!.displayOrder).toBe(30)],
      ['availability: second category in', () => catAvail(market, c2, true, 5), (r) => expect(r.categories.map((x) => x.code)).toEqual([c2, c])],
      ['setCategoryStatus INACTIVE', () => setCat(c2, 'INACTIVE'), (r) => expect(r.categories.map((x) => x.code)).toEqual([c])],
      ['setCategoryStatus ACTIVE', () => setCat(c2, 'ACTIVE'), (r) => expect(r.categories.map((x) => x.code)).toEqual([c2, c])],
      [
        'availability: category off (with the cascade of its service types)',
        () => catAvail(market, c, false),
        (r) => expect(r.categories.map((x) => x.code)).toEqual([c2]),
      ],
    ];
    for (const [name, step, check] of steps) {
      await primed(market);
      const g = lastGen();
      const incrs = cache.incrs.length;
      await step();
      expect(cache.incrs.length - incrs, `${name}: one bump per committed change`).toBe(1);
      expect(lastGen(), name).toBe(g + 1);
      expect(await fresh(market), `${name}: the next read is a miss`).toBe('db');
      check(await svc.getMarketCatalog(market));
      expect((await bare.getMarketCatalog(market)).categories).toEqual((await svc.getMarketCatalog(market)).categories);
      expect((await bare.getMarketCatalog(market)).serviceTypes).toEqual((await svc.getMarketCatalog(market)).serviceTypes);
    }
  }, 60_000);

  it('a no-op never bumps: the same status again, the same availability again, the same metadata again, and every read after it is still a hit', async () => {
    const { market, c, s } = await publicFixture();
    await primed(market);
    const g = lastGen();
    const incrs = cache.incrs.length;
    const world = await worldHash();
    await setCat(c, 'ACTIVE');
    await setSt(s, 'ACTIVE');
    await catAvail(market, c, true, 10);
    await catAvail(market, c, true);
    await stAvail(market, s, true, 10);
    await svc.updateCategory(c, { iconKey: 'one', reason: REASON }, ACTOR);
    await svc.updateCategory(c, { withDescription: false, reason: REASON }, ACTOR);
    await svc.updateServiceType(s, { withDescription: false, reason: REASON }, ACTOR);
    expect(cache.incrs.length).toBe(incrs);
    expect(lastGen()).toBe(g);
    expect(await worldHash()).toBe(world);
    expect((await svc.getMarketCatalog(market)).source).toBe('cache');
  });

  it('a refused or failed change never bumps (guard refusals, validation, not-found, content missing, a database failure after the audit row)', async () => {
    const { market, c, s } = await publicFixture();
    const draft = await mkCategory();
    await primed(market);
    const g = lastGen();
    const incrs = cache.incrs.length;
    const world = await worldHash();
    await expectError(setCat(c, 'INACTIVE'), 'INVALID_STATE', 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    await expectError(setCat(draft, 'INACTIVE'), 'INVALID_STATE', 'STATUS_TRANSITION');
    await expectError(setSt(s, 'DRAFT' as CatalogStatus), 'VALIDATION_FAILED');
    await expectError(setCat('devtest_nothing', 'ACTIVE'), 'CATEGORY_NOT_FOUND');
    await expectError(catAvail(market, draft, true), 'VALIDATION_FAILED', 'DISPLAY_ORDER_REQUIRED');
    await expectError(catAvail(market, draft, true, 10), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
    await expectError(svc.updateCategory(draft, { withDescription: true, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'DESCRIPTION_CONTENT_MISSING');
    await q(
      `CREATE FUNCTION public.cat_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END $$`,
    );
    await q(
      `CREATE TRIGGER trg_cat_test_fail BEFORE INSERT ON integration.outbox_events FOR EACH ROW WHEN (NEW.event_type = '${CATALOG_EVENTS.categoryActivated}') EXECUTE FUNCTION public.cat_test_fail()`,
    );
    try {
      const e = (await rejection(setCat(draft, 'ACTIVE'))) as { code?: string };
      expect(e?.code).toBe('XX000');
    } finally {
      await q('DROP TRIGGER trg_cat_test_fail ON integration.outbox_events');
      await q('DROP FUNCTION public.cat_test_fail()');
    }
    expect(cache.incrs.length).toBe(incrs);
    expect(lastGen()).toBe(g);
    expect(await worldHash()).toBe(world);
    expect((await svc.getMarketCatalog(market)).source).toBe('cache');
  });

  it('create operations change nothing public: the snapshot is still correct after them (and they do not have to bump)', async () => {
    const { market } = await publicFixture();
    const before = (await bare.getMarketCatalog(market)).categories.map((x) => x.code);
    await primed(market);
    const nc = await mkCategory();
    await mkServiceType(nc);
    await mkProhibited({ categoryCode: nc });
    expect((await svc.getMarketCatalog(market)).categories.map((x) => x.code)).toEqual(before);
    expect((await bare.getMarketCatalog(market)).categories.map((x) => x.code)).toEqual(before);
  });

  it('a cache that throws, rejects or hangs never changes a result, a mutation or an error (reads fall back to the database; changes still commit)', async () => {
    const { market, c, s } = await publicFixture();
    for (const mode of ['throw', 'hang'] as const) {
      const bad = new TestCache();
      bad.mode = mode;
      const own = new CatalogService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: bad, cacheDeadlineMs: 40 });
      const truth = (await bare.getMarketCatalog(market)).categories.map((x) => x.code);
      expect(
        (await own.getMarketCatalog(market)).categories.map((x) => x.code),
        mode,
      ).toEqual(truth);
      expect((await own.getMarketCatalog(market)).source).toBe('db');
      await own.setMarketCategoryAvailability(market, c, { enabled: true, displayOrder: 10 + (mode === 'throw' ? 1 : 2), reason: REASON }, ACTOR);
      expect((await mcRow(market, c))[0]!.display_order).toBe(10 + (mode === 'throw' ? 1 : 2));
      await expectError(own.setCategoryStatus(c, { status: 'INACTIVE', reason: REASON }, ACTOR), 'INVALID_STATE', 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
      expect((await own.getMarketCatalog(market)).categories[0]!.displayOrder).toBe(10 + (mode === 'throw' ? 1 : 2));
      await expectError(own.getMarketCatalog('devtest-nowhere'), 'MARKET_NOT_FOUND');
      expect(await err(own.setServiceTypeStatus(s, { status: 'ACTIVE', reason: REASON }, ACTOR))).toBeUndefined(); // idempotent
    }
  });

  it('a stale generation can never serve old data: a reader that loaded BEFORE a commit and writes AFTER the bump only fills a dead key', async () => {
    const { market, c } = await publicFixture();
    const own = new TestCache();
    const reader = new CatalogService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: own, cacheDeadlineMs: 5000 });
    // the writer shares the reader's cache so that its bump is visible to the reader
    const hold = deferred();
    own.holdNextSet = hold;
    const slow = reader.getMarketCatalog(market); // loads the OLD state and then waits to store it
    for (let i = 0; i < 200 && own.sets.length === 0; i++) await sleep(10);
    expect(own.sets).toHaveLength(1);
    const oldGen = own.gen();
    await reader.setMarketCategoryAvailability(market, c, { enabled: true, displayOrder: 77, reason: REASON }, ACTOR); // commit + bump
    expect(own.gen()).toBe(oldGen + 1);
    hold.resolve();
    const stale = await slow;
    expect(stale.categories[0]!.displayOrder).not.toBe(77); // what it loaded before the commit
    // it is stored under the OLD generation, so nobody reads it
    expect(own.sets[0]!.key.endsWith(`:${oldGen}`)).toBe(true);
    const next = await reader.getMarketCatalog(market);
    expect(next.source).toBe('db');
    expect(next.categories[0]!.displayOrder).toBe(77);
    expect((await reader.getMarketCatalog(market)).source).toBe('cache');
  });

  it('a LOST bump is the documented gap: the stale entry is served until the next successful bump (bounded by the TTL), then fresh data again', async () => {
    const { market, c } = await publicFixture();
    const own = new TestCache();
    const s2 = new CatalogService({
      database: iso.database,
      markets: gate,
      env: 'test',
      allowTestKeys: true,
      cache: own,
      cacheDeadlineMs: 100,
      cacheTtlSeconds: 7,
    });
    await s2.getMarketCatalog(market);
    own.mode = 'lose-bump';
    await s2.setMarketCategoryAvailability(market, c, { enabled: true, displayOrder: 55, reason: REASON }, ACTOR);
    own.mode = 'ok';
    expect((await s2.getMarketCatalog(market)).source).toBe('cache'); // stale by design
    expect(own.sets.every((x) => x.ttl === 7)).toBe(true); // ... and every entry has a bounded lifetime
    await s2.setMarketCategoryAvailability(market, c, { enabled: true, displayOrder: 56, reason: REASON }, ACTOR);
    expect((await s2.getMarketCatalog(market)).categories[0]!.displayOrder).toBe(56);
  });

  it('the market gate is consulted on EVERY read, hit or miss: a market that stops being public stops being readable at once even though its snapshot is cached', async () => {
    const { market } = await publicFixture();
    await primed(market);
    gateState.markets.delete(market);
    try {
      await expectError(svc.getMarketCatalog(market), 'MARKET_NOT_FOUND');
      await expectError(svc.listCategoriesForMarket(market), 'MARKET_NOT_FOUND');
    } finally {
      gateState.markets.set(market, { code: market, defaultLocale: 'en-US' });
    }
    expect((await svc.getMarketCatalog(market)).source).toBe('cache');
  });

  it('a market that is not public is never given a cache entry (the key space is the set of public markets)', async () => {
    const planned = await mkMarket(false);
    cache.sets.length = 0;
    cache.gets.length = 0;
    await expectError(svc.getMarketCatalog(planned), 'MARKET_NOT_FOUND');
    await expectError(svc.getMarketCatalog('LA-OC'), 'MARKET_NOT_FOUND');
    expect(cache.sets).toEqual([]);
    expect(cache.gets).toEqual([]);
  });
});

// ====================================================================== 6. mutations: audit, outbox, correlation
describe('audit and outbox of every mutation', () => {
  it('createCategory: one CATEGORY_CREATED row with the exact diff, actor, reason and a correlation id; no event; the category is a DRAFT', async () => {
    const c = code('c');
    await addContent('category', c, { description: true });
    const before = await counts();
    const reason = '  Launch plan — Q3 ✓ "quoted"  ';
    const view = await runWithCorrelation('corr-create-1', () =>
      svc.createCategory({ code: c, iconKey: 'sparkles', withDescription: true, reason }, 'admin:bob'),
    );
    expect(view).toMatchObject({
      code: c,
      status: 'DRAFT',
      iconKey: 'sparkles',
      nameContentKey: `catalog.category.${c}.name`,
      descriptionContentKey: `catalog.category.${c}.description`,
      displayOrder: null,
    });
    expect(await categoryAudit(c)).toEqual([
      {
        action: 'CATEGORY_CREATED',
        actor: 'admin:bob',
        changes: { status: [null, 'DRAFT'], iconKey: [null, 'sparkles'], withDescription: [null, true] },
        reason,
        correlation_id: 'corr-create-1',
      },
    ]);
    const after = await counts();
    expect(after.audit - before.audit).toBe(1);
    expect(after.events - before.events).toBe(0);
    const c2 = await mkCategory();
    expect((await categoryAudit(c2))[0]!.changes).toEqual({ status: [null, 'DRAFT'], iconKey: [null, null], withDescription: [null, false] });
    expect((await categoryAudit(c2))[0]!.correlation_id).toMatch(/^[0-9a-f-]{36}$/); // a fresh id when the caller has none
  });

  it('without a caller correlation id the audit row and the event of one change share the same fresh id', async () => {
    const c = await mkCategory();
    await setCat(c, 'ACTIVE');
    const [audit] = (await categoryAudit(c)).slice(-1);
    const [ev] = await eventsWhere(CATALOG_EVENTS.categoryActivated, { categoryCode: c });
    expect(audit!.correlation_id).toBe(ev!.correlation_id);
    expect(audit!.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('category status changes: audit diff per change; events only for ACTIVE transitions (activated on entering ACTIVE, deactivated on leaving it)', async () => {
    const path: [CatalogStatus, string | null][] = [
      ['ACTIVE', CATALOG_EVENTS.categoryActivated],
      ['INACTIVE', CATALOG_EVENTS.categoryDeactivated],
      ['ACTIVE', CATALOG_EVENTS.categoryActivated],
      ['RETIRED', CATALOG_EVENTS.categoryDeactivated],
    ];
    const c = await mkCategory();
    let from: CatalogStatus = 'DRAFT';
    let n = 0;
    for (const [to, event] of path) {
      const before = await counts();
      const corr = `corr-${c}-${n++}`;
      const view = await runWithCorrelation(corr, () => svc.setCategoryStatus(c, { status: to, reason: `to ${to}` }, 'admin:carol'));
      expect(view.status).toBe(to);
      const last = (await categoryAudit(c)).at(-1)!;
      expect(last).toEqual({
        action: 'CATEGORY_STATUS_CHANGED',
        actor: 'admin:carol',
        changes: { status: [from, to] },
        reason: `to ${to}`,
        correlation_id: corr,
      });
      const after = await counts();
      expect(after.audit - before.audit).toBe(1);
      expect(after.events - before.events).toBe(event ? 1 : 0);
      if (event) {
        const evs = await eventsWhere(event, { categoryCode: c });
        const ev = evs.at(-1)!;
        expect(ev).toMatchObject({
          event_type: event,
          event_version: 1,
          aggregate_type: 'catalog_category',
          actor_type: 'user',
          actor_id: 'admin:carol',
          payload_json: { categoryCode: c },
          correlation_id: corr,
          causation_id: null,
          published_at: null,
        });
        expect(ev.aggregate_id).toBe((await one<{ category_id: string }>('SELECT category_id FROM catalog.categories WHERE code = $1', [c])).category_id);
        expect(keys(ev.payload_json)).toEqual(['categoryCode']);
      }
      from = to;
    }
  });

  it('no event for a transition that does not touch ACTIVE (DRAFT to RETIRED, INACTIVE to RETIRED), for categories and service types', async () => {
    const before = await counts();
    const c1 = await mkCategory();
    await setCat(c1, 'RETIRED');
    const c2 = await mkCategory();
    await setCat(c2, 'ACTIVE');
    await setCat(c2, 'INACTIVE');
    const mid = await counts();
    await setCat(c2, 'RETIRED');
    const s1 = await mkServiceType(await mkCategory());
    await setSt(s1, 'RETIRED');
    const cat = await mkCategory();
    await setCat(cat, 'ACTIVE');
    const s2 = await mkServiceType(cat);
    await setSt(s2, 'ACTIVE');
    await setSt(s2, 'INACTIVE');
    const beforeRetire = await counts();
    await setSt(s2, 'RETIRED');
    const end = await counts();
    expect(end.events - beforeRetire.events).toBe(0);
    expect(end.audit - beforeRetire.audit).toBe(1);
    expect(mid.events - before.events).toBe(2); // the only events so far: c2 activated, c2 deactivated
    expect(mid.audit).toBeGreaterThan(before.audit);
  });

  it('service type status changes: exact audit and events with the category code in the payload', async () => {
    const cat = await mkCategory();
    await setCat(cat, 'ACTIVE');
    const s = await mkServiceType(cat);
    const created = (await serviceTypeAudit(s))[0]!;
    expect(created).toMatchObject({ action: 'SERVICE_TYPE_CREATED', actor: ACTOR, reason: REASON });
    expect(created.changes).toEqual({ status: [null, 'DRAFT'], categoryCode: [null, cat], withDescription: [null, false] });
    const stId = (await one<{ service_type_id: string }>('SELECT service_type_id FROM catalog.service_types WHERE code = $1', [s])).service_type_id;
    const seq1: [CatalogStatus, string | null][] = [
      ['ACTIVE', CATALOG_EVENTS.serviceTypeActivated],
      ['INACTIVE', CATALOG_EVENTS.serviceTypeDeactivated],
      ['ACTIVE', CATALOG_EVENTS.serviceTypeActivated],
      ['RETIRED', CATALOG_EVENTS.serviceTypeDeactivated],
    ];
    let from: CatalogStatus = 'DRAFT';
    for (const [to, type] of seq1) {
      const corr = `corr-st-${to}-${seq++}`;
      await runWithCorrelation(corr, () => setSt(s, to));
      expect((await serviceTypeAudit(s)).at(-1)).toEqual({
        action: 'SERVICE_TYPE_STATUS_CHANGED',
        actor: ACTOR,
        changes: { status: [from, to] },
        reason: REASON,
        correlation_id: corr,
      });
      const ev = (await eventsWhere(type!, { serviceTypeCode: s })).at(-1)!;
      expect(ev).toMatchObject({
        event_version: 1,
        aggregate_type: 'catalog_service_type',
        aggregate_id: stId,
        actor_type: 'user',
        actor_id: ACTOR,
        correlation_id: corr,
      });
      expect(ev.payload_json).toEqual({ serviceTypeCode: s, categoryCode: cat });
      from = to;
    }
    expect(await eventsWhere(CATALOG_EVENTS.serviceTypeActivated, { serviceTypeCode: s })).toHaveLength(2);
    expect(await eventsWhere(CATALOG_EVENTS.serviceTypeDeactivated, { serviceTypeCode: s })).toHaveLength(2);
  });

  it('updateCategory / updateServiceType: audit rows carry exactly the fields that changed; no event; created_at is kept and updated_at moves', async () => {
    const c = await mkCategory({ iconKey: 'one' });
    await addContent('category', c, { name: false, description: true });
    const t0 = await one<{ created_at: Date; updated_at: Date }>('SELECT created_at, updated_at FROM catalog.categories WHERE code = $1', [c]);
    await sleep(5);
    const before = await counts();
    await svc.updateCategory(c, { iconKey: 'two', reason: 'icon' }, 'admin:dave');
    await svc.updateCategory(c, { withDescription: true, reason: 'link' }, 'admin:dave');
    await svc.updateCategory(c, { iconKey: null, withDescription: false, reason: 'both' }, 'admin:dave');
    const audit = (await categoryAudit(c)).slice(1);
    expect(audit.map((a) => [a.action, a.changes, a.reason, a.actor])).toEqual([
      ['CATEGORY_UPDATED', { iconKey: ['one', 'two'] }, 'icon', 'admin:dave'],
      ['CATEGORY_UPDATED', { withDescription: [false, true] }, 'link', 'admin:dave'],
      ['CATEGORY_UPDATED', { iconKey: ['two', null], withDescription: [true, false] }, 'both', 'admin:dave'],
    ]);
    const after = await counts();
    expect(after.audit - before.audit).toBe(3);
    expect(after.events - before.events).toBe(0);
    const t1 = await one<{ created_at: Date; updated_at: Date }>('SELECT created_at, updated_at FROM catalog.categories WHERE code = $1', [c]);
    expect(t1.created_at.getTime()).toBe(t0.created_at.getTime());
    expect(t1.updated_at.getTime()).toBeGreaterThan(t0.updated_at.getTime());
    const s = await mkServiceType(c);
    await addContent('service_type', s, { name: false, description: true });
    await svc.updateServiceType(s, { withDescription: true, reason: 'sdesc' }, 'admin:erin');
    await svc.updateServiceType(s, { withDescription: false, reason: 'sdesc off' }, 'admin:erin');
    expect((await serviceTypeAudit(s)).slice(1).map((a) => [a.action, a.changes, a.reason])).toEqual([
      ['SERVICE_TYPE_UPDATED', { withDescription: [false, true] }, 'sdesc'],
      ['SERVICE_TYPE_UPDATED', { withDescription: [true, false] }, 'sdesc off'],
    ]);
    expect((await bare.getServiceType(s)).descriptionContentKey).toBeNull();
  });

  it('prohibited services: created as DRAFT with an exact audit row, status changes audited, never an event, listed by code', async () => {
    const cat = await mkCategory();
    const before = await counts();
    const p1 = await mkProhibited({ categoryCode: cat, withDescription: true });
    const p2 = await mkProhibited();
    expect((await prohibitedAudit(p1))[0]).toEqual({
      action: 'PROHIBITED_SERVICE_CREATED',
      actor: ACTOR,
      changes: { status: [null, 'DRAFT'], categoryCode: [null, cat], withDescription: [null, true] },
      reason: REASON,
      correlation_id: expect.any(String),
    });
    expect((await prohibitedAudit(p2))[0]!.changes).toEqual({ status: [null, 'DRAFT'], categoryCode: [null, null], withDescription: [null, false] });
    const v1 = await bare.getProhibitedService(p1);
    expect(v1).toMatchObject({
      code: p1,
      categoryCode: cat,
      status: 'DRAFT',
      nameContentKey: `catalog.prohibited_service.${p1}.name`,
      descriptionContentKey: `catalog.prohibited_service.${p1}.description`,
    });
    expect(keys(v1)).toEqual(['categoryCode', 'code', 'createdAt', 'descriptionContentKey', 'nameContentKey', 'prohibitedServiceId', 'status', 'updatedAt']);
    expect((await bare.getProhibitedService(p2)).categoryCode).toBeNull();
    await svc.setProhibitedServiceStatus(p1, { status: 'ACTIVE', reason: 'enforce' }, 'admin:fay');
    await svc.setProhibitedServiceStatus(p1, { status: 'ACTIVE', reason: 'again' }, 'admin:fay'); // idempotent
    await svc.setProhibitedServiceStatus(p1, { status: 'INACTIVE', reason: 'pause' }, 'admin:fay');
    await svc.setProhibitedServiceStatus(p1, { status: 'RETIRED', reason: 'done' }, 'admin:fay');
    expect((await prohibitedAudit(p1)).slice(1).map((a) => [a.action, a.changes, a.reason, a.actor])).toEqual([
      ['PROHIBITED_SERVICE_STATUS_CHANGED', { status: ['DRAFT', 'ACTIVE'] }, 'enforce', 'admin:fay'],
      ['PROHIBITED_SERVICE_STATUS_CHANGED', { status: ['ACTIVE', 'INACTIVE'] }, 'pause', 'admin:fay'],
      ['PROHIBITED_SERVICE_STATUS_CHANGED', { status: ['INACTIVE', 'RETIRED'] }, 'done', 'admin:fay'],
    ]);
    const after = await counts();
    expect(after.events - before.events).toBe(0);
    const list = (await bare.listProhibitedServices()).filter((p) => [p1, p2].includes(p.code));
    expect(list.map((p) => p.code)).toEqual([p1, p2].sort());
    await expectError(svc.createProhibitedService({ code: code('p'), categoryCode: 'devtest_nothing', reason: REASON }, ACTOR), 'CATEGORY_NOT_FOUND');
    await expectError(mkProhibited({ code: p1 }), 'CONFLICT', 'CODE_TAKEN');
    // prohibited services are never part of the public catalogue
    const market = await mkMarket(true);
    expect(keys(await bare.getMarketCatalog(market))).toEqual(['categories', 'market', 'serviceTypes', 'source']);
  });

  it('prohibited services follow the one status machine, and RETIRED is terminal', async () => {
    for (const from of CATALOG_STATUSES) {
      for (const to of ['ACTIVE', 'INACTIVE', 'RETIRED'] as const) {
        const p = await mkProhibited();
        if (from === 'ACTIVE') await svc.setProhibitedServiceStatus(p, { status: 'ACTIVE', reason: REASON }, ACTOR);
        if (from === 'INACTIVE') {
          await svc.setProhibitedServiceStatus(p, { status: 'ACTIVE', reason: REASON }, ACTOR);
          await svc.setProhibitedServiceStatus(p, { status: 'INACTIVE', reason: REASON }, ACTOR);
        }
        if (from === 'RETIRED') await svc.setProhibitedServiceStatus(p, { status: 'RETIRED', reason: REASON }, ACTOR);
        const world = await worldHash();
        const call = svc.setProhibitedServiceStatus(p, { status: to, reason: REASON }, ACTOR);
        if (from === to || isCatalogTransitionAllowed(from, to)) {
          expect((await call).status).toBe(to);
        } else {
          await expectError(call, 'INVALID_STATE', 'STATUS_TRANSITION');
          expect(await worldHash()).toBe(world);
        }
      }
    }
  });

  it('a rejected create leaves nothing behind: no row, no audit, no event', async () => {
    const world = await worldHash();
    await expectError(svc.createCategory({ code: code('c'), reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'NAME_CONTENT_MISSING');
    expect(await worldHash()).toBe(world);
  });
});

// ====================================================================== 7. atomicity
describe('atomicity: the change, its audit row and its event commit together or not at all', () => {
  async function failing(table: string, when: string, fn: () => Promise<unknown>): Promise<unknown> {
    await q(
      `CREATE FUNCTION public.cat_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END $$`,
    );
    await q(`CREATE TRIGGER trg_cat_test_fail BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.cat_test_fail()`);
    try {
      return await rejection(fn());
    } finally {
      await q(`DROP TRIGGER trg_cat_test_fail ON ${table}`);
      await q('DROP FUNCTION public.cat_test_fail()');
    }
  }

  it('when the event cannot be written the status, the audit row and the cache all stay as they were', async () => {
    const c = await mkCategory();
    const world = await worldHash();
    const g = cache.gen();
    const incrs = cache.incrs.length;
    const e = (await failing('integration.outbox_events', `NEW.event_type = '${CATALOG_EVENTS.categoryActivated}'`, () => setCat(c, 'ACTIVE'))) as {
      code?: string;
    };
    expect(e.code).toBe('XX000');
    expect(await dbStatus('categories', c)).toBe('DRAFT');
    expect(await worldHash()).toBe(world);
    expect(cache.gen()).toBe(g);
    expect(cache.incrs.length).toBe(incrs);
    await setCat(c, 'ACTIVE'); // and the retry works once the failure is gone
    expect(await eventsWhere(CATALOG_EVENTS.categoryActivated, { categoryCode: c })).toHaveLength(1);
  });

  it('when the audit row cannot be written no event and no change remains (status change, service type, availability)', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    await catAvail(market, c, true, 10);
    const world = await worldHash();
    const cases: [string, string, () => Promise<unknown>][] = [
      ['category status', `NEW.action = 'CATEGORY_STATUS_CHANGED'`, () => setCat(c, 'INACTIVE')],
      ['service type status', `NEW.action = 'SERVICE_TYPE_STATUS_CHANGED'`, () => setSt(s, 'ACTIVE')],
      ['availability', `NEW.action = 'MARKET_CATALOG_AVAILABILITY_CHANGED'`, () => stAvail(market, s, true, 10)],
      ['availability change of order', `NEW.action = 'MARKET_CATALOG_AVAILABILITY_CHANGED'`, () => catAvail(market, c, true, 99)],
    ];
    for (const [label, when, call] of cases) {
      const e = (await failing('catalog.audit_events', when, call)) as { code?: string };
      expect(e.code, label).toBe('XX000');
      expect(await worldHash(), label).toBe(world);
    }
    expect(await dbStatus('categories', c)).toBe('ACTIVE');
    expect(await mstRow(market, s)).toEqual([]);
    expect((await mcRow(market, c))[0]!.display_order).toBe(10);
  });

  it('a failure in the MIDDLE of the cascade (the second service type) rolls back the category, both service types, their audit rows and their events', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    await setCat(c, 'ACTIVE');
    await catAvail(market, c, true, 10);
    const sts = [await mkServiceType(c), await mkServiceType(c), await mkServiceType(c)].sort();
    for (const s of sts) await stAvail(market, s, true, 'auto');
    const second = (await one<{ service_type_id: string }>('SELECT service_type_id FROM catalog.service_types WHERE code = $1', [sts[1]])).service_type_id;
    const world = await worldHash();
    const g = cache.gen();
    const e = (await failing('catalog.audit_events', `NEW.service_type_id = '${second}'`, () => catAvail(market, c, false))) as { code?: string };
    expect(e.code).toBe('XX000');
    expect(await worldHash()).toBe(world);
    expect(cache.gen()).toBe(g);
    expect((await mcRow(market, c))[0]!.enabled).toBe(true);
    for (const s of sts) expect((await mstRow(market, s))[0]!.enabled).toBe(true);
  });

  it('a transaction that is rolled back AFTER the service committed its work inside it leaves no row, no audit and no event', async () => {
    const c = await mkCategory();
    const world = await worldHash();
    const abort = new Error('outer abort');
    // the service joins the caller's transaction (Database.transaction nests); the caller then fails
    const e = await rejection(
      iso.database.transaction(async () => {
        await svc.setCategoryStatus(c, { status: 'ACTIVE', reason: REASON }, ACTOR);
        expect((await bare.getCategory(c)).status).toBe('ACTIVE'); // visible inside
        throw abort;
      }),
    );
    expect(e).toBe(abort);
    expect(await dbStatus('categories', c)).toBe('DRAFT');
    expect(await worldHash()).toBe(world);
    expect(await eventsWhere(CATALOG_EVENTS.categoryActivated, { categoryCode: c })).toEqual([]);
  });
});

// ====================================================================== 8. idempotence
describe('idempotence', () => {
  it('the same status twice writes nothing the second time: no audit row, no event, no updated_at move, no bump', async () => {
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    await setSt(s, 'ACTIVE');
    const t0 = await one<{ updated_at: Date }>('SELECT updated_at FROM catalog.categories WHERE code = $1', [c]);
    await sleep(5);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    for (let i = 0; i < 3; i++) {
      expect((await setCat(c, 'ACTIVE')).status).toBe('ACTIVE');
      expect((await setSt(s, 'ACTIVE')).status).toBe('ACTIVE');
    }
    expect(await worldHash()).toBe(world);
    expect((await one<{ updated_at: Date }>('SELECT updated_at FROM catalog.categories WHERE code = $1', [c])).updated_at.getTime()).toBe(
      t0.updated_at.getTime(),
    );
    expect(cache.incrs.length).toBe(incrs);
    expect(await eventsWhere(CATALOG_EVENTS.categoryActivated, { categoryCode: c })).toHaveLength(1);
    expect((await categoryAudit(c)).map((a) => a.action)).toEqual(['CATEGORY_CREATED', 'CATEGORY_STATUS_CHANGED']);
  });

  it('a RETIRED item asked to be RETIRED again is a no-op, not an INVALID_STATE', async () => {
    const c = await mkCategory();
    await setCat(c, 'RETIRED');
    const world = await worldHash();
    expect((await setCat(c, 'RETIRED')).status).toBe('RETIRED');
    expect(await worldHash()).toBe(world);
  });

  it('the same availability twice (with or without the order) writes nothing: no audit, no event', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await catAvail(market, c, true, 10);
    await stAvail(market, s, true, 10);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    for (const args of [
      [true, 10],
      [true, undefined],
    ] as const) {
      expect(await catAvail(market, c, args[0], args[1])).toEqual({
        marketCode: market,
        code: c,
        kind: 'CATEGORY',
        enabled: true,
        displayOrder: 10,
        alsoDisabled: [],
      });
      expect(await stAvail(market, s, args[0], args[1])).toEqual({
        marketCode: market,
        code: s,
        kind: 'SERVICE_TYPE',
        enabled: true,
        displayOrder: 10,
        alsoDisabled: [],
      });
    }
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
    expect(await availabilityAudit(market, 'CATEGORY', c)).toHaveLength(1);
  });

  it('switching a category off twice cascades once: the repeat reports an empty alsoDisabled and writes nothing', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await catAvail(market, c, true, 10);
    await stAvail(market, s, true, 10);
    expect((await catAvail(market, c, false)).alsoDisabled).toEqual([s]);
    const world = await worldHash();
    expect(await catAvail(market, c, false)).toMatchObject({ enabled: false, alsoDisabled: [] });
    expect(await worldHash()).toBe(world);
  });
});

// ====================================================================== 9. status machine
describe('the status machine through the service', () => {
  async function inState(kind: 'category' | 'service_type', target: CatalogStatus): Promise<string> {
    const cat = await mkCategory();
    const c = kind === 'category' ? cat : await mkServiceType(cat);
    const set = kind === 'category' ? setCat : setSt;
    if (kind === 'service_type') await setCat(cat, 'ACTIVE');
    if (target === 'ACTIVE') await set(c, 'ACTIVE');
    if (target === 'INACTIVE') {
      await set(c, 'ACTIVE');
      await set(c, 'INACTIVE');
    }
    if (target === 'RETIRED') await set(c, 'RETIRED');
    return c;
  }
  for (const kind of ['category', 'service_type'] as const) {
    it(`${kind}: all 12 (from, to) pairs behave exactly as the contract says; a refused pair is INVALID_STATE STATUS_TRANSITION and writes nothing`, async () => {
      let allowed = 0;
      let refused = 0;
      for (const from of CATALOG_STATUSES) {
        for (const to of ['ACTIVE', 'INACTIVE', 'RETIRED'] as const) {
          const c = await inState(kind, from);
          const world = await worldHash();
          const call = kind === 'category' ? setCat(c, to) : setSt(c, to);
          if (from === to || isCatalogTransitionAllowed(from, to)) {
            expect((await call).status, `${from}->${to}`).toBe(to);
            allowed++;
          } else {
            await expectError(call, 'INVALID_STATE', 'STATUS_TRANSITION');
            expect(await worldHash(), `${from}->${to}`).toBe(world);
            refused++;
          }
        }
      }
      expect(CATALOG_STATUS_TRANSITIONS.RETIRED).toEqual([]);
      expect(allowed).toBe(9); // 3 identity pairs (ACTIVE, INACTIVE, RETIRED) + DRAFT->ACTIVE, DRAFT->RETIRED, ACTIVE->INACTIVE, ACTIVE->RETIRED, INACTIVE->ACTIVE, INACTIVE->RETIRED
      expect(refused).toBe(3); // DRAFT->INACTIVE, RETIRED->ACTIVE, RETIRED->INACTIVE
    }, 60_000);
  }
});

// ====================================================================== 10. hierarchy rules
describe('hierarchy rules', () => {
  it('a service type can be created under a DRAFT, ACTIVE or INACTIVE category (always as DRAFT) but not under a RETIRED one; an unknown category is CATEGORY_NOT_FOUND', async () => {
    const draft = await mkCategory();
    const active = await mkCategory();
    const inactive = await mkCategory();
    const retired = await mkCategory();
    await setCat(active, 'ACTIVE');
    await setCat(inactive, 'ACTIVE');
    await setCat(inactive, 'INACTIVE');
    await setCat(retired, 'RETIRED');
    for (const c of [draft, active, inactive]) {
      const s = await mkServiceType(c);
      expect(await bare.getServiceType(s)).toMatchObject({ status: 'DRAFT', categoryCode: c });
    }
    const world = await worldHash();
    const code1 = code('s');
    await addContent('service_type', code1);
    await expectError(svc.createServiceType({ code: code1, categoryCode: retired, reason: REASON }, ACTOR), 'INVALID_STATE', 'CATEGORY_RETIRED');
    await expectError(svc.createServiceType({ code: code1, categoryCode: 'devtest_nothing', reason: REASON }, ACTOR), 'CATEGORY_NOT_FOUND');
    expect(await worldHash()).toBe(world);
    await expectError(bare.getServiceType(code1), 'SERVICE_TYPE_NOT_FOUND');
  });

  it('a category with ACTIVE service types cannot be deactivated or retired; once they are INACTIVE it can be deactivated, and it is retired only when every service type is RETIRED', async () => {
    const c = await mkCategory();
    const s1 = await mkServiceType(c);
    const s2 = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    await setSt(s1, 'ACTIVE');
    const world = await worldHash();
    await expectError(setCat(c, 'INACTIVE'), 'INVALID_STATE', 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    await expectError(setCat(c, 'RETIRED'), 'INVALID_STATE', 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    expect(await worldHash()).toBe(world);
    await setSt(s1, 'INACTIVE');
    await setCat(c, 'INACTIVE');
    await expectError(setCat(c, 'RETIRED'), 'INVALID_STATE', 'CATEGORY_HAS_OPEN_SERVICE_TYPES'); // s1 INACTIVE, s2 DRAFT
    await setSt(s1, 'RETIRED');
    await expectError(setCat(c, 'RETIRED'), 'INVALID_STATE', 'CATEGORY_HAS_OPEN_SERVICE_TYPES'); // s2 DRAFT
    await setSt(s2, 'RETIRED');
    expect((await setCat(c, 'RETIRED')).status).toBe('RETIRED');
  });

  it('a service type cannot be activated under a DRAFT, INACTIVE or RETIRED category (CATEGORY_NOT_ACTIVE) and can once the category is ACTIVE; deactivating it never needs the category', async () => {
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await expectError(setSt(s, 'ACTIVE'), 'INVALID_STATE', 'CATEGORY_NOT_ACTIVE');
    await setCat(c, 'ACTIVE');
    await setCat(c, 'INACTIVE');
    await expectError(setSt(s, 'ACTIVE'), 'INVALID_STATE', 'CATEGORY_NOT_ACTIVE');
    await setCat(c, 'ACTIVE');
    await setSt(s, 'ACTIVE');
    await setSt(s, 'INACTIVE');
    await setCat(c, 'INACTIVE');
    expect((await setSt(s, 'RETIRED')).status).toBe('RETIRED'); // retiring under an INACTIVE category is fine
    const c2 = await mkCategory();
    const s2 = await mkServiceType(c2);
    await setSt(s2, 'RETIRED');
    await setCat(c2, 'RETIRED');
    await expectError(setSt(s2, 'ACTIVE'), 'INVALID_STATE', 'STATUS_TRANSITION'); // RETIRED is terminal before anything else is asked
  });

  it('the code and the category of an existing item can never change (there is no operation that moves a service type; the guard says IMMUTABLE)', async () => {
    const c = await mkCategory();
    const c2 = await mkCategory();
    const s = await mkServiceType(c);
    for (const raw of [
      `UPDATE catalog.service_types SET category_id = (SELECT category_id FROM catalog.categories WHERE code = '${c2}') WHERE code = '${s}'`,
      `UPDATE catalog.service_types SET code = 'devtest_other' WHERE code = '${s}'`,
      `UPDATE catalog.categories SET code = 'devtest_other' WHERE code = '${c}'`,
      `DELETE FROM catalog.service_types WHERE code = '${s}'`,
      `DELETE FROM catalog.categories WHERE code = '${c}'`,
    ])
      await expect(q(raw)).rejects.toMatchObject({ code: '23000' });
    expect(await bare.getServiceType(s)).toMatchObject({ categoryCode: c });
  });
});

// ====================================================================== 11. availability
describe('market availability', () => {
  it('a new row needs displayOrder (VALIDATION_FAILED DISPLAY_ORDER_REQUIRED) and leaves nothing behind; an existing row keeps its order when none is given', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    const world = await worldHash();
    const e1 = await expectError(catAvail(market, c, true), 'VALIDATION_FAILED', 'DISPLAY_ORDER_REQUIRED');
    expect(e1.details.field).toBe('displayOrder');
    await expectError(stAvail(market, s, false), 'VALIDATION_FAILED', 'DISPLAY_ORDER_REQUIRED');
    expect(await worldHash()).toBe(world);
    await catAvail(market, c, true, 40);
    expect((await catAvail(market, c, false)).displayOrder).toBe(40);
    expect((await catAvail(market, c, true)).displayOrder).toBe(40);
    expect(await mcRow(market, c)).toEqual([{ enabled: true, display_order: 40 }]);
  });

  it('a duplicate display order in the same market is CONFLICT DISPLAY_ORDER_TAKEN (also for a disabled row), nothing is written, and another market or the other kind may reuse the number', async () => {
    const m1 = await mkMarket(true);
    const m2 = await mkMarket(true);
    const a = await mkCategory();
    const d = await mkCategory();
    const b = await mkCategory();
    const sa = await mkServiceType(a);
    const sd = await mkServiceType(a);
    const sb = await mkServiceType(a);
    await catAvail(m1, a, true, 10);
    await catAvail(m1, d, false, 20); // a disabled row still owns its position
    await stAvail(m1, sa, true, 10);
    await stAvail(m1, sd, false, 20);
    const world = await worldHash();
    for (const order of [10, 20]) {
      const e = await expectError(catAvail(m1, b, true, order), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
      expect(e.details.retryable).toBeUndefined();
      await expectError(catAvail(m1, b, false, order), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
      await expectError(stAvail(m1, sb, true, order), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
      await expectError(stAvail(m1, sb, false, order), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
    }
    expect(await worldHash()).toBe(world);
    await catAvail(m2, b, true, 10); // another market
    await catAvail(m2, a, true, 20);
    await stAvail(m1, sb, true, 30);
    await catAvail(m1, b, true, 30); // a category may reuse a service type's number
    // changing an existing row onto a taken number is refused too, and the row keeps its own
    await catAvail(m2, a, true, 30);
    await expectError(catAvail(m2, a, true, 10), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
    expect((await mcRow(m2, a))[0]!.display_order).toBe(30);
    // bounds
    const edge = await mkCategory();
    await catAvail(m1, edge, false, 1);
    const edge2 = await mkCategory();
    await catAvail(m1, edge2, false, 9999);
    await expectError(catAvail(m1, await mkCategory(), false, 0), 'VALIDATION_FAILED', 'INVALID_FIELD');
    await expectError(catAvail(m1, await mkCategory(), false, 10000), 'VALIDATION_FAILED', 'INVALID_FIELD');
  });

  it('swapping two orders directly is refused (the unique key is not deferrable), the three-step swap through a free number works and is audited step by step', async () => {
    const m = await mkMarket(true);
    const a = await mkCategory();
    const b = await mkCategory();
    await catAvail(m, a, true, 10);
    await catAvail(m, b, true, 20);
    await expectError(catAvail(m, a, true, 20), 'CONFLICT', 'DISPLAY_ORDER_TAKEN');
    await catAvail(m, a, true, 99);
    await catAvail(m, b, true, 10);
    await catAvail(m, a, true, 20);
    expect((await mcRow(m, a))[0]!.display_order).toBe(20);
    expect((await mcRow(m, b))[0]!.display_order).toBe(10);
    expect((await availabilityAudit(m, 'CATEGORY', a)).map((x) => x.changes!.displayOrder)).toEqual([
      [null, 10],
      [10, 99],
      [99, 20],
    ]);
  });

  it('first insert and later changes are audited as exact enabled/displayOrder diffs with the market and ONE subject, and announced with an identifier-only event', async () => {
    const m = await mkMarket(true);
    const marketId = (await one<{ market_id: string }>('SELECT market_id FROM geography.markets WHERE code = $1', [m])).market_id;
    const c = await mkCategory();
    const s = await mkServiceType(c);
    const corr = `corr-av-${seq}`;
    const dto = await runWithCorrelation(corr, () => catAvail(m, c, true, 10));
    expect(dto).toEqual({ marketCode: m, code: c, kind: 'CATEGORY', enabled: true, displayOrder: 10, alsoDisabled: [] });
    await runWithCorrelation(corr + 'b', () => stAvail(m, s, true, 20));
    await catAvail(m, c, true, 15); // order only
    const ca = await availabilityAudit(m, 'CATEGORY', c);
    expect(ca.map((x) => [x.action, x.actor, x.reason, x.changes, x.has_category, x.has_service_type])).toEqual([
      ['MARKET_CATALOG_AVAILABILITY_CHANGED', ACTOR, REASON, { enabled: [null, true], displayOrder: [null, 10] }, true, false],
      ['MARKET_CATALOG_AVAILABILITY_CHANGED', ACTOR, REASON, { enabled: [true, true], displayOrder: [10, 15] }, true, false],
    ]);
    expect(ca[0]!.correlation_id).toBe(corr);
    const sa = await availabilityAudit(m, 'SERVICE_TYPE', s);
    expect(sa).toHaveLength(1);
    expect(sa[0]).toMatchObject({
      changes: { enabled: [null, true], displayOrder: [null, 20] },
      has_category: false,
      has_service_type: true,
      correlation_id: corr + 'b',
    });
    const evs = await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, kind: 'CATEGORY', code: c });
    expect(evs).toHaveLength(2);
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
      expect(keys(ev.payload_json)).toEqual(['code', 'enabled', 'kind', 'marketCode']);
      expect(ev.payload_json).toEqual({ marketCode: m, kind: 'CATEGORY', code: c, enabled: true });
    }
    expect(evs[0]!.correlation_id).toBe(corr);
    const sev = await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, kind: 'SERVICE_TYPE', code: s });
    expect(sev).toHaveLength(1);
    expect(sev[0]!.payload_json).toEqual({ marketCode: m, kind: 'SERVICE_TYPE', code: s, enabled: true });
  });

  it('a PLANNED market (the seeded la-oc) can be prepared, but it is not public', async () => {
    const c = await mkCategory();
    await setCat(c, 'ACTIVE');
    const dto = await catAvail('la-oc', c, true, 5000 + seq);
    expect(dto.marketCode).toBe('la-oc');
    expect((await bare.getCategory(c, { marketCode: 'la-oc' })).enabled).toBe(true);
    await expectError(bare.getMarketCatalog('la-oc'), 'MARKET_NOT_FOUND');
  });

  it('availability may be prepared for an item that is not ACTIVE (DRAFT, INACTIVE), which stays invisible until it is ACTIVE', async () => {
    const m = await mkMarket(true);
    const draft = await mkCategory();
    const inactive = await mkCategory();
    await setCat(inactive, 'ACTIVE');
    await setCat(inactive, 'INACTIVE');
    await catAvail(m, draft, true, 'auto');
    await catAvail(m, inactive, true, 'auto');
    expect((await bare.getMarketCatalog(m)).categories).toEqual([]);
    await setCat(draft, 'ACTIVE');
    expect((await bare.getMarketCatalog(m)).categories.map((x) => x.code)).toEqual([draft]);
  });

  it('enabling a service type before its category is INVALID_STATE CATEGORY_NOT_ENABLED_IN_MARKET (no row, disabled row), a disabled row may be prepared, and after the category is enabled it works', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    const world = await worldHash();
    await expectError(stAvail(m, s, true, 10), 'INVALID_STATE', 'CATEGORY_NOT_ENABLED_IN_MARKET');
    expect(await worldHash()).toBe(world);
    expect(await mstRow(m, s)).toEqual([]);
    await catAvail(m, c, false, 10);
    await expectError(stAvail(m, s, true, 10), 'INVALID_STATE', 'CATEGORY_NOT_ENABLED_IN_MARKET');
    await stAvail(m, s, false, 10); // preparing a disabled row is fine
    await expectError(stAvail(m, s, true), 'INVALID_STATE', 'CATEGORY_NOT_ENABLED_IN_MARKET');
    expect((await mstRow(m, s))[0]!.enabled).toBe(false);
    await catAvail(m, c, true);
    expect((await stAvail(m, s, true)).enabled).toBe(true);
    // the category of ANOTHER market does not count
    const m2 = await mkMarket(true);
    await expectError(stAvail(m2, s, true, 10), 'INVALID_STATE', 'CATEGORY_NOT_ENABLED_IN_MARKET');
  });

  it('a RETIRED category or service type can never be enabled (ITEM_RETIRED), but a row can still be prepared disabled and an enabled one switched off', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await catAvail(m, c, true, 'auto');
    await stAvail(m, s, true, 'auto');
    await setSt(s, 'RETIRED');
    await setCat(c, 'RETIRED');
    expect((await stAvail(m, s, false)).enabled).toBe(false); // switching a retired item off is fine
    await expectError(stAvail(m, s, true), 'INVALID_STATE', 'ITEM_RETIRED');
    expect((await mstRow(m, s))[0]!.enabled).toBe(false);
    expect((await catAvail(m, c, false)).enabled).toBe(false);
    await expectError(catAvail(m, c, true), 'INVALID_STATE', 'ITEM_RETIRED');
    // a retired item can be prepared DISABLED, but never inserted enabled
    const r1 = await mkCategory();
    await setCat(r1, 'RETIRED');
    expect((await catAvail(m, r1, false, 'auto')).enabled).toBe(false);
    const r2 = await mkCategory();
    await setCat(r2, 'RETIRED');
    const world = await worldHash();
    await expectError(catAvail(m, r2, true, 'auto'), 'INVALID_STATE', 'ITEM_RETIRED');
    expect(await worldHash()).toBe(world);
    expect(await mcRow(m, r2)).toEqual([]);
  });

  it('unknown market, unknown category and unknown service type are typed errors, the market is checked first, and nothing is written', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const world = await worldHash();
    await expectError(catAvail('devtest-missing', c, true, 10), 'MARKET_NOT_FOUND');
    await expectError(catAvail('DEVTEST-M1', c, true, 10), 'MARKET_NOT_FOUND');
    await expectError(catAvail('devtest-missing', 'devtest_nothing', true, 10), 'MARKET_NOT_FOUND');
    await expectError(catAvail(m, 'devtest_nothing', true, 10), 'CATEGORY_NOT_FOUND');
    await expectError(stAvail('devtest-missing', 'devtest_nothing', true, 10), 'MARKET_NOT_FOUND');
    await expectError(stAvail(m, 'devtest_nothing', true, 10), 'SERVICE_TYPE_NOT_FOUND');
    await expectError(stAvail(m, c, true, 10), 'SERVICE_TYPE_NOT_FOUND'); // a category code is not a service type
    expect(await worldHash()).toBe(world);
  });

  it('switching a category OFF first switches off its enabled service types in that market: audited and announced one by one, alsoDisabled sorted by code, other markets and other categories untouched, one bump', async () => {
    const m1 = await mkMarket(true);
    const m2 = await mkMarket(true);
    const marketId = (await one<{ market_id: string }>('SELECT market_id FROM geography.markets WHERE code = $1', [m1])).market_id;
    const a = await mkCategory();
    const other = await mkCategory();
    await catAvail(m1, a, true, 10);
    await catAvail(m1, other, true, 20);
    await catAvail(m2, a, true, 10);
    const sts = [await mkServiceType(a), await mkServiceType(a), await mkServiceType(a), await mkServiceType(a)];
    const [x, y, z, off] = sts as [string, string, string, string];
    const foreign = await mkServiceType(other);
    // orders chosen against the code order, so that "sorted by code" is not an accident of insertion
    await stAvail(m1, z, true, 10);
    await stAvail(m1, x, true, 30);
    await stAvail(m1, y, true, 20);
    await stAvail(m1, off, false, 40); // already off: not part of alsoDisabled
    await stAvail(m1, foreign, true, 50);
    for (const s of [x, z]) await stAvail(m2, s, true, 10 + (s === z ? 10 : 0));
    await setCat(a, 'ACTIVE');
    for (const s of [x, y, z]) await setSt(s, 'ACTIVE');
    const g = cache.gen();
    const before = await counts();
    const corr = `corr-cascade-${seq}`;
    const dto = await runWithCorrelation(corr, () => catAvail(m1, a, false, 12));
    expect(dto).toEqual({ marketCode: m1, code: a, kind: 'CATEGORY', enabled: false, displayOrder: 12, alsoDisabled: [x, y, z].sort() });
    // state
    expect(await mcRow(m1, a)).toEqual([{ enabled: false, display_order: 12 }]);
    for (const s of [x, y, z]) expect((await mstRow(m1, s))[0]!.enabled, s).toBe(false);
    expect((await mstRow(m1, off))[0]).toEqual({ enabled: false, display_order: 40 });
    expect((await mstRow(m1, foreign))[0]!.enabled).toBe(true);
    expect((await mcRow(m1, other))[0]!.enabled).toBe(true);
    expect(await mcRow(m2, a)).toEqual([{ enabled: true, display_order: 10 }]);
    for (const s of [x, z]) expect((await mstRow(m2, s))[0]!.enabled, `${s} in the other market`).toBe(true);
    // audit: one row per service type (with the reason and the because-field) and one for the category
    const orderOf = new Map([
      [x, 30],
      [y, 20],
      [z, 10],
    ]);
    for (const s of [x, y, z]) {
      const audit = (await availabilityAudit(m1, 'SERVICE_TYPE', s)).at(-1)!;
      expect(audit).toMatchObject({
        action: 'MARKET_CATALOG_AVAILABILITY_CHANGED',
        actor: ACTOR,
        reason: REASON,
        correlation_id: corr,
        changes: { enabled: [true, false], displayOrder: [orderOf.get(s), orderOf.get(s)], becauseCategory: a },
        has_service_type: true,
        has_category: false,
      });
    }
    expect((await availabilityAudit(m1, 'SERVICE_TYPE', off)).at(-1)!.changes).toEqual({ enabled: [null, false], displayOrder: [null, 40] }); // untouched by the cascade
    expect((await availabilityAudit(m1, 'SERVICE_TYPE', foreign)).at(-1)!.changes).toEqual({ enabled: [null, true], displayOrder: [null, 50] });
    expect((await availabilityAudit(m1, 'CATEGORY', a)).at(-1)!.changes).toEqual({ enabled: [true, false], displayOrder: [10, 12] });
    const after = await counts();
    expect(after.audit - before.audit).toBe(4);
    expect(after.events - before.events).toBe(4);
    // events: one per service type and one for the category, all for the market, same correlation id
    const evs = (
      await q<OutboxRow>(
        `SELECT ${OUTBOX_COLS} FROM integration.outbox_events WHERE event_type = $1 AND payload_json->>'marketCode' = $2 AND correlation_id = $3`,
        [CATALOG_EVENTS.availabilityChanged, m1, corr],
      )
    ).sort((p, r) => String(p.payload_json.code).localeCompare(String(r.payload_json.code)));
    expect(evs.map((e) => [e.payload_json.kind, e.payload_json.code, e.payload_json.enabled])).toEqual(
      [...[x, y, z].map((s) => ['SERVICE_TYPE', s, false]), ['CATEGORY', a, false]].sort((p, r) => String(p[1]).localeCompare(String(r[1]))),
    );
    for (const e of evs) {
      expect(e.aggregate_id).toBe(marketId);
      expect(e.aggregate_type).toBe('catalog_market_availability');
      expect(keys(e.payload_json)).toEqual(['code', 'enabled', 'kind', 'marketCode']);
    }
    // the cache: exactly one bump for the whole cascade
    expect(cache.gen()).toBe(g + 1);
    // the public view of M1 lost the whole category, M2 keeps it with its own order
    await setCat(other, 'ACTIVE');
    expect((await bare.getMarketCatalog(m1)).categories.map((c) => c.code)).toEqual([other]);
    expect((await bare.getMarketCatalog(m1)).serviceTypes.map((s) => s.code)).toEqual([]);
    expect((await bare.getMarketCatalog(m2)).categories.map((c) => c.code)).toEqual([a]);
    expect((await bare.getMarketCatalog(m2)).serviceTypes.map((s) => s.code)).toEqual([x, z]);
  });

  it('alsoDisabled is sorted by code in BYTE order, whatever the database collation (a list an API client compares must not depend on the server locale)', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    await catAvail(m, c, true, 10);
    // 'devtest_o_b...' sorts BEFORE 'devtest_oa...' in byte order ('_' < 'a') but AFTER it in an en_US collation that ignores punctuation
    const lo = await mkServiceType(c, { code: `devtest_o_b${++seq}` });
    const hi = await mkServiceType(c, { code: `devtest_oa${++seq}` });
    await stAvail(m, hi, true, 10);
    await stAvail(m, lo, true, 20);
    const dto = await catAvail(m, c, false);
    expect(dto.alsoDisabled).toEqual([lo, hi].sort());
  });

  it('every list ordered by code is in BYTE order whatever the database collation: global and per-market category lists, service type lists, prohibited services', async () => {
    const m = await mkMarket(false);
    const n = ++seq;
    // in byte order '_' < 'a'; an en_US collation that ignores punctuation puts the first one SECOND
    const lowC = await mkCategory({ code: `devtest_k_b${n}` });
    const highC = await mkCategory({ code: `devtest_ka${n}` });
    const lowS = await mkServiceType(lowC, { code: `devtest_k_s${n}` });
    const highS = await mkServiceType(lowC, { code: `devtest_kas${n}` });
    const otherS = await mkServiceType(highC, { code: `devtest_k_t${n}` });
    const lowP = await mkProhibited({ code: `devtest_k_p${n}` });
    const highP = await mkProhibited({ code: `devtest_kap${n}` });
    const mine = <T extends { code: string }>(rows: T[], wanted: string[]) => rows.filter((r) => wanted.includes(r.code)).map((r) => r.code);
    expect(mine(await bare.listCategories(), [lowC, highC])).toEqual([lowC, highC]);
    expect(mine(await bare.listCategories({ marketCode: m }), [lowC, highC])).toEqual([lowC, highC]); // neither is configured: ordered by code
    expect(mine(await bare.listServiceTypes(), [lowS, highS, otherS])).toEqual([lowS, highS, otherS]); // category code first, then service type code
    expect(mine(await bare.listServiceTypes({ marketCode: m }), [lowS, highS, otherS])).toEqual([lowS, highS, otherS]);
    expect(mine(await bare.listServiceTypes({ categoryCode: lowC }), [lowS, highS])).toEqual([lowS, highS]);
    expect(mine(await bare.listProhibitedServices(), [lowP, highP])).toEqual([lowP, highP]);
  });

  it('a switch-off with no enabled service type reports an empty alsoDisabled and a switch-on never cascades', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    await catAvail(m, c, true, 10);
    expect((await catAvail(m, c, false)).alsoDisabled).toEqual([]);
    expect((await catAvail(m, c, true)).alsoDisabled).toEqual([]);
    const s = await mkServiceType(c);
    await stAvail(m, s, true, 10);
    expect((await catAvail(m, c, true, 11)).alsoDisabled).toEqual([]); // order change of a category that stays on
    expect((await mstRow(m, s))[0]!.enabled).toBe(true);
  });
});

// ====================================================================== 12. content
describe('names and descriptions are content', () => {
  it('a code without its name entry is VALIDATION_FAILED NAME_CONTENT_MISSING (categories, service types, prohibited services); without its description entry only when a description is asked for', async () => {
    const world = await worldHash();
    const cc = code('c');
    await expectError(svc.createCategory({ code: cc, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'NAME_CONTENT_MISSING');
    await addContent('category', cc); // name only
    await expectError(svc.createCategory({ code: cc, withDescription: true, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'DESCRIPTION_CONTENT_MISSING');
    expect(await worldHash()).toBe(world);
    expect((await svc.createCategory({ code: cc, withDescription: false, reason: REASON }, ACTOR)).descriptionContentKey).toBeNull();
    const parent = await mkCategory();
    const sc = code('s');
    await expectError(svc.createServiceType({ code: sc, categoryCode: parent, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'NAME_CONTENT_MISSING');
    await addContent('service_type', sc);
    await expectError(
      svc.createServiceType({ code: sc, categoryCode: parent, withDescription: true, reason: REASON }, ACTOR),
      'VALIDATION_FAILED',
      'DESCRIPTION_CONTENT_MISSING',
    );
    const pc = code('p');
    await expectError(svc.createProhibitedService({ code: pc, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'NAME_CONTENT_MISSING');
    await addContent('prohibited_service', pc);
    await expectError(
      svc.createProhibitedService({ code: pc, withDescription: true, reason: REASON }, ACTOR),
      'VALIDATION_FAILED',
      'DESCRIPTION_CONTENT_MISSING',
    );
    // both missing: the name is reported first
    await expectError(svc.createCategory({ code: code('c'), withDescription: true, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'NAME_CONTENT_MISSING');
    // the message names neither the key nor the table
    const e = await expectError(svc.createCategory({ code: code('c'), reason: REASON }, ACTOR), 'VALIDATION_FAILED');
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/catalog\.|content\.|fk_|_content_key/);
  });

  it("linking a description that does not exist is refused on update and changes nothing; a category cannot borrow another code's description", async () => {
    const c = await mkCategory();
    const s = await mkServiceType(c);
    const world = await worldHash();
    await expectError(svc.updateCategory(c, { withDescription: true, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'DESCRIPTION_CONTENT_MISSING');
    await expectError(svc.updateServiceType(s, { withDescription: true, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'DESCRIPTION_CONTENT_MISSING');
    expect(await worldHash()).toBe(world);
    await expect(
      q('UPDATE catalog.categories SET description_content_key = $1 WHERE code = $2', [
        `catalog.category.${await mkCategory({ withDescription: true })}.description`,
        c,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a test-only code is refused without allowTestKeys (nothing written) and an ordinary code is created fine', async () => {
    const world = await worldHash();
    const t = code('c');
    await addContent('category', t);
    const e = await expectError(strict.createCategory({ code: t, reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'TEST_KEY_NOT_ALLOWED');
    expect(e.details.field).toBe('code');
    await expectError(
      strict.createServiceType({ code: code('s'), categoryCode: 'home_cleaning', reason: REASON }, ACTOR),
      'VALIDATION_FAILED',
      'TEST_KEY_NOT_ALLOWED',
    );
    await expectError(strict.createProhibitedService({ code: code('p'), reason: REASON }, ACTOR), 'VALIDATION_FAILED', 'TEST_KEY_NOT_ALLOWED');
    expect(await worldHash()).toBe(world);
    await addContent('category', 'garden_care');
    expect((await strict.createCategory({ code: 'garden_care', reason: REASON }, ACTOR)).code).toBe('garden_care');
    await expectError(strict.createCategory({ code: 'garden_care', reason: REASON }, ACTOR), 'CONFLICT', 'CODE_TAKEN');
    // the strict service still manages (and reads) a devtest_ row that already exists
    expect((await strict.getCategory(await mkCategory())).status).toBe('DRAFT');
  });
});

// ====================================================================== 13. concurrency
describe('concurrency through the service (real transactions)', () => {
  // open the service's connections up front: on a cold pool the callers start one after the other and a race can quietly become a sequence
  beforeAll(async () => {
    await Promise.all(Array.from({ length: 30 }, () => iso.database.query('SELECT pg_sleep(0.1)')));
  });

  it('20 simultaneous activations of one category: every caller sees ACTIVE, ONE status change, ONE audit row, ONE event, ONE cache bump', async () => {
    for (let round = 0; round < 3; round++) {
      const c = await mkCategory();
      const incrs = cache.incrs.length;
      const results = await Promise.all(Array.from({ length: 20 }, () => setCat(c, 'ACTIVE')));
      expect(results.every((r) => r.status === 'ACTIVE')).toBe(true);
      expect((await categoryAudit(c)).map((a) => a.action)).toEqual(['CATEGORY_CREATED', 'CATEGORY_STATUS_CHANGED']);
      expect(await eventsWhere(CATALOG_EVENTS.categoryActivated, { categoryCode: c })).toHaveLength(1);
      expect(cache.incrs.length - incrs).toBe(1);
    }
  });

  it('20 simultaneous activations of one service type behave the same', async () => {
    const cat = await mkCategory();
    await setCat(cat, 'ACTIVE');
    const s = await mkServiceType(cat);
    const results = await Promise.all(Array.from({ length: 20 }, () => setSt(s, 'ACTIVE')));
    expect(results.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(await serviceTypeAudit(s)).toHaveLength(2);
    expect(await eventsWhere(CATALOG_EVENTS.serviceTypeActivated, { serviceTypeCode: s })).toHaveLength(1);
  });

  it('simultaneous mixed status changes of one category leave a consistent chain: every audit row continues the previous one, the last matches the row, events match the ACTIVE transitions', async () => {
    for (let round = 0; round < 3; round++) {
      const c = await mkCategory();
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
      const outcomes = await Promise.all(wanted.map((status) => err(setCat(c, status))));
      for (const e of outcomes) if (e) expect(['INVALID_STATE', 'CONFLICT']).toContain(e.code);
      const chain = (await categoryAudit(c)).slice(1).map((a) => a.changes!.status as [string, string]);
      let at = 'DRAFT';
      for (const [from, to] of chain) {
        expect(from).toBe(at);
        expect(isCatalogTransitionAllowed(from as CatalogStatus, to as CatalogStatus)).toBe(true);
        at = to;
      }
      expect(await dbStatus('categories', c)).toBe(at);
      const entering = chain.filter(([, to]) => to === 'ACTIVE').length;
      const leaving = chain.filter(([from]) => from === 'ACTIVE').length;
      expect(await eventsWhere(CATALOG_EVENTS.categoryActivated, { categoryCode: c })).toHaveLength(entering);
      expect(await eventsWhere(CATALOG_EVENTS.categoryDeactivated, { categoryCode: c })).toHaveLength(leaving);
    }
  });

  it('activating a service type against deactivating its category: exactly one wins, the other gets the typed refusal, and the invariant (no ACTIVE service type under a category that is not ACTIVE) holds, 15 rounds', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 15; round++) {
      const c = await mkCategory();
      const s = await mkServiceType(c);
      await setCat(c, 'ACTIVE');
      const [a, b] = await Promise.all([err(setSt(s, 'ACTIVE')), err(setCat(c, 'INACTIVE'))]);
      expect([a, b].filter(Boolean), 'exactly one of the two is refused').toHaveLength(1);
      const refused = (a ?? b)!;
      expect(refused.code).toBe('INVALID_STATE');
      expect(['CATEGORY_NOT_ACTIVE', 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES']).toContain(refused.details.reason);
      outcomes.add(String(refused.details.reason));
      const cs = await dbStatus('categories', c);
      const ss = await dbStatus('service_types', s);
      expect(ss === 'ACTIVE' && cs !== 'ACTIVE', `category ${cs}, service type ${ss}`).toBe(false);
      // the refusal matches the winner
      expect(refused.details.reason).toBe(a ? 'CATEGORY_NOT_ACTIVE' : 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it('deterministic: a service type activation in flight makes the category deactivation wait and then fail with CATEGORY_HAS_ACTIVE_SERVICE_TYPES', async () => {
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    const t = await rawTx();
    await t.query("UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = $1", [s]);
    const incrs = cache.incrs.length;
    const pending = err(setCat(c, 'INACTIVE'));
    await waitUntilBlocked();
    await t.commit();
    const e = (await pending)!;
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details.reason).toBe('CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    expect(await dbStatus('categories', c)).toBe('ACTIVE');
    expect(cache.incrs.length).toBe(incrs);
    expect((await categoryAudit(c)).map((a) => a.action)).toEqual(['CATEGORY_CREATED', 'CATEGORY_STATUS_CHANGED']);
  });

  it('deterministic: a category deactivation in flight makes the service type activation wait and then fail with CATEGORY_NOT_ACTIVE', async () => {
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    const t = await rawTx();
    await t.query("UPDATE catalog.categories SET status = 'INACTIVE' WHERE code = $1", [c]);
    const pending = err(setSt(s, 'ACTIVE'));
    await waitUntilBlocked();
    await t.commit();
    const e = (await pending)!;
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details.reason).toBe('CATEGORY_NOT_ACTIVE');
    expect(await dbStatus('service_types', s)).toBe('DRAFT');
    expect(await eventsWhere(CATALOG_EVENTS.serviceTypeActivated, { serviceTypeCode: s })).toEqual([]);
  });

  it('creating a service type against retiring its category: either the service type exists and the category was refused, or the category is RETIRED and no service type was created (15 rounds)', async () => {
    for (let round = 0; round < 15; round++) {
      const c = await mkCategory();
      const sc = code('s');
      await addContent('service_type', sc);
      const [a, b] = await Promise.all([err(svc.createServiceType({ code: sc, categoryCode: c, reason: REASON }, ACTOR)), err(setCat(c, 'RETIRED'))]);
      expect([a, b].filter(Boolean), 'exactly one is refused').toHaveLength(1);
      expect((a ?? b)!.details.reason).toBe(a ? 'CATEGORY_RETIRED' : 'CATEGORY_HAS_OPEN_SERVICE_TYPES');
      const open = await one<{ n: number }>(
        "SELECT count(*)::int AS n FROM catalog.service_types st JOIN catalog.categories c USING (category_id) WHERE c.code = $1 AND st.status <> 'RETIRED'",
        [c],
      );
      expect((await dbStatus('categories', c)) === 'RETIRED' && open.n > 0).toBe(false);
    }
  });

  it('simultaneous creates of the same code: one wins, every other gets CONFLICT CODE_TAKEN, one row and one audit row (categories, service types, prohibited services, and a service type code across categories)', async () => {
    const c = code('c');
    await addContent('category', c);
    const r = await Promise.all(Array.from({ length: 10 }, () => err(svc.createCategory({ code: c, reason: REASON }, ACTOR))));
    expect(r.filter((e) => !e)).toHaveLength(1);
    for (const e of r.filter(Boolean)) {
      expect(e!.code).toBe('CONFLICT');
      expect(e!.details.reason).toBe('CODE_TAKEN');
    }
    expect(await categoryAudit(c)).toHaveLength(1);
    const p1 = await mkCategory();
    const p2 = await mkCategory();
    const s = code('s');
    await addContent('service_type', s);
    const r2 = await Promise.all(
      Array.from({ length: 10 }, (_, i) => err(svc.createServiceType({ code: s, categoryCode: i % 2 ? p1 : p2, reason: REASON }, ACTOR))),
    );
    expect(r2.filter((e) => !e)).toHaveLength(1);
    for (const e of r2.filter(Boolean)) expect([e!.code, e!.details.reason]).toEqual(['CONFLICT', 'CODE_TAKEN']);
    expect(await serviceTypeAudit(s)).toHaveLength(1);
    const p = code('p');
    await addContent('prohibited_service', p);
    const r3 = await Promise.all(Array.from({ length: 8 }, () => err(svc.createProhibitedService({ code: p, reason: REASON }, ACTOR))));
    expect(r3.filter((e) => !e)).toHaveLength(1);
    expect(await prohibitedAudit(p)).toHaveLength(1);
  });

  it('simultaneous identical availability requests for a NEW pair converge: every caller succeeds with the same result, and exactly one row, one audit row and one event exist', async () => {
    for (let round = 0; round < 3; round++) {
      const m = await mkMarket(true);
      const c = await mkCategory();
      const incrs = cache.incrs.length;
      const r = await Promise.all(
        Array.from({ length: 10 }, () =>
          catAvail(m, c, true, 10).then(
            (d) => d,
            (e: unknown) => e as Error,
          ),
        ),
      );
      for (const d of r)
        expect(d, d instanceof Error ? String((d as CatalogError).details?.reason) : '').toEqual({
          marketCode: m,
          code: c,
          kind: 'CATEGORY',
          enabled: true,
          displayOrder: 10,
          alsoDisabled: [],
        });
      expect((await mcRow(m, c)).length).toBe(1);
      expect(await availabilityAudit(m, 'CATEGORY', c)).toHaveLength(1);
      expect(await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, code: c })).toHaveLength(1);
      expect(cache.incrs.length - incrs, 'only the winner bumps').toBe(1);
      const s = await mkServiceType(c);
      const r2 = await Promise.all(
        Array.from({ length: 10 }, () =>
          stAvail(m, s, true, 10).then(
            (d) => d,
            (e: unknown) => e as Error,
          ),
        ),
      );
      for (const d of r2)
        expect(d, d instanceof Error ? String((d as CatalogError).details?.reason) : '').toMatchObject({
          code: s,
          kind: 'SERVICE_TYPE',
          enabled: true,
          displayOrder: 10,
        });
      expect((await mstRow(m, s)).length).toBe(1);
      expect(await availabilityAudit(m, 'SERVICE_TYPE', s)).toHaveLength(1);
      expect(await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, code: s })).toHaveLength(1);
    }
  });

  it('deterministic: a lost race on the INSERT of a new availability row is retried once: the same request is a no-op (nothing audited, announced or bumped), a different one is applied on top of the winner', async () => {
    const m = await mkMarket(true);
    const parent = await mkCategory();
    await catAvail(m, parent, true, 'auto');
    const kinds = [
      {
        label: 'category',
        insert:
          'INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) SELECT m.market_id, x.category_id, $4, $3 FROM geography.markets m, catalog.categories x WHERE m.code = $1 AND x.code = $2',
        make: () => mkCategory(),
        order: () => nextOrder(m, 'c'),
        call: (target: string, enabled: boolean, order: number) => catAvail(m, target, enabled, order),
        row: (t: string) => mcRow(m, t),
        audit: (t: string) => availabilityAudit(m, 'CATEGORY', t),
      },
      {
        label: 'service type',
        insert:
          'INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) SELECT m.market_id, x.service_type_id, $4, $3 FROM geography.markets m, catalog.service_types x WHERE m.code = $1 AND x.code = $2',
        make: () => mkServiceType(parent),
        order: () => nextOrder(m, 's'),
        call: (target: string, enabled: boolean, order: number) => stAvail(m, target, enabled, order),
        row: (t: string) => mstRow(m, t),
        audit: (t: string) => availabilityAudit(m, 'SERVICE_TYPE', t),
      },
    ];
    for (const k of kinds) {
      // (a) the other session inserts exactly what this request asks for
      const same = await k.make();
      const order = k.order();
      let t = await rawTx();
      await t.query(k.insert, [m, same, order, true]);
      const incrs = cache.incrs.length;
      let pending = k.call(same, true, order);
      await waitUntilBlocked();
      await t.commit();
      expect(await pending, `${k.label} same`).toMatchObject({ code: same, enabled: true, displayOrder: order, alsoDisabled: [] });
      expect(await k.row(same)).toEqual([{ enabled: true, display_order: order }]);
      expect(await k.audit(same), 'the foreign insert is not audited and the retried no-op writes nothing').toHaveLength(0);
      expect(await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, code: same })).toEqual([]);
      expect(cache.incrs.length, 'a retried no-op does not bump').toBe(incrs);
      // (b) the other session inserts the row DISABLED; this request wants it enabled: it is applied on top
      const other = await k.make();
      const order2 = k.order();
      t = await rawTx();
      await t.query(k.insert, [m, other, order2, false]);
      pending = k.call(other, true, order2);
      await waitUntilBlocked();
      await t.commit();
      expect(await pending, `${k.label} other`).toMatchObject({ code: other, enabled: true, displayOrder: order2 });
      expect(await k.row(other)).toEqual([{ enabled: true, display_order: order2 }]);
      const audit = await k.audit(other);
      expect(audit.map((a) => a.changes)).toEqual([{ enabled: [false, true], displayOrder: [order2, order2] }]);
      expect(await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, code: other })).toHaveLength(1);
      expect(cache.incrs.length, 'the applied retry bumps exactly once').toBe(incrs + 1);
    }
  });

  it('simultaneous changes of an EXISTING pair serialize on its row: the audit rows form a chain old -> new, the last one is the stored state, one event per change', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    await catAvail(m, c, true, 10);
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
    const out = await Promise.all(plan.map(([enabled, order]) => err(catAvail(m, c, enabled, order))));
    expect(out.filter(Boolean)).toEqual([]);
    const chain = (await availabilityAudit(m, 'CATEGORY', c)).map(
      (a) => a.changes as { enabled: [boolean | null, boolean]; displayOrder: [number | null, number] },
    );
    expect(chain).toHaveLength(1 + plan.length);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.enabled[0], `row ${i}`).toBe(chain[i - 1]!.enabled[1]);
      expect(chain[i]!.displayOrder[0], `row ${i}`).toBe(chain[i - 1]!.displayOrder[1]);
    }
    const last = chain.at(-1)!;
    expect(await mcRow(m, c)).toEqual([{ enabled: last.enabled[1], display_order: last.displayOrder[1] }]);
    expect(await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, code: c })).toHaveLength(chain.length);
  });

  it('two categories moved onto the same order at once: one wins, the other gets DISPLAY_ORDER_TAKEN, and the orders stay unique', async () => {
    for (let round = 0; round < 5; round++) {
      const m = await mkMarket(true);
      const a = await mkCategory();
      const b = await mkCategory();
      await catAvail(m, a, true, 10);
      await catAvail(m, b, true, 20);
      const [ra, rb] = await Promise.all([err(catAvail(m, a, true, 40)), err(catAvail(m, b, true, 40))]);
      expect([ra, rb].filter(Boolean)).toHaveLength(1);
      expect((ra ?? rb)!.details.reason).toBe('DISPLAY_ORDER_TAKEN');
      const orders = (
        await q<{ display_order: number }>(
          'SELECT display_order FROM catalog.market_categories mc JOIN geography.markets m USING (market_id) WHERE m.code = $1',
          [m],
        )
      ).map((x) => x.display_order);
      expect(new Set(orders).size).toBe(2);
      expect(orders.filter((o) => o === 40)).toHaveLength(1);
    }
  });

  it('switching a category off against enabling one of its service types in the same market: the invariant holds and each outcome is one of the two legal ones (20 rounds)', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 20; round++) {
      const m = await mkMarket(true);
      const c = await mkCategory();
      const s = await mkServiceType(c);
      await catAvail(m, c, true, 10);
      await stAvail(m, s, false, 10);
      const [off, on] = await Promise.all([err(catAvail(m, c, false)), err(stAvail(m, s, true))]);
      const cEnabled = (await mcRow(m, c))[0]!.enabled;
      const sEnabled = (await mstRow(m, s))[0]!.enabled;
      expect(sEnabled && !cEnabled, 'an enabled service type under a category that is off').toBe(false);
      expect(off, 'switching a category off never fails').toBeUndefined();
      if (on) {
        expect(on.code).toBe('INVALID_STATE');
        expect(on.details.reason).toBe('CATEGORY_NOT_ENABLED_IN_MARKET');
        seen.add('refused');
      } else {
        seen.add('enabled-then-cascaded');
        expect(sEnabled).toBe(false); // it was enabled first and the switch-off then took it with it
        expect((await availabilityAudit(m, 'SERVICE_TYPE', s)).at(-1)!.changes).toMatchObject({ enabled: [true, false], becauseCategory: c });
      }
      expect(cEnabled).toBe(false);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('deterministic: an enabling service type row in flight makes the category switch-off wait and then cascade it', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await catAvail(m, c, true, 10);
    const t = await rawTx();
    await t.query(
      `INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order)
       SELECT (SELECT market_id FROM geography.markets WHERE code = $1), service_type_id, true, 10 FROM catalog.service_types WHERE code = $2`,
      [m, s],
    );
    const pending = catAvail(m, c, false);
    await waitUntilBlocked();
    await t.commit();
    expect((await pending).alsoDisabled).toEqual([s]);
    expect((await mstRow(m, s))[0]!.enabled).toBe(false);
    expect(await mcRow(m, c)).toEqual([{ enabled: false, display_order: 10 }]);
  });

  it('deterministic: a category switch-off in flight makes the service type enable wait and then fail with CATEGORY_NOT_ENABLED_IN_MARKET', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await catAvail(m, c, true, 10);
    const t = await rawTx();
    await t.query('UPDATE catalog.market_categories SET enabled = false WHERE category_id = (SELECT category_id FROM catalog.categories WHERE code = $1)', [c]);
    const pending = err(stAvail(m, s, true, 10));
    await waitUntilBlocked();
    await t.commit();
    const e = (await pending)!;
    expect([e.code, e.details.reason]).toEqual(['INVALID_STATE', 'CATEGORY_NOT_ENABLED_IN_MARKET']);
    expect(await mstRow(m, s)).toEqual([]);
  });

  it('a genuine deadlock between the service and another session is a retryable CONFLICT for the victim and nothing half-written (or the other session is the victim and the service succeeds)', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    await catAvail(m, c, true, 'auto');
    const world = await worldHash();
    const t = await rawTx();
    // the raw session takes the availability row FIRST; the service takes the category (FOR SHARE) and then waits for that row;
    // the raw session then wants the category row itself: a cycle that only PostgreSQL's deadlock detector can break
    await t.query('SELECT 1 FROM catalog.market_categories mc JOIN geography.markets m USING (market_id) WHERE m.code = $1 FOR UPDATE OF mc', [m]);
    const pending = err(catAvail(m, c, false));
    await waitUntilBlocked();
    const other = t.query('UPDATE catalog.categories SET icon_key = $2 WHERE code = $1', [c, 'deadlocked']).then(
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
      expect((await catAvail(m, c, false)).enabled).toBe(false); // the retry works
    } else {
      expect(raw?.code).toBe('40P01');
    }
  }, 20_000);

  it('a row lock held longer than the lock timeout is a retryable CONFLICT (CONCURRENT_UPDATE), writes nothing, and the same request succeeds once the lock is gone', async () => {
    const c = await mkCategory();
    const t = await rawTx();
    await t.query('SELECT category_id FROM catalog.categories WHERE code = $1 FOR UPDATE', [c]);
    const world = await worldHash();
    const incrs = cache.incrs.length;
    const e = await expectError(setCat(c, 'ACTIVE'), 'CONFLICT', 'CONCURRENT_UPDATE'); // the tests' pool policy waits 3 s for a lock
    expect(e.details.retryable).toBe(true);
    expect(JSON.stringify([e.message, e.details])).not.toMatch(/lock|relation|catalog\./i);
    await t.rollback();
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
    expect((await setCat(c, 'ACTIVE')).status).toBe('ACTIVE');
  }, 20_000);

  it('20 parallel mutations of different categories in different markets all succeed independently', async () => {
    const m = await mkMarket(true);
    const cats = await Promise.all(Array.from({ length: 20 }, () => mkCategory()));
    const out = await Promise.all(cats.map((c, i) => err(setCat(c, 'ACTIVE').then(() => catAvail(m, c, true, (i + 1) * 10)))));
    expect(out.filter(Boolean)).toEqual([]);
    expect((await bare.getMarketCatalog(m)).categories.map((c) => c.code)).toEqual(cats);
  });
});

// ====================================================================== 14. scope validator against the real service
describe('the CATEGORY scope reference validator over the real service', () => {
  it('DRAFT, ACTIVE and INACTIVE categories are valid, RETIRED / unknown / non-canonical share ONE generic answer, other scope types are valid without a lookup', async () => {
    const v = createCatalogScopeReferenceValidator(svc);
    const draft = await mkCategory();
    const active = await mkCategory();
    const inactive = await mkCategory();
    const retired = await mkCategory();
    await setCat(active, 'ACTIVE');
    await setCat(inactive, 'ACTIVE');
    await setCat(inactive, 'INACTIVE');
    await setCat(retired, 'RETIRED');
    for (const c of [draft, active, inactive, 'home_cleaning', 'auto_services']) expect(await v.validate('CATEGORY', c), c).toEqual({ valid: true });
    const answers = new Set<string>();
    for (const bad of [
      retired,
      'devtest_missing_one',
      'Home_Cleaning',
      `${draft} `,
      ` ${draft}`,
      draft.toUpperCase(),
      'a',
      'a'.repeat(49),
      '',
      null,
      undefined,
      "x'; DROP TABLE catalog.categories;--",
      'deep_cleaning',
      'car_detailing',
    ])
      answers.add(JSON.stringify(await v.validate('CATEGORY', bad as string)));
    expect([...answers]).toEqual([JSON.stringify({ valid: false, reason: 'the scope reference is not valid' })]);
    for (const t of ['PLATFORM', 'COUNTRY', 'MARKET', 'ROLE']) expect(await v.validate(t, 'anything at all')).toEqual({ valid: true });
    // a retired category turns invalid the moment it is retired; reactivation is not possible, so it stays invalid
    expect((await v.validate('CATEGORY', retired)).valid).toBe(false);
  });

  it('a database outage is NOT "invalid": the typed UNAVAILABLE propagates, and the log never carries the connection credentials', async () => {
    const dead = createDatabase('postgres://nobody:pw-secret-scan-0@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 800 } }); // secret-scan:allow
    try {
      const down = new CatalogService({ database: dead, markets: gate, env: 'test', allowTestKeys: true });
      const v = createCatalogScopeReferenceValidator(down);
      const e = await expectError(v.validate('CATEGORY', 'home_cleaning'), 'UNAVAILABLE');
      expect(e.message).toBe('the catalogue database is unavailable');
      expect(await v.validate('MARKET', 'x')).toEqual({ valid: true }); // other scopes need no database
      await expectError(down.getCategory('home_cleaning'), 'UNAVAILABLE');
      await expectError(down.listCategories(), 'UNAVAILABLE');
      await expectError(down.setCategoryStatus('home_cleaning', { status: 'ACTIVE', reason: REASON }, ACTOR), 'UNAVAILABLE');
      await expectError(down.createCategory({ code: 'devtest_down', reason: REASON }, ACTOR), 'UNAVAILABLE');
      await expectError(down.getMarketCatalog('devtest-anything'), 'MARKET_NOT_FOUND'); // the gate answers before the database is asked
      const market = await mkMarket(true);
      await expectError(down.getMarketCatalog(market), 'UNAVAILABLE'); // cold cache, dead database
      for (const line of logSink.lines.filter((l) => l.includes('catalog database unavailable'))) {
        expect(line).not.toContain('pw-secret-scan-0');
        expect(line).not.toContain('nobody');
        expect(line).not.toMatch(/postgres:\/\//);
      }
      expect(logSink.lines.some((l) => l.includes('catalog database unavailable'))).toBe(true);
    } finally {
      await dead.close();
    }
  });

  it('a dead database with a warm cache still serves the public catalogue (the cache is a real fast path, but the gate still decides)', async () => {
    const market = await mkMarket(true);
    const c = await mkCategory();
    await setCat(c, 'ACTIVE');
    await catAvail(market, c, true, 10);
    const own = new TestCache();
    const live = new CatalogService({ database: iso.database, markets: gate, env: 'test', cache: own });
    await live.getMarketCatalog(market);
    const dead = createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 500 } }); // secret-scan:allow
    try {
      const down = new CatalogService({ database: dead, markets: gate, env: 'test', cache: own });
      const r = await down.getMarketCatalog(market);
      expect(r.source).toBe('cache');
      expect(r.categories.map((x) => x.code)).toEqual([c]);
    } finally {
      await dead.close();
    }
  });
});

// ====================================================================== 15. shape and privacy
describe('retryOnRace: an availability change that lost a race is repeated once', () => {
  /** Installs a trigger that fails the first `n` matching inserts (counted with a sequence, which is not rolled back) with the given SQLSTATE. */
  async function flaky<T>(
    o: { table: string; when: string; n: number; sqlstate: string },
    fn: () => Promise<T>,
  ): Promise<{ result: PromiseSettledResult<T>; calls: number }> {
    await q('CREATE SEQUENCE public.cat_test_seq');
    await q(`CREATE FUNCTION public.cat_test_flaky() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('public.cat_test_seq') <= TG_ARGV[0]::int THEN RAISE EXCEPTION 'injected failure' USING ERRCODE = TG_ARGV[1]; END IF; RETURN NEW; END $$`);
    await q(
      `CREATE TRIGGER trg_cat_test_flaky BEFORE INSERT ON ${o.table} FOR EACH ROW WHEN (${o.when}) EXECUTE FUNCTION public.cat_test_flaky('${o.n}', '${o.sqlstate}')`,
    );
    try {
      const [result] = await Promise.allSettled([fn()]);
      const last = await one<{ last_value: string; is_called: boolean }>('SELECT last_value, is_called FROM public.cat_test_seq');
      return { result, calls: last.is_called ? Number(last.last_value) : 0 };
    } finally {
      await q(`DROP TRIGGER trg_cat_test_flaky ON ${o.table}`);
      await q('DROP FUNCTION public.cat_test_flaky()');
      await q('DROP SEQUENCE public.cat_test_seq');
    }
  }
  const AVAIL_AUDIT = { table: 'catalog.audit_events', when: `NEW.action = 'MARKET_CATALOG_AVAILABILITY_CHANGED'` };
  const insertsInto = (table: string, from: number) => statements.slice(from).filter((x) => new RegExp(`insert into ${table}\\b`, 'i').test(x)).length;

  for (const sqlstate of ['40P01', '40001']) {
    it(`a ${sqlstate} on the first attempt is retried once and succeeds: ONE audit row, ONE event, ONE cache bump, the change applied (category and service type)`, async () => {
      const m = await mkMarket(true);
      const c = await mkCategory();
      const s = await mkServiceType(c);
      for (const kind of ['CATEGORY', 'SERVICE_TYPE'] as const) {
        const target = kind === 'CATEGORY' ? c : s;
        const order = nextOrder(m, kind === 'CATEGORY' ? 'c' : 's');
        const incrs = cache.incrs.length;
        const { result, calls } = await flaky({ ...AVAIL_AUDIT, n: 1, sqlstate }, () =>
          kind === 'CATEGORY' ? catAvail(m, c, true, order) : stAvail(m, s, true, order),
        );
        expect(result.status, `${kind}: ${result.status === 'rejected' ? String((result.reason as Error).message) : ''}`).toBe('fulfilled');
        expect((result as PromiseFulfilledResult<unknown>).value).toEqual({
          marketCode: m,
          code: target,
          kind,
          enabled: true,
          displayOrder: order,
          alsoDisabled: [],
        });
        expect(calls, 'the transaction ran twice: the failed attempt and the retry').toBe(2);
        expect(await availabilityAudit(m, kind, target)).toHaveLength(1);
        expect(await eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m, code: target })).toHaveLength(1);
        expect(cache.incrs.length - incrs).toBe(1);
        expect(await (kind === 'CATEGORY' ? mcRow(m, target) : mstRow(m, target))).toEqual([{ enabled: true, display_order: order }]);
      }
    });
  }

  it('a failure in the middle of a cascade is repeated as a whole: every switched-off service type is audited and announced exactly once', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    await catAvail(m, c, true, 'auto');
    const sts = [await mkServiceType(c), await mkServiceType(c)];
    for (const s of sts) await stAvail(m, s, true, 'auto');
    const before = await counts();
    // the audit row of the CATEGORY itself comes last, after both service types were switched off
    const { result, calls } = await flaky(
      {
        table: 'catalog.audit_events',
        when: `NEW.category_id IS NOT NULL AND NEW.service_type_id IS NULL AND NEW.action = 'MARKET_CATALOG_AVAILABILITY_CHANGED'`,
        n: 1,
        sqlstate: '40001',
      },
      () => catAvail(m, c, false),
    );
    expect(result.status).toBe('fulfilled');
    expect((result as PromiseFulfilledResult<{ alsoDisabled: string[] }>).value.alsoDisabled).toEqual([...sts].sort());
    expect(calls).toBe(2);
    const after = await counts();
    expect(after.audit - before.audit).toBe(3);
    expect(after.events - before.events).toBe(3);
    for (const s of sts) {
      expect(await availabilityAudit(m, 'SERVICE_TYPE', s)).toHaveLength(2); // the enabling and the cascade
      expect((await mstRow(m, s))[0]!.enabled).toBe(false);
    }
  });

  it('a second loss surfaces as the retryable CONFLICT CONCURRENT_UPDATE: two attempts only, nothing written, no bump', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await catAvail(m, c, true, 'auto');
    const world = await worldHash();
    const incrs = cache.incrs.length;
    for (const call of [() => catAvail(m, c, false), () => stAvail(m, s, true, 'auto')]) {
      const from = statements.length;
      const { result, calls } = await flaky({ ...AVAIL_AUDIT, n: 2, sqlstate: '40P01' }, call);
      expect(result.status).toBe('rejected');
      const e = (result as PromiseRejectedResult).reason as CatalogError;
      expect([e.code, e.details.reason, e.details.retryable]).toEqual(['CONFLICT', 'CONCURRENT_UPDATE', true]);
      expect(calls, 'exactly one retry, never a third attempt').toBe(2);
      expect(statements.slice(from).filter((x) => /^start transaction/i.test(x))).toHaveLength(2);
    }
    expect(await worldHash()).toBe(world);
    expect(cache.incrs.length).toBe(incrs);
  });

  it('an error that is not a lost race is NOT retried: a raw failure, a guard refusal, a taken display order and a validation failure each run the transaction once', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    const other = await mkCategory();
    await catAvail(m, c, true, 'auto'); // order 10 of the market
    // a raw (unclassified) failure
    let from = statements.length;
    const raw = await flaky({ ...AVAIL_AUDIT, n: 1, sqlstate: 'XX000' }, () => catAvail(m, c, false));
    expect(raw.result.status).toBe('rejected');
    expect(((raw.result as PromiseRejectedResult).reason as { code?: string }).code).toBe('XX000');
    expect(raw.calls).toBe(1);
    expect(statements.slice(from).filter((x) => /^start transaction/i.test(x))).toHaveLength(1);
    // a guard refusal (INVALID_STATE), a taken order (CONFLICT but another reason), a missing order (VALIDATION_FAILED)
    for (const [label, call, wanted] of [
      ['guard', () => stAvail(m, s, true, 'auto'), 'CATEGORY_NOT_ENABLED_IN_MARKET'] as const,
      ['order taken', () => catAvail(m, other, true, 10), 'DISPLAY_ORDER_TAKEN'] as const,
      ['order missing', () => catAvail(m, other, true), 'DISPLAY_ORDER_REQUIRED'] as const,
    ]) {
      if (label === 'guard') await catAvail(m, c, false); // the category is off, so enabling its service type is refused
      from = statements.length;
      const e = await expectError(call(), label === 'guard' ? 'INVALID_STATE' : label === 'order taken' ? 'CONFLICT' : 'VALIDATION_FAILED', wanted);
      expect(e.details.retryable, label).toBeUndefined();
      expect(
        statements.slice(from).filter((x) => /^start transaction/i.test(x)),
        label,
      ).toHaveLength(label === 'order missing' ? 1 : 1);
      expect(insertsInto('catalog.market_(categories|service_types)', from), label).toBeLessThanOrEqual(1);
    }
  });
});

describe('getMarketDefaultLocale', () => {
  it('answers for a market of ANY status without asking the public gate, in one statement', async () => {
    const planned = await mkMarket(false);
    const expectedLocale = (await one<{ default_locale: string }>('SELECT default_locale FROM geography.markets WHERE code = $1', [planned])).default_locale;
    const r = await counting(() => bare.getMarketDefaultLocale(planned));
    expect(r.result).toBe(expectedLocale);
    expect(r.gate).toEqual([]);
    expect(r.sql).toHaveLength(1);
    expect(await bare.getMarketDefaultLocale('la-oc')).toBe('en-US');
    // the same for a market whose registry status is INACTIVE
    const inactive = await mkMarket(true);
    await q("UPDATE geography.markets SET status = 'INACTIVE' WHERE code = $1", [inactive]);
    expect(await bare.getMarketDefaultLocale(inactive)).toBe(expectedLocale);
    // and for the public one
    expect(await bare.getMarketDefaultLocale(await mkMarket(true))).toBe(expectedLocale);
  });

  it('an unknown or malformed market is MARKET_NOT_FOUND (long codes are cut in the echo) and a locale reads the real column', async () => {
    for (const bad of [
      'devtest-missing',
      'LA-OC',
      '',
      ' la-oc',
      'la_oc',
      "x'; DROP TABLE geography.markets;--",
      'a'.repeat(61),
      'x'.repeat(5000),
      null,
      undefined,
      7,
    ]) {
      const e = await expectError(bare.getMarketDefaultLocale(bad as string), 'MARKET_NOT_FOUND');
      expect(String(e.details.code).length).toBeLessThanOrEqual(64);
    }
    const m = await mkMarket(false);
    await q('INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, $2 FROM geography.markets WHERE code = $1', [
      m,
      'en-US',
    ]).catch(() => undefined);
    expect(await bare.getMarketDefaultLocale(m)).toBe('en-US');
  });
});

describe('documented behaviour (not necessarily desired): what retiring and nesting do', () => {
  it('retiring an item leaves its ENABLED market rows in place: the public view hides it, and no availability event is announced (only the deactivation event)', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    await setCat(c, 'ACTIVE');
    await catAvail(m, c, true, 'auto');
    await stAvail(m, s, true, 'auto');
    await setSt(s, 'ACTIVE');
    expect((await bare.getMarketCatalog(m)).categories.map((x) => x.code)).toEqual([c]);
    const availabilityEvents = () => eventsWhere(CATALOG_EVENTS.availabilityChanged, { marketCode: m });
    const before = (await availabilityEvents()).length;
    await setSt(s, 'RETIRED');
    await setCat(c, 'RETIRED');
    // the rows still say "enabled" ...
    expect((await mcRow(m, c))[0]!.enabled).toBe(true);
    expect((await mstRow(m, s))[0]!.enabled).toBe(true);
    // ... the audit trail has no availability change for the retirement ...
    expect((await availabilityAudit(m, 'CATEGORY', c)).map((a) => a.changes)).toEqual([{ enabled: [null, true], displayOrder: [null, 10] }]);
    expect((await availabilityEvents()).length).toBe(before);
    expect(await eventsWhere(CATALOG_EVENTS.categoryDeactivated, { categoryCode: c })).toHaveLength(1);
    expect(await eventsWhere(CATALOG_EVENTS.serviceTypeDeactivated, { serviceTypeCode: s })).toHaveLength(1);
    // ... and the public catalogue does not show them
    expect(await bare.getMarketCatalog(m)).toMatchObject({ categories: [], serviceTypes: [] });
    expect((await bare.listCategories({ marketCode: m })).find((x) => x.code === c)).toMatchObject({ status: 'RETIRED', enabled: true });
  });

  it("a service called inside a caller's transaction bumps the generation BEFORE the outer commit: a reader in between caches the old data under the new generation until the next bump", async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    await setCat(c, 'ACTIVE');
    await catAvail(m, c, true, 'auto');
    const own = new TestCache();
    const writer = new CatalogService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: own, cacheDeadlineMs: 150 });
    // a second Database object is outside the caller's transaction (the transaction context belongs to the Database instance)
    const other = createDatabase(iso.url, { role: 'tests' });
    try {
      const reader = new CatalogService({ database: other, markets: gate, env: 'test', allowTestKeys: true, cache: own, cacheDeadlineMs: 150 });
      await writer.getMarketCatalog(m);
      const g = own.gen();
      await iso.database.transaction(async () => {
        await writer.setCategoryStatus(c, { status: 'INACTIVE', reason: REASON }, ACTOR);
        expect(own.gen(), 'bumped although nothing is committed').toBe(g + 1);
        expect(await dbStatus('categories', c)).toBe('ACTIVE'); // another connection still sees the old row
        const inBetween = await reader.getMarketCatalog(m); // misses under the new generation and loads the OLD state
        expect(inBetween.source).toBe('db');
        expect(inBetween.categories.map((x) => x.code)).toEqual([c]);
      });
      expect(await dbStatus('categories', c)).toBe('INACTIVE');
      const stale = await writer.getMarketCatalog(m);
      expect(stale.source).toBe('cache');
      expect(
        stale.categories.map((x) => x.code),
        'documented: stale until the next bump or the TTL',
      ).toEqual([c]);
      expect((await bare.getMarketCatalog(m)).categories).toEqual([]);
      await writer.updateCategory(c, { iconKey: 'healed', reason: REASON }, ACTOR); // any later committed change bumps again
      expect((await writer.getMarketCatalog(m)).categories).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('a transaction that is rolled back around the service still leaves the generation bumped (a harmless extra miss) but changes nothing else', async () => {
    const c = await mkCategory();
    const own = new TestCache();
    const writer = new CatalogService({ database: iso.database, markets: gate, env: 'test', allowTestKeys: true, cache: own });
    const world = await worldHash();
    await rejection(
      iso.database.transaction(async () => {
        await writer.setCategoryStatus(c, { status: 'ACTIVE', reason: REASON }, ACTOR);
        throw new Error('abort');
      }),
    );
    expect(own.gen()).toBe(1);
    expect(await worldHash()).toBe(world);
  });
});

describe('shape and privacy', () => {
  it('nothing provider-specific exists in the schema: the catalogue tables hold exactly these columns (no price, duration, radius, capacity, availability window, provider)', async () => {
    const cols = await q<{ table_name: string; columns: string[] }>(
      `SELECT table_name, array_agg(column_name::text COLLATE "C" ORDER BY column_name COLLATE "C") AS columns FROM information_schema.columns WHERE table_schema = 'catalog' AND table_name NOT LIKE '%gig\\_template%' GROUP BY table_name ORDER BY table_name`,
    );
    // (the Gig Template tables of 0016 are pinned by gig-template-model.itest.ts)
    expect(Object.fromEntries(cols.map((c) => [c.table_name, c.columns]))).toEqual({
      audit_events: [
        'action',
        'actor',
        'category_id',
        'changes',
        'correlation_id',
        'gig_template_id',
        'gig_template_version_id',
        'market_id',
        'occurred_at',
        'prohibited_service_id',
        'reason',
        'service_type_id',
        'audit_event_id',
      ].sort(),
      categories: ['category_id', 'code', 'created_at', 'description_content_key', 'icon_key', 'name_content_key', 'status', 'updated_at'].sort(),
      market_categories: ['category_id', 'created_at', 'display_order', 'enabled', 'market_id', 'updated_at'].sort(),
      market_service_types: ['created_at', 'display_order', 'enabled', 'market_id', 'service_type_id', 'updated_at'].sort(),
      prohibited_services: [
        'category_id',
        'code',
        'created_at',
        'description_content_key',
        'name_content_key',
        'prohibited_service_id',
        'status',
        'updated_at',
      ].sort(),
      service_types: ['category_id', 'code', 'created_at', 'description_content_key', 'name_content_key', 'service_type_id', 'status', 'updated_at'].sort(),
    });
  });

  it('the availability result has exactly its documented key set', async () => {
    const m = await mkMarket(true);
    const c = await mkCategory();
    const s = await mkServiceType(c);
    expect(keys(await catAvail(m, c, true, 10))).toEqual(['alsoDisabled', 'code', 'displayOrder', 'enabled', 'kind', 'marketCode']);
    expect(keys(await stAvail(m, s, true, 10))).toEqual(['alsoDisabled', 'code', 'displayOrder', 'enabled', 'kind', 'marketCode']);
  });

  it("what the audit rows and events hold is identifiers, codes and the admin's own reason: no content text, no locale, no token; error details carry no database text", async () => {
    const c = await mkCategory();
    await setCat(c, 'ACTIVE');
    const s = await mkServiceType(c);
    const m = await mkMarket(true);
    await catAvail(m, c, true, 10);
    await stAvail(m, s, true, 10);
    await catAvail(m, c, false);
    const events = await catalogEvents();
    const idOrCode = /^([a-z][a-z0-9]*(_[a-z0-9]+)*|[a-z][a-z0-9]*(-[a-z0-9]+)*|CATEGORY|SERVICE_TYPE|[0-9a-f-]{36})$/;
    for (const ev of events.filter((e) => JSON.stringify(e.payload_json).includes(c) || JSON.stringify(e.payload_json).includes(m))) {
      for (const v of Object.values(ev.payload_json)) if (typeof v === 'string') expect(v, JSON.stringify(ev.payload_json)).toMatch(idOrCode);
    }
    const trail = JSON.stringify(await categoryAudit(c));
    expect(trail).not.toMatch(/Home Cleaning|Auto Services|en-US|catalog integration test copy/);
    // errors from the database layer carry only fixed text
    const e = await expectError(catAvail(m, c, true, (10 ** 6) as number), 'VALIDATION_FAILED');
    expect(JSON.stringify([e.message, e.details])).not.toMatch(/violates|relation|column|constraint|catalog\.|ERROR/);
    const w = await expectError(svc.updateCategory(c, { iconKey: 'x'.repeat(100), reason: REASON }, ACTOR), 'VALIDATION_FAILED');
    expect(JSON.stringify([w.message, w.details])).not.toContain('xxxxxxxx');
  });

  it('no name, reason, actor or content text was ever written to the log by the whole run (only outage lines may exist, and they carry no catalogue data)', async () => {
    const text = logSink.lines.join('\n');
    expect(text).not.toContain(ACTOR);
    expect(text).not.toContain(REASON);
    expect(text).not.toMatch(/Home Cleaning|Auto Services|Car Detailing|Deep Cleaning/);
    expect(text).not.toMatch(/devtest_c\d|devtest_s\d/);
    for (const line of logSink.lines) expect(JSON.parse(line).message).toBe('catalog database unavailable');
  });
});

// ====================================================================== offeredServiceTypeCodes (PRO-001)
describe('offeredServiceTypeCodes: what a provider can choose in a market', () => {
  /** A market (any status) with an ACTIVE category enabled in it. */
  async function mkOfferEnv(): Promise<{ market: string; category: string }> {
    const market = await mkMarket(false);
    const category = await mkCategory();
    await setCat(category, 'ACTIVE');
    await catAvail(market, category, true, 'auto');
    return { market, category };
  }
  /** An ACTIVE service type of the category, enabled in the market. */
  async function mkOffered(market: string, category: string, c?: string): Promise<string> {
    const st = await mkServiceType(category, c === undefined ? {} : { code: c });
    await stAvail(market, st, true, 'auto');
    await setSt(st, 'ACTIVE');
    return st;
  }
  const offered = (market: string) => bare.offeredServiceTypeCodes(market);

  it('an ACTIVE service type, enabled in the market, under an ACTIVE category enabled there, is offered', async () => {
    const { market, category } = await mkOfferEnv();
    const st = await mkOffered(market, category);
    expect(await offered(market)).toEqual([st]);
  });

  it('the market status does not matter: PLANNED, ACTIVE and INACTIVE markets all offer their service types', async () => {
    for (const status of ['PLANNED', 'ACTIVE', 'INACTIVE'] as const) {
      const { market, category } = await mkOfferEnv();
      const st = await mkOffered(market, category);
      if (status !== 'PLANNED') await q('UPDATE geography.markets SET status = $2 WHERE code = $1', [market, status]);
      expect((await one<{ status: string }>('SELECT status FROM geography.markets WHERE code = $1', [market])).status).toBe(status);
      expect(await offered(market), status).toEqual([st]);
    }
  });

  it('DRAFT, INACTIVE and RETIRED service types are not offered; only the ACTIVE one is', async () => {
    const { market, category } = await mkOfferEnv();
    const draft = await mkServiceType(category);
    await stAvail(market, draft, true, 'auto');
    const inactive = await mkOffered(market, category);
    await setSt(inactive, 'INACTIVE');
    const retired = await mkOffered(market, category);
    await setSt(retired, 'RETIRED');
    const active = await mkOffered(market, category);
    expect(await dbStatus('service_types', draft)).toBe('DRAFT');
    expect(await offered(market)).toEqual([active]);
    // and it follows the status: deactivating the last one empties the answer, activating the draft adds it
    await setSt(draft, 'ACTIVE');
    expect(await offered(market)).toEqual([draft, active].sort());
    await setSt(active, 'INACTIVE');
    expect(await offered(market)).toEqual([draft]);
  });

  it('a service type whose availability row in the market is disabled, or missing, is not offered', async () => {
    const { market, category } = await mkOfferEnv();
    const disabled = await mkOffered(market, category);
    const never = await mkServiceType(category);
    await setSt(never, 'ACTIVE');
    const kept = await mkOffered(market, category);
    await stAvail(market, disabled, false);
    expect((await mstRow(market, disabled))[0]!.enabled).toBe(false);
    expect(await mstRow(market, never)).toEqual([]);
    expect(await offered(market)).toEqual([kept]);
    await stAvail(market, disabled, true);
    expect(await offered(market)).toEqual([disabled, kept].sort());
  });

  it('a disabled category availability row in the market removes its service types, even when their own row is still enabled (crafted: the service cascades)', async () => {
    const { market, category } = await mkOfferEnv();
    const st = await mkOffered(market, category);
    expect(await offered(market)).toEqual([st]);
    await withoutTriggers(['catalog.market_categories'], () =>
      q(
        'UPDATE catalog.market_categories SET enabled = false WHERE market_id = (SELECT market_id FROM geography.markets WHERE code = $1) AND category_id = (SELECT category_id FROM catalog.categories WHERE code = $2)',
        [market, category],
      ),
    );
    expect((await mstRow(market, st))[0]!.enabled).toBe(true);
    expect((await mcRow(market, category))[0]!.enabled).toBe(false);
    expect(await offered(market)).toEqual([]);
    await withoutTriggers(['catalog.market_categories'], () =>
      q(
        'UPDATE catalog.market_categories SET enabled = true WHERE market_id = (SELECT market_id FROM geography.markets WHERE code = $1) AND category_id = (SELECT category_id FROM catalog.categories WHERE code = $2)',
        [market, category],
      ),
    );
    expect(await offered(market)).toEqual([st]);
  });

  it('a missing category availability row removes the service type too (crafted)', async () => {
    const { market, category } = await mkOfferEnv();
    const st = await mkOffered(market, category);
    await withoutTriggers(['catalog.market_categories'], () =>
      q(
        'DELETE FROM catalog.market_categories WHERE market_id = (SELECT market_id FROM geography.markets WHERE code = $1) AND category_id = (SELECT category_id FROM catalog.categories WHERE code = $2)',
        [market, category],
      ),
    );
    expect(await mcRow(market, category)).toEqual([]);
    expect(await mstRow(market, st)).toHaveLength(1);
    expect(await offered(market)).toEqual([]);
  });

  it('a category that is not ACTIVE removes its service types (crafted: the guard would refuse the state)', async () => {
    for (const status of ['INACTIVE', 'RETIRED', 'DRAFT'] as const) {
      const { market, category } = await mkOfferEnv();
      const st = await mkOffered(market, category);
      await withoutTriggers(['catalog.categories'], () => q('UPDATE catalog.categories SET status = $2 WHERE code = $1', [category, status]));
      expect(await dbStatus('categories', category)).toBe(status);
      expect(await dbStatus('service_types', st)).toBe('ACTIVE');
      expect(await offered(market), status).toEqual([]);
    }
  });

  it("another market's service types and categories never leak in, and a market without any availability offers nothing", async () => {
    const a = await mkOfferEnv();
    const b = await mkOfferEnv();
    const empty = await mkMarket(false);
    const sa = await mkOffered(a.market, a.category);
    const sb = await mkOffered(b.market, b.category);
    // the same service type enabled in b as well: it is offered in both
    await stAvail(b.market, sa, true, 'auto').catch(() => undefined);
    expect(await offered(a.market)).toEqual([sa]);
    expect((await offered(b.market)).includes(sb)).toBe(true);
    expect((await offered(b.market)).includes(sa)).toBe(false); // category of sa is not enabled in b
    expect(await offered(empty)).toEqual([]);
  });

  it('an unknown market has none; a malformed code has none and sends no statement at all', async () => {
    expect(await offered('devtest-no-such-market')).toEqual([]);
    for (const bad of [
      '',
      ' ',
      'LA-OC',
      'la_oc',
      'la oc',
      "la-oc'; DROP TABLE catalog.service_types;--",
      '-la',
      'la--oc',
      'x'.repeat(61),
      '\u0000',
      'la-oc\n',
    ]) {
      const r = await counting(() => offered(bad));
      expect(r.result, JSON.stringify(bad)).toEqual([]);
      expect(r.sql, JSON.stringify(bad)).toEqual([]);
    }
    for (const notAString of [undefined, null, 5, {}, ['la-oc']] as unknown[]) expect(await offered(notAString as string)).toEqual([]);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM catalog.service_types')).n).toBeGreaterThan(0);
  });

  it('codes come in byte order (COLLATE "C"), whatever the creation order and the database collation', async () => {
    const { market, category } = await mkOfferEnv();
    const stem = code('o');
    // '9' (0x39) < '_' (0x5f) < 'a' (0x61): a locale-aware collation ignores the underscore and would put a_b after ab
    const wanted = [`${stem}a9`, `${stem}a_b`, `${stem}aa`, `${stem}ab`, `${stem}b`];
    for (const c of [`${stem}b`, `${stem}ab`, `${stem}a_b`, `${stem}a9`, `${stem}aa`]) await mkOffered(market, category, c);
    expect(await offered(market)).toEqual(wanted);
    const bytes = [...wanted].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(wanted).toEqual(bytes);
  });

  it('there are no duplicates even when the service type has availability in the market through several routes', async () => {
    const { market, category } = await mkOfferEnv();
    const other = await mkCategory();
    await setCat(other, 'ACTIVE');
    await catAvail(market, other, true, 'auto');
    const a = await mkOffered(market, category);
    const b = await mkOffered(market, other);
    const list = await offered(market);
    expect(list).toEqual([a, b].sort());
    expect(new Set(list).size).toBe(list.length);
  });

  it('is exactly one plain read statement, writes nothing, calls no market gate and touches no cache', async () => {
    const { market, category } = await mkOfferEnv();
    await mkOffered(market, category);
    const before = await worldHash();
    const gen = cache.gen();
    const r = await counting(() => offered(market));
    expect(r.sql).toHaveLength(1);
    expect(r.sql[0]).toMatch(/^select /i);
    expect(r.sql[0]).not.toMatch(/\b(insert|update|delete|for update|for share)\b/i);
    expect(r.gate).toEqual([]);
    expect(await worldHash()).toBe(before);
    expect(cache.gen()).toBe(gen);
    // the service WITH a cache behaves the same (the answer is never cached)
    const withCache = await counting(() => svc.offeredServiceTypeCodes(market));
    expect(withCache.result).toEqual(r.result);
    expect(withCache.sql).toHaveLength(1);
  });

  it('joins the transaction of the caller: it sees the uncommitted change of that transaction, and no other session does', async () => {
    const { market, category } = await mkOfferEnv();
    const st = await mkOffered(market, category);
    const stop = new Error('rollback on purpose');
    const seen = await rejection(
      iso.database.transaction(async (trx) => {
        await sql`UPDATE catalog.market_service_types SET enabled = false WHERE market_id = (SELECT market_id FROM geography.markets WHERE code = ${market})
          AND service_type_id = (SELECT service_type_id FROM catalog.service_types WHERE code = ${st})`.execute(trx);
        const inside = await bare.offeredServiceTypeCodes(market);
        const outside = (
          await q<{ code: string }>(
            `SELECT st.code FROM catalog.market_service_types mst JOIN catalog.service_types st ON st.service_type_id = mst.service_type_id
              JOIN geography.markets m ON m.market_id = mst.market_id WHERE m.code = $1 AND mst.enabled`,
            [market],
          )
        ).map((x) => x.code);
        throw Object.assign(stop, { inside, outside });
      }),
    );
    expect(seen).toBe(stop);
    expect((seen as unknown as { inside: string[] }).inside).toEqual([]);
    expect((seen as unknown as { outside: string[] }).outside).toEqual([st]);
    // rolled back: the committed state is unchanged
    expect(await offered(market)).toEqual([st]);
  });

  it('never opens a transaction of its own (no BEGIN, no snapshot isolation statement)', async () => {
    const { market, category } = await mkOfferEnv();
    await mkOffered(market, category);
    const r = await counting(() => offered(market));
    expect(r.sql.join('\n')).not.toMatch(/begin|isolation|set_config/i);
  });
});
