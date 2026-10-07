// Unit tests of the service against a scripted database: a real Database whose pool hands out a fake client that answers by SQL text.
// No network is used. Behaviour that needs real constraints, triggers and locks is covered in geography.itest.ts.
import { describe, expect, it } from 'vitest';
import { MemoryConfigCache } from '@bananagig/configuration';
import { createDatabase } from '@bananagig/database';
import { GeographyError } from './errors';
import { GeographyService, buildMarketDefaults, diffFields, inEffect, mapCountry, mapDbError, mapMarket } from './service';

type Row = Record<string, unknown>;
type Handler = [RegExp, (params: unknown[]) => Row[]];
function scripted(handlers: Handler[]) {
  const database = createDatabase('postgres://x:x@127.0.0.1:1/x', { role: 'tests' });
  const log: { text: string; params: unknown[] }[] = [];
  (database.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
    query: async (text: string, params: unknown[]) => {
      log.push({ text, params });
      const rows = handlers.find(([re]) => re.test(text))?.[1](params) ?? [];
      return { rows, rowCount: rows.length, command: 'SELECT' };
    },
    release: () => undefined,
  });
  return { database, log };
}
const T0 = new Date('2026-06-01T12:00:00Z');
const defaultsRow = (over: Row = {}): Row => ({
  code: 'la-oc',
  name: 'LA & OC',
  status: 'ACTIVE',
  default_locale: 'en-US',
  effective_from: new Date('2026-01-01T00:00:00Z'),
  effective_to: null,
  country_code: 'US',
  dialing_code: '+1',
  country_status: 'ACTIVE',
  distance_unit: 'MILES',
  first_day_of_week: 'SUNDAY',
  date_format_code: 'MDY',
  time_format_code: '12_HOUR',
  currency_code: 'USD',
  minor_unit_digits: 2,
  symbol: '$',
  currency_status: 'ACTIVE',
  time_zone: 'America/Los_Angeles',
  time_zone_status: 'ACTIVE',
  supported_locales: ['en-US'],
  ...over,
});
const service = (rows: Row[], over: { cache?: MemoryConfigCache } = {}) => {
  const { database, log } = scripted([[/FROM geography\.markets m\s+LEFT JOIN/, () => rows]]);
  return { svc: new GeographyService({ database, env: 'test', now: () => T0, ...over }), log };
};
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as GeographyError;
  }
  throw new Error('expected a failure');
};

