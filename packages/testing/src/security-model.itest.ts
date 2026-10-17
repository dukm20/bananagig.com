import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authSecurityErrorMessageKey,
  AUTH_SECURITY_ERROR_CODES,
  BROWSER_FAMILIES,
  browserLabelKey,
  DEVICE_CLASSES,
  deviceClassLabelKey,
  OS_FAMILIES,
  osLabelKey,
  SECURITY_ACTIVITY_TYPES,
  SECURITY_AUDIT_ACTIONS,
  SECURITY_ERROR_CODES,
  SESSION_REVOCATION_REASONS,
  securityActivityLabelKey,
  securityErrorMessageKey,
} from '../../contracts/src/security';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase, createTestPool } from './index';

// Migration 0012 adds the BananaGig-owned application session registry (identity.application_sessions), the device registry with the trusted-browser window
// (identity.account_devices), the revocation watermark (identity.accounts.sessions_not_before), the audit extension (sixteen security actions, a session reference
// and a device reference with composite foreign keys), three guard triggers, six session/MFA/recovery configuration parameters and 86 security and
// password-reset content entries. These tests drive the REAL tables with raw SQL: the shape of the schema (every column, constraint, index and trigger by name,
// nothing speculative), the privacy shape (no token, secret, code, address or raw user agent can be stored), every CHECK/UNIQUE/FK by constraint name, every
// guard rule (SQLSTATE 23000, DETAIL identity_rule:<KEY>), the watermark, the audit widening, the interleavings that matter under real concurrency, and both seeds.
// The service behaviour is covered in packages/accounts (security-service.itest.ts).
let iso: IsolatedDatabase;
let pool: pg.Pool;
let racePool: pg.Pool;
let seq = 0;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 24);
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
  column?: string;
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
/** Asserts the statement violates a NOT NULL constraint (SQLSTATE 23502) on this column. */
const expectNotNull = async (p: Promise<unknown>, column: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, column: e.column }).toEqual({ code: '23502', column });
};
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const uniq = (): string => `${++seq}-${randomUUID().slice(0, 8)}`;
const hex64 = (): string => randomBytes(32).toString('hex');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
let phoneSeq = 0;
const phoneNo = (): string => `+1202${String(++phoneSeq).padStart(7, '0')}`;

type Db = pg.Pool | pg.PoolClient;

/** Runs the callback in one transaction on its own connection: COMMIT on success, ROLLBACK on any failure. */
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
const ACCOUNTS = 'identity.accounts';
const DEVICES = 'identity.account_devices';
const SESSIONS = 'identity.application_sessions';
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
/** Waits until nothing is blocked on a lock any more. */
async function noLockWaiters(): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n === 0) return;
    await sleep(20);
  }
  throw new Error('sessions are still blocked on a lock');
}

// ---------------------------------------------------------------- fixtures: accounts (the ID-001 shape, copied from phone-model.itest.ts)
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
const watermarkOf = async (accountId: string): Promise<string | null> =>
  (await q<{ w: string | null }>('SELECT sessions_not_before::text AS w FROM identity.accounts WHERE account_id = $1', [accountId]))[0]!.w;

// ---------------------------------------------------------------- fixtures: devices and sessions
interface Device {
  id: string;
  accountId: string;
  hash: string;
}
interface DeviceInput {
  id?: string;
  hash?: string;
  browser?: string;
  os?: string;
  deviceClass?: string;
  /** SQL expressions (timestamptz) for the timestamps; the database default applies when omitted */
  firstSeen?: string;
  lastSeen?: string;
  trustedAt?: string | null;
  trustedUntil?: string | null;
  removedAt?: string | null;
}
const insertDevice = async (accountId: string, o: DeviceInput = {}, db: Db = pool): Promise<Device> => {
  const hash = o.hash ?? hex64();
  const cols: string[] = ['account_id', 'device_hash', 'browser_family', 'os_family', 'device_class'];
  const vals: string[] = ['$1', '$2', '$3', '$4', '$5'];
  const params: unknown[] = [accountId, hash, o.browser ?? 'CHROME', o.os ?? 'MACOS', o.deviceClass ?? 'DESKTOP'];
  if (o.id) {
    cols.push('account_device_id');
    vals.push(`$${params.push(o.id)}`);
  }
  const exprs: [string, string | null | undefined][] = [
    ['first_seen_at', o.firstSeen],
    ['last_seen_at', o.lastSeen],
    ['trusted_at', o.trustedAt],
    ['trusted_until', o.trustedUntil],
    ['removed_at', o.removedAt],
  ];
  for (const [col, expr] of exprs) {
    if (expr === undefined) continue;
    cols.push(col);
    vals.push(expr === null ? 'NULL' : expr);
  }
  const r = await db.query(`INSERT INTO ${DEVICES} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING account_device_id`, params);
  return { id: r.rows[0].account_device_id as string, accountId, hash };
};
/** A trusted device (trusted now, for the given interval). */
const trustedDevice = (accountId: string, interval = '30 days') =>
  insertDevice(accountId, { trustedAt: 'clock_timestamp()', trustedUntil: `clock_timestamp() + interval '${interval}'` });
const freshDevice = async (): Promise<Device> => insertDevice(await makeAccount());

interface Session {
  id: string;
  accountId: string;
  sid: string;
}
interface SessionInput {
  id?: string;
  sid?: string;
  deviceId?: string | null;
  createdAt?: string;
  lastSeenAt?: string;
  revokedAt?: string | null;
  reason?: string | null;
}
const insertSession = async (accountId: string, o: SessionInput = {}, db: Db = pool): Promise<Session> => {
  const sid = o.sid ?? `sid-${uniq()}`;
  const cols: string[] = ['account_id', 'keycloak_session_id'];
  const vals: string[] = ['$1', '$2'];
  const params: unknown[] = [accountId, sid];
  if (o.id) {
    cols.push('application_session_id');
    vals.push(`$${params.push(o.id)}`);
  }
  if (o.deviceId !== undefined) {
    cols.push('account_device_id');
    vals.push(`$${params.push(o.deviceId)}`);
  }
  const exprs: [string, string | null | undefined][] = [
    ['created_at', o.createdAt],
    ['last_seen_at', o.lastSeenAt],
    ['revoked_at', o.revokedAt],
  ];
  for (const [col, expr] of exprs) {
    if (expr === undefined) continue;
    cols.push(col);
    vals.push(expr === null ? 'NULL' : expr);
  }
  if (o.reason !== undefined) {
    cols.push('revocation_reason');
    vals.push(o.reason === null ? 'NULL' : `$${params.push(o.reason)}`);
  }
  const r = await db.query(`INSERT INTO ${SESSIONS} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING application_session_id`, params);
  return { id: r.rows[0].application_session_id as string, accountId, sid };
};
const freshSession = async (): Promise<Session> => insertSession(await makeAccount());
/** The way the service revokes: reason and timestamp together, one statement. */
const revokeOn = (db: Db, sessionId: string, reason = 'REVOKED_BY_USER') =>
  db.query('UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = $2 WHERE application_session_id = $1', [
    sessionId,
    reason,
  ]);
const revoked = async (): Promise<Session> => {
  const s = await freshSession();
  await revokeOn(pool, s.id);
  return s;
};
const sessionRow = async (id: string) =>
  (
    await q<{
      account_id: string;
      keycloak_session_id: string;
      account_device_id: string | null;
      revoked: boolean;
      revocation_reason: string | null;
      last_seen_at: Date;
      created_at: Date;
    }>(
      'SELECT account_id, keycloak_session_id, account_device_id, revoked_at IS NOT NULL AS revoked, revocation_reason, last_seen_at, created_at FROM identity.application_sessions WHERE application_session_id = $1',
      [id],
    )
  )[0]!;
const deviceRow = async (id: string) =>
  (
    await q<{ trusted: boolean; removed: boolean; last_seen_at: Date; first_seen_at: Date; trusted_until: Date | null; trusted_at: Date | null }>(
      'SELECT trusted_until IS NOT NULL AS trusted, removed_at IS NOT NULL AS removed, last_seen_at, first_seen_at, trusted_until, trusted_at FROM identity.account_devices WHERE account_device_id = $1',
      [id],
    )
  )[0]!;

// ---------------------------------------------------------------- fixtures: audit rows
const CUSTOMER = async (): Promise<string> => (await q<{ role_id: string }>("SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER'"))[0]!.role_id;
interface AuditRefs {
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  session?: string | null;
  device?: string | null;
  changes?: string | null;
}
const insertAuditRow = (accountId: string, action: string, refs: AuditRefs = {}, db: Db = pool) =>
  db
    .query(
      `INSERT INTO ${AUDIT} (actor, action, account_id, role_id, email_contact_id, phone_contact_id, application_session_id, account_device_id, changes, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING audit_event_id`,
      [
        'test',
        action,
        accountId,
        refs.role ?? null,
        refs.email ?? null,
        refs.phone ?? null,
        refs.session ?? null,
        refs.device ?? null,
        refs.changes ?? null,
        'test-correlation',
      ],
    )
    .then((r) => r.rows[0].audit_event_id as string);
const pendingEmail = async (accountId: string): Promise<string> =>
  (
    await q<{ email_contact_id: string }>(
      "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED') RETURNING email_contact_id",
      [accountId, `audit-${uniq()}@example.test`],
    )
  )[0]!.email_contact_id;
const pendingPhone = async (accountId: string): Promise<string> =>
  (
    await q<{ phone_contact_id: string }>(
      "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED') RETURNING phone_contact_id",
      [accountId, phoneNo()],
    )
  )[0]!.phone_contact_id;
