// Integration tests: real PostgreSQL (isolated, migrated database: migration 0007 seeds US, USD, four US time zones and the PLANNED market la-oc,
// so tests that need other data create it with unique codes through the service). Cache behaviour uses MemoryConfigCache and hanging/failing clients.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryConfigCache, type ConfigCache } from '@bananagig/configuration';
import { GEOGRAPHY_EVENTS, CountryEventPayload, MarketEventPayload, type CountryDto, type MarketDto } from '@bananagig/contracts';
import { createDatabase } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  GeographyError,
  GeographyService,
  ReadinessRegistry,
  createGeographyScopeReferenceValidator,
  createMarketDefaultsProvider,
  mapDbError,
  type ServiceDeps,
} from './index';

let iso: IsolatedDatabase;
let svc: GeographyService;
let seq = 0;
const ACTOR = 'admin-a';
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);
const mk = (over: Partial<ServiceDeps> = {}) =>
  new GeographyService({ database: db(), env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry(), ...over });
const err = async (p: Promise<unknown>) => (await rejection(p)) as GeographyError | undefined;
const code = async (p: Promise<unknown>) => (await err(p))?.code;
const reason = async (p: Promise<unknown>) => (await err(p))?.details.reason;

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  svc = mk();
});
afterAll(async () => {
  await iso?.drop();
});

