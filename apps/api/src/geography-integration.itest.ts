// GEO-001 integration tests 17 and 18 with the REAL services wired exactly as apps/api/src/index.ts wires them: GeographyService, ConfigurationService
// (scope reference validator) and ContentService (scope reference validator and market defaults provider), all on one real, isolated PostgreSQL.
//  17: configuration and content COUNTRY/MARKET scope references are validated against the geography registry.
//  18: the content locale chain requested -> market default -> platform default, with the market default derived from the registry.
// The market defaults provider gets a controllable clock so the 60 s memo is exercised deterministically.
//  S1: PUBLIC content resolution (over HTTP, real app) only honours a market or country the public geography API shows; content-read sees all.
//  D7: deactivating a locale that an ACTIVE country or market uses as its default is a typed INVALID_STATE / LOCALE_IN_USE_BY_GEOGRAPHY.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { ConfigurationError, ConfigurationService } from '@bananagig/configuration';
import type { CreateParameterRequest } from '@bananagig/contracts';
import { ContentError, ContentService, type CreateEntryInput } from '@bananagig/content';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER } from '@bananagig/identity/testing';
import { createIsolatedDatabase, rejection, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';

let iso: IsolatedDatabase;
let geography: GeographyService;
let configuration: ConfigurationService;
let content: ContentService;
let app: FastifyInstance;
let contentReader: string; // content-read
let contentWriter: string; // content-write only (no read)
let clock = Date.UTC(2026, 0, 1);
let seq = 0;
const A = 'author-a';
const B = 'approver-b';
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);

const countryReq = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  alpha3: `${code}X`,
  numeric: String(900 + ++seq),
  displayNameContentKey: 'geography.country.us.name',
  dialingCode: '+999',
  defaultCurrencyCode: 'USD',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  timeZones: ['America/Denver'],
  distanceUnit: 'KILOMETERS',
  firstDayOfWeek: 'MONDAY',
  dateFormat: 'DMY',
  timeFormat: '24_HOUR',
  reason: 'integration test',
  ...over,
});
const marketReq = (code: string, countryCode: string, over: Record<string, unknown> = {}) => ({
  code,
  name: 'Integration Market',
  countryCode,
  defaultLocale: 'en-US',
  currencyCode: 'USD',
  defaultTimeZone: 'America/Denver',
  reason: 'integration test',
  ...over,
});
/** Creates a market and, when asked, takes it through ACTIVE (and INACTIVE). */
async function newMarket(code: string, countryCode: string, state: 'PLANNED' | 'ACTIVE' | 'INACTIVE', over: Record<string, unknown> = {}) {
  await geography.createMarket(marketReq(code, countryCode, over), A);
  if (state !== 'PLANNED') await geography.setMarketActive(code, true, 'activate for test', A);
  if (state === 'INACTIVE') await geography.setMarketActive(code, false, 'retire for test', A);
}

const paramReq = (key: string, over: Partial<CreateParameterRequest> = {}): CreateParameterRequest => ({
  key,
  dataType: 'INTEGER',
  description: 'neutral test parameter',
  ownerRole: 'platform',
  approvalPolicy: 'NONE',
  allowedOverrideScopes: ['COUNTRY', 'MARKET', 'GIG'],
  ...over,
});
const entryReq = (key: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key,
  contentType: 'PLAIN_TEXT',
  ownerRole: 'CONTENT',
  description: 'neutral test entry',
  approvalPolicy: 'NONE',
  maxScopeType: 'MARKET',
  ...over,
});

const cfgDraft = (parameterKey: string, scopeType: string, scopeRef: string | null, value = 5) =>
  configuration.createChangeRequest({ parameterKey, scopeType: scopeType as 'MARKET', scopeRef, value, reason: 'integration test' }, A);
async function cfgPublish(parameterKey: string, scopeType: string, scopeRef: string | null, value = 5) {
  const cr = await cfgDraft(parameterKey, scopeType, scopeRef, value);
  await configuration.submit(cr.changeRequestId, A); // policy NONE: approved on submit
  return configuration.publish(cr.changeRequestId, A);
}
const configError = async (p: Promise<unknown>) => (await rejection(p)) as ConfigurationError | undefined;
const contentError = async (p: Promise<unknown>) => (await rejection(p)) as ContentError | undefined;
const invalidReference = (e: { code?: string; details?: Record<string, unknown> } | undefined) => [e?.code, e?.details?.reason];

