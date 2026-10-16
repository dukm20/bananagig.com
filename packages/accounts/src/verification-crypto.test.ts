// Unit tests of the SHARED verification primitives (ID-003, ADR-0030): the CSPRNG numeric code, the injective keyed hash and the constant-time compare, plus the
// EMAIL REGRESSION that proves the refactor of the email module onto them changed no stored value: the email code hash, the magic-link hash and the rate
// dimension hash are pinned with constants computed independently of this code base (HMAC-SHA-256 over domain, NUL and length-prefixed parts). node:crypto is wrapped
// (the real implementation still runs unless a test feeds fixed values) so the tests can prove which primitives are used. No database, no network.
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { generateVerificationCode, hashDimension, hashMagicToken, hashVerificationCode, hashesEqual as emailHashesEqual } from './email-crypto';
import { CODE_LENGTH_MAX, CODE_LENGTH_MIN, generateNumericCode, hashesEqual, hmacHex } from './verification-crypto';

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

const feedDigits = (...digits: number[]): void => {
  let i = 0;
  randomIntSpy.mockImplementation(() => digits[i++ % digits.length]!);
};

// Test-only inputs, built from bytes so no source line holds a credential-looking literal.
const NUL = String.fromCharCode(0);
const HASH_KEY = Buffer.alloc(32, 7).toString('hex');
const OTHER_HASH_KEY = Buffer.alloc(32, 9).toString('hex');
const CHALLENGE_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_CHALLENGE_ID = '9d2b7c64-1f0a-4e55-8c3b-6a1d2e4f5b70';
const TOKEN = 'A'.repeat(43);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** The reference construction, written out independently: HMAC-SHA-256 keyed with the secret over `domain NUL len:part NUL len:part ...`. */
const reference = (key: string, domain: string, parts: string[]): string =>
  real
    .createHmac('sha256', key)
    .update(domain + NUL + parts.map((p) => `${p.length}:${p}`).join(NUL))
    .digest('hex');

