// CAT-001 end to end, written by an independent author: the REAL catalogue API (routes, auth, strict validation), the REAL CatalogService, GeographyService (the market gate),
// ContentService (names and descriptions) and PostgreSQL (an isolated, migrated database), wired as apps/api/src/index.ts wires them. Tokens are signed test tokens verified
// by the real verifier. Every scenario builds its own markets and codes (devtest_*), so the order of the tests does not matter.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { CATALOG_EVENTS, categoryDescriptionKey, categoryNameKey, serviceTypeNameKey, prohibitedServiceNameKey } from '@bananagig/contracts';
import { CatalogService, createCatalogScopeReferenceValidator } from '@bananagig/catalog';
import { ContentService, type CreateEntryInput } from '@bananagig/content';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { createDatabase } from '@bananagig/database';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { composeScopeReferenceValidators, createMarketGate } from './modules/catalog/wiring';

/** An in-memory cache that counts its calls and can be inspected. */
class CountingCache extends MemoryConfigCache {
  gets = 0;
  sets = 0;
  incrs = 0;
  override async get(key: string): Promise<string | null> {
    this.gets += 1;
    return super.get(key);
  }
  override async set(key: string, value: string): Promise<void> {
    this.sets += 1;
    return super.set(key, value);
  }
  override async incr(key: string): Promise<void> {
    this.incrs += 1;
    return super.incr(key);
  }
}

let iso: IsolatedDatabase;
let app: FastifyInstance;
let keys: TestKeys;
let geography: GeographyService;
let content: ContentService;
let catalog: CatalogService;
let cache: CountingCache;
let staff: string; // catalog-read + catalog-write, subject staff-a
let reader: string; // catalog-read only, subject reader-r
let writer: string; // catalog-write only, subject writer-w
let customer: string;
let norole: string; // admin context without a catalog role
let contentStaff: string;
const A = 'author-a';
const B = 'approver-b';
let queries: string[] = [];
let counting = false;
let seq = 0;

const adminToken = (sub: string, roles: string[]) =>
  signToken(keys, {
    claims: { sub, azp: 'bananagig-admin', realm_access: { roles: [] }, resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } } },
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  status: number;
  body: Json;
  raw: string;
  headers: Record<string, unknown>;
}
const api = async (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  t?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> => {
  const r = await app.inject({
    method,
    url: `/api/v1/catalog${url}`,
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, body: r.json() as Json, raw: r.body, headers: r.headers };
};
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const codes = (r: Res): string[] => r.body.data.map((x: { code: string }) => x.code);
const keysOf = (o: object) => Object.keys(o).sort();
const REASON = 'integration test';
const code = (prefix: string) => `devtest_${prefix}${++seq}`;

// ---------------------------------------------------------------- content helpers (the real workflow, the way the other itests do it)
const entryReq = (key: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key,
  contentType: 'UI_LABEL',
  ownerRole: 'CONTENT',
  description: 'neutral catalogue test entry',
  approvalPolicy: 'NONE',
  maxScopeType: 'MARKET',
  ...over,
});
async function publishText(key: string, locale: string, body: string): Promise<void> {
  const v = await content.createVersion(key, { locale, scopeType: 'PLATFORM', scopeRef: null, body, reason: REASON }, A);
  const submitted = await content.submit(v.versionId, A);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, B);
  await content.publish(v.versionId, A);
}
async function ensureEntry(key: string, contentType: CreateEntryInput['contentType'] = 'UI_LABEL'): Promise<void> {
  await content.createEntry(entryReq(key, { contentType }), A);
}
/** Creates the name (and description) entries of a code and publishes en-US (and es-US) text. */
async function names(nameKey: string, o: { en?: string; es?: string; descKey?: string; descEn?: string; descEs?: string }): Promise<void> {
  await ensureEntry(nameKey);
  if (o.en) await publishText(nameKey, 'en-US', o.en);
  if (o.es) await publishText(nameKey, 'es-US', o.es);
  if (o.descKey) {
    await ensureEntry(o.descKey, 'PLAIN_TEXT');
    if (o.descEn) await publishText(o.descKey, 'en-US', o.descEn);
    if (o.descEs) await publishText(o.descKey, 'es-US', o.descEs);
  }
}

// ---------------------------------------------------------------- domain helpers (through the HTTP API, as an administrator does)
async function market(name: string, state: 'PLANNED' | 'ACTIVE' | 'INACTIVE', defaultLocale = 'en-US'): Promise<string> {
  const c = `devtest-cat-${name}`;
  await geography.createMarket(
    { code: c, name: 'Catalog Test Market', countryCode: 'US', defaultLocale, currencyCode: 'USD', defaultTimeZone: 'America/Denver', reason: REASON },
    A,
  );
  if (state !== 'PLANNED') await geography.setMarketActive(c, true, 'activate for test', A);
  if (state === 'INACTIVE') await geography.setMarketActive(c, false, 'retire for test', A);
  return c;
}
interface Made {
  code: string;
  res: Res;
}
async function category(
  prefix: string,
  text: { en?: string; es?: string; desc?: string; descEs?: string } = { en: 'Test category' },
  body: Record<string, unknown> = {},
): Promise<Made> {
  const c = code(prefix);
  await names(categoryNameKey(c), {
    en: text.en,
    es: text.es,
    descKey: text.desc ? categoryDescriptionKey(c) : undefined,
    descEn: text.desc,
    descEs: text.descEs,
  });
  const res = await api('POST', '/categories', staff, { code: c, withDescription: text.desc !== undefined, reason: REASON, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { code: c, res };
}
async function serviceType(prefix: string, categoryCode: string, text: { en?: string; es?: string } = { en: 'Test service type' }): Promise<Made> {
  const c = code(prefix);
  await names(serviceTypeNameKey(c), { en: text.en, es: text.es });
  const res = await api('POST', '/service-types', staff, { code: c, categoryCode, reason: REASON });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { code: c, res };
}
const setStatus = (kind: 'categories' | 'service-types' | 'prohibited-services', c: string, status: string, headers: Record<string, string> = {}) =>
  api('PUT', `/${kind}/${c}/status`, staff, { status, reason: REASON }, headers);
const setAvail = (m: string, kind: 'categories' | 'service-types', c: string, enabled: boolean, displayOrder?: number, headers: Record<string, string> = {}) =>
  api('PUT', `/markets/${m}/${kind}/${c}`, staff, { enabled, ...(displayOrder === undefined ? {} : { displayOrder }), reason: REASON }, headers);
/** A category ACTIVE and enabled in a market, ready for service types. */
async function liveCategory(
  prefix: string,
  m: string,
  order: number,
  text: { en?: string; es?: string; desc?: string; descEs?: string } = { en: 'Live category' },
): Promise<string> {
  const c = (await category(prefix, text)).code;
  expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
  expect((await setAvail(m, 'categories', c, true, order)).status).toBe(200);
  return c;
}
async function liveServiceType(
  prefix: string,
  categoryCode: string,
  m: string,
  order: number,
  text: { en?: string; es?: string } = { en: 'Live service type' },
): Promise<string> {
  const c = (await serviceType(prefix, categoryCode, text)).code;
  expect((await setStatus('service-types', c, 'ACTIVE')).status).toBe(200);
  expect((await setAvail(m, 'service-types', c, true, order)).status).toBe(200);
  return c;
}
const auditOf = (cid: string) =>
  q<{
    action: string;
    actor: string;
    changes: Record<string, [unknown, unknown]> | null;
    reason: string;
    category_id: string | null;
    service_type_id: string | null;
    prohibited_service_id: string | null;
    market_id: string | null;
  }>(
    'SELECT action, actor, changes, reason, category_id, service_type_id, prohibited_service_id, market_id FROM catalog.audit_events WHERE correlation_id = $1 ORDER BY occurred_at, audit_event_id',
    [cid],
  );
const outboxOf = (cid: string) =>
  q<{ event_type: string; aggregate_type: string; aggregate_id: string; actor_type: string; actor_id: string; payload_json: Record<string, unknown> }>(
    'SELECT event_type, aggregate_type, aggregate_id::text, actor_type, actor_id, payload_json FROM integration.outbox_events WHERE correlation_id = $1 ORDER BY created_at, outbox_event_id',
    [cid],
  );
const id0 = () => '00000000-0000-4000-8000-000000000001';
const cids = (n: string) => ({ 'x-correlation-id': `cat-itest-${n}-${++seq}` });
const cidOf = (h: Record<string, string>) => h['x-correlation-id']!;
const count = async (table: string) => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]!.n);

const PUBLIC_CAT_KEYS = ['categoryId', 'code', 'description', 'displayOrder', 'iconKey', 'name'];
const PUBLIC_ST_KEYS = ['categoryCode', 'code', 'description', 'displayOrder', 'name', 'serviceTypeId'];

beforeAll(async () => {
  iso = await createIsolatedDatabase({
    database: {
      onQuery: (e) => {
        if (counting) queries.push(e.sql);
      },
    },
  });
  keys = await createTestKeys('k1');
  const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  geography = new GeographyService({ database: iso.database, env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry() });
  content = new ContentService({
    database: iso.database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geography),
    markets: createMarketDefaultsProvider(geography, { ttlMs: 60_000 }),
  });
  cache = new CountingCache();
  catalog = new CatalogService({ database: iso.database, markets: createMarketGate(geography), cache, env: 'test', allowTestKeys: true });
  app = await buildApp({ cfg, verifier, configuration: {} as never, content, geography, catalog, readiness: async () => ({}) });
  await app.ready();
  await content.registerLocale({ locale: 'es-US', active: true, reason: REASON }, A);
  await geography.updateCountry('US', { supportedLocales: ['en-US', 'es-US'], reason: 'Spanish support for the tests' }, A);
  staff = await adminToken('staff-a', ['catalog-read', 'catalog-write']);
  reader = await adminToken('reader-r', ['catalog-read']);
  writer = await adminToken('writer-w', ['catalog-write']);
  norole = await adminToken('norole-n', ['admin-console-access']);
  contentStaff = await adminToken('content-c', ['content-read', 'content-write', 'geography-read', 'geography-write', 'configuration-write']);
  customer = await signToken(keys, { claims: { sub: 'customer-c', azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });
});
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});

// ====================================================================== the seed and the guards at the door
describe('the seeded taxonomy and access control (real token verification)', () => {
  it('ships the seeded taxonomy as DRAFT with published names: nothing is public, the management view shows it with resolved text and the content keys', async () => {
    const list = await api('GET', '/categories', reader);
    expect(list.status).toBe(200);
    const seeded = list.body.data.filter((c: { code: string }) => ['auto_services', 'home_cleaning'].includes(c.code));
    expect(seeded.map((c: { code: string; status: string; name: string }) => [c.code, c.status, c.name])).toEqual([
      ['auto_services', 'DRAFT', 'Auto Services'],
      ['home_cleaning', 'DRAFT', 'Home Cleaning'],
    ]);
    expect(seeded[0]).toMatchObject({
      nameContentKey: 'catalog.category.auto_services.name',
      description: 'Car care, from a wash to a full detail.',
      displayOrder: null,
    });
    const sts = await api('GET', '/service-types', reader);
    expect(
      sts.body.data.filter((s: { code: string }) => ['car_detailing', 'mobile_car_wash', 'regular_cleaning', 'deep_cleaning'].includes(s.code)),
    ).toHaveLength(4);
    expect(sts.body.data.find((s: { code: string }) => s.code === 'car_detailing')).toMatchObject({
      categoryCode: 'auto_services',
      status: 'DRAFT',
      name: 'Car Detailing',
    });
    expect((await api('GET', '/prohibited-services', reader)).body.data).toEqual([]);
    for (const m of ['us-sf', 'la-oc', 'devtest-nothing']) expect((await api('GET', `/categories?market=${m}`)).status).toBe(404);
    expect(await count('catalog.market_categories')).toBe(0);
    expect(await count('catalog.audit_events')).toBe(6);
  });

  it('401 without or with a bad token, 403 for a customer, an admin without a catalog role, a read-only admin and foreign registry roles; the database is untouched', async () => {
    const before = [await count('catalog.categories'), await count('catalog.audit_events'), await count('integration.outbox_events')];
    const body = { code: code('denied'), reason: REASON };
    for (const [t, expected] of [
      [undefined, 401],
      ['not.a.token', 401],
      [customer, 403],
      [norole, 403],
      [reader, 403],
      [contentStaff, 403],
    ] as const) {
      for (const [m, u, b] of [
        ['POST', '/categories', body],
        ['PATCH', '/categories/auto_services', { iconKey: 'x', reason: REASON }],
        ['PUT', '/categories/auto_services/status', { status: 'ACTIVE', reason: REASON }],
        ['POST', '/service-types', { ...body, categoryCode: 'auto_services' }],
        ['PUT', '/service-types/car_detailing/status', { status: 'ACTIVE', reason: REASON }],
        ['POST', '/prohibited-services', body],
        ['PUT', '/markets/la-oc/categories/auto_services', { enabled: true, displayOrder: 1, reason: REASON }],
        ['PUT', '/markets/la-oc/service-types/car_detailing', { enabled: true, displayOrder: 1, reason: REASON }],
      ] as const) {
        const r = await api(m, u, t, b);
        expect(r.status, `${m} ${u} ${t === undefined ? 'anon' : ''}`).toBe(expected);
      }
    }
    for (const t of [customer, norole, contentStaff]) {
      expect((await api('GET', '/prohibited-services', t)).status).toBe(403);
      expect((await api('GET', '/prohibited-services/anything', t)).status).toBe(403);
    }
    expect((await api('GET', '/prohibited-services')).status).toBe(401);
    // the writer-only token may read the management view; the others see the public view and need the market
    expect((await api('GET', '/categories', writer)).status).toBe(200);
    for (const t of [customer, norole, contentStaff]) expect((await api('GET', '/categories', t)).status).toBe(400);
    expect([await count('catalog.categories'), await count('catalog.audit_events'), await count('integration.outbox_events')]).toEqual(before);
  });
});

