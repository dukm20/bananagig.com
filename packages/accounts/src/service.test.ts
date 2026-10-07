// Unit tests of the account service that need no PostgreSQL: the database error mapping, the status guards, the request rejections that happen BEFORE
// any database access (proved with a Database that throws when touched) and the service flows against a scripted pg connection (a fake pool client that
// answers by statement, so retries, mapping and the privacy of audit rows and events can be asserted without a server and without a network).
// Behavior that needs real constraints, triggers and locks lives in the identity integration test.
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  AccountCreatedPayload,
  AccountRolePayload,
  AccountStatusChangedPayload,
  ExternalIdentityLinkedPayload,
  IDENTITY_EVENTS,
  ACCOUNT_STATUSES,
  isAccountStatusTransitionAllowed,
  type AccountStatus,
} from '@bananagig/contracts';
import { Database } from '@bananagig/database';
import { AccountError, isDatabaseOutage } from './errors';
import type { VerifiedIdentity } from './identity';
import { AccountService, assertUsable, mapDbError, ruleOf } from './service';

const ISSUER = 'http://issuer-marker-77c1.example/realms/bananagig';
const SUBJECT = 'subject-marker-4be9-0d1f-8a22';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const NEW_ACCOUNT_ID = '9d2b7c64-1f0a-4e55-8c3b-6a1d2e4f5b70';
const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  providerType: 'KEYCLOAK',
  issuer: ISSUER,
  subject: SUBJECT,
  identityRoles: ['customer'],
  ...over,
});

/** A Database that fails the test loudly if anything touches it: the code under test must reject before reading or writing. */
const untouchable = (): Database =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`the database was touched (${String(prop)})`);
      },
    },
  ) as unknown as Database;
const offline = () => new AccountService({ database: untouchable() });

/** Everything an error could expose: message, name, stack, own properties (code, details), cause. */
const exposed = (err: unknown): string => inspect(err, { depth: 8, showHidden: false });
const caught = async (p: Promise<unknown>): Promise<AccountError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError);
    return err as AccountError;
  }
  throw new Error('expected the call to reject');
};
const mapped = (e: unknown): AccountError => {
  try {
    mapDbError(e);
  } catch (err) {
    return err as AccountError;
  }
  throw new Error('mapDbError did not throw');
};
const pgError = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`driver text for ${code}`), { code, ...extra });

let consoleLog: MockInstance<typeof console.log>;
beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ====================================================================== ruleOf
describe('ruleOf', () => {
  it('extracts the guard key of an identity_rule detail', () => {
    expect(ruleOf('identity_rule:ACCOUNT_CLOSED')).toBe('ACCOUNT_CLOSED');
    expect(ruleOf('identity_rule:ROLE_NOT_ACTIVE')).toBe('ROLE_NOT_ACTIVE');
    expect(ruleOf('identity_rule:X')).toBe('X');
  });
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 5],
    ['an object', { detail: 'identity_rule:ACCOUNT_CLOSED' }],
    ['an empty string', ''],
    ['no key', 'identity_rule:'],
    ['a lower-case key', 'identity_rule:account_closed'],
    ['a key with digits', 'identity_rule:RULE_1'],
    ['a key starting with an underscore', 'identity_rule:_RULE'],
    ['a leading prefix', 'x identity_rule:ACCOUNT_CLOSED'],
    ['a trailing suffix', 'identity_rule:ACCOUNT_CLOSED extra'],
    ['a trailing newline', 'identity_rule:ACCOUNT_CLOSED\n'],
    ['a second line', 'identity_rule:ACCOUNT_CLOSED\nidentity_rule:ROLE_IN_USE'],
    ['another namespace', 'geography_rule:ACCOUNT_CLOSED'],
    ['a different case prefix', 'IDENTITY_RULE:ACCOUNT_CLOSED'],
    ['a message-like text', 'violation of identity_rule:ACCOUNT_CLOSED in table accounts'],
  ])('returns undefined for %s', (_label, detail) => {
    expect(ruleOf(detail)).toBeUndefined();
  });
});

// ====================================================================== mapDbError
describe('mapDbError: guard (trigger) failures, SQLSTATE 23000, classified by detail', () => {
  const guard = (key: string, message = 'a message that names identity.accounts and a user value Secret-123') => ({
    code: '23000',
    message,
    detail: `identity_rule:${key}`,
  });

  it('maps ACCOUNT_CLOSED to CLOSED', () => {
    const e = mapped(guard('ACCOUNT_CLOSED'));
    expect(e).toBeInstanceOf(AccountError);
    expect(e.code).toBe('CLOSED');
    expect(e.details).toEqual({ reason: 'ACCOUNT_CLOSED' });
    expect(e.message).toBe('the account is closed');
  });
  it.each(['ROLE_NOT_ACTIVE', 'PRIMARY_ROLE_NOT_ACTIVE'])('maps %s to ROLE_NOT_ACTIVE', (key) => {
    const e = mapped(guard(key));
    expect(e.code).toBe('ROLE_NOT_ACTIVE');
    expect(e.details).toEqual({ reason: key });
  });
  it('maps PRIMARY_ROLE_IN_USE to a retryable CONFLICT (a concurrent update moved the primary role)', () => {
    const e = mapped(guard('PRIMARY_ROLE_IN_USE'));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
  });
  it.each([
    'ACCOUNT_STATUS_TRANSITION',
    'ACCOUNT_HAS_ACTIVE_ROLES',
    'ROLE_IN_USE',
    'ROLE_STATUS_TRANSITION',
    'ACCOUNT_INITIAL_STATE',
    'STATUS_HISTORY_MISMATCH',
  ])('maps %s to INVALID_STATE carrying the guard key as the reason', (key) => {
    const e = mapped(guard(key));
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({ reason: key });
    expect(e.message).toBe('the operation is not allowed in the current state');
  });
  it.each(['IMMUTABLE_IDENTITY', 'NOT_DELETABLE', 'ROW_IMMUTABLE'])('maps %s to INVALID_STATE with the generic reason IMMUTABLE', (key) => {
    const e = mapped(guard(key));
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({ reason: 'IMMUTABLE' });
    expect(e.message).toBe('the record is immutable');
  });
  it('maps an unknown guard key to a generic INVALID_STATE without a reason', () => {
    const e = mapped(guard('SOMETHING_NEW'));
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({});
    expect(e.message).toBe('the operation violates an account integrity rule');
  });
  it('maps a 23000 error with no detail, or a detail of another shape, to the generic INVALID_STATE', () => {
    for (const e of [
      { code: '23000' },
      { code: '23000', detail: undefined },
      { code: '23000', detail: 'identity_rule:account_closed' },
      { code: '23000', detail: 'other:ACCOUNT_CLOSED' },
    ]) {
      const m = mapped(e);
      expect(m.code).toBe('INVALID_STATE');
      expect(m.details).toEqual({});
    }
  });

  describe('the message text is never used for classification', () => {
    const keys = [
      'ACCOUNT_CLOSED',
      'ROLE_NOT_ACTIVE',
      'PRIMARY_ROLE_NOT_ACTIVE',
      'PRIMARY_ROLE_IN_USE',
      'ACCOUNT_STATUS_TRANSITION',
      'ACCOUNT_HAS_ACTIVE_ROLES',
      'ROLE_IN_USE',
      'ROLE_STATUS_TRANSITION',
      'ACCOUNT_INITIAL_STATE',
      'STATUS_HISTORY_MISMATCH',
      'IMMUTABLE_IDENTITY',
      'NOT_DELETABLE',
      'ROW_IMMUTABLE',
    ];
    it('a message that names another key does not change the result', () => {
      for (const key of keys) {
        const plain = mapped({ code: '23000', detail: `identity_rule:${key}`, message: 'neutral' });
        for (const other of keys) {
          const noisy = mapped({ code: '23000', detail: `identity_rule:${key}`, message: `identity_rule:${other} ${other} (${other})` });
          expect({ code: noisy.code, details: noisy.details, message: noisy.message }, `${key} with the message of ${other}`).toEqual({
            code: plain.code,
            details: plain.details,
            message: plain.message,
          });
        }
      }
    });
    it('a message naming a guard key does NOT classify an error that has no usable detail', () => {
      for (const key of keys) {
        const m = mapped({ code: '23000', message: `identity_rule:${key}`, detail: 'something else' });
        expect(m.code).toBe('INVALID_STATE');
        expect(m.details).toEqual({});
      }
    });
    it('ignores a message-only guard text on a non-guard SQLSTATE too', () => {
      expect(mapped({ code: '23514', message: 'identity_rule:ACCOUNT_CLOSED', detail: 'identity_rule:ACCOUNT_CLOSED' }).code).toBe('VALIDATION_FAILED');
    });
  });

  it('never copies the driver message, the detail, a table name or a value into the typed error', () => {
    for (const key of ['ACCOUNT_CLOSED', 'ROLE_IN_USE', 'ROW_IMMUTABLE', 'NOPE']) {
      const e = mapped({
        code: '23000',
        detail: `identity_rule:${key}`,
        message: 'identity.accounts Secret-123',
        table: 'accounts',
        constraint: 'ck_secret',
        where: 'PL/pgSQL function',
      });
      const text = exposed(e);
      for (const leak of ['Secret-123', 'identity.accounts', 'ck_secret', 'PL/pgSQL']) expect(text, `${key} leaks ${leak}`).not.toContain(leak);
    }
  });
});

