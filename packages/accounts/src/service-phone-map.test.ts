// Unit tests of the phone additions of mapDbError (ID-003): the unique-index, number-cap and guard-trigger failures of identity.phone_contacts and
// identity.phone_verification_challenges become typed errors with fixed messages. Classification uses the SQLSTATE, the constraint name and the
// `identity_rule:<KEY>` detail, never the message text, and no constraint name, number, table or driver text reaches the typed error.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_ERROR_CODES, PHONE_ERROR_CODES } from '@bananagig/contracts';
import { AccountError } from './errors';
import { mapDbError } from './service';

const NUMBER = '+12025550142';
const exposed = (err: unknown): string => inspect(err, { depth: 8, showHidden: false });
const mapped = (e: unknown): AccountError => {
  try {
    mapDbError(e);
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError);
    return err as AccountError;
  }
  throw new Error('mapDbError did not throw');
};
const unique = (constraint: string | undefined, extra: Record<string, unknown> = {}) => ({
  code: '23505',
  constraint,
  table: 'phone_contacts',
  message: 'duplicate key value violates unique constraint "driver-text-marker"',
  detail: `Key (phone_e164)=(${NUMBER}) already exists.`,
  ...extra,
});
const guard = (key: string, message = `driver message naming identity.phone_contacts and ${NUMBER}`) => ({
  code: '23000',
  message,
  detail: `identity_rule:${key}`,
  table: 'phone_contacts',
  constraint: 'ck_phone_contacts__status',
});

const PHONE_RULES = [
  'PHONE_INITIAL_WITH_PRIMARY',
  'PHONE_REPLACEMENT_WITHOUT_PRIMARY',
  'PHONE_PRIMARY_NOT_REPLACEABLE',
  'PHONE_PRIMARY_CHANGE',
  'PHONE_STATUS_TRANSITION',
  'PHONE_INVARIANT',
  'PHONE_CHALLENGE_NOT_OPEN',
  'PHONE_CHALLENGE_PURPOSE',
  'PHONE_CHALLENGE_STATE',
  'PHONE_CHALLENGE_CLOSED',
  'PHONE_CHALLENGE_ATTEMPTS',
  'PHONE_CHALLENGE_DELIVERY',
  'PHONE_CHALLENGE_CONSUMPTION',
];
const PHONE_CONCURRENT_INDEXES = [
  'uq_phone_contacts__primary_per_account',
  'uq_phone_contacts__open_per_account',
  'uq_phone_contacts__live_number_per_account',
  'uq_phone_verification_challenges__open_per_contact',
];

// ====================================================================== guard rules
describe('mapDbError: the phone guard triggers (SQLSTATE 23000, identity_rule detail) are INVALID_STATE carrying the rule as the reason', () => {
  it('covers the thirteen state rules of migration 0011', () => {
    expect(new Set(PHONE_RULES).size).toBe(13);
  });
  it.each(PHONE_RULES)('maps %s to INVALID_STATE with details.reason = the rule key', (rule) => {
    const e = mapped(guard(rule));
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({ reason: rule });
    expect(e.message).toBe('the operation is not allowed in the current state');
    expect(e).toBeInstanceOf(AccountError);
    expect(e.name).toBe('AccountError');
  });
  it.each(PHONE_RULES)('%s ignores the driver message text (a message naming another rule does not change the result)', (rule) => {
    const noisy = mapped(guard(rule, 'identity_rule:ACCOUNT_CLOSED NOT_DELETABLE ROW_IMMUTABLE PHONE_NUMBER_CAP'));
    expect(noisy.code).toBe('INVALID_STATE');
    expect(noisy.details).toEqual({ reason: rule });
  });
  it.each(PHONE_RULES)('%s never leaks the driver message, table, constraint or number', (rule) => {
    const text = exposed(mapped(guard(rule)));
    for (const leak of ['driver message', 'identity.phone_contacts', 'phone_contacts', 'ck_phone_contacts__status', NUMBER, '2025550142', '23000']) {
      expect(text, `${rule} leaks ${leak}`).not.toContain(leak);
    }
  });
  it.each(PHONE_RULES)('%s is classified by the detail, not by the SQLSTATE class of another code', (rule) => {
    expect(mapped({ code: '23000', detail: `identity_rule:${rule}` }).details).toEqual({ reason: rule });
  });
  it('maps the phone rules next to the email rules without confusing them', () => {
    expect(mapped(guard('EMAIL_INVARIANT')).details).toEqual({ reason: 'EMAIL_INVARIANT' });
    expect(mapped(guard('PHONE_INVARIANT')).details).toEqual({ reason: 'PHONE_INVARIANT' });
    expect(mapped(guard('CHALLENGE_STATE')).details).toEqual({ reason: 'CHALLENGE_STATE' });
    expect(mapped(guard('PHONE_CHALLENGE_STATE')).details).toEqual({ reason: 'PHONE_CHALLENGE_STATE' });
  });
  it('keeps the older rules unchanged next to the phone ones', () => {
    expect(mapped(guard('ACCOUNT_CLOSED'))).toMatchObject({ code: 'CLOSED', details: { reason: 'ACCOUNT_CLOSED' } });
    expect(mapped(guard('IMMUTABLE_IDENTITY'))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'IMMUTABLE' } });
    expect(mapped(guard('NOT_DELETABLE'))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'IMMUTABLE' } });
  });
  it.each(['identity_rule:phone_invariant', 'identity_rule:PHONE_SOMETHING_NEW', 'identity_rule:PHONE_', 'identity_rule:PHONE_CHALLENGE_', 'PHONE_INVARIANT'])(
    'maps the lower-case, unknown or unprefixed rule detail %j to the generic INVALID_STATE without a reason',
    (detail) => {
      const e = mapped({ code: '23000', detail });
      expect(e.code).toBe('INVALID_STATE');
      expect(e.details).toEqual({});
      expect(e.message).toBe('the operation violates an account integrity rule');
    },
  );
  it('maps a guard failure without a detail to the generic INVALID_STATE', () => {
    expect(mapped({ code: '23000' }).details).toEqual({});
    expect(mapped({ code: '23000', detail: undefined }).code).toBe('INVALID_STATE');
  });
});