const countryReq = (alpha2: string, over: Record<string, unknown> = {}) => ({
  code: alpha2,
  alpha3: `${alpha2}X`,
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
const marketReq = (countryCode: string, over: Record<string, unknown> = {}) => ({
  code: `devtest-m${++seq}`,
  name: 'Test Market Name',
  countryCode,
  defaultLocale: 'en-US',
  currencyCode: 'USD',
  defaultTimeZone: 'America/Denver',
  reason: 'integration test',
  ...over,
});
/** Creates and activates a country (PLANNED first, then the real activation path). */
async function activeCountry(s: GeographyService, alpha2: string, over: Record<string, unknown> = {}) {
  await s.createCountry(countryReq(alpha2, over), ACTOR);
  return s.setCountryActive(alpha2, true, 'activate for test', ACTOR);
}
async function newMarket(s: GeographyService, countryCode: string, over: Record<string, unknown> = {}) {
  const req = marketReq(countryCode, over);
  await s.createMarket(req, ACTOR);
  return req.code as string;
}
const registerLocale = (locale: string, active: boolean) =>
  q('INSERT INTO content.locales (locale, is_active) VALUES ($1, $2) ON CONFLICT (locale) DO UPDATE SET is_active = $2', [locale, active]);
const registerCurrency = (c: string, numeric: string, digits: number, status: string) =>
  q('INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, symbol, status) VALUES ($1, $2, $3, $4, NULL, $5)', [
    c,
    numeric,
    digits,
    `${c} test currency`,
    status,
  ]);
const outbox = (type: string, filter: { market?: string; country?: string }) =>
  q<{ payload_json: Record<string, unknown>; aggregate_type: string; aggregate_id: string; actor_type: string; actor_id: string; correlation_id: string }>(
    `SELECT payload_json, aggregate_type, aggregate_id, actor_type, actor_id, correlation_id FROM integration.outbox_events
      WHERE event_type = $1 AND ($2::text IS NULL OR payload_json->>'marketCode' = $2) AND ($3::text IS NULL OR payload_json->>'countryCode' = $3) ORDER BY created_at, outbox_event_id`,
    [type, filter.market ?? null, filter.country ?? null],
  );
const marketAudit = (marketCode: string) =>
  q<{ action: string; actor: string; changes: Record<string, [unknown, unknown]> | null; reason: string; correlation_id: string; country_id: string | null }>(
    `SELECT a.action, a.actor, a.changes, a.reason, a.correlation_id, a.country_id FROM geography.audit_events a JOIN geography.markets m ON m.market_id = a.market_id
      WHERE m.code = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [marketCode],
  );
const countryAudit = (alpha2: string) =>
  q<{ action: string; actor: string; changes: Record<string, [unknown, unknown]> | null; reason: string; correlation_id: string }>(
    `SELECT a.action, a.actor, a.changes, a.reason, a.correlation_id FROM geography.audit_events a JOIN geography.countries c ON c.country_id = a.country_id
      WHERE c.iso_alpha2 = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [alpha2],
  );
const statusOf = async (table: 'markets' | 'countries', where: string, value: string) =>
  (await q<{ status: string }>(`SELECT status FROM geography.${table} WHERE ${where} = $1`, [value]))[0]!.status;

// ====================================================================== 10, 11. lookups
describe('seeded reference data and lookups (10, 11)', () => {
  it('looks up the seeded United States: public view has no management fields, management view has them; non-canonical codes are not found', async () => {
    const us = await svc.getCountry('US');
    expect(us).toMatchObject({
      code: 'US',
      alpha3: 'USA',
      numeric: '840',
      displayNameContentKey: 'geography.country.us.name',
      dialingCode: '+1',
      defaultCurrencyCode: 'USD',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      distanceUnit: 'MILES',
      firstDayOfWeek: 'SUNDAY',
      dateFormat: 'MDY',
      timeFormat: '12_HOUR',
    });
    expect(us.timeZones).toEqual(['America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York']);
    expect(us).not.toHaveProperty('status');
    expect(us).not.toHaveProperty('createdAt');
    const mgmt = await svc.getCountry('US', { management: true });
    expect(mgmt.status).toBe('ACTIVE');
    expect(typeof mgmt.createdAt).toBe('string');
    for (const bad of ['us', 'USA', 'U', '', 'ZZ', 'QQ']) expect(await code(svc.getCountry(bad))).toBe('COUNTRY_NOT_FOUND');
    expect((await svc.getActiveCountries()).map((c) => c.code)).toContain('US');
    expect((await svc.listCountries()).every((c) => c.status === undefined)).toBe(true);
  });

  it('lists currencies and time zones (USD has 2 minor digits); the public view shows ACTIVE rows only', async () => {
    expect(await svc.getCurrency('USD')).toEqual({ code: 'USD', numericCode: '840', minorUnitDigits: 2, displayName: 'US Dollar', symbol: '$' });
    expect(await code(svc.getCurrency('usd'))).toBe('CURRENCY_NOT_FOUND');
    expect(await code(svc.getCurrency('EUR'))).toBe('CURRENCY_NOT_FOUND');
    expect((await svc.listTimeZones()).map((t) => t.ianaName)).toEqual(['America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York']);
    await registerCurrency('JPY', '392', 0, 'PLANNED');
    expect((await svc.listCurrencies()).map((c) => c.code)).not.toContain('JPY');
    const all = await svc.listCurrencies({ management: true });
    expect(all.find((c) => c.code === 'JPY')).toMatchObject({ minorUnitDigits: 0, status: 'PLANNED' });
  });

  it('the seeded market la-oc is PLANNED: invisible to the public view and excluded from getActiveMarkets, visible to management', async () => {
    expect(await code(svc.getMarket('la-oc'))).toBe('MARKET_NOT_FOUND');
    expect(await code(svc.getMarket('LA-OC'))).toBe('MARKET_NOT_FOUND');
    expect((await svc.getActiveMarkets()).map((m) => m.code)).not.toContain('la-oc');
    expect((await svc.getActiveMarkets({ countryCode: 'US' })).map((m) => m.code)).not.toContain('la-oc');
    const m = await svc.getMarket('la-oc', { management: true });
    expect(m).toMatchObject({
      code: 'la-oc',
      name: 'LA & OC',
      countryCode: 'US',
      defaultLocale: 'en-US',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      status: 'PLANNED',
      effectiveTo: null,
    });
    expect((await svc.listMarkets({ management: true })).map((x) => x.code)).toContain('la-oc');
    expect((await svc.listMarkets({ management: true, countryCode: 'ZZ' })).length).toBe(0);
  });

  it('resolveMarketDefaults for la-oc (management view): en-US, USD, America/Los_Angeles, MILES, SUNDAY, MDY, 12_HOUR; the public view does not resolve a PLANNED market', async () => {
    const d = await svc.resolveMarketDefaults('la-oc', { includeInactive: true });
    expect(d).toMatchObject({
      market: { code: 'la-oc', name: 'LA & OC', countryCode: 'US' },
      country: { code: 'US', dialingCode: '+1' },
      currency: { code: 'USD', minorUnitDigits: 2, symbol: '$' },
      locale: 'en-US',
      supportedLocales: ['en-US'],
      timeZone: 'America/Los_Angeles',
      distanceUnit: 'MILES',
      firstDayOfWeek: 'SUNDAY',
      dateFormat: 'MDY',
      timeFormat: '12_HOUR',
      effectiveTo: null,
    });
    expect(await code(svc.resolveMarketDefaults('la-oc'))).toBe('MARKET_NOT_FOUND');
    expect(await code(svc.resolveMarketDefaults('nowhere', { includeInactive: true }))).toBe('MARKET_NOT_FOUND');
  });
});

// ====================================================================== 12, 19. market lifecycle, events, audit
describe('market lifecycle through the service (12, 19)', () => {
  it('creates a PLANNED market, activates and deactivates it; every step writes an audit row and an identifier-only outbox event', async () => {
    const m = await newMarket(svc, 'US', { name: 'Denver Metro', defaultTimeZone: 'America/Denver' });
    expect((await svc.getMarket(m, { management: true })).status).toBe('PLANNED');
    expect(await code(svc.getMarket(m))).toBe('MARKET_NOT_FOUND');
    expect((await outbox(GEOGRAPHY_EVENTS.marketCreated, { market: m })).length).toBe(1);

    const cid = 'corr-activate-1';
    const active = await runWithCorrelation(cid, () => svc.setMarketActive(m, true, 'go live', ACTOR));
    expect(active.status).toBe('ACTIVE');
    expect((await svc.getMarket(m)).name).toBe('Denver Metro');
    expect((await svc.getActiveMarkets({ countryCode: 'US' })).map((x) => x.code)).toContain(m);
    const ev = await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ aggregate_type: 'geography_market', actor_type: 'user', actor_id: ACTOR, correlation_id: cid });
    expect(ev[0]!.payload_json).toEqual({ marketCode: m, countryCode: 'US' });
    const marketId = (await q<{ market_id: string }>('SELECT market_id FROM geography.markets WHERE code = $1', [m]))[0]!.market_id;
    expect(ev[0]!.aggregate_id).toBe(marketId);

    await svc.setMarketActive(m, false, 'pause', ACTOR);
    expect(await statusOf('markets', 'code', m)).toBe('INACTIVE');
    expect(await code(svc.getMarket(m))).toBe('MARKET_NOT_FOUND');
    expect((await outbox(GEOGRAPHY_EVENTS.marketDeactivated, { market: m })).length).toBe(1);
    await svc.setMarketActive(m, true, 'resume', ACTOR); // INACTIVE -> ACTIVE is allowed
    expect(await statusOf('markets', 'code', m)).toBe('ACTIVE');

    const audit = await marketAudit(m);
    expect(audit.map((a) => a.action)).toEqual(['MARKET_CREATED', 'MARKET_ACTIVATED', 'MARKET_DEACTIVATED', 'MARKET_ACTIVATED']);
    expect(audit[1]).toMatchObject({ actor: ACTOR, reason: 'go live', correlation_id: cid, changes: { status: ['PLANNED', 'ACTIVE'] }, country_id: null });
    expect(audit[2]!.changes).toEqual({ status: ['ACTIVE', 'INACTIVE'] });
  });

  it('deactivating a PLANNED market retires it to INACTIVE (PLANNED is never written back) and a repeat is a no-op', async () => {
    const m = await newMarket(svc, 'US');
    await svc.setMarketActive(m, false, 'never needed', ACTOR);
    expect(await statusOf('markets', 'code', m)).toBe('INACTIVE');
    await svc.setMarketActive(m, false, 'again', ACTOR);
    expect((await marketAudit(m)).map((a) => a.action)).toEqual(['MARKET_CREATED', 'MARKET_DEACTIVATED']);
  });

  it('activation is idempotent: a second activation writes no audit row and no event', async () => {
    const m = await newMarket(svc, 'US');
    await svc.setMarketActive(m, true, 'first', ACTOR);
    const again = await svc.setMarketActive(m, true, 'second', ACTOR);
    expect(again.status).toBe('ACTIVE');
    expect((await marketAudit(m)).filter((a) => a.action === 'MARKET_ACTIVATED')).toHaveLength(1);
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m })).toHaveLength(1);
  });

  it('the allowTestKeys gate: devtest-* markets and the country ZZ need allowTestKeys', async () => {
    const prod = mk({ allowTestKeys: false });
    expect(await reason(prod.createMarket(marketReq('US'), ACTOR))).toBe('TEST_KEY');
    expect(await reason(prod.createCountry(countryReq('ZZ'), ACTOR))).toBe('TEST_KEY');
    expect(await code(prod.createMarket(marketReq('US', { code: 'real-market' }), ACTOR))).toBeUndefined();
    expect((await svc.createCountry(countryReq('ZZ'), ACTOR)).status).toBe('PLANNED');
  });

  it('creating the same market twice is a CONFLICT; unknown country, currency, locale and unsupported time zones are typed', async () => {
    const req = marketReq('US');
    await svc.createMarket(req, ACTOR);
    expect(await code(svc.createMarket(req, ACTOR))).toBe('CONFLICT');
    expect(await code(svc.createMarket(marketReq('QQ'), ACTOR))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(svc.createMarket(marketReq('US', { currencyCode: 'XTS' }), ACTOR))).toBe('CURRENCY_NOT_FOUND');
    expect(await reason(svc.createMarket(marketReq('US', { defaultLocale: 'fr-FR' }), ACTOR))).toBe('LOCALE_NOT_IN_COUNTRY');
    expect(await reason(svc.createMarket(marketReq('US', { defaultTimeZone: 'Europe/Paris' }), ACTOR))).toBe('TIME_ZONE_NOT_IN_COUNTRY');
    expect(await code(svc.createMarket(marketReq('US', { defaultTimeZone: 'Mars/Olympus' }), ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(svc.createMarket({ ...marketReq('US'), extra: 1 }, ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(svc.createMarket(marketReq('US', { effectiveFrom: '2030-01-01T00:00:00Z', effectiveTo: '2029-01-01T00:00:00Z' }), ACTOR))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('a market outside its effective window is not visible publicly but is to management; `at` evaluates the window', async () => {
    const m = await newMarket(svc, 'US', { effectiveFrom: new Date(Date.now() + 3_600_000).toISOString() });
    await svc.setMarketActive(m, true, 'scheduled', ACTOR);
    expect(await code(svc.getMarket(m))).toBe('MARKET_NOT_FOUND');
    expect((await svc.getActiveMarkets()).map((x) => x.code)).not.toContain(m);
    expect(await code(svc.resolveMarketDefaults(m))).toBe('MARKET_NOT_FOUND');
    expect((await svc.getMarket(m, { management: true })).status).toBe('ACTIVE');
    const later = new Date(Date.now() + 2 * 3_600_000);
    expect((await svc.resolveMarketDefaults(m, { at: later })).market.code).toBe(m);
    expect((await svc.getActiveMarkets({ at: later })).map((x) => x.code)).toContain(m);
    // an ended window hides it again
    const e = await newMarket(svc, 'US', {
      effectiveFrom: new Date(Date.now() - 7_200_000).toISOString(),
      effectiveTo: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await svc.setMarketActive(e, true, 'expired', ACTOR);
    expect(await code(svc.getMarket(e))).toBe('MARKET_NOT_FOUND');
  });
});

// ====================================================================== 13-16. activation with typed errors
describe('activation requires ACTIVE dependencies, with typed errors (13, 14, 15, 16)', () => {
  it('country not ACTIVE (13)', async () => {
    await svc.createCountry(countryReq('DE'), ACTOR); // PLANNED
    const m = await newMarket(svc, 'DE');
    const e = await err(svc.setMarketActive(m, true, 'try', ACTOR));
    expect([e?.code, e?.details.reason]).toEqual(['INVALID_STATE', 'COUNTRY_NOT_ACTIVE']);
    expect(e?.details.checks).toEqual([{ code: 'COUNTRY_ACTIVE', detail: 'country DE is PLANNED' }]);
    expect(await statusOf('markets', 'code', m)).toBe('PLANNED');
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m })).toHaveLength(0);
    expect((await marketAudit(m)).map((a) => a.action)).toEqual(['MARKET_CREATED']);
  });

  it('locale not ACTIVE (14)', async () => {
    await registerLocale('fr-CA', false);
    await activeCountry(svc, 'ES', { supportedLocales: ['en-US', 'fr-CA'] });
    const m = await newMarket(svc, 'ES', { defaultLocale: 'fr-CA' });
    expect(await reason(svc.setMarketActive(m, true, 'try', ACTOR))).toBe('LOCALE_NOT_ACTIVE');
    await registerLocale('fr-CA', true);
    expect((await svc.setMarketActive(m, true, 'now it works', ACTOR)).status).toBe('ACTIVE');
  });

  it('currency not ACTIVE (15)', async () => {
    await activeCountry(svc, 'FR');
    const m = await newMarket(svc, 'FR', { currencyCode: 'JPY' }); // JPY is registered PLANNED above
    expect(await reason(svc.setMarketActive(m, true, 'try', ACTOR))).toBe('CURRENCY_NOT_ACTIVE');
    await q("UPDATE geography.currencies SET status = 'ACTIVE' WHERE currency_code = 'JPY'");
    await svc.setMarketActive(m, true, 'ok', ACTOR);
    const d = await svc.resolveMarketDefaults(m);
    expect(d.currency).toEqual({ code: 'JPY', minorUnitDigits: 0, symbol: null });
  });

  it('time zone not ACTIVE (16): unknown valid zones are registered PLANNED and cannot be a market default until ACTIVE', async () => {
    await activeCountry(svc, 'IT', { timeZones: ['America/Denver', 'Europe/London'] });
    expect(await statusOf('countries', 'iso_alpha2', 'IT')).toBe('ACTIVE');
    const m = await newMarket(svc, 'IT', { defaultTimeZone: 'Europe/London' });
    expect(await reason(svc.setMarketActive(m, true, 'try', ACTOR))).toBe('TIME_ZONE_NOT_ACTIVE');
    await q("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'Europe/London'");
    expect((await svc.setMarketActive(m, true, 'ok', ACTOR)).status).toBe('ACTIVE');
    expect((await svc.listTimeZones()).map((t) => t.ianaName)).toContain('Europe/London');
  });

  it('country activation: no ACTIVE time zone, inactive default currency and inactive default locale are typed', async () => {
    await svc.createCountry(countryReq('NL', { timeZones: ['Europe/Paris'] }), ACTOR);
    expect(await reason(svc.setCountryActive('NL', true, 'try', ACTOR))).toBe('NO_ACTIVE_TIME_ZONE');
    await registerCurrency('KWD', '414', 3, 'PLANNED');
    await svc.createCountry(countryReq('SE', { defaultCurrencyCode: 'KWD' }), ACTOR);
    expect(await reason(svc.setCountryActive('SE', true, 'try', ACTOR))).toBe('CURRENCY_NOT_ACTIVE');
    await registerLocale('de-DE', false);
    await svc.createCountry(countryReq('DK', { defaultLocale: 'de-DE', supportedLocales: ['de-DE'] }), ACTOR);
    expect(await reason(svc.setCountryActive('DK', true, 'try', ACTOR))).toBe('LOCALE_NOT_ACTIVE');
    expect(await countryAudit('DK')).toHaveLength(1); // only COUNTRY_CREATED
    expect(await code(svc.createCountry(countryReq('NO', { defaultCurrencyCode: 'XTS' }), ACTOR))).toBe('CURRENCY_NOT_FOUND');
    expect(await code(svc.createCountry(countryReq('NO', { supportedLocales: ['en-US', 'xx-XX'] }), ACTOR))).toBe('LOCALE_NOT_FOUND');
    expect(await reason(svc.createCountry(countryReq('NO', { displayNameContentKey: 'no.such.key' }), ACTOR))).toBe('CONTENT_KEY_NOT_FOUND');
    expect(await code(svc.createCountry(countryReq('NO', { timeZones: ['Mars/Olympus'] }), ACTOR))).toBe('VALIDATION_FAILED');
  });

  it('the database triggers are the safety net: a direct SQL activation fails and mapDbError turns it into the same typed error', async () => {
    const m = (
      await q<{ code: string }>(
        "SELECT code FROM geography.markets WHERE country_id = (SELECT country_id FROM geography.countries WHERE iso_alpha2 = 'DE') LIMIT 1",
      )
    )[0]!.code;
    const e = (await rejection(q("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = $1", [m]))) as { code?: string };
    expect(e.code).toBe('23000');
    const mapped = (() => {
      try {
        return mapDbError(e);
      } catch (x) {
        return x as GeographyError;
      }
    })();
    expect([mapped.code, mapped.details.reason]).toEqual(['INVALID_STATE', 'COUNTRY_NOT_ACTIVE']);
    expect(mapped.message).not.toMatch(/geography\.|trigger|SELECT/i);
    const dup = (await rejection(
      q("INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name) VALUES ('USD', '999', 2, 'dup')"),
    )) as { code?: string; constraint?: string };
    expect(
      ((): string => {
        try {
          return mapDbError(dup);
        } catch (x) {
          return (x as GeographyError).code;
        }
      })(),
    ).toBe('CONFLICT');
  });

  it('a PLANNED country cannot drop a time zone or locale that one of its markets uses (typed IN_USE from the foreign keys)', async () => {
    await svc.createCountry(countryReq('RO', { timeZones: ['America/Denver', 'America/Chicago'] }), ACTOR);
    await newMarket(svc, 'RO', { defaultTimeZone: 'America/Denver' });
    const e = await err(svc.updateCountry('RO', { timeZones: ['America/Chicago'], reason: 'x' }, ACTOR));
    expect([e?.code, e?.details.reason]).toEqual(['INVALID_STATE', 'IN_USE']);
    expect((await svc.getCountry('RO', { management: true })).timeZones).toEqual(['America/Chicago', 'America/Denver']);
  });

  it('a country with ACTIVE markets cannot be deactivated; after the markets are deactivated it can; links of an ACTIVE country are frozen', async () => {
    await activeCountry(svc, 'FI');
    const m = await newMarket(svc, 'FI');
    await svc.setMarketActive(m, true, 'on', ACTOR);
    const e = await err(svc.setCountryActive('FI', false, 'off', ACTOR));
    expect([e?.code, e?.details.reason, e?.details.markets]).toEqual(['INVALID_STATE', 'COUNTRY_HAS_ACTIVE_MARKETS', [m]]);
    expect(
      await reason(svc.updateCountry('FI', { timeZones: ['America/Denver', 'America/Chicago'], supportedLocales: ['en-US'], reason: 'x' }, ACTOR)),
    ).toBeUndefined(); // adding is allowed
    expect(await reason(svc.updateCountry('FI', { timeZones: ['America/Chicago'], reason: 'x' }, ACTOR))).toBe('LINKS_FROZEN');
    await svc.setMarketActive(m, false, 'off', ACTOR);
    expect(await reason(svc.updateCountry('FI', { timeZones: ['America/Chicago'], reason: 'x' }, ACTOR))).toBe('LINKS_FROZEN');
    await svc.setCountryActive('FI', false, 'off', ACTOR);
    expect(await statusOf('countries', 'iso_alpha2', 'FI')).toBe('INACTIVE');
    expect(await code(svc.getCountry('FI'))).toBe('COUNTRY_NOT_FOUND');
  });
});

// ====================================================================== readiness
describe('readiness registry (NOT_READY)', () => {
  it('a custom required check that fails blocks activation with NOT_READY and details.checks; a non-required failing check does not; passing makes it ready', async () => {
    let healthy = false;
    const registry = new ReadinessRegistry();
    registry.register({ code: 'TAX', description: 'tax configured', evaluate: () => ({ passed: healthy, detail: healthy ? 'tax ready' : 'no tax rules' }) });
    registry.register({ code: 'NICE_TO_HAVE', description: 'optional', required: false, evaluate: () => ({ passed: false, detail: 'optional is missing' }) });
    const s = mk({ readiness: registry });
    const m = await newMarket(s, 'US');
    const r = await s.getMarketReadiness(m);
    expect(r.ready).toBe(false);
    expect(r.checks.map((c) => [c.code, c.passed])).toEqual([
      ['COUNTRY_ACTIVE', true],
      ['CURRENCY_ACTIVE', true],
      ['LOCALE_ACTIVE', true],
      ['TIME_ZONE_ACTIVE', true],
      ['TAX', false],
      ['NICE_TO_HAVE', false],
    ]);
    const e = await err(s.setMarketActive(m, true, 'try', ACTOR));
    expect(e?.code).toBe('NOT_READY');
    expect(e?.details.checks).toEqual([{ code: 'TAX', detail: 'no tax rules' }]);
    expect(await statusOf('markets', 'code', m)).toBe('PLANNED');
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m })).toHaveLength(0);
    expect((await marketAudit(m)).map((a) => a.action)).toEqual(['MARKET_CREATED']);
    healthy = true;
    expect((await s.getMarketReadiness(m)).ready).toBe(true);
    expect((await s.setMarketActive(m, true, 'now', ACTOR)).status).toBe('ACTIVE');
    expect(await code(s.getMarketReadiness('no-such-market'))).toBe('MARKET_NOT_FOUND');
  });

  it('a check that throws counts as failed with a fixed detail (no internals leak)', async () => {
    const registry = new ReadinessRegistry();
    registry.register({
      code: 'BOOM',
      description: 'throws',
      evaluate: () => {
        throw new Error('secret connection string postgres://u:p@h');
      },
    });
    const s = mk({ readiness: registry });
    const m = await newMarket(s, 'US');
    const e = await err(s.setMarketActive(m, true, 'try', ACTOR));
    expect(e?.code).toBe('NOT_READY');
    expect(JSON.stringify(e?.details)).not.toMatch(/secret|postgres/);
  });
});

// ====================================================================== 20. concurrency
describe('concurrent activation safety (20)', () => {
  it('two callers activating the same market: both succeed, exactly one event and one audit row', async () => {
    const m = await newMarket(svc, 'US');
    const [a, b] = await Promise.all([svc.setMarketActive(m, true, 'a', 'actor-a'), svc.setMarketActive(m, true, 'b', 'actor-b')]);
    expect([a.status, b.status]).toEqual(['ACTIVE', 'ACTIVE']);
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m })).toHaveLength(1);
    expect((await marketAudit(m)).filter((x) => x.action === 'MARKET_ACTIVATED')).toHaveLength(1);
  });

  it('market activation racing a country deactivation (both queued behind a lock barrier, in a controlled order): the first in the queue wins, the other gets the typed error, never an ACTIVE market in a non-ACTIVE country, no deadlock', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const marketFirst = i % 2 === 0;
      const cc = ['JP', 'KR', 'SG', 'TH', 'VN', 'MY'][i]!;
      await activeCountry(svc, cc);
      const m = await newMarket(svc, cc);
      const holder = await db().pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM geography.countries WHERE iso_alpha2 = $1 FOR UPDATE', [cc]);
        let act: Promise<unknown>;
        let deact: Promise<unknown>;
        if (marketFirst) {
          act = rejection(svc.setMarketActive(m, true, 'activate', ACTOR)); // holds the market row, waits for the country row
          await lockWaiters(1);
          deact = rejection(svc.setCountryActive(cc, false, 'deactivate', ACTOR)); // waits for the market row (lock order: markets first)
          await lockWaiters(2);
        } else {
          deact = rejection(svc.setCountryActive(cc, false, 'deactivate', ACTOR)); // holds the markets (share), waits for the country row
          await lockWaiters(1);
          act = rejection(svc.setMarketActive(m, true, 'activate', ACTOR)); // waits for the market row
          await lockWaiters(2);
        }
        await holder.query('COMMIT');
        const [ea, ed] = (await Promise.all([act, deact])) as (GeographyError | undefined)[];
        const market = await statusOf('markets', 'code', m);
        const country = await statusOf('countries', 'iso_alpha2', cc);
        if (!ea) {
          // the activation won: the country stays ACTIVE and its deactivation is refused with a typed error
          expect([market, country, ed?.code, ed?.details.reason]).toEqual(['ACTIVE', 'ACTIVE', 'INVALID_STATE', 'COUNTRY_HAS_ACTIVE_MARKETS']);
          outcomes.push('market-first');
        } else {
          // the deactivation won: the market stays PLANNED and its activation is refused with a typed error
          expect([ed, market, country, ea.code, ea.details.reason]).toEqual([undefined, 'PLANNED', 'INACTIVE', 'INVALID_STATE', 'COUNTRY_NOT_ACTIVE']);
          outcomes.push('country-first');
        }
        const bad = await q(
          "SELECT 1 FROM geography.markets m JOIN geography.countries c ON c.country_id = m.country_id WHERE m.status = 'ACTIVE' AND c.status <> 'ACTIVE'",
        );
        expect(bad).toHaveLength(0);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    }
    // the queue order decides, and both orders were exercised: three runs each, no other outcome exists
    expect(outcomes).toEqual(['market-first', 'country-first', 'market-first', 'country-first', 'market-first', 'country-first']);
  });
});