describe('mapDbError: other SQLSTATEs', () => {
  it.each(['40P01', '40001', '55P03'])('maps %s (deadlock, serialization failure, lock timeout) to a retryable CONFLICT', (code) => {
    const e = mapped(pgError(code));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expect(e.message).toBe('the change conflicted with a concurrent update; repeat the request');
  });
  it('maps 23505 (unique violation) to CONFLICT DUPLICATE carrying the constraint name', () => {
    const e = mapped(
      pgError('23505', { constraint: 'uq_external_identities__provider_issuer_subject', detail: 'Key (issuer, provider_subject)=(x, y) already exists.' }),
    );
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'DUPLICATE', constraint: 'uq_external_identities__provider_issuer_subject' });
    expect(exposed(e)).not.toContain('Key (');
  });
  it('maps 23514 (check violation) to VALIDATION_FAILED', () => {
    const e = mapped(pgError('23514', { constraint: 'ck_account_profiles__first_name', detail: 'Failing row contains (Secret-123).' }));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ constraint: 'ck_account_profiles__first_name' });
    expect(exposed(e)).not.toContain('Secret-123');
  });
  it('maps 23503 (foreign key violation) to VALIDATION_FAILED', () => {
    const e = mapped(
      pgError('23503', { constraint: 'fk_account_profiles__time_zone_id', detail: 'Key (time_zone_id)=(Secret-123) is not present in table "time_zones".' }),
    );
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ constraint: 'fk_account_profiles__time_zone_id' });
    expect(exposed(e)).not.toContain('Secret-123');
  });
  it.each(['22021', '22P05'])('maps %s (character not valid for the encoding) to VALIDATION_FAILED FORBIDDEN_CHARACTER', (code) => {
    const e = mapped(pgError(code));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ reason: 'FORBIDDEN_CHARACTER' });
  });
  it('gives the SQLSTATE precedence: a 23505 whose detail looks like a guard key stays a DUPLICATE', () => {
    expect(mapped({ code: '23505', detail: 'identity_rule:ACCOUNT_CLOSED' }).details).toMatchObject({ reason: 'DUPLICATE' });
  });
});

describe('mapDbError: outages', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', '08006', '08001', '53300', '57P01', '57014', '58030'])(
    'maps the connectivity or server code %s to UNAVAILABLE',
    (code) => {
      const e = mapped(pgError(code));
      expect(e.code).toBe('UNAVAILABLE');
      expect(e.message).toBe('the account database is unavailable');
      expect(e.details).toEqual({});
    },
  );
  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
    'socket hang up',
    'Connection terminated due to connection timeout',
  ])('maps the driver message "%s" to UNAVAILABLE', (message) => {
    expect(mapped(new Error(message)).code).toBe('UNAVAILABLE');
  });
  it('keeps host names, ports, credentials and SQL out of the typed outage error', () => {
    const e = mapped(pgError('ECONNREFUSED', { message: 'connect ECONNREFUSED 10.0.0.5:5432 password=hunter2 SELECT secret FROM identity.accounts' }));
    const text = exposed(e);
    for (const leak of ['10.0.0.5', '5432', 'hunter2', 'SELECT', 'identity.accounts', 'ECONNREFUSED']) expect(text, leak).not.toContain(leak);
  });
  it('logs the outage for operators', () => {
    mapped(pgError('ECONNREFUSED'));
    expect(consoleLog.mock.calls.some((c) => String(c[0]).includes('account database unavailable'))).toBe(true);
  });
});

describe('mapDbError: errors that are not database failures', () => {
  it('passes an AccountError through unchanged (same instance), even an UNAVAILABLE one', () => {
    for (const code of ['NOT_FOUND', 'SUSPENDED', 'ROLE_NOT_HELD', 'UNAVAILABLE', 'CONFLICT'] as const) {
      const original = new AccountError(code, 'typed', { reason: 'X' });
      expect(() => mapDbError(original)).toThrow(original);
      let thrown: unknown;
      try {
        mapDbError(original);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBe(original);
    }
  });
  it.each([
    ['a TypeError', new TypeError('x is not a function')],
    ['a RangeError', new RangeError('Invalid array length')],
    ['a ReferenceError', new ReferenceError('y is not defined')],
    ['a TypeError that mentions a connection', new TypeError('cannot read connection of undefined')],
    ['a plain Error', new Error('boom')],
    ['an undefined_table error', pgError('42P01')],
    ['a syntax error', pgError('42601')],
    ['a string_data_right_truncation error', pgError('22001')],
    ['an invalid_text_representation error', pgError('22P02')],
    ['an in_failed_sql_transaction error', pgError('25P02')],
  ])('rethrows %s unchanged (a programming or SQL error is never reported as an outage or a typed error)', (_label, error) => {
    let thrown: unknown;
    try {
      mapDbError(error);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(error);
  });
  it('rethrows a non-Error value unchanged', () => {
    let thrown: unknown;
    try {
      mapDbError('oops');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe('oops');
  });
});

// ====================================================================== assertUsable
describe('assertUsable', () => {
  it.each(['SUSPENDED', 'CLOSED'] as const)('refuses a %s account and carries the status in the details', (status) => {
    let thrown: unknown;
    try {
      assertUsable(status);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AccountError);
    expect((thrown as AccountError).code).toBe(status);
    expect((thrown as AccountError).details).toEqual({ status });
  });
  it.each(['PENDING', 'ACTIVE', 'CLOSURE_REQUESTED'] as const)('lets a %s account through', (status) => {
    expect(() => assertUsable(status)).not.toThrow();
  });
});

// ====================================================================== isDatabaseOutage
describe('isDatabaseOutage', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'is true for the connectivity code %s',
    (code) => {
      expect(isDatabaseOutage(pgError(code))).toBe(true);
      expect(isDatabaseOutage({ code })).toBe(true);
    },
  );
  it.each(['08000', '08003', '08006', '53000', '53300', '53400', '57P01', '57P02', '57P03', '57014', '58000', '58030'])(
    'is true for the SQLSTATE class of %s (connection, resources, operator, system)',
    (code) => {
      expect(isDatabaseOutage(pgError(code))).toBe(true);
    },
  );
  it.each(['22001', '22021', '22P02', '23000', '23502', '23503', '23505', '23514', '25P02', '40001', '40P01', '42601', '42P01', '42703'])(
    'is false for the SQL-level rejection %s',
    (code) => {
      expect(isDatabaseOutage(pgError(code))).toBe(false);
    },
  );
  it('lets a SQL-level code win over a message that looks like an outage', () => {
    expect(isDatabaseOutage(pgError('23505', { message: 'connection timeout while inserting' }))).toBe(false);
    expect(isDatabaseOutage(Object.assign(new Error('timed out'), { code: '40P01' }))).toBe(false);
  });
  it('is false for typed errors, even when their text mentions a connection', () => {
    expect(isDatabaseOutage(new AccountError('UNAVAILABLE', 'connection lost'))).toBe(false);
    expect(isDatabaseOutage(new AccountError('CONFLICT', 'timeout'))).toBe(false);
  });
  it.each([new TypeError('connection is undefined'), new RangeError('timeout'), new ReferenceError('socket'), new SyntaxError('connect')])(
    'is false for the programming error %s',
    (error) => {
      expect(isDatabaseOutage(error)).toBe(false);
    },
  );
  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    'query timed out',
    'socket hang up',
    'Connection ended',
    'ECONN broke',
    'terminating connection due to administrator command',
  ])('is true for the driver message "%s" when there is no code', (message) => {
    expect(isDatabaseOutage(new Error(message))).toBe(true);
  });
  it.each([new Error('boom'), new Error('duplicate key value'), new Error('')])('is false for an unrelated Error (%s)', (error) => {
    expect(isDatabaseOutage(error)).toBe(false);
  });
  it.each([null, undefined, 'connection refused', 42, {}, { message: 'connection refused' }, []])('is false for the non-Error value %j', (value) => {
    expect(isDatabaseOutage(value)).toBe(false);
  });
});