/** version -> submit -> (approve) -> publish. */
async function contentPublish(key: string, o: { locale: string; body: string; scopeType?: 'PLATFORM' | 'COUNTRY' | 'MARKET'; scopeRef?: string | null }) {
  const v = await content.createVersion(
    key,
    { locale: o.locale, scopeType: o.scopeType ?? 'PLATFORM', scopeRef: o.scopeRef ?? null, body: o.body, reason: 'integration test' },
    A,
  );
  const submitted = await content.submit(v.versionId, A);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, B);
  return content.publish(v.versionId, A);
}

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  geography = new GeographyService({ database: iso.database, env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry() });
  const scopeReferences = createGeographyScopeReferenceValidator(geography);
  configuration = new ConfigurationService({ database: iso.database, env: 'test', allowTestKeys: true, scopeReferences });
  content = new ContentService({
    database: iso.database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences,
    markets: createMarketDefaultsProvider(geography, { ttlMs: 1_000, now: () => clock }),
  });
  // the real HTTP app over the same real services, exactly as index.ts wires them
  const keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({
    cfg: loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } }),
    verifier,
    configuration,
    content,
    geography,
    readiness: async () => ({}),
  });
  await app.ready();
  const adminToken = (sub: string, roles: string[]) =>
    signToken(keys, {
      claims: {
        sub,
        azp: 'bananagig-admin',
        realm_access: { roles: [] },
        resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } },
      },
    });
  contentReader = await adminToken('reader-r', ['content-read']);
  contentWriter = await adminToken('writer-w', ['content-write']);
});
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});

