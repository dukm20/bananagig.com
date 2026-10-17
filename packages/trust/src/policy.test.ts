// Unit tests of the evidence policy parser (TRUST-001): typed configuration values in, a validated policy out, and a fail-closed UNAVAILABLE for anything missing or invalid.
import { TRUST_DOCUMENT_SIZE_CEILING, TRUST_POLICY_KEYS } from '@bananagig/contracts';
import { describe, expect, it } from 'vitest';
import { TrustError } from './errors';
import { StaticTrustPolicyProvider, parseTrustPolicy, trustPolicyKeys } from './policy';

const K = TRUST_POLICY_KEYS;
const VALID = {
  [K.maxSizeBytes]: 10_485_760,
  [K.allowedMimeTypes]: ['application/pdf', 'image/jpeg', 'image/png'],
  [K.maxDocumentsPerRequirement]: 5,
  [K.uploadUrlTtlSeconds]: 600,
  [K.downloadUrlTtlSeconds]: 120,
  [K.requireCleanScan]: true,
};
const with_ = (over: Record<string, unknown>): Record<string, unknown> => ({ ...VALID, ...over });
const without = (key: string): Record<string, unknown> => {
  const { [key]: _drop, ...rest } = VALID as Record<string, unknown>;
  return rest;
};
const failure = (values: Record<string, unknown>): TrustError => {
  try {
    parseTrustPolicy(values);
  } catch (e) {
    expect(e).toBeInstanceOf(TrustError);
    return e as TrustError;
  }
  throw new Error('expected parseTrustPolicy to throw');
};

describe('trustPolicyKeys', () => {
  it('lists the six configuration keys, all under trust.', () => {
    const keys = trustPolicyKeys();
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    for (const k of keys) expect(k.startsWith('trust.')).toBe(true);
    expect(keys.sort()).toEqual(Object.values(K).sort());
  });
});