// ====================================================================== rejections before any database access
describe('AccountService rejects bad input before it touches the database', () => {
  const NAME_MARKER = 'Zq9-typed-name-marker';

  describe('upsertProfile', () => {
    const upsert = (input: Record<string, unknown>, ...actor: [unknown?]) =>
      caught(
        offline().upsertProfile(
          ACCOUNT_ID,
          { firstName: 'Ana', lastName: 'Martinez', ...input },
          { actor: (actor.length > 0 ? actor[0] : `account:${ACCOUNT_ID}`) as string },
        ),
      );

    it('reports an empty first name as REQUIRED with its content key', async () => {
      const e = await upsert({ firstName: '' });
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'INVALID_PROFILE', issues: [{ field: 'firstName', code: 'REQUIRED', messageKey: 'account.error.name_required' }] });
    });
    it('reports a blank, invisible-only or non-string last name as REQUIRED', async () => {
      for (const lastName of ['   ', String.fromCodePoint(0x200b), '\t\n', undefined, null, 5, {}]) {
        const e = await upsert({ lastName });
        expect(e.details.issues, String(lastName)).toEqual([{ field: 'lastName', code: 'REQUIRED', messageKey: 'account.error.name_required' }]);
      }
    });
    it('reports a 51 character name as TOO_LONG and accepts the boundary only past the validation (50 reaches the database)', async () => {
      const e = await upsert({ lastName: 'a'.repeat(51) });
      expect(e.details).toEqual({ reason: 'INVALID_PROFILE', issues: [{ field: 'lastName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }] });
      await expect(offline().upsertProfile(ACCOUNT_ID, { firstName: 'a'.repeat(50), lastName: 'b'.repeat(50) }, { actor: 'x' })).rejects.toThrow(
        'the database was touched',
      );
    });
    it('reports control characters as INVALID_CHARACTERS', async () => {
      const e = await upsert({ firstName: `${NAME_MARKER}${String.fromCharCode(7)}` });
      expect(e.details.issues).toEqual([{ field: 'firstName', code: 'INVALID_CHARACTERS', messageKey: 'account.error.name_invalid_characters' }]);
    });
    it('reports both names at once, first name before last name', async () => {
      const e = await upsert({ firstName: '', lastName: 'x'.repeat(60) });
      expect(e.details.issues).toEqual([
        { field: 'firstName', code: 'REQUIRED', messageKey: 'account.error.name_required' },
        { field: 'lastName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' },
      ]);
    });
    it('carries content keys, not texts: every issue has exactly field, code and messageKey', async () => {
      const e = await upsert({ firstName: '', lastName: 'x'.repeat(60) });
      for (const issue of e.details.issues as Record<string, unknown>[]) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'field', 'messageKey']);
        expect(issue.messageKey).toMatch(/^account\.error\.name_[a-z_]+$/);
      }
    });
    it('never carries any input value in the message, the details, the stack or the cause', async () => {
      const inputs: Record<string, unknown>[] = [
        { firstName: `${NAME_MARKER}${String.fromCharCode(0)}` },
        { firstName: `${NAME_MARKER}${'a'.repeat(60)}` },
        { lastName: `${NAME_MARKER}${String.fromCodePoint(0x202e)}` },
        { firstName: `${NAME_MARKER}-first${'b'.repeat(60)}`, lastName: `${NAME_MARKER}-last${String.fromCharCode(1)}` },
        { preferredLocale: `${NAME_MARKER}_en` },
      ];
      for (const input of inputs) {
        const e = await upsert(input);
        expect(e.code).toBe('VALIDATION_FAILED');
        expect(exposed(e), JSON.stringify(Object.keys(input))).not.toContain(NAME_MARKER);
        expect(JSON.stringify(e.details)).not.toContain('marker');
      }
    });
    it.each(['en_US', ' en-US', 'english', 'en-US-x-extra-thing', '', 'e', 'en--US'])('rejects the invalid locale "%s"', async (preferredLocale) => {
      const e = await upsert({ preferredLocale });
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'preferredLocale' });
    });
    it('rejects a non-string locale and never echoes a locale value', async () => {
      const e = await upsert({ preferredLocale: 123 });
      expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'preferredLocale' });
      const typed = await upsert({ preferredLocale: `${NAME_MARKER}_US` });
      expect(exposed(typed)).not.toContain(NAME_MARKER);
    });
    it.each([
      ['an empty actor', ''],
      ['a blank actor', '   '],
      ['an undefined actor', undefined],
      ['a numeric actor', 5],
      ['an actor of 201 characters', 'a'.repeat(201)],
    ])('rejects %s before validating anything else', async (_label, actor) => {
      const e = await upsert({ firstName: '' }, actor);
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'actor' });
    });
    it('lets a valid request through to the database (the stub then refuses), so the rejections above are the validation, not a blanket failure', async () => {
      await expect(offline().upsertProfile(ACCOUNT_ID, { firstName: 'Ana', lastName: 'Martinez' }, { actor: 'account:x' })).rejects.toThrow(
        'the database was touched (transaction)',
      );
      await expect(
        offline().upsertProfile(
          ACCOUNT_ID,
          { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' },
          { actor: 'a'.repeat(200) },
        ),
      ).rejects.toThrow('the database was touched (transaction)');
    });
  });

  describe('actor and reason of the administrative operations', () => {
    const svc = offline();
    const BAD_ACTORS: [string, unknown][] = [
      ['an empty actor', ''],
      ['a blank actor', '  \t '],
      ['an undefined actor', undefined],
      ['a null actor', null],
      ['a numeric actor', 7],
      ['an actor of 201 characters', 'a'.repeat(201)],
    ];
    const BAD_REASONS: [string, unknown][] = [
      ['an empty reason', ''],
      ['a blank reason', '   '],
      ['a numeric reason', 5],
      ['a reason of 1001 characters', `${NAME_MARKER}${'r'.repeat(1001)}`],
    ];
    const operations: [string, (opts: { actor: unknown; reason?: unknown }) => Promise<unknown>][] = [
      ['grantRole', (o) => svc.grantRole(ACCOUNT_ID, 'CUSTOMER', { source: 'ADMIN', ...o } as never)],
      ['deactivateRole', (o) => svc.deactivateRole(ACCOUNT_ID, 'CUSTOMER', o as never)],
      ['changeStatus', (o) => svc.changeStatus(ACCOUNT_ID, 'SUSPENDED', o as never)],
      ['setPrimaryRole', (o) => svc.setPrimaryRole(ACCOUNT_ID, 'CUSTOMER', o as never)],
      ['setPrimaryRole (clearing)', (o) => svc.setPrimaryRole(ACCOUNT_ID, null, o as never)],
    ];

    describe.each(operations)('%s', (_name, run) => {
      it.each(BAD_ACTORS)('rejects %s without touching the database', async (_label, actor) => {
        const e = await caught(run({ actor }));
        expect(e.code).toBe('VALIDATION_FAILED');
        expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'actor' });
        expect(e.message).toBe('the actor is required');
      });
      it('accepts an actor of exactly 200 characters (it proceeds to the database)', async () => {
        await expect(run({ actor: 'a'.repeat(200) })).rejects.toThrow('the database was touched');
      });
      it('accepts an absent reason (it proceeds to the database)', async () => {
        await expect(run({ actor: 'admin:ops' })).rejects.toThrow('the database was touched');
        await expect(run({ actor: 'admin:ops', reason: null })).rejects.toThrow('the database was touched');
      });
    });

    describe.each(operations.filter(([name]) => name !== 'grantRole'))('%s reasons', (_name, run) => {
      it.each(BAD_REASONS)('rejects %s without touching the database', async (_label, reason) => {
        const e = await caught(run({ actor: 'admin:ops', reason }));
        expect(e.code).toBe('VALIDATION_FAILED');
        expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'reason' });
        expect(exposed(e)).not.toContain(NAME_MARKER);
      });
      it('accepts a reason of exactly 1000 characters (it proceeds to the database)', async () => {
        await expect(run({ actor: 'admin:ops', reason: 'r'.repeat(1000) })).rejects.toThrow('the database was touched');
      });
    });
  });

  describe('ensureAccountForIdentity', () => {
    const invalid: [string, Partial<VerifiedIdentity>, string][] = [
      ['a blank issuer', { issuer: '   ' }, 'issuer'],
      ['an empty subject', { subject: '' }, 'subject'],
      ['an over-long issuer', { issuer: `${ISSUER}/${'x'.repeat(520)}` }, 'issuer'],
      ['an over-long subject', { subject: `${SUBJECT}${'y'.repeat(260)}` }, 'subject'],
      ['a control character in the subject', { subject: `${SUBJECT}${String.fromCharCode(10)}` }, 'subject'],
      ['a control character in the issuer', { issuer: `${ISSUER}${String.fromCharCode(0)}` }, 'issuer'],
      ['an unknown provider type', { providerType: 'GOOGLE' as never }, 'providerType'],
    ];
    it.each(invalid)('rejects %s as VALIDATION_FAILED INVALID_IDENTITY before any database access', async (_label, over, field) => {
      const e = await caught(offline().ensureAccountForIdentity(identity(over)));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'INVALID_IDENTITY', field });
    });
    it('proceeds to the database for a valid identity (the stub then refuses)', async () => {
      await expect(offline().ensureAccountForIdentity(identity())).rejects.toThrow('the database was touched');
    });
  });

  describe('no error of these paths contains the Keycloak subject or issuer', () => {
    it('across every rejection above, for invalid and for valid identity fields', async () => {
      const svc = offline();
      const attempts: (() => Promise<unknown>)[] = [
        () => svc.ensureAccountForIdentity(identity({ issuer: '' })),
        () => svc.ensureAccountForIdentity(identity({ subject: '' })),
        () => svc.ensureAccountForIdentity(identity({ issuer: `${ISSUER}${'x'.repeat(520)}` })),
        () => svc.ensureAccountForIdentity(identity({ subject: `${SUBJECT}${'y'.repeat(260)}` })),
        () => svc.ensureAccountForIdentity(identity({ subject: `${SUBJECT}${String.fromCharCode(0)}` })),
        () => svc.ensureAccountForIdentity(identity({ providerType: 'GOOGLE' as never })),
        () => svc.upsertProfile(ACCOUNT_ID, { firstName: SUBJECT, lastName: '' }, { actor: ISSUER.repeat(10) }),
        () => svc.upsertProfile(ACCOUNT_ID, { firstName: `${SUBJECT}${String.fromCharCode(1)}`, lastName: 'x'.repeat(60) }, { actor: 'account:x' }),
        () => svc.grantRole(ACCOUNT_ID, 'CUSTOMER', { actor: '', source: 'ADMIN' }),
        () => svc.changeStatus(ACCOUNT_ID, 'SUSPENDED', { actor: 'admin:x', reason: `${SUBJECT}${'z'.repeat(1001)}` }),
      ];
      for (const attempt of attempts) {
        const e = await caught(attempt());
        const text = exposed(e);
        expect(text).not.toContain('subject-marker');
        expect(text).not.toContain('issuer-marker');
      }
    });
  });
});

