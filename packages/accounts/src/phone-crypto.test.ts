// Unit tests of the phone-specific hash domain (ID-003): the SMS code is stored only as a keyed hash bound to its challenge, in a hash space of its own that is
// separate from the email code hash and from every rate-limit dimension. Known answers are computed independently of this code base. No database, no network.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashDimension, hashVerificationCode } from './email-crypto';
import { hashPhoneCode } from './phone-crypto';
import { hmacHex } from './verification-crypto';

const NUL = String.fromCharCode(0);
const HASH_KEY = Buffer.alloc(32, 7).toString('hex');
const OTHER_HASH_KEY = Buffer.alloc(32, 9).toString('hex');
const CHALLENGE_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_CHALLENGE_ID = '9d2b7c64-1f0a-4e55-8c3b-6a1d2e4f5b70';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

describe('hashPhoneCode', () => {
  it('is the pinned known answer (computed independently with an HMAC-SHA-256 implementation outside this code base)', () => {
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213')).toBe('c4a3beea8eff7dcc7529af96910b0a3b642539f43741ae2f8641ea56d60ca8a6');
    expect(hashPhoneCode(OTHER_HASH_KEY, CHALLENGE_ID, '048213')).toBe('ac9e96263965f40d651c202945f80bdd9ac5c226ca1027d295380620e6e2f6ec');
    expect(hashPhoneCode(HASH_KEY, OTHER_CHALLENGE_ID, '048213')).toBe('9361e686f430523197c38b4da985c73118305850951d7a7955924088d37f8e5e');
  });
  it('is HMAC-SHA-256 over the domain bananagig:phone-code:v1, a NUL and the length-prefixed challenge id and code', () => {
    const text = `bananagig:phone-code:v1${NUL}${CHALLENGE_ID.length}:${CHALLENGE_ID}${NUL}6:048213`;
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213')).toBe(createHmac('sha256', HASH_KEY).update(text).digest('hex'));
  });
  it('is the shared hmacHex under the phone domain', () => {
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213')).toBe(hmacHex(HASH_KEY, 'bananagig:phone-code:v1', CHALLENGE_ID, '048213'));
  });
  it('returns 64 lower-case hex characters', () => {
    for (const code of ['0000', '048213', '123456', '0123456789']) expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, code)).toMatch(HEX64);
  });
  it('is deterministic', () => {
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213')).toBe(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213'));
  });
  it('is bound to the challenge id: the same code under another challenge hashes differently', () => {
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213')).not.toBe(hashPhoneCode(HASH_KEY, OTHER_CHALLENGE_ID, '048213'));
  });
  it('is bound to the code', () => {
    const base = hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213');
    for (const code of ['048214', '148213', '48213', '0482130', '', '000000', ' 048213', '048213 '])
      expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, code)).not.toBe(base);
  });
  it('is bound to the server key', () => {
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213')).not.toBe(hashPhoneCode(OTHER_HASH_KEY, CHALLENGE_ID, '048213'));
  });
  it('does not allow a code to move into the challenge id (injective encoding)', () => {
    expect(hashPhoneCode(HASH_KEY, 'ab', 'c')).not.toBe(hashPhoneCode(HASH_KEY, 'a', 'bc'));
    expect(hashPhoneCode(HASH_KEY, `a${NUL}b`, 'c')).not.toBe(hashPhoneCode(HASH_KEY, 'a', `b${NUL}c`));
  });
  it('never contains the plaintext code', () => {
    for (const code of ['048213', '123456', '000000', '987654']) expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, code)).not.toContain(code);
  });
  it('does not contain the challenge id or the key', () => {
    const h = hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213');
    expect(h).not.toContain(CHALLENGE_ID);
    expect(h).not.toContain(HASH_KEY);
  });
  it('distinct codes of one challenge give distinct hashes (all 6-digit codes with the same prefix)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(hashPhoneCode(HASH_KEY, CHALLENGE_ID, String(i).padStart(6, '0')));
    expect(seen.size).toBe(1000);
  });
});

describe('domain separation between the phone and the email code hash', () => {
  it('differs from the email code hash for the same (secret, challenge id, code)', () => {
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213')).not.toBe(hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213'));
  });
  it.each(['000000', '048213', '123456', '999999', '0000', '0123456789'])('differs from the email code hash for the code %s', (code) => {
    expect(hashPhoneCode(HASH_KEY, CHALLENGE_ID, code)).not.toBe(hashVerificationCode(HASH_KEY, CHALLENGE_ID, code));
  });
  it('differs for every key and challenge combination', () => {
    for (const key of [HASH_KEY, OTHER_HASH_KEY]) {
      for (const id of [CHALLENGE_ID, OTHER_CHALLENGE_ID]) {
        expect(hashPhoneCode(key, id, '048213')).not.toBe(hashVerificationCode(key, id, '048213'));
      }
    }
  });
  it('a hash copied from an email challenge never equals the phone hash of the same challenge id', () => {
    const emailHash = hashVerificationCode(HASH_KEY, CHALLENGE_ID, '048213');
    expect(emailHash).not.toBe(hashPhoneCode(HASH_KEY, CHALLENGE_ID, '048213'));
  });
});

describe("hashDimension('phone', value)", () => {
  const value = '+12025550142';
  it('is the pinned known answer (domain bananagig:rate-dimension:v1, first 32 hex characters)', () => {
    expect(hashDimension(HASH_KEY, 'phone', value)).toBe('dc6b612a3308f93f78ff328cf4295a17');
  });
  it('is the first 32 hex characters of the shared hash under the rate-dimension domain', () => {
    expect(hashDimension(HASH_KEY, 'phone', value)).toBe(hmacHex(HASH_KEY, 'bananagig:rate-dimension:v1', 'phone', value).slice(0, 32));
    expect(hashDimension(HASH_KEY, 'phone', value)).toMatch(HEX32);
  });
  it.each(['email', 'ip', 'device'] as const)('differs from the %s dimension for the same value', (other) => {
    expect(hashDimension(HASH_KEY, 'phone', value)).not.toBe(hashDimension(HASH_KEY, other, value));
  });
  it('differs from the other three dimensions for several values', () => {
    for (const v of ['x', '+442079460958', '203.0.113.77', 'ana@example.test', '']) {
      const all = (['phone', 'email', 'ip', 'device'] as const).map((d) => hashDimension(HASH_KEY, d, v));
      expect(new Set(all).size).toBe(4);
    }
  });
  it('depends on the number and on the key', () => {
    expect(hashDimension(HASH_KEY, 'phone', '+12025550142')).not.toBe(hashDimension(HASH_KEY, 'phone', '+12025550143'));
    expect(hashDimension(HASH_KEY, 'phone', value)).not.toBe(hashDimension(OTHER_HASH_KEY, 'phone', value));
  });
  it('does not contain the number', () => {
    const h = hashDimension(HASH_KEY, 'phone', value);
    expect(h).not.toContain('2025550142');
    expect(h).not.toContain(value);
  });
  it('is not the phone code hash space (a counter key can never equal a code hash prefix)', () => {
    expect(hashDimension(HASH_KEY, 'phone', value)).not.toBe(hashPhoneCode(HASH_KEY, CHALLENGE_ID, value).slice(0, 32));
  });
});