// ====================================================================== coerced bodies (DEBT-0043 for the new bodies)
describe('a coerced or malformed body is a 400 and writes NOTHING (the whole state is compared)', () => {
  const stateOf = async () => {
    const tables = ['categories', 'service_types', 'prohibited_services', 'market_categories', 'market_service_types', 'audit_events'];
    const out: string[] = [];
    for (const t of tables)
      out.push(String((await q<{ h: string | null }>(`SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM catalog.${t} x`))[0]!.h));
    out.push(String((await q<{ n: string }>('SELECT count(*)::text AS n FROM integration.outbox_events'))[0]!.n));
    return out.join(' ');
  };
  it('the values Ajv coercion would have accepted (1, true, "1e3", null, extra keys, ids, wrong-case enums) are refused on every mutation', async () => {
    const m = await market('coerce', 'ACTIVE');
    const c = await liveCategory('coerce', m, 10, { en: 'Coercion' });
    const st = (await serviceType('coercest', c)).code;
    const fresh = code('coercenew');
    await names(categoryNameKey(fresh), { en: 'Fresh' });
    const freshSt = code('coercenewst');
    await names(serviceTypeNameKey(freshSt), { en: 'Fresh st' });
    const before = await stateOf();
    const bodies: [Parameters<typeof api>[0], string, Record<string, unknown>[]][] = [
      [
        'POST',
        '/categories',
        [
          { code: fresh, reason: 123 },
          { code: fresh, reason: true },
          { code: fresh, reason: REASON, withDescription: 1 },
          { code: fresh, reason: REASON, withDescription: 'false' },
          { code: fresh, reason: REASON, iconKey: 5 },
          { code: fresh, reason: REASON, id: '1' },
          { code: fresh, reason: REASON, status: 'ACTIVE' },
          { code: fresh.toUpperCase(), reason: REASON },
        ],
      ],
      [
        'PATCH',
        `/categories/${c}`,
        [
          { reason: REASON },
          { reason: REASON, iconKey: 5 },
          { reason: REASON, withDescription: 0 },
          { reason: REASON, withDescription: null },
          { reason: REASON, iconKey: 'x', code: 'renamed_x' },
        ],
      ],
      [
        'PUT',
        `/categories/${c}/status`,
        [
          { status: 'active', reason: REASON },
          { status: 1, reason: REASON },
          { status: 'INACTIVE', reason: 123 },
          { status: 'INACTIVE', reason: REASON, enabled: true },
          { status: 'DRAFT', reason: REASON },
          { status: null, reason: REASON },
        ],
      ],
      [
        'POST',
        '/service-types',
        [
          { code: freshSt, categoryCode: c, reason: 123 },
          { code: freshSt, categoryCode: 5, reason: REASON },
          { code: freshSt, categoryCode: c, reason: REASON, categoryId: id0() },
          { code: freshSt, reason: REASON },
        ],
      ],
      [
        'PATCH',
        `/service-types/${st}`,
        [
          { withDescription: 1, reason: REASON },
          { withDescription: 'true', reason: REASON },
          { reason: REASON },
          { withDescription: true, reason: REASON, categoryCode: 'home_cleaning' },
        ],
      ],
      [
        'PUT',
        `/service-types/${st}/status`,
        [
          { status: 'ACTIVE', reason: 123 },
          { status: ['ACTIVE'], reason: REASON },
        ],
      ],
      [
        'POST',
        '/prohibited-services',
        [
          { code: code('coercep'), reason: 123 },
          { code: code('coercep'), reason: REASON, categoryCode: 7 },
        ],
      ],
      ['PUT', '/prohibited-services/weapons/status', [{ status: 'ACTIVE', reason: 123 }, { status: 'ACTIVE' }]],
      [
        'PUT',
        `/markets/${m}/categories/${c}`,
        [
          { enabled: 'true', displayOrder: 10, reason: REASON },
          { enabled: 1, displayOrder: 10, reason: REASON },
          { enabled: false, displayOrder: '10', reason: REASON },
          { enabled: false, displayOrder: '1e3', reason: REASON },
          { enabled: false, displayOrder: 10.5, reason: REASON },
          { enabled: false, displayOrder: null, reason: REASON },
          { enabled: false, displayOrder: 10, reason: 123 },
          { enabled: false, displayOrder: 10, reason: REASON, marketCode: 'x' },
        ],
      ],
      [
        'PUT',
        `/markets/${m}/service-types/${st}`,
        [
          { enabled: 'false', displayOrder: 10, reason: REASON },
          { enabled: 0, displayOrder: 10, reason: REASON },
          { enabled: true, displayOrder: 0, reason: REASON },
          { enabled: true, displayOrder: 10000, reason: REASON },
          { enabled: true, displayOrder: true, reason: REASON },
        ],
      ],
    ];
    let n = 0;
    for (const [method, url, list] of bodies)
      for (const body of list) {
        const r = await api(method, url, staff, body);
        expect(r.status, `${method} ${url} ${JSON.stringify(body)}`).toBe(400);
        expect(r.body.error.category).toBe('VALIDATION');
        n += 1;
      }
    expect(n).toBeGreaterThan(40);
    for (const [method, url] of bodies)
      for (const raw of ['[]', '"x"', '1', 'true', 'null']) {
        const r = await app.inject({
          method,
          url: `/api/v1/catalog${url}`,
          headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json' },
          payload: raw,
        });
        expect(r.statusCode, `${method} ${url} ${raw}`).toBe(400);
      }
    expect(await stateOf()).toBe(before);
  });
});