// ====================================================================== 17. configuration and content scope references
describe('scope reference validation against the geography registry (17)', () => {
  it('configuration accepts MARKET la-oc (PLANNED) and COUNTRY US at draft and publish; GIG and PLATFORM are not geography’s domain', async () => {
    const k = 'devtest.geoint.scopes';
    await configuration.createParameter(paramReq(k), A);
    await cfgPublish(k, 'PLATFORM', null, 1);
    expect((await cfgPublish(k, 'MARKET', 'la-oc', 2)).state).toBe('ACTIVE');
    expect((await cfgPublish(k, 'COUNTRY', 'US', 3)).state).toBe('ACTIVE');
    // other scope types keep their old behaviour: any reference
    expect((await cfgPublish(k, 'GIG', 'any-gig-reference', 4)).state).toBe('ACTIVE');
    expect((await configuration.resolveMany([k], { market: 'la-oc' })).values.get(k)).toMatchObject({ value: 2, sourceScope: 'MARKET', scopeRef: 'la-oc' });
  });

  it('configuration rejects unknown, non-canonical and INACTIVE references with SCOPE_REFERENCE_INVALID, and writes nothing', async () => {
    const k = 'devtest.geoint.rejects';
    await configuration.createParameter(paramReq(k), A);
    await newMarket('devtest-geoint-retired', 'US', 'INACTIVE');
    await geography.createCountry(countryReq('CA'), A);
    await geography.setCountryActive('CA', true, 'activate', A);
    await geography.setCountryActive('CA', false, 'retire', A);
    const before = (await q<{ n: number }>('SELECT count(*)::int AS n FROM configuration.change_requests'))[0]!.n;
    const bad: [string, string][] = [
      ['MARKET', 'LA-OC'],
      ['MARKET', 'la_oc'],
      ['MARKET', 'nowhere'],
      ['MARKET', 'devtest-geoint-retired'],
      ['COUNTRY', 'us'],
      ['COUNTRY', 'USA'],
      ['COUNTRY', 'QQ'],
      ['COUNTRY', 'CA'], // retired
    ];
    for (const [scopeType, ref] of bad) {
      const e = await configError(cfgDraft(k, scopeType, ref));
      expect(invalidReference(e), `${scopeType} ${ref}`).toEqual(['VALIDATION_FAILED', 'SCOPE_REFERENCE_INVALID']);
      expect(e?.details.scopeType).toBe(scopeType);
    }
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM configuration.change_requests'))[0]!.n).toBe(before);
  });

  it('configuration re-validates at publish: a reference retired between draft and publish is refused', async () => {
    const k = 'devtest.geoint.retire';
    await configuration.createParameter(paramReq(k), A);
    await newMarket('devtest-geoint-cfg', 'US', 'ACTIVE');
    const cr = await cfgDraft(k, 'MARKET', 'devtest-geoint-cfg');
    await configuration.submit(cr.changeRequestId, A);
    await geography.setMarketActive('devtest-geoint-cfg', false, 'retire', A);
    const e = await configError(configuration.publish(cr.changeRequestId, A));
    expect(invalidReference(e)).toEqual(['VALIDATION_FAILED', 'SCOPE_REFERENCE_INVALID']);
    expect((await configuration.getChangeRequest(cr.changeRequestId)).state).toBe('APPROVED'); // untouched, not published
    // reactivating makes the same request publishable again
    await geography.setMarketActive('devtest-geoint-cfg', true, 'restore', A);
    expect((await configuration.publish(cr.changeRequestId, A)).state).toBe('ACTIVE');
  });

  it('content createVersion and publish validate MARKET and COUNTRY references the same way', async () => {
    const k = 'devtest.geoint.content';
    await content.createEntry(entryReq(k), A);
    await contentPublish(k, { locale: 'en-US', body: 'platform copy' });
    expect((await contentPublish(k, { locale: 'en-US', body: 'la-oc copy', scopeType: 'MARKET', scopeRef: 'la-oc' })).status).toBe('PUBLISHED');
    expect((await contentPublish(k, { locale: 'en-US', body: 'us copy', scopeType: 'COUNTRY', scopeRef: 'US' })).status).toBe('PUBLISHED');
    await newMarket('devtest-geoint-copy', 'US', 'INACTIVE');
    const versionsBefore = (await q<{ n: number }>('SELECT count(*)::int AS n FROM content.versions'))[0]!.n;
    const bad: ['MARKET' | 'COUNTRY', string][] = [
      ['MARKET', 'LA-OC'],
      ['MARKET', 'nowhere'],
      ['MARKET', 'devtest-geoint-copy'],
      ['COUNTRY', 'us'],
      ['COUNTRY', 'QQ'],
    ];
    for (const [scopeType, scopeRef] of bad) {
      const e = await contentError(content.createVersion(k, { locale: 'en-US', scopeType, scopeRef, body: 'x', reason: 'r' }, A));
      expect(invalidReference(e), `${scopeType} ${scopeRef}`).toEqual(['VALIDATION_FAILED', 'SCOPE_REFERENCE_INVALID']);
    }
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM content.versions'))[0]!.n).toBe(versionsBefore);

    // publish re-validates a reference that was retired after the draft was written
    await newMarket('devtest-geoint-pub', 'US', 'ACTIVE');
    const v = await content.createVersion(k, { locale: 'en-US', scopeType: 'MARKET', scopeRef: 'devtest-geoint-pub', body: 'pub copy', reason: 'r' }, A);
    const submitted = await content.submit(v.versionId, A);
    if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, B);
    await geography.setMarketActive('devtest-geoint-pub', false, 'retire', A);
    expect(invalidReference(await contentError(content.publish(v.versionId, A)))).toEqual(['VALIDATION_FAILED', 'SCOPE_REFERENCE_INVALID']);
    await geography.setMarketActive('devtest-geoint-pub', true, 'restore', A);
    expect((await content.publish(v.versionId, A)).status).toBe('PUBLISHED');
  });
});