// ====================================================================== scripted pg connection
type Row = Record<string, unknown>;
interface Recorded {
  sql: string;
  params: unknown[];
}
type Reply = Row[] | Error | undefined;

const openDatabases: Database[] = [];
afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((d) => d.close()));
});

/** A real Database whose pool hands out a fake client: every statement is recorded and answered by `reply` (no server, no network). */
const scripted = (reply: (q: Recorded) => Reply) => {
  const log: Recorded[] = [];
  const database = new Database('postgresql://app:pw@db.invalid:5432/app');
  openDatabases.push(database);
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const q = { sql: text.replace(/\s+/g, ' ').trim(), params };
      log.push(q);
      const r = reply(q);
      if (r instanceof Error) throw r;
      return { command: 'SELECT', rowCount: r?.length ?? 0, rows: r ?? [] };
    },
    release: () => undefined,
  };
  vi.spyOn(database.pool, 'connect').mockResolvedValue(client as never);
  return { database, log };
};
/** A Database whose pool cannot hand out a connection at all. */
const unreachable = (failure: unknown) => {
  const database = new Database('postgresql://app:pw@db.invalid:5432/app');
  openDatabases.push(database);
  vi.spyOn(database.pool, 'connect').mockRejectedValue(failure);
  return database;
};

interface Member {
  roleId: string;
  code: string;
  status: string;
}
interface Store {
  linked: { externalIdentityId: string; accountId: string } | null;
  account: { accountId: string; status: string; primaryRoleId: string | null } | null;
  members: Member[];
  profile: Row | null;
  roles: Record<string, { roleId: string; status: string }>;
}
const newStore = (over: Partial<Store> = {}): Store => ({
  linked: null,
  account: null,
  members: [],
  profile: null,
  roles: { CUSTOMER: { roleId: 'role-customer', status: 'ACTIVE' }, PROVIDER: { roleId: 'role-provider', status: 'ACTIVE' } },
  ...over,
});
const existing = (
  over: Partial<Store['account'] & object> = {},
  members: Member[] = [{ roleId: 'role-customer', code: 'CUSTOMER', status: 'ACTIVE' }],
): Partial<Store> => ({
  linked: { externalIdentityId: 'ei-1', accountId: ACCOUNT_ID },
  account: { accountId: ACCOUNT_ID, status: 'ACTIVE', primaryRoleId: 'role-customer', ...over },
  members,
});
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const codeOfRole = (store: Store, roleId: string | null): string | null =>
  roleId === null ? null : (Object.entries(store.roles).find(([, r]) => r.roleId === roleId)?.[0] ?? null);

