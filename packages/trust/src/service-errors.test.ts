// Unit tests of the database error translation of the verification service (TRUST-001): `guardRuleOf` and `mapDbError`. No database: driver errors are plain objects shaped like
// node-postgres errors. Every guard rule key of migration 0019 is covered; no driver text, SQL, constraint or table name may reach a typed error.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRUST_ERROR_CODES, type TrustErrorCode } from '@bananagig/contracts';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@bananagig/observability', async (orig) => ({ ...(await orig<object>()), log: vi.fn() }));

const { TrustError } = await import('./errors');
const { guardRuleOf, mapDbError } = await import('./service');
const { log } = await import('@bananagig/observability');

const DRIVER_TEXT =
  'duplicate key value violates unique constraint "uq_secret_table_name" Key (account_id)=(11111111-2222-3333-4444-555555555555) SELECT * FROM trust.documents';
const guard = (rule: string | undefined, over: Record<string, unknown> = {}) =>
  Object.assign(new Error(DRIVER_TEXT), { code: '23000', detail: rule === undefined ? undefined : `trust_rule:${rule}`, ...over });
const caught = (err: unknown): InstanceType<typeof TrustError> => {
  try {
    mapDbError(err);
  } catch (e) {
    expect(e).toBeInstanceOf(TrustError);
    return e as InstanceType<typeof TrustError>;
  }
  throw new Error('mapDbError must throw');
};
const expectClean = (e: InstanceType<typeof TrustError>) => {
  const text = JSON.stringify({ message: e.message, details: e.details });
  for (const leak of ['duplicate key', 'uq_secret_table_name', 'SELECT', 'trust.documents', '11111111', 'unique constraint', 'violates unique'])
    expect(text).not.toContain(leak);
};

describe('guardRuleOf', () => {
  it('extracts the rule key from a trust_rule detail', () => {
    expect(guardRuleOf('trust_rule:CASE_FROZEN')).toBe('CASE_FROZEN');
    expect(guardRuleOf('trust_rule:X')).toBe('X');
  });
  it.each([
    '',
    'trust_rule:',
    'trust_rule:lower',
    'trust_rule:A1',
    'trust_rule:_A',
    'trust_rule:A B',
    'trust_rule:A\n',
    'x trust_rule:A',
    'trust_rule:A trailing',
    'TRUST_RULE:A',
    'rule:A',
    'trust_rule: A',
  ])('returns undefined for the unanchored or malformed detail %j', (d) => {
    expect(guardRuleOf(d)).toBeUndefined();
  });
  it.each([undefined, null, 5, {}, ['trust_rule:A'], true])('returns undefined for the non-string detail %j', (d) => {
    expect(guardRuleOf(d)).toBeUndefined();
  });
});

describe('mapDbError: pass-through', () => {
  it('rethrows a TrustError as the same instance', () => {
    const t = new TrustError('NOT_FOUND', 'nothing');
    expect(() => mapDbError(t)).toThrow(t);
    try {
      mapDbError(t);
    } catch (e) {
      expect(e).toBe(t);
    }
  });
  it.each([null, undefined, 'text', 42, true])('rethrows the non-object %j unchanged', (v) => {
    try {
      mapDbError(v);
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBe(v);
    }
  });
  it('rethrows an unknown error (a programming error or an unclassified SQLSTATE) as the same instance', () => {
    for (const err of [
      new TypeError('x is not a function'),
      Object.assign(new Error('boom'), { code: 'XX000' }),
      Object.assign(new Error('bad'), { code: '42703' }),
    ]) {
      try {
        mapDbError(err);
        throw new Error('did not throw');
      } catch (e) {
        expect(e).toBe(err);
      }
    }
  });
});