describe('market activation winning the race against a country deactivation (20)', () => {
  it('the market activates while the country row is share-locked; the queued country deactivation then sees the committed ACTIVE market and is refused', async () => {
    await activeCountry(svc, 'ID');
    const m = await newMarket(svc, 'ID');
    const holder = await db().pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM geography.countries WHERE iso_alpha2 = $1 FOR SHARE', ['ID']);
      expect((await svc.setMarketActive(m, true, 'activate', ACTOR)).status).toBe('ACTIVE'); // share locks do not conflict
      const deact = rejection(svc.setCountryActive('ID', false, 'deactivate', ACTOR));
      for (let n = 0; n < 100; n++) {
        const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        if (r[0]!.n >= 1) break;
        await sleep(25);
      }
      await holder.query('COMMIT');
      const e = (await deact) as GeographyError;
      expect([e.code, e.details.reason]).toEqual(['INVALID_STATE', 'COUNTRY_HAS_ACTIVE_MARKETS']);
      expect([await statusOf('markets', 'code', m), await statusOf('countries', 'iso_alpha2', 'ID')]).toEqual(['ACTIVE', 'ACTIVE']);
    } finally {
      holder.release();
    }
  });
});

// ====================================================================== updates, diffs, defaults-changed events
describe('updates: field-level audit diffs and market-defaults-changed events', () => {
  it('a market update records {field: [old, new]} and emits market-defaults-changed only for default locale, currency or time zone (names, never values)', async () => {
    await registerLocale('es-US', true);
    await activeCountry(svc, 'PL', { supportedLocales: ['en-US', 'es-US'], timeZones: ['America/Denver', 'America/Chicago'] });
    const m = await newMarket(svc, 'PL');
    const cid = 'corr-update-1';
    await runWithCorrelation(cid, () => svc.updateMarket(m, { name: 'Renamed Market', reason: 'rename' }, ACTOR));
    expect(await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: m })).toHaveLength(0); // a name is not a default
    await svc.updateMarket(m, { supportedLocales: ['en-US', 'es-US'], defaultLocale: 'es-US', defaultTimeZone: 'America/Chicago', reason: 'localize' }, ACTOR);
    const events = await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: m });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload_json).toEqual({ marketCode: m, countryCode: 'PL', changedFields: ['defaultLocale', 'defaultTimeZone'], cause: 'MARKET' });
    expect(JSON.stringify(events[0]!.payload_json)).not.toMatch(/es-US|Chicago|Renamed/);
    const audit = await marketAudit(m);
    expect(audit.map((a) => a.action)).toEqual(['MARKET_CREATED', 'MARKET_UPDATED', 'MARKET_UPDATED']);
    expect(audit[1]).toMatchObject({ actor: ACTOR, reason: 'rename', correlation_id: cid, changes: { name: ['Test Market Name', 'Renamed Market'] } });
    expect(audit[2]!.changes).toEqual({
      defaultLocale: ['en-US', 'es-US'],
      supportedLocales: [['en-US'], ['en-US', 'es-US']],
      defaultTimeZone: ['America/Denver', 'America/Chicago'],
    });
    // replace-set semantics: dropping a locale removes it (the default stays supported)
    const back = await svc.updateMarket(m, { supportedLocales: ['es-US'], reason: 'es only' }, ACTOR);
    expect(back.supportedLocales).toEqual(['es-US']);
    // a no-op update writes nothing
    const before = (await marketAudit(m)).length;
    await svc.updateMarket(m, { name: 'Renamed Market', supportedLocales: ['es-US'], reason: 'nothing' }, ACTOR);
    expect((await marketAudit(m)).length).toBe(before);
    expect(await code(svc.updateMarket(m, { supportedLocales: ['en-US'], reason: 'drops the default' }, ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(svc.updateMarket(m, { name: 'x' }, ACTOR))).toBe('VALIDATION_FAILED'); // reason is required
    expect(await code(svc.updateMarket('no-such', { name: 'x', reason: 'r' }, ACTOR))).toBe('MARKET_NOT_FOUND');
  });

  it('an ACTIVE market cannot be switched to a non-ACTIVE currency or time zone (typed, nothing written)', async () => {
    await activeCountry(svc, 'PT', { timeZones: ['America/Denver', 'Asia/Tokyo'] });
    const m = await newMarket(svc, 'PT');
    await svc.setMarketActive(m, true, 'on', ACTOR);
    const n = (await marketAudit(m)).length;
    expect(await reason(svc.updateMarket(m, { defaultTimeZone: 'Asia/Tokyo', reason: 'move' }, ACTOR))).toBe('TIME_ZONE_NOT_ACTIVE');
    await q(
      "INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, status) VALUES ('CHF', '756', 2, 'Franc', 'PLANNED')",
    );
    expect(await reason(svc.updateMarket(m, { currencyCode: 'CHF', reason: 'move' }, ACTOR))).toBe('CURRENCY_NOT_ACTIVE');
    expect((await marketAudit(m)).length).toBe(n);
    expect((await svc.getMarket(m)).defaultTimeZone).toBe('America/Denver');
  });

  it('a country format update emits market-defaults-changed (cause COUNTRY) for EVERY market of the country and records the diff; non-format changes emit none', async () => {
    await activeCountry(svc, 'AT');
    const m1 = await newMarket(svc, 'AT');
    const m2 = await newMarket(svc, 'AT');
    const other = await newMarket(svc, 'US');
    await svc.setMarketActive(m1, true, 'on', ACTOR);
    await svc.updateCountry('AT', { dialingCode: '+998', reason: 'dial' }, ACTOR);
    for (const m of [m1, m2]) expect(await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: m })).toHaveLength(0);
    await svc.updateCountry('AT', { distanceUnit: 'MILES', timeFormat: '12_HOUR', reason: 'format' }, ACTOR);
    for (const m of [m1, m2]) {
      const ev = await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: m });
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload_json).toEqual({ marketCode: m, countryCode: 'AT', changedFields: ['distanceUnit', 'timeFormat'], cause: 'COUNTRY' });
    }
    expect(await outbox(GEOGRAPHY_EVENTS.marketDefaultsChanged, { market: other })).toHaveLength(0);
    const a = await countryAudit('AT');
    expect(a.map((x) => x.action)).toEqual(['COUNTRY_CREATED', 'COUNTRY_ACTIVATED', 'COUNTRY_UPDATED', 'COUNTRY_UPDATED']);
    expect(a[3]!.changes).toEqual({ distanceUnit: ['KILOMETERS', 'MILES'], timeFormat: ['24_HOUR', '12_HOUR'] });
    expect((await svc.resolveMarketDefaults(m1)).distanceUnit).toBe('MILES');
  });

  it('distance unit, first day and formats come from the country: miles vs kilometers carried through resolveMarketDefaults; JPY 0 and KWD 3 minor digits', async () => {
    await q("UPDATE geography.currencies SET status = 'ACTIVE' WHERE currency_code IN ('KWD', 'JPY')");
    await activeCountry(svc, 'BE', { distanceUnit: 'MILES', firstDayOfWeek: 'SUNDAY', dateFormat: 'MDY', timeFormat: '12_HOUR' });
    await activeCountry(svc, 'CH', { distanceUnit: 'KILOMETERS', firstDayOfWeek: 'MONDAY', dateFormat: 'YMD', timeFormat: '24_HOUR' });
    const mi = await newMarket(svc, 'BE', { currencyCode: 'KWD' });
    const km = await newMarket(svc, 'CH', { currencyCode: 'JPY' });
    await svc.setMarketActive(mi, true, 'on', ACTOR);
    await svc.setMarketActive(km, true, 'on', ACTOR);
    const a = await svc.resolveMarketDefaults(mi);
    const b = await svc.resolveMarketDefaults(km);
    expect([a.distanceUnit, a.firstDayOfWeek, a.dateFormat, a.timeFormat, a.currency.minorUnitDigits]).toEqual(['MILES', 'SUNDAY', 'MDY', '12_HOUR', 3]);
    expect([b.distanceUnit, b.firstDayOfWeek, b.dateFormat, b.timeFormat, b.currency.minorUnitDigits]).toEqual(['KILOMETERS', 'MONDAY', 'YMD', '24_HOUR', 0]);
  });

  it('updateCountry validates: default locale must be supported, unknown codes are typed, nothing changes writes nothing', async () => {
    expect(await code(svc.updateCountry('AT', { defaultLocale: 'es-US', reason: 'r' }, ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(svc.updateCountry('QQ', { dialingCode: '+1', reason: 'r' }, ACTOR))).toBe('COUNTRY_NOT_FOUND');
    const n = (await countryAudit('AT')).length;
    await svc.updateCountry('AT', { dialingCode: '+998', reason: 'same' }, ACTOR);
    expect((await countryAudit('AT')).length).toBe(n);
    expect(await code(svc.setCountryActive('QQ', true, 'r', ACTOR))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(svc.setCountryActive('AT', true, '   ', ACTOR))).toBe('VALIDATION_FAILED');
  });
});