describe('market-default resolution shape (5)', () => {
  it('assembles the MarketDefaultsDto from market, country and currency rows with no extra fields', async () => {
    const { svc } = service([defaultsRow()]);
    const d = await svc.resolveMarketDefaults('la-oc');
    expect(d).toEqual({
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
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    });
  });

  it('uses the currency of the row (JPY 0 digits, KWD 3 digits, no symbol) with no code fallback (2)', async () => {
    const jpy = await service([defaultsRow({ currency_code: 'JPY', minor_unit_digits: 0, symbol: '¥' })]).svc.resolveMarketDefaults('la-oc');
    expect(jpy.currency).toEqual({ code: 'JPY', minorUnitDigits: 0, symbol: '¥' });
    const kwd = await service([defaultsRow({ currency_code: 'KWD', minor_unit_digits: 3, symbol: null })]).svc.resolveMarketDefaults('la-oc');
    expect(kwd.currency).toEqual({ code: 'KWD', minorUnitDigits: 3, symbol: null });
  });

  it("distance unit and the date, time and week settings are the COUNTRY's: two countries with different formats and a market in each (two in one country) resolve to their own country's settings (7)", async () => {
    // each country row carries its own four format settings; every market row is a market of exactly one of them
    const countries = {
      US: { distance_unit: 'MILES', first_day_of_week: 'SUNDAY', date_format_code: 'MDY', time_format_code: '12_HOUR', dialing_code: '+1' },
      DE: { distance_unit: 'KILOMETERS', first_day_of_week: 'MONDAY', date_format_code: 'DMY', time_format_code: '24_HOUR', dialing_code: '+49' },
      JP: { distance_unit: 'KILOMETERS', first_day_of_week: 'SUNDAY', date_format_code: 'YMD', time_format_code: '24_HOUR', dialing_code: '+81' },
    } as const;
    const markets = [
      { code: 'la-oc', country: 'US', locale: 'en-US', zone: 'America/Los_Angeles', currency: 'USD' },
      { code: 'berlin', country: 'DE', locale: 'de-DE', zone: 'Europe/Berlin', currency: 'EUR' },
      { code: 'munich', country: 'DE', locale: 'en-GB', zone: 'Europe/Berlin', currency: 'EUR' }, // same country, other locale: same formats
      { code: 'tokyo', country: 'JP', locale: 'ja-JP', zone: 'Asia/Tokyo', currency: 'JPY' },
    ];
    const rowOf = (m: (typeof markets)[number]): Row =>
      defaultsRow({
        code: m.code,
        default_locale: m.locale,
        supported_locales: [m.locale],
        country_code: m.country,
        currency_code: m.currency,
        time_zone: m.zone,
        ...countries[m.country as keyof typeof countries],
      });
    const resolved = new Map<string, Awaited<ReturnType<GeographyService['resolveMarketDefaults']>>>();
    for (const m of markets) resolved.set(m.code, await service([rowOf(m)]).svc.resolveMarketDefaults(m.code));
    for (const m of markets) {
      const c = countries[m.country as keyof typeof countries];
      const d = resolved.get(m.code)!;
      expect([d.distanceUnit, d.firstDayOfWeek, d.dateFormat, d.timeFormat, d.country.dialingCode], m.code).toEqual([
        c.distance_unit,
        c.first_day_of_week,
        c.date_format_code,
        c.time_format_code,
        c.dialing_code,
      ]);
      expect([d.locale, d.timeZone, d.currency.code], m.code).toEqual([m.locale, m.zone, m.currency]); // the market's own settings stay the market's
      expect(buildMarketDefaults(rowOf(m), true)).toEqual(d); // the pure helper and the service agree
    }
    expect(resolved.get('berlin')!.distanceUnit).not.toBe(resolved.get('la-oc')!.distanceUnit); // miles vs kilometers is observable
    expect(['berlin', 'munich'].map((c) => [resolved.get(c)!.distanceUnit, resolved.get(c)!.firstDayOfWeek, resolved.get(c)!.dateFormat])).toEqual([
      ['KILOMETERS', 'MONDAY', 'DMY'],
      ['KILOMETERS', 'MONDAY', 'DMY'],
    ]);
    // the query takes the four settings from the country alias only: a market column can never override them
    const { svc, log } = service([rowOf(markets[0]!)]);
    await svc.resolveMarketDefaults('la-oc');
    const text = log.at(-1)!.text;
    for (const col of ['distance_unit', 'first_day_of_week', 'date_format_code', 'time_format_code']) {
      expect(text, col).toMatch(new RegExp(`c\\.${col}`));
      expect(text, col).not.toMatch(new RegExp(`m\\.${col}`));
    }
  });

  it('a country format change reaches the defaults of every one of its markets and of no other market', async () => {
    let usUnit = 'MILES';
    const { database } = scripted([
      [
        /FROM geography\.markets m\s+LEFT JOIN/,
        (params) =>
          params[1] === 'la-oc'
            ? [defaultsRow({ code: 'la-oc', distance_unit: usUnit })]
            : [defaultsRow({ code: params[1], country_code: 'DE', distance_unit: 'KILOMETERS', first_day_of_week: 'MONDAY' })],
      ],
    ]);
    const svc = new GeographyService({ database, env: 'test', now: () => T0 });
    expect((await svc.resolveMarketDefaults('la-oc')).distanceUnit).toBe('MILES');
    usUnit = 'KILOMETERS'; // the country row changed; no market row did
    expect((await svc.resolveMarketDefaults('la-oc')).distanceUnit).toBe('KILOMETERS');
    expect((await svc.resolveMarketDefaults('berlin')).distanceUnit).toBe('KILOMETERS');
  });

  it('a missing market, country, currency or time zone is a typed error (no code fallback)', async () => {
    expect((await failure(service([]).svc.resolveMarketDefaults('la-oc'))).code).toBe('MARKET_NOT_FOUND');
    expect((await failure(service([defaultsRow({ country_code: null })]).svc.resolveMarketDefaults('la-oc', { includeInactive: true }))).code).toBe(
      'COUNTRY_NOT_FOUND',
    );
    expect((await failure(service([defaultsRow({ currency_code: null })]).svc.resolveMarketDefaults('la-oc', { includeInactive: true }))).code).toBe(
      'CURRENCY_NOT_FOUND',
    );
    expect((await failure(service([defaultsRow({ time_zone: null })]).svc.resolveMarketDefaults('la-oc', { includeInactive: true }))).code).toBe(
      'TIME_ZONE_NOT_FOUND',
    );
    expect((await failure(service([]).svc.resolveMarketDefaults('LA-OC'))).code).toBe('MARKET_NOT_FOUND');
  });

  it('the public view rejects inactive dependencies (defense in depth); management (includeInactive) still resolves them', async () => {
    for (const [over, reason] of [
      [{ country_status: 'INACTIVE' }, 'COUNTRY_NOT_ACTIVE'],
      [{ currency_status: 'PLANNED' }, 'CURRENCY_NOT_ACTIVE'],
      [{ time_zone_status: 'INACTIVE' }, 'TIME_ZONE_NOT_ACTIVE'],
    ] as const) {
      const e = await failure(service([defaultsRow(over)]).svc.resolveMarketDefaults('la-oc'));
      expect([e.code, e.details.reason]).toEqual(['INVALID_STATE', reason]);
      expect((await service([defaultsRow(over)]).svc.resolveMarketDefaults('la-oc', { includeInactive: true })).market.code).toBe('la-oc');
    }
    expect(() => buildMarketDefaults(defaultsRow({ currency_status: 'INACTIVE' }), true)).toThrow(GeographyError);
    expect(() => buildMarketDefaults(defaultsRow({ currency_status: 'INACTIVE' }), false)).not.toThrow();
  });

  it('the effective window is half-open and evaluated at `at` (default: the service clock)', async () => {
    const row = defaultsRow({ effective_from: new Date('2026-06-01T12:00:00Z'), effective_to: new Date('2026-07-01T00:00:00Z') });
    const { svc } = service([row]);
    expect((await svc.resolveMarketDefaults('la-oc')).market.code).toBe('la-oc'); // exactly at effectiveFrom
    expect((await failure(svc.resolveMarketDefaults('la-oc', { at: new Date('2026-06-01T11:59:59Z') }))).code).toBe('MARKET_NOT_FOUND');
    expect((await failure(svc.resolveMarketDefaults('la-oc', { at: new Date('2026-07-01T00:00:00Z') }))).code).toBe('MARKET_NOT_FOUND'); // exactly at effectiveTo
    expect((await svc.resolveMarketDefaults('la-oc', { at: new Date('2026-06-30T23:59:59Z') })).market.code).toBe('la-oc');
    expect(inEffect({ effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null }, T0)).toBe(true);
    expect((await service([row]).svc.resolveMarketDefaults('la-oc', { includeInactive: true, at: new Date('2020-01-01T00:00:00Z') })).market.code).toBe(
      'la-oc',
    ); // management ignores the window
  });

  it('public reads query ACTIVE rows with management=false; management reads pass management=true and never touch the cache', async () => {
    const cache = new MemoryConfigCache();
    const pub = service([defaultsRow()], { cache });
    await pub.svc.resolveMarketDefaults('la-oc');
    expect(pub.log.at(-1)!.params).toEqual([false, 'la-oc', false]);
    expect([...cache.data.keys()].filter((k) => k.includes(':defaults:la-oc:')).length).toBe(1);
    const size = cache.data.size;
    const mgmt = service([defaultsRow()], { cache });
    await mgmt.svc.resolveMarketDefaults('la-oc', { includeInactive: true });
    expect(mgmt.log.at(-1)!.params).toEqual([true, 'la-oc', true]);
    expect(cache.data.size).toBe(size);
    const before = pub.log.length;
    await pub.svc.resolveMarketDefaults('la-oc'); // cache hit: no database query for the defaults
    expect(pub.log.length).toBe(before);
  });
});