// ====================================================================== 18. market default locale chain
describe('content market-default locale derived from geography (18)', () => {
  const key = 'devtest.geoint.chain';
  const resolveFor = (context: Record<string, unknown> | undefined, locale = 'fr-CA') => content.resolve(key, { locale, ...(context ? { context } : {}) });
  const advance = (ms: number) => {
    clock += ms;
  };

  beforeAll(async () => {
    // private-use locales qaa and qab (registered ACTIVE: authoring and serving both need them)
    for (const l of ['qaa', 'qab']) await q('INSERT INTO content.locales (locale, is_active) VALUES ($1, true)', [l]);
    await content.createEntry(entryReq(key), A);
    await contentPublish(key, { locale: 'en-US', body: 'English copy' });
    await contentPublish(key, { locale: 'qaa', body: 'Qaa copy' });
    await contentPublish(key, { locale: 'qab', body: 'Qab copy' });
    await geography.createCountry(countryReq('ZZ', { defaultLocale: 'qaa', supportedLocales: ['qaa', 'qab', 'en-US'] }), A);
    await geography.setCountryActive('ZZ', true, 'activate', A);
    await newMarket('devtest-chain-q', 'ZZ', 'ACTIVE', { defaultLocale: 'qaa', supportedLocales: ['qaa', 'qab', 'en-US'] });
  });

  it('chain: a requested locale without content resolves to the market default (with fallback applied), and to the platform default without a market', async () => {
    const withMarket = await resolveFor({ market: 'devtest-chain-q' });
    expect(withMarket).toMatchObject({ requestedLocale: 'fr-CA', resolvedLocale: 'qaa', body: 'Qaa copy' });
    expect(withMarket.fallback.applied).toBe(true);
    expect(withMarket.fallback.chain.indexOf('qaa')).toBeLessThan(withMarket.fallback.chain.indexOf('en-US'));
    const without = await resolveFor(undefined);
    expect(without).toMatchObject({ resolvedLocale: 'en-US', body: 'English copy' });
    expect(without.fallback.applied).toBe(true);
    // an unknown market contributes nothing
    expect((await resolveFor({ market: 'devtest-chain-unknown' })).resolvedLocale).toBe('en-US');
    // content in the requested locale itself still wins over the market default
    expect((await resolveFor({ market: 'devtest-chain-q' }, 'qab')).resolvedLocale).toBe('qab');
  });

  it('a market update changes the next resolution once the provider memo (60 s, here 1 s on a test clock) has expired', async () => {
    await geography.updateMarket('devtest-chain-q', { defaultLocale: 'qab', reason: 'switch default' }, A);
    expect((await geography.getMarket('devtest-chain-q')).defaultLocale).toBe('qab'); // the registry already says qab
    expect((await resolveFor({ market: 'devtest-chain-q' })).resolvedLocale).toBe('qaa'); // memoized
    advance(1_001);
    expect((await resolveFor({ market: 'devtest-chain-q' })).resolvedLocale).toBe('qab');
    expect((await resolveFor({ market: 'devtest-chain-q' })).body).toBe('Qab copy');
  });

  it('a PLANNED market yields no market default; once activated (and the memo expired) it does', async () => {
    await newMarket('devtest-chain-p', 'ZZ', 'PLANNED', { defaultLocale: 'qab', supportedLocales: ['qab', 'en-US'] });
    const planned = await resolveFor({ market: 'devtest-chain-p' });
    expect(planned.resolvedLocale).toBe('en-US');
    await geography.setMarketActive('devtest-chain-p', true, 'go live', A);
    expect((await resolveFor({ market: 'devtest-chain-p' })).resolvedLocale).toBe('en-US'); // "unknown" is memoized too
    advance(1_001);
    expect((await resolveFor({ market: 'devtest-chain-p' })).resolvedLocale).toBe('qab');
    await geography.setMarketActive('devtest-chain-p', false, 'retire', A);
    advance(1_001);
    expect((await resolveFor({ market: 'devtest-chain-p' })).resolvedLocale).toBe('en-US'); // INACTIVE: no market default again
  });

  it('an explicit marketDefaultLocale wins over the derived one', async () => {
    const explicit = await resolveFor({ market: 'devtest-chain-q', marketDefaultLocale: 'qaa' });
    expect(explicit.resolvedLocale).toBe('qaa'); // the market default is now qab
    expect((await resolveFor({ market: 'devtest-chain-q' })).resolvedLocale).toBe('qab');
    expect((await resolveFor({ marketDefaultLocale: 'qaa' })).resolvedLocale).toBe('qaa'); // explicit without a market still works
  });

  it('a snapshot records the derived market default (and nothing for a market without one)', async () => {
    const snap = await content.createSnapshot({ keys: [key], locale: 'fr-CA', context: { market: 'devtest-chain-q' }, purpose: 'integration test' }, A);
    expect(snap.context).toMatchObject({ market: 'devtest-chain-q', marketDefaultLocale: 'qab' });
    expect(snap.items[0]).toMatchObject({ resolvedLocale: 'qab', body: 'Qab copy' });
    const read = await content.getSnapshot(snap.snapshotId);
    expect(read.context).toEqual(snap.context);

    const none = await content.createSnapshot({ keys: [key], locale: 'fr-CA', context: { market: 'devtest-chain-p' }, purpose: 'integration test' }, A);
    expect(none.context).toEqual({ market: 'devtest-chain-p' });
    expect(none.items[0]!.resolvedLocale).toBe('en-US');

    const explicit = await content.createSnapshot(
      { keys: [key], locale: 'fr-CA', context: { market: 'devtest-chain-q', marketDefaultLocale: 'qaa' }, purpose: 'integration test' },
      A,
    );
    expect(explicit.context.marketDefaultLocale).toBe('qaa');
    expect(explicit.items[0]!.resolvedLocale).toBe('qaa');
  });
});