/** Answers the statements of ensureAccountForIdentity, getAccountContext and the creation transaction from an in-memory store. */
const answer =
  (store: Store, hooks: { before?: (q: Recorded) => Reply } = {}) =>
  (q: Recorded): Reply => {
    const early = hooks.before?.(q);
    if (early !== undefined) return early;
    const s = q.sql;
    if (/^select external_identity_id, account_id from identity\.external_identities/i.test(s)) {
      return store.linked ? [{ external_identity_id: store.linked.externalIdentityId, account_id: store.linked.accountId }] : [];
    }
    if (/^update identity\.external_identities set last_seen_at/i.test(s)) return [];
    if (/^insert into identity\.accounts \(status\)/i.test(s)) {
      store.account = { accountId: NEW_ACCOUNT_ID, status: 'ACTIVE', primaryRoleId: null };
      return [{ account_id: NEW_ACCOUNT_ID }];
    }
    if (/^insert into identity\.external_identities/i.test(s)) {
      store.linked = { externalIdentityId: 'ei-new', accountId: NEW_ACCOUNT_ID };
      return [];
    }
    if (/^select 1 from identity\.accounts where account_id = \$1 for update/i.test(s)) return store.account ? [{ '?column?': 1 }] : [];
    if (/^select status from identity\.accounts where account_id = \$1$/i.test(s)) return store.account ? [{ status: store.account.status }] : [];
    if (/^select primary_role_id from identity\.accounts/i.test(s)) return [{ primary_role_id: store.account?.primaryRoleId ?? null }];
    if (/^update identity\.accounts set primary_role_id = \$1/i.test(s)) {
      if (store.account) store.account.primaryRoleId = q.params[0] as string | null;
      return [];
    }
    if (/^select 1 from identity\.roles where code = \$1 for share/i.test(s)) return store.roles[q.params[0] as string] ? [{ '?column?': 1 }] : [];
    if (/^select role_id, status from identity\.roles where code = \$1/i.test(s)) {
      const r = store.roles[q.params[0] as string];
      return r ? [{ role_id: r.roleId, status: r.status }] : [];
    }
    if (/^select 1 from identity\.account_roles where account_id = \$1 and role_id = \$2 for update/i.test(s)) {
      return store.members.some((m) => m.roleId === q.params[1]) ? [{ '?column?': 1 }] : [];
    }
    if (/^insert into identity\.account_roles/i.test(s)) {
      const roleId = q.params[1] as string;
      store.members.push({ roleId, code: codeOfRole(store, roleId)!, status: /'ACTIVE'|\$3/.test(s) ? (q.params[2] as string) : 'ACTIVE' });
      return [];
    }
    if (/^select a\.account_id, a\.status, a\.created_at, pr\.code as primary_code/i.test(s)) {
      return store.account
        ? [
            {
              account_id: store.account.accountId,
              status: store.account.status,
              created_at: CREATED_AT,
              primary_code: codeOfRole(store, store.account.primaryRoleId),
            },
          ]
        : [];
    }
    if (/^select r\.code, r\.name_content_key, m\.status, m\.activated_at/i.test(s)) {
      return store.members.map((m) => ({
        code: m.code,
        name_content_key: `identity.role.${m.code.toLowerCase()}.name`,
        status: m.status,
        activated_at: CREATED_AT,
      }));
    }
    if (/from identity\.account_profiles p left join/i.test(s)) return store.profile ? [store.profile] : [];
    if (/^insert into integration\.outbox_events/i.test(s)) return [{ outbox_event_id: 'outbox-1' }];
    return []; // begin, commit, rollback, audit and history inserts
  };
const statements = (log: Recorded[], pattern: RegExp): Recorded[] => log.filter((q) => pattern.test(q.sql));
const subjectOrIssuerIn = (q: Recorded): boolean =>
  q.params.some((p) => typeof p === 'string' && (p.includes('subject-marker') || p.includes('issuer-marker')));

describe('AccountService.ensureAccountForIdentity against a scripted connection: an existing account', () => {
  it('reads the account linked to the identity and creates nothing', async () => {
    const store = newStore(existing());
    const { database, log } = scripted(answer(store));
    const ctx = await new AccountService({ database }).ensureAccountForIdentity(identity());
    expect(ctx).toEqual({
      accountId: ACCOUNT_ID,
      status: 'ACTIVE',
      roles: [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }],
      memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }],
      primaryRole: 'CUSTOMER',
      activeRole: 'CUSTOMER',
      profile: null,
      createdAt: CREATED_AT,
      created: false,
    });
    expect(statements(log, /^(insert|begin|start transaction|commit)/i)).toEqual([]);
  });
  it('looks the identity up by provider type, issuer and subject taken verbatim from the verified identity', async () => {
    const store = newStore(existing());
    const { database, log } = scripted(answer(store));
    await new AccountService({ database }).ensureAccountForIdentity(identity());
    expect(log[0]!.sql).toMatch(/where provider_type = \$1 and issuer = \$2 and provider_subject = \$3/i);
    expect(log[0]!.params).toEqual(['KEYCLOAK', ISSUER, SUBJECT]);
  });
  it('uses the roles the token carries only for a NEW account: an existing account ignores them (PostgreSQL is the authority)', async () => {
    const store = newStore(existing({}, [{ roleId: 'role-customer', code: 'CUSTOMER', status: 'ACTIVE' }]));
    const { database, log } = scripted(answer(store));
    const ctx = await new AccountService({ database }).ensureAccountForIdentity(identity({ identityRoles: ['provider', 'customer', 'admin'] }));
    expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER']);
    expect(statements(log, /account_roles/i).filter((q) => /^insert/i.test(q.sql))).toEqual([]);
  });
  it.each([
    ['the default of 300 seconds', undefined, 300],
    ['a configured 60 seconds', 60, 60],
    ['zero (every request)', 0, 0],
  ])('touches last_seen_at with %s', async (_label, configured, expected) => {
    const store = newStore(existing());
    const { database, log } = scripted(answer(store));
    await new AccountService({ database, lastSeenTouchSeconds: configured }).ensureAccountForIdentity(identity());
    const touch = statements(log, /^update identity\.external_identities set last_seen_at/i);
    expect(touch).toHaveLength(1);
    expect(touch[0]!.params).toEqual(['ei-1', expected]);
    expect(touch[0]!.sql).toMatch(/last_seen_at < now\(\) - make_interval/i);
  });
  it('never fails the request when last_seen_at cannot be updated', async () => {
    const store = newStore(existing());
    const { database } = scripted(answer(store, { before: (q) => (/^update identity\.external_identities/i.test(q.sql) ? pgError('ECONNRESET') : undefined) }));
    await expect(new AccountService({ database }).ensureAccountForIdentity(identity())).resolves.toMatchObject({ accountId: ACCOUNT_ID, created: false });
    expect(consoleLog.mock.calls.some((c) => String(c[0]).includes('last_seen_at could not be updated'))).toBe(true);
  });
  it('returns the profile only when asked, with the zone name resolved', async () => {
    const profile = { first_name: 'Ana', last_name: 'Martinez', preferred_locale: 'en-US', iana_name: 'America/Los_Angeles' };
    const store = newStore({ ...existing(), profile });
    const { database, log } = scripted(answer(store));
    const svc = new AccountService({ database });
    expect((await svc.ensureAccountForIdentity(identity())).profile).toBeNull();
    expect(statements(log, /account_profiles/i)).toHaveLength(0);
    expect((await svc.ensureAccountForIdentity(identity(), { includeProfile: true })).profile).toEqual({
      firstName: 'Ana',
      lastName: 'Martinez',
      preferredLocale: 'en-US',
      timeZone: 'America/Los_Angeles',
    });
  });
  it('returns a null profile when none exists and null locale and zone when unset', async () => {
    const svc = (profile: Row | null) => new AccountService({ database: scripted(answer(newStore({ ...existing(), profile }))).database });
    expect((await svc(null).ensureAccountForIdentity(identity(), { includeProfile: true })).profile).toBeNull();
    expect(
      (await svc({ first_name: 'A', last_name: 'B', preferred_locale: null, iana_name: null }).ensureAccountForIdentity(identity(), { includeProfile: true }))
        .profile,
    ).toEqual({
      firstName: 'A',
      lastName: 'B',
      preferredLocale: null,
      timeZone: null,
    });
  });
  it('validates a requested role against the memberships PostgreSQL holds', async () => {
    const members: Member[] = [
      { roleId: 'role-customer', code: 'CUSTOMER', status: 'ACTIVE' },
      { roleId: 'role-provider', code: 'PROVIDER', status: 'INACTIVE' },
    ];
    const svc = new AccountService({ database: scripted(answer(newStore(existing({}, members)))).database });
    await expect(svc.ensureAccountForIdentity(identity(), { requestedRole: 'CUSTOMER' })).resolves.toMatchObject({ activeRole: 'CUSTOMER' });
    expect((await caught(svc.ensureAccountForIdentity(identity(), { requestedRole: 'PROVIDER' }))).code).toBe('ROLE_NOT_ACTIVE');
    expect((await caught(svc.ensureAccountForIdentity(identity(), { requestedRole: 'SUPPORT' }))).code).toBe('ROLE_NOT_HELD');
    expect((await caught(svc.ensureAccountForIdentity(identity(), { requestedRole: 'customer' }))).details).toEqual({ reason: 'INVALID_ROLE_CODE' });
  });
  it('lists only ACTIVE memberships as roles but keeps every membership for diagnostics', async () => {
    const members: Member[] = [
      { roleId: 'role-customer', code: 'CUSTOMER', status: 'ACTIVE' },
      { roleId: 'role-provider', code: 'PROVIDER', status: 'PENDING' },
    ];
    const ctx = await new AccountService({ database: scripted(answer(newStore(existing({}, members)))).database }).ensureAccountForIdentity(identity());
    expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER']);
    expect(ctx.memberships).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE' },
      { code: 'PROVIDER', status: 'PENDING' },
    ]);
  });
  it.each(['SUSPENDED', 'CLOSED'] as const)('refuses a %s account with its status in the details, unless allowUnusable is set', async (status) => {
    const svc = new AccountService({ database: scripted(answer(newStore(existing({ status })))).database });
    const e = await caught(svc.ensureAccountForIdentity(identity()));
    expect(e.code).toBe(status);
    expect(e.details).toEqual({ status });
    await expect(svc.ensureAccountForIdentity(identity(), { allowUnusable: true })).resolves.toMatchObject({ status });
  });
  it.each(['PENDING', 'CLOSURE_REQUESTED'] as const)('serves a %s account', async (status) => {
    const svc = new AccountService({ database: scripted(answer(newStore(existing({ status })))).database });
    await expect(svc.ensureAccountForIdentity(identity())).resolves.toMatchObject({ status });
  });
  it('answers NOT_FOUND when the linked account row does not exist', async () => {
    const store = newStore({ linked: { externalIdentityId: 'ei-1', accountId: ACCOUNT_ID }, account: null });
    const svc = new AccountService({ database: scripted(answer(store)).database });
    expect((await caught(svc.ensureAccountForIdentity(identity()))).code).toBe('NOT_FOUND');
  });
});