// ====================================================================== 19. outbox contents and audit completeness
describe('outbox payloads and audit completeness (19)', () => {
  it('every geography outbox event carries identifiers only and parses against the contract; country events use the country id', async () => {
    const countryEvents = [...(await outbox(GEOGRAPHY_EVENTS.countryActivated, {})), ...(await outbox(GEOGRAPHY_EVENTS.countryDeactivated, {}))];
    expect(countryEvents.length).toBeGreaterThan(0);
    for (const e of countryEvents) {
      expect(Object.keys(e.payload_json)).toEqual(['countryCode']);
      expect(CountryEventPayload.safeParse(e.payload_json).success).toBe(true);
      expect(e.aggregate_type).toBe('geography_country');
    }
    const ev = await q<{ event_type: string; payload_json: Record<string, unknown>; aggregate_type: string }>(
      "SELECT event_type, payload_json, aggregate_type FROM integration.outbox_events WHERE event_type LIKE 'bananagig.geography.%'",
    );
    expect(ev.length).toBeGreaterThan(10);
    for (const e of ev) {
      expect(['geography_country', 'geography_market']).toContain(e.aggregate_type);
      if (e.aggregate_type === 'geography_market') expect(MarketEventPayload.safeParse(e.payload_json).success).toBe(true);
      expect(Object.keys(e.payload_json).every((k) => ['countryCode', 'marketCode', 'changedFields', 'cause'].includes(k))).toBe(true);
      expect(JSON.stringify(e.payload_json)).not.toMatch(/Test Market Name|Renamed|LA & OC|integration test/);
    }
  });

  it('every management mutation wrote an audit row with actor, reason and correlation id; the table is append-only', async () => {
    const rows = await q<{ actor: string; reason: string | null; correlation_id: string; action: string }>(
      "SELECT actor, reason, correlation_id, action FROM geography.audit_events WHERE actor <> 'system:migration'",
    );
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.actor).toBeTruthy();
      expect(r.reason).toBeTruthy();
      expect(r.correlation_id).toBeTruthy();
    }
    const e = (await rejection(q("UPDATE geography.audit_events SET reason = 'tamper'"))) as { code?: string };
    expect(e.code).toBe('23000');
  });
});

