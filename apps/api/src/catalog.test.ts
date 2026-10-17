// Unit tests of the catalogue API module (CAT-001) with a FAKE CatalogService and a FAKE ContentService, written by an independent author. The real rules are covered by
// packages/catalog and catalog.itest.ts; here: authentication and authorization on all 16 operations, strict bodies/queries/params, the public view (market required, exact
// key sets, one content batch, unnamed items omitted), the management view, error mapping, the OpenAPI inventory, and the composition helpers of wiring.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  CATALOG_ERROR_CODES,
  ErrorResponse,
  categoryDescriptionKey,
  categoryNameKey,
  serviceTypeDescriptionKey,
  serviceTypeNameKey,
  prohibitedServiceNameKey,
  type CatalogErrorCode,
} from '@bananagig/contracts';
import { CatalogError, type CatalogService, type CategoryView, type ProhibitedServiceView, type ServiceTypeView } from '@bananagig/catalog';
import type { ContentService } from '@bananagig/content';
import { GeographyError } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, MAX_PATH_PARAM_LENGTH } from './app';
import { composeScopeReferenceValidators, createMarketGate } from './modules/catalog/wiring';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let app: FastifyInstance;

// ---------------------------------------------------------------- fakes
const catalog = {
  listCategories: vi.fn(),
  getCategory: vi.fn(),
  listServiceTypes: vi.fn(),
  getServiceType: vi.fn(),
  listProhibitedServices: vi.fn(),
  getMarketDefaultLocale: vi.fn(),
  getProhibitedService: vi.fn(),
  listCategoriesForMarket: vi.fn(),
  getCategoryForMarket: vi.fn(),
  listServiceTypesForMarket: vi.fn(),
  getServiceTypeForMarket: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  setCategoryStatus: vi.fn(),
  createServiceType: vi.fn(),
  updateServiceType: vi.fn(),
  setServiceTypeStatus: vi.fn(),
  createProhibitedService: vi.fn(),
  setProhibitedServiceStatus: vi.fn(),
  setMarketCategoryAvailability: vi.fn(),
  setMarketServiceTypeAvailability: vi.fn(),
};
const content = { resolveRendered: vi.fn(), listLocales: vi.fn() };
const noServiceCalled = () => Object.values(catalog).every((f) => f.mock.calls.length === 0);
const noContentCalled = () => Object.values(content).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- tokens and requests
const READ = 'catalog-read';
const WRITE = 'catalog-write';
const adminToken = (roles: string[], over: Record<string, unknown> = {}) =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: [] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } },
      ...over,
    },
  });
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const call = async (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url: `/api/v1/catalog${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const keysOf = (o: object) => Object.keys(o).sort();
const names = (r: { json: () => { data: { code: string }[] } }) => r.json().data.map((x) => x.code);

// ---------------------------------------------------------------- fixtures: the management shape; the fakes strip it for the public view like the real service
const T0 = '2026-01-01T00:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cat = (code: string, status: CategoryView['status'], n: number, over: Partial<CategoryView> = {}): CategoryView => ({
  categoryId: id(n),
  code,
  nameContentKey: categoryNameKey(code),
  descriptionContentKey: categoryDescriptionKey(code),
  iconKey: null,
  displayOrder: null,
  status,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const st = (code: string, categoryCode: string, status: ServiceTypeView['status'], n: number, over: Partial<ServiceTypeView> = {}): ServiceTypeView => ({
  serviceTypeId: id(n),
  code,
  categoryCode,
  nameContentKey: serviceTypeNameKey(code),
  descriptionContentKey: serviceTypeDescriptionKey(code),
  displayOrder: null,
  status,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const CATEGORIES = [
  cat('auto_services', 'ACTIVE', 1, { iconKey: 'car' }),
  cat('draft_cat', 'DRAFT', 2),
  cat('home_cleaning', 'ACTIVE', 3),
  cat('old_cat', 'RETIRED', 4),
  cat('unnamed_cat', 'ACTIVE', 5),
];
const SERVICE_TYPES = [
  st('car_detailing', 'auto_services', 'ACTIVE', 11),
  st('draft_st', 'auto_services', 'DRAFT', 12),
  st('mobile_car_wash', 'auto_services', 'ACTIVE', 13, { descriptionContentKey: serviceTypeDescriptionKey('mobile_car_wash') }),
  st('regular_cleaning', 'home_cleaning', 'ACTIVE', 14),
  st('unnamed_st', 'home_cleaning', 'ACTIVE', 15),
];
const PROHIBITED: ProhibitedServiceView[] = [
  {
    prohibitedServiceId: id(21),
    code: 'weapons',
    categoryCode: null,
    nameContentKey: prohibitedServiceNameKey('weapons'),
    descriptionContentKey: null,
    status: 'ACTIVE',
    createdAt: T0,
    updatedAt: T0,
  },
];
/** text of the content registry: every key of the fixtures except the unnamed ones; the value carries the requested locale so the locale is observable */
const TEXT: Record<string, string> = {};
for (const c of CATEGORIES.filter((x) => x.code !== 'unnamed_cat')) {
  TEXT[c.nameContentKey] = `Name of ${c.code}`;
  TEXT[c.descriptionContentKey!] = `About ${c.code}`;
}
for (const s of SERVICE_TYPES.filter((x) => x.code !== 'unnamed_st')) {
  TEXT[s.nameContentKey] = `Name of ${s.code}`;
  if (s.code !== 'mobile_car_wash') TEXT[s.descriptionContentKey!] = `About ${s.code}`;
}
TEXT[prohibitedServiceNameKey('weapons')] = 'Weapons';

const ORDER: Record<string, number> = {
  auto_services: 10,
  home_cleaning: 20,
  unnamed_cat: 30,
  car_detailing: 10,
  mobile_car_wash: 20,
  regular_cleaning: 30,
  unnamed_st: 40,
};
const PUBLIC_MARKETS: Record<string, string> = { 'us-sf': 'en-US', 'mx-cdmx': 'es-MX' };
const MGMT_MARKET_LOCALES: Record<string, string> = { 'us-sf': 'en-US', 'mx-cdmx': 'es-MX', 'la-oc': 'en-US', 'qa-lab': 'qaa' };
const MGMT_MARKETS = Object.keys(MGMT_MARKET_LOCALES);
const marketNotFound = (code: string) => new CatalogError('MARKET_NOT_FOUND', 'the market is not available', { code });
const publicMarket = (code: string) => {
  const defaultLocale = PUBLIC_MARKETS[code];
  if (!defaultLocale) throw marketNotFound(code);
  return { code, defaultLocale };
};
const publicCat = (c: CategoryView): CategoryView => {
  const { status: _s, createdAt: _c, updatedAt: _u, ...rest } = c;
  return { ...rest, displayOrder: ORDER[c.code]! };
};
const publicSt = (s: ServiceTypeView): ServiceTypeView => {
  const { status: _s, createdAt: _c, updatedAt: _u, ...rest } = s;
  return { ...rest, displayOrder: ORDER[s.code]! };
};
const PUBLIC_CATEGORIES = CATEGORIES.filter((c) => c.status === 'ACTIVE');
const PUBLIC_SERVICE_TYPES = SERVICE_TYPES.filter((s) => s.status === 'ACTIVE');

const PUBLIC_CAT_KEYS = ['categoryId', 'code', 'description', 'displayOrder', 'iconKey', 'name'];
const MGMT_CAT_KEYS = [...PUBLIC_CAT_KEYS, 'createdAt', 'descriptionContentKey', 'nameContentKey', 'status', 'updatedAt'].sort();
const MGMT_CAT_KEYS_WITH_MARKET = [...MGMT_CAT_KEYS, 'enabled'].sort();
const PUBLIC_ST_KEYS = ['categoryCode', 'code', 'description', 'displayOrder', 'name', 'serviceTypeId'];
const MGMT_ST_KEYS = [...PUBLIC_ST_KEYS, 'createdAt', 'descriptionContentKey', 'nameContentKey', 'status', 'updatedAt'].sort();
const PROHIBITED_KEYS = [
  'categoryCode',
  'code',
  'createdAt',
  'description',
  'descriptionContentKey',
  'name',
  'nameContentKey',
  'prohibitedServiceId',
  'status',
  'updatedAt',
];
const AVAILABILITY_KEYS = ['alsoDisabled', 'code', 'displayOrder', 'enabled', 'kind', 'marketCode'];
const INTERNAL_WORDS = ['actor', 'audit', 'createdBy', 'correlation_id', 'reason'];

const availability = (kind: 'CATEGORY' | 'SERVICE_TYPE', marketCode: string, code: string, enabled = true, alsoDisabled: string[] = []) => ({
  marketCode,
  code,
  kind,
  enabled,
  displayOrder: 10,
  alsoDisabled,
});

beforeAll(async () => {
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({
    cfg,
    verifier,
    configuration: {} as never,
    content: content as unknown as ContentService,
    catalog: catalog as unknown as CatalogService,
    readiness: async () => ({}),
  });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const f of [...Object.values(catalog), ...Object.values(content)]) f.mockReset();
  catalog.listCategoriesForMarket.mockImplementation(async (m: string) => ({ market: publicMarket(m), categories: PUBLIC_CATEGORIES.map(publicCat) }));
  catalog.getCategoryForMarket.mockImplementation(async (m: string, code: string) => {
    const market = publicMarket(m);
    const c = PUBLIC_CATEGORIES.find((x) => x.code === code);
    if (!c) throw new CatalogError('CATEGORY_NOT_FOUND', 'the category is not available', { code });
    return { market, category: publicCat(c) };
  });
  catalog.listServiceTypesForMarket.mockImplementation(async (m: string, o: { categoryCode?: string } = {}) => ({
    market: publicMarket(m),
    serviceTypes: PUBLIC_SERVICE_TYPES.filter((s) => !o.categoryCode || s.categoryCode === o.categoryCode).map(publicSt),
  }));
  catalog.getServiceTypeForMarket.mockImplementation(async (m: string, code: string) => {
    const market = publicMarket(m);
    const s = PUBLIC_SERVICE_TYPES.find((x) => x.code === code);
    if (!s) throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not available', { code });
    return { market, serviceType: publicSt(s) };
  });
  const mgmtMarket = (o: { marketCode?: string } = {}) => {
    if (o.marketCode !== undefined && !MGMT_MARKETS.includes(o.marketCode))
      throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: o.marketCode });
  };
  catalog.listCategories.mockImplementation(async (o: { marketCode?: string } = {}) => {
    mgmtMarket(o);
    return o.marketCode === undefined ? CATEGORIES : CATEGORIES.map((c) => ({ ...c, displayOrder: ORDER[c.code] ?? null, enabled: c.status === 'ACTIVE' }));
  });
  catalog.getCategory.mockImplementation(async (code: string, o: { marketCode?: string } = {}) => {
    mgmtMarket(o);
    const c = CATEGORIES.find((x) => x.code === code);
    if (!c) throw new CatalogError('CATEGORY_NOT_FOUND', 'the category is not registered', { code });
    return c;
  });
  catalog.listServiceTypes.mockImplementation(async (o: { marketCode?: string; categoryCode?: string } = {}) => {
    mgmtMarket(o);
    return SERVICE_TYPES.filter((s) => !o.categoryCode || s.categoryCode === o.categoryCode);
  });
  catalog.getServiceType.mockImplementation(async (code: string, o: { marketCode?: string } = {}) => {
    mgmtMarket(o);
    const s = SERVICE_TYPES.find((x) => x.code === code);
    if (!s) throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not registered', { code });
    return s;
  });
  catalog.getMarketDefaultLocale.mockImplementation(async (m: string) => {
    const l = MGMT_MARKET_LOCALES[m];
    if (!l) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: m });
    return l;
  });
  catalog.listProhibitedServices.mockResolvedValue(PROHIBITED);
  catalog.getProhibitedService.mockImplementation(async (code: string) => {
    const p = PROHIBITED.find((x) => x.code === code);
    if (!p) throw new CatalogError('PROHIBITED_SERVICE_NOT_FOUND', 'the prohibited service is not registered', { code });
    return p;
  });
  catalog.createCategory.mockResolvedValue(cat('new_cat', 'DRAFT', 31));
  catalog.updateCategory.mockResolvedValue(cat('auto_services', 'ACTIVE', 1, { iconKey: 'car' }));
  catalog.setCategoryStatus.mockResolvedValue(cat('auto_services', 'INACTIVE', 1));
  catalog.createServiceType.mockResolvedValue(st('new_st', 'auto_services', 'DRAFT', 32));
  catalog.updateServiceType.mockResolvedValue(st('car_detailing', 'auto_services', 'ACTIVE', 11));
  catalog.setServiceTypeStatus.mockResolvedValue(st('car_detailing', 'auto_services', 'INACTIVE', 11));
  catalog.createProhibitedService.mockResolvedValue(PROHIBITED[0]);
  catalog.setProhibitedServiceStatus.mockResolvedValue({ ...PROHIBITED[0]!, status: 'INACTIVE' });
  catalog.setMarketCategoryAvailability.mockResolvedValue(availability('CATEGORY', 'us-sf', 'auto_services', false, ['car_detailing']));
  catalog.setMarketServiceTypeAvailability.mockResolvedValue(availability('SERVICE_TYPE', 'us-sf', 'car_detailing'));
  content.resolveRendered.mockImplementation(async (ks: string[], o: { locale: string }) => ({
    items: new Map(ks.filter((k) => TEXT[k] !== undefined).map((k) => [k, { format: 'text', value: `${TEXT[k]} [${o.locale}]` }])),
    sources: new Map(),
    missing: new Map(),
    at: new Date(),
  }));
  content.listLocales.mockResolvedValue([
    { locale: 'en-US', isPlatformDefault: true },
    { locale: 'es-US', isPlatformDefault: false },
  ]);
});

// ====================================================================== the 16 operations
type Perm = 'public' | 'write' | 'read';
interface Route {
  operationId: string;
  method: Method;
  url: string;
  spec: string;
  perm: Perm;
  body?: unknown;
  okStatus: number;
  fn: keyof typeof catalog;
}
const REASON = 'unit test reason';
const ROUTES: Route[] = [
  {
    operationId: 'listCatalogCategories',
    method: 'GET',
    url: '/categories?market=us-sf',
    spec: '/api/v1/catalog/categories',
    perm: 'public',
    okStatus: 200,
    fn: 'listCategoriesForMarket',
  },
  {
    operationId: 'getCatalogCategory',
    method: 'GET',
    url: '/categories/auto_services?market=us-sf',
    spec: '/api/v1/catalog/categories/{code}',
    perm: 'public',
    okStatus: 200,
    fn: 'getCategoryForMarket',
  },
  {
    operationId: 'listCatalogServiceTypes',
    method: 'GET',
    url: '/service-types?market=us-sf',
    spec: '/api/v1/catalog/service-types',
    perm: 'public',
    okStatus: 200,
    fn: 'listServiceTypesForMarket',
  },
  {
    operationId: 'getCatalogServiceType',
    method: 'GET',
    url: '/service-types/car_detailing?market=us-sf',
    spec: '/api/v1/catalog/service-types/{code}',
    perm: 'public',
    okStatus: 200,
    fn: 'getServiceTypeForMarket',
  },
  {
    operationId: 'listCatalogProhibitedServices',
    method: 'GET',
    url: '/prohibited-services',
    spec: '/api/v1/catalog/prohibited-services',
    perm: 'read',
    okStatus: 200,
    fn: 'listProhibitedServices',
  },
  {
    operationId: 'getCatalogProhibitedService',
    method: 'GET',
    url: '/prohibited-services/weapons',
    spec: '/api/v1/catalog/prohibited-services/{code}',
    perm: 'read',
    okStatus: 200,
    fn: 'getProhibitedService',
  },
  {
    operationId: 'createCatalogCategory',
    method: 'POST',
    url: '/categories',
    spec: '/api/v1/catalog/categories',
    perm: 'write',
    body: { code: 'new_cat', iconKey: 'star', withDescription: true, reason: REASON },
    okStatus: 201,
    fn: 'createCategory',
  },
  {
    operationId: 'updateCatalogCategory',
    method: 'PATCH',
    url: '/categories/auto_services',
    spec: '/api/v1/catalog/categories/{code}',
    perm: 'write',
    body: { iconKey: null, withDescription: false, reason: REASON },
    okStatus: 200,
    fn: 'updateCategory',
  },
  {
    operationId: 'setCatalogCategoryStatus',
    method: 'PUT',
    url: '/categories/auto_services/status',
    spec: '/api/v1/catalog/categories/{code}/status',
    perm: 'write',
    body: { status: 'INACTIVE', reason: REASON },
    okStatus: 200,
    fn: 'setCategoryStatus',
  },
  {
    operationId: 'createCatalogServiceType',
    method: 'POST',
    url: '/service-types',
    spec: '/api/v1/catalog/service-types',
    perm: 'write',
    body: { code: 'new_st', categoryCode: 'auto_services', withDescription: true, reason: REASON },
    okStatus: 201,
    fn: 'createServiceType',
  },
  {
    operationId: 'updateCatalogServiceType',
    method: 'PATCH',
    url: '/service-types/car_detailing',
    spec: '/api/v1/catalog/service-types/{code}',
    perm: 'write',
    body: { withDescription: false, reason: REASON },
    okStatus: 200,
    fn: 'updateServiceType',
  },
  {
    operationId: 'setCatalogServiceTypeStatus',
    method: 'PUT',
    url: '/service-types/car_detailing/status',
    spec: '/api/v1/catalog/service-types/{code}/status',
    perm: 'write',
    body: { status: 'RETIRED', reason: REASON },
    okStatus: 200,
    fn: 'setServiceTypeStatus',
  },
  {
    operationId: 'createCatalogProhibitedService',
    method: 'POST',
    url: '/prohibited-services',
    spec: '/api/v1/catalog/prohibited-services',
    perm: 'write',
    body: { code: 'weapons', categoryCode: null, reason: REASON },
    okStatus: 201,
    fn: 'createProhibitedService',
  },
  {
    operationId: 'setCatalogProhibitedServiceStatus',
    method: 'PUT',
    url: '/prohibited-services/weapons/status',
    spec: '/api/v1/catalog/prohibited-services/{code}/status',
    perm: 'write',
    body: { status: 'INACTIVE', reason: REASON },
    okStatus: 200,
    fn: 'setProhibitedServiceStatus',
  },
  {
    operationId: 'setCatalogMarketCategoryAvailability',
    method: 'PUT',
    url: '/markets/us-sf/categories/auto_services',
    spec: '/api/v1/catalog/markets/{market}/categories/{code}',
    perm: 'write',
    body: { enabled: false, displayOrder: 10, reason: REASON },
    okStatus: 200,
    fn: 'setMarketCategoryAvailability',
  },
  {
    operationId: 'setCatalogMarketServiceTypeAvailability',
    method: 'PUT',
    url: '/markets/us-sf/service-types/car_detailing',
    spec: '/api/v1/catalog/markets/{market}/service-types/{code}',
    perm: 'write',
    body: { enabled: true, displayOrder: 10, reason: REASON },
    okStatus: 200,
    fn: 'setMarketServiceTypeAvailability',
  },
];
const PROTECTED = ROUTES.filter((r) => r.perm !== 'public');
const WRITES = ROUTES.filter((r) => r.perm === 'write');
const bodyless = (r: Route) => (r.method === 'GET' ? [undefined] : [undefined, {}, { garbage: true }, r.body]);

describe('the 16 operations: OpenAPI inventory', () => {
  it('documents exactly the 16 catalogue operations with the right method, path, tag and security', () => {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, { operationId: string; tags: string[]; security?: unknown[]; responses: Record<string, unknown> }>>;
    };
    const found: { operationId: string; method: string; path: string; tags: string[]; security: unknown }[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      if (path.startsWith('/api/v1/catalog'))
        for (const [method, op] of Object.entries(item))
          found.push({ operationId: op.operationId, method: method.toUpperCase(), path, tags: op.tags, security: op.security });
    expect(found).toHaveLength(16);
    expect(found.map((f) => f.operationId).sort()).toEqual(ROUTES.map((r) => r.operationId).sort());
    for (const r of ROUTES) {
      const f = found.find((x) => x.operationId === r.operationId)!;
      expect([f.method, f.path], r.operationId).toEqual([r.method, r.spec]);
      expect(f.tags, r.operationId).toEqual(['catalog']);
      if (r.perm === 'public') expect(f.security, r.operationId).toEqual([]);
      else expect(f.security, r.operationId).toEqual([{ bearerAuth: [] }]);
    }
    // nothing is documented that is not served: every documented operation answers (not 404 ROUTE_NOT_FOUND)
    const responses = (op: string) =>
      Object.keys(
        found.find((x) => x.operationId === op)
          ? doc.paths[found.find((x) => x.operationId === op)!.path]![found.find((x) => x.operationId === op)!.method.toLowerCase()]!.responses
          : {},
      );
    for (const r of PROTECTED) expect(responses(r.operationId), r.operationId).toEqual(expect.arrayContaining(['401', '403']));
    for (const r of ROUTES.filter((x) => x.perm === 'public')) {
      expect(responses(r.operationId), r.operationId).toEqual(expect.arrayContaining(['200', '400', '401', '404']));
      expect(responses(r.operationId), r.operationId).not.toContain('403');
    }
  });

  it('is not registered when the app is built without a catalogue service OR without a content service', async () => {
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const common = { cfg, verifier, configuration: {} as never, readiness: async () => ({}) };
    const t = await adminToken([READ, WRITE]);
    for (const deps of [
      { ...common },
      { ...common, content: content as unknown as ContentService },
      { ...common, catalog: catalog as unknown as CatalogService },
    ]) {
      const bare = await buildApp(deps);
      await bare.ready();
      for (const r of ROUTES) {
        const res = await bare.inject({
          method: r.method,
          url: `/api/v1/catalog${r.url}`,
          headers: { authorization: `Bearer ${t}` },
          ...(r.body ? { payload: r.body as object } : {}),
        });
        expect(res.statusCode, `${r.operationId}`).toBe(404);
        expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
      }
      await bare.close();
    }
    expect(noServiceCalled()).toBe(true);
  });
});

// ====================================================================== access control
describe('catalogue API access control (management routes)', () => {
  it('returns 401 before any validation on every protected route, with an empty, invalid or missing body and malformed params', async () => {
    for (const r of PROTECTED)
      for (const payload of bodyless(r)) {
        const res = await call(r.method, r.url, undefined, payload);
        expect(res.statusCode, `${r.method} ${r.url} ${JSON.stringify(payload)}`).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
        expect(res.headers['www-authenticate']).toContain('Bearer');
      }
    for (const [m, u] of [
      ['GET', '/prohibited-services/Not_A_Code'],
      ['PUT', '/categories/BAD/status'],
      ['PATCH', '/categories/BAD'],
      ['PUT', '/markets/BAD_MARKET/categories/BAD'],
      ['PUT', '/prohibited-services/' + 'a'.repeat(49) + '/status'],
    ] as const)
      expect((await call(m, u, undefined, m === 'GET' ? undefined : {})).statusCode, `${m} ${u}`).toBe(401);
    const expired = await signToken(keys, { claims: { sub: 'x', azp: 'bananagig-admin' }, expiresInSec: -60 });
    for (const bad of ['not.a.token', expired, unsignedToken({ azp: 'bananagig-admin' })])
      for (const r of PROTECTED) expect((await call(r.method, r.url, bad, r.method === 'GET' ? undefined : r.body)).statusCode, `${r.operationId}`).toBe(401);
    expect(noServiceCalled()).toBe(true);
    expect(noContentCalled()).toBe(true);
  });

  it('returns 403 (before validation) when an admin lacks the permission: catalog-read cannot write, and no role at all cannot do anything', async () => {
    for (const r of PROTECTED) {
      const refused = r.perm === 'read' ? [[]] : [[READ], []];
      for (const roles of refused) {
        const res = await call(r.method, r.url, await adminToken(roles), r.method === 'GET' ? undefined : {});
        expect(res.statusCode, `${r.method} ${r.url} [${roles}]`).toBe(403);
        expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
      }
    }
    expect(noServiceCalled()).toBe(true);
    expect(noContentCalled()).toBe(true);
  });

  it('catalog-write implies read (every protected GET and the management view), the reverse never holds', async () => {
    const writeOnly = await adminToken([WRITE]);
    const readOnly = await adminToken([READ]);
    for (const r of PROTECTED.filter((x) => x.perm === 'read')) expect((await call(r.method, r.url, writeOnly)).statusCode, r.operationId).toBe(200);
    const mgmt = await call('GET', '/categories', writeOnly);
    expect(names(mgmt)).toEqual(CATEGORIES.map((c) => c.code));
    expect(keysOf(mgmt.json().data[0])).toEqual(MGMT_CAT_KEYS);
    for (const r of WRITES) expect((await call(r.method, r.url, readOnly, r.body)).statusCode, r.operationId).toBe(403);
    expect(catalog.createCategory).not.toHaveBeenCalled();
  });

  it('does not let the content, configuration or geography roles (or any other role name) grant catalogue access', async () => {
    const foreign = await adminToken([
      'content-read',
      'content-write',
      'content-approve',
      'content-legal',
      'configuration-read',
      'configuration-write',
      'configuration-approve',
      'geography-read',
      'geography-write',
      'catalog-admin',
      'catalog',
      'Catalog-Read',
      'CATALOG-WRITE',
      'catalog-read ',
    ]);
    for (const r of PROTECTED) expect((await call(r.method, r.url, foreign, r.method === 'GET' ? undefined : r.body)).statusCode, r.operationId).toBe(403);
    // and the public reads stay in the public view for such a token
    expect((await call('GET', '/categories?market=us-sf', foreign)).json().data.map((c: object) => keysOf(c))[0]).toEqual(PUBLIC_CAT_KEYS);
    expect(Object.values(catalog).filter((f) => f.mock.calls.length > 0)).toHaveLength(1);
  });

  it('keeps customers, web-client tokens and other clients out even when they carry the role names', async () => {
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const spoofedOnWebClient = await signToken(keys, { claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [READ, WRITE] } } } });
    const webWithAdminResource = await signToken(keys, {
      claims: { azp: 'bananagig-web', resource_access: { 'bananagig-admin': { roles: ['admin-console-access', READ, WRITE] } } },
    });
    const realmRoles = await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: [READ, WRITE, 'admin-console-access'] } } });
    const adminRolesFromOtherClient = await signToken(keys, {
      claims: { azp: 'bananagig-dev-test', resource_access: { 'bananagig-admin': { roles: [READ, WRITE] } } },
    });
    for (const t of [customer, spoofedOnWebClient, webWithAdminResource, realmRoles, adminRolesFromOtherClient])
      for (const r of PROTECTED) {
        const res = await call(r.method, r.url, t, r.method === 'GET' ? undefined : r.body);
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      }
    // such tokens get the PUBLIC view of the shared reads: the market is required for them too
    for (const t of [customer, spoofedOnWebClient, webWithAdminResource, realmRoles, adminRolesFromOtherClient]) {
      const noMarket = await call('GET', '/categories', t);
      expect(noMarket.statusCode).toBe(400);
      expect(errorOf(noMarket).details).toMatchObject({ reason: 'MARKET_REQUIRED', field: 'market' });
      const withMarket = await call('GET', '/categories?market=us-sf', t);
      expect(keysOf(withMarket.json().data[0])).toEqual(PUBLIC_CAT_KEYS);
    }
    expect(catalog.listCategories).not.toHaveBeenCalled();
    expect(catalog.getCategory).not.toHaveBeenCalled();
  });

  it('with catalog-write: every mutation calls the service with the validated body and the TOKEN SUBJECT as actor and answers 201/200 with the management view', async () => {
    const t = await adminToken([WRITE], { sub: 'staff-77' });
    for (const r of WRITES) {
      const res = await call(r.method, r.url, t, r.body);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(r.okStatus);
      expect(res.json().meta.correlationId).toEqual(expect.any(String));
    }
    const created = await call('POST', '/categories', t, ROUTES.find((r) => r.fn === 'createCategory')!.body);
    expect(keysOf(created.json().data)).toEqual(MGMT_CAT_KEYS);
    // the fixture has no published text for the new code: the management view shows the content key an administrator has to create
    expect(created.json().data).toMatchObject({ code: 'new_cat', status: 'DRAFT', name: 'catalog.category.new_cat.name' });
    expect(catalog.createCategory).toHaveBeenCalledWith({ code: 'new_cat', iconKey: 'star', withDescription: true, reason: REASON }, 'staff-77');
    expect(catalog.updateCategory).toHaveBeenCalledWith('auto_services', { iconKey: null, withDescription: false, reason: REASON }, 'staff-77');
    expect(catalog.setCategoryStatus).toHaveBeenCalledWith('auto_services', { status: 'INACTIVE', reason: REASON }, 'staff-77');
    expect(catalog.createServiceType).toHaveBeenCalledWith(
      { code: 'new_st', categoryCode: 'auto_services', withDescription: true, reason: REASON },
      'staff-77',
    );
    expect(catalog.updateServiceType).toHaveBeenCalledWith('car_detailing', { withDescription: false, reason: REASON }, 'staff-77');
    expect(catalog.setServiceTypeStatus).toHaveBeenCalledWith('car_detailing', { status: 'RETIRED', reason: REASON }, 'staff-77');
    expect(catalog.createProhibitedService).toHaveBeenCalledWith({ code: 'weapons', categoryCode: null, reason: REASON }, 'staff-77');
    expect(catalog.setProhibitedServiceStatus).toHaveBeenCalledWith('weapons', { status: 'INACTIVE', reason: REASON }, 'staff-77');
    expect(catalog.setMarketCategoryAvailability).toHaveBeenCalledWith(
      'us-sf',
      'auto_services',
      { enabled: false, displayOrder: 10, reason: REASON },
      'staff-77',
    );
    expect(catalog.setMarketServiceTypeAvailability).toHaveBeenCalledWith(
      'us-sf',
      'car_detailing',
      { enabled: true, displayOrder: 10, reason: REASON },
      'staff-77',
    );
    // each mutation was called exactly once per request (no double execution)
    for (const f of WRITES.map((r) => r.fn)) expect(catalog[f].mock.calls.length, f).toBe(f === 'createCategory' ? 2 : 1);
    // a different admin is a different actor
    await call('PUT', '/categories/auto_services/status', await adminToken([WRITE], { sub: 'staff-88' }), { status: 'ACTIVE', reason: REASON });
    expect(catalog.setCategoryStatus).toHaveBeenLastCalledWith('auto_services', { status: 'ACTIVE', reason: REASON }, 'staff-88');
  });

  it('the response of each mutation is the management view of the right shape (and the fake service cannot smuggle extra fields through)', async () => {
    const t = await adminToken([WRITE]);
    catalog.createServiceType.mockResolvedValue({
      ...st('new_st', 'auto_services', 'DRAFT', 32),
      actor: 'staff-1',
      auditEvents: [{ actor: 'staff-1' }],
      price: 99,
      durationMinutes: 30,
    });
    catalog.setMarketCategoryAvailability.mockResolvedValue({
      ...availability('CATEGORY', 'us-sf', 'auto_services', false, ['car_detailing']),
      actor: 'staff-1',
      reason: 'secret',
    });
    const stRes = await call('POST', '/service-types', t, ROUTES.find((r) => r.fn === 'createServiceType')!.body);
    expect(stRes.statusCode).toBe(201);
    expect(keysOf(stRes.json().data)).toEqual(MGMT_ST_KEYS);
    expect(stRes.body).not.toContain('staff-1');
    expect(stRes.body).not.toContain('price');
    const av = await call('PUT', '/markets/us-sf/categories/auto_services', t, { enabled: false, reason: REASON });
    expect(keysOf(av.json().data)).toEqual(AVAILABILITY_KEYS);
    expect(av.json().data).toEqual(availability('CATEGORY', 'us-sf', 'auto_services', false, ['car_detailing']));
    expect(av.body).not.toContain('secret');
    const p = await call('POST', '/prohibited-services', t, ROUTES.find((r) => r.fn === 'createProhibitedService')!.body);
    expect(keysOf(p.json().data)).toEqual(PROHIBITED_KEYS);
    expect(p.json().data).toMatchObject({ name: 'Weapons [en-US]', description: null, nameContentKey: 'catalog.prohibited_service.weapons.name' });
  });
});

// ====================================================================== strict validation
describe('strict bodies, queries and params (400, standard envelope, never echoed, service never called)', () => {
  const SENTINEL = 'SENTINEL_VALUE_7c1e';
  const lastWord = (url: string) => url;
  const withBody = WRITES;

  it('rejects unknown fields, wrong types, coerced values and malformed bodies on every mutation', async () => {
    const t = await adminToken([WRITE]);
    for (const r of withBody) {
      const good = r.body as Record<string, unknown>;
      const bad: unknown[] = [
        {},
        { ...good, extra: SENTINEL },
        { ...good, status: SENTINEL },
        { ...good, categoryId: id(1), serviceTypeId: id(2), displayText: SENTINEL, name: SENTINEL },
        { ...good, price: 5, durationMinutes: 30 },
        { ...good, reason: '' },
        { ...good, reason: '   ' },
        { ...good, reason: `bad${String.fromCharCode(7)}${SENTINEL}` },
        { ...good, reason: SENTINEL.repeat(200) },
        { ...good, reason: 12 },
        { ...good, reason: [SENTINEL] },
        (({ reason: _r, ...rest }) => rest)(good),
        [good],
        [SENTINEL],
        SENTINEL,
        12345,
        true,
      ];
      for (const key of Object.keys(good)) {
        if (key === 'reason') continue;
        if (!['iconKey', 'categoryCode'].includes(key) || (key === 'categoryCode' && r.fn === 'createServiceType')) bad.push({ ...good, [key]: null }); // null where it is not allowed (iconKey and the prohibited service's categoryCode are nullable)
        bad.push({ ...good, [key]: key === 'displayOrder' ? '5' : 5 });
        bad.push({ ...good, [key]: [SENTINEL] });
        bad.push({ ...good, [key]: { v: SENTINEL } });
      }
      if ('code' in good)
        bad.push(
          { ...good, code: 'Bad_Code' },
          { ...good, code: 'a' },
          { ...good, code: 'a'.repeat(49) },
          { ...good, code: 'ab__cd' },
          { ...good, code: `${SENTINEL}!` },
        );
      if ('categoryCode' in good && good.categoryCode !== null) bad.push({ ...good, categoryCode: 'Bad' }, { ...good, categoryCode: id(1) });
      if ('iconKey' in good) bad.push({ ...good, iconKey: 'Bad_Icon' }, { ...good, iconKey: 'http://x/y.png' }, { ...good, iconKey: 5 });
      if ('withDescription' in good)
        bad.push({ ...good, withDescription: 'true' }, { ...good, withDescription: 1 }, { ...good, withDescription: 0 }, { ...good, withDescription: 'false' });
      if ('enabled' in good)
        bad.push({ ...good, enabled: 'true' }, { ...good, enabled: 1 }, { ...good, enabled: 0 }, { ...good, enabled: null }, { ...good, enabled: SENTINEL });
      if ('displayOrder' in good)
        bad.push(
          { ...good, displayOrder: '10' },
          { ...good, displayOrder: 0 },
          { ...good, displayOrder: 10000 },
          { ...good, displayOrder: 1.5 },
          { ...good, displayOrder: -1 },
          { ...good, displayOrder: null },
          { ...good, displayOrder: '1e3' },
          { ...good, displayOrder: true },
        );
      if ('status' in good)
        bad.push(
          { ...good, status: 'DRAFT' },
          { ...good, status: 'active' },
          { ...good, status: 'DELETED' },
          { ...good, status: null },
          { ...good, status: 1 },
        );
      for (const payload of bad) {
        const res = await app.inject({
          method: r.method,
          url: `/api/v1/catalog${r.url}`,
          headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
          payload: JSON.stringify(payload),
        });
        expect(res.statusCode, `${r.operationId} ${JSON.stringify(payload).slice(0, 120)}`).toBe(400);
        const e = errorOf(res);
        expect(e.category).toBe('VALIDATION');
        expect(res.body, `${r.operationId} ${JSON.stringify(payload).slice(0, 80)}`).not.toContain(SENTINEL);
        expect(res.body).not.toContain('"stack"');
      }
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('rejects `__proto__` / constructor keys, non-JSON text and a missing body without calling the service', async () => {
    const t = await adminToken([WRITE]);
    for (const r of withBody) {
      const raw = JSON.stringify(r.body).slice(0, -1);
      for (const payload of [`${raw},"__proto__":{"admin":true}}`, `${raw},"constructor":{"prototype":{"x":1}}}`]) {
        const res = await app.inject({
          method: r.method,
          url: `/api/v1/catalog${r.url}`,
          headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
          payload,
        });
        expect(res.statusCode, `${r.operationId} ${payload.slice(-40)}`).toBe(400);
        expect(errorOf(res).category).toBe('VALIDATION');
      }
      for (const [payload, type] of [
        ['{not json', 'application/json'],
        ['', 'application/json'],
        ['null', 'application/json'],
        ['"text"', 'application/json'],
        [`code=${SENTINEL}`, 'application/x-www-form-urlencoded'],
        [JSON.stringify(r.body), 'text/plain'],
      ] as const) {
        const res = await app.inject({
          method: r.method,
          url: `/api/v1/catalog${r.url}`,
          headers: { authorization: `Bearer ${t}`, 'content-type': type },
          payload,
        });
        expect([400, 415], `${r.operationId} ${type} ${payload.slice(0, 20)}`).toContain(res.statusCode);
        expect(res.body).not.toContain(SENTINEL);
        expect(errorOf(res).category).toBe('VALIDATION');
      }
      expect((await call(r.method, r.url, t)).statusCode, `${r.operationId} no body`).toBe(400);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('refuses a huge body (above the server limit) with a client error, not a 5xx, and without calling the service', async () => {
    const t = await adminToken([WRITE]);
    const huge = 'x'.repeat(3 * 1024 * 1024);
    for (const r of [WRITES[0]!, WRITES[3]!, WRITES[8]!]) {
      const res = await call(r.method, r.url, t, { ...(r.body as object), reason: huge });
      expect(res.statusCode, r.operationId).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, r.operationId).toBeLessThan(500);
      expect(res.body.length).toBeLessThan(2000);
      expect(res.body).not.toContain('xxxxxxxxxx');
    }
    // a deeply nested body (well under the size limit) is a client error as well, not a crash
    for (const nested of ['['.repeat(200_000), `{"reason":${'['.repeat(200_000)}`, `{"a":`.repeat(50_000)]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/catalog/categories',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        payload: nested,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    // a body just under the limit with a too-long reason: the standard 400 from the contract
    const big = await call('POST', '/categories', t, { code: 'new_cat', reason: 'y'.repeat(100_000) });
    expect(big.statusCode).toBe(400);
    expect(big.body).not.toContain('yyyyyyyyyy');
    expect(noServiceCalled()).toBe(true);
  });

  it('validates the path parameters: a code is canonical, a market code is canonical, `__proto__`, case, length, encoded newline and percent-encoding are refused', async () => {
    const t = await adminToken([READ, WRITE]);
    const badCodes = [
      'Bad',
      'BAD_CODE',
      'a',
      'a'.repeat(49),
      'ab__cd',
      '_ab',
      'ab_',
      '1ab',
      '__proto__',
      'ab%0A',
      'ab%20cd',
      'ab%2Fcd',
      'caf%C3%A9',
      'ab-cd',
      'ab.cd',
      '%00ab',
    ];
    // note: `%61b` decodes to the valid code `ab` (the router decodes before the schema), which is the standard behaviour and not an error
    const forms = (c: string): [Method, string, unknown?][] => [
      ['GET', `/categories/${c}?market=us-sf`],
      ['GET', `/service-types/${c}?market=us-sf`],
      ['GET', `/prohibited-services/${c}`],
      ['PATCH', `/categories/${c}`, { iconKey: 'star', reason: REASON }],
      ['PUT', `/categories/${c}/status`, { status: 'ACTIVE', reason: REASON }],
      ['PATCH', `/service-types/${c}`, { withDescription: true, reason: REASON }],
      ['PUT', `/service-types/${c}/status`, { status: 'ACTIVE', reason: REASON }],
      ['PUT', `/prohibited-services/${c}/status`, { status: 'ACTIVE', reason: REASON }],
      ['PUT', `/markets/us-sf/categories/${c}`, { enabled: true, displayOrder: 5, reason: REASON }],
      ['PUT', `/markets/us-sf/service-types/${c}`, { enabled: true, displayOrder: 5, reason: REASON }],
    ];
    for (const c of badCodes)
      for (const [m, u, b] of forms(c)) {
        const res = await call(m, u, t, b);
        expect(res.statusCode, `${m} ${u}`).toBe(400);
        expect(errorOf(res).category).toBe('VALIDATION');
      }
    for (const mk of ['US-SF', 'us_sf', '-us', 'us--sf', '1us', 'a'.repeat(61), '__proto__', 'us%0A', 'us%20sf'])
      for (const k of ['categories', 'service-types']) {
        const res = await call('PUT', `/markets/${mk}/${k}/auto_services`, t, { enabled: true, displayOrder: 5, reason: REASON });
        expect(res.statusCode, `${mk} ${k}`).toBe(400);
      }
    const router = await call('GET', `/categories/${'a'.repeat(MAX_PATH_PARAM_LENGTH + 8)}?market=us-sf`);
    expect(router.statusCode).toBe(400);
    expect(errorOf(router).code).toBe('PATH_PARAMETER_TOO_LONG');
    expect(noServiceCalled()).toBe(true);
    // the longest valid code is routed to the service
    expect((await call('GET', `/categories/${'a'.repeat(48)}?market=us-sf`)).statusCode).toBe(404);
    expect(catalog.getCategoryForMarket).toHaveBeenCalledTimes(1);
  });

  it('validates the query of the public reads: unknown parameters, arrays, bad market/locale/category, `__proto__` are 400 for anonymous AND for privileged callers', async () => {
    const t = await adminToken([READ]);
    const urls = (q: string): string[] => [`/categories?${q}`, `/categories/auto_services?${q}`, `/service-types?${q}`, `/service-types/car_detailing?${q}`];
    const badQueries = [
      'market=us-sf&bogus=1',
      'market=US-SF',
      'market=us_sf',
      'market=',
      'market=us-sf&market=mx-cdmx',
      'market[]=us-sf',
      'market=us-sf&locale=en_US',
      'market=us-sf&locale=EN-us',
      'market=us-sf&locale=',
      'market=us-sf&locale=en-US&locale=es-US',
      `market=us-sf&locale=${'a'.repeat(25)}`,
      'market=us-sf&status=ACTIVE',
      'market=us-sf&enabled=true',
      '__proto__=1&market=us-sf',
      'market=us-sf&constructor=1',
      `market=${'a'.repeat(61)}`,
    ];
    for (const token of [undefined, t])
      for (const q of badQueries)
        for (const u of urls(q)) {
          const res = await call('GET', u, token);
          expect(res.statusCode, `${token ? 'mgmt' : 'anon'} ${u}`).toBe(400);
          expect(errorOf(res).category).toBe('VALIDATION');
        }
    for (const token of [undefined, t])
      for (const q of [
        'category=Bad&market=us-sf',
        'category=a&market=us-sf',
        'category=&market=us-sf',
        'category=auto_services&category=home_cleaning&market=us-sf',
        'category[]=auto_services',
      ])
        expect((await call('GET', `/service-types?${q}`, token)).statusCode, `service-types ${q}`).toBe(400);
    // `category` is accepted ONLY by the service type list
    for (const u of [
      '/categories?market=us-sf&category=auto_services',
      '/categories/auto_services?market=us-sf&category=auto_services',
      '/service-types/car_detailing?market=us-sf&category=auto_services',
    ])
      expect((await call('GET', u)).statusCode, u).toBe(400);
    expect(noServiceCalled()).toBe(true);
    expect(noContentCalled()).toBe(true);
  });

  it('answers 401 for a credential that is presented but invalid on the public reads (never silently downgraded to anonymous), with the query still validated after', async () => {
    const expired = await signToken(keys, { claims: { sub: 'x', azp: 'bananagig-admin' }, expiresInSec: -60 });
    const unsigned = unsignedToken({ azp: 'bananagig-admin' });
    for (const url of [
      '/categories?market=us-sf',
      '/categories/auto_services?market=us-sf',
      '/service-types?market=us-sf',
      '/service-types/car_detailing?market=us-sf',
      '/categories',
    ]) {
      for (const bad of ['not.a.token', expired, unsigned]) {
        const res = await call('GET', url, bad);
        expect(res.statusCode, url).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
        expect(res.headers.vary).toMatch(/authorization/i);
      }
      const basic = await app.inject({ method: 'GET', url: `/api/v1/catalog${url}`, headers: { authorization: 'Basic abc' } });
      expect(basic.statusCode, `${url} basic`).toBe(401);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('lastWord helper stays trivial (keeps the table above readable)', () => {
    expect(lastWord('x')).toBe('x');
  });
});

// ====================================================================== headers
describe('headers: Vary, cache policy, correlation id', () => {
  it('every response of a public read carries `Vary: Authorization`: 200, 400, 401, 404, with and without a token', async () => {
    const t = await adminToken([READ]);
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const cases: [string, string | undefined, number][] = [
      ['/categories?market=us-sf', undefined, 200],
      ['/categories?market=us-sf', t, 200],
      ['/categories?market=us-sf', customer, 200],
      ['/categories/auto_services?market=us-sf', undefined, 200],
      ['/service-types?market=us-sf', undefined, 200],
      ['/service-types/car_detailing?market=us-sf', t, 200],
      ['/categories', undefined, 400], // market required
      ['/categories?market=us-sf&bogus=1', undefined, 400], // query validation
      ['/categories/Bad?market=us-sf', undefined, 400], // param validation
      ['/categories?market=us-sf', 'garbage', 401],
      ['/categories?market=la-oc', undefined, 404],
      ['/categories/draft_cat?market=us-sf', undefined, 404],
      ['/service-types/nope_st?market=us-sf', undefined, 404],
    ];
    for (const [url, token, status] of cases) {
      const res = await call('GET', url, token);
      expect(res.statusCode, `${url} ${token ? 'token' : 'anon'}`).toBe(status);
      expect(res.headers.vary, `${url} ${status}`).toMatch(/\bauthorization\b/i);
    }
    // an existing Vary value is kept, not replaced
    expect(
      String((await call('GET', '/categories?market=us-sf')).headers.vary)
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s === 'authorization'),
    ).toHaveLength(1);
  });

  it('the management view, the prohibited list and the mutations are `Cache-Control: private, no-store`; the public view is not', async () => {
    const t = await adminToken([READ, WRITE]);
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const noStore = /private, no-store/;
    for (const url of [
      '/categories',
      '/categories/auto_services',
      '/service-types',
      '/service-types/car_detailing',
      '/categories?market=us-sf',
      '/prohibited-services',
    ]) {
      expect(String((await call('GET', url, t)).headers['cache-control']), `${url} management`).toMatch(noStore);
    }
    const post = await call('POST', '/categories', t, ROUTES.find((r) => r.fn === 'createCategory')!.body);
    expect(String(post.headers['cache-control'])).toMatch(noStore);
    for (const token of [undefined, customer]) {
      for (const url of ['/categories?market=us-sf', '/service-types/car_detailing?market=us-sf']) {
        expect(String((await call('GET', url, token)).headers['cache-control'] ?? ''), `${url} public`).not.toMatch(noStore);
      }
    }
  });

  it('never marks a catalogue response as publicly cacheable by the server (no `Cache-Control: public`, no shared-cache directive) and sets no cookie', async () => {
    const t = await adminToken([READ, WRITE]);
    const responses = [
      await call('GET', '/categories?market=us-sf'),
      await call('GET', '/categories?market=us-sf', t),
      await call('GET', '/categories', t),
      await call('GET', '/prohibited-services', t),
      await call('POST', '/categories', t, ROUTES.find((r) => r.fn === 'createCategory')!.body),
      await call('GET', '/categories'),
      await call('GET', '/categories?market=la-oc'),
    ];
    for (const r of responses) {
      expect(String(r.headers['cache-control'] ?? ''), `${r.statusCode}`).not.toMatch(/public|s-maxage/i);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(r.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('echoes the correlation id in the header and in the meta / error envelope, for successes and errors of every kind', async () => {
    const t = await adminToken([READ, WRITE]);
    const ok = await call('GET', '/categories?market=us-sf', undefined, undefined, { 'x-correlation-id': 'corr-cat-1' });
    expect(ok.json().meta.correlationId).toBe('corr-cat-1');
    expect(ok.headers['x-correlation-id']).toBe('corr-cat-1');
    const mgmt = await call('GET', '/categories', t, undefined, { 'x-correlation-id': 'corr-cat-2' });
    expect(mgmt.json().meta.correlationId).toBe('corr-cat-2');
    const created = await call('POST', '/categories', t, ROUTES.find((r) => r.fn === 'createCategory')!.body, { 'x-correlation-id': 'corr-cat-3' });
    expect(created.json().meta.correlationId).toBe('corr-cat-3');
    const missing = await call('GET', '/categories/draft_cat?market=us-sf', undefined, undefined, { 'x-correlation-id': 'corr-cat-4' });
    expect(errorOf(missing).correlationId).toBe('corr-cat-4');
    expect(missing.headers['x-correlation-id']).toBe('corr-cat-4');
    const noMarket = await call('GET', '/categories', undefined, undefined, { 'x-correlation-id': 'corr-cat-5' });
    expect(errorOf(noMarket).correlationId).toBe('corr-cat-5');
    const denied = await call('POST', '/categories', await adminToken([READ]), {}, { 'x-correlation-id': 'corr-cat-6' });
    expect(errorOf(denied).correlationId).toBe('corr-cat-6');
    const unauth = await call('POST', '/categories', undefined, {}, { 'x-correlation-id': 'corr-cat-7' });
    expect(errorOf(unauth).correlationId).toBe('corr-cat-7');
    const invalid = await call('POST', '/categories', t, { nope: 1 }, { 'x-correlation-id': 'corr-cat-8' });
    expect(errorOf(invalid).correlationId).toBe('corr-cat-8');
    catalog.createCategory.mockRejectedValueOnce(new CatalogError('CONFLICT', 'a record with this code already exists', { reason: 'CODE_TAKEN' }));
    const conflict = await call('POST', '/categories', t, ROUTES.find((r) => r.fn === 'createCategory')!.body, { 'x-correlation-id': 'corr-cat-9' });
    expect(errorOf(conflict).correlationId).toBe('corr-cat-9');
    expect((await call('GET', '/categories?market=us-sf')).json().meta.correlationId).toEqual(expect.any(String));
  });
});

// ====================================================================== the public view
describe('the PUBLIC view (anonymous and every caller without catalog-read)', () => {
  const callers = async () => [
    { token: undefined as string | undefined, label: 'anonymous' },
    { token: await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } }), label: 'customer' },
    {
      token: await signToken(keys, { claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [READ, WRITE] } } } }),
      label: 'web client with the role names',
    },
    { token: await adminToken(['content-read', 'configuration-read', 'geography-read']), label: 'admin without catalog roles' },
  ];

  it('REQUIRES the market on all four reads (400 MARKET_REQUIRED, field market) for anonymous callers and for tokens without catalog-read; the service is not asked', async () => {
    for (const { token, label } of await callers())
      for (const u of [
        '/categories',
        '/categories/auto_services',
        '/service-types',
        '/service-types/car_detailing',
        '/service-types?category=auto_services',
        '/categories?locale=en-US',
      ]) {
        const res = await call('GET', u, token);
        expect(res.statusCode, `${label} ${u}`).toBe(400);
        expect(errorOf(res)).toMatchObject({
          category: 'VALIDATION',
          code: 'CATALOG_VALIDATION_FAILED',
          details: { reason: 'MARKET_REQUIRED', field: 'market' },
        });
      }
    for (const f of [
      'listCategoriesForMarket',
      'getCategoryForMarket',
      'listServiceTypesForMarket',
      'getServiceTypeForMarket',
      'listCategories',
      'getCategory',
    ] as const)
      expect(catalog[f], f).not.toHaveBeenCalled();
  });

  it('answers a market that is not public (unknown, PLANNED, INACTIVE: the same for all) with 404 CATALOG_MARKET_NOT_FOUND and never says whether it exists', async () => {
    for (const { token, label } of await callers()) {
      const answers: unknown[] = [];
      for (const market of ['la-oc', 'nowhere', 'old-mkt', 'devtest-x']) {
        for (const u of ['/categories', '/categories/auto_services', '/service-types', '/service-types/car_detailing']) {
          const res = await call('GET', `${u}?market=${market}`, token);
          expect(res.statusCode, `${label} ${u} ${market}`).toBe(404);
          expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'CATALOG_MARKET_NOT_FOUND' });
          const { correlationId: _c, ...rest } = errorOf(res);
          answers.push({ ...rest, details: { ...(rest.details as object), code: '*' } });
        }
      }
      expect(new Set(answers.map((a) => JSON.stringify(a))).size, label).toBe(1);
    }
    expect(content.resolveRendered).not.toHaveBeenCalled();
  });

  it('lists the ACTIVE categories and service types in the order of the market with ONLY the public fields (exact key sets, no status, enabled, content keys, timestamps, audit)', async () => {
    const cats = await call('GET', '/categories?market=us-sf');
    expect(cats.statusCode).toBe(200);
    expect(names(cats)).toEqual(['auto_services', 'home_cleaning']); // unnamed_cat is omitted: it has no published text
    for (const c of cats.json().data) expect(keysOf(c)).toEqual(PUBLIC_CAT_KEYS);
    expect(cats.json().data[0]).toEqual({
      categoryId: id(1),
      code: 'auto_services',
      name: 'Name of auto_services [en-US]',
      description: 'About auto_services [en-US]',
      iconKey: 'car',
      displayOrder: 10,
    });
    expect(keysOf(cats.json().meta)).toEqual(['correlationId']);
    const sts = await call('GET', '/service-types?market=us-sf');
    expect(names(sts)).toEqual(['car_detailing', 'mobile_car_wash', 'regular_cleaning']);
    for (const s of sts.json().data) expect(keysOf(s)).toEqual(PUBLIC_ST_KEYS);
    expect(sts.json().data[1]).toMatchObject({ code: 'mobile_car_wash', categoryCode: 'auto_services', description: null, displayOrder: 20 });
    const one = await call('GET', '/categories/auto_services?market=us-sf');
    expect(keysOf(one.json().data)).toEqual(PUBLIC_CAT_KEYS);
    const oneSt = await call('GET', '/service-types/car_detailing?market=us-sf');
    expect(keysOf(oneSt.json().data)).toEqual(PUBLIC_ST_KEYS);
    for (const r of [cats, sts, one, oneSt]) {
      for (const w of ['status', 'enabled', 'nameContentKey', 'descriptionContentKey', 'createdAt', 'updatedAt', ...INTERNAL_WORDS])
        expect(r.body, w).not.toContain(`"${w}"`);
      expect(r.body).not.toContain('catalog.category.');
      expect(r.body).not.toContain('catalog.service_type.');
    }
    // the public view is requested explicitly from the service: the gate-checked public methods, never a management read
    expect(catalog.listCategoriesForMarket).toHaveBeenCalledWith('us-sf');
    expect(catalog.listServiceTypesForMarket).toHaveBeenCalledWith('us-sf', { categoryCode: undefined });
    expect(catalog.getCategoryForMarket).toHaveBeenCalledWith('us-sf', 'auto_services');
    expect(catalog.getServiceTypeForMarket).toHaveBeenCalledWith('us-sf', 'car_detailing');
    expect(catalog.listCategories).not.toHaveBeenCalled();
    expect(catalog.listServiceTypes).not.toHaveBeenCalled();
  });

  it('filters service types by category through the service', async () => {
    const r = await call('GET', '/service-types?market=us-sf&category=home_cleaning');
    expect(names(r)).toEqual(['regular_cleaning']);
    expect(catalog.listServiceTypesForMarket).toHaveBeenCalledWith('us-sf', { categoryCode: 'home_cleaning' });
    expect(names(await call('GET', '/service-types?market=us-sf&category=nope_cat'))).toEqual([]);
  });

  it('never exposes a management or audit field even if the service returned them (defense in depth)', async () => {
    const dirtyCat = {
      ...publicCat(CATEGORIES[0]!),
      status: 'DRAFT',
      enabled: false,
      createdAt: T0,
      updatedAt: T0,
      createdBy: 'staff-1',
      actor: 'staff-1',
      auditEvents: [{ actor: 'staff-1' }],
      price: 5,
      nameContentKey: 'catalog.category.auto_services.name',
    };
    const dirtySt = {
      ...publicSt(SERVICE_TYPES[0]!),
      status: 'DRAFT',
      enabled: false,
      createdAt: T0,
      actor: 'staff-1',
      durationMinutes: 60,
      radiusKm: 5,
      capacity: 3,
    };
    catalog.listCategoriesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, categories: [dirtyCat] });
    catalog.getCategoryForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, category: dirtyCat });
    catalog.listServiceTypesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, serviceTypes: [dirtySt] });
    catalog.getServiceTypeForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, serviceType: dirtySt });
    const rs = [
      await call('GET', '/categories?market=us-sf'),
      await call('GET', '/categories/auto_services?market=us-sf'),
      await call('GET', '/service-types?market=us-sf'),
      await call('GET', '/service-types/car_detailing?market=us-sf'),
    ];
    for (const r of rs) {
      expect(r.statusCode).toBe(200);
      const item = Array.isArray(r.json().data) ? r.json().data[0] : r.json().data;
      expect(keysOf(item)).toEqual(item.serviceTypeId ? PUBLIC_ST_KEYS : PUBLIC_CAT_KEYS);
      for (const w of ['staff-1', 'DRAFT', 'durationMinutes', 'radiusKm', 'capacity', 'price', 'catalog.category.', 'createdAt'])
        expect(r.body, w).not.toContain(w);
    }
  });

  it('resolves ALL names and descriptions with ONE resolveRendered call: market in the context, includeInternal FALSE, the market default locale, unique keys', async () => {
    await call('GET', '/categories?market=us-sf');
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    const [keysArg, opts] = content.resolveRendered.mock.calls[0]!;
    expect(opts).toEqual({ locale: 'en-US', context: { market: 'us-sf' }, includeInternal: false });
    expect(opts.includeInternal).toBe(false);
    expect([...keysArg].sort()).toEqual(PUBLIC_CATEGORIES.flatMap((c) => [c.nameContentKey, c.descriptionContentKey!]).sort());
    expect(new Set(keysArg).size).toBe(keysArg.length);
    expect(content.listLocales).not.toHaveBeenCalled(); // the market supplies the default locale
    content.resolveRendered.mockClear();
    await call('GET', '/service-types?market=mx-cdmx');
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    expect(content.resolveRendered.mock.calls[0]![1]).toEqual({ locale: 'es-MX', context: { market: 'mx-cdmx' }, includeInternal: false });
    content.resolveRendered.mockClear();
    await call('GET', '/categories/auto_services?market=us-sf');
    await call('GET', '/service-types/car_detailing?market=us-sf');
    expect(content.resolveRendered).toHaveBeenCalledTimes(2);
    for (const c of content.resolveRendered.mock.calls) expect(c[1]).toMatchObject({ locale: 'en-US', context: { market: 'us-sf' }, includeInternal: false });
    expect(content.resolveRendered.mock.calls[0]![0]).toEqual([categoryNameKey('auto_services'), categoryDescriptionKey('auto_services')]);
  });

  it('uses the locale of the request when given, otherwise the default locale of the MARKET (not the platform default)', async () => {
    const mx = await call('GET', '/categories?market=mx-cdmx');
    expect(mx.json().data[0].name).toBe('Name of auto_services [es-MX]');
    const es = await call('GET', '/categories?market=us-sf&locale=es-US');
    expect(es.json().data[0].name).toBe('Name of auto_services [es-US]');
    const explicitOverMarket = await call('GET', '/categories/auto_services?market=mx-cdmx&locale=en-US');
    expect(explicitOverMarket.json().data.name).toBe('Name of auto_services [en-US]');
    expect(content.resolveRendered.mock.calls.map((c) => c[1].locale)).toEqual(['es-MX', 'es-US', 'en-US']);
    expect(content.listLocales).not.toHaveBeenCalled();
  });

  it('OMITS an item whose NAME has no published text (list) and answers 404 for it (single); a missing DESCRIPTION is null, not a failure', async () => {
    const list = await call('GET', '/categories?market=us-sf');
    expect(names(list)).not.toContain('unnamed_cat');
    const one = await call('GET', '/categories/unnamed_cat?market=us-sf');
    expect(one.statusCode).toBe(404);
    expect(errorOf(one)).toMatchObject({ category: 'NOT_FOUND', code: 'CATALOG_CATEGORY_NOT_FOUND' });
    expect(one.body).not.toContain('catalog.category.');
    const stList = await call('GET', '/service-types?market=us-sf');
    expect(names(stList)).not.toContain('unnamed_st');
    expect((await call('GET', '/service-types/unnamed_st?market=us-sf')).statusCode).toBe(404);
    expect(errorOf(await call('GET', '/service-types/unnamed_st?market=us-sf')).code).toBe('CATALOG_SERVICE_TYPE_NOT_FOUND');
    expect(stList.json().data.find((s: { code: string }) => s.code === 'mobile_car_wash').description).toBeNull();
    // unnamed AND nothing resolved at all: still an empty list, not an error
    content.resolveRendered.mockResolvedValue({ items: new Map(), sources: new Map(), missing: new Map(), at: new Date() });
    const empty = await call('GET', '/categories?market=us-sf');
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data).toEqual([]);
  });

  it('treats a text that resolved as html (not plain text) as unresolved: the item is omitted, never rendered as markup', async () => {
    content.resolveRendered.mockImplementation(async (ks: string[]) => ({
      items: new Map(ks.map((k) => [k, { format: 'html', value: '<b>bold</b>' }])),
      sources: new Map(),
      missing: new Map(),
      at: new Date(),
    }));
    const r = await call('GET', '/categories?market=us-sf');
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual([]);
    expect(r.body).not.toContain('<b>');
  });

  it('a content outage is a generic 503 CATALOG_UNAVAILABLE on EVERY public read (never an empty 200, never a misleading 404), without the cause', async () => {
    content.resolveRendered.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2'));
    for (const u of [
      '/categories?market=us-sf',
      '/categories/auto_services?market=us-sf',
      '/service-types?market=us-sf',
      '/service-types/car_detailing?market=us-sf',
    ]) {
      for (const token of [undefined, await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } })]) {
        const r = await call('GET', u, token);
        expect(r.statusCode, u).toBe(503);
        expect(errorOf(r)).toMatchObject({ category: 'DEPENDENCY', code: 'CATALOG_UNAVAILABLE', message: 'The catalogue is temporarily unavailable' });
        expect(errorOf(r).details).toBeUndefined();
        expect(r.headers.vary).toMatch(/authorization/i);
        for (const w of ['ECONNREFUSED', 'hunter2', '10.1.2.3', 'content']) expect(r.body, `${u} ${w}`).not.toContain(w);
      }
    }
    // an item that has no text is still the 404 / omission (a registry that ANSWERS), only a registry that cannot answer is a 503
    content.resolveRendered.mockReset();
    content.resolveRendered.mockResolvedValue({ items: new Map(), sources: new Map(), missing: new Map(), at: new Date() });
    expect((await call('GET', '/categories?market=us-sf')).statusCode).toBe(200);
    expect((await call('GET', '/categories/auto_services?market=us-sf')).statusCode).toBe(404);
  });

  it('no text lookup at all (an empty page) is not an outage: nothing to resolve, no content call, 200', async () => {
    catalog.listCategoriesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, categories: [] });
    content.resolveRendered.mockRejectedValue(new Error('down'));
    const r = await call('GET', '/categories?market=us-sf');
    expect([r.statusCode, r.json().data]).toEqual([200, []]);
    expect(content.resolveRendered).not.toHaveBeenCalled();
  });

  it('falls back to the PLATFORM default locale when the market has none and the request names none', async () => {
    catalog.listCategoriesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: undefined }, categories: PUBLIC_CATEGORIES.map(publicCat) });
    const r = await call('GET', '/categories?market=us-sf');
    expect(r.json().data[0].name).toBe('Name of auto_services [en-US]');
    expect(content.listLocales).toHaveBeenCalledWith({ activeOnly: true });
  });

  it('a service failure that is not a CatalogError is a generic 500 with no internal text', async () => {
    catalog.listCategoriesForMarket.mockRejectedValue(new Error('relation "catalog.categories" does not exist password=hunter2'));
    const r = await call('GET', '/categories?market=us-sf');
    expect(r.statusCode).toBe(500);
    expect(errorOf(r)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(r.body).not.toContain('hunter2');
    expect(r.body).not.toContain('does not exist');
  });
});

// ====================================================================== the management view
describe('the MANAGEMENT view (admin context with catalog-read or catalog-write)', () => {
  it('lists every status, with management fields, without a market (the global list); the market is optional', async () => {
    const t = await adminToken([READ]);
    const list = await call('GET', '/categories', t);
    expect(list.statusCode).toBe(200);
    expect(names(list)).toEqual(['auto_services', 'draft_cat', 'home_cleaning', 'old_cat', 'unnamed_cat']);
    expect(list.json().data.map((c: { status: string }) => c.status)).toEqual(['ACTIVE', 'DRAFT', 'ACTIVE', 'RETIRED', 'ACTIVE']);
    for (const c of list.json().data) expect(keysOf(c)).toEqual(MGMT_CAT_KEYS);
    expect(list.json().data[0]).toMatchObject({ createdAt: T0, updatedAt: T0, nameContentKey: 'catalog.category.auto_services.name', displayOrder: null });
    expect(catalog.listCategories).toHaveBeenCalledWith({ marketCode: undefined });
    expect(catalog.listCategoriesForMarket).not.toHaveBeenCalled();
    const sts = await call('GET', '/service-types', t);
    expect(names(sts)).toEqual(SERVICE_TYPES.map((s) => s.code));
    for (const s of sts.json().data) expect(keysOf(s)).toEqual(MGMT_ST_KEYS);
    expect(catalog.listServiceTypes).toHaveBeenCalledWith({ marketCode: undefined, categoryCode: undefined });
    expect((await call('GET', '/categories/draft_cat', t)).json().data.status).toBe('DRAFT');
    expect((await call('GET', '/service-types/draft_st', t)).json().data.status).toBe('DRAFT');
    expect(catalog.getCategory).toHaveBeenCalledWith('draft_cat', { marketCode: undefined });
  });

  it('with a market (any status of the market): the availability flag and the order of that market are added; an unregistered market is a 404', async () => {
    const t = await adminToken([READ]);
    const list = await call('GET', '/categories?market=la-oc', t);
    expect(list.statusCode).toBe(200);
    for (const c of list.json().data) expect(keysOf(c)).toEqual(MGMT_CAT_KEYS_WITH_MARKET);
    expect(list.json().data[0]).toMatchObject({ code: 'auto_services', enabled: true, displayOrder: 10 });
    expect(catalog.listCategories).toHaveBeenCalledWith({ marketCode: 'la-oc' });
    expect((await call('GET', '/service-types?market=la-oc&category=home_cleaning', t)).statusCode).toBe(200);
    expect(catalog.listServiceTypes).toHaveBeenCalledWith({ marketCode: 'la-oc', categoryCode: 'home_cleaning' });
    expect((await call('GET', '/categories/auto_services?market=la-oc', t)).statusCode).toBe(200);
    expect((await call('GET', '/service-types/car_detailing?market=la-oc', t)).statusCode).toBe(200);
    const missing = await call('GET', '/categories?market=nowhere', t);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('CATALOG_MARKET_NOT_FOUND');
  });

  it('falls back to the content KEY as the name when no text is published (the public view omits the item) and to null for a missing description', async () => {
    const t = await adminToken([READ]);
    const list = await call('GET', '/categories', t);
    const unnamed = list.json().data.find((c: { code: string }) => c.code === 'unnamed_cat');
    expect(unnamed).toMatchObject({ name: 'catalog.category.unnamed_cat.name', description: null });
    const sts = await call('GET', '/service-types', t);
    expect(sts.json().data.find((s: { code: string }) => s.code === 'unnamed_st')).toMatchObject({ name: 'catalog.service_type.unnamed_st.name' });
    expect(sts.json().data.find((s: { code: string }) => s.code === 'mobile_car_wash').description).toBeNull();
    const one = await call('GET', '/categories/unnamed_cat', t);
    expect(one.statusCode).toBe(200);
    expect(one.json().data.name).toBe('catalog.category.unnamed_cat.name');
  });

  it('resolves the text with ONE call: no includeInternal restriction for administrators, the market (when named) in the context, the platform default locale unless asked', async () => {
    const t = await adminToken([READ]);
    await call('GET', '/categories', t);
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    const [keysArg, opts] = content.resolveRendered.mock.calls[0]!;
    expect(opts.includeInternal).not.toBe(false);
    expect(opts.locale).toBe('en-US');
    expect(opts.context).toBeUndefined();
    expect(content.listLocales).toHaveBeenCalledWith({ activeOnly: true });
    expect(new Set(keysArg).size).toBe(keysArg.length);
    expect(keysArg).toHaveLength(2 * CATEGORIES.length);
    content.resolveRendered.mockClear();
    await call('GET', '/categories?market=la-oc&locale=es-US', t);
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    expect(content.resolveRendered.mock.calls[0]![1]).toMatchObject({ locale: 'es-US', context: { market: 'la-oc' } });
    expect(content.resolveRendered.mock.calls[0]![1].includeInternal).not.toBe(false);
  });

  it('a content outage never fails the management read: the names fall back to the content keys (200), with a warn log that holds no cause', async () => {
    const t = await adminToken([READ]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    try {
      content.resolveRendered.mockRejectedValue(new Error('content down password=hunter2'));
      for (const u of [
        '/categories',
        '/categories/auto_services',
        '/service-types',
        '/service-types/car_detailing',
        '/categories?market=la-oc',
        '/prohibited-services',
        '/prohibited-services/weapons',
      ]) {
        const r = await call('GET', u, t);
        expect(r.statusCode, u).toBe(200);
        expect(r.body).not.toContain('hunter2');
      }
      expect((await call('GET', '/categories', t)).json().data.map((c: { name: string }) => c.name)).toEqual(CATEGORIES.map((c) => c.nameContentKey));
      content.listLocales.mockRejectedValue(new Error('locales down'));
      expect((await call('GET', '/categories', t)).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const out = logged.join('\n');
    expect(out).toContain('catalogue text could not be resolved');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('content down');
  });

  it('a management view WITH a market resolves text in the default locale of THAT market (any status), on lists and on details; an explicit locale wins; without a market the platform default', async () => {
    const t = await adminToken([READ]);
    const localeOfLast = () => content.resolveRendered.mock.calls.at(-1)![1].locale;
    for (const [market, locale] of [
      ['mx-cdmx', 'es-MX'],
      ['qa-lab', 'qaa'],
      ['la-oc', 'en-US'],
    ] as const) {
      for (const u of ['/categories', '/categories/auto_services', '/service-types', '/service-types/car_detailing']) {
        content.resolveRendered.mockClear();
        const r = await call('GET', `${u}?market=${market}`, t);
        expect(r.statusCode, `${u} ${market}`).toBe(200);
        expect(localeOfLast(), `${u} ${market}`).toBe(locale);
        expect(content.resolveRendered.mock.calls.at(-1)![1].context).toEqual({ market });
      }
    }
    expect((await call('GET', '/categories?market=mx-cdmx', t)).json().data[0].name).toBe('Name of auto_services [es-MX]');
    // an explicit locale still wins
    for (const u of ['/categories', '/categories/auto_services', '/service-types', '/service-types/car_detailing']) {
      content.resolveRendered.mockClear();
      await call('GET', `${u}?market=mx-cdmx&locale=en-US`, t);
      expect(localeOfLast(), u).toBe('en-US');
    }
    // without a market: the platform default and no market lookup
    catalog.getMarketDefaultLocale.mockClear();
    content.resolveRendered.mockClear();
    for (const u of ['/categories', '/categories/auto_services', '/service-types', '/service-types/car_detailing']) await call('GET', u, t);
    expect(catalog.getMarketDefaultLocale).not.toHaveBeenCalled();
    for (const c of content.resolveRendered.mock.calls) expect(c[1].locale).toBe('en-US');
    // the public view never asks for it (the gate already supplied the locale)
    catalog.getMarketDefaultLocale.mockClear();
    await call('GET', '/categories?market=mx-cdmx');
    expect(catalog.getMarketDefaultLocale).not.toHaveBeenCalled();
    // an unregistered market is a typed 404 on the locale lookup as well
    catalog.listCategories.mockResolvedValue(CATEGORIES);
    const missing = await call('GET', '/categories?market=nowhere', t);
    expect([missing.statusCode, errorOf(missing).code]).toEqual([404, 'CATALOG_MARKET_NOT_FOUND']);
  });

  it('the prohibited-service list is management only and resolves its text without a market', async () => {
    const t = await adminToken([READ]);
    const list = await call('GET', '/prohibited-services', t);
    expect(list.statusCode).toBe(200);
    expect(keysOf(list.json().data[0])).toEqual(PROHIBITED_KEYS);
    expect(list.json().data[0]).toMatchObject({ code: 'weapons', name: 'Weapons [en-US]'.replace(' [en-US]', ' [en-US]') });
    const one = await call('GET', '/prohibited-services/weapons', t);
    expect(keysOf(one.json().data)).toEqual(PROHIBITED_KEYS);
    const missing = await call('GET', '/prohibited-services/nope_one', t);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('CATALOG_PROHIBITED_SERVICE_NOT_FOUND');
    // a prohibited service without published text keeps null (no key fallback is invented for it)
    content.resolveRendered.mockResolvedValue({ items: new Map(), sources: new Map(), missing: new Map(), at: new Date() });
    expect((await call('GET', '/prohibited-services', t)).json().data[0].name).toBeNull();
  });
});

// ====================================================================== error mapping
describe('error mapping: every CatalogError code becomes the standard envelope with a CATALOG_ code', () => {
  const EXPECTED: Record<CatalogErrorCode, { status: number; category: string }> = {
    CATEGORY_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    SERVICE_TYPE_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    PROHIBITED_SERVICE_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    GIG_TEMPLATE_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    GIG_TEMPLATE_VERSION_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    MARKET_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    VALIDATION_FAILED: { status: 400, category: 'VALIDATION' },
    CONFLICT: { status: 409, category: 'CONFLICT' },
    INVALID_STATE: { status: 409, category: 'CONFLICT' },
    UNAVAILABLE: { status: 503, category: 'DEPENDENCY' },
  };
  const ALLOWED_DETAILS = new Set(['reason', 'field', 'retryable', 'code']);

  it('covers every code of the contract', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CATALOG_ERROR_CODES].sort());
  });

  it.each([...CATALOG_ERROR_CODES])('%s on a mutation, a management read and a public read', async (code) => {
    const details: Record<string, unknown> =
      code === 'UNAVAILABLE'
        ? {}
        : code === 'CONFLICT'
          ? { reason: 'CONCURRENT_UPDATE', retryable: true }
          : code === 'VALIDATION_FAILED'
            ? { reason: 'INVALID_FIELD', field: 'code' }
            : code === 'INVALID_STATE'
              ? { reason: 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES' }
              : { code: 'some_code' };
    const failure = () => new CatalogError(code, `fixed message for ${code}`, details);
    const t = await adminToken([READ, WRITE]);
    const create = ROUTES.find((r) => r.fn === 'createCategory')!;
    catalog.createCategory.mockRejectedValueOnce(failure());
    catalog.getCategory.mockRejectedValueOnce(failure());
    catalog.listCategoriesForMarket.mockRejectedValueOnce(failure());
    const results = [
      await call('POST', '/categories', t, create.body),
      await call('GET', '/categories/auto_services', t),
      await call('GET', '/categories?market=us-sf'),
    ];
    for (const res of results) {
      expect(res.statusCode, code).toBe(EXPECTED[code].status);
      const e = errorOf(res);
      expect(e).toMatchObject({ code: `CATALOG_${code}`, category: EXPECTED[code].category });
      if (code === 'UNAVAILABLE') {
        expect(e.message).toBe('The catalogue is temporarily unavailable');
        expect(e.details).toBeUndefined();
      } else {
        expect(e.message).toBe(`fixed message for ${code}`);
        for (const k of Object.keys(e.details ?? {})) expect(ALLOWED_DETAILS.has(k), `${code} detail ${k}`).toBe(true);
        expect(e.details).toEqual(details);
      }
      expect(res.body).not.toContain('"stack"');
    }
  });

  it('every mutation and every read maps a CatalogError (not just the one covered above)', async () => {
    const t = await adminToken([READ, WRITE]);
    for (const r of ROUTES) {
      catalog[r.fn].mockRejectedValueOnce(new CatalogError('CONFLICT', 'fixed', { reason: 'CODE_TAKEN' }));
      const res = await call(r.method, r.url, r.perm === 'public' ? undefined : t, r.body);
      expect(res.statusCode, r.operationId).toBe(409);
      expect(errorOf(res).code, r.operationId).toBe('CATALOG_CONFLICT');
    }
    // a management read of a public route goes through the management methods
    for (const [fn, url] of [
      ['listCategories', '/categories'],
      ['getCategory', '/categories/auto_services'],
      ['listServiceTypes', '/service-types'],
      ['getServiceType', '/service-types/car_detailing'],
    ] as const) {
      catalog[fn].mockRejectedValueOnce(new CatalogError('UNAVAILABLE', 'driver text: connect ECONNREFUSED 10.9.9.9:5432'));
      const res = await call('GET', url, t);
      expect(res.statusCode, fn).toBe(503);
      expect(res.body).not.toContain('ECONNREFUSED');
      expect(res.body).not.toContain('10.9.9.9');
    }
  });

  it('strips the cause and the constraint name from the details and never returns driver, SQL or table text for UNAVAILABLE', async () => {
    const t = await adminToken([WRITE]);
    const create = ROUTES.find((r) => r.fn === 'createCategory')!;
    catalog.createCategory.mockRejectedValueOnce(
      new CatalogError('VALIDATION_FAILED', 'a required field is missing', {
        constraint: 'fk_categories__name_content_key',
        cause: new Error('pg: password authentication failed'),
        reason: 'X',
      }),
    );
    const r = await call('POST', '/categories', t, create.body);
    expect(errorOf(r).details).toEqual({ reason: 'X' });
    expect(r.body).not.toContain('fk_categories');
    expect(r.body).not.toContain('password');
    catalog.createCategory.mockRejectedValueOnce(
      new CatalogError('UNAVAILABLE', 'the catalogue database is unavailable', { cause: new Error('ECONNREFUSED 10.0.0.5'), host: '10.0.0.5' }),
    );
    const u = await call('POST', '/categories', t, create.body);
    expect(u.statusCode).toBe(503);
    expect(u.body).not.toContain('10.0.0.5');
    expect(u.body).not.toContain('database');
  });

  it('details are an ALLOW-list: sql, detail, table, host, cause, constraint and any unknown key are dropped on EVERY route and error path', async () => {
    const t = await adminToken([READ, WRITE]);
    const hostile = (): Record<string, unknown> => ({
      reason: 'CATEGORY_NOT_ACTIVE',
      field: 'displayOrder',
      code: 'some_code',
      retryable: true,
      sql: 'SELECT secret FROM catalog.categories',
      detail: 'Key (code)=(x) already exists',
      table: 'categories',
      host: '10.0.0.5',
      schema: 'catalog',
      value: 'hunter2',
      constraint: 'fk_categories__name_content_key',
      cause: new Error('pg: password authentication failed'),
      nested: { reason: 'sneaky' },
    });
    const expected = { reason: 'CATEGORY_NOT_ACTIVE', field: 'displayOrder', code: 'some_code', retryable: true };
    const forbidden = ['SELECT', 'already exists', 'categories', '10.0.0.5', 'hunter2', 'fk_', 'password', 'sneaky', '"sql"', '"table"', '"host"', '"nested"'];
    for (const ec of CATALOG_ERROR_CODES.filter((c) => c !== 'UNAVAILABLE')) {
      for (const r of ROUTES) {
        catalog[r.fn].mockRejectedValueOnce(new CatalogError(ec, 'fixed message', hostile()));
        const res = await call(r.method, r.url, r.perm === 'public' ? undefined : t, r.body);
        expect(errorOf(res).details, `${ec} ${r.operationId}`).toEqual(expected);
        for (const w of forbidden) expect(res.body.replace(/"message":"[^"]*"/, ''), `${ec} ${r.operationId} ${w}`).not.toContain(w);
      }
      // the management reads on the shared routes
      for (const [fn, url] of [
        ['listCategories', '/categories'],
        ['getCategory', '/categories/auto_services'],
        ['listServiceTypes', '/service-types'],
        ['getServiceType', '/service-types/car_detailing'],
        ['getMarketDefaultLocale', '/categories?market=la-oc'],
        ['getMarketDefaultLocale', '/service-types/car_detailing?market=la-oc'],
      ] as const) {
        catalog[fn].mockRejectedValueOnce(new CatalogError(ec, 'fixed message', hostile()));
        const res = await call('GET', url, t);
        expect(errorOf(res).details, `${ec} ${fn}`).toEqual(expected);
      }
    }
    // UNAVAILABLE carries no details at all, whatever the service put in
    catalog.createCategory.mockRejectedValueOnce(new CatalogError('UNAVAILABLE', 'driver text', hostile()));
    const down = await call('POST', '/categories', t, ROUTES.find((x) => x.fn === 'createCategory')!.body);
    expect(down.statusCode).toBe(503);
    expect(errorOf(down).details).toBeUndefined();
    for (const w of forbidden) expect(down.body).not.toContain(w);
  });

  it('safeDetails: only short machine tokens survive (non-string, blank, spaced, injected or over-long values are dropped or cut to 64); retryable only when exactly true', async () => {
    const { safeDetails } = await import('./modules/catalog/dto');
    expect(safeDetails({})).toEqual({});
    expect(safeDetails({ reason: 'A_B-c.d9', field: 'f', code: 'x' })).toEqual({ reason: 'A_B-c.d9', field: 'f', code: 'x' });
    for (const bad of [
      12,
      true,
      null,
      undefined,
      ['A'],
      { a: 1 },
      '',
      ' ',
      'two words',
      'quote"',
      "it's",
      'a/b',
      'a;b',
      'a\nb',
      'a\u0000b',
      `caf${String.fromCharCode(0xe9)}`,
      '<script>',
      'SELECT * FROM x',
    ])
      expect(safeDetails({ reason: bad, field: bad, code: bad }), JSON.stringify(bad)).toEqual({});
    expect(safeDetails({ code: 'a'.repeat(100) })).toEqual({ code: 'a'.repeat(64) });
    expect(safeDetails({ reason: 'a'.repeat(64) })).toEqual({ reason: 'a'.repeat(64) });
    for (const r of ['true', 1, 'yes', false, null, undefined, {}]) expect(safeDetails({ retryable: r }), String(r)).toEqual({});
    expect(safeDetails({ retryable: true })).toEqual({ retryable: true });
    expect(safeDetails({ constraint: 'x', cause: 'y', message: 'z', stack: 's', details: { reason: 'r' } })).toEqual({});
    expect(Object.keys(safeDetails({ reason: 'r', field: 'f', code: 'c', retryable: true, extra: 1 })).sort()).toEqual([
      'code',
      'field',
      'reason',
      'retryable',
    ]);
  });

  it('a non-CatalogError failure of a mutation is a generic 500 (no internal text)', async () => {
    const t = await adminToken([WRITE]);
    for (const r of WRITES) {
      catalog[r.fn].mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint "uq_categories__code" password=hunter2'), { code: '23505' }),
      );
      const res = await call(r.method, r.url, t, r.body);
      expect(res.statusCode, r.operationId).toBe(500);
      expect(errorOf(res).code).toBe('INTERNAL_ERROR');
      expect(res.body).not.toContain('hunter2');
      expect(res.body).not.toContain('uq_categories');
    }
  });
});

// ====================================================================== composition helpers
describe("createMarketGate (the public visibility of a market is the geography registry's decision)", () => {
  const market = { code: 'us-sf', defaultLocale: 'en-US', name: 'SF', status: 'ACTIVE' };
  it('answers {code, defaultLocale} for a public market and asks geography with the code ONLY (the public view, never the management one)', async () => {
    const getMarket = vi.fn().mockResolvedValue(market);
    expect(await createMarketGate({ getMarket }).publicMarket('us-sf')).toEqual({ code: 'us-sf', defaultLocale: 'en-US' });
    expect(getMarket).toHaveBeenCalledTimes(1);
    expect(getMarket.mock.calls[0]).toEqual(['us-sf']);
  });
  it('answers null for MARKET_NOT_FOUND (unknown, PLANNED, INACTIVE, out of window are all the same to geography)', async () => {
    const getMarket = vi.fn().mockRejectedValue(new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code: 'la-oc' }));
    expect(await createMarketGate({ getMarket }).publicMarket('la-oc')).toBeNull();
  });
  it('maps a geography outage to the typed catalogue UNAVAILABLE (never to "not public")', async () => {
    const getMarket = vi.fn().mockRejectedValue(new GeographyError('UNAVAILABLE', 'registry down'));
    const err = await createMarketGate({ getMarket })
      .publicMarket('us-sf')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogError);
    expect((err as CatalogError).code).toBe('UNAVAILABLE');
    expect((err as CatalogError).message).not.toContain('registry down');
  });
  it('lets any other error propagate unchanged (other geography codes, programming errors)', async () => {
    const other = new GeographyError('VALIDATION_FAILED', 'x');
    expect(
      await createMarketGate({ getMarket: vi.fn().mockRejectedValue(other) })
        .publicMarket('us-sf')
        .catch((e: unknown) => e),
    ).toBe(other);
    const plain = new TypeError('boom');
    expect(
      await createMarketGate({ getMarket: vi.fn().mockRejectedValue(plain) })
        .publicMarket('us-sf')
        .catch((e: unknown) => e),
    ).toBe(plain);
  });
  it('through the HTTP layer, the real gate + a throwing geography outage is a 503 and an unknown market a 404', async () => {
    // a gate-backed fake of the service: the same two behaviours as CatalogService.publicMarketOrThrow
    const gate = createMarketGate({
      getMarket: vi.fn().mockImplementation(async (c: string) => {
        if (c === 'down') throw new GeographyError('UNAVAILABLE', 'x');
        if (c !== 'us-sf') throw new GeographyError('MARKET_NOT_FOUND', 'x');
        return market;
      }),
    });
    catalog.listCategoriesForMarket.mockImplementation(async (m: string) => {
      const pm = await gate.publicMarket(m);
      if (!pm) throw marketNotFound(m);
      return { market: pm, categories: PUBLIC_CATEGORIES.map(publicCat) };
    });
    expect((await call('GET', '/categories?market=down')).statusCode).toBe(503);
    expect((await call('GET', '/categories?market=other')).statusCode).toBe(404);
    expect((await call('GET', '/categories?market=us-sf')).statusCode).toBe(200);
  });
});

describe('composeScopeReferenceValidators (the CATEGORY scope joins the geography scopes)', () => {
  const valid = { valid: true } as const;
  const refuse = (reason: string) => ({ valid: false, reason }) as const;
  const v = (fn: (t: string, r: string | null | undefined) => unknown) => ({
    validate: vi.fn(async (t: string, r: string | null | undefined) => fn(t, r) as never),
  });
  it('is valid when there are no validators or when nobody owns the type', async () => {
    expect(await composeScopeReferenceValidators([]).validate('GIG', 'x')).toEqual(valid);
    expect(await composeScopeReferenceValidators([v(() => valid), v(() => valid)]).validate('PLATFORM', null)).toEqual(valid);
  });
  it('the FIRST refusal wins and the later validators are not asked', async () => {
    const a = v((t) => (t === 'MARKET' ? refuse('geo says no') : valid));
    const b = v(() => refuse('catalog says no'));
    const c = v(() => valid);
    const composed = composeScopeReferenceValidators([a, b, c]);
    expect(await composed.validate('MARKET', 'la-oc')).toEqual(refuse('geo says no'));
    expect(b.validate).not.toHaveBeenCalled();
    expect(c.validate).not.toHaveBeenCalled();
    expect(await composed.validate('CATEGORY', 'x_y')).toEqual(refuse('catalog says no'));
    expect(a.validate).toHaveBeenCalledTimes(2);
    expect(c.validate).not.toHaveBeenCalled();
  });
  it('asks the validators in the given order with the unchanged arguments', async () => {
    const order: string[] = [];
    const mk = (n: string) => v(() => (order.push(n), valid));
    const composed = composeScopeReferenceValidators([mk('a'), mk('b'), mk('c')]);
    await composed.validate('CATEGORY', 'auto_services');
    expect(order).toEqual(['a', 'b', 'c']);
    const one = v(() => valid);
    await composeScopeReferenceValidators([one]).validate('CATEGORY', undefined);
    expect(one.validate).toHaveBeenCalledWith('CATEGORY', undefined);
  });
  it('an outage propagates from whichever validator raises it, and the later validators are not asked', async () => {
    const boom = new CatalogError('UNAVAILABLE', 'down');
    const a = v(() => valid);
    const b = { validate: vi.fn().mockRejectedValue(boom) };
    const c = v(() => valid);
    await expect(composeScopeReferenceValidators([a, b, c]).validate('CATEGORY', 'x_y')).rejects.toBe(boom);
    expect(c.validate).not.toHaveBeenCalled();
    const first = { validate: vi.fn().mockRejectedValue(boom) };
    const second = v(() => valid);
    await expect(composeScopeReferenceValidators([first, second]).validate('MARKET', 'us-sf')).rejects.toBe(boom);
    expect(second.validate).not.toHaveBeenCalled();
  });
  it('a refusal reached after a valid answer is returned as is (no merging, no rewording)', async () => {
    const reason = 'the scope reference is not valid';
    const composed = composeScopeReferenceValidators([v(() => valid), v(() => refuse(reason))]);
    expect(await composed.validate('CATEGORY', 'gone')).toEqual({ valid: false, reason });
  });
});
