// Unit tests of the secrets of the email verification (ID-002): the generation of the one-time code and the magic-link token (CSPRNG only), the keyed
// hashes that are stored (HMAC-SHA-256, domain separated, code hash bound to its challenge) and the constant-time compare. No database, no network.
// node:crypto is wrapped (the real implementation still runs unless a test feeds fixed values) so the tests can PROVE which primitives are used.
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { EMAIL_CODE_SHAPE, EMAIL_TOKEN_SHAPE } from '@bananagig/contracts';
import {
  generateMagicToken,
  generateVerificationCode,
  hashDimension,
  hashMagicToken,
  hashVerificationCode,
  hashesEqual,
  isCodeShape,
  isTokenShape,
} from './email-crypto';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: vi.fn(actual.randomInt),
    randomBytes: vi.fn(actual.randomBytes),
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});
const real = await vi.importActual<typeof import('node:crypto')>('node:crypto');

const randomIntSpy = randomInt as unknown as MockInstance<(min: number, max: number) => number>;
const randomBytesSpy = randomBytes as unknown as MockInstance<(size: number) => Buffer>;
const timingSafeEqualSpy = timingSafeEqual as unknown as MockInstance<(a: Buffer, b: Buffer) => boolean>;

beforeEach(() => {
  randomIntSpy.mockReset();
  randomIntSpy.mockImplementation(real.randomInt as never);
  randomBytesSpy.mockReset();
  randomBytesSpy.mockImplementation(real.randomBytes as never);
  timingSafeEqualSpy.mockReset();
  timingSafeEqualSpy.mockImplementation(real.timingSafeEqual as never);
});

/** Makes randomInt return the given digits in order (cycling), so a test can pin leading zeros and the digit order. */
const feedDigits = (...digits: number[]): void => {
  let i = 0;
  randomIntSpy.mockImplementation(() => digits[i++ % digits.length]!);
};
const chiSquare = (counts: number[], expected: number): number => counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);

// Test-only inputs, built from bytes so no source line holds a credential-looking literal.
const NUL = String.fromCharCode(0);
const HASH_KEY = Buffer.alloc(32, 7).toString('hex');
const OTHER_HASH_KEY = Buffer.alloc(32, 9).toString('hex');
const CHALLENGE_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_CHALLENGE_ID = '9d2b7c64-1f0a-4e55-8c3b-6a1d2e4f5b70';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

