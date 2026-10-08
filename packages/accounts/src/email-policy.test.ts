// Unit tests of the email verification policy (ID-002): the parsing of the eight configuration-driven limits (a missing or malformed value is an outage of
// the policy, never a default) and the verified-social rule decideIdpEmail (an address an identity provider reports is VERIFIED only for a trusted
// provider with the boolean email_verified === true). No database, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { canonicalizeEmail } from '@bananagig/contracts';
import { AccountError } from './errors';
import {
  EMAIL_POLICY_KEYS,
  EMAIL_POLICY_PARAMETER_KEYS,
  decideIdpEmail,
  parseEmailVerificationPolicy,
  type EmailPolicyField,
  type EmailVerificationPolicy,
  type IdpEmailAssertion,
} from './email-policy';

const FIELDS = Object.keys(EMAIL_POLICY_KEYS) as EmailPolicyField[];
const exposed = (err: unknown): string => inspect(err, { depth: 8, showHidden: false });

// ====================================================================== parseEmailVerificationPolicy
/** The values the migration seeds (PRD SV-03.01 and CU-03.06), keyed by the configuration parameter key. */
const SEEDED: Record<string, unknown> = {
  [EMAIL_POLICY_KEYS.codeLength]: 6,
  [EMAIL_POLICY_KEYS.validityMinutes]: 10,
  [EMAIL_POLICY_KEYS.resendSeconds]: 30,
  [EMAIL_POLICY_KEYS.maxPerHour]: 5,
  [EMAIL_POLICY_KEYS.maxPerDay]: 10,
  [EMAIL_POLICY_KEYS.maxAttempts]: 5,
  [EMAIL_POLICY_KEYS.requestsPerHour]: 30,
  [EMAIL_POLICY_KEYS.addressPerHour]: 5,
};
const SEEDED_POLICY: EmailVerificationPolicy = {
  codeLength: 6,
  validityMinutes: 10,
  resendSeconds: 30,
  maxPerHour: 5,
  maxPerDay: 10,
  maxAttempts: 5,
  requestsPerHour: 30,
  addressPerHour: 5,
};
/** The inclusive range the parser enforces for each field (the last line of defense behind the registry's own ranges). */
const BOUNDS: Record<EmailPolicyField, [number, number]> = {
  codeLength: [4, 10],
  validityMinutes: [1, 1440],
  resendSeconds: [0, 86400],
  maxPerHour: [1, 1000],
  maxPerDay: [1, 10000],
  maxAttempts: [1, 100],
  requestsPerHour: [1, 100000],
  addressPerHour: [1, 1000],
};
const withValue = (field: EmailPolicyField, value: unknown): Record<string, unknown> => ({ ...SEEDED, [EMAIL_POLICY_KEYS[field]]: value });
const without = (field: EmailPolicyField): Record<string, unknown> => {
  const copy = { ...SEEDED };
  delete copy[EMAIL_POLICY_KEYS[field]];
  return copy;
};
const rejected = (values: Record<string, unknown>): AccountError => {
  try {
    parseEmailVerificationPolicy(values);
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError);
    return err as AccountError;
  }
  throw new Error('expected the policy to be rejected');
};

describe('parseEmailVerificationPolicy: accepted input', () => {
  it('returns the typed policy for the seeded values', () => {
    expect(parseEmailVerificationPolicy(SEEDED)).toEqual(SEEDED_POLICY);
  });
  it('maps each configuration key to its own field (no two fields swapped)', () => {
    const distinct: Record<string, unknown> = {
      [EMAIL_POLICY_KEYS.codeLength]: 4,
      [EMAIL_POLICY_KEYS.validityMinutes]: 11,
      [EMAIL_POLICY_KEYS.resendSeconds]: 22,
      [EMAIL_POLICY_KEYS.maxPerHour]: 33,
      [EMAIL_POLICY_KEYS.maxPerDay]: 44,
      [EMAIL_POLICY_KEYS.maxAttempts]: 55,
      [EMAIL_POLICY_KEYS.requestsPerHour]: 66,
      [EMAIL_POLICY_KEYS.addressPerHour]: 77,
    };
    expect(parseEmailVerificationPolicy(distinct)).toEqual({
      codeLength: 4,
      validityMinutes: 11,
      resendSeconds: 22,
      maxPerHour: 33,
      maxPerDay: 44,
      maxAttempts: 55,
      requestsPerHour: 66,
      addressPerHour: 77,
    });
  });
  it('returns exactly the eight policy fields and nothing else, as a new plain object', () => {
    const input: Record<string, unknown> = { ...SEEDED, 'some.other.key': 1, extra: 'ignored' };
    const policy = parseEmailVerificationPolicy(input);
    expect(Object.keys(policy).sort()).toEqual([...FIELDS].sort());
    expect(policy).not.toBe(input);
    input[EMAIL_POLICY_KEYS.codeLength] = 9;
    expect(policy.codeLength).toBe(6);
  });
  it('accepts a frozen input and does not modify it', () => {
    const input = Object.freeze({ ...SEEDED });
    expect(parseEmailVerificationPolicy(input)).toEqual(SEEDED_POLICY);
    expect(input).toEqual(SEEDED);
  });
  it.each(FIELDS)('accepts exactly the minimum and the maximum of %s', (field) => {
    const [min, max] = BOUNDS[field];
    expect(parseEmailVerificationPolicy(withValue(field, min))[field]).toBe(min);
    expect(parseEmailVerificationPolicy(withValue(field, max))[field]).toBe(max);
  });
});

