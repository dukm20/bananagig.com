import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0010 adds the BananaGig-owned email contact (identity.email_contacts), one verification challenge per send
// (identity.email_verification_challenges), the audit extension (email_contact_id + seven EMAIL_* actions), the guard triggers, the deferred invariant
// triggers, eight verification.email.* configuration parameters and 34 account.email.* content entries. These tests drive the REAL tables with raw SQL:
// the shape of the schema (no plaintext secret, no plain address column), every CHECK/UNIQUE/FK/PK by constraint name, the uniqueness policy, every
// guard rule (SQLSTATE 23000, DETAIL identity_rule:<KEY>), the deferred invariants at COMMIT, atomic attempt counting under real concurrency, the audit
// extension and both seeds. Service behaviour is covered in packages/accounts (email-verification.itest.ts).
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
const addr = (tag = 'u'): string => `${tag}-${uniq()}@example.test`;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type Db = pg.Pool | pg.PoolClient;

/** Runs the callback in one transaction on its own connection: COMMIT on success (a deferred trigger may fail right there), ROLLBACK on any failure. */
async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
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
const CONTACTS = 'identity.email_contacts';
const CHALLENGES = 'identity.email_verification_challenges';

/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}

// ---------------------------------------------------------------- fixtures: accounts (the ID-001 shape, copied from identity-model.itest.ts)
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

// ---------------------------------------------------------------- fixtures: contacts and challenges
interface Contact {
  id: string;
  accountId: string;
  email: string;
  /** true for a REPLACEMENT_PENDING candidate (its challenges have the purpose CHANGE_EMAIL) */
  replacement: boolean;
}
interface ContactInput {
  id?: string;
  email?: string;
  status?: string;
  primary?: boolean;
  source?: string;
  verified?: boolean;
  disabledAt?: boolean;
  disabledReason?: string | null;
}
const insertContact = async (accountId: string, o: ContactInput = {}): Promise<Contact> => {
  const email = o.email ?? addr();
  const status = o.status ?? 'PENDING';
  const r = await q<{ email_contact_id: string }>(
    `INSERT INTO identity.email_contacts (email_contact_id, account_id, email_normalized, status, is_primary, source, verified_at, disabled_at, disabled_reason)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END, CASE WHEN $8::boolean THEN now() END, $9)
     RETURNING email_contact_id`,
    [
      o.id ?? null,
      accountId,
      email,
      status,
      o.primary ?? false,
      o.source ?? 'USER_ENTERED',
      o.verified ?? false,
      o.disabledAt ?? false,
      o.disabledReason ?? null,
    ],
  );
  return { id: r[0]!.email_contact_id, accountId, email, replacement: status === 'REPLACEMENT_PENDING' };
};
/** PENDING -> VERIFIED and primary (the legal first verification). */
const verifyOn = (db: Db, id: string) =>
  db.query("UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now(), updated_at = now() WHERE email_contact_id = $1", [
    id,
  ]);
/** -> DISABLED (REPLACED for a verified primary, SUPERSEDED for a pending candidate). */
const disableOn = (db: Db, id: string, reason: 'REPLACED' | 'SUPERSEDED') =>
  db.query(
    "UPDATE identity.email_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = $2, updated_at = now() WHERE email_contact_id = $1",
    [id, reason],
  );
const insertIdpPrimary = (accountId: string, email = addr()) =>
  insertContact(accountId, { email, status: 'VERIFIED', primary: true, source: 'IDP_VERIFIED', verified: true });
const consumeOn = (db: Db, challengeId: string, via: 'CODE' | 'LINK' = 'CODE') =>
  db.query('UPDATE identity.email_verification_challenges SET used_at = now(), consumed_via = $2 WHERE challenge_id = $1', [challengeId, via]);
const invalidateOn = (db: Db, challengeId: string, reason: string) =>
  db.query('UPDATE identity.email_verification_challenges SET invalidated_at = now(), invalidation_reason = $2 WHERE challenge_id = $1', [challengeId, reason]);

/** A new account with a PENDING address. */
const freshPending = async (): Promise<Contact> => insertContact(await makeAccount());
/** A new account whose address is verified and primary (PENDING -> VERIFIED, no challenge involved). */
async function accountWithPrimary(): Promise<{ accountId: string; primary: Contact }> {
  const accountId = await makeAccount();
  const primary = await insertContact(accountId);
  await verifyOn(pool, primary.id);
  return { accountId, primary: { ...primary } };
}
/** A new account with a verified primary and a REPLACEMENT_PENDING candidate. */
async function accountWithReplacement(): Promise<{ accountId: string; primary: Contact; candidate: Contact }> {
  const { accountId, primary } = await accountWithPrimary();
  return { accountId, primary, candidate: await insertContact(accountId, { status: 'REPLACEMENT_PENDING' }) };
}

/** Inserts a challenge; `override` replaces columns (or adds one such as used_at); expires_at defaults to ten minutes from the database clock. */
async function insertChallengeRow(contactId: string, override: Record<string, unknown> = {}, db: Db = pool): Promise<string> {
  const cols: Record<string, unknown> = {
    email_contact_id: contactId,
    purpose: 'INITIAL_EMAIL',
    code_hash: hex64(),
    magic_token_hash: hex64(),
    correlation_id: 'test-correlation',
    ...override,
  };
  const names = Object.keys(cols);
  const withExpiry = 'expires_at' in cols;
  const text = `INSERT INTO identity.email_verification_challenges (${names.join(', ')}${withExpiry ? '' : ', expires_at'})
    VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}${withExpiry ? '' : ", now() + interval '10 minutes'"}) RETURNING challenge_id`;
  return (await db.query(text, Object.values(cols))).rows[0].challenge_id as string;
}
const challengeFor = (c: Contact, override: Record<string, unknown> = {}, db: Db = pool): Promise<string> =>
  insertChallengeRow(c.id, { purpose: c.replacement ? 'CHANGE_EMAIL' : 'INITIAL_EMAIL', ...override }, db);
/** An insert with explicit SQL expressions for the timestamps (for the expiry check and expired fixtures). */
const challengeAt = (contactId: string, o: { expires: string; created?: string }) =>
  run(
    `INSERT INTO identity.email_verification_challenges (email_contact_id, purpose, code_hash, magic_token_hash, expires_at, created_at, correlation_id)
     VALUES ($1, 'INITIAL_EMAIL', $2, $3, ${o.expires}, ${o.created ?? 'now()'}, 'test-correlation')`,
    [contactId, hex64(), hex64()],
  );

