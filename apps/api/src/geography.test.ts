// Unit tests of the geography API module with a fake service (the real rules are covered by packages/geography and geography.itest.ts):
// authentication and authorization on every route, public versus management views, exact DTO key sets, request validation, error mapping.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { ErrorResponse, GEOGRAPHY_ERROR_CODES, type CountryDto, type GeographyErrorCode, type MarketDto } from '@bananagig/contracts';
import { GeographyError, type GeographyService } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, MAX_PATH_PARAM_LENGTH } from './app';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let app: FastifyInstance;

const svc = {
  listCountries: vi.fn(),
  getCountry: vi.fn(),
  listMarkets: vi.fn(),
  getMarket: vi.fn(),
  resolveMarketDefaults: vi.fn(),
  listCurrencies: vi.fn(),
  listTimeZones: vi.fn(),
  getMarketReadiness: vi.fn(),
  createCountry: vi.fn(),
  updateCountry: vi.fn(),
  setCountryActive: vi.fn(),
  createMarket: vi.fn(),
  updateMarket: vi.fn(),
  setMarketActive: vi.fn(),
};

const READ = 'geography-read';
const WRITE = 'geography-write';
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
type Method = 'GET' | 'POST' | 'PUT';
const call = async (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url: `/api/v1/geography${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const keysOf = (o: object) => Object.keys(o).sort();
const noMocksCalled = () => Object.values(svc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures (management shape; the fake strips it for the public view like the real service)
const T0 = '2026-01-01T00:00:00.000Z';
const country = (code: string, status: string, over: Partial<CountryDto> = {}): CountryDto => ({
  code,
  alpha3: `${code}X`,
  numeric: '840',
  displayNameContentKey: 'geography.country.us.name',
  dialingCode: '+1',
  defaultCurrencyCode: 'USD',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  timeZones: ['America/Denver'],
  distanceUnit: 'MILES',
  firstDayOfWeek: 'SUNDAY',
  dateFormat: 'MDY',
  timeFormat: '12_HOUR',
  status: status as CountryDto['status'],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const market = (code: string, status: string, over: Partial<MarketDto> = {}): MarketDto => ({
  code,
  name: `Market ${code}`,
  countryCode: 'US',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  currencyCode: 'USD',
  defaultTimeZone: 'America/Denver',
  effectiveFrom: T0,
  effectiveTo: null,
  status: status as MarketDto['status'],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const COUNTRIES = [country('US', 'ACTIVE'), country('CA', 'PLANNED'), country('FR', 'INACTIVE')];
const MARKETS = [market('us-sf', 'ACTIVE'), market('la-oc', 'PLANNED'), market('old-mkt', 'INACTIVE')];
const CURRENCIES = [
  { code: 'USD', numericCode: '840', minorUnitDigits: 2, displayName: 'US Dollar', symbol: '$', status: 'ACTIVE' },
  { code: 'JPY', numericCode: '392', minorUnitDigits: 0, displayName: 'Yen', symbol: null, status: 'PLANNED' },
];
const ZONES = [
  { ianaName: 'America/Denver', status: 'ACTIVE' },
  { ianaName: 'Asia/Tokyo', status: 'PLANNED' },
];
const DEFAULTS = {
  market: { code: 'us-sf', name: 'Market us-sf', countryCode: 'US' },
  country: { code: 'US', dialingCode: '+1' },
  currency: { code: 'USD', minorUnitDigits: 2, symbol: '$' },
  locale: 'en-US',
  supportedLocales: ['en-US'],
  timeZone: 'America/Denver',
  distanceUnit: 'MILES',
  firstDayOfWeek: 'SUNDAY',
  dateFormat: 'MDY',
  timeFormat: '12_HOUR',
  effectiveFrom: T0,
  effectiveTo: null,
};
const READINESS = { market: 'la-oc', ready: false, checks: [{ code: 'COUNTRY_ACTIVE', passed: false, detail: 'country US is PLANNED' }] };

const PUBLIC_COUNTRY_KEYS = [
  'alpha3',
  'code',
  'dateFormat',
  'defaultCurrencyCode',
  'defaultLocale',
  'dialingCode',
  'displayNameContentKey',
  'distanceUnit',
  'firstDayOfWeek',
  'numeric',
  'supportedLocales',
  'timeFormat',
  'timeZones',
];
const MGMT_COUNTRY_KEYS = [...PUBLIC_COUNTRY_KEYS, 'createdAt', 'status', 'updatedAt'].sort();
const PUBLIC_MARKET_KEYS = [
  'code',
  'countryCode',
  'currencyCode',
  'defaultLocale',
  'defaultTimeZone',
  'effectiveFrom',
  'effectiveTo',
  'name',
  'supportedLocales',
];
const MGMT_MARKET_KEYS = [...PUBLIC_MARKET_KEYS, 'createdAt', 'status', 'updatedAt'].sort();
const PUBLIC_CURRENCY_KEYS = ['code', 'displayName', 'minorUnitDigits', 'numericCode', 'symbol'];
const INTERNAL_WORDS = ['actor', 'audit', 'readiness', 'checks', 'createdBy', 'correlation'];

const validCountry = {
  code: 'ZZ',
  alpha3: 'ZZZ',
  numeric: '999',
  displayNameContentKey: 'geography.country.zz.name',
  dialingCode: '+999',
  defaultCurrencyCode: 'USD',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  timeZones: ['America/Denver'],
  distanceUnit: 'MILES',
  firstDayOfWeek: 'SUNDAY',
  dateFormat: 'MDY',
  timeFormat: '12_HOUR',
  reason: 'unit test',
};
const validMarket = {
  code: 'devtest-m1',
  name: 'Test Market',
  countryCode: 'US',
  defaultLocale: 'en-US',
  currencyCode: 'USD',
  defaultTimeZone: 'America/Denver',
  reason: 'unit test',
};

/** The fake behaves like the real service for visibility: the public view hides non-ACTIVE rows and the management-only fields. */
const publicCountry = (c: CountryDto): CountryDto => {
  const { status: _s, createdAt: _c, updatedAt: _u, ...rest } = c;
  return rest;
};
const publicMarket = (m: MarketDto): MarketDto => {
  const { status: _s, createdAt: _c, updatedAt: _u, ...rest } = m;
  return rest;
};
const notFound = (kind: 'COUNTRY' | 'MARKET', code: string) => new GeographyError(`${kind}_NOT_FOUND`, `the ${kind.toLowerCase()} is not registered`, { code });

beforeAll(async () => {
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({ cfg, verifier, configuration: {} as never, geography: svc as unknown as GeographyService, readiness: async () => ({}) });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.listCountries.mockImplementation(async (o: { management?: boolean } = {}) =>
    o.management ? COUNTRIES : COUNTRIES.filter((c) => c.status === 'ACTIVE').map(publicCountry),
  );
  svc.getCountry.mockImplementation(async (code: string, o: { management?: boolean } = {}) => {
    const c = COUNTRIES.find((x) => x.code === code && (o.management || x.status === 'ACTIVE'));
    if (!c) throw notFound('COUNTRY', code);
    return o.management ? c : publicCountry(c);
  });
  svc.listMarkets.mockImplementation(async (o: { management?: boolean; countryCode?: string } = {}) =>
    MARKETS.filter((m) => (o.management || m.status === 'ACTIVE') && (!o.countryCode || m.countryCode === o.countryCode)).map((m) =>
      o.management ? m : publicMarket(m),
    ),
  );
  svc.getMarket.mockImplementation(async (code: string, o: { management?: boolean } = {}) => {
    const m = MARKETS.find((x) => x.code === code && (o.management || x.status === 'ACTIVE'));
    if (!m) throw notFound('MARKET', code);
    return o.management ? m : publicMarket(m);
  });
  svc.resolveMarketDefaults.mockImplementation(async (code: string, o: { includeInactive?: boolean } = {}) => {
    const m = MARKETS.find((x) => x.code === code && (o.includeInactive || x.status === 'ACTIVE'));
    if (!m) throw notFound('MARKET', code);
    return { ...DEFAULTS, market: { ...DEFAULTS.market, code } };
  });
  svc.listCurrencies.mockImplementation(async (o: { management?: boolean } = {}) =>
    CURRENCIES.filter((c) => o.management || c.status === 'ACTIVE').map(({ status, ...rest }) => (o.management ? { ...rest, status } : rest)),
  );
  svc.listTimeZones.mockImplementation(async (o: { management?: boolean } = {}) =>
    ZONES.filter((z) => o.management || z.status === 'ACTIVE').map((z) => (o.management ? z : { ianaName: z.ianaName })),
  );
  svc.getMarketReadiness.mockResolvedValue(READINESS);
  svc.createCountry.mockResolvedValue(country('ZZ', 'PLANNED'));
  svc.updateCountry.mockResolvedValue(country('ZZ', 'PLANNED'));
  svc.setCountryActive.mockResolvedValue(country('ZZ', 'ACTIVE'));
  svc.createMarket.mockResolvedValue(market('devtest-m1', 'PLANNED'));
  svc.updateMarket.mockResolvedValue(market('devtest-m1', 'PLANNED'));
  svc.setMarketActive.mockResolvedValue(market('devtest-m1', 'ACTIVE'));
});

// ====================================================================== access control
type Route = { method: Method; url: string; permission: string; body?: unknown };
const protectedRoutes: Route[] = [
  { method: 'GET', url: '/markets/la-oc/readiness', permission: READ },
  { method: 'POST', url: '/countries', permission: WRITE, body: validCountry },
  { method: 'PUT', url: '/countries/ZZ', permission: WRITE, body: { dialingCode: '+998', reason: 'r' } },
  { method: 'POST', url: '/countries/ZZ/activation', permission: WRITE, body: { active: true, reason: 'r' } },
  { method: 'POST', url: '/markets', permission: WRITE, body: validMarket },
  { method: 'PUT', url: '/markets/devtest-m1', permission: WRITE, body: { name: 'New', reason: 'r' } },
  { method: 'POST', url: '/markets/devtest-m1/activation', permission: WRITE, body: { active: true, reason: 'r' } },
];
const bodiless = (r: Route) => (r.method === 'GET' ? [undefined] : [undefined, {}, { garbage: true }]);

describe('geography API access control (management routes)', () => {
  it('returns 401 before any validation on every management route, with an empty, invalid or missing body and malformed params', async () => {
    for (const r of protectedRoutes) {
      for (const payload of bodiless(r)) {
        const res = await call(r.method, r.url, undefined, payload);
        expect(res.statusCode, `${r.method} ${r.url} ${JSON.stringify(payload)}`).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
        expect(res.headers['www-authenticate']).toContain('Bearer');
      }
    }
    for (const [m, u] of [
      ['GET', '/markets/NOT_A_CODE/readiness'],
      ['POST', '/countries/zz/activation'],
      ['PUT', '/countries/ZZZ'],
      ['PUT', '/markets/BAD_CODE'],
      ['POST', '/markets/BAD_CODE/activation'],
    ] as const)
      expect((await call(m, u, undefined, m === 'GET' ? undefined : {})).statusCode, `${m} ${u}`).toBe(401);
    for (const r of protectedRoutes) expect((await call(r.method, r.url, 'not.a.token', r.method === 'GET' ? undefined : {})).statusCode).toBe(401);
    expect(noMocksCalled()).toBe(true);
  });

  it('returns 403 (before validation) when an admin lacks the permission: geography-read cannot write, and no role at all cannot do anything', async () => {
    for (const r of protectedRoutes) {
      // geography-write implies read (see the next test), so only a read-only token and a token without any geography role are refused on the read route
      const refused = r.permission === READ ? [[]] : [[READ], []];
      for (const roles of refused) {
        const res = await call(r.method, r.url, await adminToken(roles), r.method === 'GET' ? undefined : {});
        expect(res.statusCode, `${r.method} ${r.url} [${roles}]`).toBe(403);
        expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
      }
    }
    expect(noMocksCalled()).toBe(true);
  });

  it('geography-write implies read: a write-only token gets the management view of the reads and the readiness endpoint, a read-only token still cannot write', async () => {
    const writeOnly = await adminToken([WRITE]);
    const readOnly = await adminToken([READ]);
    // the readiness endpoint
    const ready = await call('GET', '/markets/la-oc/readiness', writeOnly);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data).toEqual(READINESS);
    // the management view of every public read route, including PLANNED and INACTIVE rows (404 for public callers)
    expect((await call('GET', '/countries', writeOnly)).json().data.map((c: { code: string }) => c.code)).toEqual(['US', 'CA', 'FR']);
    expect(keysOf((await call('GET', '/countries/CA', writeOnly)).json().data)).toEqual(MGMT_COUNTRY_KEYS);
    expect((await call('GET', '/countries/FR', writeOnly)).json().data.status).toBe('INACTIVE');
    expect((await call('GET', '/markets', writeOnly)).json().data.map((m: { code: string }) => m.code)).toEqual(['us-sf', 'la-oc', 'old-mkt']);
    expect(keysOf((await call('GET', '/markets/la-oc', writeOnly)).json().data)).toEqual(MGMT_MARKET_KEYS);
    expect((await call('GET', '/markets/la-oc/defaults', writeOnly)).statusCode).toBe(200);
    expect((await call('GET', '/currencies', writeOnly)).json().data.map((c: { status: string }) => c.status)).toEqual(['ACTIVE', 'PLANNED']);
    expect((await call('GET', '/time-zones', writeOnly)).json().data).toEqual(ZONES);
    expect(svc.getMarket).toHaveBeenCalledWith('la-oc', { management: true });
    expect(svc.resolveMarketDefaults).toHaveBeenLastCalledWith('la-oc', { includeInactive: true });
    // the same token reads back what it wrote: a mutation response and the matching GET agree on the view
    const written = await call('POST', '/markets/devtest-m1/activation', writeOnly, { active: true, reason: 'r' });
    expect(keysOf(written.json().data)).toEqual(MGMT_MARKET_KEYS);
    expect((await call('GET', '/markets/old-mkt', writeOnly)).statusCode).toBe(200);
    // the reverse never holds
    for (const r of protectedRoutes.filter((x) => x.permission === WRITE)) {
      const res = await call(r.method, r.url, readOnly, r.body);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
    // and neither the content nor the configuration roles grant anything (read included)
    const foreign = await adminToken([
      'content-read',
      'content-write',
      'content-approve',
      'content-legal',
      'configuration-read',
      'configuration-write',
      'configuration-approve',
    ]);
    expect((await call('GET', '/markets/la-oc/readiness', foreign)).statusCode).toBe(403);
    expect((await call('GET', '/markets/la-oc', foreign)).statusCode).toBe(404);
    expect((await call('GET', '/markets', foreign)).json().data.map((m: { code: string }) => m.code)).toEqual(['us-sf']);
  });

  it('does not let the content or configuration roles (or anything else) grant geography access', async () => {
    const foreign = ['content-read', 'content-write', 'content-approve', 'content-legal', 'configuration-read', 'configuration-write', 'configuration-approve'];
    for (const r of protectedRoutes) {
      const res = await call(r.method, r.url, await adminToken(foreign), r.method === 'GET' ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
    expect(noMocksCalled()).toBe(true);
  });

  it('keeps customers, web-client tokens and other clients out even when they carry the role names', async () => {
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const spoofedOnWebClient = await signToken(keys, { claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [READ, WRITE] } } } });
    const adminRolesFromOtherClient = await signToken(keys, {
      claims: { azp: 'bananagig-dev-test', resource_access: { 'bananagig-admin': { roles: [READ, WRITE] } } },
    });
    for (const t of [customer, spoofedOnWebClient, adminRolesFromOtherClient]) {
      for (const r of protectedRoutes) {
        const res = await call(r.method, r.url, t, r.method === 'GET' ? undefined : {});
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      }
    }
    expect(noMocksCalled()).toBe(true);
  });

  it('with the right permission: validates the body (400), calls the service with the token subject as actor, and returns the management view', async () => {
    const t = await adminToken([READ, WRITE]);
    for (const r of protectedRoutes) {
      const ok = await call(r.method, r.url, t, r.body);
      expect(ok.statusCode, `${r.method} ${r.url}`).toBe(r.method === 'POST' && r.url.split('/').length === 2 ? 201 : 200);
      if (r.method !== 'GET') {
        const bad = await call(r.method, r.url, t, {});
        expect(bad.statusCode, `${r.method} ${r.url} empty`).toBe(400);
        expect(errorOf(bad)).toMatchObject({ category: 'VALIDATION' });
      }
    }
    expect(svc.createCountry).toHaveBeenCalledWith(expect.objectContaining({ code: 'ZZ', reason: 'unit test' }), 'admin-a');
    expect(svc.updateCountry).toHaveBeenCalledWith('ZZ', { dialingCode: '+998', reason: 'r' }, 'admin-a');
    expect(svc.setCountryActive).toHaveBeenCalledWith('ZZ', true, 'r', 'admin-a');
    expect(svc.createMarket).toHaveBeenCalledWith(expect.objectContaining({ code: 'devtest-m1' }), 'admin-a');
    expect(svc.updateMarket).toHaveBeenCalledWith('devtest-m1', { name: 'New', reason: 'r' }, 'admin-a');
    expect(svc.setMarketActive).toHaveBeenCalledWith('devtest-m1', true, 'r', 'admin-a');
    expect(svc.getMarketReadiness).toHaveBeenCalledWith('la-oc');
    // mutations answer with the management view of the stored row
    const created = await call('POST', '/countries', t, validCountry);
    expect(created.statusCode).toBe(201);
    expect(keysOf(created.json().data)).toEqual(MGMT_COUNTRY_KEYS);
    const m = await call('POST', '/markets', t, validMarket);
    expect(m.statusCode).toBe(201);
    expect(keysOf(m.json().data)).toEqual(MGMT_MARKET_KEYS);
    expect(keysOf((await call('POST', '/markets/devtest-m1/activation', t, { active: true, reason: 'r' })).json().data)).toEqual(MGMT_MARKET_KEYS);
  });

  it('rejects unknown fields, wrong types and malformed bodies with the standard 400 (never stripped, never passed to the service)', async () => {
    const t = await adminToken([READ, WRITE]);
    const cases: [Method, string, unknown][] = [
      ['POST', '/countries', { ...validCountry, extra: 1 }],
      ['POST', '/countries', { ...validCountry, code: 'zz' }],
      ['POST', '/countries', { ...validCountry, code: 'ZZZ' }],
      ['POST', '/countries', { ...validCountry, distanceUnit: 'FURLONGS' }],
      ['POST', '/countries', { ...validCountry, timeFormat: '36_HOUR' }],
      ['POST', '/countries', { ...validCountry, supportedLocales: [] }],
      ['POST', '/countries', { ...validCountry, reason: '' }],
      ['PUT', '/countries/ZZ', { code: 'YY', reason: 'r' }], // identity cannot change
      ['PUT', '/countries/ZZ', { dialingCode: '+1' }], // reason required
      ['PUT', '/countries/ZZ', { dialingCode: '+1', reason: 'r', extra: true }],
      ['POST', '/countries/ZZ/activation', { active: 'yes', reason: 'r' }],
      ['POST', '/countries/ZZ/activation', { active: true }],
      ['POST', '/countries/ZZ/activation', { active: true, reason: 'r', extra: 1 }],
      ['POST', '/markets', { ...validMarket, code: 'Bad_Code' }],
      ['POST', '/markets', { ...validMarket, countryCode: 'us' }],
      ['POST', '/markets', { ...validMarket, extra: 1 }],
      ['POST', '/markets', { ...validMarket, effectiveFrom: 'yesterday' }],
      ['PUT', '/markets/devtest-m1', { countryCode: 'CA', reason: 'r' }], // identity cannot change
      ['PUT', '/markets/devtest-m1', { code: 'other', reason: 'r' }],
      ['POST', '/markets/devtest-m1/activation', { reason: 'r' }],
    ];
    for (const [m, u, body] of cases) {
      const res = await call(m, u, t, body);
      expect(res.statusCode, `${m} ${u} ${JSON.stringify(body)}`).toBe(400);
      expect(errorOf(res).category).toBe('VALIDATION');
    }
    expect((await call('POST', '/countries', t)).statusCode).toBe(400);
    expect(svc.createCountry).not.toHaveBeenCalled();
    expect(svc.updateCountry).not.toHaveBeenCalled();
    expect(svc.setCountryActive).not.toHaveBeenCalled();
    expect(svc.createMarket).not.toHaveBeenCalled();
    expect(svc.updateMarket).not.toHaveBeenCalled();
    expect(svc.setMarketActive).not.toHaveBeenCalled();
  });
});

// ====================================================================== public routes
describe('geography API public reads', () => {
  const anonymous = async () => ({ token: undefined as string | undefined, label: 'anonymous' });
  const nonPrivileged = async () => [
    await anonymous(),
    { token: await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } }), label: 'customer' },
    {
      token: await signToken(keys, { claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [READ, WRITE] } } } }),
      label: 'web client with the role names',
    },
    { token: await adminToken(['content-read', 'configuration-read']), label: 'admin without geography-read' },
  ];

  it('serves every public route anonymously with the exact public key sets and ACTIVE data only', async () => {
    const countries = await call('GET', '/countries');
    expect(countries.statusCode).toBe(200);
    expect(countries.json().data.map((c: { code: string }) => c.code)).toEqual(['US']);
    expect(keysOf(countries.json().data[0])).toEqual(PUBLIC_COUNTRY_KEYS);
    expect(keysOf(countries.json().meta)).toEqual(['correlationId']);

    const one = await call('GET', '/countries/US');
    expect(keysOf(one.json().data)).toEqual(PUBLIC_COUNTRY_KEYS);

    const markets = await call('GET', '/markets');
    expect(markets.json().data.map((m: { code: string }) => m.code)).toEqual(['us-sf']);
    expect(keysOf(markets.json().data[0])).toEqual(PUBLIC_MARKET_KEYS);
    expect(keysOf((await call('GET', '/markets/us-sf')).json().data)).toEqual(PUBLIC_MARKET_KEYS);
    expect((await call('GET', '/markets?countryCode=US')).json().data).toHaveLength(1);
    expect((await call('GET', '/markets?countryCode=CA')).json().data).toHaveLength(0);

    const defaults = await call('GET', '/markets/us-sf/defaults');
    expect(defaults.statusCode).toBe(200);
    expect(keysOf(defaults.json().data)).toEqual(
      [
        'market',
        'country',
        'currency',
        'locale',
        'supportedLocales',
        'timeZone',
        'distanceUnit',
        'firstDayOfWeek',
        'dateFormat',
        'timeFormat',
        'effectiveFrom',
        'effectiveTo',
      ].sort(),
    );
    expect(keysOf(defaults.json().data.market)).toEqual(['code', 'countryCode', 'name']);
    expect(keysOf(defaults.json().data.country)).toEqual(['code', 'dialingCode']);
    expect(keysOf(defaults.json().data.currency)).toEqual(['code', 'minorUnitDigits', 'symbol']);

    const currencies = await call('GET', '/currencies');
    expect(currencies.json().data.map((c: { code: string }) => c.code)).toEqual(['USD']);
    expect(keysOf(currencies.json().data[0])).toEqual(PUBLIC_CURRENCY_KEYS);
    const zones = await call('GET', '/time-zones');
    expect(zones.json().data).toEqual([{ ianaName: 'America/Denver' }]);

    for (const r of [countries, one, markets, defaults, currencies, zones]) {
      for (const w of [...INTERNAL_WORDS, 'status', 'createdAt', 'updatedAt']) expect(r.body, w).not.toContain(w === 'checks' ? '"checks"' : `"${w}"`);
    }
    // the public view is requested explicitly: no management flag for anonymous callers
    expect(svc.listCountries).toHaveBeenCalledWith({ management: false });
    expect(svc.getCountry).toHaveBeenCalledWith('US', { management: false });
    expect(svc.getMarket).toHaveBeenCalledWith('us-sf', { management: false });
    expect(svc.resolveMarketDefaults).toHaveBeenCalledWith('us-sf', { includeInactive: false });
    expect(svc.listMarkets).toHaveBeenCalledWith({ management: false, countryCode: undefined });
    expect(svc.listCurrencies).toHaveBeenCalledWith({ management: false });
    expect(svc.listTimeZones).toHaveBeenCalledWith({ management: false });
  });

  it('treats PLANNED and INACTIVE rows as not found for every non-privileged caller (identical to unknown codes)', async () => {
    for (const { token, label } of await nonPrivileged()) {
      for (const url of [
        '/countries/CA',
        '/countries/FR',
        '/countries/QQ',
        '/markets/la-oc',
        '/markets/old-mkt',
        '/markets/nowhere',
        '/markets/la-oc/defaults',
        '/markets/old-mkt/defaults',
      ]) {
        const res = await call('GET', url, token);
        expect(res.statusCode, `${label} ${url}`).toBe(404);
        expect(errorOf(res).category).toBe('NOT_FOUND');
      }
      const planned = await call('GET', '/countries/CA', token);
      const unknown = await call('GET', '/countries/QQ', token);
      expect(errorOf(planned).message).toBe(errorOf(unknown).message);
      expect(errorOf(planned).code).toBe(errorOf(unknown).code);
      expect(
        (await call('GET', '/countries', token)).json().data.map((c: { code: string }) => c.code),
        label,
      ).toEqual(['US']);
      expect(
        (await call('GET', '/markets', token)).json().data.map((c: { code: string }) => c.code),
        label,
      ).toEqual(['us-sf']);
      expect((await call('GET', '/currencies', token)).json().data, label).toHaveLength(1);
      expect((await call('GET', '/time-zones', token)).json().data, label).toHaveLength(1);
      expect(keysOf((await call('GET', '/countries/US', token)).json().data), label).toEqual(PUBLIC_COUNTRY_KEYS);
    }
    expect(svc.listCountries.mock.calls.every(([o]) => o.management === false)).toBe(true);
  });

  it('shows every status, the management-only fields and PLANNED/INACTIVE rows to the admin context with geography-read', async () => {
    const t = await adminToken([READ]);
    const countries = await call('GET', '/countries', t);
    expect(countries.json().data.map((c: { code: string; status: string }) => [c.code, c.status])).toEqual([
      ['US', 'ACTIVE'],
      ['CA', 'PLANNED'],
      ['FR', 'INACTIVE'],
    ]);
    expect(keysOf(countries.json().data[1])).toEqual(MGMT_COUNTRY_KEYS);
    expect((await call('GET', '/countries/CA', t)).json().data).toMatchObject({ code: 'CA', status: 'PLANNED', createdAt: T0, updatedAt: T0 });
    expect((await call('GET', '/countries/FR', t)).json().data.status).toBe('INACTIVE');
    expect((await call('GET', '/markets', t)).json().data.map((m: { code: string }) => m.code)).toEqual(['us-sf', 'la-oc', 'old-mkt']);
    expect(keysOf((await call('GET', '/markets/la-oc', t)).json().data)).toEqual(MGMT_MARKET_KEYS);
    expect((await call('GET', '/markets/old-mkt', t)).json().data.status).toBe('INACTIVE');
    expect((await call('GET', '/markets?countryCode=US', t)).json().data).toHaveLength(3);
    expect((await call('GET', '/currencies', t)).json().data.map((c: { code: string; status: string }) => [c.code, c.status])).toEqual([
      ['USD', 'ACTIVE'],
      ['JPY', 'PLANNED'],
    ]);
    expect((await call('GET', '/time-zones', t)).json().data).toEqual(ZONES);
    // defaults of a PLANNED market (management only)
    const d = await call('GET', '/markets/la-oc/defaults', t);
    expect(d.statusCode).toBe(200);
    expect(d.json().data.market.code).toBe('la-oc');
    expect(svc.resolveMarketDefaults).toHaveBeenLastCalledWith('la-oc', { includeInactive: true });
    expect(svc.getCountry).toHaveBeenCalledWith('CA', { management: true });
    // readiness
    const r = await call('GET', '/markets/la-oc/readiness', t);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual(READINESS);
    expect(keysOf(r.json().data.checks[0])).toEqual(['code', 'detail', 'passed']);
  });

  it('never exposes audit, actor or readiness fields in a public DTO even if the service returned them (defense in depth)', async () => {
    svc.getCountry.mockResolvedValue({ ...country('US', 'ACTIVE'), createdBy: 'staff-1', auditEvents: [{ actor: 'staff-1' }], readiness: { ready: true } });
    svc.getMarket.mockResolvedValue({ ...market('us-sf', 'ACTIVE'), createdBy: 'staff-1', actor: 'staff-1', readiness: { ready: true } });
    svc.resolveMarketDefaults.mockResolvedValue({ ...DEFAULTS, actor: 'staff-1', status: 'ACTIVE', readiness: {} });
    svc.listCurrencies.mockResolvedValue([{ ...CURRENCIES[0], actor: 'staff-1' }]);
    svc.listTimeZones.mockResolvedValue([{ ianaName: 'America/Denver', status: 'ACTIVE', actor: 'staff-1' }]);
    const c = await call('GET', '/countries/US');
    const m = await call('GET', '/markets/us-sf');
    const d = await call('GET', '/markets/us-sf/defaults');
    const cur = await call('GET', '/currencies');
    const tz = await call('GET', '/time-zones');
    expect(keysOf(c.json().data)).toEqual(PUBLIC_COUNTRY_KEYS);
    expect(keysOf(m.json().data)).toEqual(PUBLIC_MARKET_KEYS);
    expect(keysOf(d.json().data)).not.toContain('status');
    expect(keysOf(cur.json().data[0])).toEqual(PUBLIC_CURRENCY_KEYS);
    expect(tz.json().data).toEqual([{ ianaName: 'America/Denver' }]);
    for (const r of [c, m, d, cur, tz]) {
      expect(r.body).not.toContain('staff-1');
      expect(r.body).not.toContain('readiness');
    }
  });

  it('answers 401 for a credential that is presented but invalid, on every public route (never silently downgraded to anonymous)', async () => {
    const expired = await signToken(keys, { claims: { sub: 'x', azp: 'bananagig-admin' }, expiresInSec: -60 });
    const unsigned = unsignedToken({ azp: 'bananagig-admin' });
    for (const url of ['/countries', '/countries/US', '/markets', '/markets/us-sf', '/markets/us-sf/defaults', '/currencies', '/time-zones']) {
      for (const bad of ['not.a.token', expired, unsigned]) {
        const res = await call('GET', url, bad);
        expect(res.statusCode, `${url}`).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
      }
      const malformed = await app.inject({ method: 'GET', url: `/api/v1/geography${url}`, headers: { authorization: 'Basic abc' } });
      expect(malformed.statusCode, `${url} basic`).toBe(401);
    }
    expect(noMocksCalled()).toBe(true);
  });

  it('validates path parameters and rejects unknown query parameters (400) without calling the service', async () => {
    for (const url of [
      '/countries/us',
      '/countries/USA',
      '/countries/U',
      '/countries/1A',
      '/markets/LA-OC',
      '/markets/la_oc',
      '/markets/-la',
      '/markets/la--oc',
      '/markets/1abc',
      `/markets/${'a'.repeat(61)}`,
      `/markets/${'a'.repeat(61)}/defaults`,
      '/markets?countryCode=us',
      '/markets?countryCode=USA',
      '/markets?bogus=1',
    ]) {
      const res = await call('GET', url);
      expect(res.statusCode, url).toBe(400);
      expect(errorOf(res).category).toBe('VALIDATION');
    }
    const router = await call('GET', `/markets/${'a'.repeat(MAX_PATH_PARAM_LENGTH + 8)}`);
    expect(router.statusCode).toBe(400);
    expect(errorOf(router).code).toBe('PATH_PARAMETER_TOO_LONG');
    expect(noMocksCalled()).toBe(true);
    expect((await call('GET', '/markets/' + 'a'.repeat(60))).statusCode).toBe(404); // the longest valid code is routed to the service
  });

  it('is not registered when the app is built without a geography service', async () => {
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const bare = await buildApp({ cfg, verifier, configuration: {} as never, readiness: async () => ({}) });
    await bare.ready();
    expect((await bare.inject({ method: 'GET', url: '/api/v1/geography/countries' })).statusCode).toBe(404);
    await bare.close();
  });

  it('echoes the correlation id in the header and the response meta, for successes and errors', async () => {
    const ok = await call('GET', '/countries/US', undefined, undefined, { 'x-correlation-id': 'corr-geo-1' });
    expect(ok.json().meta.correlationId).toBe('corr-geo-1');
    expect(ok.headers['x-correlation-id']).toBe('corr-geo-1');
    const missing = await call('GET', '/countries/CA', undefined, undefined, { 'x-correlation-id': 'corr-geo-2' });
    expect(errorOf(missing).correlationId).toBe('corr-geo-2');
    expect(missing.headers['x-correlation-id']).toBe('corr-geo-2');
    const denied = await call('POST', '/countries', await adminToken([READ]), {}, { 'x-correlation-id': 'corr-geo-3' });
    expect(errorOf(denied).correlationId).toBe('corr-geo-3');
    const generated = await call('GET', '/currencies');
    expect(generated.json().meta.correlationId).toEqual(expect.any(String));
  });
});

// ====================================================================== review hardening
describe('geography API: planned retirement is management information (effectiveTo)', () => {
  const RETIRES = '2030-06-30T00:00:00.000Z';
  const retiring = market('us-sf', 'ACTIVE', { effectiveTo: RETIRES });

  it('returns effectiveTo null in the public market, list and defaults views even when the service returns a value, and the value to geography-read and geography-write', async () => {
    svc.getMarket.mockImplementation(async (_code: string, o: { management?: boolean } = {}) => (o.management ? retiring : publicMarket(retiring)));
    svc.listMarkets.mockImplementation(async (o: { management?: boolean } = {}) => [o.management ? retiring : publicMarket(retiring)]);
    svc.resolveMarketDefaults.mockResolvedValue({ ...DEFAULTS, effectiveTo: RETIRES });
    const nonPublic = [undefined, await adminToken(['content-read'])];
    for (const t of nonPublic) {
      const one = await call('GET', '/markets/us-sf', t);
      expect(one.json().data.effectiveTo, 'one').toBeNull();
      expect(keysOf(one.json().data)).toEqual(PUBLIC_MARKET_KEYS); // the key stays (the contract shape is unchanged), the value is null
      expect((await call('GET', '/markets', t)).json().data[0].effectiveTo, 'list').toBeNull();
      expect((await call('GET', '/markets/us-sf/defaults', t)).json().data.effectiveTo, 'defaults').toBeNull();
      expect((await call('GET', '/markets/us-sf', t)).body).not.toContain('2030-06-30');
    }
    for (const roles of [[READ], [WRITE]]) {
      const t = await adminToken(roles);
      expect((await call('GET', '/markets/us-sf', t)).json().data.effectiveTo, `one ${roles}`).toBe(RETIRES);
      expect((await call('GET', '/markets', t)).json().data[0].effectiveTo, `list ${roles}`).toBe(RETIRES);
      expect((await call('GET', '/markets/us-sf/defaults', t)).json().data.effectiveTo, `defaults ${roles}`).toBe(RETIRES);
    }
    // management mutation responses keep it
    svc.createMarket.mockResolvedValue(retiring);
    expect((await call('POST', '/markets', await adminToken([WRITE]), validMarket)).json().data.effectiveTo).toBe(RETIRES);
  });
});

describe('geography API: Vary: Authorization on every public read', () => {
  const publicGets = [
    '/countries',
    '/countries/US',
    '/countries/CA',
    '/markets',
    '/markets/us-sf',
    '/markets/la-oc',
    '/markets/us-sf/defaults',
    '/markets/la-oc/defaults',
    '/currencies',
    '/time-zones',
  ];
  const vary = (r: { headers: Record<string, unknown> }) =>
    String(r.headers['vary'] ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase());

  it('is present on successes, 404s and 401s, for anonymous and authenticated callers alike (a shared cache must not mix the views)', async () => {
    const tokens = [undefined, await adminToken([READ]), await adminToken(['content-read'])];
    for (const url of publicGets) {
      for (const t of tokens) {
        const r = await call('GET', url, t);
        expect([200, 404], `${url} ${r.statusCode}`).toContain(r.statusCode);
        expect(vary(r), `${url} ${r.statusCode} ${t ? 'token' : 'anonymous'}`).toContain('authorization');
      }
      const bad = await call('GET', url, 'not.a.token');
      expect(bad.statusCode).toBe(401);
      expect(vary(bad), `${url} 401`).toContain('authorization');
    }
    // a 400 from parameter validation is still a response of the public route
    expect(vary(await call('GET', '/markets/NOT_VALID'))).toContain('authorization');
    expect(vary(await call('GET', '/markets?bogus=1'))).toContain('authorization');
  });

  it('the body really does differ by credential (which is why the header matters) and is never duplicated or replaced', async () => {
    const anonymous = await call('GET', '/markets');
    const privileged = await call('GET', '/markets', await adminToken([READ]));
    expect(anonymous.json().data.length).not.toBe(privileged.json().data.length);
    expect(
      String(anonymous.headers['vary'])
        .toLowerCase()
        .match(/authorization/g),
    ).toHaveLength(1);
  });

  it('management routes are not public reads and carry no Vary of their own making', async () => {
    const r = await call('GET', '/markets/la-oc/readiness', await adminToken([READ]));
    expect(r.statusCode).toBe(200);
    expect(vary(r)).not.toContain('authorization');
  });
});

describe('geography API: bodies are validated raw, before Fastify coerces them (no {"active":1} activation)', () => {
  const activations = [
    ['POST', '/countries/ZZ/activation', () => svc.setCountryActive],
    ['POST', '/markets/devtest-m1/activation', () => svc.setMarketActive],
  ] as const;
  const coerced: [string, unknown][] = [
    ['number 1', 1],
    ['number 0', 0],
    ['string "true"', 'true'],
    ['string "false"', 'false'],
    ['string "1"', '1'],
    ['null', null],
    ['empty string', ''],
    ['array', [true]],
    ['object', { active: true }],
  ];

  it.each(activations)('%s %s answers 400 for a non-boolean active and never calls the service', async (method, url, mock) => {
    const t = await adminToken([WRITE]);
    for (const [label, active] of coerced) {
      const res = await call(method, url, t, { active, reason: 'r' });
      expect(res.statusCode, label).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED' });
    }
    expect(mock()).not.toHaveBeenCalled();
    // a real boolean still works, in both directions
    expect((await call(method, url, t, { active: true, reason: 'r' })).statusCode).toBe(200);
    expect((await call(method, url, t, { active: false, reason: 'r' })).statusCode).toBe(200);
    expect(mock()).toHaveBeenCalledTimes(2);
  });

  it('also refuses coerced strings in the other management bodies (a number is not a reason, a number is not a numeric code)', async () => {
    const t = await adminToken([WRITE]);
    const cases: [Method, string, unknown][] = [
      ['POST', '/countries', { ...validCountry, numeric: 999 }],
      ['POST', '/countries', { ...validCountry, reason: 123 }],
      ['POST', '/markets', { ...validMarket, name: 42 }],
      ['PUT', '/markets/devtest-m1', { name: 'New', reason: 7 }],
      ['PUT', '/countries/ZZ', { dialingCode: '+1', reason: true }],
    ];
    for (const [m, u, body] of cases) {
      const res = await call(m, u, t, body);
      expect(res.statusCode, `${m} ${u} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(svc.createCountry).not.toHaveBeenCalled();
    expect(svc.createMarket).not.toHaveBeenCalled();
    expect(svc.updateMarket).not.toHaveBeenCalled();
    expect(svc.updateCountry).not.toHaveBeenCalled();
  });

  it('keeps 401 and 403 ahead of the body check, and query-string coercion (the app-wide ajv option) untouched', async () => {
    const noBody = { active: 1, reason: 'r' };
    expect((await call('POST', '/markets/devtest-m1/activation', undefined, noBody)).statusCode).toBe(401);
    expect((await call('POST', '/markets/devtest-m1/activation', await adminToken([READ]), noBody)).statusCode).toBe(403);
    expect((await call('POST', '/markets/devtest-m1/activation', await adminToken([]), noBody)).statusCode).toBe(403);
    expect(svc.setMarketActive).not.toHaveBeenCalled();
    // string query parameters are still accepted by the router
    expect((await call('GET', '/markets?countryCode=US')).statusCode).toBe(200);
  });
});