// ====================================================================== number cap
describe('mapDbError: a number verified on the maximum number of accounts (PHONE_NUMBER_CAP, SQLSTATE 23000)', () => {
  it('maps the cap rule to PHONE_UNAVAILABLE with reason NUMBER_UNAVAILABLE', () => {
    const e = mapped(guard('PHONE_NUMBER_CAP'));
    expect(e.code).toBe('PHONE_UNAVAILABLE');
    expect(e.details).toEqual({ reason: 'NUMBER_UNAVAILABLE' });
    expect(e.message).toBe('this phone number cannot be verified for this account');
  });
  it('is not an INVALID_STATE', () => {
    expect(mapped(guard('PHONE_NUMBER_CAP')).code).not.toBe('INVALID_STATE');
  });
  it('carries no constraint name, table, driver text, SQLSTATE or number', () => {
    const e = mapped(guard('PHONE_NUMBER_CAP'));
    const text = exposed(e);
    for (const leak of [
      'driver message',
      'identity.phone_contacts',
      'phone_contacts',
      'ck_phone_contacts__status',
      NUMBER,
      '2025550142',
      '23000',
      'PHONE_NUMBER_CAP',
      'identity_rule',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(Object.keys(e.details)).toEqual(['reason']);
  });
  it('is a typed phone code known to the public contract', () => {
    expect(PHONE_ERROR_CODES).toContain('PHONE_UNAVAILABLE');
    expect(ACCOUNT_ERROR_CODES).toContain('PHONE_UNAVAILABLE');
  });
  it('depends on the SQLSTATE 23000: the same detail under another SQLSTATE is not PHONE_UNAVAILABLE', () => {
    expect(mapped({ code: '23514', detail: 'identity_rule:PHONE_NUMBER_CAP' }).code).toBe('VALIDATION_FAILED');
    expect(mapped({ code: '23503', detail: 'identity_rule:PHONE_NUMBER_CAP' }).code).toBe('VALIDATION_FAILED');
  });
  it('does not depend on the message text (a message mentioning the rule on another rule changes nothing)', () => {
    expect(mapped({ code: '23000', detail: 'identity_rule:PHONE_INVARIANT', message: 'identity_rule:PHONE_NUMBER_CAP' }).code).toBe('INVALID_STATE');
    expect(mapped({ code: '23000', detail: 'identity_rule:PHONE_NUMBER_CAP', message: 'something unrelated' }).code).toBe('PHONE_UNAVAILABLE');
  });
  it('rejects a lower-case or extended rule name', () => {
    expect(mapped({ code: '23000', detail: 'identity_rule:phone_number_cap' }).code).toBe('INVALID_STATE');
    expect(mapped({ code: '23000', detail: 'identity_rule:PHONE_NUMBER_CAP_X' }).code).toBe('INVALID_STATE');
    expect(mapped({ code: '23000', detail: 'identity_rule:PHONE_NUMBER_CAP_X' }).details).toEqual({});
  });
  it('does not treat a unique violation as the cap', () => {
    expect(mapped(unique('uq_phone_contacts__live_number_per_account', { detail: 'identity_rule:PHONE_NUMBER_CAP' })).code).toBe('CONFLICT');
  });
});

// ====================================================================== concurrent changes of the same account
describe('mapDbError: a concurrent change of the same account phone rows is a retryable CONFLICT', () => {
  it.each(PHONE_CONCURRENT_INDEXES)('maps a 23505 on %s to CONFLICT CONCURRENT_UPDATE retryable', (constraint) => {
    const e = mapped(unique(constraint));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expect(e.message).toBe('the change conflicted with a concurrent update; repeat the request');
  });
  it.each(PHONE_CONCURRENT_INDEXES)('%s leaks no constraint name, table, number or driver text', (constraint) => {
    const text = exposed(mapped(unique(constraint)));
    for (const leak of [constraint, 'phone_contacts', 'phone_verification_challenges', 'phone_e164', NUMBER, '2025550142', 'driver-text-marker', '23505']) {
      expect(text, leak).not.toContain(leak);
    }
  });
  it.each(PHONE_CONCURRENT_INDEXES)('%s does not become PHONE_UNAVAILABLE', (constraint) => {
    expect(mapped(unique(constraint)).code).toBe('CONFLICT');
    expect(mapped(unique(constraint)).code).not.toBe('PHONE_UNAVAILABLE');
  });
  it.each(PHONE_CONCURRENT_INDEXES)('%s needs SQLSTATE 23505: under 23514 it is a check failure, under 23503 a reference failure', (constraint) => {
    expect(mapped({ code: '23514', constraint }).code).toBe('VALIDATION_FAILED');
    expect(mapped({ code: '23503', constraint }).code).toBe('VALIDATION_FAILED');
  });
  it('keeps the email concurrency indexes mapped the same way', () => {
    for (const constraint of [
      'uq_email_contacts__primary_per_account',
      'uq_email_contacts__open_per_account',
      'uq_email_contacts__live_address_per_account',
      'uq_email_verification_challenges__open_per_contact',
    ]) {
      expect(mapped(unique(constraint)).details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    }
  });
  it.each(['40P01', '40001', '55P03'])('maps the SQLSTATE %s (deadlock, serialization, lock timeout) to the same retryable CONFLICT', (code) => {
    const e = mapped({ code, message: 'deadlock detected', detail: `Process 1 waits for ShareLock on ${NUMBER}` });
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expect(exposed(e)).not.toContain(NUMBER);
  });
});

// ====================================================================== other unique violations and constraints
describe('mapDbError: any other phone unique violation is still a DUPLICATE', () => {
  it.each([
    'pk_phone_contacts',
    'pk_phone_verification_challenges',
    'uq_phone_contacts__something_new',
    'uq_phone_verification_challenges__code_hash',
    'UQ_PHONE_CONTACTS__PRIMARY_PER_ACCOUNT',
    'uq_phone_contacts__primary_per_account_other',
  ])('maps a 23505 on %s to CONFLICT DUPLICATE carrying the constraint name', (constraint) => {
    const e = mapped(unique(constraint));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'DUPLICATE', constraint });
    expect(e.message).toBe('a record with this identity already exists');
    expect(exposed(e)).not.toContain(NUMBER);
  });
  it('maps a 23505 without a constraint name to DUPLICATE', () => {
    const e = mapped({ code: '23505' });
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toMatchObject({ reason: 'DUPLICATE' });
  });
  it('gives the SQLSTATE precedence over a detail that looks like a guard key', () => {
    const e = mapped(unique('uq_phone_contacts__primary_per_account', { detail: 'identity_rule:PHONE_INVARIANT' }));
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
  });
});

describe('mapDbError: check and foreign-key violations of the phone tables are VALIDATION_FAILED without values', () => {
  it.each([
    'ck_phone_contacts__status',
    'ck_phone_contacts__phone_e164',
    'ck_phone_verification_challenges__attempts',
    'ck_account_audit_events__phone_contact',
  ])('maps a 23514 on %s to VALIDATION_FAILED carrying only the constraint', (constraint) => {
    const e = mapped({ code: '23514', constraint, detail: `Failing row contains (${NUMBER}).` });
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ constraint });
    expect(exposed(e)).not.toContain(NUMBER);
  });
  it.each(['fk_phone_contacts__account_id', 'fk_account_audit_events__account_phone_contact', 'fk_phone_verification_challenges__phone_contact_id'])(
    'maps a 23503 on %s to VALIDATION_FAILED',
    (constraint) => {
      const e = mapped({ code: '23503', constraint, detail: 'Key (account_id)=(x) is not present.' });
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ constraint });
    },
  );
});

describe('mapDbError: errors that are already typed or are not database errors', () => {
  it('passes an AccountError through unchanged', () => {
    const original = new AccountError('PHONE_NOT_PENDING', 'there is no phone number to verify', { reason: 'X' });
    expect(mapped(original)).toBe(original);
  });
  it('rethrows an unrelated programming error as it is', () => {
    const boom = new TypeError('programming error');
    expect(() => mapDbError(boom)).toThrow(boom);
  });
});