// ====================================================================== 17. scope reference validator
describe('scope reference validator for COUNTRY and MARKET (17)', () => {
  it('accepts canonical existing PLANNED/ACTIVE references; rejects non-canonical, unknown and INACTIVE ones; other scope types are not its domain', async () => {
    const v = createGeographyScopeReferenceValidator(svc);
    expect(await v.validate('COUNTRY', 'US')).toEqual({ valid: true });
    expect(await v.validate('MARKET', 'la-oc')).toEqual({ valid: true }); // PLANNED is allowed
    for (const [t, r] of [
      ['COUNTRY', 'us'],
      ['COUNTRY', 'USA'],
      ['COUNTRY', ' US'],
      ['MARKET', 'LA-OC'],
      ['MARKET', 'la_oc'],
      ['MARKET', ''],
      ['COUNTRY', null],
    ] as const) {
      const res = await v.validate(t, r);
      expect(res.valid, `${t} ${String(r)}`).toBe(false);
    }
    const unknown = await v.validate('MARKET', 'nowhere');
    expect(unknown).toEqual({ valid: false, reason: 'the scope reference is not valid' }); // one generic reason: no registry state is revealed
    expect(await v.validate('COUNTRY', 'QQ')).toMatchObject({ valid: false });
    const retired = await newMarket(svc, 'US');
    await svc.setMarketActive(retired, false, 'retire', ACTOR);
    expect(await v.validate('MARKET', retired)).toEqual(unknown); // INACTIVE reads exactly like unknown
    expect(await v.validate('PLATFORM', null)).toEqual({ valid: true });
    expect(await v.validate('SOMETHING_ELSE', 'x')).toEqual({ valid: true });
    const outage = new GeographyService({
      database: createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 300 } }),
      env: 'test',
    });
    expect(await code(createGeographyScopeReferenceValidator(outage).validate('COUNTRY', 'US'))).toBe('UNAVAILABLE'); // an outage is not "invalid"
  });
});

// ====================================================================== 18. market default provider
describe('market defaults provider (18)', () => {
  it('returns the default locale of an ACTIVE market in effect, null for PLANNED, unknown and malformed codes; memoizes for the TTL', async () => {
    await registerLocale('es-US', true);
    await activeCountry(svc, 'IE', { supportedLocales: ['en-US', 'es-US'] });
    const m = await newMarket(svc, 'IE', { defaultLocale: 'es-US', supportedLocales: ['en-US', 'es-US'] });
    let t = 1_000_000;
    const provider = createMarketDefaultsProvider(svc, { now: () => t });
    expect(await provider.defaultLocale(m)).toBeNull(); // PLANNED
    t += 61_000;
    await svc.setMarketActive(m, true, 'on', ACTOR);
    expect(await provider.defaultLocale(m)).toBe('es-US');
    await svc.setMarketActive(m, false, 'off', ACTOR);
    expect(await provider.defaultLocale(m)).toBe('es-US'); // memo within 60 s
    t += 61_000;
    expect(await provider.defaultLocale(m)).toBeNull();
    expect(await provider.defaultLocale('nowhere')).toBeNull();
    expect(await provider.defaultLocale('NOT A CODE')).toBeNull();
  });

  it('serves the stale value when the database errors', async () => {
    let t = 0;
    let fail = false;
    const flaky = {
      getMarket: async (c: string) => {
        if (fail) throw new GeographyError('UNAVAILABLE', 'down');
        return svc.getMarket(c, { management: true });
      },
    };
    const provider = createMarketDefaultsProvider(flaky, { now: () => t });
    expect(await provider.defaultLocale('la-oc')).toBe('en-US');
    fail = true;
    t += 120_000;
    expect(await provider.defaultLocale('la-oc')).toBe('en-US');
    expect(await code(provider.defaultLocale('never-seen'))).toBe('UNAVAILABLE');
  });
});

// ====================================================================== public locale filtering
describe('public reads advertise only ACTIVE locales', () => {
  it('a deactivated non-default locale disappears from public country, market and defaults reads but stays visible to management', async () => {
    await registerLocale('it-IT', true);
    await activeCountry(svc, 'GR', { supportedLocales: ['en-US', 'it-IT'] });
    const m = await newMarket(svc, 'GR', { supportedLocales: ['en-US', 'it-IT'] });
    await svc.setMarketActive(m, true, 'on', ACTOR);
    expect((await svc.getCountry('GR')).supportedLocales).toEqual(['en-US', 'it-IT']);
    await q("UPDATE content.locales SET is_active = false WHERE locale = 'it-IT'"); // allowed: it is not a default
    expect((await svc.getCountry('GR')).supportedLocales).toEqual(['en-US']);
    expect((await svc.getMarket(m)).supportedLocales).toEqual(['en-US']);
    expect((await svc.resolveMarketDefaults(m)).supportedLocales).toEqual(['en-US']);
    expect((await svc.getActiveCountries()).find((c) => c.code === 'GR')!.supportedLocales).toEqual(['en-US']);
    expect((await svc.getActiveMarkets()).find((x) => x.code === m)!.supportedLocales).toEqual(['en-US']);
    expect((await svc.getCountry('GR', { management: true })).supportedLocales).toEqual(['en-US', 'it-IT']);
    expect((await svc.getMarket(m, { management: true })).supportedLocales).toEqual(['en-US', 'it-IT']);
    expect((await svc.resolveMarketDefaults(m, { includeInactive: true })).supportedLocales).toEqual(['en-US', 'it-IT']);
    await q("UPDATE content.locales SET is_active = true WHERE locale = 'it-IT'");
  });
});

