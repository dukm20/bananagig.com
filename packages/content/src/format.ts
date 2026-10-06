// Locale-aware formatting of template variables by TYPE. Intl only, no floating-point money, strict validation.
// Failures throw ContentError('TEMPLATE_ERROR', ..., { reason: 'INVALID_VARIABLE_VALUE', variable }) and never include the offending value.
import { canonicalizeLocale, type VariableType } from '@bananagig/contracts';
import { ContentError, templateError } from './errors';

export interface FormatOptions {
  /** Canonicalizable BCP 47 locale (the resolved locale of the copy being rendered). */
  locale: string;
  /** IANA time zone for DATETIME values (default UTC). */
  timeZone?: string;
}

export const MAX_STRING_LENGTH = 500;
export const MAX_PERSON_NAME_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;
const MAX_NUMBER_STRING_LENGTH = 40;
const MAX_NUMBER_DECIMALS = 20;

/** Sentinels (private use) delimit placeholders in the intermediate markup string; they may never appear in source or values. */
export const SENTINEL_OPEN = '';
export const SENTINEL_CLOSE = '';

function isForbiddenCode(c: number): boolean {
  return (
    c <= 0x08 ||
    c === 0x0b ||
    c === 0x0c ||
    (c >= 0x0e && c <= 0x1f) ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xe000 ||
    c === 0xe001
  );
}

/** Index of the first forbidden character (C0 and C1 control characters other than TAB/LF/CR, line/paragraph separators, bidi controls, sentinels), or -1. */
export function findForbiddenCharacter(text: string): number {
  for (let i = 0; i < text.length; i++) if (isForbiddenCode(text.charCodeAt(i))) return i;
  return -1;
}

function invalid(variable: string, type: VariableType, expected: string): never {
  throw templateError('INVALID_VARIABLE_VALUE', `Invalid value for ${type} variable '${variable}': expected ${expected}`, { variable, type });
}

// ---------------------------------------------------------------- Intl caches
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();
const CACHE_LIMIT = 500;

function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let value = cache.get(key);
  if (!value) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    value = make();
    cache.set(key, value);
  }
  return value;
}

/** Canonicalizes a locale used for formatting; throws VALIDATION_FAILED for an unsupported tag. */
export function formattingLocale(locale: string): string {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) throw new ContentError('VALIDATION_FAILED', 'Locale is not a supported BCP 47 locale tag', { reason: 'INVALID_LOCALE' });
  return canonical;
}

/** Validates an IANA time zone name (offset strings are not accepted). */
export function validateTimeZone(timeZone: string): string {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64 || /^[+-]/.test(timeZone)) {
    throw new ContentError('VALIDATION_FAILED', 'Time zone is not a valid IANA time zone', { reason: 'INVALID_TIME_ZONE' });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ContentError('VALIDATION_FAILED', 'Time zone is not a valid IANA time zone', { reason: 'INVALID_TIME_ZONE' });
  }
  return timeZone;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(numberFormats, `${locale}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options));
}
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(dateFormats, `${locale}|${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, options));
}

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export const PLURAL_CATEGORIES: readonly PluralCategory[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** CLDR plural category of a count for a locale. */
export function pluralCategory(locale: string, count: number): PluralCategory {
  const l = formattingLocale(locale);
  return cached(pluralRules, l, () => new Intl.PluralRules(l)).select(count) as PluralCategory;
}

/** A COUNT value formatted with locale digit grouping. Throws INVALID_VARIABLE_VALUE when it is not a non-negative safe integer. */
export function formatCount(variable: string, value: unknown, locale: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(variable, 'COUNT', 'a non-negative safe integer');
  return numberFormat(formattingLocale(locale)).format(value);
}

// ---------------------------------------------------------------- per-type validators
let currencies: Set<string> | null = null;
function isSupportedCurrency(code: string): boolean {
  currencies ??= new Set(Intl.supportedValuesOf('currency'));
  return currencies.has(code);
}

function currencyFractionDigits(currency: string): number {
  return numberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Exact decimal string from integer minor units, BigInt only (never Number division). */
export function minorUnitsToDecimal(amountMinor: number, fractionDigits: number): string {
  const negative = amountMinor < 0;
  let digits = (negative ? -BigInt(amountMinor) : BigInt(amountMinor)).toString();
  if (fractionDigits > 0) {
    digits = digits.padStart(fractionDigits + 1, '0');
    digits = `${digits.slice(0, digits.length - fractionDigits)}.${digits.slice(digits.length - fractionDigits)}`;
  }
  return negative && /[1-9]/.test(digits) ? `-${digits}` : digits;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatMoney(name: string, value: unknown, locale: string): string {
  const expected = '{ amount_minor: integer, currency: ISO-4217 code }';
  if (!isPlainObject(value)) return invalid(name, 'MONEY', expected);
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, 'amount_minor') || !Object.hasOwn(value, 'currency')) return invalid(name, 'MONEY', expected);
  const { amount_minor: amount, currency } = value;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return invalid(name, 'MONEY', 'amount_minor as a safe integer');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || !isSupportedCurrency(currency))
    return invalid(name, 'MONEY', 'a supported ISO-4217 currency');
  const decimal = minorUnitsToDecimal(amount, currencyFractionDigits(currency));
  // Intl.NumberFormat formats the exact decimal string (no binary floating point involved).
  return numberFormat(locale, { style: 'currency', currency }).format(decimal as unknown as number);
}