// ====================================================================== S1. public content resolution honours only publicly visible markets and countries
describe('public content resolution only honours a market or country that the public geography API shows (S1)', () => {
  const key = 'devtest.geoint.visibility';
  const advance = (ms: number) => {
    clock += ms;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;
  const post = async (url: string, payload: unknown, token?: string) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/content${url}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as object,
    });
    return { status: r.statusCode, body: r.json() as Json };
  };
  /** The comparable part of a response (the correlation id differs per request). */
  const resolve = async (context: Record<string, unknown> | undefined, token?: string) => {
    const r = await post('/resolve', { key, locale: 'en-US', ...(context ? { context } : {}) }, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const copy = async (context: Record<string, unknown> | undefined, token?: string) => (await resolve(context, token)).value;

  beforeAll(async () => {
    await content.createEntry(entryReq(key), A);
    await contentPublish(key, { locale: 'en-US', body: 'platform copy' });
    // US is ACTIVE; ZS is PLANNED (created, never activated)
    await contentPublish(key, { locale: 'en-US', body: 'us country copy', scopeType: 'COUNTRY', scopeRef: 'US' });
    await geography.createCountry(countryReq('MX'), A);
    await contentPublish(key, { locale: 'en-US', body: 'zs country copy', scopeType: 'COUNTRY', scopeRef: 'MX' });
    // markets: ACTIVE, PLANNED and INACTIVE (published while ACTIVE, retired afterwards), each with its own MARKET copy
    await newMarket('devtest-vis-active', 'US', 'ACTIVE');
    await contentPublish(key, { locale: 'en-US', body: 'active market copy', scopeType: 'MARKET', scopeRef: 'devtest-vis-active' });
    await newMarket('devtest-vis-planned', 'US', 'PLANNED');
    await contentPublish(key, { locale: 'en-US', body: 'planned market copy', scopeType: 'MARKET', scopeRef: 'devtest-vis-planned' });
    await newMarket('devtest-vis-inactive', 'US', 'ACTIVE');
    await contentPublish(key, { locale: 'en-US', body: 'inactive market copy', scopeType: 'MARKET', scopeRef: 'devtest-vis-inactive' });
    await geography.setMarketActive('devtest-vis-inactive', false, 'retire', A);
    advance(5_000); // any memoized answer from the setup is stale
  });

  it('anonymous callers get market copy only for the ACTIVE market; PLANNED, INACTIVE and unknown markets behave exactly like no market', async () => {
    expect(await copy(undefined)).toBe('platform copy');
    expect(await copy({ market: 'devtest-vis-active' })).toBe('active market copy');
    expect((await resolve({ market: 'devtest-vis-active' })).sourceScope).toBe('MARKET');
    for (const market of ['devtest-vis-planned', 'devtest-vis-inactive', 'devtest-vis-unknown', 'la-oc']) {
      const r = await resolve({ market });
      expect(r.value, market).toBe('platform copy');
      expect(r.sourceScope, market).toBe('PLATFORM');
      expect(r.scopeRef, market).toBeNull();
    }
  });

  it('the existence oracle is closed: unknown, PLANNED, INACTIVE and no-market responses are identical, byte for byte', async () => {
    const reference = JSON.stringify(await resolve(undefined));
    for (const market of ['devtest-vis-planned', 'devtest-vis-inactive', 'devtest-vis-unknown', 'Not-A-Market', 'x'.repeat(150)])
      expect(JSON.stringify(await resolve({ market })), market).toBe(reference);
    // the same holds for the batch endpoint and for a request whose market default locale would have changed the chain
    const many = async (context: Record<string, unknown>) =>
      JSON.stringify((await post('/resolve-many', { keys: [key, 'devtest.geoint.nothing'], locale: 'fr-CA', context })).body.data.items);
    expect(await many({ market: 'devtest-vis-planned' })).toBe(await many({ market: 'devtest-vis-unknown' }));
    expect(await many({ market: 'devtest-vis-inactive' })).toBe(await many({}));
    expect(JSON.parse(await many({ market: 'devtest-vis-active' }))[0].value).toBe('active market copy');
    expect(JSON.parse(await many({ market: 'devtest-vis-planned' }))[0].value).toBe('platform copy');
  });

  it('a COUNTRY that the public API does not show (PLANNED ZS, unknown QQ) is dropped too; an ACTIVE country still applies', async () => {
    expect(await copy({ country: 'US' })).toBe('us country copy');
    expect(await copy({ country: 'MX' })).toBe('platform copy');
    expect(await copy({ country: 'QQ' })).toBe('platform copy');
    expect(JSON.stringify(await resolve({ country: 'MX' }))).toBe(JSON.stringify(await resolve({ country: 'QQ' })));
    // only the invisible member is dropped: an ACTIVE market next to a PLANNED country, and the reverse
    expect(await copy({ market: 'devtest-vis-active', country: 'MX' })).toBe('active market copy');
    expect(await copy({ market: 'devtest-vis-planned', country: 'US' })).toBe('us country copy');
  });

  it('management callers (content-read) still see everything, including copy of a PLANNED or INACTIVE market and a PLANNED country', async () => {
    expect(await copy({ market: 'devtest-vis-planned' }, contentReader)).toBe('planned market copy');
    expect(await copy({ market: 'devtest-vis-inactive' }, contentReader)).toBe('inactive market copy');
    expect(await copy({ market: 'devtest-vis-active' }, contentReader)).toBe('active market copy');
    expect(await copy({ market: 'devtest-vis-unknown' }, contentReader)).toBe('platform copy'); // nothing exists for it, for anyone
    expect(await copy({ country: 'MX' }, contentReader)).toBe('zs country copy');
    // a token without content-read is an anonymous-equivalent public caller
    expect(await copy({ market: 'devtest-vis-planned' }, contentWriter)).toBe('platform copy');
    expect(await copy({ country: 'MX' }, contentWriter)).toBe('platform copy');
    const many = await post('/resolve-many', { keys: [key], locale: 'en-US', context: { market: 'devtest-vis-planned' } }, contentReader);
    expect(many.body.data.items[0].value).toBe('planned market copy');
  });

  it('snapshots (management) are unchanged: the PLANNED market and its copy are recorded as asked, over the service and over HTTP', async () => {
    const snap = await content.createSnapshot({ keys: [key], locale: 'en-US', context: { market: 'devtest-vis-planned' }, purpose: 'visibility test' }, A);
    expect(snap.context).toEqual({ market: 'devtest-vis-planned' }); // recorded as asked (a PLANNED market has no public default locale to derive)
    expect(snap.items[0]).toMatchObject({ sourceScope: 'MARKET', scopeRef: 'devtest-vis-planned', body: 'planned market copy' });
    const http = await post(
      '/snapshots',
      { keys: [key], locale: 'en-US', context: { market: 'devtest-vis-planned', country: 'MX' }, purpose: 'visibility test' },
      contentReader,
    );
    expect(http.status, JSON.stringify(http.body)).toBe(201);
    expect(http.body.data.context).toMatchObject({
      market: 'devtest-vis-planned',
      country: 'MX',
    });
    expect(http.body.data.items[0].body).toBe('planned market copy'); // the market level outranks the country level
  });

  it('visibility follows the reference data once the provider memo expires: activation reveals the market copy, retirement hides it again', async () => {
    expect(await copy({ market: 'devtest-vis-planned' })).toBe('platform copy');
    await geography.setMarketActive('devtest-vis-planned', true, 'go live', A);
    expect(await copy({ market: 'devtest-vis-planned' })).toBe('platform copy'); // "not visible" is memoized for the TTL
    advance(1_001);
    expect(await copy({ market: 'devtest-vis-planned' })).toBe('planned market copy');
    await geography.setMarketActive('devtest-vis-planned', false, 'retire', A);
    advance(1_001);
    expect(await copy({ market: 'devtest-vis-planned' })).toBe('platform copy');
    expect(await copy({ market: 'devtest-vis-planned' }, contentReader)).toBe('planned market copy');
  });

  it('a market outside its effective period is not visible (ACTIVE but expired)', async () => {
    await geography.createMarket(
      marketReq('devtest-vis-expired', 'US', {
        effectiveFrom: new Date(Date.now() - 2 * 86400e3).toISOString(),
        effectiveTo: new Date(Date.now() - 86400e3).toISOString(),
      }),
      A,
    );
    await geography.setMarketActive('devtest-vis-expired', true, 'activate', A);
    await contentPublish(key, { locale: 'en-US', body: 'expired market copy', scopeType: 'MARKET', scopeRef: 'devtest-vis-expired' });
    advance(1_001);
    expect(await copy({ market: 'devtest-vis-expired' })).toBe('platform copy');
    expect(await copy({ market: 'devtest-vis-expired' }, contentReader)).toBe('expired market copy');
  });
});