describe('AccountService.getAccountContext and selectActiveRole against a scripted connection', () => {
  it('reads by account id with an optional role and profile', async () => {
    const members: Member[] = [
      { roleId: 'role-customer', code: 'CUSTOMER', status: 'ACTIVE' },
      { roleId: 'role-provider', code: 'PROVIDER', status: 'ACTIVE' },
    ];
    const profile = { first_name: 'Ana', last_name: 'M', preferred_locale: null, iana_name: null };
    const svc = new AccountService({ database: scripted(answer(newStore({ ...existing({ primaryRoleId: null }, members), profile }))).database });
    expect(await svc.getAccountContext(ACCOUNT_ID)).toMatchObject({ activeRole: null, primaryRole: null, profile: null, created: false });
    expect(await svc.getAccountContext(ACCOUNT_ID, { requestedRole: 'PROVIDER', includeProfile: true })).toMatchObject({
      activeRole: 'PROVIDER',
      profile: { firstName: 'Ana', lastName: 'M', preferredLocale: null, timeZone: null },
    });
  });
  it('selectActiveRole validates and writes nothing', async () => {
    const members: Member[] = [
      { roleId: 'role-customer', code: 'CUSTOMER', status: 'ACTIVE' },
      { roleId: 'role-provider', code: 'PROVIDER', status: 'INACTIVE' },
    ];
    const { database, log } = scripted(
      answer(newStore({ ...existing({}, members), profile: { first_name: 'Ana', last_name: 'M', preferred_locale: null, iana_name: null } })),
    );
    const svc = new AccountService({ database });
    await expect(svc.selectActiveRole(ACCOUNT_ID, 'CUSTOMER')).resolves.toMatchObject({ activeRole: 'CUSTOMER', profile: { firstName: 'Ana' } });
    expect((await caught(svc.selectActiveRole(ACCOUNT_ID, 'PROVIDER'))).code).toBe('ROLE_NOT_ACTIVE');
    expect((await caught(svc.selectActiveRole(ACCOUNT_ID, 'ADMIN'))).code).toBe('ROLE_NOT_HELD');
    expect(statements(log, /^(insert|update|delete|begin|start transaction|commit)/i)).toEqual([]);
  });
  it('refuses a SUSPENDED account and answers NOT_FOUND for an unknown id', async () => {
    const suspended = new AccountService({ database: scripted(answer(newStore(existing({ status: 'SUSPENDED' })))).database });
    expect((await caught(suspended.getAccountContext(ACCOUNT_ID))).code).toBe('SUSPENDED');
    expect((await caught(suspended.selectActiveRole(ACCOUNT_ID, 'CUSTOMER'))).code).toBe('SUSPENDED');
    const none = new AccountService({ database: scripted(answer(newStore())).database });
    expect((await caught(none.getAccountContext(ACCOUNT_ID))).code).toBe('NOT_FOUND');
  });
});

