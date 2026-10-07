// Pure validation helpers: ISO codes, IANA time zones, canonical scope references, locales and the format enumerations.
// Every function either returns the validated value or throws a typed VALIDATION_FAILED error that names the FIELD, never the value.
import {
  canonicalizeLocale,
  CountryAlpha3,
  CountryCode,
  CountryNumeric,
  CurrencyCode,
  CurrencyNumeric,
  DateFormatCode,
  DialingCode,
  DistanceUnit,
  IanaTimeZone,
  MarketCode,
  TimeFormatCode,
  Weekday,
  type DateFormatCode as DateFormat,
  type DistanceUnit as Distance,
  type TimeFormatCode as TimeFormat,
  type Weekday as WeekdayValue,
} from '@bananagig/contracts';
import { GeographyError } from './errors';

export { canonicalizeLocale };

export function invalid(message: string, details: Record<string, unknown> = {}): GeographyError {
  return new GeographyError('VALIDATION_FAILED', message, details);
}
const field = (name: string) => ({ reason: 'INVALID_FIELD', field: name });

type Schema = { safeParse(v: unknown): { success: boolean } };
const matches = (schema: Schema, value: unknown): boolean => typeof value === 'string' && schema.safeParse(value).success;

// ---------------------------------------------------------------- ISO codes
/** ISO 3166-1 alpha-2, upper case (also the canonical COUNTRY scope reference). */
export const isCountryCode = (v: unknown): v is string => matches(CountryCode, v);
export const isCountryAlpha3 = (v: unknown): v is string => matches(CountryAlpha3, v);
export const isCountryNumeric = (v: unknown): v is string => matches(CountryNumeric, v);
/** ISO 4217 alpha code, upper case. */
export const isCurrencyCode = (v: unknown): v is string => matches(CurrencyCode, v);
export const isCurrencyNumeric = (v: unknown): v is string => matches(CurrencyNumeric, v);
export const isDialingCode = (v: unknown): v is string => matches(DialingCode, v);
/** Market code: lower-case kebab (also the canonical MARKET scope reference). */
export const isMarketCode = (v: unknown): v is string => matches(MarketCode, v);

function require_(ok: boolean, value: unknown, name: string, what: string): string {
  if (!ok) throw invalid(`${name} must be ${what}`, field(name));
  return value as string;
}
export const requireCountryCode = (v: unknown, name = 'code') => require_(isCountryCode(v), v, name, 'an upper-case ISO 3166-1 alpha-2 code');
export const requireCountryAlpha3 = (v: unknown, name = 'alpha3') => require_(isCountryAlpha3(v), v, name, 'an upper-case ISO 3166-1 alpha-3 code');
export const requireCountryNumeric = (v: unknown, name = 'numeric') => require_(isCountryNumeric(v), v, name, 'a three-digit ISO 3166-1 numeric code');
export const requireCurrencyCode = (v: unknown, name = 'currencyCode') => require_(isCurrencyCode(v), v, name, 'an upper-case ISO 4217 code');
export const requireMarketCode = (v: unknown, name = 'code') =>
  require_(isMarketCode(v), v, name, 'a lower-case kebab-case market code of at most 60 characters');

/** Currencies keep 0 to 4 minor-unit digits (JPY 0, USD 2, KWD 3): money elsewhere is an integer amount in minor units plus the currency code. */
export function requireMinorUnitDigits(v: unknown, name = 'minorUnitDigits'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 4) throw invalid(`${name} must be an integer from 0 to 4`, field(name));
  return v;
}

