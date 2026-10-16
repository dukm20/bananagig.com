import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0011 adds the BananaGig-owned phone contact (identity.phone_contacts), one verification challenge per SMS send
// (identity.phone_verification_challenges), the audit extension (phone_contact_id + seven PHONE_* actions), the guard triggers (including the cap on the number of
// accounts that may hold one verified number), the deferred invariant triggers, ten verification.phone.* configuration parameters and 33 phone content entries.
// These tests drive the REAL tables with raw SQL: the shape of the schema (no plaintext secret, one E.164 column), every CHECK/UNIQUE/FK/PK by constraint name,
// the uniqueness policy and the number cap, every guard rule (SQLSTATE 23000, DETAIL identity_rule:<KEY>), the deferred invariants at COMMIT, atomic attempt
// counting and the cap under real concurrency, the audit extension and both seeds. Service behaviour is covered in packages/accounts.
let iso: IsolatedDatabase;
let pool: pg.Pool;
let racePool: pg.Pool;
let seq = 0;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = new pg.Pool({ connectionString: iso.url, max: 10 });
  racePool = new pg.Pool({ connectionString: iso.url, max: 24 });
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await iso?.drop();
});

// ---------------------------------------------------------------- helpers
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = []) => pool.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0]!.n;
interface PgFailure {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}
/** The failure of a statement (the test fails when the statement succeeds). */
const fail = async (p: Promise<unknown>): Promise<PgFailure> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  expect(e, 'the statement was expected to be rejected').toBeDefined();
  return e!;
};
/** The violated constraint (or unique index) of a rejected statement. */
const constraintOf = async (p: Promise<unknown>): Promise<string | undefined> => (await fail(p)).constraint;
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL identity_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `identity_rule:${key}` });
};
/** Asserts the statement is refused by a UNIQUE index (SQLSTATE 23505) and names it. */
const expectUnique = async (p: Promise<unknown>, index: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23505', constraint: index });
};
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const uniq = (): string => `${++seq}-${randomUUID().slice(0, 8)}`;
const hex64 = (): string => randomBytes(32).toString('hex');
/** A unique valid E.164 number (a plus, 1 + 3 + 7 digits); the digits never repeat inside one run of this file. */
let phoneSeq = 0;
const phoneNo = (): string => `+1202${String(++phoneSeq).padStart(7, '0')}`;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type Db = pg.Pool | pg.PoolClient;

/** Runs the callback in one transaction on its own connection: COMMIT on success (a deferred trigger may fail right there), ROLLBACK on any failure. */
async function inTxOn<T>(from: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const inTx = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => inTxOn(pool, fn);
/**
 * Runs `prep` statements and then `text` inside a transaction that is ALWAYS rolled back. Used to reach a CHECK or foreign key that a guard trigger
 * would report first: the prep disables the user triggers of one table for this transaction only.
 */
async function isolated(prep: string[], text: string, params: unknown[] = []): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const p of prep) await c.query(p);
    await c.query(text, params);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const noTriggers = (table: string): string[] => [`ALTER TABLE ${table} DISABLE TRIGGER USER`];
const CONTACTS = 'identity.phone_contacts';
const CHALLENGES = 'identity.phone_verification_challenges';
const AUDIT = 'identity.account_audit_events';

/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}

// ---------------------------------------------------------------- fixtures: accounts (the ID-001 shape, copied from email-model.itest.ts)
type AccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSURE_REQUESTED' | 'CLOSED';
const historyRow = (c: Db, accountId: string, from: string | null, to: string) =>
  c.query(
    "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2::text, $3::text, NULL, 'test', 'test-correlation')",
    [accountId, from, to],
  );
/** An account in its creation state (PENDING or ACTIVE) with the creation history row, in one transaction (the deferred trigger demands both). */
async function makeAccount(status: 'PENDING' | 'ACTIVE' = 'ACTIVE'): Promise<string> {
  return inTx(async (c) => {
    const r = await c.query('INSERT INTO identity.accounts (status) VALUES ($1) RETURNING account_id', [status]);
    const id = r.rows[0].account_id as string;
    await historyRow(c, id, null, status);
    return id;
  });
}
/** Moves an account to another status together with its history row (the service does the same in one transaction). */
async function setStatus(accountId: string, to: AccountStatus): Promise<void> {
  await inTx(async (c) => {
    const from = (await c.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0].status as string;
    await c.query(
      "UPDATE identity.accounts SET status = $2::text, closed_at = CASE WHEN $2::text = 'CLOSED' THEN now() END, updated_at = now() WHERE account_id = $1",
      [accountId, to],
    );
    await historyRow(c, accountId, from, to);
  });
}
/** An account in the given status, reached along a legal path (it holds no role, so it can be closed). */
async function accountIn(status: AccountStatus): Promise<string> {
  if (status === 'PENDING') return makeAccount('PENDING');
  const id = await makeAccount('ACTIVE');
  if (status === 'SUSPENDED' || status === 'CLOSURE_REQUESTED') await setStatus(id, status);
  if (status === 'CLOSED') {
    await setStatus(id, 'SUSPENDED');
    await setStatus(id, 'CLOSED');
  }
  return id;
}
const closeAccount = async (accountId: string): Promise<void> => {
  await setStatus(accountId, 'SUSPENDED');
  await setStatus(accountId, 'CLOSED');
};

// ---------------------------------------------------------------- fixtures: a second country (PLANNED is enough: the ACTIVE rule belongs to the service)
let countryLetter = 0;
/** A fresh PLANNED country (XA, XB, ...) with its locale and time zone link; returns its ISO alpha-2 code. */
async function makeCountry(): Promise<string> {
  const n = ++seq;
  const i = countryLetter++;
  const alpha2 = `${String.fromCharCode(88 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
  await inTx(async (c) => {
    // the default locale must be one of the country's locales (deferred constraint), so both rows go in one transaction
    const r = await c.query(
      `INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
       VALUES ($1, $2, $3, 'geography.country.us.name', 'PLANNED', '+999', 'USD', 'en-US', 'KILOMETERS', 'MONDAY', 'DMY', '24_HOUR') RETURNING country_id`,
      [alpha2, `${alpha2}Z`, String(900 + n).padStart(3, '0')],
    );
    const id = r.rows[0].country_id as string;
    await c.query("INSERT INTO geography.country_locales (country_id, locale) VALUES ($1, 'en-US')", [id]);
    await c.query(
      "INSERT INTO geography.country_time_zones (country_id, time_zone_id) SELECT $1, time_zone_id FROM geography.time_zones WHERE iana_name = 'America/Los_Angeles'",
      [id],
    );
  });
  return alpha2;
}

// ---------------------------------------------------------------- fixtures: contacts and challenges
interface Contact {
  id: string;
  accountId: string;
  phone: string;
  /** true for a REPLACEMENT_PENDING candidate (its challenges have the purpose CHANGE_PHONE) */
  replacement: boolean;
}
interface ContactInput {
  id?: string;
  phone?: string;
  country?: string;
  status?: string;
  primary?: boolean;
  source?: string;
  lineType?: string | null;
  /** defaults to "a line type was stored" */
  lineCheckedAt?: boolean;
  verified?: boolean;
  disabledAt?: boolean;
  disabledReason?: string | null;
}
const insertContact = async (accountId: string, o: ContactInput = {}): Promise<Contact> => {
  const phone = o.phone ?? phoneNo();
  const status = o.status ?? 'PENDING';
  const lineType = o.lineType ?? null;
  const r = await q<{ phone_contact_id: string }>(
    `INSERT INTO identity.phone_contacts (phone_contact_id, account_id, phone_e164, country_code, status, is_primary, source, line_type, line_type_checked_at, verified_at, disabled_at, disabled_reason)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::boolean THEN now() END, CASE WHEN $10::boolean THEN now() END, CASE WHEN $11::boolean THEN now() END, $12)
     RETURNING phone_contact_id`,
    [
      o.id ?? null,
      accountId,
      phone,
      o.country ?? 'US',
      status,
      o.primary ?? false,
      o.source ?? 'USER_ENTERED',
      lineType,
      o.lineCheckedAt ?? lineType !== null,
      o.verified ?? false,
      o.disabledAt ?? false,
      o.disabledReason ?? null,
    ],
  );
  return { id: r[0]!.phone_contact_id, accountId, phone, replacement: status === 'REPLACEMENT_PENDING' };
};
/** PENDING -> VERIFIED and primary (the legal first verification). */
const verifyOn = (db: Db, id: string) =>
  db.query("UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now(), updated_at = now() WHERE phone_contact_id = $1", [
    id,
  ]);
/** -> DISABLED (REPLACED for a verified primary, SUPERSEDED for a pending candidate). */
const disableOn = (db: Db, id: string, reason: 'REPLACED' | 'SUPERSEDED') =>
  db.query(
    "UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = $2, updated_at = now() WHERE phone_contact_id = $1",
    [id, reason],
  );
const consumeOn = (db: Db, challengeId: string) =>
  db.query('UPDATE identity.phone_verification_challenges SET used_at = now() WHERE challenge_id = $1', [challengeId]);
const invalidateOn = (db: Db, challengeId: string, reason: string) =>
  db.query('UPDATE identity.phone_verification_challenges SET invalidated_at = now(), invalidation_reason = $2 WHERE challenge_id = $1', [challengeId, reason]);
const setCap = (db: Db, value: string) => db.query("SELECT set_config('app.phone_max_accounts', $1, true)", [value]);

/** A new account with a PENDING number. */
const freshPending = async (o: ContactInput = {}): Promise<Contact> => insertContact(await makeAccount(), o);
/** A new account whose number is verified and primary (PENDING -> VERIFIED, no challenge involved). */
async function accountWithPrimary(o: ContactInput = {}): Promise<{ accountId: string; primary: Contact }> {
  const accountId = await makeAccount();
  const primary = await insertContact(accountId, o);
  await verifyOn(pool, primary.id);
  return { accountId, primary };
}
/** A new account with a verified primary and a REPLACEMENT_PENDING candidate. */
async function accountWithReplacement(
  o: { candidatePhone?: string; primaryPhone?: string } = {},
): Promise<{ accountId: string; primary: Contact; candidate: Contact }> {
  const { accountId, primary } = await accountWithPrimary(o.primaryPhone ? { phone: o.primaryPhone } : {});
  return {
    accountId,
    primary,
    candidate: await insertContact(accountId, { status: 'REPLACEMENT_PENDING', ...(o.candidatePhone ? { phone: o.candidatePhone } : {}) }),
  };
}
/** The replacement as the service performs it: disable the old primary, verify the candidate (one transaction). */
const replaceOld = (primary: Contact, candidate: Contact) =>
  inTx(async (c) => {
    await disableOn(c, primary.id, 'REPLACED');
    await verifyOn(c, candidate.id);
  });
/** One verification of a pending number the way the service does it: own transaction, account lock first, the cap setting, then the update. */
async function verifyUnderCap(c: Contact, setting: string | null, from: pg.Pool = pool): Promise<void> {
  await inTxOn(from, async (t) => {
    await t.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [c.accountId]);
    if (setting !== null) await setCap(t, setting);
    await verifyOn(t, c.id);
  });
}

/** Inserts a challenge; `override` replaces columns (or adds one such as used_at); expires_at defaults to ten minutes from the database clock. */
async function insertChallengeRow(contactId: string, override: Record<string, unknown> = {}, db: Db = pool): Promise<string> {
  const cols: Record<string, unknown> = {
    phone_contact_id: contactId,
    purpose: 'INITIAL_PHONE',
    code_hash: hex64(),
    correlation_id: 'test-correlation',
    ...override,
  };
  const names = Object.keys(cols);
  const withExpiry = 'expires_at' in cols;
  const text = `INSERT INTO identity.phone_verification_challenges (${names.join(', ')}${withExpiry ? '' : ', expires_at'})
    VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}${withExpiry ? '' : ", now() + interval '10 minutes'"}) RETURNING challenge_id`;
  return (await db.query(text, Object.values(cols))).rows[0].challenge_id as string;
}
const challengeFor = (c: Contact, override: Record<string, unknown> = {}, db: Db = pool): Promise<string> =>
  insertChallengeRow(c.id, { purpose: c.replacement ? 'CHANGE_PHONE' : 'INITIAL_PHONE', ...override }, db);
/** An insert with explicit SQL expressions for the timestamps (for the expiry check and expired fixtures). */
const challengeAt = (contactId: string, o: { expires: string; created?: string }) =>
  run(
    `INSERT INTO identity.phone_verification_challenges (phone_contact_id, purpose, code_hash, expires_at, created_at, correlation_id)
     VALUES ($1, 'INITIAL_PHONE', $2, ${o.expires}, ${o.created ?? 'now()'}, 'test-correlation')`,
    [contactId, hex64()],
  );

/** A new account with a PENDING number and one open INITIAL_PHONE challenge. */
async function freshOpen(): Promise<{ contact: Contact; challengeId: string }> {
  const contact = await freshPending();
  return { contact, challengeId: await challengeFor(contact) };
}
/** A new account with a verified primary, a REPLACEMENT_PENDING candidate and one open CHANGE_PHONE challenge. */
async function freshReplacementOpen() {
  const base = await accountWithReplacement();
  return { ...base, challengeId: await challengeFor(base.candidate) };
}
/** A challenge that was consumed together with the verification of its number (one transaction, as the service does it). */
async function freshUsed(): Promise<{ contact: Contact; challengeId: string }> {
  const { contact, challengeId } = await freshOpen();
  await inTx(async (c) => {
    await verifyOn(c, contact.id);
    await consumeOn(c, challengeId);
  });
  return { contact, challengeId };
}
/** A challenge that was invalidated (open -> closed without a use). */
async function freshInvalidated(reason = 'SUPERSEDED'): Promise<{ contact: Contact; challengeId: string }> {
  const { contact, challengeId } = await freshOpen();
  await invalidateOn(pool, challengeId, reason);
  return { contact, challengeId };
}

const contactState = async (id: string) =>
  (
    await q<{ status: string; is_primary: boolean; verified: boolean; disabled_reason: string | null }>(
      'SELECT status, is_primary, verified_at IS NOT NULL AS verified, disabled_reason FROM identity.phone_contacts WHERE phone_contact_id = $1',
      [id],
    )
  )[0]!;
const challengeState = async (id: string) =>
  (
    await q<{
      attempt_count: number;
      used: boolean;
      invalidated: boolean;
      invalidation_reason: string | null;
      delivery_status: string;
      sent: boolean;
    }>(
      `SELECT attempt_count, used_at IS NOT NULL AS used, invalidated_at IS NOT NULL AS invalidated, invalidation_reason, delivery_status,
              last_sent_at IS NOT NULL AS sent FROM identity.phone_verification_challenges WHERE challenge_id = $1`,
      [id],
    )
  )[0]!;
const primariesOf = async (accountId: string): Promise<number> => count(CONTACTS, 'account_id = $1 AND is_primary', [accountId]);
const holdersOf = async (phone: string): Promise<number> => count(CONTACTS, "phone_e164 = $1 AND status = 'VERIFIED'", [phone]);
const insertAudit = (accountId: string, action: string, contactId: string | null = null, changes: string | null = null) =>
  q<{ audit_event_id: string }>(
    `INSERT INTO ${AUDIT} (actor, action, account_id, phone_contact_id, changes, correlation_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING audit_event_id`,
    ['test', action, accountId, contactId, changes, 'test-correlation'],
  ).then((r) => r[0]!.audit_event_id);

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null];
const CONTACT_COLUMNS: ColumnShape[] = [
  ['phone_contact_id', 'uuid', false, 'gen_random_uuid()'],
  ['account_id', 'uuid', false, null],
  ['phone_e164', 'text', false, null],
  ['country_code', 'character', false, null],
  ['status', 'text', false, null],
  ['is_primary', 'boolean', false, 'false'],
  ['source', 'text', false, null],
  ['line_type', 'text', true, null],
  ['line_type_checked_at', 'timestamp with time zone', true, null],
  ['verified_at', 'timestamp with time zone', true, null],
  ['disabled_at', 'timestamp with time zone', true, null],
  ['disabled_reason', 'text', true, null],
  ['created_at', 'timestamp with time zone', false, 'now()'],
  ['updated_at', 'timestamp with time zone', false, 'now()'],
];
const CHALLENGE_COLUMNS: ColumnShape[] = [
  ['challenge_id', 'uuid', false, 'gen_random_uuid()'],
  ['phone_contact_id', 'uuid', false, null],
  ['purpose', 'text', false, null],
  ['code_hash', 'text', false, null],
  ['expires_at', 'timestamp with time zone', false, null],
  ['used_at', 'timestamp with time zone', true, null],
  ['attempt_count', 'integer', false, '0'],
  ['invalidated_at', 'timestamp with time zone', true, null],
  ['invalidation_reason', 'text', true, null],
  ['delivery_status', 'text', false, "'PENDING'::text"],
  ['last_sent_at', 'timestamp with time zone', true, null],
  ['created_at', 'timestamp with time zone', false, 'now()'],
  ['correlation_id', 'text', false, null],
];
const columnsOf = async (table: string): Promise<ColumnShape[]> =>
  (
    await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = $1 ORDER BY ordinal_position",
      [table],
    )
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default]);
const constraintsOf = async (table: string): Promise<{ conname: string; contype: string; confdeltype: string; target: string | null }[]> =>
  q(
    `SELECT conname, contype, confdeltype, confrelid::regclass::text AS target FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f', 'c') ORDER BY conname COLLATE "C"`,
    [table],
  );