describe('mapping and diffs', () => {
  it('maps rows to DTOs: public fields only unless management; currency minor digits stay numbers', async () => {
    const country = {
      iso_alpha2: 'JP',
      iso_alpha3: 'JPN',
      iso_numeric: '392',
      display_name_content_key: 'geography.country.jp.name',
      dialing_code: '+81',
      default_currency_code: 'JPY',
      default_locale: 'ja-JP',
      distance_unit: 'KILOMETERS',
      first_day_of_week: 'SUNDAY',
      date_format_code: 'YMD',
      time_format_code: '24_HOUR',
      status: 'ACTIVE',
      supported_locales: ['ja-JP', 'en-US'],
      time_zones: ['Asia/Tokyo'],
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    };
    expect(mapCountry(country, false)).not.toHaveProperty('status');
    expect(mapCountry(country, false).supportedLocales).toEqual(['en-US', 'ja-JP']);
    expect(mapCountry(country, true)).toMatchObject({ status: 'ACTIVE', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
    const market = {
      code: 'tokyo',
      name: 'Tokyo',
      country_code: 'JP',
      default_locale: 'ja-JP',
      supported_locales: ['ja-JP'],
      currency_code: 'JPY',
      default_time_zone: 'Asia/Tokyo',
      effective_from: T0,
      effective_to: null,
      status: 'PLANNED',
      created_at: T0,
      updated_at: T0,
    };
    expect(mapMarket(market, false)).not.toHaveProperty('status');
    expect(mapMarket(market, true).status).toBe('PLANNED');
  });

  it('diffFields lists only changed fields as [old, new]; sets compare by value', () => {
    expect(diffFields({ a: 1, b: ['x', 'y'], c: null }, { a: 2, b: ['x', 'y'], c: null }, ['a', 'b', 'c'])).toEqual({ a: [1, 2] });
    expect(diffFields({ b: ['x'] }, { b: ['x', 'y'] }, ['b'])).toEqual({ b: [['x'], ['x', 'y']] });
    expect(diffFields({ c: null }, { c: 'v' }, ['c'])).toEqual({ c: [null, 'v'] });
    expect(diffFields({ a: 1 }, { a: 1 }, ['a'])).toEqual({});
  });
});

describe('mapDbError: constraint and guard failures become typed errors without internals', () => {
  const map = (e: unknown): GeographyError => {
    try {
      mapDbError(e);
    } catch (x) {
      return x as GeographyError;
    }
    throw new Error('did not throw');
  };
  /** A guard failure as the pg driver reports it: SQLSTATE 23000, a human message and the machine-readable key in `detail`. */
  const guard = (key: string, message = 'whatever the message says') => ({ code: '23000', message, detail: `geography_rule:${key}` });
  it('translates SQLSTATE classes and constraint names', () => {
    expect(map({ code: '23505', constraint: 'uq_markets__code' }).code).toBe('CONFLICT');
    expect(map({ code: '23505', constraint: 'uq_countries__iso_alpha2' }).message).toMatch(/country/);
    expect(map({ code: '23P01' }).code).toBe('CONFLICT');
    expect(map({ code: '23514', constraint: 'ck_markets__effective_range' }).message).toMatch(/effectiveTo/);
    expect(map({ code: '23502' }).code).toBe('VALIDATION_FAILED');
    expect(map({ code: '23503', constraint: 'fk_markets__currency_code' }).code).toBe('CURRENCY_NOT_FOUND');
    expect(map({ code: '23503', constraint: 'fk_country_locales__locale' }).code).toBe('LOCALE_NOT_FOUND');
    expect(map({ code: '23503', constraint: 'fk_country_time_zones__time_zone_id' }).code).toBe('TIME_ZONE_NOT_FOUND');
    expect(map({ code: '23503', constraint: 'fk_markets__country_time_zone' })).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'IN_USE' } });
  });
  it('classifies every guard failure by its geography_rule key in detail (all 15 keys)', () => {
    expect(map(guard('NOT_IANA')).code).toBe('TIME_ZONE_NOT_FOUND');
    for (const reason of [
      'COUNTRY_NOT_ACTIVE',
      'CURRENCY_NOT_ACTIVE',
      'TIME_ZONE_NOT_ACTIVE',
      'LOCALE_NOT_ACTIVE',
      'NO_ACTIVE_TIME_ZONE',
      'COUNTRY_HAS_ACTIVE_MARKETS',
    ])
      expect(map(guard(reason))).toMatchObject({ code: 'INVALID_STATE', details: { reason } });
    for (const rule of ['CURRENCY_IN_USE', 'TIME_ZONE_IN_USE', 'LOCALE_IS_ACTIVE_DEFAULT'])
      expect(map(guard(rule))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'IN_USE', rule } });
    expect(map(guard('LINKS_PROTECTED')).details.reason).toBe('LINKS_FROZEN');
    expect(map(guard('PLANNED_IS_INITIAL'))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'PLANNED_IS_INITIAL' } });
    for (const rule of ['IMMUTABLE_IDENTITY', 'NOT_DELETABLE', 'ROW_IMMUTABLE']) expect(map(guard(rule)).details.reason).toBe('IMMUTABLE');
    const generic = map({ code: '23000', message: 'something else entirely with geography.secret_table', detail: 'geography_rule:NOT_A_KNOWN_RULE' });
    expect(generic.code).toBe('INVALID_STATE');
    expect(generic.message).not.toContain('secret_table');
    expect(map({ code: '23000', message: 'market x cannot be ACTIVE: its country is not ACTIVE' }).details.reason).toBeUndefined(); // no key, no classification
    expect(map({ code: '23000', message: 'x', detail: 'geography_rule:COUNTRY_NOT_ACTIVE trailing' }).details.reason).toBeUndefined(); // exactly the key, nothing else
    expect(map({ code: '23000', message: 'x', detail: 'Key (code)=(geography_rule:COUNTRY_NOT_ACTIVE) already exists.' }).details.reason).toBeUndefined();
  });
  it('never classifies by message text: a market code that contains a rule word cannot change the answer (the code is user-chosen)', () => {
    const e = map(guard('LOCALE_NOT_ACTIVE', 'market devtest-currency cannot be ACTIVE: its default locale es-MX is not an ACTIVE locale'));
    expect(e.details.reason).toBe('LOCALE_NOT_ACTIVE'); // the old regex over the message answered CURRENCY_NOT_ACTIVE here
    expect(map(guard('COUNTRY_NOT_ACTIVE', 'market devtest-time-zone-locale cannot be ACTIVE: its country is not ACTIVE')).details.reason).toBe(
      'COUNTRY_NOT_ACTIVE',
    );
    expect(map(guard('CURRENCY_NOT_ACTIVE', 'market is-immutable-cannot-be-deleted cannot be ACTIVE: its currency USD is not ACTIVE')).details.reason).toBe(
      'CURRENCY_NOT_ACTIVE',
    );
  });
  it('deadlocks and serialization failures are a retryable CONFLICT (CONCURRENT_UPDATE), never a raw error', () => {
    for (const code of ['40P01', '40001']) {
      const e = map({
        code,
        message: 'deadlock detected\nProcess 123 waits for ShareLock on transaction 456; blocked by process 789',
        detail: 'Process 123 ...',
      });
      expect(e).toMatchObject({ code: 'CONFLICT', details: { reason: 'CONCURRENT_UPDATE', retryable: true } });
      expect(JSON.stringify([e.message, e.details])).not.toMatch(/Process|ShareLock|transaction/);
    }
  });
  it('NUL bytes (22021) and untranslatable characters in JSON (22P05) are VALIDATION_FAILED / FORBIDDEN_CHARACTER, not a 500', () => {
    for (const code of ['22021', '22P05']) {
      const e = map({ code, message: 'invalid byte sequence for encoding "UTF8": 0x00' });
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'FORBIDDEN_CHARACTER' } });
      expect(e.message).not.toMatch(/UTF8|0x00/);
    }
  });
  it('connectivity failures become UNAVAILABLE with no driver text; typed errors pass through; programming errors are not masked', () => {
    const e = map(Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2'), { code: 'ECONNREFUSED' }));
    expect(e.code).toBe('UNAVAILABLE');
    expect(JSON.stringify([e.message, e.details])).not.toMatch(/hunter2|10\.1\.2\.3/);
    const typed = new GeographyError('NOT_READY', 'x');
    expect(map(typed)).toBe(typed);
    expect(() => mapDbError(new TypeError('bug'))).toThrow(TypeError);
  });
});

