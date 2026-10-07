// The geography registry workflow over HTTP: real PostgreSQL (isolated, migrated; migration 0007 seeds USD, four US time zones, the ACTIVE country
// US and the PLANNED market la-oc), the real auth plugin, forged-but-signed tokens (same approach as content.itest.ts) and the real
// GeographyService. The client role names are asserted by the API from the token, so this test does not depend on the Keycloak realm import.
// There is no API for locales and time zones (content owns locales; zones are registered PLANNED by the country), so the test activates the
// ones it needs with SQL, exactly as an operator would until those registries have their own management surface.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { MemoryConfigCache } from '@bananagig/configuration';
import { GEOGRAPHY_EVENTS, ErrorResponse } from '@bananagig/contracts';
import { GeographyService, ReadinessRegistry } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';

let iso: IsolatedDatabase;
let app: FastifyInstance;
let keys: TestKeys;
let staff: string; // geography-read + geography-write
let reader: string; // geography-read only
let writer: string; // geography-write only
let customer: string;
let taxHealthy = true;

const adminToken = (sub: string, roles: string[]) =>
  signToken(keys, {
    claims: { sub, azp: 'bananagig-admin', realm_access: { roles: [] }, resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } } },
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const api = async (method: 'GET' | 'POST' | 'PUT', url: string, t?: string, payload?: unknown): Promise<{ status: number; body: Json }> => {
  const r = await app.inject({
    method,
    url: `/api/v1/geography${url}`,
    headers: t ? { authorization: `Bearer ${t}` } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, body: r.json() as Json };
};
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const codes = (body: Json): string[] => body.data.map((x: { code: string }) => x.code);
const outbox = (type: string, filter: { market?: string; country?: string }) =>
  q<{ payload_json: Record<string, unknown>; aggregate_type: string; aggregate_id: string; actor_type: string; actor_id: string; correlation_id: string }>(
    `SELECT payload_json, aggregate_type, aggregate_id, actor_type, actor_id, correlation_id FROM integration.outbox_events
      WHERE event_type = $1 AND ($2::text IS NULL OR payload_json->>'marketCode' = $2) AND ($3::text IS NULL OR payload_json->>'countryCode' = $3) ORDER BY created_at, outbox_event_id`,
    [type, filter.market ?? null, filter.country ?? null],
  );
const marketAudit = (code: string) =>
  q<{ action: string; actor: string; changes: Record<string, [unknown, unknown]> | null; reason: string; correlation_id: string }>(
    `SELECT a.action, a.actor, a.changes, a.reason, a.correlation_id FROM geography.audit_events a JOIN geography.markets m ON m.market_id = a.market_id
      WHERE m.code = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [code],
  );
const countryAudit = (code: string) =>
  q<{ action: string; actor: string; changes: Record<string, [unknown, unknown]> | null; reason: string }>(
    `SELECT a.action, a.actor, a.changes, a.reason FROM geography.audit_events a JOIN geography.countries c ON c.country_id = a.country_id
      WHERE c.iso_alpha2 = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [code],
  );

const zz = (over: Record<string, unknown> = {}) => ({
  code: 'ZZ',
  alpha3: 'ZZZ',
  numeric: '999',
  displayNameContentKey: 'geography.country.us.name',
  dialingCode: '+999',
  defaultCurrencyCode: 'USD',
  defaultLocale: 'qaa',
  supportedLocales: ['qaa', 'en-US'],
  timeZones: ['Pacific/Honolulu'],
  distanceUnit: 'KILOMETERS',
  firstDayOfWeek: 'MONDAY',
  dateFormat: 'DMY',
  timeFormat: '24_HOUR',
  reason: 'http integration test',
  ...over,
});
const market = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  name: 'HTTP Test Market',
  countryCode: 'ZZ',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US', 'qaa'],
  currencyCode: 'USD',
  defaultTimeZone: 'Pacific/Honolulu',
  reason: 'http integration test',
  ...over,
});

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  keys = await createTestKeys('k1');
  const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const readiness = new ReadinessRegistry();
  readiness.register({
    code: 'TAX',
    description: 'test-only extra readiness check',
    evaluate: () => ({ passed: taxHealthy, detail: taxHealthy ? 'tax ready' : 'no tax rules' }),
  });
  const geography = new GeographyService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true, readiness });
  app = await buildApp({ cfg, verifier, configuration: {} as never, geography, readiness: async () => ({}) });
  await app.ready();
  // private-use locale tags (qaa-qtz): registered INACTIVE; tests activate them with SQL
  for (const l of ['qaa', 'qab']) await q('INSERT INTO content.locales (locale, is_active) VALUES ($1, false)', [l]);
  staff = await adminToken('staff-a', ['geography-read', 'geography-write']);
  reader = await adminToken('reader-r', ['geography-read']);
  writer = await adminToken('writer-w', ['geography-write']);
  customer = await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });
});
afterAll(async () => {
  await app.close();
  await iso.drop();
});