const constraintDef = async (name: string): Promise<string> =>
  (await q<{ def: string }>('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [name]))[0]!.def;
const indexesOf = async (table: string): Promise<{ indexname: string; indexdef: string }[]> =>
  q('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = \'identity\' AND tablename = $1 ORDER BY indexname COLLATE "C"', [table]);
const commentOn = async (table: string, column?: string): Promise<string | null> =>
  (
    await q<{ c: string | null }>(
      column
        ? 'SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c'
        : "SELECT obj_description($1::regclass, 'pg_class') AS c",
      column ? [table, column] : [table],
    )
  )[0]!.c;
const triggersOf = async (table: string) =>
  q<{ tgname: string; def: string }>(
    'SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"',
    [table],
  );

const CONTACT_CONSTRAINTS = [
  'c:ck_phone_contacts__country_code',
  'c:ck_phone_contacts__disabled',
  'c:ck_phone_contacts__disabled_reason',
  'c:ck_phone_contacts__line_type',
  'c:ck_phone_contacts__line_type_pair',
  'c:ck_phone_contacts__phone_e164',
  'c:ck_phone_contacts__primary_is_verified',
  'c:ck_phone_contacts__source',
  'c:ck_phone_contacts__status',
  'c:ck_phone_contacts__verified_at',
  'f:fk_phone_contacts__account_id',
  'f:fk_phone_contacts__country_code',
  'p:pk_phone_contacts',
  'u:uq_phone_contacts__account_contact',
];
const CHALLENGE_CONSTRAINTS = [
  'c:ck_phone_verification_challenges__attempts',
  'c:ck_phone_verification_challenges__closed_once',
  'c:ck_phone_verification_challenges__code_hash',
  'c:ck_phone_verification_challenges__correlation',
  'c:ck_phone_verification_challenges__delivery',
  'c:ck_phone_verification_challenges__expiry',
  'c:ck_phone_verification_challenges__invalidated',
  'c:ck_phone_verification_challenges__purpose',
  'f:fk_phone_verification_challenges__phone_contact_id',
  'p:pk_phone_verification_challenges',
];

describe('A. schema shape: only a hash, no plaintext secret, one E.164 column, restrictive foreign keys', () => {
  it('adds exactly two tables to the identity schema (nine with 0010, eleven after 0011, thirteen after 0012, fifteen after 0013) and no sequence', async () => {
    const tables = await q<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity' AND table_type = 'BASE TABLE'",
    );
    expect(tables.map((r) => r.table_name).sort()).toEqual([
      'account_audit_events',
      'account_devices',
      'account_profiles',
      'account_roles',
      'account_status_history',
      'accounts',
      'application_sessions',
      'consent_events',
      'consent_purposes',
      'email_contacts',
      'email_verification_challenges',
      'external_identities',
      'phone_contacts',
      'phone_verification_challenges',
      'roles',
    ]);
    // the only sequence of the schema is the history sequence of 0009: the phone tables use uuid keys
    expect(await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'S'")).toEqual([
      { relname: 'account_status_history_history_seq_seq' },
    ]);
  });

  it('has exactly the documented columns, types, nullability and defaults on phone_contacts', async () => {
    expect(await columnsOf('phone_contacts')).toEqual(CONTACT_COLUMNS);
  });

  it('has exactly the documented columns, types, nullability and defaults on phone_verification_challenges', async () => {
    expect(await columnsOf('phone_verification_challenges')).toEqual(CHALLENGE_COLUMNS);
  });

  it('adds exactly one nullable uuid column (phone_contact_id) to the audit trail, after email_contact_id, and keeps the rest (0012 appends application_session_id and account_device_id, 0013 consent_event_id)', async () => {
    expect((await columnsOf('account_audit_events')).map(([n, t, nullable]) => [n, t, nullable])).toEqual([
      ['audit_event_id', 'uuid', false],
      ['occurred_at', 'timestamp with time zone', false],
      ['actor', 'text', false],
      ['action', 'text', false],
      ['account_id', 'uuid', false],
      ['role_id', 'uuid', true],
      ['changes', 'jsonb', true],
      ['reason', 'text', true],
      ['correlation_id', 'text', false],
      ['email_contact_id', 'uuid', true],
      ['phone_contact_id', 'uuid', true],
      ['application_session_id', 'uuid', true],
      ['account_device_id', 'uuid', true],
      ['consent_event_id', 'uuid', true],
    ]);
  });

  it('stores the country as char(2) and the number as plain text with no length limit beyond the CHECK', async () => {
    const r = await q<{ column_name: string; character_maximum_length: number | null }>(
      "SELECT column_name, character_maximum_length FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'phone_contacts' AND column_name IN ('country_code', 'phone_e164') ORDER BY column_name",
    );
    expect(r).toEqual([
      { column_name: 'country_code', character_maximum_length: 2 },
      { column_name: 'phone_e164', character_maximum_length: null },
    ]);
  });

  it('stores no plaintext secret: the only code-like columns are the HMAC code_hash and the ISO country_code (a CHECKed char(2) that cannot hold a code)', async () => {
    const secretLike = /(code|token|passw|secret|otp|credential|salt|plain|raw|link|url|pin|magic|hmac|key)/i;
    const offenders: string[] = [];
    for (const t of ['phone_contacts', 'phone_verification_challenges']) {
      for (const [name] of await columnsOf(t)) if (secretLike.test(name)) offenders.push(`${t}.${name}`);
    }
    expect(offenders.sort()).toEqual(['phone_contacts.country_code', 'phone_verification_challenges.code_hash']);
    expect(await constraintDef('ck_phone_contacts__country_code')).toContain('^[A-Z]{2}$');
  });

  it('has no magic_token_hash and no consumed_via column: an SMS carries a code and never a link', async () => {
    const names = (await columnsOf('phone_verification_challenges')).map(([n]) => n);
    expect(names).not.toContain('magic_token_hash');
    expect(names).not.toContain('consumed_via');
    expect(names.filter((n) => /(token|link|url|via)/i.test(n))).toEqual([]);
  });

  it('keeps one number column only: phone_e164 (no national, display, raw, original or masked phone column anywhere in the identity schema)', async () => {
    const rows = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'identity' AND column_name ~* '(phone|mobile|msisdn|e164|national|dialing|calling|display|original|masked|raw)' ORDER BY table_name, column_name`,
    );
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'account_audit_events.phone_contact_id',
      // coincidental match: the word "withdrawal" contains "raw" (the structural withdrawal policy of a consent purpose, 0013; not a phone column)
      'consent_purposes.withdrawal_policy',
      'phone_contacts.phone_contact_id',
      'phone_contacts.phone_e164',
      'phone_verification_challenges.phone_contact_id',
    ]);
  });

  it('has no JSON, array or binary column in the phone tables (every value is a typed scalar)', async () => {
    const types = new Set<string>();
    for (const t of ['phone_contacts', 'phone_verification_challenges']) for (const [, type] of await columnsOf(t)) types.add(type);
    expect([...types].sort()).toEqual(['boolean', 'character', 'integer', 'text', 'timestamp with time zone', 'uuid']);
  });

  it('has exactly the documented constraints on phone_contacts (primary key, the (account, contact) key the audit foreign key targets, two foreign keys, ten checks)', async () => {
    const c = await constraintsOf(CONTACTS);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual([...CONTACT_CONSTRAINTS].sort());
  });

  it('has exactly the documented constraints on phone_verification_challenges (primary key, restrictive foreign key, eight checks and NO unique hash)', async () => {
    const c = await constraintsOf(CHALLENGES);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual([...CHALLENGE_CONSTRAINTS].sort());
    expect(c.filter((r) => r.contype === 'u')).toEqual([]);
  });

  it('declares every foreign key of the phone model ON DELETE RESTRICT, and no foreign key of the identity schema cascades', async () => {
    const mine = [
      ...(await constraintsOf(CONTACTS)),
      ...(await constraintsOf(CHALLENGES)),
      ...(await constraintsOf(AUDIT)).filter((r) => r.conname.includes('phone_contact')),
    ].filter((r) => r.contype === 'f');
    expect(mine.map((r) => [r.conname, r.confdeltype, r.target]).sort()).toEqual(
      [
        ['fk_phone_contacts__account_id', 'r', 'identity.accounts'],
        ['fk_phone_contacts__country_code', 'r', 'geography.countries'],
        ['fk_phone_verification_challenges__phone_contact_id', 'r', 'identity.phone_contacts'],
        ['fk_account_audit_events__account_phone_contact', 'r', 'identity.phone_contacts'],
      ].sort(),
    );
    const loose = await q(
      "SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'identity' AND c.contype = 'f' AND c.confdeltype <> 'r'",
    );
    expect(loose).toEqual([]);
  });

  it('points the country foreign key at geography.countries (iso_alpha2), so the supported countries are data and not a list in the schema', async () => {
    expect(await constraintDef('fk_phone_contacts__country_code')).toBe(
      'FOREIGN KEY (country_code) REFERENCES geography.countries(iso_alpha2) ON DELETE RESTRICT',
    );
    expect(await constraintDef('fk_phone_contacts__account_id')).toBe('FOREIGN KEY (account_id) REFERENCES identity.accounts(account_id) ON DELETE RESTRICT');
    expect(await constraintDef('fk_phone_verification_challenges__phone_contact_id')).toBe(
      'FOREIGN KEY (phone_contact_id) REFERENCES identity.phone_contacts(phone_contact_id) ON DELETE RESTRICT',
    );
  });

  it('makes the audit foreign key COMPOSITE: an audit row can only name a contact of the audited account', async () => {
    expect(await constraintDef('fk_account_audit_events__account_phone_contact')).toBe(
      'FOREIGN KEY (account_id, phone_contact_id) REFERENCES identity.phone_contacts(account_id, phone_contact_id) ON DELETE RESTRICT',
    );
    expect(await q("SELECT 1 FROM pg_constraint WHERE conname = 'fk_account_audit_events__phone_contact_id'")).toEqual([]);
  });

  it('brings the identity schema to 141 primary key, unique, foreign key and check constraints (44 from 0009, 26 from 0010, 26 from 0011, 25 from 0012, 20 from 0013)', async () => {
    const { n } = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace WHERE s.nspname = 'identity' AND c.contype IN ('p', 'u', 'f', 'c')",
      )
    )[0]!;
    expect(n).toBe(141);
    expect(CONTACT_CONSTRAINTS.length + CHALLENGE_CONSTRAINTS.length + 2).toBe(26);
  });

  it('CHECKs the number to E.164 (a plus, a non-zero first digit, 7 to 15 digits in all) and the country to two capital letters (catalog)', async () => {
    expect(await constraintDef('ck_phone_contacts__phone_e164')).toContain('^\\+[1-9][0-9]{6,14}$');
    expect(await constraintDef('ck_phone_contacts__country_code')).toContain('^[A-Z]{2}$');
  });

  it('CHECKs the code hash to 64 lowercase hex characters (catalog)', async () => {
    expect(await constraintDef('ck_phone_verification_challenges__code_hash')).toContain('^[0-9a-f]{64}$');
  });

  it('CHECKs the enumerations (catalog): status, source (USER_ENTERED only), line type, disabled reason, purpose, invalidation reason, delivery status', async () => {
    expect(await constraintDef('ck_phone_contacts__status')).toMatch(/PENDING.*VERIFIED.*REPLACEMENT_PENDING.*DISABLED/);
    expect(await constraintDef('ck_phone_contacts__source')).toBe("CHECK ((source = 'USER_ENTERED'::text))");
    expect(await constraintDef('ck_phone_contacts__line_type')).toMatch(/MOBILE.*LANDLINE.*VOIP.*VIRTUAL.*UNKNOWN.*HIGH_RISK/);
    expect(await constraintDef('ck_phone_contacts__disabled_reason')).toMatch(/REPLACED.*SUPERSEDED/);
    expect(await constraintDef('ck_phone_verification_challenges__purpose')).toMatch(/INITIAL_PHONE.*CHANGE_PHONE/);
    expect(await constraintDef('ck_phone_verification_challenges__invalidated')).toMatch(/SUPERSEDED.*LOCKED.*CONTACT_DISABLED.*DELIVERY_FAILED/);
    expect(await constraintDef('ck_phone_verification_challenges__delivery')).toMatch(/PENDING.*SENT.*FAILED/);
  });

  it('has exactly the documented indexes on phone_contacts: three partial unique indexes, one partial lookup index and the (account, contact) key', async () => {
    const idx = await indexesOf('phone_contacts');
    expect(idx.map((r) => r.indexname)).toEqual([
      'idx_phone_contacts__verified_number',
      'pk_phone_contacts',
      'uq_phone_contacts__account_contact',
      'uq_phone_contacts__live_number_per_account',
      'uq_phone_contacts__open_per_account',
      'uq_phone_contacts__primary_per_account',
    ]);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.uq_phone_contacts__account_contact).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id, phone_contact_id\)$/);
    expect(def.uq_phone_contacts__primary_per_account).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id\) WHERE is_primary$/);
    expect(def.uq_phone_contacts__open_per_account).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(account_id\) WHERE \(status = ANY \(ARRAY\['PENDING'::text, 'REPLACEMENT_PENDING'::text\]\)\)$/,
    );
    expect(def.uq_phone_contacts__live_number_per_account).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(account_id, phone_e164\) WHERE \(status <> 'DISABLED'::text\)$/,
    );
    expect(def.idx_phone_contacts__verified_number).toMatch(/^CREATE INDEX .* USING btree \(phone_e164\) WHERE \(status = 'VERIFIED'::text\)$/);
  });

  it('has NO unique index on the number alone: how many accounts may verify one number is data (configuration), not a constraint of the schema', async () => {
    const unique = await q<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'identity' AND tablename = 'phone_contacts' AND indexdef LIKE 'CREATE UNIQUE%' AND indexdef LIKE '%phone_e164%'",
    );
    expect(unique.map((r) => r.indexname)).toEqual(['uq_phone_contacts__live_number_per_account']);
    // the only unique index that names the number also names the account first, so it limits one ACCOUNT, never the number across accounts
    expect(unique[0]!.indexdef).toContain('(account_id, phone_e164)');
    expect(await q("SELECT 1 FROM pg_indexes WHERE indexname = 'uq_phone_contacts__verified_number'")).toEqual([]);
  });

  it('has exactly the documented indexes on phone_verification_challenges: open-per-contact partial unique, contact history, no index on the hash', async () => {
    const idx = await indexesOf('phone_verification_challenges');
    expect(idx.map((r) => r.indexname)).toEqual([
      'idx_phone_verification_challenges__contact_created',
      'pk_phone_verification_challenges',
      'uq_phone_verification_challenges__open_per_contact',
    ]);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.uq_phone_verification_challenges__open_per_contact).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(phone_contact_id\) WHERE \(\(used_at IS NULL\) AND \(invalidated_at IS NULL\)\)$/,
    );
    expect(def.idx_phone_verification_challenges__contact_created).toMatch(/^CREATE INDEX .* USING btree \(phone_contact_id, created_at DESC\)$/);
    expect(idx.filter((r) => /code_hash/.test(r.indexdef))).toEqual([]);
  });

  it('adds no index to the audit trail for the new column (the per-account index serves the timeline)', async () => {
    const idx = await indexesOf('account_audit_events');
    expect(idx.filter((r) => /phone_contact_id/.test(r.indexdef))).toEqual([]);
  });

  it('wires the guards: a row guard BEFORE insert/update/delete on each table and the two deferred constraint triggers AFTER', async () => {
    const contacts = await triggersOf(CONTACTS);
    expect(contacts.map((t) => t.tgname)).toEqual(['trg_phone_contacts__guard', 'trg_phone_contacts__invariants']);
    expect(contacts[0]!.def).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON identity\.phone_contacts FOR EACH ROW EXECUTE FUNCTION identity\.guard_phone_contacts\(\)/,
    );
    expect(contacts[1]!.def).toMatch(
      /^CREATE CONSTRAINT TRIGGER .* AFTER INSERT OR UPDATE ON identity\.phone_contacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/,
    );
    const challenges = await triggersOf(CHALLENGES);
    expect(challenges.map((t) => t.tgname)).toEqual(['trg_phone_verification_challenges__consumption', 'trg_phone_verification_challenges__guard']);
    expect(challenges[0]!.def).toMatch(
      /^CREATE CONSTRAINT TRIGGER .* AFTER UPDATE ON identity\.phone_verification_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/,
    );
    expect(challenges[1]!.def).toMatch(/BEFORE INSERT OR DELETE OR UPDATE ON identity\.phone_verification_challenges FOR EACH ROW/);
  });

  it('documents both tables and their sensitive columns in the catalog', async () => {
    expect(await commentOn(CONTACTS)).toMatch(/PERSONAL DATA/);
    expect(await commentOn(CHALLENGES)).toMatch(/HMAC-SHA-256/);
    for (const col of ['phone_e164', 'country_code', 'is_primary', 'line_type', 'source']) expect(await commentOn(CONTACTS, col), col).toBeTruthy();
    for (const col of ['purpose', 'code_hash', 'last_sent_at', 'invalidation_reason']) expect(await commentOn(CHALLENGES, col), col).toBeTruthy();
    expect(await commentOn(AUDIT, 'phone_contact_id')).toMatch(/MASKED|never/);
  });

  it('starts empty: the migration seeds configuration and content only, never a number, a challenge or an audit row', async () => {
    const fresh = await createIsolatedDatabase();
    try {
      const c = new pg.Client({ connectionString: fresh.url });
      await c.connect();
      try {
        for (const t of ['identity.phone_contacts', 'identity.phone_verification_challenges', 'identity.account_audit_events'])
          expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
        expect((await c.query("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.phone%'")).rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
    } finally {
      await fresh.drop();
    }
  });
});

// ====================================================================== B. phone_contacts constraints
type Attempt = () => Promise<unknown>;
interface ConstraintCase {
  constraint: string;
  label: string;
  attempt: Attempt;
}
const bad = (constraint: string, label: string, attempt: Attempt): ConstraintCase => ({ constraint, label, attempt });

const BAD_NUMBERS: [label: string, value: string][] = [
  ['no plus sign', '12025550142'],
  ['a leading zero after the plus', '+02025550142'],
  ['a zero country code only', '+0'],
  ['a double plus', '++12025550142'],
  ['a plus in the middle', '1+2025550142'],
  ['a trailing plus', '12025550142+'],
  ['a space inside', '+1 2025550142'],
  ['a leading space', ' +12025550142'],
  ['a trailing space', '+12025550142 '],
  ['a trailing line feed', `+12025550142${ch(0x0a)}`],
  ['a tab', `+1202${ch(0x09)}5550142`],
  ['a non-breaking space', `+1202${ch(0xa0)}5550142`],
  ['dashes', '+1-202-555-0142'],
  ['dots', '+1.202.555.0142'],
  ['parentheses', '+1(202)5550142'],
  ['a slash', '+1/2025550142'],
  ['an extension', '+12025550142x12'],
  ['an extension with a comma', '+12025550142,12'],
  ['letters', '+1202555CALL'],
  ['only letters', '+abcdefghij'],
  ['a tel: prefix', 'tel:+12025550142'],
  ['an international 00 prefix', '0012025550142'],
  ['an empty string', ''],
  ['a plus sign only', '+'],
  ['6 digits (one too few)', '+123456'],
  ['1 digit', '+1'],
  ['16 digits (one too many)', '+1234567890123456'],
  ['20 digits', '+12345678901234567890'],
  ['full-width digits', `+${ch(0xff11, 0xff12, 0xff10, 0xff12, 0xff15, 0xff15, 0xff15, 0xff10, 0xff11, 0xff14, 0xff12)}`],
  ['Arabic-Indic digits', `+${ch(0x661, 0x662, 0x660, 0x662, 0x665, 0x665, 0x665, 0x660, 0x661, 0x664, 0x662)}`],
  ['a bidi override', `+1202555${ch(0x202e)}0142`],
  ['a control character', `+1202555${ch(0x01)}0142`],
  ['a zero-width space', `+1202555${ch(0x200b)}0142`],
  ['an emoji', `+1202555${ch(0x1f600)}0142`],
  ['a minus sign instead of the plus', '-12025550142'],
];
const GOOD_NUMBERS: [label: string, value: string][] = [
  ['the shortest valid shape (7 digits)', '+1234567'],
  ['the longest valid shape (15 digits)', '+123456789012345'],
  ['a US number', '+12025550142'],
  ['a UK number', '+442071838750'],
  ['a Japanese number', '+819012345678'],
  ['an Indian number', '+919876543210'],
  ['a number whose second digit is zero', '+10234567890'],
  ['a number of only nines', '+9999999999'],
];
const BAD_COUNTRIES: [label: string, value: string][] = [
  ['lower-case letters', 'us'],
  ['a mixed-case code', 'Us'],
  ['a single letter (padded with a space)', 'U'],
  ['an empty string (padded with spaces)', ''],
  ['a digit', '1S'],
  ['two digits', '84'],
  ['a letter and a digit', 'U1'],
  ['a hyphen', 'U-'],
  ['a space inside', 'U '],
  ['a non-ASCII capital', `${ch(0xc9)}A`],
  ['a full-width capital', `${ch(0xff35)}${ch(0xff33)}`],
];

const CONTACT_CASES: ConstraintCase[] = [
  bad('pk_phone_contacts', 'a duplicate phone_contact_id', async () => {
    const c = await freshPending();
    await insertContact(await makeAccount(), { id: c.id });
  }),
  bad(
    'uq_phone_contacts__account_contact',
    'a second row with the same (account_id, phone_contact_id) (primary key dropped and guards off for this transaction)',
    async () => {
      const c = await freshPending();
      await isolated(
        [...noTriggers(CONTACTS), 'ALTER TABLE identity.phone_contacts DROP CONSTRAINT pk_phone_contacts CASCADE'],
        `INSERT INTO identity.phone_contacts (phone_contact_id, account_id, phone_e164, country_code, status, source, disabled_at, disabled_reason)
       VALUES ($1, $2, $3, 'US', 'DISABLED', 'USER_ENTERED', now(), 'SUPERSEDED')`,
        [c.id, c.accountId, phoneNo()],
      );
    },
  ),
  bad('fk_phone_contacts__account_id', 'an account that does not exist', () => insertContact(randomUUID())),
  bad('fk_phone_contacts__country_code', 'a country that is not in geography.countries (ZZ)', async () =>
    insertContact(await makeAccount(), { country: 'ZZ' }),
  ),
  bad('fk_phone_contacts__country_code', 'a well-formed country that is not seeded (GB)', async () => insertContact(await makeAccount(), { country: 'GB' })),
  bad('ck_phone_contacts__status', 'an unknown status (guard bypassed: the insert guard refuses any non-pending status first)', async () => {
    const a = await makeAccount();
    await isolated(
      noTriggers(CONTACTS),
      "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'BOGUS', 'USER_ENTERED')",
      [a, phoneNo()],
    );
  }),
  bad('ck_phone_contacts__status', 'a lower-case status (guard bypassed)', async () => {
    const a = await makeAccount();
    await isolated(
      noTriggers(CONTACTS),
      "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'pending', 'USER_ENTERED')",
      [a, phoneNo()],
    );
  }),
  bad('ck_phone_contacts__status', 'an empty status (guard bypassed)', async () => {
    const a = await makeAccount();
    await isolated(
      noTriggers(CONTACTS),
      "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', '', 'USER_ENTERED')",
      [a, phoneNo()],
    );
  }),
  bad('ck_phone_contacts__source', 'an unknown source', async () => insertContact(await makeAccount(), { source: 'ADMIN' })),
  bad('ck_phone_contacts__source', 'the email-only source IDP_VERIFIED (a phone is never reported verified by an identity provider)', async () =>
    insertContact(await makeAccount(), { source: 'IDP_VERIFIED' }),
  ),
  bad('ck_phone_contacts__source', 'a lower-case source', async () => insertContact(await makeAccount(), { source: 'user_entered' })),
  ...BAD_NUMBERS.map(([label, value]) =>
    bad('ck_phone_contacts__phone_e164', `a number with ${label}`, async () => insertContact(await makeAccount(), { phone: value })),
  ),
  bad('ck_phone_contacts__phone_e164', 'an update to a malformed number (the guard reports a changed number first, so the guard is bypassed)', async () => {
    const c = await freshPending();
    await isolated(noTriggers(CONTACTS), "UPDATE identity.phone_contacts SET phone_e164 = '0123' WHERE phone_contact_id = $1", [c.id]);
  }),
  ...BAD_COUNTRIES.map(([label, value]) =>
    bad('ck_phone_contacts__country_code', `a country code with ${label}`, async () => insertContact(await makeAccount(), { country: value })),
  ),
  bad('ck_phone_contacts__line_type', 'an unknown line type', async () => insertContact(await makeAccount(), { lineType: 'PREPAID' })),
  bad('ck_phone_contacts__line_type', 'a lower-case line type', async () => insertContact(await makeAccount(), { lineType: 'mobile' })),
  bad('ck_phone_contacts__line_type', 'an empty line type', async () => insertContact(await makeAccount(), { lineType: '' })),
  bad('ck_phone_contacts__line_type', 'a plural line type', async () => insertContact(await makeAccount(), { lineType: 'LANDLINES' })),
  bad('ck_phone_contacts__line_type_pair', 'a line type without the time of the check', async () =>
    insertContact(await makeAccount(), { lineType: 'MOBILE', lineCheckedAt: false }),
  ),
  bad('ck_phone_contacts__line_type_pair', 'the time of a check without a line type', async () =>
    insertContact(await makeAccount(), { lineType: null, lineCheckedAt: true }),
  ),
  bad('ck_phone_contacts__primary_is_verified', 'a PENDING row flagged primary (insert)', async () => insertContact(await makeAccount(), { primary: true })),
  bad('ck_phone_contacts__primary_is_verified', 'a DISABLED row that is still flagged primary', async () => {
    const { primary } = await accountWithReplacement();
    await run("UPDATE identity.phone_contacts SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'REPLACED' WHERE phone_contact_id = $1", [
      primary.id,
    ]);
  }),
  bad('ck_phone_contacts__verified_at', 'a PENDING row with verified_at (insert)', async () => insertContact(await makeAccount(), { verified: true })),
  bad('ck_phone_contacts__verified_at', 'a REPLACEMENT_PENDING row with verified_at (insert)', async () => {
    const { accountId } = await accountWithPrimary();
    await insertContact(accountId, { status: 'REPLACEMENT_PENDING', verified: true });
  }),
  bad('ck_phone_contacts__verified_at', 'the transition to VERIFIED without verified_at', async () => {
    const c = await freshPending();
    await run("UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true WHERE phone_contact_id = $1", [c.id]);
  }),
  bad('ck_phone_contacts__verified_at', 'verified_at set on a row that stays PENDING', async () => {
    const c = await freshPending();
    await run('UPDATE identity.phone_contacts SET verified_at = now() WHERE phone_contact_id = $1', [c.id]);
  }),
  bad('ck_phone_contacts__disabled', 'DISABLED without disabled_at', async () => {
    const c = await freshPending();
    await run("UPDATE identity.phone_contacts SET status = 'DISABLED', disabled_reason = 'SUPERSEDED' WHERE phone_contact_id = $1", [c.id]);
  }),
  bad('ck_phone_contacts__disabled', 'DISABLED without disabled_reason (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(noTriggers(CONTACTS), "UPDATE identity.phone_contacts SET status = 'DISABLED', disabled_at = now() WHERE phone_contact_id = $1", [c.id]);
  }),
  bad('ck_phone_contacts__disabled', 'disabled_at on a live row', async () => {
    const c = await freshPending();
    await run('UPDATE identity.phone_contacts SET disabled_at = now() WHERE phone_contact_id = $1', [c.id]);
  }),
  bad('ck_phone_contacts__disabled', 'disabled_reason on a live row', async () => {
    const c = await freshPending();
    await run("UPDATE identity.phone_contacts SET disabled_reason = 'SUPERSEDED' WHERE phone_contact_id = $1", [c.id]);
  }),
  bad('ck_phone_contacts__disabled_reason', 'a reason outside REPLACED and SUPERSEDED (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(
      noTriggers(CONTACTS),
      "UPDATE identity.phone_contacts SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'BOGUS' WHERE phone_contact_id = $1",
      [c.id],
    );
  }),
  bad('ck_phone_contacts__disabled_reason', 'an empty reason (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(
      noTriggers(CONTACTS),
      "UPDATE identity.phone_contacts SET status = 'DISABLED', disabled_at = now(), disabled_reason = '' WHERE phone_contact_id = $1",
      [c.id],
    );
  }),
];

describe('B. phone_contacts constraints reject bad data, by constraint name', () => {
  it.each(CONTACT_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it.each(GOOD_NUMBERS)('accepts %s', async (_label, value) => {
    const c = await insertContact(await makeAccount(), { phone: value });
    expect((await contactState(c.id)).status).toBe('PENDING');
    expect(await q('SELECT phone_e164 FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id])).toEqual([{ phone_e164: value }]);
  });

  it.each(['MOBILE', 'LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'])(
    'accepts the line type %s together with the time of the check',
    async (lineType) => {
      const c = await freshPending({ lineType });
      expect(await q('SELECT line_type, line_type_checked_at IS NOT NULL AS checked FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id])).toEqual(
        [{ line_type: lineType, checked: true }],
      );
    },
  );

  it('accepts a number without a line type snapshot (no lookup was needed): both columns NULL', async () => {
    const c = await freshPending();
    expect(await q('SELECT line_type, line_type_checked_at FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id])).toEqual([
      { line_type: null, line_type_checked_at: null },
    ]);
  });

  it('accepts a country that exists but is not ACTIVE (PLANNED): the ACTIVE and dialing-code rules belong to the service, the schema only keeps the reference valid', async () => {
    const country = await makeCountry();
    const c = await freshPending({ country });
    expect(await q('SELECT country_code FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id])).toEqual([{ country_code: country }]);
  });

  it('stores the country exactly as given: US for a +1 number, and the same number may carry another country row (the country is not derived by the schema)', async () => {
    const country = await makeCountry();
    const phone = phoneNo();
    const a = await freshPending({ phone, country: 'US' });
    const b = await freshPending({ phone, country });
    expect((await q<{ country_code: string }>('SELECT country_code FROM identity.phone_contacts WHERE phone_contact_id = $1', [a.id]))[0]!.country_code).toBe(
      'US',
    );
    expect((await q<{ country_code: string }>('SELECT country_code FROM identity.phone_contacts WHERE phone_contact_id = $1', [b.id]))[0]!.country_code).toBe(
      country,
    );
  });

  it('defaults a new row to PENDING-compatible values (not primary, no verified_at, no disabled_at, no line type, timestamps set by the database)', async () => {
    const a = await makeAccount();
    const r = await q(
      `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED')
       RETURNING is_primary, line_type, line_type_checked_at, verified_at, disabled_at, disabled_reason, created_at IS NOT NULL AS created, updated_at IS NOT NULL AS updated`,
      [a, phoneNo()],
    );
    expect(r).toEqual([
      {
        is_primary: false,
        line_type: null,
        line_type_checked_at: null,
        verified_at: null,
        disabled_at: null,
        disabled_reason: null,
        created: true,
        updated: true,
      },
    ]);
  });

  it('accepts a verified primary that carries verified_at (PENDING -> VERIFIED with the primary flag)', async () => {
    const { primary } = await accountWithPrimary();
    expect(await contactState(primary.id)).toEqual({ status: 'VERIFIED', is_primary: true, verified: true, disabled_reason: null });
  });
});

// ====================================================================== C. uniqueness policy and the cap
describe('C. uniqueness policy: pending duplicates are allowed, the verified duplicates are capped by the guard (never by an index)', () => {
  it('lets two accounts hold the SAME number as PENDING (a pending claim proves nothing)', async () => {
    const phone = phoneNo();
    const a = await insertContact(await makeAccount(), { phone });
    const b = await insertContact(await makeAccount(), { phone });
    expect(a.id).not.toBe(b.id);
    expect(await count(CONTACTS, "phone_e164 = $1 AND status = 'PENDING'", [phone])).toBe(2);
  });

  it('lets six accounts hold the same number as PENDING at once (nothing counts a pending claim)', async () => {
    const phone = phoneNo();
    for (let n = 0; n < 6; n++) await insertContact(await makeAccount(), { phone });
    expect(await count(CONTACTS, 'phone_e164 = $1', [phone])).toBe(6);
  });

  it('lets another account hold the number as PENDING or REPLACEMENT_PENDING after it is verified elsewhere (the owner is not revealed or blocked)', async () => {
    const phone = phoneNo();
    const first = await insertContact(await makeAccount(), { phone });
    await verifyOn(pool, first.id);
    const second = await insertContact(await makeAccount(), { phone });
    expect((await contactState(second.id)).status).toBe('PENDING');
    const withPrimary = await accountWithPrimary();
    const third = await insertContact(withPrimary.accountId, { phone, status: 'REPLACEMENT_PENDING' });
    expect((await contactState(third.id)).status).toBe('REPLACEMENT_PENDING');
  });

  it('does not count a PENDING or REPLACEMENT_PENDING claim toward the cap: with a cap of 1 and one pending twin the verification still succeeds', async () => {
    const phone = phoneNo();
    await insertContact(await makeAccount(), { phone });
    const { accountId } = await accountWithPrimary();
    await insertContact(accountId, { phone, status: 'REPLACEMENT_PENDING' });
    const mine = await insertContact(await makeAccount(), { phone });
    await verifyUnderCap(mine, '1');
    expect((await contactState(mine.id)).status).toBe('VERIFIED');
  });

  it('does not count a different number of the same person, only the same E.164 string', async () => {
    const holder = await freshPending();
    await verifyUnderCap(holder, '1');
    const other = await freshPending();
    await verifyUnderCap(other, '1');
    expect((await contactState(other.id)).status).toBe('VERIFIED');
  });

  it('does NOT block the same number verified on a second account by an index: the structural default allows it (no setting)', async () => {
    const phone = phoneNo();
    const a = await insertContact(await makeAccount(), { phone });
    const b = await insertContact(await makeAccount(), { phone });
    await verifyOn(pool, a.id);
    await verifyOn(pool, b.id);
    expect(await holdersOf(phone)).toBe(2);
  });

  describe('the cap (guard rule PHONE_NUMBER_CAP, transaction setting app.phone_max_accounts)', () => {
    // [label, setting, how many accounts may hold the number]; an absent or invalid setting falls back to the structural ceiling of five accounts
    const CAPS: [label: string, setting: string | null, holders: number][] = [
      ["'1'", '1', 1],
      ["'2'", '2', 2],
      ["'3'", '3', 3],
      ["'4'", '4', 4],
      ["'5'", '5', 5],
      ['unset (no setting at all)', null, 5],
      ["'0' (below the range)", '0', 5],
      ["'6' (above the range)", '6', 5],
      ["'7'", '7', 5],
      ["'10' (two digits)", '10', 5],
      ["'15' (starts with an allowed digit)", '15', 5],
      ["'abc' (not a number)", 'abc', 5],
      ["'' (empty)", '', 5],
      ["'-1' (negative)", '-1', 5],
      ["'+2' (signed)", '+2', 5],
      ["'1.0' (decimal)", '1.0', 5],
      ["' 2' (leading space)", ' 2', 5],
      ["'2 ' (trailing space)", '2 ', 5],
      [`'2' followed by a line feed`, `2${ch(0x0a)}`, 5],
      ["'02' (leading zero)", '02', 5],
      ["'1,2'", '1,2', 5],
      ["'NaN'", 'NaN', 5],
      ['an Arabic-Indic digit', ch(0x663), 5],
      ['a full-width digit', ch(0xff12), 5],
    ];
    it.each(CAPS)(
      'with the setting %s exactly %s accounts can verify one number and the next one is refused PHONE_NUMBER_CAP',
      async (_label, setting, holders) => {
        const phone = phoneNo();
        const contacts: Contact[] = [];
        for (let n = 0; n < holders + 1; n++) contacts.push(await insertContact(await makeAccount(), { phone }));
        for (const c of contacts.slice(0, holders)) await verifyUnderCap(c, setting);
        expect(await holdersOf(phone)).toBe(holders);
        const refused = contacts[holders]!;
        await expectRule(verifyUnderCap(refused, setting), 'PHONE_NUMBER_CAP');
        expect(await contactState(refused.id)).toMatchObject({ status: 'PENDING', is_primary: false, verified: false });
        expect(await holdersOf(phone)).toBe(holders);
      },
    );

    it('refuses the second account with a cap of 1 and leaves its row, its challenge and its audit trail untouched', async () => {
      const phone = phoneNo();
      const first = await insertContact(await makeAccount(), { phone });
      const second = await insertContact(await makeAccount(), { phone });
      const challengeId = await challengeFor(second);
      await verifyUnderCap(first, '1');
      await expectRule(
        inTx(async (c) => {
          await setCap(c, '1');
          await verifyOn(c, second.id);
          await consumeOn(c, challengeId);
        }),
        'PHONE_NUMBER_CAP',
      );
      expect(await contactState(second.id)).toMatchObject({ status: 'PENDING', verified: false });
      expect(await challengeState(challengeId)).toMatchObject({ used: false, invalidated: false, attempt_count: 0 });
    });

    it('evaluates the cap with the setting of the verifying transaction, not a stored value (cap 5 lets a second account in, a later cap 1 refuses a third)', async () => {
      const phone = phoneNo();
      const [a, b, c] = [
        await insertContact(await makeAccount(), { phone }),
        await insertContact(await makeAccount(), { phone }),
        await insertContact(await makeAccount(), { phone }),
      ];
      await verifyUnderCap(a, '5');
      await verifyUnderCap(b, '5');
      await expectRule(verifyUnderCap(c, '2'), 'PHONE_NUMBER_CAP');
      await expectRule(verifyUnderCap(c, '1'), 'PHONE_NUMBER_CAP');
      await verifyUnderCap(c, '3');
      expect(await holdersOf(phone)).toBe(3);
    });

    it('scopes the setting to the transaction: a later transaction without the setting is back to the structural five', async () => {
      const phone = phoneNo();
      const a = await insertContact(await makeAccount(), { phone });
      const b = await insertContact(await makeAccount(), { phone });
      await verifyUnderCap(a, '1');
      await expectRule(verifyUnderCap(b, '1'), 'PHONE_NUMBER_CAP');
      await verifyUnderCap(b, null);
      expect(await holdersOf(phone)).toBe(2);
    });

    it('leaves no session-wide setting behind (set_config is transaction-local)', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await setCap(c, '1');
        expect((await c.query("SELECT current_setting('app.phone_max_accounts', true) AS v")).rows[0].v).toBe('1');
        await c.query('COMMIT');
        expect([null, '']).toContain((await c.query("SELECT current_setting('app.phone_max_accounts', true) AS v")).rows[0].v);
      } finally {
        c.release();
      }
    });

    it('counts DISTINCT accounts that hold the number VERIFIED, and ignores the verifying account itself (the count excludes its own rows)', async () => {
      // the live-number and primary unique indexes are dropped in this rolled-back transaction so one account can hold the same number twice
      const holder = await accountWithPrimary();
      const phone = holder.primary.phone;
      await isolated(
        [
          'DROP INDEX identity.uq_phone_contacts__live_number_per_account',
          'DROP INDEX identity.uq_phone_contacts__primary_per_account',
          `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ('${holder.accountId}', '${phone}', 'US', 'REPLACEMENT_PENDING', 'USER_ENTERED')`,
          "SELECT set_config('app.phone_max_accounts', '1', true)",
        ],
        "UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE account_id = $1 AND status = 'REPLACEMENT_PENDING'",
        [holder.accountId],
      );
    });

    it('does count ANOTHER account in the same situation (the same statement is refused when a different account holds the number)', async () => {
      const holder = await accountWithPrimary();
      const phone = holder.primary.phone;
      const other = await accountWithPrimary();
      await expectRule(
        isolated(
          [
            'DROP INDEX identity.uq_phone_contacts__live_number_per_account',
            'DROP INDEX identity.uq_phone_contacts__primary_per_account',
            `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ('${other.accountId}', '${phone}', 'US', 'REPLACEMENT_PENDING', 'USER_ENTERED')`,
            "SELECT set_config('app.phone_max_accounts', '1', true)",
          ],
          "UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE account_id = $1 AND status = 'REPLACEMENT_PENDING'",
          [other.accountId],
        ),
        'PHONE_NUMBER_CAP',
      );
    });

    it('counts a replaced (DISABLED) row as nobody: a number released by its holder is free again at a cap of 1', async () => {
      const phone = phoneNo();
      const { primary, candidate } = await accountWithReplacement({ primaryPhone: phone });
      const taker = await insertContact(await makeAccount(), { phone });
      await expectRule(verifyUnderCap(taker, '1'), 'PHONE_NUMBER_CAP');
      await replaceOld(primary, candidate);
      await verifyUnderCap(taker, '1');
      expect(await holdersOf(phone)).toBe(1);
      expect(await contactState(primary.id)).toMatchObject({ status: 'DISABLED', disabled_reason: 'REPLACED' });
    });

    it('lets a former holder take its number back as a replacement of the same account, and does not count its own DISABLED history row', async () => {
      const phone = phoneNo();
      const { accountId, primary, candidate } = await accountWithReplacement({ primaryPhone: phone });
      await replaceOld(primary, candidate);
      const back = await insertContact(accountId, { phone, status: 'REPLACEMENT_PENDING' });
      await inTx(async (c) => {
        await setCap(c, '1');
        await disableOn(c, candidate.id, 'REPLACED');
        await verifyOn(c, back.id);
      });
      expect(await contactState(back.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    });

    it('releases a SUPERSEDED pending claim as well: it was never counted and a disabled twin changes nothing', async () => {
      const phone = phoneNo();
      const claim = await insertContact(await makeAccount(), { phone });
      await disableOn(pool, claim.id, 'SUPERSEDED');
      const a = await insertContact(await makeAccount(), { phone });
      await verifyUnderCap(a, '1');
      expect(await holdersOf(phone)).toBe(1);
    });

    it('applies the cap to a REPLACEMENT verification too: the whole replacement rolls back and the old primary stays primary', async () => {
      const phone = phoneNo();
      const owner = await insertContact(await makeAccount(), { phone });
      await verifyUnderCap(owner, '1');
      const { accountId, primary, candidate } = await accountWithReplacement({ candidatePhone: phone });
      await expectRule(
        inTx(async (c) => {
          await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
          await setCap(c, '1');
          await disableOn(c, primary.id, 'REPLACED');
          await verifyOn(c, candidate.id);
        }),
        'PHONE_NUMBER_CAP',
      );
      expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('does not apply the cap to an update that does not verify (touching a verified row, disabling a pending one)', async () => {
      const phone = phoneNo();
      const a = await insertContact(await makeAccount(), { phone });
      const b = await insertContact(await makeAccount(), { phone });
      await verifyUnderCap(a, '1');
      await inTx(async (c) => {
        await setCap(c, '1');
        await c.query("UPDATE identity.phone_contacts SET updated_at = now() + interval '1 second' WHERE phone_contact_id = $1", [a.id]);
        await disableOn(c, b.id, 'SUPERSEDED');
      });
      expect((await contactState(b.id)).status).toBe('DISABLED');
    });

    it('reports a closed account before the cap (ACCOUNT_CLOSED is checked first)', async () => {
      const phone = phoneNo();
      const holder = await insertContact(await makeAccount(), { phone });
      await verifyUnderCap(holder, '1');
      const closed = await insertContact(await makeAccount(), { phone });
      await closeAccount(closed.accountId);
      await expectRule(verifyUnderCap(closed, '1'), 'ACCOUNT_CLOSED');
    });

    it('reports verification without the primary flag before the cap (PHONE_PRIMARY_CHANGE is checked first)', async () => {
      const phone = phoneNo();
      const holder = await insertContact(await makeAccount(), { phone });
      await verifyUnderCap(holder, '1');
      const other = await insertContact(await makeAccount(), { phone });
      await expectRule(
        inTx(async (c) => {
          await setCap(c, '1');
          await c.query("UPDATE identity.phone_contacts SET status = 'VERIFIED', verified_at = now() WHERE phone_contact_id = $1", [other.id]);
        }),
        'PHONE_PRIMARY_CHANGE',
      );
    });

    it('serializes two verifications of one number even without any account lock: the guard takes its own number lock (cap 1, the second waits then is refused)', async () => {
      const phone = phoneNo();
      const a = await insertContact(await makeAccount(), { phone });
      const b = await insertContact(await makeAccount(), { phone });
      const t1 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await setCap(t1, '1');
        await verifyOn(t1, a.id);
        const second = rejection(
          inTx(async (c) => {
            await setCap(c, '1');
            await verifyOn(c, b.id);
          }),
        );
        await lockWaiters(1);
        await t1.query('COMMIT');
        const e = (await second) as PgFailure;
        expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:PHONE_NUMBER_CAP' });
      } finally {
        await t1.query('ROLLBACK').catch(() => undefined);
        t1.release();
      }
      expect(await holdersOf(phone)).toBe(1);
    });

    it('lets the second verification through when the first one rolls back (the number lock is transaction-scoped)', async () => {
      const phone = phoneNo();
      const a = await insertContact(await makeAccount(), { phone });
      const b = await insertContact(await makeAccount(), { phone });
      const t1 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await setCap(t1, '1');
        await verifyOn(t1, a.id);
        const second = verifyUnderCap(b, '1');
        await lockWaiters(1);
        await t1.query('ROLLBACK');
        await second;
      } finally {
        await t1.query('ROLLBACK').catch(() => undefined);
        t1.release();
      }
      expect((await contactState(a.id)).status).toBe('PENDING');
      expect((await contactState(b.id)).status).toBe('VERIFIED');
    });
  });

  describe('per-account indexes', () => {
    it('allows one primary per account: a second primary in the same account is refused (uq_phone_contacts__primary_per_account)', async () => {
      const { candidate } = await accountWithReplacement();
      // the old primary is still primary: verifying the replacement without replacing it first collides
      await expectUnique(verifyOn(pool, candidate.id), 'uq_phone_contacts__primary_per_account');
      expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
    });

    it('allows one open candidate per account: a second PENDING number in the same account is refused (uq_phone_contacts__open_per_account)', async () => {
      const a = await makeAccount();
      await insertContact(a);
      await expectUnique(insertContact(a), 'uq_phone_contacts__open_per_account');
      expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(1);
    });

    it('allows one open candidate per account: a second REPLACEMENT_PENDING number is refused too', async () => {
      const { accountId } = await accountWithReplacement();
      await expectUnique(insertContact(accountId, { status: 'REPLACEMENT_PENDING' }), 'uq_phone_contacts__open_per_account');
    });

    it('refuses the same live number twice in one account, verified and replacement-pending (uq_phone_contacts__live_number_per_account)', async () => {
      const { accountId, primary } = await accountWithPrimary();
      await expectUnique(insertContact(accountId, { phone: primary.phone, status: 'REPLACEMENT_PENDING' }), 'uq_phone_contacts__live_number_per_account');
    });

    it('allows the same number again in one account once the first row is DISABLED (superseded history is kept)', async () => {
      const a = await makeAccount();
      const phone = phoneNo();
      const first = await insertContact(a, { phone });
      await disableOn(pool, first.id, 'SUPERSEDED');
      const second = await insertContact(a, { phone });
      expect(await count(CONTACTS, 'account_id = $1 AND phone_e164 = $2', [a, phone])).toBe(2);
      expect(await contactState(first.id)).toMatchObject({ status: 'DISABLED', disabled_reason: 'SUPERSEDED' });
      expect((await contactState(second.id)).status).toBe('PENDING');
    });

    it('lets the former number come back as a replacement of the same account (the replaced row is DISABLED, so the live-number index is free)', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await replaceOld(primary, candidate);
      const back = await insertContact(accountId, { phone: primary.phone, status: 'REPLACEMENT_PENDING' });
      expect((await contactState(back.id)).status).toBe('REPLACEMENT_PENDING');
    });

    it('treats the number verbatim: only the canonical E.164 string is stored, so a formatted variant cannot exist (the CHECK refuses it)', async () => {
      const phone = phoneNo();
      await insertContact(await makeAccount(), { phone });
      const formatted = `${phone.slice(0, 2)} ${phone.slice(2)}`;
      expect(await constraintOf(insertContact(await makeAccount(), { phone: formatted }))).toBe('ck_phone_contacts__phone_e164');
    });

    it('lets independent accounts each hold their own open candidate at once', async () => {
      await freshPending();
      await freshPending();
      await accountWithReplacement();
    });

    it('releases a verified number for another account when its holder replaces it (DISABLED rows are outside the verified index)', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await replaceOld(primary, candidate);
      const taken = await insertContact(await makeAccount(), { phone: primary.phone });
      await verifyUnderCap(taken, '1');
      expect(await contactState(taken.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect(await primariesOf(accountId)).toBe(1);
    });
  });
});

// ====================================================================== D. contact guards
type ContactStatus = 'PENDING' | 'VERIFIED' | 'REPLACEMENT_PENDING' | 'DISABLED';
/** A contact in the given status, reached along a legal path (VERIFIED and REPLACEMENT_PENDING rows belong to an account with a primary). */
async function contactIn(status: ContactStatus): Promise<Contact> {
  if (status === 'PENDING') return freshPending();
  if (status === 'VERIFIED') return (await accountWithPrimary()).primary;
  if (status === 'REPLACEMENT_PENDING') return (await accountWithReplacement()).candidate;
  const c = await freshPending();
  await disableOn(pool, c.id, 'SUPERSEDED');
  return c;
}

describe('D. contact guards: deletion, immutability, transitions, primary changes, insert rules', () => {
  it.each<ContactStatus>(['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED'])('refuses to delete a %s contact (NOT_DELETABLE)', async (status) => {
    const c = await contactIn(status);
    await expectRule(run('DELETE FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id]), 'NOT_DELETABLE');
    expect(await count(CONTACTS, 'phone_contact_id = $1', [c.id])).toBe(1);
  });

  it('refuses a bulk delete across all contacts too', async () => {
    await freshPending();
    await expectRule(run('DELETE FROM identity.phone_contacts'), 'NOT_DELETABLE');
  });

  it('refuses to delete an account row that still has contacts (the account foreign key is RESTRICT)', async () => {
    const c = await freshPending();
    const e = await fail(run('DELETE FROM identity.accounts WHERE account_id = $1', [c.accountId]));
    expect(e.code).toBe('23000');
    expect(await count(CONTACTS, 'phone_contact_id = $1', [c.id])).toBe(1);
  });

  describe('immutable identity columns (IMMUTABLE_IDENTITY)', () => {
    const IMMUTABLE: [column: string, value: () => Promise<unknown>, withLineType: boolean][] = [
      ['phone_contact_id', async () => randomUUID(), false],
      ['account_id', async () => makeAccount(), false],
      ['phone_e164', async () => phoneNo(), false],
      ['country_code', async () => 'GB', false],
      ['source', async () => 'OTHER', false],
      ['created_at', async () => new Date(0), false],
      ['line_type', async () => 'LANDLINE', true],
      ['line_type', async () => 'MOBILE', false],
      ['line_type', async () => null, true],
      ['line_type_checked_at', async () => new Date(Date.now() + 3_600_000), true],
      ['line_type_checked_at', async () => new Date(Date.now() + 3_600_000), false],
      ['line_type_checked_at', async () => null, true],
    ];
    it.each(IMMUTABLE)('keeps %s immutable (#%#)', async (column, value, withLineType) => {
      const c = await freshPending(withLineType ? { lineType: 'MOBILE' } : {});
      await expectRule(run(`UPDATE identity.phone_contacts SET ${column} = $2 WHERE phone_contact_id = $1`, [c.id, await value()]), 'IMMUTABLE_IDENTITY');
    });

    it.each<ContactStatus>(['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING'])('keeps the number of a %s contact immutable', async (status) => {
      const c = await contactIn(status);
      await expectRule(run('UPDATE identity.phone_contacts SET phone_e164 = $2 WHERE phone_contact_id = $1', [c.id, phoneNo()]), 'IMMUTABLE_IDENTITY');
      expect((await q<{ phone_e164: string }>('SELECT phone_e164 FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id]))[0]!.phone_e164).toBe(
        c.phone,
      );
    });

    it('keeps the number immutable even when the new value is also a valid number, and when it changes together with a legal transition', async () => {
      const c = await freshPending();
      await expectRule(
        run("UPDATE identity.phone_contacts SET phone_e164 = $2, status = 'VERIFIED', is_primary = true, verified_at = now() WHERE phone_contact_id = $1", [
          c.id,
          phoneNo(),
        ]),
        'IMMUTABLE_IDENTITY',
      );
      expect((await contactState(c.id)).status).toBe('PENDING');
    });

    it('keeps the country immutable even when it moves to another existing country together with a legal transition', async () => {
      const country = await makeCountry();
      const c = await freshPending();
      await expectRule(
        run("UPDATE identity.phone_contacts SET country_code = $2, status = 'VERIFIED', is_primary = true, verified_at = now() WHERE phone_contact_id = $1", [
          c.id,
          country,
        ]),
        'IMMUTABLE_IDENTITY',
      );
    });

    it('keeps the line type snapshot immutable when the snapshot is applied together with a legal transition', async () => {
      const c = await freshPending({ lineType: 'MOBILE' });
      await expectRule(
        run(
          "UPDATE identity.phone_contacts SET line_type = 'VIRTUAL', status = 'VERIFIED', is_primary = true, verified_at = now() WHERE phone_contact_id = $1",
          [c.id],
        ),
        'IMMUTABLE_IDENTITY',
      );
    });

    it('lets a legal transition keep line_type and line_type_checked_at as they are (the snapshot survives the verification)', async () => {
      const c = await freshPending({ lineType: 'MOBILE' });
      const before = await q('SELECT line_type, line_type_checked_at FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id]);
      await verifyOn(pool, c.id);
      expect(await q('SELECT line_type, line_type_checked_at FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id])).toEqual(before);
    });

    it('lets updated_at change on a live contact', async () => {
      const c = await freshPending();
      await run("UPDATE identity.phone_contacts SET updated_at = now() + interval '1 minute' WHERE phone_contact_id = $1", [c.id]);
    });
  });

  describe('verified_at is set once', () => {
    it('cannot be moved, cleared or re-set on a verified contact, nor on a replaced one (IMMUTABLE_IDENTITY)', async () => {
      const { primary, candidate } = await accountWithReplacement();
      await expectRule(
        run("UPDATE identity.phone_contacts SET verified_at = verified_at + interval '1 second' WHERE phone_contact_id = $1", [primary.id]),
        'IMMUTABLE_IDENTITY',
      );
      await expectRule(run('UPDATE identity.phone_contacts SET verified_at = NULL WHERE phone_contact_id = $1', [primary.id]), 'IMMUTABLE_IDENTITY');
      await replaceOld(primary, candidate);
      await expectRule(
        run("UPDATE identity.phone_contacts SET verified_at = now() + interval '1 day' WHERE phone_contact_id = $1", [primary.id]),
        'IMMUTABLE_IDENTITY',
      );
      expect((await contactState(primary.id)).verified).toBe(true);
    });

    it('is kept when the row is later replaced (the proof of ownership stays in the history)', async () => {
      const { primary, candidate } = await accountWithReplacement();
      const before = (await q<{ v: Date }>('SELECT verified_at AS v FROM identity.phone_contacts WHERE phone_contact_id = $1', [primary.id]))[0]!.v;
      await replaceOld(primary, candidate);
      const after = (await q<{ v: Date }>('SELECT verified_at AS v FROM identity.phone_contacts WHERE phone_contact_id = $1', [primary.id]))[0]!.v;
      expect(after.getTime()).toBe(before.getTime());
    });

    it('may be set on the transition to VERIFIED, because the pending row had none', async () => {
      const c = await freshPending();
      await verifyOn(pool, c.id);
      expect((await contactState(c.id)).verified).toBe(true);
    });
  });

  describe('a DISABLED contact never changes again', () => {
    const replacedRow = async (): Promise<Contact> => {
      const { primary, candidate } = await accountWithReplacement();
      await replaceOld(primary, candidate);
      return primary;
    };
    const snapshot = async (id: string) =>
      (
        await q(
          'SELECT status, is_primary, verified_at, disabled_at, disabled_reason, updated_at, created_at FROM identity.phone_contacts WHERE phone_contact_id = $1',
          [id],
        )
      )[0];
    const REWRITES: [label: string, set: string][] = [
      ['disabled_at moved back', "disabled_at = disabled_at - interval '1 day'"],
      ['disabled_at moved forward', "disabled_at = disabled_at + interval '1 day'"],
      ['disabled_at set to now', 'disabled_at = now()'],
      ['updated_at touched', "updated_at = now() + interval '1 minute'"],
      ['a no-op write of the status', 'status = status'],
      ['a no-op write of updated_at', 'updated_at = updated_at'],
      ['is_primary written', 'is_primary = false'],
      ['verified_at written', 'verified_at = now()'],
    ];
    it.each<[string, () => Promise<Contact>, string]>([
      ['SUPERSEDED', () => contactIn('DISABLED'), 'REPLACED'],
      ['REPLACED', replacedRow, 'SUPERSEDED'],
    ])(
      'refuses every rewrite of a %s row (IMMUTABLE_IDENTITY): disabled_at, disabled_reason, updated_at, even a no-op write',
      async (_reason, make, otherReason) => {
        const c = await make();
        const before = await snapshot(c.id);
        const sets = [...REWRITES.map(([, set]) => set), `disabled_reason = '${otherReason}'`];
        for (const set of sets) await expectRule(run(`UPDATE identity.phone_contacts SET ${set} WHERE phone_contact_id = $1`, [c.id]), 'IMMUTABLE_IDENTITY');
        expect(await snapshot(c.id)).toEqual(before);
      },
    );

    it('refuses a bulk UPDATE that reaches a DISABLED row, whatever the other rows are (IMMUTABLE_IDENTITY)', async () => {
      await contactIn('DISABLED');
      await expectRule(run("UPDATE identity.phone_contacts SET updated_at = now() WHERE status = 'DISABLED'"), 'IMMUTABLE_IDENTITY');
    });

    it('keeps the other contacts of the account changeable (only the disabled row is frozen)', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await replaceOld(primary, candidate);
      await run("UPDATE identity.phone_contacts SET updated_at = now() + interval '1 minute' WHERE phone_contact_id = $1", [candidate.id]);
      await expectRule(run('UPDATE identity.phone_contacts SET updated_at = now() WHERE phone_contact_id = $1', [primary.id]), 'IMMUTABLE_IDENTITY');
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('still lets a PENDING or REPLACEMENT_PENDING contact be disabled exactly once (the disabling itself is the last change)', async () => {
      const c = await freshPending();
      await disableOn(pool, c.id, 'SUPERSEDED');
      await expectRule(disableOn(pool, c.id, 'SUPERSEDED'), 'IMMUTABLE_IDENTITY');
    });

    it('refuses to change an immutable column of a DISABLED row too, and reports the immutable column first', async () => {
      const c = await contactIn('DISABLED');
      await expectRule(run('UPDATE identity.phone_contacts SET phone_e164 = $2 WHERE phone_contact_id = $1', [c.id, phoneNo()]), 'IMMUTABLE_IDENTITY');
      await expectRule(run("UPDATE identity.phone_contacts SET country_code = 'GB' WHERE phone_contact_id = $1", [c.id]), 'IMMUTABLE_IDENTITY');
    });

    it('still lets a DISABLED row be read and joined (history stays queryable)', async () => {
      const c = await contactIn('DISABLED');
      expect(await q('SELECT status, disabled_reason FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id])).toEqual([
        { status: 'DISABLED', disabled_reason: 'SUPERSEDED' },
      ]);
    });
  });

  describe('closed accounts verify nothing and receive no number or challenge (ACCOUNT_CLOSED)', () => {
    it('refuses PENDING -> VERIFIED on a contact of a CLOSED account and leaves it PENDING', async () => {
      const c = await freshPending();
      await closeAccount(c.accountId);
      await expectRule(verifyOn(pool, c.id), 'ACCOUNT_CLOSED');
      expect(await contactState(c.id)).toMatchObject({ status: 'PENDING', is_primary: false, verified: false });
    });

    it('refuses the verification of a replacement on a CLOSED account, and the whole replacement rolls back with it', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await closeAccount(accountId);
      await expectRule(replaceOld(primary, candidate), 'ACCOUNT_CLOSED');
      expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
    });

    it('reports a verification without is_primary as PHONE_PRIMARY_CHANGE even on a CLOSED account (the primary rule is checked first)', async () => {
      const c = await freshPending();
      await closeAccount(c.accountId);
      await expectRule(
        run("UPDATE identity.phone_contacts SET status = 'VERIFIED', verified_at = now() WHERE phone_contact_id = $1", [c.id]),
        'PHONE_PRIMARY_CHANGE',
      );
    });

    it.each<AccountStatus>(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'])('still verifies a contact of a %s account', async (status) => {
      const c = await insertContact(await accountIn(status));
      await verifyOn(pool, c.id);
      expect(await contactState(c.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    });

    it('lets a verification that was committed before the closure stand (the closure does not touch contacts)', async () => {
      const { accountId, primary } = await accountWithPrimary();
      await closeAccount(accountId);
      expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    });

    it.each<ContactStatus>(['PENDING', 'REPLACEMENT_PENDING', 'VERIFIED', 'DISABLED'])(
      'refuses a verification challenge for a %s contact of a CLOSED account (ACCOUNT_CLOSED)',
      async (status) => {
        const c = await contactIn(status);
        await closeAccount(c.accountId);
        await expectRule(challengeFor(c), 'ACCOUNT_CLOSED');
        expect(await count(CHALLENGES, 'phone_contact_id = $1', [c.id])).toBe(0);
      },
    );

    it.each<AccountStatus>(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'])(
      'still issues a challenge for a contact of a %s account',
      async (status) => {
        const c = await insertContact(await accountIn(status));
        const id = await challengeFor(c);
        expect(await challengeState(id)).toMatchObject({ used: false, invalidated: false });
      },
    );

    it('reports the closed account before the open-contact and purpose rules, and still reports a missing contact as PHONE_CHALLENGE_NOT_OPEN', async () => {
      const c = await freshPending();
      await closeAccount(c.accountId);
      await expectRule(insertChallengeRow(c.id, { purpose: 'CHANGE_PHONE', attempt_count: 3 }), 'ACCOUNT_CLOSED');
      await expectRule(insertChallengeRow(randomUUID()), 'PHONE_CHALLENGE_NOT_OPEN');
    });

    it.each(['PENDING', 'REPLACEMENT_PENDING'])('refuses a %s contact for a CLOSED account (ACCOUNT_CLOSED on insert)', async (status) => {
      const closed = await accountIn('CLOSED');
      await expectRule(insertContact(closed, { status }), 'ACCOUNT_CLOSED');
      expect(await count(CONTACTS, 'account_id = $1', [closed])).toBe(0);
    });

    it('reports a closed account before any other insert rule (a VERIFIED or DISABLED insert into a CLOSED account is ACCOUNT_CLOSED)', async () => {
      const closed = await accountIn('CLOSED');
      await expectRule(insertContact(closed, { status: 'VERIFIED', primary: true, verified: true }), 'ACCOUNT_CLOSED');
      await expectRule(insertContact(closed, { status: 'DISABLED', disabledAt: true, disabledReason: 'SUPERSEDED' }), 'ACCOUNT_CLOSED');
    });

    it.each<AccountStatus>(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'])('accepts a contact for a %s account', async (status) => {
      const c = await insertContact(await accountIn(status));
      expect((await contactState(c.id)).status).toBe('PENDING');
    });

    it('keeps the contacts of an account that is closed later readable (closing does not touch them)', async () => {
      const c = await freshPending();
      await closeAccount(c.accountId);
      expect((await contactState(c.id)).status).toBe('PENDING');
    });

    it('serializes with a concurrent closure: a closure that commits first makes the verification fail (ACCOUNT_CLOSED)', async () => {
      const c = await freshPending();
      await setStatus(c.accountId, 'SUSPENDED');
      const t1 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await t1.query("UPDATE identity.accounts SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE account_id = $1", [c.accountId]);
        await historyRow(t1, c.accountId, 'SUSPENDED', 'CLOSED');
        const second = rejection(verifyOn(pool, c.id));
        await lockWaiters(1);
        await t1.query('COMMIT');
        const e = (await second) as PgFailure;
        expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_CLOSED' });
      } finally {
        await t1.query('ROLLBACK').catch(() => undefined);
        t1.release();
      }
      expect((await contactState(c.id)).status).toBe('PENDING');
    });

    it('serializes with a concurrent closure: a closure that commits first makes the challenge insert fail (ACCOUNT_CLOSED)', async () => {
      const c = await freshPending();
      await setStatus(c.accountId, 'SUSPENDED');
      const t1 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await t1.query("UPDATE identity.accounts SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE account_id = $1", [c.accountId]);
        await historyRow(t1, c.accountId, 'SUSPENDED', 'CLOSED');
        const second = rejection(challengeFor(c));
        await lockWaiters(1);
        await t1.query('COMMIT');
        const e = (await second) as PgFailure;
        expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_CLOSED' });
      } finally {
        await t1.query('ROLLBACK').catch(() => undefined);
        t1.release();
      }
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [c.id])).toBe(0);
    });

    it('serializes with a concurrent closure: a closure that commits first makes the contact insert fail (ACCOUNT_CLOSED)', async () => {
      const a = await makeAccount();
      await setStatus(a, 'SUSPENDED');
      const t1 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await t1.query("UPDATE identity.accounts SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE account_id = $1", [a]);
        await historyRow(t1, a, 'SUSPENDED', 'CLOSED');
        const second = rejection(insertContact(a));
        await lockWaiters(1);
        await t1.query('COMMIT');
        const e = (await second) as PgFailure;
        expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_CLOSED' });
      } finally {
        await t1.query('ROLLBACK').catch(() => undefined);
        t1.release();
      }
      expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(0);
    });

    it('serializes with a concurrent verification: a verification that commits first makes the closure wait, then both stand', async () => {
      const c = await freshPending();
      await setStatus(c.accountId, 'SUSPENDED');
      const t1 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await verifyOn(t1, c.id);
        const closing = setStatus(c.accountId, 'CLOSED');
        await lockWaiters(1);
        await t1.query('COMMIT');
        await closing;
      } finally {
        await t1.query('ROLLBACK').catch(() => undefined);
        t1.release();
      }
      expect((await contactState(c.id)).status).toBe('VERIFIED');
      expect(await q('SELECT status FROM identity.accounts WHERE account_id = $1', [c.accountId])).toEqual([{ status: 'CLOSED' }]);
    });
  });

  describe('status transitions', () => {
    // a DISABLED contact never changes again, so every move out of DISABLED is refused as an immutable row (the row guard reports it before the transition rule)
    const ILLEGAL: [ContactStatus, ContactStatus, string][] = [
      ['PENDING', 'REPLACEMENT_PENDING', 'PHONE_STATUS_TRANSITION'],
      ['REPLACEMENT_PENDING', 'PENDING', 'PHONE_STATUS_TRANSITION'],
      ['VERIFIED', 'PENDING', 'PHONE_STATUS_TRANSITION'],
      ['VERIFIED', 'REPLACEMENT_PENDING', 'PHONE_STATUS_TRANSITION'],
      ['DISABLED', 'VERIFIED', 'IMMUTABLE_IDENTITY'],
      ['DISABLED', 'PENDING', 'IMMUTABLE_IDENTITY'],
      ['DISABLED', 'REPLACEMENT_PENDING', 'IMMUTABLE_IDENTITY'],
    ];
    it.each(ILLEGAL)('refuses %s -> %s (%s) and leaves the row untouched', async (from, to, rule) => {
      const c = await contactIn(from);
      const before = await contactState(c.id);
      await expectRule(run('UPDATE identity.phone_contacts SET status = $2 WHERE phone_contact_id = $1', [c.id, to]), rule);
      expect(await contactState(c.id)).toEqual(before);
    });

    it('partitions the twelve ordered status pairs: five legal (verify or disable), seven illegal', () => {
      const all: ContactStatus[] = ['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED'];
      const pairs = all.flatMap((f) => all.filter((t) => t !== f).map((t) => `${f}>${t}`));
      const legal = ['PENDING>VERIFIED', 'PENDING>DISABLED', 'REPLACEMENT_PENDING>VERIFIED', 'REPLACEMENT_PENDING>DISABLED', 'VERIFIED>DISABLED'];
      expect(pairs).toHaveLength(12);
      expect([...legal, ...ILLEGAL.map(([f, t]) => `${f}>${t}`)].sort()).toEqual(pairs.sort());
    });

    it.each(['PENDING', 'REPLACEMENT_PENDING'] as const)(
      'refuses %s -> VERIFIED without is_primary in the same UPDATE (PHONE_PRIMARY_CHANGE), with or without verified_at',
      async (status) => {
        const c = await contactIn(status);
        await expectRule(
          run("UPDATE identity.phone_contacts SET status = 'VERIFIED', verified_at = now() WHERE phone_contact_id = $1", [c.id]),
          'PHONE_PRIMARY_CHANGE',
        );
        await expectRule(run("UPDATE identity.phone_contacts SET status = 'VERIFIED' WHERE phone_contact_id = $1", [c.id]), 'PHONE_PRIMARY_CHANGE');
        await expectRule(
          run("UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = false, verified_at = now() WHERE phone_contact_id = $1", [c.id]),
          'PHONE_PRIMARY_CHANGE',
        );
        expect(await contactState(c.id)).toMatchObject({ status, is_primary: false, verified: false });
      },
    );

    it('allows PENDING -> VERIFIED together with the primary flag and verified_at', async () => {
      const c = await freshPending();
      await verifyOn(pool, c.id);
      expect(await contactState(c.id)).toEqual({ status: 'VERIFIED', is_primary: true, verified: true, disabled_reason: null });
    });

    it('allows PENDING -> DISABLED with SUPERSEDED', async () => {
      const c = await freshPending();
      await disableOn(pool, c.id, 'SUPERSEDED');
      expect(await contactState(c.id)).toMatchObject({ status: 'DISABLED', disabled_reason: 'SUPERSEDED', is_primary: false });
    });

    it('allows REPLACEMENT_PENDING -> DISABLED with SUPERSEDED while the old primary stays verified and primary', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await disableOn(pool, candidate.id, 'SUPERSEDED');
      expect((await contactState(candidate.id)).status).toBe('DISABLED');
      expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('allows REPLACEMENT_PENDING -> VERIFIED once the old primary is replaced (one transaction)', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await replaceOld(primary, candidate);
      expect(await contactState(candidate.id)).toMatchObject({ status: 'VERIFIED', is_primary: true, verified: true });
      expect(await contactState(primary.id)).toMatchObject({ status: 'DISABLED', is_primary: false, disabled_reason: 'REPLACED' });
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('lets the guard accept VERIFIED -> DISABLED REPLACED while a REPLACEMENT_PENDING exists in the same account (the statement passes; only the COMMIT check can still refuse it)', async () => {
      const { primary } = await accountWithReplacement();
      await isolated(
        [],
        "UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'REPLACED' WHERE phone_contact_id = $1",
        [primary.id],
      );
      expect((await contactState(primary.id)).status).toBe('VERIFIED');
    });

    it('refuses VERIFIED -> DISABLED REPLACED without a replacement in the account (PHONE_PRIMARY_NOT_REPLACEABLE)', async () => {
      const { accountId, primary } = await accountWithPrimary();
      await expectRule(disableOn(pool, primary.id, 'REPLACED'), 'PHONE_PRIMARY_NOT_REPLACEABLE');
      expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('refuses to replace a primary when the only replacement belongs to ANOTHER account (PHONE_PRIMARY_NOT_REPLACEABLE)', async () => {
      const { primary } = await accountWithPrimary();
      await accountWithReplacement();
      await expectRule(disableOn(pool, primary.id, 'REPLACED'), 'PHONE_PRIMARY_NOT_REPLACEABLE');
    });

    it('refuses to replace a primary whose replacement was already withdrawn (PHONE_PRIMARY_NOT_REPLACEABLE)', async () => {
      const { primary, candidate } = await accountWithReplacement();
      await disableOn(pool, candidate.id, 'SUPERSEDED');
      await expectRule(disableOn(pool, primary.id, 'REPLACED'), 'PHONE_PRIMARY_NOT_REPLACEABLE');
    });

    it('refuses to disable a verified number with SUPERSEDED or without a reason (PHONE_STATUS_TRANSITION)', async () => {
      const { primary } = await accountWithReplacement();
      await expectRule(disableOn(pool, primary.id, 'SUPERSEDED'), 'PHONE_STATUS_TRANSITION');
      await expectRule(
        run("UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now() WHERE phone_contact_id = $1", [primary.id]),
        'PHONE_STATUS_TRANSITION',
      );
    });

    it('refuses to disable a pending or replacement number with REPLACED or without a reason (PHONE_STATUS_TRANSITION)', async () => {
      const pending = await freshPending();
      await expectRule(disableOn(pool, pending.id, 'REPLACED'), 'PHONE_STATUS_TRANSITION');
      const { candidate } = await accountWithReplacement();
      await expectRule(disableOn(pool, candidate.id, 'REPLACED'), 'PHONE_STATUS_TRANSITION');
      await expectRule(
        run("UPDATE identity.phone_contacts SET status = 'DISABLED', disabled_at = now() WHERE phone_contact_id = $1", [candidate.id]),
        'PHONE_STATUS_TRANSITION',
      );
    });
  });

  describe('primary changes', () => {
    it('refuses to flag a PENDING or REPLACEMENT_PENDING row primary (PHONE_PRIMARY_CHANGE reports before the CHECK)', async () => {
      const pending = await freshPending();
      await expectRule(run('UPDATE identity.phone_contacts SET is_primary = true WHERE phone_contact_id = $1', [pending.id]), 'PHONE_PRIMARY_CHANGE');
      const { candidate } = await accountWithReplacement();
      await expectRule(run('UPDATE identity.phone_contacts SET is_primary = true WHERE phone_contact_id = $1', [candidate.id]), 'PHONE_PRIMARY_CHANGE');
    });

    it('refuses to clear the primary flag of a verified number that stays verified (PHONE_PRIMARY_CHANGE)', async () => {
      const { primary } = await accountWithPrimary();
      await expectRule(run('UPDATE identity.phone_contacts SET is_primary = false WHERE phone_contact_id = $1', [primary.id]), 'PHONE_PRIMARY_CHANGE');
      expect((await contactState(primary.id)).is_primary).toBe(true);
    });

    it('refuses a DISABLED row to become primary again or to leave DISABLED (IMMUTABLE_IDENTITY: a disabled contact never changes again)', async () => {
      const c = await contactIn('DISABLED');
      await expectRule(run('UPDATE identity.phone_contacts SET is_primary = true WHERE phone_contact_id = $1', [c.id]), 'IMMUTABLE_IDENTITY');
      await expectRule(
        run("UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE phone_contact_id = $1", [c.id]),
        'IMMUTABLE_IDENTITY',
      );
    });

    it('allows the primary flag to flip exactly on the transition to VERIFIED and on the transition to DISABLED', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await replaceOld(primary, candidate);
      expect(await primariesOf(accountId)).toBe(1);
      expect((await contactState(candidate.id)).is_primary).toBe(true);
      expect((await contactState(primary.id)).is_primary).toBe(false);
    });
  });

  describe('insert rules', () => {
    it('refuses a PENDING number while the account has a verified primary (PHONE_INITIAL_WITH_PRIMARY)', async () => {
      const { accountId } = await accountWithPrimary();
      await expectRule(insertContact(accountId), 'PHONE_INITIAL_WITH_PRIMARY');
      expect(await count(CONTACTS, 'account_id = $1', [accountId])).toBe(1);
    });

    it('refuses a REPLACEMENT_PENDING number without a primary to replace (PHONE_REPLACEMENT_WITHOUT_PRIMARY)', async () => {
      const a = await makeAccount();
      await expectRule(insertContact(a, { status: 'REPLACEMENT_PENDING' }), 'PHONE_REPLACEMENT_WITHOUT_PRIMARY');
      await insertContact(a); // an initial number is what the account needs first
      await expectRule(insertContact(await makeAccount(), { status: 'REPLACEMENT_PENDING' }), 'PHONE_REPLACEMENT_WITHOUT_PRIMARY');
    });

    it('refuses a REPLACEMENT_PENDING number while the primary is already replaced inside the transaction (PHONE_REPLACEMENT_WITHOUT_PRIMARY)', async () => {
      const { primary, candidate, accountId } = await accountWithReplacement();
      await expectRule(
        isolated(
          [
            `UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'REPLACED' WHERE phone_contact_id = '${primary.id}'`,
            `UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'SUPERSEDED' WHERE phone_contact_id = '${candidate.id}'`,
          ],
          "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'REPLACEMENT_PENDING', 'USER_ENTERED')",
          [accountId, phoneNo()],
        ),
        'PHONE_REPLACEMENT_WITHOUT_PRIMARY',
      );
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('refuses a contact created DISABLED, whatever its reason (PHONE_STATUS_TRANSITION)', async () => {
      const a = await makeAccount();
      for (const reason of ['REPLACED', 'SUPERSEDED'])
        await expectRule(insertContact(a, { status: 'DISABLED', disabledAt: true, disabledReason: reason }), 'PHONE_STATUS_TRANSITION');
      expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(0);
    });

    it('refuses a contact created VERIFIED, with or without the primary flag (PHONE_STATUS_TRANSITION): a number is proven by a code and never born verified', async () => {
      const a = await makeAccount();
      await expectRule(insertContact(a, { status: 'VERIFIED', primary: true, verified: true }), 'PHONE_STATUS_TRANSITION');
      await expectRule(insertContact(a, { status: 'VERIFIED', verified: true }), 'PHONE_STATUS_TRANSITION');
      await expectRule(insertContact(a, { status: 'VERIFIED' }), 'PHONE_STATUS_TRANSITION');
      expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(0);
    });

    it('refuses a VERIFIED insert even when the account already has a primary (the status rule is reported before the primary rules)', async () => {
      const { accountId } = await accountWithPrimary();
      await expectRule(insertContact(accountId, { status: 'VERIFIED', verified: true }), 'PHONE_STATUS_TRANSITION');
    });

    it('refuses an unknown source before any other check (the source CHECK) and does not mistake it for a status problem', async () => {
      expect(await constraintOf(insertContact(await makeAccount(), { source: 'IDP_VERIFIED' }))).toBe('ck_phone_contacts__source');
    });

    it('accepts a PENDING number for an account that never had one and a REPLACEMENT_PENDING one for an account with a primary', async () => {
      const a = await insertContact(await makeAccount());
      expect(await contactState(a.id)).toMatchObject({ status: 'PENDING' });
      const { candidate } = await accountWithReplacement();
      expect(await contactState(candidate.id)).toMatchObject({ status: 'REPLACEMENT_PENDING' });
    });

    it('accepts a new PENDING number after the previous one was superseded (the account still has no primary)', async () => {
      const first = await freshPending();
      await disableOn(pool, first.id, 'SUPERSEDED');
      const second = await insertContact(first.accountId);
      expect((await contactState(second.id)).status).toBe('PENDING');
    });
  });
});

// ====================================================================== E. deferred invariants at COMMIT
/** Runs `fn` in a transaction, forces the named constraint trigger to run now and returns its failure (the transaction is always rolled back). */
async function forcedEarly(fn: (c: pg.PoolClient) => Promise<unknown>, trigger: string): Promise<PgFailure | undefined> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    return (await rejection(c.query(`SET CONSTRAINTS identity.${trigger} IMMEDIATE`))) as PgFailure | undefined;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const GUARD_OFF = 'ALTER TABLE identity.phone_contacts DISABLE TRIGGER trg_phone_contacts__guard';

describe('E. whole-account invariants are checked at COMMIT (PHONE_INVARIANT, PHONE_CHALLENGE_CONSUMPTION)', () => {
  it('commits a replacement performed in the right order: disable the old primary, verify the new one, consume the challenge', async () => {
    const { accountId, primary, candidate, challengeId } = await freshReplacementOpen();
    await inTx(async (c) => {
      await disableOn(c, primary.id, 'REPLACED');
      await verifyOn(c, candidate.id);
      await consumeOn(c, challengeId);
    });
    expect(await primariesOf(accountId)).toBe(1);
    expect(await contactState(primary.id)).toMatchObject({ status: 'DISABLED', is_primary: false, disabled_reason: 'REPLACED' });
    expect(await contactState(candidate.id)).toMatchObject({ status: 'VERIFIED', is_primary: true, verified: true });
    expect(await challengeState(challengeId)).toMatchObject({ used: true, invalidated: false });
  });

  it('fails at COMMIT when the old primary is disabled and the replacement is NOT verified, and rolls everything back', async () => {
    const { accountId, primary, candidate } = await accountWithReplacement();
    await expectRule(
      inTx(async (c) => {
        await disableOn(c, primary.id, 'REPLACED');
      }),
      'PHONE_INVARIANT',
    );
    expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
    expect(await primariesOf(accountId)).toBe(1);
  });

  it('fails at COMMIT when the replacement is withdrawn right after the old primary was disabled (the account would have no primary)', async () => {
    const { accountId, primary, candidate } = await accountWithReplacement();
    await expectRule(
      inTx(async (c) => {
        await disableOn(c, primary.id, 'REPLACED');
        await disableOn(c, candidate.id, 'SUPERSEDED');
      }),
      'PHONE_INVARIANT',
    );
    expect(await primariesOf(accountId)).toBe(1);
  });

  it('fails at COMMIT when the replacement is created and the primary is disabled in the same transaction (a replacement needs a verified primary)', async () => {
    const { accountId, primary } = await accountWithPrimary();
    await expectRule(
      inTx(async (c) => {
        await c.query(
          "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'REPLACEMENT_PENDING', 'USER_ENTERED')",
          [accountId, phoneNo()],
        );
        await disableOn(c, primary.id, 'REPLACED');
      }),
      'PHONE_INVARIANT',
    );
    expect(await primariesOf(accountId)).toBe(1);
    expect(await count(CONTACTS, 'account_id = $1', [accountId])).toBe(1);
  });

  it('fails at COMMIT when a contact is verified while its challenge is still open', async () => {
    const { contact, challengeId } = await freshOpen();
    await expectRule(
      inTx(async (c) => {
        await verifyOn(c, contact.id);
      }),
      'PHONE_INVARIANT',
    );
    expect((await contactState(contact.id)).status).toBe('PENDING');
    expect(await challengeState(challengeId)).toMatchObject({ used: false, invalidated: false });
  });

  it('commits a verification that closes the open challenge by invalidating it instead of using it (no open challenge is left)', async () => {
    const { contact, challengeId } = await freshOpen();
    await inTx(async (c) => {
      await verifyOn(c, contact.id);
      await invalidateOn(c, challengeId, 'SUPERSEDED');
    });
    expect((await contactState(contact.id)).status).toBe('VERIFIED');
    expect(await challengeState(challengeId)).toMatchObject({ used: false, invalidated: true, invalidation_reason: 'SUPERSEDED' });
  });

  it('fails at COMMIT when a contact is disabled while its challenge is still open', async () => {
    const { contact, challengeId } = await freshOpen();
    await expectRule(
      inTx(async (c) => {
        await disableOn(c, contact.id, 'SUPERSEDED');
      }),
      'PHONE_INVARIANT',
    );
    expect((await contactState(contact.id)).status).toBe('PENDING');
    expect((await challengeState(challengeId)).invalidated).toBe(false);
  });

  it('fails at COMMIT when a withdrawn replacement keeps its open challenge', async () => {
    const { candidate, challengeId } = await freshReplacementOpen();
    await expectRule(
      inTx(async (c) => {
        await disableOn(c, candidate.id, 'SUPERSEDED');
      }),
      'PHONE_INVARIANT',
    );
    expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
    expect((await challengeState(challengeId)).invalidated).toBe(false);
  });

  it('commits a withdrawn replacement whose challenge was invalidated first (CONTACT_DISABLED)', async () => {
    const { primary, candidate, challengeId } = await freshReplacementOpen();
    await inTx(async (c) => {
      await invalidateOn(c, challengeId, 'CONTACT_DISABLED');
      await disableOn(c, candidate.id, 'SUPERSEDED');
    });
    expect((await contactState(candidate.id)).status).toBe('DISABLED');
    expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
  });

  it('commits the supersede flow: invalidate the challenge, disable the old candidate, add the new one (in this order)', async () => {
    const { contact, challengeId } = await freshOpen();
    const fresh = await inTx(async (c) => {
      await invalidateOn(c, challengeId, 'CONTACT_DISABLED');
      await disableOn(c, contact.id, 'SUPERSEDED');
      return (
        await c.query(
          "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED') RETURNING phone_contact_id",
          [contact.accountId, phoneNo()],
        )
      ).rows[0].phone_contact_id as string;
    });
    expect((await contactState(contact.id)).status).toBe('DISABLED');
    expect((await contactState(fresh)).status).toBe('PENDING');
    expect(await challengeState(challengeId)).toMatchObject({ invalidated: true, invalidation_reason: 'CONTACT_DISABLED' });
  });

  it('fails at COMMIT when a PENDING initial number and a verified primary coexist (the insert guard bypassed in the transaction: the deferred check is the second line of defence)', async () => {
    const { accountId } = await accountWithPrimary();
    await expectRule(
      inTx(async (c) => {
        await c.query(GUARD_OFF);
        await c.query(
          "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED')",
          [accountId, phoneNo()],
        );
      }),
      'PHONE_INVARIANT',
    );
    expect(await count(CONTACTS, 'account_id = $1', [accountId])).toBe(1);
    expect(await primariesOf(accountId)).toBe(1);
  });

  it('fails at COMMIT when a replacement exists without any primary (the insert guard bypassed in the transaction)', async () => {
    const a = await makeAccount();
    await expectRule(
      inTx(async (c) => {
        await c.query(GUARD_OFF);
        await c.query(
          "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'REPLACEMENT_PENDING', 'USER_ENTERED')",
          [a, phoneNo()],
        );
      }),
      'PHONE_INVARIANT',
    );
    expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(0);
  });

  it('fails at COMMIT when a challenge is marked used while its contact is not VERIFIED (PHONE_CHALLENGE_CONSUMPTION)', async () => {
    const { contact, challengeId } = await freshOpen();
    await expectRule(
      inTx(async (c) => {
        await consumeOn(c, challengeId);
      }),
      'PHONE_CHALLENGE_CONSUMPTION',
    );
    expect((await contactState(contact.id)).status).toBe('PENDING');
    expect(await challengeState(challengeId)).toMatchObject({ used: false });
  });

  it('fails the consumption check for a replacement-pending contact as well', async () => {
    const { candidate, challengeId } = await freshReplacementOpen();
    await expectRule(
      inTx(async (c) => {
        await consumeOn(c, challengeId);
      }),
      'PHONE_CHALLENGE_CONSUMPTION',
    );
    expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
  });

  it('passes the consumption check when the contact is verified in the same transaction, in either statement order', async () => {
    const first = await freshOpen();
    await inTx(async (c) => {
      await consumeOn(c, first.challengeId);
      await verifyOn(c, first.contact.id);
    });
    expect(await challengeState(first.challengeId)).toMatchObject({ used: true });
    expect((await contactState(first.contact.id)).status).toBe('VERIFIED');
  });

  it('surfaces the invariant at the statement when forced early with SET CONSTRAINTS ... IMMEDIATE', async () => {
    const { contact } = await freshOpen();
    const e = await forcedEarly((c) => verifyOn(c, contact.id), 'trg_phone_contacts__invariants');
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:PHONE_INVARIANT' });
    expect((await contactState(contact.id)).status).toBe('PENDING');
  });

  it('surfaces the consumption check early with SET CONSTRAINTS ... IMMEDIATE too', async () => {
    const { challengeId } = await freshOpen();
    const e = await forcedEarly((c) => consumeOn(c, challengeId), 'trg_phone_verification_challenges__consumption');
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:PHONE_CHALLENGE_CONSUMPTION' });
  });

  it('passes the early check for a consistent account (nothing to report)', async () => {
    const { contact, challengeId } = await freshOpen();
    const e = await forcedEarly(async (c) => {
      await verifyOn(c, contact.id);
      await consumeOn(c, challengeId);
    }, 'trg_phone_contacts__invariants');
    expect(e).toBeUndefined();
  });

  it('does not require a primary for an account that never had one (a lone PENDING number commits)', async () => {
    const c = await freshPending();
    expect((await contactState(c.id)).status).toBe('PENDING');
    expect(await primariesOf(c.accountId)).toBe(0);
  });

  it('re-evaluates the invariants for any touched row and passes for a consistent account (an updated_at write on the primary commits)', async () => {
    const { accountId, primary } = await accountWithPrimary();
    await inTx((c) => c.query("UPDATE identity.phone_contacts SET updated_at = now() + interval '1 second' WHERE phone_contact_id = $1", [primary.id]));
    expect(await primariesOf(accountId)).toBe(1);
  });

  it('keeps accounts independent: an open challenge on one account does not fail the commit of another', async () => {
    await freshOpen();
    const other = await freshPending();
    await verifyOn(pool, other.id);
    expect((await contactState(other.id)).status).toBe('VERIFIED');
  });
});

// ====================================================================== F. challenge table
const CH = 'ck_phone_verification_challenges__';
const HASH_VARIANTS: [string, () => string][] = [
  ['upper-case hex', () => hex64().toUpperCase()],
  ['a 63-character hex string', () => hex64().slice(1)],
  ['a 65-character hex string', () => `${hex64()}a`],
  ['a non-hex character', () => `g${hex64().slice(1)}`],
  ['an empty string', () => ''],
  ['a leading space', () => ` ${hex64().slice(1)}`],
  ['a trailing line feed', () => `${hex64().slice(1)}${ch(0x0a)}`],
  ['an algorithm prefix', () => `sha256:${hex64().slice(0, 57)}`],
  ['a 6-digit plaintext code', () => '123456'],
  ['an 8-digit plaintext code', () => '12345678'],
  ['a 64-character non-hex string', () => 'z'.repeat(64)],
  ['a base64 string', () => randomBytes(32).toString('base64')],
];
const CHALLENGE_CASES: ConstraintCase[] = [
  bad('pk_phone_verification_challenges', 'a duplicate challenge_id', async () => {
    const { challengeId } = await freshOpen();
    await insertChallengeRow((await freshPending()).id, { challenge_id: challengeId });
  }),
  bad('fk_phone_verification_challenges__phone_contact_id', 'a contact that does not exist (guard bypassed)', () =>
    isolated(
      noTriggers(CHALLENGES),
      `INSERT INTO ${CHALLENGES} (phone_contact_id, purpose, code_hash, expires_at, correlation_id) VALUES ($1, 'INITIAL_PHONE', $2, now() + interval '1 hour', 'c')`,
      [randomUUID(), hex64()],
    ),
  ),
  bad(`${CH}purpose`, 'an unknown purpose (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(
      noTriggers(CHALLENGES),
      `INSERT INTO ${CHALLENGES} (phone_contact_id, purpose, code_hash, expires_at, correlation_id) VALUES ($1, 'BOGUS', $2, now() + interval '1 hour', 'c')`,
      [c.id, hex64()],
    );
  }),
  bad(`${CH}purpose`, 'the email purpose INITIAL_EMAIL (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(
      noTriggers(CHALLENGES),
      `INSERT INTO ${CHALLENGES} (phone_contact_id, purpose, code_hash, expires_at, correlation_id) VALUES ($1, 'INITIAL_EMAIL', $2, now() + interval '1 hour', 'c')`,
      [c.id, hex64()],
    );
  }),
  ...HASH_VARIANTS.map(([label, make]) =>
    bad(`${CH}code_hash`, `a code_hash with ${label}`, async () => insertChallengeRow((await freshPending()).id, { code_hash: make() })),
  ),
  bad(`${CH}expiry`, 'expires_at equal to created_at', async () => challengeAt((await freshPending()).id, { expires: 'now()' })),
  bad(`${CH}expiry`, 'expires_at before created_at', async () => challengeAt((await freshPending()).id, { expires: "now() - interval '1 minute'" })),
  bad(`${CH}expiry`, 'an explicit created_at after expires_at', async () =>
    challengeAt((await freshPending()).id, { expires: "now() + interval '1 minute'", created: "now() + interval '2 minutes'" }),
  ),
  bad(`${CH}attempts`, 'a negative attempt_count (guard bypassed)', async () => {
    const { challengeId } = await freshOpen();
    await isolated(noTriggers(CHALLENGES), `UPDATE ${CHALLENGES} SET attempt_count = -1 WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}invalidated`, 'invalidated_at without a reason', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET invalidated_at = now() WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}invalidated`, 'a reason without invalidated_at', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET invalidation_reason = 'LOCKED' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}invalidated`, 'a reason outside the four documented ones', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET invalidated_at = now(), invalidation_reason = 'BOGUS' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}invalidated`, 'EXPIRED as a reason (expiry is evaluated from expires_at, never stored)', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET invalidated_at = now(), invalidation_reason = 'EXPIRED' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}invalidated`, 'a lower-case reason', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET invalidated_at = now(), invalidation_reason = 'locked' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}closed_once`, 'a challenge both used and invalidated', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET used_at = now(), invalidated_at = now(), invalidation_reason = 'LOCKED' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}delivery`, 'an unknown delivery_status', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET delivery_status = 'BOGUS' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}delivery`, 'a lower-case delivery_status', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET delivery_status = 'sent', last_sent_at = now() WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}delivery`, 'SENT without last_sent_at', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET delivery_status = 'SENT' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}delivery`, 'last_sent_at while the delivery is still PENDING', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET last_sent_at = now() WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}delivery`, 'FAILED with last_sent_at', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET delivery_status = 'FAILED', last_sent_at = now() WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}correlation`, 'an empty correlation_id', async () => insertChallengeRow((await freshPending()).id, { correlation_id: '' })),
  bad(`${CH}correlation`, 'a blank correlation_id', async () => insertChallengeRow((await freshPending()).id, { correlation_id: '   ' })),
  bad(`${CH}correlation`, 'a 201-character correlation_id', async () => insertChallengeRow((await freshPending()).id, { correlation_id: 'c'.repeat(201) })),
];

