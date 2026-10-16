// Unit tests of the consent policy (ID-005): strict parsing of the two configuration values per purpose (a missing or malformed value is an outage of the policy, never a
// default), the key set against the migration that seeds it, and the static provider. No database, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { REACCEPTANCE_MODES, SEEDED_CONSENT_PURPOSES, consentReacceptanceKey, consentRequiredForKey } from '@bananagig/contracts';
import { describe, expect, it } from 'vitest';
import { SEEDED_CONSENT_POLICY, StaticConsentPolicyProvider } from './consent-fakes';
import { CONSENT_REQUIRED_FOR_MAX, assertConsentPolicy, consentPolicyKeys, parseConsentPolicy, parseReacceptance, parseRequiredFor } from './consent-policy';
import { AccountError } from './errors';

const P = 'TERMS_OF_SERVICE';
const K = consentPolicyKeys(P);
const SEEDED = { [K.requiredFor]: ['CUSTOMER', 'PROVIDER'], [K.reacceptance]: 'REACCEPT_REQUIRED' };
const thrown = (fn: () => unknown): AccountError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError);
    return err as AccountError;
  }
  throw new Error('expected the call to throw');
};
const expectInvalid = (fn: () => unknown, field: string): void => {
  const err = thrown(fn);
  expect(err.code).toBe('UNAVAILABLE');
  expect(err.details).toEqual({ reason: 'POLICY_INVALID', purposeCode: P, field });
};

describe('consentPolicyKeys', () => {
  it('uses the contract key helpers', () => {
    expect(K).toEqual({ requiredFor: 'consent.terms_of_service.required_for', reacceptance: 'consent.terms_of_service.reacceptance' });
    expect(K.requiredFor).toBe(consentRequiredForKey(P));
    expect(K.reacceptance).toBe(consentReacceptanceKey(P));
  });
});

describe('parseConsentPolicy', () => {
  it('parses the seeded values', () => {
    expect(parseConsentPolicy(P, SEEDED)).toEqual({ requiredForRoles: ['CUSTOMER', 'PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });
  });
  it.each(REACCEPTANCE_MODES)('accepts the mode %s', (mode) => {
    expect(parseConsentPolicy(P, { ...SEEDED, [K.reacceptance]: mode }).reacceptance).toBe(mode);
  });
  it('accepts an empty role list (nobody is required)', () => {
    expect(parseConsentPolicy(P, { ...SEEDED, [K.requiredFor]: [] }).requiredForRoles).toEqual([]);
  });
  it('returns a copy of the list', () => {
    const list = ['CUSTOMER'];
    const parsed = parseConsentPolicy(P, { ...SEEDED, [K.requiredFor]: list });
    list.push('PROVIDER');
    expect(parsed.requiredForRoles).toEqual(['CUSTOMER']);
  });
  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'CUSTOMER'],
    ['an object', { 0: 'CUSTOMER' }],
    ['a number', 1],
    ['a non-string member', ['CUSTOMER', 1]],
    ['a null member', ['CUSTOMER', null]],
    ['a lower-case role', ['customer']],
    ['a role with a space', ['CUS TOMER']],
    ['an empty role', ['']],
    ['a one-letter role', ['C']],
    ['a role starting with a digit', ['1CUSTOMER']],
    ['a duplicated role', ['CUSTOMER', 'CUSTOMER']],
    ['too many roles', Array.from({ length: CONSENT_REQUIRED_FOR_MAX + 1 }, (_, i) => `ROLE_${String.fromCharCode(65 + i)}`)],
  ])('required_for %s fails closed', (_name, value) => {
    expectInvalid(() => parseConsentPolicy(P, { ...SEEDED, [K.requiredFor]: value }), 'required_for');
  });
  it.each([
    ['missing', undefined],
    ['null', null],
    ['lower case', 'reaccept_required'],
    ['unknown', 'ALWAYS'],
    ['a number', 1],
    ['an array', ['REACCEPT_REQUIRED']],
    ['padded', ' REACCEPT_REQUIRED'],
  ])('reacceptance %s fails closed', (_name, value) => {
    expectInvalid(() => parseConsentPolicy(P, { ...SEEDED, [K.reacceptance]: value }), 'reacceptance');
  });
  it('checks the roles against the known roles when given', () => {
    const known = new Set(['CUSTOMER', 'PROVIDER']);
    expect(parseConsentPolicy(P, SEEDED, known).requiredForRoles).toEqual(['CUSTOMER', 'PROVIDER']);
    expectInvalid(() => parseConsentPolicy(P, { ...SEEDED, [K.requiredFor]: ['CUSTOMER', 'ADMIN'] }, known), 'required_for');
    expectInvalid(() => parseRequiredFor(P, ['ADMINN'], known), 'required_for');
  });
  it('reads only the keys of the purpose', () => {
    const other = consentPolicyKeys('PRIVACY_POLICY');
    expectInvalid(() => parseConsentPolicy(P, { [other.requiredFor]: ['CUSTOMER'], [other.reacceptance]: 'NO_REACCEPT' }), 'required_for');
  });
  it('carries nothing but codes in the error', () => {
    const err = thrown(() => parseConsentPolicy(P, { ...SEEDED, [K.requiredFor]: 'secret-value-123' }));
    expect(inspect(err, { depth: 8 })).not.toContain('secret-value-123');
  });
  it('parseReacceptance rejects non-modes', () => {
    expect(() => parseReacceptance(P, 'NOPE')).toThrow(AccountError);
  });
});