// ---------------------------------------------------------------- canonical scope references (configuration and content)
/** COUNTRY references are the ISO alpha-2 code in upper case. Resolution matches references by exact string, so no other form is accepted. */
export const isCanonicalCountryRef = isCountryCode;
/** MARKET references are the market code in lower-case kebab form. */
export const isCanonicalMarketRef = isMarketCode;
export function scopeReferenceProblem(scopeType: 'COUNTRY' | 'MARKET', ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length === 0) return `a ${scopeType} scope needs a reference`;
  if (scopeType === 'COUNTRY' && !isCanonicalCountryRef(ref)) return 'a COUNTRY reference must be the upper-case ISO 3166-1 alpha-2 code (for example US)';
  if (scopeType === 'MARKET' && !isCanonicalMarketRef(ref)) return 'a MARKET reference must be the lower-case kebab-case market code (for example la-oc)';
  return null;
}

// ---------------------------------------------------------------- IANA time zones
/**
 * IANA names that the runtime's canonical list (CLDR ids) spells differently: `Intl.supportedValuesOf('timeZone')` lists Asia/Calcutta where
 * IANA says Asia/Kolkata. They are accepted when the runtime resolves them to a name that IS in the list (so an old runtime without them rejects
 * them, never accepts something unknown). Legacy links (US/Pacific, EST, Etc/GMT+5, ...) are deliberately not here.
 */
const IANA_NAMES_SPELLED_DIFFERENTLY_BY_CLDR = [
  'Africa/Asmara',
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Catamarca',
  'America/Argentina/Cordoba',
  'America/Argentina/Jujuy',
  'America/Argentina/Mendoza',
  'America/Atikokan',
  'America/Indiana/Indianapolis',
  'America/Kentucky/Louisville',
  'America/Nuuk',
  'Asia/Ho_Chi_Minh',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Yangon',
  'Atlantic/Faroe',
  'Europe/Kyiv',
  'Pacific/Chuuk',
  'Pacific/Kanton',
  'Pacific/Pohnpei',
] as const;
let supported: Set<string> | undefined;
function supportedZones(): Set<string> {
  if (!supported) {
    let names: string[] = [];
    try {
      names = Intl.supportedValuesOf('timeZone');
    } catch {
      names = [];
    }
    supported = new Set(names);
    if (supported.size > 0)
      for (const n of IANA_NAMES_SPELLED_DIFFERENTLY_BY_CLDR) {
        try {
          const resolved = new Intl.DateTimeFormat('en-US', { timeZone: n }).resolvedOptions().timeZone;
          if (supported.has(resolved)) supported.add(n);
        } catch {
          // this runtime does not know the name: it stays rejected
        }
      }
  }
  return supported;
}
/**
 * Whether `v` is a canonical regional time zone identifier: the syntactic format (the same rule as the database) AND membership in the
 * runtime's canonical list (`Intl.supportedValuesOf('timeZone')`, exact case). Fixed offsets (+05:00, UTC+5, Etc/GMT+5), legacy aliases
 * (EST, GMT-0, US/Pacific), wrong-case spellings and the posix/ and right/ trees are therefore rejected; `UTC` only if the list contains it.
 * This is a pre-check for clear errors: the database trigger on insert (pg_timezone_names) stays the final authority. A runtime without
 * `Intl.supportedValuesOf` has no list, so only the format is checked there and the database decides.
 */
export function isIanaTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || !IanaTimeZone.safeParse(v).success) return false;
  const zones = supportedZones();
  return zones.size === 0 || zones.has(v);
}
export function requireIanaTimeZone(v: unknown, name = 'timeZone'): string {
  if (!isIanaTimeZone(v)) throw invalid(`${name} must be an IANA time zone identifier such as America/Los_Angeles`, field(name));
  return v;
}

// ---------------------------------------------------------------- assigned country codes
/**
 * Codes that Intl names but that are not countries: the European Union and similar groupings, outlying Oceania and the CLDR pseudo-locales.
 * ZZ ("Unknown Region") is the DEV/TEST code and is gated by the service option allowTestKeys, never by this check.
 */
