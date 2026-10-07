import { describe, expect, it } from 'vitest';
import { GeographyError } from './errors';
import {
  isCanonicalCountryRef,
  isCanonicalMarketRef,
  isCountryAlpha3,
  isCountryCode,
  isCountryNumeric,
  isCurrencyCode,
  isCurrencyNumeric,
  isDialingCode,
  isAssignedCountryCode,
  isIanaTimeZone,
  isMarketCode,
  requireAssignedCountryCode,
  requireCountryCode,
  requireCurrencyCode,
  requireDateFormat,
  requireDistanceUnit,
  requireIanaTimeZone,
  requireInstant,
  requireLocale,
  requireLocaleSet,
  requireMarketCode,
  requireMinorUnitDigits,
  requireTimeFormat,
  requireTimeZoneSet,
  requireWeekday,
  scopeReferenceProblem,
} from './validation';

const failure = (fn: () => unknown): GeographyError => {
  try {
    fn();
  } catch (e) {
    return e as GeographyError;
  }
  throw new Error('expected a failure');
};

describe('ISO code validation (1)', () => {
  it('accepts upper-case alpha-2, alpha-3, numeric and currency codes only in their canonical shape', () => {
    expect(['US', 'GB', 'ZZ'].every(isCountryCode)).toBe(true);
    for (const bad of ['us', 'USA', 'U', 'U1', ' US', 'US ', '', null, undefined, 840]) expect(isCountryCode(bad)).toBe(false);
    expect(isCountryAlpha3('USA')).toBe(true);
    for (const bad of ['usa', 'US', 'USAA', '840']) expect(isCountryAlpha3(bad)).toBe(false);
    expect(isCountryNumeric('840')).toBe(true);
    for (const bad of ['84', '8400', 'US1', 840]) expect(isCountryNumeric(bad)).toBe(false);
    expect(isCurrencyCode('USD')).toBe(true);
    for (const bad of ['usd', 'US', 'USDD', 'U$D']) expect(isCurrencyCode(bad)).toBe(false);
    expect(isCurrencyNumeric('392')).toBe(true);
    expect(isCurrencyNumeric('39')).toBe(false);
    expect(isDialingCode('+1')).toBe(true);
    expect(isDialingCode('+12345')).toBe(false);
    expect(isDialingCode('1')).toBe(false);
  });

  it('require* helpers throw VALIDATION_FAILED naming the field and never the value', () => {
    const e = failure(() => requireCountryCode('secret-value', 'country'));
    expect(e).toBeInstanceOf(GeographyError);
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'country' });
    expect(JSON.stringify([e.message, e.details])).not.toContain('secret-value');
    expect(requireCountryCode('US')).toBe('US');
    expect(requireCurrencyCode('EUR')).toBe('EUR');
    expect(failure(() => requireCurrencyCode('eur')).code).toBe('VALIDATION_FAILED');
    expect(requireMarketCode('la-oc')).toBe('la-oc');
    expect(failure(() => requireMarketCode('LA-OC')).code).toBe('VALIDATION_FAILED');
  });

  it('market codes are lower-case kebab of at most 60 characters', () => {
    for (const ok of ['la-oc', 'devtest-1', 'a', 'sf-bay-area', 'x1-y2']) expect(isMarketCode(ok), ok).toBe(true);
    for (const bad of ['La-oc', 'la_oc', '-la', 'la-', 'la--oc', '1la', 'la oc', '', 'a'.repeat(61)]) expect(isMarketCode(bad), bad).toBe(false);
  });
});

describe('currency minor digits (2)', () => {
  it('accepts the integers 0 to 4 (JPY 0, USD 2, KWD 3) and rejects everything else', () => {
    for (const n of [0, 2, 3, 4]) expect(requireMinorUnitDigits(n)).toBe(n);
    for (const bad of [-1, 5, 2.5, '2', null, NaN]) expect(failure(() => requireMinorUnitDigits(bad)).code).toBe('VALIDATION_FAILED');
  });
});