// ====================================================================== cache
describe('cache: hits, invalidation, management bypass, outage', () => {
  it('serves public reads from the cache, invalidates by generation after a committed change, and keeps keys under bg:{env}:geo:v1', async () => {
    const cache = new MemoryConfigCache();
    const s = mk({ cache });
    expect((await s.getCountry('US')).dialingCode).toBe('+1');
    const key = [...cache.data.keys()].find((k) => k.startsWith('bg:test:geo:v1:country:US:'));
    expect(key).toBe('bg:test:geo:v1:country:US:0.0');
    // a change made behind the service's back is NOT seen until the generation moves (proves the read came from the cache)
    await q("UPDATE geography.countries SET dialing_code = '+11' WHERE iso_alpha2 = 'US'");
    expect((await s.getCountry('US')).dialingCode).toBe('+1');
    await q("UPDATE geography.countries SET dialing_code = '+1' WHERE iso_alpha2 = 'US'");
    // a change through the service bumps the generation after commit
    await activeCountry(s, 'CZ');
    expect(cache.data.get('bg:test:geo:gen')).toBeDefined();
    await s.updateCountry('US', { dialingCode: '+1', reason: 'noop' }, ACTOR); // no change: no bump
    const gen = cache.data.get('bg:test:geo:gen');
    await s.updateCountry('CZ', { dialingCode: '+777', reason: 'change' }, ACTOR);
    expect(cache.data.get('bg:test:geo:gen')).not.toBe(gen);
    expect((await s.getCountry('CZ')).dialingCode).toBe('+777');
    // content's locale generation is part of the key: a locale change invalidates public reads too
    await s.getCountry('US');
    const before = [...cache.data.keys()].filter((k) => k.includes(':country:US:'));
    await cache.incr('bg:test:content:locgen');
    await s.getCountry('US');
    expect([...cache.data.keys()].filter((k) => k.includes(':country:US:')).length).toBe(before.length + 1);
  });

  it('a lost generation bump is bounded by the TTL (entries are written with the configured TTL)', async () => {
    const ttls: number[] = [];
    class Spy extends MemoryConfigCache {
      override async set(key: string, value: string, ttl?: number): Promise<void> {
        ttls.push(ttl as number);
        await super.set(key, value);
      }
    }
    const s = mk({ cache: new Spy() as unknown as ConfigCache, cacheTtlSeconds: 42 });
    await s.getActiveCountries();
    expect(ttls).toEqual([42]);
    expect((await mk({ cache: new MemoryConfigCache() }).getActiveCountries()).length).toBeGreaterThan(0);
  });

  it('management reads bypass the cache (a poisoned public entry is served to the public view only)', async () => {
    const cache = new MemoryConfigCache();
    const s = mk({ cache });
    await s.getCountry('US');
    const key = [...cache.data.keys()].find((k) => k.includes(':country:US:'))!;
    const poisoned = JSON.parse(cache.data.get(key)!);
    poisoned.v.dialingCode = '+000';
    cache.data.set(key, JSON.stringify(poisoned));
    expect((await s.getCountry('US')).dialingCode).toBe('+000');
    expect((await s.getCountry('US', { management: true })).dialingCode).toBe('+1');
    cache.data.set(key, '{not json');
    expect((await s.getCountry('US')).dialingCode).toBe('+1'); // malformed entry: a miss
    cache.data.set(key, JSON.stringify({ v: { code: 5 } }));
    expect((await s.getCountry('US')).dialingCode).toBe('+1'); // schema-invalid entry: a miss
    const n = cache.data.size;
    await s.listCountries({ management: true });
    await s.getMarket('la-oc', { management: true });
    await s.resolveMarketDefaults('la-oc', { includeInactive: true });
    expect(cache.data.size).toBe(n);
  });

  it('misses are never cached (PLANNED/unknown keys cannot grow the key space)', async () => {
    const cache = new MemoryConfigCache();
    const s = mk({ cache });
    await err(s.getMarket('la-oc'));
    await err(s.getCountry('QQ'));
    expect([...cache.data.keys()].filter((k) => k.includes(':market:') || k.includes(':country:'))).toEqual([]);
  });

  it('a failing cache degrades to database reads and never changes a result; a hanging cache does not slow reads (bounded by the deadline)', async () => {
    const memory = new MemoryConfigCache();
    const s = mk({ cache: memory });
    await s.getCountry('US');
    memory.fail = true;
    expect((await s.getCountry('US')).code).toBe('US');
    await activeCountry(s, 'HU');
    expect((await s.getCountry('HU')).code).toBe('HU');

    const never = () => new Promise<never>(() => undefined);
    const hang: ConfigCache = { get: never, mget: never, set: never, incr: never };
    const hs = mk({ cache: hang, cacheDeadlineMs: 100 });
    const t0 = Date.now();
    expect((await hs.getCountry('US')).code).toBe('US');
    expect((await hs.getActiveCountries()).length).toBeGreaterThan(0);
    const readMs = Date.now() - t0;
    expect(readMs).toBeLessThan(1500); // one deadline per read at most, never per key
    const t1 = Date.now();
    await hs.updateCountry('HU', { dialingCode: '+555', reason: 'while the cache hangs' }, ACTOR);
    expect(Date.now() - t1).toBeLessThan(2000);
    expect((await mk().getCountry('HU', { management: true })).dialingCode).toBe('+555');

    const slowFail: ConfigCache = {
      get: () => new Promise((_, rej) => setTimeout(() => rej(new Error('ECONNREFUSED')), 3000)),
      mget: () => new Promise((_, rej) => setTimeout(() => rej(new Error('ECONNREFUSED')), 3000)),
      set: () => new Promise((_, rej) => setTimeout(() => rej(new Error('ECONNREFUSED')), 3000)),
      incr: () => new Promise((_, rej) => setTimeout(() => rej(new Error('ECONNREFUSED')), 3000)),
    };
    const t2 = Date.now();
    expect((await mk({ cache: slowFail, cacheDeadlineMs: 100 }).getCountry('US')).code).toBe('US');
    expect(Date.now() - t2).toBeLessThan(1500);
  });
});

