// Unit tests of the email additions of mapDbError (ID-002): the unique-index and guard-trigger failures of identity.email_contacts and
// identity.email_verification_challenges become typed errors with fixed messages. Classification uses the SQLSTATE, the constraint name and the
// `identity_rule:<KEY>` detail, never the message text, and no constraint name, address, table or driver text reaches the typed error.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_ERROR_CODES, EMAIL_ERROR_CODES } from '@bananagig/contracts';
import { AccountError } from './errors';
import { mapDbError } from './service';

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
  table: 'email_contacts',
  message: 'duplicate key value violates unique constraint "driver-text-marker"',
  detail: 'Key (email_normalized)=(ana@example.test) already exists.',
  ...extra,
});
const guard = (key: string, message = 'driver message naming identity.email_contacts and ana@example.test') => ({
  code: '23000',
  message,
  detail: `identity_rule:${key}`,
  table: 'email_contacts',
  constraint: 'ck_email_contacts__status',
});

describe('mapDbError: a verified address held by another account (uq_email_contacts__verified_address)', () => {
  it('maps a 23505 on the verified-address index to EMAIL_UNAVAILABLE / ADDRESS_UNAVAILABLE', () => {
    const e = mapped(unique('uq_email_contacts__verified_address'));
    expect(e.code).toBe('EMAIL_UNAVAILABLE');
    expect(e.details).toEqual({ reason: 'ADDRESS_UNAVAILABLE' });
    expect(e.message).toBe('this email address cannot be verified for this account');
  });
  it('carries no constraint name, table, driver text or address', () => {
    const text = exposed(mapped(unique('uq_email_contacts__verified_address')));
    for (const leak of ['uq_email_contacts', 'verified_address', 'email_contacts', 'email_normalized', 'ana@example.test', 'driver-text-marker', '23505']) {
      expect(text, leak).not.toContain(leak);
    }
    expect(Object.keys(mapped(unique('uq_email_contacts__verified_address')).details)).toEqual(['reason']);
  });
  it('is a typed email code known to the public contract', () => {
    expect(EMAIL_ERROR_CODES).toContain('EMAIL_UNAVAILABLE');
    expect(ACCOUNT_ERROR_CODES).toContain('EMAIL_UNAVAILABLE');
  });
  it('does not depend on the SQLSTATE alone: another constraint name, or the same name under another SQLSTATE, is not EMAIL_UNAVAILABLE', () => {
    expect(mapped(unique('uq_email_contacts__verified_address_other')).code).toBe('CONFLICT');
    expect(mapped(unique('UQ_EMAIL_CONTACTS__VERIFIED_ADDRESS')).code).toBe('CONFLICT');
    expect(mapped({ code: '23514', constraint: 'uq_email_contacts__verified_address' }).code).toBe('VALIDATION_FAILED');
    expect(mapped({ code: '23503', constraint: 'uq_email_contacts__verified_address' }).code).toBe('VALIDATION_FAILED');
  });
  it('gives the SQLSTATE precedence over a detail that looks like a guard key', () => {
    const e = mapped(unique('uq_email_contacts__verified_address', { detail: 'identity_rule:EMAIL_INVARIANT' }));
    expect(e.code).toBe('EMAIL_UNAVAILABLE');
  });
});

describe('mapDbError: a concurrent change of the same account email rows is a retryable CONFLICT', () => {
  it.each([
    'uq_email_contacts__primary_per_account',
    'uq_email_contacts__open_per_account',
    'uq_email_contacts__live_address_per_account',
    'uq_email_verification_challenges__open_per_contact',
  ])('maps a 23505 on %s to CONFLICT CONCURRENT_UPDATE retryable', (constraint) => {
    const e = mapped(unique(constraint));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expect(e.message).toBe('the change conflicted with a concurrent update; repeat the request');
    const text = exposed(e);
    for (const leak of [constraint, 'email_contacts', 'email_verification_challenges', 'ana@example.test', 'driver-text-marker'])
      expect(text, leak).not.toContain(leak);
  });
  it('does not mistake these indexes for the verified-address rule (no EMAIL_UNAVAILABLE)', () => {
    for (const constraint of [
      'uq_email_contacts__primary_per_account',
      'uq_email_contacts__open_per_account',
      'uq_email_contacts__live_address_per_account',
      'uq_email_verification_challenges__open_per_contact',
    ]) {
      expect(mapped(unique(constraint)).code).not.toBe('EMAIL_UNAVAILABLE');
    }
  });
});