// ====================================================================== generateVerificationCode
describe('generateVerificationCode', () => {
  it.each([4, 5, 6, 7, 8, 9, 10])('returns exactly %i decimal digits', (length) => {
    for (let i = 0; i < 50; i++) {
      const code = generateVerificationCode(length);
      expect(code).toHaveLength(length);
      expect(code).toMatch(/^[0-9]+$/);
      expect(EMAIL_CODE_SHAPE.test(code)).toBe(true);
      expect(isCodeShape(code)).toBe(true);
    }
  });

  it('draws one digit per position from node:crypto randomInt(0, 10) and from nothing else', () => {
    generateVerificationCode(7);
    expect(randomIntSpy).toHaveBeenCalledTimes(7);
    for (const call of randomIntSpy.mock.calls) expect(call).toEqual([0, 10]);
    expect(randomBytesSpy).not.toHaveBeenCalled();
  });

  it('preserves leading zeros: a draw of all zeros is a string of zeros, not the number 0', () => {
    feedDigits(0);
    expect(generateVerificationCode(6)).toBe('000000');
    expect(generateVerificationCode(4)).toBe('0000');
    expect(generateVerificationCode(10)).toBe('0000000000');
  });

  it('keeps the order of the draws and does not drop a leading zero in the middle of a sequence', () => {
    feedDigits(0, 0, 4, 2, 1, 3);
    expect(generateVerificationCode(6)).toBe('004213');
    feedDigits(1, 2, 3, 4, 5, 6, 7, 8, 9, 0);
    expect(generateVerificationCode(10)).toBe('1234567890');
    feedDigits(9, 0, 0, 9);
    expect(generateVerificationCode(4)).toBe('9009');
  });

  it('produces codes that start with zero with the real CSPRNG (5000 four-digit codes: a leading zero is certain to appear)', () => {
    let leadingZero = 0;
    for (let i = 0; i < 5000; i++) {
      const code = generateVerificationCode(4);
      expect(code).toHaveLength(4);
      if (code.startsWith('0')) leadingZero++;
    }
    expect(leadingZero).toBeGreaterThan(0);
    // about 10% (500 expected, standard deviation 21); a very wide band only guards against a generator that avoids or forces a zero
    expect(leadingZero).toBeGreaterThan(300);
    expect(leadingZero).toBeLessThan(700);
  });

  it.each([
    ['3', 3],
    ['11', 11],
    ['0', 0],
    ['-1', -1],
    ['4.5', 4.5],
    ['6.0000001', 6.0000001],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a very large integer', Number.MAX_SAFE_INTEGER],
    ['a numeric string', '6' as unknown as number],
    ['null', null as unknown as number],
    ['undefined', undefined as unknown as number],
    ['an object', {} as unknown as number],
  ])('throws a RangeError for the length %s and draws nothing', (_label, length) => {
    expect(() => generateVerificationCode(length)).toThrow(RangeError);
    expect(randomIntSpy).not.toHaveBeenCalled();
  });

  it('accepts exactly the boundaries 4 and 10', () => {
    expect(generateVerificationCode(4)).toHaveLength(4);
    expect(generateVerificationCode(10)).toHaveLength(10);
  });

  it('is uniform per position and overall: chi-square of 10,000 six-digit codes stays inside a loose bound (9 degrees of freedom, p well below 1e-6)', () => {
    const N = 10_000;
    const LENGTH = 6;
    const perPosition = Array.from({ length: LENGTH }, () => new Array<number>(10).fill(0));
    const overall = new Array<number>(10).fill(0);
    for (let i = 0; i < N; i++) {
      const code = generateVerificationCode(LENGTH);
      for (let p = 0; p < LENGTH; p++) {
        const d = Number(code[p]);
        perPosition[p]![d]!++;
        overall[d]!++;
      }
    }
    // The 0.1 % critical value for 9 degrees of freedom is 27.9: 50 only fails a generator that is clearly not uniform.
    for (let p = 0; p < LENGTH; p++) expect(chiSquare(perPosition[p]!, N / 10), `position ${p}`).toBeLessThan(50);
    expect(chiSquare(overall, (N * LENGTH) / 10)).toBeLessThan(50);
    // every digit shows up in every position
    for (const counts of perPosition) for (const c of counts) expect(c).toBeGreaterThan(0);
  });

  it('shows no duplicates beyond the birthday expectation: 10,000 draws from 1,000,000 codes collide about 50 times, never hundreds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateVerificationCode(6));
    // expected distinct ~9,950 with a standard deviation of about 7: 9,900 is roughly seven sigma away
    expect(seen.size).toBeGreaterThan(9_900);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('never uses Math.random (a Math.random that throws is never touched, for every length and for tokens)', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must never be used for a verification secret');
    });
    try {
      for (let length = 4; length <= 10; length++) for (let i = 0; i < 100; i++) generateVerificationCode(length);
      for (let i = 0; i < 100; i++) generateMagicToken();
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});

// ====================================================================== generateMagicToken
describe('generateMagicToken', () => {
  it('returns 43 unpadded base64url characters that match the contract shape', () => {
    for (let i = 0; i < 100; i++) {
      const token = generateMagicToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).not.toMatch(/[=+/]/);
      expect(EMAIL_TOKEN_SHAPE.test(token)).toBe(true);
      expect(isTokenShape(token)).toBe(true);
    }
  });

  it('decodes to exactly 32 random bytes (256 bits) and is the canonical encoding of them', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateMagicToken();
      const bytes = Buffer.from(token, 'base64url');
      expect(bytes).toHaveLength(32);
      expect(bytes.toString('base64url')).toBe(token);
    }
  });

  it('asks node:crypto randomBytes for exactly 32 bytes, once, and uses nothing else', () => {
    generateMagicToken();
    expect(randomBytesSpy).toHaveBeenCalledTimes(1);
    expect(randomBytesSpy).toHaveBeenCalledWith(32);
    expect(randomIntSpy).not.toHaveBeenCalled();
  });

  it('encodes the bytes it was given as unpadded base64url (all-zero and all-one inputs pin the alphabet and the length)', () => {
    randomBytesSpy.mockImplementation((() => Buffer.alloc(32, 0)) as never);
    expect(generateMagicToken()).toBe('A'.repeat(43));
    randomBytesSpy.mockImplementation((() => Buffer.alloc(32, 0xff)) as never);
    expect(generateMagicToken()).toBe(`${'_'.repeat(42)}8`);
  });

  it('produces 1,000 distinct tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i++) seen.add(generateMagicToken());
    expect(seen.size).toBe(1_000);
  });

  it('uses all four parts of the alphabet over many tokens (letters, digits, - and _ appear)', () => {
    let joined = '';
    for (let i = 0; i < 200; i++) joined += generateMagicToken();
    expect(joined).toMatch(/[A-Z]/);
    expect(joined).toMatch(/[a-z]/);
    expect(joined).toMatch(/[0-9]/);
    expect(joined).toMatch(/-/);
    expect(joined).toMatch(/_/);
  });
});

