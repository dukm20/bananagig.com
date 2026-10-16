// Unit tests of the phone verification policy (ID-003): the parsing of the ten configuration-driven values (a missing or malformed value is an outage of the
// policy, never a default), the key set against the migration that seeds it, assertPhoneVerificationPolicy and the line-type decision. No database, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PHONE_BLOCKABLE_LINE_TYPES, PHONE_LINE_TYPES, type PhoneBlockableLineType, type PhoneLineType } from '@bananagig/contracts';
import { AccountError } from './errors';
import {
  PHONE_POLICY_KEYS,
  PHONE_POLICY_PARAMETER_KEYS,
  assertPhoneVerificationPolicy,
  isLineTypeBlocked,
  parsePhoneVerificationPolicy,
  type PhonePolicyField,
  type PhoneVerificationPolicy,
} from './phone-policy';

const FIELDS = Object.keys(PHONE_POLICY_KEYS) as PhonePolicyField[];
const INT_FIELDS = FIELDS.filter((f) => f !== 'blockedLineTypes');
const exposed = (err: unknown): string => inspect(err, { depth: 8, showHidden: false });

/** The values the migration seeds, keyed by the configuration parameter key. */
const SEEDED: Record<string, unknown> = {
  [PHONE_POLICY_KEYS.codeLength]: 6,
  [PHONE_POLICY_KEYS.validityMinutes]: 10,
  [PHONE_POLICY_KEYS.resendSeconds]: 30,
  [PHONE_POLICY_KEYS.maxPerHour]: 5,
  [PHONE_POLICY_KEYS.maxPerDay]: 10,
  [PHONE_POLICY_KEYS.maxAttempts]: 5,
  [PHONE_POLICY_KEYS.maxAccountsPerNumber]: 1,
  [PHONE_POLICY_KEYS.blockedLineTypes]: ['VIRTUAL', 'HIGH_RISK'],
  [PHONE_POLICY_KEYS.requestsPerHour]: 30,
  [PHONE_POLICY_KEYS.numberPerHour]: 5,
};
const SEEDED_POLICY: PhoneVerificationPolicy = {
  codeLength: 6,
  validityMinutes: 10,
  resendSeconds: 30,
  maxPerHour: 5,
  maxPerDay: 10,
  maxAttempts: 5,
  maxAccountsPerNumber: 1,
  blockedLineTypes: ['VIRTUAL', 'HIGH_RISK'],
  requestsPerHour: 30,
  numberPerHour: 5,
};
/** The accepted range of every integer field (the parser is the last line of defense, so these are the hard bounds). */
const BOUNDS: Record<string, readonly [number, number]> = {
  codeLength: [4, 10],
  validityMinutes: [1, 1440],
  resendSeconds: [0, 86400],
  maxPerHour: [1, 1000],
  maxPerDay: [1, 10000],
  maxAttempts: [1, 100],
  maxAccountsPerNumber: [1, 5],
  requestsPerHour: [1, 100000],
  numberPerHour: [1, 1000],
};
const withValue = (field: PhonePolicyField, value: unknown): Record<string, unknown> => ({ ...SEEDED, [PHONE_POLICY_KEYS[field]]: value });
const without = (field: PhonePolicyField): Record<string, unknown> => {
  const copy = { ...SEEDED };
  delete copy[PHONE_POLICY_KEYS[field]];
  return copy;
};
const thrown = (fn: () => unknown): AccountError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError);
    return err as AccountError;
  }
  throw new Error('did not throw');
};
const expectInvalid = (fn: () => unknown, field: PhonePolicyField): void => {
  const err = thrown(fn);
  expect(err.code).toBe('UNAVAILABLE');
  expect(err.details).toEqual({ reason: 'POLICY_INVALID', field });
};