describe('parseEmailVerificationPolicy: rejected input fails closed as UNAVAILABLE / POLICY_INVALID naming the field', () => {
  it('has exactly eight fields, one per configuration key', () => {
    expect(FIELDS).toHaveLength(8);
    expect(new Set(Object.values(EMAIL_POLICY_KEYS)).size).toBe(8);
  });

  it.each(FIELDS)('rejects a missing %s', (field) => {
    const e = rejected(without(field));
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.details).toEqual({ reason: 'POLICY_INVALID', field });
  });
  it('rejects an empty configuration and names the first field', () => {
    const e = rejected({});
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.details).toEqual({ reason: 'POLICY_INVALID', field: 'codeLength' });
  });
  it('treats a key that exists with the value undefined as missing', () => {
    expect(rejected(withValue('maxAttempts', undefined)).details).toEqual({ reason: 'POLICY_INVALID', field: 'maxAttempts' });
  });
  it('reports the first invalid field when several are invalid', () => {
    const values = { ...withValue('maxPerDay', 'x'), [EMAIL_POLICY_KEYS.validityMinutes]: -1 };
    expect(rejected(values).details).toEqual({ reason: 'POLICY_INVALID', field: 'validityMinutes' });
  });

  const WRONG_TYPES: [string, unknown][] = [
    ['a numeric string', '6'],
    ['a string with a unit', '10 minutes'],
    ['an empty string', ''],
    ['a float', 6.5],
    ['a tiny float above an integer', 6.000001],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['true', true],
    ['false', false],
    ['null', null],
    ['an object', { value: 6 }],
    ['an array', [6]],
    ['a bigint', BigInt(6)],
    ['a Number object', new Number(6)],
    ['an unsafe integer', 2 ** 53],
  ];
  describe.each(FIELDS)('%s', (field) => {
    it.each(WRONG_TYPES)('rejects %s', (_label, value) => {
      const e = rejected(withValue(field, value));
      expect(e.code).toBe('UNAVAILABLE');
      expect(e.details).toEqual({ reason: 'POLICY_INVALID', field });
    });
    it('rejects the value just below the minimum and just above the maximum', () => {
      const [min, max] = BOUNDS[field];
      for (const bad of [min - 1, max + 1]) {
        const e = rejected(withValue(field, bad));
        expect(e.code, `${field}=${bad}`).toBe('UNAVAILABLE');
        expect(e.details, `${field}=${bad}`).toEqual({ reason: 'POLICY_INVALID', field });
      }
    });
    it('rejects a negative value and a very large value', () => {
      for (const bad of [-1_000_000, 1e12, Number.MAX_SAFE_INTEGER]) {
        expect(rejected(withValue(field, bad)).details).toEqual({ reason: 'POLICY_INVALID', field });
      }
    });
  });

  it('only resendSeconds may be zero (no cooldown); every other field starts at 1 or more', () => {
    expect(parseEmailVerificationPolicy(withValue('resendSeconds', 0)).resendSeconds).toBe(0);
    for (const field of FIELDS.filter((f) => f !== 'resendSeconds')) expect(rejected(withValue(field, 0)).details).toEqual({ reason: 'POLICY_INVALID', field });
  });

  it('never puts the offending value (or any configuration value) in the error', () => {
    const marker = 987_654_321;
    for (const field of FIELDS) {
      const e = rejected(withValue(field, marker));
      expect(exposed(e)).not.toContain(String(marker));
      expect(e.message).toBe('the email verification policy is not available');
      expect(Object.keys(e.details).sort()).toEqual(['field', 'reason']);
    }
    const text = rejected(withValue('codeLength', 'Zq9-typed-config-marker')) as AccountError;
    expect(exposed(text)).not.toContain('Zq9-typed-config-marker');
  });
});

