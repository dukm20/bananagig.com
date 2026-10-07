// The ONE strict parser for integers that arrive as text (GEO-002A). Canonical base-10 only, checked lexically before any conversion.
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_FORMAT_VERSION_BOUNDS,
  DECIMAL_INTEGER_PATTERN,
  MAX_DECIMAL_INTEGER_DIGITS,
  decimalIntegerMessage,
  decimalIntegerParam,
  parseDecimalInteger,
} from './index';

describe('parseDecimalInteger', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['9', 9],
    ['10', 10],
    ['1000', 1000],
    ['100000', 100000],
    ['999999999999999', 999999999999999],
  ])('accepts the canonical text %s', (raw, expected) => {
    expect(parseDecimalInteger(raw)).toBe(expected);
  });

  it.each([
    ['1e3', 'exponent'],
    ['1E3', 'exponent'],
    ['1e0', 'exponent'],
    ['1e+3', 'signed exponent'],
    ['1e999', 'exponent overflow'],
    ['1.0', 'decimal point'],
    ['1.', 'trailing point'],
    ['.1', 'leading point'],
    ['1,000', 'separator'],
    ['1_000', 'separator'],
    ['+1', 'plus sign'],
    ['-1', 'minus sign'],
    ['-0', 'negative zero'],
    ['00', 'leading zeros'],
    ['01', 'leading zero'],
    ['0001', 'leading zeros'],
    [' 1', 'leading space'],
    ['1 ', 'trailing space'],
    ['\t1', 'tab'],
    ['1\n', 'line feed'],
    [' 1', 'non-breaking space'],
    ['', 'empty'],
    [' ', 'blank'],
    ['0x10', 'hex'],
    ['0X10', 'hex'],
    ['0b1', 'binary'],
    ['0o7', 'octal'],
    ['ff', 'hex digits'],
    ['Infinity', 'Infinity'],
    ['-Infinity', 'negative Infinity'],
    ['NaN', 'NaN'],
    ['null', 'null text'],
    ['true', 'boolean text'],
    ['١', 'Arabic-Indic digit one'],
    ['１', 'full-width digit one'],
    ['1\u0000', 'NUL'],
    ['1abc', 'trailing letters'],
    ['1000000000000000', '16 digits (beyond the digit cap)'],
    ['9007199254740993', 'beyond the safe integer range'],
  ])('rejects %j (%s)', (raw) => {
    expect(parseDecimalInteger(raw)).toBeNull();
  });

  it.each([[1], [1.5], [NaN], [Infinity], [null], [undefined], [true], [{}], [['1']]])(
    'rejects the non-string %j: it never converts what is not text',
    (raw) => {
      expect(parseDecimalInteger(raw)).toBeNull();
    },
  );

  it('rejects a bigint as well', () => {
    expect(parseDecimalInteger(BigInt(1))).toBeNull();
  });

  it('applies inclusive bounds, with a default minimum of zero', () => {
    expect(parseDecimalInteger('0', { min: 1 })).toBeNull();
    expect(parseDecimalInteger('1', { min: 1 })).toBe(1);
    expect(parseDecimalInteger('100', { max: 100 })).toBe(100);
    expect(parseDecimalInteger('101', { max: 100 })).toBeNull();
    expect(parseDecimalInteger('5', { min: 5, max: 5 })).toBe(5);
    expect(parseDecimalInteger('4', { min: 5, max: 5 })).toBeNull();
    expect(parseDecimalInteger('1000', ADDRESS_FORMAT_VERSION_BOUNDS)).toBe(1000);
    expect(parseDecimalInteger('100001', ADDRESS_FORMAT_VERSION_BOUNDS)).toBeNull();
  });

  it('keeps every accepted value an exact integer: the digit cap sits below 2^53', () => {
    expect(MAX_DECIMAL_INTEGER_DIGITS).toBe(15);
    expect(Number.isSafeInteger(Number('9'.repeat(MAX_DECIMAL_INTEGER_DIGITS)))).toBe(true);
    expect(parseDecimalInteger('9'.repeat(MAX_DECIMAL_INTEGER_DIGITS))).toBe(Number('9'.repeat(MAX_DECIMAL_INTEGER_DIGITS)));
    expect(parseDecimalInteger('9'.repeat(MAX_DECIMAL_INTEGER_DIGITS + 1))).toBeNull();
  });

  it('never throws, whatever it is given', () => {
    for (const raw of [Symbol('x'), () => 1, Object.create(null), new Date(), '\ud800', 'a'.repeat(100000)])
      expect(() => parseDecimalInteger(raw)).not.toThrow();
  });

  it('exposes the lexical rule: the pattern alone already rejects what Number() would have accepted', () => {
    for (const raw of ['1e3', '1.0', '+1', '01', ' 1', '0x10', 'Infinity']) {
      expect(Number.isFinite(Number(raw)) || raw === 'Infinity').toBe(true);
      expect(DECIMAL_INTEGER_PATTERN.test(raw)).toBe(false);
    }
  });
});

describe('decimalIntegerParam (the same rule as a zod schema)', () => {
  const version = decimalIntegerParam(ADDRESS_FORMAT_VERSION_BOUNDS);
  it('turns canonical text into a number', () => {
    expect(version.parse('1')).toBe(1);
    expect(version.parse('1000')).toBe(1000);
  });
  it('rejects everything the parser rejects, with the fixed message', () => {
    for (const raw of ['1e3', '1.0', '-1', '+1', '01', ' 1', '0x10', 'Infinity', 'NaN', '0', '100001', '']) {
      const r = version.safeParse(raw);
      expect(r.success, raw).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toBe(decimalIntegerMessage(ADDRESS_FORMAT_VERSION_BOUNDS));
    }
    expect(version.safeParse(1000).success).toBe(false);
  });
  it('states the accepted syntax in a message that never carries the rejected text', () => {
    expect(decimalIntegerMessage(ADDRESS_FORMAT_VERSION_BOUNDS)).toBe(
      'must be a base-10 integer from 1 to 100000, written without sign, leading zeros, decimals, exponent, radix prefix or whitespace',
    );
    expect(decimalIntegerMessage()).toContain(`from 0 to ${Number.MAX_SAFE_INTEGER}`);
  });
});