describe('assertConsentPolicy', () => {
  it('validates a provider-built object and returns a copy', () => {
    const value = { requiredForRoles: ['CUSTOMER'], reacceptance: 'NO_REACCEPT' as const };
    const out = assertConsentPolicy(P, value);
    expect(out).toEqual(value);
    expect(out.requiredForRoles).not.toBe(value.requiredForRoles);
  });
  it('rejects malformed objects (also null and undefined)', () => {
    expectInvalid(() => assertConsentPolicy(P, { requiredForRoles: ['x'], reacceptance: 'NO_REACCEPT' }), 'required_for');
    expectInvalid(() => assertConsentPolicy(P, { requiredForRoles: [], reacceptance: 'x' as never }), 'reacceptance');
    expect(() => assertConsentPolicy(P, null as never)).toThrow(AccountError);
    expect(() => assertConsentPolicy(P, undefined as never)).toThrow(AccountError);
  });
});

describe('the seeded values', () => {
  it('match migration 0013 (keys, required roles, default mode)', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../../db/migrations/0013_consent.sql', import.meta.url)), 'utf8');
    for (const code of SEEDED_CONSENT_PURPOSES) {
      const keys = consentPolicyKeys(code);
      expect(sql).toContain(`'${keys.requiredFor}'`);
      expect(sql).toContain(`'${keys.reacceptance}'`);
    }
    expect(SEEDED_CONSENT_POLICY).toEqual({ requiredForRoles: ['CUSTOMER', 'PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });
    expect(sql).toContain(`'["CUSTOMER", "PROVIDER"]'::jsonb`);
    expect(sql).toContain(`'"REACCEPT_REQUIRED"'::jsonb`);
  });
});

describe('StaticConsentPolicyProvider', () => {
  it('serves the seeded policy for the seeded purposes and counts reads', async () => {
    const p = new StaticConsentPolicyProvider();
    expect(await p.policy('TERMS_OF_SERVICE')).toEqual(SEEDED_CONSENT_POLICY);
    expect(await p.policy('PRIVACY_POLICY')).toEqual(SEEDED_CONSENT_POLICY);
    expect(p.reads).toBe(2);
    expect(p.readPurposes).toEqual(['TERMS_OF_SERVICE', 'PRIVACY_POLICY']);
  });
  it('replaces and unsets values; an unset purpose reads as an invalid policy', async () => {
    const p = new StaticConsentPolicyProvider();
    p.set('TERMS_OF_SERVICE', { requiredForRoles: ['PROVIDER'], reacceptance: 'NO_REACCEPT' });
    expect(await p.policy('TERMS_OF_SERVICE')).toEqual({ requiredForRoles: ['PROVIDER'], reacceptance: 'NO_REACCEPT' });
    p.unset('TERMS_OF_SERVICE');
    await expect(p.policy('TERMS_OF_SERVICE')).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
  });
  it('injects a failure and does not hand out its internal list', async () => {
    const p = new StaticConsentPolicyProvider();
    const err = new Error('configuration down');
    p.failure = err;
    await expect(p.policy('TERMS_OF_SERVICE')).rejects.toBe(err);
    p.failure = undefined;
    const a = await p.policy('TERMS_OF_SERVICE');
    (a.requiredForRoles as string[]).push('X');
    expect((await p.policy('TERMS_OF_SERVICE')).requiredForRoles).toEqual(['CUSTOMER', 'PROVIDER']);
  });
  it('can start empty', async () => {
    await expect(new StaticConsentPolicyProvider({}).policy('TERMS_OF_SERVICE')).rejects.toBeInstanceOf(AccountError);
  });
});