describe('EMAIL_POLICY_PARAMETER_KEYS and the migration', () => {
  const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0010_email_verification.sql', import.meta.url)), 'utf8');
  // rows of the seed: (n, 'key', 'unit', 'description', '{"min": a, "max": b}'::jsonb, value, 'source')
  const SEED_ROW = /\(\s*\d+,\s*'(verification\.email\.[a-z_.]+)',\s*'[^']*',\s*'[^']*',\s*'\{"min":\s*(\d+),\s*"max":\s*(\d+)\}'::jsonb,\s*(\d+),/g;
  const seeded = [...migration.matchAll(SEED_ROW)].map((m) => ({ key: m[1]!, min: Number(m[2]), max: Number(m[3]), value: Number(m[4]) }));

  it('lists exactly the eight keys of the policy', () => {
    expect([...EMAIL_POLICY_PARAMETER_KEYS].sort()).toEqual(
      [
        'verification.email.address.max_per_hour',
        'verification.email.code.length',
        'verification.email.max_attempts',
        'verification.email.max_per_day',
        'verification.email.max_per_hour',
        'verification.email.requests.max_per_hour',
        'verification.email.resend_seconds',
        'verification.email.validity_minutes',
      ].sort(),
    );
    expect([...EMAIL_POLICY_PARAMETER_KEYS].sort()).toEqual(Object.values(EMAIL_POLICY_KEYS).sort());
    expect(new Set(EMAIL_POLICY_PARAMETER_KEYS).size).toBe(8);
  });
  it('has every key as a seeded configuration parameter in migration 0010, and seeds nothing else under verification.email.*', () => {
    expect(seeded).toHaveLength(8);
    expect(seeded.map((s) => s.key).sort()).toEqual([...EMAIL_POLICY_PARAMETER_KEYS].sort());
    for (const key of EMAIL_POLICY_PARAMETER_KEYS) expect(migration, key).toContain(`'${key}'`);
  });
  it('seeds the values the policy tests assume (6/10/30/5/10/5/30/5), so a changed default is noticed here', () => {
    const byKey = Object.fromEntries(seeded.map((s) => [s.key, s.value]));
    for (const [key, value] of Object.entries(SEEDED)) expect(byKey[key], key).toBe(value);
  });
  it('seeds each value inside its own registry range, and the parser accepts the whole registry range of every parameter (it never rejects what the registry allows)', () => {
    for (const row of seeded) {
      expect(row.value, row.key).toBeGreaterThanOrEqual(row.min);
      expect(row.value, row.key).toBeLessThanOrEqual(row.max);
      const field = FIELDS.find((f) => EMAIL_POLICY_KEYS[f] === row.key)!;
      expect(parseEmailVerificationPolicy(withValue(field, row.min))[field], `${row.key} min`).toBe(row.min);
      expect(parseEmailVerificationPolicy(withValue(field, row.max))[field], `${row.key} max`).toBe(row.max);
    }
  });
});

// ====================================================================== decideIdpEmail
const TRUSTED: ReadonlySet<string> = new Set(['google', 'apple']);
const assertion = (over: Partial<Record<keyof IdpEmailAssertion, unknown>> = {}): IdpEmailAssertion =>
  ({ email: 'ana@example.test', emailVerified: true, identityProvider: 'google', ...over }) as IdpEmailAssertion;

describe('decideIdpEmail: VERIFIED', () => {
  it.each(['google', 'apple'])('is VERIFIED for a valid address, email_verified true and the trusted provider %s', (identityProvider) => {
    expect(decideIdpEmail(assertion({ identityProvider }), TRUSTED)).toEqual({ kind: 'VERIFIED', email: 'ana@example.test' });
  });
  it('returns the CANONICAL form: trimmed, with the case folded, plus tags and dots kept', () => {
    expect(decideIdpEmail(assertion({ email: '  Ana.Smith+Tag@Example.TEST  ' }), TRUSTED)).toEqual({ kind: 'VERIFIED', email: 'ana.smith+tag@example.test' });
    expect(decideIdpEmail(assertion({ email: 'ANA@EXAMPLE.TEST' }), TRUSTED)).toEqual({ kind: 'VERIFIED', email: 'ana@example.test' });
  });
  it('returns the same string canonicalizeEmail returns (one canonicalization for every address)', () => {
    for (const raw of ['Ana@Example.test', 'a.b+c@sub.example.test', ' x@y.zz ']) {
      const canonical = canonicalizeEmail(raw);
      expect(canonical.ok).toBe(true);
      expect(decideIdpEmail(assertion({ email: raw }), TRUSTED)).toEqual({ kind: 'VERIFIED', email: canonical.ok ? canonical.value : '' });
    }
  });
  it('maps an internationalized domain to its ASCII form', () => {
    const email = `ana@b${String.fromCodePoint(0xfc)}cher.example`;
    expect(decideIdpEmail(assertion({ email }), TRUSTED)).toEqual({ kind: 'VERIFIED', email: 'ana@xn--bcher-kva.example' });
  });
  it('accepts an Apple private relay address (opaque local part, apple provider) and folds its case', () => {
    expect(decideIdpEmail(assertion({ email: 'abc123@privaterelay.appleid.com', identityProvider: 'apple' }), TRUSTED)).toEqual({
      kind: 'VERIFIED',
      email: 'abc123@privaterelay.appleid.com',
    });
    expect(decideIdpEmail(assertion({ email: 'AbC123@PrivateRelay.AppleID.com', identityProvider: 'apple' }), TRUSTED)).toEqual({
      kind: 'VERIFIED',
      email: 'abc123@privaterelay.appleid.com',
    });
  });
  it('returns exactly kind and email (no provider, no flag, no raw claim leaks into the result)', () => {
    const result = decideIdpEmail(assertion({ email: 'ANA@example.test' }), TRUSTED);
    expect(Object.keys(result).sort()).toEqual(['email', 'kind']);
  });
});

describe('decideIdpEmail: a missing or untrue email_verified flag is only a SUGGESTION (NOT_VERIFIED)', () => {
  const NOT_TRUE: [string, unknown][] = [
    ['false', false],
    ['the string "true"', 'true'],
    ['the string "True"', 'True'],
    ['the number 1', 1],
    ['the string "yes"', 'yes'],
    ['the string "1"', '1'],
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ['an empty string', ''],
    ['an object', {}],
    ['an array holding true', [true]],
    ['a Boolean object wrapping true', new Boolean(true)],
  ];
  it.each(NOT_TRUE)('is a SUGGESTION NOT_VERIFIED for email_verified = %s, even for a trusted provider', (_label, emailVerified) => {
    expect(decideIdpEmail(assertion({ emailVerified }), TRUSTED)).toEqual({ kind: 'SUGGESTION', email: 'ana@example.test', reason: 'NOT_VERIFIED' });
  });
  it('is a SUGGESTION NOT_VERIFIED when the flag is absent from the claims altogether (a plain email claim is never VERIFIED)', () => {
    for (const identityProvider of ['google', 'apple']) {
      const claims = { email: 'ana@example.test', identityProvider } as unknown as IdpEmailAssertion;
      expect(decideIdpEmail(claims, TRUSTED)).toEqual({ kind: 'SUGGESTION', email: 'ana@example.test', reason: 'NOT_VERIFIED' });
    }
  });
  it('reports NOT_VERIFIED before UNTRUSTED_SOURCE when both apply', () => {
    expect(decideIdpEmail(assertion({ emailVerified: 'true', identityProvider: null }), TRUSTED)).toEqual({
      kind: 'SUGGESTION',
      email: 'ana@example.test',
      reason: 'NOT_VERIFIED',
    });
  });
  it('suggests the canonical address, not the raw claim', () => {
    expect(decideIdpEmail(assertion({ email: ' ANA@Example.TEST ', emailVerified: false }), TRUSTED)).toEqual({
      kind: 'SUGGESTION',
      email: 'ana@example.test',
      reason: 'NOT_VERIFIED',
    });
  });
});

describe('decideIdpEmail: the provider must be in the trusted set (SUGGESTION UNTRUSTED_SOURCE)', () => {
  const UNTRUSTED: [string, unknown][] = [
    ['null (a user of the Keycloak realm itself)', null],
    ['an empty string', ''],
    ['an unknown alias', 'facebook'],
    ['"Google" (the alias is case-sensitive)', 'Google'],
    ['"GOOGLE"', 'GOOGLE'],
    ['"Apple"', 'Apple'],
    ['an alias with a leading space', ' google'],
    ['an alias with a trailing space', 'google '],
    ['an alias with a trailing newline', 'google\n'],
    ['a longer alias that starts with a trusted one', 'google-workspace'],
    ['a prefix of a trusted alias', 'goog'],
    ['undefined', undefined],
    ['a number', 5],
    ['an object', {}],
    ['an array holding a trusted alias', ['google']],
  ];
  it.each(UNTRUSTED)('is a SUGGESTION UNTRUSTED_SOURCE for the provider %s, even with email_verified true', (_label, identityProvider) => {
    expect(decideIdpEmail(assertion({ identityProvider }), TRUSTED)).toEqual({ kind: 'SUGGESTION', email: 'ana@example.test', reason: 'UNTRUSTED_SOURCE' });
  });
  it('trusts nothing when the trusted set is empty (the default): no provider is ever VERIFIED', () => {
    const none: ReadonlySet<string> = new Set();
    for (const identityProvider of ['google', 'apple', null, '', 'facebook']) {
      expect(decideIdpEmail(assertion({ identityProvider }), none)).toEqual({ kind: 'SUGGESTION', email: 'ana@example.test', reason: 'UNTRUSTED_SOURCE' });
    }
  });
  it('never trusts an empty alias, even when the set contains an empty string', () => {
    expect(decideIdpEmail(assertion({ identityProvider: '' }), new Set(['']))).toEqual({
      kind: 'SUGGESTION',
      email: 'ana@example.test',
      reason: 'UNTRUSTED_SOURCE',
    });
  });
  it('uses exactly the set it is given (a custom set trusts only its own members)', () => {
    const onlyApple: ReadonlySet<string> = new Set(['apple']);
    expect(decideIdpEmail(assertion({ identityProvider: 'apple' }), onlyApple).kind).toBe('VERIFIED');
    expect(decideIdpEmail(assertion({ identityProvider: 'google' }), onlyApple)).toEqual({
      kind: 'SUGGESTION',
      email: 'ana@example.test',
      reason: 'UNTRUSTED_SOURCE',
    });
    expect(decideIdpEmail(assertion({ identityProvider: 'okta' }), new Set(['okta'])).kind).toBe('VERIFIED');
  });
});

describe('decideIdpEmail: no usable address is IGNOREd', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('is IGNORE NO_EMAIL for the email claim %s, whatever the flag and provider say', (_label, email) => {
    expect(decideIdpEmail(assertion({ email }), TRUSTED)).toEqual({ kind: 'IGNORE', reason: 'NO_EMAIL' });
    expect(decideIdpEmail(assertion({ email, emailVerified: false, identityProvider: null }), TRUSTED)).toEqual({ kind: 'IGNORE', reason: 'NO_EMAIL' });
  });
  it('is IGNORE NO_EMAIL when the claim is missing from the object', () => {
    expect(decideIdpEmail({ emailVerified: true, identityProvider: 'google' } as unknown as IdpEmailAssertion, TRUSTED)).toEqual({
      kind: 'IGNORE',
      reason: 'NO_EMAIL',
    });
  });
  it.each([
    ['plain text', 'not-an-email'],
    ['no domain', 'ana@'],
    ['no local part', '@example.test'],
    ['a single-label domain', 'ana@localhost'],
    ['two @ signs', 'ana@@example.test'],
    ['two addresses', 'ana@example.test,bob@example.test'],
    ['a space inside', 'ana smith@example.test'],
    ['an IP literal', 'ana@[127.0.0.1]'],
    ['a numeric top-level label', 'ana@example.123'],
    ['a trailing dot', 'ana@example.test.'],
    ['a quoted local part', '"ana smith"@example.test'],
    ['a control character', `ana${String.fromCharCode(7)}@example.test`],
    ['a newline injection', 'ana@example.test\nBcc: bob@example.test'],
    ['a bidirectional override', `ana${String.fromCodePoint(0x202e)}@example.test`],
    ['a non-ASCII local part', `${String.fromCodePoint(0xe9)}na@example.test`],
    ['whitespace only', '   '],
    ['an over-long address', `${'a'.repeat(65)}@example.test`],
    ['a number', 12345],
    ['true', true],
    ['an object', { address: 'ana@example.test' }],
    ['an array', ['ana@example.test']],
  ])('is IGNORE INVALID_EMAIL for %s, even when the provider is trusted and says the address is verified', (_label, email) => {
    expect(decideIdpEmail(assertion({ email }), TRUSTED)).toEqual({ kind: 'IGNORE', reason: 'INVALID_EMAIL' });
  });
});