/** The valid references an action of any family needs (the family pairing CHECKs), created on the given account. */
async function refsFor(accountId: string, action: string): Promise<AuditRefs> {
  if (action.startsWith('ROLE_')) return { role: await CUSTOMER() };
  if (action.startsWith('EMAIL_')) return { email: await pendingEmail(accountId) };
  if (action.startsWith('PHONE_')) return { phone: await pendingPhone(accountId) };
  if (/^SESSION_/.test(action)) return { session: (await insertSession(accountId)).id };
  if (action.startsWith('DEVICE_')) return { device: (await insertDevice(accountId)).id };
  return {};
}

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null];
const DEVICE_COLUMNS: ColumnShape[] = [
  ['account_device_id', 'uuid', false, 'gen_random_uuid()'],
  ['account_id', 'uuid', false, null],
  ['device_hash', 'character', false, null],
  ['browser_family', 'text', false, null],
  ['os_family', 'text', false, null],
  ['device_class', 'text', false, null],
  ['first_seen_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['last_seen_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['trusted_at', 'timestamp with time zone', true, null],
  ['trusted_until', 'timestamp with time zone', true, null],
  ['removed_at', 'timestamp with time zone', true, null],
];
const SESSION_COLUMNS: ColumnShape[] = [
  ['application_session_id', 'uuid', false, 'gen_random_uuid()'],
  ['account_id', 'uuid', false, null],
  ['keycloak_session_id', 'text', false, null],
  ['account_device_id', 'uuid', true, null],
  ['created_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['last_seen_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['revoked_at', 'timestamp with time zone', true, null],
  ['revocation_reason', 'text', true, null],
];
const columnsOf = async (table: string): Promise<ColumnShape[]> =>
  (
    await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = $1 ORDER BY ordinal_position",
      [table],
    )
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default]);
const constraintsOf = async (
  table: string,
): Promise<{ conname: string; contype: string; confdeltype: string; confmatchtype: string; target: string | null }[]> =>
  q(
    `SELECT conname, contype, confdeltype, confmatchtype, confrelid::regclass::text AS target FROM pg_constraint
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

const DEVICE_CONSTRAINTS = [
  'c:ck_account_devices__browser_family',
  'c:ck_account_devices__device_class',
  'c:ck_account_devices__device_hash',
  'c:ck_account_devices__os_family',
  'c:ck_account_devices__removed_untrusted',
  'c:ck_account_devices__seen_order',
  'c:ck_account_devices__trust_pair',
  'c:ck_account_devices__trust_window',
  'f:fk_account_devices__account_id',
  'p:pk_account_devices',
  'u:uq_account_devices__account_device',
  'u:uq_account_devices__account_hash',
];
const SESSION_CONSTRAINTS = [
  'c:ck_application_sessions__keycloak_session_id',
  'c:ck_application_sessions__revocation_reason',
  'c:ck_application_sessions__revoked_pair',
  'c:ck_application_sessions__seen_order',
  'f:fk_application_sessions__account_device',
  'f:fk_application_sessions__account_id',
  'p:pk_application_sessions',
  'u:uq_application_sessions__account_session',
  'u:uq_application_sessions__keycloak_session',
];
const AUDIT_CONSTRAINTS_0012 = [
  'ck_account_audit_events__device',
  'ck_account_audit_events__session',
  'fk_account_audit_events__account_device',
  'fk_account_audit_events__account_session',
];

describe('A. schema shape: a registry of sessions and browsers that holds no token, no secret, no code, no address and no raw user agent', () => {
  it('adds exactly two tables to the identity schema (thirteen with 0012, fifteen after 0013, seventeen after 0014) and no sequence', async () => {
    const tables = await q<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity' AND table_type = 'BASE TABLE'",
    );
    expect(tables.map((r) => r.table_name).sort()).toEqual([
      'account_audit_events',
      'account_devices',
      'account_profiles',
      'account_roles',
      'account_section_roles',
      'account_sections',
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
    // the only sequence of the schema is the history sequence of 0009: both new tables use uuid keys
    expect(await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'S'")).toEqual([
      { relname: 'account_status_history_history_seq_seq' },
    ]);
  });

  it('creates no view, materialized view or partition in the identity schema (liveness is derived by the reader, there is no status table)', async () => {
    expect(
      await q(
        "SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind IN ('v', 'm', 'p')",
      ),
    ).toEqual([]);
  });

  it('has exactly the documented columns, types, nullability and defaults on account_devices', async () => {
    expect(await columnsOf('account_devices')).toEqual(DEVICE_COLUMNS);
  });

  it('has exactly the documented columns, types, nullability and defaults on application_sessions', async () => {
    expect(await columnsOf('application_sessions')).toEqual(SESSION_COLUMNS);
  });

  it('adds exactly one nullable timestamptz column (sessions_not_before, no default) to accounts and keeps the rest', async () => {
    expect(await columnsOf('accounts')).toEqual([
      ['account_id', 'uuid', false, 'gen_random_uuid()'],
      ['status', 'text', false, null],
      ['primary_role_id', 'uuid', true, null],
      ['created_at', 'timestamp with time zone', false, 'now()'],
      ['updated_at', 'timestamp with time zone', false, 'now()'],
      ['closed_at', 'timestamp with time zone', true, null],
      ['sessions_not_before', 'timestamp with time zone', true, null],
    ]);
  });

  it('adds exactly two nullable uuid columns (application_session_id, account_device_id) to the audit trail, after phone_contact_id, and keeps the rest (0013 appends consent_event_id)', async () => {
    const cols = await columnsOf('account_audit_events');
    expect(cols.map(([n, t, nullable]) => [n, t, nullable])).toEqual([
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
    // the two new references have no default: an audit row names a session or a device explicitly or not at all
    expect(cols.filter(([n]) => n === 'application_session_id' || n === 'account_device_id').map(([, , , d]) => d)).toEqual([null, null]);
  });

  it('stores the device hash as char(64) (exactly the hex length of an HMAC-SHA-256) and the Keycloak session id as unbounded text limited by a CHECK', async () => {
    const r = await q<{ table_name: string; column_name: string; character_maximum_length: number | null }>(
      "SELECT table_name, column_name, character_maximum_length FROM information_schema.columns WHERE table_schema = 'identity' AND column_name IN ('device_hash', 'keycloak_session_id') ORDER BY table_name, column_name",
    );
    expect(r).toEqual([
      { table_name: 'account_devices', column_name: 'device_hash', character_maximum_length: 64 },
      { table_name: 'application_sessions', column_name: 'keycloak_session_id', character_maximum_length: null },
    ]);
  });

  it('has exactly the documented constraints on account_devices (primary key, two uniques, one foreign key, eight checks: 12)', async () => {
    const c = await constraintsOf(DEVICES);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(DEVICE_CONSTRAINTS);
    expect(c).toHaveLength(12);
  });

  it('has exactly the documented constraints on application_sessions (primary key, two uniques, two foreign keys, four checks: 9)', async () => {
    const c = await constraintsOf(SESSIONS);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(SESSION_CONSTRAINTS);
    expect(c).toHaveLength(9);
  });

  it('adds exactly four constraints to the audit trail (two composite foreign keys, two pairing checks; 0013 adds two more, tested in consent-model.itest.ts) and keeps the action CHECK under its name', async () => {
    const names = (await constraintsOf(AUDIT)).map((r) => r.conname);
    for (const n of AUDIT_CONSTRAINTS_0012) expect(names, n).toContain(n);
    expect(names).toContain('ck_account_audit_events__action');
    expect(names.sort()).toEqual([
      'ck_account_audit_events__action',
      'ck_account_audit_events__actor',
      'ck_account_audit_events__changes_object',
      'ck_account_audit_events__consent_event',
      'ck_account_audit_events__device',
      'ck_account_audit_events__email_contact',
      'ck_account_audit_events__phone_contact',
      'ck_account_audit_events__role',
      'ck_account_audit_events__session',
      'fk_account_audit_events__account_consent_event',
      'fk_account_audit_events__account_device',
      'fk_account_audit_events__account_email_contact',
      'fk_account_audit_events__account_id',
      'fk_account_audit_events__account_phone_contact',
      'fk_account_audit_events__account_session',
      'fk_account_audit_events__role_id',
      'pk_account_audit_events',
    ]);
  });

  it('brings the identity schema to 155 primary key, unique, foreign key and check constraints (96 before 0012 plus 12 + 9 + 4, plus 20 from 0013, plus 14 from 0014)', async () => {
    const { n } = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace WHERE s.nspname = 'identity' AND c.contype IN ('p', 'u', 'f', 'c')",
      )
    )[0]!;
    expect(n).toBe(155);
    expect(DEVICE_CONSTRAINTS.length + SESSION_CONSTRAINTS.length + AUDIT_CONSTRAINTS_0012.length).toBe(25);
    expect(96 + 25 + 20 + 14).toBe(155);
  });

  it('declares every foreign key of the registry ON DELETE RESTRICT with the default MATCH SIMPLE, and no foreign key of the identity schema cascades', async () => {
    const mine = [
      ...(await constraintsOf(DEVICES)),
      ...(await constraintsOf(SESSIONS)),
      ...(await constraintsOf(AUDIT)).filter((r) => /account_(session|device)$/.test(r.conname)),
    ].filter((r) => r.contype === 'f');
    expect(mine.map((r) => [r.conname, r.confdeltype, r.confmatchtype, r.target]).sort()).toEqual(
      [
        ['fk_account_devices__account_id', 'r', 's', 'identity.accounts'],
        ['fk_application_sessions__account_id', 'r', 's', 'identity.accounts'],
        ['fk_application_sessions__account_device', 'r', 's', 'identity.account_devices'],
        ['fk_account_audit_events__account_session', 'r', 's', 'identity.application_sessions'],
        ['fk_account_audit_events__account_device', 'r', 's', 'identity.account_devices'],
      ].sort(),
    );
    const loose = await q(
      "SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'identity' AND c.contype = 'f' AND c.confdeltype <> 'r'",
    );
    expect(loose).toEqual([]);
  });

  it('makes the three cross-table foreign keys COMPOSITE on (account_id, id): a row can only name a session or device of its own account', async () => {
    expect(await constraintDef('fk_application_sessions__account_device')).toBe(
      'FOREIGN KEY (account_id, account_device_id) REFERENCES identity.account_devices(account_id, account_device_id) ON DELETE RESTRICT',
    );
    expect(await constraintDef('fk_account_audit_events__account_session')).toBe(
      'FOREIGN KEY (account_id, application_session_id) REFERENCES identity.application_sessions(account_id, application_session_id) ON DELETE RESTRICT',
    );
    expect(await constraintDef('fk_account_audit_events__account_device')).toBe(
      'FOREIGN KEY (account_id, account_device_id) REFERENCES identity.account_devices(account_id, account_device_id) ON DELETE RESTRICT',
    );
    // no single-column foreign key to the new primary keys exists anywhere: nothing can reference a session or device without its account
    expect(
      await q(
        `SELECT conname FROM pg_constraint WHERE contype = 'f' AND confrelid IN ('identity.account_devices'::regclass, 'identity.application_sessions'::regclass)
            AND array_length(conkey, 1) = 1`,
      ),
    ).toEqual([]);
    expect(await constraintDef('fk_account_devices__account_id')).toBe('FOREIGN KEY (account_id) REFERENCES identity.accounts(account_id) ON DELETE RESTRICT');
    expect(await constraintDef('fk_application_sessions__account_id')).toBe(
      'FOREIGN KEY (account_id) REFERENCES identity.accounts(account_id) ON DELETE RESTRICT',
    );
  });

  it('defines the unique keys that the composite foreign keys target and the one-row-per-Keycloak-session rule', async () => {
    expect(await constraintDef('uq_account_devices__account_device')).toBe('UNIQUE (account_id, account_device_id)');
    expect(await constraintDef('uq_account_devices__account_hash')).toBe('UNIQUE (account_id, device_hash)');
    expect(await constraintDef('uq_application_sessions__account_session')).toBe('UNIQUE (account_id, application_session_id)');
    expect(await constraintDef('uq_application_sessions__keycloak_session')).toBe('UNIQUE (keycloak_session_id)');
  });

  it('CHECKs the device hash to 64 lowercase hex characters (catalog)', async () => {
    expect(await constraintDef('ck_account_devices__device_hash')).toContain('^[0-9a-f]{64}$');
  });

  it('CHECKs the three coarse vocabularies to exactly the contract lists (catalog), so the database and the API cannot drift', async () => {
    const vocab = async (name: string): Promise<string[]> => [...(await constraintDef(name)).matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);
    expect(await vocab('ck_account_devices__browser_family')).toEqual([...BROWSER_FAMILIES]);
    expect(await vocab('ck_account_devices__os_family')).toEqual([...OS_FAMILIES]);
    expect(await vocab('ck_account_devices__device_class')).toEqual([...DEVICE_CLASSES]);
    expect(await vocab('ck_application_sessions__revocation_reason')).toEqual([...SESSION_REVOCATION_REASONS]);
  });

  it('CHECKs the Keycloak session id to 1 to 100 characters without whitespace or control characters (catalog)', async () => {
    const def = await constraintDef('ck_application_sessions__keycloak_session_id');
    expect(def).toMatch(/length\(keycloak_session_id\) >= 1/);
    expect(def).toMatch(/length\(keycloak_session_id\) <= 100/);
    expect(def).toContain('u0001');
    expect(def).toContain('u0020');
    expect(def).toContain('u007F');
  });

  it('has exactly the documented indexes on account_devices: only the keys (the device list of one account needs no further index)', async () => {
    const idx = await indexesOf('account_devices');
    expect(idx.map((r) => r.indexname)).toEqual(['pk_account_devices', 'uq_account_devices__account_device', 'uq_account_devices__account_hash']);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.uq_account_devices__account_hash).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id, device_hash\)$/);
    expect(def.uq_account_devices__account_device).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id, account_device_id\)$/);
  });

  it('has exactly the documented indexes on application_sessions: two keys, the Keycloak session lookup and two PARTIAL indexes', async () => {
    const idx = await indexesOf('application_sessions');
    expect(idx.map((r) => r.indexname)).toEqual([
      'idx_application_sessions__account_live',
      'idx_application_sessions__device',
      'pk_application_sessions',
      'uq_application_sessions__account_session',
      'uq_application_sessions__keycloak_session',
    ]);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.uq_application_sessions__keycloak_session).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(keycloak_session_id\)$/);
    expect(def.uq_application_sessions__account_session).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id, application_session_id\)$/);
    // keyed on account_id ONLY: last_seen_at is written once a minute per session on the request path and an indexed column would make every touch a non-HOT update
    expect(def.idx_application_sessions__account_live).toMatch(/^CREATE INDEX .* USING btree \(account_id\) WHERE \(revoked_at IS NULL\)$/);
    expect(def.idx_application_sessions__device).toMatch(
      /^CREATE INDEX .* USING btree \(account_id, account_device_id\) WHERE \(account_device_id IS NOT NULL\)$/,
    );
  });

  it('has nothing speculative: no index on revoked_at, revocation_reason, created_at, the trust or removal columns, the families, the hash alone or the session id alone', async () => {
    const rows = await q<{ table_name: string; index_name: string; column_name: string }>(
      `SELECT t.relname AS table_name, i.relname AS index_name, a.attname AS column_name
         FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
        WHERE n.nspname = 'identity' AND t.relname IN ('account_devices', 'application_sessions') ORDER BY 1, 2, 3`,
    );
    const indexed = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    expect([...indexed].sort()).toEqual([
      'account_devices.account_device_id',
      'account_devices.account_id',
      'account_devices.device_hash',
      'application_sessions.account_device_id',
      'application_sessions.account_id',
      'application_sessions.application_session_id',
      'application_sessions.keycloak_session_id',
    ]);
    // in particular NOT last_seen_at: the once-a-minute touch must stay a HOT update
    expect(indexed.has('application_sessions.last_seen_at')).toBe(false);
    // the two non-constraint indexes are the only plain ones, and both are partial (a revoked row is never read on those paths)
    const plain = await q<{ index_name: string; partial: boolean }>(
      `SELECT i.relname AS index_name, x.indpred IS NOT NULL AS partial FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
        WHERE t.relname IN ('account_devices', 'application_sessions') AND NOT x.indisunique AND NOT x.indisprimary ORDER BY 1`,
    );
    expect(plain).toEqual([
      { index_name: 'idx_application_sessions__account_live', partial: true },
      { index_name: 'idx_application_sessions__device', partial: true },
    ]);
  });

  it('adds no index ON the new audit columns and none to accounts for the watermark (the per-account audit index serves the timeline; nothing filters by them)', async () => {
    for (const t of ['account_audit_events', 'accounts']) {
      const idx = await indexesOf(t);
      expect(
        idx.filter((r) => /application_session_id|account_device_id|sessions_not_before/.test(r.indexdef)),
        t,
      ).toEqual([]);
    }
    // the one extra index of 0012 is the PARTIAL security-state index (tested below); nothing else was added
    expect((await indexesOf('account_audit_events')).map((r) => r.indexname)).toEqual([
      'idx_account_audit_events__account',
      'idx_account_audit_events__account_security_state',
      'pk_account_audit_events',
    ]);
  });

  it('wires one guard per new table (a row guard BEFORE insert/update/delete) and the UPDATE OF trigger of the watermark, and no deferred trigger', async () => {
    const devices = await triggersOf(DEVICES);
    expect(devices.map((t) => t.tgname)).toEqual(['trg_account_devices__guard']);
    expect(devices[0]!.def).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON identity\.account_devices FOR EACH ROW EXECUTE FUNCTION identity\.guard_account_devices\(\)/,
    );
    const sessions = await triggersOf(SESSIONS);
    expect(sessions.map((t) => t.tgname)).toEqual(['trg_application_sessions__guard']);
    expect(sessions[0]!.def).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON identity\.application_sessions FOR EACH ROW EXECUTE FUNCTION identity\.guard_application_sessions\(\)/,
    );
    const accounts = await triggersOf(ACCOUNTS);
    const wm = accounts.filter((t) => t.tgname.includes('sessions_not_before'));
    expect(wm.map((t) => t.tgname)).toEqual(['trg_accounts__sessions_not_before']);
    expect(wm[0]!.def).toMatch(/BEFORE UPDATE OF sessions_not_before ON identity\.accounts FOR EACH ROW/);
    expect(wm[0]!.def).toMatch(/WHEN \(\(old\.sessions_not_before IS DISTINCT FROM new\.sessions_not_before\)\)/i);
    expect(wm[0]!.def).toMatch(/EXECUTE FUNCTION identity\.guard_accounts_sessions_not_before\(\)/);
    // the original account guard is untouched and still fires first (alphabetical order of trigger names)
    expect(accounts.map((t) => t.tgname).indexOf('trg_accounts__guard')).toBeLessThan(
      accounts.map((t) => t.tgname).indexOf('trg_accounts__sessions_not_before'),
    );
    expect(devices.concat(sessions).filter((t) => /CONSTRAINT TRIGGER|DEFERRABLE/.test(t.def))).toEqual([]);
  });

  it('leaves the append-only trigger of the audit trail in force and adds no other trigger to it', async () => {
    const audit = await triggersOf(AUDIT);
    expect(audit.map((t) => t.tgname)).toEqual(['trg_account_audit_events__immutable']);
    expect(audit[0]!.def).toMatch(/BEFORE DELETE OR UPDATE ON identity\.account_audit_events FOR EACH ROW EXECUTE FUNCTION identity\.forbid_mutation\(\)/);
  });

  it('defines the three guard functions as plain (not SECURITY DEFINER) plpgsql in the identity schema', async () => {
    const rows = await q<{ proname: string; lang: string; secdef: boolean }>(
      `SELECT p.proname, l.lanname AS lang, p.prosecdef AS secdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'identity' AND p.proname IN ('guard_account_devices', 'guard_application_sessions', 'guard_accounts_sessions_not_before') ORDER BY 1`,
    );
    expect(rows).toEqual([
      { proname: 'guard_account_devices', lang: 'plpgsql', secdef: false },
      { proname: 'guard_accounts_sessions_not_before', lang: 'plpgsql', secdef: false },
      { proname: 'guard_application_sessions', lang: 'plpgsql', secdef: false },
    ]);
  });

  it('starts empty: the migration seeds configuration and content only, never a device, a session, an audit row, a watermark or an outbox event', async () => {
    const fresh = await createIsolatedDatabase();
    try {
      const c = new pg.Client({ connectionString: fresh.url });
      await c.connect();
      try {
        for (const t of ['identity.account_devices', 'identity.application_sessions', 'identity.account_audit_events', 'identity.accounts'])
          expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
        expect((await c.query("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.session%'")).rows[0].n).toBe(
          0,
        );
      } finally {
        await c.end();
      }
    } finally {
      await fresh.drop();
    }
  });
});

// ====================================================================== B. account_devices constraints
type Attempt = () => Promise<unknown>;
interface ConstraintCase {
  constraint: string;
  label: string;
  attempt: Attempt;
}
const bad = (constraint: string, label: string, attempt: Attempt): ConstraintCase => ({ constraint, label, attempt });
const hashOf = (hex: string): { hash: string } => ({ hash: hex });

const BAD_HASHES: [label: string, value: string][] = [
  ['upper-case hex', hex64().toUpperCase().replace(/[0-9]/g, 'A')],
  ['a mixed-case hex', `A${hex64().slice(1)}`],
  ['63 hex characters', hex64().slice(1)],
  ['an empty string (padded with spaces by char(64))', ''],
  ['a single character (padded with spaces)', 'a'],
  ['a non-hex letter g', `g${hex64().slice(1)}`],
  ['a non-hex letter z in the last place', `${hex64().slice(0, 63)}z`],
  ['a 0x prefix (62 hex characters)', `0x${hex64().slice(2)}`],
  ['a leading space', ` ${hex64().slice(1)}`],
  ['a trailing space', `${hex64().slice(1)} `],
  ['an inner space', `${hex64().slice(0, 30)} ${hex64().slice(0, 33)}`],
  ['a trailing line feed', `${hex64().slice(1)}${ch(0x0a)}`],
  ['a leading line feed', `${ch(0x0a)}${hex64().slice(1)}`],
  ['a tab', `${hex64().slice(0, 31)}${ch(0x09)}${hex64().slice(0, 32)}`],
  ['dashes (a UUID-like value, 36 characters)', randomUUID()],
  ['base64url (a 43-character device secret instead of a hash)', randomBytes(32).toString('base64url')],
  ['base64 padding characters', `${randomBytes(32).toString('base64').slice(0, 63)}=`],
  ['full-width digits', ch(0xff10).repeat(64)],
  ['Arabic-Indic digits', ch(0x660).repeat(64)],
  ['a zero-width space', `${hex64().slice(1, 63)}${ch(0x200b)}a`],
  ['an emoji', `${hex64().slice(0, 62)}${ch(0x1f600)}`],
];
const BAD_FAMILIES: [label: string, value: string][] = [
  ['an unknown value', 'NETSCAPE'],
  ['a lower-case value', 'chrome'],
  ['a mixed-case value', 'Chrome'],
  ['an empty value', ''],
  ['a blank value', ' '],
  ['a padded value', 'CHROME '],
  ['a plural', 'CHROMES'],
  ['the user agent itself', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'],
];

const DEVICE_CASES: ConstraintCase[] = [
  bad('pk_account_devices', 'a duplicate account_device_id', async () => {
    const d = await freshDevice();
    await insertDevice(await makeAccount(), { id: d.id });
  }),
  bad('fk_account_devices__account_id', 'an account that does not exist', () => insertDevice(randomUUID())),
  bad('ck_account_devices__browser_family', 'the OS vocabulary value WINDOWS', async () => insertDevice(await makeAccount(), { browser: 'WINDOWS' })),
  bad('ck_account_devices__os_family', 'the browser vocabulary value CHROME', async () => insertDevice(await makeAccount(), { os: 'CHROME' })),
  bad('ck_account_devices__device_class', 'the browser vocabulary value FIREFOX', async () => insertDevice(await makeAccount(), { deviceClass: 'FIREFOX' })),
  ...BAD_FAMILIES.map(([label, value]) =>
    bad('ck_account_devices__browser_family', `a browser family that is ${label}`, async () => insertDevice(await makeAccount(), { browser: value })),
  ),
  ...BAD_FAMILIES.map(([label, value]) =>
    bad('ck_account_devices__os_family', `an OS family that is ${label}`, async () => insertDevice(await makeAccount(), { os: value })),
  ),
  ...BAD_FAMILIES.map(([label, value]) =>
    bad('ck_account_devices__device_class', `a device class that is ${label}`, async () => insertDevice(await makeAccount(), { deviceClass: value })),
  ),
  ...BAD_HASHES.map(([label, value]) =>
    bad('ck_account_devices__device_hash', `a device hash with ${label}`, async () => insertDevice(await makeAccount(), hashOf(value))),
  ),
  bad('ck_account_devices__device_hash', 'an update to a malformed hash (the guard reports a changed hash first, so the guard is bypassed)', async () => {
    const d = await freshDevice();
    await isolated(noTriggers(DEVICES), "UPDATE identity.account_devices SET device_hash = 'XYZ' WHERE account_device_id = $1", [d.id]);
  }),
  bad('ck_account_devices__seen_order', 'last_seen_at before first_seen_at (insert)', async () =>
    insertDevice(await makeAccount(), { firstSeen: 'clock_timestamp()', lastSeen: "clock_timestamp() - interval '1 second'" }),
  ),
  bad('ck_account_devices__seen_order', 'last_seen_at one microsecond before first_seen_at', async () =>
    insertDevice(await makeAccount(), { firstSeen: "timestamptz '2026-01-01 00:00:00.000001+00'", lastSeen: "timestamptz '2026-01-01 00:00:00+00'" }),
  ),
  bad('ck_account_devices__trust_pair', 'trusted_at without trusted_until', async () => insertDevice(await makeAccount(), { trustedAt: 'clock_timestamp()' })),
  bad('ck_account_devices__trust_pair', 'trusted_until without trusted_at', async () =>
    insertDevice(await makeAccount(), { trustedUntil: "clock_timestamp() + interval '1 day'" }),
  ),
  bad('ck_account_devices__trust_pair', 'clearing only trusted_until of a trusted device', async () => {
    const d = await trustedDevice(await makeAccount());
    await run('UPDATE identity.account_devices SET trusted_until = NULL WHERE account_device_id = $1', [d.id]);
  }),
  bad('ck_account_devices__trust_pair', 'clearing only trusted_at of a trusted device', async () => {
    const d = await trustedDevice(await makeAccount());
    await run('UPDATE identity.account_devices SET trusted_at = NULL WHERE account_device_id = $1', [d.id]);
  }),
  bad('ck_account_devices__trust_window', 'trusted_until equal to trusted_at', async () =>
    insertDevice(await makeAccount(), { trustedAt: "timestamptz '2026-06-01 12:00:00+00'", trustedUntil: "timestamptz '2026-06-01 12:00:00+00'" }),
  ),
  bad('ck_account_devices__trust_window', 'trusted_until one microsecond before trusted_at', async () =>
    insertDevice(await makeAccount(), { trustedAt: "timestamptz '2026-06-01 12:00:00.000001+00'", trustedUntil: "timestamptz '2026-06-01 12:00:00+00'" }),
  ),
  bad('ck_account_devices__trust_window', 'trusted_until a day before trusted_at', async () =>
    insertDevice(await makeAccount(), { trustedAt: 'clock_timestamp()', trustedUntil: "clock_timestamp() - interval '1 day'" }),
  ),
  bad('ck_account_devices__removed_untrusted', 'removing a device that is still trusted', async () => {
    const d = await trustedDevice(await makeAccount());
    await run('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
  }),
  bad(
    'ck_account_devices__removed_untrusted',
    'a device born removed AND trusted (guard bypassed: the insert guard refuses a removed device first)',
    async () => {
      const a = await makeAccount();
      await isolated(
        noTriggers(DEVICES),
        `INSERT INTO identity.account_devices (account_id, device_hash, browser_family, os_family, device_class, trusted_at, trusted_until, removed_at)
       VALUES ($1, $2, 'CHROME', 'MACOS', 'DESKTOP', clock_timestamp(), clock_timestamp() + interval '1 day', clock_timestamp())`,
        [a, hex64()],
      );
    },
  ),
];

describe('B. account_devices constraints reject bad data, by constraint name', () => {
  it.each(DEVICE_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it('refuses the same (account, hash) twice with the named unique index, and the same hash on another account is a different browser row', async () => {
    const a = await makeAccount();
    const hash = hex64();
    await insertDevice(a, { hash });
    await expectUnique(insertDevice(a, { hash }), 'uq_account_devices__account_hash');
    // a different browser family / OS does not make it a different browser: the hash alone identifies the cookie
    await expectUnique(insertDevice(a, { hash, browser: 'FIREFOX', os: 'LINUX', deviceClass: 'MOBILE' }), 'uq_account_devices__account_hash');
    const other = await makeAccount();
    const second = await insertDevice(other, { hash });
    expect(second.accountId).toBe(other);
    expect(await count(DEVICES, 'device_hash = $1', [hash])).toBe(2);
  });

  it('refuses a second row with the same (account, account_device_id) with the named unique constraint (primary key dropped, guards off, this transaction only)', async () => {
    const d = await freshDevice();
    const e = await fail(
      isolated(
        [...noTriggers(DEVICES), 'ALTER TABLE identity.account_devices DROP CONSTRAINT pk_account_devices CASCADE'],
        `INSERT INTO identity.account_devices (account_device_id, account_id, device_hash, browser_family, os_family, device_class) VALUES ($1, $2, $3, 'CHROME', 'MACOS', 'DESKTOP')`,
        [d.id, d.accountId, hex64()],
      ),
    );
    expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23505', constraint: 'uq_account_devices__account_device' });
  });

  it('refuses a 65-character hash as too long for char(64) (SQLSTATE 22001, not silently truncated)', async () => {
    const e = await fail(insertDevice(await makeAccount(), hashOf(`${hex64()}a`)));
    expect(e.code).toBe('22001');
  });

  it.each(['account_id', 'device_hash', 'browser_family', 'os_family', 'device_class', 'first_seen_at', 'last_seen_at'])(
    'requires %s (NOT NULL)',
    async (column) => {
      const a = await makeAccount();
      const values: Record<string, string> = {
        account_id: `'${a}'`,
        device_hash: `'${hex64()}'`,
        browser_family: "'CHROME'",
        os_family: "'MACOS'",
        device_class: "'DESKTOP'",
        first_seen_at: 'clock_timestamp()',
        last_seen_at: 'clock_timestamp()',
      };
      values[column] = 'NULL';
      const cols = Object.keys(values);
      await expectNotNull(run(`INSERT INTO ${DEVICES} (${cols.join(', ')}) VALUES (${cols.map((c) => values[c]).join(', ')})`), column);
    },
  );

  it.each(BROWSER_FAMILIES)('accepts the browser family %s', async (browser) => {
    const d = await insertDevice(await makeAccount(), { browser });
    expect(await q('SELECT browser_family FROM identity.account_devices WHERE account_device_id = $1', [d.id])).toEqual([{ browser_family: browser }]);
  });
  it.each(OS_FAMILIES)('accepts the OS family %s', async (os) => {
    const d = await insertDevice(await makeAccount(), { os });
    expect(await q('SELECT os_family FROM identity.account_devices WHERE account_device_id = $1', [d.id])).toEqual([{ os_family: os }]);
  });
  it.each(DEVICE_CLASSES)('accepts the device class %s', async (deviceClass) => {
    const d = await insertDevice(await makeAccount(), { deviceClass });
    expect(await q('SELECT device_class FROM identity.account_devices WHERE account_device_id = $1', [d.id])).toEqual([{ device_class: deviceClass }]);
  });

  it.each([
    ['all zeros', '0'.repeat(64)],
    ['all f', 'f'.repeat(64)],
    ['digits only', '0123456789'.repeat(6) + '0123'],
    ['a SHA-256 of text', sha256('x')],
    ['a random 32-byte hex', hex64()],
  ])('accepts a device hash that is %s', async (_label, hash) => {
    const d = await insertDevice(await makeAccount(), { hash });
    expect(await q('SELECT device_hash FROM identity.account_devices WHERE account_device_id = $1', [d.id])).toEqual([{ device_hash: hash }]);
  });

  it('defaults a new device to untrusted and not removed, with both seen timestamps set by the database clock (last_seen_at never before first_seen_at)', async () => {
    const d = await freshDevice();
    expect(
      await q(
        'SELECT trusted_at, trusted_until, removed_at, last_seen_at >= first_seen_at AS ordered, first_seen_at <= clock_timestamp() AS past FROM identity.account_devices WHERE account_device_id = $1',
        [d.id],
      ),
    ).toEqual([{ trusted_at: null, trusted_until: null, removed_at: null, ordered: true, past: true }]);
  });

  it('stores the hash exactly as given (char(64) with 64 characters has no padding and compares as text)', async () => {
    const hash = hex64();
    const d = await insertDevice(await makeAccount(), { hash });
    const r = await q<{ device_hash: string; len: number; same: boolean }>(
      'SELECT device_hash, length(device_hash) AS len, device_hash::text = $2 AS same FROM identity.account_devices WHERE account_device_id = $1',
      [d.id, hash],
    );
    expect(r).toEqual([{ device_hash: hash, len: 64, same: true }]);
  });

  it('accepts a trusted device with a window of one microsecond, of 365 days and of ten years (the length of the window is configuration, never a schema limit)', async () => {
    for (const interval of ['1 microsecond', '365 days', '3650 days']) {
      const d = await trustedDevice(await makeAccount(), interval);
      expect((await deviceRow(d.id)).trusted).toBe(true);
    }
  });

  it('accepts a device whose first and last seen timestamps are equal (the boundary of the seen-order check)', async () => {
    const d = await insertDevice(await makeAccount(), { firstSeen: "timestamptz '2026-01-01 00:00:00+00'", lastSeen: "timestamptz '2026-01-01 00:00:00+00'" });
    expect(await q('SELECT last_seen_at = first_seen_at AS same FROM identity.account_devices WHERE account_device_id = $1', [d.id])).toEqual([{ same: true }]);
  });
});

// ====================================================================== C. application_sessions constraints
const BAD_SIDS: [label: string, value: string][] = [
  ['an empty string', ''],
  ['101 characters (one too many)', 'a'.repeat(101)],
  ['300 characters', 'a'.repeat(300)],
  ['a single space', ' '],
  ['a leading space', ' abc'],
  ['a trailing space', 'abc '],
  ['an inner space', 'ab cd'],
  ['a tab', `ab${ch(0x09)}cd`],
  ['a line feed', `ab${ch(0x0a)}cd`],
  ['a trailing line feed', `abc${ch(0x0a)}`],
  ['a carriage return', `ab${ch(0x0d)}cd`],
  ['a vertical tab', `ab${ch(0x0b)}cd`],
  ['a form feed', `ab${ch(0x0c)}cd`],
  ['the control character SOH (0x01)', `ab${ch(0x01)}cd`],
  ['the unit separator (0x1f)', `ab${ch(0x1f)}cd`],
  ['DEL (0x7f)', `ab${ch(0x7f)}cd`],
  ['a 100-character value plus a space (length 101)', `${'a'.repeat(100)} `],
];
const GOOD_SIDS: [label: string, value: string][] = [
  ['a single character', 'a'],
  ['100 characters', 'a'.repeat(100)],
  ['a UUID (the usual Keycloak session id)', randomUUID()],
  ['punctuation that Keycloak never uses but the registry tolerates', 'a.b-c_d:e/f=g+h~i'],
  ['a tilde (0x7e, the last printable ASCII character)', 'a~'],
  ['an exclamation mark (0x21, the first printable ASCII character)', '!a'],
  ['100 multi-byte characters', ch(0xe9).repeat(100)],
];

const SESSION_CASES: ConstraintCase[] = [
  bad('pk_application_sessions', 'a duplicate application_session_id', async () => {
    const s = await freshSession();
    await insertSession(await makeAccount(), { id: s.id });
  }),
  bad('fk_application_sessions__account_id', 'an account that does not exist', () => insertSession(randomUUID())),
  bad('fk_application_sessions__account_device', 'a device that does not exist', async () => insertSession(await makeAccount(), { deviceId: randomUUID() })),
  bad('fk_application_sessions__account_device', "a device of ANOTHER account (a session cannot point at someone else's browser)", async () => {
    const foreign = await freshDevice();
    await insertSession(await makeAccount(), { deviceId: foreign.id });
  }),
  bad('fk_application_sessions__account_device', "attaching ANOTHER account's device to an existing session (update)", async () => {
    const s = await freshSession();
    const foreign = await freshDevice();
    await run('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, foreign.id]);
  }),
  ...BAD_SIDS.map(([label, value]) =>
    bad('ck_application_sessions__keycloak_session_id', `a Keycloak session id that is ${label}`, async () =>
      insertSession(await makeAccount(), { sid: value }),
    ),
  ),
  bad('ck_application_sessions__revocation_reason', 'an unknown reason on a revoked session (update)', async () => {
    const s = await freshSession();
    await run("UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'BOGUS' WHERE application_session_id = $1", [s.id]);
  }),
  bad('ck_application_sessions__revocation_reason', 'a lower-case reason', async () => {
    const s = await freshSession();
    await run("UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'sign_out' WHERE application_session_id = $1", [
      s.id,
    ]);
  }),
  bad('ck_application_sessions__revocation_reason', 'an empty reason', async () => {
    const s = await freshSession();
    await run("UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = '' WHERE application_session_id = $1", [s.id]);
  }),
  bad('ck_application_sessions__revocation_reason', 'a padded reason', async () => {
    const s = await freshSession();
    await run("UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT ' WHERE application_session_id = $1", [
      s.id,
    ]);
  }),
  bad('ck_application_sessions__revocation_reason', 'a reason that is a PLURAL of a real one', async () =>
    insertSession(await makeAccount(), { revokedAt: 'clock_timestamp()', reason: 'SIGN_OUTS' }),
  ),
  bad('ck_application_sessions__revocation_reason', 'the device-removal reason spelled DEVICE_REMOVAL', async () =>
    insertSession(await makeAccount(), { revokedAt: 'clock_timestamp()', reason: 'DEVICE_REMOVAL' }),
  ),
  bad('ck_application_sessions__revoked_pair', 'revoked_at without a reason (update)', async () => {
    const s = await freshSession();
    await run('UPDATE identity.application_sessions SET revoked_at = clock_timestamp() WHERE application_session_id = $1', [s.id]);
  }),
  bad('ck_application_sessions__revoked_pair', 'a reason without revoked_at (update)', async () => {
    const s = await freshSession();
    await run("UPDATE identity.application_sessions SET revocation_reason = 'SIGN_OUT' WHERE application_session_id = $1", [s.id]);
  }),
  bad('ck_application_sessions__revoked_pair', 'revoked_at without a reason (insert)', async () =>
    insertSession(await makeAccount(), { revokedAt: 'clock_timestamp()' }),
  ),
  bad('ck_application_sessions__revoked_pair', 'a reason without revoked_at (insert)', async () => insertSession(await makeAccount(), { reason: 'SIGN_OUT' })),
  bad('ck_application_sessions__seen_order', 'last_seen_at before created_at (insert)', async () =>
    insertSession(await makeAccount(), { createdAt: 'clock_timestamp()', lastSeenAt: "clock_timestamp() - interval '1 second'" }),
  ),
  bad('ck_application_sessions__seen_order', 'last_seen_at one microsecond before created_at', async () =>
    insertSession(await makeAccount(), { createdAt: "timestamptz '2026-01-01 00:00:00.000001+00'", lastSeenAt: "timestamptz '2026-01-01 00:00:00+00'" }),
  ),
  bad('ck_application_sessions__seen_order', 'revoked_at before created_at (insert)', async () =>
    insertSession(await makeAccount(), {
      createdAt: "timestamptz '2026-01-01 00:00:10+00'",
      lastSeenAt: "timestamptz '2026-01-01 00:00:10+00'",
      revokedAt: "timestamptz '2026-01-01 00:00:09+00'",
      reason: 'SIGN_OUT',
    }),
  ),
  bad('ck_application_sessions__seen_order', 'revoking a session at a moment before its creation (update)', async () => {
    const s = await freshSession();
    await run(
      "UPDATE identity.application_sessions SET revoked_at = created_at - interval '1 second', revocation_reason = 'SIGN_OUT' WHERE application_session_id = $1",
      [s.id],
    );
  }),
];

describe('C. application_sessions constraints reject bad data, by constraint name', () => {
  it.each(SESSION_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it('refuses the same Keycloak session id twice (the named unique index), also for another account: one session belongs to exactly one account', async () => {
    const a = await makeAccount();
    const sid = `sid-${uniq()}`;
    await insertSession(a, { sid });
    await expectUnique(insertSession(a, { sid }), 'uq_application_sessions__keycloak_session');
    await expectUnique(insertSession(await makeAccount(), { sid }), 'uq_application_sessions__keycloak_session');
    expect(await count(SESSIONS, 'keycloak_session_id = $1', [sid])).toBe(1);
  });

  it('treats a Keycloak session id as case-sensitive text (two ids that differ only in case are two sessions) and never trims it', async () => {
    const a = await makeAccount();
    const base = `Sid-${uniq()}`;
    await insertSession(a, { sid: base });
    await insertSession(a, { sid: base.toLowerCase() });
    expect(await count(SESSIONS, 'lower(keycloak_session_id) = lower($1)', [base])).toBe(2);
  });

  it('refuses a second row with the same (account, application_session_id) with the named unique constraint (primary key dropped, guards off, this transaction only)', async () => {
    const s = await freshSession();
    const e = await fail(
      isolated(
        [...noTriggers(SESSIONS), 'ALTER TABLE identity.application_sessions DROP CONSTRAINT pk_application_sessions CASCADE'],
        `INSERT INTO identity.application_sessions (application_session_id, account_id, keycloak_session_id) VALUES ($1, $2, $3)`,
        [s.id, s.accountId, `sid-${uniq()}`],
      ),
    );
    expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23505', constraint: 'uq_application_sessions__account_session' });
  });

  it.each(['account_id', 'keycloak_session_id', 'created_at', 'last_seen_at'])('requires %s (NOT NULL)', async (column) => {
    const a = await makeAccount();
    const values: Record<string, string> = {
      account_id: `'${a}'`,
      keycloak_session_id: `'sid-${uniq()}'`,
      created_at: 'clock_timestamp()',
      last_seen_at: 'clock_timestamp()',
    };
    values[column] = 'NULL';
    const cols = Object.keys(values);
    await expectNotNull(run(`INSERT INTO ${SESSIONS} (${cols.join(', ')}) VALUES (${cols.map((c) => values[c]).join(', ')})`), column);
  });

  it.each(GOOD_SIDS)('accepts a Keycloak session id that is %s', async (_label, sid) => {
    const s = await insertSession(await makeAccount(), { sid });
    expect((await sessionRow(s.id)).keycloak_session_id).toBe(sid);
  });

  it.each(SESSION_REVOCATION_REASONS)('accepts the revocation reason %s together with revoked_at', async (reason) => {
    const s = await freshSession();
    await revokeOn(pool, s.id, reason);
    expect(await sessionRow(s.id)).toMatchObject({ revoked: true, revocation_reason: reason });
  });

  it('defaults a new session to live and device-less, created and last seen at the database clock', async () => {
    const s = await freshSession();
    expect(
      await q(
        'SELECT account_device_id, revoked_at, revocation_reason, last_seen_at >= created_at AS ordered, created_at <= clock_timestamp() AS past FROM identity.application_sessions WHERE application_session_id = $1',
        [s.id],
      ),
    ).toEqual([{ account_device_id: null, revoked_at: null, revocation_reason: null, ordered: true, past: true }]);
  });

  it("accepts a session of the same account's device, a session with no device, and several sessions on one device", async () => {
    const a = await makeAccount();
    const d = await insertDevice(a);
    const s1 = await insertSession(a, { deviceId: d.id });
    const s2 = await insertSession(a, { deviceId: d.id });
    const s3 = await insertSession(a);
    expect((await sessionRow(s1.id)).account_device_id).toBe(d.id);
    expect((await sessionRow(s2.id)).account_device_id).toBe(d.id);
    expect((await sessionRow(s3.id)).account_device_id).toBeNull();
    expect(await count(SESSIONS, 'account_device_id = $1', [d.id])).toBe(2);
  });

  it('accepts many sessions of one account (a person may be signed in on several browsers)', async () => {
    const a = await makeAccount();
    for (let n = 0; n < 12; n++) await insertSession(a);
    expect(await count(SESSIONS, 'account_id = $1', [a])).toBe(12);
  });
});

// ====================================================================== D. device guards
describe('D. device guards: deletion, immutability, monotonic last_seen_at, terminal removal, closed accounts', () => {
  it('refuses to delete a device, trusted or not, removed or not, with or without sessions (NOT_DELETABLE)', async () => {
    const plain = await freshDevice();
    const trusted = await trustedDevice(await makeAccount());
    const removed = await freshDevice();
    await run('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [removed.id]);
    const withSession = await freshDevice();
    await insertSession(withSession.accountId, { deviceId: withSession.id });
    for (const d of [plain, trusted, removed, withSession]) {
      await expectRule(run('DELETE FROM identity.account_devices WHERE account_device_id = $1', [d.id]), 'NOT_DELETABLE');
      expect(await count(DEVICES, 'account_device_id = $1', [d.id])).toBe(1);
    }
    await expectRule(run('DELETE FROM identity.account_devices WHERE account_id = $1', [plain.accountId]), 'NOT_DELETABLE');
  });

  it('refuses TRUNCATE-free bulk deletion too: a DELETE of every row of the table fails on the first row and removes nothing', async () => {
    const before = await count(DEVICES);
    await expectRule(run('DELETE FROM identity.account_devices'), 'NOT_DELETABLE');
    expect(await count(DEVICES)).toBe(before);
  });

  const IMMUTABLE_DEVICE_UPDATES: [label: string, set: (other: { account: string }) => string][] = [
    ['account_device_id', () => 'account_device_id = gen_random_uuid()'],
    ['account_id (moving the browser to another account)', ({ account }) => `account_id = '${account}'`],
    ['device_hash (to a valid other hash)', () => `device_hash = '${hex64()}'`],
    ['device_hash (to the same hash upper-cased is also a change)', () => "device_hash = repeat('a', 64)"],
    ['browser_family (to another valid family)', () => "browser_family = 'FIREFOX'"],
    ['os_family (to another valid family)', () => "os_family = 'LINUX'"],
    ['device_class (to another valid class)', () => "device_class = 'MOBILE'"],
    ['first_seen_at (later)', () => "first_seen_at = first_seen_at + interval '1 second'"],
    ['first_seen_at (earlier)', () => "first_seen_at = first_seen_at - interval '1 second'"],
  ];
  it.each(IMMUTABLE_DEVICE_UPDATES)('refuses to change %s (DEVICE_IMMUTABLE)', async (_label, set) => {
    const d = await insertDevice(await makeAccount(), { browser: 'CHROME', os: 'MACOS', deviceClass: 'DESKTOP', hash: 'b'.repeat(64) });
    const other = await makeAccount();
    const before = await q('SELECT * FROM identity.account_devices WHERE account_device_id = $1', [d.id]);
    await expectRule(run(`UPDATE identity.account_devices SET ${set({ account: other })} WHERE account_device_id = $1`, [d.id]), 'DEVICE_IMMUTABLE');
    expect(await q('SELECT * FROM identity.account_devices WHERE account_device_id = $1', [d.id])).toEqual(before);
  });

  it('reports the immutability rule before the monotonic rule when one statement breaks both', async () => {
    const d = await freshDevice();
    await expectRule(
      run("UPDATE identity.account_devices SET os_family = 'LINUX', last_seen_at = last_seen_at - interval '1 hour' WHERE account_device_id = $1", [d.id]),
      'DEVICE_IMMUTABLE',
    );
  });

  it('keeps last_seen_at monotonic: moving it back by even one microsecond is refused (DEVICE_LAST_SEEN_MONOTONIC), equal and forward are accepted', async () => {
    const d = await insertDevice(await makeAccount(), { firstSeen: "timestamptz '2026-01-01 00:00:00+00'", lastSeen: "timestamptz '2026-01-01 00:10:00+00'" });
    await expectRule(
      run("UPDATE identity.account_devices SET last_seen_at = timestamptz '2026-01-01 00:09:59.999999+00' WHERE account_device_id = $1", [d.id]),
      'DEVICE_LAST_SEEN_MONOTONIC',
    );
    await expectRule(
      run("UPDATE identity.account_devices SET last_seen_at = timestamptz '2026-01-01 00:05:00+00' WHERE account_device_id = $1", [d.id]),
      'DEVICE_LAST_SEEN_MONOTONIC',
    );
    await run("UPDATE identity.account_devices SET last_seen_at = timestamptz '2026-01-01 00:10:00+00' WHERE account_device_id = $1", [d.id]);
    await run("UPDATE identity.account_devices SET last_seen_at = timestamptz '2026-01-01 00:10:00.000001+00' WHERE account_device_id = $1", [d.id]);
    await run("UPDATE identity.account_devices SET last_seen_at = timestamptz '2027-01-01 00:00:00+00' WHERE account_device_id = $1", [d.id]);
    expect((await q<{ t: string }>('SELECT last_seen_at::text AS t FROM identity.account_devices WHERE account_device_id = $1', [d.id]))[0]!.t).toBe(
      '2027-01-01 00:00:00+00',
    );
  });

  it('lets the service touch last_seen_at with GREATEST(...) without ever tripping the guard, whatever the order of the clocks', async () => {
    const d = await freshDevice();
    await run('UPDATE identity.account_devices SET last_seen_at = GREATEST(last_seen_at, clock_timestamp()) WHERE account_device_id = $1', [d.id]);
    await run("UPDATE identity.account_devices SET last_seen_at = GREATEST(last_seen_at, clock_timestamp() - interval '1 day') WHERE account_device_id = $1", [
      d.id,
    ]);
  });

  it('accepts a no-op update (nothing changes, nothing is refused)', async () => {
    const d = await trustedDevice(await makeAccount());
    await run('UPDATE identity.account_devices SET account_id = account_id, device_hash = device_hash WHERE account_device_id = $1', [d.id]);
  });

  it('trusts, extends, shortens, untrusts and re-trusts a device freely (the window is configuration; only removal is terminal)', async () => {
    const d = await freshDevice();
    const trust = (interval: string) =>
      run(
        `UPDATE identity.account_devices SET trusted_at = clock_timestamp(), trusted_until = clock_timestamp() + interval '${interval}' WHERE account_device_id = $1`,
        [d.id],
      );
    await trust('30 days');
    expect((await deviceRow(d.id)).trusted).toBe(true);
    await trust('60 days');
    await trust('1 day');
    await run('UPDATE identity.account_devices SET trusted_at = NULL, trusted_until = NULL WHERE account_device_id = $1', [d.id]);
    expect((await deviceRow(d.id)).trusted).toBe(false);
    await trust('30 days');
    expect((await deviceRow(d.id)).trusted).toBe(true);
  });

  it('removes a device the way the service does: trust cleared and removed_at set in ONE statement', async () => {
    const d = await trustedDevice(await makeAccount());
    await run('UPDATE identity.account_devices SET trusted_at = NULL, trusted_until = NULL, removed_at = clock_timestamp() WHERE account_device_id = $1', [
      d.id,
    ]);
    expect(await deviceRow(d.id)).toMatchObject({ trusted: false, removed: true });
  });

  describe('a removed device is terminal (DEVICE_REMOVED_TERMINAL)', () => {
    const removedDevice = async (): Promise<Device> => {
      const d = await freshDevice();
      await run('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
      return d;
    };
    it('cannot be trusted', async () => {
      const d = await removedDevice();
      await expectRule(
        run(
          "UPDATE identity.account_devices SET trusted_at = clock_timestamp(), trusted_until = clock_timestamp() + interval '30 days' WHERE account_device_id = $1",
          [d.id],
        ),
        'DEVICE_REMOVED_TERMINAL',
      );
      expect((await deviceRow(d.id)).trusted).toBe(false);
    });
    it('cannot be restored (removed_at back to NULL)', async () => {
      const d = await removedDevice();
      await expectRule(run('UPDATE identity.account_devices SET removed_at = NULL WHERE account_device_id = $1', [d.id]), 'DEVICE_REMOVED_TERMINAL');
      expect((await deviceRow(d.id)).removed).toBe(true);
    });
    it('cannot be removed at another moment (removed_at is written once)', async () => {
      const d = await removedDevice();
      await expectRule(
        run("UPDATE identity.account_devices SET removed_at = clock_timestamp() + interval '1 hour' WHERE account_device_id = $1", [d.id]),
        'DEVICE_REMOVED_TERMINAL',
      );
    });
    it('cannot be restored and trusted in one statement', async () => {
      const d = await removedDevice();
      await expectRule(
        run(
          "UPDATE identity.account_devices SET removed_at = NULL, trusted_at = clock_timestamp(), trusted_until = clock_timestamp() + interval '1 day' WHERE account_device_id = $1",
          [d.id],
        ),
        'DEVICE_REMOVED_TERMINAL',
      );
    });
    it('still reports an immutable-column change as DEVICE_IMMUTABLE (checked first)', async () => {
      const d = await removedDevice();
      await expectRule(run("UPDATE identity.account_devices SET browser_family = 'OTHER' WHERE account_device_id = $1", [d.id]), 'DEVICE_IMMUTABLE');
    });
    it('still lets last_seen_at move forward (it is not a trust or removal field), and refuses it moving back', async () => {
      const d = await removedDevice();
      await run("UPDATE identity.account_devices SET last_seen_at = clock_timestamp() + interval '1 minute' WHERE account_device_id = $1", [d.id]);
      await expectRule(
        run("UPDATE identity.account_devices SET last_seen_at = last_seen_at - interval '1 hour' WHERE account_device_id = $1", [d.id]),
        'DEVICE_LAST_SEEN_MONOTONIC',
      );
    });
    it('accepts a no-op update of a removed device', async () => {
      const d = await removedDevice();
      await run('UPDATE identity.account_devices SET removed_at = removed_at WHERE account_device_id = $1', [d.id]);
    });
    it('is never created removed (an INSERT with removed_at is refused), and a replacement browser is a new row', async () => {
      const a = await makeAccount();
      await expectRule(insertDevice(a, { removedAt: 'clock_timestamp()' }), 'DEVICE_REMOVED_TERMINAL');
      const old = await insertDevice(a);
      await run('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [old.id]);
      // the same cookie hash cannot come back as a second row (the unique key still holds the removed one): the service registers a NEW cookie
      await expectUnique(insertDevice(a, { hash: old.hash }), 'uq_account_devices__account_hash');
      const fresh = await insertDevice(a);
      expect((await deviceRow(fresh.id)).removed).toBe(false);
    });
  });

  describe('account status on insert (ACCOUNT_CLOSED)', () => {
    it.each(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'] as const)('accepts a device for a %s account', async (status) => {
      const a = await accountIn(status);
      const d = await insertDevice(a);
      expect((await deviceRow(d.id)).removed).toBe(false);
    });
    it('refuses a device for a CLOSED account (ACCOUNT_CLOSED)', async () => {
      const a = await accountIn('CLOSED');
      await expectRule(insertDevice(a), 'ACCOUNT_CLOSED');
      expect(await count(DEVICES, 'account_id = $1', [a])).toBe(0);
    });
    it('reports ACCOUNT_CLOSED before the born-removed rule', async () => {
      const a = await accountIn('CLOSED');
      await expectRule(insertDevice(a, { removedAt: 'clock_timestamp()' }), 'ACCOUNT_CLOSED');
    });
    it('still lets the devices of an account that was closed AFTER registering them change (untrust, remove, touch): only a new device is refused', async () => {
      const a = await makeAccount();
      const d = await trustedDevice(a);
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      await run('UPDATE identity.account_devices SET trusted_at = NULL, trusted_until = NULL, removed_at = clock_timestamp() WHERE account_device_id = $1', [
        d.id,
      ]);
      expect(await deviceRow(d.id)).toMatchObject({ trusted: false, removed: true });
      await expectRule(insertDevice(a), 'ACCOUNT_CLOSED');
    });
    it('keeps a device row after its account is closed (rows are never deleted and the foreign key restricts)', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      expect(await count(DEVICES, 'account_device_id = $1', [d.id])).toBe(1);
      await expectRule(run('DELETE FROM identity.accounts WHERE account_id = $1', [a]), 'NOT_DELETABLE');
    });
  });
});

// ====================================================================== E. session guards
describe('E. session guards: deletion, immutability, terminal revocation, the device set once, monotonic last_seen_at, closed accounts', () => {
  it('refuses to delete a session, live or revoked, with a device or without (NOT_DELETABLE)', async () => {
    const live = await freshSession();
    const gone = await revoked();
    const a = await makeAccount();
    const d = await insertDevice(a);
    const withDevice = await insertSession(a, { deviceId: d.id });
    for (const s of [live, gone, withDevice]) {
      await expectRule(run('DELETE FROM identity.application_sessions WHERE application_session_id = $1', [s.id]), 'NOT_DELETABLE');
      expect(await count(SESSIONS, 'application_session_id = $1', [s.id])).toBe(1);
    }
    const before = await count(SESSIONS);
    await expectRule(run('DELETE FROM identity.application_sessions'), 'NOT_DELETABLE');
    expect(await count(SESSIONS)).toBe(before);
  });

  const IMMUTABLE_SESSION_UPDATES: [label: string, set: string][] = [
    ['application_session_id', 'application_session_id = gen_random_uuid()'],
    ['account_id (moving the session to another account)', "account_id = '__OTHER__'"],
    ['keycloak_session_id (to another valid id)', "keycloak_session_id = 'another-sid'"],
    ['keycloak_session_id (to the same text in upper case)', 'keycloak_session_id = upper(keycloak_session_id)'],
    ['created_at (later)', "created_at = created_at + interval '1 second'"],
    ['created_at (earlier)', "created_at = created_at - interval '1 second'"],
  ];
  it.each(IMMUTABLE_SESSION_UPDATES)('refuses to change %s (SESSION_IMMUTABLE)', async (_label, set) => {
    const s = await insertSession(await makeAccount(), { sid: `sid-keep-${uniq()}` });
    const other = await makeAccount();
    const before = await q('SELECT * FROM identity.application_sessions WHERE application_session_id = $1', [s.id]);
    await expectRule(
      run(`UPDATE identity.application_sessions SET ${set.replace('__OTHER__', other)} WHERE application_session_id = $1`, [s.id]),
      'SESSION_IMMUTABLE',
    );
    expect(await q('SELECT * FROM identity.application_sessions WHERE application_session_id = $1', [s.id])).toEqual(before);
  });

  it('checks immutability before everything else, also on a REVOKED session (SESSION_IMMUTABLE, not SESSION_REVOKED_TERMINAL)', async () => {
    const s = await revoked();
    await expectRule(
      run("UPDATE identity.application_sessions SET keycloak_session_id = 'x-other' WHERE application_session_id = $1", [s.id]),
      'SESSION_IMMUTABLE',
    );
    await expectRule(
      run("UPDATE identity.application_sessions SET created_at = created_at - interval '1 hour' WHERE application_session_id = $1", [s.id]),
      'SESSION_IMMUTABLE',
    );
  });

  describe('revocation is terminal (SESSION_REVOKED_TERMINAL)', () => {
    const REVOKED_CHANGES: [label: string, set: string][] = [
      ['un-revoking it (both columns back to NULL)', 'revoked_at = NULL, revocation_reason = NULL'],
      ['changing the reason', "revocation_reason = 'SIGN_OUT_EVERYWHERE'"],
      ['changing the reason to the other terminal-looking value KEYCLOAK_ENDED', "revocation_reason = 'KEYCLOAK_ENDED'"],
      ['moving revoked_at later', "revoked_at = revoked_at + interval '1 second'"],
      ['moving revoked_at earlier', "revoked_at = revoked_at - interval '1 microsecond'"],
      ['touching last_seen_at forward (a revoked session is not seen any more)', "last_seen_at = last_seen_at + interval '1 hour'"],
      ['attaching a device', "account_device_id = '__DEVICE__'"],
    ];
    it.each(REVOKED_CHANGES)('refuses %s', async (_label, set) => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a);
      await revokeOn(pool, s.id, 'SIGN_OUT');
      const before = await q('SELECT * FROM identity.application_sessions WHERE application_session_id = $1', [s.id]);
      await expectRule(
        run(`UPDATE identity.application_sessions SET ${set.replace('__DEVICE__', d.id)} WHERE application_session_id = $1`, [s.id]),
        'SESSION_REVOKED_TERMINAL',
      );
      expect(await q('SELECT * FROM identity.application_sessions WHERE application_session_id = $1', [s.id])).toEqual(before);
    });
    it.each(SESSION_REVOCATION_REASONS)('keeps a session revoked with %s revoked for good, whatever the later statement', async (reason) => {
      const s = await freshSession();
      await revokeOn(pool, s.id, reason);
      for (const other of SESSION_REVOCATION_REASONS.filter((r) => r !== reason))
        await expectRule(
          run('UPDATE identity.application_sessions SET revocation_reason = $2 WHERE application_session_id = $1', [s.id, other]),
          'SESSION_REVOKED_TERMINAL',
        );
      expect((await sessionRow(s.id)).revocation_reason).toBe(reason);
    });
    it('accepts a no-op update of a revoked session (idempotent revoke in the same statement shape changes nothing only when the values are identical)', async () => {
      const s = await revoked();
      await run(
        'UPDATE identity.application_sessions SET revoked_at = revoked_at, revocation_reason = revocation_reason, last_seen_at = last_seen_at WHERE application_session_id = $1',
        [s.id],
      );
    });
    it('refuses to revoke a session twice with a new timestamp (the service must guard with revoked_at IS NULL)', async () => {
      const s = await revoked();
      await expectRule(revokeOn(pool, s.id, 'REVOKED_BY_USER'), 'SESSION_REVOKED_TERMINAL');
      expect(await q('SELECT count(*)::int AS n FROM identity.application_sessions WHERE application_session_id = $1 AND revoked_at IS NULL', [s.id])).toEqual([
        { n: 0 },
      ]);
    });
    it('is idempotent in SQL when the revoke statement is guarded with revoked_at IS NULL (the service shape): the second statement updates zero rows', async () => {
      const s = await freshSession();
      const guarded = () =>
        pool.query(
          "UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'REVOKED_BY_USER' WHERE application_session_id = $1 AND revoked_at IS NULL",
          [s.id],
        );
      expect((await guarded()).rowCount).toBe(1);
      expect((await guarded()).rowCount).toBe(0);
    });
    it('lets a bulk revoke (revoke-all shape) skip the already revoked rows without failing', async () => {
      const a = await makeAccount();
      const s1 = await insertSession(a);
      const s2 = await insertSession(a);
      const s3 = await insertSession(a);
      await revokeOn(pool, s2.id, 'SIGN_OUT');
      const r = await pool.query(
        "UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT_EVERYWHERE' WHERE account_id = $1 AND revoked_at IS NULL RETURNING application_session_id",
        [a],
      );
      expect(r.rows.map((x) => x.application_session_id).sort()).toEqual([s1.id, s3.id].sort());
      expect((await sessionRow(s2.id)).revocation_reason).toBe('SIGN_OUT');
    });
    it('refuses a bulk revoke that does not exclude revoked rows, and rolls the whole statement back', async () => {
      const a = await makeAccount();
      const live = await insertSession(a);
      const gone = await insertSession(a);
      await revokeOn(pool, gone.id, 'SIGN_OUT');
      await expectRule(
        run("UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT_EVERYWHERE' WHERE account_id = $1", [a]),
        'SESSION_REVOKED_TERMINAL',
      );
      expect((await sessionRow(live.id)).revoked).toBe(false);
    });
  });

  describe('the device of a session is set once (SESSION_DEVICE_IMMUTABLE)', () => {
    it('attaches a device to a device-less session, once', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a);
      await run('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, d.id]);
      expect((await sessionRow(s.id)).account_device_id).toBe(d.id);
    });
    it('refuses to change the device to another device of the same account', async () => {
      const a = await makeAccount();
      const d1 = await insertDevice(a);
      const d2 = await insertDevice(a);
      const s = await insertSession(a, { deviceId: d1.id });
      await expectRule(
        run('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, d2.id]),
        'SESSION_DEVICE_IMMUTABLE',
      );
      expect((await sessionRow(s.id)).account_device_id).toBe(d1.id);
    });
    it('refuses to detach the device (back to NULL)', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a, { deviceId: d.id });
      await expectRule(
        run('UPDATE identity.application_sessions SET account_device_id = NULL WHERE application_session_id = $1', [s.id]),
        'SESSION_DEVICE_IMMUTABLE',
      );
    });
    it('accepts writing the same device again (registerSession is idempotent)', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a, { deviceId: d.id });
      await run('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, d.id]);
    });
    it('reports the device rule before the monotonic rule when one statement breaks both', async () => {
      const a = await makeAccount();
      const d1 = await insertDevice(a);
      const d2 = await insertDevice(a);
      const s = await insertSession(a, { deviceId: d1.id });
      await expectRule(
        run(
          "UPDATE identity.application_sessions SET account_device_id = $2, last_seen_at = last_seen_at - interval '1 hour' WHERE application_session_id = $1",
          [s.id, d2.id],
        ),
        'SESSION_DEVICE_IMMUTABLE',
      );
    });
    it('refuses to attach a REMOVED device to a live session (DEVICE_REMOVED_TERMINAL)', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      await run('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
      const s = await insertSession(a);
      await expectRule(
        run('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, d.id]),
        'DEVICE_REMOVED_TERMINAL',
      );
      expect((await sessionRow(s.id)).account_device_id).toBeNull();
    });
    it('refuses to insert a session on a REMOVED device (DEVICE_REMOVED_TERMINAL) and accepts one on its replacement', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      await run('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
      await expectRule(insertSession(a, { deviceId: d.id }), 'DEVICE_REMOVED_TERMINAL');
      const replacement = await insertDevice(a);
      await insertSession(a, { deviceId: replacement.id });
    });
    it('keeps the sessions that were already attached to a device after the device is removed (history), only revoking them is the service job', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a, { deviceId: d.id });
      await inTx(async (c) => {
        await c.query('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
        await revokeOn(c, s.id, 'DEVICE_REMOVED');
      });
      expect(await sessionRow(s.id)).toMatchObject({ account_device_id: d.id, revoked: true, revocation_reason: 'DEVICE_REMOVED' });
    });
  });

  describe('last_seen_at is monotonic (SESSION_LAST_SEEN_MONOTONIC)', () => {
    it('refuses to move it back by even one microsecond, accepts equal and forward', async () => {
      const s = await insertSession(await makeAccount(), {
        createdAt: "timestamptz '2026-01-01 00:00:00+00'",
        lastSeenAt: "timestamptz '2026-01-01 00:10:00+00'",
      });
      await expectRule(
        run("UPDATE identity.application_sessions SET last_seen_at = timestamptz '2026-01-01 00:09:59.999999+00' WHERE application_session_id = $1", [s.id]),
        'SESSION_LAST_SEEN_MONOTONIC',
      );
      await expectRule(
        run("UPDATE identity.application_sessions SET last_seen_at = timestamptz '2026-01-01 00:00:00+00' WHERE application_session_id = $1", [s.id]),
        'SESSION_LAST_SEEN_MONOTONIC',
      );
      await run("UPDATE identity.application_sessions SET last_seen_at = timestamptz '2026-01-01 00:10:00+00' WHERE application_session_id = $1", [s.id]);
      await run("UPDATE identity.application_sessions SET last_seen_at = timestamptz '2026-01-01 00:10:00.000001+00' WHERE application_session_id = $1", [
        s.id,
      ]);
      await run("UPDATE identity.application_sessions SET last_seen_at = timestamptz '2027-01-01 00:00:00+00' WHERE application_session_id = $1", [s.id]);
    });
    it('accepts the one-statement touch of the request path (a GREATEST of the old value and the clock), also with a stale clock', async () => {
      const s = await freshSession();
      await run('UPDATE identity.application_sessions SET last_seen_at = GREATEST(last_seen_at, clock_timestamp()) WHERE application_session_id = $1', [s.id]);
      await run(
        "UPDATE identity.application_sessions SET last_seen_at = GREATEST(last_seen_at, clock_timestamp() - interval '1 day') WHERE application_session_id = $1",
        [s.id],
      );
    });
    it('touches only live sessions in the guarded one-statement shape (revoked_at IS NULL and older than a minute)', async () => {
      const a = await makeAccount();
      const old = await insertSession(a, { createdAt: "clock_timestamp() - interval '2 hours'", lastSeenAt: "clock_timestamp() - interval '2 hours'" });
      const fresh = await insertSession(a);
      const gone = await insertSession(a, { createdAt: "clock_timestamp() - interval '2 hours'", lastSeenAt: "clock_timestamp() - interval '2 hours'" });
      await revokeOn(pool, gone.id, 'SIGN_OUT');
      const r = await pool.query(
        "UPDATE identity.application_sessions SET last_seen_at = clock_timestamp() WHERE account_id = $1 AND revoked_at IS NULL AND last_seen_at < clock_timestamp() - interval '60 seconds' RETURNING application_session_id",
        [a],
      );
      expect(r.rows.map((x) => x.application_session_id)).toEqual([old.id]);
      expect((await sessionRow(fresh.id)).revoked).toBe(false);
    });
  });

  describe('first sight: ON CONFLICT upsert shape of the request path', () => {
    const upsert = (accountId: string, sid: string, db: Db = pool) =>
      db.query(
        `INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2)
         ON CONFLICT (keycloak_session_id) DO UPDATE SET last_seen_at = GREATEST(identity.application_sessions.last_seen_at, clock_timestamp())
         RETURNING application_session_id, (xmax = 0) AS inserted`,
        [accountId, sid],
      );
    it('creates the row once and returns the same row afterwards', async () => {
      const a = await makeAccount();
      const sid = `sid-${uniq()}`;
      const first = (await upsert(a, sid)).rows[0];
      const second = (await upsert(a, sid)).rows[0];
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.application_session_id).toBe(first.application_session_id);
      expect(await count(SESSIONS, 'keycloak_session_id = $1', [sid])).toBe(1);
    });
    it('hits SESSION_REVOKED_TERMINAL when the conflicting row is revoked and the DO UPDATE touches it: the service must read the row state, not blindly upsert', async () => {
      const a = await makeAccount();
      const sid = `sid-${uniq()}`;
      const s = await insertSession(a, { sid });
      await run("UPDATE identity.application_sessions SET last_seen_at = clock_timestamp() - interval '1 second' WHERE application_session_id = $1 AND false", [
        s.id,
      ]);
      await revokeOn(pool, s.id, 'SIGN_OUT');
      await expectRule(upsert(a, sid), 'SESSION_REVOKED_TERMINAL');
      expect((await sessionRow(s.id)).revoked).toBe(true);
    });
    it('keeps the OWNER of a row on conflict: another account presenting the same sid does not take the row over (the DO UPDATE never changes account_id)', async () => {
      const owner = await makeAccount();
      const sid = `sid-${uniq()}`;
      const s = await insertSession(owner, { sid });
      const intruder = await makeAccount();
      const r = (await upsert(intruder, sid)).rows[0];
      expect(r.application_session_id).toBe(s.id);
      expect((await sessionRow(s.id)).account_id).toBe(owner);
      expect(await count(SESSIONS, 'account_id = $1', [intruder])).toBe(0);
    });
  });

  describe('account status on insert (ACCOUNT_CLOSED)', () => {
    it.each(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'] as const)('accepts a session for a %s account', async (status) => {
      const a = await accountIn(status);
      const s = await insertSession(a);
      expect((await sessionRow(s.id)).revoked).toBe(false);
    });
    it('refuses a session for a CLOSED account (ACCOUNT_CLOSED)', async () => {
      const a = await accountIn('CLOSED');
      await expectRule(insertSession(a), 'ACCOUNT_CLOSED');
      expect(await count(SESSIONS, 'account_id = $1', [a])).toBe(0);
    });
    it('refuses it also through the upsert shape (the insert guard fires before the conflict is detected)', async () => {
      const a = await accountIn('CLOSED');
      await expectRule(
        run('INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2) ON CONFLICT (keycloak_session_id) DO NOTHING', [
          a,
          `sid-${uniq()}`,
        ]),
        'ACCOUNT_CLOSED',
      );
    });
    it('reports ACCOUNT_CLOSED before the removed-device rule', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      await run('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      await expectRule(insertSession(a, { deviceId: d.id }), 'ACCOUNT_CLOSED');
    });
    it('still lets the sessions of an account closed AFTER their creation be touched and revoked (closing an account ends its sessions), but not created', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      const t = await insertSession(a);
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      await run('UPDATE identity.application_sessions SET last_seen_at = clock_timestamp() WHERE application_session_id = $1', [s.id]);
      await revokeOn(pool, s.id, 'SIGN_OUT_EVERYWHERE');
      await revokeOn(pool, t.id, 'SIGN_OUT_EVERYWHERE');
      expect(await count(SESSIONS, 'account_id = $1 AND revoked_at IS NOT NULL', [a])).toBe(2);
      await expectRule(insertSession(a), 'ACCOUNT_CLOSED');
    });
    it('keeps session rows after the account is closed (rows are never deleted)', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      expect(await count(SESSIONS, 'application_session_id = $1', [s.id])).toBe(1);
      await expectRule(run('DELETE FROM identity.accounts WHERE account_id = $1', [a]), 'NOT_DELETABLE');
    });
  });

  it('refuses a session born revoked only through the CHECKs, not through a guard: an insert with a valid pair is accepted (a historical import path stays possible)', async () => {
    const s = await insertSession(await makeAccount(), { revokedAt: 'clock_timestamp()', reason: 'KEYCLOAK_ENDED' });
    expect(await sessionRow(s.id)).toMatchObject({ revoked: true, revocation_reason: 'KEYCLOAK_ENDED' });
  });
});

// ====================================================================== F. the revocation watermark (identity.accounts.sessions_not_before)
describe('F. the revocation watermark: raised by revoke-all, never back, never NULL again, never far in the future, CLOSED stays immutable', () => {
  const setWatermark = (accountId: string, expr: string, db: Db = pool) =>
    db.query(`UPDATE identity.accounts SET sessions_not_before = ${expr} WHERE account_id = $1`, [accountId]);

  it('is NULL for every new account (no revoke-all has happened)', async () => {
    expect(await watermarkOf(await makeAccount())).toBeNull();
    expect(await watermarkOf(await makeAccount('PENDING'))).toBeNull();
  });

  it('accepts a first value at the database clock (the revoke-all shape), then a later one', async () => {
    const a = await makeAccount();
    await setWatermark(a, 'clock_timestamp()');
    const first = await watermarkOf(a);
    expect(first).not.toBeNull();
    await sleep(5);
    await setWatermark(a, 'clock_timestamp()');
    expect(new Date((await watermarkOf(a))!).getTime()).toBeGreaterThan(new Date(first!).getTime());
  });

  it('accepts writing the same value again (no change, the guard does not fire) and a no-op update', async () => {
    const a = await makeAccount();
    await setWatermark(a, "timestamptz '2026-03-01 10:00:00+00'");
    await setWatermark(a, "timestamptz '2026-03-01 10:00:00+00'");
    await setWatermark(a, 'sessions_not_before');
    expect(await watermarkOf(a)).toBe('2026-03-01 10:00:00+00');
  });

  it('refuses to move it back by even one microsecond (SESSIONS_WATERMARK) and keeps the old value', async () => {
    const a = await makeAccount();
    await setWatermark(a, "timestamptz '2026-03-01 10:00:00+00'");
    await expectRule(setWatermark(a, "timestamptz '2026-03-01 09:59:59.999999+00'"), 'SESSIONS_WATERMARK');
    await expectRule(setWatermark(a, "timestamptz '2020-01-01 00:00:00+00'"), 'SESSIONS_WATERMARK');
    expect(await watermarkOf(a)).toBe('2026-03-01 10:00:00+00');
  });

  it('refuses to clear it back to NULL once set (SESSIONS_WATERMARK)', async () => {
    const a = await makeAccount();
    await setWatermark(a, 'clock_timestamp()');
    await expectRule(setWatermark(a, 'NULL'), 'SESSIONS_WATERMARK');
    expect(await watermarkOf(a)).not.toBeNull();
  });

  it('accepts NULL on an account that never had a watermark (no change, nothing to guard)', async () => {
    const a = await makeAccount();
    await setWatermark(a, 'NULL');
    expect(await watermarkOf(a)).toBeNull();
  });

  it('refuses a value more than one minute in the future, as first value and as a later value (SESSIONS_WATERMARK)', async () => {
    const first = await makeAccount();
    await expectRule(setWatermark(first, "clock_timestamp() + interval '2 minutes'"), 'SESSIONS_WATERMARK');
    await expectRule(setWatermark(first, "clock_timestamp() + interval '1 day'"), 'SESSIONS_WATERMARK');
    await expectRule(setWatermark(first, "timestamptz 'infinity'"), 'SESSIONS_WATERMARK');
    expect(await watermarkOf(first)).toBeNull();
    const later = await makeAccount();
    await setWatermark(later, 'clock_timestamp()');
    const before = await watermarkOf(later);
    await expectRule(setWatermark(later, "clock_timestamp() + interval '5 minutes'"), 'SESSIONS_WATERMARK');
    expect(await watermarkOf(later)).toBe(before);
  });

  it('accepts a value inside the one-minute tolerance for a database clock that is slightly ahead (30 seconds)', async () => {
    const a = await makeAccount();
    await setWatermark(a, "clock_timestamp() + interval '30 seconds'");
    expect(await watermarkOf(a)).not.toBeNull();
  });

  it('accepts a long-past value as a first value (the guard bounds the future, not the past)', async () => {
    const a = await makeAccount();
    await setWatermark(a, "timestamptz '2001-01-01 00:00:00+00'");
    expect(await watermarkOf(a)).toBe('2001-01-01 00:00:00+00');
  });

  it('fires only when the column is in the SET list: other updates of an account with a watermark pass even if the clock moved', async () => {
    const a = await makeAccount();
    await setWatermark(a, "clock_timestamp() + interval '50 seconds'");
    await sleep(5);
    await run('UPDATE identity.accounts SET updated_at = now() WHERE account_id = $1', [a]);
  });

  it('is changed in one statement with the account status (a suspension that also signs everybody out)', async () => {
    const a = await makeAccount();
    await inTx(async (c) => {
      await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', sessions_not_before = clock_timestamp(), updated_at = now() WHERE account_id = $1", [
        a,
      ]);
      await historyRow(c, a, 'ACTIVE', 'SUSPENDED');
    });
    expect(await watermarkOf(a)).not.toBeNull();
  });

  describe('account status', () => {
    it.each(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'] as const)('accepts a revoke-all watermark on a %s account', async (status) => {
      const a = await accountIn(status);
      await setWatermark(a, 'clock_timestamp()');
      expect(await watermarkOf(a)).not.toBeNull();
    });
    it('keeps a CLOSED account immutable: the watermark cannot be set (ACCOUNT_CLOSED, from the original account guard that fires first)', async () => {
      const a = await accountIn('CLOSED');
      await expectRule(setWatermark(a, 'clock_timestamp()'), 'ACCOUNT_CLOSED');
      expect(await watermarkOf(a)).toBeNull();
    });
    it('keeps the watermark of a CLOSED account as it was and refuses to raise it (the service skips the watermark for closed accounts)', async () => {
      const a = await makeAccount();
      await setWatermark(a, "timestamptz '2026-03-01 10:00:00+00'");
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      await expectRule(setWatermark(a, 'clock_timestamp()'), 'ACCOUNT_CLOSED');
      await expectRule(setWatermark(a, "timestamptz '2020-01-01 00:00:00+00'"), 'ACCOUNT_CLOSED');
      await expectRule(setWatermark(a, 'NULL'), 'ACCOUNT_CLOSED');
      expect(await watermarkOf(a)).toBe('2026-03-01 10:00:00+00');
    });
    it('still treats the account guard as the first line: an immutable account column on a CLOSED account is ACCOUNT_CLOSED even with the watermark', async () => {
      const a = await accountIn('CLOSED');
      await expectRule(
        run('UPDATE identity.accounts SET updated_at = now(), sessions_not_before = clock_timestamp() WHERE account_id = $1', [a]),
        'ACCOUNT_CLOSED',
      );
    });
    it('closing an account does not require the watermark and does not change an existing one', async () => {
      const a = await makeAccount();
      await setWatermark(a, "timestamptz '2026-03-01 10:00:00+00'");
      await setStatus(a, 'SUSPENDED');
      await setStatus(a, 'CLOSED');
      expect(await watermarkOf(a)).toBe('2026-03-01 10:00:00+00');
    });
  });

  it('is independent of the sessions: raising it does not touch a session row and no session needs to exist', async () => {
    const a = await makeAccount();
    const s = await insertSession(a);
    const before = await sessionRow(s.id);
    await setWatermark(a, 'clock_timestamp()');
    expect(await sessionRow(s.id)).toEqual(before);
  });
});

// ====================================================================== G. audit extension
const OLD_ACTIONS_0009 = [
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
const OLD_ACTIONS = [...OLD_ACTIONS_0009, ...EMAIL_ACTIONS, ...PHONE_ACTIONS];
const SESSION_ACTIONS = SECURITY_AUDIT_ACTIONS.filter((a) => /^SESSION_/.test(a));
const DEVICE_ACTIONS = SECURITY_AUDIT_ACTIONS.filter((a) => a.startsWith('DEVICE_'));
const NEUTRAL_SECURITY_ACTIONS = SECURITY_AUDIT_ACTIONS.filter((a) => !/^SESSION_/.test(a) && !a.startsWith('DEVICE_'));

describe('G. audit extension: the sixteen security actions, the session and the device they concern', () => {
  it('lists exactly 21 old and 16 new actions (37), and the contract list is exactly the 16 added ones', () => {
    expect(OLD_ACTIONS).toHaveLength(21);
    expect(SECURITY_AUDIT_ACTIONS).toHaveLength(16);
    expect(new Set([...OLD_ACTIONS, ...SECURITY_AUDIT_ACTIONS]).size).toBe(37);
    expect(SESSION_ACTIONS).toEqual(['SESSION_CREATED', 'SESSION_ENDED', 'SESSION_REVOKED']);
    expect(DEVICE_ACTIONS).toEqual(['DEVICE_TRUSTED', 'DEVICE_UNTRUSTED', 'DEVICE_REMOVED']);
    expect(NEUTRAL_SECURITY_ACTIONS).toHaveLength(10);
  });

  it('names every one of the 39 actions in the CHECK definition (catalog: 37 from 0009 to 0012 plus the two consent actions of 0013) and nothing else', async () => {
    const def = await constraintDef('ck_account_audit_events__action');
    const names = [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!).sort();
    expect(names).toEqual([...OLD_ACTIONS, ...SECURITY_AUDIT_ACTIONS, 'CONSENT_ACCEPTED', 'CONSENT_WITHDRAWN'].sort());
  });

  it.each(OLD_ACTIONS)('still accepts the old action %s with the references of its own family and no session or device', async (action) => {
    const a = await makeAccount();
    const refs = await refsFor(a, action);
    const id = await insertAuditRow(a, action, refs);
    expect(await q(`SELECT action, application_session_id, account_device_id FROM ${AUDIT} WHERE audit_event_id = $1`, [id])).toEqual([
      { action, application_session_id: null, account_device_id: null },
    ]);
  });

  it.each(SECURITY_AUDIT_ACTIONS)('accepts the new action %s with exactly the reference it requires', async (action) => {
    const a = await makeAccount();
    const refs = await refsFor(a, action);
    const id = await insertAuditRow(a, action, { ...refs, changes: JSON.stringify({ reason: 'REVOKED_BY_USER', count: 2 }) });
    const row = (
      await q<{ action: string; s: boolean; d: boolean }>(
        `SELECT action, application_session_id IS NOT NULL AS s, account_device_id IS NOT NULL AS d FROM ${AUDIT} WHERE audit_event_id = $1`,
        [id],
      )
    )[0]!;
    expect(row).toEqual({ action, s: SESSION_ACTIONS.includes(action as never), d: DEVICE_ACTIONS.includes(action as never) });
  });

  const UNKNOWN_ACTIONS = [
    'SESSION_DELETED',
    'SESSION_EXPIRED',
    'SESSIONS_REVOKED',
    'SESSIONS_REVOKED_ALL_EVERYWHERE',
    'DEVICE_BLOCKED',
    'DEVICE_ADDED',
    'DEVICE_SEEN',
    'MFA_RESET',
    'MFA_ENROLLED',
    'MFA_',
    'RECOVERY_CODES_USED',
    'RECOVERY_CODE_USED',
    'PASSWORD_REMINDED',
    'PASSWORD_RESET',
    'PASSWORD_RESET_FAILED',
    'LOGIN',
    'LOGOUT',
    'session_created',
    'Session_Created',
    'SESSION_CREATED ',
    ' SESSION_CREATED',
    'SESSION',
    'SESSIONS_REVOKED_ALL ',
    'DEVICE_',
    '',
  ];
  it.each(UNKNOWN_ACTIONS)('refuses the unknown action "%s" (ck_account_audit_events__action)', async (action) => {
    const a = await makeAccount();
    // supply a session AND a device so that no pairing check can be the first to fail, whatever the prefix looks like
    const s = await insertSession(a);
    const d = await insertDevice(a);
    const e = await fail(insertAuditRow(a, action, { session: s.id, device: d.id }));
    expect(e.constraint).toBe('ck_account_audit_events__action');
  });

  describe('the SESSION_ prefix <-> application_session_id CHECK (ck_account_audit_events__session)', () => {
    it.each(SESSION_ACTIONS)('requires a session for %s', async (action) => {
      expect(await constraintOf(insertAuditRow(await makeAccount(), action))).toBe('ck_account_audit_events__session');
    });
    it('does NOT give SESSIONS_REVOKED_ALL a session: the literal underscore of the LIKE pattern keeps it out of the SESSION_ family', async () => {
      const a = await makeAccount();
      await insertAuditRow(a, 'SESSIONS_REVOKED_ALL');
      const s = await insertSession(a);
      expect(await constraintOf(insertAuditRow(a, 'SESSIONS_REVOKED_ALL', { session: s.id }))).toBe('ck_account_audit_events__session');
    });
    it.each([...OLD_ACTIONS.filter((a) => !a.startsWith('ROLE_')), ...NEUTRAL_SECURITY_ACTIONS, ...DEVICE_ACTIONS])(
      'refuses a session on the non-session action %s',
      async (action) => {
        const a = await makeAccount();
        const refs = await refsFor(a, action);
        const s = await insertSession(a);
        expect(await constraintOf(insertAuditRow(a, action, { ...refs, session: s.id }))).toBe('ck_account_audit_events__session');
      },
    );
    it('refuses a session on a ROLE_ action (the session pairing and the role pairing both hold)', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      expect(await constraintOf(insertAuditRow(a, 'ROLE_GRANTED', { role: await CUSTOMER(), session: s.id }))).toBe('ck_account_audit_events__session');
    });
    it('keeps the LIKE pattern literal: a hypothetical action SESSIONX_.. cannot sneak in as a session action (the action list refuses it first)', async () => {
      const a = await makeAccount();
      expect(await constraintOf(insertAuditRow(a, 'SESSIONX_CREATED'))).toBe('ck_account_audit_events__action');
    });
    it('defines the pairing with escaped underscores (catalog)', async () => {
      expect(await constraintDef('ck_account_audit_events__session')).toMatch(/\(\(action ~~ 'SESSION\\_%'::text\) = \(application_session_id IS NOT NULL\)\)/);
    });
  });

  describe('the DEVICE_ prefix <-> account_device_id CHECK (ck_account_audit_events__device)', () => {
    it.each(DEVICE_ACTIONS)('requires a device for %s', async (action) => {
      expect(await constraintOf(insertAuditRow(await makeAccount(), action))).toBe('ck_account_audit_events__device');
    });
    it.each([...OLD_ACTIONS.filter((a) => !a.startsWith('ROLE_')), ...NEUTRAL_SECURITY_ACTIONS, ...SESSION_ACTIONS, 'SESSIONS_REVOKED_ALL'])(
      'refuses a device on the non-device action %s',
      async (action) => {
        const a = await makeAccount();
        const refs = await refsFor(a, action);
        const d = await insertDevice(a);
        expect(await constraintOf(insertAuditRow(a, action, { ...refs, device: d.id }))).toBe('ck_account_audit_events__device');
      },
    );
    it('defines the pairing with escaped underscores (catalog)', async () => {
      expect(await constraintDef('ck_account_audit_events__device')).toMatch(/\(\(action ~~ 'DEVICE\\_%'::text\) = \(account_device_id IS NOT NULL\)\)/);
    });
    it('accepts a DEVICE_ action together with a session reference only when the session CHECK is also satisfied: never (a device action has no session)', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      const d = await insertDevice(a);
      expect(await constraintOf(insertAuditRow(a, 'DEVICE_TRUSTED', { device: d.id, session: s.id }))).toBe('ck_account_audit_events__session');
    });
  });

  describe('composite foreign keys: an audit row can only name a session or device of the audited account', () => {
    it.each(SESSION_ACTIONS)("refuses %s naming a session of ANOTHER account, and accepts the same row with the account's own session", async (action) => {
      const own = await makeAccount();
      const foreign = await freshSession();
      expect(await constraintOf(insertAuditRow(own, action, { session: foreign.id }))).toBe('fk_account_audit_events__account_session');
      expect(await count(AUDIT, 'application_session_id = $1', [foreign.id])).toBe(0);
      await insertAuditRow(own, action, { session: (await insertSession(own)).id });
      await insertAuditRow(foreign.accountId, action, { session: foreign.id });
    });
    it.each(DEVICE_ACTIONS)("refuses %s naming a device of ANOTHER account, and accepts the same row with the account's own device", async (action) => {
      const own = await makeAccount();
      const foreign = await freshDevice();
      expect(await constraintOf(insertAuditRow(own, action, { device: foreign.id }))).toBe('fk_account_audit_events__account_device');
      expect(await count(AUDIT, 'account_device_id = $1', [foreign.id])).toBe(0);
      await insertAuditRow(own, action, { device: (await insertDevice(own)).id });
      await insertAuditRow(foreign.accountId, action, { device: foreign.id });
    });
    it('refuses a session or device that does not exist', async () => {
      const a = await makeAccount();
      expect(await constraintOf(insertAuditRow(a, 'SESSION_CREATED', { session: randomUUID() }))).toBe('fk_account_audit_events__account_session');
      expect(await constraintOf(insertAuditRow(a, 'DEVICE_TRUSTED', { device: randomUUID() }))).toBe('fk_account_audit_events__account_device');
    });
    it('refuses naming a real session of another account even when the audited account holds many sessions of its own', async () => {
      const own = await makeAccount();
      for (let n = 0; n < 3; n++) await insertSession(own);
      const foreign = await freshSession();
      expect(await constraintOf(insertAuditRow(own, 'SESSION_REVOKED', { session: foreign.id }))).toBe('fk_account_audit_events__account_session');
    });
    it('accepts one audit row per event for the same session (a session has a timeline: created, revoked, ended)', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      for (const action of SESSION_ACTIONS) await insertAuditRow(a, action, { session: s.id });
      expect(await count(AUDIT, 'application_session_id = $1', [s.id])).toBe(3);
    });
    it('accepts the audit row of a revoked session and of a removed device (history keeps its references)', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a, { deviceId: d.id });
      await inTx(async (c) => {
        await c.query('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
        await revokeOn(c, s.id, 'DEVICE_REMOVED');
        await insertAuditRow(a, 'DEVICE_REMOVED', { device: d.id }, c);
        await insertAuditRow(a, 'SESSION_REVOKED', { session: s.id, changes: JSON.stringify({ reason: 'DEVICE_REMOVED' }) }, c);
      });
      expect(await count(AUDIT, 'account_id = $1', [a])).toBe(2);
    });
    it('skips the composite keys for a row without references (MATCH SIMPLE): SESSIONS_REVOKED_ALL and the MFA/password actions need none', async () => {
      const a = await makeAccount();
      for (const action of ['SESSIONS_REVOKED_ALL', ...NEUTRAL_SECURITY_ACTIONS]) await insertAuditRow(a, action);
      expect(await count(AUDIT, 'account_id = $1', [a])).toBe(1 + NEUTRAL_SECURITY_ACTIONS.length);
    });
    it('keeps a session or device that an audit row names: they cannot be deleted (NOT_DELETABLE) and the foreign key is RESTRICT when the guard is bypassed', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a);
      await insertAuditRow(a, 'SESSION_CREATED', { session: s.id });
      await insertAuditRow(a, 'DEVICE_TRUSTED', { device: d.id });
      await expectRule(run('DELETE FROM identity.application_sessions WHERE application_session_id = $1', [s.id]), 'NOT_DELETABLE');
      await expectRule(run('DELETE FROM identity.account_devices WHERE account_device_id = $1', [d.id]), 'NOT_DELETABLE');
      expect(await constraintOf(isolated(noTriggers(SESSIONS), 'DELETE FROM identity.application_sessions WHERE application_session_id = $1', [s.id]))).toBe(
        'fk_account_audit_events__account_session',
      );
      expect(await constraintOf(isolated(noTriggers(DEVICES), 'DELETE FROM identity.account_devices WHERE account_device_id = $1', [d.id]))).toBe(
        'fk_account_audit_events__account_device',
      );
    });
    it('keeps a device that a session names: the session foreign key is RESTRICT when the guard is bypassed', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      await insertSession(a, { deviceId: d.id });
      expect(await constraintOf(isolated(noTriggers(DEVICES), 'DELETE FROM identity.account_devices WHERE account_device_id = $1', [d.id]))).toBe(
        'fk_application_sessions__account_device',
      );
    });
  });

  describe('the table stays append-only and the older constraints stay in force', () => {
    it('refuses UPDATE and DELETE of a session audit row and of a device audit row, on every column (ROW_IMMUTABLE)', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      const d = await insertDevice(a);
      const sid = await insertAuditRow(a, 'SESSION_CREATED', { session: s.id, changes: JSON.stringify({ reason: 'x' }) });
      const did = await insertAuditRow(a, 'DEVICE_TRUSTED', { device: d.id });
      const updates = [
        "actor = 'someone'",
        "action = 'SESSION_ENDED'",
        'application_session_id = NULL',
        'account_device_id = NULL',
        `application_session_id = '${(await insertSession(a)).id}'`,
        `account_device_id = '${(await insertDevice(a)).id}'`,
        "changes = '{}'::jsonb",
        "reason = 'edited'",
        "correlation_id = 'x'",
        'occurred_at = now()',
        'account_id = account_id',
      ];
      for (const id of [sid, did]) {
        for (const set of updates) await expectRule(run(`UPDATE ${AUDIT} SET ${set} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
        await expectRule(run(`DELETE FROM ${AUDIT} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
      }
      expect(await q(`SELECT action, application_session_id, account_device_id FROM ${AUDIT} WHERE audit_event_id = ANY($1)`, [[sid, did]])).toHaveLength(2);
    });
    it('refuses to re-point ALL existing audit rows in bulk (the append-only trigger fires per row)', async () => {
      const before = await count(AUDIT);
      await expectRule(run(`UPDATE ${AUDIT} SET application_session_id = NULL`), 'ROW_IMMUTABLE');
      expect(await count(AUDIT)).toBe(before);
    });
    it('keeps the role rule: a session action with a role is refused (ck_account_audit_events__role)', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      expect(await constraintOf(insertAuditRow(a, 'SESSION_CREATED', { session: s.id, role: await CUSTOMER() }))).toBe('ck_account_audit_events__role');
    });
    it('keeps the email and phone rules: a security action with a contact is refused', async () => {
      const a = await makeAccount();
      const e = await fail(insertAuditRow(a, 'MFA_ENABLED', { email: await pendingEmail(a) }));
      expect(e.constraint).toBe('ck_account_audit_events__email_contact');
      const p = await fail(insertAuditRow(a, 'MFA_ENABLED', { phone: await pendingPhone(a) }));
      expect(p.constraint).toBe('ck_account_audit_events__phone_contact');
    });
    it('keeps the changes and actor rules for the new actions', async () => {
      const a = await makeAccount();
      expect(await constraintOf(insertAuditRow(a, 'MFA_ENABLED', { changes: '[1]' }))).toBe('ck_account_audit_events__changes_object');
      expect(await constraintOf(q(`INSERT INTO ${AUDIT} (actor, action, account_id, correlation_id) VALUES ('', 'MFA_ENABLED', $1, 'c')`, [a]))).toBe(
        'ck_account_audit_events__actor',
      );
    });
    it('keeps the EMAIL_ and PHONE_ pairings working next to the new ones', async () => {
      const a = await makeAccount();
      expect(await constraintOf(insertAuditRow(a, 'EMAIL_ADDED'))).toBe('ck_account_audit_events__email_contact');
      expect(await constraintOf(insertAuditRow(a, 'PHONE_ADDED'))).toBe('ck_account_audit_events__phone_contact');
    });
    it('does not let a session audit row also carry the other family references', async () => {
      const a = await makeAccount();
      const s = await insertSession(a);
      const fail1 = await fail(insertAuditRow(a, 'SESSION_REVOKED', { session: s.id, phone: await pendingPhone(a) }));
      expect(fail1.constraint).toBe('ck_account_audit_events__phone_contact');
    });
  });

  it('stores only identifiers and closed vocabulary words in the changes of a realistic session timeline (no sid, no hash, no address)', async () => {
    const a = await makeAccount();
    const d = await insertDevice(a);
    const s = await insertSession(a, { deviceId: d.id, sid: `sid-secret-${uniq()}` });
    await insertAuditRow(a, 'SESSION_CREATED', { session: s.id });
    await insertAuditRow(a, 'SESSION_REVOKED', { session: s.id, changes: JSON.stringify({ reason: 'REVOKED_BY_USER' }) });
    await insertAuditRow(a, 'SESSIONS_REVOKED_ALL', { changes: JSON.stringify({ revokedCount: 2, includeCurrent: false }) });
    const dump = JSON.stringify(await q(`SELECT * FROM ${AUDIT} WHERE account_id = $1`, [a]));
    expect(dump).not.toContain(s.sid);
    expect(dump).not.toContain(d.hash);
  });
});

// ====================================================================== H. SQL-level concurrency
/** Opens a transaction on a connection of its own (the caller commits or rolls back and releases). */
async function openTx(from: pg.Pool = pool): Promise<pg.PoolClient> {
  const c = await from.connect();
  await c.query('BEGIN');
  return c;
}
const finish = async (c: pg.PoolClient, how: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<void> => {
  try {
    await c.query(how);
  } finally {
    c.release();
  }
};

describe('H. real concurrency: first-sight races, FOR SHARE against FOR UPDATE on the account row, monotonic last_seen_at, device removal against attach', () => {
  it('creates exactly ONE row when 24 callers insert the same Keycloak session id at once (plain INSERT: one winner, 23 named unique violations, no other error)', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await makeAccount();
      const sid = `sid-race-${uniq()}`;
      const results = await Promise.allSettled(
        Array.from({ length: 24 }, () =>
          racePool.query('INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2) RETURNING application_session_id', [
            a,
            sid,
          ]),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected'))
        expect({ code: r.reason.code, constraint: r.reason.constraint }).toEqual({ code: '23505', constraint: 'uq_application_sessions__keycloak_session' });
      expect(await count(SESSIONS, 'keycloak_session_id = $1', [sid])).toBe(1);
    }
  });

  it('creates exactly ONE row and hands every caller the SAME id when 24 callers use the first-sight upsert (ON CONFLICT DO UPDATE)', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await makeAccount();
      const sid = `sid-upsert-${uniq()}`;
      const rows = await Promise.all(
        Array.from({ length: 24 }, () =>
          racePool.query(
            `INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2)
             ON CONFLICT (keycloak_session_id) DO UPDATE SET last_seen_at = GREATEST(identity.application_sessions.last_seen_at, clock_timestamp())
             RETURNING application_session_id, (xmax = 0) AS inserted`,
            [a, sid],
          ),
        ),
      );
      const ids = new Set(rows.map((r) => r.rows[0].application_session_id as string));
      expect(ids.size).toBe(1);
      expect(rows.filter((r) => r.rows[0].inserted)).toHaveLength(1);
      expect(await count(SESSIONS, 'keycloak_session_id = $1', [sid])).toBe(1);
    }
  });

  it('creates one row per distinct Keycloak session id when several accounts and ids race at once, and never mixes the owners', async () => {
    const accounts = await Promise.all(Array.from({ length: 6 }, () => makeAccount()));
    const jobs = accounts.flatMap((a) => Array.from({ length: 4 }, (_, i) => ({ a, sid: `sid-multi-${a}-${i}` })));
    await Promise.all(
      jobs.flatMap((j) =>
        [0, 1, 2].map(() =>
          racePool.query(
            `INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2) ON CONFLICT (keycloak_session_id) DO UPDATE SET last_seen_at = GREATEST(identity.application_sessions.last_seen_at, clock_timestamp())`,
            [j.a, j.sid],
          ),
        ),
      ),
    );
    for (const j of jobs)
      expect(await q('SELECT account_id FROM identity.application_sessions WHERE keycloak_session_id = $1', [j.sid])).toEqual([{ account_id: j.a }]);
    expect(await count(SESSIONS, 'keycloak_session_id LIKE $1', ['sid-multi-%'])).toBe(24);
  });

  it('lets exactly one of two accounts own a Keycloak session id when both insert it at once (the other gets the named unique violation)', async () => {
    const a1 = await makeAccount();
    const a2 = await makeAccount();
    const sid = `sid-owner-${uniq()}`;
    const results = await Promise.allSettled([
      racePool.query('INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2)', [a1, sid]),
      racePool.query('INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2)', [a2, sid]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count(SESSIONS, 'keycloak_session_id = $1', [sid])).toBe(1);
  });

  it('creates exactly ONE device row when 24 callers register the same (account, hash) at once with the upsert shape', async () => {
    const a = await makeAccount();
    const hash = hex64();
    const rows = await Promise.all(
      Array.from({ length: 24 }, () =>
        racePool.query(
          `INSERT INTO identity.account_devices (account_id, device_hash, browser_family, os_family, device_class) VALUES ($1, $2, 'CHROME', 'MACOS', 'DESKTOP')
           ON CONFLICT (account_id, device_hash) DO UPDATE SET last_seen_at = GREATEST(identity.account_devices.last_seen_at, clock_timestamp())
           RETURNING account_device_id`,
          [a, hash],
        ),
      ),
    );
    expect(new Set(rows.map((r) => r.rows[0].account_device_id)).size).toBe(1);
    expect(await count(DEVICES, 'account_id = $1', [a])).toBe(1);
  });

  it('keeps the first classification when racing registrations of one browser disagree about the families (DO UPDATE never rewrites them)', async () => {
    const a = await makeAccount();
    const hash = hex64();
    await Promise.all(
      ['CHROME', 'FIREFOX', 'SAFARI', 'EDGE', 'OPERA', 'OTHER'].map((b) =>
        racePool.query(
          `INSERT INTO identity.account_devices (account_id, device_hash, browser_family, os_family, device_class) VALUES ($1, $2, $3, 'MACOS', 'DESKTOP')
           ON CONFLICT (account_id, device_hash) DO UPDATE SET last_seen_at = GREATEST(identity.account_devices.last_seen_at, clock_timestamp())`,
          [a, hash, b],
        ),
      ),
    );
    expect(await count(DEVICES, 'account_id = $1', [a])).toBe(1);
    const stored = (await q<{ browser_family: string }>('SELECT browser_family FROM identity.account_devices WHERE account_id = $1', [a]))[0]!.browser_family;
    expect(['CHROME', 'FIREFOX', 'SAFARI', 'EDGE', 'OPERA', 'OTHER']).toContain(stored);
  });

  describe('the account row serializes first sight (FOR SHARE) with revoke-all (FOR UPDATE)', () => {
    it('blocks a revoke-all (FOR UPDATE) while a first-sight transaction holds FOR SHARE, and the revoke-all then sees and revokes the session that first sight inserted', async () => {
      const a = await makeAccount();
      const sight = await openTx();
      await sight.query('SELECT sessions_not_before FROM identity.accounts WHERE account_id = $1 FOR SHARE', [a]);
      const s = await insertSession(a, {}, sight);
      const revokeAll = inTxOn(racePool, async (c) => {
        await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [a]);
        await c.query('UPDATE identity.accounts SET sessions_not_before = clock_timestamp() WHERE account_id = $1', [a]);
        return (
          await c.query(
            "UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT_EVERYWHERE' WHERE account_id = $1 AND revoked_at IS NULL RETURNING application_session_id",
            [a],
          )
        ).rows.map((r) => r.application_session_id as string);
      });
      await lockWaiters(1);
      await finish(sight);
      expect(await revokeAll).toEqual([s.id]);
      expect(await sessionRow(s.id)).toMatchObject({ revoked: true, revocation_reason: 'SIGN_OUT_EVERYWHERE' });
      expect(await watermarkOf(a)).not.toBeNull();
    });

    it('blocks a first-sight FOR SHARE while a revoke-all holds FOR UPDATE, and first sight then reads the NEW watermark', async () => {
      const a = await makeAccount();
      const revoke = await openTx();
      await revoke.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [a]);
      await revoke.query("UPDATE identity.accounts SET sessions_not_before = timestamptz '2026-05-05 05:05:05+00' WHERE account_id = $1", [a]);
      const sight = inTxOn(
        racePool,
        async (c) => (await c.query('SELECT sessions_not_before::text AS w FROM identity.accounts WHERE account_id = $1 FOR SHARE', [a])).rows[0].w as string,
      );
      await lockWaiters(1);
      await finish(revoke);
      expect(await sight).toBe('2026-05-05 05:05:05+00');
    });

    it('serializes the session INSERT itself with a concurrent revoke-all: the account row lock (FOR SHARE in the guard, KEY SHARE in the foreign key) keeps an insert from slipping in between the lock and the commit', async () => {
      const a = await makeAccount();
      const revoke = await openTx();
      await revoke.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [a]);
      let inserted = false;
      const insert = insertSession(a, {}, racePool).then((s) => {
        inserted = true;
        return s;
      });
      await lockWaiters(1);
      expect(inserted).toBe(false);
      await revoke.query('UPDATE identity.accounts SET sessions_not_before = clock_timestamp() WHERE account_id = $1', [a]);
      await finish(revoke);
      const s = await insert;
      expect(inserted).toBe(true);
      expect(await count(SESSIONS, 'application_session_id = $1', [s.id])).toBe(1);
    });

    it('lets two first-sight transactions share-lock the account row at the same time (FOR SHARE does not block FOR SHARE), so first sights never queue behind each other', async () => {
      const a = await makeAccount();
      const t1 = await openTx();
      const t2 = await openTx();
      await t1.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR SHARE', [a]);
      await t2.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR SHARE', [a]);
      const s1 = await insertSession(a, {}, t1);
      const s2 = await insertSession(a, {}, t2);
      await noLockWaiters();
      await finish(t1);
      await finish(t2);
      expect(await count(SESSIONS, 'application_session_id = ANY($1)', [[s1.id, s2.id]])).toBe(2);
    });

    it('lets a revoke-all revoke ALL sessions of the account, including those inserted by first sights that finished before it, with no survivor (50 sessions, 8 racing first sights)', async () => {
      const a = await makeAccount();
      for (let n = 0; n < 50; n++) await insertSession(a);
      const sights = Array.from({ length: 8 }, () => insertSession(a, {}, racePool));
      const revokeAll = inTxOn(racePool, async (c) => {
        await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [a]);
        await c.query('UPDATE identity.accounts SET sessions_not_before = clock_timestamp() WHERE account_id = $1', [a]);
        await c.query(
          "UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT_EVERYWHERE' WHERE account_id = $1 AND revoked_at IS NULL",
          [a],
        );
      });
      const created = await Promise.all(sights);
      await revokeAll;
      // a first sight that committed AFTER the revoke-all is live (it will be refused by the service through the watermark); the others are all revoked
      const live = await q<{ application_session_id: string }>(
        'SELECT application_session_id FROM identity.application_sessions WHERE account_id = $1 AND revoked_at IS NULL',
        [a],
      );
      expect(live.every((r) => created.some((c) => c.id === r.application_session_id))).toBe(true);
      expect(await count(SESSIONS, 'account_id = $1', [a])).toBe(58);
    });

    it('blocks a session insert while the account is being CLOSED and then refuses it (ACCOUNT_CLOSED): a closed account never receives a session through a race', async () => {
      const a = await accountIn('SUSPENDED');
      const closing = await openTx();
      await closing.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [a]);
      await closing.query("UPDATE identity.accounts SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE account_id = $1", [a]);
      await historyRow(closing, a, 'SUSPENDED', 'CLOSED');
      const insert = insertSession(a, {}, racePool);
      const settled = insert.then(
        () => undefined,
        (e: unknown) => e as PgFailure,
      );
      await lockWaiters(1);
      await finish(closing);
      const e = await settled;
      expect(e).toBeDefined();
      expect({ code: e!.code, detail: e!.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_CLOSED' });
      expect(await count(SESSIONS, 'account_id = $1', [a])).toBe(0);
    });

    it('blocks a device insert the same way while the account is being closed (ACCOUNT_CLOSED)', async () => {
      const a = await accountIn('SUSPENDED');
      const closing = await openTx();
      await closing.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [a]);
      await closing.query("UPDATE identity.accounts SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE account_id = $1", [a]);
      await historyRow(closing, a, 'SUSPENDED', 'CLOSED');
      const settled = insertDevice(a, {}, racePool).then(
        () => undefined,
        (e: unknown) => e as PgFailure,
      );
      await lockWaiters(1);
      await finish(closing);
      const e = await settled;
      expect({ code: e!.code, detail: e!.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_CLOSED' });
    });
  });

  describe('removing a device races with attaching a session to it', () => {
    it('serializes an attach (guard FOR SHARE on the device row) with a removal: the removal waits for the attach, which stays attached and can be revoked in the same removal transaction', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a);
      const attach = await openTx();
      await attach.query('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, d.id]);
      const removal = inTxOn(racePool, async (c) => {
        await c.query('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
        // the removal transaction sees the committed attach and revokes the session of the device it removes
        return (
          await c.query(
            "UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'DEVICE_REMOVED' WHERE account_id = $1 AND account_device_id = $2 AND revoked_at IS NULL RETURNING application_session_id",
            [a, d.id],
          )
        ).rows.map((r) => r.application_session_id as string);
      });
      await lockWaiters(1);
      await finish(attach);
      expect(await removal).toEqual([s.id]);
      expect(await sessionRow(s.id)).toMatchObject({ account_device_id: d.id, revoked: true, revocation_reason: 'DEVICE_REMOVED' });
      expect((await deviceRow(d.id)).removed).toBe(true);
    });

    it('refuses the attach (DEVICE_REMOVED_TERMINAL) when the removal commits first: the attach waits on the device row and re-reads the removed state', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const s = await insertSession(a);
      const removal = await openTx();
      await removal.query('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
      const attach = run('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, d.id]).then(
        () => undefined,
        (e: unknown) => e as PgFailure,
      );
      await lockWaiters(1);
      await finish(removal);
      const e = await attach;
      expect({ code: e!.code, detail: e!.detail }).toEqual({ code: '23000', detail: 'identity_rule:DEVICE_REMOVED_TERMINAL' });
      expect((await sessionRow(s.id)).account_device_id).toBeNull();
    });

    it('refuses an INSERT of a session on a device whose removal commits first (DEVICE_REMOVED_TERMINAL)', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const removal = await openTx();
      await removal.query('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
      const insert = insertSession(a, { deviceId: d.id }, racePool).then(
        () => undefined,
        (e: unknown) => e as PgFailure,
      );
      await lockWaiters(1);
      await finish(removal);
      const e = await insert;
      expect({ code: e!.code, detail: e!.detail }).toEqual({ code: '23000', detail: 'identity_rule:DEVICE_REMOVED_TERMINAL' });
    });

    it('never leaves a live session on a removed device when a removal and 12 attaches race (removal also revokes what it sees; every attach either precedes it or is refused)', async () => {
      const a = await makeAccount();
      const d = await insertDevice(a);
      const sessions = await Promise.all(Array.from({ length: 12 }, () => insertSession(a)));
      const attaches = sessions.map((s) =>
        racePool.query('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [s.id, d.id]).then(
          () => 'attached',
          (e: PgFailure) => e.detail,
        ),
      );
      const removal = inTxOn(racePool, async (c) => {
        await c.query('UPDATE identity.account_devices SET removed_at = clock_timestamp() WHERE account_device_id = $1', [d.id]);
      });
      const outcomes = await Promise.all([...attaches, removal.then(() => 'removed')]);
      expect(outcomes.filter((o) => o !== 'attached' && o !== 'removed' && o !== 'identity_rule:DEVICE_REMOVED_TERMINAL')).toEqual([]);
      // the race leaves attached sessions whose revocation is the service's job in the removal transaction; the invariant the database keeps is: after the
      // removal committed, NO further session can be attached
      const late = await freshSessionOn(a);
      await expectRule(
        run('UPDATE identity.application_sessions SET account_device_id = $2 WHERE application_session_id = $1', [late.id, d.id]),
        'DEVICE_REMOVED_TERMINAL',
      );
    });
  });

  describe('last_seen_at under concurrent updates', () => {
    it('never moves a session back when 24 parallel updates carry values in scrambled order: the final value is the maximum and every refusal is SESSION_LAST_SEEN_MONOTONIC', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await insertSession(await makeAccount(), {
          createdAt: "timestamptz '2026-01-01 00:00:00+00'",
          lastSeenAt: "timestamptz '2026-01-01 00:00:00+00'",
        });
        const offsets = Array.from({ length: 24 }, (_, i) => ((i * 7) % 24) + 1);
        const results = await Promise.allSettled(
          offsets.map((o) =>
            racePool.query(
              "UPDATE identity.application_sessions SET last_seen_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => $2) WHERE application_session_id = $1",
              [s.id, o],
            ),
          ),
        );
        for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected'))
          expect({ code: r.reason.code, detail: r.reason.detail }).toEqual({ code: '23000', detail: 'identity_rule:SESSION_LAST_SEEN_MONOTONIC' });
        const final = (
          await q<{ secs: number }>(
            "SELECT extract(epoch FROM last_seen_at - timestamptz '2026-01-01 00:00:00+00')::int AS secs FROM identity.application_sessions WHERE application_session_id = $1",
            [s.id],
          )
        )[0]!.secs;
        expect(final).toBe(Math.max(...offsets));
      }
    });

    it('accepts every one of 24 parallel GREATEST(...) touches (the request-path shape cannot trip the guard) and ends at a value not before any of them', async () => {
      const s = await freshSession();
      const before = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: 24 }, () =>
          racePool.query(
            'UPDATE identity.application_sessions SET last_seen_at = GREATEST(last_seen_at, clock_timestamp()) WHERE application_session_id = $1',
            [s.id],
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      const row = await sessionRow(s.id);
      expect(row.last_seen_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
      expect(Date.now()).toBeGreaterThanOrEqual(before);
    });

    it('never moves a device back when 24 parallel updates carry scrambled values: the final value is the maximum and every refusal is DEVICE_LAST_SEEN_MONOTONIC', async () => {
      const d = await insertDevice(await makeAccount(), {
        firstSeen: "timestamptz '2026-01-01 00:00:00+00'",
        lastSeen: "timestamptz '2026-01-01 00:00:00+00'",
      });
      const offsets = Array.from({ length: 24 }, (_, i) => ((i * 5) % 24) + 1);
      const results = await Promise.allSettled(
        offsets.map((o) =>
          racePool.query(
            "UPDATE identity.account_devices SET last_seen_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => $2) WHERE account_device_id = $1",
            [d.id, o],
          ),
        ),
      );
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected'))
        expect({ code: r.reason.code, detail: r.reason.detail }).toEqual({ code: '23000', detail: 'identity_rule:DEVICE_LAST_SEEN_MONOTONIC' });
      const final = (
        await q<{ secs: number }>(
          "SELECT extract(epoch FROM last_seen_at - timestamptz '2026-01-01 00:00:00+00')::int AS secs FROM identity.account_devices WHERE account_device_id = $1",
          [d.id],
        )
      )[0]!.secs;
      expect(final).toBe(Math.max(...offsets));
    });
  });

  describe('revocation races', () => {
    it('revokes a session exactly once when 24 callers race with the guarded revoke statement: one row updated in total, the reason of the winner stays', async () => {
      const s = await freshSession();
      const reasons = SESSION_REVOCATION_REASONS;
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          racePool.query(
            'UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = $2 WHERE application_session_id = $1 AND revoked_at IS NULL',
            [s.id, reasons[i % reasons.length]],
          ),
        ),
      );
      expect(results.reduce((n, r) => n + (r.rowCount ?? 0), 0)).toBe(1);
      expect(reasons).toContain((await sessionRow(s.id)).revocation_reason);
    });

    it('lets a touch racing with a revoke either win (and be revoked after) or be refused (SESSION_REVOKED_TERMINAL): a revoked row never carries a later last_seen_at than its revocation', async () => {
      for (let round = 0; round < 5; round++) {
        const s = await insertSession(await makeAccount(), {
          createdAt: "clock_timestamp() - interval '1 hour'",
          lastSeenAt: "clock_timestamp() - interval '1 hour'",
        });
        const [touch, revoke] = await Promise.allSettled([
          racePool.query('UPDATE identity.application_sessions SET last_seen_at = clock_timestamp() WHERE application_session_id = $1', [s.id]),
          racePool.query(
            "UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'REVOKED_BY_USER' WHERE application_session_id = $1",
            [s.id],
          ),
        ]);
        expect(revoke.status).toBe('fulfilled');
        if (touch.status === 'rejected') expect(touch.reason.detail).toBe('identity_rule:SESSION_REVOKED_TERMINAL');
        const row = await sessionRow(s.id);
        expect(row.revoked).toBe(true);
      }
    });
  });
});
const freshSessionOn = (accountId: string): Promise<Session> => insertSession(accountId);

// ====================================================================== I. configuration seeds
interface ParamSeed {
  key: string;
  unit: string;
  min: number;
  max: number;
  value: number;
  /** the three engineering assumptions (not in the PRD) are flagged in the version reason */
  assumption: boolean;
  prd?: string;
}
const PARAM_SEEDS: ParamSeed[] = [
  { key: 'session.trusted_browser_days', unit: 'days', min: 1, max: 365, value: 30, assumption: false, prd: 'CU-09.13' },
  { key: 'session.keep_signed_in_days', unit: 'days', min: 1, max: 90, value: 30, assumption: false, prd: 'SV-01.12' },
  { key: 'reset_link.validity_minutes', unit: 'minutes', min: 5, max: 1440, value: 60, assumption: false, prd: 'CU-03.11' },
  { key: 'security.step_up_valid_minutes', unit: 'minutes', min: 1, max: 60, value: 15, assumption: true },
  { key: 'security.activity_log_days', unit: 'days', min: 30, max: 730, value: 90, assumption: true },
  { key: 'reset_link.max_requests_per_hour', unit: 'requests', min: 1, max: 20, value: 5, assumption: true },
];
const PARAM_KEYS = PARAM_SEEDS.map((p) => p.key);
const SEED_FILTER = "(p.key LIKE 'session.%' OR p.key LIKE 'security.%' OR p.key LIKE 'reset_link.%')";
const parameterId = async (key: string): Promise<string> =>
  (await q<{ parameter_id: string }>('SELECT parameter_id FROM configuration.parameters WHERE key = $1', [key]))[0]!.parameter_id;

describe('I. seeded configuration: the six session, MFA and recovery parameters', () => {
  it('seeds exactly the six parameters, and no other session.*, security.* or reset_link.* key', async () => {
    const rows = await q<{ key: string }>(`SELECT p.key FROM configuration.parameters p WHERE ${SEED_FILTER}`);
    expect(rows.map((r) => r.key).sort()).toEqual([...PARAM_KEYS].sort());
    expect(PARAM_KEYS).toHaveLength(6);
  });

  it('leaves the eight verification.email.* and ten verification.phone.* parameters untouched (24 in all, 28 with the four consent.* parameters of 0013)', async () => {
    expect(await count('configuration.parameters', "key LIKE 'verification.email.%'")).toBe(8);
    expect(await count('configuration.parameters', "key LIKE 'verification.phone.%'")).toBe(10);
    expect(await count('configuration.parameters', "key LIKE 'consent.%'")).toBe(4);
    expect(await count('configuration.parameters')).toBe(28);
  });

  it.each(PARAM_SEEDS)(
    'defines $key as a required, active, CRITICAL INTERNAL INTEGER parameter owned by security with a SECOND_APPROVER policy',
    async (seed) => {
      expect(
        await q(
          `SELECT data_type, owner_role, approval_policy, criticality, sensitivity, is_required, is_active, created_by FROM configuration.parameters WHERE key = $1`,
          [seed.key],
        ),
      ).toEqual([
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
    },
  );

  it.each(PARAM_SEEDS)('declares the unit $unit and the range [$min..$max] of $key', async ({ key, unit, min, max }) => {
    expect(await q('SELECT unit, validation_rules FROM configuration.parameters WHERE key = $1', [key])).toEqual([{ unit, validation_rules: { min, max } }]);
  });

  it.each(PARAM_SEEDS)('allows ONLY the PLATFORM scope for $key (a session policy is not per country or market)', async ({ key }) => {
    const rows = await q<{ scope_type: string }>(
      'SELECT s.scope_type FROM configuration.parameters p JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id WHERE p.key = $1 ORDER BY s.scope_type',
      [key],
    );
    expect(rows).toEqual([{ scope_type: 'PLATFORM' }]);
  });

  it.each(PARAM_SEEDS)('holds one PLATFORM value version 1 = $value for $key, effective now and open-ended', async ({ key, value }) => {
    const rows = await q(
      `SELECT h.scope_type, h.scope_ref, v.version, v.value, v.effective_from <= now() AS started, v.effective_to, v.created_by
         FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key = $1`,
      [key],
    );
    expect(rows).toEqual([{ scope_type: 'PLATFORM', scope_ref: null, version: 1, value, started: true, effective_to: null, created_by: 'system:migration' }]);
  });

  it('seeds the defaults 30, 30, 60, 15, 90, 5 in order, each inside its own range', async () => {
    const rows = await q<{ key: string; value: number }>(
      `SELECT p.key, v.value FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE ${SEED_FILTER}`,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(PARAM_KEYS.map((k) => byKey[k])).toEqual([30, 30, 60, 15, 90, 5]);
    for (const p of PARAM_SEEDS) {
      expect(p.value, p.key).toBeGreaterThanOrEqual(p.min);
      expect(p.value, p.key).toBeLessThanOrEqual(p.max);
    }
  });

  it('keeps the PRD values (CU-09.13 trusted browser 30 days, SV-01.12 keep signed in 30 days, CU-03.11 reset link 60 minutes) in the PRD-named reasons and flags the other three as engineering assumptions', async () => {
    for (const p of PARAM_SEEDS) {
      const reason = (
        await q<{ reason: string }>(
          `SELECT v.reason FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
             JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key = $1`,
          [p.key],
        )
      )[0]!.reason;
      expect(reason, p.key).toMatch(/^Initial value \(migration 0012\): /);
      if (p.assumption) {
        expect(reason, p.key).toMatch(/engineering assumption/);
        expect(reason, p.key).toMatch(/not in the PRD|PRD CU-09\.20/);
        expect(reason, p.key).toMatch(/security owner/);
        expect(reason, p.key).not.toMatch(/PRD [A-Z]{2}-\d\d\.\d\d default/);
      } else {
        expect(reason, p.key).toBe(`Initial value (migration 0012): PRD ${p.prd} default`);
      }
    }
    expect(PARAM_SEEDS.filter((p) => p.assumption).map((p) => p.key)).toEqual([
      'security.step_up_valid_minutes',
      'security.activity_log_days',
      'reset_link.max_requests_per_hour',
    ]);
  });

  it('says in the descriptions that trusting a browser does not change when the sign-in service asks for a code, and that keep-signed-in MUST equal the realm remember-me lifetimes', async () => {
    const d = Object.fromEntries(
      (await q<{ key: string; description: string }>(`SELECT p.key, p.description FROM configuration.parameters p WHERE ${SEED_FILTER}`)).map((r) => [
        r.key,
        r.description,
      ]),
    );
    expect(d['session.trusted_browser_days']).toMatch(/does not change when the sign-in service asks for a code/);
    expect(d['session.keep_signed_in_days']).toMatch(/MUST equal the remember-me lifetimes of the realm/);
  });

  it('keeps session.keep_signed_in_days equal to BOTH remember-me lifetimes of the Keycloak realm (the seed and infra/keycloak/bananagig-realm.json cannot drift)', async () => {
    const realm = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'infra', 'keycloak', 'bananagig-realm.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const days = PARAM_SEEDS.find((p) => p.key === 'session.keep_signed_in_days')!.value;
    expect(realm.rememberMe).toBe(true);
    expect(realm.ssoSessionIdleTimeoutRememberMe).toBe(days * 86400);
    expect(realm.ssoSessionMaxLifespanRememberMe).toBe(days * 86400);
    const stored = (
      await q<{ value: number }>(
        `SELECT v.value FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
           JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key = 'session.keep_signed_in_days'`,
      )
    )[0]!.value;
    expect(stored * 86400).toBe(realm.ssoSessionMaxLifespanRememberMe);
  });

  it('resolves exactly one effective version per parameter at the database clock (the no-overlap rule)', async () => {
    const rows = await q<{ key: string; n: number }>(
      `SELECT p.key, count(*)::int AS n FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id
        WHERE ${SEED_FILTER} AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now()) GROUP BY p.key`,
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.n, r.key).toBe(1);
  });

  it.each(PARAM_SEEDS)('records exactly one ACTIVE change request for $key, published as its value version', async ({ key, value }) => {
    const rows = await q(
      `SELECT r.state, r.scope_type, r.scope_ref, r.proposed_value, r.effective_from <= now() AS started, r.effective_to, r.requested_by, r.approval_policy,
              r.value_version_id = v.version_id AS linked, v.value AS version_value, v.version
         FROM configuration.change_requests r LEFT JOIN configuration.value_versions v ON v.version_id = r.value_version_id WHERE r.parameter_id = $1`,
      [await parameterId(key)],
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
    expect(
      await q(
        `SELECT a.approver, a.decision, r.requested_by, a.approver <> r.requested_by AS second_person
           FROM configuration.change_requests r JOIN configuration.change_approvals a ON a.change_request_id = r.change_request_id WHERE r.parameter_id = $1`,
        [await parameterId(key)],
      ),
    ).toEqual([{ approver: 'system:migration-review', decision: 'APPROVE', requested_by: 'system:migration', second_person: true }]);
  });

  it.each(PARAM_SEEDS)('writes the six-step audit trail of $key exactly like the real workflow, in order, under the correlation seed-0012', async ({ key }) => {
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
    for (const r of rows) expect(r.correlation_id).toBe('seed-0012');
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

  it('refuses to change or delete a seeded value version (immutable; corrections create a new version) and to rename, retype or delete the definition', async () => {
    const id = await parameterId('security.step_up_valid_minutes');
    const version = (
      await q<{ version_id: string }>(
        'SELECT v.version_id FROM configuration.parameter_values h JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE h.parameter_id = $1',
        [id],
      )
    )[0]!.version_id;
    for (const set of ["value = '45'::jsonb", "reason = 'edited'", "effective_from = now() - interval '1 day'", "created_by = 'someone'", 'version = 2'])
      expect((await fail(run(`UPDATE configuration.value_versions SET ${set} WHERE version_id = $1`, [version]))).code, set).toBe('23000');
    expect((await fail(run('DELETE FROM configuration.value_versions WHERE version_id = $1', [version]))).code).toBe('23000');
    expect((await q<{ value: number }>('SELECT value FROM configuration.value_versions WHERE version_id = $1', [version]))[0]!.value).toBe(15);
    expect((await fail(run("UPDATE configuration.parameters SET key = 'security.other' WHERE parameter_id = $1", [id]))).code).toBe('23000');
    expect((await fail(run("UPDATE configuration.parameters SET data_type = 'STRING' WHERE parameter_id = $1", [id]))).code).toBe('23000');
    expect((await fail(run('DELETE FROM configuration.parameters WHERE parameter_id = $1', [id]))).code).toBe('23000');
    expect((await fail(run('DELETE FROM configuration.audit_events WHERE parameter_id = $1', [id]))).code).toBe('23000');
  });

  it('would refuse the requester approving its own change again (the self-approval trigger holds for these requests)', async () => {
    const request = (
      await q<{ change_request_id: string }>('SELECT change_request_id FROM configuration.change_requests WHERE parameter_id = $1', [
        await parameterId('reset_link.validity_minutes'),
      ])
    )[0]!.change_request_id;
    expect(
      (
        await fail(
          run("INSERT INTO configuration.change_approvals (change_request_id, approver, decision) VALUES ($1, 'system:migration', 'APPROVE')", [request]),
        )
      ).code,
    ).toBe('23000');
  });
});

// ====================================================================== J. content seeds
const UI_LABEL_KEYS = [
  'account.security.title',
  'account.security.mfa.title',
  'account.security.mfa.status.enabled',
  'account.security.mfa.status.disabled',
  'account.security.mfa.status.unknown',
  'account.security.mfa.totp.label',
  'account.security.mfa.totp.enable',
  'account.security.mfa.recovery.label',
  'account.security.mfa.recovery.generate',
  'account.security.sessions.title',
  'account.security.sessions.current',
  'account.security.sessions.sign_out',
  'account.security.sessions.sign_out_everywhere',
  'account.security.devices.title',
  'account.security.devices.trust',
  'account.security.devices.untrust',
  'account.security.devices.remove',
  'account.security.activity.title',
  'account.security.activity.session_created',
  'account.security.activity.session_ended',
  'account.security.activity.session_revoked',
  'account.security.activity.sessions_revoked_all',
  'account.security.activity.device_trusted',
  'account.security.activity.device_untrusted',
  'account.security.activity.device_removed',
  'account.security.activity.mfa_enrollment_requested',
  'account.security.activity.mfa_enabled',
  'account.security.activity.mfa_disabled',
  'account.security.activity.recovery_codes_requested',
  'account.security.activity.recovery_codes_enabled',
  'account.security.activity.recovery_codes_disabled',
  'account.security.activity.password_reset_requested',
  'account.security.activity.password_changed',
  'account.security.activity.password_reset_completed',
  'account.security.activity.email_verified',
  'account.security.activity.email_primary_changed',
  'account.security.activity.phone_verified',
  'account.security.activity.phone_primary_changed',
  'account.security.browser.chrome',
  'account.security.browser.firefox',
  'account.security.browser.safari',
  'account.security.browser.edge',
  'account.security.browser.opera',
  'account.security.browser.other',
  'account.security.os.windows',
  'account.security.os.macos',
  'account.security.os.linux',
  'account.security.os.ios',
  'account.security.os.android',
  'account.security.os.other',
  'account.security.device_class.desktop',
  'account.security.device_class.mobile',
  'account.security.device_class.tablet',
  'account.security.device_class.other',
  'account.password_reset.title',
  'account.password_reset.email_label',
  'account.password_reset.submit',
  'account.password_reset.back_to_sign_in',
];
const PLAIN_TEXT_KEYS = [
  'account.security.mfa.recovery.warning',
  'account.security.mfa.stepup_note',
  'account.security.sessions.empty',
  'account.security.sessions.unreconciled',
  'account.security.sessions.last_seen',
  'account.security.devices.trust_note',
  'account.security.devices.none',
  'account.security.devices.trusted_until',
  'account.security.activity.empty',
  'account.security.notice.session_revoked',
  'account.security.notice.signed_out_elsewhere',
  'account.security.notice.device_trusted',
  'account.security.notice.device_untrusted',
  'account.security.notice.device_removed',
  'account.security.notice.mfa_return_success',
  'account.security.notice.mfa_return_cancelled',
  'account.security.error.session_revoked',
  'account.security.error.step_up_required',
  'account.security.error.mfa_enrollment_required',
  'account.security.error.session_not_found',
  'account.security.error.device_not_found',
  'account.security.error.device_required',
  'account.security.error.security_unavailable',
  'account.security.error.password_reset_rate_limited',
  'account.password_reset.intro',
  'account.password_reset.accepted',
  'account.password_reset.error.invalid_email',
  'account.password_reset.error.rate_limited',
];

const SECURITY_COPY: [key: string, type: string][] = [
  ...UI_LABEL_KEYS.map((k): [string, string] => [k, 'UI_LABEL']),
  ...PLAIN_TEXT_KEYS.map((k): [string, string] => [k, 'PLAIN_TEXT']),
];
const COPY_FILTER = "(e.key LIKE 'account.security.%' OR e.key LIKE 'account.password_reset.%')";
/** The keys the web needs, computed from the contract helpers (a missing label fails the test) plus the keys the spec names. */
const REQUIRED_BY_CONTRACTS: string[] = [
  ...SECURITY_ACTIVITY_TYPES.map((t) => securityActivityLabelKey(t)),
  ...BROWSER_FAMILIES.map((b) => browserLabelKey(b)),
  ...OS_FAMILIES.map((o) => osLabelKey(o)),
  ...DEVICE_CLASSES.map((d) => deviceClassLabelKey(d)),
  ...SECURITY_ERROR_CODES.map((c) => securityErrorMessageKey(c)),
  ...AUTH_SECURITY_ERROR_CODES.map((c) => authSecurityErrorMessageKey(c)),
];
const REQUIRED_BY_SPEC: string[] = [
  'title',
  'mfa.title',
  'mfa.status.enabled',
  'mfa.status.disabled',
  'mfa.status.unknown',
  'mfa.totp.label',
  'mfa.totp.enable',
  'mfa.recovery.label',
  'mfa.recovery.generate',
  'mfa.recovery.warning',
  'mfa.stepup_note',
  'sessions.title',
  'sessions.current',
  'sessions.sign_out',
  'sessions.sign_out_everywhere',
  'sessions.empty',
  'sessions.unreconciled',
  'sessions.last_seen',
  'devices.title',
  'devices.trust',
  'devices.untrust',
  'devices.remove',
  'devices.trust_note',
  'devices.none',
  'devices.trusted_until',
  'activity.title',
  'activity.empty',
  'notice.session_revoked',
  'notice.signed_out_elsewhere',
  'notice.device_trusted',
  'notice.device_untrusted',
  'notice.device_removed',
  'notice.mfa_return_success',
  'notice.mfa_return_cancelled',
  'error.session_revoked',
  'error.step_up_required',
  'error.mfa_enrollment_required',
  'error.session_not_found',
  'error.device_not_found',
  'error.device_required',
  'error.security_unavailable',
  'error.password_reset_rate_limited',
]
  .map((k) => `account.security.${k}`)
  .concat(
    ['title', 'intro', 'email_label', 'submit', 'accepted', 'back_to_sign_in', 'error.invalid_email', 'error.rate_limited'].map(
      (k) => `account.password_reset.${k}`,
    ),
  );
const EXPECTED_COPY_VARIABLES: Record<string, [name: string, type: string, pii: string][]> = {
  'account.security.sessions.last_seen': [['when', 'STRING', 'NONE']],
  'account.security.devices.trusted_until': [['date', 'STRING', 'NONE']],
};
const copyEntries = async (): Promise<{ entry_id: string; key: string; content_type: string }[]> =>
  q(`SELECT e.entry_id, e.key, e.content_type FROM content.entries e WHERE ${COPY_FILTER} ORDER BY e.key COLLATE "C"`);
const copyBodies = async (): Promise<{ key: string; body: string }[]> =>
  q(`SELECT e.key, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER} ORDER BY e.key COLLATE "C"`);
const bodyOf = async (key: string): Promise<string> =>
  (await q<{ body: string }>('SELECT v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = $1', [key]))[0]!.body;

describe('J. seeded content: the security screen and password reset copy (86 entries)', () => {
  it('seeds exactly 86 entries (78 account.security.* and 8 account.password_reset.*), each key once', async () => {
    const rows = await copyEntries();
    expect(rows).toHaveLength(86);
    expect(SECURITY_COPY).toHaveLength(86);
    expect(new Set(SECURITY_COPY.map(([k]) => k)).size).toBe(86);
    expect(rows.map((r) => r.key)).toEqual(SECURITY_COPY.map(([k]) => k).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(rows.filter((r) => r.key.startsWith('account.password_reset.'))).toHaveLength(8);
    expect(rows.filter((r) => r.key.startsWith('account.security.'))).toHaveLength(78);
  });

  it('gives each entry its content type (UI_LABEL for titles, buttons and labels, PLAIN_TEXT for sentences) and never an email or legal type', async () => {
    const rows = await copyEntries();
    expect(Object.fromEntries(rows.map((r) => [r.key, r.content_type]))).toEqual(Object.fromEntries(SECURITY_COPY));
    const types = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.content_type]: (acc[r.content_type] ?? 0) + 1 }), {});
    expect(types).toEqual({ UI_LABEL: UI_LABEL_KEYS.length, PLAIN_TEXT: PLAIN_TEXT_KEYS.length });
    expect(rows.filter((r) => /^(EMAIL_|LEGAL)/.test(r.content_type))).toEqual([]);
  });

  it('seeds every entry as PUBLIC, STANDARD, owned by CONTENT, approval NONE, CHAIN fallback, PLATFORM maximum scope, active', async () => {
    expect(
      await q(
        `SELECT DISTINCT sensitivity, criticality, owner_role, approval_policy, fallback_policy, max_scope_type, is_active, created_by FROM content.entries e WHERE ${COPY_FILTER}`,
      ),
    ).toEqual([
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
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER} GROUP BY e.key`,
    );
    expect(rows).toHaveLength(86);
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
      `SELECT e.key, v.body, v.body_sha256 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER}`,
    );
    expect(rows).toHaveLength(86);
    for (const r of rows) expect(r.body_sha256, r.key).toBe(sha256(r.body));
  });

  it('writes the content audit trail of every entry: ENTRY_CREATED, VERSION_DRAFTED, VERSION_APPROVED, VERSION_PUBLISHED, VERSION_ACTIVATED, under seed-0012', async () => {
    const rows = await q<{ key: string; actions: string[]; actors: string[]; correlations: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at) AS actions, array_agg(DISTINCT a.actor) AS actors, array_agg(DISTINCT a.correlation_id) AS correlations
         FROM content.entries e JOIN content.audit_events a ON a.entry_id = e.entry_id WHERE ${COPY_FILTER} GROUP BY e.key`,
    );
    expect(rows).toHaveLength(86);
    for (const r of rows) {
      expect(r.actions, r.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
      expect(r.actors).toEqual(['system:migration']);
      expect(r.correlations).toEqual(['seed-0012']);
    }
  });

  it('declares exactly the typed variables of the two strings that carry one (when and date, STRING, required, no personal data) and none on any other entry', async () => {
    const rows = await q<{ key: string; name: string; var_type: string; pii_class: string; is_required: boolean; example_value: unknown }>(
      `SELECT e.key, x.name, x.var_type, x.pii_class, x.is_required, x.example_value FROM content.entries e JOIN content.entry_variables x ON x.entry_id = e.entry_id
        WHERE ${COPY_FILTER} ORDER BY e.key, x.name`,
    );
    const grouped: Record<string, [string, string, string][]> = {};
    for (const r of rows) (grouped[r.key] ??= []).push([r.name, r.var_type, r.pii_class]);
    expect(grouped).toEqual(EXPECTED_COPY_VARIABLES);
    for (const r of rows) {
      expect(r.is_required, `${r.key}.${r.name}`).toBe(true);
      expect(typeof r.example_value).toBe('string');
    }
  });

  it('uses only the placeholders the entry declares, and every declared variable appears in its text', async () => {
    const rows = await q<{ key: string; body: string; names: string[] | null }>(
      `SELECT e.key, v.body, (SELECT array_agg(x.name ORDER BY x.name) FROM content.entry_variables x WHERE x.entry_id = e.entry_id) AS names
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER}`,
    );
    for (const r of rows) {
      const used = [...new Set([...r.body.matchAll(/\{([a-z][a-z0-9_]*)\s*[,}]/g)].map((m) => m[1]!))].sort();
      expect(used, r.key).toEqual(r.names ?? []);
    }
    expect(await bodyOf('account.security.sessions.last_seen')).toBe('Last active {when}');
    expect(await bodyOf('account.security.devices.trusted_until')).toBe('Trusted until {date}');
  });

  describe('every key the web needs exists (computed from the contract helpers, so a missing label fails here)', () => {
    it('has a label for every security activity type (16 audit actions and 4 contact actions: 20)', async () => {
      expect(SECURITY_ACTIVITY_TYPES).toHaveLength(20);
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const t of SECURITY_ACTIVITY_TYPES) expect(present.has(securityActivityLabelKey(t)), t).toBe(true);
      expect([...present].filter((k) => k.startsWith('account.security.activity.') && !k.endsWith('.title') && !k.endsWith('.empty'))).toHaveLength(20);
    });
    it('has a label for every browser family (6), OS family (6) and device class (4)', async () => {
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const b of BROWSER_FAMILIES) expect(present.has(browserLabelKey(b)), b).toBe(true);
      for (const o of OS_FAMILIES) expect(present.has(osLabelKey(o)), o).toBe(true);
      for (const d of DEVICE_CLASSES) expect(present.has(deviceClassLabelKey(d)), d).toBe(true);
      expect([...present].filter((k) => /^account\.security\.(browser|os|device_class)\./.test(k))).toHaveLength(16);
    });
    it('has a message for every security error code (5) and every guard error code (3): eight error keys', async () => {
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const c of SECURITY_ERROR_CODES) expect(present.has(securityErrorMessageKey(c)), c).toBe(true);
      for (const c of AUTH_SECURITY_ERROR_CODES) expect(present.has(authSecurityErrorMessageKey(c)), c).toBe(true);
      expect([...present].filter((k) => k.startsWith('account.security.error.'))).toHaveLength(8);
      expect(new Set([...SECURITY_ERROR_CODES, ...AUTH_SECURITY_ERROR_CODES]).size).toBe(8);
    });
    it('has every key the spec names for the page, the notices and the password reset screen', async () => {
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const k of REQUIRED_BY_SPEC) expect(present.has(k), k).toBe(true);
    });
    it('contains nothing but the keys above: every seeded key is required by a contract helper or by the spec (no orphan copy)', async () => {
      const required = new Set([...REQUIRED_BY_CONTRACTS, ...REQUIRED_BY_SPEC]);
      const orphans = (await copyEntries()).map((r) => r.key).filter((k) => !required.has(k));
      expect(orphans).toEqual([]);
      expect(required.size).toBe(86);
    });
  });

  it('keeps the activity labels in lower case after the dot of the SECURITY_ACTIVITY_TYPES, e.g. account.security.activity.session_created reads "Signed in"', async () => {
    expect(securityActivityLabelKey('SESSION_CREATED')).toBe('account.security.activity.session_created');
    expect(await bodyOf('account.security.activity.session_created')).toBe('Signed in');
    expect(await bodyOf('account.security.activity.sessions_revoked_all')).toBe('Signed out of all sessions');
  });

  it('states plainly in the trust note that the sign-in service still decides when it asks for a code (no false claim that trusting skips the code)', async () => {
    const note = await bodyOf('account.security.devices.trust_note');
    expect(note).toMatch(/sign-in service still decides when it asks for a verification code/);
    expect(note).toMatch(/does not by itself skip that step/);
    expect(note).toMatch(/never replaces the extra confirmation required for sensitive changes/);
    // none of the promises a trusted-browser feature usually makes
    expect(note).not.toMatch(
      /won't ask|will not ask|no longer ask|skip(s|ped)? (the )?(code|verification|two)|remember(s|ed)? (this|you)|stay signed in|without (a )?code/i,
    );
    expect(await bodyOf('account.security.devices.trust')).toBe('Trust this browser');
    expect(await bodyOf('account.security.devices.trusted_until')).not.toMatch(/skip|without|no (code|verification)/i);
  });

  it('explains the step-up note without promising to skip anything, and warns that recovery codes are shown once', async () => {
    expect(await bodyOf('account.security.mfa.stepup_note')).toMatch(/may ask you to confirm your sign-in again/);
    expect(await bodyOf('account.security.mfa.recovery.warning')).toMatch(/shown once/);
  });

  it('never reveals whether an account exists on the password reset screen: one accepted text with "if" and no definite statement, and no technical detail', async () => {
    const accepted = await bodyOf('account.password_reset.accepted');
    expect(accepted).toMatch(/^If that email address belongs to an account/);
    expect(accepted).not.toMatch(/\b(sent|found|exists|no account|not found|unknown|registered|invalid)\b/i);
    expect(await bodyOf('account.password_reset.intro')).toMatch(/If it is a verified address of an account/);
    for (const k of ['error.invalid_email', 'error.rate_limited']) expect(await bodyOf(`account.password_reset.${k}`)).not.toMatch(/account/i);
  });

  it('keeps the rate-limit and error messages free of numbers, timings, keys and system names (they must not expose a limit or an identifier)', async () => {
    for (const r of (await copyBodies()).filter((x) => /\.error\./.test(x.key))) {
      expect(r.body, r.key).not.toMatch(/\d/);
      expect(r.body, r.key).not.toMatch(/keycloak|valkey|postgres|redis|nats|session id|sid\b|token|jwt|http|[A-Z_]{6,}/);
    }
  });

  it('never embeds a link, an email address, a sample code, a token or a secret in any seeded text', async () => {
    for (const r of await copyBodies()) {
      expect(r.body, r.key).not.toMatch(/https?:\/\//i);
      expect(r.body, r.key).not.toMatch(/www\./i);
      expect(r.body, r.key).not.toMatch(/@/);
      expect(r.body, r.key).not.toMatch(/\d{4,}/);
      expect(r.body, r.key).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    }
  });

  it('tells nobody which second factor to use that Keycloak does not offer: no SMS or email code promised for the second factor', async () => {
    for (const r of (await copyBodies()).filter((x) => x.key.startsWith('account.security.mfa.')))
      expect(r.body, r.key).not.toMatch(/\b(sms|text message|email)\b/i);
  });

  it('keeps every seeded text non-blank, single-line, free of control characters and without leading or trailing space', async () => {
    for (const r of await copyBodies()) {
      expect(r.body.trim().length, r.key).toBeGreaterThan(0);
      expect(r.body, r.key).toBe(r.body.trim());
      expect(
        [...r.body].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
        r.key,
      ).toBe(false);
    }
  });

  it('keeps the labels short (UI_LABEL at most 40 characters) and the sentences under 400', async () => {
    const rows = await q<{ key: string; content_type: string; body: string }>(
      `SELECT e.key, e.content_type, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER}`,
    );
    for (const r of rows) expect(r.body.length, r.key).toBeLessThanOrEqual(r.content_type === 'UI_LABEL' ? 40 : 400);
  });

  it('leaves the email (34) and phone (33) copy untouched', async () => {
    expect(await count('content.entries', "key LIKE 'account.email.%'")).toBe(34);
    expect(await count('content.entries', "key LIKE 'account.phone.%' OR key = 'sms.verification.phone.body'")).toBe(33);
  });

  it('refuses to edit or delete a seeded published version (the text is immutable; corrections are new versions)', async () => {
    const version = (
      await q<{ version_id: string }>(
        "SELECT v.version_id FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = 'account.security.devices.trust_note'",
      )
    )[0]!.version_id;
    expect((await fail(run("UPDATE content.versions SET body = 'Changed' WHERE version_id = $1", [version]))).code).toBe('23000');
    expect((await fail(run('DELETE FROM content.versions WHERE version_id = $1', [version]))).code).toBe('23000');
  });
});

// ====================================================================== K. privacy shape
const NEW_TABLES = ['account_devices', 'application_sessions'];
describe('K. privacy shape: nothing in the registry or the audit trail can hold a raw IP, user agent, token, secret, code or email', () => {
  const columnsWithTypes = async (tables: string[]): Promise<{ table_name: string; column_name: string; data_type: string }[]> =>
    q(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = ANY($1) ORDER BY table_name, ordinal_position",
      [tables],
    );

  it('has no column on the new tables, the audit trail or accounts named like an address, location, agent, token, secret, code, credential, cookie, password or email', async () => {
    const forbidden =
      /(^|_)(ip|ipv4|ipv6|addr|address|host|hostname|geo|geoip|lat|lng|latitude|longitude|city|region|country|location|agent|ua|useragent|user_agent|browser_version|version|header|referer|referrer|fingerprint|token|jwt|secret|code|otp|totp|pin|passw|password|credential|cookie|key|salt|plain|raw|link|url|email|phone|mobile|name|subject|sub|sid|claims?)(_|$)/i;
    const offenders = (await columnsWithTypes([...NEW_TABLES, 'account_audit_events', 'accounts']))
      .filter((c) => forbidden.test(c.column_name))
      .map((c) => `${c.table_name}.${c.column_name}`);
    // the ONLY exceptions are the pre-existing audit contact references email_contact_id / phone_contact_id (identifiers, not addresses); the protocol
    // session id keycloak_session_id is covered by the dedicated keycloak/sid test below
    expect(offenders.sort()).toEqual(['account_audit_events.email_contact_id', 'account_audit_events.phone_contact_id']);
  });

  it('keeps exactly three coarse text families, a hash and timestamps as the only descriptive columns of a device', async () => {
    expect((await columnsOf('account_devices')).map(([n, t]) => `${n}:${t}`)).toEqual([
      'account_device_id:uuid',
      'account_id:uuid',
      'device_hash:character',
      'browser_family:text',
      'os_family:text',
      'device_class:text',
      'first_seen_at:timestamp with time zone',
      'last_seen_at:timestamp with time zone',
      'trusted_at:timestamp with time zone',
      'trusted_until:timestamp with time zone',
      'removed_at:timestamp with time zone',
    ]);
  });

  it('has no JSON, array, binary, inet, cidr, geometry or free-form column on the new tables (every value is a typed scalar), and the only unbounded text column is CHECKed', async () => {
    const types = new Set((await columnsWithTypes(NEW_TABLES)).map((c) => c.data_type));
    expect([...types].sort()).toEqual(['character', 'text', 'timestamp with time zone', 'uuid']);
    const textCols = (await columnsWithTypes(NEW_TABLES)).filter((c) => c.data_type === 'text').map((c) => `${c.table_name}.${c.column_name}`);
    expect(textCols.sort()).toEqual([
      'account_devices.browser_family',
      'account_devices.device_class',
      'account_devices.os_family',
      'application_sessions.keycloak_session_id',
      'application_sessions.revocation_reason',
    ]);
    // every one of them is bounded by a CHECK: a vocabulary or a 1..100 character visible id
    for (const [table, column] of textCols.map((c) => c.split('.') as [string, string])) {
      const checks = await q<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ('identity.' || $1)::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%' || $2 || '%'`,
        [table, column],
      );
      expect(checks.length, `${table}.${column}`).toBeGreaterThan(0);
    }
  });

  it('adds no JSON column anywhere in the identity schema except the audit "changes" object that already existed', async () => {
    const rows = await q<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'identity' AND data_type IN ('json', 'jsonb', 'bytea', 'inet', 'cidr', 'macaddr', 'ARRAY', 'USER-DEFINED') ORDER BY 1, 2",
    );
    expect(rows).toEqual([{ table_name: 'account_audit_events', column_name: 'changes' }]);
  });

  it('stores the device hash as lowercase hex of exactly 64 characters, bound to the account: the same secret hashes differently per account, so a stored value is no usable cookie', async () => {
    const secret = randomBytes(32).toString('base64url');
    const hashFor = (account: string) => createHash('sha256').update(`bananagig:device:v1:${account}:${secret}`).digest('hex');
    const a1 = await makeAccount();
    const a2 = await makeAccount();
    const d1 = await insertDevice(a1, { hash: hashFor(a1) });
    const d2 = await insertDevice(a2, { hash: hashFor(a2) });
    const rows = await q<{ device_hash: string }>('SELECT device_hash FROM identity.account_devices WHERE account_device_id = ANY($1)', [[d1.id, d2.id]]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.device_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.device_hash).not.toContain(secret);
    }
    expect(rows[0]!.device_hash).not.toBe(rows[1]!.device_hash);
  });

  it('refuses the plaintext device secret as a hash: a 43-character base64url secret and a 44-character base64 secret are not 64 hex characters', async () => {
    for (const secret of [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64')]) {
      expect(await constraintOf(insertDevice(await makeAccount(), hashOf(secret)))).toBe('ck_account_devices__device_hash');
    }
  });

  it('keeps a full row dump of a realistic account (device, sessions, audit rows) free of the raw cookie secret, the user agent, an IP address, the email and the subject', async () => {
    const secret = randomBytes(32).toString('base64url');
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    const ip = '203.0.113.77';
    const email = `leak-${uniq()}@example.test`;
    const a = await makeAccount();
    const hash = createHash('sha256').update(`bananagig:device:v1:${a}:${secret}`).digest('hex');
    const d = await insertDevice(a, { hash });
    const sid = `kc-${randomUUID()}`;
    const s = await insertSession(a, { sid, deviceId: d.id });
    await insertAuditRow(a, 'SESSION_CREATED', { session: s.id });
    await insertAuditRow(a, 'DEVICE_TRUSTED', { device: d.id });
    const dump = JSON.stringify({
      devices: await q('SELECT * FROM identity.account_devices WHERE account_id = $1', [a]),
      sessions: await q(
        'SELECT application_session_id, account_id, account_device_id, created_at, last_seen_at, revoked_at, revocation_reason FROM identity.application_sessions WHERE account_id = $1',
        [a],
      ),
      audit: await q('SELECT * FROM identity.account_audit_events WHERE account_id = $1', [a]),
      account: await q('SELECT * FROM identity.accounts WHERE account_id = $1', [a]),
    });
    for (const needle of [secret, userAgent, 'Mozilla', ip, email, sid]) expect(dump).not.toContain(needle);
  });

  it('holds no login subject and no Keycloak identifier outside the link table, except the session id column of the registry', async () => {
    const cols = (
      await q<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'identity' AND column_name ~* '(subject|^sub$|keycloak|issuer)' ORDER BY 1, 2",
      )
    ).map((r) => `${r.table_name}.${r.column_name}`);
    expect(cols).toEqual(['application_sessions.keycloak_session_id', 'external_identities.issuer', 'external_identities.provider_subject']);
  });

  it('documents in the catalog that the Keycloak session id is SENSITIVE and never logged, returned or audited', async () => {
    expect(await commentOn(SESSIONS, 'keycloak_session_id')).toMatch(/SENSITIVE: never logged, returned or audited/);
  });
});