// ====================================================================== the keys
describe('PHONE_POLICY_KEYS', () => {
  it('names the ten channel-specific verification.phone.* keys', () => {
    expect(PHONE_POLICY_KEYS).toEqual({
      codeLength: 'verification.phone.code.length',
      validityMinutes: 'verification.phone.validity_minutes',
      resendSeconds: 'verification.phone.resend_seconds',
      maxPerHour: 'verification.phone.max_per_hour',
      maxPerDay: 'verification.phone.max_per_day',
      maxAttempts: 'verification.phone.max_attempts',
      maxAccountsPerNumber: 'verification.phone.max_accounts_per_number',
      blockedLineTypes: 'verification.phone.blocked_line_types',
      requestsPerHour: 'verification.phone.requests.max_per_hour',
      numberPerHour: 'verification.phone.number.max_per_hour',
    });
  });
  it('never shares a key with the email verification (the phone has its own values)', () => {
    for (const key of Object.values(PHONE_POLICY_KEYS)) {
      expect(key.startsWith('verification.phone.')).toBe(true);
      expect(key).not.toContain('email');
    }
  });
  it('has ten distinct keys', () => {
    expect(new Set(Object.values(PHONE_POLICY_KEYS)).size).toBe(10);
  });
  it('PHONE_POLICY_PARAMETER_KEYS is exactly the ten keys', () => {
    expect([...PHONE_POLICY_PARAMETER_KEYS].sort()).toEqual(Object.values(PHONE_POLICY_KEYS).sort());
    expect(PHONE_POLICY_PARAMETER_KEYS).toHaveLength(10);
  });
  it('every key exists in migration 0011 with the seeded value of this test file', () => {
    const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0011_phone_verification.sql', import.meta.url)), 'utf8');
    const rows = new Map<string, string>();
    // one seed row: (n, 'key', 'TYPE', unit, description, rules ... , 'owner', ARRAY[scopes], 'value'::jsonb, basis)
    for (const m of migration.matchAll(/\(\s*\d+,\s*'(verification\.phone\.[a-z_.]+)'[\s\S]*?(?:'(\[[^']*\]|-?\d+)'::jsonb),\s*'[^']*'\)/g))
      rows.set(m[1]!, m[2]!);
    for (const key of PHONE_POLICY_PARAMETER_KEYS) {
      expect(migration, key).toContain(`'${key}'`);
      expect(rows.has(key), `seed row of ${key}`).toBe(true);
    }
    for (const [key, value] of Object.entries(SEEDED)) {
      const stored = JSON.parse(rows.get(key)!) as unknown;
      expect(stored, key).toEqual(value);
    }
  });
});

// ====================================================================== parsePhoneVerificationPolicy
describe('parsePhoneVerificationPolicy: the seeded values', () => {
  it('parses the seeded values into the policy', () => {
    expect(parsePhoneVerificationPolicy(SEEDED)).toEqual(SEEDED_POLICY);
  });
  it('copies the blocked list instead of sharing the input array', () => {
    const list = ['VIRTUAL', 'HIGH_RISK'];
    const policy = parsePhoneVerificationPolicy({ ...SEEDED, [PHONE_POLICY_KEYS.blockedLineTypes]: list });
    expect(policy.blockedLineTypes).toEqual(list);
    expect(policy.blockedLineTypes).not.toBe(list);
    list.push('VOIP');
    expect(policy.blockedLineTypes).toEqual(['VIRTUAL', 'HIGH_RISK']);
  });
  it('ignores unrelated keys', () => {
    expect(parsePhoneVerificationPolicy({ ...SEEDED, 'verification.email.code.length': 99, other: 'x' })).toEqual(SEEDED_POLICY);
  });
  it('does not read the email keys for any phone field', () => {
    const emailOnly = Object.fromEntries(Object.entries(SEEDED).map(([k, v]) => [k.replace('verification.phone.', 'verification.email.'), v]));
    expect(() => parsePhoneVerificationPolicy(emailOnly)).toThrow(AccountError);
  });
});

describe('parsePhoneVerificationPolicy: a missing value is an outage, never a default', () => {
  it.each(FIELDS)('refuses a missing %s', (field) => {
    expectInvalid(() => parsePhoneVerificationPolicy(without(field)), field);
  });
  it('refuses an empty input and reports the first field', () => {
    const err = thrown(() => parsePhoneVerificationPolicy({}));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.details.reason).toBe('POLICY_INVALID');
    expect(FIELDS).toContain(err.details.field);
  });
  it.each(FIELDS)('refuses %s when its value is undefined', (field) => {
    expectInvalid(() => parsePhoneVerificationPolicy(withValue(field, undefined)), field);
  });
});