describe('geography API: control characters, bidirectional overrides and blank text are refused at the contract', () => {
  const bad: [string, string][] = [
    ['NUL', 'Name\u0000Tail'],
    ['newline', 'two\nlines'],
    ['bidi override', 'abc\u202Edef'],
    ['bidi isolate', 'abc\u2067def'],
    ['lone surrogate', 'abc\uD800'],
    ['blank', '    '],
    ['NBSP only', '\u00A0\u00A0\u00A0'],
  ];
  it('answers 400 for such a market name or reason on every management body, with the standard envelope that does not echo the value', async () => {
    const t = await adminToken([WRITE]);
    for (const [label, value] of bad) {
      const cases: [Method, string, unknown][] = [
        ['POST', '/markets', { ...validMarket, name: value }],
        ['POST', '/markets', { ...validMarket, reason: value }],
        ['PUT', '/markets/devtest-m1', { name: value, reason: 'r' }],
        ['PUT', '/markets/devtest-m1', { name: 'ok', reason: value }],
        ['POST', '/markets/devtest-m1/activation', { active: true, reason: value }],
        ['POST', '/countries', { ...validCountry, reason: value }],
        ['PUT', '/countries/ZZ', { dialingCode: '+1', reason: value }],
        ['POST', '/countries/ZZ/activation', { active: true, reason: value }],
      ];
      for (const [m, u, body] of cases) {
        const res = await call(m, u, t, body);
        expect(res.statusCode, `${label} ${m} ${u}`).toBe(400);
        expect(errorOf(res).category).toBe('VALIDATION');
        expect(res.body).not.toContain('Tail');
      }
    }
    expect(noMocksCalled()).toBe(true);
    // ordinary text in other scripts is fine
    expect((await call('POST', '/markets', t, { ...validMarket, name: 'São Paulo 東京', reason: 'Lançamento' })).statusCode).toBe(201);
  });
});

