import { describe, expect, it } from 'vitest';
import { VARIABLE_TYPES, type VariableType } from '@bananagig/contracts';
import { ContentError } from './errors';
import { findForbiddenCharacter, formatCount, formatVariable, minorUnitsToDecimal, normalizeUrlValue, pluralCategory, validateTimeZone } from './format';

/** Intl uses NBSP / narrow NBSP in several locales; normalize for readable assertions. */
const norm = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ');
const fmt = (type: VariableType, value: unknown, locale = 'en-US', timeZone?: string): string =>
  norm(formatVariable({ name: 'v', type }, value, { locale, timeZone }));
const money = (amount_minor: number, currency: string, locale = 'en-US'): string => fmt('MONEY', { amount_minor, currency }, locale);

function expectInvalid(type: VariableType, value: unknown, locale = 'en-US'): ContentError {
  try {
    formatVariable({ name: 'v', type }, value, { locale });
  } catch (e) {
    expect(e).toBeInstanceOf(ContentError);
    const err = e as ContentError;
    expect(err.code).toBe('TEMPLATE_ERROR');
    expect(err.details.reason).toBe('INVALID_VARIABLE_VALUE');
    expect(err.details.variable).toBe('v');
    return err;
  }
  throw new Error(`expected ${type} value ${JSON.stringify(value)} to be rejected`);
}