describe('parseTrustPolicy', () => {
  it('maps every configuration key to its policy field', () => {
    expect(parseTrustPolicy(VALID)).toEqual({
      maxSizeBytes: 10_485_760,
      allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
      maxDocumentsPerRequirement: 5,
      uploadUrlTtlSeconds: 600,
      downloadUrlTtlSeconds: 120,
      requireCleanScan: true,
    });
  });
  it('keeps false for requireCleanScan (it is not defaulted to true)', () => {
    expect(parseTrustPolicy(with_({ [K.requireCleanScan]: false })).requireCleanScan).toBe(false);
  });
  it('ignores configuration keys that are not trust policy keys', () => {
    expect(parseTrustPolicy(with_({ 'other.key': 1, unrelated: 'x' }))).not.toHaveProperty('other.key');
  });

  describe('fails closed with UNAVAILABLE / POLICY_INVALID when a value is missing', () => {
    it.each(Object.values(K))('missing %s', (key) => {
      const e = failure(without(key));
      expect(e.code).toBe('UNAVAILABLE');
      expect(e.details).toEqual({ reason: 'POLICY_INVALID' });
      expect(e.message).toBe('the verification policy is not available');
    });
    it('an empty object', () => {
      expect(failure({}).code).toBe('UNAVAILABLE');
    });
    it('null and undefined values', () => {
      for (const key of Object.values(K)) {
        expect(failure(with_({ [key]: null })).code, `${key} null`).toBe('UNAVAILABLE');
        expect(failure(with_({ [key]: undefined })).code, `${key} undefined`).toBe('UNAVAILABLE');
      }
    });
  });

  describe('fails closed on a value of the wrong type (no coercion)', () => {
    it.each([
      [K.maxSizeBytes, '10485760'],
      [K.maxSizeBytes, 1024.5],
      [K.maxDocumentsPerRequirement, '5'],
      [K.uploadUrlTtlSeconds, '600'],
      [K.downloadUrlTtlSeconds, 15.5],
      [K.requireCleanScan, 'true'],
      [K.requireCleanScan, 1],
      [K.requireCleanScan, 0],
      [K.allowedMimeTypes, 'application/pdf'],
      [K.allowedMimeTypes, [1, 2]],
      [K.allowedMimeTypes, { 0: 'application/pdf' }],
    ])('%s = %j', (key, value) => {
      expect(failure(with_({ [key]: value })).details).toEqual({ reason: 'POLICY_INVALID' });
    });
    it('NaN and Infinity', () => {
      expect(failure(with_({ [K.maxSizeBytes]: Number.NaN })).code).toBe('UNAVAILABLE');
      expect(failure(with_({ [K.maxSizeBytes]: Number.POSITIVE_INFINITY })).code).toBe('UNAVAILABLE');
    });
  });

  describe('boundaries', () => {
    const ok = (key: string, value: unknown) => expect(() => parseTrustPolicy(with_({ [key]: value })), `${key}=${JSON.stringify(value)}`).not.toThrow();
    const bad = (key: string, value: unknown) => expect(failure(with_({ [key]: value })).code, `${key}=${JSON.stringify(value)}`).toBe('UNAVAILABLE');

    it('maxSizeBytes: 1024 .. the structural ceiling', () => {
      expect(TRUST_DOCUMENT_SIZE_CEILING).toBe(52_428_800);
      ok(K.maxSizeBytes, 1024);
      ok(K.maxSizeBytes, TRUST_DOCUMENT_SIZE_CEILING);
      bad(K.maxSizeBytes, 1023);
      bad(K.maxSizeBytes, TRUST_DOCUMENT_SIZE_CEILING + 1);
      bad(K.maxSizeBytes, 0);
      bad(K.maxSizeBytes, -1);
    });
    it('maxDocumentsPerRequirement: 1 .. 20', () => {
      ok(K.maxDocumentsPerRequirement, 1);
      ok(K.maxDocumentsPerRequirement, 20);
      bad(K.maxDocumentsPerRequirement, 0);
      bad(K.maxDocumentsPerRequirement, 21);
    });
    it('uploadUrlTtlSeconds: 60 .. 3600', () => {
      ok(K.uploadUrlTtlSeconds, 60);
      ok(K.uploadUrlTtlSeconds, 3600);
      bad(K.uploadUrlTtlSeconds, 59);
      bad(K.uploadUrlTtlSeconds, 3601);
    });
    it('downloadUrlTtlSeconds: 15 .. 900', () => {
      ok(K.downloadUrlTtlSeconds, 15);
      ok(K.downloadUrlTtlSeconds, 900);
      bad(K.downloadUrlTtlSeconds, 14);
      bad(K.downloadUrlTtlSeconds, 901);
    });
    it('allowedMimeTypes: 1 .. 10 entries', () => {
      const n = (count: number) => Array.from({ length: count }, (_, i) => `application/x-t${i}`);
      ok(K.allowedMimeTypes, n(1));
      ok(K.allowedMimeTypes, n(10));
      bad(K.allowedMimeTypes, []);
      bad(K.allowedMimeTypes, n(11));
    });
    it('allowedMimeTypes: duplicates are refused', () => {
      bad(K.allowedMimeTypes, ['application/pdf', 'application/pdf']);
    });
    it.each([
      'PDF',
      'application',
      'application/',
      '/pdf',
      'Application/pdf',
      'application/PDF',
      'application/pdf; charset=x',
      ' application/pdf',
      'application/pdf ',
      '',
      'a/b/c',
      'image/png\n',
    ])('allowedMimeTypes: refuses the malformed type %j', (m) => {
      bad(K.allowedMimeTypes, ['image/jpeg', m]);
    });
    it('allowedMimeTypes: a type longer than 100 characters is refused', () => {
      ok(K.allowedMimeTypes, [`application/${'a'.repeat(100 - 'application/'.length)}`]);
      bad(K.allowedMimeTypes, [`application/${'a'.repeat(101 - 'application/'.length)}`]);
    });
    it('allowedMimeTypes: accepts dots, plus and hyphen in the subtype', () => {
      ok(K.allowedMimeTypes, ['application/vnd.api+json', 'image/svg+xml', 'application/x-tar']);
    });
  });

  it('does not leak the offending value into the error', () => {
    const e = failure(with_({ [K.maxSizeBytes]: 'super-secret-sentinel' }));
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain('super-secret-sentinel');
  });
});

describe('StaticTrustPolicyProvider', () => {
  it('returns the policy it was given', async () => {
    const policy = parseTrustPolicy(VALID);
    expect(await new StaticTrustPolicyProvider(policy).documents()).toBe(policy);
  });
});