// ====================================================================== L. data comments (the data dictionary source)
describe('L. data comments: tables, sensitive columns and the new references are documented in the catalog', () => {
  it('documents both new tables', async () => {
    expect(await commentOn(DEVICES)).toMatch(/HMAC-SHA-256/);
    expect(await commentOn(DEVICES)).toMatch(/no raw IP/);
    expect(await commentOn(DEVICES)).toMatch(/NO effect on the identity provider/);
    expect(await commentOn(SESSIONS)).toMatch(/never holds a token/);
    expect(await commentOn(SESSIONS)).toMatch(/Liveness is DERIVED/);
    expect(await commentOn(SESSIONS)).toMatch(/Rows are never deleted/);
  });

  it.each([
    [DEVICES, 'device_hash', /HMAC-SHA-256.*never stored or logged/s],
    [DEVICES, 'browser_family', /CHROME, FIREFOX, SAFARI, EDGE, OPERA or OTHER/],
    [DEVICES, 'os_family', /WINDOWS, MACOS, LINUX, IOS, ANDROID or OTHER/],
    [DEVICES, 'device_class', /DESKTOP, MOBILE, TABLET or OTHER/],
    [DEVICES, 'last_seen_at', /Never moves back/],
    [DEVICES, 'trusted_until', /trusted_until > clock_timestamp\(\) AND removed_at IS NULL/],
    [DEVICES, 'removed_at', /Terminal/],
    [SESSIONS, 'keycloak_session_id', /SENSITIVE/],
    [SESSIONS, 'account_device_id', /MATCH SIMPLE/],
    [SESSIONS, 'last_seen_at', /Never moves back/],
    [SESSIONS, 'revocation_reason', /immutable once set/],
    [ACCOUNTS, 'sessions_not_before', /never moves back or to NULL/],
    [AUDIT, 'application_session_id', /Never the Keycloak session id/],
    [AUDIT, 'account_device_id', /composite foreign key/],
  ] as [string, string, RegExp][])('documents %s.%s', async (table, column, pattern) => {
    expect(await commentOn(table, column)).toMatch(pattern);
  });

  it('names every revocation reason of the contract in the revocation_reason comment (the vocabulary is documented where it is stored)', async () => {
    const comment = (await commentOn(SESSIONS, 'revocation_reason'))!;
    for (const r of SESSION_REVOCATION_REASONS) expect(comment, r).toContain(r);
  });

  it('explains the watermark as only affecting a session FIRST SEEN after it, not future-dated and not personal data', async () => {
    const c = (await commentOn(ACCOUNTS, 'sessions_not_before'))!;
    expect(c).toMatch(/FIRST SEEN/);
    expect(c).toMatch(/never into the future/);
    expect(c).toMatch(/Not personal data/);
  });
});