// ====================================================================== lifecycle
describe('the lifecycle of a category and a service type over HTTP', () => {
  it('creating needs the name content first (typed 400), then creates a DRAFT row with a management DTO, an audit row and NO event', async () => {
    const c = code('life');
    const noName = await api('POST', '/categories', staff, { code: c, reason: REASON });
    expect([noName.status, noName.body.error.code, noName.body.error.details]).toEqual([400, 'CATALOG_VALIDATION_FAILED', { reason: 'NAME_CONTENT_MISSING' }]);
    expect(noName.raw).not.toMatch(/fk_|constraint|catalog\.categories|violates/i);
    expect((await q('SELECT 1 FROM catalog.categories WHERE code = $1', [c])).length).toBe(0);

    await names(categoryNameKey(c), { en: 'Lifecycle', descKey: categoryDescriptionKey(c), descEn: 'About lifecycle' });
    const h = cids('create');
    const created = await api('POST', '/categories', staff, { code: c, iconKey: 'star', withDescription: true, reason: 'because we launch' }, h);
    expect(created.status, created.raw).toBe(201);
    expect(keysOf(created.body.data)).toEqual(
      [
        'categoryId',
        'code',
        'createdAt',
        'description',
        'descriptionContentKey',
        'displayOrder',
        'iconKey',
        'name',
        'nameContentKey',
        'status',
        'updatedAt',
      ].sort(),
    );
    expect(created.body.data).toMatchObject({
      code: c,
      name: 'Lifecycle',
      description: 'About lifecycle',
      iconKey: 'star',
      status: 'DRAFT',
      displayOrder: null,
      nameContentKey: `catalog.category.${c}.name`,
      descriptionContentKey: `catalog.category.${c}.description`,
    });
    expect(created.body.meta.correlationId).toBe(cidOf(h));
    const audit = await auditOf(cidOf(h));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'CATEGORY_CREATED',
      actor: 'staff-a',
      reason: 'because we launch',
      changes: { status: [null, 'DRAFT'], iconKey: [null, 'star'], withDescription: [null, true] },
      service_type_id: null,
      prohibited_service_id: null,
      market_id: null,
    });
    expect(audit[0]!.category_id).toBe(created.body.data.categoryId);
    expect(await outboxOf(cidOf(h))).toHaveLength(0); // a DRAFT announces nothing
    // not public anywhere, not even by direct code
    const m = await market('life', 'ACTIVE');
    expect((await api('GET', `/categories/${c}?market=${m}`)).status).toBe(404);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
    // the management view finds it
    expect((await api('GET', `/categories/${c}`, reader)).body.data).toMatchObject({ code: c, status: 'DRAFT' });
  });

  it('refuses a duplicate code (409 CODE_TAKEN, also for a seeded and a RETIRED code), a malformed code (400) and a code that differs only by case', async () => {
    const { code: c } = await category('dup');
    const dup = await api('POST', '/categories', staff, { code: c, reason: REASON });
    expect([dup.status, dup.body.error.code, dup.body.error.details]).toEqual([409, 'CATALOG_CONFLICT', { reason: 'CODE_TAKEN' }]);
    expect(dup.raw).not.toMatch(/uq_|duplicate key|constraint/i);
    expect((await api('POST', '/categories', staff, { code: 'auto_services', reason: REASON })).body.error.details.reason).toBe('CODE_TAKEN');
    expect((await setStatus('categories', c, 'RETIRED')).status).toBe(200);
    expect((await api('POST', '/categories', staff, { code: c, reason: REASON })).status).toBe(409); // a retired code is never reused
    for (const bad of [c.toUpperCase(), `${c}_`, `_${c}`, `${c}__x`, 'a'])
      expect((await api('POST', '/categories', staff, { code: bad, reason: REASON })).status, bad).toBe(400);
    expect(await count('catalog.categories')).toBe((await q('SELECT 1 FROM catalog.categories')).length);
    const stCode = (await serviceType('dupst', 'auto_services')).code;
    const dupSt = await api('POST', '/service-types', staff, { code: stCode, categoryCode: 'home_cleaning', reason: REASON });
    expect([dupSt.status, dupSt.body.error.details.reason]).toEqual([409, 'CODE_TAKEN']); // unique across ALL service types, whatever the category
  });

  it('service types: exactly one category, the category must exist and not be RETIRED, an unknown category is a typed 404, the category never changes', async () => {
    const cat = await category('stparent');
    const st = await serviceType('st', cat.code);
    expect(st.res.body.data).toMatchObject({ categoryCode: cat.code, status: 'DRAFT', name: 'Test service type', displayOrder: null });
    expect(keysOf(st.res.body.data)).toEqual(
      [
        'categoryCode',
        'code',
        'createdAt',
        'description',
        'descriptionContentKey',
        'displayOrder',
        'name',
        'nameContentKey',
        'serviceTypeId',
        'status',
        'updatedAt',
      ].sort(),
    );
    const orphan = code('orphan');
    await names(serviceTypeNameKey(orphan), { en: 'Orphan' });
    const unknown = await api('POST', '/service-types', staff, { code: orphan, categoryCode: 'no_such_category', reason: REASON });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'CATALOG_CATEGORY_NOT_FOUND']);
    // under a RETIRED category: refused
    const dead = await category('dead');
    expect((await setStatus('categories', dead.code, 'RETIRED')).status).toBe(200);
    const underDead = await api('POST', '/service-types', staff, { code: orphan, categoryCode: dead.code, reason: REASON });
    expect([underDead.status, underDead.body.error.code, underDead.body.error.details]).toEqual([409, 'CATALOG_INVALID_STATE', { reason: 'CATEGORY_RETIRED' }]);
    expect((await q('SELECT 1 FROM catalog.service_types WHERE code = $1', [orphan])).length).toBe(0);
    // the category cannot be changed: there is no way to send it (strict body) and the database refuses a raw attempt
    expect((await api('PATCH', `/service-types/${st.code}`, staff, { withDescription: false, categoryCode: 'home_cleaning', reason: REASON })).status).toBe(
      400,
    );
    await expect(
      q('UPDATE catalog.service_types SET category_id = (SELECT category_id FROM catalog.categories WHERE code = $2) WHERE code = $1', [
        st.code,
        'home_cleaning',
      ]),
    ).rejects.toMatchObject({
      detail: 'catalog_rule:IMMUTABLE_IDENTITY',
    });
  });

  it('walks the status machine through the API: every refusal is a typed 409 with the rule as the reason; idempotent repeats write nothing', async () => {
    const cat = await category('mach');
    const m = await market('mach', 'ACTIVE');
    const st = await serviceType('machst', cat.code);
    // a service type cannot be ACTIVE while its category is DRAFT
    const early = await setStatus('service-types', st.code, 'ACTIVE');
    expect([early.status, early.body.error.code, early.body.error.details]).toEqual([409, 'CATALOG_INVALID_STATE', { reason: 'CATEGORY_NOT_ACTIVE' }]);
    // a DRAFT category can go to ACTIVE or RETIRED only
    const draftToPause = await setStatus('categories', cat.code, 'INACTIVE');
    expect([draftToPause.status, draftToPause.body.error.details]).toEqual([409, { reason: 'STATUS_TRANSITION' }]);
    // DRAFT is never a target (400 from the contract, nothing reaches the database)
    expect((await setStatus('categories', cat.code, 'DRAFT')).status).toBe(400);
    const h1 = cids('act');
    const activated = await setStatus('categories', cat.code, 'ACTIVE', h1);
    expect([activated.status, activated.body.data.status]).toEqual([200, 'ACTIVE']);
    const ev1 = await outboxOf(cidOf(h1));
    expect(ev1.map((e) => [e.event_type, e.aggregate_type, e.actor_type, e.actor_id, e.payload_json])).toEqual([
      [CATALOG_EVENTS.categoryActivated, 'catalog_category', 'user', 'staff-a', { categoryCode: cat.code }],
    ]);
    expect(ev1[0]!.aggregate_id).toBe(activated.body.data.categoryId);
    expect(await auditOf(cidOf(h1))).toMatchObject([
      { action: 'CATEGORY_STATUS_CHANGED', actor: 'staff-a', changes: { status: ['DRAFT', 'ACTIVE'] }, reason: REASON },
    ]);
    // repeat: idempotent, no audit row, no event
    const h2 = cids('act2');
    const again = await setStatus('categories', cat.code, 'ACTIVE', h2);
    expect([again.status, again.body.data.status]).toEqual([200, 'ACTIVE']);
    expect(await auditOf(cidOf(h2))).toHaveLength(0);
    expect(await outboxOf(cidOf(h2))).toHaveLength(0);
    // service type ACTIVE now allowed; then the category can neither leave ACTIVE nor be retired
    const h3 = cids('stact');
    expect((await setStatus('service-types', st.code, 'ACTIVE', h3)).status).toBe(200);
    expect((await outboxOf(cidOf(h3))).map((e) => [e.event_type, e.payload_json])).toEqual([
      [CATALOG_EVENTS.serviceTypeActivated, { serviceTypeCode: st.code, categoryCode: cat.code }],
    ]);
    const pause = await setStatus('categories', cat.code, 'INACTIVE');
    expect([pause.status, pause.body.error.details]).toEqual([409, { reason: 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES' }]);
    const retire = await setStatus('categories', cat.code, 'RETIRED');
    expect([retire.status, retire.body.error.details]).toEqual([409, { reason: 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES' }]);
    // pause the service type (an ACTIVE -> INACTIVE announces the deactivation), then the category may pause
    const h4 = cids('stoff');
    expect((await setStatus('service-types', st.code, 'INACTIVE', h4)).status).toBe(200);
    expect((await outboxOf(cidOf(h4))).map((e) => e.event_type)).toEqual([CATALOG_EVENTS.serviceTypeDeactivated]);
    const retireOpen = await setStatus('categories', cat.code, 'RETIRED');
    expect([retireOpen.status, retireOpen.body.error.details]).toEqual([409, { reason: 'CATEGORY_HAS_OPEN_SERVICE_TYPES' }]); // the INACTIVE service type is not RETIRED
    const h5 = cids('catoff');
    expect((await setStatus('categories', cat.code, 'INACTIVE', h5)).status).toBe(200);
    expect((await outboxOf(cidOf(h5))).map((e) => e.event_type)).toEqual([CATALOG_EVENTS.categoryDeactivated]);
    // a service type cannot come back while the category is INACTIVE
    expect((await setStatus('service-types', st.code, 'ACTIVE')).body.error.details.reason).toBe('CATEGORY_NOT_ACTIVE');
    // retire bottom-up; RETIRED is terminal and emits no event when it was not ACTIVE
    const h6 = cids('stret');
    expect((await setStatus('service-types', st.code, 'RETIRED', h6)).status).toBe(200);
    expect(await outboxOf(cidOf(h6))).toHaveLength(0);
    const h7 = cids('catret');
    expect((await setStatus('categories', cat.code, 'RETIRED', h7)).status).toBe(200);
    expect(await outboxOf(cidOf(h7))).toHaveLength(0); // INACTIVE -> RETIRED: it was already deactivated
    for (const target of ['ACTIVE', 'INACTIVE']) {
      const back = await setStatus('categories', cat.code, target);
      expect([back.status, back.body.error.code, back.body.error.details], target).toEqual([409, 'CATALOG_INVALID_STATE', { reason: 'STATUS_TRANSITION' }]);
      expect((await setStatus('service-types', st.code, target)).status, `st ${target}`).toBe(409);
    }
    expect((await setStatus('categories', cat.code, 'RETIRED')).status).toBe(200); // idempotent even when terminal
    expect(m).toBeTruthy();
    // unknown codes
    expect((await setStatus('categories', 'no_such_cat', 'ACTIVE')).body.error.code).toBe('CATALOG_CATEGORY_NOT_FOUND');
    expect((await setStatus('service-types', 'no_such_st', 'ACTIVE')).body.error.code).toBe('CATALOG_SERVICE_TYPE_NOT_FOUND');
    expect((await setStatus('prohibited-services', 'no_such_ps', 'ACTIVE')).body.error.code).toBe('CATALOG_PROHIBITED_SERVICE_NOT_FOUND');
  });

  it('retirement keeps the row, the code and the history: the management view still shows it, the audit trail is complete and ordered, the public view never does', async () => {
    const m = await market('retire', 'ACTIVE');
    const c = await liveCategory('ret', m, 10, { en: 'Doomed' });
    const st = await liveServiceType('retst', c, m, 10);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]);
    // retire from the leaves up: pause + retire the service type, then the category
    expect((await setStatus('service-types', st, 'RETIRED')).status).toBe(200);
    expect((await setStatus('categories', c, 'RETIRED')).status).toBe(200);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
    expect((await api('GET', `/categories/${c}?market=${m}`)).status).toBe(404);
    expect(codes(await api('GET', `/service-types?market=${m}`))).toEqual([]);
    const row = await api('GET', `/categories/${c}?market=${m}`, reader);
    expect(row.body.data).toMatchObject({ code: c, status: 'RETIRED', enabled: true, displayOrder: 10, name: 'Doomed' });
    // a RETIRED item can never be enabled again (the availability row stays as it was; enabling an already enabled one is the idempotent path)
    const newerOrder = await setAvail(m, 'categories', c, true, 20);
    expect(newerOrder.status).toBe(200); // reorder of an enabled row is not "becoming enabled" for the guard
    expect((await setAvail(m, 'categories', c, false)).status).toBe(200);
    const back = await setAvail(m, 'categories', c, true);
    expect([back.status, back.body.error.details]).toEqual([409, { reason: 'ITEM_RETIRED' }]);
    const stBack = await setAvail(m, 'service-types', st, true);
    expect(stBack.status).toBe(409);
    // the audit trail kept every step, in order, with who and why
    const id = row.body.data.categoryId;
    const trail = await q<{ action: string; changes: Json }>(
      "SELECT action, changes FROM catalog.audit_events WHERE category_id = $1 AND action LIKE 'CATEGORY\\_%' ORDER BY occurred_at, audit_event_id",
      [id],
    );
    expect(trail.map((a) => a.action)).toEqual(['CATEGORY_CREATED', 'CATEGORY_STATUS_CHANGED', 'CATEGORY_STATUS_CHANGED']);
    expect(trail.map((a) => a.changes?.status)).toEqual([
      [null, 'DRAFT'],
      ['DRAFT', 'ACTIVE'],
      ['ACTIVE', 'RETIRED'],
    ]);
    expect(await q('SELECT 1 FROM catalog.categories WHERE code = $1', [c])).toHaveLength(1);
    // raw deletes and truncates are refused by the database as the last line
    await expect(q('DELETE FROM catalog.categories WHERE code = $1', [c])).rejects.toMatchObject({ detail: 'catalog_rule:NOT_DELETABLE' });
    await expect(q('DELETE FROM catalog.audit_events WHERE category_id = $1', [id])).rejects.toMatchObject({ detail: 'catalog_rule:ROW_IMMUTABLE' });
    await expect(q('UPDATE catalog.audit_events SET reason = $2 WHERE category_id = $1', [id, 'tampered'])).rejects.toMatchObject({
      detail: 'catalog_rule:ROW_IMMUTABLE',
    });
  });

  it('updates metadata idempotently: icon and description link change the row, write ONE audit row each, and a repeat writes nothing; the response is the management view', async () => {
    const c = (await category('upd', { en: 'Updatable', desc: 'About it' })).code;
    const h1 = cids('upd');
    const r1 = await api('PATCH', `/categories/${c}`, staff, { iconKey: 'wrench', reason: 'give it an icon' }, h1);
    expect(r1.status, r1.raw).toBe(200);
    expect(r1.body.data).toMatchObject({ iconKey: 'wrench', description: 'About it' });
    expect(await auditOf(cidOf(h1))).toMatchObject([
      { action: 'CATEGORY_UPDATED', actor: 'staff-a', reason: 'give it an icon', changes: { iconKey: [null, 'wrench'] } },
    ]);
    const h2 = cids('upd2');
    expect((await api('PATCH', `/categories/${c}`, staff, { iconKey: 'wrench', reason: 'again' }, h2)).status).toBe(200);
    expect(await auditOf(cidOf(h2))).toHaveLength(0);
    const unlink = await api('PATCH', `/categories/${c}`, staff, { withDescription: false, iconKey: null, reason: 'strip' });
    expect(unlink.body.data).toMatchObject({ iconKey: null, description: null, descriptionContentKey: null });
    // linking a description whose entry does not exist is a typed 400
    const bare = (await category('bare', { en: 'Bare' })).code;
    const noDesc = await api('PATCH', `/categories/${bare}`, staff, { withDescription: true, reason: REASON });
    expect([noDesc.status, noDesc.body.error.details]).toEqual([400, { reason: 'DESCRIPTION_CONTENT_MISSING' }]);
    // service type: link and unlink its description
    const st = await serviceType('updst', c);
    await ensureEntry(`catalog.service_type.${st.code}.description`, 'PLAIN_TEXT');
    await publishText(`catalog.service_type.${st.code}.description`, 'en-US', 'About st');
    const linked = await api('PATCH', `/service-types/${st.code}`, staff, { withDescription: true, reason: REASON });
    expect(linked.body.data).toMatchObject({ description: 'About st' });
    const h3 = cids('updst');
    expect((await api('PATCH', `/service-types/${st.code}`, staff, { withDescription: true, reason: REASON }, h3)).status).toBe(200);
    expect(await auditOf(cidOf(h3))).toHaveLength(0);
    expect((await api('PATCH', '/categories/no_such_cat', staff, { iconKey: 'x', reason: REASON })).status).toBe(404);
    expect((await api('PATCH', '/service-types/no_such_st', staff, { withDescription: false, reason: REASON })).status).toBe(404);
  });
});

// ====================================================================== availability, the public view
describe('market availability and the public view', () => {
  it('lists EXACTLY the ACTIVE, enabled categories and service types of an ACTIVE market, in the market order, with resolved text in two locales and nothing else', async () => {
    const m = await market('pub', 'ACTIVE');
    const first = await liveCategory('pubb', m, 20, { en: 'Second in menu', es: 'Segundo en el menu', desc: 'About the second', descEs: 'Sobre el segundo' });
    const second = await liveCategory('puba', m, 10, { en: 'First in menu', es: 'Primero en el menu' });
    const st1 = await liveServiceType('pubst1', first, m, 20, { en: 'Service two', es: 'Servicio dos' });
    const st2 = await liveServiceType('pubst2', first, m, 10, { en: 'Service one', es: 'Servicio uno' });
    // noise that must NOT appear: a DRAFT category, a category ACTIVE but not enabled, an enabled category row that is INACTIVE, a service type DRAFT / not enabled
    const draft = (await category('pubdraft', { en: 'Draft' })).code;
    expect((await setAvail(m, 'categories', draft, true, 30)).status).toBe(200); // prepared: enabled but not ACTIVE
    const unlisted = (await category('pubunl', { en: 'Unlisted' })).code;
    expect((await setStatus('categories', unlisted, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m, 'categories', unlisted, false, 40)).status).toBe(200);
    const stDraft = (await serviceType('pubstd', first, { en: 'Draft service' })).code;
    expect((await setAvail(m, 'service-types', stDraft, true, 30)).status).toBe(200);
    const stOff = await serviceType('pubsto', first, { en: 'Off service' });
    expect((await setStatus('service-types', stOff.code, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m, 'service-types', stOff.code, false, 40)).status).toBe(200);

    const en = await api('GET', `/categories?market=${m}`);
    expect(en.status).toBe(200);
    expect(codes(en)).toEqual([second, first]); // market order, not code order
    expect(en.body.data.map((c: { displayOrder: number }) => c.displayOrder)).toEqual([10, 20]);
    for (const c of en.body.data) expect(keysOf(c)).toEqual(PUBLIC_CAT_KEYS);
    expect(en.body.data[1]).toMatchObject({ name: 'Second in menu', description: 'About the second', iconKey: null });
    expect(en.body.data[0]).toMatchObject({ name: 'First in menu', description: null });
    expect(en.headers.vary).toMatch(/authorization/i);
    const es = await api('GET', `/categories?market=${m}&locale=es-US`);
    expect(es.body.data.map((c: { name: string; description: string | null }) => [c.name, c.description])).toEqual([
      ['Primero en el menu', null],
      ['Segundo en el menu', 'Sobre el segundo'],
    ]);
    // the locale falls back along the content chain when a translation is missing
    const noEs = await category('pubnoes', { en: 'English only' });
    expect((await setStatus('categories', noEs.code, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m, 'categories', noEs.code, true, 50)).status).toBe(200);
    expect((await api('GET', `/categories/${noEs.code}?market=${m}&locale=es-US`)).body.data.name).toBe('English only');
    expect((await setAvail(m, 'categories', noEs.code, false)).status).toBe(200);

    const sts = await api('GET', `/service-types?market=${m}`);
    expect(codes(sts)).toEqual([st2, st1]);
    for (const s of sts.body.data) expect(keysOf(s)).toEqual(PUBLIC_ST_KEYS);
    expect(sts.body.data[0]).toMatchObject({ name: 'Service one', categoryCode: first, displayOrder: 10 });
    expect((await api('GET', `/service-types?market=${m}&locale=es-US`)).body.data.map((s: { name: string }) => s.name)).toEqual([
      'Servicio uno',
      'Servicio dos',
    ]);
    expect(codes(await api('GET', `/service-types?market=${m}&category=${first}`))).toEqual([st2, st1]);
    expect(codes(await api('GET', `/service-types?market=${m}&category=${second}`))).toEqual([]);
    expect(codes(await api('GET', `/service-types?market=${m}&category=no_such_cat`))).toEqual([]);
    expect((await api('GET', `/categories/${first}?market=${m}`)).body.data.code).toBe(first);
    expect((await api('GET', `/service-types/${st1}?market=${m}`)).body.data).toMatchObject({ code: st1, name: 'Service two' });
    for (const hidden of [draft, unlisted]) expect((await api('GET', `/categories/${hidden}?market=${m}`)).status, hidden).toBe(404);
    for (const hidden of [stDraft, stOff.code]) expect((await api('GET', `/service-types/${hidden}?market=${m}`)).status, hidden).toBe(404);
    // no internals whatsoever
    for (const r of [en, es, sts])
      for (const w of ['status', 'enabled', 'ContentKey', 'createdAt', 'updatedAt', 'actor', 'audit', 'staff-a', 'catalog.category', 'catalog.service_type'])
        expect(r.raw, w).not.toContain(w);
    // the MARKET is required, for anonymous and for tokens without the role
    for (const t of [undefined, customer, norole]) expect((await api('GET', '/categories', t)).status).toBe(400);
  });

  it('the same category is in different positions in different markets, and a service type needs its category enabled in the SAME market', async () => {
    const m1 = await market('two-a', 'ACTIVE');
    const m2 = await market('two-b', 'ACTIVE');
    const c = (await category('shared', { en: 'Shared' })).code;
    expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
    const st = (await serviceType('sharedst', c)).code;
    expect((await setStatus('service-types', st, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m1, 'categories', c, true, 10)).status).toBe(200);
    const noCat = await setAvail(m2, 'service-types', st, true, 10);
    expect([noCat.status, noCat.body.error.details]).toEqual([409, { reason: 'CATEGORY_NOT_ENABLED_IN_MARKET' }]); // enabled in m1 only
    expect((await setAvail(m1, 'service-types', st, true, 10)).status).toBe(200);
    expect(codes(await api('GET', `/service-types?market=${m1}`))).toEqual([st]);
    expect(codes(await api('GET', `/service-types?market=${m2}`))).toEqual([]);
    expect(codes(await api('GET', `/categories?market=${m2}`))).toEqual([]);
    expect((await setAvail(m2, 'categories', c, true, 99)).status).toBe(200);
    expect((await api('GET', `/categories/${c}?market=${m2}`)).body.data.displayOrder).toBe(99);
    expect((await api('GET', `/categories/${c}?market=${m1}`)).body.data.displayOrder).toBe(10);
  });

  it('display order: required for a new row (400), unique per market (409), swapping takes a free slot, out-of-range is refused, an unknown market or code is a typed 404', async () => {
    const m = await market('order', 'ACTIVE');
    const a = (await category('orda')).code;
    const b = (await category('ordb')).code;
    const missing = await setAvail(m, 'categories', a, true);
    expect([missing.status, missing.body.error.code, missing.body.error.details]).toEqual([
      400,
      'CATALOG_VALIDATION_FAILED',
      { reason: 'DISPLAY_ORDER_REQUIRED', field: 'displayOrder' },
    ]);
    const inMarket = async () =>
      Number(
        (
          await q<{ n: string }>(
            'SELECT count(*)::text AS n FROM catalog.market_categories mc JOIN geography.markets mk USING (market_id) WHERE mk.code = $1',
            [m],
          )
        )[0]!.n,
      );
    expect(await inMarket()).toBe(0);
    expect((await setAvail(m, 'categories', a, true, 10)).body.data).toEqual({
      marketCode: m,
      code: a,
      kind: 'CATEGORY',
      enabled: true,
      displayOrder: 10,
      alsoDisabled: [],
    });
    const taken = await setAvail(m, 'categories', b, true, 10);
    expect([taken.status, taken.body.error.code, taken.body.error.details]).toEqual([409, 'CATALOG_CONFLICT', { reason: 'DISPLAY_ORDER_TAKEN' }]);
    expect(taken.raw).not.toMatch(/uq_|duplicate|constraint/i);
    expect((await q('SELECT 1 FROM catalog.market_categories mc JOIN catalog.categories c USING (category_id) WHERE c.code = $1', [b])).length).toBe(0);
    // a disabled row keeps its slot
    expect((await setAvail(m, 'categories', a, false)).status).toBe(200);
    expect((await setAvail(m, 'categories', b, true, 10)).status).toBe(409);
    expect((await setAvail(m, 'categories', b, true, 11)).status).toBe(200);
    // reorder to a free slot
    expect((await setAvail(m, 'categories', a, false, 12)).body.data.displayOrder).toBe(12);
    for (const bad of [0, 10000, -3, 1.5]) expect((await setAvail(m, 'categories', a, true, bad)).status, String(bad)).toBe(400);
    expect((await setAvail('devtest-cat-nowhere', 'categories', a, true, 5)).body.error.code).toBe('CATALOG_MARKET_NOT_FOUND');
    expect((await setAvail(m, 'categories', 'no_such_cat', true, 5)).body.error.code).toBe('CATALOG_CATEGORY_NOT_FOUND');
    expect((await setAvail(m, 'service-types', 'no_such_st', true, 5)).body.error.code).toBe('CATALOG_SERVICE_TYPE_NOT_FOUND');
    // service types have their OWN order space in the market
    const st = (await serviceType('ordst', a)).code;
    expect((await setStatus('categories', a, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m, 'categories', a, true)).status).toBe(200);
    expect((await setAvail(m, 'service-types', st, true, 10)).status).toBe(200);
  });

  it('the CASCADE: switching a category off in a market first switches off its enabled service types there (listed in alsoDisabled, ONE audit row and ONE event each), and the public view hides all of them at once', async () => {
    const m = await market('casc', 'ACTIVE');
    const other = await market('casc2', 'ACTIVE');
    const c = await liveCategory('casc', m, 10, { en: 'Cascade parent' });
    expect((await setAvail(other, 'categories', c, true, 10)).status).toBe(200);
    const s1 = await liveServiceType('cascz', c, m, 10);
    const s2 = await liveServiceType('cascy', c, m, 20);
    const s3 = (await serviceType('cascoff', c, { en: 'Never enabled' })).code;
    expect((await setStatus('service-types', s3, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(other, 'service-types', s1, true, 10)).status).toBe(200); // the same service type in ANOTHER market stays
    expect(codes(await api('GET', `/service-types?market=${m}`))).toEqual([s1, s2]);
    const h = cids('casc');
    const off = await setAvail(m, 'categories', c, false, undefined, h);
    expect(off.status, off.raw).toBe(200);
    expect(off.body.data).toEqual({ marketCode: m, code: c, kind: 'CATEGORY', enabled: false, displayOrder: 10, alsoDisabled: [s1, s2].sort() });
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
    expect(codes(await api('GET', `/service-types?market=${m}`))).toEqual([]);
    expect(codes(await api('GET', `/service-types?market=${other}`))).toEqual([s1]);
    expect(codes(await api('GET', `/categories?market=${other}`))).toEqual([c]);
    const audit = await auditOf(cidOf(h));
    expect(audit).toHaveLength(3);
    const cascaded = audit.filter((a) => a.service_type_id !== null).map((a) => a.changes!);
    expect(cascaded.map((ch) => ch.displayOrder![0]).sort()).toEqual([10, 20]);
    for (const ch of cascaded) expect(ch).toMatchObject({ enabled: [true, false], becauseCategory: c });
    expect(audit.every((a) => a.action === 'MARKET_CATALOG_AVAILABILITY_CHANGED' && a.actor === 'staff-a' && a.reason === REASON && a.market_id !== null)).toBe(
      true,
    );
    expect(audit.filter((a) => a.category_id !== null)).toHaveLength(1);
    const events = await outboxOf(cidOf(h));
    expect(events).toHaveLength(3);
    expect(
      events.every(
        (e) => e.event_type === CATALOG_EVENTS.availabilityChanged && e.aggregate_type === 'catalog_market_availability' && e.actor_id === 'staff-a',
      ),
    ).toBe(true);
    expect(events.map((e) => e.payload_json).sort((x, y) => String(x.code).localeCompare(String(y.code)))).toEqual(
      [
        { marketCode: m, kind: 'CATEGORY', code: c, enabled: false },
        { marketCode: m, kind: 'SERVICE_TYPE', code: s1, enabled: false },
        { marketCode: m, kind: 'SERVICE_TYPE', code: s2, enabled: false },
      ].sort((x, y) => x.code.localeCompare(y.code)),
    );
    // service-type rows are switched off in the market's rows, nothing else changed
    const rows = await q<{ enabled: boolean; code: string }>(
      'SELECT mst.enabled, st.code FROM catalog.market_service_types mst JOIN catalog.service_types st USING (service_type_id) JOIN geography.markets mk ON mk.market_id = mst.market_id WHERE mk.code = $1 ORDER BY st.code',
      [m],
    );
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    // the repeat is idempotent: nothing written, empty alsoDisabled
    const h2 = cids('casc2');
    expect((await setAvail(m, 'categories', c, false, undefined, h2)).body.data.alsoDisabled).toEqual([]);
    expect(await auditOf(cidOf(h2))).toHaveLength(0);
    expect(await outboxOf(cidOf(h2))).toHaveLength(0);
    // switching the category back on does NOT bring the service types back
    expect((await setAvail(m, 'categories', c, true)).status).toBe(200);
    expect(codes(await api('GET', `/service-types?market=${m}`))).toEqual([]);
    expect((await setAvail(m, 'service-types', s1, true)).status).toBe(200);
    expect(codes(await api('GET', `/service-types?market=${m}`))).toEqual([s1]);
    // the database refuses the same switch-off done directly while a service type is enabled (the guard is the second line)
    await expect(
      q(
        'UPDATE catalog.market_categories SET enabled = false WHERE market_id = (SELECT market_id FROM geography.markets WHERE code = $1) AND category_id = (SELECT category_id FROM catalog.categories WHERE code = $2)',
        [m, c],
      ),
    ).rejects.toMatchObject({ detail: 'catalog_rule:CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES' });
  });

  it('a PLANNED market (and the seeded la-oc) exposes NOTHING even with enabled rows; the management view still sees the rows; going ACTIVE exposes them at once, INACTIVE hides them again', async () => {
    const planned = await market('planned', 'PLANNED');
    const c = await liveCategory('plan', planned, 10, { en: 'Prepared early' });
    const st = await liveServiceType('planst', c, planned, 10);
    for (const t of [undefined, customer, norole, contentStaff]) {
      for (const u of ['/categories', `/categories/${c}`, '/service-types', `/service-types/${st}`]) {
        const r = await api('GET', `${u}${u.includes('?') ? '&' : '?'}market=${planned}`, t);
        expect(r.status, `${u}`).toBe(404);
        expect(r.body.error.code).toBe('CATALOG_MARKET_NOT_FOUND');
      }
    }
    const seen = await api('GET', `/categories?market=${planned}`, reader);
    expect(seen.status).toBe(200);
    expect(seen.body.data.find((x: { code: string }) => x.code === c)).toMatchObject({ enabled: true, displayOrder: 10, status: 'ACTIVE' });
    expect((await api('GET', `/service-types/${st}?market=${planned}`, reader)).body.data).toMatchObject({ enabled: true, status: 'ACTIVE' });
    // the SEEDED PLANNED market la-oc, with a seeded (already named) category made ACTIVE and enabled
    expect((await setStatus('categories', 'home_cleaning', 'ACTIVE')).status).toBe(200);
    expect((await setAvail('la-oc', 'categories', 'home_cleaning', true, 10)).status).toBe(200);
    expect((await api('GET', '/categories?market=la-oc')).status).toBe(404);
    expect((await api('GET', '/categories/home_cleaning?market=la-oc')).status).toBe(404);
    expect((await api('GET', '/categories?market=la-oc', reader)).body.data.find((x: { code: string }) => x.code === 'home_cleaning')).toMatchObject({
      enabled: true,
      name: 'Home Cleaning',
    });
    // lifecycle of the market: ACTIVE exposes, INACTIVE hides, ACTIVE again exposes the same rows; no catalogue invalidation needed (the gate decides on every call)
    await geography.setMarketActive(planned, true, 'launch', A);
    expect(codes(await api('GET', `/categories?market=${planned}`))).toEqual([c]);
    expect(codes(await api('GET', `/service-types?market=${planned}`))).toEqual([st]);
    await geography.setMarketActive(planned, false, 'pause', A);
    expect((await api('GET', `/categories?market=${planned}`)).status).toBe(404);
    expect((await api('GET', `/service-types/${st}?market=${planned}`)).status).toBe(404);
    expect((await api('GET', `/categories?market=${planned}`, reader)).status).toBe(200); // still manageable
    await geography.setMarketActive(planned, true, 'resume', A);
    expect(codes(await api('GET', `/categories?market=${planned}`))).toEqual([c]);
  });

  it('an INACTIVE market is exactly like an unknown one for the public, and an unknown or malformed market is the same 404 (identical body but the echoed code)', async () => {
    const inactive = await market('inactive', 'INACTIVE');
    const answers: string[] = [];
    for (const m of [inactive, 'devtest-cat-never', 'la-oc', 'us-sf']) {
      const r = await api('GET', `/categories?market=${m}`);
      expect(r.status, m).toBe(404);
      const { correlationId: _c, details: _d, ...rest } = r.body.error;
      answers.push(JSON.stringify(rest));
    }
    expect(new Set(answers).size).toBe(1);
    expect((await api('GET', '/categories?market=Not_A_Market')).status).toBe(400); // malformed: rejected by the contract
  });

  it('INACTIVE categories and service types are hidden and come back when reactivated; ids, codes and order are unchanged', async () => {
    const m = await market('pause', 'ACTIVE');
    const c = await liveCategory('pause', m, 10, { en: 'Pausable' });
    const st = await liveServiceType('pausest', c, m, 10);
    const before = (await api('GET', `/service-types/${st}?market=${m}`)).body.data;
    expect((await setStatus('service-types', st, 'INACTIVE')).status).toBe(200);
    expect(codes(await api('GET', `/service-types?market=${m}`))).toEqual([]);
    expect((await api('GET', `/service-types/${st}?market=${m}`)).status).toBe(404);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]);
    expect((await setStatus('categories', c, 'INACTIVE')).status).toBe(200);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
    expect((await api('GET', `/categories/${c}?market=${m}`)).status).toBe(404);
    expect((await api('GET', `/categories/${c}?market=${m}`, reader)).body.data).toMatchObject({ status: 'INACTIVE', enabled: true });
    expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
    expect((await setStatus('service-types', st, 'ACTIVE')).status).toBe(200);
    expect((await api('GET', `/service-types/${st}?market=${m}`)).body.data).toEqual(before);
  });

  it('a content RENAME (a new published version of the name) changes the text at once and nothing else: id, code, order stay; the catalogue cache holds keys only', async () => {
    const m = await market('rename', 'ACTIVE');
    const c = await liveCategory('ren', m, 10, { en: 'Original name', es: 'Nombre original' });
    const before = (await api('GET', `/categories/${c}?market=${m}`)).body.data;
    expect(before.name).toBe('Original name');
    await new Promise((r) => setTimeout(r, 6)); // the new version starts after the first one
    await publishText(categoryNameKey(c), 'en-US', 'Renamed category');
    const after = (await api('GET', `/categories/${c}?market=${m}`)).body.data;
    expect(after).toEqual({ ...before, name: 'Renamed category' });
    expect((await api('GET', `/categories?market=${m}&locale=es-US`)).body.data[0].name).toBe('Nombre original');
    // no catalogue audit row or event for a content change; the cache entry holds codes and keys, never text
    expect((await api('GET', `/categories?market=${m}`)).status).toBe(200); // warm the entry of THIS generation
    const entry = [...cache.data.entries()].filter(([k]) => k.startsWith(`bg:test:cat:v1:market:${m}:`));
    expect(entry.length).toBeGreaterThan(0);
    for (const [, v] of entry) {
      expect(v).not.toContain('Original name');
      expect(v).not.toContain('Renamed category');
      expect(v).toContain(categoryNameKey(c));
      expect(v).not.toMatch(/"status"|"enabled"|createdAt|actor/);
    }
  });

  it('an item whose name has no published text in ANY locale is omitted from the public view but visible (with the content key as its name) to administrators', async () => {
    const m = await market('unnamed', 'ACTIVE');
    const c = code('unnamed');
    await ensureEntry(categoryNameKey(c)); // the entry exists (the foreign key) but nothing is published yet
    expect((await api('POST', '/categories', staff, { code: c, reason: REASON })).status).toBe(201);
    expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m, 'categories', c, true, 10)).status).toBe(200);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
    expect((await api('GET', `/categories/${c}?market=${m}`)).status).toBe(404);
    const mgmt = await api('GET', `/categories/${c}?market=${m}`, reader);
    expect(mgmt.body.data).toMatchObject({ code: c, name: categoryNameKey(c), description: null });
    await publishText(categoryNameKey(c), 'en-US', 'Now named');
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]);
  });

  it('the market default locale decides the language of a request without `locale`', async () => {
    const m = await market('eslocale', 'ACTIVE', 'es-US');
    const c = await liveCategory('esloc', m, 10, { en: 'English name', es: 'Nombre en espanol' });
    expect((await api('GET', `/categories/${c}?market=${m}`)).body.data.name).toBe('Nombre en espanol');
    expect((await api('GET', `/categories/${c}?market=${m}&locale=en-US`)).body.data.name).toBe('English name');
  });

  it('a market outside its effective window is not public (the gate evaluates the window on every call)', async () => {
    const m = await market('window', 'ACTIVE');
    const c = await liveCategory('win', m, 10, { en: 'Windowed' });
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]);
    await q('ALTER TABLE geography.markets DISABLE TRIGGER USER');
    try {
      await q("UPDATE geography.markets SET effective_from = now() - interval '2 days', effective_to = now() - interval '1 day' WHERE code = $1", [m]);
    } finally {
      await q('ALTER TABLE geography.markets ENABLE TRIGGER USER');
    }
    const r = await api('GET', `/categories?market=${m}`);
    expect([r.status, r.body.error?.code]).toEqual([404, 'CATALOG_MARKET_NOT_FOUND']);
    expect((await api('GET', `/categories?market=${m}`, reader)).status).toBe(200);
  });
});