// ====================================================================== hashes
describe('hashVerificationCode', () => {
  const hash = (key = HASH_KEY, challengeId = CHALLENGE_ID, code = '048213') => hashVerificationCode(key, challengeId, code);

  it('is 64 lower-case hex characters (HMAC-SHA-256)', () => {
    expect(hash()).toMatch(HEX64);
  });
  it('is deterministic for the same inputs', () => {
    expect(hash()).toBe(hash());
    expect(hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213')).toBe(hash());
  });
  it('changes with the key', () => {
    expect(hash(OTHER_HASH_KEY)).not.toBe(hash());
  });
  it('is bound to the challenge: the same code on another challenge hashes differently', () => {
    expect(hash(HASH_KEY, OTHER_CHALLENGE_ID)).not.toBe(hash());
  });
  it('changes with the code, including a change of one digit and a leading zero', () => {
    expect(hash(HASH_KEY, CHALLENGE_ID, '048214')).not.toBe(hash());
    expect(hash(HASH_KEY, CHALLENGE_ID, '48213')).not.toBe(hash());
    expect(hash(HASH_KEY, CHALLENGE_ID, '0482130')).not.toBe(hash());
  });
  it('has a stable stored format: HMAC-SHA-256 over "bananagig:email-code:v1", the length-prefixed challenge id and code, separated by NUL (changing it would orphan open challenges)', () => {
    const expected = createHmac('sha256', HASH_KEY).update(`bananagig:email-code:v1${NUL}${CHALLENGE_ID.length}:${CHALLENGE_ID}${NUL}6:048213`).digest('hex');
    expect(hash()).toBe(expected);
  });
  it('is injective in its parts: a NUL inside one part cannot be moved into the neighbouring part', () => {
    expect(hash(HASH_KEY, 'a', `b${NUL}c`)).not.toBe(hash(HASH_KEY, `a${NUL}b`, 'c'));
    expect(hashDimension(HASH_KEY, 'ip', `x${NUL}2:y`)).not.toBe(hashDimension(HASH_KEY, 'ip', 'x'));
  });
  it('does not contain the plaintext code, the challenge id or the key', () => {
    for (const code of ['048213', '000000', '123456', '99999999']) {
      const h = hash(HASH_KEY, CHALLENGE_ID, code);
      expect(h).not.toContain(code);
      expect(h).not.toContain(CHALLENGE_ID);
      expect(h).not.toContain(HASH_KEY);
      expect(h).not.toBe(code);
    }
  });
  it('does not throw for empty strings and non-ASCII input, and still returns a well-formed hash', () => {
    expect(hashVerificationCode(HASH_KEY, '', '')).toMatch(HEX64);
    expect(hashVerificationCode('', CHALLENGE_ID, '048213')).toMatch(HEX64);
    expect(hashVerificationCode('', '', '')).toMatch(HEX64);
    expect(hashVerificationCode(HASH_KEY, CHALLENGE_ID, String.fromCodePoint(0x1f600, 0x0660))).toMatch(HEX64);
  });
  it('gives no collisions across 1,000 different codes of one challenge', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i++) seen.add(hash(HASH_KEY, CHALLENGE_ID, String(i).padStart(6, '0')));
    expect(seen.size).toBe(1_000);
  });
});