function formatNumber(name: string, value: unknown, locale: string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid(name, 'NUMBER', 'a finite number or decimal string');
    return numberFormat(locale).format(value);
  }
  if (typeof value === 'string' && value.length <= MAX_NUMBER_STRING_LENGTH && /^-?\d+(\.\d+)?$/.test(value)) {
    const decimals = value.includes('.') ? value.length - value.indexOf('.') - 1 : 0;
    if (decimals > MAX_NUMBER_DECIMALS) return invalid(name, 'NUMBER', `at most ${MAX_NUMBER_DECIMALS} decimal places`);
    return numberFormat(locale, { maximumFractionDigits: decimals }).format(value as unknown as number);
  }
  return invalid(name, 'NUMBER', 'a finite number or decimal string');
}

/** Parses and normalizes an http/https URL value. Returns the WHATWG-normalized href. */
export function normalizeUrlValue(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH)
    return invalid(name, 'URL', 'an http(s) URL of at most 2048 characters');
  // Reject whitespace/control characters outright instead of letting the WHATWG parser silently strip them.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || isForbiddenCode(c)) return invalid(name, 'URL', 'a URL without whitespace or control characters');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(name, 'URL', 'an absolute http(s) URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.username !== '' || url.password !== '') {
    return invalid(name, 'URL', 'an http(s) URL without credentials');
  }
  return url.href;
}

function parseDateParts(name: string, type: VariableType, y: number, mo: number, d: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  if (y < 1 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return invalid(name, type, 'a real calendar date');
  return date;
}

function formatDate(name: string, value: unknown, locale: string): string {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return invalid(name, 'DATE', "'YYYY-MM-DD'");
  const date = parseDateParts(name, 'DATE', Number(m[1]), Number(m[2]), Number(m[3]));
  // Midnight UTC rendered in UTC: the calendar day can never shift with the reader's zone.
  return dateFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function formatTime(name: string, value: unknown, locale: string): string {
  const m = typeof value === 'string' ? /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value) : null;
  if (!m) return invalid(name, 'TIME', "'HH:mm' or 'HH:mm:ss'");
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || mi > 59 || s > 59) return invalid(name, 'TIME', 'a valid time of day');
  const date = new Date(Date.UTC(1970, 0, 1, h, mi, s));
  return dateFormat(locale, { timeStyle: m[3] === undefined ? 'short' : 'medium', timeZone: 'UTC' }).format(date);
}

function formatDateTime(name: string, value: unknown, locale: string, timeZone: string): string {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!m) return invalid(name, 'DATETIME', 'an ISO-8601 instant with an offset or Z');
  parseDateParts(name, 'DATETIME', Number(m[1]), Number(m[2]), Number(m[3]));
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (h > 23 || mi > 59 || s > 59) return invalid(name, 'DATETIME', 'a valid time of day');
  const offset = m[8]!;
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return invalid(name, 'DATETIME', 'a valid UTC offset');
  const ms = (m[7] ?? '').padEnd(3, '0').slice(0, 3);
  const instant = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(s).padStart(2, '0')}.${ms}${offset}`);
  if (Number.isNaN(instant)) return invalid(name, 'DATETIME', 'an ISO-8601 instant within the supported range');
  return dateFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone }).format(new Date(instant));
}

function checkedString(name: string, type: VariableType, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) return invalid(name, type, `a string of at most ${max} characters`);
  if (findForbiddenCharacter(value) !== -1) return invalid(name, type, 'a string without control characters');
  return value;
}

/**
 * Formats one variable value by its declared type for the given locale. The result is plain text (callers escape or insert it
 * as escaped text); it is never parsed as template or markup.
 */
export function formatVariable(def: { name: string; type: VariableType }, value: unknown, options: FormatOptions): string {
  const locale = formattingLocale(options.locale);
  const { name } = def;
  switch (def.type) {
    case 'STRING':
      return checkedString(name, 'STRING', value, MAX_STRING_LENGTH);
    case 'PERSON_DISPLAY_NAME': {
      const text = checkedString(name, 'PERSON_DISPLAY_NAME', value, MAX_PERSON_NAME_LENGTH * 5)
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length === 0 || text.length > MAX_PERSON_NAME_LENGTH)
        return invalid(name, 'PERSON_DISPLAY_NAME', `a non-empty name of at most ${MAX_PERSON_NAME_LENGTH} characters`);
      return text;
    }
    case 'URL':
      return normalizeUrlValue(name, value);
    case 'NUMBER':
      return formatNumber(name, value, locale);
    case 'COUNT':
      return formatCount(name, value, locale);
    case 'MONEY':
      return formatMoney(name, value, locale);
    case 'DATE':
      return formatDate(name, value, locale);
    case 'TIME':
      return formatTime(name, value, locale);
    case 'DATETIME':
      return formatDateTime(name, value, locale, validateTimeZone(options.timeZone ?? 'UTC'));
    default:
      return invalid(name, def.type as VariableType, 'a known variable type');
  }
}