const NON_COUNTRY_REGIONS = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB']);
let regionNames: Intl.DisplayNames | null | undefined;
/**
 * Whether the alpha-2 code is an assigned region according to the runtime's CLDR data (`Intl.DisplayNames(..., { type: 'region', fallback: 'none' })`
 * returns undefined for unassigned codes such as QQ). ONLY the alpha-2 code is checked against real data: alpha-3 and numeric codes are checked
 * syntactically (pattern and uniqueness) and are NOT verified to belong to the same country (recorded as debt). A runtime without region names
 * leaves the syntactic check as the only one.
 */
export function isAssignedCountryCode(v: unknown): v is string {
  if (!isCountryCode(v) || NON_COUNTRY_REGIONS.has(v)) return false;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    } catch {
      regionNames = null;
    }
  }
  if (regionNames === null) return true;
  try {
    return regionNames.of(v) !== undefined;
  } catch {
    return false;
  }
}
export function requireAssignedCountryCode(v: unknown, name = 'code'): string {
  if (!isAssignedCountryCode(v)) throw invalid(`${name} must be an assigned ISO 3166-1 alpha-2 country code`, field(name));
  return v;
}

// ---------------------------------------------------------------- instants
/** Effective windows are evaluated by people and consumers in this range; anything else is a typo or an attack (and PostgreSQL rejects year 10000+ in ISO strings). */
export const MIN_INSTANT_YEAR = 1970;
export const MAX_INSTANT_YEAR = 9999;
/** An ISO 8601 instant (string or Date) whose UTC year is within 1970 to 9999. The result is always a valid Date that `toISOString()` renders with a 4-digit year. */
export function requireInstant(v: unknown, name = 'timestamp'): Date {
  const d = typeof v === 'string' ? new Date(v) : v instanceof Date ? v : new Date(Number.NaN);
  const year = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || year < MIN_INSTANT_YEAR || year > MAX_INSTANT_YEAR)
    throw invalid(`${name} must be a timestamp in the years ${MIN_INSTANT_YEAR} to ${MAX_INSTANT_YEAR}`, field(name));
  return d;
}

// ---------------------------------------------------------------- locales
/** Canonical BCP 47 form (en-us -> en-US); VALIDATION_FAILED when the tag is outside the supported subset. */
export function requireLocale(v: unknown, name = 'locale'): string {
  const tag = canonicalizeLocale(v);
  if (!tag) throw invalid(`${name} must be a supported BCP 47 locale tag such as en-US`, { reason: 'INVALID_LOCALE', field: name });
  return tag;
}
/** Canonical, de-duplicated, sorted; empty sets are rejected. */
export function requireLocaleSet(v: unknown, name = 'supportedLocales', max = 30): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) throw invalid(`${name} must contain 1 to ${max} locales`, field(name));
  return [...new Set(v.map((x) => requireLocale(x, name)))].sort();
}
export function requireTimeZoneSet(v: unknown, name = 'timeZones', max = 40): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) throw invalid(`${name} must contain 1 to ${max} time zones`, field(name));
  return [...new Set(v.map((x) => requireIanaTimeZone(x, name)))].sort();
}

// ---------------------------------------------------------------- format enumerations
function requireEnum<T extends string>(schema: Schema, v: unknown, name: string, allowed: readonly string[]): T {
  if (!matches(schema, v)) throw invalid(`${name} must be one of ${allowed.join(', ')}`, field(name));
  return v as T;
}
export const requireDistanceUnit = (v: unknown, name = 'distanceUnit'): Distance => requireEnum(DistanceUnit, v, name, DistanceUnit.options);
export const requireWeekday = (v: unknown, name = 'firstDayOfWeek'): WeekdayValue => requireEnum(Weekday, v, name, Weekday.options);
export const requireDateFormat = (v: unknown, name = 'dateFormat'): DateFormat => requireEnum(DateFormatCode, v, name, DateFormatCode.options);
export const requireTimeFormat = (v: unknown, name = 'timeFormat'): TimeFormat => requireEnum(TimeFormatCode, v, name, TimeFormatCode.options);
