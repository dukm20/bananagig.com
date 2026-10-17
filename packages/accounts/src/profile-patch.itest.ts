// Integration tests of the partial profile update (ACC-001): the real AccountService.patchProfile over a real, freshly migrated PostgreSQL database, compared with the
// existing full replace upsertProfile. Every behaviour is asserted against the rows it leaves: the profile, the audit trail and the outbox.
//
// Time: the DATABASE clock decides updated_at; "unchanged" is proved by comparing the stored timestamp before and after a repeat, never by a sleep.
//
// Races are real (parallel service calls on separate pool connections, many rounds, fresh accounts per round) or deterministic (a raw transaction holds the account row
// lock while the call under test is started and observed, through pg_stat_activity, to wait on it). The assertions are INVARIANTS of the final state.
//
// Privacy: every captured log line, audit row, outbox payload and thrown error is scanned for the typed names and for the locale and time zone values; the scanner has a
// negative control proving that it can fail.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { AccountError, AccountService, type ProfilePatchInput } from './index';

// every log call of the code under test is captured here (and nothing is printed): the logs are scanned for the typed values
const logSink = vi.hoisted(() => ({ all: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.all.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});

const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
let iso: IsolatedDatabase;
let bigDb: Database;
let raw: ReturnType<typeof createTestPool>;
let svc: AccountService;

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  // the `tests` pool policy holds 5 connections; the races below keep up to 24 calls in flight
  bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 40, connectionTimeoutMs: 30_000 } });
  raw = createTestPool(iso.url, 12);
  svc = new AccountService({ database: bigDb });
  await raw.query("INSERT INTO content.locales (locale, is_active) VALUES ('de-DE', false), ('es-MX', true), ('fr-CA', true)");
  await raw.query("INSERT INTO geography.time_zones (iana_name) VALUES ('America/Phoenix')"); // registered but PLANNED
});
afterAll(async () => {
  await bigDb?.close();
  await raw?.end();
  await iso?.drop();
});
beforeEach(() => {
  logSink.all.length = 0;
});

// ---------------------------------------------------------------- helpers
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => (await raw.query(text, params)).rows as T[];
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const err = async (p: Promise<unknown>): Promise<AccountError> => {
  const e = await rejection(p);
  expect(e, 'the call was expected to be rejected').toBeInstanceOf(AccountError);
  return e as AccountError;
};
const settled = <T>(p: Promise<T>): Promise<T | AccountError> =>
  p.then(
    (v) => v,
    (e: unknown) => e as AccountError,
  );
const isErr = (v: unknown): v is AccountError => v instanceof AccountError;

async function newAccount(): Promise<string> {
  return (await svc.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: randomUUID(), identityRoles: ['customer'] })).accountId;
}
const selfOf = (id: string) => ({ actor: `account:${id}` });
/** An account that already has a full profile (written by upsertProfile, then the audit trail is the baseline of the test). */
async function profiled(over: { firstName?: string; lastName?: string; preferredLocale?: string | null; timeZone?: string | null } = {}): Promise<string> {
  const id = await newAccount();
  await svc.upsertProfile(
    id,
    {
      firstName: over.firstName ?? 'Ana',
      lastName: over.lastName ?? 'Martinez',
      preferredLocale: over.preferredLocale === undefined ? 'en-US' : over.preferredLocale,
      timeZone: over.timeZone === undefined ? 'America/Denver' : over.timeZone,
    },
    selfOf(id),
  );
  return id;
}
interface ProfileT {
  first_name: string;
  last_name: string;
  preferred_locale: string | null;
  iana_name: string | null;
  created_at: Date;
  updated_at: Date;
}
const profileRow = async (id: string): Promise<ProfileT | undefined> =>
  (
    await q<ProfileT>(
      `SELECT p.first_name, p.last_name, p.preferred_locale, z.iana_name, p.created_at, p.updated_at
         FROM identity.account_profiles p LEFT JOIN geography.time_zones z ON z.time_zone_id = p.time_zone_id WHERE p.account_id = $1`,
      [id],
    )
  )[0];
const shape = (r: ProfileT | undefined) => (r ? { first: r.first_name, last: r.last_name, locale: r.preferred_locale, zone: r.iana_name } : undefined);
interface AuditT {
  action: string;
  actor: string;
  changes: { fields?: string[] } | null;
  reason: string | null;
  correlation_id: string;
}
const audits = (id: string) =>
  q<AuditT>(
    `SELECT action, actor, changes, reason, correlation_id FROM identity.account_audit_events WHERE account_id = $1 AND action = 'PROFILE_UPDATED' ORDER BY occurred_at, audit_event_id`,
    [id],
  );
const fieldLists = async (id: string): Promise<string[][]> => (await audits(id)).map((a) => a.changes!.fields!);
const footprint = async (id: string) => ({
  profile: await q('SELECT * FROM identity.account_profiles WHERE account_id = $1', [id]),
  audit: (await q<{ n: number }>('SELECT count(*)::int AS n FROM identity.account_audit_events WHERE account_id = $1', [id]))[0]!.n,
  outbox: (await q<{ n: number }>('SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = $1', [id]))[0]!.n,
});
const patch = (id: string, input: ProfilePatchInput) => svc.patchProfile(id, input, selfOf(id));

const waitersOn = async (): Promise<number> =>
  (
    await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
    )
  )[0]!.n;
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn()) >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
async function noLockWaiters(): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn()) === 0) return;
    await sleep(20);
  }
  throw new Error('sessions are still blocked on a lock');
}