describe('parsePhoneVerificationPolicy: a wrongly typed integer value', () => {
  const WRONG: [string, unknown][] = [
    ['a numeric string', '6'],
    ['a float', 6.5],
    ['a tiny float', 6.0000001],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['true', true],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['an object', { value: 6 }],
    ['an empty object', {}],
    ['an array', [6]],
    ['a bigint', BigInt(6)],
    ['a Number object', Object(6)],
    ['a function', () => 6],
    ['an empty string', ''],
    ['a symbol', Symbol('6')],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ];
  for (const field of INT_FIELDS) {
    it.each(WRONG)(`refuses ${field} as %s`, (_label, value) => {
      expectInvalid(() => parsePhoneVerificationPolicy(withValue(field, value)), field);
    });
  }
});

describe('parsePhoneVerificationPolicy: the bounds of every integer field', () => {
  for (const field of INT_FIELDS) {
    const [min, max] = BOUNDS[field]!;
    it(`accepts ${field} exactly at the minimum ${min}`, () => {
      expect(parsePhoneVerificationPolicy(withValue(field, min))[field]).toBe(min);
    });
    it(`accepts ${field} exactly at the maximum ${max}`, () => {
      expect(parsePhoneVerificationPolicy(withValue(field, max))[field]).toBe(max);
    });
    it(`refuses ${field} one below the minimum (${min - 1})`, () => {
      expectInvalid(() => parsePhoneVerificationPolicy(withValue(field, min - 1)), field);
    });
    it(`refuses ${field} one above the maximum (${max + 1})`, () => {
      expectInvalid(() => parsePhoneVerificationPolicy(withValue(field, max + 1)), field);
    });
    it(`refuses ${field} at a negative value`, () => {
      expectInvalid(() => parsePhoneVerificationPolicy(withValue(field, -1)), field);
    });
  }
  it('accepts resendSeconds 0 (no cooldown) but no other field accepts 0', () => {
    expect(parsePhoneVerificationPolicy(withValue('resendSeconds', 0)).resendSeconds).toBe(0);
    for (const field of INT_FIELDS.filter((f) => f !== 'resendSeconds')) {
      expectInvalid(() => parsePhoneVerificationPolicy(withValue(field, 0)), field);
    }
  });
  it.each([1, 2, 3, 4, 5])('accepts maxAccountsPerNumber %i', (n) => {
    expect(parsePhoneVerificationPolicy(withValue('maxAccountsPerNumber', n)).maxAccountsPerNumber).toBe(n);
  });
  it.each([0, 6, 7, 10, 100])('refuses maxAccountsPerNumber %i', (n) => {
    expectInvalid(() => parsePhoneVerificationPolicy(withValue('maxAccountsPerNumber', n)), 'maxAccountsPerNumber');
  });
  it('accepts negative zero as zero where zero is allowed', () => {
    expect(parsePhoneVerificationPolicy(withValue('resendSeconds', -0)).resendSeconds === 0).toBe(true);
  });
});