describe('AccountService.ensureAccountForIdentity against a scripted connection: the first request creates the account', () => {
  const create = async (identityRoles: string[]) => {
    const store = newStore();
    const { database, log } = scripted(answer(store));
    const ctx = await new AccountService({ database }).ensureAccountForIdentity(identity({ identityRoles }));
    return { ctx, log, store };
  };
  const auditActions = (log: Recorded[]) => statements(log, /^insert into identity\.account_audit_events/i).map((q) => q.params[1]);
  const events = (log: Recorded[]) =>
    statements(log, /^insert into integration\.outbox_events/i).map((q) => ({
      aggregateType: q.params[0],
      aggregateId: q.params[1],
      type: q.params[2],
      actorType: q.params[4],
      actorId: q.params[5],
      payload: JSON.parse(q.params[6] as string) as unknown,
    }));

  it('creates account, status history, external identity link, audit rows and events in ONE transaction, in that order', async () => {
    const { ctx, log } = await create(['customer']);
    expect(ctx).toMatchObject({ accountId: NEW_ACCOUNT_ID, status: 'ACTIVE', created: true, primaryRole: 'CUSTOMER', activeRole: 'CUSTOMER' });
    const kinds = log.map((q) => q.sql.split(' ').slice(0, 3).join(' ').toLowerCase());
    const begin = kinds.findIndex((k) => k.startsWith('start transaction'));
    const commit = kinds.indexOf('commit');
    expect(begin).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(begin);
    const inTx = log.slice(begin, commit + 1).map((q) => q.sql);
    const order = [
      /^insert into identity\.accounts/i,
      /^insert into identity\.account_status_history/i,
      /^insert into identity\.external_identities/i,
      /^insert into identity\.account_audit_events/i,
      /^insert into integration\.outbox_events/i,
    ].map((re) => inTx.findIndex((s) => re.test(s)));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(statements(log.slice(commit + 1), /^insert/i)).toEqual([]);
  });
  it('writes the history row with no previous status, the system actor and the account status ACTIVE', async () => {
    const { log } = await create(['customer']);
    const history = statements(log, /^insert into identity\.account_status_history/i)[0]!;
    expect(history.sql).toMatch(/values \(\$1, NULL, 'ACTIVE', 'account created from the first verified identity', \$2, \$3\)/i);
    expect(history.params.slice(0, 2)).toEqual([NEW_ACCOUNT_ID, 'system:account-bootstrap']);
  });
  it('links the identity with the verified provider type, issuer and subject', async () => {
    const { log } = await create(['customer']);
    expect(statements(log, /^insert into identity\.external_identities/i)[0]!.params).toEqual([NEW_ACCOUNT_ID, 'KEYCLOAK', ISSUER, SUBJECT]);
  });
  it('seeds CUSTOMER from the realm role customer, as a BOOTSTRAP grant, and makes it the primary role', async () => {
    const { log, ctx } = await create(['customer', 'offline_access']);
    const grants = statements(log, /^insert into identity\.account_roles/i);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.params).toEqual([NEW_ACCOUNT_ID, 'role-customer', 'ACTIVE', 'system:account-bootstrap', 'BOOTSTRAP']);
    expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER']);
    expect(statements(log, /^update identity\.accounts set primary_role_id/i)[0]!.params[0]).toBe('role-customer');
    expect(auditActions(log)).toEqual(['ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED', 'ROLE_GRANTED', 'PRIMARY_ROLE_CHANGED']);
  });
  it('seeds PROVIDER only for a provider token (a provider-first account is not also a customer)', async () => {
    const { ctx } = await create(['provider']);
    expect(ctx.roles.map((r) => r.code)).toEqual(['PROVIDER']);
    expect(ctx).toMatchObject({ primaryRole: 'PROVIDER', activeRole: 'PROVIDER' });
  });
  it('seeds both roles for a token with both, in mapping order; only the first becomes the primary role', async () => {
    const { ctx, log } = await create(['provider', 'customer']);
    expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(ctx.primaryRole).toBe('CUSTOMER');
    expect(statements(log, /^update identity\.accounts set primary_role_id/i)).toHaveLength(1);
  });
  it.each([[[]], [['offline_access', 'uma_authorization']], [['admin', 'admin-console-access']], [['Customer', 'PROVIDER']]])(
    'creates an account with NO role for the token roles %j',
    async (identityRoles) => {
      const { ctx, log } = await create(identityRoles);
      expect(ctx).toMatchObject({ created: true, roles: [], memberships: [], primaryRole: null, activeRole: null, status: 'ACTIVE' });
      expect(statements(log, /^insert into identity\.account_roles/i)).toEqual([]);
      expect(auditActions(log)).toEqual(['ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED']);
    },
  );
  it('emits account-created and external-identity-linked (and role-granted per role), never status-changed, with valid identifier-only payloads', async () => {
    const { log } = await create(['customer', 'provider']);
    const emitted = events(log);
    expect(emitted.map((e) => e.type)).toEqual([
      IDENTITY_EVENTS.accountCreated,
      IDENTITY_EVENTS.externalIdentityLinked,
      IDENTITY_EVENTS.accountRoleGranted,
      IDENTITY_EVENTS.accountRoleGranted,
    ]);
    expect(emitted.map((e) => e.type)).not.toContain(IDENTITY_EVENTS.accountStatusChanged);
    for (const e of emitted) {
      expect(e.aggregateType).toBe('identity_account');
      expect(e.aggregateId).toBe(NEW_ACCOUNT_ID);
      expect(e.actorType).toBe('system');
      expect(e.actorId).toBe('system:account-bootstrap');
    }
    expect(AccountCreatedPayload.strict().parse(emitted[0]!.payload)).toEqual({ accountId: NEW_ACCOUNT_ID, status: 'ACTIVE' });
    expect(ExternalIdentityLinkedPayload.strict().parse(emitted[1]!.payload)).toEqual({ accountId: NEW_ACCOUNT_ID, providerType: 'KEYCLOAK' });
    expect(AccountRolePayload.strict().parse(emitted[2]!.payload)).toEqual({ accountId: NEW_ACCOUNT_ID, roleCode: 'CUSTOMER', source: 'BOOTSTRAP' });
    expect(AccountRolePayload.strict().parse(emitted[3]!.payload)).toEqual({ accountId: NEW_ACCOUNT_ID, roleCode: 'PROVIDER', source: 'BOOTSTRAP' });
  });
  it('keeps the Keycloak subject and issuer out of every statement except the identity lookup and the link itself', async () => {
    const { log } = await create(['customer', 'provider']);
    const carrying = log
      .filter(subjectOrIssuerIn)
      .map((q) => (/^insert into identity\.external_identities/i.test(q.sql) ? 'link' : /^select external_identity_id/i.test(q.sql) ? 'lookup' : q.sql));
    expect(carrying).toEqual(['lookup', 'link']);
    for (const q of log.filter((x) => /audit_events|status_history|outbox_events|account_roles/i.test(x.sql))) {
      expect(JSON.stringify(q.params), q.sql).not.toMatch(/marker/);
    }
  });
  it('uses one correlation id for the whole creation (history, audit and events)', async () => {
    const { log } = await create(['customer']);
    const history = statements(log, /^insert into identity\.account_status_history/i)[0]!.params[2];
    const audits = statements(log, /^insert into identity\.account_audit_events/i).map((q) => q.params[6]);
    const outbox = statements(log, /^insert into integration\.outbox_events/i).map((q) => q.params[7]);
    expect(typeof history).toBe('string');
    expect(new Set([history, ...audits, ...outbox]).size).toBe(1);
  });
});

describe('AccountService.ensureAccountForIdentity against a scripted connection: concurrent first requests', () => {
  const UNIQUE = 'uq_external_identities__provider_issuer_subject';
  const raceLoss = (q: Recorded): Reply =>
    /^insert into identity\.external_identities/i.test(q.sql)
      ? pgError('23505', { constraint: UNIQUE, detail: `Key (provider_subject)=(${SUBJECT}) already exists.`, message: `duplicate key ${SUBJECT}` })
      : undefined;

  it('rolls the half-created account back and returns the winner when the unique identity key is taken', async () => {
    const store = newStore();
    let lookups = 0;
    const { database, log } = scripted(
      answer(store, {
        before: (q) => {
          if (/^select external_identity_id, account_id from identity\.external_identities/i.test(q.sql)) {
            lookups++;
            if (lookups >= 2) {
              // by now the winning request has committed its account and link
              store.linked = { externalIdentityId: 'ei-winner', accountId: ACCOUNT_ID };
              store.account = { accountId: ACCOUNT_ID, status: 'ACTIVE', primaryRoleId: 'role-customer' };
              store.members = [{ roleId: 'role-customer', code: 'CUSTOMER', status: 'ACTIVE' }];
              return [{ external_identity_id: 'ei-winner', account_id: ACCOUNT_ID }];
            }
          }
          return raceLoss(q);
        },
      }),
    );
    const ctx = await new AccountService({ database }).ensureAccountForIdentity(identity());
    expect(ctx).toMatchObject({ accountId: ACCOUNT_ID, created: false, activeRole: 'CUSTOMER' });
    expect(lookups).toBe(2);
    const kinds = log.map((q) => q.sql.toLowerCase());
    expect(kinds).toContain('rollback');
    expect(kinds).not.toContain('commit');
  });
  it('gives up with a retryable CONFLICT after three lost races', async () => {
    const store = newStore();
    const { database, log } = scripted(answer(store, { before: raceLoss }));
    const e = await caught(new AccountService({ database }).ensureAccountForIdentity(identity()));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expect(statements(log, /^select external_identity_id/i)).toHaveLength(3);
    expect(statements(log, /^rollback$/i)).toHaveLength(3);
    expect(statements(log, /^commit$/i)).toHaveLength(0);
    expect(exposed(e)).not.toMatch(/marker/);
  });
  it('does NOT retry a unique violation of another constraint', async () => {
    const store = newStore();
    const other = (q: Recorded): Reply =>
      /^insert into identity\.external_identities/i.test(q.sql)
        ? pgError('23505', { constraint: 'pk_accounts', message: `duplicate key ${SUBJECT}` })
        : undefined;
    const { database, log } = scripted(answer(store, { before: other }));
    const e = await caught(new AccountService({ database }).ensureAccountForIdentity(identity()));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'DUPLICATE', constraint: 'pk_accounts' });
    expect(statements(log, /^select external_identity_id/i)).toHaveLength(1);
    expect(exposed(e)).not.toMatch(/marker/);
  });
  it('maps a database outage in the middle of the creation to UNAVAILABLE after rolling back', async () => {
    const store = newStore();
    const dies = (q: Recorded): Reply =>
      /^insert into identity\.account_audit_events/i.test(q.sql) ? pgError('ECONNRESET', { message: `read ECONNRESET for ${SUBJECT}` }) : undefined;
    const { database, log } = scripted(answer(store, { before: dies }));
    const e = await caught(new AccountService({ database }).ensureAccountForIdentity(identity()));
    expect(e.code).toBe('UNAVAILABLE');
    expect(statements(log, /^rollback$/i)).toHaveLength(1);
    expect(statements(log, /^commit$/i)).toHaveLength(0);
    expect(exposed(e)).not.toMatch(/marker|ECONNRESET/);
  });
});