// ====================================================================== prohibited services
describe('prohibited services (management only)', () => {
  it('create, list, read and change the status; never part of the public catalogue; audited; no events', async () => {
    const p = code('proh');
    await names(prohibitedServiceNameKey(p), { en: 'Something forbidden' });
    const h = cids('proh');
    const created = await api('POST', '/prohibited-services', staff, { code: p, categoryCode: 'auto_services', reason: 'policy AD-01.03' }, h);
    expect(created.status, created.raw).toBe(201);
    expect(created.body.data).toMatchObject({ code: p, categoryCode: 'auto_services', status: 'DRAFT', name: 'Something forbidden', description: null });
    expect(await auditOf(cidOf(h))).toMatchObject([
      {
        action: 'PROHIBITED_SERVICE_CREATED',
        actor: 'staff-a',
        reason: 'policy AD-01.03',
        changes: { status: [null, 'DRAFT'], categoryCode: [null, 'auto_services'] },
      },
    ]);
    expect(await outboxOf(cidOf(h))).toHaveLength(0);
    expect((await api('GET', `/prohibited-services/${p}`, reader)).body.data.status).toBe('DRAFT');
    expect((await api('GET', '/prohibited-services', writer)).body.data.map((x: { code: string }) => x.code)).toContain(p);
    const h2 = cids('proh2');
    expect((await setStatus('prohibited-services', p, 'ACTIVE', h2)).body.data.status).toBe('ACTIVE');
    expect(await auditOf(cidOf(h2))).toMatchObject([{ action: 'PROHIBITED_SERVICE_STATUS_CHANGED', changes: { status: ['DRAFT', 'ACTIVE'] } }]);
    expect(await outboxOf(cidOf(h2))).toHaveLength(0);
    const h3 = cids('proh3');
    expect((await setStatus('prohibited-services', p, 'ACTIVE', h3)).status).toBe(200);
    expect(await auditOf(cidOf(h3))).toHaveLength(0);
    expect((await setStatus('prohibited-services', p, 'RETIRED')).status).toBe(200);
    expect((await setStatus('prohibited-services', p, 'ACTIVE')).body.error.details.reason).toBe('STATUS_TRANSITION');
    expect((await api('POST', '/prohibited-services', staff, { code: p, reason: REASON })).status).toBe(409);
    expect((await api('POST', '/prohibited-services', staff, { code: code('proh'), reason: REASON })).body.error.details.reason).toBe('NAME_CONTENT_MISSING');
    expect((await api('POST', '/prohibited-services', staff, { code: code('proh'), categoryCode: 'no_such_cat', reason: REASON })).status).toBe(404);
    expect((await api('GET', '/prohibited-services/no_such_ps', reader)).body.error.code).toBe('CATALOG_PROHIBITED_SERVICE_NOT_FOUND');
    // not reachable through any public route
    const m = await market('proh', 'ACTIVE');
    for (const u of [`/categories?market=${m}`, `/service-types?market=${m}`]) expect((await api('GET', u)).raw).not.toContain(p);
    for (const u of [`/categories/${p}?market=${m}`, `/service-types/${p}?market=${m}`]) expect((await api('GET', u)).status).toBe(404);
    expect((await api('GET', `/categories/${p}?market=${m}`, reader)).status).toBe(404); // not even a management category
    expect((await api('GET', `/prohibited-services/${p}`)).status).toBe(401);
  });
});

