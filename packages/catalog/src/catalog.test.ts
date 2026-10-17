// Unit tests of the catalogue (CAT-001) that need no database: error translation, the pure view mappers, the generation cache, the CATEGORY scope reference validator
// and the input validation / test-code gating that must happen BEFORE any statement is sent. Behaviour that needs real constraints, triggers, locks and the outbox
// is covered in catalog.itest.ts.
//
// The service is built over a `database` whose every entry point throws a sentinel: a test that expects "no database access" proves it by the absence of the sentinel,
// a test that expects to get PAST a gate proves it by the presence of the sentinel.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryConfigCache, type ConfigCache } from '@bananagig/configuration';
import { CATALOG_CODE_MAX, CATALOG_ERROR_CODES, type CatalogStatus } from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import {
  CATALOG_CACHE_DEADLINE_MS,
  CATEGORY_SCOPE_REFERENCE_INVALID_REASON,
  CatalogError,
  CatalogService,
  DEFAULT_CATALOG_CACHE_TTL_SECONDS,
  cachedRead,
  catalogEntryKey,
  catalogGenKey,
  categoryView,
  createCatalogScopeReferenceValidator,
  guardRuleOf,
  invalidateCatalog,
  isDatabaseOutage,
  mapDbError,
  serviceTypeView,
  type MarketGate,
  type PublicMarket,
} from './index';

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
beforeEach(() => {
  logSink.lines.length = 0;
});

const capture = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const fail = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
};
const asCatalog = (e: unknown): CatalogError => {
  expect(e).toBeInstanceOf(CatalogError);
  return e as CatalogError;
};
/** Everything a caller can observe of an error, as one string. */
const surface = (e: CatalogError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });

// ====================================================================== error translation
describe('guardRuleOf', () => {
  it('reads exactly catalog_rule:<UPPER_SNAKE> and nothing else', () => {
    expect(guardRuleOf('catalog_rule:NOT_DELETABLE')).toBe('NOT_DELETABLE');
    expect(guardRuleOf('catalog_rule:CATEGORY_HAS_ACTIVE_SERVICE_TYPES')).toBe('CATEGORY_HAS_ACTIVE_SERVICE_TYPES');
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      'catalog_rule:',
      'catalog_rule:lower',
      'catalog_rule:_X',
      'catalog_rule:X1',
      'geography_rule:STATUS_TRANSITION',
      'identity_rule:STATUS_TRANSITION',
      ' catalog_rule:STATUS_TRANSITION',
      'catalog_rule:STATUS_TRANSITION ',
      'catalog_rule:STATUS_TRANSITION\n',
      'x catalog_rule:STATUS_TRANSITION',
      'Key (code)=(x) already exists. catalog_rule:STATUS_TRANSITION',
    ])
      expect(guardRuleOf(bad), String(bad)).toBeUndefined();
  });
});

describe('mapDbError: guard (SQLSTATE 23000) failures', () => {
  const INVALID_STATE = [
    'CATEGORY_HAS_ACTIVE_SERVICE_TYPES',
    'CATEGORY_HAS_OPEN_SERVICE_TYPES',
    'CATEGORY_NOT_ACTIVE',
    'CATEGORY_RETIRED',
    'ITEM_RETIRED',
    'CATEGORY_NOT_ENABLED_IN_MARKET',
    'CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES',
    'DRAFT_IS_INITIAL',
    'STATUS_TRANSITION',
    'MUST_START_AS_DRAFT',
  ];
  it.each(INVALID_STATE)('%s -> INVALID_STATE carrying the rule as the machine-readable reason', (rule) => {
    const e = asCatalog(capture(() => mapDbError({ code: '23000', detail: `catalog_rule:${rule}`, message: 'driver text' })));
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({ reason: rule });
    expect(e.message.length).toBeGreaterThan(10);
  });

  it.each(['NOT_DELETABLE', 'IMMUTABLE_IDENTITY', 'ROW_IMMUTABLE'])(
    '%s -> INVALID_STATE reason IMMUTABLE (one public reason for the three immutability rules)',
    (rule) => {
      const e = asCatalog(capture(() => mapDbError({ code: '23000', detail: `catalog_rule:${rule}` })));
      expect(e.code).toBe('INVALID_STATE');
      expect(e.details).toEqual({ reason: 'IMMUTABLE' });
    },
  );

  it('an unknown rule, a rule of another schema or no detail at all is a generic INVALID_STATE without a reason', () => {
    for (const detail of ['catalog_rule:SOMETHING_NEW', 'geography_rule:STATUS_TRANSITION', undefined, '', 'Key (x)=(y)']) {
      const e = asCatalog(capture(() => mapDbError({ code: '23000', detail })));
      expect(e.code).toBe('INVALID_STATE');
      expect(e.details).toEqual({});
    }
  });

  it('a guard failure never leaks the driver message, the SQL, the table or the detail', () => {
    const e = asCatalog(
      capture(() =>
        mapDbError({
          code: '23000',
          detail: 'catalog_rule:STATUS_TRANSITION',
          message: 'the status transition is not allowed LEAK-MESSAGE',
          table: 'categories',
          constraint: 'ck_leak',
          query: 'UPDATE catalog.categories SET LEAK-SQL',
        }),
      ),
    );
    for (const needle of ['LEAK-MESSAGE', 'LEAK-SQL', 'categories', 'catalog.', 'ck_leak', 'catalog_rule']) expect(surface(e)).not.toContain(needle);
  });
});

describe('mapDbError: constraint and concurrency failures', () => {
  it('23505 on the display order of a market is DISPLAY_ORDER_TAKEN, for categories and for service types', () => {
    for (const constraint of ['uq_market_categories__market_order', 'uq_market_service_types__market_order']) {
      const e = asCatalog(capture(() => mapDbError({ code: '23505', constraint, detail: 'Key (market_id, display_order)=(x, 10) already exists.' })));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'DISPLAY_ORDER_TAKEN' });
      expect(surface(e)).not.toContain('Key (');
    }
  });

  it('23505 on a code is CODE_TAKEN, whatever the (other) constraint', () => {
    for (const constraint of ['uq_categories__code', 'uq_service_types__code', 'uq_prohibited_services__code', undefined]) {
      const e = asCatalog(capture(() => mapDbError({ code: '23505', constraint })));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'CODE_TAKEN' });
    }
  });

  it('23514 is VALIDATION_FAILED and 23502 is VALIDATION_FAILED; neither echoes a message, a column or SQL', () => {
    for (const [code, text] of [
      ['23514', 'the operation violates a catalogue constraint'],
      ['23502', 'a required field is missing'],
    ] as const) {
      const e = asCatalog(
        capture(() =>
          mapDbError({
            code,
            constraint: 'ck_categories__icon_key',
            message: 'new row for relation "categories" violates check constraint LEAK',
            table: 'categories',
          }),
        ),
      );
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.message).toBe(text);
      expect(e.message).not.toContain('LEAK');
      expect(e.message).not.toContain('categories');
    }
  });

  it('23503 on the name key is NAME_CONTENT_MISSING, on the description key DESCRIPTION_CONTENT_MISSING, any other reference a generic VALIDATION_FAILED', () => {
    const name = asCatalog(capture(() => mapDbError({ code: '23503', constraint: 'fk_categories__name_content_key' })));
    expect(name.code).toBe('VALIDATION_FAILED');
    expect(name.details).toEqual({ reason: 'NAME_CONTENT_MISSING' });
    for (const constraint of ['fk_service_types__name_content_key', 'fk_prohibited_services__name_content_key'])
      expect(asCatalog(capture(() => mapDbError({ code: '23503', constraint }))).details.reason).toBe('NAME_CONTENT_MISSING');
    for (const constraint of [
      'fk_categories__description_content_key',
      'fk_service_types__description_content_key',
      'fk_prohibited_services__description_content_key',
    ])
      expect(asCatalog(capture(() => mapDbError({ code: '23503', constraint }))).details.reason).toBe('DESCRIPTION_CONTENT_MISSING');
    const other = asCatalog(
      capture(() =>
        mapDbError({ code: '23503', constraint: 'fk_market_categories__market_id', detail: 'Key (market_id)=(LEAK) is not present in table "markets".' }),
      ),
    );
    expect(other.code).toBe('VALIDATION_FAILED');
    expect(other.details.reason).toBeUndefined();
    expect(other.message).not.toContain('LEAK');
    expect(other.message).not.toContain('markets');
    // and none of them leaks the content key text
    expect(surface(name)).not.toContain('catalog.category');
  });

  it('22021 and 22P05 (a character PostgreSQL cannot store) are VALIDATION_FAILED FORBIDDEN_CHARACTER', () => {
    for (const code of ['22021', '22P05']) {
      const e = asCatalog(capture(() => mapDbError({ code, message: 'invalid byte sequence LEAK' })));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'FORBIDDEN_CHARACTER' });
      expect(surface(e)).not.toContain('LEAK');
    }
  });

  it('a deadlock, a serialization failure and a lock timeout are one retryable CONFLICT', () => {
    for (const code of ['40P01', '40001', '55P03']) {
      const e = asCatalog(capture(() => mapDbError({ code, message: 'deadlock detected LEAK', detail: 'Process 12 waits for ShareLock LEAK' })));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
      expect(surface(e)).not.toContain('LEAK');
    }
  });

  it('precedence: a concurrency code wins over a constraint name, a constraint code over a guard detail', () => {
    expect(asCatalog(capture(() => mapDbError({ code: '40P01', constraint: 'uq_categories__code' }))).details.reason).toBe('CONCURRENT_UPDATE');
    expect(
      asCatalog(capture(() => mapDbError({ code: '23505', detail: 'catalog_rule:STATUS_TRANSITION', constraint: 'uq_categories__code' }))).details.reason,
    ).toBe('CODE_TAKEN');
  });
});