describe('mapDbError: any other unique violation is still a DUPLICATE', () => {
  it.each([
    'uq_email_verification_challenges__magic_token_hash',
    'pk_email_contacts',
    'pk_email_verification_challenges',
    'uq_external_identities__provider_issuer_subject',
    'uq_email_contacts__something_new',
  ])('maps a 23505 on %s to CONFLICT DUPLICATE carrying the constraint name', (constraint) => {
    const e = mapped(unique(constraint));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'DUPLICATE', constraint });
    expect(e.message).toBe('a record with this identity already exists');
    expect(exposed(e)).not.toContain('ana@example.test');
  });
  it('maps a 23505 without a constraint name to DUPLICATE as well', () => {
    const e = mapped({ code: '23505' });
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toMatchObject({ reason: 'DUPLICATE' });
  });
});

describe('mapDbError: the email guard triggers (SQLSTATE 23000, identity_rule detail) are INVALID_STATE carrying the rule as the reason', () => {
  const EMAIL_RULES = [
    'EMAIL_INITIAL_WITH_PRIMARY',
    'EMAIL_REPLACEMENT_WITHOUT_PRIMARY',
    'EMAIL_PRIMARY_NOT_REPLACEABLE',
    'EMAIL_PRIMARY_CHANGE',
    'EMAIL_STATUS_TRANSITION',
    'EMAIL_INVARIANT',
    'CHALLENGE_NOT_OPEN',
    'CHALLENGE_PURPOSE',
    'CHALLENGE_STATE',
    'CHALLENGE_CLOSED',
    'CHALLENGE_ATTEMPTS',
    'CHALLENGE_DELIVERY',
    'CHALLENGE_CONSUMPTION',
  ];
  it('covers the thirteen rules of migration 0010', () => {
    expect(new Set(EMAIL_RULES).size).toBe(13);
  });
  it.each(EMAIL_RULES)('maps %s to INVALID_STATE with details.reason = the rule key', (rule) => {
    const e = mapped(guard(rule));
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({ reason: rule });
    expect(e.message).toBe('the operation is not allowed in the current state');
  });
  it.each(EMAIL_RULES)('%s ignores the driver message text (a message naming another rule does not change the result)', (rule) => {
    const noisy = mapped(guard(rule, 'identity_rule:ACCOUNT_CLOSED NOT_DELETABLE ROW_IMMUTABLE'));
    expect(noisy.code).toBe('INVALID_STATE');
    expect(noisy.details).toEqual({ reason: rule });
  });
  it.each(EMAIL_RULES)('%s never leaks the driver message, table, constraint or address', (rule) => {
    const text = exposed(mapped(guard(rule)));
    for (const leak of ['driver message', 'identity.email_contacts', 'email_contacts', 'ck_email_contacts__status', 'ana@example.test', '23000']) {
      expect(text, `${rule} leaks ${leak}`).not.toContain(leak);
    }
  });
  it('keeps the older rules unchanged next to the new ones (ACCOUNT_CLOSED, IMMUTABLE_IDENTITY and NOT_DELETABLE of the email tables)', () => {
    expect(mapped(guard('ACCOUNT_CLOSED'))).toMatchObject({ code: 'CLOSED', details: { reason: 'ACCOUNT_CLOSED' } });
    expect(mapped(guard('IMMUTABLE_IDENTITY'))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'IMMUTABLE' } });
    expect(mapped(guard('NOT_DELETABLE'))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'IMMUTABLE' } });
  });
  it('maps a lower-case or unknown email-like rule to the generic INVALID_STATE without a reason', () => {
    for (const detail of ['identity_rule:email_invariant', 'identity_rule:EMAIL_SOMETHING_NEW', 'identity_rule:CHALLENGE_']) {
      const e = mapped({ code: '23000', detail });
      expect(e.code).toBe('INVALID_STATE');
      expect(e.details).toEqual({});
    }
  });
});

describe('mapDbError: check and foreign-key violations of the email tables are VALIDATION_FAILED without values', () => {
  it.each([
    'ck_email_contacts__status',
    'ck_email_contacts__email_normalized',
    'ck_email_verification_challenges__attempts',
    'ck_account_audit_events__email_contact',
  ])('maps a 23514 on %s to VALIDATION_FAILED carrying only the constraint', (constraint) => {
    const e = mapped({ code: '23514', constraint, detail: 'Failing row contains (ana@example.test).' });
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ constraint });
    expect(exposed(e)).not.toContain('ana@example.test');
  });
  it('maps a 23503 on the account foreign key to VALIDATION_FAILED', () => {
    const e = mapped({ code: '23503', constraint: 'fk_email_contacts__account_id', detail: 'Key (account_id)=(x) is not present.' });
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ constraint: 'fk_email_contacts__account_id' });
  });
});