// ====================================================================== error mapping
describe('geography API error mapping', () => {
  const expected: Record<GeographyErrorCode, [number, string]> = {
    COUNTRY_NOT_FOUND: [404, 'NOT_FOUND'],
    MARKET_NOT_FOUND: [404, 'NOT_FOUND'],
    CURRENCY_NOT_FOUND: [404, 'NOT_FOUND'],
    TIME_ZONE_NOT_FOUND: [404, 'NOT_FOUND'],
    LOCALE_NOT_FOUND: [404, 'NOT_FOUND'],
    VALIDATION_FAILED: [400, 'VALIDATION'],
    CONFLICT: [409, 'CONFLICT'],
    INVALID_STATE: [409, 'CONFLICT'],
    NOT_READY: [409, 'CONFLICT'],
    UNAVAILABLE: [503, 'DEPENDENCY'],
  };
  it('covers every GeographyError code', () => {
    expect(Object.keys(expected).sort()).toEqual([...GEOGRAPHY_ERROR_CODES].sort());
  });

  it.each(GEOGRAPHY_ERROR_CODES)('maps %s to the standard error model on public and management routes without leaking internals', async (code) => {
    const [status, category] = expected[code];
    const error = () =>
      new GeographyError(code, `${code} happened`, {
        market: 'us-sf',
        reason: 'SOME_REASON',
        constraint: 'fk_markets__secret_constraint',
        cause: 'connect ECONNREFUSED 10.0.0.5:5432 SELECT secret FROM geography.markets password=hunter2',
        ...(code === 'NOT_READY' ? { checks: [{ code: 'TAX', detail: 'no tax configuration' }] } : {}),
      });
    const check = (r: { statusCode: number; body: string; json: () => unknown }) => {
      expect(r.statusCode).toBe(status);
      expect(errorOf(r)).toMatchObject({ category, code: `GEOGRAPHY_${code}` });
      for (const leak of ['ECONNREFUSED', 'SELECT', 'hunter2', 'secret', 'cause', 'constraint', 'geography.markets']) expect(r.body, leak).not.toContain(leak);
      if (code === 'UNAVAILABLE') {
        expect(errorOf(r).message).toBe('The geography registry is temporarily unavailable');
        expect(errorOf(r).details).toBeUndefined();
      } else {
        expect(errorOf(r).details).toMatchObject({ market: 'us-sf', reason: 'SOME_REASON' });
      }
      if (code === 'NOT_READY') expect(errorOf(r).details).toMatchObject({ checks: [{ code: 'TAX', detail: 'no tax configuration' }] });
    };
    const t = await adminToken([READ, WRITE]);
    svc.getMarket.mockRejectedValueOnce(error());
    check(await call('GET', '/markets/us-sf'));
    svc.listCountries.mockRejectedValueOnce(error());
    check(await call('GET', '/countries'));
    svc.resolveMarketDefaults.mockRejectedValueOnce(error());
    check(await call('GET', '/markets/us-sf/defaults'));
    svc.getMarketReadiness.mockRejectedValueOnce(error());
    check(await call('GET', '/markets/us-sf/readiness', t));
    svc.setMarketActive.mockRejectedValueOnce(error());
    check(await call('POST', '/markets/us-sf/activation', t, { active: true, reason: 'r' }));
    svc.createCountry.mockRejectedValueOnce(error());
    check(await call('POST', '/countries', t, validCountry));
    svc.updateMarket.mockRejectedValueOnce(error());
    check(await call('PUT', '/markets/us-sf', t, { name: 'x', reason: 'r' }));
  });

  it('reports unexpected (non-geography) failures as a generic 500 without the cause', async () => {
    svc.getCountry.mockRejectedValueOnce(new Error('boom: password=hunter2'));
    const r = await call('GET', '/countries/US');
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('hunter2');
  });

  it('documents the geography routes: public reads have no security requirement, management routes need the bearer token', () => {
    const doc = app.swagger() as { paths: Record<string, Record<string, { security?: unknown[]; tags?: string[] }>> };
    const pub = [
      ['/api/v1/geography/countries', 'get'],
      ['/api/v1/geography/countries/{code}', 'get'],
      ['/api/v1/geography/markets', 'get'],
      ['/api/v1/geography/markets/{code}', 'get'],
      ['/api/v1/geography/markets/{code}/defaults', 'get'],
      ['/api/v1/geography/currencies', 'get'],
      ['/api/v1/geography/time-zones', 'get'],
    ] as const;
    for (const [p, m] of pub) expect(doc.paths[p]![m]).toMatchObject({ security: [], tags: ['geography'] });
    const mgmt = [
      ['/api/v1/geography/markets/{code}/readiness', 'get'],
      ['/api/v1/geography/countries', 'post'],
      ['/api/v1/geography/countries/{code}', 'put'],
      ['/api/v1/geography/countries/{code}/activation', 'post'],
      ['/api/v1/geography/markets', 'post'],
      ['/api/v1/geography/markets/{code}', 'put'],
      ['/api/v1/geography/markets/{code}/activation', 'post'],
    ] as const;
    for (const [p, m] of mgmt) expect(doc.paths[p]![m]!.security).toEqual([{ bearerAuth: [] }]);
  });
});