describe('parsePhoneVerificationPolicy: the blocked line types', () => {
  const BAD: [string, unknown][] = [
    ['a string', 'VIRTUAL'],
    ['a JSON string', '["VIRTUAL"]'],
    ['an object', { VIRTUAL: true }],
    ['null', null],
    ['a number', 1],
    ['true', true],
    ['an array holding a number', ['VIRTUAL', 1]],
    ['an array holding null', ['VIRTUAL', null]],
    ['an array holding an object', [{ type: 'VIRTUAL' }]],
    ['an array holding a nested array', [['VIRTUAL']]],
    ['an unknown type', ['SATELLITE']],
    ['a lower-case type', ['virtual']],
    ['a type with a space', ['VIRTUAL ']],
    ['an empty-string type', ['']],
    ['MOBILE (not blockable)', ['MOBILE']],
    ['MOBILE among valid types', ['VIRTUAL', 'MOBILE']],
    ['duplicates', ['VIRTUAL', 'VIRTUAL']],
    ['duplicates among others', ['VOIP', 'VIRTUAL', 'HIGH_RISK', 'VOIP']],
    ['more than five entries', ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK', 'LANDLINE']],
    ['six distinct-looking entries including an unknown one', ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK', 'MOBILE']],
    ['an array holding undefined', [undefined, 'VIRTUAL']],
    ['undefined', undefined],
  ];
  it.each(BAD)('refuses %s', (_label, value) => {
    expectInvalid(() => parsePhoneVerificationPolicy(withValue('blockedLineTypes', value)), 'blockedLineTypes');
  });
  it('accepts an empty list (nothing is blocked)', () => {
    expect(parsePhoneVerificationPolicy(withValue('blockedLineTypes', [])).blockedLineTypes).toEqual([]);
  });
  it.each(PHONE_BLOCKABLE_LINE_TYPES)('accepts %s alone', (type) => {
    expect(parsePhoneVerificationPolicy(withValue('blockedLineTypes', [type])).blockedLineTypes).toEqual([type]);
  });
  it('accepts all five blockable types, in the order given', () => {
    const all = ['HIGH_RISK', 'UNKNOWN', 'VIRTUAL', 'VOIP', 'LANDLINE'];
    expect(parsePhoneVerificationPolicy(withValue('blockedLineTypes', all)).blockedLineTypes).toEqual(all);
  });
  it('refuses MOBILE because it is not in the blockable vocabulary', () => {
    expect(PHONE_BLOCKABLE_LINE_TYPES as readonly string[]).not.toContain('MOBILE');
    expect(PHONE_LINE_TYPES as readonly string[]).toContain('MOBILE');
  });
});

describe('parsePhoneVerificationPolicy: the error', () => {
  it('is an AccountError UNAVAILABLE with a fixed message', () => {
    const err = thrown(() => parsePhoneVerificationPolicy(withValue('codeLength', 99)));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toBe('the phone verification policy is not available');
    expect(err.name).toBe('AccountError');
  });
  it.each([
    ['codeLength', 987654321, '987654321'],
    ['maxAttempts', 'marker-value-777', 'marker-value-777'],
    ['validityMinutes', 123456789, '123456789'],
    ['blockedLineTypes', ['MARKER-TYPE'], 'MARKER-TYPE'],
    ['maxPerDay', 424242, '424242'],
  ] as const)('names the field %s and never the value', (field, value, needle) => {
    const err = thrown(() => parsePhoneVerificationPolicy(withValue(field, value)));
    expect(err.details).toEqual({ reason: 'POLICY_INVALID', field });
    expect(exposed(err)).not.toContain(needle);
    expect(Object.keys(err.details).sort()).toEqual(['field', 'reason']);
  });
  it('reports the first failing integer field in declaration order', () => {
    const err = thrown(() => parsePhoneVerificationPolicy({ ...SEEDED, [PHONE_POLICY_KEYS.codeLength]: 1, [PHONE_POLICY_KEYS.maxAttempts]: 0 }));
    expect(err.details.field).toBe('codeLength');
  });
  it('reports blockedLineTypes last, after the integer fields', () => {
    const err = thrown(() => parsePhoneVerificationPolicy({ ...SEEDED, [PHONE_POLICY_KEYS.blockedLineTypes]: 'x', [PHONE_POLICY_KEYS.numberPerHour]: 0 }));
    expect(err.details.field).toBe('numberPerHour');
  });
});

// ====================================================================== assertPhoneVerificationPolicy
describe('assertPhoneVerificationPolicy', () => {
  it('returns an equal policy for a valid one', () => {
    expect(assertPhoneVerificationPolicy(SEEDED_POLICY)).toEqual(SEEDED_POLICY);
  });
  it('accepts an empty blocked list and the edge values', () => {
    const edge: PhoneVerificationPolicy = {
      codeLength: 4,
      validityMinutes: 1,
      resendSeconds: 0,
      maxPerHour: 1,
      maxPerDay: 1,
      maxAttempts: 1,
      maxAccountsPerNumber: 5,
      blockedLineTypes: [],
      requestsPerHour: 1,
      numberPerHour: 1,
    };
    expect(assertPhoneVerificationPolicy(edge)).toEqual(edge);
  });
  it.each(INT_FIELDS)('refuses a policy whose %s is out of range', (field) => {
    const [min, max] = BOUNDS[field]!;
    expectInvalid(() => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, [field]: max + 1 }), field);
    expectInvalid(() => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, [field]: min - 1 }), field);
  });
  it.each(INT_FIELDS)('refuses a policy whose %s is not an integer', (field) => {
    expectInvalid(() => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, [field]: 5.5 }), field);
    expectInvalid(() => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, [field]: Number.NaN }), field);
    expectInvalid(() => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, [field]: '5' as unknown as number }), field);
  });
  it('refuses a policy with a missing field', () => {
    const { codeLength: _drop, ...rest } = SEEDED_POLICY;
    expectInvalid(() => assertPhoneVerificationPolicy(rest as unknown as PhoneVerificationPolicy), 'codeLength');
  });
  it('refuses a policy with a bad blocked list', () => {
    expectInvalid(
      () => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, blockedLineTypes: ['MOBILE'] as unknown as PhoneBlockableLineType[] }),
      'blockedLineTypes',
    );
    expectInvalid(() => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, blockedLineTypes: ['VOIP', 'VOIP'] }), 'blockedLineTypes');
    expectInvalid(
      () => assertPhoneVerificationPolicy({ ...SEEDED_POLICY, blockedLineTypes: 'VOIP' as unknown as PhoneBlockableLineType[] }),
      'blockedLineTypes',
    );
  });
  it('returns a new policy object (the blocked list is copied)', () => {
    const out = assertPhoneVerificationPolicy(SEEDED_POLICY);
    expect(out).not.toBe(SEEDED_POLICY);
    expect(out.blockedLineTypes).not.toBe(SEEDED_POLICY.blockedLineTypes);
  });
});