describe('mapDbError: concurrency and class mappings', () => {
  it.each(['40P01', '40001', '55P03'])('SQLSTATE %s is a retryable CONFLICT / CONCURRENT_UPDATE', (code) => {
    const e = caught(Object.assign(new Error(DRIVER_TEXT), { code }));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expectClean(e);
  });
  it.each(['22021', '22P05'])('SQLSTATE %s is VALIDATION_FAILED / FORBIDDEN_CHARACTER', (code) => {
    const e = caught(Object.assign(new Error(DRIVER_TEXT), { code }));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ reason: 'FORBIDDEN_CHARACTER' });
    expectClean(e);
  });
  it('23505 on the one-decision-per-round constraint is ALREADY_DECIDED', () => {
    const e = caught(Object.assign(new Error(DRIVER_TEXT), { code: '23505', constraint: 'uq_reviews__decision' }));
    expect(e.code).toBe('ALREADY_DECIDED');
    expect(e.details).toEqual({ reason: 'ALREADY_DECIDED' });
    expectClean(e);
  });
  it.each(['uq_verification_cases__live', 'uq_something_else', undefined])('23505 on %s is a plain CONFLICT (retryable)', (constraint) => {
    const e = caught(Object.assign(new Error(DRIVER_TEXT), { code: '23505', constraint }));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toMatchObject({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expectClean(e);
  });
  it('23503 is VALIDATION_FAILED / REFERENCE_NOT_FOUND', () => {
    const e = caught(Object.assign(new Error(DRIVER_TEXT), { code: '23503' }));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ reason: 'REFERENCE_NOT_FOUND' });
    expectClean(e);
  });
});