describe('locale canonicalization (3)', () => {
  it('canonicalizes casing and rejects underscores, padding and unsupported shapes', () => {
    expect(requireLocale('en-us')).toBe('en-US');
    expect(requireLocale('EN-us')).toBe('en-US');
    expect(requireLocale('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(requireLocale('es-419')).toBe('es-419');
    expect(requireLocale('fr')).toBe('fr');
    for (const bad of ['en_US', ' en-US', 'en-US ', 'english', 'e', 'en-US-extra-parts', '', null, 5])
      expect(failure(() => requireLocale(bad)).details.reason, String(bad)).toBe('INVALID_LOCALE');
  });
  it('locale sets are canonical, de-duplicated and sorted; empty or oversized sets are rejected', () => {
    expect(requireLocaleSet(['es-us', 'en-US', 'EN-us'])).toEqual(['en-US', 'es-US']);
    expect(failure(() => requireLocaleSet([])).code).toBe('VALIDATION_FAILED');
    expect(failure(() => requireLocaleSet('en-US')).code).toBe('VALIDATION_FAILED');
    expect(
      failure(() =>
        requireLocaleSet(
          Array.from(
            { length: 31 },
            (_, i) => `a${String.fromCharCode(97 + (i % 26))}-${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
          ),
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('IANA time zone validation (4)', () => {
  it('accepts canonical regional identifiers (members of the runtime list), including IANA names the CLDR list spells differently', () => {
    for (const z of [
      'America/Los_Angeles',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'Pacific/Honolulu',
      'Europe/London',
      'Asia/Tokyo',
      'America/Argentina/Buenos_Aires',
      'Asia/Kolkata', // the IANA name; the runtime list says Asia/Calcutta
      'Europe/Kyiv',
    ])
      expect(isIanaTimeZone(z), z).toBe(true);
  });
  it('rejects fixed offsets and legacy aliases that the canonical list does not contain, and UTC unless the list has it', () => {
    for (const z of [
      'Etc/GMT+5',
      'Etc/GMT-14',
      'EST',
      'EST5EDT',
      'GMT',
      'GMT-0',
      'US/Pacific',
      'us/pacific',
      'Etc/UTC',
      'posix/America/Denver',
      'right/UTC',
      'Zulu',
    ])
      expect(isIanaTimeZone(z), z).toBe(false);
    expect(isIanaTimeZone('UTC')).toBe(Intl.supportedValuesOf('timeZone').includes('UTC')); // allowed only if the runtime lists it
    for (const z of ['Etc/GMT+5', 'EST', 'us/pacific', 'UTC+5', 'posix/America/Denver'])
      expect(failure(() => requireIanaTimeZone(z, 'timeZones')).details).toEqual({ reason: 'INVALID_FIELD', field: 'timeZones' });
    expect(requireIanaTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
  });
  it('rejects offsets, unknown names, wrong case, whitespace and non-strings', () => {
    for (const z of [
      '+05:00',
      'UTC+5',
      'GMT+5',
      'Mars/Olympus',
      'america/los_angeles',
      'America/los_angeles',
      'utc',
      ' America/New_York',
      'America/',
      '/America',
      '',
      'A'.repeat(70),
      null,
      5,
    ])
      expect(isIanaTimeZone(z), String(z)).toBe(false);
    expect(failure(() => requireIanaTimeZone('Mars/Olympus', 'defaultTimeZone')).details).toEqual({ reason: 'INVALID_FIELD', field: 'defaultTimeZone' });
  });
  it('time zone sets are de-duplicated and sorted', () => {
    expect(requireTimeZoneSet(['America/New_York', 'America/Chicago', 'America/New_York'])).toEqual(['America/Chicago', 'America/New_York']);
    expect(failure(() => requireTimeZoneSet([])).code).toBe('VALIDATION_FAILED');
    expect(failure(() => requireTimeZoneSet(['America/Chicago', 'Nope/Zone'])).code).toBe('VALIDATION_FAILED');
  });
});

describe('format enumerations (8)', () => {
  it('accepts exactly the contract values', () => {
    expect(['MILES', 'KILOMETERS'].map((v) => requireDistanceUnit(v))).toEqual(['MILES', 'KILOMETERS']);
    expect(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((v) => requireWeekday(v)).length).toBe(7);
    expect(['MDY', 'DMY', 'YMD'].map((v) => requireDateFormat(v))).toEqual(['MDY', 'DMY', 'YMD']);
    expect(['12_HOUR', '24_HOUR'].map((v) => requireTimeFormat(v))).toEqual(['12_HOUR', '24_HOUR']);
  });
  it('rejects other values, casing variants and non-strings, naming the field', () => {
    for (const bad of ['miles', 'KM', 'METERS', '', null, 1]) expect(failure(() => requireDistanceUnit(bad)).details.field).toBe('distanceUnit');
    for (const bad of ['Monday', 'MON', 'SUN']) expect(failure(() => requireWeekday(bad)).code).toBe('VALIDATION_FAILED');
    for (const bad of ['ISO', 'mdy', 'DM']) expect(failure(() => requireDateFormat(bad)).code).toBe('VALIDATION_FAILED');
    for (const bad of ['12', '24', '12_hour', 'AMPM']) expect(failure(() => requireTimeFormat(bad)).code).toBe('VALIDATION_FAILED');
  });
});

describe('canonical scope references', () => {
  it('COUNTRY refs are upper-case alpha-2 and MARKET refs lower-case kebab; every other form is a problem', () => {
    expect(isCanonicalCountryRef('US')).toBe(true);
    expect(isCanonicalCountryRef('us')).toBe(false);
    expect(isCanonicalMarketRef('la-oc')).toBe(true);
    expect(isCanonicalMarketRef('LA-OC')).toBe(false);
    expect(scopeReferenceProblem('COUNTRY', 'US')).toBeNull();
    expect(scopeReferenceProblem('MARKET', 'la-oc')).toBeNull();
    expect(scopeReferenceProblem('COUNTRY', 'us')).toMatch(/upper-case/);
    expect(scopeReferenceProblem('MARKET', 'la_oc')).toMatch(/lower-case/);
    expect(scopeReferenceProblem('COUNTRY', null)).toMatch(/needs a reference/);
    expect(scopeReferenceProblem('MARKET', '')).toMatch(/needs a reference/);
  });
});

describe('assigned country codes (C3)', () => {
  it('accepts assigned ISO 3166-1 alpha-2 regions and rejects unassigned codes, groupings and pseudo regions', () => {
    for (const c of ['US', 'DE', 'JP', 'IN', 'GB', 'BR']) expect(isAssignedCountryCode(c), c).toBe(true);
    for (const c of ['QQ', 'AA', 'YA', 'XC', 'EU', 'UN', 'XA', 'XB', 'us', 'USA', '', null, 5]) expect(isAssignedCountryCode(c), String(c)).toBe(false);
    expect(requireAssignedCountryCode('DE')).toBe('DE');
    expect(failure(() => requireAssignedCountryCode('QQ')).details).toEqual({ reason: 'INVALID_FIELD', field: 'code' });
  });
});

describe('instants (effective window)', () => {
  it('accepts instants whose UTC year is 1970 to 9999 (strings with any offset, or Dates) and returns a Date that renders with a 4-digit year', () => {
    expect(requireInstant('2026-06-01T12:00:00Z').toISOString()).toBe('2026-06-01T12:00:00.000Z');
    expect(requireInstant('2026-06-01T12:00:00+05:30').toISOString()).toBe('2026-06-01T06:30:00.000Z');
    expect(requireInstant('1970-01-01T00:00:00Z').getTime()).toBe(0);
    expect(requireInstant('9999-12-31T23:59:59.999Z').toISOString()).toBe('9999-12-31T23:59:59.999Z');
    expect(requireInstant(new Date('2030-01-01T00:00:00Z')).toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
  it('rejects years before 1970 or after 9999, invalid dates and non-instants, naming the field (the 9999 offset case would otherwise reach PostgreSQL as +010000-...)', () => {
    for (const bad of ['0001-01-01T00:00:00Z', '1969-12-31T23:59:59Z', '10000-01-01T00:00:00Z', '9999-12-31T23:59:59-23:59', 'not a date', '', null, 5, {}])
      expect(failure(() => requireInstant(bad, 'effectiveTo')).details).toEqual({ reason: 'INVALID_FIELD', field: 'effectiveTo' });
    expect(failure(() => requireInstant(new Date(Number.NaN))).code).toBe('VALIDATION_FAILED');
    // the offset case: the instant lies in year 10000 although the string says 9999
    expect(new Date('9999-12-31T23:59:59-23:59').toISOString()).toMatch(/^\+010000-/);
  });
});