describe('decideIdpEmail: VERIFIED if and only if all three conditions hold (exhaustive matrix against an independent oracle)', () => {
  const emails: [string, unknown, 'VALID' | 'INVALID' | 'NONE'][] = [
    ['valid', 'Ana@Example.test', 'VALID'],
    ['invalid', 'ana@', 'INVALID'],
    ['missing', undefined, 'NONE'],
    ['empty', '', 'NONE'],
  ];
  const flags: unknown[] = [true, false, 'true', 1, undefined, null, 'yes'];
  const providers: unknown[] = ['google', 'apple', null, '', 'Google', 'facebook', undefined];
  const sets: [string, ReadonlySet<string>][] = [
    ['empty', new Set()],
    ['google only', new Set(['google'])],
    ['google and apple', new Set(['google', 'apple'])],
  ];
  for (const [setLabel, trusted] of sets) {
    it(`for the trusted set "${setLabel}"`, () => {
      let verified = 0;
      for (const [, email, emailKind] of emails) {
        for (const emailVerified of flags) {
          for (const identityProvider of providers) {
            const decision = decideIdpEmail({ email, emailVerified, identityProvider } as IdpEmailAssertion, trusted);
            const shouldVerify =
              emailKind === 'VALID' &&
              emailVerified === true &&
              typeof identityProvider === 'string' &&
              identityProvider !== '' &&
              trusted.has(identityProvider);
            const context = JSON.stringify({ email, emailVerified, identityProvider, trusted: [...trusted] });
            expect(decision.kind === 'VERIFIED', context).toBe(shouldVerify);
            if (emailKind === 'NONE') expect(decision, context).toEqual({ kind: 'IGNORE', reason: 'NO_EMAIL' });
            else if (emailKind === 'INVALID') expect(decision, context).toEqual({ kind: 'IGNORE', reason: 'INVALID_EMAIL' });
            else if (shouldVerify) expect(decision, context).toEqual({ kind: 'VERIFIED', email: 'ana@example.test' });
            else
              expect(decision, context).toEqual({
                kind: 'SUGGESTION',
                email: 'ana@example.test',
                reason: emailVerified === true ? 'UNTRUSTED_SOURCE' : 'NOT_VERIFIED',
              });
            if (decision.kind === 'VERIFIED') verified++;
          }
        }
      }
      // sanity: the matrix does contain verified cases exactly where the set allows them
      expect(verified).toBe(setLabel === 'empty' ? 0 : setLabel === 'google only' ? 1 : 2);
    });
  }
});