/** A new account with a PENDING address and one open INITIAL_EMAIL challenge. */
async function freshOpen(): Promise<{ contact: Contact; challengeId: string }> {
  const contact = await freshPending();
  return { contact, challengeId: await challengeFor(contact) };
}
/** A new account with a verified primary, a REPLACEMENT_PENDING candidate and one open CHANGE_EMAIL challenge. */
async function freshReplacementOpen() {
  const base = await accountWithReplacement();
  return { ...base, challengeId: await challengeFor(base.candidate) };
}
/** A challenge that was consumed together with the verification of its address (one transaction, as the service does it). */
async function freshUsed(via: 'CODE' | 'LINK' = 'CODE'): Promise<{ contact: Contact; challengeId: string }> {
  const { contact, challengeId } = await freshOpen();
  await inTx(async (c) => {
    await verifyOn(c, contact.id);
    await consumeOn(c, challengeId, via);
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
      'SELECT status, is_primary, verified_at IS NOT NULL AS verified, disabled_reason FROM identity.email_contacts WHERE email_contact_id = $1',
      [id],
    )
  )[0]!;
const challengeState = async (id: string) =>
  (
    await q<{
      attempt_count: number;
      used: boolean;
      consumed_via: string | null;
      invalidated: boolean;
      invalidation_reason: string | null;
      delivery_status: string;
      sent: boolean;
    }>(
      `SELECT attempt_count, used_at IS NOT NULL AS used, consumed_via, invalidated_at IS NOT NULL AS invalidated, invalidation_reason, delivery_status,
              last_sent_at IS NOT NULL AS sent FROM identity.email_verification_challenges WHERE challenge_id = $1`,
      [id],
    )
  )[0]!;
const primariesOf = async (accountId: string): Promise<number> => count(CONTACTS, 'account_id = $1 AND is_primary', [accountId]);
const insertAudit = (accountId: string, action: string, contactId: string | null = null, changes: string | null = null) =>
  q<{ audit_event_id: string }>(
    'INSERT INTO identity.account_audit_events (actor, action, account_id, email_contact_id, changes, correlation_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING audit_event_id',
    ['test', action, accountId, contactId, changes, 'test-correlation'],
  ).then((r) => r[0]!.audit_event_id);

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null];
const CONTACT_COLUMNS: ColumnShape[] = [
  ['email_contact_id', 'uuid', false, 'gen_random_uuid()'],
  ['account_id', 'uuid', false, null],
  ['email_normalized', 'text', false, null],
  ['status', 'text', false, null],
  ['is_primary', 'boolean', false, 'false'],
  ['source', 'text', false, null],
  ['verified_at', 'timestamp with time zone', true, null],
  ['disabled_at', 'timestamp with time zone', true, null],
  ['disabled_reason', 'text', true, null],
  ['created_at', 'timestamp with time zone', false, 'now()'],
  ['updated_at', 'timestamp with time zone', false, 'now()'],
];
const CHALLENGE_COLUMNS: ColumnShape[] = [
  ['challenge_id', 'uuid', false, 'gen_random_uuid()'],
  ['email_contact_id', 'uuid', false, null],
  ['purpose', 'text', false, null],
  ['code_hash', 'text', false, null],
  ['magic_token_hash', 'text', false, null],
  ['expires_at', 'timestamp with time zone', false, null],
  ['used_at', 'timestamp with time zone', true, null],
  ['consumed_via', 'text', true, null],
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

describe('A. schema shape: only hashes, no plaintext secret, no plain address, restrictive foreign keys', () => {
  it('adds exactly two tables to the identity schema (nine in total) and no sequence', async () => {
    const tables = await q<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity' AND table_type = 'BASE TABLE'",
    );
    expect(tables.map((r) => r.table_name).sort()).toEqual([
      'account_audit_events',
      'account_profiles',
      'account_roles',
      'account_status_history',
      'accounts',
      'email_contacts',
      'email_verification_challenges',
      'external_identities',
      'roles',
    ]);
    expect(
      (await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'S'")).length,
    ).toBe(1);
  });

  it('has exactly the documented columns, types, nullability and defaults on email_contacts', async () => {
    expect(await columnsOf('email_contacts')).toEqual(CONTACT_COLUMNS);
  });

  it('has exactly the documented columns, types, nullability and defaults on email_verification_challenges', async () => {
    expect(await columnsOf('email_verification_challenges')).toEqual(CHALLENGE_COLUMNS);
  });

  it('adds exactly one nullable uuid column (email_contact_id) to the audit trail and keeps the rest', async () => {
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
    ]);
  });

  it('stores no plaintext secret: the only code/token-like columns are the two HMAC hashes', async () => {
    const secretLike = /(code|token|passw|secret|otp|credential|salt|plain|raw|link|url|pin)/i;
    const offenders: string[] = [];
    for (const t of ['email_contacts', 'email_verification_challenges']) {
      for (const [name] of await columnsOf(t)) if (secretLike.test(name)) offenders.push(`${t}.${name}`);
    }
    expect(offenders.sort()).toEqual(['email_verification_challenges.code_hash', 'email_verification_challenges.magic_token_hash']);
  });

  it('keeps one address column only: email_normalized (no display, original, masked or plain email column anywhere in the email tables or the audit)', async () => {
    const addressLike = /(email|mail|address|display|original|masked)/i;
    const byTable: Record<string, string[]> = {};
    for (const t of ['email_contacts', 'email_verification_challenges', 'account_audit_events']) {
      byTable[t] = (await columnsOf(t)).map(([n]) => n).filter((n) => addressLike.test(n));
    }
    expect(byTable).toEqual({
      email_contacts: ['email_contact_id', 'email_normalized'],
      email_verification_challenges: ['email_contact_id'],
      account_audit_events: ['email_contact_id'],
    });
  });

  it('has no JSON, array or binary column in the email tables (every value is a typed scalar)', async () => {
    const types = new Set<string>();
    for (const t of ['email_contacts', 'email_verification_challenges']) for (const [, type] of await columnsOf(t)) types.add(type);
    expect([...types].sort()).toEqual(['boolean', 'integer', 'text', 'timestamp with time zone', 'uuid']);
  });

  it('has exactly the documented constraints on email_contacts (primary key, the (account, contact) key the audit foreign key targets)', async () => {
    const c = await constraintsOf(CONTACTS);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(
      [
        'c:ck_email_contacts__disabled',
        'c:ck_email_contacts__disabled_reason',
        'c:ck_email_contacts__email_normalized',
        'c:ck_email_contacts__idp_born_verified',
        'c:ck_email_contacts__primary_is_verified',
        'c:ck_email_contacts__source',
        'c:ck_email_contacts__status',
        'c:ck_email_contacts__verified_at',
        'f:fk_email_contacts__account_id',
        'p:pk_email_contacts',
        'u:uq_email_contacts__account_contact',
      ].sort(),
    );
  });

  it('has exactly the documented constraints on email_verification_challenges (primary key, unique token hash, restrictive foreign key)', async () => {
    const c = await constraintsOf(CHALLENGES);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(
      [
        'c:ck_email_verification_challenges__attempts',
        'c:ck_email_verification_challenges__closed_once',
        'c:ck_email_verification_challenges__code_hash',
        'c:ck_email_verification_challenges__consumed',
        'c:ck_email_verification_challenges__correlation',
        'c:ck_email_verification_challenges__delivery',
        'c:ck_email_verification_challenges__expiry',
        'c:ck_email_verification_challenges__invalidated',
        'c:ck_email_verification_challenges__magic_token_hash',
        'c:ck_email_verification_challenges__purpose',
        'f:fk_email_verification_challenges__email_contact_id',
        'p:pk_email_verification_challenges',
        'u:uq_email_verification_challenges__magic_token_hash',
      ].sort(),
    );
  });

  it('declares every foreign key of the email model ON DELETE RESTRICT, and no foreign key of the identity schema cascades', async () => {
    const mine = [
      ...(await constraintsOf(CONTACTS)),
      ...(await constraintsOf(CHALLENGES)),
      ...(await constraintsOf('identity.account_audit_events')).filter((r) => r.conname.includes('email_contact')),
    ].filter((r) => r.contype === 'f');
    expect(mine.map((r) => [r.conname, r.confdeltype, r.target])).toEqual(
      expect.arrayContaining([
        ['fk_email_contacts__account_id', 'r', 'identity.accounts'],
        ['fk_email_verification_challenges__email_contact_id', 'r', 'identity.email_contacts'],
        ['fk_account_audit_events__account_email_contact', 'r', 'identity.email_contacts'],
      ]),
    );
    expect(mine).toHaveLength(3);
    // the audit foreign key is COMPOSITE: an audit row can only name a contact of the audited account (the former single-column key is gone)
    const audit = await q<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fk_account_audit_events__account_email_contact'",
    );
    expect(audit[0]!.def).toBe(
      'FOREIGN KEY (account_id, email_contact_id) REFERENCES identity.email_contacts(account_id, email_contact_id) ON DELETE RESTRICT',
    );
    expect(await q("SELECT 1 FROM pg_constraint WHERE conname = 'fk_account_audit_events__email_contact_id'")).toEqual([]);
    const loose = await q(
      "SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'identity' AND c.contype = 'f' AND c.confdeltype <> 'r'",
    );
    expect(loose).toEqual([]);
  });

  it('brings the identity schema to 70 primary key, unique, foreign key and check constraints (44 from 0009 plus 26)', async () => {
    const { n } = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace WHERE s.nspname = 'identity' AND c.contype IN ('p', 'u', 'f', 'c')",
      )
    )[0]!;
    expect(n).toBe(70);
  });

  it('CHECKs both hash columns to 64 lowercase hex characters (catalog)', async () => {
    const defs = await q<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname IN ('ck_email_verification_challenges__code_hash', 'ck_email_verification_challenges__magic_token_hash')`,
      [CHALLENGES],
    );
    expect(defs).toHaveLength(2);
    for (const d of defs) expect(d.def, d.conname).toContain('^[0-9a-f]{64}$');
  });

  it('has exactly the documented indexes on email_contacts: four partial unique indexes with their predicates and the (account, contact) key', async () => {
    const idx = await indexesOf('email_contacts');
    expect(idx.map((r) => r.indexname)).toEqual([
      'pk_email_contacts',
      'uq_email_contacts__account_contact',
      'uq_email_contacts__live_address_per_account',
      'uq_email_contacts__open_per_account',
      'uq_email_contacts__primary_per_account',
      'uq_email_contacts__verified_address',
    ]);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.uq_email_contacts__account_contact).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id, email_contact_id\)$/);
    expect(def.uq_email_contacts__verified_address).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(email_normalized\) WHERE \(status = 'VERIFIED'::text\)$/);
    expect(def.uq_email_contacts__primary_per_account).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id\) WHERE is_primary$/);
    expect(def.uq_email_contacts__open_per_account).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(account_id\) WHERE \(status = ANY \(ARRAY\['PENDING'::text, 'REPLACEMENT_PENDING'::text\]\)\)$/,
    );
    expect(def.uq_email_contacts__live_address_per_account).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(account_id, email_normalized\) WHERE \(status <> 'DISABLED'::text\)$/,
    );
  });

  it('has exactly the documented indexes on email_verification_challenges: unique token hash, open-per-contact partial unique, contact history', async () => {
    const idx = await indexesOf('email_verification_challenges');
    expect(idx.map((r) => r.indexname)).toEqual([
      'idx_email_verification_challenges__contact_created',
      'pk_email_verification_challenges',
      'uq_email_verification_challenges__magic_token_hash',
      'uq_email_verification_challenges__open_per_contact',
    ]);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.uq_email_verification_challenges__open_per_contact).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(email_contact_id\) WHERE \(\(used_at IS NULL\) AND \(invalidated_at IS NULL\)\)$/,
    );
    expect(def.idx_email_verification_challenges__contact_created).toMatch(/^CREATE INDEX .* USING btree \(email_contact_id, created_at DESC\)$/);
    expect(def.uq_email_verification_challenges__magic_token_hash).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(magic_token_hash\)$/);
  });

  it('adds no index to the audit trail for the new column (the per-account index serves the timeline)', async () => {
    const idx = await indexesOf('account_audit_events');
    expect(idx.filter((r) => /email_contact_id/.test(r.indexdef))).toEqual([]);
  });

  it('wires the guards: a row guard BEFORE insert/update/delete on each table and the two deferred constraint triggers AFTER', async () => {
    const triggers = async (table: string) =>
      q<{ tgname: string; def: string }>(
        'SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"',
        [table],
      );
    const contacts = await triggers(CONTACTS);
    expect(contacts.map((t) => t.tgname)).toEqual(['trg_email_contacts__guard', 'trg_email_contacts__invariants']);
    expect(contacts[0]!.def).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON identity\.email_contacts FOR EACH ROW EXECUTE FUNCTION identity\.guard_email_contacts\(\)/,
    );
    expect(contacts[1]!.def).toMatch(
      /^CREATE CONSTRAINT TRIGGER .* AFTER INSERT OR UPDATE ON identity\.email_contacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/,
    );
    const challenges = await triggers(CHALLENGES);
    expect(challenges.map((t) => t.tgname)).toEqual(['trg_email_verification_challenges__consumption', 'trg_email_verification_challenges__guard']);
    expect(challenges[0]!.def).toMatch(
      /^CREATE CONSTRAINT TRIGGER .* AFTER UPDATE ON identity\.email_verification_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/,
    );
    expect(challenges[1]!.def).toMatch(/BEFORE INSERT OR DELETE OR UPDATE ON identity\.email_verification_challenges FOR EACH ROW/);
  });

  it('documents both tables and their sensitive columns in the catalog', async () => {
    expect(await commentOn(CONTACTS)).toMatch(/PERSONAL DATA/);
    expect(await commentOn(CHALLENGES)).toMatch(/HMAC-SHA-256/);
    for (const col of ['email_normalized', 'is_primary', 'source', 'verified_at', 'disabled_reason']) expect(await commentOn(CONTACTS, col), col).toBeTruthy();
    for (const col of ['purpose', 'code_hash', 'magic_token_hash', 'attempt_count', 'last_sent_at', 'invalidation_reason'])
      expect(await commentOn(CHALLENGES, col), col).toBeTruthy();
    expect(await commentOn('identity.account_audit_events', 'email_contact_id')).toMatch(/MASKED|never/);
  });

  it('starts empty: the migration seeds configuration and content only, never an address, a challenge or an audit row', async () => {
    const fresh = await createIsolatedDatabase();
    try {
      const c = new pg.Client({ connectionString: fresh.url });
      await c.connect();
      try {
        for (const t of ['identity.email_contacts', 'identity.email_verification_challenges', 'identity.account_audit_events'])
          expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
        expect((await c.query("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.email%'")).rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
    } finally {
      await fresh.drop();
    }
  });
});

// ====================================================================== B. email_contacts constraints
type Attempt = () => Promise<unknown>;
interface ConstraintCase {
  constraint: string;
  label: string;
  attempt: Attempt;
}
const bad = (constraint: string, label: string, attempt: Attempt): ConstraintCase => ({ constraint, label, attempt });

const BAD_ADDRESSES: [label: string, value: string][] = [
  ['upper-case letters in the local part', 'Ana@example.test'],
  ['upper-case letters in the domain', 'ana@Example.test'],
  ['a space inside the local part', 'a na@example.test'],
  ['a leading space', ' ana@example.test'],
  ['a trailing space', 'ana@example.test '],
  ['a trailing line feed', `ana@example.test${ch(0x0a)}`],
  ['a tab', `a${ch(0x09)}na@example.test`],
  ['no @', 'ana.example.test'],
  ['two @', 'a@b@example.test'],
  ['an empty local part', '@example.test'],
  ['an empty domain', 'ana@'],
  ['an empty string', ''],
  ['a domain of two characters', 'a@bc'],
  ['a 65-character local part', `${'a'.repeat(65)}@example.test`],
  ['255 characters in total', `${'a'.repeat(64)}@${'b'.repeat(190)}`],
  ['a non-ASCII local part', `an${ch(0xe9)}@example.test`],
  ['a non-ASCII domain', `ana@ex${ch(0xe4)}mple.test`],
  ['a full-width letter', `${ch(0xff41)}na@example.test`],
  ['an emoji', `ana${ch(0x1f600)}@example.test`],
  ['a bidi override', `ana${ch(0x202e)}@example.test`],
  ['a control character', `an${ch(0x01)}a@example.test`],
  ['a quoted local part', '"ana"@example.test'],
  ['an angle-bracket (display name) form', '<ana@example.test>'],
  ['an underscore in the domain', 'ana@exa_mple.test'],
  ['a comma', 'a,b@example.test'],
  ['a semicolon', 'a;b@example.test'],
  ['a parenthesis', 'a(b)@example.test'],
  ['a backslash', `a${ch(0x5c)}na@example.test`],
  ['a double quote', 'a"na@example.test'],
];
const GOOD_ADDRESSES: [label: string, value: string][] = [
  ['the shortest shape', 'a@b.c'],
  ['a 64-character local part', `${'a'.repeat(64)}@example.test`],
  ['exactly 254 characters', `${'a'.repeat(64)}@${'b'.repeat(189)}`],
  ['an apostrophe and a plus tag', "o'brien+tag@example.test"],
  ['every allowed special character', "!#$%&'*+/=?^_`{|}~.-@example.test"],
  ['digits only', '0123456789@123.456'],
  ['a hyphenated sub-domain', 'first.last@sub-domain.example.test'],
  ['an IDNA (punycode) domain', 'xn--bcher-kva@xn--bcher-kva.example'],
];

const CONTACT_CASES: ConstraintCase[] = [
  bad('pk_email_contacts', 'a duplicate email_contact_id', async () => {
    const c = await freshPending();
    await insertContact(await makeAccount(), { id: c.id });
  }),
  bad(
    'uq_email_contacts__account_contact',
    'a second row with the same (account_id, email_contact_id) (primary key dropped and guards off for this transaction)',
    async () => {
      const c = await freshPending();
      await isolated(
        [...noTriggers(CONTACTS), 'ALTER TABLE identity.email_contacts DROP CONSTRAINT pk_email_contacts CASCADE'],
        `INSERT INTO identity.email_contacts (email_contact_id, account_id, email_normalized, status, source, disabled_at, disabled_reason)
       VALUES ($1, $2, $3, 'DISABLED', 'USER_ENTERED', now(), 'SUPERSEDED')`,
        [c.id, c.accountId, addr()],
      );
    },
  ),
  bad('fk_email_contacts__account_id', 'an account that does not exist', () => insertContact(randomUUID())),
  bad('ck_email_contacts__status', 'an unknown status', async () => insertContact(await makeAccount(), { status: 'BOGUS' })),
  bad('ck_email_contacts__status', 'a lower-case status', async () => insertContact(await makeAccount(), { status: 'pending' })),
  bad('ck_email_contacts__status', 'an empty status', async () => insertContact(await makeAccount(), { status: '' })),
  bad('ck_email_contacts__source', 'an unknown source', async () => insertContact(await makeAccount(), { source: 'ADMIN' })),
  bad('ck_email_contacts__source', 'a lower-case source', async () => insertContact(await makeAccount(), { source: 'user_entered' })),
  ...BAD_ADDRESSES.map(([label, value]) =>
    bad('ck_email_contacts__email_normalized', `an address with ${label}`, async () => insertContact(await makeAccount(), { email: value })),
  ),
  bad(
    'ck_email_contacts__email_normalized',
    'an update to a malformed address (the guard reports a changed address first, so the guard is bypassed)',
    async () => {
      const c = await freshPending();
      await isolated(noTriggers(CONTACTS), "UPDATE identity.email_contacts SET email_normalized = 'Not An Address' WHERE email_contact_id = $1", [c.id]);
    },
  ),
  bad('ck_email_contacts__primary_is_verified', 'a PENDING row flagged primary (insert)', async () => insertContact(await makeAccount(), { primary: true })),
  bad('ck_email_contacts__primary_is_verified', 'a DISABLED row that is still flagged primary', async () => {
    const { primary } = await accountWithReplacement();
    await run("UPDATE identity.email_contacts SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'REPLACED' WHERE email_contact_id = $1", [
      primary.id,
    ]);
  }),
  bad('ck_email_contacts__verified_at', 'a PENDING row with verified_at (insert)', async () => insertContact(await makeAccount(), { verified: true })),
  bad('ck_email_contacts__verified_at', 'a REPLACEMENT_PENDING row with verified_at (insert)', async () => {
    const { accountId } = await accountWithPrimary();
    await insertContact(accountId, { status: 'REPLACEMENT_PENDING', verified: true });
  }),
  bad('ck_email_contacts__verified_at', 'the transition to VERIFIED without verified_at', async () => {
    const c = await freshPending();
    await run("UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true WHERE email_contact_id = $1", [c.id]);
  }),
  bad('ck_email_contacts__verified_at', 'verified_at set on a row that stays PENDING', async () => {
    const c = await freshPending();
    await run('UPDATE identity.email_contacts SET verified_at = now() WHERE email_contact_id = $1', [c.id]);
  }),
  bad('ck_email_contacts__idp_born_verified', 'an IDP_VERIFIED row without verified_at (insert as PENDING)', async () =>
    insertContact(await makeAccount(), { source: 'IDP_VERIFIED' }),
  ),
  bad('ck_email_contacts__disabled', 'DISABLED without disabled_at', async () => {
    const c = await freshPending();
    await run("UPDATE identity.email_contacts SET status = 'DISABLED', disabled_reason = 'SUPERSEDED' WHERE email_contact_id = $1", [c.id]);
  }),
  bad('ck_email_contacts__disabled', 'DISABLED without disabled_reason (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(noTriggers(CONTACTS), "UPDATE identity.email_contacts SET status = 'DISABLED', disabled_at = now() WHERE email_contact_id = $1", [c.id]);
  }),
  bad('ck_email_contacts__disabled', 'disabled_at on a live row', async () => {
    const c = await freshPending();
    await run('UPDATE identity.email_contacts SET disabled_at = now() WHERE email_contact_id = $1', [c.id]);
  }),
  bad('ck_email_contacts__disabled', 'disabled_reason on a live row', async () => {
    const c = await freshPending();
    await run("UPDATE identity.email_contacts SET disabled_reason = 'SUPERSEDED' WHERE email_contact_id = $1", [c.id]);
  }),
  bad('ck_email_contacts__disabled_reason', 'a reason outside REPLACED and SUPERSEDED (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(
      noTriggers(CONTACTS),
      "UPDATE identity.email_contacts SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'BOGUS' WHERE email_contact_id = $1",
      [c.id],
    );
  }),
  bad('ck_email_contacts__disabled_reason', 'an empty reason (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(
      noTriggers(CONTACTS),
      "UPDATE identity.email_contacts SET status = 'DISABLED', disabled_at = now(), disabled_reason = '' WHERE email_contact_id = $1",
      [c.id],
    );
  }),
];