describe('F. phone_verification_challenges: constraints, guards and the one-open-challenge rule', () => {
  describe('constraints, by name', () => {
    it.each(CHALLENGE_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
      expect(await constraintOf(attempt())).toBe(constraint);
    });

    it('accepts the boundary values the checks allow (200-character correlation id, shared code hash, expired fixture, both purposes)', async () => {
      const c1 = await freshPending();
      await insertChallengeRow(c1.id, { correlation_id: 'c'.repeat(200) });
      const c2 = await freshPending();
      await insertChallengeRow(c2.id, { correlation_id: 'x' });
      // the code hash is not unique: two challenges (even of two contacts) may carry the same hash value
      const shared = hex64();
      await insertChallengeRow((await freshPending()).id, { code_hash: shared });
      await insertChallengeRow((await freshPending()).id, { code_hash: shared });
      expect(await count(CHALLENGES, 'code_hash = $1', [shared])).toBe(2);
      // an already-expired challenge: explicit created_at in the past with a later expires_at that is also in the past
      const c3 = await freshPending();
      await challengeAt(c3.id, { expires: "now() - interval '30 minutes'", created: "now() - interval '1 hour'" });
      expect(await count(CHALLENGES, 'phone_contact_id = $1 AND expires_at < now()', [c3.id])).toBe(1);
      // CHANGE_PHONE for a replacement candidate
      const { candidate } = await accountWithReplacement();
      await challengeFor(candidate);
    });

    it('defaults a new challenge to unused, unsent, zero attempts and a database-assigned id and creation time', async () => {
      const c = await freshPending();
      const id = await challengeFor(c);
      const row = (
        await q(
          `SELECT attempt_count, used_at, invalidated_at, invalidation_reason, delivery_status, last_sent_at, created_at IS NOT NULL AS created
             FROM identity.phone_verification_challenges WHERE challenge_id = $1`,
          [id],
        )
      )[0];
      expect(row).toEqual({
        attempt_count: 0,
        used_at: null,
        invalidated_at: null,
        invalidation_reason: null,
        delivery_status: 'PENDING',
        last_sent_at: null,
        created: true,
      });
    });

    it('has no column to put a link or a consumption channel in: an INSERT naming magic_token_hash or consumed_via fails at parse time', async () => {
      const c = await freshPending();
      for (const column of ['magic_token_hash', 'consumed_via']) {
        const e = await fail(insertChallengeRow(c.id, { [column]: hex64() }));
        expect(e.code, column).toBe('42703');
      }
    });
  });

  describe('insert guards', () => {
    it.each<ContactStatus>(['VERIFIED', 'DISABLED'])('refuses a challenge for a %s contact (PHONE_CHALLENGE_NOT_OPEN)', async (status) => {
      const c = await contactIn(status);
      await expectRule(challengeFor(c), 'PHONE_CHALLENGE_NOT_OPEN');
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [c.id])).toBe(0);
    });

    it('refuses a challenge for a contact that does not exist (PHONE_CHALLENGE_NOT_OPEN, before the foreign key)', async () => {
      await expectRule(insertChallengeRow(randomUUID()), 'PHONE_CHALLENGE_NOT_OPEN');
    });

    it.each<ContactStatus>(['PENDING', 'REPLACEMENT_PENDING'])('accepts a challenge for a %s contact', async (status) => {
      const c = await contactIn(status);
      const id = await challengeFor(c);
      expect(await challengeState(id)).toMatchObject({ attempt_count: 0, used: false, invalidated: false, delivery_status: 'PENDING' });
    });

    it('refuses CHANGE_PHONE for a PENDING contact and INITIAL_PHONE for a REPLACEMENT_PENDING one (PHONE_CHALLENGE_PURPOSE)', async () => {
      const pending = await freshPending();
      await expectRule(insertChallengeRow(pending.id, { purpose: 'CHANGE_PHONE' }), 'PHONE_CHALLENGE_PURPOSE');
      const { candidate } = await accountWithReplacement();
      await expectRule(insertChallengeRow(candidate.id, { purpose: 'INITIAL_PHONE' }), 'PHONE_CHALLENGE_PURPOSE');
    });

    const STATE_CASES: [string, Record<string, unknown>][] = [
      ['one attempt already counted', { attempt_count: 1 }],
      ['five attempts already counted', { attempt_count: 5 }],
      ['already used', { used_at: new Date() }],
      ['already invalidated', { invalidated_at: new Date(), invalidation_reason: 'SUPERSEDED' }],
      ['already sent', { delivery_status: 'SENT', last_sent_at: new Date() }],
      ['already failed', { delivery_status: 'FAILED' }],
    ];
    it.each(STATE_CASES)('refuses a new challenge that starts %s (PHONE_CHALLENGE_STATE)', async (_label, override) => {
      const c = await freshPending();
      await expectRule(challengeFor(c, override), 'PHONE_CHALLENGE_STATE');
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [c.id])).toBe(0);
    });

    it('reports a negative initial attempt count as a state problem (the guard runs before the CHECK)', async () => {
      const c = await freshPending();
      await expectRule(challengeFor(c, { attempt_count: -1 }), 'PHONE_CHALLENGE_STATE');
    });

    it('reports the open-contact rule before the purpose rule and the purpose rule before the state rule', async () => {
      const verified = (await accountWithPrimary()).primary;
      await expectRule(insertChallengeRow(verified.id, { purpose: 'CHANGE_PHONE', attempt_count: 3 }), 'PHONE_CHALLENGE_NOT_OPEN');
      const pending = await freshPending();
      await expectRule(insertChallengeRow(pending.id, { purpose: 'CHANGE_PHONE', attempt_count: 3 }), 'PHONE_CHALLENGE_PURPOSE');
    });
  });

  describe('one open challenge per contact', () => {
    it('refuses a second open challenge for the same contact (uq_phone_verification_challenges__open_per_contact)', async () => {
      const { contact } = await freshOpen();
      await expectUnique(challengeFor(contact), 'uq_phone_verification_challenges__open_per_contact');
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [contact.id])).toBe(1);
    });

    it('allows a new challenge once the previous one is invalidated (a resend supersedes the open challenge)', async () => {
      const { contact, challengeId } = await freshOpen();
      await invalidateOn(pool, challengeId, 'SUPERSEDED');
      const second = await challengeFor(contact);
      expect(second).not.toBe(challengeId);
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [contact.id])).toBe(2);
    });

    it.each(['SUPERSEDED', 'LOCKED', 'CONTACT_DISABLED', 'DELIVERY_FAILED'])(
      'accepts the invalidation reason %s and then allows a new challenge',
      async (reason) => {
        const { contact, challengeId } = await freshOpen();
        await invalidateOn(pool, challengeId, reason);
        expect(await challengeState(challengeId)).toMatchObject({ invalidated: true, invalidation_reason: reason });
        await challengeFor(contact);
      },
    );

    it('records a failed delivery together with its invalidation (FAILED + DELIVERY_FAILED in one update) and then allows a new challenge', async () => {
      const { contact, challengeId } = await freshOpen();
      await run(
        `UPDATE ${CHALLENGES} SET delivery_status = 'FAILED', invalidated_at = now(), invalidation_reason = 'DELIVERY_FAILED' WHERE challenge_id = $1`,
        [challengeId],
      );
      expect(await challengeState(challengeId)).toMatchObject({
        delivery_status: 'FAILED',
        sent: false,
        invalidated: true,
        invalidation_reason: 'DELIVERY_FAILED',
      });
      await challengeFor(contact);
    });

    it('refuses a new challenge for a contact whose previous challenge was used (the contact is then VERIFIED: PHONE_CHALLENGE_NOT_OPEN)', async () => {
      const { contact } = await freshUsed();
      await expectRule(challengeFor(contact), 'PHONE_CHALLENGE_NOT_OPEN');
    });

    it('keeps the whole send history of a contact (three sends, three rows, one open)', async () => {
      const { contact, challengeId } = await freshOpen();
      await invalidateOn(pool, challengeId, 'SUPERSEDED');
      const second = await challengeFor(contact);
      await invalidateOn(pool, second, 'SUPERSEDED');
      await challengeFor(contact);
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [contact.id])).toBe(3);
      expect(await count(CHALLENGES, 'phone_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL', [contact.id])).toBe(1);
    });

    it('lets two contacts each hold their own open challenge', async () => {
      await freshOpen();
      await freshOpen();
    });
  });

  describe('updates: immutability, attempts, closed rows, delivery', () => {
    const IMMUTABLE_COLUMNS: [string, () => Promise<unknown> | unknown][] = [
      ['code_hash', () => hex64()],
      ['expires_at', () => new Date(Date.now() + 3_600_000)],
      ['created_at', () => new Date(0)],
      ['correlation_id', () => 'another-correlation'],
      ['purpose', () => 'CHANGE_PHONE'],
      ['phone_contact_id', async () => (await freshPending()).id],
      ['challenge_id', () => randomUUID()],
    ];
    it.each(IMMUTABLE_COLUMNS)('keeps %s immutable (IMMUTABLE_IDENTITY)', async (column, value) => {
      const { challengeId } = await freshOpen();
      await expectRule(run(`UPDATE ${CHALLENGES} SET ${column} = $2 WHERE challenge_id = $1`, [challengeId, await value()]), 'IMMUTABLE_IDENTITY');
    });

    it('reports an immutable-field change before a closed challenge (IMMUTABLE_IDENTITY first, then PHONE_CHALLENGE_CLOSED)', async () => {
      const { challengeId } = await freshInvalidated();
      await expectRule(run(`UPDATE ${CHALLENGES} SET code_hash = $2 WHERE challenge_id = $1`, [challengeId, hex64()]), 'IMMUTABLE_IDENTITY');
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 1 WHERE challenge_id = $1`, [challengeId]), 'PHONE_CHALLENGE_CLOSED');
    });

    it('counts attempts one at a time (attempt_count + 1 succeeds, and a no-change write is allowed)', async () => {
      const { challengeId } = await freshOpen();
      for (let n = 1; n <= 3; n++) {
        await run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 1 WHERE challenge_id = $1`, [challengeId]);
        expect((await challengeState(challengeId)).attempt_count).toBe(n);
      }
      await run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count WHERE challenge_id = $1`, [challengeId]);
      expect((await challengeState(challengeId)).attempt_count).toBe(3);
    });

    it('refuses a jump of more than one attempt (PHONE_CHALLENGE_ATTEMPTS)', async () => {
      const { challengeId } = await freshOpen();
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = 2 WHERE challenge_id = $1`, [challengeId]), 'PHONE_CHALLENGE_ATTEMPTS');
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 5 WHERE challenge_id = $1`, [challengeId]), 'PHONE_CHALLENGE_ATTEMPTS');
      expect((await challengeState(challengeId)).attempt_count).toBe(0);
    });

    it('refuses to decrease or reset the attempt counter (PHONE_CHALLENGE_ATTEMPTS)', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET attempt_count = 1 WHERE challenge_id = $1`, [challengeId]);
      await run(`UPDATE ${CHALLENGES} SET attempt_count = 2 WHERE challenge_id = $1`, [challengeId]);
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = 0 WHERE challenge_id = $1`, [challengeId]), 'PHONE_CHALLENGE_ATTEMPTS');
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count - 1 WHERE challenge_id = $1`, [challengeId]), 'PHONE_CHALLENGE_ATTEMPTS');
      expect((await challengeState(challengeId)).attempt_count).toBe(2);
    });

    it('locks the challenge in the same statement as the attempt that reaches the maximum (attempt + invalidation LOCKED), as the service does', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET attempt_count = 1 WHERE challenge_id = $1`, [challengeId]);
      await run(
        `UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 1, invalidated_at = clock_timestamp(), invalidation_reason = 'LOCKED' WHERE challenge_id = $1`,
        [challengeId],
      );
      expect(await challengeState(challengeId)).toMatchObject({ attempt_count: 2, invalidated: true, invalidation_reason: 'LOCKED' });
    });

    it.each([
      ['an invalidated', () => freshInvalidated('LOCKED')],
      ['a used', () => freshUsed()],
    ])('never changes %s challenge again (PHONE_CHALLENGE_CLOSED), not even by a no-op write', async (_label, make) => {
      const { challengeId } = await make();
      const updates = [
        'attempt_count = attempt_count + 1',
        'attempt_count = attempt_count',
        "delivery_status = 'SENT', last_sent_at = now()",
        'used_at = NULL',
        'invalidated_at = NULL, invalidation_reason = NULL',
        "invalidated_at = now(), invalidation_reason = 'SUPERSEDED'",
        'used_at = now()',
      ];
      for (const set of updates) await expectRule(run(`UPDATE ${CHALLENGES} SET ${set} WHERE challenge_id = $1`, [challengeId]), 'PHONE_CHALLENGE_CLOSED');
    });

    it('records the delivery outcome once: PENDING -> SENT is allowed, SENT -> FAILED, SENT -> PENDING and a new last_sent_at are refused (PHONE_CHALLENGE_DELIVERY)', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET delivery_status = 'SENT', last_sent_at = now() WHERE challenge_id = $1`, [challengeId]);
      expect(await challengeState(challengeId)).toMatchObject({ delivery_status: 'SENT', sent: true });
      await expectRule(
        run(`UPDATE ${CHALLENGES} SET delivery_status = 'FAILED', last_sent_at = NULL WHERE challenge_id = $1`, [challengeId]),
        'PHONE_CHALLENGE_DELIVERY',
      );
      await expectRule(
        run(`UPDATE ${CHALLENGES} SET delivery_status = 'PENDING', last_sent_at = NULL WHERE challenge_id = $1`, [challengeId]),
        'PHONE_CHALLENGE_DELIVERY',
      );
      await expectRule(
        run(`UPDATE ${CHALLENGES} SET last_sent_at = now() + interval '1 minute' WHERE challenge_id = $1`, [challengeId]),
        'PHONE_CHALLENGE_DELIVERY',
      );
      expect(await challengeState(challengeId)).toMatchObject({ delivery_status: 'SENT', sent: true });
    });

    it('refuses to turn a FAILED delivery into SENT (PHONE_CHALLENGE_DELIVERY) while the challenge is still open', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET delivery_status = 'FAILED' WHERE challenge_id = $1`, [challengeId]);
      await expectRule(
        run(`UPDATE ${CHALLENGES} SET delivery_status = 'SENT', last_sent_at = now() WHERE challenge_id = $1`, [challengeId]),
        'PHONE_CHALLENGE_DELIVERY',
      );
    });

    it('lets attempts and invalidation continue on a SENT challenge (the delivery fields stay as they are)', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET delivery_status = 'SENT', last_sent_at = now() WHERE challenge_id = $1`, [challengeId]);
      await run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 1 WHERE challenge_id = $1`, [challengeId]);
      await invalidateOn(pool, challengeId, 'SUPERSEDED');
      expect(await challengeState(challengeId)).toMatchObject({ attempt_count: 1, delivery_status: 'SENT', sent: true, invalidated: true });
    });

    it('refuses to delete a challenge, open or closed (NOT_DELETABLE)', async () => {
      const open = await freshOpen();
      const used = await freshUsed();
      const invalidated = await freshInvalidated();
      for (const { challengeId } of [open, used, invalidated])
        await expectRule(run(`DELETE FROM ${CHALLENGES} WHERE challenge_id = $1`, [challengeId]), 'NOT_DELETABLE');
      await expectRule(run(`DELETE FROM ${CHALLENGES}`), 'NOT_DELETABLE');
    });

    it('keeps a used challenge consumed together with its VERIFIED contact (the pair survives and is consistent)', async () => {
      const { contact, challengeId } = await freshUsed();
      expect(await contactState(contact.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect(await challengeState(challengeId)).toMatchObject({ used: true, invalidated: false });
    });
  });

  describe('attempt counting under real concurrency', () => {
    it('counts 20 concurrent increments exactly (the row lock serializes them): attempt_count ends at 20', async () => {
      const { challengeId } = await freshOpen();
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => racePool.query(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 1 WHERE challenge_id = $1`, [challengeId])),
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      expect((await challengeState(challengeId)).attempt_count).toBe(20);
    });

    /**
     * The service's wrong-code transaction (PhoneVerificationService.confirmCode): re-read the OPEN challenge FOR UPDATE; at the maximum lock it, otherwise count
     * the attempt with the CASE statement that locks the challenge in the same statement as the attempt that reaches the maximum.
     */
    async function wrongCode(contactId: string, max: number): Promise<{ outcome: 'COUNTED' | 'LOCKED_NOW' | 'NO_OPEN_CHALLENGE'; attempts?: number }> {
      const c = await racePool.connect();
      try {
        await c.query('BEGIN');
        const open = (
          await c.query(
            `SELECT challenge_id, attempt_count FROM ${CHALLENGES} WHERE phone_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL FOR UPDATE`,
            [contactId],
          )
        ).rows[0] as { challenge_id: string; attempt_count: number } | undefined;
        if (!open) {
          await c.query('ROLLBACK');
          return { outcome: 'NO_OPEN_CHALLENGE' };
        }
        if (open.attempt_count >= max) {
          await c.query(
            `UPDATE ${CHALLENGES} SET invalidated_at = clock_timestamp(), invalidation_reason = 'LOCKED' WHERE challenge_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
            [open.challenge_id],
          );
          await c.query('COMMIT');
          return { outcome: 'LOCKED_NOW' };
        }
        const counted = (
          await c.query(
            `UPDATE ${CHALLENGES}
                SET attempt_count = attempt_count + 1,
                    invalidated_at = CASE WHEN attempt_count + 1 >= $2::int THEN clock_timestamp() END,
                    invalidation_reason = CASE WHEN attempt_count + 1 >= $2::int THEN 'LOCKED' END
              WHERE challenge_id = $1 RETURNING attempt_count, invalidated_at`,
            [open.challenge_id, max],
          )
        ).rows[0] as { attempt_count: number };
        await c.query('COMMIT');
        return { outcome: 'COUNTED', attempts: counted.attempt_count };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    }

    it('never lets attempt_count exceed the maximum: 12 concurrent wrong-code transactions with max 5 count exactly 1..5 and lock the challenge', async () => {
      const { contact, challengeId } = await freshOpen();
      const results = await Promise.all(Array.from({ length: 12 }, () => wrongCode(contact.id, 5)));
      const counted = results.filter((r) => r.outcome === 'COUNTED').map((r) => r.attempts!);
      expect(counted.sort()).toEqual([1, 2, 3, 4, 5]);
      expect(results.filter((r) => r.outcome === 'NO_OPEN_CHALLENGE')).toHaveLength(7);
      expect(await challengeState(challengeId)).toMatchObject({ attempt_count: 5, invalidated: true, invalidation_reason: 'LOCKED', used: false });
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [contact.id])).toBe(1);
    });

    it('holds the same bound with max 1 (the first wrong attempt locks) and with max 3 on 8 concurrent attempts', async () => {
      for (const [max, total] of [
        [1, 6],
        [3, 8],
      ] as const) {
        const { contact, challengeId } = await freshOpen();
        const results = await Promise.all(Array.from({ length: total }, () => wrongCode(contact.id, max)));
        expect(results.filter((r) => r.outcome === 'COUNTED')).toHaveLength(max);
        expect(await challengeState(challengeId)).toMatchObject({ attempt_count: max, invalidated: true, invalidation_reason: 'LOCKED' });
      }
    });

    it('keeps the bound at the database even without the re-read: concurrent CASE updates past the maximum are refused by the closed-challenge guard (PHONE_CHALLENGE_CLOSED)', async () => {
      const { challengeId } = await freshOpen();
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          racePool.query(
            `UPDATE ${CHALLENGES}
                SET attempt_count = attempt_count + 1,
                    invalidated_at = CASE WHEN attempt_count + 1 >= 5 THEN clock_timestamp() END,
                    invalidation_reason = CASE WHEN attempt_count + 1 >= 5 THEN 'LOCKED' END
              WHERE challenge_id = $1`,
            [challengeId],
          ),
        ),
      );
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      expect(refused).toHaveLength(7);
      for (const r of refused)
        expect({ code: (r.reason as PgFailure).code, detail: (r.reason as PgFailure).detail }).toEqual({
          code: '23000',
          detail: 'identity_rule:PHONE_CHALLENGE_CLOSED',
        });
      expect(await challengeState(challengeId)).toMatchObject({ attempt_count: 5, invalidated: true, invalidation_reason: 'LOCKED' });
    });

    it('lets exactly one of eight concurrent challenge inserts for one contact win (the others hit the open-per-contact unique index)', async () => {
      const contact = await freshPending();
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => insertChallengeRow(contact.id, {}, racePool)));
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of refused)
        expect({ code: (r.reason as PgFailure).code, constraint: (r.reason as PgFailure).constraint }).toEqual({
          code: '23505',
          constraint: 'uq_phone_verification_challenges__open_per_contact',
        });
      expect(await count(CHALLENGES, 'phone_contact_id = $1', [contact.id])).toBe(1);
    });

    it('lets exactly one of six concurrent first-number inserts for one account win (the others hit the open-per-account unique index)', async () => {
      const a = await makeAccount();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          racePool.query(
            "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED')",
            [a, phoneNo()],
          ),
        ),
      );
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of refused)
        expect({ code: (r.reason as PgFailure).code, constraint: (r.reason as PgFailure).constraint }).toEqual({
          code: '23505',
          constraint: 'uq_phone_contacts__open_per_account',
        });
      expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(1);
    });
  });
});

// ====================================================================== G. the cap under real concurrency
describe('G. N concurrent verifications of ONE number end with exactly the cap many holders and no deadlock', () => {
  const lockAccountFirst = true;
  async function race(accounts: number, setting: string | null, takeAccountLock = lockAccountFirst) {
    const phone = phoneNo();
    const contacts: Contact[] = [];
    for (let n = 0; n < accounts; n++) contacts.push(await insertContact(await makeAccount(), { phone }));
    const results = await Promise.allSettled(
      contacts.map((c) =>
        inTxOn(racePool, async (t) => {
          if (takeAccountLock) await t.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [c.accountId]);
          if (setting !== null) await setCap(t, setting);
          await verifyOn(t, c.id);
        }),
      ),
    );
    return { phone, contacts, results };
  }
  const refusals = (results: PromiseSettledResult<unknown>[]) =>
    results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as PgFailure);

  it.each([
    [1, '1', 8],
    [2, '2', 8],
    [3, '3', 8],
    [4, '4', 8],
    [5, '5', 8],
  ])('cap %i: %i of %i racing accounts win and the rest are refused PHONE_NUMBER_CAP', async (cap, setting, accounts) => {
    const { phone, contacts, results } = await race(accounts, setting);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(cap);
    const failures = refusals(results);
    expect(failures).toHaveLength(accounts - cap);
    for (const f of failures) expect({ code: f.code, detail: f.detail }).toEqual({ code: '23000', detail: 'identity_rule:PHONE_NUMBER_CAP' });
    expect(await holdersOf(phone)).toBe(cap);
    // every refused account kept its pending row (nothing was half-verified)
    const states = await Promise.all(contacts.map((c) => contactState(c.id)));
    expect(states.filter((s) => s.status === 'VERIFIED')).toHaveLength(cap);
    expect(states.filter((s) => s.status === 'PENDING' && !s.is_primary && !s.verified)).toHaveLength(accounts - cap);
  });

  it('falls back to the structural five when no setting is passed: seven racing accounts, five winners, two refused', async () => {
    const { phone, results } = await race(7, null);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const failures = refusals(results);
    expect(failures).toHaveLength(2);
    for (const f of failures) expect(f.detail).toBe('identity_rule:PHONE_NUMBER_CAP');
    expect(await holdersOf(phone)).toBe(5);
  });

  it('falls back to the structural five for an invalid setting (abc): seven racing accounts, five winners', async () => {
    const { phone, results } = await race(7, 'abc');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await holdersOf(phone)).toBe(5);
  });

  it.each([
    [1, '1'],
    [3, '3'],
  ])('holds cap %i without any account lock: the guard serializes on the number by itself', async (cap, setting) => {
    const { phone, results } = await race(7, setting, false);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(cap);
    for (const f of refusals(results)) expect(f.detail).toBe('identity_rule:PHONE_NUMBER_CAP');
    expect(await holdersOf(phone)).toBe(cap);
  });

  it('does not deadlock when 12 accounts race for two different numbers at once (numbers are locked independently)', async () => {
    const [p1, p2] = [phoneNo(), phoneNo()];
    const contacts: Contact[] = [];
    for (let n = 0; n < 6; n++) {
      contacts.push(await insertContact(await makeAccount(), { phone: p1 }));
      contacts.push(await insertContact(await makeAccount(), { phone: p2 }));
    }
    const results = await Promise.allSettled(contacts.map((c) => verifyUnderCap(c, '2', racePool)));
    const failures = refusals(results);
    for (const f of failures) expect(f.detail).toBe('identity_rule:PHONE_NUMBER_CAP');
    expect(failures.filter((f) => f.code === '40P01')).toEqual([]);
    expect(await holdersOf(p1)).toBe(2);
    expect(await holdersOf(p2)).toBe(2);
  });

  it('does not deadlock when replacements race: accounts that replace their primary with the same number respect the cap', async () => {
    const shared = phoneNo();
    const setups = [];
    for (let n = 0; n < 5; n++) setups.push(await accountWithReplacement({ candidatePhone: shared }));
    const results = await Promise.allSettled(
      setups.map(({ accountId, primary, candidate }) =>
        inTxOn(racePool, async (t) => {
          await t.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
          await setCap(t, '2');
          await disableOn(t, primary.id, 'REPLACED');
          await verifyOn(t, candidate.id);
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const f of refusals(results)) expect(f.detail).toBe('identity_rule:PHONE_NUMBER_CAP');
    expect(await holdersOf(shared)).toBe(2);
    // the losers rolled back completely: their old primary is still the primary
    for (const s of setups) expect(await primariesOf(s.accountId)).toBe(1);
  });

  it('lets a rolled-back winner free its slot for the next racer (a failed commit does not keep the number)', async () => {
    const phone = phoneNo();
    const first = await insertContact(await makeAccount(), { phone });
    const withChallenge = await insertContact(await makeAccount(), { phone });
    await challengeFor(withChallenge);
    // this one fails at COMMIT (its challenge is still open), after the cap check passed
    await expectRule(verifyUnderCap(withChallenge, '1'), 'PHONE_INVARIANT');
    await verifyUnderCap(first, '1');
    expect(await holdersOf(phone)).toBe(1);
  });
});

// ====================================================================== H. audit extension
const OLD_ACTIONS = [
  'ACCOUNT_CREATED',
  'EXTERNAL_IDENTITY_LINKED',
  'ROLE_GRANTED',
  'ROLE_ACTIVATED',
  'ROLE_DEACTIVATED',
  'PRIMARY_ROLE_CHANGED',
  'PROFILE_UPDATED',
];
const EMAIL_ACTIONS = [
  'EMAIL_ADDED',
  'EMAIL_CHANGE_REQUESTED',
  'EMAIL_VERIFICATION_REQUESTED',
  'EMAIL_VERIFICATION_FAILED',
  'EMAIL_VERIFICATION_LOCKED',
  'EMAIL_VERIFIED',
  'EMAIL_PRIMARY_CHANGED',
];
const PHONE_ACTIONS = [
  'PHONE_ADDED',
  'PHONE_CHANGE_REQUESTED',
  'PHONE_VERIFICATION_REQUESTED',
  'PHONE_VERIFICATION_FAILED',
  'PHONE_VERIFICATION_LOCKED',
  'PHONE_VERIFIED',
  'PHONE_PRIMARY_CHANGED',
];
const CUSTOMER = async (): Promise<string> => (await q<{ role_id: string }>("SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER'"))[0]!.role_id;

const AUDIT_CASES: ConstraintCase[] = [
  bad('fk_account_audit_events__account_phone_contact', 'a contact that does not exist', async () =>
    insertAudit(await makeAccount(), 'PHONE_ADDED', randomUUID()),
  ),
  bad('fk_account_audit_events__account_phone_contact', 'a contact that belongs to ANOTHER account', async () => {
    const other = await freshPending();
    await insertAudit(await makeAccount(), 'PHONE_ADDED', other.id);
  }),
  bad('fk_account_audit_events__account_phone_contact', 'a contact of another account, naming a verified primary', async () => {
    const { primary } = await accountWithPrimary();
    await insertAudit(await makeAccount(), 'PHONE_VERIFIED', primary.id);
  }),
  bad('ck_account_audit_events__phone_contact', 'PHONE_ADDED without a contact', async () => insertAudit(await makeAccount(), 'PHONE_ADDED')),
  bad('ck_account_audit_events__phone_contact', 'ACCOUNT_CREATED with a phone contact', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'ACCOUNT_CREATED', c.id);
  }),
  bad('ck_account_audit_events__phone_contact', 'PROFILE_UPDATED with a phone contact', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'PROFILE_UPDATED', c.id);
  }),
  bad('ck_account_audit_events__action', 'an unknown PHONE_ action', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'PHONE_DELETED', c.id);
  }),
  bad('ck_account_audit_events__action', 'an action without the underscore after PHONE', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'PHONEVERIFIED', c.id);
  }),
  bad('ck_account_audit_events__action', 'a lower-case phone action', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'phone_verified', c.id);
  }),
  bad('ck_account_audit_events__action', 'an SMS action (the vocabulary is PHONE_*)', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'SMS_SENT', c.id);
  }),
  bad('ck_account_audit_events__action', 'a MOBILE_ action', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'MOBILE_ADDED', c.id);
  }),
];

describe('H. audit extension: seven PHONE_* actions and the contact they concern', () => {
  it.each(OLD_ACTIONS)('still accepts the 0009 action %s (no contact)', async (action) => {
    const a = await makeAccount();
    const role = action.startsWith('ROLE_') ? await CUSTOMER() : null;
    await q(`INSERT INTO ${AUDIT} (actor, action, account_id, role_id, correlation_id) VALUES ($1, $2, $3, $4, $5)`, [
      'test',
      action,
      a,
      role,
      'test-correlation',
    ]);
  });

  it.each(EMAIL_ACTIONS)('still accepts the 0010 action %s with its email contact and no phone contact', async (action) => {
    const a = await makeAccount();
    const email = (
      await q<{ email_contact_id: string }>(
        "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED') RETURNING email_contact_id",
        [a, `audit-${uniq()}@example.test`],
      )
    )[0]!.email_contact_id;
    await q(`INSERT INTO ${AUDIT} (actor, action, account_id, email_contact_id, correlation_id) VALUES ($1, $2, $3, $4, $5)`, [
      'test',
      action,
      a,
      email,
      'test-correlation',
    ]);
  });

  it.each(EMAIL_ACTIONS)('refuses the email action %s that also carries a phone contact (ck_account_audit_events__phone_contact)', async (action) => {
    const a = await makeAccount();
    const email = (
      await q<{ email_contact_id: string }>(
        "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED') RETURNING email_contact_id",
        [a, `audit-${uniq()}@example.test`],
      )
    )[0]!.email_contact_id;
    const phone = await insertContact(a);
    expect(
      await constraintOf(
        q(`INSERT INTO ${AUDIT} (actor, action, account_id, email_contact_id, phone_contact_id, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
          'test',
          action,
          a,
          email,
          phone.id,
          'test-correlation',
        ]),
      ),
    ).toBe('ck_account_audit_events__phone_contact');
  });

  it.each(PHONE_ACTIONS)('accepts %s with a contact, and with a changes object holding only a masked number and ids', async (action) => {
    const c = await freshPending();
    const id = await insertAudit(c.accountId, action, c.id, JSON.stringify({ maskedPhone: '+*******0142', challengeId: randomUUID(), attempt: 2 }));
    expect(await q(`SELECT action, phone_contact_id FROM ${AUDIT} WHERE audit_event_id = $1`, [id])).toEqual([{ action, phone_contact_id: c.id }]);
  });

  it.each(PHONE_ACTIONS)('requires a contact for %s (ck_account_audit_events__phone_contact)', async (action) => {
    expect(await constraintOf(insertAudit(await makeAccount(), action))).toBe('ck_account_audit_events__phone_contact');
  });

  it.each(PHONE_ACTIONS)('refuses %s with an email contact in place of a phone contact (ck_account_audit_events__email_contact)', async (action) => {
    const a = await makeAccount();
    const phone = await insertContact(a);
    const email = (
      await q<{ email_contact_id: string }>(
        "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED') RETURNING email_contact_id",
        [a, `audit-${uniq()}@example.test`],
      )
    )[0]!.email_contact_id;
    expect(
      await constraintOf(
        q(`INSERT INTO ${AUDIT} (actor, action, account_id, email_contact_id, phone_contact_id, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
          'test',
          action,
          a,
          email,
          phone.id,
          'test-correlation',
        ]),
      ),
    ).toBe('ck_account_audit_events__email_contact');
  });

  it.each(OLD_ACTIONS.filter((a) => !a.startsWith('ROLE_')))(
    'refuses a phone contact on the non-phone action %s (ck_account_audit_events__phone_contact)',
    async (action) => {
      const c = await freshPending();
      expect(await constraintOf(insertAudit(c.accountId, action, c.id))).toBe('ck_account_audit_events__phone_contact');
    },
  );

  it.each(EMAIL_ACTIONS)('refuses a phone contact on the email action %s (a phone contact on a non-phone action)', async (action) => {
    const c = await freshPending();
    const e = await fail(insertAudit(c.accountId, action, c.id));
    expect(['ck_account_audit_events__email_contact', 'ck_account_audit_events__phone_contact']).toContain(e.constraint);
  });

  it.each(AUDIT_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it('keeps the role rule beside the phone rule: a phone action with a role is refused (ck_account_audit_events__role)', async () => {
    const c = await freshPending();
    const e = await fail(
      q(`INSERT INTO ${AUDIT} (actor, action, account_id, role_id, phone_contact_id, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
        'test',
        'PHONE_ADDED',
        c.accountId,
        await CUSTOMER(),
        c.id,
        'test-correlation',
      ]),
    );
    expect(e.constraint).toBe('ck_account_audit_events__role');
  });

  it.each(PHONE_ACTIONS)(
    "refuses %s naming a contact of ANOTHER account (composite foreign key), and accepts the same row once the contact is the audited account's own",
    async (action) => {
      const own = await freshPending();
      const foreign = await freshPending();
      expect(await constraintOf(insertAudit(own.accountId, action, foreign.id))).toBe('fk_account_audit_events__account_phone_contact');
      expect(await count(AUDIT, 'phone_contact_id = $1', [foreign.id])).toBe(0);
      await insertAudit(own.accountId, action, own.id);
      await insertAudit(foreign.accountId, action, foreign.id);
    },
  );

  it('ties the audit row to the account of the contact even when the account holds several contacts (history rows included)', async () => {
    const { accountId, primary, candidate } = await accountWithReplacement();
    await disableOn(pool, candidate.id, 'SUPERSEDED');
    for (const c of [primary, candidate]) await insertAudit(accountId, 'PHONE_ADDED', c.id);
    const other = await freshPending();
    for (const c of [primary, candidate])
      expect(await constraintOf(insertAudit(other.accountId, 'PHONE_ADDED', c.id))).toBe('fk_account_audit_events__account_phone_contact');
    expect(await count(AUDIT, 'account_id = $1 AND phone_contact_id IS NOT NULL', [accountId])).toBe(2);
  });

  it('skips the composite key for a row without a contact (MATCH SIMPLE): a non-phone action of any account needs no contact', async () => {
    await insertAudit(await makeAccount(), 'PROFILE_UPDATED');
  });

  it('refuses UPDATE and DELETE of a phone audit row, on every column (ROW_IMMUTABLE)', async () => {
    const c = await freshPending();
    const id = await insertAudit(c.accountId, 'PHONE_ADDED', c.id, '{"maskedPhone":"+*******0142"}');
    const updates = [
      "actor = 'someone'",
      "action = 'PHONE_VERIFIED'",
      'phone_contact_id = NULL',
      "changes = '{}'::jsonb",
      "reason = 'edited'",
      "correlation_id = 'x'",
      'occurred_at = now()',
    ];
    for (const set of updates) await expectRule(run(`UPDATE ${AUDIT} SET ${set} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${AUDIT} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
    expect(await q(`SELECT action, phone_contact_id, changes FROM ${AUDIT} WHERE audit_event_id = $1`, [id])).toEqual([
      { action: 'PHONE_ADDED', phone_contact_id: c.id, changes: { maskedPhone: '+*******0142' } },
    ]);
  });

  it('keeps the contact when an audit row names it (the contact cannot be deleted: NOT_DELETABLE, and the foreign key is RESTRICT)', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'PHONE_ADDED', c.id);
    await expectRule(run('DELETE FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id]), 'NOT_DELETABLE');
    // with the guard bypassed the foreign key itself refuses
    expect(await constraintOf(isolated(noTriggers(CONTACTS), 'DELETE FROM identity.phone_contacts WHERE phone_contact_id = $1', [c.id]))).toBe(
      'fk_account_audit_events__account_phone_contact',
    );
  });

  it('accepts a per-contact timeline: several audit rows for one contact are all kept', async () => {
    const c = await freshPending();
    for (const action of ['PHONE_ADDED', 'PHONE_VERIFICATION_REQUESTED', 'PHONE_VERIFICATION_FAILED']) await insertAudit(c.accountId, action, c.id);
    const rows = await q<{ action: string }>(`SELECT action FROM ${AUDIT} WHERE phone_contact_id = $1 ORDER BY occurred_at, action`, [c.id]);
    expect(rows.map((r) => r.action).sort()).toEqual(['PHONE_ADDED', 'PHONE_VERIFICATION_FAILED', 'PHONE_VERIFICATION_REQUESTED']);
  });

  it('leaves the old email audit constraints in force (EMAIL_ADDED still requires an email contact)', async () => {
    expect(
      await constraintOf(q(`INSERT INTO ${AUDIT} (actor, action, account_id, correlation_id) VALUES ('t', 'EMAIL_ADDED', $1, 'c')`, [await makeAccount()])),
    ).toBe('ck_account_audit_events__email_contact');
  });
});

// ====================================================================== I. configuration seeds
interface ParamSeed {
  key: string;
  type: 'INTEGER' | 'JSON';
  owner: 'security' | 'trust';
  unit: string | null;
  rules: unknown;
  value: unknown;
  scopes: string[];
}
const PLATFORM_ONLY = ['PLATFORM'];
const POLICY_SCOPES = ['COUNTRY', 'MARKET', 'PLATFORM'];
const range = (min: number, max: number) => ({ min, max });
const PARAM_SEEDS: ParamSeed[] = [
  { key: 'verification.phone.code.length', type: 'INTEGER', owner: 'security', unit: 'digits', rules: range(4, 10), value: 6, scopes: PLATFORM_ONLY },
  { key: 'verification.phone.validity_minutes', type: 'INTEGER', owner: 'security', unit: 'minutes', rules: range(1, 120), value: 10, scopes: PLATFORM_ONLY },
  { key: 'verification.phone.resend_seconds', type: 'INTEGER', owner: 'security', unit: 'seconds', rules: range(0, 3600), value: 30, scopes: PLATFORM_ONLY },
  { key: 'verification.phone.max_per_hour', type: 'INTEGER', owner: 'security', unit: 'sends', rules: range(1, 100), value: 5, scopes: PLATFORM_ONLY },
  { key: 'verification.phone.max_per_day', type: 'INTEGER', owner: 'security', unit: 'sends', rules: range(1, 1000), value: 10, scopes: PLATFORM_ONLY },
  { key: 'verification.phone.max_attempts', type: 'INTEGER', owner: 'security', unit: 'attempts', rules: range(1, 20), value: 5, scopes: PLATFORM_ONLY },
  { key: 'verification.phone.max_accounts_per_number', type: 'INTEGER', owner: 'trust', unit: 'accounts', rules: range(1, 5), value: 1, scopes: POLICY_SCOPES },
  {
    key: 'verification.phone.blocked_line_types',
    type: 'JSON',
    owner: 'trust',
    unit: null,
    rules: {
      schema: {
        type: 'array',
        items: { type: 'string', enum: ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'] },
        uniqueItems: true,
        maxItems: 5,
      },
    },
    value: ['VIRTUAL', 'HIGH_RISK'],
    scopes: POLICY_SCOPES,
  },
  {
    key: 'verification.phone.requests.max_per_hour',
    type: 'INTEGER',
    owner: 'security',
    unit: 'requests',
    rules: range(1, 1000),
    value: 30,
    scopes: PLATFORM_ONLY,
  },
  { key: 'verification.phone.number.max_per_hour', type: 'INTEGER', owner: 'security', unit: 'sends', rules: range(1, 100), value: 5, scopes: PLATFORM_ONLY },
];
const PARAM_KEYS = PARAM_SEEDS.map((p) => p.key);
const parameterId = async (key: string): Promise<string> =>
  (await q<{ parameter_id: string }>('SELECT parameter_id FROM configuration.parameters WHERE key = $1', [key]))[0]!.parameter_id;

describe('I. seeded configuration: the ten verification.phone.* parameters', () => {
  it('seeds exactly the ten parameters, and no other verification.phone.* key', async () => {
    const rows = await q<{ key: string }>("SELECT key FROM configuration.parameters WHERE key LIKE 'verification.phone.%'");
    expect(rows.map((r) => r.key).sort()).toEqual([...PARAM_KEYS].sort());
    expect(PARAM_KEYS).toHaveLength(10);
  });

  it('leaves the eight verification.email.* parameters untouched', async () => {
    expect(await count('configuration.parameters', "key LIKE 'verification.email.%'")).toBe(8);
  });

  it.each(PARAM_SEEDS)(
    'defines $key as a required, active, CRITICAL INTERNAL parameter with a SECOND_APPROVER policy and the right owner and type',
    async (seed) => {
      const rows = await q(
        `SELECT data_type, owner_role, approval_policy, criticality, sensitivity, is_required, is_active, created_by FROM configuration.parameters WHERE key = $1`,
        [seed.key],
      );
      expect(rows).toEqual([
        {
          data_type: seed.type,
          owner_role: seed.owner,
          approval_policy: 'SECOND_APPROVER',
          criticality: 'CRITICAL',
          sensitivity: 'INTERNAL',
          is_required: true,
          is_active: true,
          created_by: 'system:migration',
        },
      ]);
    },
  );

  it.each(PARAM_SEEDS)('declares the unit and the validation rules of $key', async ({ key, unit, rules }) => {
    const rows = await q<{ unit: string | null; validation_rules: unknown }>('SELECT unit, validation_rules FROM configuration.parameters WHERE key = $1', [
      key,
    ]);
    expect(rows).toEqual([{ unit, validation_rules: rules }]);
  });

  it.each(PARAM_SEEDS)('allows the scopes $scopes for $key', async ({ key, scopes }) => {
    const rows = await q<{ scope_type: string }>(
      `SELECT s.scope_type FROM configuration.parameters p JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id WHERE p.key = $1 ORDER BY s.scope_type`,
      [key],
    );
    expect(rows.map((r) => r.scope_type)).toEqual(scopes);
  });

  it('allows the PLATFORM scope only for the eight platform parameters and PLATFORM + COUNTRY + MARKET for max_accounts_per_number and blocked_line_types', async () => {
    const rows = await q<{ key: string; scopes: string[] }>(
      `SELECT p.key, array_agg(s.scope_type ORDER BY s.scope_type) AS scopes FROM configuration.parameters p
         JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id WHERE p.key LIKE 'verification.phone.%' GROUP BY p.key`,
    );
    expect(rows).toHaveLength(10);
    const wide = rows
      .filter((r) => r.scopes.length === 3)
      .map((r) => r.key)
      .sort();
    expect(wide).toEqual(['verification.phone.blocked_line_types', 'verification.phone.max_accounts_per_number']);
    for (const r of rows.filter((x) => !wide.includes(x.key))) expect(r.scopes, r.key).toEqual(['PLATFORM']);
  });

  it('gives the two market policy parameters to the trust owner and the eight abuse and code parameters to security', async () => {
    const rows = await q<{ key: string; owner_role: string }>("SELECT key, owner_role FROM configuration.parameters WHERE key LIKE 'verification.phone.%'");
    const trust = rows
      .filter((r) => r.owner_role === 'trust')
      .map((r) => r.key)
      .sort();
    expect(trust).toEqual(['verification.phone.blocked_line_types', 'verification.phone.max_accounts_per_number']);
    expect(rows.filter((r) => r.owner_role === 'security')).toHaveLength(8);
  });

  it('declares the JSON schema of blocked_line_types: a unique array of at most five of the five blockable line types (MOBILE is not blockable)', async () => {
    const rules = (
      await q<{ validation_rules: { schema: { items: { enum: string[] }; maxItems: number; uniqueItems: boolean; type: string } } }>(
        "SELECT validation_rules FROM configuration.parameters WHERE key = 'verification.phone.blocked_line_types'",
      )
    )[0]!.validation_rules;
    expect(rules.schema.type).toBe('array');
    expect(rules.schema.uniqueItems).toBe(true);
    expect(rules.schema.maxItems).toBe(5);
    expect(rules.schema.items.enum).toEqual(['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK']);
    expect(rules.schema.items.enum).not.toContain('MOBILE');
  });

  it.each(PARAM_SEEDS)('holds one PLATFORM value version 1 = $value for $key, effective now and open-ended', async ({ key, value }) => {
    const rows = await q(
      `SELECT h.scope_type, h.scope_ref, v.version, v.value, v.effective_from <= now() AS started, v.effective_to, v.created_by, v.reason
         FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key = $1`,
      [key],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope_type: 'PLATFORM',
      scope_ref: null,
      version: 1,
      value,
      started: true,
      effective_to: null,
      created_by: 'system:migration',
    });
    expect((rows[0] as { reason: string }).reason).toMatch(/^Initial value \(migration 0011\)/);
  });

  it('seeds the values in order: 6, 10, 30, 5, 10, 5, 1, ["VIRTUAL","HIGH_RISK"], 30, 5', async () => {
    const rows = await q<{ key: string; value: unknown }>(
      `SELECT p.key, v.value FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key LIKE 'verification.phone.%'`,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(PARAM_KEYS.map((k) => byKey[k])).toEqual([6, 10, 30, 5, 10, 5, 1, ['VIRTUAL', 'HIGH_RISK'], 30, 5]);
  });

  it('keeps every integer value inside its own validation range, and the hourly cap at most the daily cap', () => {
    for (const p of PARAM_SEEDS.filter((s) => s.type === 'INTEGER')) {
      const { min, max } = p.rules as { min: number; max: number };
      expect(p.value as number, p.key).toBeGreaterThanOrEqual(min);
      expect(p.value as number, p.key).toBeLessThanOrEqual(max);
    }
    const value = (key: string) => PARAM_SEEDS.find((p) => p.key === key)!.value as number;
    expect(value('verification.phone.max_per_hour')).toBeLessThanOrEqual(value('verification.phone.max_per_day'));
  });

  it('never blocks MOBILE by default and keeps the blocked list inside its enum', () => {
    const blocked = PARAM_SEEDS.find((p) => p.key === 'verification.phone.blocked_line_types')!.value as string[];
    const allowed = (PARAM_SEEDS.find((p) => p.key === 'verification.phone.blocked_line_types')!.rules as { schema: { items: { enum: string[] } } }).schema
      .items.enum;
    expect(blocked.every((t) => allowed.includes(t))).toBe(true);
    expect(blocked).not.toContain('MOBILE');
  });

  it('resolves exactly one effective version per parameter at the database clock (the no-overlap rule)', async () => {
    const rows = await q<{ key: string; n: number }>(
      `SELECT p.key, count(*)::int AS n FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id
        WHERE p.key LIKE 'verification.phone.%' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now()) GROUP BY p.key`,
    );
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(r.n, r.key).toBe(1);
  });

  it.each(PARAM_SEEDS)('records exactly one ACTIVE change request for $key, published as its value version', async ({ key, value }) => {
    const id = await parameterId(key);
    const rows = await q(
      `SELECT r.state, r.scope_type, r.scope_ref, r.proposed_value, r.effective_from <= now() AS started, r.effective_to, r.requested_by, r.approval_policy,
              r.value_version_id = v.version_id AS linked, v.value AS version_value, v.version
         FROM configuration.change_requests r LEFT JOIN configuration.value_versions v ON v.version_id = r.value_version_id WHERE r.parameter_id = $1`,
      [id],
    );
    expect(rows).toEqual([
      {
        state: 'ACTIVE',
        scope_type: 'PLATFORM',
        scope_ref: null,
        proposed_value: value,
        started: true,
        effective_to: null,
        requested_by: 'system:migration',
        approval_policy: 'SECOND_APPROVER',
        linked: true,
        version_value: value,
        version: 1,
      },
    ]);
  });

  it.each(PARAM_SEEDS)('records one approval of $key by a second person (system:migration-review, not the requester)', async ({ key }) => {
    const rows = await q(
      `SELECT a.approver, a.decision, r.requested_by, a.approver <> r.requested_by AS second_person
         FROM configuration.change_requests r JOIN configuration.change_approvals a ON a.change_request_id = r.change_request_id WHERE r.parameter_id = $1`,
      [await parameterId(key)],
    );
    expect(rows).toEqual([{ approver: 'system:migration-review', decision: 'APPROVE', requested_by: 'system:migration', second_person: true }]);
  });

  it.each(PARAM_SEEDS)('writes the six-step audit trail of $key exactly like the real workflow, in order', async ({ key }) => {
    const id = await parameterId(key);
    const rows = await q<{ action: string; actor: string; correlation_id: string; new_version_id: string | null; change_request_id: string | null }>(
      'SELECT action, actor, correlation_id, new_version_id, change_request_id FROM configuration.audit_events WHERE parameter_id = $1 ORDER BY occurred_at',
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'PARAMETER_CREATED',
      'CHANGE_DRAFTED',
      'CHANGE_SUBMITTED',
      'CHANGE_APPROVED',
      'CHANGE_PUBLISHED',
      'CHANGE_ACTIVATED',
    ]);
    expect(rows.map((r) => r.actor)).toEqual([
      'system:migration',
      'system:migration',
      'system:migration',
      'system:migration-review',
      'system:migration',
      'system:migration',
    ]);
    for (const r of rows) expect(r.correlation_id).toBe('seed-0011');
    const version = (
      await q<{ version_id: string }>(
        'SELECT v.version_id FROM configuration.change_requests r JOIN configuration.value_versions v ON v.version_id = r.value_version_id WHERE r.parameter_id = $1',
        [id],
      )
    )[0]!.version_id;
    expect(rows.slice(4).map((r) => r.new_version_id)).toEqual([version, version]);
    expect(rows[0]!.change_request_id).toBeNull();
    expect(new Set(rows.slice(1).map((r) => r.change_request_id)).size).toBe(1);
  });

  it('refuses to change or delete a seeded value version: they are immutable (corrections create a new version)', async () => {
    const id = await parameterId('verification.phone.max_attempts');
    const version = (
      await q<{ version_id: string }>(
        'SELECT v.version_id FROM configuration.parameter_values h JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE h.parameter_id = $1',
        [id],
      )
    )[0]!.version_id;
    for (const set of ["value = '99'::jsonb", "reason = 'edited'", "effective_from = now() - interval '1 day'", "created_by = 'someone'", 'version = 2']) {
      const e = await fail(run(`UPDATE configuration.value_versions SET ${set} WHERE version_id = $1`, [version]));
      expect(e.code, set).toBe('23000');
    }
    expect((await fail(run('DELETE FROM configuration.value_versions WHERE version_id = $1', [version]))).code).toBe('23000');
    expect((await q<{ value: number }>('SELECT value FROM configuration.value_versions WHERE version_id = $1', [version]))[0]!.value).toBe(5);
  });

  it('refuses to change the seeded blocked_line_types value version too (the JSON value is immutable)', async () => {
    const id = await parameterId('verification.phone.blocked_line_types');
    const version = (
      await q<{ version_id: string }>(
        'SELECT v.version_id FROM configuration.parameter_values h JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE h.parameter_id = $1',
        [id],
      )
    )[0]!.version_id;
    expect((await fail(run(`UPDATE configuration.value_versions SET value = '[]'::jsonb WHERE version_id = $1`, [version]))).code).toBe('23000');
    expect((await q<{ value: unknown }>('SELECT value FROM configuration.value_versions WHERE version_id = $1', [version]))[0]!.value).toEqual([
      'VIRTUAL',
      'HIGH_RISK',
    ]);
  });

  it('refuses to rename, retype or delete a seeded parameter definition, and to rewrite its approved request or approval', async () => {
    const id = await parameterId('verification.phone.code.length');
    expect((await fail(run("UPDATE configuration.parameters SET key = 'verification.phone.other' WHERE parameter_id = $1", [id]))).code).toBe('23000');
    expect((await fail(run("UPDATE configuration.parameters SET data_type = 'STRING' WHERE parameter_id = $1", [id]))).code).toBe('23000');
    expect((await fail(run('DELETE FROM configuration.parameters WHERE parameter_id = $1', [id]))).code).toBe('23000');
    expect((await fail(run("UPDATE configuration.change_requests SET proposed_value = '1'::jsonb WHERE parameter_id = $1", [id]))).code).toBe('23000');
    expect(
      (
        await fail(
          run(
            "UPDATE configuration.change_approvals SET decision = 'REJECT' WHERE change_request_id IN (SELECT change_request_id FROM configuration.change_requests WHERE parameter_id = $1)",
            [id],
          ),
        )
      ).code,
    ).toBe('23000');
    expect((await fail(run('DELETE FROM configuration.audit_events WHERE parameter_id = $1', [id]))).code).toBe('23000');
  });

  it('would refuse the requester approving its own change again (the self-approval trigger holds for these requests)', async () => {
    const id = await parameterId('verification.phone.max_per_day');
    const request = (await q<{ change_request_id: string }>('SELECT change_request_id FROM configuration.change_requests WHERE parameter_id = $1', [id]))[0]!
      .change_request_id;
    const e = await fail(
      run("INSERT INTO configuration.change_approvals (change_request_id, approver, decision) VALUES ($1, 'system:migration', 'APPROVE')", [request]),
    );
    expect(e.code).toBe('23000');
  });
});

// ====================================================================== J. content seeds
const ISSUE_KEYS = ['required', 'too_long', 'invalid_characters', 'invalid_number', 'country_required', 'country_not_supported'].map(
  (k) => `account.phone.error.${k}`,
);
const ERROR_KEYS = [
  'not_pending',
  'code_invalid',
  'code_expired',
  'code_used',
  'verification_locked',
  'resend_too_soon',
  'send_limit',
  'unavailable',
  'not_accepted',
  'risk_unavailable',
  'delivery_failed',
  'rate_limited',
].map((k) => `account.phone.error.${k}`);
const SMS_KEY = 'sms.verification.phone.body';
const PHONE_COPY: [key: string, type: string][] = [
  [SMS_KEY, 'PLAIN_TEXT'],
  ['account.phone.verify.title', 'UI_LABEL'],
  ['account.phone.verify.intro', 'PLAIN_TEXT'],
  ['account.phone.verify.number_label', 'UI_LABEL'],
  ['account.phone.verify.country_label', 'UI_LABEL'],
  ['account.phone.verify.code_label', 'UI_LABEL'],
  ['account.phone.verify.submit', 'UI_LABEL'],
  ['account.phone.verify.resend', 'UI_LABEL'],
  ['account.phone.verify.resend_wait', 'PLAIN_TEXT'],
  ['account.phone.verify.change', 'UI_LABEL'],
  ['account.phone.verify.sent', 'PLAIN_TEXT'],
  ['account.phone.verify.success', 'PLAIN_TEXT'],
  ['account.phone.status.none', 'UI_LABEL'],
  ['account.phone.status.pending', 'UI_LABEL'],
  ['account.phone.status.verified', 'UI_LABEL'],
  ...[...ISSUE_KEYS, ...ERROR_KEYS].map((k): [string, string] => [k, 'PLAIN_TEXT']),
];
const EXPECTED_VARIABLES: Record<string, [name: string, type: string, pii: string][]> = {
  [SMS_KEY]: [
    ['expiry_minutes', 'COUNT', 'NONE'],
    ['verification_code', 'STRING', 'SENSITIVE_PERSONAL'],
  ],
  'account.phone.verify.intro': [['masked_phone', 'STRING', 'PERSONAL']],
  'account.phone.verify.resend_wait': [['seconds', 'COUNT', 'NONE']],
};
interface EntryRow {
  entry_id: string;
  key: string;
  content_type: string;
}
const PHONE_FILTER = "(e.key LIKE 'account.phone.%' OR e.key = 'sms.verification.phone.body')";
const phoneEntries = async (): Promise<EntryRow[]> =>
  q<EntryRow>(`SELECT e.entry_id, e.key, e.content_type FROM content.entries e WHERE ${PHONE_FILTER} ORDER BY e.key`);
const bodyOf = async (key: string): Promise<string> =>
  (await q<{ body: string }>('SELECT v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = $1', [key]))[0]!.body;
/** Renders the SMS body the way an ICU renderer would for a COUNT: the other form for any number but one. */
const renderSms = (body: string, code: string, minutes: number): string =>
  body
    .replace('{verification_code}', code)
    .replace(/\{expiry_minutes, plural, one \{# minute\} other \{# minutes\}\}/, minutes === 1 ? `${minutes} minute` : `${minutes} minutes`);

describe('J. seeded content: the verification SMS and the phone screen copy (33 entries)', () => {
  it('seeds exactly 33 phone entries (one SMS body and 32 account.phone.* strings), each key once', async () => {
    const rows = await phoneEntries();
    expect(rows).toHaveLength(33);
    expect(PHONE_COPY).toHaveLength(33);
    expect(new Set(PHONE_COPY.map(([k]) => k)).size).toBe(33);
    expect(rows.map((r) => r.key)).toEqual(PHONE_COPY.map(([k]) => k).sort());
  });

  it('gives each entry its content type: the SMS body PLAIN_TEXT, ten UI_LABEL, the rest PLAIN_TEXT', async () => {
    const rows = await phoneEntries();
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.content_type]));
    expect(byKey).toEqual(Object.fromEntries(PHONE_COPY));
    expect(byKey[SMS_KEY]).toBe('PLAIN_TEXT');
    const types = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.content_type]: (acc[r.content_type] ?? 0) + 1 }), {});
    expect(types).toEqual({ UI_LABEL: 10, PLAIN_TEXT: 23 });
  });

  it('seeds no email content type for the SMS (no EMAIL_SUBJECT or EMAIL_BODY among the phone entries)', async () => {
    const rows = await phoneEntries();
    expect(rows.filter((r) => r.content_type.startsWith('EMAIL_'))).toEqual([]);
  });

  it('seeds every entry as PUBLIC, STANDARD, owned by CONTENT, approval NONE, CHAIN fallback, PLATFORM maximum scope, active', async () => {
    const rows = await q(
      `SELECT DISTINCT sensitivity, criticality, owner_role, approval_policy, fallback_policy, max_scope_type, is_active, created_by FROM content.entries e WHERE ${PHONE_FILTER}`,
    );
    expect(rows).toEqual([
      {
        sensitivity: 'PUBLIC',
        criticality: 'STANDARD',
        owner_role: 'CONTENT',
        approval_policy: 'NONE',
        fallback_policy: 'CHAIN',
        max_scope_type: 'PLATFORM',
        is_active: true,
        created_by: 'system:migration',
      },
    ]);
  });

  it('gives every entry exactly one en-US PLATFORM version 1, PUBLISHED, effective now and open-ended', async () => {
    const rows = await q(
      `SELECT e.key, count(*)::int AS versions, bool_and(v.locale = 'en-US') AS en_us, bool_and(v.scope_type = 'PLATFORM' AND v.scope_ref IS NULL) AS platform,
              bool_and(v.version = 1) AS v1, bool_and(v.status = 'PUBLISHED') AS published, bool_and(v.effective_from <= now()) AS started,
              bool_and(v.effective_to IS NULL) AS open_ended, bool_and(v.approval_policy = 'NONE') AS no_approval
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${PHONE_FILTER} GROUP BY e.key`,
    );
    expect(rows).toHaveLength(33);
    for (const r of rows)
      expect(r, (r as { key: string }).key).toMatchObject({
        versions: 1,
        en_us: true,
        platform: true,
        v1: true,
        published: true,
        started: true,
        open_ended: true,
        no_approval: true,
      });
  });

  it('records each body hash as the SHA-256 of its text (computed by the database, never trusted from the seed)', async () => {
    const rows = await q<{ key: string; body: string; body_sha256: string }>(
      `SELECT e.key, v.body, v.body_sha256 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${PHONE_FILTER}`,
    );
    expect(rows).toHaveLength(33);
    for (const r of rows) expect(r.body_sha256, r.key).toBe(sha256(r.body));
  });

  it('writes the content audit trail of every entry: ENTRY_CREATED, VERSION_DRAFTED, VERSION_APPROVED, VERSION_PUBLISHED, VERSION_ACTIVATED', async () => {
    const rows = await q<{ key: string; actions: string[]; actors: string[]; correlations: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at) AS actions, array_agg(DISTINCT a.actor) AS actors, array_agg(DISTINCT a.correlation_id) AS correlations
         FROM content.entries e JOIN content.audit_events a ON a.entry_id = e.entry_id WHERE ${PHONE_FILTER} GROUP BY e.key`,
    );
    expect(rows).toHaveLength(33);
    for (const r of rows) {
      expect(r.actions, r.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
      expect(r.actors).toEqual(['system:migration']);
      expect(r.correlations).toEqual(['seed-0011']);
    }
  });

  it('declares exactly the typed variables of the SMS body and the two screen strings, and none on any other entry', async () => {
    const rows = await q<{ key: string; name: string; var_type: string; pii_class: string; is_required: boolean }>(
      `SELECT e.key, x.name, x.var_type, x.pii_class, x.is_required FROM content.entries e JOIN content.entry_variables x ON x.entry_id = e.entry_id
        WHERE ${PHONE_FILTER} ORDER BY e.key, x.name`,
    );
    const grouped: Record<string, [string, string, string][]> = {};
    for (const r of rows) (grouped[r.key] ??= []).push([r.name, r.var_type, r.pii_class]);
    expect(grouped).toEqual(EXPECTED_VARIABLES);
    for (const r of rows) expect(r.is_required, `${r.key}.${r.name}`).toBe(true);
  });

  it('marks the verification code SENSITIVE_PERSONAL (a credential), the masked number PERSONAL and the counts NONE', async () => {
    const rows = await q<{ name: string; var_type: string; pii_class: string }>(
      `SELECT x.name, x.var_type, x.pii_class FROM content.entry_variables x JOIN content.entries e ON e.entry_id = x.entry_id WHERE e.key = $1 ORDER BY x.name`,
      [SMS_KEY],
    );
    expect(rows).toEqual([
      { name: 'expiry_minutes', var_type: 'COUNT', pii_class: 'NONE' },
      { name: 'verification_code', var_type: 'STRING', pii_class: 'SENSITIVE_PERSONAL' },
    ]);
  });

  it('carries the example values of the SMS variables (a code and ten minutes)', async () => {
    const rows = await q<{ name: string; example_value: unknown }>(
      `SELECT x.name, x.example_value FROM content.entry_variables x JOIN content.entries e ON e.entry_id = x.entry_id WHERE e.key = $1 ORDER BY x.name`,
      [SMS_KEY],
    );
    expect(rows).toEqual([
      { name: 'expiry_minutes', example_value: 10 },
      { name: 'verification_code', example_value: '123456' },
    ]);
  });

  it('puts both placeholders in the SMS body, each once, and uses the plural form for the minutes', async () => {
    const body = await bodyOf(SMS_KEY);
    expect(body.split('{verification_code}')).toHaveLength(2);
    expect(body).toMatch(/\{expiry_minutes, plural,/);
    expect(body.match(/\{expiry_minutes/g)).toHaveLength(1);
    expect(body).toMatch(/^BananaGig: /);
    expect(body).toMatch(/Never share this code\.$/);
  });

  it('keeps the SMS free of any link, address or account detail', async () => {
    const body = await bodyOf(SMS_KEY);
    expect(body).not.toMatch(/https?:\/\//i);
    expect(body).not.toMatch(/www\./i);
    expect(body).not.toMatch(/\b[a-z0-9-]+\.(com|net|org|io|app|test|co)\b/i);
    expect(body).not.toMatch(/@/);
    expect(body).not.toMatch(/\{(account|user|name|email|phone|url|link)/i);
  });

  it('renders the SMS to at most 160 characters with the example values (one GSM-7 segment)', async () => {
    const body = await bodyOf(SMS_KEY);
    const text = renderSms(body, '123456', 10);
    expect(text).toBe('BananaGig: 123456 is your verification code. It expires in 10 minutes. Never share this code.');
    expect(text.length).toBeLessThanOrEqual(160);
  });

  it('still renders to at most 160 characters at the extremes of the validation ranges (10-digit code, 120 minutes) and for one minute', async () => {
    const body = await bodyOf(SMS_KEY);
    expect(renderSms(body, '9'.repeat(10), 120).length).toBeLessThanOrEqual(160);
    const single = renderSms(body, '123456', 1);
    expect(single).toContain('1 minute.');
    expect(single).not.toContain('1 minutes');
    expect(single.length).toBeLessThanOrEqual(160);
  });

  it('renders to plain GSM-7 basic characters only (printable ASCII, none of the two-septet extension characters)', async () => {
    const text = renderSms(await bodyOf(SMS_KEY), '123456', 10);
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    expect(text).not.toMatch(/[{}[\]~^|\\]/);
  });

  it('leaves no placeholder behind once the two variables are substituted', async () => {
    const text = renderSms(await bodyOf(SMS_KEY), '123456', 10);
    expect(text).not.toMatch(/[{}#]/);
  });

  it('never embeds a sample code or a literal link in any seeded text other than the SMS example variable', async () => {
    const rows = await q<{ key: string; body: string }>(
      `SELECT e.key, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${PHONE_FILTER}`,
    );
    for (const r of rows) {
      expect(r.body, r.key).not.toMatch(/\d{4,}/);
      expect(r.body, r.key).not.toMatch(/https?:\/\//i);
    }
  });

  it('uses only the placeholders the entry declares, and every declared variable appears in its text', async () => {
    const rows = await q<{ key: string; body: string; names: string[] | null }>(
      `SELECT e.key, v.body, (SELECT array_agg(x.name ORDER BY x.name) FROM content.entry_variables x WHERE x.entry_id = e.entry_id) AS names
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${PHONE_FILTER}`,
    );
    for (const r of rows) {
      const used = [...new Set([...r.body.matchAll(/\{([a-z][a-z0-9_]*)\s*[,}]/g)].map((m) => m[1]!))].sort();
      expect(used, r.key).toEqual(r.names ?? []);
    }
  });

  it('covers every message key the phone vocabulary needs: six validation issues and twelve error codes (eighteen error keys)', async () => {
    const present = new Set((await phoneEntries()).map((r) => r.key));
    for (const key of [...ISSUE_KEYS, ...ERROR_KEYS]) expect(present.has(key), key).toBe(true);
    expect(ISSUE_KEYS).toHaveLength(6);
    expect(ERROR_KEYS).toHaveLength(12);
    expect(new Set([...ISSUE_KEYS, ...ERROR_KEYS]).size).toBe(18);
    expect([...present].filter((k) => k.startsWith('account.phone.error.'))).toHaveLength(18);
  });

  it('covers the three verification status labels and the screen strings a client reads by key', async () => {
    const present = new Set((await phoneEntries()).map((r) => r.key));
    for (const s of ['none', 'pending', 'verified']) expect(present.has(`account.phone.status.${s}`), s).toBe(true);
    for (const k of ['title', 'intro', 'number_label', 'country_label', 'code_label', 'submit', 'resend', 'resend_wait', 'change', 'sent', 'success'])
      expect(present.has(`account.phone.verify.${k}`), k).toBe(true);
  });

  it('has no link-confirmation screen (an SMS carries a code only): no account.phone.link.* entry', async () => {
    expect((await phoneEntries()).filter((r) => r.key.startsWith('account.phone.link.'))).toEqual([]);
  });

  it('keeps every seeded text non-blank, single-line and free of control characters', async () => {
    const rows = await q<{ key: string; body: string }>(
      `SELECT e.key, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${PHONE_FILTER}`,
    );
    for (const r of rows) {
      expect(r.body.trim().length, r.key).toBeGreaterThan(0);
      expect(
        [...r.body].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
        r.key,
      ).toBe(false);
    }
  });

  it('leaves the email copy untouched (34 account.email.* entries)', async () => {
    expect(await count('content.entries', "key LIKE 'account.email.%'")).toBe(34);
  });

  it('refuses to edit or delete a seeded published version (the text is immutable; corrections are new versions)', async () => {
    const version = (
      await q<{ version_id: string }>(
        "SELECT v.version_id FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = 'account.phone.verify.title'",
      )
    )[0]!.version_id;
    expect((await fail(run("UPDATE content.versions SET body = 'Changed' WHERE version_id = $1", [version]))).code).toBe('23000');
    expect((await fail(run('DELETE FROM content.versions WHERE version_id = $1', [version]))).code).toBe('23000');
  });

  it('refuses to edit the seeded SMS version too (the credential-bearing text cannot be changed in place)', async () => {
    const version = (
      await q<{ version_id: string }>(
        `SELECT v.version_id FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = '${SMS_KEY}'`,
      )
    )[0]!.version_id;
    expect((await fail(run("UPDATE content.versions SET body = 'Your code is {verification_code}' WHERE version_id = $1", [version]))).code).toBe('23000');
  });
});