describe('decideIdpEmail: purity', () => {
  it('gives equal results when called twice and does not modify its inputs', () => {
    const input = Object.freeze(assertion({ email: ' Ana@Example.TEST ' }));
    const trusted = new Set(['google', 'apple']);
    const before = { input: { ...input }, members: [...trusted] };
    const first = decideIdpEmail(input, trusted);
    const second = decideIdpEmail(input, trusted);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect({ ...input }).toEqual(before.input);
    expect([...trusted]).toEqual(before.members);
    expect(input.email).toBe(' Ana@Example.TEST ');
  });
  it('does no I/O: it writes no log, calls no network function and reads no clock', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('decideIdpEmail must not use the network');
    });
    const now = vi.spyOn(Date, 'now');
    try {
      for (const identityProvider of ['google', null, 'x']) decideIdpEmail(assertion({ identityProvider }), TRUSTED);
      decideIdpEmail(assertion({ email: 'garbage' }), TRUSTED);
      decideIdpEmail(assertion({ email: undefined }), TRUSTED);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      fetchSpy.mockRestore();
      now.mockRestore();
    }
  });
  it('is a synchronous function (it returns a decision, not a promise)', () => {
    const decision = decideIdpEmail(assertion(), TRUSTED);
    expect(decision).not.toBeInstanceOf(Promise);
    expect(decision.kind).toBe('VERIFIED');
  });
});