describe('hashMagicToken', () => {
  const linkValue = Buffer.alloc(32, 5).toString('base64url');
  it('is 64 lower-case hex characters, deterministic, and key dependent', () => {
    const h = hashMagicToken(HASH_KEY, linkValue);
    expect(h).toMatch(HEX64);
    expect(hashMagicToken(HASH_KEY, linkValue)).toBe(h);
    expect(hashMagicToken(OTHER_HASH_KEY, linkValue)).not.toBe(h);
  });
  it('depends on every character of the token', () => {
    const generated = generateMagicToken();
    const variant = `${generated.slice(0, -1)}${generated.endsWith('A') ? 'B' : 'A'}`;
    expect(hashMagicToken(HASH_KEY, variant)).not.toBe(hashMagicToken(HASH_KEY, generated));
  });
  it('has a stable stored format: HMAC-SHA-256 over "bananagig:email-link:v1" and the length-prefixed token, separated by NUL', () => {
    const expected = createHmac('sha256', HASH_KEY).update(`bananagig:email-link:v1${NUL}${linkValue.length}:${linkValue}`).digest('hex');
    expect(hashMagicToken(HASH_KEY, linkValue)).toBe(expected);
  });
  it('does not contain the plaintext token, and does not throw for an empty token or key', () => {
    const t = generateMagicToken();
    expect(hashMagicToken(HASH_KEY, t)).not.toContain(t);
    expect(hashMagicToken(HASH_KEY, '')).toMatch(HEX64);
    expect(hashMagicToken('', '')).toMatch(HEX64);
  });
  it('gives no collisions across 1,000 generated tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i++) seen.add(hashMagicToken(HASH_KEY, generateMagicToken()));
    expect(seen.size).toBe(1_000);
  });
});

describe('hashDimension', () => {
  const value = 'person@example.test';
  it('is 32 lower-case hex characters (128 bits), deterministic, and key dependent', () => {
    const h = hashDimension(HASH_KEY, 'email', value);
    expect(h).toMatch(HEX32);
    expect(hashDimension(HASH_KEY, 'email', value)).toBe(h);
    expect(hashDimension(OTHER_HASH_KEY, 'email', value)).not.toBe(h);
  });
  it('separates the dimensions: the same value as an ip, an email and a device hashes differently', () => {
    const ip = hashDimension(HASH_KEY, 'ip', value);
    const email = hashDimension(HASH_KEY, 'email', value);
    const device = hashDimension(HASH_KEY, 'device', value);
    expect(new Set([ip, email, device]).size).toBe(3);
  });
  it('depends on the value', () => {
    expect(hashDimension(HASH_KEY, 'ip', '203.0.113.7')).not.toBe(hashDimension(HASH_KEY, 'ip', '203.0.113.8'));
  });
  it('has a stable stored format: the first 32 hex characters of HMAC-SHA-256 over "bananagig:rate-dimension:v1", the dimension and the value', () => {
    const full = createHmac('sha256', HASH_KEY).update(`bananagig:rate-dimension:v1${NUL}2:ip${NUL}${value.length}:${value}`).digest('hex');
    expect(hashDimension(HASH_KEY, 'ip', value)).toBe(full.slice(0, 32));
  });
  it('never exposes the raw value (an address, an IP or a device id never becomes part of a counter key)', () => {
    for (const dimension of ['ip', 'email', 'device'] as const) {
      const h = hashDimension(HASH_KEY, dimension, value);
      expect(h).not.toContain('person');
      expect(h).not.toContain('@');
    }
    expect(hashDimension(HASH_KEY, 'ip', '203.0.113.7')).not.toContain('203');
  });
  it('does not throw for an empty value or key', () => {
    expect(hashDimension(HASH_KEY, 'ip', '')).toMatch(HEX32);
    expect(hashDimension('', 'device', '')).toMatch(HEX32);
  });
});

describe('domain separation between the three hash families', () => {
  it('the same string hashed as a code, as a token and as a dimension value gives three unrelated values', () => {
    const text = '048213';
    const asCode = hashVerificationCode(HASH_KEY, CHALLENGE_ID, text);
    const asToken = hashMagicToken(HASH_KEY, text);
    const asDimension = hashDimension(HASH_KEY, 'email', text);
    expect(asCode).not.toBe(asToken);
    expect(asToken).not.toContain(asDimension);
    expect(asCode).not.toContain(asDimension);
  });
  it('a code hash can never be replayed as a token hash (and the reverse), even with an empty challenge id', () => {
    const text = generateMagicToken();
    expect(hashVerificationCode(HASH_KEY, '', text)).not.toBe(hashMagicToken(HASH_KEY, text));
    expect(hashVerificationCode(HASH_KEY, CHALLENGE_ID, text)).not.toBe(hashMagicToken(HASH_KEY, text));
  });
});