// ====================================================================== D7. locale deactivation blocked by an ACTIVE country or market default
describe('deactivating a locale that an ACTIVE country or market uses as its default (D7)', () => {
  const contentApi = async (url: string, payload: unknown, token: string) => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/content${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
    return {
      status: r.statusCode,
      body: r.json() as { data?: { isActive: boolean }; error?: { code: string; category: string; message: string; details?: Record<string, unknown> } },
    };
  };
  const localeActive = async (locale: string) =>
    (await q<{ is_active: boolean }>('SELECT is_active FROM content.locales WHERE locale = $1', [locale]))[0]!.is_active;

  it('a country default blocks it with INVALID_STATE / LOCALE_IN_USE_BY_GEOGRAPHY (service and HTTP); after the country is retired it succeeds', async () => {
    await q('INSERT INTO content.locales (locale, is_active) VALUES ($1, true)', ['qac']);
    await geography.createCountry(countryReq('GB', { defaultLocale: 'qac', supportedLocales: ['qac', 'en-US'] }), A);
    await geography.setCountryActive('GB', true, 'activate', A);
    const e = await contentError(content.setLocaleActive('qac', false, 'retire the locale', A));
    expect([e?.code, e?.details]).toEqual(['INVALID_STATE', { reason: 'LOCALE_IN_USE_BY_GEOGRAPHY' }]);
    expect(await localeActive('qac')).toBe(true);
    const http = await contentApi('/locales/qac/activation', { active: false, reason: 'retire the locale' }, contentWriter);
    expect(http.status).toBe(409);
    expect(http.body.error).toMatchObject({ category: 'CONFLICT', code: 'CONTENT_INVALID_STATE', details: { reason: 'LOCALE_IN_USE_BY_GEOGRAPHY' } });
    expect(JSON.stringify(http.body)).not.toMatch(/GB|geography_rule|trigger|integrity/);
    expect(await localeActive('qac')).toBe(true);
    await geography.setCountryActive('GB', false, 'retire the country', A);
    expect((await contentApi('/locales/qac/activation', { active: false, reason: 'retire the locale' }, contentWriter)).body.data?.isActive).toBe(false);
    expect(await localeActive('qac')).toBe(false);
  });

  it('a market default blocks it the same way', async () => {
    await q('INSERT INTO content.locales (locale, is_active) VALUES ($1, true)', ['qad']);
    await geography.createCountry(countryReq('FR', { supportedLocales: ['en-US', 'qad'] }), A);
    await geography.setCountryActive('FR', true, 'activate', A);
    await newMarket('devtest-d7-market', 'FR', 'ACTIVE', { defaultLocale: 'qad', supportedLocales: ['qad', 'en-US'] });
    const e = await contentError(content.setLocaleActive('qad', false, 'retire the locale', A));
    expect([e?.code, e?.details]).toEqual(['INVALID_STATE', { reason: 'LOCALE_IN_USE_BY_GEOGRAPHY' }]);
    expect(await localeActive('qad')).toBe(true);
    await geography.setMarketActive('devtest-d7-market', false, 'retire the market', A);
    expect((await content.setLocaleActive('qad', false, 'retire the locale', A)).isActive).toBe(false);
  });

  it('a locale that no ACTIVE country or market uses as its default (and the platform default) keep their existing behaviour', async () => {
    await q('INSERT INTO content.locales (locale, is_active) VALUES ($1, true)', ['qae']);
    expect((await content.setLocaleActive('qae', false, 'unused locale', A)).isActive).toBe(false);
    const platform = await contentError(content.setLocaleActive('en-US', false, 'must not', A));
    expect([platform?.code, platform?.details.reason]).toEqual(['VALIDATION_FAILED', 'PLATFORM_DEFAULT']);
  });
});