// ====================================================================== isLineTypeBlocked
describe('isLineTypeBlocked', () => {
  const EVERY: readonly (PhoneLineType | null)[] = [null, ...PHONE_LINE_TYPES];
  const LISTS: readonly (readonly PhoneBlockableLineType[])[] = [
    [],
    ['VIRTUAL'],
    ['VIRTUAL', 'HIGH_RISK'],
    ['UNKNOWN'],
    ['VOIP', 'LANDLINE'],
    ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'],
  ];

  it('never blocks a null snapshot, whatever the list', () => {
    for (const list of LISTS) expect(isLineTypeBlocked(null, list)).toBe(false);
  });
  it('never blocks MOBILE, whatever the list (even a corrupted one that names it)', () => {
    for (const list of LISTS) expect(isLineTypeBlocked('MOBILE', list)).toBe(false);
    expect(isLineTypeBlocked('MOBILE', ['MOBILE'] as unknown as PhoneBlockableLineType[])).toBe(false);
  });
  it('blocks nothing with an empty list', () => {
    for (const type of EVERY) expect(isLineTypeBlocked(type, [])).toBe(false);
  });
  it('blocks UNKNOWN only when the list names it', () => {
    expect(isLineTypeBlocked('UNKNOWN', ['VIRTUAL', 'HIGH_RISK'])).toBe(false);
    expect(isLineTypeBlocked('UNKNOWN', ['UNKNOWN'])).toBe(true);
    expect(isLineTypeBlocked('UNKNOWN', ['VIRTUAL', 'UNKNOWN'])).toBe(true);
  });
  it('blocks exactly the listed types for the seeded list', () => {
    const seeded: readonly PhoneBlockableLineType[] = ['VIRTUAL', 'HIGH_RISK'];
    const expected: Record<string, boolean> = { null: false, MOBILE: false, LANDLINE: false, VOIP: false, VIRTUAL: true, UNKNOWN: false, HIGH_RISK: true };
    for (const type of EVERY) expect(isLineTypeBlocked(type, seeded), String(type)).toBe(expected[String(type)]);
  });
  describe.each(LISTS.map((list) => [list.join(',') || '(empty)', list] as const))('with the list %s', (_label, list) => {
    it.each(EVERY.map((t) => [String(t), t] as const))('decides %s as: listed and not MOBILE and not null', (_name, type) => {
      const expected = type !== null && type !== 'MOBILE' && (list as readonly string[]).includes(type);
      expect(isLineTypeBlocked(type, list)).toBe(expected);
    });
  });
  it('is a pure boolean function', () => {
    const list: readonly PhoneBlockableLineType[] = ['VOIP'];
    expect(isLineTypeBlocked('VOIP', list)).toBe(true);
    expect(isLineTypeBlocked('VOIP', list)).toBe(true);
    expect(list).toEqual(['VOIP']);
  });
});