// ====================================================================== hashesEqual
describe('hashesEqual', () => {
  const h = hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213');
  const flipLast = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
  const flipFirst = (hex: string): string => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;

  it('is true for two equal 64-hex hashes (same string and an equal copy)', () => {
    expect(hashesEqual(h, h)).toBe(true);
    expect(hashesEqual(h, Array.from(h).join(''))).toBe(true);
    expect(hashesEqual(h, hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213'))).toBe(true);
  });
  it('is false for different hashes', () => {
    expect(hashesEqual(h, hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048214'))).toBe(false);
    expect(hashesEqual(h, hashMagicToken(HASH_KEY, '048213'))).toBe(false);
  });
  it('is false when the hashes differ only in the last or in the first character', () => {
    expect(hashesEqual(h, flipLast(h))).toBe(false);
    expect(hashesEqual(flipLast(h), h)).toBe(false);
    expect(hashesEqual(h, flipFirst(h))).toBe(false);
    expect(hashesEqual(h.slice(0, 63) + (h.endsWith('f') ? 'e' : 'f'), h)).toBe(false);
  });
  it.each([
    ['63 characters', h.slice(0, 63)],
    ['65 characters', `${h}0`],
    ['an empty string', ''],
    ['32 characters', h.slice(0, 32)],
    ['128 characters', `${h}${h}`],
  ])('is false when either side has the wrong length (%s)', (_label, other) => {
    expect(hashesEqual(h, other)).toBe(false);
    expect(hashesEqual(other, h)).toBe(false);
    expect(hashesEqual(other, other)).toBe(false);
  });
  it('is false for two empty strings', () => {
    expect(hashesEqual('', '')).toBe(false);
  });
  it('is false for a 64-character string that is not hex, even when both sides are identical', () => {
    const notHex = 'g'.repeat(64);
    expect(hashesEqual(notHex, notHex)).toBe(false);
    expect(hashesEqual(h, notHex)).toBe(false);
    expect(hashesEqual(notHex, h)).toBe(false);
    const partlyHex = `${h.slice(0, 40)}${'z'.repeat(24)}`;
    expect(hashesEqual(partlyHex, partlyHex)).toBe(false);
    expect(hashesEqual(h, `${h.slice(0, 63)}z`)).toBe(false);
    expect(hashesEqual(h, `${h.slice(0, 10)}-${h.slice(11)}`)).toBe(false);
  });
  it('treats upper-case hex as the same bytes as lower-case hex (ACTUAL behavior: the compare decodes hex, it does not compare text; stored hashes are lower-case)', () => {
    expect(hashesEqual(h, h.toUpperCase())).toBe(true);
    expect(hashesEqual(h.toUpperCase(), h.toUpperCase())).toBe(true);
    expect(hashesEqual(flipLast(h), h.toUpperCase())).toBe(false);
  });
  it('never throws for any pair of strings and always returns a boolean', () => {
    const odd = [
      '',
      NUL,
      NUL.repeat(64),
      ' '.repeat(64),
      '\n'.repeat(64),
      String.fromCodePoint(0x1f600).repeat(32),
      String.fromCodePoint(0x0660).repeat(64),
      'a'.repeat(10_000),
      h,
      h.toUpperCase(),
      flipLast(h),
      `${h}\n`,
      ` ${h.slice(1)}`,
    ];
    for (const a of odd) {
      for (const b of odd) {
        const result = hashesEqual(a, b);
        expect(typeof result).toBe('boolean');
      }
    }
  });
  it('is symmetric', () => {
    const pool = [h, flipLast(h), flipFirst(h), '', h.slice(0, 63), 'g'.repeat(64), h.toUpperCase()];
    for (const a of pool) for (const b of pool) expect(hashesEqual(a, b)).toBe(hashesEqual(b, a));
  });
  it('compares with node:crypto timingSafeEqual on two 32-byte buffers, also when the hashes differ only in the last character', () => {
    expect(hashesEqual(h, flipLast(h))).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    const [x, y] = timingSafeEqualSpy.mock.calls[0]!;
    expect(x).toHaveLength(32);
    expect(y).toHaveLength(32);
    expect(hashesEqual(h, h)).toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });
  it('rejects a wrong shape without comparing anything (timingSafeEqual would throw on unequal lengths)', () => {
    expect(hashesEqual(h, h.slice(0, 63))).toBe(false);
    expect(hashesEqual(h, 'g'.repeat(64))).toBe(false);
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });
});

// ====================================================================== shapes
describe('isCodeShape', () => {
  it.each(['0000', '048213', '123456', '0123456789', '9999999999'])('accepts the numeric code %s (4 to 10 digits)', (v) => {
    expect(isCodeShape(v)).toBe(true);
  });
  it.each([
    ['3 digits', '123'],
    ['11 digits', '12345678901'],
    ['an empty string', ''],
    ['letters', 'abcdef'],
    ['digits and a letter', '12345a'],
    ['a space inside', '123 456'],
    ['a leading space', ' 123456'],
    ['a trailing space', '123456 '],
    ['a trailing newline', '123456\n'],
    ['a sign', '+12345'],
    ['a decimal point', '123.456'],
    ['Arabic-Indic digits', String.fromCodePoint(0x0660, 0x0661, 0x0662, 0x0663)],
    ['full-width digits', String.fromCodePoint(0xff11, 0xff12, 0xff13, 0xff14)],
  ])('rejects %s', (_label, v) => {
    expect(isCodeShape(v)).toBe(false);
  });
  it.each([
    ['a number', 123456],
    ['null', null],
    ['undefined', undefined],
    ['an array', ['123456']],
    ['an object', { code: '123456' }],
    ['a String object', new String('123456')],
    ['a boolean', true],
  ])('rejects %s (only a primitive string counts)', (_label, v) => {
    expect(isCodeShape(v)).toBe(false);
  });
  it('agrees with the contract regex on every generated code', () => {
    for (let length = 4; length <= 10; length++) {
      const code = generateVerificationCode(length);
      expect(isCodeShape(code)).toBe(EMAIL_CODE_SHAPE.test(code));
      expect(isCodeShape(code)).toBe(true);
    }
  });
});

describe('isTokenShape', () => {
  const token = generateMagicToken();
  it('accepts a generated token and the whole base64url alphabet', () => {
    expect(isTokenShape(token)).toBe(true);
    expect(isTokenShape(`-_${'a'.repeat(41)}`)).toBe(true);
    expect(isTokenShape('A'.repeat(43))).toBe(true);
    expect(isTokenShape('0'.repeat(43))).toBe(true);
  });
  it.each([
    ['42 characters', token.slice(0, 42)],
    ['44 characters', `${token}A`],
    ['an empty string', ''],
    ['a padded token', `${token.slice(0, 42)}=`],
    ['a "+"', `${token.slice(0, 42)}+`],
    ['a "/"', `${token.slice(0, 42)}/`],
    ['a space', `${token.slice(0, 42)} `],
    ['a trailing newline', `${token}\n`],
    ['a leading newline', `\n${token}`],
    ['a non-ASCII letter', `${token.slice(0, 42)}${String.fromCodePoint(0xe9)}`],
    ['a hex digest (64 characters)', hashMagicToken(HASH_KEY, token)],
  ])('rejects %s', (_label, v) => {
    expect(isTokenShape(v)).toBe(false);
  });
  it.each([
    ['a number', 12345],
    ['null', null],
    ['undefined', undefined],
    ['an array', [token]],
    ['an object', { token }],
    ['a String object', new String(token)],
  ])('rejects %s (only a primitive string counts)', (_label, v) => {
    expect(isTokenShape(v)).toBe(false);
  });
});

// ====================================================================== the source of email-crypto.ts
describe('the source of email-crypto.ts', () => {
  const source = readFileSync(fileURLToPath(new URL('./email-crypto.ts', import.meta.url)), 'utf8');
  // comments are removed first: the header comment mentions Math.random on purpose
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('compares secrets with timingSafeEqual', () => {
    expect(code).toMatch(/\btimingSafeEqual\s*\(/);
    expect(code).toMatch(/import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*'node:crypto'/);
  });
  it('draws randomness from node:crypto only: no Math.random, no Date-based or other non-CSPRNG source', () => {
    expect(code).not.toMatch(/Math\s*\.\s*random/);
    expect(code).not.toMatch(/\bDate\s*\.\s*now\b|\bnew Date\b|performance\s*\.\s*now/);
    expect(code).toMatch(/\brandomInt\s*\(/);
    expect(code).toMatch(/\brandomBytes\s*\(/);
    expect(code).not.toMatch(/getRandomValues/);
  });
  it('does not compare hashes or buffers with ===, ==, equals or Buffer.compare', () => {
    expect(code).not.toMatch(/\.equals\s*\(/);
    expect(code).not.toMatch(/Buffer\s*\.\s*compare\s*\(/);
    expect(code).not.toMatch(/\blocaleCompare\b/);
    // the two buffers and the two inputs of hashesEqual are never the operands of an equality operator
    expect(code).not.toMatch(/\b(?:a|b|x|y)\s*[!=]==?\s*(?:a|b|x|y)\b/);
    expect(code).not.toMatch(/digest\s*\([^)]*\)\s*[!=]==?/);
  });
  it('does not log (no console, no logger import)', () => {
    expect(code).not.toMatch(/\bconsole\s*\./);
    expect(code).not.toMatch(/observability/);
  });
});