// ====================================================================== creating a profile
describe('patchProfile: a profile that does not exist yet', () => {
  it('needs BOTH names: one name, a locale alone, a time zone alone or an empty patch is PROFILE_REQUIRED and writes nothing at all', async () => {
    const id = await newAccount();
    const before = await footprint(id);
    for (const input of [
      { firstName: 'Ana' },
      { lastName: 'Martinez' },
      { preferredLocale: 'en-US' },
      { timeZone: 'America/Denver' },
      {},
      { firstName: 'Ana', preferredLocale: 'en-US', timeZone: 'America/Denver' },
    ]) {
      const e = await err(patch(id, input));
      expect({ code: e.code, details: e.details }, JSON.stringify(input)).toEqual({ code: 'VALIDATION_FAILED', details: { reason: 'PROFILE_REQUIRED' } });
    }
    expect(await footprint(id)).toEqual(before);
    expect(await profileRow(id)).toBeUndefined();
  });

  it('creates the profile from two names (optional fields null) and records one audit row naming exactly the fields that now have a value', async () => {
    const id = await newAccount();
    const r = await patch(id, { firstName: 'Ana', lastName: 'Martinez' });
    expect(r).toEqual({ changed: true, profile: { firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null } });
    expect(shape(await profileRow(id))).toEqual({ first: 'Ana', last: 'Martinez', locale: null, zone: null });
    expect(await fieldLists(id)).toEqual([['firstName', 'lastName']]);
  });

  it('creates the profile with a locale and a time zone in the same patch', async () => {
    const id = await newAccount();
    const r = await patch(id, { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    expect(r.profile).toEqual({ firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    expect(await fieldLists(id)).toEqual([['firstName', 'lastName', 'preferredLocale', 'timeZone']]);
  });

  it('writes nothing when the creation is refused for the locale or the time zone, although both names were given (all or nothing)', async () => {
    const id = await newAccount();
    const before = await footprint(id);
    expect((await err(patch(id, { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'de-DE' }))).details).toEqual({
      reason: 'UNKNOWN_LOCALE',
      field: 'preferredLocale',
    });
    expect((await err(patch(id, { firstName: 'Ana', lastName: 'Martinez', timeZone: 'America/Phoenix' }))).details).toEqual({
      reason: 'UNKNOWN_TIME_ZONE',
      field: 'timeZone',
    });
    expect(await footprint(id)).toEqual(before);
  });
});

// ====================================================================== changing only what is present
describe('patchProfile: absent keeps, present changes, null clears', () => {
  it('a last name alone keeps the first name, the locale and the time zone', async () => {
    const id = await profiled({ preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    const created = (await profileRow(id))!;
    await sleep(3); // updated_at is compared at millisecond resolution: let the clock move between the two writes
    const r = await patch(id, { lastName: 'Lopez' });
    expect(r).toEqual({ changed: true, profile: { firstName: 'Ana', lastName: 'Lopez', preferredLocale: 'es-MX', timeZone: 'America/Chicago' } });
    const row = (await profileRow(id))!;
    expect(shape(row)).toEqual({ first: 'Ana', last: 'Lopez', locale: 'es-MX', zone: 'America/Chicago' });
    expect(row.created_at.getTime()).toBe(created.created_at.getTime());
    expect(row.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
    expect(await fieldLists(id)).toEqual([['firstName', 'lastName', 'preferredLocale', 'timeZone'], ['lastName']]);
  });

  it('a first name alone keeps the last name, the locale and the time zone', async () => {
    const id = await profiled({ preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    await patch(id, { firstName: 'Zoe' });
    expect(shape(await profileRow(id))).toEqual({ first: 'Zoe', last: 'Martinez', locale: 'es-MX', zone: 'America/Chicago' });
    expect((await fieldLists(id)).at(-1)).toEqual(['firstName']);
  });

  it('a locale alone keeps the names and the time zone', async () => {
    const id = await profiled({ preferredLocale: 'en-US', timeZone: 'America/Chicago' });
    const r = await patch(id, { preferredLocale: 'es-MX' });
    expect(r.profile).toEqual({ firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    expect(shape(await profileRow(id))).toEqual({ first: 'Ana', last: 'Martinez', locale: 'es-MX', zone: 'America/Chicago' });
    expect((await fieldLists(id)).at(-1)).toEqual(['preferredLocale']);
  });

  it('a time zone alone keeps the names and the locale', async () => {
    const id = await profiled({ preferredLocale: 'es-MX', timeZone: 'America/Denver' });
    const r = await patch(id, { timeZone: 'America/New_York' });
    expect(r.profile).toEqual({ firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-MX', timeZone: 'America/New_York' });
    expect(shape(await profileRow(id))).toEqual({ first: 'Ana', last: 'Martinez', locale: 'es-MX', zone: 'America/New_York' });
    expect((await fieldLists(id)).at(-1)).toEqual(['timeZone']);
  });

  it('null clears the locale and clears the time zone (each alone and both), and leaves the names', async () => {
    const id = await profiled({ preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    expect((await patch(id, { preferredLocale: null })).profile).toEqual({
      firstName: 'Ana',
      lastName: 'Martinez',
      preferredLocale: null,
      timeZone: 'America/Chicago',
    });
    expect(shape(await profileRow(id))).toEqual({ first: 'Ana', last: 'Martinez', locale: null, zone: 'America/Chicago' });
    expect((await patch(id, { timeZone: null })).profile).toEqual({ firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null });
    expect(shape(await profileRow(id))).toEqual({ first: 'Ana', last: 'Martinez', locale: null, zone: null });
    const both = await profiled({ preferredLocale: 'fr-CA', timeZone: 'America/New_York' });
    await patch(both, { preferredLocale: null, timeZone: null });
    expect(shape(await profileRow(both))).toEqual({ first: 'Ana', last: 'Martinez', locale: null, zone: null });
    expect((await fieldLists(both)).at(-1)).toEqual(['preferredLocale', 'timeZone']);
    expect((await fieldLists(id)).slice(1)).toEqual([['preferredLocale'], ['timeZone']]);
  });

  it('clearing what is already empty is not a change: nothing is written and no audit row appears', async () => {
    const id = await profiled({ preferredLocale: null, timeZone: null });
    const before = await footprint(id);
    expect((await patch(id, { preferredLocale: null, timeZone: null })).changed).toBe(false);
    expect(await footprint(id)).toEqual(before);
  });

  it('an empty patch or one with only undefined values is absent everywhere: nothing changes and nothing is written', async () => {
    const id = await profiled();
    const before = await footprint(id);
    for (const input of [{}, { firstName: undefined, lastName: undefined, preferredLocale: undefined, timeZone: undefined }]) {
      const r = await patch(id, input);
      expect(r).toEqual({ changed: false, profile: { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Denver' } });
    }
    expect(await footprint(id)).toEqual(before);
  });

  it('a patch changes several fields in one write and one audit row', async () => {
    const id = await profiled();
    await patch(id, { firstName: 'Zoe', lastName: 'Zamora', preferredLocale: 'fr-CA', timeZone: 'America/Los_Angeles' });
    expect(shape(await profileRow(id))).toEqual({ first: 'Zoe', last: 'Zamora', locale: 'fr-CA', zone: 'America/Los_Angeles' });
    expect(await fieldLists(id)).toHaveLength(2);
    expect((await fieldLists(id)).at(-1)).toEqual(['firstName', 'lastName', 'preferredLocale', 'timeZone']);
  });
});

// ====================================================================== idempotence and the audit row
describe('patchProfile: idempotence and the audit row', () => {
  it('a repeat of the same patch writes nothing: no new audit row, no outbox event, updated_at exactly as it was', async () => {
    const id = await profiled();
    await patch(id, { lastName: 'Lopez', preferredLocale: 'es-MX' });
    const before = await footprint(id);
    const stamp = (await profileRow(id))!.updated_at.getTime();
    for (let i = 0; i < 3; i++) {
      const r = await patch(id, { lastName: 'Lopez', preferredLocale: 'es-MX' });
      expect(r).toEqual({ changed: false, profile: { firstName: 'Ana', lastName: 'Lopez', preferredLocale: 'es-MX', timeZone: 'America/Denver' } });
    }
    expect(await footprint(id)).toEqual(before);
    expect((await profileRow(id))!.updated_at.getTime()).toBe(stamp);
  });

  it('a value that equals the stored one after normalization is not a change (padding, a decomposed name, the locale in another case)', async () => {
    const id = await profiled({ firstName: `Jos${ch(0xe9)}`, preferredLocale: 'es-MX' });
    const before = await footprint(id);
    const decomposed = `Jose${ch(0x301)}`;
    expect((await patch(id, { firstName: `  ${decomposed}  `, preferredLocale: 'ES-mx' })).changed).toBe(false);
    expect(await footprint(id)).toEqual(before);
  });

  it('lists only the CHANGED field names in the audit row, never a value, and keeps the keys to `fields`', async () => {
    const id = await profiled({ preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    await patch(id, { firstName: 'Ana', lastName: 'Lopez', preferredLocale: 'es-MX', timeZone: 'America/New_York' }); // two of the four values are the stored ones
    const rows = await audits(id);
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)!.changes).toEqual({ fields: ['lastName', 'timeZone'] });
    expect(rows.at(-1)).toMatchObject({ action: 'PROFILE_UPDATED', actor: `account:${id}`, reason: null });
    const text = JSON.stringify(rows);
    for (const value of ['Lopez', 'Martinez', 'es-MX', 'America/New_York', 'America/Chicago']) expect(text, value).not.toContain(value);
  });

  it('writes the audit row with the correlation id of the request and no outbox event (no consumer exists, the audit row is the record)', async () => {
    const id = await profiled();
    const correlation = `patch-${randomUUID()}`;
    const outboxBefore = (await footprint(id)).outbox; // the events of the account creation and the role grant are there already
    await runWithCorrelation(correlation, () => patch(id, { lastName: 'Lopez' }));
    expect((await audits(id)).at(-1)!.correlation_id).toBe(correlation);
    expect((await footprint(id)).outbox).toBe(outboxBefore);
  });

  it('records the actor the caller gave (a person, an operator, the system), exactly', async () => {
    const id = await profiled();
    await svc.patchProfile(id, { lastName: 'Lopez' }, { actor: 'admin:operator-1' });
    await svc.patchProfile(id, { lastName: 'Garcia' }, { actor: 'system:import' });
    expect((await audits(id)).slice(1).map((a) => a.actor)).toEqual(['admin:operator-1', 'system:import']);
  });
});

// ====================================================================== the checks
describe('patchProfile: locale and time zone', () => {
  it('requires a canonical locale tag (INVALID_FIELD) and stores the canonical form of a tag in another case', async () => {
    const id = await profiled();
    const before = await footprint(id);
    for (const preferredLocale of ['en_US', 'english', '', ' en-US', 'e', 'en--US', 'not a locale', 'en-US-x-extra-thing']) {
      const e = await err(patch(id, { preferredLocale }));
      expect({ code: e.code, details: e.details }, JSON.stringify(preferredLocale)).toEqual({
        code: 'VALIDATION_FAILED',
        details: { reason: 'INVALID_FIELD', field: 'preferredLocale' },
      });
    }
    expect(await footprint(id)).toEqual(before);
    expect((await patch(id, { preferredLocale: 'es-mx' })).profile.preferredLocale).toBe('es-MX');
  });

  it('requires an ACTIVE registered locale (UNKNOWN_LOCALE): an unregistered tag and a registered but inactive one are refused and change nothing, even with a name change in the same patch', async () => {
    const id = await profiled();
    const before = await footprint(id);
    for (const preferredLocale of ['fr-FR', 'de-DE', 'ja-JP']) {
      const e = await err(patch(id, { lastName: 'Lopez', preferredLocale }));
      expect({ code: e.code, details: e.details }, preferredLocale).toEqual({
        code: 'VALIDATION_FAILED',
        details: { reason: 'UNKNOWN_LOCALE', field: 'preferredLocale' },
      });
    }
    expect(await footprint(id)).toEqual(before);
  });

  it('requires an ACTIVE registered time zone (UNKNOWN_TIME_ZONE): unknown, in another case, PLANNED and deactivated are refused and change nothing, even with a name change in the same patch', async () => {
    const id = await profiled();
    const before = await footprint(id);
    for (const timeZone of ['Mars/Phobos', 'america/denver', 'AMERICA/DENVER', 'America/Phoenix', '', ' America/Denver', 'America/Denver ']) {
      const e = await err(patch(id, { lastName: 'Lopez', timeZone }));
      expect({ code: e.code, details: e.details }, JSON.stringify(timeZone)).toEqual({
        code: 'VALIDATION_FAILED',
        details: { reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' },
      });
    }
    await q("UPDATE geography.time_zones SET status = 'INACTIVE', updated_at = now() WHERE iana_name = 'America/Los_Angeles'");
    try {
      const e = await err(patch(id, { lastName: 'Lopez', timeZone: 'America/Los_Angeles' }));
      expect(e.details).toEqual({ reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' });
      expect(await footprint(id)).toEqual(before);
    } finally {
      await q("UPDATE geography.time_zones SET status = 'ACTIVE', updated_at = now() WHERE iana_name = 'America/Los_Angeles'");
    }
    expect((await patch(id, { timeZone: 'America/Los_Angeles' })).profile.timeZone).toBe('America/Los_Angeles');
  });

  it('refuses a locale or time zone that went inactive when it is PATCHED, but accepts it again once it is active (the registry is read inside the transaction, with a share lock)', async () => {
    const id = await profiled();
    await q("UPDATE content.locales SET is_active = false WHERE locale = 'fr-CA'");
    try {
      expect((await err(patch(id, { preferredLocale: 'fr-CA' }))).details.reason).toBe('UNKNOWN_LOCALE');
    } finally {
      await q("UPDATE content.locales SET is_active = true WHERE locale = 'fr-CA'");
    }
    expect((await patch(id, { preferredLocale: 'fr-CA' })).profile.preferredLocale).toBe('fr-CA');
  });
});

describe('patchProfile: names', () => {
  it('normalizes a name like upsertProfile does (trim, composed form, collapsed inner whitespace, invisible characters dropped) and stores the normalized value', async () => {
    const id = await profiled();
    const r = await patch(id, { firstName: `  Jose${ch(0x301)}   Mar${ch(0x200b)}ia  `, lastName: `de${ch(0x09)}la${ch(0x0a)}  Cruz ` });
    expect(r.profile.firstName).toBe(`Jos${ch(0xe9)} Maria`);
    expect(r.profile.lastName).toBe('de la Cruz');
    expect(shape(await profileRow(id))).toMatchObject({ first: `Jos${ch(0xe9)} Maria`, last: 'de la Cruz' });
  });

  it('refuses invalid names with field, code and content key only, never the value, and changes nothing (also when a valid field is in the same patch)', async () => {
    const id = await profiled();
    const before = await footprint(id);
    const cases: [ProfilePatchInput, { field: string; code: string; messageKey: string }[]][] = [
      [{ firstName: '' }, [{ field: 'firstName', code: 'REQUIRED', messageKey: 'account.error.name_required' }]],
      [{ lastName: '   ' }, [{ field: 'lastName', code: 'REQUIRED', messageKey: 'account.error.name_required' }]],
      [{ firstName: 'x'.repeat(51) }, [{ field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }]],
      [
        { lastName: `Mar${String.fromCharCode(7)}tin` },
        [{ field: 'lastName', code: 'INVALID_CHARACTERS', messageKey: 'account.error.name_invalid_characters' }],
      ],
      [{ lastName: `Mar${ch(0x202e)}tin` }, [{ field: 'lastName', code: 'INVALID_CHARACTERS', messageKey: 'account.error.name_invalid_characters' }]],
      [
        { firstName: '', lastName: 'y'.repeat(60), timeZone: 'America/Chicago' },
        [
          { field: 'firstName', code: 'REQUIRED', messageKey: 'account.error.name_required' },
          { field: 'lastName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' },
        ],
      ],
    ];
    for (const [input, issues] of cases) {
      const e = await err(patch(id, input));
      expect({ code: e.code, details: e.details }, JSON.stringify(Object.keys(input))).toEqual({
        code: 'VALIDATION_FAILED',
        details: { reason: 'INVALID_PROFILE', issues },
      });
    }
    expect(await footprint(id)).toEqual(before);
  });

  it('accepts the length boundaries: a 1-character and a 50-character name, 50 emoji', async () => {
    const id = await profiled();
    await patch(id, { firstName: 'A', lastName: 'm'.repeat(50) });
    expect(shape(await profileRow(id))).toMatchObject({ first: 'A', last: 'm'.repeat(50) });
    await patch(id, { firstName: ch(0x1f600).repeat(50) });
    expect((await profileRow(id))!.first_name).toBe(ch(0x1f600).repeat(50));
  });

  it('never trims a stored name into a different one and never lets a name patch touch the locale or the zone', async () => {
    const id = await profiled({ preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    await patch(id, { firstName: 'Zoe' });
    await patch(id, { lastName: 'Lopez' });
    expect(shape(await profileRow(id))).toEqual({ first: 'Zoe', last: 'Lopez', locale: 'es-MX', zone: 'America/Chicago' });
  });
});

// ====================================================================== accounts that cannot be changed
describe('patchProfile: the state of the account', () => {
  it('refuses a SUSPENDED and a CLOSED account (before PROFILE_REQUIRED and before any check of the values) and writes nothing', async () => {
    const suspended = await profiled();
    await svc.changeStatus(suspended, 'SUSPENDED', { actor: 'admin:operator-1', reason: 'integration test' });
    const closed = await profiled();
    await svc.changeStatus(closed, 'SUSPENDED', { actor: 'admin:operator-1', reason: 'integration test' });
    await svc.changeStatus(closed, 'CLOSED', { actor: 'admin:operator-1', reason: 'integration test' });
    const noProfile = await newAccount();
    await svc.changeStatus(noProfile, 'SUSPENDED', { actor: 'admin:operator-1', reason: 'integration test' });
    for (const [id, code] of [
      [suspended, 'SUSPENDED'],
      [closed, 'CLOSED'],
      [noProfile, 'SUSPENDED'],
    ] as const) {
      const before = await footprint(id);
      expect((await err(patch(id, { lastName: 'Lopez' }))).code, code).toBe(code);
      expect((await err(patch(id, { lastName: 'Lopez', preferredLocale: 'de-DE' }))).code).toBe(code); // the account is checked before the locale
      expect(await footprint(id)).toEqual(before);
    }
  });

  it('fails for an unknown account with NOT_FOUND and for a bad actor with VALIDATION_FAILED, writing nothing', async () => {
    const id = await profiled();
    const before = await footprint(id);
    expect((await err(patch(randomUUID(), { lastName: 'Lopez' }))).code).toBe('NOT_FOUND');
    for (const actor of ['', '   ', 'a'.repeat(201)]) {
      const e = await err(svc.patchProfile(id, { lastName: 'Lopez' }, { actor }));
      expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'actor' });
    }
    expect(await footprint(id)).toEqual(before);
  });

  it('lets a patch resume after a refusal: the failed patches left no lock and no half-written row', async () => {
    const id = await profiled();
    await rejection(patch(id, { lastName: 'Lopez', preferredLocale: 'de-DE' }));
    await rejection(patch(id, { firstName: '' }));
    expect((await patch(id, { lastName: 'Lopez' })).changed).toBe(true);
    await noLockWaiters();
  });
});

// ====================================================================== equivalence with upsertProfile
describe('patchProfile and upsertProfile: the same final row for the same effective input', () => {
  const CASES: { name: string; start: { first: string; last: string; locale: string | null; zone: string | null }; patch: ProfilePatchInput }[] = [
    { name: 'a last name', start: { first: 'Ana', last: 'Martinez', locale: 'en-US', zone: 'America/Denver' }, patch: { lastName: 'Lopez' } },
    { name: 'a locale', start: { first: 'Ana', last: 'Martinez', locale: 'en-US', zone: 'America/Denver' }, patch: { preferredLocale: 'es-MX' } },
    { name: 'a cleared zone', start: { first: 'Ana', last: 'Martinez', locale: 'en-US', zone: 'America/Denver' }, patch: { timeZone: null } },
    {
      name: 'a cleared locale and a new zone',
      start: { first: 'Ana', last: 'Martinez', locale: 'es-MX', zone: null },
      patch: { preferredLocale: null, timeZone: 'America/Chicago' },
    },
    {
      name: 'everything',
      start: { first: 'Ana', last: 'Martinez', locale: null, zone: null },
      patch: { firstName: 'Zoe', lastName: 'Zamora', preferredLocale: 'fr-CA', timeZone: 'America/New_York' },
    },
    {
      name: 'nothing new',
      start: { first: 'Ana', last: 'Martinez', locale: 'en-US', zone: 'America/Denver' },
      patch: { firstName: 'Ana', timeZone: 'America/Denver' },
    },
  ];
  it.each(CASES)('$name', async ({ start, patch: input }) => {
    const [viaPatch, viaUpsert] = [
      await profiled({ firstName: start.first, lastName: start.last, preferredLocale: start.locale, timeZone: start.zone }),
      await profiled({ firstName: start.first, lastName: start.last, preferredLocale: start.locale, timeZone: start.zone }),
    ];
    const effective = {
      firstName: input.firstName ?? start.first,
      lastName: input.lastName ?? start.last,
      preferredLocale: input.preferredLocale === undefined ? start.locale : input.preferredLocale,
      timeZone: input.timeZone === undefined ? start.zone : input.timeZone,
    };
    const a = await patch(viaPatch, input);
    const b = await svc.upsertProfile(viaUpsert, effective, selfOf(viaUpsert));
    expect(a).toEqual(b);
    expect(shape(await profileRow(viaPatch))).toEqual(shape(await profileRow(viaUpsert)));
    expect(await fieldLists(viaPatch)).toEqual(await fieldLists(viaUpsert));
  });

  it('a profile built by patch equals one built by upsertProfile (names, locale, zone, one audit row)', async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    await patch(a, { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-MX', timeZone: 'America/Chicago' });
    await svc.upsertProfile(b, { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-MX', timeZone: 'America/Chicago' }, selfOf(b));
    expect(shape(await profileRow(a))).toEqual(shape(await profileRow(b)));
    expect(await fieldLists(a)).toEqual(await fieldLists(b));
  });
});

// ====================================================================== a stored value that went inactive
// zones a test registers and deactivates (names PostgreSQL knows; each is used once)
const SPARE_ZONES = [
  'America/Boise',
  'America/Anchorage',
  'America/Detroit',
  'America/Juneau',
  'America/Adak',
  'Pacific/Honolulu',
  'America/Nome',
  'America/Sitka',
];
let spare = 0;
describe('patchProfile: a stored locale or time zone that went inactive after it was chosen is a historical reference', () => {
  /** An account whose stored locale and time zone were deactivated after the person chose them. */
  async function withInactiveStored(): Promise<{ id: string; locale: string; zone: string }> {
    const n = Math.floor(Math.random() * 1e9);
    const locale = `qa-${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + (Math.floor(n / 26) % 26))}`;
    const zone = SPARE_ZONES[spare++]!; // a real zone nobody else uses (PostgreSQL knows the name), registered ACTIVE here and deactivated below
    await q('INSERT INTO content.locales (locale, is_active) VALUES ($1, true)', [locale]);
    await q("INSERT INTO geography.time_zones (iana_name, status) VALUES ($1, 'ACTIVE')", [zone]);
    const id = await profiled({ preferredLocale: locale, timeZone: zone });
    await q('UPDATE content.locales SET is_active = false WHERE locale = $1', [locale]);
    await q("UPDATE geography.time_zones SET status = 'INACTIVE', updated_at = now() WHERE iana_name = $1", [zone]);
    return { id, locale, zone };
  }

  it('lets a names-only patch succeed: changed, the locale and the zone untouched in the row, and only firstName in the audit fields', async () => {
    const { id, locale, zone } = await withInactiveStored();
    const r = await patch(id, { firstName: 'Zoe' });
    expect(r).toEqual({ changed: true, profile: { firstName: 'Zoe', lastName: 'Martinez', preferredLocale: locale, timeZone: zone } });
    expect(shape(await profileRow(id))).toEqual({ first: 'Zoe', last: 'Martinez', locale, zone });
    expect((await fieldLists(id)).at(-1)).toEqual(['firstName']);
    expect((await patch(id, { lastName: 'Lopez' })).changed).toBe(true);
    expect((await fieldLists(id)).at(-1)).toEqual(['lastName']);
  });

  it('treats re-sending the same inactive stored locale or zone as an idempotent no-op: nothing written, no audit row, updated_at unchanged', async () => {
    const { id, locale, zone } = await withInactiveStored();
    const before = await footprint(id);
    const stamp = (await profileRow(id))!.updated_at.getTime();
    for (const input of [{ preferredLocale: locale }, { timeZone: zone }, { preferredLocale: locale, timeZone: zone }]) {
      expect((await patch(id, input)).changed, JSON.stringify(input)).toBe(false);
    }
    expect(await footprint(id)).toEqual(before);
    expect((await profileRow(id))!.updated_at.getTime()).toBe(stamp);
  });

  it('still refuses a DIFFERENT inactive locale or zone (UNKNOWN_LOCALE, UNKNOWN_TIME_ZONE) and writes nothing, even with a name change in the same patch', async () => {
    const { id } = await withInactiveStored();
    const before = await footprint(id);
    expect((await err(patch(id, { firstName: 'Zoe', preferredLocale: 'de-DE' }))).details).toEqual({ reason: 'UNKNOWN_LOCALE', field: 'preferredLocale' });
    expect((await err(patch(id, { firstName: 'Zoe', timeZone: 'America/Phoenix' }))).details).toEqual({ reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' });
    expect(await footprint(id)).toEqual(before);
  });

  it('clears an inactive stored locale or zone with null, and then the preference can be set to an ACTIVE value', async () => {
    const { id, locale, zone } = await withInactiveStored();
    expect((await patch(id, { preferredLocale: null })).profile).toMatchObject({ preferredLocale: null, timeZone: zone });
    expect(shape(await profileRow(id))).toMatchObject({ locale: null, zone });
    expect((await fieldLists(id)).at(-1)).toEqual(['preferredLocale']);
    expect((await patch(id, { timeZone: null })).profile).toMatchObject({ preferredLocale: null, timeZone: null });
    expect((await fieldLists(id)).at(-1)).toEqual(['timeZone']);
    expect(locale).toBeTruthy();
    expect((await patch(id, { preferredLocale: 'es-MX', timeZone: 'America/Chicago' })).changed).toBe(true);
  });

  it('keeps the stored zone when only the locale changes and the other way round, although the zone is inactive', async () => {
    const { id, zone } = await withInactiveStored();
    expect((await patch(id, { preferredLocale: 'es-MX' })).profile).toMatchObject({ preferredLocale: 'es-MX', timeZone: zone });
    expect(shape(await profileRow(id))).toMatchObject({ locale: 'es-MX', zone });
    expect((await fieldLists(id)).at(-1)).toEqual(['preferredLocale']);
  });

  it('keeps the full replace (upsertProfile, PUT) strict: an inactive locale or zone is refused as before, also when it is the stored one', async () => {
    const { id, locale, zone } = await withInactiveStored();
    const before = await footprint(id);
    const full = { firstName: 'Ana', lastName: 'Martinez' };
    expect((await err(svc.upsertProfile(id, { ...full, preferredLocale: locale }, selfOf(id)))).details).toEqual({
      reason: 'UNKNOWN_LOCALE',
      field: 'preferredLocale',
    });
    expect((await err(svc.upsertProfile(id, { ...full, timeZone: zone }, selfOf(id)))).details).toEqual({ reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' });
    expect((await err(svc.upsertProfile(id, { ...full, preferredLocale: 'de-DE' }, selfOf(id)))).details.reason).toBe('UNKNOWN_LOCALE');
    expect(await footprint(id)).toEqual(before);
  });

  it('does not let a kept value hide an unregistered one on creation: a new profile still needs ACTIVE values', async () => {
    const id = await newAccount();
    expect((await err(patch(id, { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'de-DE' }))).details.reason).toBe('UNKNOWN_LOCALE');
    expect((await err(patch(id, { firstName: 'Ana', lastName: 'Martinez', timeZone: 'America/Phoenix' }))).details.reason).toBe('UNKNOWN_TIME_ZONE');
    expect(await profileRow(id)).toBeUndefined();
  });
});

// ====================================================================== real concurrency
describe('patchProfile: real concurrency', () => {
  it('applies two concurrent patches of DIFFERENT fields (lastName and timeZone) both: no lost update, over 25 fresh accounts', async () => {
    for (let round = 0; round < 25; round++) {
      const id = await profiled({ timeZone: 'America/Denver', preferredLocale: 'en-US' });
      const [a, b] = await Promise.all([settled(patch(id, { lastName: 'Lopez' })), settled(patch(id, { timeZone: 'America/Chicago' }))]);
      expect(isErr(a) || isErr(b), `round ${round}`).toBe(false);
      expect(shape(await profileRow(id)), `round ${round}`).toEqual({ first: 'Ana', last: 'Lopez', locale: 'en-US', zone: 'America/Chicago' });
      expect((await fieldLists(id)).slice(1).sort(), `round ${round}`).toEqual([['lastName'], ['timeZone']]);
    }
  });

  it('applies four concurrent patches of four different fields all, with exactly one audit row each', async () => {
    for (let round = 0; round < 10; round++) {
      const id = await profiled({ preferredLocale: 'en-US', timeZone: 'America/Denver' });
      const results = await Promise.all([
        settled(patch(id, { firstName: 'Zoe' })),
        settled(patch(id, { lastName: 'Lopez' })),
        settled(patch(id, { preferredLocale: 'es-MX' })),
        settled(patch(id, { timeZone: 'America/New_York' })),
      ]);
      for (const r of results) expect(isErr(r), `round ${round}`).toBe(false);
      expect(shape(await profileRow(id)), `round ${round}`).toEqual({ first: 'Zoe', last: 'Lopez', locale: 'es-MX', zone: 'America/New_York' });
      expect((await fieldLists(id)).slice(1).sort(), `round ${round}`).toEqual([['firstName'], ['lastName'], ['preferredLocale'], ['timeZone']]);
    }
  });

  it('records ONE change and ONE audit row when 20 identical patches race', async () => {
    const id = await profiled();
    const results = await Promise.all(Array.from({ length: 20 }, () => patch(id, { lastName: 'Lopez', timeZone: 'America/Chicago' })));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(shape(await profileRow(id))).toEqual({ first: 'Ana', last: 'Lopez', locale: 'en-US', zone: 'America/Chicago' });
    expect((await fieldLists(id)).slice(1)).toEqual([['lastName', 'timeZone']]);
  });

  it('ends consistent when a patch and a full replace race: the final row is the one the later of the two leaves, and the audit trail tells the same order', async () => {
    const orders = { upsertFirst: 0, patchFirst: 0 };
    for (let round = 0; round < 30; round++) {
      const id = await profiled({ firstName: 'Zed', lastName: 'Quinn', preferredLocale: null, timeZone: 'America/Denver' });
      const full = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-MX', timeZone: 'America/Chicago' };
      const [p, u] = await Promise.all([settled(patch(id, { lastName: 'Lopez' })), settled(svc.upsertProfile(id, full, selfOf(id)))]);
      expect(isErr(p) || isErr(u), `round ${round}`).toBe(false);
      const final = shape(await profileRow(id));
      const trail = (await fieldLists(id)).slice(1);
      if (final?.last === 'Lopez') {
        // the full replace ran first, the patch changed the last name afterwards
        expect(final, `round ${round}`).toEqual({ first: 'Ana', last: 'Lopez', locale: 'es-MX', zone: 'America/Chicago' });
        expect(trail, `round ${round}`).toEqual([['firstName', 'lastName', 'preferredLocale', 'timeZone'], ['lastName']]);
        orders.upsertFirst++;
      } else {
        // the patch ran first; the full replace then changed everything again (the last name back to the replace's value)
        expect(final, `round ${round}`).toEqual({ first: 'Ana', last: 'Martinez', locale: 'es-MX', zone: 'America/Chicago' });
        expect(trail, `round ${round}`).toEqual([['lastName'], ['firstName', 'lastName', 'preferredLocale', 'timeZone']]);
        orders.patchFirst++;
      }
    }
    expect(orders.upsertFirst + orders.patchFirst).toBe(30);
  });

  it('creates ONE profile when several patches that each carry both names race for an account without one, and every later writer sees the earlier one', async () => {
    for (let round = 0; round < 8; round++) {
      const id = await newAccount();
      const names = ['Ana', 'Bea', 'Cai', 'Dax', 'Eli', 'Fay'];
      const results = await Promise.all(names.map((n) => settled(patch(id, { firstName: n, lastName: 'Same' }))));
      for (const r of results) expect(isErr(r), `round ${round}`).toBe(false);
      expect((await q('SELECT 1 FROM identity.account_profiles WHERE account_id = $1', [id])).length).toBe(1);
      const changed = results.filter((r) => !isErr(r) && r.changed).length;
      expect(await audits(id), `round ${round}`).toHaveLength(changed);
      expect(names).toContain((await profileRow(id))!.first_name);
      expect((await fieldLists(id))[0]).toEqual(['firstName', 'lastName']); // the creation lists both names, the later writers only the first name
      for (const later of (await fieldLists(id)).slice(1)) expect(later).toEqual(['firstName']);
    }
  });

  it('waits for the account lock and then works on the CURRENT row: a patch started while another transaction holds the account and changes the last name keeps that new last name (no stale read)', async () => {
    const id = await profiled();
    const holder = await raw.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [id]);
      await holder.query("UPDATE identity.account_profiles SET last_name = 'FromHolder', updated_at = now() WHERE account_id = $1", [id]);
      const waiting = patch(id, { firstName: 'Zoe' });
      await lockWaiters(1);
      await holder.query('COMMIT');
      const r = await waiting;
      expect(r.profile).toEqual({ firstName: 'Zoe', lastName: 'FromHolder', preferredLocale: 'en-US', timeZone: 'America/Denver' });
    } finally {
      holder.release();
    }
    expect(shape(await profileRow(id))).toEqual({ first: 'Zoe', last: 'FromHolder', locale: 'en-US', zone: 'America/Denver' });
    expect((await fieldLists(id)).at(-1)).toEqual(['firstName']);
    await noLockWaiters();
  });

  it('waits for a transaction that updates only the profile row (its guard takes the account row FOR SHARE, so the wait is on the account lock; the profile row lock of the patch is a second line of defence that no black-box test can isolate), and then sees the committed values', async () => {
    const id = await profiled();
    const holder = await raw.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM identity.account_profiles WHERE account_id = $1 FOR UPDATE', [id]);
      await holder.query("UPDATE identity.account_profiles SET last_name = 'FromHolder', updated_at = now() WHERE account_id = $1", [id]);
      const waiting = patch(id, { firstName: 'Zoe' });
      await lockWaiters(1);
      await holder.query('COMMIT');
      expect((await waiting).profile.lastName).toBe('FromHolder');
    } finally {
      holder.release();
    }
    await noLockWaiters();
  });

  it('leaves no lock waiter behind after the races above', async () => {
    await noLockWaiters();
  });
});

// ====================================================================== privacy
describe('patchProfile: privacy', () => {
  it('puts no name, locale or time zone value into any log line, audit row, outbox event or error, over successes, refusals and races', async () => {
    const FIRST = `Zq${randomUUID().slice(0, 8)}First`;
    const LAST = `Zq${randomUUID().slice(0, 8)}Last`;
    const ZONES = ['America/Chicago', 'America/New_York'];
    const id = await newAccount();
    const caught: unknown[] = [];
    const run = async (p: Promise<unknown>) => {
      const e = await rejection(p);
      if (e) caught.push(e);
    };
    await patch(id, { firstName: FIRST, lastName: LAST, preferredLocale: 'es-MX', timeZone: ZONES[0] });
    await patch(id, { lastName: `${LAST}2`, timeZone: ZONES[1] });
    await patch(id, { lastName: `${LAST}2` }); // no change
    await run(patch(id, { firstName: `${FIRST}${ch(0x202e)}` }));
    await run(patch(id, { lastName: `${LAST}${'x'.repeat(60)}` }));
    await run(patch(id, { preferredLocale: `${FIRST}_xx` }));
    await run(patch(id, { preferredLocale: 'de-DE' }));
    await run(patch(id, { timeZone: `Mars/${LAST}` }));
    await run(patch(randomUUID(), { firstName: FIRST, lastName: LAST }));
    await Promise.all([settled(patch(id, { firstName: `${FIRST}3` })), settled(patch(id, { timeZone: ZONES[0] }))]);
    const suspended = await newAccount();
    await svc.changeStatus(suspended, 'SUSPENDED', { actor: 'admin:operator-1', reason: 'integration test' });
    await run(patch(suspended, { firstName: FIRST, lastName: LAST }));

    const auditText = JSON.stringify(await q('SELECT * FROM identity.account_audit_events WHERE account_id IN ($1, $2)', [id, suspended]));
    const outboxText = JSON.stringify(await q('SELECT payload_json, actor_id FROM integration.outbox_events WHERE aggregate_id IN ($1, $2)', [id, suspended]));
    const errorText = caught.map((e) => JSON.stringify({ m: (e as Error).message, d: (e as AccountError).details, s: (e as Error).stack })).join('\n');
    const logText = logSink.all.join('\n');
    expect(caught.length).toBeGreaterThanOrEqual(6);
    for (const needle of [FIRST, LAST, 'es-MX', ...ZONES, 'Mars/']) {
      expect(auditText, `audit: ${needle}`).not.toContain(needle);
      expect(outboxText, `outbox: ${needle}`).not.toContain(needle);
      expect(errorText, `errors: ${needle}`).not.toContain(needle);
      expect(logText, `logs: ${needle}`).not.toContain(needle);
    }
    // negative control: the scan can fail (the stored profile does hold the typed values)
    expect(JSON.stringify(await q('SELECT first_name, last_name FROM identity.account_profiles WHERE account_id = $1', [id]))).toContain(FIRST);
    // the audit rows name fields only
    for (const a of await audits(id)) expect(Object.keys(a.changes!)).toEqual(['fields']);
  });
});
