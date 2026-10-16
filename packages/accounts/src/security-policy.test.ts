// Unit tests of the security policy (ID-004): the six configuration-driven values (a missing or malformed value is an outage of the policy, never a default), the key
// set against the migration that seeds it, assertSecurityPolicy and the static provider. No database, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AccountError } from './errors';
import { SEEDED_SECURITY_POLICY, StaticSecurityPolicyProvider } from './security-fakes';
import {
  SECURITY_POLICY_BOUNDS,
  SECURITY_POLICY_KEYS,
  SECURITY_POLICY_PARAMETER_KEYS,
  assertSecurityPolicy,
  parseSecurityPolicy,
  type SecurityPolicyField,
} from './security-policy';
import type { SecurityPolicy } from './security-types';

const FIELDS = Object.keys(SECURITY_POLICY_KEYS) as SecurityPolicyField[];
const exposed = (err: unknown): string => inspect(err, { depth: 8, showHidden: false });

/** The values the migration seeds, keyed by the configuration parameter key. */
const SEEDED: Record<string, unknown> = {
  [SECURITY_POLICY_KEYS.trustedBrowserDays]: 30,
  [SECURITY_POLICY_KEYS.keepSignedInDays]: 30,
  [SECURITY_POLICY_KEYS.stepUpValidMinutes]: 15,
  [SECURITY_POLICY_KEYS.activityLogDays]: 90,
  [SECURITY_POLICY_KEYS.resetLinkValidityMinutes]: 60,
  [SECURITY_POLICY_KEYS.resetMaxRequestsPerHour]: 5,
};
const withValue = (field: SecurityPolicyField, value: unknown): Record<string, unknown> => ({ ...SEEDED, [SECURITY_POLICY_KEYS[field]]: value });
const without = (field: SecurityPolicyField): Record<string, unknown> => {
  const copy = { ...SEEDED };
  delete copy[SECURITY_POLICY_KEYS[field]];
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
const expectInvalid = (fn: () => unknown, field: SecurityPolicyField): void => {
  const err = thrown(fn);
  expect(err.code).toBe('UNAVAILABLE');
  expect(err.details).toEqual({ reason: 'POLICY_INVALID', field });
};

// ====================================================================== the keys
describe('SECURITY_POLICY_KEYS', () => {
  it('names the six configuration keys', () => {
    expect(SECURITY_POLICY_KEYS).toEqual({
      trustedBrowserDays: 'session.trusted_browser_days',
      keepSignedInDays: 'session.keep_signed_in_days',
      stepUpValidMinutes: 'security.step_up_valid_minutes',
      activityLogDays: 'security.activity_log_days',
      resetLinkValidityMinutes: 'reset_link.validity_minutes',
      resetMaxRequestsPerHour: 'reset_link.max_requests_per_hour',
    });
  });
  it('has six distinct keys and SECURITY_POLICY_PARAMETER_KEYS is exactly those', () => {
    expect(new Set(Object.values(SECURITY_POLICY_KEYS)).size).toBe(6);
    expect([...SECURITY_POLICY_PARAMETER_KEYS].sort()).toEqual(Object.values(SECURITY_POLICY_KEYS).sort());
  });
  it('covers every field of SecurityPolicy', () => {
    expect([...FIELDS].sort()).toEqual(Object.keys(SEEDED_SECURITY_POLICY).sort());
  });
});

describe('the migration seeds exactly these keys, values and bounds', () => {
  const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0012_application_sessions.sql', import.meta.url)), 'utf8');
  // one seed row: (n, 'key', 'INTEGER', 'unit', 'description', '{"min": a, "max": b}'::jsonb, 'owner', ARRAY['PLATFORM'], 'value'::jsonb, 'basis')
  const rows = new Map<string, { min: number; max: number; value: number; owner: string; basis: string }>();
  for (const m of migration.matchAll(
    /\(\s*\d+,\s*'([a-z_.]+)',\s*'INTEGER',\s*'[a-z]+',\s*'[^']*',\s*'\{"min": (\d+), "max": (\d+)\}'::jsonb,\s*'([a-z]+)',\s*ARRAY\['PLATFORM'\],\s*'(\d+)'::jsonb,\s*'([^']*)'\)/g,
  ))
    rows.set(m[1]!, { min: Number(m[2]), max: Number(m[3]), owner: m[4]!, value: Number(m[5]), basis: m[6]! });

  it('seeds one PLATFORM integer row per key', () => {
    expect([...rows.keys()].sort()).toEqual([...SECURITY_POLICY_PARAMETER_KEYS].sort());
  });
  it('seeds the values of this test file', () => {
    for (const [key, value] of Object.entries(SEEDED)) expect(rows.get(key)?.value, key).toBe(value);
    expect(SEEDED_SECURITY_POLICY).toEqual(parseSecurityPolicy(SEEDED));
  });
  it('has validation rules equal to the hard bounds of the parser', () => {
    for (const field of FIELDS) {
      const [min, max] = SECURITY_POLICY_BOUNDS[field];
      const row = rows.get(SECURITY_POLICY_KEYS[field])!;
      expect([row.min, row.max], field).toEqual([min, max]);
    }
  });
  it('is owned by security and flags the three assumptions (not the PRD values)', () => {
    for (const row of rows.values()) expect(row.owner).toBe('security');
    const assumptions = [...rows.entries()]
      .filter(([, r]) => /assumption/i.test(r.basis))
      .map(([k]) => k)
      .sort();
    expect(assumptions).toEqual(['reset_link.max_requests_per_hour', 'security.activity_log_days', 'security.step_up_valid_minutes']);
    for (const key of ['session.trusted_browser_days', 'session.keep_signed_in_days', 'reset_link.validity_minutes'])
      expect(rows.get(key)!.basis).toMatch(/^PRD /);
  });
  it('keeps every seeded value inside its own bounds', () => {
    for (const row of rows.values()) {
      expect(row.value).toBeGreaterThanOrEqual(row.min);
      expect(row.value).toBeLessThanOrEqual(row.max);
    }
  });
});

// ====================================================================== parseSecurityPolicy
describe('parseSecurityPolicy', () => {
  it('parses the seeded values into the policy', () => {
    expect(parseSecurityPolicy(SEEDED)).toEqual({
      trustedBrowserDays: 30,
      keepSignedInDays: 30,
      stepUpValidMinutes: 15,
      activityLogDays: 90,
      resetLinkValidityMinutes: 60,
      resetMaxRequestsPerHour: 5,
    });
  });
  it('ignores unrelated keys', () => {
    expect(parseSecurityPolicy({ ...SEEDED, 'verification.email.code.length': 6, nonsense: 'x' })).toEqual(SEEDED_SECURITY_POLICY);
  });
  it('returns only the six fields', () => {
    expect(Object.keys(parseSecurityPolicy({ ...SEEDED, extra: 1 })).sort()).toEqual([...FIELDS].sort());
  });
  it.each(FIELDS)('%s: a missing value is an outage of the policy, not a default', (field) => {
    expectInvalid(() => parseSecurityPolicy(without(field)), field);
  });
  it.each(FIELDS)('%s: accepts both bounds and refuses just outside them', (field) => {
    const [min, max] = SECURITY_POLICY_BOUNDS[field];
    expect(parseSecurityPolicy(withValue(field, min))[field]).toBe(min);
    expect(parseSecurityPolicy(withValue(field, max))[field]).toBe(max);
    expectInvalid(() => parseSecurityPolicy(withValue(field, min - 1)), field);
    expectInvalid(() => parseSecurityPolicy(withValue(field, max + 1)), field);
  });
  it.each(FIELDS)('%s: refuses every malformed type', (field) => {
    for (const v of [
      undefined,
      null,
      '',
      '30',
      ' 30',
      'abc',
      30.5,
      NaN,
      Infinity,
      -Infinity,
      -1,
      0,
      Number.MAX_SAFE_INTEGER + 1,
      1e21,
      true,
      false,
      [],
      [30],
      {},
      { value: 30 },
      () => 30,
      10n as unknown,
    ])
      if (!(typeof v === 'number' && v >= SECURITY_POLICY_BOUNDS[field][0] && v <= SECURITY_POLICY_BOUNDS[field][1] && Number.isInteger(v)))
        expectInvalid(() => parseSecurityPolicy(withValue(field, v)), field);
  });
  it('names the first invalid field only and exposes nothing else', () => {
    const err = thrown(() => parseSecurityPolicy({ ...SEEDED, [SECURITY_POLICY_KEYS.trustedBrowserDays]: 9999, [SECURITY_POLICY_KEYS.activityLogDays]: -5 }));
    expect(err.message).toBe('the security policy is not available');
    expect(Object.keys(err.details).sort()).toEqual(['field', 'reason']);
    expect(exposed(err)).not.toContain('9999');
    expect(exposed(err)).not.toContain('-5');
  });
  it('keeps the activity log at least 30 days and the trusted window at most a year (the PRD-visible limits)', () => {
    expect(SECURITY_POLICY_BOUNDS.activityLogDays[0]).toBe(30);
    expect(SECURITY_POLICY_BOUNDS.trustedBrowserDays[1]).toBe(365);
    expect(SECURITY_POLICY_BOUNDS.keepSignedInDays[1]).toBe(90);
  });
  it('does not mutate its input', () => {
    const input = { ...SEEDED };
    const frozen = Object.freeze({ ...SEEDED });
    parseSecurityPolicy(input);
    parseSecurityPolicy(frozen);
    expect(input).toEqual(SEEDED);
  });
});

// ====================================================================== assertSecurityPolicy
describe('assertSecurityPolicy', () => {
  it('returns an equal copy of a valid policy', () => {
    const copy = assertSecurityPolicy(SEEDED_SECURITY_POLICY);
    expect(copy).toEqual(SEEDED_SECURITY_POLICY);
    expect(copy).not.toBe(SEEDED_SECURITY_POLICY);
  });
  it.each(FIELDS)('%s: applies the bounds of the parser', (field) => {
    const [min, max] = SECURITY_POLICY_BOUNDS[field];
    expectInvalid(() => assertSecurityPolicy({ ...SEEDED_SECURITY_POLICY, [field]: min - 1 }), field);
    expectInvalid(() => assertSecurityPolicy({ ...SEEDED_SECURITY_POLICY, [field]: max + 1 }), field);
    expectInvalid(() => assertSecurityPolicy({ ...SEEDED_SECURITY_POLICY, [field]: 'x' as unknown as number }), field);
    expect(assertSecurityPolicy({ ...SEEDED_SECURITY_POLICY, [field]: max })[field]).toBe(max);
  });
  it('refuses a policy with a missing field', () => {
    const partial = { ...SEEDED_SECURITY_POLICY } as Partial<SecurityPolicy>;
    delete partial.stepUpValidMinutes;
    expectInvalid(() => assertSecurityPolicy(partial as SecurityPolicy), 'stepUpValidMinutes');
  });
});

// ====================================================================== StaticSecurityPolicyProvider
describe('StaticSecurityPolicyProvider', () => {
  it('serves a validated copy and counts reads', async () => {
    const provider = new StaticSecurityPolicyProvider({ ...SEEDED_SECURITY_POLICY });
    expect(provider.reads).toBe(0);
    const p = await provider.policy();
    expect(p).toEqual(SEEDED_SECURITY_POLICY);
    expect(provider.reads).toBe(1);
    p.trustedBrowserDays = 1;
    expect((await provider.policy()).trustedBrowserDays).toBe(30);
  });
  it('picks up a replaced value on the next read (a configuration change between two calls)', async () => {
    const provider = new StaticSecurityPolicyProvider({ ...SEEDED_SECURITY_POLICY });
    provider.set({ ...SEEDED_SECURITY_POLICY, trustedBrowserDays: 7 });
    expect((await provider.policy()).trustedBrowserDays).toBe(7);
  });
  it('rejects an invalid value on read, like the real provider path does', async () => {
    const provider = new StaticSecurityPolicyProvider({ ...SEEDED_SECURITY_POLICY, resetMaxRequestsPerHour: 0 });
    await expect(provider.policy()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID', field: 'resetMaxRequestsPerHour' } });
  });
});