// ====================================================================== audit and outbox
describe('audit rows and outbox events: one per effective mutation, identifier-only, in the same transaction', () => {
  it('writes exactly the documented rows and events for a full cycle and none for refused or idempotent calls', async () => {
    const m = await market('audit', 'ACTIVE');
    const cat = await category('aud', { en: 'Audited' });
    const st = await serviceType('audst', cat.code);
    const steps: [string, () => Promise<Res>, number, string[]][] = [];
    const run = async (name: string, f: (h: Record<string, string>) => Promise<Res>, status: number, audit: string[], events: string[]) => {
      const h = cids(name);
      const r = await f(h);
      expect(r.status, `${name}: ${r.raw}`).toBe(status);
      expect(
        (await auditOf(cidOf(h))).map((a) => a.action),
        `${name} audit`,
      ).toEqual(audit);
      expect(
        (await outboxOf(cidOf(h))).map((e) => e.event_type),
        `${name} events`,
      ).toEqual(events);
      steps.push([name, async () => r, status, audit]);
    };
    await run('cat-active', (h) => setStatus('categories', cat.code, 'ACTIVE', h), 200, ['CATEGORY_STATUS_CHANGED'], [CATALOG_EVENTS.categoryActivated]);
    await run('cat-active-again', (h) => setStatus('categories', cat.code, 'ACTIVE', h), 200, [], []);
    await run(
      'cat-avail',
      (h) => setAvail(m, 'categories', cat.code, true, 10, h),
      200,
      ['MARKET_CATALOG_AVAILABILITY_CHANGED'],
      [CATALOG_EVENTS.availabilityChanged],
    );
    await run('cat-avail-again', (h) => setAvail(m, 'categories', cat.code, true, 10, h), 200, [], []);
    await run(
      'cat-avail-order',
      (h) => setAvail(m, 'categories', cat.code, true, 11, h),
      200,
      ['MARKET_CATALOG_AVAILABILITY_CHANGED'],
      [CATALOG_EVENTS.availabilityChanged],
    );
    await run(
      'st-active',
      (h) => setStatus('service-types', st.code, 'ACTIVE', h),
      200,
      ['SERVICE_TYPE_STATUS_CHANGED'],
      [CATALOG_EVENTS.serviceTypeActivated],
    );
    await run(
      'st-avail',
      (h) => setAvail(m, 'service-types', st.code, true, 10, h),
      200,
      ['MARKET_CATALOG_AVAILABILITY_CHANGED'],
      [CATALOG_EVENTS.availabilityChanged],
    );
    await run('st-update', async (h) => api('PATCH', `/service-types/${st.code}`, staff, { withDescription: false, reason: REASON }, h), 200, [], []);
    await run('refused-order', (h) => setAvail(m, 'service-types', st.code, true, 0, h), 400, [], []);
    await run('refused-state', (h) => setStatus('categories', cat.code, 'INACTIVE', h), 409, [], []);
    await run('refused-role', (h) => api('PUT', `/categories/${cat.code}/status`, reader, { status: 'INACTIVE', reason: REASON }, h), 403, [], []);
    await run('refused-anon', (h) => api('PUT', `/categories/${cat.code}/status`, undefined, { status: 'INACTIVE', reason: REASON }, h), 401, [], []);
    await run(
      'st-off',
      (h) => setStatus('service-types', st.code, 'INACTIVE', h),
      200,
      ['SERVICE_TYPE_STATUS_CHANGED'],
      [CATALOG_EVENTS.serviceTypeDeactivated],
    );
    await run('cat-off', (h) => setStatus('categories', cat.code, 'INACTIVE', h), 200, ['CATEGORY_STATUS_CHANGED'], [CATALOG_EVENTS.categoryDeactivated]);
    expect(steps.length).toBe(14);
    // event contents: identifier-only payloads, the actor, the aggregate
    const all = await q<{ event_type: string; payload_json: Json; actor_id: string; actor_type: string }>(
      "SELECT event_type, payload_json, actor_id, actor_type FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%' ORDER BY created_at, outbox_event_id",
    );
    expect(all.length).toBeGreaterThan(5);
    for (const e of all) {
      expect(e.actor_type).toBe('user');
      expect(Object.values(CATALOG_EVENTS)).toContain(e.event_type);
      expect(Object.keys(e.payload_json).every((k) => ['categoryCode', 'serviceTypeCode', 'marketCode', 'kind', 'code', 'enabled'].includes(k))).toBe(true);
      expect(JSON.stringify(e.payload_json)).not.toMatch(/Audited|reason|staff-a|token|Bearer/i);
    }
    // every audit row has exactly one subject, a reason, an actor, and none holds text or tokens
    const rows = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM catalog.audit_events WHERE (category_id IS NOT NULL)::int + (service_type_id IS NOT NULL)::int + (prohibited_service_id IS NOT NULL)::int + (market_id IS NOT NULL)::int < 1 OR length(btrim(reason)) = 0`,
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('a failed mutation rolls back completely: no audit row, no event, no row, the cache generation is not bumped', async () => {
    const m = await market('rollback', 'ACTIVE');
    const c = await liveCategory('rb', m, 10);
    const second = (await category('rb2')).code;
    const genKey = 'bg:test:cat:gen';
    const gen = cache.data.get(genKey);
    const rowsBefore = [await count('catalog.audit_events'), await count('integration.outbox_events'), await count('catalog.market_categories')];
    const dup = await setAvail(m, 'categories', second, true, 10); // order taken -> 409 after the service started its transaction
    expect(dup.status).toBe(409);
    expect([await count('catalog.audit_events'), await count('integration.outbox_events'), await count('catalog.market_categories')]).toEqual(rowsBefore);
    expect(cache.data.get(genKey)).toBe(gen);
    expect(c).toBeTruthy();
  });

  it('the cache generation is bumped after an effective change and only then', async () => {
    const m = await market('gen', 'ACTIVE');
    const c = (await category('gen', { en: 'Generation' })).code;
    const g0 = cache.data.get('bg:test:cat:gen');
    expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
    const g1 = cache.data.get('bg:test:cat:gen');
    expect(g1).not.toBe(g0);
    expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
    expect(cache.data.get('bg:test:cat:gen')).toBe(g1);
    expect((await setAvail(m, 'categories', c, true, 10)).status).toBe(200);
    const g2 = cache.data.get('bg:test:cat:gen');
    expect(g2).not.toBe(g1);
    // a read warms the cache for this generation; a change makes the old entry unreachable
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]);
    expect((await setAvail(m, 'categories', c, false)).status).toBe(200);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
  });
});

// ====================================================================== privacy, concurrency, budget, outage
describe('privacy, parallel reads, query budget and an unavailable database', () => {
  it('logs and responses never contain a token, a token segment or the subject of the caller', async () => {
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    try {
      const secretSub = 'subject-9f3c1a77';
      const t = await adminToken(secretSub, ['catalog-read', 'catalog-write']);
      const m = await market('privacy', 'ACTIVE');
      const c = (await category('priv', { en: 'Private' })).code;
      const responses: Res[] = [
        await api('GET', `/categories?market=${m}`, t),
        await api('GET', '/prohibited-services', t),
        await api('PUT', `/categories/${c}/status`, t, { status: 'ACTIVE', reason: REASON }),
        await api('PUT', `/markets/${m}/categories/${c}`, t, { enabled: true, displayOrder: 10, reason: REASON }),
        await api('PUT', `/markets/${m}/categories/${c}`, t, { enabled: true, displayOrder: 10 }), // 400
        await api('PUT', `/markets/${m}/categories/${c}`, 'not.a.token', { enabled: true, displayOrder: 10, reason: REASON }), // 401
        await api('PUT', `/markets/${m}/categories/${c}`, customer, { enabled: true, displayOrder: 10, reason: REASON }), // 403
        await api('POST', '/categories', t, { code: c, reason: REASON }), // 409
        await api('GET', `/categories?market=${m}`),
        await api('GET', '/categories?market=never-heard'),
      ];
      const [h, p, s] = t.split('.');
      for (const r of responses)
        for (const needle of [t, h!, p!, s!, secretSub, 'bearer ']) expect(r.raw.toLowerCase(), needle.slice(0, 12)).not.toContain(needle.toLowerCase());
      const out = logged.join('\n');
      expect(out.length).toBeGreaterThan(0); // the request log lines exist
      for (const needle of [t, h!, p!, s!, secretSub, 'authorization']) expect(out.toLowerCase(), needle.slice(0, 12)).not.toContain(needle.toLowerCase());
    } finally {
      spy.mockRestore();
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it('20 parallel public requests return the identical response, cold (right after a change) and warm', async () => {
    const m = await market('parallel', 'ACTIVE');
    const c = await liveCategory('par', m, 10, { en: 'Parallel', desc: 'Same for everybody' });
    await liveServiceType('parst', c, m, 10);
    const results: string[][] = [];
    for (const phase of ['cold', 'warm']) {
      if (phase === 'cold') expect((await setAvail(m, 'categories', c, true, 10)).status).toBe(200); // no-op: stays warm
      if (phase === 'cold') expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
      if (phase === 'cold') {
        // force a generation bump (a real change), so the next 20 requests all start cold
        expect((await setAvail(m, 'categories', c, true, 12)).status).toBe(200);
      }
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => api('GET', i % 2 ? `/categories?market=${m}` : `/service-types?market=${m}`)));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      results.push(rs.map((r) => JSON.stringify(r.body.data)));
      const evens = new Set(results[results.length - 1]!.filter((_, i) => i % 2 === 0));
      const odds = new Set(results[results.length - 1]!.filter((_, i) => i % 2 === 1));
      expect(evens.size, phase).toBe(1);
      expect(odds.size, phase).toBe(1);
    }
    expect(results[0]![1]).toBe(results[1]![1]);
    expect(JSON.parse(results[1]![1]!)[0]).toMatchObject({ code: c, displayOrder: 12, name: 'Parallel', description: 'Same for everybody' });
    // parallel reads while a change commits: every response is a complete, valid snapshot (before or after), never a mixture
    const reads = Promise.all(Array.from({ length: 20 }, () => api('GET', `/service-types?market=${m}`)));
    const change = setAvail(m, 'categories', c, false);
    const [rs] = await Promise.all([reads, change]);
    for (const r of rs) {
      expect(r.status).toBe(200);
      expect([0, 1]).toContain(r.body.data.length);
    }
  });

  it('QUERY BUDGET of GET /categories?market on a warm cache versus a cold one (the numbers are pinned)', async () => {
    const m = await market('budget', 'ACTIVE');
    const c1 = await liveCategory('bud1', m, 10, { en: 'Budget one', desc: 'D1' });
    const c2 = await liveCategory('bud2', m, 20, { en: 'Budget two', desc: 'D2' });
    // classify every statement: the catalogue's own (the snapshot transaction and its 2 selects), the content registry's, and the market gate (geography)
    const classify = (list: string[]) => {
      const t = list.map((x) => x.replace(/\s+/g, ' ').trim());
      const catalogOwned = t.filter((x) => /catalog\./.test(x) || /^(start transaction|commit)/i.test(x));
      const contentOwned = t.filter((x) => /content\./.test(x) && !/catalog\./.test(x) && !/geography\.markets m/.test(x));
      const gate = t.filter((x) => /geography\.markets/.test(x) && !/catalog\./.test(x));
      return {
        all: t.length,
        catalog: catalogOwned.length,
        content: contentOwned.length,
        gate: gate.length,
        other: t.length - catalogOwned.length - contentOwned.length - gate.length,
      };
    };
    const measure = async (url: string, t?: string) => {
      queries = [];
      counting = true;
      const r = await api('GET', url, t);
      counting = false;
      expect(r.status, r.raw).toBe(200);
      return classify(queries);
    };
    await measure(`/categories?market=${m}`); // prime: the market defaults memo of the content registry and the catalogue cache
    expect((await setAvail(m, 'categories', c2, true, 21)).status).toBe(200); // a real change bumps the generation: the next read is COLD
    const cold = await measure(`/categories?market=${m}`);
    const warm1 = await measure(`/categories?market=${m}`);
    const warm2 = await measure(`/categories?market=${m}`);
    console.info('QUERY-BUDGET', JSON.stringify({ cold, warm1, warm2 }));
    // PINNED: warm = 1 gate read (geography has no cache in this test) + 3 content queries (the batch resolve) + 0 catalogue queries
    expect(warm1).toEqual({ all: 4, catalog: 0, content: 3, gate: 1, other: 0 });
    expect(warm2).toEqual(warm1);
    // PINNED: cold adds exactly the snapshot read: start transaction (repeatable read, read only), 2 selects, commit
    expect(cold).toEqual({ all: 8, catalog: 4, content: 3, gate: 1, other: 0 });
    // more rows do not grow the budget: one snapshot read, one batched text resolve
    for (let i = 0; i < 5; i++) await liveServiceType(`budst${i}`, c1, m, 100 + i);
    const coldMany = await measure(`/service-types?market=${m}`);
    const warmMany = await measure(`/service-types?market=${m}`);
    console.info('QUERY-BUDGET-MANY', JSON.stringify({ coldMany, warmMany }));
    expect(coldMany).toEqual({ all: 8, catalog: 4, content: 3, gate: 1, other: 0 });
    expect(warmMany).toEqual({ all: 4, catalog: 0, content: 3, gate: 1, other: 0 });
    // the management view never uses the cache: every call reads the database (no snapshot transaction, one read per call plus the content batch)
    const mgmt1 = await measure(`/categories?market=${m}`, reader);
    const mgmt2 = await measure(`/categories?market=${m}`, reader);
    console.info('QUERY-BUDGET-MGMT', JSON.stringify({ mgmt1, mgmt2 }));
    expect(mgmt2).toEqual(mgmt1);
    // PINNED: the market lookup of the management read (1), the default locale of that market (1), the list (1) and the batched text resolve (3)
    expect(mgmt1).toEqual({ all: 6, catalog: 1, content: 3, gate: 2, other: 0 });
    // without a market: the list (1), the platform locale list (1) and the text resolve (3)
    const mgmtGlobal = await measure('/categories', reader);
    console.info('QUERY-BUDGET-MGMT-GLOBAL', JSON.stringify(mgmtGlobal));
    expect(mgmtGlobal).toEqual({ all: 5, catalog: 1, content: 4, gate: 0, other: 0 });
  });

  it('an unavailable database is a generic 503 for every route kind: no host, port, driver or SQL text; the public gate keeps answering 404 for unknown markets', async () => {
    const broken = createDatabase('postgres://nobody:nothing@127.0.0.1:1/none', { role: 'tests', onPoolError: () => undefined });
    const down = new CatalogService({ database: broken, markets: createMarketGate(geography), env: 'test', allowTestKeys: true });
    const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const downApp = await buildApp({ cfg, verifier, configuration: {} as never, content, geography, catalog: down, readiness: async () => ({}) });
    await downApp.ready();
    const m = await market('down', 'ACTIVE');
    try {
      const call = async (method: 'GET' | 'POST' | 'PUT', url: string, t?: string, payload?: unknown) => {
        const r = await downApp.inject({
          method,
          url: `/api/v1/catalog${url}`,
          headers: t ? { authorization: `Bearer ${t}` } : {},
          ...(payload ? { payload: payload as object } : {}),
        });
        return { status: r.statusCode, raw: r.body, json: r.json() };
      };
      const results = [
        await call('GET', `/categories?market=${m}`),
        await call('GET', `/service-types/anything_x?market=${m}`),
        await call('GET', '/categories', reader),
        await call('GET', '/prohibited-services', reader),
        await call('PUT', `/categories/auto_services/status`, staff, { status: 'ACTIVE', reason: REASON }),
        await call('POST', '/prohibited-services', staff, { code: 'devtest_down1', reason: REASON }),
        await call('PUT', `/markets/${m}/categories/auto_services`, staff, { enabled: true, displayOrder: 1, reason: REASON }),
      ];
      for (const r of results) {
        expect(r.status, r.raw).toBe(503);
        expect(r.json.error).toMatchObject({ category: 'DEPENDENCY', code: 'CATALOG_UNAVAILABLE', message: 'The catalogue is temporarily unavailable' });
        expect(r.raw).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|nobody|SELECT|catalog\.|postgres|connect/i);
      }
      expect((await call('GET', '/categories?market=devtest-cat-never')).status).toBe(404);
    } finally {
      await downApp.close();
      await broken.close().catch(() => undefined);
    }
  });
});

// ====================================================================== scope references (DEBT-0024)
describe('the CATEGORY configuration scope reference (composed with geography as index.ts does)', () => {
  it('accepts DRAFT / ACTIVE / INACTIVE categories, refuses RETIRED, unknown and non-canonical references with ONE generic reason, and leaves the other scopes to their owners', async () => {
    const validator = composeScopeReferenceValidators([createGeographyScopeReferenceValidator(geography), createCatalogScopeReferenceValidator(catalog)]);
    const c = (await category('scope', { en: 'Scoped' })).code;
    expect(await validator.validate('CATEGORY', c)).toEqual({ valid: true }); // DRAFT
    expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
    expect(await validator.validate('CATEGORY', c)).toEqual({ valid: true });
    expect((await setStatus('categories', c, 'INACTIVE')).status).toBe(200);
    expect(await validator.validate('CATEGORY', c)).toEqual({ valid: true });
    expect(await validator.validate('CATEGORY', 'auto_services')).toEqual({ valid: true }); // seeded
    expect((await setStatus('categories', c, 'RETIRED')).status).toBe(200);
    const refusals = [
      await validator.validate('CATEGORY', c),
      await validator.validate('CATEGORY', 'no_such_category'),
      await validator.validate('CATEGORY', 'Auto_Services'),
      await validator.validate('CATEGORY', ''),
      await validator.validate('CATEGORY', null),
      await validator.validate('CATEGORY', undefined),
      await validator.validate('CATEGORY', `${c}\n`),
      await validator.validate('CATEGORY', 'a'.repeat(49)),
    ];
    for (const r of refusals) expect(r).toEqual({ valid: false, reason: 'the scope reference is not valid' });
    expect(await validator.validate('PLATFORM', null)).toEqual({ valid: true });
    expect(await validator.validate('GIG', 'whatever')).toEqual({ valid: true });
    expect((await validator.validate('MARKET', 'nowhere')).valid).toBe(false); // geography still owns MARKET
    expect((await validator.validate('MARKET', 'la-oc')).valid).toBe(true);
    expect((await validator.validate('COUNTRY', 'US')).valid).toBe(true);
  });
});

// ====================================================================== text resolution: sensitivity, market context, locale chain
describe('text resolution through the content registry (real)', () => {
  it('an INTERNAL name is never shown publicly (includeInternal false) but is shown to administrators', async () => {
    const m = await market('internal', 'ACTIVE');
    const c = code('intl');
    await content.createEntry(entryReq(categoryNameKey(c), { sensitivity: 'INTERNAL' }), A);
    await publishText(categoryNameKey(c), 'en-US', 'Staff only name');
    expect((await api('POST', '/categories', staff, { code: c, reason: REASON })).status).toBe(201);
    expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m, 'categories', c, true, 10)).status).toBe(200);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
    expect((await api('GET', `/categories/${c}?market=${m}`)).raw).not.toContain('Staff only name');
    expect((await api('GET', `/categories/${c}?market=${m}`)).status).toBe(404);
    expect((await api('GET', `/categories/${c}?market=${m}`, reader)).body.data.name).toBe('Staff only name');
    // an INTERNAL DESCRIPTION leaves the item visible with a null description
    const d = await category('intld', { en: 'Visible name' });
    await content.createEntry(entryReq(categoryDescriptionKey(d.code), { contentType: 'PLAIN_TEXT', sensitivity: 'INTERNAL' }), A);
    await publishText(categoryDescriptionKey(d.code), 'en-US', 'Secret description');
    expect((await api('PATCH', `/categories/${d.code}`, staff, { withDescription: true, reason: REASON })).status).toBe(200);
    expect((await setStatus('categories', d.code, 'ACTIVE')).status).toBe(200);
    expect((await setAvail(m, 'categories', d.code, true, 20)).status).toBe(200);
    const pub = await api('GET', `/categories/${d.code}?market=${m}`);
    expect(pub.body.data).toMatchObject({ name: 'Visible name', description: null });
    expect(pub.raw).not.toContain('Secret description');
    expect((await api('GET', `/categories/${d.code}`, reader)).body.data.description).toBe('Secret description');
  });

  it('the MARKET goes into the content context: a market-scoped version of the name overrides the platform text in that market only', async () => {
    const m1 = await market('ctx-a', 'ACTIVE');
    const m2 = await market('ctx-b', 'ACTIVE');
    const c = await liveCategory('ctx', m1, 10, { en: 'Platform name' });
    expect((await setAvail(m2, 'categories', c, true, 10)).status).toBe(200);
    const v = await content.createVersion(
      categoryNameKey(c),
      { locale: 'en-US', scopeType: 'MARKET', scopeRef: m1, body: 'Local name in market A', reason: REASON },
      A,
    );
    const submitted = await content.submit(v.versionId, A);
    if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, B);
    await content.publish(v.versionId, A);
    expect((await api('GET', `/categories/${c}?market=${m1}`)).body.data.name).toBe('Local name in market A');
    expect((await api('GET', `/categories/${c}?market=${m2}`)).body.data.name).toBe('Platform name');
    expect((await api('GET', `/categories?market=${m1}`)).body.data[0].name).toBe('Local name in market A');
    // the management view with the market also resolves in its context; without a market it shows the platform text
    expect((await api('GET', `/categories/${c}?market=${m1}`, reader)).body.data.name).toBe('Local name in market A');
    expect((await api('GET', `/categories/${c}`, reader)).body.data.name).toBe('Platform name');
  });

  it('an unregistered, inactive or language-only locale falls back along the content chain (200), never an error', async () => {
    const m = await market('fallback', 'ACTIVE');
    const c = await liveCategory('fb', m, 10, { en: 'English fallback', es: 'Espanol' });
    for (const locale of ['fr-FR', 'zh-Hant-TW', 'qaa', 'de', 'es', 'es-419']) {
      const r = await api('GET', `/categories/${c}?market=${m}&locale=${locale}`);
      expect(r.status, locale).toBe(200);
      expect(['English fallback', 'Espanol'], locale).toContain(r.body.data.name);
    }
    expect((await api('GET', `/categories/${c}?market=${m}&locale=es-US`)).body.data.name).toBe('Espanol');
    expect((await api('GET', `/categories/${c}?market=${m}&locale=fr-FR`)).body.data.name).toBe('English fallback');
  });

  it('creating with withDescription needs the description entry to exist (typed 400, nothing written)', async () => {
    const c = code('nodesc');
    await names(categoryNameKey(c), { en: 'No description yet' });
    const r = await api('POST', '/categories', staff, { code: c, withDescription: true, reason: REASON });
    expect([r.status, r.body.error.code, r.body.error.details]).toEqual([400, 'CATALOG_VALIDATION_FAILED', { reason: 'DESCRIPTION_CONTENT_MISSING' }]);
    expect((await q('SELECT 1 FROM catalog.categories WHERE code = $1', [c])).length).toBe(0);
    const sc = code('nodescst');
    await names(serviceTypeNameKey(sc), { en: 'Service' });
    const s = await api('POST', '/service-types', staff, { code: sc, categoryCode: 'auto_services', withDescription: true, reason: REASON });
    expect([s.status, s.body.error.details]).toEqual([400, { reason: 'DESCRIPTION_CONTENT_MISSING' }]);
    const p = code('nodescp');
    await names(prohibitedServiceNameKey(p), { en: 'Prohibited' });
    const pr = await api('POST', '/prohibited-services', staff, { code: p, withDescription: true, reason: REASON });
    expect([pr.status, pr.body.error.details]).toEqual([400, { reason: 'DESCRIPTION_CONTENT_MISSING' }]);
  });

  it('the management view of a market lists rows without availability too (enabled absent, order null, listed last) and the market rows in order', async () => {
    const m = await market('mgmtview', 'PLANNED');
    const a = await liveCategory('mva', m, 20, { en: 'A' });
    const b = await liveCategory('mvb', m, 10, { en: 'B' });
    const off = (await category('mvc', { en: 'C' })).code;
    expect((await setAvail(m, 'categories', off, false, 30)).status).toBe(200);
    const none = (await category('mvd', { en: 'D' })).code;
    const list = (await api('GET', `/categories?market=${m}`, reader)).body.data as Json[];
    const mine = list.filter((x) => [a, b, off, none].includes(x.code));
    expect(mine.map((x) => x.code)).toEqual([b, a, off, none]);
    expect(mine.map((x) => x.displayOrder)).toEqual([10, 20, 30, null]);
    expect(mine.map((x) => x.enabled)).toEqual([true, true, false, undefined]);
    expect(Object.keys(mine[3]!)).not.toContain('enabled');
    // the seeded rows without availability come after all rows with an order
    const lastWithOrder = list.map((x) => x.displayOrder !== null).lastIndexOf(true);
    const firstWithout = list.findIndex((x) => x.displayOrder === null);
    expect(lastWithOrder).toBeLessThan(firstWithout);
  });
});

describe('the management preview and a content outage (real)', () => {
  it("a management view WITH a market shows the text in that market's default locale (any market status), an explicit locale wins, without a market it is the platform default", async () => {
    const planned = await market('preview', 'PLANNED', 'es-US');
    const c = await liveCategory('prev', planned, 10, { en: 'English name', es: 'Nombre en espanol', desc: 'English about', descEs: 'Sobre en espanol' });
    const st = await liveServiceType('prevst', c, planned, 10, { en: 'English service', es: 'Servicio en espanol' });
    const get = async (u: string, t = reader) => (await api('GET', u, t)).body.data;
    const pick = (l: Json[], code: string) => l.find((x) => x.code === code);
    expect(pick(await get(`/categories?market=${planned}`), c)).toMatchObject({ name: 'Nombre en espanol', description: 'Sobre en espanol' });
    expect(await get(`/categories/${c}?market=${planned}`)).toMatchObject({ name: 'Nombre en espanol', description: 'Sobre en espanol' });
    expect(pick(await get(`/service-types?market=${planned}`), st)).toMatchObject({ name: 'Servicio en espanol' });
    expect(await get(`/service-types/${st}?market=${planned}`)).toMatchObject({ name: 'Servicio en espanol' });
    // writer-only tokens get the same management view
    expect(await get(`/categories/${c}?market=${planned}`, writer)).toMatchObject({ name: 'Nombre en espanol' });
    // an explicit locale wins, in both directions
    expect(await get(`/categories/${c}?market=${planned}&locale=en-US`)).toMatchObject({ name: 'English name' });
    expect(pick(await get(`/service-types?market=${planned}&locale=en-US`), st)).toMatchObject({ name: 'English service' });
    // no market: the platform default (en-US)
    expect(await get(`/categories/${c}`)).toMatchObject({ name: 'English name' });
    expect(pick(await get('/service-types'), st)).toMatchObject({ name: 'English service' });
    // an en-US market previews in English
    const en = await market('preview-en', 'PLANNED');
    expect((await api('GET', `/categories?market=${en}`, reader)).status).toBe(200);
    // the public view of an ACTIVE market uses the same rule (parity once the market goes live)
    await geography.setMarketActive(planned, true, 'launch', A);
    expect((await api('GET', `/categories/${c}?market=${planned}`)).body.data.name).toBe('Nombre en espanol');
    // an unknown market is a typed 404 for the locale lookup too
    expect((await api('GET', '/categories/auto_services?market=devtest-cat-never', reader)).body.error.code).toBe('CATALOG_MARKET_NOT_FOUND');
  });

  it('when the content registry cannot answer: every PUBLIC read is a generic 503, the MANAGEMENT view degrades to content keys (200)', async () => {
    const m = await market('outage', 'ACTIVE');
    const c = await liveCategory('out', m, 10, { en: 'Outage name' });
    const st = await liveServiceType('outst', c, m, 10);
    const flaky = {
      resolveRendered: async () => {
        throw new Error('connect ECONNREFUSED 10.9.9.9:5432 password=hunter2');
      },
      listLocales: (o: { activeOnly?: boolean }) => content.listLocales(o),
    } as unknown as ContentService;
    const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const flakyApp = await buildApp({ cfg, verifier, configuration: {} as never, content: flaky, geography, catalog, readiness: async () => ({}) });
    await flakyApp.ready();
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    try {
      const get = async (u: string, t?: string) => {
        const r = await flakyApp.inject({ method: 'GET', url: `/api/v1/catalog${u}`, headers: t ? { authorization: `Bearer ${t}` } : {} });
        return { status: r.statusCode, raw: r.body, json: r.json() };
      };
      for (const u of [`/categories?market=${m}`, `/categories/${c}?market=${m}`, `/service-types?market=${m}`, `/service-types/${st}?market=${m}`]) {
        for (const t of [undefined, customer, norole]) {
          const r = await get(u, t);
          expect(r.status, u).toBe(503);
          expect(r.json.error).toMatchObject({ category: 'DEPENDENCY', code: 'CATALOG_UNAVAILABLE', message: 'The catalogue is temporarily unavailable' });
          expect(r.raw).not.toMatch(/ECONNREFUSED|hunter2|10\.9\.9\.9|content/i);
        }
      }
      for (const u of ['/categories', `/categories/${c}`, '/service-types', `/service-types/${st}`, `/categories?market=${m}`, '/prohibited-services']) {
        const r = await get(u, reader);
        expect(r.status, u).toBe(200);
        expect(r.raw).not.toMatch(/hunter2|ECONNREFUSED/);
      }
      expect((await get(`/categories/${c}`, reader)).json.data.name).toBe(categoryNameKey(c));
    } finally {
      spy.mockRestore();
      await flakyApp.close();
    }
    expect(logged.join('\n')).toContain('catalogue text could not be resolved');
    expect(logged.join('\n')).not.toMatch(/hunter2|10\.9\.9\.9/);
    // the real registry answers again: nothing was cached from the failure
    expect((await api('GET', `/categories/${c}?market=${m}`)).body.data.name).toBe('Outage name');
  });
});

// ====================================================================== races
describe('concurrency (real PostgreSQL, parallel HTTP requests)', () => {
  it('10 parallel creations of the same code: exactly one 201, nine typed 409 CODE_TAKEN, ONE audit row', async () => {
    const c = code('race');
    await names(categoryNameKey(c), { en: 'Race' });
    const results = await Promise.all(Array.from({ length: 10 }, () => api('POST', '/categories', staff, { code: c, reason: REASON })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201))
      expect([r.status, r.body.error.code, r.body.error.details]).toEqual([409, 'CATALOG_CONFLICT', { reason: 'CODE_TAKEN' }]);
    expect(await q('SELECT 1 FROM catalog.audit_events a JOIN catalog.categories c USING (category_id) WHERE c.code = $1', [c])).toHaveLength(1);
  });

  it('8 categories racing for ONE display order of a market: exactly one wins, the others are typed 409 DISPLAY_ORDER_TAKEN, nothing else changes', async () => {
    const m = await market('race-order', 'ACTIVE');
    const cs: string[] = [];
    for (let i = 0; i < 8; i++) cs.push((await category(`rord${i}`, { en: `Racer ${i}` })).code);
    const results = await Promise.all(cs.map((c) => setAvail(m, 'categories', c, true, 5)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect([r.status, r.body.error.details]).toEqual([409, { reason: 'DISPLAY_ORDER_TAKEN' }]);
    expect(await q('SELECT 1 FROM catalog.market_categories mc JOIN geography.markets mk USING (market_id) WHERE mk.code = $1', [m])).toHaveLength(1);
    expect(
      await q(
        "SELECT 1 FROM catalog.audit_events a JOIN geography.markets mk USING (market_id) WHERE mk.code = $1 AND a.action = 'MARKET_CATALOG_AVAILABILITY_CHANGED'",
        [m],
      ),
    ).toHaveLength(1);
  });

  it('retiring a category while a service type is created under it: never a RETIRED category with an open service type (repeated)', async () => {
    for (let i = 0; i < 8; i++) {
      const c = (await category(`rcr${i}`, { en: 'Race retire' })).code;
      const sc = code(`rcs${i}`);
      await names(serviceTypeNameKey(sc), { en: 'Race child' });
      const [retire, create] = await Promise.all([
        setStatus('categories', c, 'RETIRED'),
        api('POST', '/service-types', staff, { code: sc, categoryCode: c, reason: REASON }),
      ]);
      expect(
        [retire.status, create.status].every((s) => [200, 201, 409].includes(s)),
        `${retire.raw} ${create.raw}`,
      ).toBe(true);
      expect(retire.status === 200 && create.status === 201, `both succeeded in round ${i}`).toBe(false);
      if (retire.status === 409) expect(retire.body.error.details.reason).toBe('CATEGORY_HAS_OPEN_SERVICE_TYPES');
      if (create.status === 409) expect(create.body.error.details.reason).toBe('CATEGORY_RETIRED');
      const bad = await q(
        "SELECT 1 FROM catalog.categories c JOIN catalog.service_types s USING (category_id) WHERE c.code = $1 AND c.status = 'RETIRED' AND s.status <> 'RETIRED'",
        [c],
      );
      expect(bad).toHaveLength(0);
    }
  });

  it('enabling a service type while its category is switched off in the market: never an enabled service type under a disabled category (repeated)', async () => {
    const m = await market('race-avail', 'ACTIVE');
    for (let i = 0; i < 8; i++) {
      const c = await liveCategory(`rac${i}`, m, 100 + i);
      const st = (await serviceType(`ras${i}`, c)).code;
      expect((await setStatus('service-types', st, 'ACTIVE')).status).toBe(200);
      const [enable, disable] = await Promise.all([setAvail(m, 'service-types', st, true, 200 + i), setAvail(m, 'categories', c, false)]);
      for (const r of [enable, disable]) expect([200, 409], `${r.raw}`).toContain(r.status);
      if (enable.status === 409) expect(enable.body.error.details.reason).toBe('CATEGORY_NOT_ENABLED_IN_MARKET');
      const bad = await q(
        `SELECT 1 FROM catalog.market_service_types mst JOIN catalog.service_types s USING (service_type_id)
           JOIN catalog.market_categories mc ON mc.market_id = mst.market_id AND mc.category_id = s.category_id WHERE mst.enabled AND NOT mc.enabled`,
      );
      expect(bad, `round ${i}`).toHaveLength(0);
    }
  });

  it('activating a service type while its category is paused: never an ACTIVE service type under a non-ACTIVE category (repeated)', async () => {
    for (let i = 0; i < 8; i++) {
      const c = (await category(`rsc${i}`, { en: 'Race status' })).code;
      expect((await setStatus('categories', c, 'ACTIVE')).status).toBe(200);
      const st = (await serviceType(`rss${i}`, c)).code;
      const [activate, pause] = await Promise.all([setStatus('service-types', st, 'ACTIVE'), setStatus('categories', c, 'INACTIVE')]);
      for (const r of [activate, pause]) expect([200, 409], `${r.raw}`).toContain(r.status);
      const bad = await q(
        "SELECT 1 FROM catalog.service_types s JOIN catalog.categories c USING (category_id) WHERE s.status = 'ACTIVE' AND c.status <> 'ACTIVE' AND c.code = $1",
        [c],
      );
      expect(bad, `round ${i}`).toHaveLength(0);
    }
  });

  /** Two identical first-time availability requests at once (a double click), for a category or a service type: what each response said and what was written. */
  const doubleSubmit = async (m: string, kind: 'categories' | 'service-types', rounds: number) => {
    const out: { statuses: number[]; bodies: Json[]; rows: number; audit: number; events: number; bumps: number }[] = [];
    for (let i = 0; i < rounds; i++) {
      seq += 1;
      const parent = await liveCategory(`dbl${seq}`, m, 300 + seq);
      let target = parent;
      if (kind === 'service-types') {
        target = (await serviceType(`dblst${seq}`, parent)).code;
        expect((await setStatus('service-types', target, 'ACTIVE')).status).toBe(200);
      } else {
        target = (await category(`dblc${seq}`, { en: 'Double click' })).code;
        expect((await setStatus('categories', target, 'ACTIVE')).status).toBe(200);
      }
      const gen = () => Number(cache.data.get('bg:test:cat:gen') ?? 0);
      const g0 = gen();
      const same = await Promise.all([setAvail(m, kind, target, true, 400 + seq), setAvail(m, kind, target, true, 400 + seq)]);
      const table = kind === 'categories' ? 'market_categories' : 'market_service_types';
      const idCol = kind === 'categories' ? 'category_id' : 'service_type_id';
      const subject = kind === 'categories' ? 'categories' : 'service_types';
      const rows = await q(`SELECT 1 FROM catalog.${table} x JOIN catalog.${subject} s USING (${idCol}) WHERE s.code = $1`, [target]);
      const audit = await q(
        `SELECT 1 FROM catalog.audit_events a JOIN catalog.${subject} s ON s.${idCol} = a.${idCol} WHERE s.code = $1 AND a.action = 'MARKET_CATALOG_AVAILABILITY_CHANGED'`,
        [target],
      );
      const events = await q("SELECT 1 FROM integration.outbox_events WHERE event_type = $1 AND payload_json->>'code' = $2", [
        CATALOG_EVENTS.availabilityChanged,
        target,
      ]);
      out.push({
        statuses: same.map((r) => r.status),
        bodies: same.map((r) => r.body),
        rows: rows.length,
        audit: audit.length,
        events: events.length,
        bumps: gen() - g0,
      });
    }
    return out;
  };

  it.each(['categories', 'service-types'] as const)(
    'a double submission of the SAME first availability request of a %s row converges: both 200 with the same result, ONE row, ONE audit row, ONE event, ONE generation bump (repeated)',
    async (kind) => {
      const m = await market(`race-double-${kind}`, 'ACTIVE');
      for (const [i, round] of (await doubleSubmit(m, kind, 10)).entries()) {
        expect(round.statuses, `round ${i}: ${JSON.stringify(round.bodies)}`).toEqual([200, 200]);
        expect(round.bodies[0].data, `round ${i}`).toEqual(round.bodies[1].data);
        expect(round.bodies[0].data).toMatchObject({ enabled: true, alsoDisabled: [], kind: kind === 'categories' ? 'CATEGORY' : 'SERVICE_TYPE' });
        expect([round.rows, round.audit, round.events, round.bumps], `round ${i}`).toEqual([1, 1, 1, 1]);
      }
    },
  );

  it('parallel identical status changes are idempotent: ONE audit row and ONE event', async () => {
    const c = (await category('idem', { en: 'Idempotent' })).code;
    const h = cids('idem');
    const results = await Promise.all(Array.from({ length: 10 }, () => setStatus('categories', c, 'ACTIVE', h)));
    expect(results.every((r) => r.status === 200 && r.body.data.status === 'ACTIVE')).toBe(true);
    expect(await auditOf(cidOf(h))).toHaveLength(1);
    expect(await outboxOf(cidOf(h))).toHaveLength(1);
  });
});

// ====================================================================== cache behaviour
describe('the read cache (generation counter; a malformed entry is a miss; an outage degrades to the database)', () => {
  it('serves from the cache when warm, ignores a malformed entry and a non-JSON entry, and survives a cache outage', async () => {
    const m = await market('cachey', 'ACTIVE');
    const c = await liveCategory('cch', m, 10, { en: 'Cached' });
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]); // warms the entry
    const keyOf = () => [...cache.data.keys()].find((k) => k.startsWith(`bg:test:cat:v1:market:${m}:`))!;
    const key = keyOf();
    expect(key).toBeTruthy();
    // a poisoned entry that is not a valid snapshot is treated as a miss and replaced
    for (const poison of [
      'not json',
      '{"v":{"categories":"x","serviceTypes":[]}}',
      '{"v":null}',
      '{}',
      '{"v":{"categories":[{"code":5}],"serviceTypes":[]}}',
      '[]',
    ]) {
      cache.data.set(key, poison);
      const r = await api('GET', `/categories?market=${m}`);
      expect(r.status, poison).toBe(200);
      expect(codes(r), poison).toEqual([c]);
      expect(JSON.parse(cache.data.get(key)!).v.categories).toHaveLength(1);
    }
    // the cache is down: the database answers; a change made meanwhile is visible at once
    cache.fail = true;
    try {
      expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]);
      expect((await setAvail(m, 'categories', c, false)).status).toBe(200); // the bump is lost: the database still answers truthfully
      expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([]);
    } finally {
      cache.fail = false;
    }
    // the generation moves on at the next effective change, which orphans anything stale
    expect((await setAvail(m, 'categories', c, true)).status).toBe(200);
    expect(codes(await api('GET', `/categories?market=${m}`))).toEqual([c]);
  });
});

// ====================================================================== CATEGORY scope in the configuration registry
describe('the CATEGORY scope of the configuration registry validates its reference against the catalogue', () => {
  it('a change request for scope CATEGORY accepts DRAFT/ACTIVE/INACTIVE categories and refuses RETIRED, unknown and non-canonical references at draft and again at publish', async () => {
    const scopeReferences = composeScopeReferenceValidators([createGeographyScopeReferenceValidator(geography), createCatalogScopeReferenceValidator(catalog)]);
    const configuration = new ConfigurationService({ database: iso.database, env: 'test', allowTestKeys: true, scopeReferences });
    const key = 'devtest.catalog.scoped';
    await configuration.createParameter(
      {
        key,
        dataType: 'INTEGER',
        description: 'neutral test parameter',
        ownerRole: 'platform',
        approvalPolicy: 'NONE',
        allowedOverrideScopes: ['CATEGORY', 'MARKET'],
      },
      A,
    );
    const draft = async (scopeRef: string | null, scopeType: 'CATEGORY' | 'MARKET' = 'CATEGORY') =>
      configuration.createChangeRequest({ parameterKey: key, scopeType, scopeRef, value: 5, reason: REASON }, A);
    const c = (await category('cfg', { en: 'Configured' })).code;
    expect((await draft(c)).changeRequestId).toBeTruthy(); // DRAFT category
    expect((await draft('auto_services')).changeRequestId).toBeTruthy();
    const rejected = async (ref: string | null) => {
      const e = (await draft(ref).catch((err: unknown) => err)) as { code?: string; details?: Record<string, unknown> };
      return [e.code, e.details?.reason];
    };
    for (const bad of ['no_such_category', 'Auto_Services', 'auto-services', ''])
      expect(await rejected(bad), String(bad)).toEqual(['VALIDATION_FAILED', 'SCOPE_REFERENCE_INVALID']);
    expect((await rejected(null))[0]).toBe('VALIDATION_FAILED'); // a CATEGORY scope needs a reference at all
    // re-validated at publish: retire the category between draft and publish
    const cr = await draft(c);
    await configuration.submit(cr.changeRequestId, A);
    expect((await setStatus('categories', c, 'RETIRED')).status).toBe(200);
    const err = (await configuration.publish(cr.changeRequestId, A).catch((e: unknown) => e)) as { code?: string; details?: Record<string, unknown> };
    expect([err.code, err.details?.reason]).toEqual(['VALIDATION_FAILED', 'SCOPE_REFERENCE_INVALID']);
    expect(await rejected(c)).toEqual(['VALIDATION_FAILED', 'SCOPE_REFERENCE_INVALID']);
    // MARKET is still geography's
    expect((await draft('nowhere', 'MARKET').catch((e: unknown) => e)) as unknown).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