// ====================================================================== M. physical design: HOT touches and the security-state index
describe('M. physical design: the once-a-minute touch is a HOT update, and the audit security-state index is partial and used', () => {
  const NINE_OBSERVED = [
    'MFA_ENABLED',
    'MFA_DISABLED',
    'RECOVERY_CODES_ENABLED',
    'RECOVERY_CODES_DISABLED',
    'MFA_ENROLLMENT_REQUESTED',
    'RECOVERY_CODES_REQUESTED',
    'PASSWORD_CHANGED',
    'PASSWORD_RESET_COMPLETED',
    'PASSWORD_RESET_REQUESTED',
  ];

  it('stores application_sessions with fillfactor 80 (room on the page for the HOT touch) and leaves the other new tables at the default', async () => {
    expect(
      await q(
        "SELECT relname, reloptions FROM pg_class WHERE oid IN ('identity.application_sessions'::regclass, 'identity.account_devices'::regclass) ORDER BY relname",
      ),
    ).toEqual([
      { relname: 'account_devices', reloptions: null },
      { relname: 'application_sessions', reloptions: ['fillfactor=80'] },
    ]);
  });

  it('defines the security-state index as PARTIAL on (account_id, occurred_at DESC) for exactly the nine observed MFA, recovery and password actions', async () => {
    const def = (await indexesOf('account_audit_events')).find((r) => r.indexname === 'idx_account_audit_events__account_security_state')!.indexdef;
    expect(def).toMatch(/^CREATE INDEX .* ON identity\.account_audit_events USING btree \(account_id, occurred_at DESC\) WHERE /);
    const actions = [...def.slice(def.indexOf('WHERE')).matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!).sort();
    expect(actions).toEqual([...NINE_OBSERVED].sort());
    // every one of them is a real security audit action and none concerns a session or a device (so none needs a reference)
    for (const a of actions) expect(SECURITY_AUDIT_ACTIONS as readonly string[]).toContain(a);
    expect(actions.filter((a) => /^(SESSION|DEVICE)_/.test(a) || a === 'SESSIONS_REVOKED_ALL')).toEqual([]);
  });

  it('is used by the "latest audited state of one account" query and NOT needed by the timeline (which reads the per-account index)', async () => {
    const a = await makeAccount();
    // one SESSION_CREATED row per login buries the rare rows, which is the reason for the index
    for (let n = 0; n < 300; n++) await insertAuditRow(a, 'SESSION_CREATED', { session: (await insertSession(a)).id });
    await insertAuditRow(a, 'MFA_ENABLED');
    await insertAuditRow(a, 'PASSWORD_CHANGED');
    await run('ANALYZE identity.account_audit_events');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      const plan = (
        await c.query(
          `EXPLAIN SELECT action, occurred_at FROM ${AUDIT} WHERE account_id = $1 AND action IN ('MFA_ENABLED', 'MFA_DISABLED') ORDER BY occurred_at DESC LIMIT 1`,
          [a],
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain('idx_account_audit_events__account_security_state');
      const timeline = (await c.query(`EXPLAIN SELECT action FROM ${AUDIT} WHERE account_id = $1 ORDER BY occurred_at DESC LIMIT 25`, [a])).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(timeline).toContain('idx_account_audit_events__account');
      expect(timeline).not.toContain('security_state');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('makes the last_seen_at touch a HOT update (no index covers the column, fillfactor leaves room): at least 80% of 60 sequential touches are heap-only', async () => {
    const a = await makeAccount();
    const sessions: Session[] = [];
    for (let n = 0; n < 5; n++) sessions.push(await insertSession(a));
    const c = await pool.connect();
    try {
      const stat = async (): Promise<{ upd: number; hot: number }> => {
        await c.query('SELECT pg_stat_force_next_flush()');
        const r = await c.query(
          "SELECT pg_stat_get_tuples_updated('identity.application_sessions'::regclass)::int AS upd, pg_stat_get_tuples_hot_updated('identity.application_sessions'::regclass)::int AS hot",
        );
        return r.rows[0] as { upd: number; hot: number };
      };
      const before = await stat();
      for (let n = 0; n < 60; n++)
        await c.query('UPDATE identity.application_sessions SET last_seen_at = GREATEST(last_seen_at, clock_timestamp()) WHERE application_session_id = $1', [
          sessions[n % 5]!.id,
        ]);
      const after = await stat();
      expect(after.upd - before.upd).toBe(60);
      expect(after.hot - before.hot).toBeGreaterThanOrEqual(48);
    } finally {
      c.release();
    }
  });
});