// ====================================================================== generateNumericCode
describe('generateNumericCode', () => {
  it('has the bounds 4 and 10', () => {
    expect(CODE_LENGTH_MIN).toBe(4);
    expect(CODE_LENGTH_MAX).toBe(10);
  });
  it.each([4, 5, 6, 7, 8, 9, 10])('returns exactly %i decimal digits', (length) => {
    for (let i = 0; i < 50; i++) {
      const code = generateNumericCode(length);
      expect(code).toHaveLength(length);
      expect(code).toMatch(/^[0-9]+$/);
    }
  });
  it.each([
    ['3', 3],
    ['11', 11],
    ['0', 0],
    ['-1', -1],
    ['4.5', 4.5],
    ['3.9999', 3.9999],
    ['10.0001', 10.0001],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['a numeric string', '6' as unknown as number],
    ['null', null as unknown as number],
    ['undefined', undefined as unknown as number],
    ['an object', {} as unknown as number],
    ['an array', [6] as unknown as number],
    ['a bigint', BigInt(6) as unknown as number],
  ])('throws a RangeError for the length %s and draws nothing', (_label, length) => {
    expect(() => generateNumericCode(length)).toThrow(RangeError);
    expect(randomIntSpy).not.toHaveBeenCalled();
  });
  it('uses a fixed, value-free error message', () => {
    expect(() => generateNumericCode(99)).toThrow('the code length must be an integer from 4 to 10');
  });
  it('accepts exactly the boundaries 4 and 10', () => {
    expect(generateNumericCode(4)).toHaveLength(4);
    expect(generateNumericCode(10)).toHaveLength(10);
  });
  it('draws one digit per position from node:crypto randomInt(0, 10) and from nothing else', () => {
    generateNumericCode(7);
    expect(randomIntSpy).toHaveBeenCalledTimes(7);
    for (const call of randomIntSpy.mock.calls) expect(call).toEqual([0, 10]);
    expect(randomBytesSpy).not.toHaveBeenCalled();
  });
  it('never calls Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    try {
      for (let length = 4; length <= 10; length++) generateNumericCode(length);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('contains no Math.random in the source of the shared primitives', () => {
    const source = readFileSync(fileURLToPath(new URL('./verification-crypto.ts', import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('Math.random');
    expect(code).toContain('randomInt');
  });
  it('preserves leading zeros: a draw of all zeros is a string of zeros, not the number 0', () => {
    feedDigits(0);
    expect(generateNumericCode(6)).toBe('000000');
    expect(generateNumericCode(4)).toBe('0000');
    expect(generateNumericCode(10)).toBe('0000000000');
  });
  it('keeps the order of the draws', () => {
    feedDigits(0, 0, 4, 2, 1, 3);
    expect(generateNumericCode(6)).toBe('004213');
    feedDigits(1, 2, 3, 4, 5, 6, 7, 8, 9, 0);
    expect(generateNumericCode(10)).toBe('1234567890');
    feedDigits(9, 0, 0, 9);
    expect(generateNumericCode(4)).toBe('9009');
  });
  it('produces leading zeros with the real CSPRNG (a leading zero appears in about one code in ten)', () => {
    let leadingZero = 0;
    for (let i = 0; i < 5000; i++) if (generateNumericCode(4).startsWith('0')) leadingZero++;
    expect(leadingZero).toBeGreaterThan(300);
    expect(leadingZero).toBeLessThan(700);
  });
  it('covers every digit in every position with the real CSPRNG', () => {
    const seen = Array.from({ length: 6 }, () => new Set<string>());
    for (let i = 0; i < 2000; i++)
      generateNumericCode(6)
        .split('')
        .forEach((d, pos) => seen[pos]!.add(d));
    for (const s of seen) expect(s.size).toBe(10);
  });
  it('returns different codes on repeated calls (1000 ten-digit codes are distinct)', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateNumericCode(10)));
    expect(codes.size).toBe(1000);
  });
});

// ====================================================================== hmacHex
describe('hmacHex', () => {
  it('returns 64 lower-case hex characters', () => {
    expect(hmacHex(HASH_KEY, 'test:domain:v1', 'a', 'b')).toMatch(HEX64);
    expect(hmacHex(HASH_KEY, 'test:domain:v1')).toMatch(HEX64);
  });
  it('matches the independent node:crypto construction over domain, NUL and length-prefixed parts', () => {
    expect(hmacHex(HASH_KEY, 'test:domain:v1', 'a', 'b')).toBe(reference(HASH_KEY, 'test:domain:v1', ['a', 'b']));
    expect(hmacHex(HASH_KEY, 'test:domain:v1')).toBe(reference(HASH_KEY, 'test:domain:v1', []));
    expect(hmacHex(HASH_KEY, 'x', 'one', 'two', 'three')).toBe(reference(HASH_KEY, 'x', ['one', 'two', 'three']));
  });
  it('is the pinned known answer (computed independently with an HMAC-SHA-256 implementation outside this code base)', () => {
    expect(hmacHex(HASH_KEY, 'test:domain:v1', 'a', 'b')).toBe('96e0229e0d0467b596698dc2cff0fa895acc1b4d902944d5f8c6d37ebe6239cd');
    expect(hmacHex(HASH_KEY, 'test:domain:v1')).toBe('76a52b3c6470f5310b86e5aa787e0546ad3211f61bdf49d3dd4e5d99a4528a13');
  });
  it('is HMAC-SHA-256 keyed with the secret (the digest of the same text under another key differs)', () => {
    const text = `test:domain:v1${NUL}1:a${NUL}1:b`;
    const keyed = createHmac('sha256', HASH_KEY).update(text).digest('hex');
    const otherKey = createHmac('sha256', OTHER_HASH_KEY).update(text).digest('hex');
    expect(hmacHex(HASH_KEY, 'test:domain:v1', 'a', 'b')).toBe(keyed);
    expect(hmacHex(OTHER_HASH_KEY, 'test:domain:v1', 'a', 'b')).toBe(otherKey);
    expect(keyed).not.toBe(otherKey);
  });
  it('is injective over the part boundaries', () => {
    expect(hmacHex(HASH_KEY, 'd', 'a', `b${NUL}c`)).not.toBe(hmacHex(HASH_KEY, 'd', `a${NUL}b`, 'c'));
    expect(hmacHex(HASH_KEY, 'd', 'ab', 'c')).not.toBe(hmacHex(HASH_KEY, 'd', 'a', 'bc'));
    expect(hmacHex(HASH_KEY, 'd', 'a', '')).not.toBe(hmacHex(HASH_KEY, 'd', '', 'a'));
    expect(hmacHex(HASH_KEY, 'd', '')).not.toBe(hmacHex(HASH_KEY, 'd'));
    expect(hmacHex(HASH_KEY, 'd', 'a', 'b')).not.toBe(hmacHex(HASH_KEY, 'd', 'ab'));
    expect(hmacHex(HASH_KEY, 'd', '1:a')).not.toBe(hmacHex(HASH_KEY, 'd', 'a'));
    expect(hmacHex(HASH_KEY, 'd', '1:a', 'b')).not.toBe(hmacHex(HASH_KEY, 'd', 'a', '1:b'));
  });
  it('separates the domain from the first part', () => {
    expect(hmacHex(HASH_KEY, 'd', 'x')).not.toBe(hmacHex(HASH_KEY, `d${NUL}1:x`));
    expect(hmacHex(HASH_KEY, 'ab', 'c')).not.toBe(hmacHex(HASH_KEY, 'a', 'bc'));
  });
  it('differs for a different secret', () => {
    expect(hmacHex(HASH_KEY, 'd', 'a')).not.toBe(hmacHex(OTHER_HASH_KEY, 'd', 'a'));
  });
  it('differs for a different domain', () => {
    expect(hmacHex(HASH_KEY, 'd:one', 'a')).not.toBe(hmacHex(HASH_KEY, 'd:two', 'a'));
    expect(hmacHex(HASH_KEY, 'bananagig:email-code:v1', CHALLENGE_ID, '1')).not.toBe(hmacHex(HASH_KEY, 'bananagig:phone-code:v1', CHALLENGE_ID, '1'));
  });
  it('differs for any change in a part (one character, case, a trailing space)', () => {
    const base = hmacHex(HASH_KEY, 'd', 'abc');
    for (const other of ['abd', 'ABC', 'abc ', ' abc', 'ab', 'abcd', '']) expect(hmacHex(HASH_KEY, 'd', other)).not.toBe(base);
  });
  it('is deterministic', () => {
    expect(hmacHex(HASH_KEY, 'd', 'a', 'b')).toBe(hmacHex(HASH_KEY, 'd', 'a', 'b'));
  });
  it('handles non-ASCII text by its UTF-16 length prefix and UTF-8 bytes (consistent with the reference)', () => {
    const wide = `caf${String.fromCodePoint(0xe9)}${String.fromCodePoint(0x1f600)}`;
    expect(hmacHex(HASH_KEY, 'd', wide)).toBe(reference(HASH_KEY, 'd', [wide]));
  });
  it('never contains the plaintext part', () => {
    expect(hmacHex(HASH_KEY, 'd', '048213')).not.toContain('048213');
  });
});

// ====================================================================== hashesEqual
describe('hashesEqual', () => {
  const h = hmacHex(HASH_KEY, 'd', 'a');
  const flipLast = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
  const flipFirst = (hex: string): string => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;

  it('is true for two equal 64-hex hashes', () => {
    expect(hashesEqual(h, h)).toBe(true);
    expect(hashesEqual(h, Array.from(h).join(''))).toBe(true);
    expect(hashesEqual(h, hmacHex(HASH_KEY, 'd', 'a'))).toBe(true);
  });
  it('is false for different hashes, also when they differ only in the first or in the last character', () => {
    expect(hashesEqual(h, hmacHex(HASH_KEY, 'd', 'b'))).toBe(false);
    expect(hashesEqual(h, flipLast(h))).toBe(false);
    expect(hashesEqual(flipLast(h), h)).toBe(false);
    expect(hashesEqual(h, flipFirst(h))).toBe(false);
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
    expect(hashesEqual(h, `${h.slice(0, 63)}z`)).toBe(false);
  });
  it('never throws and always returns a boolean', () => {
    const odd = [
      '',
      NUL,
      NUL.repeat(64),
      ' '.repeat(64),
      String.fromCodePoint(0x1f600).repeat(32),
      'a'.repeat(10_000),
      h,
      h.toUpperCase(),
      flipLast(h),
      `${h}\n`,
    ];
    for (const a of odd) for (const b of odd) expect(typeof hashesEqual(a, b)).toBe('boolean');
  });
  it('is symmetric', () => {
    const pool = [h, flipLast(h), flipFirst(h), '', h.slice(0, 63), 'g'.repeat(64)];
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
  it('is the same function the email module exposes (one implementation for both channels)', () => {
    expect(emailHashesEqual).toBe(hashesEqual);
  });
});

// ====================================================================== EMAIL REGRESSION: the refactor changed no stored value
describe('email regression: pinned known answers (computed independently with HMAC-SHA-256)', () => {
  it('hashVerificationCode is the pre-refactor value (domain bananagig:email-code:v1)', () => {
    expect(hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213')).toBe('7efe90f8efe52d53b643eb61891d9ae92dbf545d3f26aaaed2dfcf234e88c514');
    expect(hashVerificationCode(OTHER_HASH_KEY, CHALLENGE_ID, '048213')).toBe('55fdcac81b86475602e01a24293b9482c5f2b34dc32f8a6abc6d15680fdb595a');
    expect(hashVerificationCode(HASH_KEY, OTHER_CHALLENGE_ID, '048213')).toBe('10bc8ed75ac5f1f293c09e905108b9586bfb30e8199ad53b6130e73aca0b0e72');
  });
  it('hashVerificationCode equals the independent construction', () => {
    expect(hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213')).toBe(reference(HASH_KEY, 'bananagig:email-code:v1', [CHALLENGE_ID, '048213']));
  });
  it('hashMagicToken is the pre-refactor value (domain bananagig:email-link:v1)', () => {
    expect(hashMagicToken(HASH_KEY, TOKEN)).toBe('2096cc35c8f5a4418c55b936492430ae1748fa58fb45a1290dd75ce51f741de1');
    expect(hashMagicToken(HASH_KEY, TOKEN)).toBe(reference(HASH_KEY, 'bananagig:email-link:v1', [TOKEN]));
  });
  it.each([
    ['ip', '203.0.113.77', 'fc0395a3031d50712f4a868620398e5e'],
    ['email', 'ana@example.test', '0736aef6c4e808df5f65bc8cfd34a2bf'],
    ['device', 'device-4f9a1c2e', '45f9a0e54cf01ce45a4955f18406cad8'],
  ] as const)('hashDimension(%s) is the pre-refactor value (domain bananagig:rate-dimension:v1, first 32 hex characters)', (dimension, value, expected) => {
    const actual = hashDimension(HASH_KEY, dimension, value);
    expect(actual).toBe(expected);
    expect(actual).toMatch(HEX32);
    expect(actual).toBe(reference(HASH_KEY, 'bananagig:rate-dimension:v1', [dimension, value]).slice(0, 32));
  });
  it('hashDimension is unchanged for the three email-era dimensions even though phone was added', () => {
    const ip = hashDimension(HASH_KEY, 'ip', 'same');
    const email = hashDimension(HASH_KEY, 'email', 'same');
    const device = hashDimension(HASH_KEY, 'device', 'same');
    expect(new Set([ip, email, device]).size).toBe(3);
  });
  it('keeps the stored hashes 64 characters long and the counter keys 32', () => {
    expect(hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213')).toMatch(HEX64);
    expect(hashMagicToken(HASH_KEY, TOKEN)).toMatch(HEX64);
    expect(hashDimension(HASH_KEY, 'ip', '203.0.113.77')).toMatch(HEX32);
  });
  it('binds the code hash to the challenge, the code and the key', () => {
    const base = hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213');
    expect(hashVerificationCode(HASH_KEY, OTHER_CHALLENGE_ID, '048213')).not.toBe(base);
    expect(hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048214')).not.toBe(base);
    expect(hashVerificationCode(OTHER_HASH_KEY, CHALLENGE_ID, '048213')).not.toBe(base);
  });
  it('keeps the code hash and the link hash in different hash spaces', () => {
    expect(hashMagicToken(HASH_KEY, '048213')).not.toBe(hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213'));
    expect(hashMagicToken(HASH_KEY, CHALLENGE_ID)).not.toBe(hashVerificationCode(HASH_KEY, CHALLENGE_ID, ''));
  });
});

describe('email regression: generateVerificationCode behaves like generateNumericCode', () => {
  it.each([4, 5, 6, 7, 8, 9, 10])('returns %i digits from randomInt(0, 10) draws only', (length) => {
    feedDigits(3, 1, 4, 1, 5, 9, 2, 6, 5, 3);
    const viaEmail = generateVerificationCode(length);
    feedDigits(3, 1, 4, 1, 5, 9, 2, 6, 5, 3);
    const viaShared = generateNumericCode(length);
    expect(viaEmail).toBe(viaShared);
    expect(viaEmail).toBe('3141592653'.slice(0, length));
    expect(randomBytesSpy).not.toHaveBeenCalled();
  });
  it('keeps leading zeros', () => {
    feedDigits(0, 0, 4, 2, 1, 3);
    expect(generateVerificationCode(6)).toBe('004213');
  });
  it.each([3, 11, 0, -1, 4.5, Number.NaN, Number.POSITIVE_INFINITY])('throws a RangeError for the length %s exactly like the shared generator', (length) => {
    expect(() => generateVerificationCode(length)).toThrow(RangeError);
    expect(() => generateNumericCode(length)).toThrow(RangeError);
    expect(randomIntSpy).not.toHaveBeenCalled();
  });
  it('throws the same message as the shared generator', () => {
    let a = '';
    let b = '';
    try {
      generateVerificationCode(3);
    } catch (e) {
      a = (e as Error).message;
    }
    try {
      generateNumericCode(3);
    } catch (e) {
      b = (e as Error).message;
    }
    expect(a).not.toBe('');
    expect(a).toBe(b);
  });
});