describe('MONEY', () => {
  it('formats USD with two fraction digits', () => {
    expect(money(123456, 'USD')).toBe('$1,234.56');
    expect(money(5, 'USD')).toBe('$0.05');
    expect(money(0, 'USD')).toBe('$0.00');
  });
  it('formats JPY with zero fraction digits', () => {
    expect(money(1234, 'JPY')).toBe('¥1,234');
    expect(money(0, 'JPY')).toBe('¥0');
  });
  it('formats KWD with three fraction digits', () => {
    expect(money(1234, 'KWD')).toBe('KWD 1.234');
    expect(money(5, 'KWD')).toBe('KWD 0.005');
  });
  it('formats negative amounts (including values below one major unit)', () => {
    expect(money(-123456, 'USD')).toBe('-$1,234.56');
    expect(money(-5, 'USD')).toBe('-$0.05');
    expect(money(-1234, 'JPY')).toBe('-¥1,234');
  });
  it('is exact near Number.MAX_SAFE_INTEGER (no floating-point division)', () => {
    expect(money(Number.MAX_SAFE_INTEGER, 'USD')).toBe('$90,071,992,547,409.91');
    expect(money(-Number.MAX_SAFE_INTEGER, 'USD')).toBe('-$90,071,992,547,409.91');
    expect(money(Number.MAX_SAFE_INTEGER, 'JPY')).toBe('¥9,007,199,254,740,991');
    expect(money(Number.MAX_SAFE_INTEGER, 'KWD')).toBe('KWD 9,007,199,254,740.991');
    expect(money(Number.MAX_SAFE_INTEGER - 1, 'USD')).toBe('$90,071,992,547,409.90');
  });
  it('builds the decimal string from minor units with BigInt arithmetic', () => {
    expect(minorUnitsToDecimal(Number.MAX_SAFE_INTEGER, 2)).toBe('90071992547409.91');
    expect(minorUnitsToDecimal(-5, 2)).toBe('-0.05');
    expect(minorUnitsToDecimal(0, 2)).toBe('0.00');
    expect(minorUnitsToDecimal(-0, 2)).toBe('0.00');
    expect(minorUnitsToDecimal(12, 0)).toBe('12');
    expect(minorUnitsToDecimal(7, 3)).toBe('0.007');
    expect(minorUnitsToDecimal(100, 2)).toBe('1.00');
  });
  it('differs by locale', () => {
    expect(money(123456, 'USD', 'en-US')).toBe('$1,234.56');
    expect(money(123456, 'USD', 'de-DE')).toBe('1.234,56 $');
    expect(money(123456, 'USD', 'es-US')).toBe('$1,234.56');
    expect(money(123456, 'EUR', 'de-DE')).toBe('1.234,56 €');
    expect(money(123456, 'EUR', 'en-US')).toBe('€1,234.56');
  });
  it.each([
    ['a number', 12.5],
    ['a string', '12.50'],
    ['null', null],
    ['an array', [1, 'USD']],
    ['missing currency', { amount_minor: 100 }],
    ['missing amount', { currency: 'USD' }],
    ['float minor units', { amount_minor: 10.5, currency: 'USD' }],
    ['string minor units', { amount_minor: '100', currency: 'USD' }],
    ['unsafe integer', { amount_minor: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' }],
    ['NaN', { amount_minor: Number.NaN, currency: 'USD' }],
    ['Infinity', { amount_minor: Number.POSITIVE_INFINITY, currency: 'USD' }],
    ['lower-case currency', { amount_minor: 100, currency: 'usd' }],
    ['unknown currency', { amount_minor: 100, currency: 'ZZZ' }],
    ['long currency', { amount_minor: 100, currency: 'USDX' }],
    ['numeric currency', { amount_minor: 100, currency: 123 }],
    ['an extra key', { amount_minor: 100, currency: 'USD', extra: 1 }],
    ['an object with a custom prototype', Object.create({ amount_minor: 100, currency: 'USD' })],
  ])('rejects %s', (_label, value) => {
    expectInvalid('MONEY', value);
  });
});

describe('NUMBER and COUNT', () => {
  it('formats numbers and exact decimal strings by locale', () => {
    expect(fmt('NUMBER', 1234.5)).toBe('1,234.5');
    expect(fmt('NUMBER', '1234567.891', 'de-DE')).toBe('1.234.567,891');
    expect(fmt('NUMBER', '1234567.891', 'en-US')).toBe('1,234,567.891');
    expect(fmt('NUMBER', '123456789012345678901234567890.12')).toBe('123,456,789,012,345,678,901,234,567,890.12');
    expect(fmt('NUMBER', '-0.5')).toBe('-0.5');
    expect(fmt('NUMBER', 0)).toBe('0');
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, '1e5', 'abc', '', '1,5', '.5', '5.', ' 5', '--1', true, null, {}, '1.' + '0'.repeat(21), '9'.repeat(41)])(
    'rejects NUMBER %j',
    (v) => {
      expectInvalid('NUMBER', v);
    },
  );
  it('formats COUNT with locale grouping', () => {
    expect(fmt('COUNT', 0)).toBe('0');
    expect(fmt('COUNT', 1234567)).toBe('1,234,567');
    expect(fmt('COUNT', 1234567, 'de-DE')).toBe('1.234.567');
    expect(fmt('COUNT', Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991');
    expect(formatCount('c', 3, 'en-US')).toBe('3');
  });
  it.each([-1, 1.5, '3', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -0.1])('rejects COUNT %j', (v) => {
    expectInvalid('COUNT', v);
  });
  it('plural category follows CLDR for the locale', () => {
    expect(pluralCategory('en-US', 1)).toBe('one');
    expect(pluralCategory('en-US', 0)).toBe('other');
    expect(pluralCategory('ar', 0)).toBe('zero');
    expect(pluralCategory('ar', 2)).toBe('two');
    expect(pluralCategory('ar', 5)).toBe('few');
    expect(pluralCategory('ar', 11)).toBe('many');
    expect(pluralCategory('ar', 100)).toBe('other');
    expect(pluralCategory('fr-FR', 0)).toBe('one');
    expect(pluralCategory('ja', 1)).toBe('other');
  });
});

describe('DATE, TIME and DATETIME', () => {
  it('formats DATE by locale and never shifts the day', () => {
    expect(fmt('DATE', '2026-03-05')).toBe('March 5, 2026');
    expect(fmt('DATE', '2026-03-05', 'de-DE')).toBe('5. März 2026');
    expect(fmt('DATE', '2026-03-05', 'es-US')).toBe('5 de marzo de 2026');
    for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Tokyo']) {
      expect(fmt('DATE', '2026-12-31', 'en-US', timeZone)).toBe('December 31, 2026');
      expect(fmt('DATE', '2026-01-01', 'en-US', timeZone)).toBe('January 1, 2026');
    }
  });
  it('accepts leap days only in leap years', () => {
    expect(fmt('DATE', '2024-02-29')).toBe('February 29, 2024');
    expectInvalid('DATE', '2025-02-29');
    expectInvalid('DATE', '1900-02-29');
    expect(fmt('DATE', '2000-02-29')).toBe('February 29, 2000');
  });
  it.each([
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-02-30',
    '2026-1-5',
    '26-01-05',
    '2026/01/05',
    '2026-01-05T00:00:00Z',
    '0000-01-01',
    '',
    20260105,
    null,
    '2026-01-05 ',
  ])('rejects DATE %j', (v) => {
    expectInvalid('DATE', v);
  });
  it('formats TIME', () => {
    expect(fmt('TIME', '14:05')).toBe('2:05 PM');
    expect(fmt('TIME', '14:05', 'de-DE')).toBe('14:05');
    expect(fmt('TIME', '14:05:09', 'de-DE')).toBe('14:05:09');
    expect(fmt('TIME', '00:00')).toBe('12:00 AM');
  });
  it.each(['24:00', '12:60', '12:30:60', '1:30', '12', '12:30:5', '12:30:00.5', '', 1230, null])('rejects TIME %j', (v) => {
    expectInvalid('TIME', v);
  });
  it('renders DATETIME in the requested time zone (default UTC)', () => {
    expect(fmt('DATETIME', '2026-03-05T23:30:00-05:00')).toBe('March 6, 2026 at 4:30 AM');
    expect(fmt('DATETIME', '2026-03-05T23:30:00-05:00', 'en-US', 'UTC')).toBe('March 6, 2026 at 4:30 AM');
    expect(fmt('DATETIME', '2026-03-05T23:30:00-05:00', 'en-US', 'Asia/Tokyo')).toBe('March 6, 2026 at 1:30 PM');
    expect(fmt('DATETIME', '2026-03-05T23:30:00-05:00', 'en-US', 'America/New_York')).toBe('March 5, 2026 at 11:30 PM');
    expect(fmt('DATETIME', '2026-03-05T12:00:00Z', 'en-US', 'America/Los_Angeles')).toBe('March 5, 2026 at 4:00 AM');
    expect(fmt('DATETIME', '2026-07-05T12:00:00.123456Z', 'en-US', 'America/Los_Angeles')).toBe('July 5, 2026 at 5:00 AM');
    expect(fmt('DATETIME', '2026-03-05T12:00Z')).toBe('March 5, 2026 at 12:00 PM');
  });
  it.each([
    '2026-03-05T12:00:00', // no offset
    '2026-03-05 12:00:00Z',
    '2026-03-05T24:00:00Z',
    '2026-02-30T12:00:00Z',
    '2026-03-05T12:00:00+25:00',
    '2026-03-05T12:00:00+01:60',
    '2026-03-05T12:00:00+0100',
    '2026-03-05',
    '2026-03-05T12:00:60Z',
    '',
    1772409600000,
    null,
  ])('rejects DATETIME %j', (v) => {
    expectInvalid('DATETIME', v);
  });
  it('rejects an invalid time zone as a validation failure', () => {
    for (const tz of ['Not/AZone', '', '+01:00', 'x'.repeat(65)]) {
      expect(() => formatVariable({ name: 'v', type: 'DATETIME' }, '2026-03-05T12:00:00Z', { locale: 'en-US', timeZone: tz })).toThrow(ContentError);
      expect(() => validateTimeZone(tz)).toThrow(/time zone/i);
    }
    expect(validateTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });
});

describe('STRING, PERSON_DISPLAY_NAME, URL', () => {
  it('accepts plain strings and returns them unchanged (no interpretation)', () => {
    expect(fmt('STRING', 'Hello {name} <b>x</b> ${x} {{y}}')).toBe('Hello {name} <b>x</b> ${x} {{y}}');
    expect(fmt('STRING', '')).toBe('');
    expect(fmt('STRING', 'tab\tand\nnewline')).toBe('tab\tand\nnewline');
  });
  it.each(['a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u007fb', 'a b', 'a b', 'a‮b', 'a⁦b', 'ab', 'ab', 'x'.repeat(501), 5, null, {}, ['a']])(
    'rejects STRING %j',
    (v) => {
      expectInvalid('STRING', v);
    },
  );
  it.each(['a\u0080b', 'a\u0085b', 'a\u008db', 'a\u009fb'])('rejects C1 control characters (including NEL) in STRING %j and PERSON_DISPLAY_NAME', (v) => {
    expectInvalid('STRING', v);
    expectInvalid('PERSON_DISPLAY_NAME', v);
  });
  it('accepts the characters just outside the C1 range', () => {
    expect(fmt('STRING', 'a\u00a1b\u00bf')).toBe('a\u00a1b\u00bf');
  });
  it('accepts a STRING of exactly 500 characters', () => {
    expect(fmt('STRING', 'x'.repeat(500))).toHaveLength(500);
  });
  it('trims and collapses whitespace in person names', () => {
    expect(fmt('PERSON_DISPLAY_NAME', '  Ada \n\t Lovelace  ')).toBe('Ada Lovelace');
    expect(fmt('PERSON_DISPLAY_NAME', 'Zoë')).toBe('Zoë');
  });
  it.each(['', '   ', 'x'.repeat(201), 'a\u0000b', 'a‮b', 5, null])('rejects PERSON_DISPLAY_NAME %j', (v) => {
    expectInvalid('PERSON_DISPLAY_NAME', v);
  });
  it('normalizes http(s) URLs', () => {
    expect(fmt('URL', 'HTTPS://EXAMPLE.com')).toBe('https://example.com/');
    expect(fmt('URL', 'http://example.com/a?b=1#c')).toBe('http://example.com/a?b=1#c');
    expect(normalizeUrlValue('u', 'https://example.com/café')).toBe('https://example.com/caf%C3%A9');
  });
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com',
    'mailto:a@b.co',
    '//example.com',
    '/relative',
    'example.com',
    'https://user:pw@example.com',
    'https://',
    'https:// example.com',
    ' https://example.com',
    'https://example.com\n',
    'https://exa\tmple.com',
    'https://example.com/\u0000',
    `https://example.com/${'a'.repeat(2048)}`,
    '',
    5,
    null,
  ])('rejects URL %j', (v) => {
    expectInvalid('URL', v);
  });
});

describe('contract', () => {
  it('handles every variable type and never echoes the offending value in an error', () => {
    const secret = 'SECRET-VALUE-123'; // secret-scan:allow (fake fixture proving values never appear in errors)
    for (const type of VARIABLE_TYPES) {
      try {
        formatVariable({ name: 'v', type }, { secret }, { locale: 'en-US' });
        throw new Error('expected rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(ContentError);
        expect(JSON.stringify([(e as ContentError).message, (e as ContentError).details])).not.toContain(secret);
      }
    }
    for (const type of VARIABLE_TYPES) {
      try {
        formatVariable({ name: 'v', type }, `${secret}\u0000`, { locale: 'en-US' });
      } catch (e) {
        expect(JSON.stringify([(e as ContentError).message, (e as ContentError).details])).not.toContain(secret);
      }
    }
  });
  it('rejects an unsupported locale', () => {
    expect(() => formatVariable({ name: 'v', type: 'STRING' }, 'x', { locale: 'en_US' })).toThrow(ContentError);
  });
  it('finds forbidden characters', () => {
    expect(findForbiddenCharacter('ok\n\t\r text')).toBe(-1);
    expect(findForbiddenCharacter('ab\u0001')).toBe(2);
    expect(findForbiddenCharacter('ab\u0085')).toBe(2);
    expect(findForbiddenCharacter('\u0080')).toBe(0);
    expect(findForbiddenCharacter('x\u009f')).toBe(1);
    expect(findForbiddenCharacter('\u00a0\u00a1')).toBe(-1);
    expect(findForbiddenCharacter('‮')).toBe(0);
    expect(findForbiddenCharacter('x')).toBe(1);
  });
});