describe('service input validation (no database access)', () => {
  const noDb = () => service([]).svc;
  it('rejects malformed requests before touching the database, naming fields and issue codes only', async () => {
    const e = await failure(noDb().createCountry({ code: 'us', secret: 'do-not-echo' }, 'actor'));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(e)).not.toContain('do-not-echo');
    expect((await failure(noDb().createMarket(null, 'actor'))).code).toBe('VALIDATION_FAILED');
    expect((await failure(noDb().updateMarket('la-oc', { name: 'x', reason: '' }, 'actor'))).code).toBe('VALIDATION_FAILED');
    expect((await failure(noDb().setMarketActive('la-oc', true, ' ', 'actor'))).code).toBe('VALIDATION_FAILED');
    expect((await failure(noDb().updateCountry('us', { reason: 'r' }, 'actor'))).code).toBe('COUNTRY_NOT_FOUND');
    expect((await failure(noDb().getCurrency('usd'))).code).toBe('CURRENCY_NOT_FOUND');
  });
  it('effective window instants outside the years 1970 to 9999 are VALIDATION_FAILED before the database is touched (no PostgreSQL 500)', async () => {
    const { svc, log } = service([]);
    const create = { code: 'x1', name: 'n', countryCode: 'US', defaultLocale: 'en-US', currencyCode: 'USD', defaultTimeZone: 'America/Denver', reason: 'r' };
    for (const [field, value] of [
      ['effectiveFrom', '0001-01-01T00:00:00Z'],
      ['effectiveFrom', '1969-12-31T23:59:59Z'],
      ['effectiveTo', '9999-12-31T23:59:59-23:59'],
    ] as const) {
      const c = await failure(svc.createMarket({ ...create, effectiveFrom: '2026-01-01T00:00:00Z', [field]: value }, 'a'));
      expect([c.code, c.details.field]).toEqual(['VALIDATION_FAILED', field]);
      const u = await failure(svc.updateMarket('la-oc', { [field]: value, reason: 'r' }, 'a'));
      expect([u.code, u.details.field]).toEqual(['VALIDATION_FAILED', field]);
    }
    expect(log).toEqual([]);
  });
  it('unassigned and non-country alpha-2 codes are VALIDATION_FAILED before the database is touched; ZZ stays behind the test-key gate (C3)', async () => {
    const { svc, log } = service([]);
    const base = {
      alpha3: 'QQQ',
      numeric: '998',
      displayNameContentKey: 'a.b',
      dialingCode: '+1',
      defaultCurrencyCode: 'USD',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      timeZones: ['America/Denver'],
      distanceUnit: 'MILES',
      firstDayOfWeek: 'SUNDAY',
      dateFormat: 'MDY',
      timeFormat: '12_HOUR',
      reason: 'r',
    };
    for (const code of ['QQ', 'AA', 'EU', 'XA']) {
      const e = await failure(svc.createCountry({ ...base, code }, 'a'));
      expect([e.code, e.details.field]).toEqual(['VALIDATION_FAILED', 'code']);
    }
    expect(log).toEqual([]);
    expect((await failure(svc.createCountry({ ...base, code: 'ZZ' }, 'a'))).details.reason).toBe('TEST_KEY'); // gated, not "unassigned"
    // an assigned region passes the region check and goes on to the database (the scripted database has no currency row)
    expect((await failure(service([]).svc.createCountry({ ...base, code: 'DE', alpha3: 'DEU', numeric: '276' }, 'a'))).code).not.toBe('VALIDATION_FAILED');
  });
  it('the time zone pre-check is the canonical regional list: fixed offsets and legacy aliases are VALIDATION_FAILED before the database is touched (C4)', async () => {
    const { svc, log } = service([]);
    for (const zone of ['Etc/GMT+5', 'EST', 'us/pacific', 'UTC+5', 'posix/America/Denver']) {
      const e = await failure(
        svc.createMarket({ code: 'x1', name: 'n', countryCode: 'US', defaultLocale: 'en-US', currencyCode: 'USD', defaultTimeZone: zone, reason: 'r' }, 'a'),
      );
      expect([e.code, e.details.field], zone).toEqual(['VALIDATION_FAILED', 'defaultTimeZone']);
    }
    expect(log).toEqual([]);
  });
  it('the test-key gate is enforced before any database access', async () => {
    const prod = service([]).svc;
    const base = {
      code: 'ZZ',
      alpha3: 'ZZZ',
      numeric: '999',
      displayNameContentKey: 'a.b',
      dialingCode: '+1',
      defaultCurrencyCode: 'USD',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      timeZones: ['America/Denver'],
      distanceUnit: 'MILES',
      firstDayOfWeek: 'SUNDAY',
      dateFormat: 'MDY',
      timeFormat: '12_HOUR',
      reason: 'r',
    };
    expect((await failure(prod.createCountry(base, 'a'))).details.reason).toBe('TEST_KEY');
    const market = {
      code: 'devtest-x',
      name: 'n',
      countryCode: 'US',
      defaultLocale: 'en-US',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Denver',
      reason: 'r',
    };
    expect((await failure(prod.createMarket(market, 'a'))).details.reason).toBe('TEST_KEY');
  });
  it('lower-case and padded locale tags in requests are canonicalized, not rejected (en-us -> en-US reaches the next validation step)', async () => {
    const e = await failure(
      noDb().createMarket(
        { code: 'x1', name: 'n', countryCode: 'US', defaultLocale: 'en-us', currencyCode: 'USD', defaultTimeZone: 'Mars/Olympus', reason: 'r' },
        'a',
      ),
    );
    expect(e.details.field).toBe('defaultTimeZone'); // the locale passed, the time zone did not
  });
});