describe('mapDbError: outages and everything else', () => {
  const OUTAGES: unknown[] = [
    ...['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'].map((code) => ({
      code,
      message: `LEAK ${code}`,
    })),
    ...['08006', '08001', '53300', '53200', '57P01', '57P03', '57014', '58000'].map((code) => ({ code, message: `LEAK ${code}` })),
    new Error('LEAK Connection terminated unexpectedly'),
    new Error('LEAK timeout exceeded when trying to connect'),
    new Error('LEAK Client has encountered a connection error and is not queryable'),
  ];
  it.each(OUTAGES.map((o, i) => [i, o] as const))('outage %i is UNAVAILABLE with a fixed message; the driver text only goes to the log', (_i, err) => {
    logSink.lines.length = 0;
    const e = asCatalog(capture(() => mapDbError(err)));
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toBe('the catalogue database is unavailable');
    expect(e.details).toEqual({});
    expect(surface(e)).not.toContain('LEAK');
    expect(logSink.lines).toHaveLength(1);
    expect(JSON.parse(logSink.lines[0]!).message).toBe('catalog database unavailable');
  });

  it('typed errors pass through unchanged (same instance) and are never logged', () => {
    const typed = new CatalogError('CATEGORY_NOT_FOUND', 'x', { code: 'a' });
    expect(capture(() => mapDbError(typed))).toBe(typed);
    expect(logSink.lines).toEqual([]);
  });

  it('programming errors and SQL-level rejections that have no mapping are rethrown as they are (never disguised as an outage)', () => {
    for (const err of [
      new TypeError('connection is undefined'),
      new RangeError('timeout'),
      new ReferenceError('socket'),
      new SyntaxError('connect'),
      { code: '42P01', message: 'relation does not exist' },
      { code: '25P02', message: 'aborted' },
      new Error('plain failure'),
    ]) {
      expect(capture(() => mapDbError(err))).toBe(err);
    }
    expect(logSink.lines).toEqual([]);
  });

  it('a rejection that is not an object (null, undefined, a string, a number) is rethrown as it is, never replaced by a TypeError', () => {
    for (const value of [null, undefined, 'plain text', 7, true]) {
      let thrown: unknown = 'NOT-THROWN';
      try {
        mapDbError(value);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBe(value);
    }
    expect(logSink.lines).toEqual([]);
  });

  it('23505 on the primary key of an availability row is a lost race: the retryable CONFLICT CONCURRENT_UPDATE, not a taken code', () => {
    for (const constraint of ['pk_market_categories', 'pk_market_service_types']) {
      const e = asCatalog(capture(() => mapDbError({ code: '23505', constraint, detail: 'Key (market_id, category_id)=(x, y) already exists.' })));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
      expect(surface(e)).not.toContain('Key (');
    }
    // the code and order constraints keep their own answers
    expect(asCatalog(capture(() => mapDbError({ code: '23505', constraint: 'uq_categories__code' }))).details.reason).toBe('CODE_TAKEN');
    expect(asCatalog(capture(() => mapDbError({ code: '23505', constraint: 'uq_market_categories__market_order' }))).details.reason).toBe(
      'DISPLAY_ORDER_TAKEN',
    );
  });

  it('isDatabaseOutage: classes 08 53 57 58 and connectivity codes yes; 22 23 25 40 42 no, even when the message sounds like a connection problem', () => {
    for (const code of ['08000', '53100', '57000', '58P01', 'ECONNREFUSED']) expect(isDatabaseOutage({ code }), code).toBe(true);
    for (const code of ['22001', '23505', '25001', '40001', '42601'])
      expect(isDatabaseOutage(Object.assign(new Error('connection timeout'), { code })), code).toBe(false);
    expect(isDatabaseOutage(new CatalogError('UNAVAILABLE', 'connection'))).toBe(false);
    expect(isDatabaseOutage(null)).toBe(false);
    expect(isDatabaseOutage('connection')).toBe(false);
  });

  it('every error code the translation can produce is in the published list', () => {
    const produced = new Set<string>();
    for (const err of [
      { code: '40P01' },
      { code: '22021' },
      { code: '23505' },
      { code: '23514' },
      { code: '23502' },
      { code: '23503' },
      { code: '23000' },
      { code: 'ECONNREFUSED' },
    ])
      produced.add(asCatalog(capture(() => mapDbError(err))).code);
    for (const c of produced) expect(CATALOG_ERROR_CODES as readonly string[]).toContain(c);
  });
});

// ====================================================================== pure view mappers
const NOW = new Date('2026-03-04T05:06:07.890Z');
const catRow = (over: Record<string, unknown> = {}) => ({
  category_id: '11111111-1111-4111-8111-111111111111',
  code: 'home_cleaning',
  name_content_key: 'catalog.category.home_cleaning.name',
  description_content_key: 'catalog.category.home_cleaning.description',
  icon_key: 'sparkles',
  display_order: 10,
  status: 'ACTIVE',
  enabled: true,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});
const stRow = (over: Record<string, unknown> = {}) => ({
  service_type_id: '22222222-2222-4222-8222-222222222222',
  code: 'deep_cleaning',
  category_code: 'home_cleaning',
  name_content_key: 'catalog.service_type.deep_cleaning.name',
  description_content_key: 'catalog.service_type.deep_cleaning.description',
  display_order: 20,
  status: 'ACTIVE',
  enabled: true,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});
const keys = (o: object) => Object.keys(o).sort();
const PUBLIC_CATEGORY_KEYS = ['categoryId', 'code', 'descriptionContentKey', 'displayOrder', 'iconKey', 'nameContentKey'];
const PUBLIC_SERVICE_TYPE_KEYS = ['categoryCode', 'code', 'descriptionContentKey', 'displayOrder', 'nameContentKey', 'serviceTypeId'];

describe('categoryView / serviceTypeView', () => {
  it('the public view has exactly the public key set, whatever the row holds (no status, enabled or timestamps, nothing provider-specific)', () => {
    const c = categoryView(catRow({ price: 5, provider_id: 'p', duration_minutes: 60, radius_km: 3, capacity: 2, secret: 'x' }), false);
    expect(keys(c)).toEqual(PUBLIC_CATEGORY_KEYS);
    expect(c).toEqual({
      categoryId: '11111111-1111-4111-8111-111111111111',
      code: 'home_cleaning',
      nameContentKey: 'catalog.category.home_cleaning.name',
      descriptionContentKey: 'catalog.category.home_cleaning.description',
      iconKey: 'sparkles',
      displayOrder: 10,
    });
    const s = serviceTypeView(stRow({ price: 5, provider_id: 'p', duration_minutes: 60 }), false);
    expect(keys(s)).toEqual(PUBLIC_SERVICE_TYPE_KEYS);
  });

  it('the management view adds status, timestamps (ISO) and, when the row carries one, enabled', () => {
    const c = categoryView(catRow(), true);
    expect(keys(c)).toEqual([...PUBLIC_CATEGORY_KEYS, 'createdAt', 'enabled', 'status', 'updatedAt'].sort());
    expect(c.status).toBe('ACTIVE');
    expect(c.enabled).toBe(true);
    expect(c.createdAt).toBe('2026-03-04T05:06:07.890Z');
    expect(c.updatedAt).toBe('2026-03-04T05:06:07.890Z');
    const s = serviceTypeView(stRow(), true);
    expect(keys(s)).toEqual([...PUBLIC_SERVICE_TYPE_KEYS, 'createdAt', 'enabled', 'status', 'updatedAt'].sort());
  });

  it('enabled: false is reported as false (a disabled row), a missing availability row (null or absent) carries no enabled key at all', () => {
    expect(categoryView(catRow({ enabled: false }), true).enabled).toBe(false);
    expect(serviceTypeView(stRow({ enabled: false }), true).enabled).toBe(false);
    for (const enabled of [null, undefined]) {
      expect(categoryView(catRow({ enabled }), true)).not.toHaveProperty('enabled');
      expect(serviceTypeView(stRow({ enabled }), true)).not.toHaveProperty('enabled');
    }
    // the public view never carries it, not even a disabled one
    expect(categoryView(catRow({ enabled: false }), false)).not.toHaveProperty('enabled');
  });

  it('null handling: an absent description or icon is null, an absent order is null (the global management view), a numeric string order is a number', () => {
    const c = categoryView(catRow({ description_content_key: undefined, icon_key: null, display_order: null }), true);
    expect(c.descriptionContentKey).toBeNull();
    expect(c.iconKey).toBeNull();
    expect(c.displayOrder).toBeNull();
    expect(categoryView(catRow({ display_order: undefined }), false).displayOrder).toBeNull();
    expect(categoryView(catRow({ display_order: '7' }), false).displayOrder).toBe(7);
    expect(categoryView(catRow({ display_order: 0 }), false).displayOrder).toBe(0);
    const s = serviceTypeView(stRow({ description_content_key: null, display_order: null }), false);
    expect(s.descriptionContentKey).toBeNull();
    expect(s.displayOrder).toBeNull();
  });

  it('a timestamp that is not a Date is passed through as text (never "Invalid Date")', () => {
    expect(categoryView(catRow({ created_at: '2026-01-01T00:00:00.000Z' }), true).createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('every status is carried verbatim in the management view', () => {
    for (const status of ['DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'] satisfies CatalogStatus[]) {
      expect(categoryView(catRow({ status }), true).status).toBe(status);
      expect(serviceTypeView(stRow({ status }), true).status).toBe(status);
    }
  });
});

// ====================================================================== cache module
describe('catalogue cache keys', () => {
  it('follow bg:{env}:cat:v1:<what>:<generation>; the counter is bg:{env}:cat:gen; defaults are pinned', () => {
    expect(catalogGenKey('prod')).toBe('bg:prod:cat:gen');
    expect(catalogEntryKey('prod', 'market:la-oc', '7')).toBe('bg:prod:cat:v1:market:la-oc:7');
    expect(DEFAULT_CATALOG_CACHE_TTL_SECONDS).toBe(300);
    expect(CATALOG_CACHE_DEADLINE_MS).toBe(250);
  });
});

const parseN = (raw: unknown) =>
  typeof raw === 'object' && raw !== null && 'n' in raw && typeof (raw as { n: unknown }).n === 'number' ? (raw as { n: number }) : null;
class Spy extends MemoryConfigCache {
  readonly ttls: number[] = [];
  readonly gets: string[] = [];
  readonly sets: string[] = [];
  readonly incrs: string[] = [];
  override async get(key: string): Promise<string | null> {
    this.gets.push(key);
    return super.get(key);
  }
  override async set(key: string, value: string, ttl?: number): Promise<void> {
    this.ttls.push(ttl as number);
    this.sets.push(key);
    await super.set(key, value);
  }
  override async incr(key: string): Promise<void> {
    this.incrs.push(key);
    await super.incr(key);
  }
}
const read = (cache: ConfigCache | undefined, loads: { n: number }, over: Partial<Parameters<typeof cachedRead<{ n: number }>>[0]> = {}) =>
  cachedRead<{ n: number }>({
    cache,
    env: 'test',
    what: 'market:la-oc',
    parse: parseN,
    deadlineMs: 30,
    load: async () => {
      loads.n++;
      return { n: loads.n };
    },
    ...over,
  });
const never = () => new Promise<never>(() => undefined);

describe('cachedRead and invalidateCatalog', () => {
  it('without a cache every read loads and reports the database; invalidation is a no-op', async () => {
    const loads = { n: 0 };
    expect(await read(undefined, loads)).toEqual({ value: { n: 1 }, source: 'db' });
    expect(await read(undefined, loads)).toEqual({ value: { n: 2 }, source: 'db' });
    await expect(invalidateCatalog(undefined, 'test')).resolves.toBeUndefined();
  });

  it('first read misses and stores under the generation key (generation 0 when the counter does not exist) with the default TTL; the second read hits', async () => {
    const cache = new Spy();
    const loads = { n: 0 };
    expect(await read(cache, loads)).toEqual({ value: { n: 1 }, source: 'db' });
    expect(await read(cache, loads)).toEqual({ value: { n: 1 }, source: 'cache' });
    expect(loads.n).toBe(1);
    expect(cache.sets).toEqual(['bg:test:cat:v1:market:la-oc:0']);
    expect(cache.ttls).toEqual([300]);
    expect(JSON.parse(cache.data.get('bg:test:cat:v1:market:la-oc:0')!)).toEqual({ v: { n: 1 } });
  });

  it('a custom TTL is passed through', async () => {
    const cache = new Spy();
    await read(cache, { n: 0 }, { ttlSeconds: 17 });
    expect(cache.ttls).toEqual([17]);
  });

  it('the generation is read BEFORE the load: a bump that happens while a slow reader loads leaves its result under the dead key, and the next read reloads', async () => {
    const cache = new Spy();
    const loads = { n: 0 };
    const slow = await read(cache, loads, {
      load: async () => {
        loads.n++;
        await invalidateCatalog(cache, 'test'); // a committed change lands while this reader is still loading
        return { n: 100 };
      },
    });
    expect(slow.value).toEqual({ n: 100 });
    expect(cache.sets).toEqual(['bg:test:cat:v1:market:la-oc:0']); // written under the OLD generation
    const next = await read(cache, loads);
    expect(next.source).toBe('db'); // the old entry is unreachable
    expect(next.value).toEqual({ n: 2 });
    expect(cache.sets[1]).toBe('bg:test:cat:v1:market:la-oc:1');
  });

  it('invalidation bumps the one counter by incr and makes the next read a miss under a new key; the old entry is never served again', async () => {
    const cache = new Spy();
    const loads = { n: 0 };
    await read(cache, loads);
    await invalidateCatalog(cache, 'test');
    expect(cache.incrs).toEqual(['bg:test:cat:gen']);
    expect(cache.data.get('bg:test:cat:gen')).toBe('1');
    expect((await read(cache, loads)).source).toBe('db');
    expect((await read(cache, loads)).source).toBe('cache');
    await invalidateCatalog(cache, 'test');
    await invalidateCatalog(cache, 'test');
    expect(cache.data.get('bg:test:cat:gen')).toBe('3');
    const r = await read(cache, loads);
    expect(r).toEqual({ value: { n: 3 }, source: 'db' });
    expect(cache.data.has('bg:test:cat:v1:market:la-oc:0')).toBe(true); // stale data still sits there, unreachable
  });

  it('entries are keyed by what (the market) AND by environment: another market or env never sees them', async () => {
    const cache = new Spy();
    const loads = { n: 0 };
    await read(cache, loads, { what: 'market:la-oc' });
    expect((await read(cache, loads, { what: 'market:sf' })).source).toBe('db');
    expect((await read(cache, loads, { what: 'market:la-oc', env: 'other' })).source).toBe('db');
    expect((await read(cache, loads, { what: 'market:la-oc' })).source).toBe('cache');
    expect([...cache.data.keys()].sort()).toEqual(['bg:other:cat:v1:market:la-oc:0', 'bg:test:cat:v1:market:la-oc:0', 'bg:test:cat:v1:market:sf:0']);
    // a bump in one environment does not invalidate another
    await invalidateCatalog(cache, 'other');
    expect((await read(cache, loads, { what: 'market:la-oc' })).source).toBe('cache');
  });

  it('malformed, poisoned or unparseable entries are misses and are overwritten with a good one', async () => {
    const cache = new Spy();
    const loads = { n: 0 };
    await read(cache, loads);
    const key = 'bg:test:cat:v1:market:la-oc:0';
    for (const bad of [
      '{nope',
      'null',
      '"x"',
      '7',
      '[]',
      JSON.stringify({}),
      JSON.stringify({ v: 'x' }),
      JSON.stringify({ v: null }),
      JSON.stringify({ v: { n: 'one' } }),
    ]) {
      cache.data.set(key, bad);
      const r = await read(cache, loads);
      expect(r.source, bad).toBe('db');
    }
    expect((await read(cache, loads)).source).toBe('cache');
  });

  it('an empty cached string is a miss; a parse that throws is a miss, never an error', async () => {
    const cache = new Spy();
    const loads = { n: 0 };
    await read(cache, loads);
    cache.data.set('bg:test:cat:v1:market:la-oc:0', '');
    expect((await read(cache, loads)).source).toBe('db');
    const r = await read(cache, loads, {
      parse: () => {
        throw new Error('parse blew up');
      },
    });
    expect(r.source).toBe('db');
  });

  it('a load error propagates (the cache never hides a database failure) and nothing is stored', async () => {
    const cache = new Spy();
    await expect(read(cache, { n: 0 }, { load: () => Promise.reject(new Error('db down')) })).rejects.toThrow('db down');
    expect(cache.sets).toEqual([]);
  });

  it('a failing or throwing cache never changes a result and never throws', async () => {
    const failing = new MemoryConfigCache();
    failing.fail = true;
    expect((await read(failing, { n: 0 })).source).toBe('db');
    const boom = () => {
      throw new Error('sync throw');
    };
    const throwing: ConfigCache = { get: boom, mget: boom, set: boom, incr: boom };
    const rejecting: ConfigCache = {
      get: () => Promise.reject(new Error('x')),
      mget: () => Promise.reject(new Error('x')),
      set: () => Promise.reject(new Error('x')),
      incr: () => Promise.reject(new Error('x')),
    };
    for (const cache of [throwing, rejecting]) {
      const loads = { n: 0 };
      expect(await read(cache, loads)).toEqual({ value: { n: 1 }, source: 'db' });
      await expect(invalidateCatalog(cache, 'test', 30)).resolves.toBeUndefined();
    }
  });

  it('a failing set after a successful get still returns the loaded value', async () => {
    const base = new MemoryConfigCache();
    const setFails: ConfigCache = {
      get: (k) => base.get(k),
      mget: (k) => base.mget(k),
      set: () => Promise.reject(new Error('set failed')),
      incr: (k) => base.incr(k),
    };
    const loads = { n: 0 };
    expect(await read(setFails, loads)).toEqual({ value: { n: 1 }, source: 'db' });
    expect(await read(setFails, loads)).toEqual({ value: { n: 2 }, source: 'db' });
    const setHangs: ConfigCache = { ...setFails, set: never };
    expect(await read(setHangs, loads)).toEqual({ value: { n: 3 }, source: 'db' });
  });

  it('a hung generation read is bounded by the deadline and is not asked a second time (no entry read, no write)', async () => {
    const calls: string[] = [];
    const hang: ConfigCache = {
      get: (k) => {
        calls.push(`get:${k}`);
        return never();
      },
      mget: never,
      set: (k) => {
        calls.push(`set:${k}`);
        return never();
      },
      incr: never,
    };
    const loads = { n: 0 };
    expect(await read(hang, loads)).toEqual({ value: { n: 1 }, source: 'db' });
    expect(calls).toEqual(['get:bg:test:cat:gen']);
  });

  it('a hung entry read is bounded and the value is loaded but not written (the cache is not answering)', async () => {
    const calls: string[] = [];
    const base = new MemoryConfigCache();
    const hangEntry: ConfigCache = {
      get: (k) => {
        calls.push(`get:${k}`);
        return k.endsWith(':gen') ? base.get(k) : never();
      },
      mget: never,
      set: (k, v) => {
        calls.push(`set:${k}`);
        return base.set(k, v);
      },
      incr: (k) => base.incr(k),
    };
    expect((await read(hangEntry, { n: 0 })).source).toBe('db');
    expect(calls.filter((c) => c.startsWith('set:'))).toEqual([]);
  });

  it('a hung incr is bounded by the deadline and does not throw', async () => {
    const hang: ConfigCache = { get: never, mget: never, set: never, incr: never };
    await expect(invalidateCatalog(hang, 'test', 20)).resolves.toBeUndefined();
  });

  it('the deadline timers are cleared: a fast cache leaves no pending timer behind', async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryConfigCache();
      const p = read(cache, { n: 0 }, { deadlineMs: 5000 });
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(vi.getTimerCount()).toBe(0);
      const q = invalidateCatalog(cache, 'test', 5000);
      await vi.advanceTimersByTimeAsync(0);
      await q;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ====================================================================== scope reference validator
describe('createCatalogScopeReferenceValidator', () => {
  const categoryService = (status: CatalogStatus | 'MISSING' | Error) => {
    const calls: unknown[][] = [];
    return {
      calls,
      service: {
        getCategory: async (...args: unknown[]) => {
          calls.push(args);
          if (status instanceof Error) throw status;
          if (status === 'MISSING') throw new CatalogError('CATEGORY_NOT_FOUND', 'the category is not registered', { code: String(args[0]) });
          return { status } as never;
        },
      },
    };
  };

  it.each(['DRAFT', 'ACTIVE', 'INACTIVE'] as const)(
    'a %s category is a valid CATEGORY scope reference, looked up by its exact code without a market',
    async (status) => {
      const { service, calls } = categoryService(status);
      expect(await createCatalogScopeReferenceValidator(service).validate('CATEGORY', 'home_cleaning')).toEqual({ valid: true });
      expect(calls).toEqual([['home_cleaning']]);
    },
  );

  it('a RETIRED category, an unknown category and every non-canonical reference return the SAME single generic reason', async () => {
    const results: unknown[] = [];
    const retired = categoryService('RETIRED');
    results.push(await createCatalogScopeReferenceValidator(retired.service).validate('CATEGORY', 'home_cleaning'));
    const missing = categoryService('MISSING');
    results.push(await createCatalogScopeReferenceValidator(missing.service).validate('CATEGORY', 'no_such_one'));
    const never = categoryService('ACTIVE');
    const validator = createCatalogScopeReferenceValidator(never.service);
    const bad: unknown[] = [
      null,
      undefined,
      '',
      'a', // too short
      'a'.repeat(CATALOG_CODE_MAX + 1), // too long
      'Home_Cleaning',
      'home-cleaning',
      'home cleaning',
      ' home_cleaning',
      'home_cleaning ',
      'home_cleaning\n',
      'home_cleaning\u0000',
      '_home',
      'home_',
      'home__cleaning',
      '1home',
      '../etc/passwd',
      "x'; DROP TABLE catalog.categories;--",
      'ｈome_cleaning', // fullwidth h
      'hоme_cleaning', // cyrillic o
      'home_cleaning%20',
      42,
      true,
      {},
      [],
      ['home_cleaning'],
      { toString: () => 'home_cleaning' },
    ];
    for (const ref of bad) results.push(await validator.validate('CATEGORY', ref as string));
    expect(never.calls, 'a non-canonical reference never reaches the service').toEqual([]);
    const reasons = new Set(results.map((r) => JSON.stringify(r)));
    expect([...reasons]).toEqual([JSON.stringify({ valid: false, reason: CATEGORY_SCOPE_REFERENCE_INVALID_REASON })]);
    expect(CATEGORY_SCOPE_REFERENCE_INVALID_REASON).toBe('the scope reference is not valid');
  });

  it('the boundary lengths: 2 and 48 characters reach the service, 1 and 49 do not', async () => {
    const { service, calls } = categoryService('ACTIVE');
    const v = createCatalogScopeReferenceValidator(service);
    expect(await v.validate('CATEGORY', 'ab')).toEqual({ valid: true });
    expect(await v.validate('CATEGORY', 'a'.repeat(48))).toEqual({ valid: true });
    expect((await v.validate('CATEGORY', 'a')).valid).toBe(false);
    expect((await v.validate('CATEGORY', 'a'.repeat(49))).valid).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('the reason never tells which case applied and never echoes the reference', async () => {
    const { service } = categoryService('MISSING');
    const r = await createCatalogScopeReferenceValidator(service).validate('CATEGORY', 'echo_me_back');
    expect(JSON.stringify(r)).not.toContain('echo_me_back');
    expect(JSON.stringify(r).toLowerCase()).not.toMatch(/retired|exist|found|unknown|format|length/);
  });

  it('other scope types are valid without calling the service, whatever the reference', async () => {
    const { service, calls } = categoryService(new Error('must not be called'));
    const v = createCatalogScopeReferenceValidator(service);
    for (const t of ['PLATFORM', 'COUNTRY', 'MARKET', 'ROLE', 'category', 'CATEGORY ', '', 'SERVICE_TYPE'])
      for (const ref of ['x', 'home_cleaning', null, undefined, '']) expect(await v.validate(t, ref), `${t}/${String(ref)}`).toEqual({ valid: true });
    expect(calls).toEqual([]);
  });

  it('outages and every other failure propagate unchanged: they are NOT reported as an invalid reference', async () => {
    for (const err of [
      new CatalogError('UNAVAILABLE', 'the catalogue database is unavailable'),
      new CatalogError('SERVICE_TYPE_NOT_FOUND', 'x'),
      new CatalogError('MARKET_NOT_FOUND', 'x'),
      new CatalogError('VALIDATION_FAILED', 'x'),
      new Error('boom'),
    ]) {
      const { service } = categoryService(err);
      expect(await fail(createCatalogScopeReferenceValidator(service).validate('CATEGORY', 'home_cleaning'))).toBe(err);
    }
  });

  it('every invalid answer is a FRESH object (never the one a previous caller received)', async () => {
    const { service } = categoryService('RETIRED');
    const v = createCatalogScopeReferenceValidator(service);
    const answers = [
      await v.validate('CATEGORY', 'home_cleaning'),
      await v.validate('CATEGORY', 'home_cleaning'),
      await v.validate('CATEGORY', 'Bad Code'),
      await v.validate('CATEGORY', null),
    ];
    expect(new Set(answers).size).toBe(answers.length);
    for (const a of answers) expect(a).toEqual({ valid: false, reason: CATEGORY_SCOPE_REFERENCE_INVALID_REASON });
  });

  it('the invalid result handed to callers cannot be changed by one of them (a later caller still gets the generic reason)', async () => {
    const { service } = categoryService('RETIRED');
    const v = createCatalogScopeReferenceValidator(service);
    const first = await v.validate('CATEGORY', 'home_cleaning');
    try {
      (first as { reason: string }).reason = 'POISONED';
    } catch {
      // a frozen result is also fine
    }
    expect(await v.validate('CATEGORY', 'home_cleaning')).toEqual({ valid: false, reason: CATEGORY_SCOPE_REFERENCE_INVALID_REASON });
  });
});

// ====================================================================== service: validation before the database, gating, public reads over a cache
const SENTINEL = 'sentinel-database-reached';
function untouchable() {
  const touched: string[] = [];
  const trap = (what: string) => () => {
    touched.push(what);
    throw new Error(SENTINEL);
  };
  const database = {
    transaction: trap('transaction'),
    get db() {
      touched.push('db');
      throw new Error(SENTINEL);
    },
    query: trap('query'),
    pool: { connect: trap('connect'), query: trap('pool.query') },
  } as unknown as Database;
  return { database, touched };
}
function gate(publicMarkets: Record<string, PublicMarket> = {}) {
  const asked: unknown[] = [];
  const g: MarketGate = {
    publicMarket: async (code) => {
      asked.push(code);
      return publicMarkets[code] ?? null;
    },
  };
  return { gate: g, asked };
}
const LAOC: PublicMarket = { code: 'la-oc', defaultLocale: 'en-US' };
function build(over: { allowTestKeys?: boolean; cache?: ConfigCache; markets?: Record<string, PublicMarket> } = {}) {
  const db = untouchable();
  const g = gate(over.markets);
  const service = new CatalogService({
    database: db.database,
    markets: g.gate,
    env: 'test',
    allowTestKeys: over.allowTestKeys,
    cache: over.cache,
    cacheDeadlineMs: 30,
  });
  return { service, ...db, ...g };
}
const GOOD = 'a valid reason';

type Call = (s: CatalogService, input: unknown) => Promise<unknown>;
const MUTATIONS: Record<string, Call> = {
  createCategory: (s, i) => s.createCategory(i, 'admin'),
  updateCategory: (s, i) => s.updateCategory('home_cleaning', i, 'admin'),
  setCategoryStatus: (s, i) => s.setCategoryStatus('home_cleaning', i, 'admin'),
  createServiceType: (s, i) => s.createServiceType(i, 'admin'),
  updateServiceType: (s, i) => s.updateServiceType('deep_cleaning', i, 'admin'),
  setServiceTypeStatus: (s, i) => s.setServiceTypeStatus('deep_cleaning', i, 'admin'),
  createProhibitedService: (s, i) => s.createProhibitedService(i, 'admin'),
  setProhibitedServiceStatus: (s, i) => s.setProhibitedServiceStatus('weapons', i, 'admin'),
  setMarketCategoryAvailability: (s, i) => s.setMarketCategoryAvailability('la-oc', 'home_cleaning', i, 'admin'),
  setMarketServiceTypeAvailability: (s, i) => s.setMarketServiceTypeAvailability('la-oc', 'deep_cleaning', i, 'admin'),
};
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  createCategory: { code: 'garden_care', reason: GOOD },
  updateCategory: { iconKey: 'leaf', reason: GOOD },
  setCategoryStatus: { status: 'ACTIVE', reason: GOOD },
  createServiceType: { code: 'lawn_mowing', categoryCode: 'home_cleaning', reason: GOOD },
  updateServiceType: { withDescription: true, reason: GOOD },
  setServiceTypeStatus: { status: 'ACTIVE', reason: GOOD },
  createProhibitedService: { code: 'fireworks', reason: GOOD },
  setProhibitedServiceStatus: { status: 'ACTIVE', reason: GOOD },
  setMarketCategoryAvailability: { enabled: true, displayOrder: 10, reason: GOOD },
  setMarketServiceTypeAvailability: { enabled: true, displayOrder: 10, reason: GOOD },
};

describe('management input is validated before the database is touched', () => {
  const names = Object.keys(MUTATIONS);

  it.each(names)('%s: a valid input reaches the database (the control that makes every refusal below meaningful)', async (name) => {
    const b = build();
    const e = await fail(MUTATIONS[name]!(b.service, VALID_INPUT[name]));
    expect((e as Error).message).toBe(SENTINEL);
    expect(b.touched.length).toBeGreaterThan(0);
  });

  it.each(names)(
    '%s: non-object inputs, unknown fields, a missing or blank reason and a wrong-type reason are VALIDATION_FAILED and never reach the database',
    async (name) => {
      const b = build();
      const good = VALID_INPUT[name]!;
      const without = (k: string) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== k));
      const cases: [string, unknown][] = [
        ['null', null],
        ['undefined', undefined],
        ['string', 'status'],
        ['number', 7],
        ['array', [good]],
        ['empty object', {}],
        ['unknown field', { ...good, extra: 1 }],
        ['unknown field __proto__', JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(good).slice(1)}`)],
        ['missing reason', without('reason')],
        ['empty reason', { ...good, reason: '' }],
        ['blank reason', { ...good, reason: '   ' }],
        ['tab/newline reason', { ...good, reason: '\t\n' }],
        ['zero-width reason', { ...good, reason: '\u200B\u2060' }],
        ['control character in the reason', { ...good, reason: 'bad\u0007reason' }],
        ['bidi override in the reason', { ...good, reason: 'bad\u202Ereason' }],
        ['lone surrogate in the reason', { ...good, reason: 'bad\uD800reason' }],
        ['reason of 1001 characters', { ...good, reason: 'x'.repeat(1001) }],
        ['numeric reason', { ...good, reason: 5 }],
        ['null reason', { ...good, reason: null }],
        ['object reason', { ...good, reason: { text: 'x' } }],
      ];
      for (const [label, input] of cases) {
        const e = asCatalog(await fail(MUTATIONS[name]!(b.service, input)));
        expect(e.code, `${name} / ${label}`).toBe('VALIDATION_FAILED');
        expect(e.details.reason, `${name} / ${label}`).toBe('INVALID_FIELD');
        expect(e.message).toBe('the request is not valid');
      }
      expect(b.touched).toEqual([]);
    },
  );

  it('a reason of exactly 1000 characters is accepted (the boundary) and reaches the database', async () => {
    const b = build();
    const e = await fail(b.service.setCategoryStatus('home_cleaning', { status: 'ACTIVE', reason: 'x'.repeat(1000) }, 'admin'));
    expect((e as Error).message).toBe(SENTINEL);
  });

  it('the error names the failing field and never echoes the value that was sent', async () => {
    const b = build();
    const secret = 'ZZ-secret-scan:allow-ZZ'; // secret-scan:allow
    const e = asCatalog(await fail(b.service.createCategory({ code: secret, reason: GOOD }, 'admin')));
    expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'code' });
    expect(surface(e)).not.toContain('ZZ');
    const e2 = asCatalog(await fail(b.service.setCategoryStatus('home_cleaning', { status: 'ACTIVE', reason: 'x'.repeat(1001) }, 'admin')));
    expect(e2.details).toEqual({ reason: 'INVALID_FIELD', field: 'reason' });
    expect(surface(e2)).not.toContain('xxxxxxxx');
    const e3 = asCatalog(await fail(b.service.createCategory({ code: 'garden_care', reason: GOOD, [secret]: 1 }, 'admin')));
    expect(surface(e3)).not.toContain('ZZ');
    const e4 = asCatalog(await fail(b.service.setMarketCategoryAvailability('la-oc', 'x', { enabled: true, displayOrder: 123456, reason: GOOD }, 'admin')));
    expect(e4.details).toEqual({ reason: 'INVALID_FIELD', field: 'displayOrder' });
    expect(surface(e4)).not.toContain('123456');
    expect(b.touched).toEqual([]);
  });

  const BAD_CODES: [string, unknown][] = [
    ['upper case', 'Garden_Care'],
    ['too short', 'a'],
    ['too long', 'a'.repeat(49)],
    ['space', 'garden care'],
    ['kebab', 'garden-care'],
    ['trailing underscore', 'garden_'],
    ['leading underscore', '_garden'],
    ['double underscore', 'garden__care'],
    ['leading digit', '1garden'],
    ['unicode letter', 'gärden'],
    ['fullwidth', 'ｇarden'],
    ['traversal', '../garden'],
    ['sql', "garden'; DROP TABLE catalog.categories;--"],
    ['newline', 'garden\n'],
    ['nul', 'garden\u0000'],
    ['empty', ''],
    ['number', 7],
    ['null', null],
    ['array', ['garden']],
    ['object', { toString: () => 'garden' }],
  ];
  it('createCategory / createServiceType / createProhibitedService reject every malformed code with field "code" before the database', async () => {
    const b = build({ allowTestKeys: true });
    for (const [label, bad] of BAD_CODES) {
      for (const [name, input] of [
        ['createCategory', { code: bad, reason: GOOD }],
        ['createServiceType', { code: bad, categoryCode: 'home_cleaning', reason: GOOD }],
        ['createProhibitedService', { code: bad, reason: GOOD }],
      ] as const) {
        const e = asCatalog(await fail(MUTATIONS[name]!(b.service, input)));
        expect(e.details, `${name} / ${label}`).toEqual({ reason: 'INVALID_FIELD', field: 'code' });
      }
    }
    expect(b.touched).toEqual([]);
  });

  it('a code of 2 and of 48 valid characters is accepted (the boundary)', async () => {
    const b = build();
    for (const code of ['ab', 'a'.repeat(48), 'a1_b2', 'a_1']) {
      const e = await fail(b.service.createCategory({ code, reason: GOOD }, 'admin'));
      expect((e as Error).message, code).toBe(SENTINEL);
    }
  });

  it('createServiceType needs a canonical categoryCode; createProhibitedService accepts a null or absent one but not a malformed one', async () => {
    const b = build();
    for (const bad of ['Home', 'h', '', null, undefined, 5]) {
      const e = asCatalog(await fail(b.service.createServiceType({ code: 'lawn_mowing', categoryCode: bad, reason: GOOD }, 'admin')));
      expect(e.details.field).toBe('categoryCode');
    }
    for (const ok of [null, undefined, 'home_cleaning']) {
      const e = await fail(b.service.createProhibitedService({ code: 'fireworks', categoryCode: ok, reason: GOOD }, 'admin'));
      expect((e as Error).message).toBe(SENTINEL);
    }
    const e = asCatalog(await fail(b.service.createProhibitedService({ code: 'fireworks', categoryCode: 'Bad Code', reason: GOOD }, 'admin')));
    expect(e.details.field).toBe('categoryCode');
  });

  it('a status request accepts ACTIVE, INACTIVE and RETIRED only: DRAFT, a wrong case, padding, a number or a missing status are refused', async () => {
    const b = build();
    for (const [name, call] of [
      ['category', (i: unknown) => b.service.setCategoryStatus('home_cleaning', i, 'admin')],
      ['service type', (i: unknown) => b.service.setServiceTypeStatus('deep_cleaning', i, 'admin')],
      ['prohibited', (i: unknown) => b.service.setProhibitedServiceStatus('fireworks', i, 'admin')],
    ] as const) {
      for (const status of ['DRAFT', 'active', 'Active', 'ACTIVE ', ' ACTIVE', 'DELETED', '', 1, true, null, undefined]) {
        const e = asCatalog(await fail(call({ status, reason: GOOD })));
        expect(e.details, `${name}/${String(status)}`).toEqual({ reason: 'INVALID_FIELD', field: 'status' });
      }
      for (const status of ['ACTIVE', 'INACTIVE', 'RETIRED']) expect(((await fail(call({ status, reason: GOOD }))) as Error).message).toBe(SENTINEL);
    }
  });

  it('updateCategory needs iconKey or withDescription, a kebab icon name of at most 48 characters (null clears it); updateServiceType needs a boolean withDescription', async () => {
    const b = build();
    const noField = asCatalog(await fail(b.service.updateCategory('home_cleaning', { reason: GOOD }, 'admin')));
    expect(noField.code).toBe('VALIDATION_FAILED');
    for (const icon of ['Leaf', 'leaf_icon', 'leaf-', '-leaf', 'a--b', '1leaf', '', 'a'.repeat(49), 'http://x/y.png', '../x', 5, [] as unknown])
      expect(asCatalog(await fail(b.service.updateCategory('home_cleaning', { iconKey: icon, reason: GOOD }, 'admin'))).details.field, String(icon)).toBe(
        'iconKey',
      );
    for (const icon of ['leaf', 'a', 'a'.repeat(48), 'leaf-icon-2', null])
      expect(((await fail(b.service.updateCategory('home_cleaning', { iconKey: icon, reason: GOOD }, 'admin'))) as Error).message).toBe(SENTINEL);
    expect(((await fail(b.service.updateCategory('home_cleaning', { withDescription: false, reason: GOOD }, 'admin'))) as Error).message).toBe(SENTINEL);
    for (const w of ['true', 1, 0, null, undefined, {}])
      expect(asCatalog(await fail(b.service.updateServiceType('deep_cleaning', { withDescription: w, reason: GOOD }, 'admin'))).details.field, String(w)).toBe(
        'withDescription',
      );
    expect(asCatalog(await fail(b.service.updateServiceType('deep_cleaning', { reason: GOOD }, 'admin'))).details.field).toBe('withDescription');
  });

  it('availability: enabled must be a real boolean, displayOrder an integer 1..9999 (or absent)', async () => {
    const b = build();
    for (const [name, call] of [
      ['category', (i: unknown) => b.service.setMarketCategoryAvailability('la-oc', 'home_cleaning', i, 'admin')],
      ['service type', (i: unknown) => b.service.setMarketServiceTypeAvailability('la-oc', 'deep_cleaning', i, 'admin')],
    ] as const) {
      for (const enabled of ['true', 'false', 1, 0, null, undefined, []])
        expect(asCatalog(await fail(call({ enabled, displayOrder: 10, reason: GOOD }))).details.field, `${name}/${String(enabled)}`).toBe('enabled');
      for (const displayOrder of [0, -1, 10000, 1.5, '10', '1e1', NaN, Infinity, null, true, []])
        expect(asCatalog(await fail(call({ enabled: true, displayOrder, reason: GOOD }))).details.field, `${name}/${String(displayOrder)}`).toBe(
          'displayOrder',
        );
      for (const displayOrder of [1, 9999, undefined])
        expect(((await fail(call({ enabled: true, displayOrder, reason: GOOD }))) as Error).message).toBe(SENTINEL);
    }
  });
});

describe('devtest_ codes are gated by allowTestKeys', () => {
  it('without allowTestKeys a devtest_ code is refused (TEST_KEY_NOT_ALLOWED on field code) before the database, for categories, service types and prohibited services', async () => {
    for (const allow of [undefined, false]) {
      const b = build({ allowTestKeys: allow });
      for (const [name, input] of [
        ['createCategory', { code: 'devtest_garden', reason: GOOD }],
        ['createServiceType', { code: 'devtest_mowing', categoryCode: 'home_cleaning', reason: GOOD }],
        ['createProhibitedService', { code: 'devtest_x1', reason: GOOD }],
      ] as const) {
        const e = asCatalog(await fail(MUTATIONS[name]!(b.service, input)));
        expect(e.code, name).toBe('VALIDATION_FAILED');
        expect(e.details, name).toEqual({ reason: 'TEST_KEY_NOT_ALLOWED', field: 'code' });
      }
      expect(b.touched).toEqual([]);
    }
  });

  it('with allowTestKeys the same codes reach the database', async () => {
    const b = build({ allowTestKeys: true });
    for (const [name, input] of [
      ['createCategory', { code: 'devtest_garden', reason: GOOD }],
      ['createServiceType', { code: 'devtest_mowing', categoryCode: 'home_cleaning', reason: GOOD }],
      ['createProhibitedService', { code: 'devtest_x1', reason: GOOD }],
    ] as const)
      expect(((await fail(MUTATIONS[name]!(b.service, input))) as Error).message).toBe(SENTINEL);
  });

  it('only the exact prefix devtest_ is gated: "devtest", "devtestx_", "x_devtest_" and "Devtest_a" are ordinary (or invalid) codes', async () => {
    const b = build();
    for (const code of ['devtest', 'devtestx_a', 'x_devtest_a', 'devtest1_a'])
      expect(((await fail(b.service.createCategory({ code, reason: GOOD }, 'admin'))) as Error).message, code).toBe(SENTINEL);
    expect(asCatalog(await fail(b.service.createCategory({ code: 'Devtest_a', reason: GOOD }, 'admin'))).details.reason).toBe('INVALID_FIELD');
  });

  it('allowTestKeys has to be exactly true (a truthy value is not enough)', async () => {
    const b = build({ allowTestKeys: 'yes' as unknown as boolean });
    expect(asCatalog(await fail(b.service.createCategory({ code: 'devtest_garden', reason: GOOD }, 'admin'))).details.reason).toBe('TEST_KEY_NOT_ALLOWED');
  });
});

describe('public reads: the market gate comes first, then the cache; the database is only the fallback', () => {
  const SNAPSHOT = {
    categories: [
      {
        categoryId: 'c1',
        code: 'auto_services',
        nameContentKey: 'catalog.category.auto_services.name',
        descriptionContentKey: null,
        iconKey: null,
        displayOrder: 5,
      },
      {
        categoryId: 'c2',
        code: 'home_cleaning',
        nameContentKey: 'catalog.category.home_cleaning.name',
        descriptionContentKey: 'catalog.category.home_cleaning.description',
        iconKey: 'sparkles',
        displayOrder: 10,
      },
    ],
    serviceTypes: [
      { serviceTypeId: 's1', code: 'car_detailing', categoryCode: 'auto_services', nameContentKey: 'k1', descriptionContentKey: null, displayOrder: 1 },
      { serviceTypeId: 's2', code: 'deep_cleaning', categoryCode: 'home_cleaning', nameContentKey: 'k2', descriptionContentKey: null, displayOrder: 2 },
      { serviceTypeId: 's3', code: 'regular_cleaning', categoryCode: 'home_cleaning', nameContentKey: 'k3', descriptionContentKey: null, displayOrder: 3 },
    ],
  };
  const seeded = (snapshot: unknown = SNAPSHOT) => {
    const cache = new Spy();
    cache.data.set('bg:test:cat:v1:market:la-oc:0', JSON.stringify({ v: snapshot }));
    return { cache, ...build({ cache, markets: { 'la-oc': LAOC } }) };
  };

  it('serves a cached snapshot without a single statement, in the stored order, marked source cache', async () => {
    const { service, touched } = seeded();
    const c = await service.getMarketCatalog('la-oc');
    expect(c.source).toBe('cache');
    expect(c.market).toEqual(LAOC);
    expect(c.categories.map((x) => x.code)).toEqual(['auto_services', 'home_cleaning']);
    expect(c.serviceTypes.map((x) => x.code)).toEqual(['car_detailing', 'deep_cleaning', 'regular_cleaning']);
    expect(touched).toEqual([]);
  });

  it('the market gate is asked exactly once per read, for every read', async () => {
    const { service, asked } = seeded();
    await service.getMarketCatalog('la-oc');
    await service.listCategoriesForMarket('la-oc');
    await service.listServiceTypesForMarket('la-oc');
    await service.listServiceTypesForMarket('la-oc', { categoryCode: 'home_cleaning' });
    await service.getCategoryForMarket('la-oc', 'auto_services');
    await service.getServiceTypeForMarket('la-oc', 'car_detailing');
    expect(asked).toEqual(['la-oc', 'la-oc', 'la-oc', 'la-oc', 'la-oc', 'la-oc']);
  });

  it('a market that is not public is MARKET_NOT_FOUND for every read, and neither the cache nor the database is ever asked', async () => {
    const cache = new Spy();
    const b = build({ cache, markets: { 'la-oc': LAOC } });
    const calls: [string, () => Promise<unknown>][] = [
      ['getMarketCatalog', () => b.service.getMarketCatalog('planned-market')],
      ['listCategoriesForMarket', () => b.service.listCategoriesForMarket('planned-market')],
      ['listServiceTypesForMarket', () => b.service.listServiceTypesForMarket('planned-market')],
      ['getCategoryForMarket', () => b.service.getCategoryForMarket('planned-market', 'home_cleaning')],
      ['getServiceTypeForMarket', () => b.service.getServiceTypeForMarket('planned-market', 'deep_cleaning')],
    ];
    for (const [name, call] of calls) {
      const e = asCatalog(await fail(call()));
      expect(e.code, name).toBe('MARKET_NOT_FOUND');
      expect(e.details, name).toEqual({ code: 'planned-market' });
    }
    expect(cache.gets).toEqual([]);
    expect(cache.sets).toEqual([]);
    expect(b.touched).toEqual([]);
  });

  it('a malformed market code is MARKET_NOT_FOUND without even asking the gate, and an echoed code is cut at 64 characters', async () => {
    const b = build({ cache: new Spy(), markets: { 'la-oc': LAOC } });
    for (const bad of ['LA-OC', 'la_oc', '', ' la-oc', 'la-oc ', '-la', 'la-', 'la--oc', '../x', "x'--", 'a'.repeat(61), null, undefined, 5, {}]) {
      const e = asCatalog(await fail(b.service.getMarketCatalog(bad as string)));
      expect(e.code, String(bad)).toBe('MARKET_NOT_FOUND');
      expect(String(e.details.code).length).toBeLessThanOrEqual(64);
    }
    const long = asCatalog(await fail(b.service.getMarketCatalog('x'.repeat(5000))));
    expect((long.details.code as string).length).toBe(64);
    expect(b.asked).toEqual([]);
    expect(b.touched).toEqual([]);
  });

  it('a gate that fails fails the read (an outage of the registry is not an empty catalogue)', async () => {
    const boom = new CatalogError('UNAVAILABLE', 'the market registry is unavailable');
    const service = new CatalogService({
      database: untouchable().database,
      markets: { publicMarket: () => Promise.reject(boom) },
      env: 'test',
      cache: new Spy(),
    });
    expect(await fail(service.getMarketCatalog('la-oc'))).toBe(boom);
  });

  it('single reads and filters work over the snapshot; unknown codes are typed not-found errors that cut the echoed code at 64 characters', async () => {
    const { service } = seeded();
    expect((await service.getCategoryForMarket('la-oc', 'home_cleaning')).category).toMatchObject({ code: 'home_cleaning', displayOrder: 10 });
    expect((await service.getServiceTypeForMarket('la-oc', 'regular_cleaning')).serviceType).toMatchObject({
      code: 'regular_cleaning',
      categoryCode: 'home_cleaning',
    });
    expect((await service.listServiceTypesForMarket('la-oc', { categoryCode: 'home_cleaning' })).serviceTypes.map((x) => x.code)).toEqual([
      'deep_cleaning',
      'regular_cleaning',
    ]);
    expect((await service.listServiceTypesForMarket('la-oc', { categoryCode: 'auto_services' })).serviceTypes.map((x) => x.code)).toEqual(['car_detailing']);
    for (const unknown of ['no_such', '', 'Home_Cleaning', 'x'.repeat(500)]) {
      expect((await service.listServiceTypesForMarket('la-oc', { categoryCode: unknown })).serviceTypes).toEqual([]);
    }
    const e = asCatalog(await fail(service.getCategoryForMarket('la-oc', 'x'.repeat(500))));
    expect(e.code).toBe('CATEGORY_NOT_FOUND');
    expect((e.details.code as string).length).toBe(64);
    expect(asCatalog(await fail(service.getServiceTypeForMarket('la-oc', 'auto_services'))).code).toBe('SERVICE_TYPE_NOT_FOUND'); // a category code is not a service type
    expect(asCatalog(await fail(service.getCategoryForMarket('la-oc', 'car_detailing'))).code).toBe('CATEGORY_NOT_FOUND');
  });

  it('a poisoned snapshot cannot add fields to the public views (extra keys are stripped) and the views have exactly the public key set', async () => {
    const poisoned = {
      categories: [{ ...SNAPSHOT.categories[0], status: 'DRAFT', enabled: false, price: 99, providerId: 'p' }],
      serviceTypes: [{ ...SNAPSHOT.serviceTypes[0], status: 'DRAFT', price: 99, durationMinutes: 60 }],
      extra: 'x',
    };
    const { service } = seeded(poisoned);
    const c = await service.getMarketCatalog('la-oc');
    expect(c.source).toBe('cache');
    expect(keys(c.categories[0]!)).toEqual(PUBLIC_CATEGORY_KEYS);
    expect(keys(c.serviceTypes[0]!)).toEqual(PUBLIC_SERVICE_TYPE_KEYS);
    expect(keys(c)).toEqual(['categories', 'market', 'serviceTypes', 'source']);
  });

  it('an invalid snapshot is a miss: the database is consulted (the sentinel proves it) and the bad entry is not served', async () => {
    for (const bad of [
      {},
      { categories: [], serviceTypes: 'x' },
      { categories: [{ code: 'x' }], serviceTypes: [] },
      { categories: [{ ...SNAPSHOT.categories[0], displayOrder: 1.5 }], serviceTypes: [] },
      null,
      'x',
    ]) {
      const { service, touched } = seeded(bad);
      const e = await fail(service.getMarketCatalog('la-oc'));
      expect((e as Error).message, JSON.stringify(bad)).toBe(SENTINEL);
      expect(touched.length).toBeGreaterThan(0);
    }
  });

  it('an empty snapshot is a valid snapshot (a market with nothing enabled is cached, not reloaded)', async () => {
    const { service, touched } = seeded({ categories: [], serviceTypes: [] });
    const c = await service.getMarketCatalog('la-oc');
    expect(c.source).toBe('cache');
    expect(c.categories).toEqual([]);
    expect(touched).toEqual([]);
  });

  it('an entry cached for one market is never served for another', async () => {
    const cache = new Spy();
    cache.data.set('bg:test:cat:v1:market:la-oc:0', JSON.stringify({ v: SNAPSHOT }));
    const b = build({ cache, markets: { 'la-oc': LAOC, sf: { code: 'sf', defaultLocale: 'en-US' } } });
    expect(((await fail(b.service.getMarketCatalog('sf'))) as Error).message).toBe(SENTINEL);
    expect((await b.service.getMarketCatalog('la-oc')).source).toBe('cache');
  });

  it('a bumped generation makes the cached snapshot unreachable', async () => {
    const { service, cache } = seeded();
    await cache.incr('bg:test:cat:gen');
    expect(((await fail(service.getMarketCatalog('la-oc'))) as Error).message).toBe(SENTINEL);
  });
});