describe('geography API workflow (HTTP, real database)', () => {
  it('serves the seeded reference data publicly (ACTIVE only, public fields) and hides the PLANNED market la-oc from everyone without geography-read or geography-write', async () => {
    const countries = await api('GET', '/countries');
    expect(codes(countries.body)).toEqual(['US']);
    expect(countries.body.data[0]).toMatchObject({ code: 'US', alpha3: 'USA', defaultCurrencyCode: 'USD', defaultLocale: 'en-US', distanceUnit: 'MILES' });
    expect(Object.keys(countries.body.data[0])).not.toContain('status');
    expect((await api('GET', '/countries/US', customer)).body.data).not.toHaveProperty('createdAt');
    expect((await api('GET', '/currencies')).body.data).toEqual([
      { code: 'USD', numericCode: '840', minorUnitDigits: 2, displayName: 'US Dollar', symbol: '$' },
    ]);
    expect((await api('GET', '/time-zones')).body.data.map((z: { ianaName: string }) => z.ianaName)).toContain('America/Los_Angeles');

    for (const t of [undefined, customer]) {
      expect((await api('GET', '/markets/la-oc', t)).status).toBe(404);
      expect((await api('GET', '/markets/la-oc/defaults', t)).status).toBe(404);
      expect(codes((await api('GET', '/markets', t)).body)).not.toContain('la-oc');
    }
    // geography-write implies read: the writer sees the management view that its own mutations return (a write-only token used to get 404 here)
    expect((await api('GET', '/markets/la-oc', writer)).body.data).toMatchObject({ code: 'la-oc', status: 'PLANNED' });
    expect((await api('GET', '/markets/la-oc/defaults', writer)).status).toBe(200);
    expect(codes((await api('GET', '/markets', writer)).body)).toContain('la-oc');
    expect((await api('GET', '/countries/US', writer)).body.data.status).toBe('ACTIVE');
    const seen = await api('GET', '/markets/la-oc', reader);
    expect(seen.body.data).toMatchObject({ code: 'la-oc', name: 'LA & OC', status: 'PLANNED', countryCode: 'US', defaultTimeZone: 'America/Los_Angeles' });
    expect(codes((await api('GET', '/markets', reader)).body)).toContain('la-oc');
    const defaults = await api('GET', '/markets/la-oc/defaults', reader);
    expect(defaults.body.data).toMatchObject({
      locale: 'en-US',
      currency: { code: 'USD', minorUnitDigits: 2 },
      timeZone: 'America/Los_Angeles',
      distanceUnit: 'MILES',
    });
    expect((await api('GET', '/countries/US', reader)).body.data.status).toBe('ACTIVE');
    const ready = await api('GET', '/markets/la-oc/readiness', reader);
    expect(ready.status).toBe(200);
    expect(ready.body.data.market).toBe('la-oc');
    expect(ready.body.data.checks.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining(['COUNTRY_ACTIVE', 'CURRENCY_ACTIVE', 'LOCALE_ACTIVE', 'TIME_ZONE_ACTIVE']),
    );
  });

  it('enforces authentication and permissions against the real token verification', async () => {
    expect((await api('GET', '/markets/la-oc/readiness')).status).toBe(401);
    expect((await api('POST', '/countries', undefined, {})).status).toBe(401);
    expect((await api('GET', '/countries', 'not.a.token')).status).toBe(401);
    expect((await api('GET', '/markets/la-oc/readiness', customer)).status).toBe(403);
    const writerReadiness = await api('GET', '/markets/la-oc/readiness', writer); // geography-write implies read
    expect(writerReadiness.status).toBe(200);
    expect(writerReadiness.body.data.market).toBe('la-oc');
    expect((await api('POST', '/countries', reader, zz())).status).toBe(403); // the reverse does not hold
    expect((await api('POST', '/markets/la-oc/activation', reader, { active: true, reason: 'x' })).status).toBe(403);
    expect((await api('POST', '/markets/la-oc/activation', customer, { active: true, reason: 'x' })).status).toBe(403);
    const contentStaff = await adminToken('content-c', ['content-read', 'content-write', 'configuration-write']);
    expect((await api('POST', '/countries', contentStaff, zz())).status).toBe(403);
    expect((await q("SELECT status FROM geography.markets WHERE code = 'la-oc'"))[0]).toEqual({ status: 'PLANNED' });
  });

  it('creates country ZZ as PLANNED, refuses activation until its dependencies are ACTIVE (typed conflicts), then activates it; identifier-only event and audit rows', async () => {
    const created = await api('POST', '/countries', staff, zz());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      code: 'ZZ',
      status: 'PLANNED',
      defaultLocale: 'qaa',
      supportedLocales: ['en-US', 'qaa'],
      timeZones: ['Pacific/Honolulu'],
      distanceUnit: 'KILOMETERS',
    });
    expect((await api('GET', '/countries/ZZ')).status).toBe(404); // PLANNED: not found publicly
    expect(codes((await api('GET', '/countries')).body)).not.toContain('ZZ');
    expect((await api('GET', '/countries/ZZ', reader)).body.data.status).toBe('PLANNED');

    // typed failures of the create route
    const dup = await api('POST', '/countries', staff, zz({ alpha3: 'ZZY', numeric: '998' }));
    expect([dup.status, dup.body.error.code]).toEqual([409, 'GEOGRAPHY_CONFLICT']);
    const noCurrency = await api('POST', '/countries', staff, zz({ code: 'GB', defaultCurrencyCode: 'XTS' }));
    expect([noCurrency.status, noCurrency.body.error.code]).toEqual([404, 'GEOGRAPHY_CURRENCY_NOT_FOUND']);
    const noLocale = await api('POST', '/countries', staff, zz({ code: 'GB', supportedLocales: ['qaa', 'xx-XX'] }));
    expect([noLocale.status, noLocale.body.error.code]).toEqual([404, 'GEOGRAPHY_LOCALE_NOT_FOUND']);
    const noKey = await api('POST', '/countries', staff, zz({ code: 'GB', displayNameContentKey: 'no.such.key' }));
    expect([noKey.status, noKey.body.error.code, noKey.body.error.details.reason]).toEqual([400, 'GEOGRAPHY_VALIDATION_FAILED', 'CONTENT_KEY_NOT_FOUND']);
    expect((await api('POST', '/countries', staff, zz({ code: 'GB', defaultLocale: 'en-US', supportedLocales: ['qaa'] }))).status).toBe(400);

    // activation: the default locale qaa is registered but not active -> typed conflict, nothing written
    const noLocaleActive = await api('POST', '/countries/ZZ/activation', writer, { active: true, reason: 'launch' });
    expect([noLocaleActive.status, noLocaleActive.body.error.code, noLocaleActive.body.error.details.reason]).toEqual([
      409,
      'GEOGRAPHY_INVALID_STATE',
      'LOCALE_NOT_ACTIVE',
    ]);
    await q("UPDATE content.locales SET is_active = true WHERE locale = 'qaa'");
    const noZone = await api('POST', '/countries/ZZ/activation', writer, { active: true, reason: 'launch' });
    expect([noZone.status, noZone.body.error.details.reason]).toEqual([409, 'NO_ACTIVE_TIME_ZONE']);
    expect(noZone.body.error.details).not.toHaveProperty('constraint');
    expect(JSON.stringify(noZone.body)).not.toMatch(/geography\.|SELECT|trigger/i);
    await q("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'Pacific/Honolulu'");

    const activated = await api('POST', '/countries/ZZ/activation', writer, { active: true, reason: 'launch' });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body.data).toMatchObject({ code: 'ZZ', status: 'ACTIVE' });
    const again = await api('POST', '/countries/ZZ/activation', writer, { active: true, reason: 'launch again' });
    expect([again.status, again.body.data.status]).toEqual([200, 'ACTIVE']);

    // the earlier public 404 was cached: the activation invalidated it
    const pub = await api('GET', '/countries/ZZ');
    expect(pub.status).toBe(200);
    expect(pub.body.data).not.toHaveProperty('status');
    expect(codes((await api('GET', '/countries')).body)).toContain('ZZ');

    const events = await outbox(GEOGRAPHY_EVENTS.countryActivated, { country: 'ZZ' });
    expect(events).toHaveLength(1); // the repeated activation wrote nothing
    expect(events[0]).toMatchObject({ aggregate_type: 'geography_country', actor_type: 'user', actor_id: 'writer-w' });
    expect(events[0]!.payload_json).toEqual({ countryCode: 'ZZ' });
    const countryId = (await q<{ country_id: string }>("SELECT country_id FROM geography.countries WHERE iso_alpha2 = 'ZZ'"))[0]!.country_id;
    expect(events[0]!.aggregate_id).toBe(countryId);
    const audit = await countryAudit('ZZ');
    expect(audit.map((a) => [a.action, a.actor])).toEqual([
      ['COUNTRY_CREATED', 'staff-a'],
      ['COUNTRY_ACTIVATED', 'writer-w'],
    ]);
    expect(audit[1]).toMatchObject({ reason: 'launch', changes: { status: ['PLANNED', 'ACTIVE'] } });
  });

  it('creates, activates, updates and deactivates a devtest market: public versus management views, events, audit rows and correlation', async () => {
    const code = 'devtest-http1';
    const created = await api('POST', '/markets', staff, market(code));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      code,
      status: 'PLANNED',
      countryCode: 'ZZ',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'qaa'],
      effectiveTo: null,
    });
    expect(created.body.data.effectiveFrom).toEqual(expect.any(String));
    expect((await api('GET', `/markets/${code}`)).status).toBe(404);
    expect((await api('GET', `/markets/${code}/defaults`)).status).toBe(404);
    expect((await api('GET', `/markets/${code}`, reader)).body.data.status).toBe('PLANNED');
    const ready = await api('GET', `/markets/${code}/readiness`, reader);
    expect(ready.body.data).toMatchObject({ market: code, ready: true });
    expect(ready.body.data.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
    expect(ready.body.data.checks.map((c: { code: string }) => c.code)).toContain('TAX'); // a registered extra check is evaluated too
    const createdEvents = await outbox(GEOGRAPHY_EVENTS.marketCreated, { market: code });
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ aggregate_type: 'geography_market', actor_id: 'staff-a' });
    expect(createdEvents[0]!.payload_json).toEqual({ marketCode: code, countryCode: 'ZZ' });

    const cid = 'corr-http-activate-1';
    const act = await app.inject({
      method: 'POST',
      url: `/api/v1/geography/markets/${code}/activation`,
      headers: { authorization: `Bearer ${writer}`, 'x-correlation-id': cid },
      payload: { active: true, reason: 'go live' },
    });
    expect(act.statusCode, act.body).toBe(200);
    expect(act.json().data).toMatchObject({ code, status: 'ACTIVE' });
    expect(act.json().meta.correlationId).toBe(cid);

    // public view: public fields only
    const pub = await api('GET', `/markets/${code}`);
    expect(pub.status).toBe(200);
    expect(Object.keys(pub.body.data).sort()).toEqual(
      ['code', 'countryCode', 'currencyCode', 'defaultLocale', 'defaultTimeZone', 'effectiveFrom', 'effectiveTo', 'name', 'supportedLocales'].sort(),
    );
    expect(codes((await api('GET', '/markets')).body)).toContain(code);
    expect(codes((await api('GET', '/markets?countryCode=ZZ')).body)).toEqual([code]);
    expect(codes((await api('GET', '/markets?countryCode=US')).body)).not.toContain(code);
    const defaults = await api('GET', `/markets/${code}/defaults`);
    expect(defaults.body.data).toMatchObject({
      market: { code, countryCode: 'ZZ' },
      country: { code: 'ZZ', dialingCode: '+999' },
      currency: { code: 'USD', minorUnitDigits: 2, symbol: '$' },
      locale: 'en-US',
      supportedLocales: ['en-US', 'qaa'],
      timeZone: 'Pacific/Honolulu',
      distanceUnit: 'KILOMETERS',
      firstDayOfWeek: 'MONDAY',
      dateFormat: 'DMY',
      timeFormat: '24_HOUR',
    });
    expect(JSON.stringify(defaults.body)).not.toContain('status');

    const activated = await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: code });
    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({ aggregate_type: 'geography_market', actor_type: 'user', actor_id: 'writer-w', correlation_id: cid });
    expect(activated[0]!.payload_json).toEqual({ marketCode: code, countryCode: 'ZZ' });
    const marketId = (await q<{ market_id: string }>('SELECT market_id FROM geography.markets WHERE code = $1', [code]))[0]!.market_id;
    expect(activated[0]!.aggregate_id).toBe(marketId);

    // updating the default locale emits market-defaults-changed (field names only) and the public defaults change at once (cache invalidated)
    const upd = await api('PUT', `/markets/${code}`, writer, { defaultLocale: 'qaa', reason: 'qaa first' });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data).toMatchObject({ defaultLocale: 'qaa', status: 'ACTIVE' });
    expect((await api('GET', `/markets/${code}/defaults`)).body.data.locale).toBe('qaa');
    expect((await api('GET', `/markets/${code}`)).body.data.defaultLocale).toBe('qaa');
    const changed = await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: code });
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload_json).toEqual({ marketCode: code, countryCode: 'ZZ', changedFields: ['defaultLocale'], cause: 'MARKET' });
    expect(JSON.stringify(changed[0]!.payload_json)).not.toContain('qaa');
    // a name-only change and an empty change write no event
    expect((await api('PUT', `/markets/${code}`, writer, { name: 'Renamed Market', reason: 'rename' })).body.data.name).toBe('Renamed Market');
    expect(await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: code })).toHaveLength(1);

    // a country format change emits market-defaults-changed (cause COUNTRY) for the markets of the country
    const country = await api('PUT', '/countries/ZZ', writer, { distanceUnit: 'MILES', dateFormat: 'YMD', reason: 'locale review' });
    expect(country.status, JSON.stringify(country.body)).toBe(200);
    expect(country.body.data).toMatchObject({ distanceUnit: 'MILES', dateFormat: 'YMD', status: 'ACTIVE' });
    expect((await api('GET', `/markets/${code}/defaults`)).body.data).toMatchObject({ distanceUnit: 'MILES', dateFormat: 'YMD' });
    const byCountry = (await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: code })).map((e) => e.payload_json);
    expect(byCountry[1]).toEqual({ marketCode: code, countryCode: 'ZZ', changedFields: ['distanceUnit', 'dateFormat'], cause: 'COUNTRY' });
    expect(JSON.stringify(byCountry[1])).not.toMatch(/MILES|YMD/);

    // the country cannot be deactivated while the market is ACTIVE
    const blocked = await api('POST', '/countries/ZZ/activation', writer, { active: false, reason: 'no' });
    expect([blocked.status, blocked.body.error.details.reason, blocked.body.error.details.markets]).toEqual([409, 'COUNTRY_HAS_ACTIVE_MARKETS', [code]]);

    // deactivate: hidden publicly at once, visible to management as INACTIVE; reactivation is allowed
    const off = await api('POST', `/markets/${code}/activation`, writer, { active: false, reason: 'pause' });
    expect([off.status, off.body.data.status]).toEqual([200, 'INACTIVE']);
    expect((await api('GET', `/markets/${code}`)).status).toBe(404);
    expect((await api('GET', `/markets/${code}/defaults`)).status).toBe(404);
    expect(codes((await api('GET', '/markets')).body)).not.toContain(code);
    expect((await api('GET', `/markets/${code}`, reader)).body.data.status).toBe('INACTIVE');
    expect((await api('GET', `/markets/${code}/defaults`, reader)).status).toBe(200);
    expect(await outbox(GEOGRAPHY_EVENTS.marketDeactivated, { market: code })).toHaveLength(1);
    expect((await api('POST', `/markets/${code}/activation`, writer, { active: true, reason: 'resume' })).body.data.status).toBe('ACTIVE');
    expect((await api('GET', `/markets/${code}`)).status).toBe(200);

    const audit = await marketAudit(code);
    expect(audit.map((a) => a.action)).toEqual([
      'MARKET_CREATED',
      'MARKET_ACTIVATED',
      'MARKET_UPDATED',
      'MARKET_UPDATED',
      'MARKET_DEACTIVATED',
      'MARKET_ACTIVATED',
    ]);
    expect(audit[1]).toMatchObject({ actor: 'writer-w', reason: 'go live', correlation_id: cid, changes: { status: ['PLANNED', 'ACTIVE'] } });
    expect(audit[2]).toMatchObject({ actor: 'writer-w', reason: 'qaa first', changes: { defaultLocale: ['en-US', 'qaa'] } });
    expect(audit[0]!.actor).toBe('staff-a');
  });

  it('refuses to activate a market whose country, currency, time zone or locale is not ACTIVE, with the typed conflict and the failing checks', async () => {
    // country not ACTIVE: a PLANNED country ZY with its own market
    expect(
      (
        await api(
          'POST',
          '/countries',
          staff,
          zz({ code: 'GB', alpha3: 'ZYY', numeric: '997', defaultLocale: 'en-US', supportedLocales: ['en-US'], timeZones: ['America/Denver'] }),
        )
      ).status,
    ).toBe(201);
    expect(
      (await api('POST', '/markets', staff, market('devtest-http-nc', { countryCode: 'GB', defaultTimeZone: 'America/Denver', supportedLocales: ['en-US'] })))
        .status,
    ).toBe(201);
    // currency not ACTIVE (PLANNED currency), time zone not ACTIVE (a second zone added to ZZ), locale not ACTIVE (qab added to ZZ)
    await q(
      "INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, status) VALUES ('JPY', '392', 0, 'Yen', 'PLANNED')",
    );
    await q(
      "INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, status) VALUES ('XDR', '960', 2, 'Retired unit', 'INACTIVE')",
    );
    const grown = await api('PUT', '/countries/ZZ', staff, {
      supportedLocales: ['qaa', 'en-US', 'qab'],
      timeZones: ['Pacific/Honolulu', 'Asia/Tokyo'],
      reason: 'add dependencies',
    });
    expect(grown.status, JSON.stringify(grown.body)).toBe(200);
    expect(grown.body.data.supportedLocales).toEqual(['en-US', 'qaa', 'qab']);
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['devtest-http-nc', {}, 'COUNTRY_NOT_ACTIVE', 'COUNTRY_ACTIVE'],
      ['devtest-http-cur', { currencyCode: 'JPY' }, 'CURRENCY_NOT_ACTIVE', 'CURRENCY_ACTIVE'],
      ['devtest-http-cur2', { currencyCode: 'XDR' }, 'CURRENCY_NOT_ACTIVE', 'CURRENCY_ACTIVE'],
      ['devtest-http-tz', { defaultTimeZone: 'Asia/Tokyo' }, 'TIME_ZONE_NOT_ACTIVE', 'TIME_ZONE_ACTIVE'],
      ['devtest-http-loc', { defaultLocale: 'qab', supportedLocales: ['qab', 'en-US'] }, 'LOCALE_NOT_ACTIVE', 'LOCALE_ACTIVE'],
    ];
    for (const [code, over, reason, check] of cases) {
      if (code !== 'devtest-http-nc') expect((await api('POST', '/markets', staff, market(code, over))).status, code).toBe(201);
      const r = await api('POST', `/markets/${code}/activation`, writer, { active: true, reason: 'try' });
      expect([r.status, r.body.error.code, r.body.error.details.reason], code).toEqual([409, 'GEOGRAPHY_INVALID_STATE', reason]);
      expect(
        r.body.error.details.checks.map((c: { code: string }) => c.code),
        code,
      ).toContain(check);
      expect((await q<{ status: string }>('SELECT status FROM geography.markets WHERE code = $1', [code]))[0]!.status).toBe('PLANNED');
      expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: code })).toHaveLength(0);
      expect((await marketAudit(code)).map((a) => a.action)).toEqual(['MARKET_CREATED']);
      // readiness reports the same failing check to management
      const ready = await api('GET', `/markets/${code}/readiness`, reader);
      expect(ready.body.data.ready, code).toBe(false);
      expect(ready.body.data.checks.find((c: { code: string }) => c.code === check).passed, code).toBe(false);
    }
  });

  it('a registered extra readiness check blocks activation with GEOGRAPHY_NOT_READY and details.checks; once it passes the market activates', async () => {
    const code = 'devtest-http-tax';
    expect((await api('POST', '/markets', staff, market(code))).status).toBe(201);
    taxHealthy = false;
    try {
      const ready = await api('GET', `/markets/${code}/readiness`, reader);
      expect(ready.body.data.ready).toBe(false);
      expect(ready.body.data.checks.find((c: { code: string }) => c.code === 'TAX')).toEqual({ code: 'TAX', passed: false, detail: 'no tax rules' });
      const r = await api('POST', `/markets/${code}/activation`, writer, { active: true, reason: 'try' });
      expect([r.status, r.body.error.category, r.body.error.code]).toEqual([409, 'CONFLICT', 'GEOGRAPHY_NOT_READY']);
      expect(r.body.error.details.checks).toEqual([{ code: 'TAX', detail: 'no tax rules' }]);
      expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: code })).toHaveLength(0);
    } finally {
      taxHealthy = true;
    }
    expect((await api('POST', `/markets/${code}/activation`, writer, { active: true, reason: 'ready now' })).body.data.status).toBe('ACTIVE');
  });

  it('concurrent duplicate activation POSTs all succeed and produce exactly one event and one audit row; concurrent duplicate creates produce one market', async () => {
    const code = 'devtest-http-race';
    expect((await api('POST', '/markets', staff, market(code))).status).toBe(201);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => api('POST', `/markets/${code}/activation`, i % 2 ? writer : staff, { active: true, reason: `race ${i}` })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(results.every((r) => r.body.data.status === 'ACTIVE')).toBe(true);
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: code })).toHaveLength(1);
    expect((await marketAudit(code)).filter((a) => a.action === 'MARKET_ACTIVATED')).toHaveLength(1);

    const dup = 'devtest-http-dup';
    const creates = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/markets', staff, market(dup))));
    expect(creates.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(creates.filter((r) => r.status === 409).every((r) => r.body.error.code === 'GEOGRAPHY_CONFLICT')).toBe(true);
    expect(await outbox(GEOGRAPHY_EVENTS.marketCreated, { market: dup })).toHaveLength(1);
    expect((await marketAudit(dup)).map((a) => a.action)).toEqual(['MARKET_CREATED']);
  });

  it('maps the remaining service failures to typed HTTP errors without leaking internals', async () => {
    const cases: [string, 'POST' | 'PUT', string, unknown, number, string][] = [
      ['unknown country', 'POST', '/markets', market('devtest-http-x1', { countryCode: 'QQ' }), 404, 'GEOGRAPHY_COUNTRY_NOT_FOUND'],
      ['unknown currency', 'POST', '/markets', market('devtest-http-x2', { currencyCode: 'XTS' }), 404, 'GEOGRAPHY_CURRENCY_NOT_FOUND'],
      [
        'locale not in country',
        'POST',
        '/markets',
        market('devtest-http-x3', { defaultLocale: 'fr-FR', supportedLocales: ['fr-FR'] }),
        400,
        'GEOGRAPHY_VALIDATION_FAILED',
      ],
      ['time zone not in country', 'POST', '/markets', market('devtest-http-x4', { defaultTimeZone: 'Europe/Paris' }), 400, 'GEOGRAPHY_VALIDATION_FAILED'],
      ['not an IANA zone', 'POST', '/markets', market('devtest-http-x5', { defaultTimeZone: 'Mars/Olympus' }), 400, 'GEOGRAPHY_VALIDATION_FAILED'],
      [
        'window reversed',
        'POST',
        '/markets',
        market('devtest-http-x6', { effectiveFrom: '2030-01-01T00:00:00Z', effectiveTo: '2029-01-01T00:00:00Z' }),
        400,
        'GEOGRAPHY_VALIDATION_FAILED',
      ],
      ['unknown market (update)', 'PUT', '/markets/devtest-http-nope', { name: 'x', reason: 'r' }, 404, 'GEOGRAPHY_MARKET_NOT_FOUND'],
      ['unknown market (activation)', 'POST', '/markets/devtest-http-nope/activation', { active: true, reason: 'r' }, 404, 'GEOGRAPHY_MARKET_NOT_FOUND'],
      ['unknown country (update)', 'PUT', '/countries/QQ', { dialingCode: '+1', reason: 'r' }, 404, 'GEOGRAPHY_COUNTRY_NOT_FOUND'],
      ['unknown country (activation)', 'POST', '/countries/QQ/activation', { active: true, reason: 'r' }, 404, 'GEOGRAPHY_COUNTRY_NOT_FOUND'],
      ['ACTIVE country links are frozen', 'PUT', '/countries/ZZ', { timeZones: ['Asia/Tokyo'], reason: 'r' }, 409, 'GEOGRAPHY_INVALID_STATE'],
      ['unknown field', 'POST', '/markets', { ...market('devtest-http-x7'), surprise: true }, 400, 'VALIDATION_FAILED'],
    ];
    for (const [label, method, url, body, status, code] of cases) {
      const r = await api(method, url, staff, body);
      expect([r.status, r.body.error.code], label).toEqual([status, code]);
      ErrorResponse.parse(r.body);
      expect(JSON.stringify(r.body), label).not.toMatch(/geography\.|SELECT |constraint|fk_|uq_|ck_/);
    }
    // nothing was created by the failed requests
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM geography.markets WHERE code LIKE 'devtest-http-x%'"))[0]!.n).toBe(0);
  });

  it('discloses a planned retirement (effectiveTo) to management only; the public views return null', async () => {
    const code = 'devtest-http-eto';
    const retires = new Date(Date.now() + 365 * 86400e3).toISOString();
    const created = await api('POST', '/markets', staff, market(code, { effectiveTo: retires }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(new Date(created.body.data.effectiveTo).toISOString()).toBe(retires); // the management response keeps it
    expect((await api('POST', `/markets/${code}/activation`, staff, { active: true, reason: 'go live' })).body.data.effectiveTo).toBe(
      created.body.data.effectiveTo,
    );
    for (const t of [undefined, customer]) {
      expect((await api('GET', `/markets/${code}`, t)).body.data.effectiveTo, 'one').toBeNull();
      expect((await api('GET', `/markets/${code}/defaults`, t)).body.data.effectiveTo, 'defaults').toBeNull();
      const listed = (await api('GET', '/markets', t)).body.data.find((m: { code: string }) => m.code === code);
      expect(listed.effectiveTo, 'list').toBeNull();
      expect(JSON.stringify((await api('GET', `/markets/${code}`, t)).body)).not.toContain(retires.slice(0, 10));
    }
    for (const t of [reader, writer, staff]) {
      expect((await api('GET', `/markets/${code}`, t)).body.data.effectiveTo).toBe(created.body.data.effectiveTo);
      expect((await api('GET', `/markets/${code}/defaults`, t)).body.data.effectiveTo).toBe(created.body.data.effectiveTo);
    }
  });

  it('answers 400 and changes nothing for coerced activation bodies ({"active":1}, "true", "false", null), and for control characters in names and reasons', async () => {
    const planned = 'devtest-http-coerce';
    expect((await api('POST', '/markets', staff, market(planned))).status).toBe(201);
    const live = 'devtest-http-coerce-live';
    expect((await api('POST', '/markets', staff, market(live))).status).toBe(201);
    expect((await api('POST', `/markets/${live}/activation`, staff, { active: true, reason: 'live' })).status).toBe(200);
    const eventCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM integration.outbox_events'))[0]!.n;
    const auditCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM geography.audit_events'))[0]!.n;
    const [events, audits] = [await eventCount(), await auditCount()];

    // a PLANNED market must not be activated by a truthy non-boolean; an ACTIVE one must not be deactivated by a falsy one
    for (const active of [1, '1', 'true', 'yes', null, [true], { active: true }]) {
      const r = await api('POST', `/markets/${planned}/activation`, staff, { active, reason: 'must not apply' });
      expect(r.status, JSON.stringify(active)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
    for (const active of [0, '0', 'false', '', null]) {
      expect((await api('POST', `/markets/${live}/activation`, staff, { active, reason: 'must not apply' })).status, JSON.stringify(active)).toBe(400);
      expect((await api('POST', '/countries/ZZ/activation', staff, { active, reason: 'must not apply' })).status, `country ${JSON.stringify(active)}`).toBe(
        400,
      );
    }
    expect(
      (await q<{ code: string; status: string }>('SELECT code, status FROM geography.markets WHERE code = ANY($1)', [[planned, live]])).sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
    ).toEqual([
      { code: planned, status: 'PLANNED' },
      { code: live, status: 'ACTIVE' },
    ]);
    expect((await q<{ status: string }>("SELECT status FROM geography.countries WHERE iso_alpha2 = 'ZZ'"))[0]!.status).toBe('ACTIVE');

    // text hardening: the rejection happens at the contract, so the database never sees a NUL, a newline or a bidi override
    for (const bad of ['Name\u0000Tail', 'two\nlines', 'abc\u202Edef', 'abc\uD800', '   ', '\u00A0\u00A0']) {
      expect((await api('POST', '/markets', staff, market('devtest-http-text', { name: bad }))).status, JSON.stringify(bad)).toBe(400);
      expect((await api('POST', '/markets/' + planned + '/activation', staff, { active: true, reason: bad })).status, `reason ${JSON.stringify(bad)}`).toBe(
        400,
      );
      expect((await api('PUT', '/markets/' + planned, staff, { name: 'fine', reason: bad })).status, `update reason ${JSON.stringify(bad)}`).toBe(400);
    }
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM geography.markets WHERE code = 'devtest-http-text'"))[0]!.n).toBe(0);
    expect(await eventCount()).toBe(events);
    expect(await auditCount()).toBe(audits);
    // real booleans and ordinary non-ASCII text still work
    expect((await api('POST', `/markets/${planned}/activation`, staff, { active: true, reason: 'ahora de verdad' })).body.data.status).toBe('ACTIVE');
    expect((await api('PUT', `/markets/${planned}`, staff, { name: 'São Paulo 東京', reason: 'renombrar' })).body.data.name).toBe('São Paulo 東京');
  });

  it('keeps the seeded data untouched and the public list consistent after the whole flow', async () => {
    expect((await q<{ status: string }>("SELECT status FROM geography.markets WHERE code = 'la-oc'"))[0]!.status).toBe('PLANNED');
    expect(codes((await api('GET', '/countries')).body)).toEqual(['US', 'ZZ']);
    const pubMarkets = codes((await api('GET', '/markets')).body);
    expect(pubMarkets).toEqual(expect.arrayContaining(['devtest-http1', 'devtest-http-race', 'devtest-http-tax']));
    expect(pubMarkets).not.toContain('la-oc');
    expect(pubMarkets).not.toContain('devtest-http-nc');
    const all = codes((await api('GET', '/markets', reader)).body);
    expect(all).toEqual(expect.arrayContaining(['la-oc', 'devtest-http-nc', 'devtest-http1']));
    // reference data the flow touched: the currencies the public never sees stay hidden
    expect((await api('GET', '/currencies')).body.data.map((c: { code: string }) => c.code)).toEqual(['USD']);
    expect((await api('GET', '/currencies', reader)).body.data.map((c: { code: string }) => c.code)).toEqual(['JPY', 'USD', 'XDR']);
  });
});