describe('B. email_contacts constraints reject bad data, by constraint name', () => {
  it.each(CONTACT_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it.each(GOOD_ADDRESSES)('accepts %s', async (_label, value) => {
    const c = await insertContact(await makeAccount(), { email: value });
    expect((await contactState(c.id)).status).toBe('PENDING');
    expect(await q('SELECT email_normalized FROM identity.email_contacts WHERE email_contact_id = $1', [c.id])).toEqual([{ email_normalized: value }]);
  });

  it('defaults a new row to PENDING-compatible values (not primary, no verified_at, no disabled_at, timestamps set by the database)', async () => {
    const a = await makeAccount();
    const r = await q(
      `INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED')
       RETURNING is_primary, verified_at, disabled_at, disabled_reason, created_at IS NOT NULL AS created, updated_at IS NOT NULL AS updated`,
      [a, addr()],
    );
    expect(r).toEqual([{ is_primary: false, verified_at: null, disabled_at: null, disabled_reason: null, created: true, updated: true }]);
  });

  it('accepts a born-verified IDP row and a verified primary that carries verified_at', async () => {
    const c = await insertIdpPrimary(await makeAccount());
    expect(await contactState(c.id)).toEqual({ status: 'VERIFIED', is_primary: true, verified: true, disabled_reason: null });
  });
});

// ====================================================================== C. uniqueness policy
describe('C. uniqueness policy: pending duplicates are allowed, a verified address belongs to one account', () => {
  it('lets two accounts hold the SAME address as PENDING (a pending claim proves nothing)', async () => {
    const email = addr('same');
    const a = await insertContact(await makeAccount(), { email });
    const b = await insertContact(await makeAccount(), { email });
    expect(a.id).not.toBe(b.id);
    expect(await count(CONTACTS, "email_normalized = $1 AND status = 'PENDING'", [email])).toBe(2);
  });

  it('refuses the second account to become VERIFIED on an address another account already verified (uq_email_contacts__verified_address)', async () => {
    const email = addr('race');
    const first = await insertContact(await makeAccount(), { email });
    const second = await insertContact(await makeAccount(), { email });
    await verifyOn(pool, first.id);
    await expectUnique(verifyOn(pool, second.id), 'uq_email_contacts__verified_address');
    expect((await contactState(first.id)).status).toBe('VERIFIED');
    expect(await contactState(second.id)).toMatchObject({ status: 'PENDING', is_primary: false, verified: false });
  });

  it('still lets another account hold the address as PENDING after it is verified elsewhere (the owner is not revealed or blocked)', async () => {
    const email = addr('later');
    const first = await insertContact(await makeAccount(), { email });
    await verifyOn(pool, first.id);
    const second = await insertContact(await makeAccount(), { email });
    expect((await contactState(second.id)).status).toBe('PENDING');
  });

  it('refuses an IDP-verified address another account already verified (uq_email_contacts__verified_address)', async () => {
    const email = addr('idp');
    await insertIdpPrimary(await makeAccount(), email);
    await expectUnique(insertIdpPrimary(await makeAccount(), email), 'uq_email_contacts__verified_address');
  });

  it('allows one primary per account: a second primary in the same account is refused (uq_email_contacts__primary_per_account)', async () => {
    const { candidate } = await accountWithReplacement();
    // the old primary is still primary: verifying the replacement without replacing it first collides
    await expectUnique(verifyOn(pool, candidate.id), 'uq_email_contacts__primary_per_account');
    expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
  });

  it('allows one open candidate per account: a second PENDING address in the same account is refused (uq_email_contacts__open_per_account)', async () => {
    const a = await makeAccount();
    await insertContact(a);
    await expectUnique(insertContact(a), 'uq_email_contacts__open_per_account');
    expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(1);
  });

  it('allows one open candidate per account: a second REPLACEMENT_PENDING address is refused too', async () => {
    const { accountId } = await accountWithReplacement();
    await expectUnique(insertContact(accountId, { status: 'REPLACEMENT_PENDING' }), 'uq_email_contacts__open_per_account');
  });

  it('refuses the same live address twice in one account, verified and replacement-pending (uq_email_contacts__live_address_per_account)', async () => {
    const { accountId, primary } = await accountWithPrimary();
    await expectUnique(insertContact(accountId, { email: primary.email, status: 'REPLACEMENT_PENDING' }), 'uq_email_contacts__live_address_per_account');
  });

  it('allows the same address again in one account once the first row is DISABLED (superseded history is kept)', async () => {
    const a = await makeAccount();
    const email = addr('again');
    const first = await insertContact(a, { email });
    await disableOn(pool, first.id, 'SUPERSEDED');
    const second = await insertContact(a, { email });
    expect(await count(CONTACTS, 'account_id = $1 AND email_normalized = $2', [a, email])).toBe(2);
    expect(await contactState(first.id)).toMatchObject({ status: 'DISABLED', disabled_reason: 'SUPERSEDED' });
    expect((await contactState(second.id)).status).toBe('PENDING');
  });

  it('releases a verified address for another account when its holder replaces it (DISABLED rows are outside the verified index)', async () => {
    const { accountId, primary, candidate } = await accountWithReplacement();
    await inTx(async (c) => {
      await disableOn(c, primary.id, 'REPLACED');
      await verifyOn(c, candidate.id);
    });
    const other = await makeAccount();
    const taken = await insertContact(other, { email: primary.email });
    await verifyOn(pool, taken.id);
    expect(await contactState(taken.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect(await contactState(primary.id)).toMatchObject({ status: 'DISABLED', disabled_reason: 'REPLACED', is_primary: false });
    expect(await primariesOf(accountId)).toBe(1);
  });

  it('lets the former address come back as a replacement of the same account (the replaced row is DISABLED, so the live-address index is free)', async () => {
    const { accountId, primary, candidate } = await accountWithReplacement();
    await inTx(async (c) => {
      await disableOn(c, primary.id, 'REPLACED');
      await verifyOn(c, candidate.id);
    });
    const back = await insertContact(accountId, { email: primary.email, status: 'REPLACEMENT_PENDING' });
    expect((await contactState(back.id)).status).toBe('REPLACEMENT_PENDING');
  });

  it('treats the address verbatim: only the canonical lower-case form is stored, so a case variant cannot exist (the CHECK refuses it)', async () => {
    const email = addr('case');
    await insertContact(await makeAccount(), { email });
    expect(await constraintOf(insertContact(await makeAccount(), { email: email.toUpperCase() }))).toBe('ck_email_contacts__email_normalized');
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
    await expectRule(run('DELETE FROM identity.email_contacts WHERE email_contact_id = $1', [c.id]), 'NOT_DELETABLE');
    expect(await count(CONTACTS, 'email_contact_id = $1', [c.id])).toBe(1);
  });

  it('refuses a bulk delete across all contacts too', async () => {
    await freshPending();
    await expectRule(run('DELETE FROM identity.email_contacts'), 'NOT_DELETABLE');
  });

  it.each(['account_id', 'email_normalized', 'source', 'created_at', 'email_contact_id'])('keeps %s immutable (IMMUTABLE_IDENTITY)', async (column) => {
    const c = await freshPending();
    const values: Record<string, unknown> = {
      account_id: await makeAccount(),
      email_normalized: addr('changed'),
      source: 'IDP_VERIFIED',
      created_at: new Date(0),
      email_contact_id: randomUUID(),
    };
    await expectRule(run(`UPDATE identity.email_contacts SET ${column} = $2 WHERE email_contact_id = $1`, [c.id, values[column]]), 'IMMUTABLE_IDENTITY');
  });

  it('keeps the address immutable even when the new value is also a valid address, and when it changes together with a legal transition', async () => {
    const c = await freshPending();
    await expectRule(
      run("UPDATE identity.email_contacts SET email_normalized = $2, status = 'VERIFIED', is_primary = true, verified_at = now() WHERE email_contact_id = $1", [
        c.id,
        addr('swap'),
      ]),
      'IMMUTABLE_IDENTITY',
    );
    expect((await contactState(c.id)).status).toBe('PENDING');
  });

  it('sets verified_at once: it cannot be moved, cleared or re-set on a verified contact, nor on a replaced one (IMMUTABLE_IDENTITY)', async () => {
    const { primary, candidate } = await accountWithReplacement();
    await expectRule(
      run("UPDATE identity.email_contacts SET verified_at = verified_at + interval '1 second' WHERE email_contact_id = $1", [primary.id]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(run('UPDATE identity.email_contacts SET verified_at = NULL WHERE email_contact_id = $1', [primary.id]), 'IMMUTABLE_IDENTITY');
    await inTx(async (c) => {
      await disableOn(c, primary.id, 'REPLACED');
      await verifyOn(c, candidate.id);
    });
    await expectRule(
      run("UPDATE identity.email_contacts SET verified_at = now() + interval '1 day' WHERE email_contact_id = $1", [primary.id]),
      'IMMUTABLE_IDENTITY',
    );
    expect((await contactState(primary.id)).verified).toBe(true);
  });

  it('keeps verified_at when the row is later replaced (the proof of ownership stays in the history)', async () => {
    const { primary, candidate } = await accountWithReplacement();
    const before = (await q<{ v: Date }>('SELECT verified_at AS v FROM identity.email_contacts WHERE email_contact_id = $1', [primary.id]))[0]!.v;
    await inTx(async (c) => {
      await disableOn(c, primary.id, 'REPLACED');
      await verifyOn(c, candidate.id);
    });
    const after = (await q<{ v: Date }>('SELECT verified_at AS v FROM identity.email_contacts WHERE email_contact_id = $1', [primary.id]))[0]!.v;
    expect(after.getTime()).toBe(before.getTime());
  });

  it('lets updated_at change on a live contact', async () => {
    const c = await freshPending();
    await run("UPDATE identity.email_contacts SET updated_at = now() + interval '1 minute' WHERE email_contact_id = $1", [c.id]);
  });

  describe('a DISABLED contact never changes again', () => {
    const replacedRow = async (): Promise<Contact> => {
      const { primary, candidate } = await accountWithReplacement();
      await inTx(async (c) => {
        await disableOn(c, primary.id, 'REPLACED');
        await verifyOn(c, candidate.id);
      });
      return primary;
    };
    const snapshot = async (id: string) =>
      (
        await q(
          'SELECT status, is_primary, verified_at, disabled_at, disabled_reason, updated_at, created_at FROM identity.email_contacts WHERE email_contact_id = $1',
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
        for (const set of sets) await expectRule(run(`UPDATE identity.email_contacts SET ${set} WHERE email_contact_id = $1`, [c.id]), 'IMMUTABLE_IDENTITY');
        expect(await snapshot(c.id)).toEqual(before);
      },
    );

    it('refuses a bulk UPDATE that reaches a DISABLED row, whatever the other rows are (IMMUTABLE_IDENTITY)', async () => {
      await contactIn('DISABLED');
      await expectRule(run("UPDATE identity.email_contacts SET updated_at = now() WHERE status = 'DISABLED'"), 'IMMUTABLE_IDENTITY');
    });

    it('keeps the other contacts of the account changeable (only the disabled row is frozen)', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await inTx(async (c) => {
        await disableOn(c, primary.id, 'REPLACED');
        await verifyOn(c, candidate.id);
      });
      await run("UPDATE identity.email_contacts SET updated_at = now() + interval '1 minute' WHERE email_contact_id = $1", [candidate.id]);
      await expectRule(run('UPDATE identity.email_contacts SET updated_at = now() WHERE email_contact_id = $1', [primary.id]), 'IMMUTABLE_IDENTITY');
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('still lets a PENDING or REPLACEMENT_PENDING contact be disabled exactly once (the disabling itself is the last change)', async () => {
      const c = await freshPending();
      await disableOn(pool, c.id, 'SUPERSEDED');
      await expectRule(disableOn(pool, c.id, 'SUPERSEDED'), 'IMMUTABLE_IDENTITY');
    });

    it('still lets a DISABLED row be read and joined (history stays queryable)', async () => {
      const c = await contactIn('DISABLED');
      expect(await q('SELECT status, disabled_reason FROM identity.email_contacts WHERE email_contact_id = $1', [c.id])).toEqual([
        { status: 'DISABLED', disabled_reason: 'SUPERSEDED' },
      ]);
    });
  });

  describe('closed accounts verify nothing and receive no challenge (ACCOUNT_CLOSED)', () => {
    const closeAccount = async (accountId: string): Promise<void> => {
      await setStatus(accountId, 'SUSPENDED');
      await setStatus(accountId, 'CLOSED');
    };
    it('refuses PENDING -> VERIFIED on a contact of a CLOSED account and leaves it PENDING', async () => {
      const c = await freshPending();
      await closeAccount(c.accountId);
      await expectRule(verifyOn(pool, c.id), 'ACCOUNT_CLOSED');
      expect(await contactState(c.id)).toMatchObject({ status: 'PENDING', is_primary: false, verified: false });
    });

    it('refuses the verification of a replacement on a CLOSED account, and the whole replacement rolls back with it', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await closeAccount(accountId);
      await expectRule(
        inTx(async (c) => {
          await disableOn(c, primary.id, 'REPLACED');
          await verifyOn(c, candidate.id);
        }),
        'ACCOUNT_CLOSED',
      );
      expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect((await contactState(candidate.id)).status).toBe('REPLACEMENT_PENDING');
    });

    it('reports a verification without is_primary as EMAIL_PRIMARY_CHANGE even on a CLOSED account (the primary rule is checked first)', async () => {
      const c = await freshPending();
      await closeAccount(c.accountId);
      await expectRule(
        run("UPDATE identity.email_contacts SET status = 'VERIFIED', verified_at = now() WHERE email_contact_id = $1", [c.id]),
        'EMAIL_PRIMARY_CHANGE',
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
        expect(await count(CHALLENGES, 'email_contact_id = $1', [c.id])).toBe(0);
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

    it('reports the closed account before the open-contact and purpose rules, and still reports a missing contact as CHALLENGE_NOT_OPEN', async () => {
      const c = await freshPending();
      await closeAccount(c.accountId);
      await expectRule(insertChallengeRow(c.id, { purpose: 'CHANGE_EMAIL', attempt_count: 3 }), 'ACCOUNT_CLOSED');
      await expectRule(insertChallengeRow(randomUUID()), 'CHALLENGE_NOT_OPEN');
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
      expect(await count(CHALLENGES, 'email_contact_id = $1', [c.id])).toBe(0);
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
      ['PENDING', 'REPLACEMENT_PENDING', 'EMAIL_STATUS_TRANSITION'],
      ['REPLACEMENT_PENDING', 'PENDING', 'EMAIL_STATUS_TRANSITION'],
      ['VERIFIED', 'PENDING', 'EMAIL_STATUS_TRANSITION'],
      ['VERIFIED', 'REPLACEMENT_PENDING', 'EMAIL_STATUS_TRANSITION'],
      ['DISABLED', 'VERIFIED', 'IMMUTABLE_IDENTITY'],
      ['DISABLED', 'PENDING', 'IMMUTABLE_IDENTITY'],
      ['DISABLED', 'REPLACEMENT_PENDING', 'IMMUTABLE_IDENTITY'],
    ];
    it.each(ILLEGAL)('refuses %s -> %s (%s) and leaves the row untouched', async (from, to, rule) => {
      const c = await contactIn(from);
      const before = await contactState(c.id);
      await expectRule(run('UPDATE identity.email_contacts SET status = $2 WHERE email_contact_id = $1', [c.id, to]), rule);
      expect(await contactState(c.id)).toEqual(before);
    });

    it('partitions the twelve ordered status pairs: five legal (verify or disable), seven illegal', () => {
      const all: ContactStatus[] = ['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED'];
      const pairs = all.flatMap((f) => all.filter((t) => t !== f).map((t) => `${f}>${t}`));
      const legal = ['PENDING>VERIFIED', 'PENDING>DISABLED', 'REPLACEMENT_PENDING>VERIFIED', 'REPLACEMENT_PENDING>DISABLED', 'VERIFIED>DISABLED'];
      expect(pairs).toHaveLength(12);
      expect([...legal, ...ILLEGAL.map(([f, t]) => `${f}>${t}`)].sort()).toEqual(pairs.sort());
    });

    it('refuses PENDING or REPLACEMENT_PENDING -> VERIFIED without is_primary in the same UPDATE (EMAIL_PRIMARY_CHANGE), with or without verified_at', async () => {
      for (const status of ['PENDING', 'REPLACEMENT_PENDING'] as const) {
        const c = await contactIn(status);
        await expectRule(
          run("UPDATE identity.email_contacts SET status = 'VERIFIED', verified_at = now() WHERE email_contact_id = $1", [c.id]),
          'EMAIL_PRIMARY_CHANGE',
        );
        await expectRule(run("UPDATE identity.email_contacts SET status = 'VERIFIED' WHERE email_contact_id = $1", [c.id]), 'EMAIL_PRIMARY_CHANGE');
        await expectRule(
          run("UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = false, verified_at = now() WHERE email_contact_id = $1", [c.id]),
          'EMAIL_PRIMARY_CHANGE',
        );
        expect(await contactState(c.id)).toMatchObject({ status, is_primary: false, verified: false });
      }
    });

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
      await inTx(async (c) => {
        await disableOn(c, primary.id, 'REPLACED');
        await verifyOn(c, candidate.id);
      });
      expect(await contactState(candidate.id)).toMatchObject({ status: 'VERIFIED', is_primary: true, verified: true });
      expect(await contactState(primary.id)).toMatchObject({ status: 'DISABLED', is_primary: false, disabled_reason: 'REPLACED' });
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('lets the guard accept VERIFIED -> DISABLED REPLACED while a REPLACEMENT_PENDING exists in the same account (the statement passes; only the COMMIT check can still refuse it)', async () => {
      const { primary } = await accountWithReplacement();
      await isolated(
        [],
        "UPDATE identity.email_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'REPLACED' WHERE email_contact_id = $1",
        [primary.id],
      );
      expect((await contactState(primary.id)).status).toBe('VERIFIED');
    });

    it('refuses VERIFIED -> DISABLED REPLACED without a replacement in the account (EMAIL_PRIMARY_NOT_REPLACEABLE)', async () => {
      const { accountId, primary } = await accountWithPrimary();
      await expectRule(disableOn(pool, primary.id, 'REPLACED'), 'EMAIL_PRIMARY_NOT_REPLACEABLE');
      expect(await contactState(primary.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('refuses to replace a primary when the only replacement belongs to ANOTHER account (EMAIL_PRIMARY_NOT_REPLACEABLE)', async () => {
      const { primary } = await accountWithPrimary();
      await accountWithReplacement();
      await expectRule(disableOn(pool, primary.id, 'REPLACED'), 'EMAIL_PRIMARY_NOT_REPLACEABLE');
    });

    it('refuses to replace a primary whose replacement was already withdrawn (EMAIL_PRIMARY_NOT_REPLACEABLE)', async () => {
      const { primary, candidate } = await accountWithReplacement();
      await disableOn(pool, candidate.id, 'SUPERSEDED');
      await expectRule(disableOn(pool, primary.id, 'REPLACED'), 'EMAIL_PRIMARY_NOT_REPLACEABLE');
    });

    it('refuses to disable a verified address with SUPERSEDED or without a reason (EMAIL_STATUS_TRANSITION)', async () => {
      const { primary } = await accountWithReplacement();
      await expectRule(disableOn(pool, primary.id, 'SUPERSEDED'), 'EMAIL_STATUS_TRANSITION');
      await expectRule(
        run("UPDATE identity.email_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now() WHERE email_contact_id = $1", [primary.id]),
        'EMAIL_STATUS_TRANSITION',
      );
    });

    it('refuses to disable a pending or replacement address with REPLACED or without a reason (EMAIL_STATUS_TRANSITION)', async () => {
      const pending = await freshPending();
      await expectRule(disableOn(pool, pending.id, 'REPLACED'), 'EMAIL_STATUS_TRANSITION');
      const { candidate } = await accountWithReplacement();
      await expectRule(disableOn(pool, candidate.id, 'REPLACED'), 'EMAIL_STATUS_TRANSITION');
      await expectRule(
        run("UPDATE identity.email_contacts SET status = 'DISABLED', disabled_at = now() WHERE email_contact_id = $1", [candidate.id]),
        'EMAIL_STATUS_TRANSITION',
      );
    });
  });

  describe('primary changes', () => {
    it('refuses to create a verified (IDP_VERIFIED) row without the primary flag, so a verified non-primary row cannot exist (EMAIL_PRIMARY_CHANGE)', async () => {
      const account = await makeAccount();
      await expectRule(insertContact(account, { status: 'VERIFIED', source: 'IDP_VERIFIED', verified: true, primary: false }), 'EMAIL_PRIMARY_CHANGE');
      expect(await q('SELECT 1 FROM identity.email_contacts WHERE account_id = $1', [account])).toEqual([]);
      const ok = await insertContact(account, { status: 'VERIFIED', source: 'IDP_VERIFIED', verified: true, primary: true });
      expect(await contactState(ok.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    });

    it('refuses to flag a PENDING or REPLACEMENT_PENDING row primary (EMAIL_PRIMARY_CHANGE reports before the CHECK)', async () => {
      const pending = await freshPending();
      await expectRule(run('UPDATE identity.email_contacts SET is_primary = true WHERE email_contact_id = $1', [pending.id]), 'EMAIL_PRIMARY_CHANGE');
      const { candidate } = await accountWithReplacement();
      await expectRule(run('UPDATE identity.email_contacts SET is_primary = true WHERE email_contact_id = $1', [candidate.id]), 'EMAIL_PRIMARY_CHANGE');
    });

    it('refuses to clear the primary flag of a verified address that stays verified (EMAIL_PRIMARY_CHANGE)', async () => {
      const { primary } = await accountWithPrimary();
      await expectRule(run('UPDATE identity.email_contacts SET is_primary = false WHERE email_contact_id = $1', [primary.id]), 'EMAIL_PRIMARY_CHANGE');
      expect((await contactState(primary.id)).is_primary).toBe(true);
    });

    it('refuses a DISABLED row to become primary again or to leave DISABLED (IMMUTABLE_IDENTITY: a disabled contact never changes again)', async () => {
      const c = await contactIn('DISABLED');
      await expectRule(run('UPDATE identity.email_contacts SET is_primary = true WHERE email_contact_id = $1', [c.id]), 'IMMUTABLE_IDENTITY');
      await expectRule(
        run("UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE email_contact_id = $1", [c.id]),
        'IMMUTABLE_IDENTITY',
      );
    });

    it('allows the primary flag to flip exactly on the transition to VERIFIED and on the transition to DISABLED', async () => {
      const { accountId, primary, candidate } = await accountWithReplacement();
      await inTx(async (c) => {
        await disableOn(c, primary.id, 'REPLACED'); // true -> false together with DISABLED
        await verifyOn(c, candidate.id); // false -> true together with VERIFIED
      });
      expect(await primariesOf(accountId)).toBe(1);
      expect((await contactState(candidate.id)).is_primary).toBe(true);
    });
  });

  describe('insert rules', () => {
    it('refuses a PENDING address while the account has a verified primary (EMAIL_INITIAL_WITH_PRIMARY)', async () => {
      const { accountId } = await accountWithPrimary();
      await expectRule(insertContact(accountId), 'EMAIL_INITIAL_WITH_PRIMARY');
      expect(await count(CONTACTS, 'account_id = $1', [accountId])).toBe(1);
    });

    it('refuses a REPLACEMENT_PENDING address without a primary to replace (EMAIL_REPLACEMENT_WITHOUT_PRIMARY)', async () => {
      const a = await makeAccount();
      await expectRule(insertContact(a, { status: 'REPLACEMENT_PENDING' }), 'EMAIL_REPLACEMENT_WITHOUT_PRIMARY');
      await insertContact(a); // an initial address is what the account needs first
      await expectRule(insertContact(await makeAccount(), { status: 'REPLACEMENT_PENDING' }), 'EMAIL_REPLACEMENT_WITHOUT_PRIMARY');
    });

    it('refuses a REPLACEMENT_PENDING address while the primary is already replaced inside the transaction (EMAIL_REPLACEMENT_WITHOUT_PRIMARY)', async () => {
      const { primary, candidate, accountId } = await accountWithReplacement();
      await expectRule(
        isolated(
          [
            `UPDATE identity.email_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'REPLACED' WHERE email_contact_id = '${primary.id}'`,
            `UPDATE identity.email_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'SUPERSEDED' WHERE email_contact_id = '${candidate.id}'`,
          ],
          "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'REPLACEMENT_PENDING', 'USER_ENTERED')",
          [accountId, addr()],
        ),
        'EMAIL_REPLACEMENT_WITHOUT_PRIMARY',
      );
      expect(await primariesOf(accountId)).toBe(1);
    });

    it('refuses a contact created DISABLED, whatever its reason (EMAIL_STATUS_TRANSITION)', async () => {
      const a = await makeAccount();
      for (const reason of ['REPLACED', 'SUPERSEDED'])
        await expectRule(insertContact(a, { status: 'DISABLED', disabledAt: true, disabledReason: reason }), 'EMAIL_STATUS_TRANSITION');
      expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(0);
    });

    it('refuses a contact created VERIFIED from user input (EMAIL_STATUS_TRANSITION): only a trusted identity provider reports an address verified', async () => {
      const a = await makeAccount();
      await expectRule(insertContact(a, { status: 'VERIFIED', primary: true, verified: true, source: 'USER_ENTERED' }), 'EMAIL_STATUS_TRANSITION');
      await expectRule(insertContact(a, { status: 'VERIFIED', verified: true, source: 'USER_ENTERED' }), 'EMAIL_STATUS_TRANSITION');
    });

    it('creates a VERIFIED IDP_VERIFIED primary when the account has no primary', async () => {
      const c = await insertIdpPrimary(await makeAccount());
      expect(await contactState(c.id)).toMatchObject({ status: 'VERIFIED', is_primary: true, verified: true });
    });

    it('refuses a second VERIFIED IDP_VERIFIED address when the account already has a primary (EMAIL_INITIAL_WITH_PRIMARY)', async () => {
      const { accountId } = await accountWithPrimary();
      await expectRule(insertIdpPrimary(accountId), 'EMAIL_INITIAL_WITH_PRIMARY');
      await expectRule(insertContact(accountId, { status: 'VERIFIED', source: 'IDP_VERIFIED', verified: true }), 'EMAIL_INITIAL_WITH_PRIMARY');
    });

    it.each(['PENDING', 'REPLACEMENT_PENDING', 'VERIFIED'])('refuses a %s contact for a CLOSED account (ACCOUNT_CLOSED)', async (status) => {
      const closed = await accountIn('CLOSED');
      const o: ContactInput = status === 'VERIFIED' ? { status, source: 'IDP_VERIFIED', verified: true, primary: true } : { status };
      await expectRule(insertContact(closed, o), 'ACCOUNT_CLOSED');
      expect(await count(CONTACTS, 'account_id = $1', [closed])).toBe(0);
    });

    it('reports a closed account before any other insert rule (a DISABLED insert into a CLOSED account is ACCOUNT_CLOSED)', async () => {
      await expectRule(insertContact(await accountIn('CLOSED'), { status: 'DISABLED', disabledAt: true, disabledReason: 'SUPERSEDED' }), 'ACCOUNT_CLOSED');
    });

    it.each<AccountStatus>(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'])('accepts a contact for a %s account', async (status) => {
      const a = await accountIn(status);
      const c = await insertContact(a);
      expect((await contactState(c.id)).status).toBe('PENDING');
    });

    it('keeps the contacts of an account that is closed later readable (closing does not touch them)', async () => {
      const a = await makeAccount();
      const c = await insertContact(a);
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      expect((await contactState(c.id)).status).toBe('PENDING');
    });
  });
});

// ====================================================================== E. deferred invariants at COMMIT
describe('E. whole-account invariants are checked at COMMIT (EMAIL_INVARIANT, CHALLENGE_CONSUMPTION)', () => {
  it('commits a replacement performed in the right order: disable the old primary, verify the new one, consume the challenge', async () => {
    const { accountId, primary, candidate, challengeId } = await freshReplacementOpen();
    await inTx(async (c) => {
      await disableOn(c, primary.id, 'REPLACED');
      await verifyOn(c, candidate.id);
      await consumeOn(c, challengeId, 'CODE');
    });
    expect(await primariesOf(accountId)).toBe(1);
    expect(await contactState(primary.id)).toMatchObject({ status: 'DISABLED', is_primary: false, disabled_reason: 'REPLACED' });
    expect(await contactState(candidate.id)).toMatchObject({ status: 'VERIFIED', is_primary: true, verified: true });
    expect(await challengeState(challengeId)).toMatchObject({ used: true, consumed_via: 'CODE', invalidated: false });
  });

  it('commits the same replacement with a link confirmation (consumed_via LINK)', async () => {
    const { primary, candidate, challengeId } = await freshReplacementOpen();
    await inTx(async (c) => {
      await disableOn(c, primary.id, 'REPLACED');
      await verifyOn(c, candidate.id);
      await consumeOn(c, challengeId, 'LINK');
    });
    expect(await challengeState(challengeId)).toMatchObject({ used: true, consumed_via: 'LINK' });
  });

  it('fails at COMMIT when the old primary is disabled and the replacement is NOT verified, and rolls everything back', async () => {
    const { accountId, primary, candidate } = await accountWithReplacement();
    await expectRule(
      inTx(async (c) => {
        await disableOn(c, primary.id, 'REPLACED');
      }),
      'EMAIL_INVARIANT',
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
      'EMAIL_INVARIANT',
    );
    expect(await primariesOf(accountId)).toBe(1);
  });

  it('fails at COMMIT when the replacement is created and the primary is disabled in the same transaction (a replacement needs a verified primary)', async () => {
    const { accountId, primary } = await accountWithPrimary();
    await expectRule(
      inTx(async (c) => {
        await c.query(
          "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'REPLACEMENT_PENDING', 'USER_ENTERED')",
          [accountId, addr()],
        );
        await disableOn(c, primary.id, 'REPLACED');
      }),
      'EMAIL_INVARIANT',
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
      'EMAIL_INVARIANT',
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
      'EMAIL_INVARIANT',
    );
    expect((await contactState(contact.id)).status).toBe('PENDING');
    expect((await challengeState(challengeId)).invalidated).toBe(false);
  });

  it('commits the supersede flow: invalidate the challenge, disable the old candidate, add the new one (in this order)', async () => {
    const { contact, challengeId } = await freshOpen();
    const fresh = await inTx(async (c) => {
      await invalidateOn(c, challengeId, 'CONTACT_DISABLED');
      await disableOn(c, contact.id, 'SUPERSEDED');
      return (
        await c.query(
          "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED') RETURNING email_contact_id",
          [contact.accountId, addr()],
        )
      ).rows[0].email_contact_id as string;
    });
    expect((await contactState(contact.id)).status).toBe('DISABLED');
    expect((await contactState(fresh)).status).toBe('PENDING');
    expect(await challengeState(challengeId)).toMatchObject({ invalidated: true, invalidation_reason: 'CONTACT_DISABLED' });
  });

  it('fails at COMMIT when a PENDING initial address and a verified primary coexist (an IDP address inserted next to a pending one)', async () => {
    const pending = await freshPending();
    await expectRule(
      inTx(async (c) => {
        await c.query(
          "INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())",
          [pending.accountId, addr()],
        );
      }),
      'EMAIL_INVARIANT',
    );
    expect(await count(CONTACTS, 'account_id = $1', [pending.accountId])).toBe(1);
    expect(await primariesOf(pending.accountId)).toBe(0);
  });

  it('fails at COMMIT when both are created in one transaction, in either order of the rows that the guards allow', async () => {
    const a = await makeAccount();
    await expectRule(
      inTx(async (c) => {
        await c.query("INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED')", [
          a,
          addr(),
        ]);
        await c.query(
          "INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())",
          [a, addr()],
        );
      }),
      'EMAIL_INVARIANT',
    );
    expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(0);
  });

  it('lets a transaction pass through the pending-plus-primary state and fix it before COMMIT (an IDP primary supersedes the pending address)', async () => {
    const { contact, challengeId } = await freshOpen();
    await inTx(async (c) => {
      await c.query(
        "INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())",
        [contact.accountId, addr()],
      );
      await invalidateOn(c, challengeId, 'CONTACT_DISABLED');
      await disableOn(c, contact.id, 'SUPERSEDED');
    });
    expect(await primariesOf(contact.accountId)).toBe(1);
    expect((await contactState(contact.id)).status).toBe('DISABLED');
  });

  it('fails at COMMIT when a challenge is marked used while its contact is not VERIFIED (CHALLENGE_CONSUMPTION)', async () => {
    const { contact, challengeId } = await freshOpen();
    await expectRule(
      inTx(async (c) => {
        await consumeOn(c, challengeId, 'CODE');
      }),
      'CHALLENGE_CONSUMPTION',
    );
    expect((await contactState(contact.id)).status).toBe('PENDING');
    expect(await challengeState(challengeId)).toMatchObject({ used: false });
  });

  it('fails the consumption check for a replacement-pending contact as well', async () => {
    const { candidate, challengeId } = await freshReplacementOpen();
    await expectRule(
      inTx(async (c) => {
        await consumeOn(c, challengeId, 'LINK');
      }),
      'CHALLENGE_CONSUMPTION',
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
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await verifyOn(c, contact.id);
      const e = (await rejection(c.query('SET CONSTRAINTS identity.trg_email_contacts__invariants IMMEDIATE'))) as PgFailure | undefined;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:EMAIL_INVARIANT' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect((await contactState(contact.id)).status).toBe('PENDING');
  });

  it('surfaces the consumption check early with SET CONSTRAINTS ... IMMEDIATE too', async () => {
    const { challengeId } = await freshOpen();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await consumeOn(c, challengeId);
      const e = (await rejection(c.query('SET CONSTRAINTS identity.trg_email_verification_challenges__consumption IMMEDIATE'))) as PgFailure | undefined;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:CHALLENGE_CONSUMPTION' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('does not require a primary for an account that never had one (a lone PENDING address commits)', async () => {
    const c = await freshPending();
    expect((await contactState(c.id)).status).toBe('PENDING');
    expect(await primariesOf(c.accountId)).toBe(0);
  });

  it('re-evaluates the invariants for any touched row and passes for a consistent account (an updated_at write on the primary commits)', async () => {
    const { accountId, primary } = await accountWithPrimary();
    await inTx((c) => c.query("UPDATE identity.email_contacts SET updated_at = now() + interval '1 second' WHERE email_contact_id = $1", [primary.id]));
    expect(await primariesOf(accountId)).toBe(1);
  });
});

// ====================================================================== F. challenge table
const CH = 'ck_email_verification_challenges__';
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
];
const CHALLENGE_CASES: ConstraintCase[] = [
  bad('pk_email_verification_challenges', 'a duplicate challenge_id', async () => {
    const { challengeId } = await freshOpen();
    await insertChallengeRow((await freshPending()).id, { challenge_id: challengeId });
  }),
  bad('uq_email_verification_challenges__magic_token_hash', 'the same magic token hash on another contact', async () => {
    const token = hex64();
    await insertChallengeRow((await freshPending()).id, { magic_token_hash: token });
    await insertChallengeRow((await freshPending()).id, { magic_token_hash: token });
  }),
  bad('uq_email_verification_challenges__magic_token_hash', 'the same magic token hash on the same contact after the first closed', async () => {
    const { contact, challengeId } = await freshOpen();
    const token = (
      await q<{ t: string }>('SELECT magic_token_hash AS t FROM identity.email_verification_challenges WHERE challenge_id = $1', [challengeId])
    )[0]!.t;
    await invalidateOn(pool, challengeId, 'SUPERSEDED');
    await insertChallengeRow(contact.id, { magic_token_hash: token });
  }),
  bad('fk_email_verification_challenges__email_contact_id', 'a contact that does not exist (guard bypassed)', () =>
    isolated(
      noTriggers(CHALLENGES),
      `INSERT INTO ${CHALLENGES} (email_contact_id, purpose, code_hash, magic_token_hash, expires_at, correlation_id) VALUES ($1, 'INITIAL_EMAIL', $2, $3, now() + interval '1 hour', 'c')`,
      [randomUUID(), hex64(), hex64()],
    ),
  ),
  bad(`${CH}purpose`, 'an unknown purpose (guard bypassed)', async () => {
    const c = await freshPending();
    await isolated(
      noTriggers(CHALLENGES),
      `INSERT INTO ${CHALLENGES} (email_contact_id, purpose, code_hash, magic_token_hash, expires_at, correlation_id) VALUES ($1, 'BOGUS', $2, $3, now() + interval '1 hour', 'c')`,
      [c.id, hex64(), hex64()],
    );
  }),
  ...HASH_VARIANTS.map(([label, make]) =>
    bad(`${CH}code_hash`, `a code_hash with ${label}`, async () => insertChallengeRow((await freshPending()).id, { code_hash: make() })),
  ),
  ...HASH_VARIANTS.map(([label, make]) =>
    bad(`${CH}magic_token_hash`, `a magic_token_hash with ${label}`, async () => insertChallengeRow((await freshPending()).id, { magic_token_hash: make() })),
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
  bad(`${CH}consumed`, 'used_at without consumed_via', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET used_at = now() WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}consumed`, 'consumed_via without used_at', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET consumed_via = 'CODE' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}consumed`, 'a consumed_via outside CODE and LINK', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET used_at = now(), consumed_via = 'SMS' WHERE challenge_id = $1`, [challengeId]);
  }),
  bad(`${CH}consumed`, 'a lower-case consumed_via', async () => {
    const { challengeId } = await freshOpen();
    await run(`UPDATE ${CHALLENGES} SET used_at = now(), consumed_via = 'code' WHERE challenge_id = $1`, [challengeId]);
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
  bad(`${CH}closed_once`, 'a challenge both used and invalidated', async () => {
    const { challengeId } = await freshOpen();
    await run(
      `UPDATE ${CHALLENGES} SET used_at = now(), consumed_via = 'CODE', invalidated_at = now(), invalidation_reason = 'LOCKED' WHERE challenge_id = $1`,
      [challengeId],
    );
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

describe('F. email_verification_challenges: constraints, guards and the one-open-challenge rule', () => {
  describe('constraints, by name', () => {
    it.each(CHALLENGE_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
      expect(await constraintOf(attempt())).toBe(constraint);
    });

    it('accepts the boundary values the checks allow (200-character correlation id, equal hash shapes, shared code hash, expired fixture, every purpose)', async () => {
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
      expect(await count(CHALLENGES, 'email_contact_id = $1 AND expires_at < now()', [c3.id])).toBe(1);
      // CHANGE_EMAIL for a replacement candidate
      const { candidate } = await accountWithReplacement();
      await challengeFor(candidate);
    });

    it('defaults a new challenge to unused, unsent, zero attempts and a database-assigned id and creation time', async () => {
      const c = await freshPending();
      const id = await challengeFor(c);
      const row = (
        await q(
          `SELECT attempt_count, used_at, consumed_via, invalidated_at, invalidation_reason, delivery_status, last_sent_at, created_at IS NOT NULL AS created
             FROM identity.email_verification_challenges WHERE challenge_id = $1`,
          [id],
        )
      )[0];
      expect(row).toEqual({
        attempt_count: 0,
        used_at: null,
        consumed_via: null,
        invalidated_at: null,
        invalidation_reason: null,
        delivery_status: 'PENDING',
        last_sent_at: null,
        created: true,
      });
    });
  });

  describe('insert guards', () => {
    it.each<ContactStatus>(['VERIFIED', 'DISABLED'])('refuses a challenge for a %s contact (CHALLENGE_NOT_OPEN)', async (status) => {
      const c = await contactIn(status);
      await expectRule(challengeFor(c), 'CHALLENGE_NOT_OPEN');
      expect(await count(CHALLENGES, 'email_contact_id = $1', [c.id])).toBe(0);
    });

    it('refuses a challenge for a contact that does not exist (CHALLENGE_NOT_OPEN, before the foreign key)', async () => {
      await expectRule(insertChallengeRow(randomUUID()), 'CHALLENGE_NOT_OPEN');
    });

    it.each<ContactStatus>(['PENDING', 'REPLACEMENT_PENDING'])('accepts a challenge for a %s contact', async (status) => {
      const c = await contactIn(status);
      const id = await challengeFor(c);
      expect(await challengeState(id)).toMatchObject({ attempt_count: 0, used: false, invalidated: false, delivery_status: 'PENDING' });
    });

    it('refuses CHANGE_EMAIL for a PENDING contact and INITIAL_EMAIL for a REPLACEMENT_PENDING one (CHALLENGE_PURPOSE)', async () => {
      const pending = await freshPending();
      await expectRule(insertChallengeRow(pending.id, { purpose: 'CHANGE_EMAIL' }), 'CHALLENGE_PURPOSE');
      const { candidate } = await accountWithReplacement();
      await expectRule(insertChallengeRow(candidate.id, { purpose: 'INITIAL_EMAIL' }), 'CHALLENGE_PURPOSE');
    });

    const STATE_CASES: [string, Record<string, unknown>][] = [
      ['one attempt already counted', { attempt_count: 1 }],
      ['already used', { used_at: new Date(), consumed_via: 'CODE' }],
      ['already invalidated', { invalidated_at: new Date(), invalidation_reason: 'SUPERSEDED' }],
      ['already sent', { delivery_status: 'SENT', last_sent_at: new Date() }],
      ['already failed', { delivery_status: 'FAILED' }],
    ];
    it.each(STATE_CASES)('refuses a new challenge that starts %s (CHALLENGE_STATE)', async (_label, override) => {
      const c = await freshPending();
      await expectRule(challengeFor(c, override), 'CHALLENGE_STATE');
      expect(await count(CHALLENGES, 'email_contact_id = $1', [c.id])).toBe(0);
    });

    it('reports the open-contact rule before the purpose rule and the purpose rule before the state rule', async () => {
      const verified = (await accountWithPrimary()).primary;
      await expectRule(insertChallengeRow(verified.id, { purpose: 'CHANGE_EMAIL', attempt_count: 3 }), 'CHALLENGE_NOT_OPEN');
      const pending = await freshPending();
      await expectRule(insertChallengeRow(pending.id, { purpose: 'CHANGE_EMAIL', attempt_count: 3 }), 'CHALLENGE_PURPOSE');
    });
  });

  describe('one open challenge per contact', () => {
    it('refuses a second open challenge for the same contact (uq_email_verification_challenges__open_per_contact)', async () => {
      const { contact } = await freshOpen();
      await expectUnique(challengeFor(contact), 'uq_email_verification_challenges__open_per_contact');
      expect(await count(CHALLENGES, 'email_contact_id = $1', [contact.id])).toBe(1);
    });

    it('allows a new challenge once the previous one is invalidated (a resend supersedes the open challenge)', async () => {
      const { contact, challengeId } = await freshOpen();
      await invalidateOn(pool, challengeId, 'SUPERSEDED');
      const second = await challengeFor(contact);
      expect(second).not.toBe(challengeId);
      expect(await count(CHALLENGES, 'email_contact_id = $1', [contact.id])).toBe(2);
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

    it('allows a new challenge for a contact whose previous challenge was used (the contact is then VERIFIED, so the guard refuses: CHALLENGE_NOT_OPEN)', async () => {
      const { contact } = await freshUsed();
      await expectRule(challengeFor(contact), 'CHALLENGE_NOT_OPEN');
    });

    it('keeps the whole send history of a contact (three sends, three rows, one open)', async () => {
      const { contact, challengeId } = await freshOpen();
      await invalidateOn(pool, challengeId, 'SUPERSEDED');
      const second = await challengeFor(contact);
      await invalidateOn(pool, second, 'SUPERSEDED');
      await challengeFor(contact);
      expect(await count(CHALLENGES, 'email_contact_id = $1', [contact.id])).toBe(3);
      expect(await count(CHALLENGES, 'email_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL', [contact.id])).toBe(1);
    });

    it('lets two contacts each hold their own open challenge', async () => {
      await freshOpen();
      await freshOpen();
    });
  });

  describe('updates: immutability, attempts, closed rows, delivery', () => {
    const IMMUTABLE_COLUMNS: [string, () => Promise<unknown> | unknown][] = [
      ['code_hash', () => hex64()],
      ['magic_token_hash', () => hex64()],
      ['expires_at', () => new Date(Date.now() + 3_600_000)],
      ['created_at', () => new Date(0)],
      ['correlation_id', () => 'another-correlation'],
      ['purpose', () => 'CHANGE_EMAIL'],
      ['email_contact_id', async () => (await freshPending()).id],
      ['challenge_id', () => randomUUID()],
    ];
    it.each(IMMUTABLE_COLUMNS)('keeps %s immutable (IMMUTABLE_IDENTITY)', async (column, value) => {
      const { challengeId } = await freshOpen();
      await expectRule(run(`UPDATE ${CHALLENGES} SET ${column} = $2 WHERE challenge_id = $1`, [challengeId, await value()]), 'IMMUTABLE_IDENTITY');
    });

    it('reports an immutable-field change before a closed challenge (IMMUTABLE_IDENTITY first, then CHALLENGE_CLOSED)', async () => {
      const { challengeId } = await freshInvalidated();
      await expectRule(run(`UPDATE ${CHALLENGES} SET code_hash = $2 WHERE challenge_id = $1`, [challengeId, hex64()]), 'IMMUTABLE_IDENTITY');
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 1 WHERE challenge_id = $1`, [challengeId]), 'CHALLENGE_CLOSED');
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

    it('refuses a jump of more than one attempt (CHALLENGE_ATTEMPTS)', async () => {
      const { challengeId } = await freshOpen();
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = 2 WHERE challenge_id = $1`, [challengeId]), 'CHALLENGE_ATTEMPTS');
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 5 WHERE challenge_id = $1`, [challengeId]), 'CHALLENGE_ATTEMPTS');
      expect((await challengeState(challengeId)).attempt_count).toBe(0);
    });

    it('refuses to decrease or reset the attempt counter (CHALLENGE_ATTEMPTS)', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET attempt_count = 1 WHERE challenge_id = $1`, [challengeId]);
      await run(`UPDATE ${CHALLENGES} SET attempt_count = 2 WHERE challenge_id = $1`, [challengeId]);
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = 0 WHERE challenge_id = $1`, [challengeId]), 'CHALLENGE_ATTEMPTS');
      await expectRule(run(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count - 1 WHERE challenge_id = $1`, [challengeId]), 'CHALLENGE_ATTEMPTS');
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
      ['a used', () => freshUsed('CODE')],
      ['a link-consumed', () => freshUsed('LINK')],
    ])('never changes %s challenge again (CHALLENGE_CLOSED), not even by a no-op write', async (_label, make) => {
      const { challengeId } = await make();
      const updates = [
        'attempt_count = attempt_count + 1',
        'attempt_count = attempt_count',
        "delivery_status = 'SENT', last_sent_at = now()",
        'used_at = NULL, consumed_via = NULL',
        'invalidated_at = NULL, invalidation_reason = NULL',
        "invalidated_at = now(), invalidation_reason = 'SUPERSEDED'",
      ];
      for (const set of updates) await expectRule(run(`UPDATE ${CHALLENGES} SET ${set} WHERE challenge_id = $1`, [challengeId]), 'CHALLENGE_CLOSED');
    });

    it('records the delivery outcome once: PENDING -> SENT is allowed, SENT -> FAILED, SENT -> PENDING and a new last_sent_at are refused (CHALLENGE_DELIVERY)', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET delivery_status = 'SENT', last_sent_at = now() WHERE challenge_id = $1`, [challengeId]);
      expect(await challengeState(challengeId)).toMatchObject({ delivery_status: 'SENT', sent: true });
      await expectRule(
        run(`UPDATE ${CHALLENGES} SET delivery_status = 'FAILED', last_sent_at = NULL WHERE challenge_id = $1`, [challengeId]),
        'CHALLENGE_DELIVERY',
      );
      await expectRule(
        run(`UPDATE ${CHALLENGES} SET delivery_status = 'PENDING', last_sent_at = NULL WHERE challenge_id = $1`, [challengeId]),
        'CHALLENGE_DELIVERY',
      );
      await expectRule(run(`UPDATE ${CHALLENGES} SET last_sent_at = now() + interval '1 minute' WHERE challenge_id = $1`, [challengeId]), 'CHALLENGE_DELIVERY');
      expect(await challengeState(challengeId)).toMatchObject({ delivery_status: 'SENT', sent: true });
    });

    it('refuses to turn a FAILED delivery into SENT (CHALLENGE_DELIVERY) while the challenge is still open', async () => {
      const { challengeId } = await freshOpen();
      await run(`UPDATE ${CHALLENGES} SET delivery_status = 'FAILED' WHERE challenge_id = $1`, [challengeId]);
      await expectRule(
        run(`UPDATE ${CHALLENGES} SET delivery_status = 'SENT', last_sent_at = now() WHERE challenge_id = $1`, [challengeId]),
        'CHALLENGE_DELIVERY',
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
      const { contact, challengeId } = await freshUsed('LINK');
      expect(await contactState(contact.id)).toMatchObject({ status: 'VERIFIED', is_primary: true });
      expect(await challengeState(challengeId)).toMatchObject({ used: true, consumed_via: 'LINK', invalidated: false });
    });
  });
});

// ====================================================================== G. atomic attempt counting under real concurrency
describe('G. atomic attempt counting and races at the SQL level', () => {
  it('counts 20 concurrent increments exactly (the row lock serializes them): attempt_count ends at 20', async () => {
    const { challengeId } = await freshOpen();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => racePool.query(`UPDATE ${CHALLENGES} SET attempt_count = attempt_count + 1 WHERE challenge_id = $1`, [challengeId])),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect((await challengeState(challengeId)).attempt_count).toBe(20);
  });

  /**
   * The service's wrong-code transaction (EmailVerificationService.confirmCode): re-read the OPEN challenge FOR UPDATE; at the maximum lock it, otherwise count
   * the attempt with the CASE statement that locks the challenge in the same statement as the attempt that reaches the maximum.
   */
  async function wrongCode(contactId: string, max: number): Promise<{ outcome: 'COUNTED' | 'LOCKED_NOW' | 'NO_OPEN_CHALLENGE'; attempts?: number }> {
    const c = await racePool.connect();
    try {
      await c.query('BEGIN');
      const open = (
        await c.query(
          `SELECT challenge_id, attempt_count FROM ${CHALLENGES} WHERE email_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL FOR UPDATE`,
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
    expect(await count(CHALLENGES, 'email_contact_id = $1', [contact.id])).toBe(1);
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

  it('keeps the bound at the database even without the re-read: concurrent CASE updates past the maximum are refused by the closed-challenge guard (CHALLENGE_CLOSED)', async () => {
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
        detail: 'identity_rule:CHALLENGE_CLOSED',
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
        constraint: 'uq_email_verification_challenges__open_per_contact',
      });
    expect(await count(CHALLENGES, 'email_contact_id = $1', [contact.id])).toBe(1);
  });

  it('lets exactly one of six concurrent first-address inserts for one account win (the others hit the open-per-account unique index)', async () => {
    const a = await makeAccount();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        racePool.query("INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED')", [
          a,
          addr('race'),
        ]),
      ),
    );
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of refused)
      expect({ code: (r.reason as PgFailure).code, constraint: (r.reason as PgFailure).constraint }).toEqual({
        code: '23505',
        constraint: 'uq_email_contacts__open_per_account',
      });
    expect(await count(CONTACTS, 'account_id = $1', [a])).toBe(1);
  });

  it('lets exactly one of two accounts verify one address when both race: the loser fails with the verified-address unique index once the winner commits', async () => {
    const email = addr('duel');
    const winner = await insertContact(await makeAccount(), { email });
    const loser = await insertContact(await makeAccount(), { email });
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await verifyOn(t1, winner.id);
      const second = rejection(verifyOn(pool, loser.id));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'uq_email_contacts__verified_address' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect((await contactState(winner.id)).status).toBe('VERIFIED');
    expect((await contactState(loser.id)).status).toBe('PENDING');
    expect(await count(CONTACTS, "email_normalized = $1 AND status = 'VERIFIED'", [email])).toBe(1);
  });

  it('rolls back a failed concurrent verification completely: the loser keeps its open challenge and its zero attempts', async () => {
    const email = addr('duel2');
    const winner = await insertContact(await makeAccount(), { email });
    const loser = await insertContact(await makeAccount(), { email });
    const challengeId = await challengeFor(loser);
    await inTx(async (c) => {
      await invalidateOn(c, await challengeFor(winner, {}, c), 'SUPERSEDED');
      await verifyOn(c, winner.id);
    });
    const e = await fail(
      inTx(async (c) => {
        await verifyOn(c, loser.id);
        await consumeOn(c, challengeId);
      }),
    );
    expect(e.constraint).toBe('uq_email_contacts__verified_address');
    expect(await challengeState(challengeId)).toMatchObject({ used: false, invalidated: false, attempt_count: 0 });
    expect((await contactState(loser.id)).status).toBe('PENDING');
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
const CUSTOMER = async (): Promise<string> => (await q<{ role_id: string }>("SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER'"))[0]!.role_id;

const AUDIT_CASES: ConstraintCase[] = [
  bad('fk_account_audit_events__account_email_contact', 'a contact that does not exist', async () =>
    insertAudit(await makeAccount(), 'EMAIL_ADDED', randomUUID()),
  ),
  bad('fk_account_audit_events__account_email_contact', 'a contact that belongs to ANOTHER account', async () => {
    const other = await freshPending();
    await insertAudit(await makeAccount(), 'EMAIL_ADDED', other.id);
  }),
  bad('fk_account_audit_events__account_email_contact', 'a contact of another account, naming a verified primary', async () => {
    const { primary } = await accountWithPrimary();
    await insertAudit(await makeAccount(), 'EMAIL_VERIFIED', primary.id);
  }),
  bad('ck_account_audit_events__email_contact', 'EMAIL_ADDED without a contact', async () => insertAudit(await makeAccount(), 'EMAIL_ADDED')),
  bad('ck_account_audit_events__email_contact', 'ACCOUNT_CREATED with a contact', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'ACCOUNT_CREATED', c.id);
  }),
  bad('ck_account_audit_events__action', 'an unknown EMAIL_ action', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'EMAIL_DELETED', c.id);
  }),
  bad('ck_account_audit_events__action', 'an action without the underscore after EMAIL', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'EMAILVERIFIED', c.id);
  }),
  bad('ck_account_audit_events__action', 'a lower-case email action', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'email_verified', c.id);
  }),
];

describe('H. audit extension: seven EMAIL_* actions and the contact they concern', () => {
  it.each(OLD_ACTIONS)('still accepts the 0009 action %s (no contact)', async (action) => {
    const a = await makeAccount();
    const role = action.startsWith('ROLE_') ? await CUSTOMER() : null;
    await q('INSERT INTO identity.account_audit_events (actor, action, account_id, role_id, correlation_id) VALUES ($1, $2, $3, $4, $5)', [
      'test',
      action,
      a,
      role,
      'test-correlation',
    ]);
  });

  it.each(EMAIL_ACTIONS)('accepts %s with a contact, and with a changes object holding only a masked address and ids', async (action) => {
    const c = await freshPending();
    const id = await insertAudit(c.accountId, action, c.id, JSON.stringify({ maskedEmail: 'a***@e***.test', challengeId: randomUUID(), attempt: 2 }));
    expect(await q('SELECT action, email_contact_id FROM identity.account_audit_events WHERE audit_event_id = $1', [id])).toEqual([
      { action, email_contact_id: c.id },
    ]);
  });

  it.each(EMAIL_ACTIONS)('requires a contact for %s (ck_account_audit_events__email_contact)', async (action) => {
    expect(await constraintOf(insertAudit(await makeAccount(), action))).toBe('ck_account_audit_events__email_contact');
  });

  it.each(OLD_ACTIONS.filter((a) => !a.startsWith('ROLE_')))(
    'refuses a contact on the non-email action %s (ck_account_audit_events__email_contact)',
    async (action) => {
      const c = await freshPending();
      expect(await constraintOf(insertAudit(c.accountId, action, c.id))).toBe('ck_account_audit_events__email_contact');
    },
  );

  it.each(AUDIT_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it('keeps the role rule beside the email rule: an email action with a role is refused (ck_account_audit_events__role)', async () => {
    const c = await freshPending();
    const e = await fail(
      q('INSERT INTO identity.account_audit_events (actor, action, account_id, role_id, email_contact_id, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        'test',
        'EMAIL_ADDED',
        c.accountId,
        await CUSTOMER(),
        c.id,
        'test-correlation',
      ]),
    );
    expect(e.constraint).toBe('ck_account_audit_events__role');
  });

  it.each(EMAIL_ACTIONS)(
    "refuses %s naming a contact of ANOTHER account (composite foreign key), and accepts the same row once the contact is the audited account's own",
    async (action) => {
      const own = await freshPending();
      const foreign = await freshPending();
      expect(await constraintOf(insertAudit(own.accountId, action, foreign.id))).toBe('fk_account_audit_events__account_email_contact');
      expect(await count('identity.account_audit_events', 'email_contact_id = $1', [foreign.id])).toBe(0);
      await insertAudit(own.accountId, action, own.id);
      await insertAudit(foreign.accountId, action, foreign.id);
    },
  );

  it('ties the audit row to the account of the contact even when the account holds several contacts (history rows included)', async () => {
    const { accountId, primary, candidate } = await accountWithReplacement();
    await disableOn(pool, candidate.id, 'SUPERSEDED');
    for (const c of [primary, candidate]) await insertAudit(accountId, 'EMAIL_ADDED', c.id);
    const other = await freshPending();
    for (const c of [primary, candidate])
      expect(await constraintOf(insertAudit(other.accountId, 'EMAIL_ADDED', c.id))).toBe('fk_account_audit_events__account_email_contact');
    expect(await count('identity.account_audit_events', 'account_id = $1 AND email_contact_id IS NOT NULL', [accountId])).toBe(2);
  });

  it('skips the composite key for a row without a contact (MATCH SIMPLE): a non-email action of any account needs no contact', async () => {
    await insertAudit(await makeAccount(), 'PROFILE_UPDATED');
  });

  it('refuses UPDATE and DELETE of an email audit row, on every column (ROW_IMMUTABLE)', async () => {
    const c = await freshPending();
    const id = await insertAudit(c.accountId, 'EMAIL_ADDED', c.id, '{"maskedEmail":"a***@e***.test"}');
    const updates = [
      "actor = 'someone'",
      "action = 'EMAIL_VERIFIED'",
      'email_contact_id = NULL',
      "changes = '{}'::jsonb",
      "reason = 'edited'",
      "correlation_id = 'x'",
      'occurred_at = now()',
    ];
    for (const set of updates) await expectRule(run(`UPDATE identity.account_audit_events SET ${set} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM identity.account_audit_events WHERE audit_event_id = $1', [id]), 'ROW_IMMUTABLE');
    expect(await q('SELECT action, email_contact_id, changes FROM identity.account_audit_events WHERE audit_event_id = $1', [id])).toEqual([
      { action: 'EMAIL_ADDED', email_contact_id: c.id, changes: { maskedEmail: 'a***@e***.test' } },
    ]);
  });

  it('keeps the contact when an audit row names it (the contact cannot be deleted: NOT_DELETABLE, and the foreign key is RESTRICT)', async () => {
    const c = await freshPending();
    await insertAudit(c.accountId, 'EMAIL_ADDED', c.id);
    await expectRule(run('DELETE FROM identity.email_contacts WHERE email_contact_id = $1', [c.id]), 'NOT_DELETABLE');
    // with the guard bypassed the foreign key itself refuses
    expect(await constraintOf(isolated(noTriggers(CONTACTS), 'DELETE FROM identity.email_contacts WHERE email_contact_id = $1', [c.id]))).toBe(
      'fk_account_audit_events__account_email_contact',
    );
  });

  it('accepts a per-contact timeline: several audit rows for one contact are all kept in order of insertion', async () => {
    const c = await freshPending();
    for (const action of ['EMAIL_ADDED', 'EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFICATION_FAILED']) await insertAudit(c.accountId, action, c.id);
    const rows = await q<{ action: string }>('SELECT action FROM identity.account_audit_events WHERE email_contact_id = $1 ORDER BY occurred_at, action', [
      c.id,
    ]);
    expect(rows.map((r) => r.action).sort()).toEqual(['EMAIL_ADDED', 'EMAIL_VERIFICATION_FAILED', 'EMAIL_VERIFICATION_REQUESTED']);
  });
});

// ====================================================================== I. configuration seeds
interface ParamSeed {
  key: string;
  unit: string;
  min: number;
  max: number;
  value: number;
}
const PARAM_SEEDS: ParamSeed[] = [
  { key: 'verification.email.code.length', unit: 'digits', min: 4, max: 10, value: 6 },
  { key: 'verification.email.validity_minutes', unit: 'minutes', min: 1, max: 120, value: 10 },
  { key: 'verification.email.resend_seconds', unit: 'seconds', min: 0, max: 3600, value: 30 },
  { key: 'verification.email.max_per_hour', unit: 'sends', min: 1, max: 100, value: 5 },
  { key: 'verification.email.max_per_day', unit: 'sends', min: 1, max: 1000, value: 10 },
  { key: 'verification.email.max_attempts', unit: 'attempts', min: 1, max: 20, value: 5 },
  { key: 'verification.email.requests.max_per_hour', unit: 'requests', min: 1, max: 1000, value: 30 },
  { key: 'verification.email.address.max_per_hour', unit: 'sends', min: 1, max: 100, value: 5 },
];
const PARAM_KEYS = PARAM_SEEDS.map((p) => p.key);
const parameterId = async (key: string): Promise<string> =>
  (await q<{ parameter_id: string }>('SELECT parameter_id FROM configuration.parameters WHERE key = $1', [key]))[0]!.parameter_id;

describe('I. seeded configuration: the eight verification.email.* parameters', () => {
  it('seeds exactly the eight parameters, and no other verification.email.* key', async () => {
    const rows = await q<{ key: string }>("SELECT key FROM configuration.parameters WHERE key LIKE 'verification.email.%'");
    expect(rows.map((r) => r.key).sort()).toEqual([...PARAM_KEYS].sort());
  });

  it.each(PARAM_SEEDS)('defines $key as a required, active, CRITICAL INTERNAL integer owned by security with a SECOND_APPROVER policy', async ({ key }) => {
    const rows = await q(
      `SELECT data_type, owner_role, approval_policy, criticality, sensitivity, is_required, is_active, created_by FROM configuration.parameters WHERE key = $1`,
      [key],
    );
    expect(rows).toEqual([
      {
        data_type: 'INTEGER',
        owner_role: 'security',
        approval_policy: 'SECOND_APPROVER',
        criticality: 'CRITICAL',
        sensitivity: 'INTERNAL',
        is_required: true,
        is_active: true,
        created_by: 'system:migration',
      },
    ]);
  });

  it.each(PARAM_SEEDS)('declares the unit and the min/max validation rules of $key', async ({ key, unit, min, max }) => {
    const rows = await q<{ unit: string; validation_rules: unknown }>('SELECT unit, validation_rules FROM configuration.parameters WHERE key = $1', [key]);
    expect(rows).toEqual([{ unit, validation_rules: { min, max } }]);
  });

  it('allows the PLATFORM scope only for every seeded parameter', async () => {
    const rows = await q<{ key: string; scopes: string[] }>(
      `SELECT p.key, array_agg(s.scope_type ORDER BY s.scope_type) AS scopes FROM configuration.parameters p
         JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id WHERE p.key LIKE 'verification.email.%' GROUP BY p.key`,
    );
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.scopes, r.key).toEqual(['PLATFORM']);
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
    expect((rows[0] as { reason: string }).reason).toMatch(/^Initial value \(migration 0010\)/);
  });

  it('seeds the PRD values in order: 6 digits, 10 minutes, 30 seconds, 5 per hour, 10 per day, 5 attempts, 30 requests per hour, 5 sends per address per hour', async () => {
    const rows = await q<{ key: string; value: number }>(
      `SELECT p.key, v.value FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key LIKE 'verification.email.%'`,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(PARAM_KEYS.map((k) => byKey[k])).toEqual([6, 10, 30, 5, 10, 5, 30, 5]);
  });

  it('keeps every seeded value inside its own validation range, and the hourly cap at most the daily cap', async () => {
    for (const p of PARAM_SEEDS) {
      expect(p.value, p.key).toBeGreaterThanOrEqual(p.min);
      expect(p.value, p.key).toBeLessThanOrEqual(p.max);
    }
    const value = (key: string) => PARAM_SEEDS.find((p) => p.key === key)!.value;
    expect(value('verification.email.max_per_hour')).toBeLessThanOrEqual(value('verification.email.max_per_day'));
  });

  it('resolves exactly one effective version per parameter at the database clock (the no-overlap rule)', async () => {
    const rows = await q<{ key: string; n: number }>(
      `SELECT p.key, count(*)::int AS n FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id
        WHERE p.key LIKE 'verification.email.%' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now()) GROUP BY p.key`,
    );
    expect(rows).toHaveLength(8);
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

  it.each(PARAM_SEEDS)('writes the audit trail of $key exactly like the real workflow, in order', async ({ key }) => {
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
    for (const r of rows) expect(r.correlation_id).toBe('seed-0010');
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
    const id = await parameterId('verification.email.max_attempts');
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

  it('refuses to rename, retype or delete a seeded parameter definition, and to rewrite its approved request or approval', async () => {
    const id = await parameterId('verification.email.code.length');
    expect((await fail(run("UPDATE configuration.parameters SET key = 'verification.email.other' WHERE parameter_id = $1", [id]))).code).toBe('23000');
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
    const id = await parameterId('verification.email.max_per_day');
    const request = (await q<{ change_request_id: string }>('SELECT change_request_id FROM configuration.change_requests WHERE parameter_id = $1', [id]))[0]!
      .change_request_id;
    const e = await fail(
      run("INSERT INTO configuration.change_approvals (change_request_id, approver, decision) VALUES ($1, 'system:migration', 'APPROVE')", [request]),
    );
    expect(e.code).toBe('23000');
  });
});

// ====================================================================== J. content seeds
const ERROR_KEYS = [
  'required',
  'too_long',
  'invalid_format',
  'invalid_characters',
  'unsupported',
  'not_pending',
  'code_invalid',
  'code_expired',
  'code_used',
  'verification_locked',
  'resend_too_soon',
  'send_limit',
  'unavailable',
  'delivery_failed',
  'rate_limited',
  'link_invalid',
].map((k) => `account.email.error.${k}`);
const EMAIL_COPY: [key: string, type: string][] = [
  ['account.email.verification.subject', 'EMAIL_SUBJECT'],
  ['account.email.verification.body', 'EMAIL_BODY'],
  ['account.email.verify.title', 'UI_LABEL'],
  ['account.email.verify.intro', 'PLAIN_TEXT'],
  ['account.email.verify.code_label', 'UI_LABEL'],
  ['account.email.verify.submit', 'UI_LABEL'],
  ['account.email.verify.resend', 'UI_LABEL'],
  ['account.email.verify.resend_wait', 'PLAIN_TEXT'],
  ['account.email.verify.change', 'UI_LABEL'],
  ['account.email.verify.sent', 'PLAIN_TEXT'],
  ['account.email.verify.success', 'PLAIN_TEXT'],
  ['account.email.link.title', 'UI_LABEL'],
  ['account.email.link.body', 'PLAIN_TEXT'],
  ['account.email.link.confirm', 'UI_LABEL'],
  ['account.email.link.sign_in_required', 'PLAIN_TEXT'],
  ['account.email.status.none', 'UI_LABEL'],
  ['account.email.status.pending', 'UI_LABEL'],
  ['account.email.status.verified', 'UI_LABEL'],
  ...ERROR_KEYS.map((k): [string, string] => [k, 'PLAIN_TEXT']),
];
const EXPECTED_VARIABLES: Record<string, [name: string, type: string, pii: string][]> = {
  'account.email.verification.body': [
    ['expiry_minutes', 'COUNT', 'NONE'],
    ['verification_code', 'STRING', 'SENSITIVE_PERSONAL'],
    ['verification_url', 'URL', 'SENSITIVE_PERSONAL'],
  ],
  'account.email.verify.intro': [['masked_email', 'STRING', 'PERSONAL']],
  'account.email.verify.resend_wait': [['seconds', 'COUNT', 'NONE']],
};
interface EntryRow {
  entry_id: string;
  key: string;
  content_type: string;
}
const emailEntries = async (): Promise<EntryRow[]> =>
  q<EntryRow>("SELECT entry_id, key, content_type FROM content.entries WHERE key LIKE 'account.email.%' ORDER BY key");
const bodyOf = async (key: string): Promise<string> =>
  (await q<{ body: string }>('SELECT v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = $1', [key]))[0]!.body;

describe('J. seeded content: the verification email and screen copy (34 entries)', () => {
  it('seeds exactly 34 account.email.* entries, each key once', async () => {
    const rows = await emailEntries();
    expect(rows).toHaveLength(34);
    expect(EMAIL_COPY).toHaveLength(34);
    expect(rows.map((r) => r.key)).toEqual(EMAIL_COPY.map(([k]) => k).sort());
  });

  it('gives each entry its content type: one EMAIL_SUBJECT, one EMAIL_BODY, the rest UI_LABEL or PLAIN_TEXT', async () => {
    const rows = await emailEntries();
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.content_type]));
    expect(byKey).toEqual(Object.fromEntries(EMAIL_COPY));
    const types = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.content_type]: (acc[r.content_type] ?? 0) + 1 }), {});
    expect(types).toEqual({ EMAIL_SUBJECT: 1, EMAIL_BODY: 1, UI_LABEL: 10, PLAIN_TEXT: 22 });
  });

  it('seeds every entry as PUBLIC, STANDARD, owned by CONTENT, approval NONE, CHAIN fallback, PLATFORM maximum scope, active', async () => {
    const rows = await q(
      `SELECT DISTINCT sensitivity, criticality, owner_role, approval_policy, fallback_policy, max_scope_type, is_active, created_by FROM content.entries WHERE key LIKE 'account.email.%'`,
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
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.email.%' GROUP BY e.key`,
    );
    expect(rows).toHaveLength(34);
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
      "SELECT e.key, v.body, v.body_sha256 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.email.%'",
    );
    expect(rows).toHaveLength(34);
    for (const r of rows) expect(r.body_sha256, r.key).toBe(sha256(r.body));
  });

  it('writes the content audit trail of every entry: ENTRY_CREATED, VERSION_DRAFTED, VERSION_APPROVED, VERSION_PUBLISHED, VERSION_ACTIVATED', async () => {
    const rows = await q<{ key: string; actions: string[]; actors: string[]; correlations: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at) AS actions, array_agg(DISTINCT a.actor) AS actors, array_agg(DISTINCT a.correlation_id) AS correlations
         FROM content.entries e JOIN content.audit_events a ON a.entry_id = e.entry_id WHERE e.key LIKE 'account.email.%' GROUP BY e.key`,
    );
    expect(rows).toHaveLength(34);
    for (const r of rows) {
      expect(r.actions, r.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
      expect(r.actors).toEqual(['system:migration']);
      expect(r.correlations).toEqual(['seed-0010']);
    }
  });

  it('declares exactly the typed variables of the email body and the two screen strings, and none on any other entry', async () => {
    const rows = await q<{ key: string; name: string; var_type: string; pii_class: string; is_required: boolean }>(
      `SELECT e.key, x.name, x.var_type, x.pii_class, x.is_required FROM content.entries e JOIN content.entry_variables x ON x.entry_id = e.entry_id
        WHERE e.key LIKE 'account.email.%' ORDER BY e.key, x.name`,
    );
    const grouped: Record<string, [string, string, string][]> = {};
    for (const r of rows) (grouped[r.key] ??= []).push([r.name, r.var_type, r.pii_class]);
    expect(grouped).toEqual(EXPECTED_VARIABLES);
    for (const r of rows) expect(r.is_required, `${r.key}.${r.name}`).toBe(true);
  });

  it('marks the code and the link SENSITIVE_PERSONAL so no consumer treats a credential as ordinary text', async () => {
    const rows = await q<{ name: string; pii_class: string }>(
      `SELECT x.name, x.pii_class FROM content.entry_variables x JOIN content.entries e ON e.entry_id = x.entry_id WHERE e.key = 'account.email.verification.body' ORDER BY x.name`,
    );
    expect(rows).toEqual([
      { name: 'expiry_minutes', pii_class: 'NONE' },
      { name: 'verification_code', pii_class: 'SENSITIVE_PERSONAL' },
      { name: 'verification_url', pii_class: 'SENSITIVE_PERSONAL' },
    ]);
  });

  it('puts the code, the expiry and the link in the body, and keeps the code out of the subject', async () => {
    const body = await bodyOf('account.email.verification.body');
    expect(body).toContain('{verification_code}');
    expect(body).toContain('{verification_url}');
    expect(body).toMatch(/\{expiry_minutes, plural,/);
    const subject = await bodyOf('account.email.verification.subject');
    expect(subject).not.toContain('verification_code');
    expect(subject).not.toContain('verification_url');
    expect(subject).not.toMatch(/[{}]/);
    expect(subject).not.toMatch(/\d{4,}/);
  });

  it('never embeds a sample code or a literal link in any seeded text', async () => {
    const rows = await q<{ key: string; body: string }>(
      "SELECT e.key, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.email.%'",
    );
    for (const r of rows) {
      expect(r.body, r.key).not.toMatch(/\d{4,}/);
      expect(r.body, r.key).not.toMatch(/https?:\/\//i);
    }
  });

  it('uses only the placeholders the entry declares, and every declared variable appears in its text', async () => {
    const rows = await q<{ key: string; body: string; names: string[] | null }>(
      `SELECT e.key, v.body, (SELECT array_agg(x.name ORDER BY x.name) FROM content.entry_variables x WHERE x.entry_id = e.entry_id) AS names
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.email.%'`,
    );
    for (const r of rows) {
      const used = [...new Set([...r.body.matchAll(/\{([a-z][a-z0-9_]*)\s*[,}]/g)].map((m) => m[1]!))].sort();
      expect(used, r.key).toEqual(r.names ?? []);
    }
  });

  it('covers every message key the email vocabulary needs: five validation issues and eleven error codes (sixteen error keys)', async () => {
    const present = new Set((await emailEntries()).map((r) => r.key));
    for (const key of ERROR_KEYS) expect(present.has(key), key).toBe(true);
    expect(ERROR_KEYS).toHaveLength(16);
    expect(ERROR_KEYS.slice(0, 5)).toEqual(
      ['required', 'too_long', 'invalid_format', 'invalid_characters', 'unsupported'].map((k) => `account.email.error.${k}`),
    );
  });

  it('covers the three verification status labels and the screen strings a client reads by key', async () => {
    const present = new Set((await emailEntries()).map((r) => r.key));
    for (const s of ['none', 'pending', 'verified']) expect(present.has(`account.email.status.${s}`), s).toBe(true);
    for (const k of ['title', 'intro', 'code_label', 'submit', 'resend', 'resend_wait', 'change', 'sent', 'success'])
      expect(present.has(`account.email.verify.${k}`), k).toBe(true);
    for (const k of ['title', 'body', 'confirm', 'sign_in_required']) expect(present.has(`account.email.link.${k}`), k).toBe(true);
  });

  it('keeps every seeded text non-blank and free of control characters', async () => {
    const rows = await q<{ key: string; body: string; content_type: string }>(
      "SELECT e.key, v.body, e.content_type FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.email.%'",
    );
    for (const r of rows) {
      expect(r.body.trim().length, r.key).toBeGreaterThan(0);
      // the email body is multi-paragraph; every other entry is a single line
      if (r.content_type !== 'EMAIL_BODY')
        expect(
          [...r.body].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
          r.key,
        ).toBe(false);
    }
  });

  it('refuses to edit a seeded published version (the text is immutable; corrections are new versions)', async () => {
    const version = (
      await q<{ version_id: string }>(
        "SELECT v.version_id FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = 'account.email.verify.title'",
      )
    )[0]!.version_id;
    expect((await fail(run("UPDATE content.versions SET body = 'Changed' WHERE version_id = $1", [version]))).code).toBe('23000');
    expect((await fail(run('DELETE FROM content.versions WHERE version_id = $1', [version]))).code).toBe('23000');
  });
});