describe('AccountService.changeStatus against a scripted connection', () => {
  const run = (status: string, to: AccountStatus, store = newStore({ account: { accountId: ACCOUNT_ID, status, primaryRoleId: null } })) => {
    const { database, log } = scripted(answer(store));
    return { result: new AccountService({ database }).changeStatus(ACCOUNT_ID, to, { actor: 'admin:ops', reason: 'because' }), log };
  };

  const FORBIDDEN = ACCOUNT_STATUSES.flatMap((from) =>
    ACCOUNT_STATUSES.filter((to) => to !== from && !isAccountStatusTransitionAllowed(from, to)).map((to) => [from, to] as const),
  );
  it('has 11 forbidden pairs to check (25 pairs, 5 unchanged, 9 allowed)', () => {
    expect(FORBIDDEN).toHaveLength(11);
  });
  it.each(FORBIDDEN)('refuses %s -> %s as INVALID_STATE ACCOUNT_STATUS_TRANSITION and writes nothing', async (from, to) => {
    const { result, log } = run(from, to);
    const e = await caught(result);
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({ reason: 'ACCOUNT_STATUS_TRANSITION', from, to });
    expect(statements(log, /^(insert|update)/i)).toEqual([]);
    expect(statements(log, /^rollback$/i)).toHaveLength(1);
  });
  it.each(ACCOUNT_STATUSES)('is a no-op for the unchanged status %s (idempotent: no history row, no event)', async (status) => {
    const { result, log } = run(status, status);
    await expect(result).resolves.toEqual({ changed: false, from: status });
    expect(statements(log, /^(insert|update)/i)).toEqual([]);
  });
  it('suspends: updates the status, appends the history row and emits account-status-changed, in that order', async () => {
    const { result, log } = run('ACTIVE', 'SUSPENDED');
    await expect(result).resolves.toEqual({ changed: true, from: 'ACTIVE' });
    const writes = log.filter((q) => /^(insert|update)/i.test(q.sql));
    expect(writes.map((q) => q.sql.split(' ').slice(0, 3).join(' ').toLowerCase())).toEqual([
      'update identity.accounts set',
      'insert into identity.account_status_history',
      'insert into integration.outbox_events',
    ]);
    expect(writes[0]!.sql).toMatch(/closed_at = NULL/i);
    expect(writes[0]!.params[0]).toBe('SUSPENDED');
    expect(writes[1]!.params.slice(0, 5)).toEqual([ACCOUNT_ID, 'ACTIVE', 'SUSPENDED', 'because', 'admin:ops']);
    expect(writes[2]!.params[2]).toBe(IDENTITY_EVENTS.accountStatusChanged);
    expect(AccountStatusChangedPayload.strict().parse(JSON.parse(writes[2]!.params[6] as string))).toEqual({
      accountId: ACCOUNT_ID,
      fromStatus: 'ACTIVE',
      toStatus: 'SUSPENDED',
    });
    expect(statements(log, /^commit$/i)).toHaveLength(1);
  });
  it('closes: clears the primary role first, sets closed_at, and records the history row (no open memberships here)', async () => {
    const { result, log } = run('CLOSURE_REQUESTED', 'CLOSED');
    await expect(result).resolves.toEqual({ changed: true, from: 'CLOSURE_REQUESTED' });
    const writes = log.filter((q) => /^(insert|update)/i.test(q.sql)).map((q) => q.sql);
    expect(writes[0]).toMatch(/^update identity\.accounts set primary_role_id = NULL/i);
    expect(writes[1]).toMatch(/^update identity\.accounts set status = \$1, closed_at = now\(\)/i);
    expect(writes[2]).toMatch(/^insert into identity\.account_status_history/i);
  });
  it('answers NOT_FOUND for an unknown account', async () => {
    const { result } = run('ACTIVE', 'SUSPENDED', newStore());
    expect((await caught(result)).code).toBe('NOT_FOUND');
  });
});

describe('AccountService maps a database failure to a typed error on every path', () => {
  const svcFor = (failure: unknown) => new AccountService({ database: unreachable(failure) });
  const paths: [string, (s: AccountService) => Promise<unknown>][] = [
    ['ensureAccountForIdentity', (s) => s.ensureAccountForIdentity(identity())],
    ['getAccountContext', (s) => s.getAccountContext(ACCOUNT_ID)],
    ['selectActiveRole', (s) => s.selectActiveRole(ACCOUNT_ID, 'CUSTOMER')],
    ['grantRole', (s) => s.grantRole(ACCOUNT_ID, 'CUSTOMER', { actor: 'admin:ops', source: 'ADMIN' })],
    ['deactivateRole', (s) => s.deactivateRole(ACCOUNT_ID, 'CUSTOMER', { actor: 'admin:ops' })],
    ['setPrimaryRole', (s) => s.setPrimaryRole(ACCOUNT_ID, 'CUSTOMER', { actor: 'admin:ops' })],
    ['changeStatus', (s) => s.changeStatus(ACCOUNT_ID, 'SUSPENDED', { actor: 'admin:ops' })],
    ['upsertProfile', (s) => s.upsertProfile(ACCOUNT_ID, { firstName: 'Ana', lastName: 'Martinez' }, { actor: 'account:x' })],
  ];
  describe.each(paths)('%s', (_name, run) => {
    it('reports an unreachable database as UNAVAILABLE without leaking the driver text', async () => {
      const failure = pgError('ECONNREFUSED', { message: `connect ECONNREFUSED 10.0.0.5:5432 password=hunter2 subject=${SUBJECT} issuer=${ISSUER}` });
      const e = await caught(run(svcFor(failure)));
      expect(e.code).toBe('UNAVAILABLE');
      const text = exposed(e);
      for (const leak of ['ECONNREFUSED', '10.0.0.5', 'hunter2', 'marker']) expect(text, leak).not.toContain(leak);
    });
    it('reports pool exhaustion (a connection timeout) as UNAVAILABLE', async () => {
      expect((await caught(run(svcFor(new Error('timeout exceeded when trying to connect'))))).code).toBe('UNAVAILABLE');
    });
    it('reports a deadlock as a retryable CONFLICT', async () => {
      const e = await caught(run(svcFor(pgError('40P01'))));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    });
    it('does not disguise a programming error: it is rethrown unchanged', async () => {
      const bug = new TypeError('cannot read properties of undefined');
      await expect(run(svcFor(bug))).rejects.toBe(bug);
    });
  });
});

describe('review fixes (ID-001)', () => {
  it('mapDbError rethrows a non-object value instead of failing with a TypeError', () => {
    for (const value of [null, undefined, 'boom', 42]) {
      let thrown: unknown = Symbol('not thrown');
      try {
        mapDbError(value);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBe(value);
    }
  });
  it('grantRole rejects a blank reason before any database access, like the other mutations', async () => {
    await expect(offline().grantRole(ACCOUNT_ID, 'CUSTOMER', { actor: 'system:test', source: 'SYSTEM', reason: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(offline().grantRole(ACCOUNT_ID, 'CUSTOMER', { actor: 'system:test', source: 'SYSTEM', reason: 'x'.repeat(1001) })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
  it('upsertProfile reports the name issues before a bad locale, so one request shows the name problem first', async () => {
    const e = await offline()
      .upsertProfile(ACCOUNT_ID, { firstName: '', lastName: 'Martin', preferredLocale: 'not a locale' }, { actor: `account:${ACCOUNT_ID}` })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'INVALID_PROFILE' } });
  });
});