// ====================================================================== review fixes: lock then read, one lock order, retryable conflicts
/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
/** Runs `fn` with a connection of its own that is rolled back (if still open) and released afterwards. */
async function withConnection<T>(fn: (c: { query: (text: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>): Promise<T> {
  const c = await db().pool.connect();
  try {
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const settled = <T>(p: Promise<T>): Promise<T | GeographyError> =>
  p.then(
    (v) => v,
    (e: unknown) => e as GeographyError,
  );
const outcomeOf = (r: unknown): string => (r instanceof Error ? `${(r as GeographyError).code}/${(r as GeographyError).details?.reason ?? ''}` : 'ok');

describe('lock, then read: a caller that waited for a row lock works on the committed state (D1)', () => {
  it('updateCountry re-reads the link sets after the lock wait: the audit diff is correct and a locale added meanwhile is not inserted twice (was: CONFLICT)', async () => {
    await registerLocale('nl-NL', true);
    await registerLocale('pt-BR', true);
    await activeCountry(svc, 'BG', { supportedLocales: ['en-US'] });
    await withConnection(async (holder) => {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM geography.countries WHERE iso_alpha2 = $1 FOR UPDATE', ['BG']);
      const second = settled(svc.updateCountry('BG', { supportedLocales: ['en-US', 'nl-NL', 'pt-BR'], reason: 'second caller' }, ACTOR));
      await lockWaiters(1);
      // the first caller finishes while the second one waits: it adds nl-NL and commits
      await holder.query(
        "INSERT INTO geography.country_locales (country_id, locale) SELECT country_id, 'nl-NL' FROM geography.countries WHERE iso_alpha2 = 'BG'",
      );
      await holder.query("UPDATE geography.countries SET updated_at = now() WHERE iso_alpha2 = 'BG'");
      await holder.query('COMMIT');
      const result = await second;
      expect(result).not.toBeInstanceOf(Error);
      expect((result as CountryDto).supportedLocales).toEqual(['en-US', 'nl-NL', 'pt-BR']);
    });
    const audit = await countryAudit('BG');
    expect(audit.map((a) => a.action)).toEqual(['COUNTRY_CREATED', 'COUNTRY_ACTIVATED', 'COUNTRY_UPDATED']);
    expect(audit[2]!.changes).toEqual({
      supportedLocales: [
        ['en-US', 'nl-NL'],
        ['en-US', 'nl-NL', 'pt-BR'],
      ],
    }); // `before` includes what committed meanwhile
  });

  it('identical concurrent updateCountry and updateMarket calls (a double submit) are BOTH successes: final sets correct, exactly one audit row per change', async () => {
    const locales = ['es-ES', 'fr-FR', 'pt-PT', 'nl-BE', 'sv-SE', 'da-DK'];
    for (const l of locales) await registerLocale(l, true);
    await svc.createCountry(countryReq('HR', { supportedLocales: ['en-US'] }), ACTOR);
    const m = await newMarket(svc, 'HR');
    let set = ['en-US'];
    for (const l of locales) {
      set = [...set, l].sort();
      const body = { supportedLocales: set, reason: 'double submit' };
      expect((await Promise.all([settled(svc.updateCountry('HR', body, ACTOR)), settled(svc.updateCountry('HR', body, ACTOR))])).map(outcomeOf)).toEqual([
        'ok',
        'ok',
      ]);
      expect((await Promise.all([settled(svc.updateMarket(m, body, ACTOR)), settled(svc.updateMarket(m, body, ACTOR))])).map(outcomeOf)).toEqual(['ok', 'ok']);
    }
    expect((await svc.getCountry('HR', { management: true })).supportedLocales).toEqual(set);
    expect((await svc.getMarket(m, { management: true })).supportedLocales).toEqual(set);
    expect((await countryAudit('HR')).filter((a) => a.action === 'COUNTRY_UPDATED')).toHaveLength(locales.length);
    expect((await marketAudit(m)).filter((a) => a.action === 'MARKET_UPDATED')).toHaveLength(locales.length);
  });

  it('updateMarket and setMarketActive that waited for the market lock see the committed default time zone: no spurious MARKET_NOT_FOUND, the audit diff is right', async () => {
    await activeCountry(svc, 'SK', { timeZones: ['America/Denver', 'America/Chicago'] });
    const renamed = await newMarket(svc, 'SK', { defaultTimeZone: 'America/Denver' });
    const activated = await newMarket(svc, 'SK', { defaultTimeZone: 'America/Denver' });
    const whileMovedToChicago = (market: string, action: () => Promise<unknown>) =>
      withConnection(async (holder) => {
        await holder.query('BEGIN');
        await holder.query(
          "UPDATE geography.markets SET default_time_zone_id = (SELECT time_zone_id FROM geography.time_zones WHERE iana_name = 'America/Chicago'), updated_at = now() WHERE code = $1",
          [market],
        );
        const pending = settled(action());
        await lockWaiters(1);
        await holder.query('COMMIT');
        return pending;
      });
    const u = await whileMovedToChicago(renamed, () => svc.updateMarket(renamed, { name: 'Renamed while waiting', reason: 'rename' }, ACTOR));
    expect(u).not.toBeInstanceOf(Error);
    expect(u).toMatchObject({ name: 'Renamed while waiting', defaultTimeZone: 'America/Chicago' });
    expect((await marketAudit(renamed)).at(-1)!.changes).toEqual({ name: ['Test Market Name', 'Renamed while waiting'] }); // the zone change is not part of this diff
    const a = await whileMovedToChicago(activated, () => svc.setMarketActive(activated, true, 'go live', ACTOR));
    expect(a).not.toBeInstanceOf(Error);
    expect(a).toMatchObject({ status: 'ACTIVE', defaultTimeZone: 'America/Chicago' });
  });
});

describe('one lock order and typed, retryable conflicts (D3)', () => {
  it('updateCountry removing a time zone a market uses never deadlocks with updateMarket (the market lock comes first) and answers IN_USE', async () => {
    await svc.createCountry(countryReq('SI', { timeZones: ['America/Denver', 'America/Chicago'] }), ACTOR);
    const m = await newMarket(svc, 'SI', { defaultTimeZone: 'America/Denver' });
    const e = await withConnection(async (holder) => {
      // the lock pattern of updateMarket: the market row first ...
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM geography.markets WHERE code = $1 FOR UPDATE', [m]);
      const removal = err(svc.updateCountry('SI', { timeZones: ['America/Chicago'], reason: 'drop denver' }, ACTOR));
      await lockWaiters(1);
      // ... then the country row. Before the fix updateCountry held the country and waited for the market: a deadlock (40P01) in every attempt.
      await holder.query('SELECT 1 FROM geography.countries WHERE iso_alpha2 = $1 FOR SHARE', ['SI']);
      await holder.query('COMMIT');
      return removal;
    });
    expect([e?.code, e?.details.reason, e?.details.timeZones]).toEqual(['INVALID_STATE', 'IN_USE', ['America/Denver']]);
    expect((await svc.getCountry('SI', { management: true })).timeZones).toEqual(['America/Chicago', 'America/Denver']);
  });

  it('overlapping updateCountry (drop a zone a market uses) and updateMarket (rename): ten pairs, only IN_USE and success, no deadlock', async () => {
    const m = (await q<{ code: string }>("SELECT m.code FROM geography.markets m JOIN geography.countries c USING (country_id) WHERE c.iso_alpha2 = 'SI'"))[0]!
      .code;
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const c = settled(svc.updateCountry('SI', { timeZones: ['America/Chicago'], reason: 'drop denver' }, ACTOR));
      await sleep((i % 4) * 3);
      const u = settled(svc.updateMarket(m, { name: `Renamed ${i}`, reason: 'rename' }, ACTOR));
      outcomes.push(...(await Promise.all([c, u])).map(outcomeOf));
    }
    expect(outcomes.filter((o) => o === 'INVALID_STATE/IN_USE')).toHaveLength(10);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(10);
  });

  it('a genuine deadlock (raw zone deactivation against a market activation) is a retryable CONFLICT / CONCURRENT_UPDATE, nothing is half-written, and the retry succeeds', async () => {
    await activeCountry(svc, 'LT', { timeZones: ['America/Denver', 'Pacific/Fiji'] });
    await q("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'Pacific/Fiji'");
    const m = await newMarket(svc, 'LT', { defaultTimeZone: 'Pacific/Fiji' });
    await withConnection(async (holder) => {
      await holder.query('BEGIN');
      await holder.query("SELECT 1 FROM geography.time_zones WHERE iana_name = 'Pacific/Fiji' FOR UPDATE");
      // the activation holds the market and a share lock on the country, then waits for the zone ...
      const activation = settled(svc.setMarketActive(m, true, 'go live', ACTOR));
      await lockWaiters(1);
      // ... while the zone deactivation, which holds the zone row, needs the country row: a cycle. PostgreSQL aborts the waiter that started first (after deadlock_timeout, 1 s).
      const deactivation = holder.query("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'Pacific/Fiji'").then(
        () => 'deactivated',
        (e: { code?: string }) => `raw ${e.code}`,
      );
      const result = await activation;
      expect(result).toBeInstanceOf(GeographyError);
      expect({ code: (result as GeographyError).code, details: (result as GeographyError).details }).toEqual({
        code: 'CONFLICT',
        details: { reason: 'CONCURRENT_UPDATE', retryable: true },
      });
      expect(await deactivation).toBe('deactivated');
      await holder.query('COMMIT');
    });
    expect(await statusOf('markets', 'code', m)).toBe('PLANNED');
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m })).toHaveLength(0);
    expect((await marketAudit(m)).map((a) => a.action)).toEqual(['MARKET_CREATED']);
    await q("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'Pacific/Fiji'");
    expect((await svc.setMarketActive(m, true, 'retry', ACTOR)).status).toBe('ACTIVE');
  });
});

describe('retiring a PLANNED country or market (D-design)', () => {
  it('PLANNED to INACTIVE is audited but emits no deactivated event; only ACTIVE to INACTIVE emits, exactly once; repeats are no-ops', async () => {
    await svc.createCountry(countryReq('LV'), ACTOR);
    await svc.setCountryActive('LV', false, 'never launched', ACTOR);
    expect(await statusOf('countries', 'iso_alpha2', 'LV')).toBe('INACTIVE');
    let audit = await countryAudit('LV');
    expect(audit.map((a) => a.action)).toEqual(['COUNTRY_CREATED', 'COUNTRY_DEACTIVATED']);
    expect(audit[1]!.changes).toEqual({ status: ['PLANNED', 'INACTIVE'] });
    expect(await outbox(GEOGRAPHY_EVENTS.countryDeactivated, { country: 'LV' })).toHaveLength(0);
    await svc.setCountryActive('LV', true, 'relaunch', ACTOR);
    await svc.setCountryActive('LV', true, 'relaunch again', ACTOR); // activation stays idempotent
    expect(await outbox(GEOGRAPHY_EVENTS.countryActivated, { country: 'LV' })).toHaveLength(1);
    await svc.setCountryActive('LV', false, 'retire', ACTOR);
    await svc.setCountryActive('LV', false, 'retire again', ACTOR);
    expect(await outbox(GEOGRAPHY_EVENTS.countryDeactivated, { country: 'LV' })).toHaveLength(1);
    audit = await countryAudit('LV');
    expect(audit.map((a) => a.action)).toEqual(['COUNTRY_CREATED', 'COUNTRY_DEACTIVATED', 'COUNTRY_ACTIVATED', 'COUNTRY_DEACTIVATED']);

    const m = await newMarket(svc, 'US');
    await svc.setMarketActive(m, false, 'never launched', ACTOR);
    expect((await marketAudit(m)).map((a) => a.action)).toEqual(['MARKET_CREATED', 'MARKET_DEACTIVATED']);
    expect((await marketAudit(m))[1]!.changes).toEqual({ status: ['PLANNED', 'INACTIVE'] });
    expect(await outbox(GEOGRAPHY_EVENTS.marketDeactivated, { market: m })).toHaveLength(0);
    await svc.setMarketActive(m, true, 'relaunch', ACTOR);
    await svc.setMarketActive(m, true, 'relaunch again', ACTOR);
    await svc.setMarketActive(m, false, 'retire', ACTOR);
    await svc.setMarketActive(m, false, 'retire again', ACTOR);
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m })).toHaveLength(1);
    expect(await outbox(GEOGRAPHY_EVENTS.marketDeactivated, { market: m })).toHaveLength(1);
  });
});

describe('public country time zones (S2/A4)', () => {
  it('the public country DTO (read, list and cached view) lists ACTIVE time zones only; management lists every status', async () => {
    const cache = new MemoryConfigCache();
    const s = mk({ cache });
    await activeCountry(s, 'EE', { timeZones: ['America/Denver', 'Pacific/Auckland'] }); // Auckland is registered PLANNED
    expect((await s.getCountry('EE')).timeZones).toEqual(['America/Denver']);
    expect((await s.getCountry('EE')).timeZones).toEqual(['America/Denver']); // second read: from the cache
    expect((await s.getActiveCountries()).find((c) => c.code === 'EE')!.timeZones).toEqual(['America/Denver']);
    expect((await s.listCountries()).find((c) => c.code === 'EE')!.timeZones).toEqual(['America/Denver']);
    const key = [...cache.data.keys()].find((k) => k.includes(':country:EE:'))!;
    expect((JSON.parse(cache.data.get(key)!) as { v: CountryDto }).v.timeZones).toEqual(['America/Denver']); // the cached public value never held the PLANNED zone
    expect((await s.getCountry('EE', { management: true })).timeZones).toEqual(['America/Denver', 'Pacific/Auckland']);
    expect((await s.listCountries({ management: true })).find((c) => c.code === 'EE')!.timeZones).toEqual(['America/Denver', 'Pacific/Auckland']);
    // a zone that becomes ACTIVE appears after the next service change (generation bump); there is no service operation that changes a zone status
    await q("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'Pacific/Auckland'");
    await s.updateCountry('EE', { dialingCode: '+997', reason: 'bump the generation' }, ACTOR);
    expect((await s.getCountry('EE')).timeZones).toEqual(['America/Denver', 'Pacific/Auckland']);
  });
});