describe('mapDbError: guard rules (SQLSTATE 23000, DETAIL trust_rule:KEY)', () => {
  const MAPPING: [string, TrustErrorCode][] = [
    ['ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_ACTIVE'],
    ['REVIEW_ROUND', 'STALE_ROUND'],
    ['ROUND_SEQUENCE', 'STALE_ROUND'],
    ['REASON_INACTIVE', 'REASON_INVALID'],
    ['REASON_NOT_APPLICABLE', 'REASON_INVALID'],
    ['EXPIRY_REQUIRED', 'VALIDATION_FAILED'],
    ['EXPIRY_IN_PAST', 'VALIDATION_FAILED'],
    ['DOCUMENT_TYPE_MISMATCH', 'DOCUMENT_TYPE_NOT_ACCEPTED'],
    ['DOCUMENT_NOT_SUPPORTED', 'EVIDENCE_NOT_ACCEPTED'],
    ['EXTERNAL_NOT_SUPPORTED', 'EVIDENCE_NOT_ACCEPTED'],
    ['CASE_FROZEN', 'INVALID_STATE'],
    ['SUPERSEDED_FROZEN', 'INVALID_STATE'],
    ['SUPERSEDE_STATE', 'INVALID_STATE'],
    ['STATUS_TRANSITION', 'INVALID_STATE'],
    ['DOCUMENT_FROZEN', 'INVALID_STATE'],
    ['DOCUMENT_REQUIREMENT_STATE', 'INVALID_STATE'],
    ['DOCUMENT_ROUND', 'INVALID_STATE'],
    ['EXTERNAL_STATE', 'INVALID_STATE'],
    ['EXTERNAL_FROZEN', 'INVALID_STATE'],
    ['REVIEW_STATE', 'INVALID_STATE'],
    ['REVIEW_SUPERSEDED', 'INVALID_STATE'],
    ['REQUIREMENT_NOT_ACTIVE', 'INVALID_STATE'],
    ['CYCLE_NEEDS_EXPIRED', 'INVALID_STATE'],
    ['EXPIRY_NOT_REACHED', 'INVALID_STATE'],
  ];
  it.each(MAPPING)('%s maps to %s and keeps the rule key as the machine-readable reason', (rule, code) => {
    const e = caught(guard(rule));
    expect(e.code).toBe(code);
    expect(e.details).toEqual({ reason: rule });
    expectClean(e);
  });
  it('uses a fixed message per mapping (the same for every rule of a group)', () => {
    expect(caught(guard('REVIEW_ROUND')).message).toBe(caught(guard('ROUND_SEQUENCE')).message);
    expect(caught(guard('CASE_FROZEN')).message).toBe(caught(guard('EXPIRY_NOT_REACHED')).message);
    expect(caught(guard('REASON_INACTIVE')).message).toBe('that reason cannot be used for this decision');
    expect(caught(guard('CASE_FROZEN')).message).toBe('that is not possible in the current state');
  });

  // The rest of the rule keys are integrity violations: CONFLICT carrying only the key.
  const INTEGRITY = [
    'NOT_DELETABLE',
    'IMMUTABLE_IDENTITY',
    'INITIAL_STATUS',
    'RULE_DEFINITION_RETIRED',
    'CASE_MUST_START_OPEN',
    'CASE_NUMBER_SEQUENCE',
    'REVISION_ONLY_GROWS',
    'MUST_START_NOT_STARTED',
    'CYCLE_SEQUENCE',
    'FIELDS_FROZEN',
    'DOCUMENT_MUST_START_PENDING',
    'HASH_IMMUTABLE',
    'SCAN_TRANSITION',
    'REVIEW_EXPIRY',
    'ROW_IMMUTABLE',
  ];
  it.each(INTEGRITY)('%s is a CONFLICT integrity violation with only the rule key as detail', (rule) => {
    const e = caught(guard(rule));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: rule });
    expect(e.message).toBe('the operation violates a verification integrity rule');
    expectClean(e);
  });
  it('an unknown rule key is also a CONFLICT with that key', () => {
    expect(caught(guard('SOMETHING_NEW'))).toMatchObject({ code: 'CONFLICT', details: { reason: 'SOMETHING_NEW' } });
  });
  it.each([undefined, 'not a trust rule', 'trust_rule:lower', 'constraint violated'])(
    'a 23000 without a parsable rule (%j) is a CONFLICT with empty details',
    (detail) => {
      const e = caught(Object.assign(new Error(DRIVER_TEXT), { code: '23000', detail }));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({});
      expectClean(e);
    },
  );
  it('every guard key of migration 0019 is translated to a typed, clean error (the mapping table cannot lag the SQL)', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../../db/migrations/0019_trust_verification.sql', import.meta.url)), 'utf8');
    const keys = new Set([...sql.matchAll(/trust_rule:([A-Z][A-Z_]*)/g)].map((m) => m[1]!));
    expect(keys.size).toBeGreaterThanOrEqual(39);
    const known = new Set([...MAPPING.map(([k]) => k), ...INTEGRITY]);
    for (const k of keys) {
      expect(known.has(k), `guard rule ${k} is not covered by the mapping tests`).toBe(true);
      expectClean(caught(guard(k)));
    }
    for (const k of known) expect(keys.has(k), `${k} is in the tests but not in the migration`).toBe(true);
  });
  it('only produces codes that are declared in TRUST_ERROR_CODES', () => {
    for (const [rule] of [...MAPPING, ...INTEGRITY.map((r) => [r])])
      expect(TRUST_ERROR_CODES as readonly string[]).toContain(caught(guard(rule as string)).code);
  });
});

describe('mapDbError: database outage', () => {
  it.each([
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error(DRIVER_TEXT), { code: '57P01' }),
    new Error('Connection terminated unexpectedly'),
  ])('maps %s to UNAVAILABLE with a fixed message and logs the cause', (err) => {
    vi.mocked(log).mockClear();
    const e = caught(err);
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toBe('verification is unavailable');
    expect(e.details).toEqual({});
    expectClean(e);
    expect(log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log).mock.calls[0]![0]).toBe('error');
  });
  it('does not log for the data-layer mappings', () => {
    vi.mocked(log).mockClear();
    caught(guard('CASE_FROZEN'));
    caught(Object.assign(new Error('x'), { code: '40P01' }));
    expect(log).not.toHaveBeenCalled();
  });
});