describe('input hardening in the service layer (S5/A3)', () => {
  it('NUL characters are VALIDATION_FAILED / FORBIDDEN_CHARACTER (not a 500) and the transaction leaves nothing behind', async () => {
    const m = await newMarket(svc, 'US');
    const reasonNul = await err(svc.setMarketActive(m, true, 'bad\u0000reason', ACTOR));
    expect([reasonNul?.code, reasonNul?.details.reason]).toEqual(['VALIDATION_FAILED', 'FORBIDDEN_CHARACTER']);
    const actorNul = await err(svc.setMarketActive(m, true, 'fine', 'actor\u0000x'));
    expect([actorNul?.code, actorNul?.details.reason]).toEqual(['VALIDATION_FAILED', 'FORBIDDEN_CHARACTER']);
    expect(await statusOf('markets', 'code', m)).toBe('PLANNED');
    expect((await marketAudit(m)).map((a) => a.action)).toEqual(['MARKET_CREATED']);
    expect(await outbox(GEOGRAPHY_EVENTS.marketActivated, { market: m })).toHaveLength(0);
    // a NUL inside a field value is rejected too (by the request contract or, at the latest, by the database)
    expect((await err(svc.updateMarket(m, { name: 'a\u0000b', reason: 'r' }, ACTOR)))?.code).toBe('VALIDATION_FAILED');
  });

  it('effective window: instants are validated (years 1970 to 9999) and written as Date values; an untouched end of the window is kept; null clears it', async () => {
    const m = await newMarket(svc, 'US');
    for (const [field, value] of [
      ['effectiveTo', '9999-12-31T23:59:59-23:59'], // the instant lies in year 10000 although the text says 9999: used to reach PostgreSQL as +010000-... (a 500)
      ['effectiveFrom', '0001-01-01T00:00:00Z'],
      ['effectiveFrom', '1969-12-31T23:59:59Z'],
    ] as const) {
      const e = await err(svc.updateMarket(m, { [field]: value, reason: 'r' }, ACTOR));
      expect([e?.code, e?.details.field]).toEqual(['VALIDATION_FAILED', field]);
    }
    expect((await err(svc.createMarket(marketReq('US', { effectiveTo: '9999-12-31T23:59:59-23:59' }), ACTOR)))?.code).toBe('VALIDATION_FAILED');
    const max = await svc.updateMarket(m, { effectiveTo: '9999-12-31T23:59:59.999Z', reason: 'longest window' }, ACTOR);
    expect(max.effectiveTo).toBe('9999-12-31T23:59:59.999Z');
    expect((await marketAudit(m)).at(-1)!.changes).toEqual({ effectiveTo: [null, '9999-12-31T23:59:59.999Z'] });
    expect((await svc.updateMarket(m, { name: 'Window untouched', reason: 'rename' }, ACTOR)).effectiveTo).toBe('9999-12-31T23:59:59.999Z');
    const from = await svc.updateMarket(m, { effectiveFrom: '2031-05-05T05:05:05+02:00', reason: 'later start' }, ACTOR);
    expect([from.effectiveFrom, from.effectiveTo]).toEqual(['2031-05-05T03:05:05.000Z', '9999-12-31T23:59:59.999Z']);
    expect((await svc.updateMarket(m, { effectiveTo: null, reason: 'open end' }, ACTOR)).effectiveTo).toBeNull();
    expect((await err(svc.updateMarket(m, { effectiveTo: '2031-05-05T03:05:05Z', reason: 'ends when it starts' }, ACTOR)))?.code).toBe('VALIDATION_FAILED');
    const typed: MarketDto = await svc.getMarket(m, { management: true });
    expect(typed.effectiveFrom).toBe('2031-05-05T03:05:05.000Z');
  });
});

describe('time zone registration and guard keys (D4, D5)', () => {
  it('registerTimeZones proposes only the names that are missing: the guard trigger scans tzdata once for every proposed row, even one ON CONFLICT then discards', async () => {
    await q('CREATE TABLE test_tz_proposed (iana_name text)');
    await q(
      'CREATE FUNCTION test_tz_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO test_tz_proposed VALUES (NEW.iana_name); RETURN NEW; END $$',
    );
    await q('CREATE TRIGGER trg_test_tz_log BEFORE INSERT ON geography.time_zones FOR EACH ROW EXECUTE FUNCTION test_tz_log()');
    try {
      const proposed = async () => (await q<{ iana_name: string }>('SELECT iana_name FROM test_tz_proposed ORDER BY iana_name')).map((r) => r.iana_name);
      await svc.createCountry(countryReq('NZ', { timeZones: ['America/Denver', 'America/Chicago', 'Asia/Kolkata'] }), ACTOR);
      expect(await proposed()).toEqual(['Asia/Kolkata']); // Denver and Chicago are registered: not proposed
      await q('TRUNCATE test_tz_proposed');
      await svc.updateCountry('NZ', { timeZones: ['America/Denver', 'Asia/Kolkata', 'Pacific/Guam'], reason: 'one new zone' }, ACTOR);
      expect(await proposed()).toEqual(['Pacific/Guam']);
      await q('TRUNCATE test_tz_proposed');
      await svc.updateCountry('NZ', { timeZones: ['America/Denver', 'Pacific/Guam'], reason: 'only known zones' }, ACTOR);
      expect(await proposed()).toEqual([]);
    } finally {
      await q('DROP TRIGGER trg_test_tz_log ON geography.time_zones');
      await q('DROP FUNCTION test_tz_log()');
      await q('DROP TABLE test_tz_proposed');
    }
  });

  it('posix/ and right/ alias names and unknown zones are refused with a typed error (the trigger refuses them too: see geography-seed.itest.ts)', async () => {
    for (const z of ['posix/America/Denver', 'right/UTC', 'Mars/Olympus_Mons'])
      expect(await code(svc.updateCountry('NZ', { timeZones: ['America/Denver', z], reason: 'alias' }, ACTOR))).toBe('VALIDATION_FAILED');
    const direct = (await rejection(q("INSERT INTO geography.time_zones (iana_name) VALUES ('posix/America/Denver')"))) as { code?: string; detail?: string };
    expect([direct.code, direct.detail]).toEqual(['23000', 'geography_rule:NOT_IANA']);
    expect(
      ((): GeographyError => {
        try {
          return mapDbError(direct);
        } catch (x) {
          return x as GeographyError;
        }
      })(),
    ).toMatchObject({ code: 'TIME_ZONE_NOT_FOUND', details: { reason: 'UNKNOWN_IANA_ZONE' } });
  });

  it('a market code that contains rule words cannot change the classification of a trigger error that went through the real driver', async () => {
    await registerLocale('es-MX', false);
    await activeCountry(svc, 'AU', { supportedLocales: ['en-US', 'es-MX'] });
    const m = await newMarket(svc, 'AU', { code: 'devtest-currency-country', defaultLocale: 'es-MX', supportedLocales: ['en-US', 'es-MX'] });
    const e = (await rejection(q("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = $1", [m]))) as {
      code?: string;
      message?: string;
      detail?: string;
    };
    expect(e.message).toContain('devtest-currency-country');
    expect(e.detail).toBe('geography_rule:LOCALE_NOT_ACTIVE');
    const mapped = ((): GeographyError => {
      try {
        return mapDbError(e);
      } catch (x) {
        return x as GeographyError;
      }
    })();
    expect([mapped.code, mapped.details.reason]).toEqual(['INVALID_STATE', 'LOCALE_NOT_ACTIVE']); // the old regex over the message answered CURRENCY_NOT_ACTIVE
  });
});

describe('assigned country codes and canonical time zones (C3, C4)', () => {
  it('createCountry accepts assigned regions (DE), refuses unassigned codes and groupings with VALIDATION_FAILED and writes nothing, and keeps ZZ behind the test-key gate', async () => {
    const countriesBefore = (await q<{ n: number }>('SELECT count(*)::int AS n FROM geography.countries'))[0]!.n;
    for (const bad of ['QQ', 'AA', 'EU', 'XA']) {
      const e = await err(svc.createCountry(countryReq(bad), ACTOR));
      expect([bad, e?.code, e?.details.field]).toEqual([bad, 'VALIDATION_FAILED', 'code']);
    }
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM geography.countries'))[0]!.n).toBe(countriesBefore);
    expect((await svc.createCountry(countryReq('LU'), ACTOR)).code).toBe('LU');
    expect(await reason(mk({ allowTestKeys: false }).createCountry(countryReq('ZZ'), ACTOR))).toBe('TEST_KEY');
  });

  it('time zones: canonical regional names (also the IANA names the CLDR list spells differently) are accepted; fixed offsets, legacy aliases and wrong-case names are VALIDATION_FAILED', async () => {
    await svc.createCountry(countryReq('MT', { timeZones: ['Europe/Malta', 'Pacific/Honolulu', 'Asia/Kolkata'] }), ACTOR);
    expect((await svc.getCountry('MT', { management: true })).timeZones).toEqual(['Asia/Kolkata', 'Europe/Malta', 'Pacific/Honolulu']);
    for (const zone of ['Etc/GMT+5', 'EST', 'GMT-0', 'us/pacific', 'US/Pacific', 'UTC+5', 'posix/America/Denver', 'right/UTC'])
      expect(await code(svc.updateCountry('MT', { timeZones: ['Europe/Malta', zone], reason: 'alias' }, ACTOR)), zone).toBe('VALIDATION_FAILED');
    expect(await code(svc.createMarket(marketReq('US', { defaultTimeZone: 'Etc/GMT+5' }), ACTOR))).toBe('VALIDATION_FAILED');
    // none of them was registered, the database trigger never saw them
    expect(await q("SELECT iana_name FROM geography.time_zones WHERE iana_name IN ('Etc/GMT+5', 'EST', 'GMT-0', 'us/pacific', 'US/Pacific')")).toEqual([]);
  });
});

// ====================================================================== database outage
describe('database outage', () => {
  it('reads and writes fail typed (UNAVAILABLE) without leaking connection details', async () => {
    const broken = createDatabase('postgres://nobody:secretpw@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 300 } });
    try {
      const s = new GeographyService({ database: broken, env: 'test', allowTestKeys: true });
      for (const p of [
        s.getCountry('US'),
        s.getActiveMarkets(),
        s.resolveMarketDefaults('la-oc'),
        s.setMarketActive('la-oc', true, 'r', ACTOR),
        s.createMarket(marketReq('US'), ACTOR),
      ]) {
        const e = await err(p);
        expect(e?.code).toBe('UNAVAILABLE');
        expect(JSON.stringify([e?.message, e?.details])).not.toMatch(/secretpw|127\.0\.0\.1/);
      }
    } finally {
      await broken.close();
    }
  });
});
